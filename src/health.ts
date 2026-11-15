import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { activate } from "./failover";
import { getGraphToken, probeMailbox } from "./graph";
import { AppConfig } from "./services";
import { audit, getSetting, getState, setSetting } from "./settings";
import { now } from "./util";

/** The probe counters as stored in the settings table. */
const ProbeRecord = Schema.Struct({
  /** "unknown" until the first probe has run. */
  status: Schema.Literals(["healthy", "degraded", "unknown"]),
  consecutiveFailures: Schema.Number,
  consecutiveSuccesses: Schema.Number,
  lastCheckedAt: Schema.NullOr(Schema.Number),
  lastError: Schema.NullOr(Schema.String),
});

type ProbeRecord = typeof ProbeRecord.Type;

export interface ProbeHealth extends ProbeRecord {
  /** Whether Graph credentials and a canary mailbox are set, so that probing can run at all. */
  readonly configured: boolean;
}

const NEVER_RUN: ProbeRecord = {
  status: "unknown",
  consecutiveFailures: 0,
  consecutiveSuccesses: 0,
  lastCheckedAt: null,
  lastError: null,
};

const decodeRecord = Schema.decodeUnknownOption(Schema.fromJsonString(ProbeRecord));

export const getProbeHealth = Effect.gen(function* () {
  const config = yield* AppConfig;
  const saved = yield* getSetting("probe");
  const record = Option.getOrElse(decodeRecord(saved), () => NEVER_RUN);
  const health: ProbeHealth = { ...record, configured: Boolean(config.graph && config.canaryMailbox) };

  return health;
});

/** Applies one probe result to the counters. Status changes only after `threshold` consecutive results. */
export function nextRecord(previous: ProbeRecord, error: string | null, threshold: number): ProbeRecord {
  if (error) {
    const failures = previous.consecutiveFailures + 1;

    return {
      status: failures >= threshold ? "degraded" : previous.status,
      consecutiveFailures: failures,
      consecutiveSuccesses: 0,
      lastCheckedAt: now(),
      lastError: error,
    };
  }

  const successes = previous.consecutiveSuccesses + 1;

  return {
    status: successes >= threshold || previous.status === "unknown" ? "healthy" : previous.status,
    consecutiveFailures: 0,
    consecutiveSuccesses: successes,
    lastCheckedAt: now(),
    lastError: null,
  };
}

/** Checks Entra ID and Exchange Online through Graph and updates the health counters. */
export const runProbe = Effect.gen(function* () {
  const config = yield* AppConfig;
  const previous = yield* getProbeHealth;

  if (!previous.configured) return previous;

  const error = yield* getGraphToken.pipe(
    Effect.flatMap((token) => probeMailbox(token, config.canaryMailbox)),
    Effect.match({ onSuccess: () => null, onFailure: (e) => e.message.slice(0, 300) }),
  );

  const record = nextRecord(previous, error, config.probeThreshold);

  yield* setSetting("probe", JSON.stringify(record));

  if (record.status === "degraded" && config.autoFailover && (yield* getState) === "standby") {
    yield* activate(
      "system",
      `Automatic failover after ${record.consecutiveFailures} failed probes: ${error}`,
    ).pipe(Effect.catchTag("FailoverError", (e) => audit("system", "failover.auto_failed", e.message)));
  }

  const health: ProbeHealth = { ...record, configured: true };

  return health;
});
