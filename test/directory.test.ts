import { afterEach, describe, expect, it, vi } from "vitest";
import { handleScheduled } from "../src/app";
import { ADMIN, call, deliverOk, enrolledUser, run, testEnv } from "./helpers";

/** Reads a response body for assertions; the tests check its contents field by field. */
const json = (res: Response): Promise<any> => res.json();

interface DirectoryEntry {
  mail: string;
  displayName: string;
  proxyAddresses?: string[];
  accountEnabled?: boolean;
}

/** Stands in for Entra ID and the Graph directory, counting how often the directory is read. */
function fakeDirectory(entries: DirectoryEntry[], opts: { down?: boolean } = {}) {
  const reads = { users: 0 };

  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    const reply = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "application/json" } });

    if (opts.down) return reply('{"error":"unavailable"}', 503);

    if (url.includes("login.microsoftonline.com")) return reply('{"access_token":"tok"}');

    if (url.includes("/mailFolders/inbox?")) return reply('{"id":"inbox"}');

    if (url.includes("/users?")) {
      reads.users++;

      return reply(JSON.stringify({ value: entries }));
    }

    return reply('{"error":"unexpected"}', 500);
  });

  return reads;
}

const emails = async () =>
  (await testEnv.DB.prepare("SELECT email FROM users ORDER BY email").all<{ email: string }>()).results.map((row) => row.email);

afterEach(() => vi.unstubAllGlobals());

describe("scheduled directory import", () => {
  it("imports mailboxes in the mail domain, adds aliases, and waits until the next import is due", async () => {
    const reads = fakeDirectory([
      { mail: "Ana@Example.com", displayName: "Ana", proxyAddresses: ["SMTP:ana@example.com", "smtp:sales@example.com"] },
      { mail: "guest@partner.test", displayName: "Guest" },
      { mail: "gone@example.com", displayName: "Gone", accountEnabled: false },
    ]);

    await run(handleScheduled);

    expect(await emails()).toEqual(["ana@example.com"]);
    // Mail to the alias now reaches the imported user.
    expect(await deliverOk("x@y.test", "sales@example.com", "Subject: hi\r\n\r\nhello")).toBeTruthy();

    const overview = await json(await call("/admin/overview", { headers: ADMIN }));

    expect(overview.directory).toMatchObject({ found: 1, created: 1 });

    await run(handleScheduled);
    expect(reads.users).toBe(1);
  });

  it("never removes a user who has disappeared from the directory", async () => {
    await enrolledUser("kept@example.com");
    fakeDirectory([{ mail: "new@example.com", displayName: "New" }]);

    await run(handleScheduled);

    expect(await emails()).toEqual(["kept@example.com", "new@example.com"]);
  });

  it("does not run during an outage, can be switched off, and records a failure without stopping the job", async () => {
    const reads = fakeDirectory([{ mail: "ana@example.com", displayName: "Ana" }]);

    await run(handleScheduled, { DIRECTORY_SYNC_HOURS: "0" });
    expect(reads.users).toBe(0);

    await call("/admin/failover/activate", { method: "POST", headers: ADMIN });
    await run(handleScheduled);
    expect(reads.users).toBe(0);
    await call("/admin/failover/deactivate", { method: "POST", headers: ADMIN });

    fakeDirectory([], { down: true });
    await run(handleScheduled);

    const audit = await json(await call("/admin/audit", { headers: ADMIN }));

    expect(audit.entries.map((entry: any) => entry.action)).toContain("directory.sync_failed");
    expect(await emails()).toEqual([]);
  });
});

describe("inline images", () => {
  // A 1x1 transparent PNG.
  const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

  it("embeds an image the HTML refers to by content ID, and leaves other references alone", async () => {
    const { cookie } = await enrolledUser("ivy@example.com");

    const raw = [
      "From: Sender <a@b.test>",
      "To: ivy@example.com",
      "Subject: Logo",
      "Message-ID: <inline@b.test>",
      "MIME-Version: 1.0",
      'Content-Type: multipart/related; boundary="r1"',
      "",
      "--r1",
      "Content-Type: text/html; charset=utf-8",
      "",
      '<p>Hello</p><img src="cid:logo@b.test"><img src="cid:missing@b.test">',
      "--r1",
      'Content-Type: image/png; name="logo.png"',
      "Content-ID: <logo@b.test>",
      'Content-Disposition: inline; filename="logo.png"',
      "Content-Transfer-Encoding: base64",
      "",
      PNG,
      "--r1--",
      "",
    ].join("\r\n");

    const id = await deliverOk("a@b.test", "ivy@example.com", raw);
    const thread = await json(await call(`/messages/${id}/thread`, { headers: { cookie } }));
    const html: string = thread.messages[0].body.html;

    expect(html).toContain(`src="data:image/png;base64,${PNG}"`);
    expect(html).toContain('src="cid:missing@b.test"');
    expect(thread.messages[0].attachments).toMatchObject([{ filename: "logo.png", inline: true }]);
  });
});
