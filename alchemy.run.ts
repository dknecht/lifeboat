/**
 * Lifeboat's deployment stack, defined with Alchemy (https://alchemy.run).
 *
 *   npm run dev       run everything locally, no Cloudflare account needed
 *   npm run deploy    create or update the D1 database, R2 bucket, and Worker
 *
 * The resources and their bindings are declared next to the code that uses them, in src/worker.ts.
 * Configuration comes from the process environment or a .env file; see .env.example.
 */
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import Worker from "./src/worker.ts";

// Deploys keep their state in Cloudflare so that any machine or CI job can update the stack.
// Local development uses a state file under .alchemy/ and needs no Cloudflare account.
const localState = process.env.LIFEBOAT_LOCAL_STATE === "1";

export default Alchemy.Stack(
  "Lifeboat",
  {
    providers: Cloudflare.providers(),
    state: localState ? Alchemy.localState() : Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* Worker;
    return { url: worker.url, workerName: worker.workerName };
  }),
);
