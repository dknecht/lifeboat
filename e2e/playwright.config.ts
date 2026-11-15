import { defineConfig, devices } from "@playwright/test";

const PORT = 1337;

/** The admin token the local server is started with, and the tests use to set up users. */
export const ADMIN_TOKEN = "e2e-admin-token";

/**
 * End-to-end tests for the web client. They start the whole stack locally through Alchemy, in its
 * own "e2e" stage so that they never touch the data of an ordinary `npm run dev`.
 */
export default defineConfig({
  testDir: ".",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: { baseURL: `http://localhost:${PORT}`, trace: "off" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1360, height: 860 } } }],
  webServer: {
    command: "npm run build:web && alchemy dev --stage e2e --no-input",
    cwd: "..",
    url: `http://localhost:${PORT}/api/status`,
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      LIFEBOAT_LOCAL_STATE: "1",
      MAIL_DOMAIN: "example.com",
      APP_URL: `http://localhost:${PORT}`,
      ADMIN_TOKEN,
    },
  },
});
