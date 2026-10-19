import type { Metadata } from "next";
import type { EventStatus } from "../repos/events";
import type { SeoEvent } from "./types";

const placeLabel = (event: SeoEvent): string | undefined => {
  const city = event.location?.city?.trim();
  if (!city) return undefined;
  const region = event.location?.region?.trim();
  return region ? `${city}, ${region}` : city;
};

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whole-word, case-insensitive: "Salem" is not inside "Jerusalem". */
const nameContainsCity = (name: string, city: string): boolean =>
  new RegExp(
    `(^|[^\\p{L}\\p{M}\\p{N}])${escapeRegExp(city.normalize("NFC"))}($|[^\\p{L}\\p{M}\\p{N}])`,
    "iu",
  ).test(name.normalize("NFC"));

/**
 * `<name> · <City>, <Region>` so a search for "open mic Nashville" can match a
 * single event page. Skipped when the name already says the city. No category
 * here: titles truncate near 60 characters.
 */
const buildTitle = (event: SeoEvent): string => {
  const label = placeLabel(event);
  const city = event.location?.city?.trim();
  if (!label || !city) return event.name;
  if (nameContainsCity(event.name, city)) return event.name;
  return `${event.name} · ${label}`;
};

/**
 * "Thu, Oct 15, 9:00 PM" in the event's own timezone. With no (or an invalid)
 * timezone the time is omitted and the date is the UTC date, never the
 * server's local one.
 */
const formatStart = (event: SeoEvent, now: Date): string | undefined => {
  if (Number.isNaN(event.startsAt.valueOf())) return undefined;
  // ICU 72+ puts U+202F before AM/PM; normalise so output is the same on any ICU.
  const clean = (value: string): string =>
    value.replace(/[\u202f\u00a0]/g, " ");
  const build = (timeZone: string, withTime: boolean): string => {
    const yearOf = (d: Date): string =>
      new Intl.DateTimeFormat("en-US", { year: "numeric", timeZone }).format(d);
    const options: Intl.DateTimeFormatOptions = {
      weekday: "short",
      month: "short",
      day: "numeric",
      ...(yearOf(event.startsAt) !== yearOf(now) ? { year: "numeric" } : {}),
      ...(withTime ? { hour: "numeric", minute: "2-digit" } : {}),
      timeZone,
    };
    return clean(
      new Intl.DateTimeFormat("en-US", options).format(event.startsAt),
    );
  };
  if (event.timezone) {
    try {
      return build(event.timezone, true);
    } catch {
      // Unknown timezone id: fall through to the UTC date.
    }
  }
  return build("UTC", false);
};

const fallbackDescription = (event: SeoEvent, now: Date): string => {
  if (event.description) return event.description;
  const kind = event.categoryName?.trim() || "Event";
  const label = placeLabel(event);
  const when = formatStart(event, now);
  return `${kind}${label ? ` in ${label}` : ""}${when ? ` on ${when}` : ""}.`;
};

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
  if (typeof value !== "number" || Number.isNaN(value)) return undefined;
  return (value / 100).toFixed(2);
};

const isValidDate = (value: unknown): value is Date =>
  value instanceof Date && !Number.isNaN(value.valueOf());

export interface BuildEventMetadataOptions {
  event: SeoEvent;
  siteName?: string;
  /** Performer name resolved from a ?ref= referral param. Personalises OG description. */
  refPerformerName?: string;
  /** Reference "now" for the description's year rule. Tests pass it. */
  now?: Date;
}

