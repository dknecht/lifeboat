/**
 * Passkeys: signing in with a WebAuthn credential in place of a password.
 *
 * A passkey is bound to the hostname Lifeboat is served from, so it cannot be phished from another
 * site, and it needs nothing from Microsoft. Each ceremony has two steps: the server issues a
 * challenge, and the browser returns a response signed by the authenticator.
 */
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { getUserAddresses, getUserById, startSession } from "./auth";
import { PasskeyRejected } from "./errors";
import { AppConfig, Db, sql } from "./services";
import type { UserRow } from "./types";
import { fromBase64, newId, now, toBase64Url } from "./util";

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MAX_PASSKEYS_PER_USER = 10;

// ── What the browser sends back ──────────────────────────────────────────────

const credentialFields = {
  id: Schema.String,
  rawId: Schema.String,
  type: Schema.Literal("public-key"),
  clientExtensionResults: Schema.Struct({}),
};

/** The result of `navigator.credentials.create()`, as JSON. */
export const RegistrationResponse = Schema.Struct({
  ...credentialFields,
  response: Schema.Struct({
    clientDataJSON: Schema.String,
    attestationObject: Schema.String,
    transports: Schema.optional(Schema.Array(Schema.String)),
  }),
});

/** The result of `navigator.credentials.get()`, as JSON. */
export const AuthenticationResponse = Schema.Struct({
  ...credentialFields,
  response: Schema.Struct({
    clientDataJSON: Schema.String,
    authenticatorData: Schema.String,
    signature: Schema.String,
    userHandle: Schema.optional(Schema.String),
  }),
});

const decodeTransports = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.String)));

interface PasskeyRow {
  id: string;
  user_id: string;
  public_key: string;
  counter: number;
  transports: string;
  name: string;
  created_at: number;
  last_used_at: number | null;
}

const transportsOf = (row: PasskeyRow) => [...Option.getOrElse(decodeTransports(row.transports), () => [])];

const rejected = (message: string) => new PasskeyRejected({ message });

/** The identity passkeys are bound to: the hostname and origin Lifeboat is served from. */
const relyingParty = Effect.gen(function* () {
  const { appUrl } = yield* AppConfig;

  const url = yield* Effect.try({
    try: () => new URL(appUrl),
    catch: () => rejected("Passkeys need APP_URL to be set to the address Lifeboat is served from."),
  });

  return { id: url.hostname, origin: url.origin, name: "Lifeboat" };
});

// ── Challenges ───────────────────────────────────────────────────────────────

const issueChallenge = Effect.fn("issueChallenge")(function* (
  kind: "register" | "login",
  userId: string | null,
  challenge: string,
) {
  const db = yield* Db;
  const id = newId();

  yield* db.batch([
    sql("DELETE FROM webauthn_challenges WHERE expires_at < ?", now()),
    sql(
      "INSERT INTO webauthn_challenges (id, user_id, kind, challenge, expires_at) VALUES (?, ?, ?, ?, ?)",
      id,
      userId,
      kind,
      challenge,
      now() + CHALLENGE_TTL_MS,
    ),
  ]);

  return id;
});

/** Takes a challenge out of the table, so that it can be answered only once. */
const redeemChallenge = Effect.fn("redeemChallenge")(function* (
  id: string,
  kind: "register" | "login",
  userId: string | null,
) {
  const db = yield* Db;

  const row = yield* db.first<{ challenge: string; user_id: string | null }>(
    sql("SELECT challenge, user_id FROM webauthn_challenges WHERE id = ? AND kind = ? AND expires_at > ?", id, kind, now()),
  );

  yield* db.run(sql("DELETE FROM webauthn_challenges WHERE id = ?", id));

  if (!row || row.user_id !== userId) return yield* rejected("That took too long. Start again.");

  return row.challenge;
});

// ── Adding a passkey ─────────────────────────────────────────────────────────

export const listPasskeys = Effect.fn("listPasskeys")(function* (user: UserRow) {
  const db = yield* Db;
  const rows = yield* db.all<PasskeyRow>(sql("SELECT * FROM passkeys WHERE user_id = ? ORDER BY created_at", user.id));

  return rows.map((row) => ({ id: row.id, name: row.name, createdAt: row.created_at, lastUsedAt: row.last_used_at }));
});

