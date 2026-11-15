import type { D1Migration } from "cloudflare:test";
import type { EnvironmentValues } from "../src/services";

// The bindings vitest.config.ts gives the test Worker, so that `env` from "cloudflare:test" is typed.
declare global {
  namespace Cloudflare {
    interface Env extends EnvironmentValues {
      DB: D1Database;
      MAIL: R2Bucket;
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
