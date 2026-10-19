import path from "node:path";
import { defineConfig } from "vitest/config";

import { buildVitestAliasEntries } from "./config/aliases";

const aliasEntries = buildVitestAliasEntries(__dirname);
const isCI = process.env.CI === "true" || process.env.CI === "1";

export default defineConfig({
  css: {
    postcss: {
      plugins: [],
    },
  },
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "react",
  },
  resolve: {
    alias: aliasEntries,
  },
  test: {
    // Queue for a machine-wide light slot (scripts/dev/gate); watch mode takes none.
    // Absolute: a relative entry resolves against vitest's root (cwd), not this file.
    globalSetup: [path.resolve(__dirname, "../../scripts/dev/gate/vitest-global-setup.mjs")],
    // ~20 sessions share one machine: cap local runs at 4 workers (CI uncapped).
    ...(isCI ? {} : { maxWorkers: 4, minWorkers: 1 }),
    environment: "jsdom",
    environmentMatchGlobs: [["src/server/**", "node"]],
    // Tests that pin a timezone by assigning `process.env.TZ` at runtime MUST
    // run in a forked process. In a worker thread the assignment changes the
    // env var but not the zone V8 formats in, so the pin silently no-ops: the
    // test passes on a machine already in that zone and fails on a UTC CI
    // runner (measured 2026-09-28: 5 failed under threads, 17 passed under
    // forks, both with TZ=UTC). Add any new zone-pinning test file here.
    poolMatchGlobs: [
      ["**/src/components/bookings/__tests__/booking-holds.test.ts", "forks"],
      ["**/src/app/embed/*/_components/embed-helpers.timezone.test.ts", "forks"],
      ["**/src/app/_components/home/__tests__/saved-strip-date.test.ts", "forks"],
      ["**/src/app/events/category/*/_components/__tests__/lineup-when.test.ts", "forks"],
    ],
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    include: [
      "src/**/*.{test,spec}.{ts,tsx}",
      "src/**/__tests__/**/*.{ts,tsx}",
      // e2e HELPERS only — never `e2e/*.spec.ts`, which are Playwright's.
      // Without this the helper tests exist but are collected by nothing.
      "e2e/helpers/**/__tests__/**/*.{ts,tsx}",
    ],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.{idea,git,cache,output,temp}/**",
      "**/*.{disabled,skip}.ts",
      "**/*.{disabled,skip}.tsx",
      "**/*.stub.{ts,tsx}",
      "**/*.test-stub.{ts,tsx}",
    ],
  },
});
