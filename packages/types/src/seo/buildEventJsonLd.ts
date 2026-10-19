import { DateTime } from "luxon";

import type { EventStatus } from "../repos/events";
import { isValidEventSchemaType } from "./eventSchemaTypes";
import type { SeoEvent } from "./types";

const EVENT_STATUS_MAP: Partial<Record<EventStatus, string>> = {
  DRAFT: "https://schema.org/EventScheduled",
  PUBLISHED: "https://schema.org/EventScheduled",
  ARCHIVED: "https://schema.org/EventScheduled",
  CANCELLED: "https://schema.org/EventCancelled",
  COMPLETED: "https://schema.org/EventScheduled",
};

const OFFER_AVAILABILITY_MAP = {
  in_stock: "https://schema.org/InStock",
  limited: "https://schema.org/LimitedAvailability",
  sold_out: "https://schema.org/SoldOut",
  preorder: "https://schema.org/PreOrder",
} as const;

type OfferAvailabilityKey = keyof typeof OFFER_AVAILABILITY_MAP;

const centsToDecimalString = (
  value: number | undefined,
): string | undefined => {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return (value / 100).toFixed(2);
};

/**
 * Format a date as an ISO 8601 string carrying the event's local UTC offset
 * (e.g. `2026-07-02T19:00:00-05:00`) so Google renders the venue-local time.
 *
 * Falls back to UTC (`.toISOString()`) when the timezone is absent or invalid.
 * Never throws.
 */
const formatVenueLocalDate = (
  date: Date,
  timezone: string | null | undefined,
): string => {
  if (timezone) {
    const zoned = DateTime.fromJSDate(date, { zone: timezone });
    if (zoned.isValid) {
      const iso = zoned.toISO({
        suppressMilliseconds: true,
        includeOffset: true,
      });
      if (iso) return iso;
    }
  }
  return date.toISOString();
};

export type EventJsonLd = Record<string, unknown>;

/**
 * `Place.name` for the JSON-LD location. Google flags a `location` with no
 * `name`, and most community listings arrive without one: the place's own
 * name is DISCLOSURE-GATED upstream (`buildEventSeo` names it only for a
 * confirmed, directory-listed place, or as plain text for a community listing
 * the owner ruling allows), and that gate must not be widened here.
 *
 * So the fallback reads ONLY values already public in this same location
 * object, each of which the page itself shows:
 *
 *   1. the gated `name`, when upstream allowed one;
 *   2. `areaLabel`, for an approximate (`isExact === false`) location, the
 *      coarse label the page renders in place of the address;
 *   3. the joined street address (already emitted as `streetAddress`);
 *   4. the city (already emitted as `addressLocality`).
 *
 * An OBSCURED location carries no street and no city (core nulls them), so it
 * can never name more than its area label. Never pulls a name from anywhere
 * but this object.
 */
const locationDisplayName = (input: {
  name?: string;
  isExact?: boolean;
  areaLabel?: string | null;
  streetAddress?: string;
  city?: string;
}): string | undefined => {
  const pick = (value: string | null | undefined) => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
  };
  return (
    pick(input.name) ??
    (input.isExact === false ? pick(input.areaLabel) : undefined) ??
    pick(input.streetAddress) ??
    pick(input.city)
  );
};

