import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Tests run the Worker's modules inside the Workers runtime with local D1 and R2.
// The bindings mirror the ones alchemy.run.ts declares for the deployed Worker.
export default defineConfig(async () => ({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2026-11-01",
        d1Databases: ["DB"],
        r2Buckets: ["MAIL"],
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations("./migrations"),
          MAIL_DOMAIN: "example.com",
          APP_URL: "https://lifeboat.test",
          DNS_MODE: "manual",
          UNKNOWN_RECIPIENT: "hold",
          AUTO_FAILOVER: "false",
          PROBE_THRESHOLD: "3",
          RETENTION_DAYS: "30",
          CF_ZONE_ID: "",
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
