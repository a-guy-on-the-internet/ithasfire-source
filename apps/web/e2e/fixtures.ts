/**
 * Custom Playwright fixtures that auto-check for console errors.
 *
 * Every test that imports `test` from this module gets:
 * 1. A console error collector attached before each test.
 * 2. An automatic assertion at the end of every test that zero console errors
 *    appeared (after the test's own assertions pass).
 *
 * This means every button click, form fill, filter toggle, and navigation in
 * the entire E2E suite doubles as a console error regression check without
 * any per-test wiring.
 *
 * Usage in spec files — change only the import:
 * ```ts
 * // Before:
 * import { expect, test } from "@playwright/test";
 * // After:
 * import { expect, test } from "./fixtures";
 * ```
 *
 * Specs that intentionally expect console errors can opt out:
 * ```ts
 * test("fires expected error", async ({ page, consoleErrors }) => {
 *   // ... do something that triggers a known error ...
 *   consoleErrors.ignore(); // skip the auto-assertion for this test
 * });
 * ```
 */
import { test as base, expect } from "@playwright/test";
import {
  collectConsoleErrors,
  type ConsoleErrorCollector,
} from "./helpers/console-errors";

// ── Extended fixtures ────────────────────────────────────────────────────

type ConsoleErrorHandle = ConsoleErrorCollector & {
  /**
   * Call this inside a test to skip the automatic "zero console errors"
   * assertion. Useful for tests that intentionally trigger errors.
   */
  ignore: () => void;
};

export const test = base.extend<{ consoleErrors: ConsoleErrorHandle }>({
  consoleErrors: [
    async ({ page }, use, testInfo) => {
      const collector = collectConsoleErrors(page);
      let shouldAssert = true;

      const handle: ConsoleErrorHandle = {
        ...collector,
        ignore: () => {
          shouldAssert = false;
        },
      };

      // Hand the collector to the test so it can call .ignore() if needed.
      await use(handle);

      // After the test body completes, check for console errors.
      // Only assert if:
      //   1. The test itself passed (don't pile a console assertion onto
      //      an already-failing test — that's noise, not signal).
      //   2. The test didn't call consoleErrors.ignore().
      collector.detach();

      if (shouldAssert && testInfo.status === testInfo.expectedStatus) {
        const errors = collector.errors();
        if (errors.length > 0) {
          const formatted = errors.map((e, i) => `  ${i + 1}. ${e}`).join("\n");

          // Attach errors to the test report for debugging.
          await testInfo.attach("console-errors", {
            body: formatted,
            contentType: "text/plain",
          });

          // Fail the test.
          expect(
            errors,
            `Console errors detected during "${testInfo.title}":\n${formatted}`,
          ).toHaveLength(0);
        }
      }
    },
    { auto: true },
  ],
});

// Re-export everything else from Playwright so specs only need one import.
export { expect } from "@playwright/test";
export type { Page, APIRequestContext } from "@playwright/test";
