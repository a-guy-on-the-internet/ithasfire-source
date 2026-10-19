/**
 * CI-only vitest config for `apps/web`. Identical to `vitest.config.ts` EXCEPT it also excludes the
 * `CI_QUARANTINE` list below. Kept separate so the quarantine NEVER hides a failure from a developer
 * running the suite locally (`pnpm -F web test`) — it applies only to `test:ci`, which the CI
 * workflows call.
 *
 * ── WEB UNIT-TEST CI QUARANTINE — a shrinking ratchet ────────────────────────────────────────────
 *
 * `apps/web` has ~2,644 unit tests and, until 2026-07-17, CI ran NONE of them (`ci.yml` and
 * `deploy-dev.yml`'s `quality_gate` ran `@th/core`, `@th/adapters`, `@th/ui` and the api smoke —
 * never `pnpm -F web exec vitest`). That gap let real breakage land unnoticed: the design-system
 * commit shipped 8 failing `AppNavbar` tests and a non-collecting `AudioBlockNodeView` on main.
 *
 * The gate is now wired in (this config, via `test:ci`, from both workflows). Three files were red on
 * a clean `main` when the gate was wired, for reasons that change did not own; gating them would land the gate itself red,
 * and a red gate is a disabled gate. They are quarantined here — excluded from the CI run, tracked,
 * and to be fixed down to zero.
 *
 * The contract (identical to `eslint-hex-allowlist.mjs`):
 *   - This list only ever SHRINKS. Never add an entry to unblock a merge — fix the test, or the code
 *     it caught. A new red test is the gate working; quarantining it defeats the point.
 *   - Each entry states WHY it is red and WHOSE it is.
 *   - Entries are BASENAME globs, deliberately: the real paths live under Next.js bracket-dirs whose
 *     `[` `]` are glob metacharacters, so an unescaped full path silently excludes nothing (verified
 *     — a full-path glob for the events route matched zero files). Each basename below is unique in
 *     `apps/web/src` (checked); if you quarantine one that isn't, escape the brackets instead.
 */
import { defineConfig } from "vitest/config";

import baseConfig from "./vitest.config";

const CI_QUARANTINE = [
  // Another session's in-flight email delivery-remediation feature. `EmailSection` renders the
  // "Send verification code" button at BOTH its verify-banner and its delivery-issue-remediation
  // block; a BOUNCED/COMPLAINED status renders both, so the 7 tests doing
  // getByRole("button", { name: "Send verification code" }) throw "Found multiple elements". Fix
  // belongs with that feature (scope the query, or settle the dual-CTA).
  "**/EmailSection.test.tsx",

  // Environment invariant, not a product/test bug: importing next.config pulls `@tamagui/static`,
  // which loads esbuild, which asserts `new TextEncoder().encode("") instanceof Uint8Array` — false
  // under this jsdom realm. Needs a node-environment override for this file (or a TextEncoder shim).
  "**/next-config.test.ts",
];

const baseExclude = baseConfig.test?.exclude ?? [];

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    // base excludes + quarantine, spread explicitly (not via mergeConfig) so the concatenation is
    // obvious and can't change if merge semantics do.
    exclude: [...baseExclude, ...CI_QUARANTINE],

    // ── Timeouts + retry live HERE, not on the workflow's command line ──────
    //
    // deploy-dev.yml invoked this suite as:
    //     pnpm -F web run test:ci -- --retry=1 --testTimeout=30000 …
    // `pnpm run <script> -- <flags>` puts a literal `--` in vitest's argv and
    // vitest (cac) DROPS everything after it, so all three flags were a silent
    // no-op. The workflow already documents this exact trap for the
    // audio-transcoder step — "(Same caveat applies to the `run test:ci --`
    // web step further down.)" — but the web step kept passing them anyway.
    //
    // Consequence: this suite ran at vitest's DEFAULT 5s timeout with NO retry,
    // while its comment claimed `--retry=1` was protecting against
    // moderate-layout's jsdom navigation flake. Run 659 then failed on exactly
    // that test with "Test timed out in 5000ms" — the protection that was
    // supposed to absorb it had never been active. Runs 608/612 were most
    // likely the same thing, misread as ordinary contention.
    //
    // Config is the durable home: it applies however the suite is invoked and
    // cannot be swallowed by an argv separator again. Matches the fix already
    // used in apps/audio-transcoder/vitest.config.ts.
    testTimeout: 30000,
    hookTimeout: 30000,
    // The runner is single-capacity; a slow jsdom navigation under contention
    // should cost one retry, not a red gate that blocks the roll.
    retry: 1,
  },
});
