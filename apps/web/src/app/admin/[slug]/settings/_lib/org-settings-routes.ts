/**
 * Org-settings ROUTE vocabulary — slugs and hrefs for `/admin/[slug]/settings`.
 *
 * Mirrors `app/account/settings/_lib/settings-routes.ts` deliberately: the two
 * settings surfaces now share one nav component, so they share one routing
 * shape too.
 *
 * Deliberately free of React and of `"use client"`: the dynamic route
 * `/admin/[slug]/settings/[section]/page.tsx` is a Server Component that
 * validates the slug and `redirect()`s before rendering anything, and a Server
 * Component cannot call a function exported across a client boundary.
 *
 * The nav MODEL (groups, entitlement, icons) lives in `org-settings-sections.tsx`,
 * which is client-side because it builds React elements.
 */

/**
 * Every legal org-settings section. Anything else redirects to the bare
 * `/admin/[slug]/settings` — not a 404, and never a crash.
 */
export const ORG_SETTINGS_SECTION_SLUGS = [
  "general",
  "contact",
  "page",
  "performer",
  "booking-defaults",
  "booking-tags",
  "default-agreement",
  "danger",
] as const;

export type OrgSettingsSectionSlug =
  (typeof ORG_SETTINGS_SECTION_SLUGS)[number];

/**
 * Sections that MOVED to another surface, keyed by their retired slug.
 *
 * Checked by `[section]/page.tsx` BEFORE slug validation, so the redirect is a
 * STATED intent rather than a side effect of the unknown-slug fallback above.
 * Dropping `booking-requests` from the slug list alone would already land the
 * old URL on the settings index — technically "not broken", but it would drop
 * the member on a page that no longer contains what they bookmarked, and
 * nothing in the code would say that was on purpose.
 *
 * A `Map`, not an object literal: lookups by a raw URL segment must not be able
 * to hit `__proto__` / `constructor` and hand back something callable.
 *
 * Entries earn removal only when the old URL has plausibly stopped circulating
 * (bookmarks, old help articles, emailed links).
 */
export const ORG_SETTINGS_LEGACY_REDIRECTS: ReadonlyMap<
  string,
  (adminSlug: string) => string
> = new Map([
  // The org's received-as-act booking inbox is a daily work queue, not
  // configuration — it lives at /admin/[slug]/bookings now.
  [
    "booking-requests",
    (adminSlug: string) => `/admin/${adminSlug}/bookings`,
  ],
  // "Resale policy" became the group's Default agreement (organiser-resale-share
  // FR-012, owner R19); the page holds the default deal and resale clause now.
  [
    "resale-policy",
    (adminSlug: string) => `/admin/${adminSlug}/settings/default-agreement`,
  ],
]);

/**
 * The destination a retired settings slug moved to, or `null` if the slug was
 * never a settings section that moved (unknown slugs keep falling through to
 * the settings-index contract above).
 */
export function orgSettingsLegacyRedirect(
  section: string | undefined | null,
  adminSlug: string,
): string | null {
  if (typeof section !== "string") return null;
  const build = ORG_SETTINGS_LEGACY_REDIRECTS.get(section);
  return build ? build(adminSlug) : null;
}

/**
 * Sections that keep a HAND-WRITTEN folder route instead of riding the dynamic
 * `[section]` segment. A section qualifies only for a concrete reason, such as
 * a server-side gate in its own `layout.tsx` that a dynamic segment cannot
 * express; the guard below then keeps `[section]` from routing around it.
 *
 * None today. `default-agreement` had one (the `resale` gate) until the page
 * and its default deal were ungated (organiser-resale-share C2); only its
 * resale parts are gated now, inside the page.
 */
export const ORG_SETTINGS_STANDALONE_SLUGS =
  [] as const satisfies readonly OrgSettingsSectionSlug[];

/** What the bare `/admin/[slug]/settings` route renders. */
export const DEFAULT_ORG_SETTINGS_SECTION: OrgSettingsSectionSlug = "general";

export function orgSettingsBasePath(slug: string): string {
  return `/admin/${slug}/settings`;
}

export function orgSettingsSectionHref(
  slug: string,
  section: OrgSettingsSectionSlug,
): string {
  return `${orgSettingsBasePath(slug)}/${section}`;
}

export function isOrgSettingsSectionSlug(
  value: string | undefined | null,
): value is OrgSettingsSectionSlug {
  return (
    typeof value === "string" &&
    (ORG_SETTINGS_SECTION_SLUGS as readonly string[]).includes(value)
  );
}

/** Slugs the dynamic `[section]` route is allowed to render. */
export function isOrgSettingsDynamicSlug(
  value: string | undefined | null,
): value is OrgSettingsSectionSlug {
  return (
    isOrgSettingsSectionSlug(value) &&
    !(ORG_SETTINGS_STANDALONE_SLUGS as readonly string[]).includes(value)
  );
}
