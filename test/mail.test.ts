import { beforeEach, describe, expect, it } from "vitest";
import { handleInbound } from "../src/inbound";
import { call, enrolledUser, fakeMailer, inboundEmail, rawEmail, testEnv } from "./helpers";

const json = async <T = any>(res: Response) => (await res.json()) as T;

describe("inbound mail", () => {
  it("stores a message for a known user and shows it in their inbox", async () => {
    const { cookie } = await enrolledUser("ana@example.com");
    const raw = rawEmail({ from: "client@other.test", to: "ana@example.com", subject: "Quarterly numbers", text: "Hello Ana,\r\nnumbers attached." });
    const result = await handleInbound(inboundEmail("client@other.test", "ana@example.com", raw), testEnv);
    expect(result.status).toBe("stored");

    const stored = await testEnv.MAIL.get(`raw/${result.id}.eml`);
    expect(await stored!.text()).toBe(raw);

    const list = await json(await call("/messages?folder=inbox", { headers: { cookie } }));
    expect(list.unread).toBe(1);
    expect(list.messages).toHaveLength(1);
    expect(list.messages[0]).toMatchObject({
      subject: "Quarterly numbers",
      from: { address: "client@other.test", name: "Sender Person" },
      isRead: false,
      syncStatus: "pending",
    });

    const detail = await json(await call(`/messages/${result.id}`, { headers: { cookie } }));
    expect(detail.message.body.text).toContain("numbers attached");
    const again = await json(await call("/messages?folder=inbox", { headers: { cookie } }));
    expect(again.unread).toBe(0);
  });

  it("delivers to an alias and keeps attachments downloadable", async () => {
    const { cookie } = await enrolledUser("ben@example.com", "user", ["sales@example.com"]);
    const raw = rawEmail({ from: "a@b.test", to: "Sales@Example.com", subject: "Order", text: "see file", attachment: { filename: "order.txt", content: "12 widgets" } });
    const result = await handleInbound(inboundEmail("a@b.test", "Sales@Example.com", raw), testEnv);
    expect(result.status).toBe("stored");

    const detail = await json(await call(`/messages/${result.id}`, { headers: { cookie } }));
    expect(detail.message.attachments).toMatchObject([{ idx: 0, filename: "order.txt", size: 10 }]);
    const file = await call(`/messages/${result.id}/attachments/0`, { headers: { cookie } });
    expect(file.headers.get("content-disposition")).toContain("attachment");
    expect(await file.text()).toBe("12 widgets");
  });

  it("holds mail for an unknown recipient until an admin assigns it", async () => {
    const admin = await enrolledUser("admin@example.com", "admin");
    const user = await enrolledUser("cy@example.com");
    const raw = rawEmail({ from: "x@y.test", to: "typo@example.com", subject: "Misaddressed", text: "hi" });
    const result = await handleInbound(inboundEmail("x@y.test", "typo@example.com", raw), testEnv);
    expect(result.status).toBe("held");

    expect((await json(await call("/messages", { headers: { cookie: user.cookie } }))).messages).toHaveLength(0);
    const held = await json(await call("/admin/held", { headers: { cookie: admin.cookie } }));
    expect(held.messages).toHaveLength(1);
    expect(held.messages[0].syncStatus).toBe("skipped");

    const assign = await call(`/admin/held/${result.id}/assign`, { method: "POST", headers: { cookie: admin.cookie }, body: { email: "cy@example.com" } });
    expect(assign.status).toBe(200);
    const inbox = await json(await call("/messages", { headers: { cookie: user.cookie } }));
    expect(inbox.messages[0]).toMatchObject({ subject: "Misaddressed", syncStatus: "pending" });
  });

  it("rejects unknown recipients when configured to, and oversized mail always", async () => {
    const strict = { ...testEnv, UNKNOWN_RECIPIENT: "reject" };
    const msg = inboundEmail("x@y.test", "nobody@example.com", rawEmail({ from: "x@y.test", to: "nobody@example.com", subject: "s", text: "t" }));
    expect((await handleInbound(msg, strict)).status).toBe("rejected");
    expect(msg.rejected).toBe("Address does not exist");

    const big = { ...inboundEmail("x@y.test", "nobody@example.com", "x"), rawSize: 26 * 1024 * 1024, rejected: undefined as string | undefined };
    big.setReject = (r: string) => void (big.rejected = r);
    expect((await handleInbound(big, testEnv)).status).toBe("rejected");
    expect(big.rejected).toBe("Message too large");
  });

  it("does not let one user read another user's mail", async () => {
    await enrolledUser("dee@example.com");
    const other = await enrolledUser("eve@example.com");
    const raw = rawEmail({ from: "x@y.test", to: "dee@example.com", subject: "Private", text: "secret", attachment: { filename: "a.txt", content: "secret" } });
    const { id } = await handleInbound(inboundEmail("x@y.test", "dee@example.com", raw), testEnv);
    expect((await call(`/messages/${id}`, { headers: { cookie: other.cookie } })).status).toBe(404);
    expect((await call(`/messages/${id}/attachments/0`, { headers: { cookie: other.cookie } })).status).toBe(404);
    expect((await call(`/messages/${id}`)).status).toBe(401);
  });
});

