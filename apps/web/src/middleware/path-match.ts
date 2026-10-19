/**
 * Shared path-prefix matcher for the middleware gates.
 *
 * Extracted so `staff-route-gate.ts` and `private-route-gate.ts` cannot
 * drift apart on the ONE detail that matters here: a prefix match must be
 * segment-aware. A naive `pathname.startsWith("/account")` also matches
 * `/accounts-payable` and `/account-recovery`, which would gate (or, in an
 * allowlist, un-gate) routes nobody intended. Behaviour is identical to the
 * inline helper this replaces in `staff-route-gate.ts`.
 *
 * Also used by client components (no imports, so safe there) for the same
 * reason: an event slug can contain "checkout", so `includes` / bare
 * `startsWith` gave a dead Support tab, a flush shell and dropped cart
 * recovery on `/events/checkout-night`.
 */

/**
 * True when `pathname` is exactly `base` or a descendant of it.
 *
 * `isUnderPath("/account", "/account")` → true
 * `isUnderPath("/account/settings", "/account")` → true
 * `isUnderPath("/accounts-payable", "/account")` → false
 *
 * Pass `base` without a trailing slash.
 */
export const isUnderPath = (pathname: string, base: string): boolean =>
  pathname === base || pathname.startsWith(`${base}/`);
