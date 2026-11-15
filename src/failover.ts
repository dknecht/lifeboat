import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { FailoverError } from "./errors";
import { readJson, request } from "./http";
import { AppConfig, Db, sql, type Configuration } from "./services";
import { audit, deleteSetting, getOpenIncidentId, getSetting, getState, setSetting } from "./settings";
import { countPending } from "./sync";
import type { FailoverState } from "./types";
import { newId, now } from "./util";

const CF_API = "https://api.cloudflare.com/client/v4";

/** An MX record as the Cloudflare DNS API returns it. */
const MxRecord = Schema.Struct({
  id: Schema.optional(Schema.String),
  name: Schema.String,
  content: Schema.String,
  priority: Schema.Number,
  ttl: Schema.Number,
});

const MxRecords = Schema.Array(MxRecord);
const decodeSavedMx = Schema.decodeUnknownOption(Schema.fromJsonString(MxRecords));

export interface TransitionResult {
  state: FailoverState;
  dnsMode: "manual" | "api";
  /** Steps the administrator must carry out by hand (manual mode). */
  instructions: string[];
}

/** Every Cloudflare API response wraps its payload in this envelope. */
const Envelope = Schema.Struct({ success: Schema.Boolean, result: Schema.optional(Schema.Unknown) });

interface CloudflareCall {
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  readonly path: string;
  /** A JSON-serializable request body. */
  readonly body?: object;
}

/** Calls the Cloudflare API for the configured zone and decodes the `result` field against `schema`. */
const cf = <S extends Schema.Top>(call: CloudflareCall, schema: S) =>
  Effect.gen(function* () {
    const { cloudflare } = yield* AppConfig;

    if (!cloudflare) {
      return yield* new FailoverError({ message: 'DNS_MODE is "api" but CF_API_TOKEN or CF_ZONE_ID is not set.' });
    }

    const headers = new Headers({ authorization: `Bearer ${Redacted.value(cloudflare.apiToken)}` });
    const init: RequestInit = { method: call.method, headers };

    if (call.body !== undefined) {
      headers.set("content-type", "application/json");
      init.body = JSON.stringify(call.body);
    }

    const label = `Cloudflare API ${call.method} ${call.path}`;

    const response = yield* request(`${CF_API}/zones/${cloudflare.zoneId}${call.path}`, init).pipe(
      Effect.mapError(() => new FailoverError({ message: `${label} could not be reached.` })),
    );

    const envelope = yield* readJson(response, Envelope);

    if (!response.ok || !envelope?.success) {
      return yield* new FailoverError({ message: `${label} failed (HTTP ${response.status}).` });
    }

    return yield* Schema.decodeUnknownEffect(schema)(envelope.result).pipe(
      Effect.mapError(() => new FailoverError({ message: `${label} returned a result in an unexpected format.` })),
    );
  });

/** The result of a call whose response body Lifeboat does not use. */
const Ignored = Schema.Unknown;

/**
 * Points the domain's MX at Cloudflare: saves and removes the existing MX records, enables Email
 * Routing, and routes every address to this Worker.
 *
 * EXPERIMENTAL: these calls have not been run against a live zone.
 */
const pointMxAtCloudflare = Effect.gen(function* () {
  const config = yield* AppConfig;

  const records = yield* cf(
    { method: "GET", path: `/dns_records?type=MX&name=${encodeURIComponent(config.mailDomain)}` },
    MxRecords,
  );

  const foreign = records.filter((record) => !record.content.endsWith(".mx.cloudflare.net"));

  if (foreign.length) {
    // Saved before anything is deleted, so that a failure halfway can still be reversed.
    yield* setSetting(
      "saved_mx",
      JSON.stringify(foreign.map(({ name, content, priority, ttl }) => ({ name, content, priority, ttl }))),
    );
    yield* Effect.forEach(
      foreign,
      (record) => cf({ method: "DELETE", path: `/dns_records/${record.id}` }, Ignored),
      { discard: true },
    );
  }

  yield* cf({ method: "POST", path: "/email/routing/enable", body: {} }, Ignored);
  yield* cf(
    {
      method: "PUT",
      path: "/email/routing/rules/catch_all",
      body: {
        enabled: true,
        name: "Lifeboat catch-all",
        matchers: [{ type: "all" }],
        actions: [{ type: "worker", value: [config.workerName] }],
      },
    },
    Ignored,
  );
});

