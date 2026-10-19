import type { SeoEvent, SeoLocation, SeoPricing } from "@th/types/seo/types";
import { formatPriceCents } from "@th/types/money";
import { formatEventDate, formatEventTimeRange } from "@th/locale";

export const formatEventDateTime = (value: Date, locale = "en-US"): string =>
  formatEventDate(value, { locale });

export const buildScheduleLabel = (event: SeoEvent, locale = "en-US"): string =>
  formatEventTimeRange(event.startsAt, event.endsAt ?? null, {
    locale,
    collapseSameDay: false,
  });

export const buildAddressLines = (
  location: SeoLocation | undefined,
): string[] => {
  if (!location) {
    return [];
  }

  const cityRegion = [location.city, location.region]
    .filter(Boolean)
    .join(", ");

  return [
    location.addressLine1,
    location.addressLine2,
    cityRegion || null,
    location.postalCode,
    location.countryCode,
  ].filter((line): line is string => Boolean(line?.trim().length));
};

/**
 * SEO / JSON-LD price rendering. Delegates to the canonical COMPACT price
 * helper in `@th/types/money`, which owns the zero-decimal set and its own
 * `Intl.NumberFormat` cache — this file used to carry a fourth private copy of
 * both. Output is unchanged (`minimumFractionDigits: 0` with the currency's
 * digits as the max is exactly the compact contract).
 *
 * CURRENCY IS REAL HERE: `SeoPricing.currency` comes off the event.
 */
const formatPrice = (
  value: number,
  currency: string,
  locale = "en-US",
): string => formatPriceCents(value, { currency, locale });

export const buildPriceLabel = (
  pricing: SeoPricing | undefined,
  locale = "en-US",
): string | null => {
  if (!pricing) {
    return null;
  }

  const minPriceCents = pricing.minBuyerTotalCents ?? pricing.minPriceCents;
  const maxPriceCents = pricing.maxBuyerTotalCents ?? pricing.maxPriceCents;
  const { currency } = pricing;

  if (
    typeof minPriceCents === "number" &&
    typeof maxPriceCents === "number" &&
    minPriceCents === maxPriceCents
  ) {
    return formatPrice(minPriceCents, currency, locale);
  }

  if (typeof minPriceCents === "number" && typeof maxPriceCents === "number") {
    return `${formatPrice(minPriceCents, currency, locale)} – ${formatPrice(maxPriceCents, currency, locale)}`;
  }

  if (typeof minPriceCents === "number") {
    return `From ${formatPrice(minPriceCents, currency, locale)}`;
  }

  if (typeof maxPriceCents === "number") {
    return `Up to ${formatPrice(maxPriceCents, currency, locale)}`;
  }

  return null;
};

export const formatAvailabilityLabel = (
  pricing: SeoPricing | undefined,
): string | null => {
  if (!pricing?.availability) {
    return null;
  }
  return pricing.availability.replace(/_/g, " ");
};

export type EventDetail = SeoEvent;
export type EventPricing = SeoPricing | undefined;
