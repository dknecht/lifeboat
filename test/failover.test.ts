import { afterEach, describe, expect, it, vi } from "vitest";
import { handleScheduled } from "../src/app";
import { buildGraphMessage } from "../src/graph";
import { runProbe } from "../src/health";
import { getState } from "../src/settings";
import { retentionSweep } from "../src/sync";
import type { MessageRow } from "../src/types";
import { ADMIN, call, deliverOk, enrolledUser, rawEmail, run, testEnv } from "./helpers";

/** Reads a response body for assertions; the tests check its contents field by field. */
const json = (res: Response): Promise<any> => res.json();

/** A JSON response body the fake Graph returns. */
interface FakeBody {
  readonly error?: string;
  readonly access_token?: string;
  readonly id?: string;
  readonly value?: ReadonlyArray<{ readonly id: string }>;
}

const reply = (body: FakeBody, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Stands in for Entra ID and Microsoft Graph, recording every call. */
function fakeGraph(opts: { down?: boolean; failCreate?: boolean } = {}) {
  const calls: { method: string; url: string; body: any }[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = init?.method ?? "GET";
    // Graph calls send JSON text; the token request sends form fields, which the tests do not inspect.
    const text = String(init?.body ?? "");
    const body = text.startsWith("{") ? JSON.parse(text) : null;
    calls.push({ method, url: decodeURIComponent(url), body });

    if (opts.down) return reply({ error: "unavailable" }, 503);

    if (url.includes("login.microsoftonline.com")) return reply({ access_token: "tok" });

    if (method === "GET" && url.includes("/messages?$filter")) return reply({ value: [] });

    if (method === "POST" && url.endsWith("/attachments")) return reply({ id: "att" }, 201);

    if (method === "POST" && url.endsWith("/messages")) {
      return opts.failCreate ? reply({ error: "mailbox busy" }, 503) : reply({ id: `graph-${calls.length}` }, 201);
    }

    if (url.includes("/mailFolders/inbox?")) return reply({ id: "inbox" });

    return reply({ error: `unexpected ${method} ${url}` }, 500);
  });

  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("failover lifecycle", () => {
  it("runs a full incident: activate, receive, reply, deactivate, sync back, return to standby", async () => {
    const { cookie } = await enrolledUser("lee@example.com");
    expect(await run(getState)).toBe("standby");

    const activated = await json(await call("/admin/failover/activate", { method: "POST", headers: ADMIN, body: { reason: "EX123 outage" } }));
    expect(activated).toMatchObject({ state: "active", dnsMode: "manual" });
    expect(activated.instructions.length).toBeGreaterThan(2);
    expect((await json(await call("/status"))).state).toBe("active");
    expect((await call("/admin/failover/activate", { method: "POST", headers: ADMIN })).status).toBe(409);

    const raw = rawEmail({ from: "client@other.test", to: "lee@example.com", subject: "During outage", html: "<p>Hello <b>Lee</b></p>", messageId: "<in1@other.test>", });
    const inbound = { id: await deliverOk("client@other.test", "lee@example.com", raw) };
    await call("/messages", { method: "POST", headers: { cookie }, body: { to: ["client@other.test"], subject: "Re: During outage", text: "Got it", inReplyToId: inbound.id } });

    const deactivated = await json(await call("/admin/failover/deactivate", { method: "POST", headers: ADMIN }));
    expect(deactivated.state).toBe("recovering");

    const calls = fakeGraph();
    const sync = await json(await call("/admin/sync/run", { method: "POST", headers: ADMIN }));
    expect(sync).toMatchObject({ attempted: 2, synced: 2, failed: 0, remaining: 0, state: "standby" });

    const creates = calls.filter((c) => c.method === "POST" && c.url.endsWith("/messages"));
    expect(creates).toHaveLength(2);
    const inboxCreate = creates.find((c) => c.url.includes("/mailFolders/inbox/"))!;
    expect(inboxCreate.url).toContain("/users/lee@example.com/");
    expect(inboxCreate.body).toMatchObject({
      subject: "During outage",
      internetMessageId: "<in1@other.test>",
      body: { contentType: "html" },
      from: { emailAddress: { address: "client@other.test" } },
    });
    expect(inboxCreate.body.singleValueExtendedProperties).toContainEqual({ id: "Integer 0x0E07", value: "1" });
    expect(creates.some((c) => c.url.includes("/mailFolders/sentitems/"))).toBe(true);

    const overview = await json(await call("/admin/overview", { headers: ADMIN }));
    expect(overview.sync).toMatchObject({ pending: 0, synced: 2 });
    expect(overview.state).toBe("standby");
    const audit = await json(await call("/admin/audit", { headers: ADMIN }));
    expect(audit.entries.map((e: any) => e.action)).toEqual(expect.arrayContaining(["failover.activate", "failover.deactivate", "failover.standby"]));
  });

  it("keeps a message pending and records the error when Graph refuses it", async () => {
    await enrolledUser("mo@example.com");
    await deliverOk("x@y.test", "mo@example.com", rawEmail({ from: "x@y.test", to: "mo@example.com", subject: "s", text: "t" }));
    fakeGraph({ failCreate: true });
    const sync = await json(await call("/admin/sync/run", { method: "POST", headers: ADMIN }));
    expect(sync).toMatchObject({ attempted: 1, synced: 0, failed: 1, remaining: 1 });
    const row = await testEnv.DB.prepare("SELECT sync_status, sync_attempts, sync_error FROM messages").first<any>();
    expect(row).toMatchObject({ sync_status: "pending", sync_attempts: 1 });
    expect(row.sync_error).toContain("503");
  });

  it("skips an item that already exists in the mailbox", async () => {
    await enrolledUser("ned@example.com");
    await deliverOk("x@y.test", "ned@example.com", rawEmail({ from: "x@y.test", to: "ned@example.com", subject: "s", text: "t", messageId: "<dup@y.test>" }));
    const calls = fakeGraph();
    const original = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: any, init?: any) =>
      String(input).includes("$filter") ? reply({ value: [{ id: "already-there" }] }) : original(input, init),
    );
    const sync = await json(await call("/admin/sync/run", { method: "POST", headers: ADMIN }));
    expect(sync.synced).toBe(1);
    expect(calls.filter((c) => c.method === "POST" && c.url.endsWith("/messages"))).toHaveLength(0);
    expect((await testEnv.DB.prepare("SELECT graph_id FROM messages").first<any>()).graph_id).toBe("already-there");
  });
});

