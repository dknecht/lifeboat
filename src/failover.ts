import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { FailoverError } from "./errors";
import { readJson, request } from "./http";
import { AppConfig, Db, sql, type AppConfigShape } from "./services";
import { audit, deleteSetting, getOpenIncidentId, getSetting, getState, setSetting } from "./settings";
import { countPending } from "./sync";
import type { FailoverState } from "./types";
import { newId, now } from "./util";

const CF_API = "https://api.cloudflare.com/client/v4";

interface MxRecord {
  id?: string;
  name: string;
  content: string;
  priority: number;
  ttl: number;
}

export interface TransitionResult {
  state: FailoverState;
  dnsMode: "manual" | "api";
  /** Steps the administrator must carry out by hand (manual mode). */
  instructions: string[];
}

/** Calls the Cloudflare API for the configured zone. */
const cf = <T>(path: string, init: { method?: string; body?: unknown } = {}) =>
  Effect.gen(function* () {
    const { cloudflare } = yield* AppConfig;
    if (!cloudflare) {
      return yield* new FailoverError({ message: 'DNS_MODE is "api" but CF_API_TOKEN or CF_ZONE_ID is not set.' });
    }
    const method = init.method ?? "GET";
    const response = yield* request(`${CF_API}/zones/${cloudflare.zoneId}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${Redacted.value(cloudflare.apiToken)}`,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }).pipe(
      Effect.mapError(() => new FailoverError({ message: `Cloudflare API ${method} ${path} could not be reached.` })),
    );
    const data = yield* readJson<{ success?: boolean; result?: T; errors?: unknown }>(response);
    if (!response.ok || !data?.success) {
      return yield* new FailoverError({
        message: `Cloudflare API ${method} ${path} failed (HTTP ${response.status}): ${JSON.stringify(data?.errors ?? null).slice(0, 300)}`,
      });
    }
    return data.result as T;
  });

/**
 * Points the domain's MX at Cloudflare: saves and removes the existing MX records, enables Email
 * Routing, and routes every address to this Worker.
 *
 * EXPERIMENTAL: these calls have not been run against a live zone.
 */
const pointMxAtCloudflare = Effect.gen(function* () {
  const config = yield* AppConfig;
  const records = yield* cf<MxRecord[]>(`/dns_records?type=MX&name=${encodeURIComponent(config.mailDomain)}`);
  const foreign = records.filter((r) => !r.content.endsWith(".mx.cloudflare.net"));
  if (foreign.length) {
    // Saved before anything is deleted, so that a failure halfway can still be reversed.
    yield* setSetting(
      "saved_mx",
      JSON.stringify(foreign.map(({ name, content, priority, ttl }) => ({ name, content, priority, ttl }))),
    );
    yield* Effect.forEach(foreign, (r) => cf(`/dns_records/${r.id}`, { method: "DELETE" }), { discard: true });
  }
  yield* cf("/email/routing/enable", { method: "POST", body: {} });
  yield* cf("/email/routing/rules/catch_all", {
    method: "PUT",
    body: {
      enabled: true,
      name: "Lifeboat catch-all",
      matchers: [{ type: "all" }],
      actions: [{ type: "worker", value: [config.workerName] }],
    },
  });
});

const restoreOriginalMx = Effect.gen(function* () {
  const saved = yield* getSetting("saved_mx");
  if (!saved) {
    return yield* new FailoverError({
      message:
        "No saved MX records were found, so they cannot be restored automatically. Restore the Microsoft 365 MX record by hand.",
    });
  }
  yield* cf("/email/routing/disable", { method: "POST", body: {} });
  yield* Effect.forEach(
    JSON.parse(saved) as MxRecord[],
    (r) =>
      cf("/dns_records", {
        method: "POST",
        body: { type: "MX", name: r.name, content: r.content, priority: r.priority, ttl: r.ttl },
      }),
    { discard: true },
  );
  yield* deleteSetting("saved_mx");
});

export function manualInstructions(config: AppConfigShape, direction: "activate" | "deactivate"): string[] {
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
  return {
    state: "active",
    dnsMode: config.dnsMode,
    instructions: config.dnsMode === "manual" ? manualInstructions(config, "activate") : [],
  } as TransitionResult;
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
  return {
    state: next,
    dnsMode: config.dnsMode,
    instructions: config.dnsMode === "manual" ? manualInstructions(config, "deactivate") : [],
  } as TransitionResult;
});
