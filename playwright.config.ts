import { defineConfig, devices } from "@playwright/test";
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local", quiet: true });

const PORT = 3200;
export const E2E_SETUP_TOKEN = "e2e-setup-token-0123456789";

/**
 * E2E tests run the PRODUCTION build (`npm run build` first) against the test database, so the
 * real service worker, offline shell and IndexedDB encryption are exercised.
 */
export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  globalSetup: "./tests/e2e/global-setup.ts",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    serviceWorkers: "allow",
  },
  projects: [
    { name: "mobile-chromium", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: `npx next start -p ${PORT}`,
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? "",
      APP_URL: `http://localhost:${PORT}`,
      SETUP_TOKEN: E2E_SETUP_TOKEN,
      APP_ENCRYPTION_KEY: process.env.APP_ENCRYPTION_KEY ?? "",
      LOG_LEVEL: "warn",
    },
  },
});
