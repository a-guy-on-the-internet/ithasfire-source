/**
 * Transport-layer mapping helpers: use-case output → EventSummaryDto.
 *
 * These run server-side so the client receives a normalised shape that can be
 * passed directly to `@th/ui` event components (EventCard, EventGrid, etc.)
 * with zero additional mapping.
 */

import { z } from "zod";
import type { EventSummaryDto, EventSummaryMedia } from "@th/types";
// Subpath, not the barrel: this is a RUNTIME import, and `@th/types`'s index
// pulls in luxon/zod/SEO builders that the tRPC server graph has no reason to
// load for a price label. Matches the other formatter call sites.
import {
  isPlausibleIndexedBuyerTotal,
  renderListingPrice,
  resolveListingPrice,
  type ListingPrice,
} from "@th/types/money";
import { resolveTimeZone } from "@th/core/lib/venue-local-time";

// ─────────────────────────────────────────────────────────────────────────────
// Shared formatting helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One formatter per zone. The card's date is in the EVENT's zone: with no
 * `timeZone` Intl uses the server's, UTC on Cloud Run, where a 7pm Chicago
 * show (00:00Z the next day) read "Tue, Oct 13, 12:00 AM" instead of
 * "Mon, Oct 12, 7:00 PM".
 */
const eventDateFormatters = new Map<string, Intl.DateTimeFormat>();

const eventDateFormatterFor = (timeZone: string): Intl.DateTimeFormat => {
  let formatter = eventDateFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    });
    eventDateFormatters.set(timeZone, formatter);
  }
  return formatter;
};

/**
 * `timezone` is `Event.timezone`; an unknown or absent zone falls back to the
 * platform default (`resolveTimeZone`), never to the server's zone.
 */
const formatEventDate = (
  value: string | Date | null,
  timezone?: string | null,
): string => {
  if (!value) return "See details";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return typeof value === "string" ? value : "See details";
  }
  return eventDateFormatterFor(resolveTimeZone(timezone)).format(date);
};

/**
 * The card's one-line venue label, in preference order:
 *
 * 1. `placeName` — the event is at a linked Place, so say "The Blue Room".
 *    A street address is noise when scanning a list; the name is the thing
 *    people recognise. Only events with a `placeId` have one.
 * 2. `addressText` — freeform-address events have no Place to name.
 * 3. `regionCode`, then "Place TBA".
 *
 * `addressText` here is NEVER a raw column. Every shape these mappers accept
 * comes from a use case (or the search index / geo adapters) that already ran
 * it through `projectPublicEventLocation`: the street for an EXACT event, the
 * coarse "locality, region" for anything else — including an event whose
 * venue withholds its address. A new source must do the same; this mapper has
 * no mode to check and must not grow one.
 */
const buildVenueLabel = (
  placeName: string | null | undefined,
  addressText: string | null | undefined,
  regionCode: string | null | undefined,
): string => {
  const named = placeName?.trim();
  if (named) return named;

  const formatted = addressText?.trim();
  if (formatted) return formatted;

  const region = regionCode?.trim();
  if (region) return region.toUpperCase();

  return "Place TBA";
};

const buildMedia = (
  url: string | null | undefined,
  alt: string,
): EventSummaryMedia | undefined => (url ? { url, alt } : undefined);

const DEFAULT_PRICE_LABEL = "See details";

type CardPrice = Pick<EventSummaryDto, "priceLabel" | "listingPrice">;

const toCardPrice = (listingPrice: ListingPrice): CardPrice => ({
  priceLabel: renderListingPrice(listingPrice),
  listingPrice,
});

/** The "we don't know" price: "See details" in English, null as data. */
const NO_CARD_PRICE: CardPrice = {
  priceLabel: DEFAULT_PRICE_LABEL,
  listingPrice: null,
};

/** RSVP attendance: always "Free" (no paid admission, no ticket types). */
const RSVP_CARD_PRICE: CardPrice = toCardPrice({ kind: "free" });

