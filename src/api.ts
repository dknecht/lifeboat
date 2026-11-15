import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import {
  MIN_PASSWORD_LENGTH,
  SESSION_COOKIE,
  acceptInvite,
  createUser,
  getSessionUser,
  getUserAddresses,
  issueInvite,
  login,
  logout,
  sessionCookie,
} from "./auth";
import { audit, getState } from "./db";
import { FailoverError, activate, deactivate, manualInstructions } from "./failover";
import { getGraphToken, graphConfigured, listDirectoryUsers } from "./graph";
import { getProbeHealth } from "./health";
import { SendError, sendMessage, type SendInput } from "./outbound";
import { finishRecoveryIfDrained, runSyncBatch } from "./sync";
import type { AttachmentRow, Env, MessageRow, StoredBody, UserRow } from "./types";
import { isValidAddress, normalizeAddress, timingSafeEqual } from "./util";

type Actor = { kind: "user"; user: UserRow } | { kind: "token" };
type App = { Bindings: Env; Variables: { actor: Actor | null } };

const actorName = (a: Actor) => (a.kind === "user" ? a.user.email : "admin-token");
const publicUser = (u: UserRow) => ({ id: u.id, email: u.email, displayName: u.display_name, role: u.role });

function listItem(m: MessageRow) {
  return {
    id: m.id,
    folder: m.folder,
    from: { address: m.from_addr, name: m.from_name },
    to: JSON.parse(m.to_json),
    cc: JSON.parse(m.cc_json),
    rcptTo: m.rcpt_to,
    subject: m.subject,
    snippet: m.snippet,
    date: m.direction === "in" ? m.received_at : m.sent_at,
    hasAttachments: m.has_attachments === 1,
    isRead: m.is_read === 1,
    syncStatus: m.sync_status,
  };
}

export const api = new Hono<App>().basePath("/api");

api.onError((err, c) => {
  console.error(err);
  return c.json({ error: "Something went wrong on the server." }, 500);
});

// Resolve who is calling, and block cross-site form posts: state changes must be JSON.
api.use("*", async (c, next) => {
  if (!["GET", "HEAD"].includes(c.req.method)) {
    const type = c.req.header("content-type") ?? "";
    if (!type.toLowerCase().startsWith("application/json")) {
      return c.json({ error: "Requests must use Content-Type: application/json." }, 415);
    }
  }
  let actor: Actor | null = null;
  const bearer = c.req.header("authorization")?.match(/^Bearer (.+)$/)?.[1];
  if (bearer && c.env.ADMIN_TOKEN && timingSafeEqual(bearer, c.env.ADMIN_TOKEN)) {
    actor = { kind: "token" };
  } else {
    const token = getCookie(c, SESSION_COOKIE);
    const user = token ? await getSessionUser(c.env, token) : null;
    if (user) actor = { kind: "user", user };
  }
  c.set("actor", actor);
  await next();
});

async function readJson<T>(c: { req: { json: () => Promise<unknown> } }): Promise<Partial<T>> {
  try {
    const body = await c.req.json();
    return body && typeof body === "object" ? (body as Partial<T>) : {};
  } catch {
    return {};
  }
}

// ── Public ───────────────────────────────────────────────────────────────────

api.get("/status", async (c) =>
  c.json({ state: await getState(c.env), domain: c.env.MAIL_DOMAIN }),
);

api.post("/auth/login", async (c) => {
  const { email, password } = await readJson<{ email: string; password: string }>(c);
  if (typeof email !== "string" || typeof password !== "string") {
    return c.json({ error: "Enter your email address and password." }, 400);
  }
  const result = await login(c.env, email, password);
  if (!result.ok) {
    return result.reason === "locked"
      ? c.json({ error: "Too many failed attempts. Try again in 15 minutes." }, 429)
      : c.json({ error: "The email address or password is incorrect." }, 401);
  }
  c.header("Set-Cookie", sessionCookie(result.token, new URL(c.req.url).protocol === "https:"));
  return c.json({ user: publicUser(result.user) });
});

api.post("/auth/accept-invite", async (c) => {
  const { token, password } = await readJson<{ token: string; password: string }>(c);
  if (typeof token !== "string" || typeof password !== "string") {
    return c.json({ error: "The invite link is incomplete." }, 400);
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return c.json({ error: `Choose a password of at least ${MIN_PASSWORD_LENGTH} characters.` }, 400);
  }
  const user = await acceptInvite(c.env, token, password);
  if (!user) {
    return c.json({ error: "This invite link is invalid or has expired. Ask an administrator for a new one." }, 400);
  }
  await audit(c.env, user.email, "user.enrolled");
  return c.json({ email: user.email });
});

