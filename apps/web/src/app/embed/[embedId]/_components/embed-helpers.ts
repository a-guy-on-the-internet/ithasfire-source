import { resolveTimeZone } from "@th/core/lib/venue-local-time";
import { formatEventDateShort } from "@th/locale";
import {
  formatMoneyCents,
  formatPriceCents,
  renderListingPrice,
  resolveListingPrice,
  type ListingPrice,
} from "@th/types/money";
import type { EventSummary } from "@th/ui";

import { getSiteUrl } from "@/config/site";

import {
  taxRateLabelBps,
  type TaxLineForLabel,
} from "@/lib/pricing/tax-rate-label";
import type { EventItem } from "./embed-types";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

export { FALLBACK_SUPPORT_EMAIL as DEFAULT_SUPPORT_EMAIL } from "@/lib/support-email";

/**
 * The event's page on Ithas Fire, by slug (or id when it has none). Every
 * link out of the widget opens it in a NEW TAB, never in the iframe itself.
 */
export const embedEventUrl = (slugOrId: string): string =>
  `${getSiteUrl()}/events/${slugOrId}`;

/**
 * When set, a Cloudflare Turnstile challenge is required before checkout.
 * Leave unset in dev to skip the challenge entirely.
 */
export const TURNSTILE_SITE_KEY =
  process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? "";

// ─────────────────────────────────────────────────────────────────────────────
// Formatting helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The event's start in the EVENT's own zone (`timezone`, or
 * `DEFAULT_VENUE_TIMEZONE` when absent or unusable), never the renderer's: the
 * server renders in UTC, and everyone going to one show reads the same door
 * time. The same rule as the shared card's stamp (`resolveCardTimeZone`).
 */
export const formatEventDateLabel = (
  date: Date,
  timezone?: string | null,
): string => {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return String(date);
  return formatEventDateShort(d, {
    locale: "en-US",
    timeZone: resolveTimeZone(timezone),
  });
};

/**
 * The place line one event prints in the embed, shared by the List view's
 * cards (`buildVenueLabel` below) and the Calendar view's rows
 * (`embed-calendar-helpers.ts`), so the toggle never shows one event under
 * two names. In preference order:
 *
 * 1. `placeLabel`: the place name, when the read has a public one.
 * 2. `addressText`: the public address (already redacted by core).
 * 3. "locality, region", then the locality alone.
 * 4. `null`: no place to print. A region alone ("TN") is not a place, so it
 *    lands here too.
 *
 * Name, then address: the same order the site's cards use
 * (`event-summary-mapper.ts`), so one event reads the same on the site and in
 * a widget. `placeLabel` may be absent on a stale cached payload. Each view
 * words the `null` case itself.
 */
export const embedPlaceLine = (fields: {
  placeLabel?: string | null;
  addressText: string | null;
  locality: string | null;
  region: string | null;
}): string | null => {
  const placeLabel = fields.placeLabel?.trim();
  if (placeLabel) return placeLabel;
  const addressText = fields.addressText?.trim();
  if (addressText) return addressText;
  const locality = fields.locality?.trim();
  const region = fields.region?.trim();
  if (locality && region) return `${locality}, ${region}`;
  if (locality) return locality;
  return null;
};

/** The card's one-line place label: {@link embedPlaceLine}, else "Place TBA". */
export const buildVenueLabel = (event: EventItem): string =>
  embedPlaceLine(event) ?? "Place TBA";

/**
 * `EventSummary.startsAt` is an ISO string. With it the shared card draws its
 * corner date stamp and prints only the time on the meta line, as site cards
 * do, which leaves the line's room to the place. Undefined for an unreadable
 * date, so the card falls back to the `date` label.
 */
const toSummaryStartsAt = (startsAt: Date): string | undefined => {
  const d = startsAt instanceof Date ? startsAt : new Date(startsAt);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
};

const DEFAULT_PRICE_LABEL = "See details";

const embedCardPrice = (
  listingPrice: ListingPrice | null,
): Pick<EventSummary, "priceLabel" | "listingPrice"> => ({
  priceLabel: listingPrice
    ? renderListingPrice(listingPrice)
    : DEFAULT_PRICE_LABEL,
  listingPrice,
});

/**
 * Embed money formatting. Thin adapter over the canonical COMPACT price helper
 * in `@th/types/money` — the embed used to carry its own `ZERO_DECIMAL` set and
 * its own `Intl` wrapper (alongside a currency-BLIND `formatDollarsFromCents`,
 * three lines away, which is how the same file managed to hold both the bug and
 * its fix). Output is unchanged: `formatPriceCents` applies the same
 * whole-amount fraction trim this did.
 */
export const formatCurrency = (cents: number, currency: string): string =>
  formatPriceCents(cents, { currency, locale: "en-US" });

