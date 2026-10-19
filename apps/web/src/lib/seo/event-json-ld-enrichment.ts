import type { SeoEvent, SeoOrganizer } from "@th/types/seo/types";

/**
 * What the web app adds to an event's schema.org JSON-LD that neither
 * `@th/core` nor `@th/types` can produce, because both need THIS app's
 * absolute site URL. Built on the server (`buildEventJsonLdEnrichment` in
 * `server/event-json-ld-enrichment.ts`) and carried to the page in
 * `EventPageData`; this module is the client-safe half (type + merge).
 *
 * STRUCTURED DATA ONLY. Neither value is rendered on the page: the poster is
 * `event.images`, which the stub never joins, and the visible "Presented by"
 * badge reads `organizerName`/`organizerHref`.
 */
export type EventJsonLdEnrichment = {
  /**
   * `{ name, url: <site>/orgs/<slug> }` for an event with an org; null for an
   * ownerless community listing. Never invented from the place or the site.
   */
  organizer: SeoOrganizer | null;
  /**
   * The generated Date Stub URL, the same one the page's `og:image` names.
   * Null when the event has a poster of its own, and on surfaces that must
   * not name the stub (a gated event's unlocked view).
   */
  fallbackImageUrl: string | null;
};

/**
 * The event as the JSON-LD builder should see it: `organizer` filled from the
 * enrichment when the payload has none, and `images` falling back to the stub
 * only when the event has no image. Returns a NEW object; the page's own event
 * (rendered as the poster) is never touched.
 */
export const applyEventJsonLdEnrichment = (
  event: SeoEvent,
  enrichment: EventJsonLdEnrichment | null | undefined,
): SeoEvent => {
  if (!enrichment) return event;
  const organizer = event.organizer ?? enrichment.organizer ?? undefined;
  const images =
    event.images.length === 0 && enrichment.fallbackImageUrl
      ? [enrichment.fallbackImageUrl]
      : event.images;
  if (organizer === event.organizer && images === event.images) return event;
  return { ...event, organizer, images };
};