api.post("/auth/logout", async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await logout(c.env, token);
  c.header("Set-Cookie", sessionCookie("", new URL(c.req.url).protocol === "https:", true));
  return c.json({ ok: true });
});

// ── Signed-in users ──────────────────────────────────────────────────────────

const mail = new Hono<App & { Variables: { user: UserRow } }>();

mail.use("*", async (c, next) => {
  const actor = c.get("actor");
  if (actor?.kind !== "user") return c.json({ error: "Sign in to continue." }, 401);
  c.set("user", actor.user);
  await next();
});

mail.get("/auth/me", async (c) => {
  const user = c.get("user");
  return c.json({
    user: publicUser(user),
    addresses: await getUserAddresses(c.env, user.id),
    state: await getState(c.env),
  });
});

mail.get("/messages", async (c) => {
  const user = c.get("user");
  const folder = c.req.query("folder") === "sent" ? "sent" : "inbox";
  const limit = 50;
  // The cursor is "<timestamp>.<id>" of the last row on the previous page.
  const [ts, id] = (c.req.query("cursor") ?? "").split(".");
  const before = Number(ts);
  const paged = Number.isFinite(before) && before > 0 && id;
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM messages WHERE user_id = ? AND folder = ?
     ${paged ? "AND (received_at < ? OR (received_at = ? AND id < ?))" : ""}
     ORDER BY received_at DESC, id DESC LIMIT ?`,
  )
    .bind(...(paged ? [user.id, folder, before, before, id, limit + 1] : [user.id, folder, limit + 1]))
    .all<MessageRow>();
  const page = results.slice(0, limit);
  const last = page[page.length - 1];
  const unread = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM messages WHERE user_id = ? AND folder = 'inbox' AND is_read = 0",
  )
    .bind(user.id)
    .first<{ n: number }>();
  return c.json({
    messages: page.map(listItem),
    nextCursor: results.length > limit && last ? `${last.received_at}.${last.id}` : null,
    unread: unread?.n ?? 0,
  });
});

async function loadMessage(env: Env, id: string, userId: string | null) {
  const row = await env.DB.prepare(
    userId === null
      ? "SELECT * FROM messages WHERE id = ? AND user_id IS NULL"
      : "SELECT * FROM messages WHERE id = ? AND user_id = ?",
  )
    .bind(...(userId === null ? [id] : [id, userId]))
    .first<MessageRow>();
  if (!row) return null;
  const bodyObject = await env.MAIL.get(`body/${id}.json`);
  const body: StoredBody = bodyObject ? await bodyObject.json<StoredBody>() : { html: null, text: null };
  const { results } = await env.DB.prepare(
    "SELECT * FROM attachments WHERE message_id = ? ORDER BY idx",
  )
    .bind(id)
    .all<AttachmentRow>();
  return {
    ...listItem(row),
    messageId: row.message_id,
    body,
    attachments: results.map((a) => ({
      idx: a.idx,
      filename: a.filename,
      contentType: a.content_type,
      size: a.size,
      inline: a.disposition === "inline",
    })),
  };
}

mail.get("/messages/:id", async (c) => {
  const message = await loadMessage(c.env, c.req.param("id"), c.get("user").id);
  if (!message) return c.json({ error: "Message not found." }, 404);
  if (!message.isRead) {
    await c.env.DB.prepare("UPDATE messages SET is_read = 1 WHERE id = ?").bind(message.id).run();
  }
  return c.json({ message: { ...message, isRead: true } });
});

mail.get("/messages/:id/attachments/:idx", async (c) => {
  const att = await c.env.DB.prepare(
    `SELECT a.* FROM attachments a JOIN messages m ON m.id = a.message_id
     WHERE a.message_id = ? AND a.idx = ? AND m.user_id = ?`,
  )
    .bind(c.req.param("id"), Number(c.req.param("idx")), c.get("user").id)
    .first<AttachmentRow>();
  const object = att ? await c.env.MAIL.get(`att/${att.message_id}/${att.idx}`) : null;
  if (!att || !object) return c.json({ error: "Attachment not found." }, 404);
  // Always a download with a generic type, so that an attachment can never run in the app's origin.
  return new Response(object.body, {
    headers: {
      "content-type": "application/octet-stream",
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(att.filename)}`,
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-store",
    },
  });
});

