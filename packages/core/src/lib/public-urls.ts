import { resolveEventOgImage } from "@th/types/seo/eventOgImage";

import { eventPublicPath, eventShortPath } from "./event-public-paths";

// The root-relative path builders live in `event-public-paths.ts` so a browser
// bundle can import them without this module's `node:crypto` (see there).
export {
  eventPublicPath,
  eventShortPath,
  eventSlugPath,
} from "./event-public-paths";

/**
 * Builders for absolute PUBLIC (visitor-facing) URLs.
 *
 * One implementation, shared by every notification emitter, because the last
 * two link bugs were both "a second place built the URL differently":
 *   - the image-moderation notices linked `/events/<uuid>`;
 *   - the RSVP confirmation email linked `/events/<uuid>` too.
 *
 * Anything that needs a public event link MUST come through here.
 */

/**
 * Normalizes a configured public web origin into a trailing-slash-free base, or
 * null when it is unusable.
 *
 * `PUBLIC_WEB_URL` is env-supplied and can be malformed (`ithasfire.com`, no
 * scheme). URLs carried in a notification payload are validated by a STRICT
 * `z.string().url()` in the renderer, and `renderNotification` runs inside
 * `notify()` BEFORE it claims its idempotency key — so a scheme-less base would
 * not merely drop a link, it would throw and sink the ENTIRE notice. Parsing
 * here means a bad env var costs the link and nothing else.
 */
export function normalizeAppBaseUrl(
  appBaseUrl: string | null | undefined,
): string | null {
  if (!appBaseUrl) return null;
  const trimmed = appBaseUrl.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    // Anything that isn't a normal absolute web origin is unusable: a bare host
    // either throws or parses with a junk protocol.
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    // Rebuild from the parsed parts rather than returning the raw string: a
    // configured base carrying a query or fragment (`https://x.com/?utm=1`)
    // would otherwise produce `https://x.com/?utm=1/events/…`, which is not
    // the URL anyone meant.
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

/**
 * Absolute public URL of an event page, or null when it can't be built.
 *
 * SLUG ONLY — never the id. The public page is `/events/[...slug]` and resolves
 * through `events.resolveBySlug`, which matches the current slug or slug
 * history and nothing else, so an id-based link 404s. (On a seeded dev database
 * some id links 307-redirect, but only because the seed left the uuid in
 * `EventSlugHistory`; `publish-event` records the generated slug, so a real
 * event's id is never in there.)
 *
 * STATUS IS DELIBERATELY NOT A CONDITION. Every status renders: the route has
 * no status gate, and `EventDetail` shows a status banner for CANCELLED /
 * ARCHIVED / COMPLETED / DRAFT precisely "so the page never reads as a live
 * event". A cancellation notice linking the cancelled event's page is the
 * intended destination, so gating on PUBLISHED would delete the link exactly
 * where it is most useful.
 *
 * A missing slug is the only real blocker, and it is close to unreachable for
 * anything worth linking: `publish-event` assigns a slug in the publishing
 * transaction, so PUBLISHED implies a slug.
 */
export function eventPublicUrl(input: {
  baseUrl: string | null | undefined;
  slug: string | null | undefined;
}): string | null {
  const base = normalizeAppBaseUrl(input.baseUrl);
  const path = eventPublicPath(input.slug);
  if (!base || !path) return null;
  return `${base}${path}`;
}

/**
 * Absolute short link of an event, or null when it can't be built. Same base
 * normalisation as {@link eventPublicUrl}.
 */
export function eventShortUrl(input: {
  baseUrl: string | null | undefined;
  shortId: string | null | undefined;
}): string | null {
  const base = normalizeAppBaseUrl(input.baseUrl);
  const path = eventShortPath(input.shortId);
  if (!base || !path) return null;
  return `${base}${path}`;
}

/**
 * The image an event's EMAIL should show, as an absolute URL — the event's own
 * poster when it has one, and the generated Date Stub
 * (`/og/event/<slug>?v=<signature>`) when it does not.
 *
 * Same resolver the web app's `generateMetadata` uses
 * (`@th/types/seo/eventOgImage`), so a share card and a confirmation email can
 * never disagree about which image represents an event.
 *
 * ── THE `?v=` IN THIS URL IS ADVISORY, NOT AUTHORITATIVE ────────────────────
 * The route recomputes the signature from the DISCLOSURE-GATED payload that
 * `events.getEventSeo` returns: a venue is named there only when it is both
 * venue-confirmed and directory-listed, an OBSCURED event is never named at
 * all, and the stub's fallback line is the public city/region. None of that is
 * reachable from here — this function is handed a plain event record whose
 * `locationLabel` is the organiser's free text and whose place row (with its
 * `venueConfirmed` / `listedInDirectory` flags) would take a privileged read to
 * resolve. Re-deriving the gate in `@th/core` would mean a second
 * implementation of a disclosure rule, which is exactly how disclosure rules
 * get broken.
 *
 * So the key is deliberately best-effort and is expected to miss. That is safe
 * by construction: a non-matching `?v=` makes the route 302 to the canonical
 * stub URL (it does NOT render, and does NOT serve a long cache), so an email
 * image costs one extra hop and lands on the correct, current artifact. Do NOT
 * "fix" this by loosening what the route accepts.
 *
 * Returns null only when there is genuinely nothing to show: an unusable
 * `PUBLIC_WEB_URL` plus an event with no poster. Every template that takes a
 * `heroImageUrl` types it as optional/nullable and simply omits the block, and
 * the ui-email schemas enforce `z.string().url()` — a relative URL would throw
 * inside `notify()` BEFORE it claims its idempotency key and sink the whole
 * notice, which is exactly why the base is normalized first rather than
 * interpolated.
 */
export function eventEmailImageUrl(input: {
  baseUrl: string | null | undefined;
  event: {
    id: string;
    slug: string | null | undefined;
    title: string;
    startsAt: Date;
    timezone?: string | null;
    updatedAt?: Date | null;
    heroImageUrl?: string | null;
    venueName?: string | null;
  };
}): string | null {
  const base = normalizeAppBaseUrl(input.baseUrl);
  // No usable origin ⇒ no stub URL can be built. The event's own poster is
  // already absolute (a public object URL), so it still stands.
  if (!base) return input.event.heroImageUrl ?? null;

  return resolveEventOgImage(
    {
      id: input.event.id,
      slug: input.event.slug ?? "",
      title: input.event.title,
      startsAt: input.event.startsAt,
      timezone: input.event.timezone ?? null,
      updatedAt: input.event.updatedAt ?? null,
      images: input.event.heroImageUrl ? [input.event.heroImageUrl] : [],
      venueName: input.event.venueName ?? null,
    },
    base,
  ).url;
}
