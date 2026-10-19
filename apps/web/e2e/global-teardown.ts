import type { FullConfig } from "@playwright/test";
import { execSync } from "node:child_process";
import path from "node:path";

const pnpmExecutable = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

/**
 * Stops the API this run STARTED.
 *
 * `E2E_USE_LIVE_STACK=1` means the operator already had a stack running and
 * asked the harness to reuse it — so the API is not ours to stop. Without this
 * guard the teardown SIGTERMs it anyway (`api:bg:stop` reads `.tmp/api-dev.pid`
 * and does not care who wrote it), which kills the dev server out from under
 * the person who started it. Observed 2026-08-07: consecutive live-stack runs
 * each took the API down mid-session, and the failures surfaced as unrelated
 * cascading e2e errors on the NEXT run rather than as anything pointing here.
 */
const globalTeardown = (_config: FullConfig): void => {
  if (process.env.E2E_USE_LIVE_STACK === "1") {
    return;
  }

  try {
    execSync(`${pnpmExecutable} api:bg:stop`, {
      stdio: "inherit",
      cwd: path.resolve(__dirname, "../../.."),
    });
  } catch {
    // Best effort: teardown should never fail the test run.
  }
};

export default globalTeardown;