mail.post("/messages", async (c) => {
  const input = (await readJson<SendInput>(c)) as SendInput;
  try {
    return c.json(await sendMessage(c.env, c.get("user"), input), 201);
  } catch (err) {
    if (err instanceof SendError) return c.json({ error: err.message }, err.status);
    throw err;
  }
});

// ── Administrators ───────────────────────────────────────────────────────────

const admin = new Hono<App & { Variables: { actor: Actor } }>();

admin.use("*", async (c, next) => {
  const actor = c.get("actor");
  if (!actor) return c.json({ error: "Sign in to continue." }, 401);
  if (actor.kind === "user" && actor.user.role !== "admin") {
    return c.json({ error: "Administrator access is required." }, 403);
  }
  await next();
});

admin.get("/overview", async (c) => {
  const env = c.env;
  const state = await getState(env);
  const [sync, users, held, incident] = await Promise.all([
    env.DB.prepare("SELECT sync_status AS status, COUNT(*) AS n FROM messages GROUP BY sync_status").all<{
      status: string;
      n: number;
    }>(),
    env.DB.prepare(
      "SELECT COUNT(*) AS total, SUM(password_hash IS NOT NULL) AS enrolled FROM users WHERE disabled = 0",
    ).first<{ total: number; enrolled: number | null }>(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE user_id IS NULL").first<{ n: number }>(),
    env.DB.prepare("SELECT * FROM incidents ORDER BY started_at DESC LIMIT 1").first(),
  ]);
  const counts = { pending: 0, synced: 0, failed: 0, skipped: 0 } as Record<string, number>;
  for (const r of sync.results) counts[r.status] = r.n;
  return c.json({
    state,
    domain: env.MAIL_DOMAIN,
    dnsMode: env.DNS_MODE === "api" ? "api" : "manual",
    autoFailover: env.AUTO_FAILOVER === "true",
    graphConfigured: graphConfigured(env),
    probe: await getProbeHealth(env),
    incident,
    sync: counts,
    users: { total: users?.total ?? 0, enrolled: users?.enrolled ?? 0 },
    held: held?.n ?? 0,
    instructions:
      env.DNS_MODE === "api"
        ? []
        : state === "active"
          ? manualInstructions(env, "activate")
          : state === "recovering"
            ? manualInstructions(env, "deactivate")
            : [],
  });
});

admin.post("/failover/activate", async (c) => {
  const { reason } = await readJson<{ reason: string }>(c);
  try {
    return c.json(await activate(c.env, actorName(c.get("actor")), typeof reason === "string" ? reason : ""));
  } catch (err) {
    if (err instanceof FailoverError) return c.json({ error: err.message }, 409);
    throw err;
  }
});

admin.post("/failover/deactivate", async (c) => {
  try {
    return c.json(await deactivate(c.env, actorName(c.get("actor"))));
  } catch (err) {
    if (err instanceof FailoverError) return c.json({ error: err.message }, 409);
    throw err;
  }
});

admin.get("/users", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT u.id, u.email, u.display_name, u.role, u.disabled, u.password_hash IS NOT NULL AS enrolled,
       (SELECT GROUP_CONCAT(address) FROM addresses a WHERE a.user_id = u.id AND a.address != u.email) AS aliases
     FROM users u ORDER BY u.email LIMIT 1000`,
  ).all<{ id: string; email: string; display_name: string; role: string; disabled: number; enrolled: number; aliases: string | null }>();
  return c.json({
    users: results.map((u) => ({
      id: u.id,
      email: u.email,
      displayName: u.display_name,
      role: u.role,
      enrolled: u.enrolled === 1,
      aliases: u.aliases ? u.aliases.split(",") : [],
    })),
  });
});

const inviteLink = (env: Env, token: string) =>
  `${env.APP_URL.replace(/\/$/, "")}/#/invite/${token}`;

admin.post("/users", async (c) => {
  const body = await readJson<{ email: string; displayName: string; role: string; aliases: string[] }>(c);
  const email = typeof body.email === "string" ? normalizeAddress(body.email) : "";
  if (!isValidAddress(email)) return c.json({ error: "Enter a valid email address." }, 400);
  const aliases = Array.isArray(body.aliases) ? body.aliases.filter((a) => typeof a === "string") : [];
  const badAlias = aliases.find((a) => !isValidAddress(normalizeAddress(a)));
  if (badAlias) return c.json({ error: `"${badAlias}" is not a valid email address.` }, 400);

  const { user, created } = await createUser(c.env, {
    email,
    displayName: typeof body.displayName === "string" ? body.displayName.slice(0, 200) : "",
    role: body.role === "admin" ? "admin" : "user",
    aliases,
  });
  if (!created) return c.json({ error: "A user with this email address already exists." }, 409);
  const token = await issueInvite(c.env, user.id);
  await audit(c.env, actorName(c.get("actor")), "user.create", `${email} (${user.role})`);
  return c.json({ user: publicUser(user), inviteLink: inviteLink(c.env, token) }, 201);
});

admin.post("/users/:id/invite", async (c) => {
  const { send } = await readJson<{ send: boolean }>(c);
  const user = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?")
    .bind(c.req.param("id"))
    .first<UserRow>();
  if (!user) return c.json({ error: "User not found." }, 404);
  const link = inviteLink(c.env, await issueInvite(c.env, user.id));
  let sent = false;
  let sendError: string | undefined;
  if (send === true) {
    try {
      await c.env.EMAIL.send({
        from: { email: `lifeboat@${c.env.MAIL_DOMAIN}`, name: "Lifeboat" },
        to: [user.email],
        subject: "Set up your emergency email access",
        text:
          `If Microsoft 365 becomes unavailable, you can read and send email at ${c.env.APP_URL}.\n\n` +
          `Set your Lifeboat password now, while everything is working:\n${link}\n\n` +
          "The link is valid for 14 days. Use a password that is different from your Microsoft password.",
      });
      sent = true;
    } catch (err) {
      sendError = (err as Error).message;
    }
  }
  await audit(c.env, actorName(c.get("actor")), "user.invite", user.email);
  return c.json({ inviteLink: link, sent, sendError });
});

admin.post("/directory/sync", async (c) => {
  if (!graphConfigured(c.env)) return c.json({ error: "Microsoft Graph is not configured." }, 400);
  let directory;
  try {
    directory = await listDirectoryUsers(c.env, await getGraphToken(c.env));
  } catch (err) {
    return c.json({ error: `The directory could not be read: ${(err as Error).message}` }, 502);
  }
  let created = 0;
  for (const entry of directory) {
    if ((await createUser(c.env, entry)).created) created++;
  }
  await audit(c.env, actorName(c.get("actor")), "directory.sync", `${directory.length} found, ${created} new`);
  return c.json({ found: directory.length, created });
});

admin.get("/held", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM messages WHERE user_id IS NULL ORDER BY received_at DESC LIMIT 200",
  ).all<MessageRow>();
  return c.json({ messages: results.map(listItem) });
});

