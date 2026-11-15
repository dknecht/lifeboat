import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { ACCESS_HEADER, verifyAccessToken } from "./access";
import {
  MIN_PASSWORD_LENGTH,
  SESSION_COOKIE,
  acceptInvite,
  createUser,
  getSessionUser,
  getUserAddresses,
  getUserByAddress,
  getUserById,
  getUserByEmail,
  issueInvite,
  login,
  logout,
  sessionCookie,
  setRole,
} from "./auth";
import {
  ApiError,
  accessRequired,
  badRequest,
  conflict,
  forbidden,
  notFound,
  unauthorized,
  type BlobError,
  type DbError,
  type FailoverError,
  type GraphError,
  type GraphNotConfigured,
} from "./errors";
import { activate, deactivate, manualInstructions } from "./failover";
import { getGraphToken, listDirectoryUsers } from "./graph";
import { getProbeHealth } from "./health";
import { SendInput, sendMessage } from "./outbound";
import { AppConfig, Blobs, Db, Mailer, sql, type AppServices } from "./services";
import { audit, getState } from "./settings";
import { finishRecoveryIfDrained, runSyncBatch } from "./sync";
import { decodePeople, type AttachmentRow, type MessageRow, type StoredBody, type UserRow } from "./types";
import { isValidAddress, normalizeAddress, timingSafeEqual } from "./util";

// ── Request context ──────────────────────────────────────────────────────────

type Actor =
  /** A person, and how they proved who they are: a Lifeboat session or a Cloudflare Access token. */
  | { readonly kind: "user"; readonly user: UserRow; readonly via: "session" | "access" }
  /** Automation: the admin token, or an Access service token that is allowed to administer. */
  | { readonly kind: "token" };

interface Ctx {
  readonly request: Request;
  readonly url: URL;
  readonly params: Record<string, string>;
  readonly actor: Actor | null;
}

/** Builds a JSON response. Each handler passes its own typed view of the data. */
const json = <Body extends object>(body: Body, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });

const cookie = (request: Request, name: string) =>
  request.headers
    .get("cookie")
    ?.split(/;\s*/)
    .map((pair) => pair.split("="))
    .find(([key]) => key === name)?.[1] ?? null;

/**
 * Finds the Lifeboat user for someone Access has already authenticated.
 *
 * Access decides who may come in, so a person without a Lifeboat account gets one on arrival if
 * they are a listed administrator or their address is in the mail domain. Anyone else is refused.
 */
const userFromAccess = Effect.fn("userFromAccess")(function* (email: string) {
  const config = yield* AppConfig;
  const isAdmin = config.accessAdminEmails.includes(email);
  const existing = yield* getUserByAddress(email);

  if (existing) {
    if (isAdmin && existing.role !== "admin") {
      yield* setRole(existing.id, "admin");

      return { ...existing, role: "admin" } satisfies UserRow;
    }

    return existing;
  }

  if (!isAdmin && !email.endsWith(`@${config.mailDomain}`)) return null;

  const { user } = yield* createUser({ email, role: isAdmin ? "admin" : "user" });

  yield* audit(email, "user.provisioned", "Created on first sign-in through Cloudflare Access.");

  return user;
});

/** Resolves an identity from the Access token on the request, or null if there is none worth trusting. */
const actorFromAccess = Effect.fn("actorFromAccess")(function* (request: Request) {
  const config = yield* AppConfig;
  const token = request.headers.get(ACCESS_HEADER);

  // In local mode the header is ignored entirely, so it cannot be used to claim an identity.
  if (!token || config.authMode === "local") return null;

  const identity = yield* verifyAccessToken(token).pipe(
    Effect.tapError((error) => Effect.logWarning(`Access token refused: ${error.reason}`)),
    Effect.orElseSucceed(() => null),
  );

  if (!identity) return null;

  if (identity.kind === "service") {
    const automation: Actor | null = config.accessAdminServiceTokens.includes(identity.clientId)
      ? { kind: "token" }
      : null;

    return automation;
  }

  const user = yield* userFromAccess(identity.email);
  const person: Actor | null = user ? { kind: "user", user, via: "access" } : null;

  return person;
});

