import type { NavigationSection } from "../../types/navigation";

export interface RouteNamespacingConfig {
  /**
   * Prefix required for admin routes. This should include the dynamic slug segment.
   * Example: `/admin/acme-co`
   */
  adminBasePath: string;
  /**
   * A stable route id to use when we can't parse the current URL.
   */
  fallbackRouteId?: string;
}

const normalizePath = (path: string): string => {
  if (!path) {
    return "/";
  }

  const trimmed = path.trim();
  if (!trimmed.startsWith("/")) {
    return `/${trimmed}`;
  }
  return trimmed;
};

const stripQueryAndHash = (path: string): string => {
  const queryIndex = path.indexOf("?");
  const hashIndex = path.indexOf("#");
  const cutIndexRaw = Math.min(
    queryIndex === -1 ? Number.POSITIVE_INFINITY : queryIndex,
    hashIndex === -1 ? Number.POSITIVE_INFINITY : hashIndex,
  );
  const cutIndex = Number.isFinite(cutIndexRaw) ? cutIndexRaw : -1;
  return cutIndex === -1 ? path : path.slice(0, cutIndex);
};

const joinPaths = (base: string, suffix: string): string => {
  const normalizedBase = normalizePath(base).replace(/\/$/, "");
  const normalizedSuffix = normalizePath(suffix);
  return `${normalizedBase}${normalizedSuffix === "/" ? "" : normalizedSuffix}`;
};

export interface NamespacedRouteMapping {
  /** Stable route id used by the shell / bottom nav for selection. */
  routeId: string;
  /** Concrete href for navigation within the admin surface. */
  href: string;
}

/**
 * Turns `NavigationSection` definitions whose `item.route` is a stable id
 * into concrete hrefs under the provided admin base path.
 *
 * A route that is ALREADY an app-absolute path (leading `/`) is passed through
 * verbatim — it is a CROSS-AREA destination, not an id to namespace. Joining it
 * under the base produced `/platform/moderate/suggestions` for a page that
 * lives at `/moderate/suggestions`, i.e. a rail entry whose anchor 404s. Every
 * shell's `onRouteSelect` already branches on `routeId.startsWith("/")` to skip
 * `toNamespacedHref` (AdminShell/SellerShell/PlatformShell); that branch was
 * unreachable while this function rewrote the leading `/` away. No existing
 * caller declares an absolute `route`, so this is a pure widening.
 */
export const namespaceNavSections = (
  sections: NavigationSection[],
  config: RouteNamespacingConfig,
): { sections: NavigationSection[]; mapping: Map<string, string> } => {
  const mapping = new Map<string, string>();

  const namespaceItem = (
    item: NavigationSection["items"][number],
  ): NavigationSection["items"][number] => {
    const href = item.route.startsWith("/")
      ? item.route
      : joinPaths(config.adminBasePath, item.route);
    mapping.set(item.route, href);
    return {
      ...item,
      route: href,
      ...(item.children ? { children: item.children.map(namespaceItem) } : {}),
    };
  };

  const next = sections.map((section) => ({
    ...section,
    items: section.items.map(namespaceItem),
  }));

  return { sections: next, mapping };
};

/**
 * Base-path forms a pathname may legitimately arrive in.
 *
 * `usePathname()` returns `URL.pathname`, which mirrors the address bar
 * VERBATIM — it neither encodes nor decodes. Every href this app generates
 * carries a literal `@` (`joinPaths` below does no encoding), so in-app
 * navigation matches the decoded base directly. But a human workspace reached
 * from a PASTED or BOOKMARKED link arrives percent-encoded
 * (`/admin/%40steve-1/orders`) while `adminBasePath` is built from the decoded
 * route param (`/admin/@steve-1`). A bare `startsWith` missed that, and every
 * caller silently fell back to its default route — the rail highlighted
 * Dashboard while the user was reading Orders, and the tab title agreed.
 *
 * Candidates are ADDITIVE, not exclusive: a base carrying a literal `%` makes
 * `decodeURIComponent` throw, and the raw and encoded forms must still be
 * tried after it does.
 */
const basePathCandidates = (adminBasePath: string): string[] => {
  const base = normalizePath(adminBasePath).replace(/\/$/, "");
  const candidates = [base];

  // Per SEGMENT, so the path's own `/` separators are never encoded away.
  const encoded = base.split("/").map(encodeURIComponent).join("/");
  if (encoded !== base) {
    candidates.push(encoded);
  }

  try {
    const decoded = decodeURIComponent(base);
    if (decoded !== base) {
      candidates.push(decoded);
    }
  } catch {
    // Malformed percent-escape in the slug — the other candidates stand.
  }

  return candidates;
};

/**
 * Remainder after `base`, or undefined when `cleaned` isn't under it.
 *
 * The base must end on a SEGMENT boundary. Without that check
 * `/admin/acme-corp/orders` "matches" the base `/admin/acme` and yields the
 * bogus route id `-corp/orders` — one workspace slug being a prefix of
 * another was enough to mis-resolve the whole shell.
 */
const remainderAfterBase = (
  cleaned: string,
  base: string,
): string | undefined => {
  if (!cleaned.startsWith(base)) {
    return undefined;
  }
  const rest = cleaned.slice(base.length);
  if (rest !== "" && !rest.startsWith("/")) {
    return undefined;
  }
  return rest || "/";
};

/**
 * Given a concrete pathname like `/admin/acme-co/orders`, return the stable route id `orders`.
 */
export const parseNamespacedPathname = (
  pathname: string | null | undefined,
  config: RouteNamespacingConfig,
): string | undefined => {
  if (!pathname) {
    return config.fallbackRouteId;
  }

  const cleaned = stripQueryAndHash(normalizePath(pathname));

  for (const base of basePathCandidates(config.adminBasePath)) {
    const remainder = remainderAfterBase(cleaned, base);
    if (remainder === undefined) {
      continue;
    }
    const stable = normalizePath(remainder);
    return stable === "/" ? config.fallbackRouteId : stable.replace(/^\//, "");
  }

  return config.fallbackRouteId;
};

/** Convenience helper for producing a concrete href from a stable route id. */
export const toNamespacedHref = (
  routeId: string,
  config: RouteNamespacingConfig,
): string => {
  return joinPaths(config.adminBasePath, routeId);
};
