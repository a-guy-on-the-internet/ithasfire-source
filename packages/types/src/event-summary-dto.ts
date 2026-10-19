/**
 * Serialisation-friendly event summary DTO.
 *
 * This is the canonical shape returned by event-listing tRPC procedures.
 * UI components (e.g. `EventCard`, `EventGrid`) accept this shape directly
 * so the client never needs to re-map backend responses.
 *
 * Structurally compatible with `EventSummary` from `@th/ui`.
 */
import { z } from "zod";

import type { ListingPrice } from "./money";

export const eventBadgeToneSchema = z.enum(["promo", "hot", "cold", "default"]);
export type EventBadgeTone = z.infer<typeof eventBadgeToneSchema>;

export const eventSummaryMediaSchema = z.object({
  url: z.string(),
  alt: z.string(),
  aspectRatio: z.number().optional(),
});
export type EventSummaryMedia = z.infer<typeof eventSummaryMediaSchema>;

/**
 * Wire schema for a structured listing price (`ListingPrice` in `./money`,
 * decided by `resolveListingPrice`). Carried beside the English `priceLabel`
 * so web renderers can word it in the viewer's language instead of
 * string-matching English.
 */
export const listingPriceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("free") }).strict(),
  z.object({ kind: z.literal("freePlus") }).strict(),
  z.object({ kind: z.literal("payWhatYouWant") }).strict(),
  z
    .object({
      kind: z.literal("amount"),
      cents: z.number().int().positive(),
      currency: z.string().min(3).max(3),
      from: z.boolean(),
    })
    .strict(),
]);

// Compile-time check that the wire schema and the domain type cannot drift.
type _ListingPriceSchemaMatches = [
  z.infer<typeof listingPriceSchema>,
] extends [ListingPrice]
  ? [ListingPrice] extends [z.infer<typeof listingPriceSchema>]
    ? true
    : never
  : never;
const _listingPriceSchemaMatches: _ListingPriceSchemaMatches = true;
void _listingPriceSchemaMatches;

export const eventSummaryDtoSchema = z.object({
  id: z.string(),
  title: z.string(),
  date: z.string(),
  venue: z.string(),
  /**
   * The listing price in ENGLISH ("$28.62", "Free", "Free+",
   * "Pay what you want", "See details"). Native apps print it as is.
   */
  priceLabel: z.string(),
  /**
   * The same listing price as data (`resolveListingPrice`). Web renderers word
   * it in the viewer's language and prefer it over `priceLabel`. `null` = no
   * price to show (the "See details" case). Absent = the producer did not
   * compute one; render `priceLabel`.
   */
  listingPrice: listingPriceSchema.nullable().optional(),
  /**
   * True when the event is genuinely free (no paid tiers — RSVP or free-only
   * admission). Structured signal so the price badge can use the amber support
   * variant without string-matching the localized `priceLabel`. Optional:
   * absent shapes read as paid (the badge stays accent).
   */
  isFree: z.boolean().optional(),
  slug: z.string().nullable().optional(),
  media: eventSummaryMediaSchema.optional(),
  badge: z
    .object({
      text: z.string(),
      tone: eventBadgeToneSchema.optional(),
    })
    .optional(),
  favorite: z.boolean().optional(),
  /** Event gate type — PASSWORD, APPLICATION, or NONE (omitted when NONE). */
  gateType: z.enum(["NONE", "PASSWORD", "APPLICATION"]).optional(),
  /** Distance from the viewer in kilometres (set when user location is available). */
  distanceKm: z.number().nonnegative().optional(),
  /** ISO 8601 datetime string for the event start (useful for client-side filtering). */
  startsAt: z.string().optional(),
  /**
   * The event's IANA zone (`Event.timezone`), the zone `date` was formatted
   * in. The card derives its stamp, stub and start time from `startsAt` in
   * this zone, so server and browser print the same text. The DB-backed
   * mappers and the search-backed `discoveredEventToDto` (from the indexed
   * `timezone`) send it, so the stamp agrees with `date`. Absent (a producer
   * with no zone, or a search document indexed before the zone was stored) →
   * the card uses `DEFAULT_VENUE_TIMEZONE`.
   */
  timezone: z.string().nullable().optional(),
  /** Tags / categories attached to the event. */
  tags: z.array(z.string()).optional(),
  /** Discriminator for unified lists — "event" for published, "scraped" for community-sourced. */
  kind: z.enum(["event", "scraped"]).optional(),
  /**
   * True when the event repeats on a recurrence schedule (a single Event that
   * surfaces as one recurring card, e.g. a weekly open mic). Optional — omitted
   * or false reads as non-recurring, leaving single-date cards unchanged.
   */
  isRecurring: z.boolean().optional(),
});

export type EventSummaryDto = z.infer<typeof eventSummaryDtoSchema>;
