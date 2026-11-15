import { api } from "./api";
import { getState } from "./db";
import { runProbe } from "./health";
import { handleInbound, type InboundEmail } from "./inbound";
import { finishRecoveryIfDrained, retentionSweep, runSyncBatch } from "./sync";
import type { Env } from "./types";

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    return api.fetch(request, env, ctx);
  },

  async email(message: InboundEmail, env: Env): Promise<void> {
    const result = await handleInbound(message, env);
    console.log("inbound", result.status, result.id ?? "", message.to);
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await runProbe(env);
    if ((await getState(env)) === "recovering") {
      await runSyncBatch(env, 20);
      await finishRecoveryIfDrained(env);
    }
    await retentionSweep(env);
  },
};