describe("scheduled job", () => {
  it("drains sync-back while recovering and returns to standby", async () => {
    await enrolledUser("pat@example.com");
    await call("/admin/failover/activate", { method: "POST", headers: ADMIN });
    await deliverOk("x@y.test", "pat@example.com", rawEmail({ from: "x@y.test", to: "pat@example.com", subject: "s", text: "t" }));
    await call("/admin/failover/deactivate", { method: "POST", headers: ADMIN });
    expect(await run(getState)).toBe("recovering");

    fakeGraph();
    await run(handleScheduled);
    expect(await run(getState)).toBe("standby");
    const row = await testEnv.DB.prepare("SELECT sync_status FROM messages").first<any>();
    expect(row.sync_status).toBe("synced");
  });
});

describe("health probe", () => {
  it("marks Microsoft 365 degraded after the threshold and activates when auto-failover is on", async () => {
    fakeGraph({ down: true });
    expect((await run(runProbe)).status).toBe("unknown");
    await run(runProbe);
    const third = await run(runProbe);
    expect(third).toMatchObject({ status: "degraded", consecutiveFailures: 3 });
    expect(await run(getState)).toBe("standby");

    await run(runProbe, { AUTO_FAILOVER: "true" });
    expect(await run(getState)).toBe("active");
  });

  it("reports healthy when Graph answers", async () => {
    fakeGraph();
    expect(await run(runProbe)).toMatchObject({ status: "healthy", consecutiveFailures: 0, lastError: null });
  });
});

describe("retention and message mapping", () => {
  it("deletes only messages synced before the retention window", async () => {
    await enrolledUser("oz@example.com");
    const mk = () => deliverOk("x@y.test", "oz@example.com", rawEmail({ from: "x@y.test", to: "oz@example.com", subject: "s", text: "t" }));
    const [old, recent, pending] = [await mk(), await mk(), await mk()];
    const day = 24 * 60 * 60 * 1000;
    await testEnv.DB.prepare("UPDATE messages SET sync_status = 'synced', synced_at = ? WHERE id = ?").bind(Date.now() - 31 * day, old).run();
    await testEnv.DB.prepare("UPDATE messages SET sync_status = 'synced', synced_at = ? WHERE id = ?").bind(Date.now() - day, recent).run();

    expect(await run(retentionSweep())).toBe(1);
    expect(await testEnv.MAIL.get(`raw/${old}.eml`)).toBeNull();
    expect(await testEnv.MAIL.get(`raw/${recent}.eml`)).not.toBeNull();
    expect(await testEnv.MAIL.get(`raw/${pending}.eml`)).not.toBeNull();
    const left = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM messages").first<{ n: number }>();
    expect(left!.n).toBe(2);
  });

  it("maps a sent message to a read Sent Items entry with original times", () => {
    const sentAt = Date.UTC(2026, 10, 14, 10);

    const row: MessageRow = {
      id: "m1",
      user_id: "u1",
      rcpt_to: "b@x.test",
      direction: "out",
      folder: "sent",
      incident_id: null,
      message_id: "<m@example.com>",
      in_reply_to: null,
      refs: null,
      thread_id: null,
      from_addr: "a@example.com",
      from_name: "A",
      to_json: JSON.stringify([{ address: "b@x.test", name: "B" }]),
      cc_json: "[]",
      subject: "Hi",
      snippet: "hello",
      sent_at: sentAt,
      received_at: sentAt,
      size: 5,
      has_attachments: 0,
      is_read: 0,
      auth_results: null,
      sync_status: "pending",
      sync_attempts: 0,
      sync_error: null,
      synced_at: null,
      graph_id: null,
    };

    const msg = buildGraphMessage(row, { html: null, text: "hello" });
    expect(msg.isRead).toBe(true);
    expect(msg.body).toEqual({ contentType: "text", content: "hello" });
    expect(msg.toRecipients).toEqual([{ emailAddress: { address: "b@x.test", name: "B" } }]);
    expect(msg.singleValueExtendedProperties).toContainEqual({ id: "SystemTime 0x0039", value: "2026-11-14T10:00:00.000Z" });
  });
});
