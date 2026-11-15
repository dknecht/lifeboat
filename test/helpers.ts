import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { acceptInvite, createUser, issueInvite } from "../src/auth";
import type { InboundEmail } from "../src/inbound";
import type { Env, OutgoingEmail } from "../src/types";

export const testEnv = env as unknown as Env;
export const ADMIN = { authorization: "Bearer test-admin-token" };

export function rawEmail(opts: {
  from: string;
  to: string;
  subject: string;
  text?: string;
  html?: string;
  messageId?: string;
  attachment?: { filename: string; content: string };
}): string {
  const head = [
    `From: Sender Person <${opts.from}>`,
    `To: ${opts.to}`,
    `Subject: ${opts.subject}`,
    `Message-ID: ${opts.messageId ?? `<${crypto.randomUUID()}@sender.test>`}`,
    "Date: Sat, 14 Nov 2026 10:00:00 +0000",
    "MIME-Version: 1.0",
  ];
  if (!opts.attachment) {
    const type = opts.html ? "text/html" : "text/plain";
    return [...head, `Content-Type: ${type}; charset=utf-8`, "", opts.html ?? opts.text ?? "", ""].join("\r\n");
  }
  return [
    ...head,
    'Content-Type: multipart/mixed; boundary="b1"',
    "",
    "--b1",
    "Content-Type: text/plain; charset=utf-8",
    "",
    opts.text ?? "",
    "--b1",
    `Content-Type: text/plain; name="${opts.attachment.filename}"`,
    `Content-Disposition: attachment; filename="${opts.attachment.filename}"`,
    "Content-Transfer-Encoding: base64",
    "",
    btoa(opts.attachment.content),
    "--b1--",
    "",
  ].join("\r\n");
}

export function inboundEmail(from: string, to: string, raw: string): InboundEmail & { rejected?: string } {
  const bytes = new TextEncoder().encode(raw);
  const msg: InboundEmail & { rejected?: string } = {
    from,
    to,
    headers: new Headers({ "authentication-results": "mx.cloudflare.net; dkim=pass; spf=pass; dmarc=pass" }),
    raw: new Response(bytes).body!,
    rawSize: bytes.byteLength,
    setReject(reason: string) {
      msg.rejected = reason;
    },
  };
  return msg;
}

/** Creates an enrolled user and returns a session cookie for them. */
export async function enrolledUser(email: string, role: "user" | "admin" = "user", aliases: string[] = []) {
  const password = "correct horse battery";
  const { user } = await createUser(testEnv, { email, displayName: "Test User", role, aliases });
  await acceptInvite(testEnv, await issueInvite(testEnv, user.id), password);
  const res = await call("/auth/login", { method: "POST", body: { email, password } });
  const cookie = res.headers.get("set-cookie")!.split(";")[0]!;
  return { user, password, cookie };
}

export async function call(
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
): Promise<Response> {
  const write = Boolean(init.method && init.method !== "GET");
  const request = new Request(`https://lifeboat.test/api${path}`, {
    method: init.method ?? "GET",
    headers: { ...(write ? { "content-type": "application/json" } : {}), ...init.headers },
    body: write ? JSON.stringify(init.body ?? {}) : undefined,
  });
  const ctx = createExecutionContext();
  const res = await worker.fetch(request, testEnv, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

/** Replaces the Email Sending binding with a recorder. */
export function fakeMailer(env: Env, fail = false): OutgoingEmail[] {
  const sent: OutgoingEmail[] = [];
  env.EMAIL = {
    async send(message) {
      if (fail) throw Object.assign(new Error("boom"), { code: "E_SENDER_NOT_VERIFIED" });
      sent.push(message);
      return { messageId: `${crypto.randomUUID()}@example.com` };
    },
  };
  return sent;
}
