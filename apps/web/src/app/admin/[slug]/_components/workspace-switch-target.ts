import { parseNamespacedPathname, type NavigationSection } from "@th/ui";

/**
 * Where a workspace switch lands.
 *
 * Historically every switch went to `/admin/{slug}/dashboard`, which threw
 * away the section the user was reading. This preserves the SECTION (and only
 * the section): switching from `/admin/orgA/orders` lands on
 * `/admin/orgB/orders`.
 *
 * Deeper segments are dropped ON PURPOSE. `/admin/orgA/events/evt_123/edit`
 * carries an entity id that belongs to orgA; replaying it under orgB would
 * 404 or FORBIDDEN, so it collapses to the section root `/admin/orgB/events`.
 * Query strings and hashes are dropped for the same reason (filters, tabs and
 * ids are workspace-scoped state).
 */

/**
 * The workspace home route. Shared so the switch target and AdminShell's
 * `currentRoute` fallback agree — the dashboard is no longer a nav item (the
 * rail identity block is the one way home), so neither can derive it from the
 * nav model any more.
 */
export const ADMIN_DASHBOARD_ROUTE = "dashboard";

/** First path segment of a route id: `events/abc-123/edit` → `events`. */
// Cut at `?`/`#` first: an anchor child (`payouts#ledger`) is the SAME
// section as its parent, not a portable segment of its own.
const firstSegment = (routeId: string): string | undefined =>
  routeId
    .split(/[?#]/, 1)[0]!
    .split("/")
    .find((segment) => segment.length > 0);

/**
 * Every route SEGMENT the workspace rail can navigate to, flattened from the
 * nav model (items + nested children) rather than hardcoded, so this list can
 * never drift from the rail.
 */
export const collectPortableRouteSegments = (
  sections: NavigationSection[],
): ReadonlySet<string> => {
  const segments = new Set<string>();

  const visit = (item: NavigationSection["items"][number]) => {
    const segment = firstSegment(item.route);
    if (segment) {
      segments.add(segment);
    }
    for (const child of item.children ?? []) {
      visit(child);
    }
  };

  for (const section of sections) {
    for (const item of section.items) {
      visit(item);
    }
  }

  return segments;
};

export interface WorkspaceSwitchTargetInput {
  /** Current pathname, as returned by Next's `usePathname()`. */
  pathname: string | null | undefined;
  /** Admin base path for the CURRENT workspace, e.g. `/admin/acme-co`. */
  adminBasePath: string;
  /** Admin slug of the workspace being switched TO. */
  targetContextId: string;
  /** Section segments that exist in the rail (see `collectPortableRouteSegments`). */
  portableRoutes: ReadonlySet<string>;
}

export const resolveWorkspaceSwitchTarget = ({
  pathname,
  adminBasePath,
  targetContextId,
  portableRoutes,
}: WorkspaceSwitchTargetInput): string => {
  const dashboard = `/admin/${targetContextId}/${ADMIN_DASHBOARD_ROUTE}`;

  // No `fallbackRouteId`: an unparseable pathname must land on the dashboard,
  // not on whatever the first nav item happens to be. `parseNamespacedPathname`
  // owns percent-encoding tolerance (a pasted `/admin/%40steve-1/orders` still
  // resolves) and the segment-boundary check — one definition, shared with
  // AdminShell's `currentRoute`.
  const routeId = parseNamespacedPathname(pathname, { adminBasePath });

  if (!routeId) return dashboard;

  const segment = firstSegment(routeId);
  if (!segment || !portableRoutes.has(segment)) return dashboard;

  return `/admin/${targetContextId}/${segment}`;
};
