import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { BlobError, DbError, SendFailed } from "./errors";
import type { OutgoingEmail } from "./types";
import { intVar } from "./util";

// ── Configuration ────────────────────────────────────────────────────────────

export interface AppConfigShape {
  readonly workerName: string;
  readonly mailDomain: string;
  readonly appUrl: string;
  readonly dnsMode: "manual" | "api";
  readonly unknownRecipient: "hold" | "reject";
  readonly autoFailover: boolean;
  readonly probeThreshold: number;
  readonly retentionDays: number;
  readonly adminToken: Redacted.Redacted<string> | null;
  /** Null when the Entra app registration is not fully configured. */
  readonly graph: {
    readonly tenantId: string;
    readonly clientId: string;
    readonly clientSecret: Redacted.Redacted<string>;
  } | null;
  readonly canaryMailbox: string;
  /** Null unless both the zone and an API token are set. */
  readonly cloudflare: { readonly zoneId: string; readonly apiToken: Redacted.Redacted<string> } | null;
}

export class AppConfig extends Context.Service<AppConfig, AppConfigShape>()("lifeboat/AppConfig") {}

/** Builds the configuration from the Worker's plain environment values. */
export function configFromEnv(env: Record<string, string | undefined>): AppConfigShape {
  const get = (key: string) => env[key] ?? "";
  const secret = (key: string) => (env[key] ? Redacted.make(env[key]!) : null);
  const graphSecret = secret("GRAPH_CLIENT_SECRET");
  const cfToken = secret("CF_API_TOKEN");
  return {
    workerName: get("WORKER_NAME") || "lifeboat",
    mailDomain: get("MAIL_DOMAIN").toLowerCase(),
    appUrl: get("APP_URL").replace(/\/$/, ""),
    dnsMode: get("DNS_MODE") === "api" ? "api" : "manual",
    unknownRecipient: get("UNKNOWN_RECIPIENT") === "reject" ? "reject" : "hold",
    autoFailover: get("AUTO_FAILOVER") === "true",
    probeThreshold: intVar(env.PROBE_THRESHOLD, 3),
    retentionDays: intVar(env.RETENTION_DAYS, 30),
    adminToken: secret("ADMIN_TOKEN"),
    graph:
      get("GRAPH_TENANT_ID") && get("GRAPH_CLIENT_ID") && graphSecret
        ? { tenantId: get("GRAPH_TENANT_ID"), clientId: get("GRAPH_CLIENT_ID"), clientSecret: graphSecret }
        : null,
    canaryMailbox: get("GRAPH_CANARY_MAILBOX"),
    cloudflare: get("CF_ZONE_ID") && cfToken ? { zoneId: get("CF_ZONE_ID"), apiToken: cfToken } : null,
  };
}

// ── Database (D1) ────────────────────────────────────────────────────────────

/** A SQL statement with its bound values, as plain data so that statements can be batched. */
export interface Statement {
  readonly sql: string;
  readonly binds: ReadonlyArray<unknown>;
}
export const sql = (text: string, ...binds: unknown[]): Statement => ({ sql: text, binds });

export interface DbShape {
  readonly first: <T>(statement: Statement) => Effect.Effect<T | null, DbError>;
  readonly all: <T>(statement: Statement) => Effect.Effect<T[], DbError>;
  /** Runs a mutation and returns the number of rows it changed. */
  readonly run: (statement: Statement) => Effect.Effect<number, DbError>;
  /** Runs the statements in one transaction. */
  readonly batch: (statements: ReadonlyArray<Statement>) => Effect.Effect<void, DbError>;
}

export class Db extends Context.Service<Db, DbShape>()("lifeboat/Db") {}

