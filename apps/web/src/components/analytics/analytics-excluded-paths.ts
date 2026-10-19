import { isUnderPath } from "@/middleware/path-match";

/**
 * Routes whose URL carries a BEARER token (in the query string, or as a path
 * segment under the listed prefix). No third-party
 * analytics script is loaded on them, so the token can't ride out in a
 * pageview's `page_location` / `u` field.
 *
 * Scope of the guarantee: this stops the scripts LOADING on these routes
 * (the normal case — the link is opened from an email or a message, i.e. a
 * full page load). If a script is already running because the visitor
 * client-navigated here (e.g. back from /sign-in), GA is additionally switched
 * off via its `ga-disable-<id>` flag (see GoogleAnalyticsLoader); Plausible
 * and the Cloudflare beacon have no equivalent runtime switch.
 */
export const ANALYTICS_EXCLUDED_PATHS = [
  "/invite/accept",
  "/invitations/accept",
  "/delegate/accept",
  // "Stop invites from this organiser" (`?token=<opt-out token>`): the page
  // strips it on load, but nothing orders that against a script's first read.
  "/invites/stop",
  // Booking-request claim link: the single-use token is the path segment
  // (`/booking-requests/claim/<token>`), so only a prefix match catches it.
  "/booking-requests/claim",
] as const;

export function isAnalyticsExcludedPath(pathname: string | null): boolean {
  if (!pathname) return false;
  return ANALYTICS_EXCLUDED_PATHS.some((p) => isUnderPath(pathname, p));
}
