import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { EnvironmentValues } from "../src/services";
import { toBase64Url } from "../src/util";
import { ADMIN, call, enrolledUser } from "./helpers";

/** Reads a response body for assertions; the tests check its contents field by field. */
const json = (res: Response): Promise<any> => res.json();

const TEAM = "lifeboat-test.cloudflareaccess.com";
const AUD = "aud-of-the-lifeboat-application";

const ACCESS: EnvironmentValues = { AUTH_MODE: "access", ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };
const BOTH: EnvironmentValues = { ...ACCESS, AUTH_MODE: "both" };

interface Claims {
  iss?: string;
  aud?: string[];
  exp?: number;
  email?: string;
  common_name?: string;
}

let signingKey: CryptoKey;
let otherKey: CryptoKey;

/** A public key as Cloudflare publishes it: a JWK with the key ID tokens refer to. */
interface PublishedKey extends JsonWebKey {
  kid: string;
}

/** The key set served at the team's certs address. */
interface PublishedKeys {
  keys: PublishedKey[];
}

let publishedKeys: PublishedKeys;

async function rsaKeyPair(): Promise<CryptoKeyPair> {
  const generated = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );

  if (!("privateKey" in generated)) throw new Error("Expected an RSA key pair.");

  return generated;
}

const encode = (json: string) => toBase64Url(new TextEncoder().encode(json));

