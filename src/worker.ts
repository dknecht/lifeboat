/**
 * The Cloudflare Worker, defined with Alchemy.
 *
 * This file is both infrastructure and runtime. At deploy time the outer Effect declares what the
 * Worker needs (database, bucket, mail binding, configuration, cron trigger). At runtime the same
 * Effect resolves those bindings and connects the three platform events to the application in
 * app.ts.
 */
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { handleInbound, handleRequest, handleScheduled } from "./app";
import { appLayer, type AppServices } from "./services";

/** Message index, users, sessions, incidents. Pending migrations are applied on every deploy. */
export const Database = Cloudflare.D1.Database("DB", { migrations: "./migrations" });

/** Raw MIME, parsed bodies, and attachments. */
export const MailBucket = Cloudflare.R2.Bucket("Mail");

/** Outbound mail through Cloudflare Email Sending. */
const Outbound = Cloudflare.Email.SendEmail("EMAIL");

/** Collects a byte stream into one array. */
async function readAll(stream: { getReader(): ReadableStreamDefaultReader<Uint8Array> }): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;

  for (let next = await reader.read(); !next.done; next = await reader.read()) {
    chunks.push(next.value);
    length += next.value.byteLength;
  }

  const bytes = new Uint8Array(length);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bytes;
}

const text = (name: string, fallback: string) => Config.String(name).pipe(Config.withDefault(fallback));

const secret = (name: string) =>
  Config.option(Config.Redacted(name)).pipe(Config.map(Option.match({ onNone: () => undefined, onSome: Redacted.value })));

/** Every configuration value the application reads. Yielding a Config here also binds it to the Worker. */
const settings = Config.all({
  MAIL_DOMAIN: Config.String("MAIL_DOMAIN"),
  APP_URL: Config.String("APP_URL"),
  DNS_MODE: text("DNS_MODE", "manual"),
  UNKNOWN_RECIPIENT: text("UNKNOWN_RECIPIENT", "hold"),
  AUTO_FAILOVER: text("AUTO_FAILOVER", "false"),
  PROBE_THRESHOLD: text("PROBE_THRESHOLD", "3"),
  RETENTION_DAYS: text("RETENTION_DAYS", "30"),
  GRAPH_TENANT_ID: text("GRAPH_TENANT_ID", ""),
  GRAPH_CLIENT_ID: text("GRAPH_CLIENT_ID", ""),
  GRAPH_CANARY_MAILBOX: text("GRAPH_CANARY_MAILBOX", ""),
  CF_ZONE_ID: text("CF_ZONE_ID", ""),
  // The name Alchemy gave this Worker; the catch-all routing rule must refer to it.
  WORKER_NAME: text("ALCHEMY_WORKER_NAME", "lifeboat"),
  ADMIN_TOKEN: secret("ADMIN_TOKEN"),
  GRAPH_CLIENT_SECRET: secret("GRAPH_CLIENT_SECRET"),
  CF_API_TOKEN: secret("CF_API_TOKEN"),
});

export default Cloudflare.Worker(
  "Worker",
  {
    main: import.meta.url,
    compatibility: { date: "2026-11-01" },
    assets: {
      // Built from web/ by `npm run build:web`.
      directory: "./dist",
      notFoundHandling: "single-page-application",
      runWorkerFirst: ["/api/*"],
    },
  },
  Effect.gen(function* () {
    const db = yield* Cloudflare.D1.QueryDatabase(Database);
    const bucket = yield* Cloudflare.R2.ReadWriteBucket(MailBucket);
    const email = yield* Cloudflare.Email.Send(Outbound);
    const vars = yield* settings;

    /** Runs an application effect with services built from this Worker's bindings. */
    const withApp = <A, E>(effect: Effect.Effect<A, E, AppServices>) =>
      Effect.gen(function* () {
        const sender = yield* email.raw;

        const layer = appLayer({
          db: yield* db.raw,
          bucket: yield* bucket.raw,
          email: { send: (message) => sender.send(message) },
          vars,
        });

        return yield* Effect.provide(effect, layer);
      });

    // Health probe, sync-back drain, retention sweep.
    yield* Cloudflare.Workers.cron("*/5 * * * *", () =>
      withApp(handleScheduled).pipe(
        Effect.andThen(Effect.logInfo("Scheduled run finished")),
        Effect.catchCause((cause) => Effect.logError("Scheduled run failed", cause)),
      ),
    );

    // No zone is given on purpose: Lifeboat only receives mail after an administrator switches the
    // domain's MX to Cloudflare. Naming a zone here would enable Email Routing on every deploy.
    yield* Cloudflare.Workers.email().subscribe((message) =>
      Effect.gen(function* () {
        const result = yield* withApp(
          handleInbound({
            from: message.from,
            to: message.to,
            headers: message.headers,
            size: message.bodySize,
            readRaw: Effect.promise(() => readAll(message.body)),
          }),
        );

        yield* Effect.logInfo(`Inbound mail for ${message.to}: ${result.status}`);

        if (result.status === "rejected") yield* message.setReject(result.reason);
        // A storage failure is deliberately left to fail the event: the platform then answers with a
        // temporary SMTP error and the sending server retries, so mail is never accepted and lost.
      }),
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const web = yield* HttpServerRequest.toWeb(request);

        return HttpServerResponse.fromWeb(yield* withApp(handleRequest(web)));
      }).pipe(
        // Only reached when the incoming request itself cannot be read.
        Effect.catchCause(() => Effect.succeed(HttpServerResponse.text("Bad request", { status: 400 }))),
      ),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Cloudflare.D1.QueryDatabaseBinding,
        Cloudflare.R2.ReadWriteBucketBinding,
        Cloudflare.Email.SendBinding,
        Cloudflare.Workers.CronEventSourceLive,
        Cloudflare.Workers.EmailEventSourceLive,
      ),
    ),
  ),
);
