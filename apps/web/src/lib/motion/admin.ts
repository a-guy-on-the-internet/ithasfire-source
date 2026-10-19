/**
 * Admin-specific motion: page transitions + skeleton shimmer.
 *
 * Keyframes live in `app/globals.css` under `@keyframes th-admin-*`.
 * This module pins their durations + easings to the centralized motion
 * tokens so the admin shell stays consistent with the public site.
 */

import { DECELERATE_EASE, DURATION } from "./index";

/** Page-level slide-up on admin route mount. */
export const ADMIN_PAGE_DURATION_MS = DURATION.medium;
/** Skeleton shimmer cycle length. */
export const ADMIN_SKELETON_DURATION_MS = 1_400;

export const ADMIN_EASING = DECELERATE_EASE;
