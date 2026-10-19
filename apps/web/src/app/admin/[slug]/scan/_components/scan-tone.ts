/**
 * Verdict TONES — the two fills a door operator can be shown, and the token
 * pair each one paints with.
 *
 * PURE — no React, no Tamagui. The contrast guard
 * (`__tests__/scan-tone-contrast.test.ts`) imports {@link TONE_FILL_TOKENS} and
 * measures the pairs this file actually ships, rather than a hand-transcribed
 * list that can drift from it. A guard that reads a copy of the mapping guards
 * a copy.
 *
 * ## Why there are two and not four
 *
 * This was a FOUR-family system (ADMIT / ALREADY IN / REDIRECT / STOP) painted
 * in green, amber, ink and red. The Ithas Fire Design System specifies **two** —
 * `pass` and `fail` — with the *word* carrying the instruction (DECISIONS.md
 * D-123, `components/tickets/ScanResult.jsx`). We conformed. Green and red were
 * never in this brand's palette; flame and amber are.
 *
 * The outcomes did not collapse with the tones. Separating **state** ("Already
 * used") from **word** ("STOP") is what lets two fills carry nineteen outcomes —
 * see `@th/types`' `SCAN_VERDICTS`, the shared map BOTH scan surfaces render
 * from (NFR-007). {@link VerdictTone} itself is imported from there rather than
 * re-declared: this package already depends on `@th/types`, so there is no
 * reason for a fifth copy.
 *
 * ## Why the tokens and not the colours
 *
 * `@th/ui-native`'s `TONE_FILL_TOKENS` is the native twin of the map below. It
 * cannot be imported here (it is a React-Native package and would pull RN into
 * the web bundle), so the two declare the same two tones against the same two
 * token NAMES, which hold identical values in both palettes. The web resolves
 * them through the Tamagui theme; native resolves them through its palette.
 *
 * Measured on the real theme objects:
 *
 *   - PASS = `support` + `onSupport`         → swiss **8.27:1**, ember
 *     **7.98:1**, stub **7.87:1**.
 *   - FAIL = `verdictFail` + `onVerdictFail` → **5.92:1** on every theme.
 *
 * FAIL is deliberately a PINNED pair rather than a themed brand token. Every
 * themed candidate was measured and none survives all three themes:
 * `brandSecondaryHover` is #E84B19 on swiss/ember (the small state line fails
 * there), `brandSecondary` is #E2481D on stub (4.06:1), and `accentHard` is
 * navy #2A4578 on swiss/ember (1.88:1). `$accent` may never be a verdict fill
 * at all — it has no legal foreground in EITHER polarity. Pinning also keeps
 * the two fills 2.75:1 apart on every theme and matches the value the native
 * scanner pins, so both surfaces speak one colour. See
 * `packages/ui/src/ui/tamagui/tokens/colors.ts`.
 *
 * ## Why not `Tone` (`success | warning | danger | neutral`)
 *
 * That is a BADGE-OUTLINE vocabulary. Its `warning` maps to `$warning`, which
 * as a full-bleed fill has no legal foreground in either polarity. Overloading
 * it for verdict fills would silently produce an unreadable verdict, and
 * nothing in the type system would object. The two axes stay separate.
 */
import { VERDICT_TONES, type VerdictTone } from "@th/types";
import { stubTheme, type ThemeTokenKey } from "@th/ui/colors";

export { VERDICT_TONES };
export type { VerdictTone };

export type TonePair = {
  /** Full-bleed fill token. */
  fill: ThemeTokenKey;
  /**
   * The ONLY foreground token legal on `fill`, and never alpha-muted.
   *
   * The DS's own `.if-verdict__state` carries `opacity: .85`; we drop it. On
   * the FAIL pair it measures **4.67:1** (versus 5.92:1 at full opacity) —
   * over AA by only 0.17 — and an alpha foreground on a tone fill is the bug
   * class this surface already shipped once (70% white on the old green fill
   * was 4.40:1 and missed AA by a tenth, which nobody catches by eye).
   * Hierarchy here comes from size and weight only. Measured in
   * `__tests__/scan-tone-contrast.test.ts`.
   */
  on: ThemeTokenKey;
};

/**
 * Tone → token pair. The single place the mapping exists.
 *
 * PASS is the LIGHT fill (`support` luminance 0.439 against `verdictFail`'s
 * 0.127) and that is load-bearing: in a dark room at arm's length "the bright
 * one" is already a decision, before hue, before glyph, before reading. The
 * contrast guard asserts both the ordering and the 2.75:1 gap.
 */
export const TONE_FILL_TOKENS: Record<VerdictTone, TonePair> = {
  pass: { fill: "support", on: "onSupport" },
  fail: { fill: "verdictFail", on: "onVerdictFail" },
};

/** Tamagui theme reference, e.g. `$onVerdictFail`. */
export const toneToken = (token: ThemeTokenKey): string => `$${token}`;

/**
 * CSS custom-property reference for the places Tamagui cannot reach — lucide
 * `color=` and inline styles.
 *
 * The fallback is read out of `stubTheme` rather than typed as a literal: Stub
 * is the shipped default and the fallback is what SSR / first paint renders, so
 * a transcribed (or Ember) hex here would be a first-paint flash of the wrong
 * colour. Reading the token means it cannot drift.
 */
export const toneVar = (token: ThemeTokenKey): string =>
  `var(--${token}, ${stubTheme[token]})`;
