import * as Effect from "effect/Effect";
import { activate } from "./failover";
import { getGraphToken, probeMailbox } from "./graph";
import { AppConfig } from "./services";
import { audit, getSetting, getState, setSetting } from "./settings";
import { now } from "./util";

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

export const getProbeHealth = Effect.gen(function* () {
  const config = yield* AppConfig;
  const saved = yield* getSetting("probe");
  return {
    ...EMPTY,
    ...(saved ? (JSON.parse(saved) as ProbeHealth) : {}),
    configured: Boolean(config.graph && config.canaryMailbox),
  } satisfies ProbeHealth;
});

/** Checks Entra ID and Exchange Online through Graph and updates the health counters. */
export const runProbe = Effect.gen(function* () {
  const config = yield* AppConfig;
  const health = yield* getProbeHealth;
  if (!health.configured) return health;

  const error = yield* getGraphToken.pipe(
    Effect.flatMap((token) => probeMailbox(token, config.canaryMailbox)),
    Effect.match({ onSuccess: () => null, onFailure: (e) => e.message.slice(0, 300) }),
  );

  health.lastCheckedAt = now();
  health.lastError = error;
  if (error) {
    health.consecutiveFailures++;
    health.consecutiveSuccesses = 0;
    if (health.consecutiveFailures >= config.probeThreshold) health.status = "degraded";
  } else {
    health.consecutiveSuccesses++;
    health.consecutiveFailures = 0;
    if (health.consecutiveSuccesses >= config.probeThreshold || health.status === "unknown") {
      health.status = "healthy";
    }
  }
  yield* setSetting("probe", JSON.stringify(health));

  if (health.status === "degraded" && config.autoFailover && (yield* getState) === "standby") {
    yield* activate(
      "system",
      `Automatic failover after ${health.consecutiveFailures} failed probes: ${error}`,
    ).pipe(Effect.catchTag("FailoverError", (e) => audit("system", "failover.auto_failed", e.message)));
  }
  return health;
});
