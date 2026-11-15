import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { GraphError, GraphNotConfigured } from "./errors";
import { readJson, readText, request } from "./http";
import { AppConfig } from "./services";
import type { AttachmentRow, MessageRow, Person, StoredBody } from "./types";
import { toBase64 } from "./util";

const GRAPH = "https://graph.microsoft.com/v1.0";
const SMALL_ATTACHMENT_BYTES = 3 * 1024 * 1024;
// Upload session chunks must be multiples of 320 KiB.
const UPLOAD_CHUNK_BYTES = 320 * 1024 * 10;

/** Throttling and gateway errors are worth a short retry; everything else is not. */
const isTransient = (error: GraphError) => [0, 429, 502, 503, 504].includes(error.status);
const retryTransient = {
  schedule: Schedule.exponential("200 millis"),
  times: 2,
  while: isTransient,
};

const requireGraph = Effect.gen(function* () {
  const { graph } = yield* AppConfig;
  return graph ?? (yield* new GraphNotConfigured());
});

/** Requests an app-only access token with the client credentials grant. */
export const getGraphToken = Effect.gen(function* () {
  const graph = yield* requireGraph;
  const url = `https://login.microsoftonline.com/${encodeURIComponent(graph.tenantId)}/oauth2/v2.0/token`;
  const response = yield* request(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: graph.clientId,
      client_secret: Redacted.value(graph.clientSecret),
      scope: "https://graph.microsoft.com/.default",
    }),
  }).pipe(Effect.mapError(() => new GraphError({ message: "The token endpoint could not be reached.", status: 0 })));
  if (!response.ok) {
    return yield* new GraphError({
      message: `Token request failed with HTTP ${response.status}.`,
      status: response.status,
    });
  }
  const data = yield* readJson<{ access_token?: string }>(response);
  if (!data?.access_token) {
    return yield* new GraphError({ message: "Token response had no access token.", status: response.status });
  }
  return Redacted.make(data.access_token);
});

export type GraphToken = Redacted.Redacted<string>;

/** Calls Microsoft Graph and decodes the JSON response. Transient failures are retried briefly. */
const graph = <T>(token: GraphToken, path: string, init: { method?: string; body?: unknown } = {}) =>
  Effect.gen(function* () {
    const method = init.method ?? "GET";
    const response = yield* request(path.startsWith("http") ? path : `${GRAPH}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${Redacted.value(token)}`,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }).pipe(Effect.mapError(() => new GraphError({ message: `Graph ${method} got no response.`, status: 0 })));
    if (!response.ok) {
      const detail = (yield* readText(response)).slice(0, 300);
      return yield* new GraphError({
        message: `Graph ${method} ${response.status}: ${detail}`,
        status: response.status,
      });
    }
    return (response.status === 204 ? undefined : yield* readJson<T>(response)) as T;
  }).pipe(Effect.retry(retryTransient));

/** Reads the canary mailbox's Inbox folder. Fails when Exchange Online is not answering. */
export const probeMailbox = (token: GraphToken, mailbox: string) =>
  Effect.asVoid(graph(token, `/users/${encodeURIComponent(mailbox)}/mailFolders/inbox?$select=id`));

export interface DirectoryUser {
  email: string;
  displayName: string;
  aliases: string[];
}

interface DirectoryPage {
  value: { mail?: string; displayName?: string; proxyAddresses?: string[]; accountEnabled?: boolean }[];
  "@odata.nextLink"?: string;
}

/** Lists enabled users that have a mailbox address in the covered domain. */
export const listDirectoryUsers = Effect.fn("listDirectoryUsers")(function* (token: GraphToken) {
  const { mailDomain } = yield* AppConfig;
  const suffix = `@${mailDomain}`;
  const out: DirectoryUser[] = [];
  let url: string | undefined = "/users?$select=mail,displayName,proxyAddresses,accountEnabled&$top=999";
  while (url) {
    const page: DirectoryPage = yield* graph<DirectoryPage>(token, url);
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
});

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

export interface ImportInput<E, R> {
  readonly mailbox: string;
  readonly row: MessageRow;
  readonly body: StoredBody;
  readonly attachments: ReadonlyArray<AttachmentRow>;
  readonly loadAttachment: (att: AttachmentRow) => Effect.Effect<Uint8Array, E, R>;
}

/** Writes one message into the user's Exchange Online mailbox and returns its Graph ID. */
export const importMessage = <E, R>(token: GraphToken, input: ImportInput<E, R>) =>
  Effect.gen(function* () {
    const { row, mailbox } = input;
    const user = `/users/${encodeURIComponent(mailbox)}`;
    const folder = row.folder === "sent" ? "sentitems" : "inbox";

    // Idempotency: a previous attempt may have created the item before failing later.
    if (row.message_id) {
      const filter = encodeURIComponent(`internetMessageId eq '${row.message_id.replace(/'/g, "''")}'`);
      const existing = yield* graph<{ value: { id: string }[] }>(
        token,
        `${user}/mailFolders/${folder}/messages?$filter=${filter}&$select=id&$top=1`,
      );
      if (existing.value[0]) return existing.value[0].id;
    }

    const created = yield* graph<{ id: string }>(token, `${user}/mailFolders/${folder}/messages`, {
      method: "POST",
      body: buildGraphMessage(row, input.body),
    });
    const messagePath = `${user}/messages/${created.id}`;

    const attach = Effect.forEach(
      input.attachments,
      (att) =>
        Effect.gen(function* () {
          const bytes = yield* input.loadAttachment(att);
          if (bytes.byteLength >= SMALL_ATTACHMENT_BYTES) {
            return yield* uploadLargeAttachment(token, messagePath, att, bytes);
          }
          yield* graph(token, `${messagePath}/attachments`, {
            method: "POST",
            body: {
              "@odata.type": "#microsoft.graph.fileAttachment",
              name: att.filename,
              contentType: att.content_type,
              contentBytes: toBase64(bytes),
              isInline: att.disposition === "inline",
              contentId: att.content_id ?? undefined,
            },
          });
        }),
      { discard: true },
    );

    // If attaching fails, remove the partial item so the retry does not find it and treat it as complete.
    yield* attach.pipe(
      Effect.tapError(() => graph(token, messagePath, { method: "DELETE" }).pipe(Effect.ignore)),
    );
    return created.id;
  });

const uploadLargeAttachment = (token: GraphToken, messagePath: string, att: AttachmentRow, bytes: Uint8Array) =>
  Effect.gen(function* () {
    const session = yield* graph<{ uploadUrl: string }>(token, `${messagePath}/attachments/createUploadSession`, {
      method: "POST",
      body: {
        AttachmentItem: {
          attachmentType: "file",
          name: att.filename,
          size: bytes.byteLength,
          contentType: att.content_type,
        },
      },
    });
    for (let start = 0; start < bytes.byteLength; start += UPLOAD_CHUNK_BYTES) {
      const end = Math.min(start + UPLOAD_CHUNK_BYTES, bytes.byteLength);
      // The upload URL is pre-authenticated; it must not receive the bearer token.
      const response = yield* request(session.uploadUrl, {
        method: "PUT",
        headers: {
          "content-type": "application/octet-stream",
          "content-range": `bytes ${start}-${end - 1}/${bytes.byteLength}`,
        },
        body: bytes.subarray(start, end),
      }).pipe(Effect.mapError(() => new GraphError({ message: "Attachment upload got no response.", status: 0 })));
      if (!response.ok) {
        return yield* new GraphError({
          message: `Attachment upload failed with HTTP ${response.status}.`,
          status: response.status,
        });
      }
    }
  });
