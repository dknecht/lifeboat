import { audit, deleteSetting, getOpenIncidentId, getSetting, getState, setSetting } from "./db";
import { countPending } from "./sync";
import type { Env, FailoverState } from "./types";
import { newId, now } from "./util";

const CF_API = "https://api.cloudflare.com/client/v4";
const WORKER_NAME = "lifeboat";

export class FailoverError extends Error {}

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

async function cf<T>(env: Env, path: string, init: RequestInit = {}): Promise<T> {
  if (!env.CF_API_TOKEN || !env.CF_ZONE_ID) {
    throw new FailoverError("DNS_MODE is \"api\" but CF_API_TOKEN or CF_ZONE_ID is not set.");
  }
  const res = await fetch(`${CF_API}/zones/${env.CF_ZONE_ID}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${env.CF_API_TOKEN}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
  });
  const data = (await res.json().catch(() => null)) as { success?: boolean; result?: T; errors?: unknown } | null;
  if (!res.ok || !data?.success) {
    throw new FailoverError(
      `Cloudflare API ${init.method ?? "GET"} ${path} failed (HTTP ${res.status}): ${JSON.stringify(data?.errors ?? null).slice(0, 300)}`,
    );
  }
  return data.result as T;
}

/**
 * Points the domain's MX at Cloudflare: saves and removes the existing MX records, enables Email
 * Routing, and routes every address to this Worker.
 *
 * EXPERIMENTAL: the Email Routing endpoints here have not been run against a live zone.
 */
async function pointMxAtCloudflare(env: Env): Promise<void> {
  const name = encodeURIComponent(env.MAIL_DOMAIN);
  const records = await cf<MxRecord[]>(env, `/dns_records?type=MX&name=${name}`);
  const foreign = records.filter((r) => !r.content.endsWith(".mx.cloudflare.net"));
  if (foreign.length) {
    // Saved before anything is deleted, so that a failure halfway can still be reversed.
    await setSetting(
      env,
      "saved_mx",
      JSON.stringify(foreign.map(({ name, content, priority, ttl }) => ({ name, content, priority, ttl }))),
    );
    for (const r of foreign) await cf(env, `/dns_records/${r.id}`, { method: "DELETE" });
  }
  await cf(env, "/email/routing/enable", { method: "POST", body: "{}" });
  await cf(env, "/email/routing/rules/catch_all", {
    method: "PUT",
    body: JSON.stringify({
      enabled: true,
      name: "Lifeboat catch-all",
      matchers: [{ type: "all" }],
      actions: [{ type: "worker", value: [WORKER_NAME] }],
    }),
  });
}

async function restoreOriginalMx(env: Env): Promise<void> {
  const saved = await getSetting(env, "saved_mx");
  if (!saved) {
    throw new FailoverError(
      "No saved MX records were found, so they cannot be restored automatically. Restore the Microsoft 365 MX record by hand.",
    );
  }
  await cf(env, "/email/routing/disable", { method: "POST", body: "{}" });
  for (const r of JSON.parse(saved) as MxRecord[]) {
    await cf(env, "/dns_records", {
      method: "POST",
      body: JSON.stringify({ type: "MX", name: r.name, content: r.content, priority: r.priority, ttl: r.ttl }),
    });
  }
  await deleteSetting(env, "saved_mx");
}

export function manualInstructions(env: Env, direction: "activate" | "deactivate"): string[] {
  const d = env.MAIL_DOMAIN;
  return direction === "activate"
    ? [
        `In the Cloudflare dashboard, open the ${d} zone and go to Email > Email Routing.`,
        `Note the current MX record for ${d} (the Microsoft 365 record ending in .mail.protection.outlook.com), then delete it.`,
        "Enable Email Routing and let it add Cloudflare's MX records.",
        `Set the catch-all rule to "Send to a Worker" and choose "${WORKER_NAME}".`,
        "Send a test message from an outside account and confirm that it appears in Lifeboat.",
      ]
    : [
        "Confirm that Microsoft 365 is accepting mail again.",
        `In the Cloudflare dashboard, open the ${d} zone and disable Email Routing, removing Cloudflare's MX records.`,
        `Re-create the Microsoft 365 MX record for ${d} with priority 0 and a TTL of 5 minutes.`,
        "Lifeboat now copies the mail it holds into each user's mailbox. Progress is shown below.",
      ];
}

export async function activate(env: Env, actor: string, reason: string): Promise<TransitionResult> {
  const state = await getState(env);
  if (state === "active") throw new FailoverError("Lifeboat is already active.");

  const dnsMode = env.DNS_MODE === "api" ? "api" : "manual";
  if (dnsMode === "api") await pointMxAtCloudflare(env);

  if (!(await getOpenIncidentId(env))) {
    await env.DB.prepare("INSERT INTO incidents (id, started_at, started_by, reason) VALUES (?, ?, ?, ?)")
      .bind(newId(), now(), actor, reason.slice(0, 500))
      .run();
  }
  await setSetting(env, "state", "active");
  await audit(env, actor, "failover.activate", reason);
  return { state: "active", dnsMode, instructions: dnsMode === "manual" ? manualInstructions(env, "activate") : [] };
}

export async function deactivate(env: Env, actor: string): Promise<TransitionResult> {
  const state = await getState(env);
  if (state !== "active") throw new FailoverError("Lifeboat is not active.");

  const dnsMode = env.DNS_MODE === "api" ? "api" : "manual";
  if (dnsMode === "api") await restoreOriginalMx(env);

  await env.DB.prepare("UPDATE incidents SET ended_at = ? WHERE ended_at IS NULL").bind(now()).run();
  const next: FailoverState = (await countPending(env)) > 0 ? "recovering" : "standby";
  await setSetting(env, "state", next);
  await audit(env, actor, "failover.deactivate", `Next state: ${next}`);
  return { state: next, dnsMode, instructions: dnsMode === "manual" ? manualInstructions(env, "deactivate") : [] };
}