describe("sending", () => {
  let sent: ReturnType<typeof fakeMailer>;
  beforeEach(() => {
    sent = fakeMailer(testEnv);
  });

  it("sends a reply with threading headers and files it under Sent", async () => {
    const { cookie } = await enrolledUser("fay@example.com");
    const raw = rawEmail({ from: "client@other.test", to: "fay@example.com", subject: "Question", text: "Can you confirm?", messageId: "<q1@other.test>" });
    const { id } = await handleInbound(inboundEmail("client@other.test", "fay@example.com", raw), testEnv);

    const res = await call("/messages", {
      method: "POST",
      headers: { cookie },
      body: { to: ["client@other.test"], subject: "Re: Question", text: "Confirmed.", inReplyToId: id, attachments: [{ filename: "note.txt", contentType: "text/plain", contentBase64: btoa("ok") }] },
    });
    expect(res.status).toBe(201);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      from: { email: "fay@example.com", name: "Test User" },
      to: ["client@other.test"],
      subject: "Re: Question",
      text: "Confirmed.",
      headers: { "In-Reply-To": "<q1@other.test>", References: "<q1@other.test>" },
    });
    expect(sent[0]!.attachments![0]).toMatchObject({ filename: "note.txt", disposition: "attachment" });

    const list = await json(await call("/messages?folder=sent", { headers: { cookie } }));
    expect(list.messages[0]).toMatchObject({ subject: "Re: Question", syncStatus: "pending", hasAttachments: true });
  });

  it("refuses to send from an address the user does not own", async () => {
    const { cookie } = await enrolledUser("gus@example.com");
    await enrolledUser("ceo@example.com");
    const res = await call("/messages", { method: "POST", headers: { cookie }, body: { from: "ceo@example.com", to: ["a@b.test"], subject: "s", text: "t" } });
    expect(res.status).toBe(400);
    expect(sent).toHaveLength(0);
  });

  it("validates recipients and stores nothing when the provider fails", async () => {
    const { cookie } = await enrolledUser("hal@example.com");
    const bad = await call("/messages", { method: "POST", headers: { cookie }, body: { to: ["not-an-address"], subject: "s", text: "t" } });
    expect(bad.status).toBe(400);
    expect((await call("/messages", { method: "POST", headers: { cookie }, body: { to: [], subject: "s", text: "t" } })).status).toBe(400);

    fakeMailer(testEnv, true);
    const failed = await call("/messages", { method: "POST", headers: { cookie }, body: { to: ["a@b.test"], subject: "s", text: "t" } });
    expect(failed.status).toBe(502);
    expect((await json(failed)).error).toContain("E_SENDER_NOT_VERIFIED");
    expect((await json(await call("/messages?folder=sent", { headers: { cookie } }))).messages).toHaveLength(0);
  });
});
