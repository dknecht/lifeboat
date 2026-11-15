import { describe, expect, it } from "vitest";
import { ADMIN, call, enrolledUser } from "./helpers";

const json = async <T = any>(res: Response) => (await res.json()) as T;

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
    const { default: worker } = await import("../src/index");
    const { testEnv } = await import("./helpers");
    const res = await worker.fetch(
      new Request("https://lifeboat.test/api/auth/login", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "email=a&password=b" }),
      testEnv,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(415);
  });
});