/** Signs an Access-style token. `key` defaults to the team's published key. */
async function accessToken(claims: Claims, key: CryptoKey = signingKey): Promise<string> {
  const payload = { iss: `https://${TEAM}`, aud: [AUD], exp: Math.floor(Date.now() / 1000) + 300, ...claims };
  const unsigned = `${encode(JSON.stringify({ alg: "RS256", kid: "key-1" }))}.${encode(JSON.stringify(payload))}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));

  return `${unsigned}.${toBase64Url(new Uint8Array(signature))}`;
}

const withToken = async (claims: Claims, key?: CryptoKey) => ({ "cf-access-jwt-assertion": await accessToken(claims, key) });

beforeAll(async () => {
  const pair = await rsaKeyPair();
  const exported = await crypto.subtle.exportKey("jwk", pair.publicKey);

  // Exporting in "jwk" format yields a JSON Web Key, never the binary form the type also allows.
  if (exported instanceof ArrayBuffer) throw new Error("Expected a JSON Web Key.");

  const published: PublishedKey = { ...exported, kid: "key-1" };

  signingKey = pair.privateKey;
  otherKey = (await rsaKeyPair()).privateKey;
  publishedKeys = { keys: [published] };
});

/** Serves the team's signing keys, as Cloudflare does at /cdn-cgi/access/certs. */
function publishKeys() {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);

    return url === `https://${TEAM}/cdn-cgi/access/certs`
      ? new Response(JSON.stringify(publishedKeys), { headers: { "content-type": "application/json" } })
      : new Response("unexpected request", { status: 500 });
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("Cloudflare Access sign-in", () => {
  it("signs in an existing user from a valid token and reports how they arrived", async () => {
    publishKeys();
    await enrolledUser("ana@example.com", "user", ["sales@example.com"]);

    const me = await call("/auth/me", { headers: await withToken({ email: "Ana@Example.com" }), vars: ACCESS });

    expect(me.status).toBe(200);
    expect(await json(me)).toMatchObject({ user: { email: "ana@example.com" }, authMode: "access", via: "access" });

    // An alias signs in as the user who owns it.
    const alias = await call("/auth/me", { headers: await withToken({ email: "sales@example.com" }), vars: ACCESS });

    expect((await json(alias)).user.email).toBe("ana@example.com");
  });

  it("creates an account on first arrival for the mail domain and for listed administrators only", async () => {
    publishKeys();
    const vars = { ...ACCESS, ACCESS_ADMIN_EMAILS: "boss@corp.example, other@corp.example" };

    const member = await call("/auth/me", { headers: await withToken({ email: "new@example.com" }), vars });

    expect((await json(member)).user).toMatchObject({ email: "new@example.com", role: "user" });

    const boss = await call("/admin/overview", { headers: await withToken({ email: "boss@corp.example" }), vars });

    expect(boss.status).toBe(200);

    const stranger = await call("/auth/me", { headers: await withToken({ email: "someone@elsewhere.test" }), vars });

    expect(stranger.status).toBe(401);
  });

  it("promotes an existing user who is listed as an Access administrator", async () => {
    publishKeys();
    await enrolledUser("cy@example.com");
    const vars = { ...ACCESS, ACCESS_ADMIN_EMAILS: "cy@example.com" };

    expect((await call("/admin/overview", { headers: await withToken({ email: "cy@example.com" }), vars })).status).toBe(200);
  });

  it("refuses tokens that are forged, expired, or meant for another application or team", async () => {
    publishKeys();
    await enrolledUser("dee@example.com");

    const attempt = async (claims: Claims, key?: CryptoKey) =>
      (await call("/auth/me", { headers: await withToken({ email: "dee@example.com", ...claims }, key), vars: ACCESS })).status;

    expect(await attempt({})).toBe(200);
    expect(await attempt({}, otherKey)).toBe(401);
    expect(await attempt({ exp: Math.floor(Date.now() / 1000) - 10 })).toBe(401);
    expect(await attempt({ aud: ["some-other-application"] })).toBe(401);
    expect(await attempt({ iss: "https://attacker.cloudflareaccess.com" })).toBe(401);
    expect((await call("/auth/me", { headers: { "cf-access-jwt-assertion": "not.a.token" }, vars: ACCESS })).status).toBe(401);
    expect((await call("/auth/me", { vars: ACCESS })).status).toBe(401);
  });

  it("ignores the Access header entirely in local mode", async () => {
    publishKeys();
    await enrolledUser("eve@example.com", "admin");
    const headers = await withToken({ email: "eve@example.com" });

    // The Access settings are present, but the mode is local, so the token grants nothing.
    const vars = { ...ACCESS, AUTH_MODE: "local" };

    expect((await call("/auth/me", { headers, vars })).status).toBe(401);
    expect((await call("/admin/overview", { headers, vars })).status).toBe(401);
  });

  it("turns off passwords, sessions, and invites when Access is the only way in", async () => {
    publishKeys();
    const { cookie, password, user } = await enrolledUser("fay@example.com", "admin");
    const admin = await withToken({ email: "fay@example.com" });
    const vars = { ...ACCESS, ACCESS_ADMIN_EMAILS: "fay@example.com" };

    expect((await call("/auth/login", { method: "POST", body: { email: "fay@example.com", password }, vars })).status).toBe(409);
    expect((await call("/auth/me", { headers: { cookie }, vars })).status).toBe(401);
    expect((await call(`/admin/users/${user.id}/invite`, { method: "POST", headers: admin, vars })).status).toBe(409);

    const created = await call("/admin/users", { method: "POST", headers: admin, body: { email: "gus@example.com" }, vars });

    expect(created.status).toBe(201);
    expect((await json(created)).inviteLink).toBeNull();
    expect((await json(await call("/status", { vars }))).authMode).toBe("access");
  });
});

describe("passwords for mail, Access for the admin console", () => {
  it("lets a session read mail but requires Access for admin routes", async () => {
    publishKeys();
    const { cookie } = await enrolledUser("hal@example.com", "admin");

    expect((await call("/messages", { headers: { cookie }, vars: BOTH })).status).toBe(200);
    expect(await json(await call("/auth/me", { headers: { cookie }, vars: BOTH }))).toMatchObject({ authMode: "both", via: "session" });

    const refused = await call("/admin/overview", { headers: { cookie }, vars: BOTH });

    expect(refused.status).toBe(401);
    expect((await json(refused)).code).toBe("access_required");
    expect((await call("/admin/failover/activate", { method: "POST", headers: { cookie }, vars: BOTH })).status).toBe(401);

    const viaAccess = await call("/admin/overview", { headers: await withToken({ email: "hal@example.com" }), vars: BOTH });

    expect(viaAccess.status).toBe(200);
  });

  it("does not make an ordinary user an administrator just because they came through Access", async () => {
    publishKeys();
    await enrolledUser("ida@example.com");

    const res = await call("/admin/overview", { headers: await withToken({ email: "ida@example.com" }), vars: BOTH });

    expect(res.status).toBe(403);
  });

  it("admits a listed service token as automation and refuses an unlisted one", async () => {
    publishKeys();
    const vars = { ...BOTH, ACCESS_ADMIN_SERVICE_TOKENS: "monitor.access" };

    const listed = await call("/admin/overview", { headers: await withToken({ common_name: "monitor.access" }), vars });
    const unlisted = await call("/admin/overview", { headers: await withToken({ common_name: "other.access" }), vars });

    expect(listed.status).toBe(200);
    expect(unlisted.status).toBe(401);
  });

  it("keeps the admin token working as a break-glass path", async () => {
    expect((await call("/admin/overview", { headers: ADMIN, vars: BOTH })).status).toBe(200);
  });

  it("sends people back into the app after the Access sign-in page", async () => {
    publishKeys();
    await enrolledUser("jo@example.com", "admin");
    const headers = await withToken({ email: "jo@example.com" });

    const admin = await call("/admin/access-login", { headers, vars: BOTH });
    const inbox = await call("/admin/access-login?next=inbox", { headers, vars: BOTH });
    const open = await call("/admin/access-login?next=https://evil.test", { headers, vars: BOTH });

    expect([admin.status, admin.headers.get("location")]).toEqual([302, "/#/admin"]);
    expect(inbox.headers.get("location")).toBe("/#/inbox");
    expect(open.headers.get("location")).toBe("/#/admin");
    expect((await call("/admin/access-login", { vars: BOTH })).status).toBe(401);
  });
});
