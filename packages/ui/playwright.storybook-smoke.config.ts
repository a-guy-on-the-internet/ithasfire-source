import { defineConfig } from "@playwright/test";

export default defineConfig({
  // Queue for the machine-wide HEAVY slot (scripts/dev/gate).
  globalSetup: "../../scripts/dev/gate/playwright-global-setup.mjs",
  testDir: "./scripts",
  testMatch: ["**/*.spec.ts"],
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  use: {
    headless: true,
    baseURL: "http://127.0.0.1:6006",
  },
  reporter: process.env.CI ? [["github"], ["line"]] : [["line"]],
});
