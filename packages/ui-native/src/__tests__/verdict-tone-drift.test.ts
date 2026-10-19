import { describe, expect, it } from "vitest";

// The REAL module, not a stub — see the alias note in `vitest.config.ts`.
import {
  SCAN_VERDICTS,
  SCAN_VERDICT_KEYS,
  VERDICT_TONES as SHARED_VERDICT_TONES,
} from "@th/types/scan/verdict";

// `../tone`, not `../index`: the barrel pulls the component layer, which pulls
// `tamagui`, which reaches for `window.matchMedia` at module load. A pure token
// comparison should not need a browser shim to run.
import { TONE_FILL_TOKENS, VERDICT_TONES } from "../tone";

/**
 * The `VerdictTone` drift guard, as something that actually executes.
 *
 * `@th/types` declares the tone vocabulary (it is shared with the web scan
 * page) and this package re-declares it, because a React-Native design-system
 * package must not acquire `@th/types`' `zod` + `luxon` dependency edge. That
 * re-declaration is only safe if something compares the two at runtime.
 *
 * It is the same arrangement — and the same lesson — as
 * `badge-tone-drift.test.ts`: the previous "guard" for `ScanStatusTone` ↔
 * `BadgeTone` was a comment pointing at a type assertion inside `apps/scanner`,
 * a directory `tsconfig.base.json` excludes. A gate in a directory the
 * typechecker never visits is a phantom gate.
 */
describe("VerdictTone ↔ @th/types VERDICT_TONES", () => {
  it("declares the identical tone set", () => {
    expect([...VERDICT_TONES].sort()).toEqual([...SHARED_VERDICT_TONES].sort());
  });

  it("gives every shared tone a token pair, and no extras", () => {
    // The failure this catches: a tone added to the shared map with no fill
    // pair here resolves to `undefined` on both sides, and React Native treats
    // that as "no colour" — so the verdict paints TRANSPARENT over the camera
    // feed with an unstyled foreground. It does not throw; it ships looking
    // like a layout bug.
    expect(Object.keys(TONE_FILL_TOKENS).sort()).toEqual(
      [...SHARED_VERDICT_TONES].sort(),
    );
  });

  it("covers every tone the shared verdict map actually emits", () => {
    // Belt and braces: the map, not just the union. A verdict whose tone has no
    // pair is the same transparent-fill defect, reached from the other side.
    for (const key of SCAN_VERDICT_KEYS) {
      const tone = SCAN_VERDICTS[key].tone;
      expect(TONE_FILL_TOKENS[tone], `${key} → ${tone}`).toBeDefined();
    }
  });
});
