import { audit, getSetting, getState, setSetting } from "./db";
import { activate } from "./failover";
import { getGraphToken, graphConfigured, probeMailbox } from "./graph";
import type { Env } from "./types";
import { intVar, now } from "./util";

export interface ProbeHealth {
  configured: boolean;
  /** "unknown" until the first probe has run. */
  status: "healthy" | "degraded" | "unknown";
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  lastCheckedAt: number | null;
  lastError: string | null;
}

const EMPTY: ProbeHealth = {
  configured: false,
  status: "unknown",
  consecutiveFailures: 0,
  consecutiveSuccesses: 0,
  lastCheckedAt: null,
  lastError: null,
};

export async function getProbeHealth(env: Env): Promise<ProbeHealth> {
  const configured = graphConfigured(env) && Boolean(env.GRAPH_CANARY_MAILBOX);
  const saved = await getSetting(env, "probe");
  return { ...EMPTY, ...(saved ? (JSON.parse(saved) as ProbeHealth) : {}), configured };
}

/** Checks Entra ID and Exchange Online through Graph and updates the health counters. */
export async function runProbe(env: Env): Promise<ProbeHealth> {
  const health = await getProbeHealth(env);
  if (!health.configured) return health;

  let error: string | null = null;
  try {
    await probeMailbox(env, await getGraphToken(env));
  } catch (err) {
    error = (err as Error).message.slice(0, 300);
  }

  const threshold = intVar(env.PROBE_THRESHOLD, 3);
  health.lastCheckedAt = now();
  health.lastError = error;
  if (error) {
    health.consecutiveFailures++;
    health.consecutiveSuccesses = 0;
    if (health.consecutiveFailures >= threshold) health.status = "degraded";
  } else {
    health.consecutiveSuccesses++;
    health.consecutiveFailures = 0;
    if (health.consecutiveSuccesses >= threshold || health.status === "unknown") health.status = "healthy";
  }
  await setSetting(env, "probe", JSON.stringify(health));

  if (health.status === "degraded" && env.AUTO_FAILOVER === "true" && (await getState(env)) === "standby") {
    try {
      await activate(env, "system", `Automatic failover after ${health.consecutiveFailures} failed probes: ${error}`);
    } catch (err) {
      await audit(env, "system", "failover.auto_failed", (err as Error).message);
    }
  }
  return health;
}