/**
 * CURRENCY: the card price labels below default to USD.
 *
 * Neither the search-index rollup (`build-search-index` → `lowestPriceCents`)
 * nor the DB rollup (`summarizePricing` → `pricingSummarySchema`, which is
 * `.strict()`) carries a currency, and neither `DiscoveredEventShape` nor
 * `LocalEventShape` has one to forward. Threading a real currency here means
 * adding `currency` to `pricingSummarySchema` + `eventLocationSummarySchema`
 * (and the search index document), then plumbing it through the shapes below —
 * a use-case/schema change, deliberately out of scope for this consolidation.
 * The helper is currency-AWARE, so that becomes a one-line change per call site
 * once the field exists.
 */
const PRICE_LABEL_CURRENCY = "USD";

export interface PricingSummary {
  hasFreeTier: boolean;
  /**
   * A floor-0 pay-what-you-want tier is on sale: the card reads "Pay what you
   * want", never "Free" (owner ruling 2026-10-06, F2). Optional so a shape
   * that predates the field reads as `false`.
   */
  hasPayWhatYouWantTier?: boolean;
  paidTierCount: number;
  minPaidPriceCents: number | null;
  /**
   * Lowest ALL-IN buyer total in cents (ticket + platform fee + processing fee
   * + tax, as checkout charges). From the DB rollup (`loadPricingByEventId`)
   * or the search index. A paid card prints THIS figure; when it is null or
   * absent the card says "See details" — never the face price, which would
   * understate the charge (owner ruling 2026-10-02).
   */
  lowestBuyerTotalCents?: number | null;
}

/**
 * Card price, as the English `priceLabel` plus the structured `listingPrice`
 * the web words in the viewer's language. Both come from ONE
 * `resolveListingPrice` call, so they cannot disagree. `listingPrice: null`
 * is the "See details" case.
 *
 * `source: "index"` marks a rollup read from the search index, whose stored
 * total can be stale relative to the face beside it; that total must pass
 * `isPlausibleIndexedBuyerTotal` or the card degrades to "See details". A
 * DB-sourced rollup was computed this request and is used as is.
 */
const cardPrice = (
  pricing: PricingSummary | null | undefined,
  source: "index" | "live" = "live",
): CardPrice => {
  if (!pricing) return NO_CARD_PRICE;
  const { hasFreeTier, paidTierCount, minPaidPriceCents } = pricing;
  let lowestBuyerTotalCents = pricing.lowestBuyerTotalCents ?? null;
  if (
    source === "index" &&
    lowestBuyerTotalCents != null &&
    (minPaidPriceCents == null ||
      !isPlausibleIndexedBuyerTotal(lowestBuyerTotalCents, minPaidPriceCents))
  ) {
    lowestBuyerTotalCents = null;
  }
  const listingPrice = resolveListingPrice({
    hasFreeTier,
    hasPayWhatYouWantTier: pricing.hasPayWhatYouWantTier ?? false,
    paidTierCount,
    minPaidPriceCents,
    lowestBuyerTotalCents,
    currency: PRICE_LABEL_CURRENCY,
  });
  return listingPrice ? toCardPrice(listingPrice) : NO_CARD_PRICE;
};

/**
 * Genuinely free = a free tier with no paid tiers (NOT "Free+", which has
 * paid tiers too, and NOT a floor-0 pay-what-you-want tier, whose label is
 * "Pay what you want"). Drives EventSummaryDto.isFree so the card shows the
 * amber support badge structurally, without string-matching the price label.
 */
const isPricingFree = (
  pricing: PricingSummary | null | undefined,
): boolean =>
  !!pricing &&
  pricing.paidTierCount === 0 &&
  pricing.hasFreeTier &&
  pricing.hasPayWhatYouWantTier !== true;

// ─────────────────────────────────────────────────────────────────────────────
// DiscoveredEvent → EventSummaryDto
// (from Meilisearch: search.nearbyEvents, search.featuredEvents,
//  search.tieredPopularEvents)
// ─────────────────────────────────────────────────────────────────────────────

export interface DiscoveredEventShape {
  id: string;
  eventId: string;
  title: string;
  subtitle: string | null;
  helper: string | null;
  slug: string | null;
  startsAt: Date | null;
  /** `Event.timezone` from the search document. Absent on a document indexed
   *  before the field existed → platform default. */
  timezone?: string | null;
  imageUrl: string | null;
  paidTierCount?: number;
  hasFreeTier?: boolean;
  hasPayWhatYouWantTier?: boolean;
  minPaidPriceCents?: number | null;
  lowestBuyerTotalCents?: number | null;
}

