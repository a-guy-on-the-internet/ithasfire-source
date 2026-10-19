import { defineConfig } from "@playwright/test";

export default defineConfig({
  // Queue for the machine-wide HEAVY slot (scripts/dev/gate).
  globalSetup: "../../scripts/dev/gate/playwright-global-setup.mjs",
  testDir: "./src/storybook/__e2e__",
  timeout: 60_000,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  use: {
    headless: true,
    viewport: { width: 1200, height: 800 },
  },
});
