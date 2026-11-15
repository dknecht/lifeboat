/**
 * Cloudflare Access sign-in.
 *
 * When Access protects a hostname or path, Cloudflare adds a signed token to every request it lets
 * through. This module checks that token against the team's published keys and returns who it
 * names. Lifeboat never trusts the header without checking it, so a request that reaches the Worker
 * some other way cannot claim an identity.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AccessRejected } from "./errors";
import { readJson, request } from "./http";
import { AppConfig } from "./services";
import { fromBase64, now } from "./util";

export const ACCESS_HEADER = "cf-access-jwt-assertion";

const KEY_LIFETIME_MS = 10 * 60 * 1000;

const TokenHeader = Schema.Struct({ alg: Schema.String, kid: Schema.String });

const TokenClaims = Schema.Struct({
  iss: Schema.String,
  aud: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
  exp: Schema.Number,
  nbf: Schema.optional(Schema.Number),
  /** Present for a person. */
  email: Schema.optional(Schema.String),
  /** Present for a service token: its client ID. */
  common_name: Schema.optional(Schema.String),
});

const KeySet = Schema.Struct({
  keys: Schema.Array(Schema.Struct({ kid: Schema.String, kty: Schema.String, n: Schema.String, e: Schema.String })),
});

/** Who an Access token names: a person by email address, or a service token by client ID. */
export type AccessIdentity =
  | { readonly kind: "person"; readonly email: string }
  | { readonly kind: "service"; readonly clientId: string };

interface CachedKeys {
  readonly teamDomain: string;
  readonly fetchedAt: number;
  readonly keys: ReadonlyMap<string, CryptoKey>;
}

// Signing keys change rarely, so they are kept for the life of the isolate and refreshed on a timer
// or when a token names a key that has not been seen.
let cachedKeys: CachedKeys | null = null;

const rejected = (reason: string) => new AccessRejected({ reason });

const fetchKeys = Effect.fn("fetchAccessKeys")(function* (teamDomain: string) {
  const response = yield* request(`https://${teamDomain}/cdn-cgi/access/certs`).pipe(
    Effect.mapError(() => rejected("The Access signing keys could not be fetched.")),
  );

  const keySet = response.ok ? yield* readJson(response, KeySet) : null;

  if (!keySet) return yield* rejected("The Access signing keys could not be read.");

  const imported = yield* Effect.forEach(keySet.keys, (key) =>
    Effect.tryPromise({
      try: async () => {
        const jwk: JsonWebKey = { kty: key.kty, n: key.n, e: key.e, alg: "RS256", ext: true };

        const cryptoKey = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, [
          "verify",
        ]);

        return [key.kid, cryptoKey] as const;
      },
      catch: () => rejected("An Access signing key could not be imported."),
    }),
  );

  cachedKeys = { teamDomain, fetchedAt: now(), keys: new Map(imported) };

  return cachedKeys.keys;
});

const signingKey = Effect.fn("accessSigningKey")(function* (teamDomain: string, keyId: string) {
  const fresh = cachedKeys && cachedKeys.teamDomain === teamDomain && now() - cachedKeys.fetchedAt < KEY_LIFETIME_MS;
  const known = fresh ? cachedKeys?.keys.get(keyId) : undefined;

  if (known) return known;

  const keys = yield* fetchKeys(teamDomain);

  return keys.get(keyId) ?? (yield* rejected("The token was signed with an unknown key."));
});

const decodePart = <S extends Schema.ConstraintDecoder<unknown>>(part: string, schema: S) => {
  try {
    return Schema.decodeUnknownOption(schema)(JSON.parse(new TextDecoder().decode(fromBase64(part))));
  } catch {
    return Option.none();
  }
};

/** Verifies an Access token and returns the identity it carries. */
export const verifyAccessToken = Effect.fn("verifyAccessToken")(function* (token: string) {
  const { access } = yield* AppConfig;

  if (!access) return yield* rejected("Cloudflare Access is not configured.");

  const [headerPart = "", claimsPart = "", signaturePart = ""] = token.split(".");
  const header = Option.getOrNull(decodePart(headerPart, TokenHeader));
  const claims = Option.getOrNull(decodePart(claimsPart, TokenClaims));

  if (!header || !claims) return yield* rejected("The token is malformed.");

  if (header.alg !== "RS256") return yield* rejected("The token uses an unsupported algorithm.");

  const key = yield* signingKey(access.teamDomain, header.kid);

  const valid = yield* Effect.tryPromise({
    try: () =>
      crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        key,
        fromBase64(signaturePart),
        new TextEncoder().encode(`${headerPart}.${claimsPart}`),
      ),
    catch: () => rejected("The token signature could not be checked."),
  });

  if (!valid) return yield* rejected("The token signature is invalid.");

  const seconds = now() / 1000;
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];

  if (claims.iss !== `https://${access.teamDomain}`) return yield* rejected("The token is from another team.");

  if (!audiences.includes(access.audience)) return yield* rejected("The token is for another application.");

  if (claims.exp <= seconds) return yield* rejected("The token has expired.");

  if (claims.nbf !== undefined && claims.nbf > seconds + 60) return yield* rejected("The token is not valid yet.");

  if (claims.email) {
    const person: AccessIdentity = { kind: "person", email: claims.email.toLowerCase() };

    return person;
  }

  if (claims.common_name) {
    const service: AccessIdentity = { kind: "service", clientId: claims.common_name };

    return service;
  }

  return yield* rejected("The token names neither a person nor a service.");
});
