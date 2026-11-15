import { env } from "cloudflare:test";
import * as Effect from "effect/Effect";
import { handleInbound, handleRequest } from "../src/app";
import { acceptInvite, createUser, issueInvite } from "../src/auth";
import { appLayer, type AppServices, type EnvironmentValues } from "../src/services";
import type { OutgoingEmail } from "../src/types";

/** The local bindings, for assertions that look at storage directly. */
export const testEnv = env;
export const ADMIN = { authorization: "Bearer test-admin-token" };

/** Records what the application sends through the mail binding. Reset before each test. */
interface Outbox {
  sent: OutgoingEmail[];
  /** When true, the next send fails the way an unverified sender does. */
  fail: boolean;
}

export const outbox: Outbox = { sent: [], fail: false };

/** The error Cloudflare Email Sending raises for a sender it has not verified. */
class SenderNotVerified extends Error {
  readonly code = "E_SENDER_NOT_VERIFIED";
}

/** Runs an application effect against the local bindings. `vars` overrides configuration values. */
export function run<A, E>(effect: Effect.Effect<A, E, AppServices>, vars: EnvironmentValues = {}): Promise<A> {
  const layer = appLayer({
    db: testEnv.DB,
    bucket: testEnv.MAIL,
    email: {
      async send(message) {
        if (outbox.fail) throw new SenderNotVerified();
        outbox.sent.push(message);

        return { messageId: `${crypto.randomUUID()}@example.com` };
      },
    },
    vars: { ...env, ...vars },
  });

  return Effect.runPromise(effect.pipe(Effect.provide(layer)));
}

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

/** Delivers a raw message to the inbound handler as the mail platform would. */
export function deliver(
  from: string,
  to: string,
  raw: string,
  opts: { vars?: EnvironmentValues; size?: number } = {},
) {
  const bytes = new TextEncoder().encode(raw);

  return run(
    handleInbound({
      from,
      to,
      headers: new Headers({ "authentication-results": "mx.cloudflare.net; dkim=pass; spf=pass; dmarc=pass" }),
      size: opts.size ?? bytes.byteLength,
      readRaw: Effect.succeed(bytes),
    }),
    opts.vars,
  );
}

/** Delivers a message that must be accepted, and returns its ID. */
export async function deliverOk(from: string, to: string, raw: string): Promise<string> {
  const result = await deliver(from, to, raw);

  if (result.status === "rejected") throw new Error(`unexpected rejection: ${result.reason}`);

  return result.id;
}

export function call(
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: object; rawBody?: string } = {},
): Promise<Response> {
  const write = Boolean(init.method && init.method !== "GET");

  const headers = new Headers(init.headers);

  // Writes are JSON unless the test sets another content type on purpose.
  if (write && !headers.has("content-type")) headers.set("content-type", "application/json");

  const request = new Request(`https://lifeboat.test/api${path}`, {
    method: init.method ?? "GET",
    headers,
    body: write ? (init.rawBody ?? JSON.stringify(init.body ?? {})) : undefined,
  });

  return run(handleRequest(request));
}

/** Creates an enrolled user and returns a session cookie for them. */
export async function enrolledUser(email: string, role: "user" | "admin" = "user", aliases: string[] = []) {
  const password = "correct horse battery";
  const { user } = await run(createUser({ email, displayName: "Test User", role, aliases }));
  await run(issueInvite(user.id).pipe(Effect.flatMap((token) => acceptInvite(token, password))));
  const res = await call("/auth/login", { method: "POST", body: { email, password } });
  const cookie = res.headers.get("set-cookie")!.split(";")[0]!;

  return { user, password, cookie };
}