/** Resolves who is calling: someone Access vouches for, the automation token, a session, or nobody. */
const resolveActor = Effect.fn("resolveActor")(function* (request: Request) {
  const config = yield* AppConfig;
  const fromAccess = yield* actorFromAccess(request);

  if (fromAccess) return fromAccess;

  const bearer = request.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1];

  if (bearer && config.adminToken && timingSafeEqual(bearer, Redacted.value(config.adminToken))) {
    const automation: Actor = { kind: "token" };

    return automation;
  }

  // In access mode Lifeboat sessions do not exist; Access is the only way in.
  if (config.authMode === "access") return null;

  const token = cookie(request, SESSION_COOKIE);
  const user = token ? yield* getSessionUser(token) : null;
  const signedIn: Actor | null = user ? { kind: "user", user, via: "session" } : null;

  return signedIn;
});

const requireUser = (ctx: Ctx) =>
  ctx.actor?.kind === "user" ? Effect.succeed(ctx.actor.user) : Effect.fail(unauthorized());

/** Admits administrators and automation, and returns a name for the audit log. */
const requireAdmin = (ctx: Ctx) =>
  Effect.gen(function* () {
    const config = yield* AppConfig;

    // Outside local mode the admin console is only open to people who came through Access.
    if (!ctx.actor) return yield* config.authMode === "local" ? unauthorized() : accessRequired();

    if (ctx.actor.kind === "token") return "admin-token";

    if (ctx.actor.user.role !== "admin") return yield* forbidden();

    if (config.authMode !== "local" && ctx.actor.via !== "access") return yield* accessRequired();

    return ctx.actor.user.email;
  });

/** Refuses a password-based route when Access is the only way to sign in. */
const requireLocalSignIn = Effect.gen(function* () {
  const config = yield* AppConfig;

  if (config.authMode === "access") return yield* conflict("Sign in through Cloudflare Access.");
});

/** Decodes the JSON request body against a schema, failing with a 400 that carries `message`. */
const body = <S extends Schema.Top>(ctx: Ctx, schema: S, message: string) =>
  Effect.promise(() => ctx.request.json().catch(() => ({}))).pipe(
    Effect.flatMap((raw) => Schema.decodeUnknownEffect(schema)(raw)),
    Effect.mapError(() => badRequest(message)),
  );

const isSecure = (ctx: Ctx) => ctx.url.protocol === "https:";

// ── Views ────────────────────────────────────────────────────────────────────

const publicUser = (u: UserRow) => ({ id: u.id, email: u.email, displayName: u.display_name, role: u.role });

function listItem(m: MessageRow) {
  return {
    id: m.id,
    folder: m.folder,
    from: { address: m.from_addr, name: m.from_name },
    to: decodePeople(m.to_json),
    cc: decodePeople(m.cc_json),
    rcptTo: m.rcpt_to,
    subject: m.subject,
    snippet: m.snippet,
    date: m.direction === "in" ? m.received_at : m.sent_at,
    hasAttachments: m.has_attachments === 1,
    isRead: m.is_read === 1,
    syncStatus: m.sync_status,
  };
}

// ── Public and session routes ────────────────────────────────────────────────

const Credentials = Schema.Struct({ email: Schema.String, password: Schema.String });
const InviteAcceptance = Schema.Struct({ token: Schema.String, password: Schema.String });

const status = () =>
  Effect.gen(function* () {
    const config = yield* AppConfig;

    return json({ state: yield* getState, domain: config.mailDomain, authMode: config.authMode });
  });

