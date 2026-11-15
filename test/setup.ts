import { applyD1Migrations, env, reset, type D1Migration } from "cloudflare:test";
import { beforeEach } from "vitest";
import { outbox } from "./helpers";

// Every test starts from empty storage with the schema applied.
beforeEach(async () => {
  await reset();
  outbox.sent = [];
  outbox.fail = false;
  const bindings = env as unknown as { DB: D1Database; TEST_MIGRATIONS: D1Migration[] };
  await applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS);
});
