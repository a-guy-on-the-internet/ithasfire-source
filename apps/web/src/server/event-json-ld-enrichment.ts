import "server-only";

import { pickHeroImageUrl } from "@th/types/seo/eventOgImage";

import { buildCanonicalUrl } from "@/config/site";
import type { EventJsonLdEnrichment } from "@/lib/seo/event-json-ld-enrichment";
import type { PublicEventSeo } from "@/server/events";
import {
  eventOgImageInputFor,
  resolveEventOgImageForSite,
} from "@/server/og/event-og-image";

export type EventJsonLdEnrichmentOptions = {
  /**
   * Whether the JSON-LD may name the generated Date Stub when the event has no
   * poster. TRUE only for the edge-cached public render, where the same stub
   * is already the page's `og:image`. FALSE for a gated event's unlocked view:
   * the gated page's head deliberately never names the stub (it draws the
   * place into a publicly cached PNG), and no crawler reads that view anyway.
   */
  generatedImage: boolean;
};

/**
 * Builds the JSON-LD additions that need this app's site URL (see
 * {@link EventJsonLdEnrichment}).
 *
 * - `organizer`: from the org behind the visible "Presented by" badge
 *   (`organizerName` + `organizerHref`, the `/orgs/<slug>` page), made
 *   absolute. No org (an ownerless community listing) means no organizer:
 *   never the place, never the site.
 * - `fallbackImageUrl`: the SAME stub `generateMetadata` puts in `og:image`
 *   (one `EventOgImageInput` builder, one resolver), only when the event has
 *   no image of its own.
 */
export const buildEventJsonLdEnrichment = (
  event: PublicEventSeo,
  canonicalSlug: string,
  options: EventJsonLdEnrichmentOptions,
): EventJsonLdEnrichment => {
  const organizerName = event.organizerName?.trim();
  const organizer =
    organizerName && event.organizerHref
      ? { name: organizerName, url: buildCanonicalUrl(event.organizerHref) }
      : null;

  const fallbackImageUrl =
    options.generatedImage && !pickHeroImageUrl(event.images)
      ? resolveEventOgImageForSite(eventOgImageInputFor(event, canonicalSlug))
          .url
      : null;

  return { organizer, fallbackImageUrl };
};
