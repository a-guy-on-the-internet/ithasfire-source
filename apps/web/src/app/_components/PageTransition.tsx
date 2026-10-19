/// <reference types="react/canary" />
"use client";

import { ViewTransition } from "react";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

/**
 * Page-level view transition, enabled on the PUBLIC surface only.
 *
 * WHY IT IS SCOPED RATHER THAN GLOBAL
 * -----------------------------------
 * A `<ViewTransition>` at the root animates MORE THAN ONCE per navigation.
 * React models a route change and a `<Suspense>` reveal identically at such a
 * boundary, so a page whose content streams commits twice and replays the
 * animation. Measured on a prod build: most admin routes animated once
 * (~260-280ms), but the data-heavy `/admin/[slug]/dashboard` animated TWICE
 * (283ms + 279ms) off a SINGLE pushState. Softening the animation only traded
 * a slide-bounce for a flicker — the replay is structural, not cosmetic.
 *
 * The replay scales with how much a route streams, and the dense app shells
 * (admin/platform/moderate rails, live dashboards) are both the worst
 * offenders and the surface where a page transition earns the least. So they
 * opt out and the public/marketing surface keeps the fade.
 *
 * WHY `default="none"` AND NOT A CONDITIONAL WRAPPER
 * -------------------------------------------------
 * Rendering `<ViewTransition>` vs a fragment based on the pathname changes the
 * ELEMENT TYPE at this position, which makes React remount the entire page
 * subtree every time you cross the boundary. `default="none"` deactivates the
 * transition name under every trigger while keeping the element type stable,
 * so nothing remounts.
 *
 * IF YOU EVER NEED THE TRANSITION ON A STREAMING ROUTE
 * ---------------------------------------------------
 * The supported escalation is transition types, not more CSS. Next's `<Link>`
 * accepts `transitionTypes={['nav']}` (and `router.push(href, {transitionTypes})`),
 * which lets you write `update={{ nav: "auto", default: "none" }}` here — real
 * navigations animate, the untagged Suspense re-commit does not. It only works
 * where call sites are tagged, and this app has 200+ programmatic navigation
 * sites, so adopt it per-surface rather than all at once.
 */

/**
 * Prefixes that get NO page transition (dense app shells; see above).
 *
 * `/embed` is here for a different reason than the app shells: those pages are
 * served INTO third-party iframes, where the site's page transitions have no
 * host-visible benefit and a real cost. React holds the DOM update until the
 * transition commits, so a widget screen change that waits on a network read
 * (browse → event detail) can blow Chrome's ~4s `updateCallbackDone` cap and
 * emit an uncaught "Transition was aborted because of timeout in DOM update"
 * — inside a customer's page, where we neither see it nor can explain it.
 * Measured 2026-08-07: reproduces on flip-then-detail, and does NOT reproduce
 * with the view switcher absent, so it rides this surface's own screen churn.
 */
const UNANIMATED_PREFIXES = [
  "/admin",
  "/platform",
  "/moderate",
  "/embed",
] as const;

/**
 * Exact routes that get NO page transition.
 *
 * `/` is here because React holds the transition until the new route commits,
 * and home is by far the heaviest streaming page: measured 604-619ms to arrive
 * at `/` versus 215-245ms for a marketing page. That hold shows the OLD page
 * the whole time, so a click appears to do nothing, then the page swaps, then
 * the streamed sections pop in — three visible steps that read as sluggish.
 * Not worth animating a page whose animation is mostly a stall.
 *
 * NOTE this keys on the DESTINATION. React reads these props on the commit that
 * starts the transition, and that commit renders the route being navigated TO —
 * so arriving at `/` does not animate, while leaving `/` for a lighter route
 * still does. That asymmetry is deliberate: the slow direction is the arrival.
 * Verified in-browser, not assumed.
 *
 * `/search` is here because its in-page URL changes are live filter updates,
 * not moves between pages: typing, scope and place edits rewrite the
 * querystring while the reader stays put. Animating those commits as a page
 * move cost one 911ms frame after typing "comedy" (prod, 6x CPU throttle).
 * It has no subroutes, so the exact match covers it.
 */
const UNANIMATED_EXACT: readonly string[] = ["/", "/search"];

export function PageTransition({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  // Prefix match must be segment-aware: a bare `startsWith("/admin")` would
  // also swallow a hypothetical `/administrators` route.
  const disabled =
    UNANIMATED_EXACT.includes(pathname) ||
    UNANIMATED_PREFIXES.some(
      (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
    );

  // NOTE: targeted by view-transition-CLASS (`th-page`), never by name, and no
  // explicit `name` is set. React de-duplicates colliding explicit names, and
  // during a navigation two instances of this boundary are briefly alive — so
  // an explicit `name="page-content"` alternated between `page-content` and
  // `page-content_1` on every navigation. Half of each transition then missed
  // the `::view-transition-*(page-content)` rules and silently fell back to the
  // browser's DEFAULT 250ms animation (losing `position: absolute` on the old
  // snapshot, which is what stops it pushing layout). Classes are not
  // de-duplicated, so both halves always match. Verified with getAnimations().
  return (
    <ViewTransition default={disabled ? "none" : "th-page"}>
      {children}
    </ViewTransition>
  );
}

PageTransition.displayName = "PageTransition";
