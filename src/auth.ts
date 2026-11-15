import * as Effect from "effect/Effect";
import { LoginRejected } from "./errors";
import { Db, sql } from "./services";
import type { UserRow } from "./types";
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
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);

  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);

  return new Uint8Array(bits);
}

export const hashPassword = (password: string) =>
  Effect.promise(async () => {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);

    return `pbkdf2$${PBKDF2_ITERATIONS}$${toBase64(salt)}$${toBase64(hash)}`;
  });

export const verifyPassword = (password: string, stored: string) =>
  Effect.promise(async () => {
    const [scheme, iter, salt, hash] = stored.split("$");

    if (scheme !== "pbkdf2" || !iter || !salt || !hash) return false;
    const expected = fromBase64(hash);
    const actual = await pbkdf2(password, fromBase64(salt), parseInt(iter, 10));

    if (actual.length !== expected.length) return false;
    let diff = 0;

    for (let i = 0; i < actual.length; i++) diff |= actual[i]! ^ expected[i]!;

    return diff === 0;
  });

const hashToken = (token: string) => Effect.promise(() => sha256Hex(token));

export const getUserByEmail = Effect.fn("getUserByEmail")(function* (email: string) {
  const db = yield* Db;

  return yield* db.first<UserRow>(sql("SELECT * FROM users WHERE email = ?", normalizeAddress(email)));
});

export const getUserById = Effect.fn("getUserById")(function* (id: string) {
  const db = yield* Db;

  return yield* db.first<UserRow>(sql("SELECT * FROM users WHERE id = ?", id));
});

/** Finds the user who owns an address, whether it is their primary address or an alias. */
export const getUserByAddress = Effect.fn("getUserByAddress")(function* (address: string) {
  const db = yield* Db;

  return yield* db.first<UserRow>(
    sql(
      "SELECT u.* FROM addresses a JOIN users u ON u.id = a.user_id WHERE a.address = ? AND u.disabled = 0",
      normalizeAddress(address),
    ),
  );
});

export const setRole = Effect.fn("setRole")(function* (userId: string, role: UserRow["role"]) {
  const db = yield* Db;

  yield* db.run(sql("UPDATE users SET role = ? WHERE id = ?", role, userId));
});

export interface NewUser {
  email: string;
  displayName?: string;
  role?: "user" | "admin";
  aliases?: ReadonlyArray<string>;
}

/** Creates the user if needed and attaches the addresses. Existing users keep their role. */
export const createUser = Effect.fn("createUser")(function* (input: NewUser) {
  const db = yield* Db;
  const email = normalizeAddress(input.email);
  let user = yield* getUserByEmail(email);
  let created = false;

  if (!user) {
    yield* db.run(
      sql(
        "INSERT INTO users (id, email, display_name, role, created_at) VALUES (?, ?, ?, ?, ?)",
        newId(),
        email,
        input.displayName ?? "",
        input.role ?? "user",
        now(),
      ),
    );
    user = (yield* getUserByEmail(email))!;
    created = true;
  } else if (input.displayName && input.displayName !== user.display_name) {
    yield* db.run(sql("UPDATE users SET display_name = ? WHERE id = ?", input.displayName, user.id));
    user = { ...user, display_name: input.displayName };
  }

  const addresses = new Set([email, ...(input.aliases ?? []).map(normalizeAddress)]);
  // An address already owned by another user stays with that user.
  yield* db.batch(
    [...addresses].map((address) =>
      sql("INSERT OR IGNORE INTO addresses (address, user_id) VALUES (?, ?)", address, user.id),
    ),
  );

  return { user, created };
});

/** Issues a fresh invite token. The plain token is returned once and only its hash is stored. */
export const issueInvite = Effect.fn("issueInvite")(function* (userId: string) {
  const db = yield* Db;
  const token = randomToken();
  yield* db.run(
    sql(
      "UPDATE users SET invite_hash = ?, invite_expires_at = ? WHERE id = ?",
      yield* hashToken(token),
      now() + INVITE_TTL_MS,
      userId,
    ),
  );

  return token;
});

/** Sets the password for the invited user, or returns null when the token is unknown or expired. */
export const acceptInvite = Effect.fn("acceptInvite")(function* (token: string, password: string) {
  const db = yield* Db;

  const user = yield* db.first<UserRow>(
    sql(
      "SELECT * FROM users WHERE invite_hash = ? AND invite_expires_at > ? AND disabled = 0",
      yield* hashToken(token),
      now(),
    ),
  );

  if (!user) return null;
  yield* db.batch([
    sql(
      "UPDATE users SET password_hash = ?, invite_hash = NULL, invite_expires_at = NULL, failed_logins = 0, locked_until = NULL WHERE id = ?",
      yield* hashPassword(password),
      user.id,
    ),
    sql("DELETE FROM sessions WHERE user_id = ?", user.id),
  ]);

  return user;
});

/** Creates a session for the user, failing with LoginRejected when the credentials are refused. */
export const login = Effect.fn("login")(function* (email: string, password: string) {
  const db = yield* Db;
  const user = yield* getUserByEmail(email);

  if (!user || user.disabled || !user.password_hash) {
    // Spend comparable time so that unknown accounts are not distinguishable by latency.
    yield* hashPassword(password);

    return yield* new LoginRejected({ reason: "invalid" });
  }

  if (user.locked_until && user.locked_until > now()) return yield* new LoginRejected({ reason: "locked" });

  if (!(yield* verifyPassword(password, user.password_hash))) {
    const failed = user.failed_logins + 1;
    const lock = failed >= MAX_FAILED_LOGINS;

    yield* db.run(
      sql(
        "UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?",
        lock ? 0 : failed,
        lock ? now() + LOCK_MS : null,
        user.id,
      ),
    );

    return yield* new LoginRejected({ reason: lock ? "locked" : "invalid" });
  }

  const token = randomToken();

  yield* db.batch([
    sql("UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?", user.id),
    sql(
      "INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
      yield* hashToken(token),
      user.id,
      now() + SESSION_TTL_MS,
      now(),
    ),
  ]);

  return { user, token };
});

export const getSessionUser = Effect.fn("getSessionUser")(function* (token: string) {
  const db = yield* Db;

  return yield* db.first<UserRow>(
    sql(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ? AND u.disabled = 0`,
      yield* hashToken(token),
      now(),
    ),
  );
});

export const logout = Effect.fn("logout")(function* (token: string) {
  const db = yield* Db;
  yield* db.run(sql("DELETE FROM sessions WHERE token_hash = ?", yield* hashToken(token)));
});

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

export const getUserAddresses = Effect.fn("getUserAddresses")(function* (userId: string) {
  const db = yield* Db;
  const rows = yield* db.all<{ address: string }>(sql("SELECT address FROM addresses WHERE user_id = ?", userId));

  return rows.map((r) => r.address);
});