export const discoveredEventToDto = (
  event: DiscoveredEventShape,
): EventSummaryDto => ({
  id: event.eventId,
  title: event.title,
  venue: event.subtitle ?? "Place TBA",
  // `helper` is already in the event's zone (formatted from the indexed
  // `timezone`); the fallback formats in that same zone, or the platform
  // default for a document indexed before the zone was stored, never the
  // server's UTC.
  date: event.helper ?? formatEventDate(event.startsAt, event.timezone),
  // The card stamps its corner date and time in this zone, so it agrees with
  // `date`. Old documents carry none → the same platform default.
  timezone: resolveTimeZone(event.timezone),
  ...cardPrice(
    {
      hasFreeTier: event.hasFreeTier ?? false,
      hasPayWhatYouWantTier: event.hasPayWhatYouWantTier ?? false,
      paidTierCount: event.paidTierCount ?? 0,
      minPaidPriceCents: event.minPaidPriceCents ?? null,
      lowestBuyerTotalCents: event.lowestBuyerTotalCents ?? null,
    },
    "index",
  ),
  isFree: isPricingFree({
    hasFreeTier: event.hasFreeTier ?? false,
    hasPayWhatYouWantTier: event.hasPayWhatYouWantTier ?? false,
    paidTierCount: event.paidTierCount ?? 0,
    minPaidPriceCents: null,
  }),
  slug: event.slug,
  media: buildMedia(event.imageUrl, event.title),
  // Forward the structured start alongside the pre-formatted `date` string, the
  // same way `discoverEventToDto` does. Renderers that need date PARTS rather
  // than a sentence — the LineupRow when-column, which splits the rail into a
  // zero-padded date line over a "FRI · 10 PM" time line — have no way back to
  // them from `helper`, so without this they silently degrade to the whole
  // sentence on one line and lose the time entirely.
  ...(event.startsAt
    ? { startsAt: event.startsAt.toISOString() }
    : {}),
});

/** One rendering of "the instant", shared by every mapper that has one. */
const toIsoInstant = (value: Date | string): string =>
  typeof value === "string" ? value : value.toISOString();

export const discoveredEventsToDto = (
  events: DiscoveredEventShape[],
): EventSummaryDto[] => events.map(discoveredEventToDto);

// ─────────────────────────────────────────────────────────────────────────────
// Country event → EventSummaryDto
// (from DB: events.countryEvents / listEventsByCountry)
// ─────────────────────────────────────────────────────────────────────────────

export interface CountryEventShape {
  eventId: string;
  title: string;
  status: string;
  slug: string | null;
  startsAt: Date;
  /** `Event.timezone`; the card's `date` renders in it. Absent → platform default. */
  timezone?: string | null;
  addressText: string | null;
  /** Venue name when the event is at a linked Place; null for freeform. */
  placeName?: string | null;
  regionCode: string | null;
  heroImageUrl: string | null;
  gateType?: "NONE" | "PASSWORD" | "APPLICATION";
  /**
   * The tier rollup `listEventsByCountry` selects (`pricing:
   * pricingSummarySchema.nullable()`), so the DB fallback quotes the same price
   * the search-backed path does. Optional and nullable to match the sibling
   * shape below; `cardPrice` / `isPricingFree` both take
   * `PricingSummary | null | undefined` and fall back to "See details".
   */
  pricing?: PricingSummary | null;
}

export const countryEventToDto = (
  event: CountryEventShape,
): EventSummaryDto => ({
  id: event.eventId,
  title: event.title,
  venue: buildVenueLabel(event.placeName, event.addressText, event.regionCode),
  date: formatEventDate(event.startsAt, event.timezone),
  // The zone `date` was formatted in, so the card's stamp and time agree
  // with it on the server and in every browser.
  timezone: resolveTimeZone(event.timezone),
  // The DTO's `startsAt` is the machine-readable instant beside the human
  // `date` string. Two of the four mappers here already carried it and two
  // silently dropped it despite holding it, so the same DTO arrived with or
  // without the field depending on which query produced it — and a consumer
  // that needs the instant (the card's corner date stamp) worked on some
  // surfaces and not others.
  startsAt: toIsoInstant(event.startsAt),
  // Was a hardcoded "See details". The query behind this shape now loads the
  // tier rollup, so the DB fallback quotes the same price the search-backed
  // path does — the home grid no longer shows prices only for readers who
  // granted location.
  ...cardPrice(event.pricing),
  isFree: isPricingFree(event.pricing),
  slug: event.slug,
  media: buildMedia(event.heroImageUrl, event.title),
  badge:
    event.status !== "PUBLISHED"
      ? { text: event.status.toLowerCase() }
      : undefined,
  gateType:
    event.gateType && event.gateType !== "NONE" ? event.gateType : undefined,
});