const postLogin = (ctx: Ctx) =>
  Effect.gen(function* () {
    yield* requireLocalSignIn;

    const input = yield* body(ctx, Credentials, "Enter your email address and password.");

    const result = yield* login(input.email, input.password).pipe(
      Effect.catchTag("LoginRejected", (rejection) =>
        Effect.fail(
          rejection.reason === "locked"
            ? new ApiError({ status: 429, message: "Too many failed attempts. Try again in 15 minutes." })
            : new ApiError({ status: 401, message: "The email address or password is incorrect." }),
        ),
      ),
    );

    return json({ user: publicUser(result.user) }, 200, {
      "set-cookie": sessionCookie(result.token, isSecure(ctx)),
    });
  });

const postAcceptInvite = (ctx: Ctx) =>
  Effect.gen(function* () {
    yield* requireLocalSignIn;

    const input = yield* body(ctx, InviteAcceptance, "The invite link is incomplete.");

    if (input.password.length < MIN_PASSWORD_LENGTH) {
      return yield* badRequest(`Choose a password of at least ${MIN_PASSWORD_LENGTH} characters.`);
    }

    const user = yield* acceptInvite(input.token, input.password);

    if (!user) {
      return yield* badRequest("This invite link is invalid or has expired. Ask an administrator for a new one.");
    }

    yield* audit(user.email, "user.enrolled");

    return json({ email: user.email });
  });

const postLogout = (ctx: Ctx) =>
  Effect.gen(function* () {
    const token = cookie(ctx.request, SESSION_COOKIE);

    if (token) yield* logout(token);

    return json({ ok: true }, 200, { "set-cookie": sessionCookie("", isSecure(ctx), true) });
  });

const getMe = (ctx: Ctx) =>
  Effect.gen(function* () {
    const user = yield* requireUser(ctx);
    const config = yield* AppConfig;

    return json({
      user: publicUser(user),
      addresses: yield* getUserAddresses(user.id),
      state: yield* getState,
      authMode: config.authMode,
      via: ctx.actor?.kind === "user" ? ctx.actor.via : "session",
    });
  });

/** Where the Access sign-in page sends people once Access has let them through. */
const AFTER_ACCESS = { admin: "/#/admin", inbox: "/#/inbox" };

/**
 * A page to navigate to, not to fetch. Access intercepts the navigation, signs the person in, and
 * lets the request through; Lifeboat then sends them back into the app.
 */
const accessLogin = (ctx: Ctx) =>
  Effect.gen(function* () {
    if (ctx.actor?.kind !== "user" || ctx.actor.via !== "access") {
      return new Response(
        "Cloudflare Access did not sign you in. Check that an Access application covers this address and that your account is allowed.",
        { status: 401, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } },
      );
    }

    const next = ctx.url.searchParams.get("next") === "inbox" ? "inbox" : "admin";

    return new Response(null, { status: 302, headers: { location: AFTER_ACCESS[next], "cache-control": "no-store" } });
  });

// ── Mail routes ──────────────────────────────────────────────────────────────

const PAGE_SIZE = 50;

const listMessages = (ctx: Ctx) =>
  Effect.gen(function* () {
    const user = yield* requireUser(ctx);
    const db = yield* Db;
    const folder = ctx.url.searchParams.get("folder") === "sent" ? "sent" : "inbox";
    // The cursor is "<timestamp>.<id>" of the last row on the previous page.
    const [ts, id] = (ctx.url.searchParams.get("cursor") ?? "").split(".");
    const before = Number(ts);
    const paged = Number.isFinite(before) && before > 0 && id;

    const rows = yield* db.all<MessageRow>(
      sql(
        `SELECT * FROM messages WHERE user_id = ? AND folder = ?
         ${paged ? "AND (received_at < ? OR (received_at = ? AND id < ?))" : ""}
         ORDER BY received_at DESC, id DESC LIMIT ?`,
        ...(paged ? [user.id, folder, before, before, id, PAGE_SIZE + 1] : [user.id, folder, PAGE_SIZE + 1]),
      ),
    );

    const page = rows.slice(0, PAGE_SIZE);
    const last = page[page.length - 1];

    const unread = yield* db.first<{ n: number }>(
      sql("SELECT COUNT(*) AS n FROM messages WHERE user_id = ? AND folder = 'inbox' AND is_read = 0", user.id),
    );

    return json({
      messages: page.map(listItem),
      nextCursor: rows.length > PAGE_SIZE && last ? `${last.received_at}.${last.id}` : null,
      unread: unread?.n ?? 0,
    });
  });

