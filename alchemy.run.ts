/**
 * Lifeboat infrastructure, defined with Alchemy (https://alchemy.run).
 *
 *   npm run dev       run everything locally, no Cloudflare account needed
 *   npm run deploy    create or update the D1 database, R2 bucket, and Worker
 *
 * Configuration comes from the process environment or a .env file; see .env.example.
 * The Worker itself is a plain async Worker (src/index.ts) with no Effect runtime in its bundle.
 */
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

// Deploys keep their state in Cloudflare so that any machine or CI job can update the stack.
// Local development uses a state file under .alchemy/ and needs no Cloudflare account.
const localState = process.env.LIFEBOAT_LOCAL_STATE === "1";

const text = (name: string, fallback: string) => Config.String(name).pipe(Config.withDefault(fallback));

export default Alchemy.Stack(
  "Lifeboat",
  {
    providers: Cloudflare.providers(),
    state: localState ? Alchemy.localState() : Cloudflare.state(),
  },
  Effect.gen(function* () {
    // Message index, users, sessions, incidents. Pending migrations are applied on every deploy.
    const db = yield* Cloudflare.D1.Database("DB", { migrations: "./migrations" });

    // Raw MIME, parsed bodies, and attachments.
    const mail = yield* Cloudflare.R2.Bucket("Mail");

    // Optional secrets are bound only when they are set, so that an unset one stays undefined.
    const graphSecret = yield* Config.option(Config.Redacted("GRAPH_CLIENT_SECRET"));
    const cfApiToken = yield* Config.option(Config.Redacted("CF_API_TOKEN"));

    // The script name is fixed because the Email Routing catch-all rule refers to the Worker by name.
    const workerName = yield* text("WORKER_NAME", "lifeboat");

    const worker = yield* Cloudflare.Worker("Worker", {
      name: workerName,
      main: "./src/index.ts",
      compatibility: { date: "2026-11-01" },
      assets: {
        directory: "./public",
        notFoundHandling: "single-page-application",
        runWorkerFirst: ["/api/*"],
      },
      // Health probe, sync-back drain, retention sweep.
      crons: ["*/5 * * * *"],
      env: {
        DB: db,
        MAIL: mail,
        EMAIL: Cloudflare.Email.SendEmail("EMAIL"),

        WORKER_NAME: workerName,
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

        ADMIN_TOKEN: Config.Redacted("ADMIN_TOKEN"),
        ...(Option.isSome(graphSecret) ? { GRAPH_CLIENT_SECRET: graphSecret.value } : {}),
        ...(Option.isSome(cfApiToken) ? { CF_API_TOKEN: cfApiToken.value } : {}),
      },
    });

    return { url: worker.url, workerName: worker.workerName };
  }),
);
