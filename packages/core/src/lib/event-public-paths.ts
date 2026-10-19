/**
 * ROOT-RELATIVE paths of an event's public pages — the dependency-free half of
 * `public-urls.ts`, which re-exports everything here.
 *
 * Split out so a browser bundle can import them. `public-urls.ts` also carries
 * `eventEmailImageUrl`, which pulls `@th/types/seo/eventOgImage` and through it
 * `node:crypto`; a client component importing `public-urls` would make Next
 * resolve that to its `crypto-browserify` polyfill and ship it in the chunk.
 * Keep this module import-free.
 *
 * Server code keeps importing from `public-urls` — one definition, two doors.
 */

/**
 * Turns an event slug into the path segments of its public URL.
 *
 * Event slugs are MULTI-SEGMENT (`org-slug/us/general/my-event-…--ab12cd`) and
 * `/events/[...slug]` is a catch-all, so the slashes must survive as real path
 * separators. Encoding the slug whole (`encodeURIComponent`) turns them into
 * `%2F` and the route 404s — verified against the running app. Each SEGMENT is
 * escaped individually instead, which keeps the route intact and still neuters
 * anything odd inside a segment.
 */
export function eventSlugPath(slug: string): string {
  return slug
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

/**
 * ROOT-RELATIVE path of an event's public page (`/events/<slug…>`), or null
 * when there is no slug.
 *
 * For in-app-only notification actions, which the client hands to
 * `router.push()` — those need a path, not an origin, so they have no reason to
 * plumb `appBaseUrl` through just to have the renderer strip it off again.
 * `eventPublicUrl` composes this with the base, so both share one definition of
 * "what an event's path looks like" and neither can drift into an id route.
 */
export function eventPublicPath(
  slug: string | null | undefined,
): string | null {
  if (!slug) return null;
  const path = eventSlugPath(slug);
  return path ? `/events/${path}` : null;
}

/**
 * ROOT-RELATIVE short link of an event (`/e/<shortId>`), or null when there is
 * no short ID. The web route `/e/[shortId]` answers it with a TEMPORARY
 * redirect to {@link eventPublicPath} — only for an event the public may read.
 *
 * Short enough for an SMS or a flyer; the canonical page stays the slug URL.
 */
export function eventShortPath(
  shortId: string | null | undefined,
): string | null {
  if (!shortId) return null;
  return `/e/${encodeURIComponent(shortId)}`;
}
