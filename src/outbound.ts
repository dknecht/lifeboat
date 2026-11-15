import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { getUserAddresses } from "./auth";
import { ApiError, badRequest } from "./errors";
import { Blobs, Db, Mailer, sql, type Statement } from "./services";
import { getOpenIncidentId } from "./settings";
import type { MessageRow, OutgoingEmail, Person, StoredBody, UserRow } from "./types";
import { MAX_MESSAGE_BYTES, MAX_RECIPIENTS } from "./types";
import { escapeHtml, fromBase64, isValidAddress, snippetOf, newId, normalizeAddress, now } from "./util";

/** The body of `POST /api/messages`. */
export const SendInput = Schema.Struct({
  from: Schema.optional(Schema.String),
  to: Schema.Array(Schema.String),
  cc: Schema.optional(Schema.Array(Schema.String)),
  subject: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  inReplyToId: Schema.optional(Schema.String),
  attachments: Schema.optional(
    Schema.Array(
      Schema.Struct({
        filename: Schema.String,
        contentType: Schema.String,
        contentBase64: Schema.String,
      }),
    ),
  ),
});

export type SendInput = typeof SendInput.Type;

const cleanList = (list: ReadonlyArray<string> | undefined) => [
  ...new Set((list ?? []).map(normalizeAddress).filter(Boolean)),
];

/** Sends a message as the user and files it under Sent. Nothing is stored unless the send is accepted. */
export const sendMessage = Effect.fn("sendMessage")(function* (user: UserRow, input: SendInput) {
  const db = yield* Db;
  const blobs = yield* Blobs;
  const mailer = yield* Mailer;

  const own = yield* getUserAddresses(user.id);
  const from = normalizeAddress(input.from ?? user.email);

  if (!own.includes(from)) return yield* badRequest("You can only send from your own address.");

  const to = cleanList(input.to);
  const cc = cleanList(input.cc);

  if (!to.length) return yield* badRequest("Add at least one recipient.");
  const invalid = [...to, ...cc].find((a) => !isValidAddress(a));

  if (invalid) return yield* badRequest(`"${invalid}" is not a valid email address.`);

  if (to.length + cc.length > MAX_RECIPIENTS) {
    return yield* badRequest(`A message can have at most ${MAX_RECIPIENTS} recipients.`);
  }

  const subject = (input.subject ?? "").replace(/[\r\n]+/g, " ").slice(0, 998);
  const text = input.text ?? "";

  const attachments = yield* Effect.forEach(input.attachments ?? [], (a) =>
    Effect.try({
      try: () => ({
        filename: (a.filename || "attachment").replace(/[\r\n"\\/]+/g, "_").slice(0, 255),
        contentType: /^[\w.+-]+\/[\w.+-]+$/.test(a.contentType) ? a.contentType : "application/octet-stream",
        bytes: fromBase64(a.contentBase64),
        base64: a.contentBase64,
      }),
      catch: () => badRequest(`Attachment "${a.filename}" could not be read.`),
    }),
  );

  const size = text.length + attachments.reduce((n, a) => n + a.bytes.byteLength, 0);

  // Base64 inflates attachments by a third on the wire.
  if (size * 1.37 > MAX_MESSAGE_BYTES) return yield* badRequest("The message is larger than 25 MB.");

  // Threading headers, taken from the message being replied to.
  let inReplyTo: string | null = null;
  let refs: string | null = null;

  if (input.inReplyToId) {
    const parent = yield* db.first<Pick<MessageRow, "message_id" | "refs">>(
      sql("SELECT message_id, refs FROM messages WHERE id = ? AND user_id = ?", input.inReplyToId, user.id),
    );

    if (parent?.message_id) {
      inReplyTo = parent.message_id;
      refs = [parent.refs, parent.message_id].filter(Boolean).join(" ");
    }
  }

  const email: OutgoingEmail = {
    from: user.display_name ? { email: from, name: user.display_name } : from,
    to,
    subject,
    text,
    html: `<div style="white-space:pre-wrap;font-family:sans-serif">${escapeHtml(text)}</div>`,
  };

  if (cc.length) email.cc = cc;

  if (inReplyTo && refs) email.headers = { "In-Reply-To": inReplyTo, References: refs };

  if (attachments.length) {
    email.attachments = attachments.map((a) => ({
      content: a.base64,
      filename: a.filename,
      type: a.contentType,
      disposition: "attachment",
    }));
  }

  const sent = yield* mailer.send(email).pipe(
    Effect.tapError((error) => Effect.logError("Send failed", error)),
    Effect.mapError(
      (error) =>
        new ApiError({
          status: 502,
          message: `The message could not be sent${error.code ? ` (${error.code})` : ""}. Nothing was delivered; try again.`,
        }),
    ),
  );

  const id = newId();
  const messageId = sent.messageId ? (sent.messageId.startsWith("<") ? sent.messageId : `<${sent.messageId}>`) : null;
  const body: StoredBody = { html: null, text };
  yield* blobs.put(`body/${id}.json`, JSON.stringify(body), "application/json");

  const attachmentRows: Statement[] = [];

  for (const [idx, a] of attachments.entries()) {
    yield* blobs.put(`att/${id}/${idx}`, a.bytes, a.contentType);
    attachmentRows.push(
      sql(
        "INSERT INTO attachments (id, message_id, idx, filename, content_type, size, disposition) VALUES (?, ?, ?, ?, ?, ?, 'attachment')",
        newId(),
        id,
        idx,
        a.filename,
        a.contentType,
        a.bytes.byteLength,
      ),
    );
  }

  const asPeople = (list: string[]): Person[] => list.map((address) => ({ address, name: "" }));
  const ts = now();
  yield* db.batch([
    sql(
      `INSERT INTO messages (id, user_id, rcpt_to, direction, folder, incident_id, message_id, in_reply_to,
         refs, thread_id, from_addr, from_name, to_json, cc_json, subject, snippet, sent_at, received_at,
         size, has_attachments, is_read, sync_status)
       VALUES (?, ?, ?, 'out', 'sent', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'pending')`,
      id,
      user.id,
      to[0]!,
      yield* getOpenIncidentId,
      messageId,
      inReplyTo,
      refs,
      refs?.split(/\s+/)[0] ?? inReplyTo ?? messageId,
      from,
      user.display_name,
      JSON.stringify(asPeople(to)),
      JSON.stringify(asPeople(cc)),
      subject,
      snippetOf(text),
      ts,
      ts,
      size,
      attachments.length ? 1 : 0,
    ),
    ...attachmentRows,
  ]);

  return { id };
});
