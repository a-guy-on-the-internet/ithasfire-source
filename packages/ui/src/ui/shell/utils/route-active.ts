import type { NavigationItem } from "../../types/navigation";

/**
 * Check whether a nav item is the active route.
 *
 * `currentRoute` is a bare stable ID (e.g. `"dashboard"`) produced by
 * `parseNamespacedPathname`, while `itemRoute` may be a full namespaced
 * path (e.g. `"/admin/acme-co/dashboard"`) produced by `namespaceNavSections`.
 *
 * We match when:
 *   1. They are identical (both bare or both namespaced), OR
 *   2. The namespaced `itemRoute` ends with `/<currentRoute>`, OR
 *   3. The item opted into `activeMatch: "prefix"` and `currentRoute`'s FIRST
 *      segment matches by rule 2 — i.e. the item owns a route family.
 *
 * Rule 3 is opt-in per item. `/admin/:slug/settings` became one route per
 * section, so `currentRoute` arrives as `"settings/booking-defaults"` and rules
 * 1–2 both miss: the rail's Settings entry went dark on seven of its eight
 * URLs. Making prefix matching global would also light "Events" from inside the
 * event builder, which the event-context rail handles differently — hence the
 * flag rather than a behaviour change for every item.
 *
 * CONSTRAINT RULE 2 PUTS ON NAV CONSTANTS: matching on the last segment means
 * two items in the SAME rail both light up whenever one's route ends with the
 * other's bare id. This became reachable once `namespaceNavSections` started
 * passing app-ABSOLUTE routes through verbatim, so a cross-area
 * `/moderate/suggestions` entry sits one same-shell `route: "suggestions"`
 * away from a double-highlight. Enforce that at the nav constant — the
 * platform rail does, in `app/platform/__tests__/platform-nav-sections.test.tsx`
 * — rather than tightening the rule here: the admin, seller and platform
 * shells all feed this a bare-id `currentRoute` against a namespaced
 * `itemRoute`, so rule 2 is the only thing lighting their rails at all.
 *
 * Shared (leaf module, no component imports) between the wide/compact
 * NavigationRail and the mobile NavigationBottomBar so the two chromes can
 * never disagree about which destination is current. The bottom bar
 * historically used strict equality, which meant the admin/seller/platform
 * shells (bare-id `currentRoute` vs namespaced `item.route`) never lit a
 * bottom tab at all.
 */
export const isRouteActive = (
  currentRoute: string,
  itemRoute: string,
  activeMatch: NavigationItem["activeMatch"] = "exact",
): boolean => {
  if (currentRoute === itemRoute) return true;
  if (!currentRoute) return false;
  // Namespaced paths start with "/" — match when the last segment equals the bare id.
  if (itemRoute.endsWith(`/${currentRoute}`)) return true;
  if (activeMatch !== "prefix") return false;
  const firstSegment = currentRoute.split("/")[0];
  return Boolean(firstSegment) && itemRoute.endsWith(`/${firstSegment}`);
};
