import type { AttachmentRow, Env, MessageRow, Person, StoredBody } from "./types";
import { toBase64 } from "./util";

const GRAPH = "https://graph.microsoft.com/v1.0";
const SMALL_ATTACHMENT_BYTES = 3 * 1024 * 1024;
// Upload session chunks must be multiples of 320 KiB.
const UPLOAD_CHUNK_BYTES = 320 * 1024 * 10;

export class GraphError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export function graphConfigured(env: Env): boolean {
  return Boolean(env.GRAPH_TENANT_ID && env.GRAPH_CLIENT_ID && env.GRAPH_CLIENT_SECRET);
}

export async function getGraphToken(env: Env): Promise<string> {
  if (!graphConfigured(env)) throw new GraphError("Microsoft Graph is not configured.", 0);
  const res = await fetch(
    `https://login.microsoftonline.com/${encodeURIComponent(env.GRAPH_TENANT_ID)}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: env.GRAPH_CLIENT_ID,
        client_secret: env.GRAPH_CLIENT_SECRET!,
        scope: "https://graph.microsoft.com/.default",
      }),
    },
  );
  if (!res.ok) throw new GraphError(`Token request failed with HTTP ${res.status}.`, res.status);
  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) throw new GraphError("Token response had no access token.", res.status);
  return data.access_token;
}

async function graph<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path.startsWith("http") ? path : `${GRAPH}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new GraphError(`Graph ${init.method ?? "GET"} ${res.status}: ${detail}`, res.status);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

/** Reads the canary mailbox's Inbox folder. Throws when Exchange Online is not answering. */
export async function probeMailbox(env: Env, token: string): Promise<void> {
  await graph(token, `/users/${encodeURIComponent(env.GRAPH_CANARY_MAILBOX)}/mailFolders/inbox?$select=id`);
}

export interface DirectoryUser {
  email: string;
  displayName: string;
  aliases: string[];
}

/** Lists enabled users that have a mailbox address in the covered domain. */
export async function listDirectoryUsers(env: Env, token: string): Promise<DirectoryUser[]> {
  const suffix = `@${env.MAIL_DOMAIN.toLowerCase()}`;
  const out: DirectoryUser[] = [];
  let url: string | undefined =
    "/users?$select=mail,displayName,proxyAddresses,accountEnabled&$top=999";
  while (url) {
    const page: {
      value: { mail?: string; displayName?: string; proxyAddresses?: string[]; accountEnabled?: boolean }[];
      "@odata.nextLink"?: string;
    } = await graph(token, url);
    for (const u of page.value) {
      const mail = u.mail?.toLowerCase();
      if (!mail || !mail.endsWith(suffix) || u.accountEnabled === false) continue;
      const aliases = (u.proxyAddresses ?? [])
        .filter((p) => p.toLowerCase().startsWith("smtp:"))
        .map((p) => p.slice(5).toLowerCase())
        .filter((a) => a.endsWith(suffix) && a !== mail);
      out.push({ email: mail, displayName: u.displayName ?? "", aliases });
    }
    url = page["@odata.nextLink"];
  }
  return out;
}

const recipient = (p: Person) => ({ emailAddress: { address: p.address, name: p.name || undefined } });

/**
 * Builds the JSON body that creates a message as a delivered item.
 *
 * Graph has no documented MIME import for non-draft items. Setting PidTagMessageFlags (0x0E07) to 1
 * at creation makes Exchange store the item as read and not a draft. 0x0E06 and 0x0039 carry the
 * original delivery and client-submit times so the item sorts where it belongs.
 */
export function buildGraphMessage(row: MessageRow, body: StoredBody): Record<string, unknown> {
  const when = new Date(row.direction === "in" ? row.received_at : row.sent_at).toISOString();
  const sent = new Date(row.sent_at).toISOString();
  const from = recipient({ address: row.from_addr, name: row.from_name });
  const message: Record<string, unknown> = {
    subject: row.subject,
    body: body.html
      ? { contentType: "html", content: body.html }
      : { contentType: "text", content: body.text ?? "" },
    from,
    sender: from,
    toRecipients: (JSON.parse(row.to_json) as Person[]).map(recipient),
    ccRecipients: (JSON.parse(row.cc_json) as Person[]).map(recipient),
    isRead: row.direction === "out" || row.is_read === 1,
    singleValueExtendedProperties: [
      { id: "Integer 0x0E07", value: "1" },
      { id: "SystemTime 0x0E06", value: when },
      { id: "SystemTime 0x0039", value: sent },
    ],
  };
  if (row.message_id) message.internetMessageId = row.message_id;
  return message;
}

export interface ImportInput {
  mailbox: string;
  row: MessageRow;
  body: StoredBody;
  attachments: AttachmentRow[];
  loadAttachment: (att: AttachmentRow) => Promise<Uint8Array>;
}

/** Writes one message into the user's Exchange Online mailbox and returns its Graph ID. */
export async function importMessage(token: string, input: ImportInput): Promise<string> {
  const { row, mailbox } = input;
  const user = `/users/${encodeURIComponent(mailbox)}`;
  const folder = row.folder === "sent" ? "sentitems" : "inbox";

  // Idempotency: a previous attempt may have created the item before failing later.
  if (row.message_id) {
    const filter = encodeURIComponent(`internetMessageId eq '${row.message_id.replace(/'/g, "''")}'`);
    const existing = await graph<{ value: { id: string }[] }>(
      token,
      `${user}/mailFolders/${folder}/messages?$filter=${filter}&$select=id&$top=1`,
    );
    if (existing.value[0]) return existing.value[0].id;
  }

  const created = await graph<{ id: string }>(token, `${user}/mailFolders/${folder}/messages`, {
    method: "POST",
    body: JSON.stringify(buildGraphMessage(row, input.body)),
  });

  try {
    for (const att of input.attachments) {
      const bytes = await input.loadAttachment(att);
      if (bytes.byteLength < SMALL_ATTACHMENT_BYTES) {
        await graph(token, `${user}/messages/${created.id}/attachments`, {
          method: "POST",
          body: JSON.stringify({
            "@odata.type": "#microsoft.graph.fileAttachment",
            name: att.filename,
            contentType: att.content_type,
            contentBytes: toBase64(bytes),
            isInline: att.disposition === "inline",
            contentId: att.content_id ?? undefined,
          }),
        });
      } else {
        await uploadLargeAttachment(token, `${user}/messages/${created.id}`, att, bytes);
      }
    }
  } catch (err) {
    // Remove the partial item so that the retry does not find it and treat it as complete.
    await graph(token, `${user}/messages/${created.id}`, { method: "DELETE" }).catch(() => {});
    throw err;
  }
  return created.id;
}

async function uploadLargeAttachment(
  token: string,
  messagePath: string,
  att: AttachmentRow,
  bytes: Uint8Array,
): Promise<void> {
  const session = await graph<{ uploadUrl: string }>(token, `${messagePath}/attachments/createUploadSession`, {
    method: "POST",
    body: JSON.stringify({
      AttachmentItem: { attachmentType: "file", name: att.filename, size: bytes.byteLength, contentType: att.content_type },
    }),
  });
  for (let start = 0; start < bytes.byteLength; start += UPLOAD_CHUNK_BYTES) {
    const end = Math.min(start + UPLOAD_CHUNK_BYTES, bytes.byteLength);
    // The upload URL is pre-authenticated; it must not receive the bearer token.
    const res = await fetch(session.uploadUrl, {
      method: "PUT",
      headers: {
        "content-type": "application/octet-stream",
        "content-range": `bytes ${start}-${end - 1}/${bytes.byteLength}`,
      },
      body: bytes.subarray(start, end),
    });
    if (!res.ok) throw new GraphError(`Attachment upload failed with HTTP ${res.status}.`, res.status);
  }
}