/** Starts adding a passkey for a signed-in user. */
export const beginRegistration = Effect.fn("beginRegistration")(function* (user: UserRow) {
  const db = yield* Db;
  const rp = yield* relyingParty;
  const existing = yield* db.all<PasskeyRow>(sql("SELECT * FROM passkeys WHERE user_id = ?", user.id));

  if (existing.length >= MAX_PASSKEYS_PER_USER) {
    return yield* rejected(`You can have at most ${MAX_PASSKEYS_PER_USER} passkeys. Remove one first.`);
  }

  const options = yield* Effect.promise(() =>
    generateRegistrationOptions({
      rpName: rp.name,
      rpID: rp.id,
      userName: user.email,
      userDisplayName: user.display_name || user.email,
      userID: Uint8Array.from(new TextEncoder().encode(user.id)),
      attestationType: "none",
      // A discoverable credential lets someone sign in without typing their address first.
      authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
      excludeCredentials: existing.map((row) => ({ id: row.id, transports: transportsOf(row) })),
    }),
  );

  return { challengeId: yield* issueChallenge("register", user.id, options.challenge), options };
});

/** Verifies the authenticator's answer and stores the new passkey. */
export const finishRegistration = Effect.fn("finishRegistration")(function* (
  user: UserRow,
  challengeId: string,
  name: string,
  response: typeof RegistrationResponse.Type,
) {
  const db = yield* Db;
  const rp = yield* relyingParty;
  const expectedChallenge = yield* redeemChallenge(challengeId, "register", user.id);

  const verification = yield* Effect.tryPromise({
    try: () =>
      verifyRegistrationResponse({
        response: { ...response, response: { ...response.response, transports: [...(response.response.transports ?? [])] } },
        expectedChallenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.id,
        requireUserVerification: false,
      }),
    catch: () => rejected("The passkey could not be verified."),
  });

  if (!verification.verified) return yield* rejected("The passkey could not be verified.");

  const { credential } = verification.registrationInfo;

  yield* db.run(
    sql(
      "INSERT INTO passkeys (id, user_id, public_key, counter, transports, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      credential.id,
      user.id,
      toBase64Url(credential.publicKey),
      credential.counter,
      JSON.stringify(credential.transports ?? []),
      name.trim().slice(0, 60) || "Passkey",
      now(),
    ),
  );

  return { id: credential.id };
});

export const deletePasskey = Effect.fn("deletePasskey")(function* (user: UserRow, id: string) {
  const db = yield* Db;

  yield* db.run(sql("DELETE FROM passkeys WHERE id = ? AND user_id = ?", id, user.id));
});

// ── Signing in with a passkey ────────────────────────────────────────────────

/** Starts a sign-in. No address is asked for: the passkey itself says whose it is. */
export const beginLogin = Effect.gen(function* () {
  const rp = yield* relyingParty;
  const options = yield* Effect.promise(() => generateAuthenticationOptions({ rpID: rp.id, userVerification: "preferred" }));

  return { challengeId: yield* issueChallenge("login", null, options.challenge), options };
});

/** Verifies a sign-in and starts a session for the passkey's owner. */
export const finishLogin = Effect.fn("finishLogin")(function* (
  challengeId: string,
  response: typeof AuthenticationResponse.Type,
) {
  const db = yield* Db;
  const rp = yield* relyingParty;
  const expectedChallenge = yield* redeemChallenge(challengeId, "login", null);
  const passkey = yield* db.first<PasskeyRow>(sql("SELECT * FROM passkeys WHERE id = ?", response.id));

  if (!passkey) return yield* rejected("That passkey is not registered with Lifeboat.");

  const verification = yield* Effect.tryPromise({
    try: () =>
      verifyAuthenticationResponse({
        response,
        expectedChallenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.id,
        requireUserVerification: false,
        credential: {
          id: passkey.id,
          publicKey: Uint8Array.from(fromBase64(passkey.public_key)),
          counter: passkey.counter,
          transports: transportsOf(passkey),
        },
      }),
    catch: () => rejected("The passkey could not be verified."),
  });

  if (!verification.verified) return yield* rejected("The passkey could not be verified.");

  const user = yield* getUserById(passkey.user_id);

  if (!user || user.disabled) return yield* rejected("This account cannot sign in.");

  yield* db.run(
    sql(
      "UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?",
      verification.authenticationInfo.newCounter,
      now(),
      passkey.id,
    ),
  );

  return { user, addresses: yield* getUserAddresses(user.id), token: yield* startSession(user.id) };
});