const restoreOriginalMx = Effect.gen(function* () {
  const saved = Option.getOrNull(decodeSavedMx(yield* getSetting("saved_mx")));

  if (!saved) {
    return yield* new FailoverError({
      message:
        "No saved MX records were found, so they cannot be restored automatically. Restore the Microsoft 365 MX record by hand.",
    });
  }

  yield* cf({ method: "POST", path: "/email/routing/disable", body: {} }, Ignored);
  yield* Effect.forEach(
    saved,
    (record) =>
      cf(
        {
          method: "POST",
          path: "/dns_records",
          body: {
            type: "MX",
            name: record.name,
            content: record.content,
            priority: record.priority,
            ttl: record.ttl,
          },
        },
        Ignored,
      ),
    { discard: true },
  );
  yield* deleteSetting("saved_mx");
});

export function manualInstructions(config: Configuration, direction: "activate" | "deactivate"): string[] {
  const d = config.mailDomain;

  return direction === "activate"
    ? [
        `In the Cloudflare dashboard, open the ${d} zone and go to Email > Email Routing.`,
        `Note the current MX record for ${d} (the Microsoft 365 record ending in .mail.protection.outlook.com), then delete it.`,
        "Enable Email Routing and let it add Cloudflare's MX records.",
        `Set the catch-all rule to "Send to a Worker" and choose "${config.workerName}".`,
        "Send a test message from an outside account and confirm that it appears in Lifeboat.",
      ]
    : [
        "Confirm that Microsoft 365 is accepting mail again.",
        `In the Cloudflare dashboard, open the ${d} zone and disable Email Routing, removing Cloudflare's MX records.`,
        `Re-create the Microsoft 365 MX record for ${d} with priority 0 and a TTL of 5 minutes.`,
        "Lifeboat now copies the mail it holds into each user's mailbox. Progress is shown below.",
      ];
}

/** Declares an outage: switches MX (in api mode), opens an incident, and enters the active state. */
export const activate = Effect.fn("activate")(function* (actor: string, reason: string) {
  const config = yield* AppConfig;
  const db = yield* Db;

  if ((yield* getState) === "active") return yield* new FailoverError({ message: "Lifeboat is already active." });

  if (config.dnsMode === "api") yield* pointMxAtCloudflare;

  if (!(yield* getOpenIncidentId)) {
    yield* db.run(
      sql(
        "INSERT INTO incidents (id, started_at, started_by, reason) VALUES (?, ?, ?, ?)",
        newId(),
        now(),
        actor,
        reason.slice(0, 500),
      ),
    );
  }

  yield* setSetting("state", "active");
  yield* audit(actor, "failover.activate", reason);

  const result: TransitionResult = {
    state: "active",
    dnsMode: config.dnsMode,
    instructions: config.dnsMode === "manual" ? manualInstructions(config, "activate") : [],
  };

  return result;
});

/** Ends the outage: restores MX (in api mode), closes the incident, and starts recovery. */
export const deactivate = Effect.fn("deactivate")(function* (actor: string) {
  const config = yield* AppConfig;
  const db = yield* Db;

  if ((yield* getState) !== "active") return yield* new FailoverError({ message: "Lifeboat is not active." });

  if (config.dnsMode === "api") yield* restoreOriginalMx;

  yield* db.run(sql("UPDATE incidents SET ended_at = ? WHERE ended_at IS NULL", now()));
  const next: FailoverState = (yield* countPending) > 0 ? "recovering" : "standby";
  yield* setSetting("state", next);
  yield* audit(actor, "failover.deactivate", `Next state: ${next}`);

  const result: TransitionResult = {
    state: next,
    dnsMode: config.dnsMode,
    instructions: config.dnsMode === "manual" ? manualInstructions(config, "deactivate") : [],
  };

  return result;
});
