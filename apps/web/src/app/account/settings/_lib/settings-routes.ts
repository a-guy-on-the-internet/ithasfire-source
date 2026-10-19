/**
 * Account-settings ROUTE vocabulary — slugs, hrefs and legacy-anchor mapping.
 *
 * Deliberately free of React and of `"use client"`: the dynamic route
 * `/account/settings/[section]/page.tsx` is a Server Component that validates
 * the slug and `redirect()`s before rendering anything, and a Server Component
 * cannot call a function exported across a client boundary.
 *
 * The nav MODEL (groups, entitlement, icons) lives in `settings-sections.tsx`,
 * which is client-side because it builds React elements.
 */

/**
 * Every legal `/account/settings/[section]` value. Anything else redirects to
 * `/account/settings` — not a 404, and never a crash.
 */
export const SETTINGS_SECTION_SLUGS = [
  "profile",
  "email",
  "security",
  "notifications",
  "billing",
  "roles",
  "performer",
  "booking-defaults",
  "booking-requests",
  "venues",
  "contributions",
  "danger",
] as const;

export type SettingsSectionSlug = (typeof SETTINGS_SECTION_SLUGS)[number];

/** What the bare `/account/settings` route renders. */
export const DEFAULT_SETTINGS_SECTION: SettingsSectionSlug = "profile";

export const SETTINGS_BASE_PATH = "/account/settings";

export function isSettingsSectionSlug(
  value: string | undefined | null,
): value is SettingsSectionSlug {
  return (
    typeof value === "string" &&
    (SETTINGS_SECTION_SLUGS as readonly string[]).includes(value)
  );
}

export function settingsSectionHref(slug: SettingsSectionSlug): string {
  return `${SETTINGS_BASE_PATH}/${slug}`;
}

/**
 * Parse a settings pathname back into the surface's client state.
 *
 * Used by the `popstate` listener in `SettingsSurface`: browser back/forward
 * over the client-side `pushState` entries never remounts the surface, so the
 * section + mobile index/detail state must be re-derived from the new URL.
 *
 * Returns `null` for anything outside the settings tree (including nested or
 * unknown slugs) — the caller then leaves the URL to Next's own router, which
 * owns the real cross-route navigation and remount.
 *
 * - `/account/settings`            → default section, mobile INDEX view
 * - `/account/settings/<slug>`     → that section, mobile DETAIL view
 * - anything else                  → `null`
 */
export function sectionFromPathname(
  pathname: string,
): { section: SettingsSectionSlug; isIndex: boolean } | null {
  if (pathname === SETTINGS_BASE_PATH) {
    return { section: DEFAULT_SETTINGS_SECTION, isIndex: true };
  }
  const prefix = `${SETTINGS_BASE_PATH}/`;
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length);
  // Only a single, known segment maps back to a section.
  if (!isSettingsSectionSlug(rest)) return null;
  return { section: rest, isIndex: false };
}

/**
 * Legacy in-page anchors → the route that now owns them.
 *
 * The single-scroll page exposed `#email`, `#notifications`, `#profile` and the
 * `phone-number-section` DOM id, and older bookmarks may carry the camelCase
 * rail ids. `/account/settings` replace-navigates on mount using this table, so
 * every one of those still lands on the right section. In-repo sources were
 * updated to point at the real routes; this is the safety net for bookmarks and
 * for any link outside the repo.
 *
 * Keys are lower-cased on lookup, so `#rolesCraft` and `#rolescraft` both hit.
 */
export const SETTINGS_HASH_ALIASES: Readonly<
  Record<string, SettingsSectionSlug>
> = {
  profile: "profile",
  email: "email",
  notifications: "notifications",
  billing: "billing",
  security: "security",
  danger: "danger",
  performer: "performer",
  roles: "roles",
  rolescraft: "roles",
  bookingdefaults: "booking-defaults",
  "booking-defaults": "booking-defaults",
  bookingrequests: "booking-requests",
  "booking-requests": "booking-requests",
  suggestions: "contributions",
  contributions: "contributions",
  venueclaims: "venues",
  venues: "venues",
  // Anchor target of the "add a phone to enable SMS" affordance in
  // NotificationsSection — the phone card now lives on the Security route.
  "phone-number-section": "security",
};

const normalizeHash = (hash: string | null | undefined): string =>
  (hash ?? "").replace(/^#/, "").trim().toLowerCase();

/** Resolve a `location.hash` (with or without `#`) to a section, if it maps. */
export function sectionForHash(
  hash: string | null | undefined,
): SettingsSectionSlug | null {
  const key = normalizeHash(hash);
  if (!key) return null;
  return SETTINGS_HASH_ALIASES[key] ?? null;
}

/**
 * Anchors that still resolve to a real element on their destination route, and
 * so are worth carrying through the redirect. Everything else is dropped —
 * `/account/settings/email#email` would be a dangling fragment.
 */
const PRESERVED_ANCHORS: ReadonlySet<string> = new Set(["phone-number-section"]);

/**
 * Full destination for a legacy `#hash` landing on the bare settings route, or
 * `null` when the hash means nothing to us (leave the user on the index).
 *
 * `search` is passed through verbatim; every consumer of `redirect_url`
 * re-sanitises it via `readRedirectParam`, so nothing hostile survives the trip.
 */
export function resolveLegacyHashTarget(
  hash: string | null | undefined,
  search: string | null | undefined,
): string | null {
  const section = sectionForHash(hash);
  if (!section) return null;
  const key = normalizeHash(hash);
  const anchor = PRESERVED_ANCHORS.has(key) ? `#${key}` : "";
  return `${settingsSectionHref(section)}${search ?? ""}${anchor}`;
}
