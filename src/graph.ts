import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { GraphError, GraphNotConfigured } from "./errors";
import { readJson, readText, request } from "./http";
import { AppConfig } from "./services";
import { decodePeople, type AttachmentRow, type MessageRow, type Person, type StoredBody } from "./types";
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

// ── Response schemas ─────────────────────────────────────────────────────────

const TokenResponse = Schema.Struct({ access_token: Schema.String });
const ItemId = Schema.Struct({ id: Schema.String });
const ItemList = Schema.Struct({ value: Schema.Array(ItemId) });
const UploadSession = Schema.Struct({ uploadUrl: Schema.String });

const DirectoryPage = Schema.Struct({
  value: Schema.Array(
    Schema.Struct({
      mail: Schema.optional(Schema.NullOr(Schema.String)),
      displayName: Schema.optional(Schema.NullOr(Schema.String)),
      proxyAddresses: Schema.optional(Schema.Array(Schema.String)),
      accountEnabled: Schema.optional(Schema.NullOr(Schema.Boolean)),
    }),
  ),
  "@odata.nextLink": Schema.optional(Schema.String),
});

// ── Requests ─────────────────────────────────────────────────────────────────

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

  const data = yield* readJson(response, TokenResponse);

  if (!data) {
    return yield* new GraphError({ message: "Token response had no access token.", status: response.status });
  }

  return Redacted.make(data.access_token);
});

export type GraphToken = Redacted.Redacted<string>;

interface GraphCall {
  readonly method: "GET" | "POST" | "DELETE";
  readonly path: string;
  /** A JSON-serializable request body. */
  readonly body?: object;
}

/** Sends one request to Microsoft Graph and returns the successful response. Transient failures are retried briefly. */
const send = (token: GraphToken, call: GraphCall) =>
  Effect.gen(function* () {
    const headers = new Headers({ authorization: `Bearer ${Redacted.value(token)}` });
    const init: RequestInit = { method: call.method, headers };

    if (call.body !== undefined) {
      headers.set("content-type", "application/json");
      init.body = JSON.stringify(call.body);
    }

    const url = call.path.startsWith("http") ? call.path : `${GRAPH}${call.path}`;

    const response = yield* request(url, init).pipe(
      Effect.mapError(() => new GraphError({ message: `Graph ${call.method} got no response.`, status: 0 })),
    );

    if (!response.ok) {
      const detail = (yield* readText(response)).slice(0, 300);

      return yield* new GraphError({
        message: `Graph ${call.method} ${response.status}: ${detail}`,
        status: response.status,
      });
    }

    return response;
  }).pipe(Effect.retry(retryTransient));

/** Sends a request and decodes its JSON response against `schema`. */
const fetchJson = <S extends Schema.Top>(token: GraphToken, call: GraphCall, schema: S) =>
  Effect.gen(function* () {
    const response = yield* send(token, call);
    const decoded = yield* readJson(response, schema);

    if (decoded === null) {
      return yield* new GraphError({
        message: `Graph ${call.method} returned a response in an unexpected format.`,
        status: response.status,
      });
    }

    return decoded;
  });

/** Reads the canary mailbox's Inbox folder. Fails when Exchange Online is not answering. */
export const probeMailbox = (token: GraphToken, mailbox: string) =>
  Effect.asVoid(
    send(token, { method: "GET", path: `/users/${encodeURIComponent(mailbox)}/mailFolders/inbox?$select=id` }),
  );

export interface DirectoryUser {
  email: string;
  displayName: string;
  aliases: string[];
}

/** Lists enabled users that have a mailbox address in the covered domain. */
export const listDirectoryUsers = Effect.fn("listDirectoryUsers")(function* (token: GraphToken) {
  const { mailDomain } = yield* AppConfig;
  const suffix = `@${mailDomain}`;
  const out: DirectoryUser[] = [];
  let path: string | undefined = "/users?$select=mail,displayName,proxyAddresses,accountEnabled&$top=999";

  while (path) {
    const page: typeof DirectoryPage.Type = yield* fetchJson(token, { method: "GET", path }, DirectoryPage);

    for (const entry of page.value) {
      const mail = entry.mail?.toLowerCase();

      if (!mail || !mail.endsWith(suffix) || entry.accountEnabled === false) continue;

      const aliases = (entry.proxyAddresses ?? []).flatMap((proxy) => {
        const address = proxy.toLowerCase().startsWith("smtp:") ? proxy.slice(5).toLowerCase() : "";

        return address.endsWith(suffix) && address !== mail ? [address] : [];
      });

      out.push({ email: mail, displayName: entry.displayName ?? "", aliases });
    }

    path = page["@odata.nextLink"];
  }

  return out;
});

// ── Message import ───────────────────────────────────────────────────────────