const getMessage = (ctx: Ctx) =>
  Effect.gen(function* () {
    const user = yield* requireUser(ctx);
    const db = yield* Db;
    const blobs = yield* Blobs;
    const id = ctx.params.id!;
    const row = yield* db.first<MessageRow>(sql("SELECT * FROM messages WHERE id = ? AND user_id = ?", id, user.id));

    if (!row) return yield* notFound("Message not found.");
    const stored = (yield* blobs.getJson<StoredBody>(`body/${id}.json`)) ?? { html: null, text: null };

    const attachments = yield* db.all<AttachmentRow>(
      sql("SELECT * FROM attachments WHERE message_id = ? ORDER BY idx", id),
    );

    if (!row.is_read) yield* db.run(sql("UPDATE messages SET is_read = 1 WHERE id = ?", id));

    return json({
      message: {
        ...listItem(row),
        isRead: true,
        messageId: row.message_id,
        body: stored,
        attachments: attachments.map((a) => ({
          idx: a.idx,
          filename: a.filename,
          contentType: a.content_type,
          size: a.size,
          inline: a.disposition === "inline",
        })),
      },
    });
  });

const getAttachment = (ctx: Ctx) =>
  Effect.gen(function* () {
    const user = yield* requireUser(ctx);
    const db = yield* Db;
    const blobs = yield* Blobs;

    const att = yield* db.first<AttachmentRow>(
      sql(
        `SELECT a.* FROM attachments a JOIN messages m ON m.id = a.message_id
         WHERE a.message_id = ? AND a.idx = ? AND m.user_id = ?`,
        ctx.params.id,
        Number(ctx.params.idx),
        user.id,
      ),
    );

    const stream = att ? yield* blobs.getStream(`att/${att.message_id}/${att.idx}`) : null;

    if (!att || !stream) return yield* notFound("Attachment not found.");

    // Always a download with a generic type, so that an attachment can never run in the app's origin.
    return new Response(stream, {
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(att.filename)}`,
        "x-content-type-options": "nosniff",
        "cache-control": "private, no-store",
      },
    });
  });

const postMessage = (ctx: Ctx) =>
  Effect.gen(function* () {
    const user = yield* requireUser(ctx);
    const input = yield* body(ctx, SendInput, "The message is missing recipients or is malformed.");

    return json(yield* sendMessage(user, input), 201);
  });

// ── Admin routes ─────────────────────────────────────────────────────────────

const overview = (ctx: Ctx) =>
  Effect.gen(function* () {
    yield* requireAdmin(ctx);
    const config = yield* AppConfig;
    const db = yield* Db;
    const state = yield* getState;

    const [sync, users, held, incident] = yield* Effect.all(
      [
        db.all<{ status: MessageRow["sync_status"]; n: number }>(
          sql("SELECT sync_status AS status, COUNT(*) AS n FROM messages GROUP BY sync_status"),
        ),
        db.first<{ total: number; enrolled: number | null }>(
          sql("SELECT COUNT(*) AS total, SUM(password_hash IS NOT NULL) AS enrolled FROM users WHERE disabled = 0"),
        ),
        db.first<{ n: number }>(sql("SELECT COUNT(*) AS n FROM messages WHERE user_id IS NULL")),
        db.first(sql("SELECT * FROM incidents ORDER BY started_at DESC LIMIT 1")),
      ],
      { concurrency: "unbounded" },
    );

    const counts = { pending: 0, synced: 0, failed: 0, skipped: 0 };

    for (const r of sync) counts[r.status] = r.n;

    return json({
      state,
      domain: config.mailDomain,
      dnsMode: config.dnsMode,
      autoFailover: config.autoFailover,
      graphConfigured: config.graph !== null,
      probe: yield* getProbeHealth,
      incident,
      sync: counts,
      users: { total: users?.total ?? 0, enrolled: users?.enrolled ?? 0 },
      held: held?.n ?? 0,
      instructions:
        config.dnsMode === "api"
          ? []
          : state === "active"
            ? manualInstructions(config, "activate")
            : state === "recovering"
              ? manualInstructions(config, "deactivate")
              : [],
    });
  });

const postActivate = (ctx: Ctx) =>
  Effect.gen(function* () {
    const actor = yield* requireAdmin(ctx);
    const input = yield* body(ctx, Schema.Struct({ reason: Schema.optional(Schema.String) }), "Invalid request.");

    return json(yield* activate(actor, input.reason ?? ""));
  });

const postDeactivate = (ctx: Ctx) =>
  Effect.gen(function* () {
    const actor = yield* requireAdmin(ctx);

    return json(yield* deactivate(actor));
  });

const listUsers = (ctx: Ctx) =>
  Effect.gen(function* () {
    yield* requireAdmin(ctx);
    const db = yield* Db;

    const rows = yield* db.all<{
      id: string;
      email: string;
      display_name: string;
      role: string;
      enrolled: number;
      aliases: string | null;
    }>(
      sql(
        `SELECT u.id, u.email, u.display_name, u.role, u.password_hash IS NOT NULL AS enrolled,
           (SELECT GROUP_CONCAT(address) FROM addresses a WHERE a.user_id = u.id AND a.address != u.email) AS aliases
         FROM users u ORDER BY u.email LIMIT 1000`,
      ),
    );

    return json({
      users: rows.map((u) => ({
        id: u.id,
        email: u.email,
        displayName: u.display_name,
        role: u.role,
        enrolled: u.enrolled === 1,
        aliases: u.aliases ? u.aliases.split(",") : [],
      })),
    });
  });

const inviteLink = Effect.fn("inviteLink")(function* (userId: string) {
  const config = yield* AppConfig;

  return `${config.appUrl}/#/invite/${yield* issueInvite(userId)}`;
});

const NewUserInput = Schema.Struct({
  email: Schema.String,
  displayName: Schema.optional(Schema.String),
  role: Schema.optional(Schema.String),
  aliases: Schema.optional(Schema.Array(Schema.String)),
});

const postUser = (ctx: Ctx) =>
  Effect.gen(function* () {
    const actor = yield* requireAdmin(ctx);
    const input = yield* body(ctx, NewUserInput, "Enter a valid email address.");
    const email = normalizeAddress(input.email);

    if (!isValidAddress(email)) return yield* badRequest("Enter a valid email address.");
    const badAlias = (input.aliases ?? []).find((a) => !isValidAddress(normalizeAddress(a)));

    if (badAlias) return yield* badRequest(`"${badAlias}" is not a valid email address.`);

    if (yield* getUserByEmail(email)) return yield* conflict("A user with this email address already exists.");

    const { user } = yield* createUser({
      email,
      displayName: (input.displayName ?? "").slice(0, 200),
      role: input.role === "admin" ? "admin" : "user",
      aliases: input.aliases,
    });

    const config = yield* AppConfig;
    // With Access as the only way in there is no password to set, so no invite is issued.
    const link = config.authMode === "access" ? null : yield* inviteLink(user.id);

    yield* audit(actor, "user.create", `${email} (${user.role})`);

    return json({ user: publicUser(user), inviteLink: link }, 201);
  });

const postInvite = (ctx: Ctx) =>
  Effect.gen(function* () {
    const actor = yield* requireAdmin(ctx);

    yield* requireLocalSignIn;

    const config = yield* AppConfig;
    const mailer = yield* Mailer;
    const input = yield* body(ctx, Schema.Struct({ send: Schema.optional(Schema.Boolean) }), "Invalid request.");
    const user = yield* getUserById(ctx.params.id!);

    if (!user) return yield* notFound("User not found.");
    const link = yield* inviteLink(user.id);

    // The link is always returned, so a failed email does not block enrollment.
    const delivery = input.send
      ? yield* mailer
          .send({
            from: { email: `lifeboat@${config.mailDomain}`, name: "Lifeboat" },
            to: [user.email],
            subject: "Set up your emergency email access",
            text:
              `If Microsoft 365 becomes unavailable, you can read and send email at ${config.appUrl}.\n\n` +
              `Set your Lifeboat password now, while everything is working:\n${link}\n\n` +
              "The link is valid for 14 days. Use a password that is different from your Microsoft password.",
          })
          .pipe(
            Effect.match({
              onSuccess: () => ({ sent: true as const }),
              onFailure: (e) => ({ sent: false as const, sendError: e.code ?? "The email service refused the message." }),
            }),
          )
      : { sent: false as const };

    yield* audit(actor, "user.invite", user.email);

    return json({ inviteLink: link, ...delivery });
  });

const postDirectorySync = (ctx: Ctx) =>
  Effect.gen(function* () {
    const actor = yield* requireAdmin(ctx);

    const directory = yield* getGraphToken.pipe(
      Effect.flatMap(listDirectoryUsers),
      Effect.catchTag("GraphError", (e) =>
        Effect.fail(new ApiError({ status: 502, message: `The directory could not be read: ${e.message}` })),
      ),
    );

    const results = yield* Effect.forEach(directory, (entry) => createUser(entry));
    const created = results.filter((r) => r.created).length;
    yield* audit(actor, "directory.sync", `${directory.length} found, ${created} new`);

    return json({ found: directory.length, created });
  });

const listHeld = (ctx: Ctx) =>
  Effect.gen(function* () {
    yield* requireAdmin(ctx);
    const db = yield* Db;

    const rows = yield* db.all<MessageRow>(
      sql("SELECT * FROM messages WHERE user_id IS NULL ORDER BY received_at DESC LIMIT 200"),
    );

    return json({ messages: rows.map(listItem) });
  });

const postAssignHeld = (ctx: Ctx) =>
  Effect.gen(function* () {
    const actor = yield* requireAdmin(ctx);
    const db = yield* Db;
    const input = yield* body(ctx, Schema.Struct({ email: Schema.String }), "Enter the user's email address.");
    const user = yield* getUserByEmail(input.email);

    if (!user) return yield* notFound("No user has that email address.");

    const changed = yield* db.run(
      sql(
        "UPDATE messages SET user_id = ?, sync_status = 'pending' WHERE id = ? AND user_id IS NULL",
        user.id,
        ctx.params.id,
      ),
    );

    if (!changed) return yield* notFound("Held message not found.");
    yield* audit(actor, "held.assign", `${ctx.params.id} -> ${user.email}`);

    return json({ ok: true });
  });

const postSyncRun = (ctx: Ctx) =>
  Effect.gen(function* () {
    const actor = yield* requireAdmin(ctx);
    const db = yield* Db;

    const input = yield* body(
      ctx,
      Schema.Struct({ retryFailed: Schema.optional(Schema.Boolean) }),
      "Invalid request.",
    );

    if (input.retryFailed) {
      yield* db.run(sql("UPDATE messages SET sync_status = 'pending', sync_attempts = 0 WHERE sync_status = 'failed'"));
    }

    const summary = yield* runSyncBatch();
    yield* finishRecoveryIfDrained;
    yield* audit(actor, "sync.run", JSON.stringify(summary));

    return json({ ...summary, state: yield* getState });
  });

const listAudit = (ctx: Ctx) =>
  Effect.gen(function* () {
    yield* requireAdmin(ctx);
    const db = yield* Db;

    return json({ entries: yield* db.all(sql("SELECT * FROM audit_log ORDER BY id DESC LIMIT 100")) });
  });

// ── Router ───────────────────────────────────────────────────────────────────

type Handler = (ctx: Ctx) => Effect.Effect<Response, RouteError, AppServices>;

type RouteError = ApiError | DbError | BlobError | FailoverError | GraphError | GraphNotConfigured;

const route = (method: string, path: string, handler: Handler) => ({
  method,
  pattern: new RegExp(`^${path.replace(/:(\w+)/g, "(?<$1>[^/]+)")}$`),
  handler,
});

const routes = [
  route("GET", "/api/status", status),
  route("POST", "/api/auth/login", postLogin),
  route("POST", "/api/auth/accept-invite", postAcceptInvite),
  route("POST", "/api/auth/logout", postLogout),
  route("GET", "/api/auth/me", getMe),
  route("GET", "/api/messages", listMessages),
  route("POST", "/api/messages", postMessage),
  route("GET", "/api/messages/:id", getMessage),
  route("GET", "/api/messages/:id/attachments/:idx", getAttachment),
  route("GET", "/api/admin/access-login", accessLogin),
  route("GET", "/api/admin/overview", overview),
  route("POST", "/api/admin/failover/activate", postActivate),
  route("POST", "/api/admin/failover/deactivate", postDeactivate),
  route("GET", "/api/admin/users", listUsers),
  route("POST", "/api/admin/users", postUser),
  route("POST", "/api/admin/users/:id/invite", postInvite),
  route("POST", "/api/admin/directory/sync", postDirectorySync),
  route("GET", "/api/admin/held", listHeld),
  route("POST", "/api/admin/held/:id/assign", postAssignHeld),
  route("POST", "/api/admin/sync/run", postSyncRun),
  route("GET", "/api/admin/audit", listAudit),
];

/** Logs an unexpected failure and answers without revealing its details. */
const serverError = (logged: Effect.Effect<void>) =>
  logged.pipe(Effect.as(json({ error: "Something went wrong on the server." }, 500)));

/** Handles one API request. Every failure is turned into a JSON response; this never fails. */
export const handleApi = (request: Request): Effect.Effect<Response, never, AppServices> =>
  Effect.gen(function* () {
    const url = new URL(request.url);

    // Cross-site form posts cannot set a JSON content type, so requiring one blocks CSRF.
    if (!["GET", "HEAD"].includes(request.method)) {
      const type = request.headers.get("content-type") ?? "";

      if (!type.toLowerCase().startsWith("application/json")) {
        return yield* new ApiError({ status: 415, message: "Requests must use Content-Type: application/json." });
      }
    }

    for (const candidate of routes) {
      if (candidate.method !== request.method) continue;
      const match = candidate.pattern.exec(url.pathname);

      if (!match) continue;
      const actor = yield* resolveActor(request);

      return yield* candidate.handler({ request, url, params: match.groups ?? {}, actor });
    }

    return yield* notFound("Not found.");
  }).pipe(
    Effect.catchTags({
      ApiError: (e) => Effect.succeed(json(e.code ? { error: e.message, code: e.code } : { error: e.message }, e.status)),
      FailoverError: (e) => Effect.succeed(json({ error: e.message }, 409)),
      GraphNotConfigured: (e) => Effect.succeed(json({ error: e.message }, 400)),
      GraphError: (e) => Effect.succeed(json({ error: e.message }, 502)),
      DbError: (e) => serverError(Effect.logError("Database error", e.cause)),
      BlobError: (e) => serverError(Effect.logError("Storage error", e.cause)),
    }),
    Effect.catchCause((cause) => serverError(Effect.logError("Unhandled failure", cause))),
  );