/**
 * EXACT money (always the currency's cents: "$0.00", "$35.00") for the order
 * breakdown rows. The compact form above suits a price label, but a row of
 * fees and tax mixing "$35" with "$1.95" — and a zero-tax event reading "$0"
 * — is not a breakdown (owner ruling 2026-10-01: zero tax reads $0.00).
 */
export const formatCurrencyExact = (cents: number, currency: string): string =>
  formatMoneyCents(cents, { currency: currency.toUpperCase(), locale: "en-US" });

/**
 * The embed card's price: the shared listing rule (`resolveListingPrice`,
 * owner ruling 2026-10-02: every listing price is the ALL-IN figure, never the
 * face). `lowestBuyerTotalCents` arrives already plausibility-checked by core
 * (`suggestionToEmbedEvent` guards index-sourced totals; the single-event
 * subject is DB-live), so it is NOT re-guarded here. Null means no price
 * ("See details", which the card hides).
 *
 * A stale cached payload may predate the pricing fields entirely, and
 * `lowestBuyerTotalCents` / `hasPayWhatYouWantTier` may be absent on a payload
 * from before they shipped: degrade to no price (or read the flag as false)
 * rather than crash or fall back to face.
 *
 * Currency is real here: `event.currency` (`event.currency ?? "usd"`), so a
 * JPY event reads "¥2,500", not "$25".
 */
const resolveEmbedListingPrice = (event: EventItem): ListingPrice | null => {
  const { lowestPriceCents, paidTierCount, hasFreeTier, currency } = event;
  if (typeof paidTierCount !== "number" || typeof hasFreeTier !== "boolean") {
    return null;
  }
  const hasPayWhatYouWantTier = event.hasPayWhatYouWantTier === true;
  return resolveListingPrice({
    hasFreeTier,
    hasPayWhatYouWantTier,
    paidTierCount,
    // Not used for the label; `lowestPriceCents` is 0 with a free or floor-0
    // pay-what-you-want tier, not the paid min.
    minPaidPriceCents:
      hasFreeTier || hasPayWhatYouWantTier ? null : (lowestPriceCents ?? null),
    lowestBuyerTotalCents: event.lowestBuyerTotalCents ?? null,
    currency: currency ?? "usd",
  });
};

export const mapEventItemToSummary = (event: EventItem): EventSummary => ({
  id: event.id,
  title: event.title,
  date: formatEventDateLabel(event.startsAt, event.timezone),
  startsAt: toSummaryStartsAt(event.startsAt),
  // The zone `date` was formatted in, so the card's stamp reads the same day.
  timezone: resolveTimeZone(event.timezone),
  venue: buildVenueLabel(event),
  // English `priceLabel` plus the same price as data; the shared card words
  // `listingPrice` in the viewer's language (`useListingPriceWords`).
  ...embedCardPrice(resolveEmbedListingPrice(event)),
  // Drives the amber "Free" badge on the shared card. Strict checks so a
  // stale payload (fields undefined) reads as paid, matching the label
  // fallback above.
  isFree:
    event.hasFreeTier === true &&
    event.paidTierCount === 0 &&
    event.hasPayWhatYouWantTier !== true,
  slug: event.slug,
  // The site card's own gate row (lock / clipboard icon + label); a stale
  // payload without the field reads as ungated, as the card omits NONE.
  gateType: event.gateType,
  media: event.heroImageUrl
    ? { url: event.heroImageUrl, alt: event.title }
    : undefined,
});

/**
 * The checkout key of one purchase: a v4 UUID (36 characters, 122 random
 * bits). The server keys the order by it and, for a guest, takes it as part
 * of the proof that a later call is about the buyer's own order, so it comes
 * from the browser's cryptographic generator and never from `Math.random`.
 * `crypto.randomUUID` is missing on older Safari and outside a secure
 * context; the same UUID is then built from `crypto.getRandomValues`.
 */
export const generateClientKey = (): string => {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  // RFC 4122: version 4 in the high bits of byte 6, the variant in byte 8.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/**
 * The rate the Taxes row labels: what the buyer is charged at, summed over
 * every `collector: "PLATFORM"` imposition — and only while those lines share
 * one base (`taxRateLabelBps`, the rule main checkout labels with). Not
 * `admissionTaxRateBps`, which describes the SALES line only and misses any
 * local tax the charge includes. ORGANISER lines are the venue's to remit,
 * never the buyer's. `null` when nothing is charged, or when the lines sit on
 * different bases (Minneapolis) — the row then shows the amount alone.
 */
export const buyerTaxRateBps = (
  feeRates:
    | {
        taxImpositions?: ReadonlyArray<TaxLineForLabel> | null;
      }
    | null
    | undefined,
): number | null => taxRateLabelBps(feeRates?.taxImpositions);