export const countryEventsToDto = (
  events: CountryEventShape[],
): EventSummaryDto[] => events.map(countryEventToDto);

// ─────────────────────────────────────────────────────────────────────────────
// Location (local) event → EventSummaryDto
// (from DB: events.localEvents / listEventsByLocation)
// ─────────────────────────────────────────────────────────────────────────────

export interface LocalEventShape {
  id: string;
  title: string;
  status: string;
  slug: string | null;
  startsAt: Date | string;
  /** `Event.timezone`; the card's `date` renders in it. Absent → platform default. */
  timezone?: string | null;
  addressText: string | null;
  /** Venue name when the event is at a linked Place; null for freeform. */
  placeName?: string | null;
  regionCode: string | null;
  heroImageUrl: string | null;
  gateType?: "NONE" | "PASSWORD" | "APPLICATION";
  pricing?: PricingSummary | null;
  /**
   * TICKETED (money paths) or RSVP (free community attendance). When present and
   * RSVP, the card always reads "Free" — RSVP events have no paid admission and
   * carry no ticket types, so the pricing rollup would otherwise fall back to
   * "See details". Omitted shapes keep the pricing-driven label (no change).
   */
  attendanceMode?: "TICKETED" | "RSVP";
  /**
   * True when the event repeats on a recurrence schedule (a single Event that
   * surfaces as one recurring card). Optional — omitted shapes read as
   * non-recurring, so single-date events are unchanged.
   */
  isRecurring?: boolean;
}

export const localEventToDto = (event: LocalEventShape): EventSummaryDto => ({
  id: event.id,
  title: event.title,
  venue: buildVenueLabel(event.placeName, event.addressText, event.regionCode),
  date: formatEventDate(event.startsAt, event.timezone),
  // The zone `date` was formatted in, so the card's stamp and time agree
  // with it on the server and in every browser.
  timezone: resolveTimeZone(event.timezone),
  ...(event.attendanceMode === "RSVP"
    ? RSVP_CARD_PRICE
    : cardPrice(event.pricing)),
  isFree: event.attendanceMode === "RSVP" || isPricingFree(event.pricing),
  startsAt: toIsoInstant(event.startsAt),
  slug: event.slug ?? null,
  media: buildMedia(event.heroImageUrl, event.title),
  badge:
    event.status !== "PUBLISHED"
      ? { text: event.status.toLowerCase() }
      : undefined,
  gateType:
    event.gateType && event.gateType !== "NONE" ? event.gateType : undefined,
  ...(event.isRecurring ? { isRecurring: true } : {}),
});

export const localEventsToDto = (
  events: LocalEventShape[],
): EventSummaryDto[] => events.map(localEventToDto);

// ─────────────────────────────────────────────────────────────────────────────
// Nearby (geo) event → EventSummaryDto
// (from geo service: events.nearbyEvents / listEventsNearCoordinate)
// ─────────────────────────────────────────────────────────────────────────────

export interface NearbyEventShape {
  id: string;
  title: string;
  addressText?: string | null;
  /** Venue name when the event is at a linked Place; null for freeform. */
  placeName?: string | null;
  lat: number;
  lng: number;
  distanceMeters?: number;
  heroImageUrl?: string | null;
  slug?: string | null;
  /**
   * True when `lat`/`lng` is an OBFUSCATED public point (OBSCURED location
   * mode) rather than the true venue pin (FR-013). The geo adapters emit the
   * coarsened coordinate and this flag together; fully-hidden events never
   * reach this shape (dropped server-side).
   */
  obscured?: boolean;
  /** Obfuscation circle radius in meters — only present when `obscured`. */
  radiusMeters?: number | null;
}

