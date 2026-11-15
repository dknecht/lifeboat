import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { BlobError, DbError, SendFailed } from "./errors";
import type { OutgoingEmail } from "./types";
import { intVar } from "./util";

// ── Configuration ────────────────────────────────────────────────────────────

export interface Configuration {
  readonly workerName: string;
  /**
   * How people sign in. "local": Lifeboat passwords. "access": Cloudflare Access only.
   * "both": Lifeboat passwords for mail, with the admin console requiring Access.
   */
  readonly authMode: "local" | "access" | "both";
  /** Null unless the Access team domain and application audience are both set. */
  readonly access: { readonly teamDomain: string; readonly audience: string } | null;
  /** People who are administrators whenever they arrive through Access. */
  readonly accessAdminEmails: ReadonlyArray<string>;
  /** Client IDs of Access service tokens that may call the admin API. */
  readonly accessAdminServiceTokens: ReadonlyArray<string>;
  readonly mailDomain: string;
  readonly appUrl: string;
  readonly dnsMode: "manual" | "api";
  readonly unknownRecipient: "hold" | "reject";
  readonly autoFailover: boolean;
  readonly probeThreshold: number;
  readonly retentionDays: number;
  /** How often the directory is re-imported from Microsoft 365, in hours. Zero turns the schedule off. */
  readonly directorySyncHours: number;
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

export class AppConfig extends Context.Service<AppConfig, Configuration>()("lifeboat/AppConfig") {}

/** The Worker's plain environment values, as bound by src/worker.ts. Every value is optional text. */
export interface EnvironmentValues {
  readonly WORKER_NAME?: string | undefined;
  readonly AUTH_MODE?: string | undefined;
  readonly ACCESS_TEAM_DOMAIN?: string | undefined;
  readonly ACCESS_AUD?: string | undefined;
  readonly ACCESS_ADMIN_EMAILS?: string | undefined;
  readonly ACCESS_ADMIN_SERVICE_TOKENS?: string | undefined;
  readonly MAIL_DOMAIN?: string | undefined;
  readonly APP_URL?: string | undefined;
  readonly DNS_MODE?: string | undefined;
  readonly UNKNOWN_RECIPIENT?: string | undefined;
  readonly AUTO_FAILOVER?: string | undefined;
  readonly PROBE_THRESHOLD?: string | undefined;
  readonly RETENTION_DAYS?: string | undefined;
  readonly DIRECTORY_SYNC_HOURS?: string | undefined;
  readonly GRAPH_TENANT_ID?: string | undefined;
  readonly GRAPH_CLIENT_ID?: string | undefined;
  readonly GRAPH_CANARY_MAILBOX?: string | undefined;
  readonly CF_ZONE_ID?: string | undefined;
  readonly ADMIN_TOKEN?: string | undefined;
  readonly GRAPH_CLIENT_SECRET?: string | undefined;
  readonly CF_API_TOKEN?: string | undefined;
}

const listOf = (value: string | undefined) =>
  (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

const AUTH_MODES: ReadonlyArray<Configuration["authMode"]> = ["access", "both"];

const secretOf = (value: string | undefined) => (value ? Redacted.make(value) : null);

/** Builds the configuration from the Worker's plain environment values. */
export function configFromEnv(env: EnvironmentValues): Configuration {
  const graphSecret = secretOf(env.GRAPH_CLIENT_SECRET);
  const cfToken = secretOf(env.CF_API_TOKEN);

  return {
    workerName: env.WORKER_NAME || "lifeboat",
    authMode: AUTH_MODES.find((mode) => mode === env.AUTH_MODE) ?? "local",
    access:
      env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD
        ? { teamDomain: env.ACCESS_TEAM_DOMAIN.replace(/^https?:\/\//, "").replace(/\/$/, ""), audience: env.ACCESS_AUD }
        : null,
    accessAdminEmails: listOf(env.ACCESS_ADMIN_EMAILS).map((email) => email.toLowerCase()),
    accessAdminServiceTokens: listOf(env.ACCESS_ADMIN_SERVICE_TOKENS),
    mailDomain: (env.MAIL_DOMAIN ?? "").toLowerCase(),
    appUrl: (env.APP_URL ?? "").replace(/\/$/, ""),
    dnsMode: env.DNS_MODE === "api" ? "api" : "manual",
    unknownRecipient: env.UNKNOWN_RECIPIENT === "reject" ? "reject" : "hold",
    autoFailover: env.AUTO_FAILOVER === "true",
    probeThreshold: intVar(env.PROBE_THRESHOLD, 3),
    retentionDays: intVar(env.RETENTION_DAYS, 30),
    directorySyncHours: env.DIRECTORY_SYNC_HOURS?.trim() === "0" ? 0 : intVar(env.DIRECTORY_SYNC_HOURS, 24),
    adminToken: secretOf(env.ADMIN_TOKEN),
    graph:
      env.GRAPH_TENANT_ID && env.GRAPH_CLIENT_ID && graphSecret
        ? { tenantId: env.GRAPH_TENANT_ID, clientId: env.GRAPH_CLIENT_ID, clientSecret: graphSecret }
        : null,
    canaryMailbox: env.GRAPH_CANARY_MAILBOX ?? "",
    cloudflare: env.CF_ZONE_ID && cfToken ? { zoneId: env.CF_ZONE_ID, apiToken: cfToken } : null,
  };
}

// ── Database (D1) ────────────────────────────────────────────────────────────

/** A SQL statement with its bound values, as plain data so that statements can be batched. */
export interface Statement {
  readonly sql: string;
  readonly binds: ReadonlyArray<unknown>;
}

export const sql = (text: string, ...binds: unknown[]): Statement => ({ sql: text, binds });

export interface SqlDatabase {
  readonly first: <T>(statement: Statement) => Effect.Effect<T | null, DbError>;
  readonly all: <T>(statement: Statement) => Effect.Effect<T[], DbError>;
  /** Runs a mutation and returns the number of rows it changed. */
  readonly run: (statement: Statement) => Effect.Effect<number, DbError>;
  /** Runs the statements in one transaction. */
  readonly batch: (statements: ReadonlyArray<Statement>) => Effect.Effect<void, DbError>;
}

export class Db extends Context.Service<Db, SqlDatabase>()("lifeboat/Db") {}

export function makeDb(d1: D1Database): SqlDatabase {
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

export interface BlobStore {
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

export class Blobs extends Context.Service<Blobs, BlobStore>()("lifeboat/Blobs") {}

export function makeBlobs(bucket: R2Bucket): BlobStore {
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

export interface MailSender {
  readonly send: (message: OutgoingEmail) => Effect.Effect<{ messageId?: string }, SendFailed>;
}

export class Mailer extends Context.Service<Mailer, MailSender>()("lifeboat/Mailer") {}

/** The structured send method of the `send_email` binding. */
export interface SendEmailBinding {
  send(message: OutgoingEmail): Promise<{ messageId?: string }>;
}

export function makeMailer(binding: SendEmailBinding): MailSender {
  return {
    send: (message) =>
      Effect.tryPromise({
        try: () => binding.send(message),
        // Cloudflare Email Sending attaches a code such as E_SENDER_NOT_VERIFIED to its errors.
        catch: (cause) =>
          new SendFailed({ code: cause instanceof Error && "code" in cause ? String(cause.code) : undefined, cause }),
      }),
  };
}

// ── Assembly ─────────────────────────────────────────────────────────────────

// ── Identity established by the platform ─────────────────────────────────────

/**
 * Who Cloudflare Access says is making this request, when Access is attached to the Worker itself.
 * Cloudflare has already verified the person by the time the Worker runs, so the address is trusted
 * as given. It is null when the request did not come through Access that way.
 */
export interface EdgeIdentityValue {
  readonly accessEmail: string | null;
}

export class EdgeIdentity extends Context.Service<EdgeIdentity, EdgeIdentityValue>()("lifeboat/EdgeIdentity") {}

export type AppServices = AppConfig | Db | Blobs | Mailer | EdgeIdentity;

/** The raw Cloudflare bindings the application runs on. */
export interface RawBindings {
  readonly db: D1Database;
  readonly bucket: R2Bucket;
  readonly email: SendEmailBinding;
  readonly vars: EnvironmentValues;
  /** The address Cloudflare Access verified for this request, if Access is attached to the Worker. */
  readonly accessEmail?: string | null;
}

export const appLayer = (raw: RawBindings): Layer.Layer<AppServices> =>
  Layer.mergeAll(
    Layer.succeed(AppConfig, configFromEnv(raw.vars)),
    Layer.succeed(Db, makeDb(raw.db)),
    Layer.succeed(Blobs, makeBlobs(raw.bucket)),
    Layer.succeed(Mailer, makeMailer(raw.email)),
    Layer.succeed(EdgeIdentity, { accessEmail: raw.accessEmail?.toLowerCase() ?? null }),
  );
