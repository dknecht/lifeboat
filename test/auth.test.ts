import { describe, expect, it } from "vitest";
import { ADMIN, call, enrolledUser } from "./helpers";

/** Reads a response body for assertions; the tests check its contents field by field. */
const json = (res: Response): Promise<any> => res.json();

describe("accounts", () => {
  it("bootstraps a user with the admin token and enrolls through the invite link", async () => {
    const created = await call("/admin/users", { method: "POST", headers: ADMIN, body: { email: "Ida@Example.com", displayName: "Ida", role: "admin" } });
    expect(created.status).toBe(201);
    const { inviteLink } = await json(created);
    const token = inviteLink.split("/#/invite/")[1];
    expect(token).toBeTruthy();

    expect((await call("/auth/login", { method: "POST", body: { email: "ida@example.com", password: "anything at all" } })).status).toBe(401);
    expect((await call("/auth/accept-invite", { method: "POST", body: { token, password: "short" } })).status).toBe(400);
    expect((await call("/auth/accept-invite", { method: "POST", body: { token, password: "a long enough password" } })).status).toBe(200);
    // An invite works once.
    expect((await call("/auth/accept-invite", { method: "POST", body: { token, password: "another long password" } })).status).toBe(400);

    const login = await call("/auth/login", { method: "POST", body: { email: "ida@example.com", password: "a long enough password" } });
    expect(login.status).toBe(200);
    const setCookie = login.headers.get("set-cookie")!;
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Secure");

    const cookie = setCookie.split(";")[0]!;
    const me = await json(await call("/auth/me", { headers: { cookie } }));
    expect(me.user).toMatchObject({ email: "ida@example.com", role: "admin" });
    expect(me.addresses).toEqual(["ida@example.com"]);

    await call("/auth/logout", { method: "POST", headers: { cookie } });
    expect((await call("/auth/me", { headers: { cookie } })).status).toBe(401);
  });

  it("rejects duplicate users and locks an account after repeated failures", async () => {
    await enrolledUser("jo@example.com");
    expect((await call("/admin/users", { method: "POST", headers: ADMIN, body: { email: "jo@example.com" } })).status).toBe(409);

    for (let i = 0; i < 4; i++) {
      expect((await call("/auth/login", { method: "POST", body: { email: "jo@example.com", password: "wrong password!" } })).status).toBe(401);
    }

    expect((await call("/auth/login", { method: "POST", body: { email: "jo@example.com", password: "wrong password!" } })).status).toBe(429);
    // The right password is refused while the lock holds.
    expect((await call("/auth/login", { method: "POST", body: { email: "jo@example.com", password: "correct horse battery" } })).status).toBe(429);
  });

  it("keeps admin routes away from ordinary users, anonymous callers, and wrong tokens", async () => {
    const { cookie } = await enrolledUser("kit@example.com");
    expect((await call("/admin/overview", { headers: { cookie } })).status).toBe(403);
    expect((await call("/admin/overview")).status).toBe(401);
    expect((await call("/admin/overview", { headers: { authorization: "Bearer nope" } })).status).toBe(401);
    expect((await call("/admin/failover/activate", { method: "POST", headers: { cookie } })).status).toBe(403);
    expect((await call("/admin/overview", { headers: ADMIN })).status).toBe(200);
  });

  it("refuses state-changing requests that are not JSON", async () => {
    const res = await call("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      rawBody: "email=a&password=b",
    });

    expect(res.status).toBe(415);
  });
});

describe("passkeys", () => {
  const bogus = {
    id: "bm90LWEtcmVhbC1jcmVkZW50aWFs",
    rawId: "bm90LWEtcmVhbC1jcmVkZW50aWFs",
    type: "public-key",
    clientExtensionResults: {},
    response: { clientDataJSON: "e30", authenticatorData: "AA", signature: "AA" },
  };

  it("issues sign-in and registration challenges bound to the address Lifeboat is served from", async () => {
    const { cookie } = await enrolledUser("pat@example.com");
    const login = await json(await call("/auth/passkeys/login-options", { method: "POST" }));

    expect(login.options.rpId).toBe("lifeboat.test");
    expect(login.options.challenge.length).toBeGreaterThan(20);

    const register = await json(await call("/auth/passkeys/register-options", { method: "POST", headers: { cookie } }));

    expect(register.options).toMatchObject({ rp: { id: "lifeboat.test", name: "Lifeboat" }, user: { name: "pat@example.com" } });
    expect(register.options.authenticatorSelection.residentKey).toBe("required");
    expect((await json(await call("/auth/passkeys", { headers: { cookie } }))).passkeys).toEqual([]);
  });

  it("refuses an unknown passkey, a reused challenge, and anyone who is not signed in", async () => {
    const { challengeId } = await json(await call("/auth/passkeys/login-options", { method: "POST" }));
    const first = await call("/auth/passkeys/login", { method: "POST", body: { challengeId, response: bogus } });

    expect(first.status).toBe(400);
    expect((await json(first)).error).toBe("That passkey is not registered with Lifeboat.");

    // The challenge was spent by the first attempt.
    const second = await call("/auth/passkeys/login", { method: "POST", body: { challengeId, response: bogus } });

    expect((await json(second)).error).toBe("That took too long. Start again.");
    expect((await call("/auth/passkeys/register-options", { method: "POST" })).status).toBe(401);
    expect((await call("/auth/passkeys", {})).status).toBe(401);
  });

  it("is switched off when Cloudflare Access is the only way to sign in", async () => {
    const vars = { AUTH_MODE: "access", ACCESS_TEAM_DOMAIN: "t.cloudflareaccess.com", ACCESS_AUD: "aud" };

    expect((await call("/auth/passkeys/login-options", { method: "POST", vars })).status).toBe(409);
  });
});
