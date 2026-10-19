/**
 * Auth-specific motion: panel slide rules + helpers.
 *
 * Builds on the shared tokens in `./index.ts` so the auth flow stays
 * timing-consistent with the rest of the app. The keyframes themselves
 * (`th-auth-panel-slide-*`) live in `app/globals.css`.
 */

import { DURATION, STANDARD_EASE } from "./index";

/** Standard auth panel-swap duration (one half of a full A→B transition). */
export const AUTH_PANEL_DURATION_MS = DURATION.base;
/** Backdrop fade + card enter/exit on overlay open/close. */
export const AUTH_OVERLAY_DURATION_MS = DURATION.base;
/** Standard ease used across the auth flow. */
export const AUTH_EASING = STANDARD_EASE;

export type AuthPanel =
  | "sign-in"
  | "sign-up"
  | "verify-email"
  | "setup-2fa"
  | "verify-2fa"
  | "welcome-profile"
  | "forgot-password";

export type SlideDirection = "forward" | "backward";
export type TransitionPhase = "idle" | "exiting" | "entering";

/** Panels that form the post-signup onboarding flow, in order. */
export const ONBOARDING_PANELS: AuthPanel[] = [
  "sign-up",
  "verify-email",
  "setup-2fa",
  "welcome-profile",
];

/**
 * Returns the slide direction for a source → target panel swap, or `null`
 * when the swap should happen instantly (no animation).
 *
 * Rules:
 *   - Stepper panels (sign-up → verify-email → setup-2fa → welcome-profile):
 *     slide based on index
 *   - sign-in ↔ verify-2fa: forward / backward
 *   - sign-in → sign-up: forward (reads as "start onboarding")
 *   - sign-up → sign-in: backward ("already have an account")
 */
export function getSlideDirection(
  source: AuthPanel,
  target: AuthPanel,
): SlideDirection | null {
  if (source === target) return null;

  const sourceIsOnboarding = ONBOARDING_PANELS.includes(source);
  const targetIsOnboarding = ONBOARDING_PANELS.includes(target);

  if (sourceIsOnboarding && targetIsOnboarding) {
    return ONBOARDING_PANELS.indexOf(target) >
      ONBOARDING_PANELS.indexOf(source)
      ? "forward"
      : "backward";
  }

  if (source === "sign-in" && target === "verify-2fa") return "forward";
  if (source === "verify-2fa" && target === "sign-in") return "backward";

  if (source === "sign-in" && target === "sign-up") return "forward";
  if (source === "sign-up" && target === "sign-in") return "backward";

  return null;
}

/**
 * Inline styles below reference the CSS custom properties defined in
 * globals.css (`--motion-base`, `--motion-ease-standard`). When the
 * canonical values change in one place, both CSS keyframes + JS-driven
 * animations stay in lockstep. JS-side constants above are still here
 * for code that needs the number (timeouts, comparisons).
 */

// `both` (not `forwards`) is critical: it applies the FROM keyframe at
// first paint AND retains the TO keyframe after the animation ends.
// With `forwards`, the element renders at its natural position
// (translateX(0)) before the animation kicks in, so the slide-in panel
// just "pops" instead of visibly sliding from the right edge.
const FILL_MODE = "both";

/** Inline style for the panel that's leaving the screen. */
export function getPanelExitStyle(
  direction: SlideDirection,
): React.CSSProperties {
  const name =
    direction === "forward"
      ? "th-auth-panel-slide-out-to-left"
      : "th-auth-panel-slide-out-to-right";
  return {
    animation: `${name} var(--motion-base) var(--motion-ease-standard) ${FILL_MODE}`,
  };
}

/** Inline style for the panel that's coming onto the screen. */
export function getPanelEnterStyle(
  direction: SlideDirection,
): React.CSSProperties {
  const name =
    direction === "forward"
      ? "th-auth-panel-slide-in-from-right"
      : "th-auth-panel-slide-in-from-left";
  return {
    animation: `${name} var(--motion-base) var(--motion-ease-standard) ${FILL_MODE}`,
  };
}
