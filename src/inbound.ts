import PostalMime from "postal-mime";
import { getOpenIncidentId } from "./db";
import type { Env, Person, StoredBody } from "./types";
import { MAX_MESSAGE_BYTES } from "./types";
import { htmlToText, makeSnippet, newId, normalizeAddress, now } from "./util";

/** The subset of Cloudflare's ForwardableEmailMessage that Lifeboat uses. */
export interface InboundEmail {
  readonly from: string;
  readonly to: string;
  readonly headers: Headers;
  readonly raw: ReadableStream<Uint8Array>;
  readonly rawSize: number;
  setReject(reason: string): void;
}

export interface InboundResult {
  status: "stored" | "held" | "rejected";
  id?: string;
}

function people(list: { address?: string; name?: string }[] | undefined): Person[] {
  return (list ?? [])
    .filter((p) => p.address)
    .map((p) => ({ address: normalizeAddress(p.address!), name: p.name ?? "" }));
}

function threadId(refs: string | null, inReplyTo: string | null, messageId: string | null): string | null {
  const first = refs?.trim().split(/\s+/)[0];
  return first || inReplyTo || messageId;
}

export async function handleInbound(message: InboundEmail, env: Env): Promise<InboundResult> {
  if (message.rawSize > MAX_MESSAGE_BYTES) {
    message.setReject("Message too large");
    return { status: "rejected" };
  }

  const rcpt = normalizeAddress(message.to);
  const owner = await env.DB.prepare("SELECT user_id FROM addresses WHERE address = ?")
    .bind(rcpt)
    .first<{ user_id: string }>();
  if (!owner && env.UNKNOWN_RECIPIENT === "reject") {
    message.setReject("Address does not exist");
    return { status: "rejected" };
  }

  const id = newId();
  const raw = new Uint8Array(await new Response(message.raw).arrayBuffer());

  // Durability point: once the raw message is in R2 it can always be recovered.
  await env.MAIL.put(`raw/${id}.eml`, raw, {
    httpMetadata: { contentType: "message/rfc822" },
    customMetadata: { rcpt, from: message.from },
  });

  let subject = message.headers.get("subject") ?? "";
  let from: Person = { address: normalizeAddress(message.from), name: "" };
  let to: Person[] = [{ address: rcpt, name: "" }];
  let cc: Person[] = [];
  let messageId = message.headers.get("message-id");
  let inReplyTo: string | null = null;
  let refs: string | null = null;
  let sentAt = now();
  let snippet = "";
  const attachmentRows: D1PreparedStatement[] = [];

  try {
    const parsed = await PostalMime.parse(raw);
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
    await env.MAIL.put(`body/${id}.json`, JSON.stringify(body), {
      httpMetadata: { contentType: "application/json" },
    });

    let idx = 0;
    for (const att of parsed.attachments ?? []) {
      const content =
        typeof att.content === "string" ? new TextEncoder().encode(att.content) : new Uint8Array(att.content);
      const contentType = att.mimeType || "application/octet-stream";
      await env.MAIL.put(`att/${id}/${idx}`, content, { httpMetadata: { contentType } });
      attachmentRows.push(
        env.DB.prepare(
          "INSERT INTO attachments (id, message_id, idx, filename, content_type, size, content_id, disposition) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ).bind(
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
      idx++;
    }
  } catch (err) {
    // The raw message is already stored; index it with envelope data so it is still visible.
    console.error("parse failed", id, err);
    snippet = "(This message could not be parsed. An administrator can retrieve the original.)";
  }

  const insert = env.DB.prepare(
    `INSERT INTO messages (id, user_id, rcpt_to, direction, folder, incident_id, message_id, in_reply_to,
       refs, thread_id, from_addr, from_name, to_json, cc_json, subject, snippet, sent_at, received_at,
       size, has_attachments, auth_results, sync_status)
     VALUES (?, ?, ?, 'in', 'inbox', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id,
    owner?.user_id ?? null,
    rcpt,
    await getOpenIncidentId(env),
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
    owner ? "pending" : "skipped",
  );
  await env.DB.batch([insert, ...attachmentRows]);

  return { status: owner ? "stored" : "held", id };
}
