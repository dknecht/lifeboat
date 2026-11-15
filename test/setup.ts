import { applyD1Migrations, env, reset } from "cloudflare:test";
import { beforeEach } from "vitest";
import { outbox } from "./helpers";

// Every test starts from empty storage with the schema applied.
beforeEach(async () => {
  await reset();
  outbox.sent = [];
  outbox.fail = false;
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
