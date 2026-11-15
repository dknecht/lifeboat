import * as Effect from "effect/Effect";
import PostalMime from "postal-mime";
import { AppConfig, Blobs, Db, sql, type Statement } from "./services";
import { getOpenIncidentId } from "./settings";
import type { Person, StoredBody } from "./types";
import { MAX_MESSAGE_BYTES } from "./types";
import { htmlToText, makeSnippet, newId, normalizeAddress, now } from "./util";

/** An inbound message as the mail platform hands it over, before any parsing. */
export interface InboundEmail {
  /** Envelope sender. */
  readonly from: string;
  /** Envelope recipient. */
  readonly to: string;
  readonly headers: { get(name: string): string | null };
  readonly size: number;
  /** Reads the raw RFC 5322 bytes. Called at most once. */
  readonly readRaw: Effect.Effect<Uint8Array>;
}

export type InboundResult =
  | { readonly status: "stored" | "held"; readonly id: string }
  /** The message must be refused with a permanent SMTP error carrying `reason`. */
  | { readonly status: "rejected"; readonly reason: string };

function people(list: { address?: string; name?: string }[] | undefined): Person[] {
  return (list ?? [])
    .filter((p) => p.address)
    .map((p) => ({ address: normalizeAddress(p.address!), name: p.name ?? "" }));
}

function threadId(refs: string | null, inReplyTo: string | null, messageId: string | null): string | null {
  return refs?.trim().split(/\s+/)[0] || inReplyTo || messageId;
}

/**
 * Stores one inbound message.
 *
 * A failure here must reach the mail platform as a temporary error so that the sending server
 * retries: the message is never acknowledged unless its raw bytes are safely in storage.
 */
export const handleInbound = Effect.fn("handleInbound")(function* (message: InboundEmail) {
  const config = yield* AppConfig;
  const db = yield* Db;
  const blobs = yield* Blobs;

  if (message.size > MAX_MESSAGE_BYTES) {
    return { status: "rejected", reason: "Message too large" } as InboundResult;
  }

  const rcpt = normalizeAddress(message.to);
  const owner = yield* db.first<{ user_id: string }>(sql("SELECT user_id FROM addresses WHERE address = ?", rcpt));
  if (!owner && config.unknownRecipient === "reject") {
    return { status: "rejected", reason: "Address does not exist" } as InboundResult;
  }

  const id = newId();
  const raw = yield* message.readRaw;

  // Durability point: once the raw message is in storage it can always be recovered.
  yield* blobs.put(`raw/${id}.eml`, raw, "message/rfc822", { rcpt, from: message.from });

  // Envelope data is the fallback when the message cannot be parsed.
  let subject = message.headers.get("subject") ?? "";
  let from: Person = { address: normalizeAddress(message.from), name: "" };
  let to: Person[] = [{ address: rcpt, name: "" }];
  let cc: Person[] = [];
  let messageId = message.headers.get("message-id");
  let inReplyTo: string | null = null;
  let refs: string | null = null;
  let sentAt = now();
  let snippet = "(This message could not be parsed. An administrator can retrieve the original.)";
  const attachmentRows: Statement[] = [];

  const parsed = yield* Effect.tryPromise(() => PostalMime.parse(raw)).pipe(
    Effect.tapError((error) => Effect.logWarning("Inbound message could not be parsed", { id, error })),
    Effect.orElseSucceed(() => null),
  );

  if (parsed) {
    subject = parsed.subject ?? subject;
    if (parsed.from?.address) {
      from = { address: normalizeAddress(parsed.from.address), name: parsed.from.name ?? "" };
    }
    const parsedTo = people(parsed.to);
    if (parsedTo.length) to = parsedTo;
    cc = people(parsed.cc);
    messageId = parsed.messageId ?? messageId;
    inReplyTo = parsed.inReplyTo ?? null;
    refs = parsed.references ?? null;
    const date = parsed.date ? Date.parse(parsed.date) : NaN;
    if (Number.isFinite(date)) sentAt = date;

    const body: StoredBody = { html: parsed.html ?? null, text: parsed.text ?? null };
    snippet = makeSnippet(body.text ?? (body.html ? htmlToText(body.html) : ""));
    yield* blobs.put(`body/${id}.json`, JSON.stringify(body), "application/json");

    for (const [idx, att] of (parsed.attachments ?? []).entries()) {
      const content =
        typeof att.content === "string" ? new TextEncoder().encode(att.content) : new Uint8Array(att.content);
      const contentType = att.mimeType || "application/octet-stream";
      yield* blobs.put(`att/${id}/${idx}`, content, contentType);
      attachmentRows.push(
        sql(
          "INSERT INTO attachments (id, message_id, idx, filename, content_type, size, content_id, disposition) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          newId(),
          id,
          idx,
          att.filename || `attachment-${idx + 1}`,
          contentType,
          content.byteLength,
          att.contentId ?? null,
          att.disposition === "inline" ? "inline" : "attachment",
        ),
      );
    }
  }

  yield* db.batch([
    sql(
      `INSERT INTO messages (id, user_id, rcpt_to, direction, folder, incident_id, message_id, in_reply_to,
         refs, thread_id, from_addr, from_name, to_json, cc_json, subject, snippet, sent_at, received_at,
         size, has_attachments, auth_results, sync_status)
       VALUES (?, ?, ?, 'in', 'inbox', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      owner?.user_id ?? null,
      rcpt,
      yield* getOpenIncidentId,
      messageId,
      inReplyTo,
      refs,
      threadId(refs, inReplyTo, messageId),
      from.address,
      from.name,
      JSON.stringify(to),
      JSON.stringify(cc),
      subject,
      snippet,
      sentAt,
      now(),
      raw.byteLength,
      attachmentRows.length ? 1 : 0,
      message.headers.get("authentication-results"),
      // Held mail has no mailbox to sync into until an administrator assigns it.
      owner ? "pending" : "skipped",
    ),
    ...attachmentRows,
  ]);

  return { status: owner ? "stored" : "held", id } as InboundResult;
});
