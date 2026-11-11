import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30000,
  expect: { timeout: 10000 },
  use: {
    actionTimeout: 10000,
    navigationTimeout: 15000,
    baseURL: "http://127.0.0.1:4195",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node scripts/e2e-server.mjs",
    url: "http://127.0.0.1:4195/health/ready",
    reuseExistingServer: false,
    timeout: 120000,
  },
  reporter: [["list"], ["html", { open: "never" }]],
});
