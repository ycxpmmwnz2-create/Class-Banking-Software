// Playwright configuration for the Phase 2B Item 10 browser isolation suite.
//
// Serves the real index.html through tests/browser/vite.phase2b.config.js, which
// injects the harness module ahead of the application's inline module.
//
// The Vite port is fixed with strictPort so a stray dev server cannot silently
// shift it, and is distinct from the emulator ports declared in firebase.json
// (Auth 9099, Functions 5001, Firestore 8080).

import { defineConfig, devices } from "@playwright/test";

export const BROWSER_TEST_PORT = 5273;

export default defineConfig({
  testDir: "tests/browser",
  testMatch: /.*\.spec\.js$/,

  // Cross-tab specs coordinate two pages in one context and poll for quiescence;
  // running files in parallel against one shared emulator would let fixtures
  // from different specs overwrite each other.
  fullyParallel: false,
  workers: 1,

  forbidOnly: true,
  retries: 0,
  reporter: [["list"]],

  timeout: 60_000,
  expect: { timeout: 15_000 },

  use: {
    baseURL: `http://127.0.0.1:${BROWSER_TEST_PORT}`,
    trace: "retain-on-failure",
    video: "off"
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    },
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"] }
    }
  ],

  webServer: {
    command: `npx vite --config tests/browser/vite.phase2b.config.js --port ${BROWSER_TEST_PORT} --strictPort`,
    url: `http://127.0.0.1:${BROWSER_TEST_PORT}`,
    reuseExistingServer: false,
    timeout: 60_000
  }
});