export const buildEventMetadata = ({
  event,
  siteName,
  refPerformerName,
  now = new Date(),
}: BuildEventMetadataOptions): Metadata => {
  const description = refPerformerName
    ? `See ${refPerformerName} at ${event.name}`
    : fallbackDescription(event, now);
  const title = buildTitle(event);

  const sharedImages = event.images.map((url) => ({ url, alt: event.name }));
  const statusUrl = EVENT_STATUS_MAP[event.status];
  const attendanceMode = event.location
    ? "https://schema.org/OfflineEventAttendanceMode"
    : "https://schema.org/OnlineEventAttendanceMode";

  const other: Record<string, string | string[]> = {
    "event:id": event.id,
    "event:slug": event.slug,
    "event:url": event.url,
    "event:status": event.status,
    "event:start": event.startsAt.toISOString(),
    "event:attendance-mode": attendanceMode,
  };

  if (statusUrl) {
    other["event:status:url"] = statusUrl;
  }

  if (typeof description === "string" && description.length > 0) {
    other["event:description"] = description;
  }

  if (isValidDate(event.endsAt)) {
    other["event:end"] = event.endsAt.toISOString();
  }

  if (isValidDate(event.updatedAt)) {
    other["event:updated"] = event.updatedAt.toISOString();
  }

  if (event.ticketingUrl) {
    other["event:ticketing:url"] = event.ticketingUrl;
  }

  if (sharedImages.length > 0) {
    const firstImage = sharedImages[0];
    if (firstImage) {
      other["event:image"] = firstImage.url;
    }
    other["event:images"] = event.images;
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
    } = event.location;
    if (name) {
      other["event:location:name"] = name;
    }

    const streetSegments = [addressLine1, addressLine2].filter(
      (segment): segment is string => Boolean(segment),
    );
    if (streetSegments.length > 0) {
      other["event:location:street"] = streetSegments.join(", ");
    }

    if (city) {
      other["event:location:city"] = city;
    }

    if (region) {
      other["event:location:region"] = region;
    }

    if (postalCode) {
      other["event:location:postal-code"] = postalCode;
    }

    if (countryCode) {
      other["event:location:country"] = countryCode;
    }

    if (typeof latitude === "number" && Number.isFinite(latitude)) {
      other["event:location:latitude"] = latitude.toString();
    }

    if (typeof longitude === "number" && Number.isFinite(longitude)) {
      other["event:location:longitude"] = longitude.toString();
    }
  }

  if (event.organizer) {
    if (event.organizer.name) {
      other["event:organizer:name"] = event.organizer.name;
    }
    if (event.organizer.url) {
      other["event:organizer:url"] = event.organizer.url;
    }
  }

  if (event.performers.length > 0) {
    const performerNames = event.performers.map((p) => p.name);
    other["event:performers"] = performerNames;
    other["event:performer-count"] = performerNames.length.toString();
  }

  if (refPerformerName) {
    other["event:ref-performer"] = refPerformerName;
  }

  if (event.pricing) {
    const availabilityKey = event.pricing.availability as OfferAvailabilityKey;
    const lowPrice = centsToDecimalString(event.pricing.minPriceCents);
    const highPrice = centsToDecimalString(event.pricing.maxPriceCents);
    const availability =
      OFFER_AVAILABILITY_MAP[availabilityKey] ??
      OFFER_AVAILABILITY_MAP.in_stock;
    other["event:offers:currency"] = event.pricing.currency;
    if (lowPrice) {
      other["event:offers:low-price"] = lowPrice;
    }
    if (highPrice) {
      other["event:offers:high-price"] = highPrice;
    }
    other["event:offers:availability"] = availability;
    if (isValidDate(event.pricing.validFrom)) {
      other["event:offers:valid-from"] = event.pricing.validFrom.toISOString();
    }
    other["event:offers:url"] = event.ticketingUrl ?? event.url;
  }

  return {
    title,
    description,
    alternates: {
      canonical: event.url,
    },
    openGraph: {
      type: "website",
      url: event.url,
      title,
      description,
      ...(siteName ? { siteName } : {}),
      ...(sharedImages.length > 0 ? { images: sharedImages } : {}),
    },
    twitter: {
      card: sharedImages.length > 0 ? "summary_large_image" : "summary",
      title,
      description,
      ...(sharedImages.length > 0 ? { images: sharedImages } : {}),
    },
    ...(isValidDate(event.updatedAt) ? { lastModified: event.updatedAt } : {}),
    other,
  } satisfies Metadata;
};
