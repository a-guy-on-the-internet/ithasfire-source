/**
 * Verdict TONES — the two fills a door operator can be shown.
 *
 * Pure: no React, no react-native, no tamagui. That is deliberate — the
 * contrast guard (`apps/scanner/src/__tests__/tone-contrast.test.ts`) imports
 * {@link TONE_FILL_TOKENS} and checks the pairs the app actually renders,
 * rather than a hand-transcribed list that can drift from it. A guard that
 * reads a copy of the mapping guards a copy.
 *
 * ## Why there are two and not four
 *
 * This was a FOUR-family system (ADMIT / ALREADY IN / REDIRECT / STOP). The
 * Ithas Fire Design System specifies **two** — `pass` and `fail` — with the
 * *word* carrying the instruction (DECISIONS.md D-123,
 * `components/tickets/ScanResult.jsx`). We conformed. Green and red were never
 * in this brand's palette; flame and amber are.
 *
 * The outcomes did not collapse with the tones. Separating **state** ("Already
 * used") from **word** ("STOP") is what lets two fills carry nineteen verdict keys —
 * see `@th/types`' `SCAN_VERDICTS`, which is the shared map both the native
 * scanner and the web scan page render from.
 *
 * ## The tokens
 *
 * Measured on the real palettes:
 *
 *   - PASS = `support` + `onSupport`         → **7.98:1** Ember, **7.87:1** Stub.
 *   - FAIL = `verdictFail` + `onVerdictFail` → **5.92:1** in both.
 *
 * Both pairs are THEME-INVARIANT, and FAIL is deliberately NOT the themed
 * `ctaFill`. Using `ctaFill` would put amber #F59E0B against Ember's orange
 * #FF5721 at **1.47:1** — two verdicts that are the same colour at a glance, in
 * the dark-venue theme, which is the one condition the whole surface exists
 * for. Pinned to flame-600 the two fills sit **2.76:1 apart in both themes**
 * (1.87× better on Ember) and the word reads at 5.92:1 rather than 5.61:1. The
 * DS agrees: it has a single `--color-accent-fill`, not a per-theme fill.
 * `apps/scanner/src/__tests__/tone-contrast.test.ts` asserts the separation, so
 * "simplifying" this back to `ctaFill` fails a gate rather than shipping.
 *
 * Callers still name a {@link VerdictTone} and never a colour. The pair is what
 * is measured, and reading one side without the other is how a foreground ends
 * up on the wrong fill — see the crossed-pair negatives in the guard.
 *
 * Net token count: the four the old four-family system needed (`successFill` /
 * `onSuccessFill` / `dangerFill` / `onDangerFill`) are gone from `./palette`;
 * two replace them.
 *
 * ## Why this is NOT `BadgeTone`
 *
 * `BadgeTone` (`./badge-tone`) is `neutral | success | warning | danger` — a
 * *badge outline* vocabulary, and its `warning` maps to `accent`. `accent` is
 * not a verdict fill and has **no legal foreground in either polarity** (white
 * 3.16:1 Ember / 4.06:1 Stub; ink 3.16:1 / 4.17:1 — see the palette docblock).
 * Overloading `BadgeTone` for a full-bleed fill would produce an accent-filled
 * verdict whose label cannot be made readable, and nothing in the type system
 * would object. The two axes stay separate.
 */
import type { ColorToken, NativePalette } from "./palette";

/**
 * The two verdict tones.
 *
 * Re-declared rather than imported from `@th/types`, for the same reason
 * `./badge-tone` re-declares `BadgeTone`: this package must not acquire a
 * dependency edge on `@th/types`, whose barrel pulls `zod` and `luxon` into a
 * React-Native design-system package. The enforcement is a RUNTIME set-equality
 * assertion against `@th/types`' `VERDICT_TONES` in
 * `__tests__/verdict-tone-drift.test.ts` — a suite `pnpm -F @th/ui-native exec
 * vitest --run` executes. A type alone cannot be compared at runtime, which is
 * why {@link VERDICT_TONES} below has a value-level twin.
 */
export type VerdictTone = "pass" | "fail";

/** Value-level twin of {@link VerdictTone}, for the drift guard. */
export const VERDICT_TONES = [
  "pass",
  "fail",
] as const satisfies readonly VerdictTone[];

/**
 * The converse direction: adding a member to {@link VerdictTone} without adding
 * it to {@link VERDICT_TONES} makes this annotation `false` and fails
 * `pnpm typecheck`.
 */
const _everyVerdictToneIsListed: [
  Exclude<VerdictTone, (typeof VERDICT_TONES)[number]>,
] extends [never]
  ? true
  : false = true;
void _everyVerdictToneIsListed;

export type TonePair = {
  /** Full-bleed fill token. */
  fill: ColorToken;
  /**
   * The ONLY foreground token legal on `fill`. Never alpha-muted.
   *
   * The DS's own `.if-verdict__state` carries `opacity: .85`; we drop it. It
   * would technically measure 4.67–6.19 on these palettes, but an alpha
   * foreground on a tone fill is the bug class this surface already shipped
   * once (70% white on the old green fill measured 4.40:1 and missed AA by a
   * tenth — nobody catches that by eye). Full opacity costs nothing and removes
   * the question. Hierarchy here comes from size and weight.
   */
  on: ColorToken;
};

/**
 * Tone → token pair. The single place the mapping exists.
 *
 * PASS is the LIGHT fill (`support` luminance 0.439 against `verdictFail`'s
 * 0.127) and that is load-bearing: in a dark room at arm's length "the bright
 * one" is already a decision, before hue, before glyph, before reading. The
 * contrast guard asserts both the ordering and the 2.76:1 gap.
 */
export const TONE_FILL_TOKENS: Record<VerdictTone, TonePair> = {
  pass: { fill: "support", on: "onSupport" },
  fail: { fill: "verdictFail", on: "onVerdictFail" },
};

export type ToneColors = {
  fill: string;
  on: string;
};

/** Resolve a tone against the ACTIVE palette. */
export const toneColors = (
  colors: NativePalette,
  tone: VerdictTone,
): ToneColors => {
  const pair = TONE_FILL_TOKENS[tone];
  return { fill: colors[pair.fill], on: colors[pair.on] };
};