admin.post("/held/:id/assign", async (c) => {
  const { email } = await readJson<{ email: string }>(c);
  const user =
    typeof email === "string"
      ? await c.env.DB.prepare("SELECT id, email FROM users WHERE email = ?")
          .bind(normalizeAddress(email))
          .first<{ id: string; email: string }>()
      : null;
  if (!user) return c.json({ error: "No user has that email address." }, 404);
  const result = await c.env.DB.prepare(
    "UPDATE messages SET user_id = ?, sync_status = 'pending' WHERE id = ? AND user_id IS NULL",
  )
    .bind(user.id, c.req.param("id"))
    .run();
  if (!result.meta.changes) return c.json({ error: "Held message not found." }, 404);
  await audit(c.env, actorName(c.get("actor")), "held.assign", `${c.req.param("id")} -> ${user.email}`);
  return c.json({ ok: true });
});

admin.post("/sync/run", async (c) => {
  const { retryFailed } = await readJson<{ retryFailed: boolean }>(c);
  if (retryFailed === true) {
    await c.env.DB.prepare(
      "UPDATE messages SET sync_status = 'pending', sync_attempts = 0 WHERE sync_status = 'failed'",
    ).run();
  }
  const summary = await runSyncBatch(c.env);
  await finishRecoveryIfDrained(c.env);
  await audit(c.env, actorName(c.get("actor")), "sync.run", JSON.stringify(summary));
  return c.json({ ...summary, state: await getState(c.env) });
});

admin.get("/audit", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT 100").all();
  return c.json({ entries: results });
});

api.route("/admin", admin);
api.route("/", mail);
api.all("*", (c) => c.json({ error: "Not found." }, 404));

