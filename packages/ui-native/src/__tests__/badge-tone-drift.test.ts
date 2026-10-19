import { describe, expect, it } from "vitest";

// The REAL module, not a stub — see the alias note in `vitest.config.ts`.
import { SCAN_STATUS_TONES } from "@th/types/scan/ticket-status-copy";

// `../badge-tone`, not `../primitives`: the latter imports `tamagui`, which
// reaches for `window.matchMedia` at module load. A pure token comparison
// should not need a browser shim to run.
import { BADGE_TONES } from "../badge-tone";

/**
 * The `ScanStatusTone` ↔ `BadgeTone` drift guard, as something that actually
 * executes.
 *
 * ## Why this file exists
 *
 * `@th/types` declares `ScanStatusTone` and `@th/ui-native` declares
 * `BadgeTone`. They are the same vocabulary, re-declared because `@th/types`
 * must not depend on a React-Native package. The documented enforcement was a
 * comment pointing at "the consumer-side assignment `const tone: BadgeTone =
 * copy.tone`" in `apps/scanner` — and `tsconfig.base.json` ends with
 * `"apps/**"` in `exclude`, so `pnpm typecheck` never reads that file. The
 * guard could not fail. It was a gate that looks real.
 *
 * A runtime set comparison in a suite CI runs (`pnpm -F @th/ui-native exec
 * vitest --run`, ci.yml) can fail, and does.
 *
 * ## Why SET equality and not array equality
 *
 * Declaration order is not a contract — `@th/types` lists success-first,
 * `primitives.tsx` lists neutral-first — and pinning it would produce a test
 * that fails on a cosmetic reorder while still passing if someone dropped
 * `neutral` from one side and added `info` to the other. Membership is the
 * contract.
 *
 * The complementary direction (a member added to a UNION but not to its
 * value-level twin) is a compile error inside each package, where those files
 * ARE typechecked.
 */
describe("ScanStatusTone ↔ BadgeTone", () => {
  it("carries exactly the same set of tones on both sides", () => {
    expect([...BADGE_TONES].sort()).toEqual([...SCAN_STATUS_TONES].sort());
  });

  it("has no duplicate members on either side", () => {
    expect(new Set(BADGE_TONES).size).toBe(BADGE_TONES.length);
    expect(new Set(SCAN_STATUS_TONES).size).toBe(SCAN_STATUS_TONES.length);
  });

  it("still contains the four tones the scan surfaces render", () => {
    // A belt-and-braces floor: set equality alone would stay green if BOTH
    // sides were emptied or both renamed in the same commit.
    for (const tone of ["neutral", "success", "warning", "danger"]) {
      expect(BADGE_TONES).toContain(tone);
      expect(SCAN_STATUS_TONES).toContain(tone);
    }
  });
});
