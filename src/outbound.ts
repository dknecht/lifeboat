import { getUserAddresses } from "./auth";
import { getOpenIncidentId } from "./db";
import type { Env, MessageRow, OutgoingEmail, Person, StoredBody, UserRow } from "./types";
import { MAX_MESSAGE_BYTES, MAX_RECIPIENTS } from "./types";
import { escapeHtml, fromBase64, isValidAddress, makeSnippet, newId, normalizeAddress, now } from "./util";

export interface SendInput {
  from?: string;
  to: string[];
  cc?: string[];
  subject: string;
  text: string;
  inReplyToId?: string;
  attachments?: { filename: string; contentType: string; contentBase64: string }[];
}

export class SendError extends Error {
  constructor(
    message: string,
    public status: 400 | 502 = 400,
  ) {
    super(message);
  }
}

function cleanList(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.filter((x): x is string => typeof x === "string").map(normalizeAddress))].filter(
    Boolean,
  );
}

export async function sendMessage(env: Env, user: UserRow, input: SendInput): Promise<{ id: string }> {
  const own = await getUserAddresses(env, user.id);
  const from = normalizeAddress(input.from ?? user.email);
  if (!own.includes(from)) throw new SendError("You can only send from your own address.");

  const to = cleanList(input.to);
  const cc = cleanList(input.cc);
  if (!to.length) throw new SendError("Add at least one recipient.");
  const invalid = [...to, ...cc].find((a) => !isValidAddress(a));
  if (invalid) throw new SendError(`"${invalid}" is not a valid email address.`);
  if (to.length + cc.length > MAX_RECIPIENTS) {
    throw new SendError(`A message can have at most ${MAX_RECIPIENTS} recipients.`);
  }

  const subject = String(input.subject ?? "").replace(/[\r\n]+/g, " ").slice(0, 998);
  const text = String(input.text ?? "");

  const attachments = (input.attachments ?? []).map((a) => {
    let bytes: Uint8Array;
    try {
      bytes = fromBase64(String(a.contentBase64 ?? ""));
    } catch {
      throw new SendError(`Attachment "${a.filename}" could not be read.`);
    }
    return {
      filename: String(a.filename || "attachment").replace(/[\r\n"\\/]+/g, "_").slice(0, 255),
      contentType: /^[\w.+-]+\/[\w.+-]+$/.test(a.contentType) ? a.contentType : "application/octet-stream",
      bytes,
      base64: a.contentBase64,
    };
  });
  const size = text.length + attachments.reduce((n, a) => n + a.bytes.byteLength, 0);
  // Base64 inflates attachments by a third on the wire.
  if (size * 1.37 > MAX_MESSAGE_BYTES) throw new SendError("The message is larger than 25 MB.");

  // Threading headers, taken from the message being replied to.
  let inReplyTo: string | null = null;
  let refs: string | null = null;
  if (input.inReplyToId) {
    const parent = await env.DB.prepare(
      "SELECT message_id, refs FROM messages WHERE id = ? AND user_id = ?",
    )
      .bind(input.inReplyToId, user.id)
      .first<Pick<MessageRow, "message_id" | "refs">>();
    if (parent?.message_id) {
      inReplyTo = parent.message_id;
      refs = [parent.refs, parent.message_id].filter(Boolean).join(" ");
    }
  }

  const headers: Record<string, string> = {};
  if (inReplyTo) headers["In-Reply-To"] = inReplyTo;
  if (refs) headers["References"] = refs;

  const email: OutgoingEmail = {
    from: user.display_name ? { email: from, name: user.display_name } : from,
    to,
    subject,
    text,
    html: `<div style="white-space:pre-wrap;font-family:sans-serif">${escapeHtml(text)}</div>`,
  };
  if (cc.length) email.cc = cc;
  if (Object.keys(headers).length) email.headers = headers;
  if (attachments.length) {
    email.attachments = attachments.map((a) => ({
      content: a.base64,
      filename: a.filename,
      type: a.contentType,
      disposition: "attachment" as const,
    }));
  }

  let platformId: string | undefined;
  try {
    platformId = (await env.EMAIL.send(email)).messageId;
  } catch (err) {
    console.error("send failed", err);
    const code = (err as { code?: string }).code;
    throw new SendError(
      `The message could not be sent${code ? ` (${code})` : ""}. Nothing was delivered; try again.`,
      502,
    );
  }

  const id = newId();
  const messageId = platformId ? (platformId.startsWith("<") ? platformId : `<${platformId}>`) : null;
  const body: StoredBody = { html: null, text };
  await env.MAIL.put(`body/${id}.json`, JSON.stringify(body), {
    httpMetadata: { contentType: "application/json" },
  });
  const statements: D1PreparedStatement[] = [];
  for (const [idx, a] of attachments.entries()) {
    await env.MAIL.put(`att/${id}/${idx}`, a.bytes, { httpMetadata: { contentType: a.contentType } });
    statements.push(
      env.DB.prepare(
        "INSERT INTO attachments (id, message_id, idx, filename, content_type, size, disposition) VALUES (?, ?, ?, ?, ?, ?, 'attachment')",
      ).bind(newId(), id, idx, a.filename, a.contentType, a.bytes.byteLength),
    );
  }

  const asPeople = (list: string[]): Person[] => list.map((address) => ({ address, name: "" }));
  const ts = now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO messages (id, user_id, rcpt_to, direction, folder, incident_id, message_id, in_reply_to,
         refs, thread_id, from_addr, from_name, to_json, cc_json, subject, snippet, sent_at, received_at,
         size, has_attachments, is_read, sync_status)
       VALUES (?, ?, ?, 'out', 'sent', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'pending')`,
    ).bind(
      id,
      user.id,
      to[0]!,
      await getOpenIncidentId(env),
      messageId,
      inReplyTo,
      refs,
      refs?.split(/\s+/)[0] ?? inReplyTo ?? messageId,
      from,
      user.display_name,
      JSON.stringify(asPeople(to)),
      JSON.stringify(asPeople(cc)),
      subject,
      makeSnippet(text),
      ts,
      ts,
      size,
      attachments.length ? 1 : 0,
    ),
    ...statements,
  ]);
  return { id };
}
