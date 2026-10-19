import { z } from "zod";

import type { EventSuggestion } from "@th/ports/search/multi-index.types";

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 50;
export const DEFAULT_RADIUS_KM = 50;
export const MAX_RADIUS_KM = 500;

export const eventResultSchema = z.object({
  id: z.string(),
  eventId: z.string(),
  title: z.string(),
  subtitle: z.string().nullable(),
  helper: z.string().nullable(),
  slug: z.string().nullable(),
  startsAt: z.date().nullable(),
  /**
   * `Event.timezone` (IANA) from the search document, the zone `helper` was
   * formatted in. Null on a document indexed before the field existed; the
   * card mapper then falls back to the platform default.
   */
  timezone: z.string().nullable().default(null),
  imageUrl: z.string().nullable(),
  paidTierCount: z.number().int().min(0).default(0),
  hasFreeTier: z.boolean().default(false),
  /** A floor-0 pay-what-you-want tier is on sale ("Pay what you want"). */
  hasPayWhatYouWantTier: z.boolean().default(false),
  minPaidPriceCents: z.number().int().min(0).nullable().default(null),
  /**
   * Lowest fee-inclusive buyer total in cents (gross + platform fee + processor
   * fee + admission tax), sourced from the search index. Null when the event was
   * indexed without a buyer total. The card badge prefers this over
   * `minPaidPriceCents` when present and plausible; otherwise it degrades to the
   * face-value label rather than render a suspect figure.
   */
  lowestBuyerTotalCents: z.number().int().min(0).nullable().default(null),
});

export type DiscoveredEvent = z.infer<typeof eventResultSchema>;

export function mapEventSuggestions(
  suggestions: EventSuggestion[],
): DiscoveredEvent[] {
  return suggestions.map((e) => ({
    id: e.id,
    eventId: e.eventId,
    title: e.title,
    subtitle: e.subtitle,
    helper: e.helper,
    slug: e.slug,
    startsAt: e.startsAt,
    timezone: e.timezone ?? null,
    imageUrl: e.imageUrl,
    paidTierCount: e.paidTierCount ?? 0,
    hasFreeTier: e.hasFreeTier ?? false,
    hasPayWhatYouWantTier: e.hasPayWhatYouWantTier ?? false,
    minPaidPriceCents:
      e.lowestPriceCents != null && e.lowestPriceCents > 0
        ? e.lowestPriceCents
        : null,
    lowestBuyerTotalCents:
      e.lowestBuyerTotalCents != null && e.lowestBuyerTotalCents > 0
        ? e.lowestBuyerTotalCents
        : null,
  }));
}
