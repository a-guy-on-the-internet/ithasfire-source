// Playwright globalSetup: every playwright run waits for the HEAVY gate slot
// (see ./gate.mjs), held by the runner process until global teardown (the
// returned function) or process exit.
//
// Playwright starts `webServer` entries BEFORE globalSetup, so the apps/web
// scripts (test:e2e*, root e2e / smoke:pages) take the slot first through
// with-gate.mjs / run.mjs and this setup then re-enters. For a bare
// `playwright test` this is the fallback: a self-booted stack boots ungated and
// only the test phase queues (E2E_USE_LIVE_STACK=1 webServers only probe).
// Never gate the webServer command itself: it is long-lived. UI mode takes no
// slot (see isUiMode), and `test:e2e:ui` is deliberately not wrapped.

import { acquire } from "./gate.mjs";

/** UI mode (`--ui`, or `--ui-port` / `--ui-host`, which imply it) is an
 * interactive session that can stay open for hours: like vitest watch mode, it
 * takes no slot. */
export function isUiMode(argv = process.argv) {
  return argv.some((a) => a === "--ui" || a.startsWith("--ui=") || a.startsWith("--ui-port") || a.startsWith("--ui-host"));
}

export default async function globalSetup() {
  if (isUiMode()) return undefined;
  const lease = await acquire("heavy", {
    label: `playwright ${process.argv.slice(2).join(" ")}`.trim(),
  });
  if (lease.held) process.env.GATE_LOCK_HELD = String(process.pid);
  return async () => lease.release();
}
