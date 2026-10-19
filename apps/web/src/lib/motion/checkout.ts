/**
 * Checkout-specific motion: panel slides + reveal animations.
 *
 * Keyframes live in `app/globals.css` under `@keyframes th-checkout-*`.
 * This module pins their durations + easings to the centralized motion
 * tokens so checkout animations stay in lockstep with the rest of the app.
 */

import { DECELERATE_EASE, DURATION, STANDARD_EASE } from "./index";

/** Step transitions in the checkout slide container. */
export const CHECKOUT_STEP_DURATION_MS = DURATION.base;
/** Confirmation pop / reveal after a successful purchase. */
export const CHECKOUT_REVEAL_DURATION_MS = DURATION.medium;

/** Reuses the standard ease for in/out moves. */
export const CHECKOUT_EASING = STANDARD_EASE;
/** Decelerate ease for "things arriving" — confirmation copy, summary. */
export const CHECKOUT_ARRIVE_EASING = DECELERATE_EASE;
