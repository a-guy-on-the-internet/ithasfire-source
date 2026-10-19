import type {
  SeoEvent,
  SeoEventInput,
  SeoLocation,
  SeoOfferAvailability,
  SeoPerformer,
  SeoPricing,
} from "./types";

const DEFAULT_AVAILABILITY: SeoOfferAvailability = "in_stock";

const normalizeString = (
  value: string | null | undefined,
): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const normalizeUrl = (value: string | null | undefined): string | undefined => {
  const normalized = normalizeString(value);
  if (!normalized) return undefined;
  try {
    // eslint-disable-next-line no-new
    new URL(normalized);
    return normalized;
  } catch {
    return normalized;
  }
};

/** A usable Date, or null: an Invalid Date would throw at `toISOString()`. */
const normalizeDate = (value: Date | null | undefined): Date | null =>
  value instanceof Date && !Number.isNaN(value.getTime()) ? value : null;

const sanitizeImages = (
  images: Iterable<string | null | undefined> | null | undefined,
): string[] => {
  if (!images) return [];
  const unique = new Set<string>();
  for (const candidate of images) {
    const normalized = normalizeUrl(candidate);
    if (!normalized) continue;
    unique.add(normalized);
  }
  return Array.from(unique);
};

const normalizeLocation = (
  input: SeoEventInput["location"],
): SeoLocation | undefined => {
  if (!input) return undefined;
  const name = normalizeString(input.name ?? null);
  const addressLine1 = normalizeString(input.addressLine1 ?? null);
  const addressLine2 = normalizeString(input.addressLine2 ?? null);
  const city = normalizeString(input.city ?? null);
  const region = normalizeString(input.region ?? null);
  const postalCode = normalizeString(input.postalCode ?? null);
  const countryCode = normalizeString(input.countryCode ?? null)?.toUpperCase();
  const latitude =
    typeof input.latitude === "number" && Number.isFinite(input.latitude)
      ? input.latitude
      : undefined;
  const longitude =
    typeof input.longitude === "number" && Number.isFinite(input.longitude)
      ? input.longitude
      : undefined;

  if (
    !name &&
    !addressLine1 &&
    !city &&
    !region &&
    !postalCode &&
    !countryCode &&
    latitude === undefined &&
    longitude === undefined
  ) {
    return undefined;
  }

  const location: SeoLocation = {};
  if (name) location.name = name;
  if (addressLine1) location.addressLine1 = addressLine1;
  if (addressLine2) location.addressLine2 = addressLine2;
  if (city) location.city = city;
  if (region) location.region = region;
  if (postalCode) location.postalCode = postalCode;
  if (countryCode) location.countryCode = countryCode;
  if (latitude !== undefined) location.latitude = latitude;
  if (longitude !== undefined) location.longitude = longitude;
  if (typeof input.isExact === "boolean") location.isExact = input.isExact;
  if (input.radiusMeters != null) location.radiusMeters = input.radiusMeters;
  if (input.areaLabel != null) location.areaLabel = input.areaLabel;
  if (input.placeSlug) location.placeSlug = input.placeSlug;
  return location;
};

const normalizePricing = (
  input: SeoEventInput["pricing"],
): SeoPricing | undefined => {
  if (!input) return undefined;
  const currency = normalizeString(input.currency ?? null)?.toUpperCase();
  if (!currency) return undefined;

  const minPriceCents =
    typeof input.minPriceCents === "number" && input.minPriceCents >= 0
      ? Math.floor(input.minPriceCents)
      : undefined;
  const maxPriceCents =
    typeof input.maxPriceCents === "number" && input.maxPriceCents >= 0
      ? Math.floor(input.maxPriceCents)
      : undefined;
  const minBuyerTotalCents =
    typeof input.minBuyerTotalCents === "number" &&
    input.minBuyerTotalCents >= 0
      ? Math.floor(input.minBuyerTotalCents)
      : undefined;
  const maxBuyerTotalCents =
    typeof input.maxBuyerTotalCents === "number" &&
    input.maxBuyerTotalCents >= 0
      ? Math.floor(input.maxBuyerTotalCents)
      : undefined;

  const availability = input.availability ?? DEFAULT_AVAILABILITY;
  const validFrom = input.validFrom ?? undefined;

  return {
    currency,
    minPriceCents,
    maxPriceCents,
    minBuyerTotalCents,
    maxBuyerTotalCents,
    availability,
    validFrom,
  } satisfies SeoPricing;
};

const sanitizePerformers = (
  performers: SeoEventInput["performers"],
): SeoPerformer[] => {
  if (!performers) return [];
  return performers
    .filter((p) => p.name.trim().length > 0)
    .map((p) => ({ ...p, name: p.name.trim() }));
};

export const mapEventToSeo = (input: SeoEventInput): SeoEvent => {
  if (!input || typeof input !== "object") {
    throw new TypeError("input must be an object");
  }

  const { event, canonicalUrl } = input;
  if (!event) {
    throw new TypeError("input.event is required");
  }

  const slug =
    normalizeString(event.slug) ??
    (() => {
      throw new TypeError("event.slug is required");
    })();

  const name =
    normalizeString(event.title) ??
    (() => {
      throw new TypeError("event.title is required");
    })();

  const url =
    normalizeUrl(canonicalUrl) ??
    (() => {
      throw new TypeError("canonicalUrl must be a valid string");
    })();

  const description = normalizeString(event.description ?? null) ?? null;

  const ticketingUrl = normalizeUrl(input.ticketingUrl ?? null) ?? null;

  const images = sanitizeImages(input.images);

  const location = normalizeLocation(input.location);

  const organizer = input.organizer
    ? {
        ...(normalizeString(input.organizer.name ?? null)
          ? { name: normalizeString(input.organizer.name ?? null) }
          : {}),
        ...(normalizeUrl(input.organizer.url ?? null)
          ? { url: normalizeUrl(input.organizer.url ?? null) }
          : {}),
      }
    : undefined;

  const pricing = normalizePricing(input.pricing);

  const performers = sanitizePerformers(input.performers);

  return {
    id: event.id,
    slug,
    url,
    name,
    description,
    startsAt: event.startsAt,
    endsAt: event.endsAt ?? null,
    status: event.status,
    updatedAt: event.updatedAt ?? undefined,
    publishedAt: normalizeDate(event.publishedAt),
    seoType: event.seoType ?? null,
    ticketingUrl,
    images,
    location,
    organizer,
    pricing,
    performers,
  } satisfies SeoEvent;
};
