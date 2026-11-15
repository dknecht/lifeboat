import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => ({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations("./migrations"),
          ADMIN_TOKEN: "test-admin-token",
          GRAPH_TENANT_ID: "tenant",
          GRAPH_CLIENT_ID: "client",
          GRAPH_CLIENT_SECRET: "secret",
          GRAPH_CANARY_MAILBOX: "canary@example.com",
        },
      },
    }),
  ],
  test: { setupFiles: ["./test/setup.ts"] },
}));
