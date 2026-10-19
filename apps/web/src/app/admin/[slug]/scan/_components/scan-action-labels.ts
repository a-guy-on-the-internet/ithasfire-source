/**
 * FR-013 — the action row's labels, and the width they have to survive.
 *
 * PURE. Exists because a label was observed clipped to **"DISMISS AND …"** at
 * 320×640 — on the one control the operator most needs to read, at the one
 * width where they are most likely to be standing in a doorway holding a phone.
 *
 * ## Why the labels are short rather than responsive or wrapping
 *
 * Three fixes were possible and two of them are traps:
 *
 * - **Wrapping.** Tamagui's `ButtonText` ships `ellipse: true`
 *   (`@tamagui/button` — `white-space: nowrap; text-overflow: ellipsis`), which
 *   is *why* it clipped. But turning that off does not help: `@th/ui`'s Button
 *   sets a FIXED `height` per size (`$4` → 44px), so a second line would
 *   overflow the frame rather than grow it. Wrapping trades a clipped word for a
 *   clipped line.
 * - **Responsive labels.** A `useMedia()` swap needs `matchMedia`, which the
 *   jsdom setup stubs to `matches: false` for every query — so the narrow branch
 *   would be untestable, and this repo has already been bitten by media-query
 *   ORDER (`$sm` beating `$xs`). It also forks the accessible name by viewport.
 * - **Shorter labels.** No machinery, no media queries, one accessible name,
 *   and it is the better copy anyway: "DISMISS AND SCAN NEXT" spends its first
 *   two words — the only two an operator reads on a button — narrating the
 *   mechanism instead of the outcome. "SCAN NEXT" is what they are doing.
 *   Likewise "CHECK IN VOLUNTEER" repeats the word VOLUNTEER, which the verdict
 *   already carries on its state line.
 *
 * This is a deliberate divergence from the native rail's `DISMISS AND SCAN NEXT`
 * (design §5). §5 is the RN one-handed control rail; the spec is explicit that
 * Phase B inherits the tone/copy contract of §2 and §10 but **not** the RN
 * layout, and the web action row is already a documented deviation (it sits
 * below the fill on the page background rather than being a rail).
 *
 * ## The budget, measured from the observed defect
 *
 * At a 320px viewport:
 *
 * ```
 * 320  viewport
 *  -2  ContentArea borderLeft
 * -48  ContentArea paddingHorizontal ($5 = 24, both sides)
 * ----
 * 270  Page (width 100%, no horizontal padding of its own)
 * -32  action row paddingHorizontal ($4 = 16, both sides)
 * ----
 * 238  the row — and a stacked full-width button
 * -48  Button size $4 paddingHorizontal ($5 = 24, both sides)
 *  -8  gap ($2) between the leading icon and the label
 * -16  the leading icon
 * ----
 * 166  LABEL
 * ```
 *
 * {@link estimateActionLabelWidth} is an estimate, and it is calibrated against
 * ground truth rather than invented: it must call the string that was SEEN
 * truncating too wide, and it does (211px against a 166px budget). That is the
 * only reason to trust it at all — see the suite.
 */

/**
 * The labels the action row renders. A table rather than inline JSX strings so
 * the width guard measures the same strings the operator sees.
 */
export const SCAN_ACTION_LABELS = {
  admit: "Admit",
  skip: "Skip",
  checkIn: "Check in",
  /** Was "Dismiss and scan next" — clipped to "DISMISS AND …" at 320px. */
  dismiss: "Scan next",
  /** The secondary beside CHECK IN. */
  dismissSecondary: "Dismiss",
} as const;

export type ScanActionLabelKey = keyof typeof SCAN_ACTION_LABELS;

/** A full-width (stacked) primary at 320px. Arithmetic in the docblock. */
export const NARROW_LABEL_BUDGET_PX = 166;

/**
 * The narrowest a primary can be while sharing a row with a secondary.
 *
 * `minWidth` on the primary is what decides when the pair stacks. It was 140,
 * which let them sit on one row from ~352px up with only `140 - 72 = 68px` of
 * label — narrower than the stacked budget, i.e. a band of viewports where
 * shortening the label alone would NOT have been enough. 180 pushes the
 * single-row threshold past the point where the flexed primary is comfortably
 * wider than its own minimum.
 */
export const PRIMARY_ACTION_MIN_WIDTH = 180;

/** Label budget when the primary is pinned at {@link PRIMARY_ACTION_MIN_WIDTH}. */
export const PAIRED_LABEL_BUDGET_PX = PRIMARY_ACTION_MIN_WIDTH - 72;

/**
 * Approximate rendered width of an action label, in px.
 *
 * `@th/ui` Button at `size="$4"`: Montserrat 700, `fontSize: 12`,
 * `letterSpacing: 1.5`, uppercased by the wrapper. Uppercase Montserrat Bold
 * averages ~0.72em of advance; tracking adds 1.5px after every glyph except the
 * last.
 *
 * An estimate, deliberately: jsdom has no layout engine, so a rendered
 * measurement is not available to the suite at all. Its value comes from being
 * anchored — the suite asserts it rejects the label that was actually observed
 * clipping before it accepts any of the ones we ship.
 */
export const estimateActionLabelWidth = (label: string): number => {
  const chars = label.trim().length;
  if (chars === 0) return 0;
  const FONT_SIZE = 12;
  const UPPERCASE_ADVANCE_EM = 0.72;
  const TRACKING = 1.5;
  return chars * (FONT_SIZE * UPPERCASE_ADVANCE_EM + TRACKING) - TRACKING;
};
