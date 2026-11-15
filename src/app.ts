/**
 * The application's three entry points, independent of the platform that invokes them.
 * The Worker shell (worker.ts) and the tests both run these against a layer of services.
 */
import * as Effect from "effect/Effect";
import { handleApi } from "./api";
import { runProbe } from "./health";
import { handleInbound } from "./inbound";
import { getState } from "./settings";
import { finishRecoveryIfDrained, retentionSweep, runSyncBatch } from "./sync";

export { handleApi as handleRequest, handleInbound };

/** The periodic job: probe Microsoft 365, drain sync-back while recovering, and apply retention. */
export const handleScheduled = Effect.gen(function* () {
  yield* runProbe;
  if ((yield* getState) === "recovering") {
    yield* runSyncBatch(20);
    yield* finishRecoveryIfDrained;
  }
  yield* retentionSweep();
});
