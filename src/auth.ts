import type { Env, UserRow } from "./types";
import { fromBase64, newId, normalizeAddress, now, randomToken, sha256Hex, toBase64 } from "./util";

// Workers' WebCrypto caps PBKDF2 at 100,000 iterations.
const PBKDF2_ITERATIONS = 100_000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_FAILED_LOGINS = 5;
const LOCK_MS = 15 * 60 * 1000;
export const MIN_PASSWORD_LENGTH = 12;
export const SESSION_COOKIE = "lifeboat_session";

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    256,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toBase64(salt)}$${toBase64(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iter, salt, hash] = stored.split("$");
  if (scheme !== "pbkdf2" || !iter || !salt || !hash) return false;
  const expected = fromBase64(hash);
  const actual = await pbkdf2(password, fromBase64(salt), parseInt(iter, 10));
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i]! ^ expected[i]!;
  return diff === 0;
}

export async function getUserByEmail(env: Env, email: string): Promise<UserRow | null> {
  return env.DB.prepare("SELECT * FROM users WHERE email = ?")
    .bind(normalizeAddress(email))
    .first<UserRow>();
}

export async function createUser(
  env: Env,
  input: { email: string; displayName?: string; role?: "user" | "admin"; aliases?: string[] },
): Promise<{ user: UserRow; created: boolean }> {
  const email = normalizeAddress(input.email);
  let user = await getUserByEmail(env, email);
  let created = false;
  if (!user) {
    const id = newId();
    await env.DB.prepare(
      "INSERT INTO users (id, email, display_name, role, created_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(id, email, input.displayName ?? "", input.role ?? "user", now())
      .run();
    user = (await getUserByEmail(env, email))!;
    created = true;
  } else if (input.displayName && input.displayName !== user.display_name) {
    await env.DB.prepare("UPDATE users SET display_name = ? WHERE id = ?")
      .bind(input.displayName, user.id)
      .run();
    user.display_name = input.displayName;
  }
  const addresses = new Set([email, ...(input.aliases ?? []).map(normalizeAddress)]);
  for (const address of addresses) {
    // An address already owned by another user stays with that user.
    await env.DB.prepare("INSERT OR IGNORE INTO addresses (address, user_id) VALUES (?, ?)")
      .bind(address, user.id)
      .run();
  }
  return { user, created };
}

/** Issues a fresh invite token. The plain token is returned once and only its hash is stored. */
export async function issueInvite(env: Env, userId: string): Promise<string> {
  const token = randomToken();
  await env.DB.prepare("UPDATE users SET invite_hash = ?, invite_expires_at = ? WHERE id = ?")
    .bind(await sha256Hex(token), now() + INVITE_TTL_MS, userId)
    .run();
  return token;
}

export async function acceptInvite(env: Env, token: string, password: string): Promise<UserRow | null> {
  const user = await env.DB.prepare(
    "SELECT * FROM users WHERE invite_hash = ? AND invite_expires_at > ? AND disabled = 0",
  )
    .bind(await sha256Hex(token), now())
    .first<UserRow>();
  if (!user) return null;
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE users SET password_hash = ?, invite_hash = NULL, invite_expires_at = NULL, failed_logins = 0, locked_until = NULL WHERE id = ?",
    ).bind(await hashPassword(password), user.id),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(user.id),
  ]);
  return user;
}

export type LoginResult =
  | { ok: true; user: UserRow; token: string }
  | { ok: false; reason: "invalid" | "locked" };

export async function login(env: Env, email: string, password: string): Promise<LoginResult> {
  const user = await getUserByEmail(env, email);
  if (!user || user.disabled || !user.password_hash) {
    // Spend comparable time so that unknown accounts are not distinguishable by latency.
    await hashPassword(password);
    return { ok: false, reason: "invalid" };
  }
  if (user.locked_until && user.locked_until > now()) return { ok: false, reason: "locked" };

  if (!(await verifyPassword(password, user.password_hash))) {
    const failed = user.failed_logins + 1;
    const lock = failed >= MAX_FAILED_LOGINS;
    await env.DB.prepare("UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?")
      .bind(lock ? 0 : failed, lock ? now() + LOCK_MS : null, user.id)
      .run();
    return { ok: false, reason: lock ? "locked" : "invalid" };
  }

  const token = randomToken();
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?").bind(user.id),
    env.DB.prepare(
      "INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
    ).bind(await sha256Hex(token), user.id, now() + SESSION_TTL_MS, now()),
  ]);
  return { ok: true, user, token };
}

export async function getSessionUser(env: Env, token: string): Promise<UserRow | null> {
  return env.DB.prepare(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ? AND u.disabled = 0`,
  )
    .bind(await sha256Hex(token), now())
    .first<UserRow>();
}

export async function logout(env: Env, token: string): Promise<void> {
  await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?")
    .bind(await sha256Hex(token))
    .run();
}

export function sessionCookie(token: string, secure: boolean, clear = false): string {
  const parts = [
    `${SESSION_COOKIE}=${clear ? "" : token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${clear ? 0 : SESSION_TTL_MS / 1000}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export async function getUserAddresses(env: Env, userId: string): Promise<string[]> {
  const { results } = await env.DB.prepare("SELECT address FROM addresses WHERE user_id = ?")
    .bind(userId)
    .all<{ address: string }>();
  return results.map((r) => r.address);
}
