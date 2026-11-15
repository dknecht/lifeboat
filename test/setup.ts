import { applyD1Migrations, env, reset, type D1Migration } from "cloudflare:test";
import { beforeEach } from "vitest";
import type { Env } from "../src/types";

// Every test starts from empty storage with the schema applied.
beforeEach(async () => {
  await reset();
  const bindings = env as unknown as Env & { TEST_MIGRATIONS: D1Migration[] };
  await applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS);
});
