/**
 * The badge-tone vocabulary, as a LEAF module.
 *
 * ## Why it is not in `primitives.tsx` with the component that uses it
 *
 * The drift guard (`__tests__/badge-tone-drift.test.ts`) has to import this at
 * runtime, and `primitives.tsx` imports `tamagui`, which reaches for
 * `window.matchMedia` at module load. A pure token union should not need a
 * browser shim (or a Tamagui provider) to be compared against another pure
 * token union — so the vocabulary lives here and `primitives.tsx` re-exports
 * the type for its existing consumers. Same split as `tone.ts`.
 *
 * ## Not to be confused with `VerdictTone`
 *
 * `./tone`'s `VerdictTone` (`pass | fail`) is the FULL-BLEED VERDICT axis. This
 * is the BADGE OUTLINE axis, and its `warning` maps to `accent` — a value with
 * no legal foreground in either polarity. The two must never be merged; see
 * `tone.ts`'s docblock for what that would cost.
 */

export type BadgeTone = "neutral" | "success" | "warning" | "danger";

/**
 * Value-level twin of {@link BadgeTone}, for the drift guard.
 *
 * `@th/types`' `ScanStatusTone` is the same vocabulary, re-declared there
 * because `@th/types` must not depend on a React-Native package. Keeping the
 * two hand-maintained unions identical used to be enforced by a comment plus a
 * type assertion in `apps/scanner` — which `tsconfig.base.json` excludes, so
 * nothing ever checked it. `__tests__/badge-tone-drift.test.ts` now asserts SET
 * EQUALITY against `SCAN_STATUS_TONES` at runtime, in a suite CI executes. A
 * type cannot be compared at runtime; this array can.
 */
export const BADGE_TONES = [
  "neutral",
  "success",
  "warning",
  "danger",
] as const satisfies readonly BadgeTone[];

/**
 * The converse direction: adding a member to {@link BadgeTone} without adding
 * it to {@link BADGE_TONES} makes this annotation `false` and fails
 * `pnpm typecheck`.
 */
const _everyBadgeToneIsListed: [
  Exclude<BadgeTone, (typeof BADGE_TONES)[number]>,
] extends [never]
  ? true
  : false = true;
void _everyBadgeToneIsListed;
