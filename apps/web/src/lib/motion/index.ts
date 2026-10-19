/**
 * Centralized motion tokens for the web app.
 *
 * Conventions:
 *   - Durations are in milliseconds (`Ms` suffix).
 *   - Easings are CSS `cubic-bezier(...)` strings, named by intent.
 *   - Keyframes themselves live in `app/globals.css` so they're part of the
 *     stylesheet. This module owns *when* and *how long* — names + timings.
 *
 * Adding a new animation system:
 *   1. Add the keyframe to globals.css under its feature section.
 *   2. Add timing constants here (or in a sibling file like `auth.ts`).
 *   3. Add a helper that returns the inline style or class name so callers
 *      never hardcode duration / easing.
 */

/** Standard ease — material-style "enter from rest, ease into rest". */
export const STANDARD_EASE = "cubic-bezier(0.4, 0, 0.2, 1)";
/** Snappy ease for short micro-interactions (button press, toggle). */
export const SHARP_EASE = "cubic-bezier(0.4, 0, 0.6, 1)";
/** Decelerate — fast start, slow end. Use for "things arriving on screen". */
export const DECELERATE_EASE = "cubic-bezier(0.16, 1, 0.3, 1)";
/** Spring with subtle overshoot for celebratory pops (success states). */
export const SPRING_EASE = "cubic-bezier(0.34, 1.56, 0.64, 1)";

/** Canonical durations. Pick the one that matches the intent, don't pick a new number. */
export const DURATION = {
  /** ~instant feedback (button hover, focus ring). */
  micro: 120,
  /** Short transitions (toast in/out, dropdown open). */
  fast: 180,
  /** Standard panel / page-level moves (auth slides, overlay open). */
  base: 220,
  /** Content reveals (modal open with depth, card stagger). */
  medium: 320,
  /** Big moves (full-screen takeovers, route hand-offs). */
  slow: 480,
} as const;

export type DurationToken = keyof typeof DURATION;