export const nearbyEventToDto = (event: NearbyEventShape): EventSummaryDto => ({
  id: event.id,
  title: event.title,
  venue: event.placeName?.trim() || event.addressText?.trim() || "Nearby",
  date:
    event.distanceMeters != null
      ? `${(event.distanceMeters / 1000).toFixed(1)} km away`
      : "Nearby",
  ...NO_CARD_PRICE,
  slug: event.slug ?? null,
  media: buildMedia(event.heroImageUrl, event.title),
});

export const nearbyEventsToDto = (
  events: NearbyEventShape[],
): EventSummaryDto[] => events.map(nearbyEventToDto);

// ─────────────────────────────────────────────────────────────────────────────
// Nearby event → MapEventDto (lightweight shape for map markers)
// Preserves lat/lng coordinates that the standard DTO intentionally strips.
// ─────────────────────────────────────────────────────────────────────────────

export interface MapEventDto {
  id: string;
  title: string;
  lat: number;
  lng: number;
  venue: string;
  slug: string | null;
  /**
   * True when `lat`/`lng` is an obfuscated (non-exact) public point — the map
   * renders a soft circle/blob instead of a sharp pin (FR-013). Absent/false
   * = exact pin. Fully-hidden events are never in the payload at all.
   */
  obscured?: boolean;
  /** Obfuscation circle radius in meters — only present when `obscured`. */
  radiusMeters?: number | null;
}

export const mapEventDtoSchema = z.object({
  id: z.string(),
  title: z.string(),
  lat: z.number(),
  lng: z.number(),
  venue: z.string(),
  slug: z.string().nullable(),
  obscured: z.boolean().optional(),
  radiusMeters: z.number().positive().optional().nullable(),
});

export const nearbyEventToMapDto = (event: NearbyEventShape): MapEventDto => ({
  id: event.id,
  title: event.title,
  lat: event.lat,
  lng: event.lng,
  venue: event.placeName?.trim() || event.addressText?.trim() || "Nearby",
  slug: event.slug ?? null,
  ...(event.obscured
    ? { obscured: true, radiusMeters: event.radiusMeters ?? null }
    : {}),
});

export const nearbyEventsToMapDto = (
  events: NearbyEventShape[],
): MapEventDto[] => events.map(nearbyEventToMapDto);

// ─────────────────────────────────────────────────────────────────────────────
// Discover event → EventSummaryDto
// (from DB: events.discoverPublic / listPublishedForDiscover)
// Enriched with distance, tags, kind for the unified event list page.
// ─────────────────────────────────────────────────────────────────────────────

export interface DiscoverEventShape {
  id: string;
  title: string;
  status: string;
  slug: string | null;
  startsAt: Date | string;
  /** `Event.timezone`; the card's `date` renders in it. Absent → platform default. */
  timezone?: string | null;
  addressText: string | null;
  /** Venue name when the event is at a linked Place; null for freeform. */
  placeName?: string | null;
  regionCode: string | null;
  heroImageUrl: string | null;
  gateType?: "NONE" | "PASSWORD" | "APPLICATION";
  distanceKm?: number | null;
  tags?: string[];
  /**
   * True when the event repeats on a recurrence schedule. Optional — omitted
   * shapes read as non-recurring, so single-date events are unchanged.
   */
  isRecurring?: boolean;
}

export const discoverEventToDto = (
  event: DiscoverEventShape,
): EventSummaryDto => ({
  id: event.id,
  title: event.title,
  venue: buildVenueLabel(event.placeName, event.addressText, event.regionCode),
  date: formatEventDate(event.startsAt, event.timezone),
  // The zone `date` was formatted in, so the card's stamp and time agree
  // with it on the server and in every browser.
  timezone: resolveTimeZone(event.timezone),
  ...NO_CARD_PRICE,
  slug: event.slug ?? null,
  media: buildMedia(event.heroImageUrl, event.title),
  badge:
    event.status !== "PUBLISHED"
      ? { text: event.status.toLowerCase() }
      : undefined,
  gateType:
    event.gateType && event.gateType !== "NONE" ? event.gateType : undefined,
  ...(event.isRecurring ? { isRecurring: true } : {}),
  distanceKm: event.distanceKm ?? undefined,
  startsAt:
    typeof event.startsAt === "string"
      ? event.startsAt
      : event.startsAt.toISOString(),
  tags: event.tags ?? [],
  kind: "event" as const,
});

export const discoverEventsToDto = (
  events: DiscoverEventShape[],
): EventSummaryDto[] => events.map(discoverEventToDto);