interface GraphRecipient {
  readonly emailAddress: { readonly address: string; readonly name?: string };
}

/** The JSON body that creates a message through Graph. */
export interface GraphMessage {
  readonly subject: string;
  readonly body: { readonly contentType: "html" | "text"; readonly content: string };
  readonly from: GraphRecipient;
  readonly sender: GraphRecipient;
  readonly toRecipients: ReadonlyArray<GraphRecipient>;
  readonly ccRecipients: ReadonlyArray<GraphRecipient>;
  readonly isRead: boolean;
  readonly singleValueExtendedProperties: ReadonlyArray<{ readonly id: string; readonly value: string }>;
  readonly internetMessageId?: string;
}

function recipient(person: Person): GraphRecipient {
  return person.name
    ? { emailAddress: { address: person.address, name: person.name } }
    : { emailAddress: { address: person.address } };
}

/**
 * Builds the JSON body that creates a message as a delivered item.
 *
 * Graph has no documented MIME import for non-draft items. Setting PidTagMessageFlags (0x0E07) to 1
 * at creation makes Exchange store the item as read and not a draft. 0x0E06 and 0x0039 carry the
 * original delivery and client-submit times so the item sorts where it belongs.
 */
export function buildGraphMessage(row: MessageRow, body: StoredBody): GraphMessage {
  const when = new Date(row.direction === "in" ? row.received_at : row.sent_at).toISOString();
  const sent = new Date(row.sent_at).toISOString();
  const from = recipient({ address: row.from_addr, name: row.from_name });

  const message: GraphMessage = {
    subject: row.subject,
    body: body.html
      ? { contentType: "html", content: body.html }
      : { contentType: "text", content: body.text ?? "" },
    from,
    sender: from,
    toRecipients: decodePeople(row.to_json).map(recipient),
    ccRecipients: decodePeople(row.cc_json).map(recipient),
    isRead: row.direction === "out" || row.is_read === 1,
    singleValueExtendedProperties: [
      { id: "Integer 0x0E07", value: "1" },
      { id: "SystemTime 0x0E06", value: when },
      { id: "SystemTime 0x0039", value: sent },
    ],
  };

  return row.message_id ? { ...message, internetMessageId: row.message_id } : message;
}

export interface MessageImport<E, R> {
  readonly mailbox: string;
  readonly row: MessageRow;
  readonly body: StoredBody;
  readonly attachments: ReadonlyArray<AttachmentRow>;
  readonly loadAttachment: (att: AttachmentRow) => Effect.Effect<Uint8Array, E, R>;
}

/** Writes one message into the user's Exchange Online mailbox and returns its Graph ID. */
export const importMessage = <E, R>(token: GraphToken, input: MessageImport<E, R>) =>
  Effect.gen(function* () {
    const { row, mailbox } = input;
    const user = `/users/${encodeURIComponent(mailbox)}`;
    const folder = row.folder === "sent" ? "sentitems" : "inbox";

    // Idempotency: a previous attempt may have created the item before failing later.
    if (row.message_id) {
      const filter = encodeURIComponent(`internetMessageId eq '${row.message_id.replace(/'/g, "''")}'`);

      const existing = yield* fetchJson(
        token,
        { method: "GET", path: `${user}/mailFolders/${folder}/messages?$filter=${filter}&$select=id&$top=1` },
        ItemList,
      );

      const found = existing.value[0];

      if (found) return found.id;
    }

    const created = yield* fetchJson(
      token,
      { method: "POST", path: `${user}/mailFolders/${folder}/messages`, body: buildGraphMessage(row, input.body) },
      ItemId,
    );

    const messagePath = `${user}/messages/${created.id}`;

    const attach = Effect.forEach(
      input.attachments,
      (att) =>
        Effect.gen(function* () {
          const bytes = yield* input.loadAttachment(att);

          if (bytes.byteLength >= SMALL_ATTACHMENT_BYTES) {
            return yield* uploadLargeAttachment(token, messagePath, att, bytes);
          }

          yield* send(token, {
            method: "POST",
            path: `${messagePath}/attachments`,
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
      Effect.tapError(() => send(token, { method: "DELETE", path: messagePath }).pipe(Effect.ignore)),
    );

    return created.id;
  });

const uploadLargeAttachment = (token: GraphToken, messagePath: string, att: AttachmentRow, bytes: Uint8Array) =>
  Effect.gen(function* () {
    const session = yield* fetchJson(
      token,
      {
        method: "POST",
        path: `${messagePath}/attachments/createUploadSession`,
        body: {
          AttachmentItem: {
            attachmentType: "file",
            name: att.filename,
            size: bytes.byteLength,
            contentType: att.content_type,
          },
        },
      },
      UploadSession,
    );

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