export function makeDb(d1: D1Database): DbShape {
  const prepare = (s: Statement) => d1.prepare(s.sql).bind(...s.binds);
  const attempt = <A>(run: () => Promise<A>) =>
    Effect.tryPromise({ try: run, catch: (cause) => new DbError({ cause }) });
  return {
    first: <T>(s: Statement) => attempt(() => prepare(s).first<T>()),
    all: <T>(s: Statement) => attempt(async () => (await prepare(s).all<T>()).results),
    run: (s) => attempt(async () => (await prepare(s).run()).meta.changes ?? 0),
    batch: (statements) =>
      statements.length ? Effect.asVoid(attempt(() => d1.batch(statements.map(prepare)))) : Effect.void,
  };
}

// ── Object storage (R2) ──────────────────────────────────────────────────────

export interface BlobsShape {
  readonly put: (
    key: string,
    value: Uint8Array | string,
    contentType: string,
    metadata?: Record<string, string>,
  ) => Effect.Effect<void, BlobError>;
  readonly getBytes: (key: string) => Effect.Effect<Uint8Array | null, BlobError>;
  readonly getJson: <T>(key: string) => Effect.Effect<T | null, BlobError>;
  /** Returns the object as a stream for passing straight into a Response. */
  readonly getStream: (key: string) => Effect.Effect<ReadableStream | null, BlobError>;
  readonly list: (prefix: string) => Effect.Effect<string[], BlobError>;
  readonly delete: (keys: string[]) => Effect.Effect<void, BlobError>;
}

export class Blobs extends Context.Service<Blobs, BlobsShape>()("lifeboat/Blobs") {}

export function makeBlobs(bucket: R2Bucket): BlobsShape {
  const attempt = <A>(run: () => Promise<A>) =>
    Effect.tryPromise({ try: run, catch: (cause) => new BlobError({ cause }) });
  return {
    put: (key, value, contentType, metadata) =>
      Effect.asVoid(
        attempt(() => bucket.put(key, value, { httpMetadata: { contentType }, customMetadata: metadata })),
      ),
    getBytes: (key) =>
      attempt(async () => {
        const object = await bucket.get(key);
        return object ? new Uint8Array(await object.arrayBuffer()) : null;
      }),
    getJson: <T>(key: string) =>
      attempt(async () => {
        const object = await bucket.get(key);
        return object ? await object.json<T>() : null;
      }),
    getStream: (key) => attempt(async () => (await bucket.get(key))?.body ?? null),
    list: (prefix) => attempt(async () => (await bucket.list({ prefix })).objects.map((o) => o.key)),
    delete: (keys) => (keys.length ? attempt(() => bucket.delete(keys)) : Effect.void),
  };
}

// ── Outbound mail (Cloudflare Email Sending) ─────────────────────────────────

export interface MailerShape {
  readonly send: (message: OutgoingEmail) => Effect.Effect<{ messageId?: string }, SendFailed>;
}

export class Mailer extends Context.Service<Mailer, MailerShape>()("lifeboat/Mailer") {}

/** The structured send method of the `send_email` binding. */
export interface SendEmailBinding {
  send(message: OutgoingEmail): Promise<{ messageId?: string }>;
}

export function makeMailer(binding: SendEmailBinding): MailerShape {
  return {
    send: (message) =>
      Effect.tryPromise({
        try: () => binding.send(message),
        catch: (cause) => new SendFailed({ code: (cause as { code?: string })?.code, cause }),
      }),
  };
}

// ── Assembly ─────────────────────────────────────────────────────────────────

export type AppServices = AppConfig | Db | Blobs | Mailer;

/** The raw Cloudflare bindings the application runs on. */
export interface RawBindings {
  readonly db: D1Database;
  readonly bucket: R2Bucket;
  readonly email: SendEmailBinding;
  readonly vars: Record<string, string | undefined>;
}

export const appLayer = (raw: RawBindings): Layer.Layer<AppServices> =>
  Layer.mergeAll(
    Layer.succeed(AppConfig, configFromEnv(raw.vars)),
    Layer.succeed(Db, makeDb(raw.db)),
    Layer.succeed(Blobs, makeBlobs(raw.bucket)),
    Layer.succeed(Mailer, makeMailer(raw.email)),
  );