export const buildEventJsonLd = (event: SeoEvent): EventJsonLd => {
  const statusUrl = EVENT_STATUS_MAP[event.status];

  const base: EventJsonLd = {
    "@context": "https://schema.org",
    // Data-driven per category (Category.seoType). A music category emits
    // `MusicEvent` (a schema.org/Event subtype — strictly additive for SEO);
    // any unknown/absent value falls back to the plain `Event`. Validated at
    // this sink against the shared allowlist so a bad DB value can never leak
    // an unrecognised @type into the JSON-LD.
    "@type": isValidEventSchemaType(event.seoType) ? event.seoType : "Event",
    name: event.name,
    startDate: formatVenueLocalDate(event.startsAt, event.timezone),
    url: event.url,
  };

  if (statusUrl) {
    base.eventStatus = statusUrl;
  }

  if (event.endsAt) {
    base.endDate = formatVenueLocalDate(event.endsAt, event.timezone);
  }

  if (event.description) {
    base.description = event.description;
  }

  if (event.updatedAt) {
    base.dateModified = event.updatedAt.toISOString();
  }

  if (event.images.length > 0) {
    base.image = event.images;
  }

  if (event.location) {
    const {
      name,
      addressLine1,
      addressLine2,
      city,
      region,
      postalCode,
      countryCode,
      latitude,
      longitude,
      isExact,
      radiusMeters,
      areaLabel,
    } = event.location;
    const hasAddress = Boolean(
      addressLine1 ||
      addressLine2 ||
      city ||
      region ||
      postalCode ||
      countryCode,
    );
    const location: Record<string, unknown> = {
      "@type": "Place",
    };

    const streetAddress =
      [addressLine1, addressLine2]
        .filter((part): part is string => Boolean(part))
        .join(", ") || undefined;
    const placeName = locationDisplayName({
      name,
      isExact,
      areaLabel,
      streetAddress,
      city,
    });
    if (placeName) location.name = placeName;
    if (hasAddress) {
      location.address = {
        "@type": "PostalAddress",
        ...(streetAddress ? { streetAddress } : {}),
        ...(city ? { addressLocality: city } : {}),
        ...(region ? { addressRegion: region } : {}),
        ...(postalCode ? { postalCode } : {}),
        ...(countryCode ? { addressCountry: countryCode } : {}),
      };
    }
    if (typeof latitude === "number" && typeof longitude === "number") {
      if (isExact === false) {
        // Obscured location: the coordinates are a deliberately-offset point
        // (see redactLocation), NOT the venue. Emitting sharp GeoCoordinates
        // would let crawlers index a precise pin at a wrong point, so emit a
        // schema.org GeoCircle instead (GeoCircle is a GeoShape subtype;
        // Place.geo accepts GeoCoordinates | GeoShape). Fully-hidden events
        // carry no lat/lng at all and therefore emit no geo.
        location.geo = {
          "@type": "GeoCircle",
          geoMidpoint: {
            "@type": "GeoCoordinates",
            latitude,
            longitude,
          },
          ...(typeof radiusMeters === "number" && Number.isFinite(radiusMeters)
            ? { geoRadius: radiusMeters }
            : {}),
        };
      } else {
        location.geo = {
          "@type": "GeoCoordinates",
          latitude,
          longitude,
        };
      }
    }

    base.location = location;
  }

  if (event.organizer && (event.organizer.name || event.organizer.url)) {
    base.organizer = {
      "@type": "Organization",
      ...(event.organizer.name ? { name: event.organizer.name } : {}),
      ...(event.organizer.url ? { url: event.organizer.url } : {}),
    };
  }

  if (event.performers.length > 0) {
    base.performer = event.performers.map((p) => ({
      "@type": "Person",
      name: p.name,
      ...(p.url ? { url: p.url } : {}),
    }));
  }

  // Google rejects an AggregateOffer that has no price, so only emit the
  // AggregateOffer when there is a POSITIVE low price. A genuinely free event
  // (community/RSVP listing with no pricing, or a ticketed event priced at $0)
  // instead gets a single free Offer so it still qualifies for richer Google
  // event results. Exactly one of the two is emitted — never both.
  // When the offer became available. `pricing.validFrom` is the ticket
  // sales opening (`buildEventSeo`); an event with no pricing block (an RSVP
  // listing) has been available since it went live.
  const validFrom = event.pricing?.validFrom ?? event.publishedAt ?? null;
  const validFromJsonLd =
    validFrom && !Number.isNaN(validFrom.getTime())
      ? { validFrom: validFrom.toISOString() }
      : {};

  const minPriceCents = event.pricing?.minPriceCents;
  const hasPaidPrice = typeof minPriceCents === "number" && minPriceCents > 0;
  const lowPrice = hasPaidPrice
    ? centsToDecimalString(minPriceCents)
    : undefined;
  if (event.pricing && lowPrice) {
    const availabilityKey = event.pricing.availability as OfferAvailabilityKey;
    const highPrice = centsToDecimalString(event.pricing.maxPriceCents);
    base.offers = {
      "@type": "AggregateOffer",
      priceCurrency: event.pricing.currency,
      lowPrice,
      ...(highPrice ? { highPrice } : {}),
      availability:
        OFFER_AVAILABILITY_MAP[availabilityKey] ??
        OFFER_AVAILABILITY_MAP.in_stock,
      ...validFromJsonLd,
      ...(event.ticketingUrl
        ? { url: event.ticketingUrl }
        : { url: event.url }),
    };
  } else if (!event.pricing || minPriceCents === 0) {
    // Honor availability/validFrom when present (e.g. a $0 ticketed event that
    // sold out), for parity with the AggregateOffer branch. Community/RSVP
    // listings have no pricing block, so they default to InStock and take
    // `validFrom` from `publishedAt`.
    const freeAvailabilityKey = event.pricing?.availability as
      | OfferAvailabilityKey
      | undefined;
    base.offers = {
      "@type": "Offer",
      price: "0",
      priceCurrency: event.pricing?.currency ?? "USD",
      availability:
        (freeAvailabilityKey && OFFER_AVAILABILITY_MAP[freeAvailabilityKey]) ??
        OFFER_AVAILABILITY_MAP.in_stock,
      ...validFromJsonLd,
      url: event.ticketingUrl ?? event.url,
    };
  }

  // This platform has no online events; a missing location is incomplete venue
  // data, not an online event. Always mark events as in-person.
  base.eventAttendanceMode = "https://schema.org/OfflineEventAttendanceMode";

  return base;
};
