/**
 * Canonical money formatting for the whole monorepo.
 *
 * This lives in `@th/types` — the LOWEST layer — deliberately. `@th/ui` may
 * only reach `@th/types` / `@th/locale` / `@th/schema` (it cannot import
 * `@th/core`), and `@th/core` depends on `@th/types`, so this is the only
 * module both sides can share. `packages/core/src/lib/currency-utils.ts`
 * re-exports everything here, which keeps `@th/core`'s public surface
 * unchanged for its existing callers.
 *
 * Before this consolidation there were FIVE copies of "format cents as a price
 * string", three of which hardcoded `$` and divided by 100 unconditionally — so
 * a ¥2,500 JPY event rendered as "$25": wrong symbol AND wrong magnitude by
 * ~100x.
 *
 * ── TWO display contracts, both intentional ────────────────────────────────
 *
 *   `formatMoneyCents` — EXACT. Always shows the currency's full fraction
 *     digits. `1099 → "$10.99"`, `4500 → "$45.00"`. Use for receipts, order
 *     summaries, ledgers, disputes — anywhere a figure is an accounting
 *     statement and a missing ".00" reads as truncation.
 *
 *   `formatPriceCents` — COMPACT. Drops the fraction when the amount is a whole
 *     major unit. `4500 → "$45"`, `4550 → "$45.50"`. Use for browse/discovery
 *     price labels — the event-card badge, its hover reveal, search results,
 *     embeds, SEO price ranges — where "$45.00" is visual noise on a card.
 *
 * Zero-decimal currencies (JPY, KRW, …) have no fraction to trim, so the two
 * contracts coincide there.
 *
 * @see https://docs.stripe.com/currencies#zero-decimal
 */

// ── Zero-decimal currencies ────────────────────────────────────────────────

/**
 * Complete set of Stripe zero-decimal currency codes (lowercase).
 * For these currencies `amount` passed to/from Stripe is already in the
 * major unit, so no divide-by-100 is needed.
 */
export const ZERO_DECIMAL_CURRENCIES = new Set([
  "bif",
  "clp",
  "djf",
  "gnf",
  "jpy",
  "kmf",
  "krw",
  "mga",
  "pyg",
  "rwf",
  "ugx",
  "vnd",
  "vuv",
  "xaf",
  "xof",
  "xpf",
]);

/**
 * Returns `true` when the given ISO 4217 currency code is a
 * Stripe zero-decimal currency.
 */
export function isZeroDecimalCurrency(currency: string): boolean {
  return ZERO_DECIMAL_CURRENCIES.has(currency.toLowerCase());
}

// ── Conversion helpers ─────────────────────────────────────────────────────

/**
 * Convert a Stripe-style "minor unit" integer into a display-friendly
 * major-unit number.
 *
 * For normal currencies this divides by 100 (1000 → 10.00).
 * For zero-decimal currencies this is a no-op (500 → 500).
 *
 * @example
 * toMajorUnits(1000, "usd") // 10
 * toMajorUnits(500, "jpy")  // 500
 */
export function toMajorUnits(minorUnits: number, currency: string): number {
  return isZeroDecimalCurrency(currency) ? minorUnits : minorUnits / 100;
}

/**
 * Convert a human-entered major-unit number into Stripe minor units.
 *
 * For normal currencies this multiplies by 100 and rounds (10.00 → 1000).
 * For zero-decimal currencies this rounds to the nearest integer (500 → 500).
 *
 * @example
 * toMinorUnits(10, "usd")  // 1000
 * toMinorUnits(500, "jpy") // 500
 */
export function toMinorUnits(majorUnits: number, currency: string): number {
  return isZeroDecimalCurrency(currency)
    ? Math.round(majorUnits)
    : Math.round(majorUnits * 100);
}

/**
 * The number of fractional digits the currency uses in display.
 * Zero-decimal currencies use 0; everything else uses 2.
 */
export function currencyFractionDigits(currency: string): number {
  return isZeroDecimalCurrency(currency) ? 0 : 2;
}

// ── Formatter cache ────────────────────────────────────────────────────────

/**
 * `Intl.NumberFormat` construction is expensive relative to `.format()`, and
 * these helpers run once per card in a grid. Cache by the full option tuple.
 * (This replaces the ad-hoc cache that lived in `apps/web/.../event-format.ts`.)
 */
const formatterCache = new Map<string, Intl.NumberFormat>();

/**
 * Bound on {@link formatterCache}. The currency and fraction-digit dimensions
 * are small and fixed, but `locale` is a free-form BCP-47 string: private-use
 * tags (`en-x-a1`, `en-x-a2`, …) are WELL-FORMED, so `Intl` accepts them and
 * each would pin another formatter for the process lifetime. This module is
 * the app-wide money chokepoint inside long-lived Node servers, so the cache
 * is capped rather than left unbounded. Real usage sits in the low tens.
 */
const FORMATTER_CACHE_MAX = 64;

const getFormatter = (
  locale: string,
  currency: string,
  minimumFractionDigits: number,
  maximumFractionDigits: number,
): Intl.NumberFormat | null => {
  const key = `${locale}|${currency}|${minimumFractionDigits}|${maximumFractionDigits}`;
  const cached = formatterCache.get(key);
  if (cached) return cached;
  try {
    const formatter = new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      minimumFractionDigits,
      maximumFractionDigits,
    });
    if (formatterCache.size >= FORMATTER_CACHE_MAX) formatterCache.clear();
    formatterCache.set(key, formatter);
    return formatter;
  } catch {
    // `Intl` throws RangeError on a malformed currency code (anything that is
    // not 3 ASCII letters) or an unusable locale tag. Only reachable from a
    // corrupt/stale payload. Signal it to the caller rather than swallowing —
    // this is the lowest layer of the app, so there is no ReporterPort here
    // and no sensible place to log; the caller renders a degraded string.
    return null;
  }
};

/**
 * Last-resort rendering when `Intl` rejects the currency code. Prints the
 * correctly-SCALED amount with the raw code, e.g. `"USDD 45.00"`.
 *
 * Deliberately NOT a silent fall back to USD: the previous embed-local copy did
 * exactly that (and at the wrong scale for zero-decimal currencies), which
 * turns an unrenderable amount into a confident lie about which currency the
 * buyer is being charged.
 */
const formatWithoutIntl = (
  majorUnits: number,
  currency: string,
  fractionDigits: number,
): string => `${currency.toUpperCase()} ${majorUnits.toFixed(fractionDigits)}`;

// ── Display helpers ────────────────────────────────────────────────────────

/**
 * Format a minor-unit integer (e.g. cents) as a human-readable currency
 * string using `Intl.NumberFormat`. EXACT contract — always shows the
 * currency's full fraction digits.
 *
 * Handles zero-decimal currencies (JPY, KRW, etc.) automatically via
 * `toMajorUnits` and `currencyFractionDigits` so callers never need to
 * know whether to divide by 100.
 *
 * @param amountCents - Price in minor units (e.g. 1000 = $10.00 for USD)
 * @param currency - ISO 4217 currency code (default: "usd")
 * @param locale - BCP-47 locale tag (default: "en-US")
 * @example
 * formatCents(1250, "usd") // "$12.50"
 * formatCents(4500, "usd") // "$45.00"
 * formatCents(500, "jpy")  // "¥500"
 */
export function formatCents(
  amountCents: number,
  currency = "usd",
  locale = "en-US",
): string {
  const fractions = currencyFractionDigits(currency);
  const majorUnits = toMajorUnits(amountCents, currency);
  const formatter = getFormatter(
    locale,
    currency.toUpperCase(),
    fractions,
    fractions,
  );
  return formatter
    ? formatter.format(majorUnits)
    : formatWithoutIntl(majorUnits, currency, fractions);
}

// ── Options-bag API (spec-aligned) ─────────────────────────────────────────

export interface FormatMoneyCentsOptions {
  /** ISO 4217 currency code. Default "USD". */
  currency?: string;
  /** BCP-47 locale tag. Default "en-US". */
  locale?: string;
}

/**
 * Format an integer number of currency minor units (e.g. cents) as a
 * localized currency string. EXACT contract — see {@link formatCents}.
 *
 * Accepts `bigint` because core money math uses bigint cents in places.
 *
 * @example
 *   formatMoneyCents(1099)                          // "$10.99"
 *   formatMoneyCents(1099n)                         // "$10.99"
 *   formatMoneyCents(1000, { currency: "JPY" })     // "¥1,000"
 *   formatMoneyCents(1099, { locale: "de-DE" })     // "10,99 $"
 */
export function formatMoneyCents(
  cents: number | bigint,
  options?: FormatMoneyCentsOptions,
): string {
  const numericCents = typeof cents === "bigint" ? Number(cents) : cents;
  return formatCents(
    numericCents,
    options?.currency ?? "USD",
    options?.locale ?? "en-US",
  );
}

/** Options for the COMPACT price contract. Same bag as the exact one. */
export type FormatPriceCentsOptions = FormatMoneyCentsOptions;

/**
 * Format a minor-unit integer as a browse/discovery PRICE LABEL. COMPACT
 * contract — a whole major-unit amount drops its fraction, a fractional amount
 * keeps the currency's full precision. Never rounds.
 *
 *   `4500 → "$45"`   (not "$45.00")
 *   `4550 → "$45.50"`
 *   `2500 → "¥2,500"` for JPY — no division, no fraction
 *
 * This is the currency-aware successor to `formatDollarsFromCents`, which
 * hardcoded `$` and always divided by 100. It is the ONE helper behind the
 * event-card badge (`event-summary-mapper.ts`), the card's hover price reveal
 * (`EventCardPriceReveal.tsx`), the embed grid, and the SEO price range — so
 * those surfaces cannot silently disagree by a cent or a symbol.
 *
 * ONE deliberate output change vs. `formatDollarsFromCents`: amounts of 1000
 * major units and up now carry the locale's group separator (`"$4,500"` rather
 * than `"$4500"`), because this goes through `Intl` like every other price
 * surface in the app already does. Sub-$1000 output — which is essentially
 * every ticket — is byte-identical.
 *
 * @example
 * formatPriceCents(4500)                        // "$45"
 * formatPriceCents(4550)                        // "$45.50"
 * formatPriceCents(2500, { currency: "jpy" })   // "¥2,500"
 * formatPriceCents(4550, { currency: "eur", locale: "de-DE" }) // "45,50 €"
 */
export function formatPriceCents(
  cents: number | bigint,
  options?: FormatPriceCentsOptions,
): string {
  const numericCents = typeof cents === "bigint" ? Number(cents) : cents;
  const currency = options?.currency ?? "USD";
  const locale = options?.locale ?? "en-US";

  const maxFractions = currencyFractionDigits(currency);
  const majorUnits = toMajorUnits(numericCents, currency);
  // Whole major units ⇒ no fraction at all. Zero-decimal currencies always take
  // this branch (`maxFractions` is 0 anyway), so `compact` is a no-op there.
  const minFractions = majorUnits % 1 === 0 ? 0 : maxFractions;

  const formatter = getFormatter(
    locale,
    currency.toUpperCase(),
    minFractions,
    maxFractions,
  );
  return formatter
    ? formatter.format(majorUnits)
    : formatWithoutIntl(majorUnits, currency, minFractions);
}

/**
 * @deprecated Currency-BLIND: hardcodes `$` and assumes a 2-decimal currency.
 * Use {@link formatPriceCents} and pass the real currency where one is
 * reachable. Kept only as a thin alias so any straggling import keeps its
 * exact USD contract (`4500 → "$45"`, `4550 → "$45.50"`).
 */
export const formatDollarsFromCents = (cents: number): string =>
  formatPriceCents(cents, { currency: "USD", locale: "en-US" });

// ─────────────────────────────────────────────────────────────────────────────
// Listing price label — THE rule behind every event-listing price
// ─────────────────────────────────────────────────────────────────────────────

/** The pricing rollup a listing label is decided from. */
export interface ListingPriceLabelInput {
  /** A genuinely free tier (fixed price 0) is on sale. */
  hasFreeTier: boolean;
  /**
   * A pay-what-you-want tier with NO minimum (floor 0) is on sale. Kept apart
   * from `hasFreeTier` on purpose (owner ruling 2026-10-06, F2): the event
   * page and checkout call that tier "Pay what you want", so a listing must
   * not call it "Free". Optional so a payload from before the field existed
   * reads as `false`. A PWYW tier with a floor above 0 is a PAID tier quoted
   * at its floor and never sets this.
   */
  hasPayWhatYouWantTier?: boolean;
  paidTierCount: number;
  /** Face price of the cheapest on-sale paid tier (PWYW at its floor). */
  minPaidPriceCents: number | null;
  /**
   * The ALL-IN price of that tier — ticket + platform fee + processing fee +
   * tax, as checkout charges. Null when it could not be computed honestly.
   */
  lowestBuyerTotalCents: number | null;
  currency?: string | null;
  /**
   * How a figure is worded when several paid tiers exist. `"bare"` (cards,
   * rows, the embed list) prints "$X" — the all-in figure already is the least
   * a buyer pays, and the old "+" meant "plus fees". `"from"` (the embed
   * calendar's week row, FR-023) prints "From $X". Single-tier events print
   * "$X" either way.
   */
  multiTier?: "bare" | "from";
}

/**
 * A listing price as DATA, before it is put into words. The shared rule
 * ({@link resolveListingPrice}) decides which of these an event gets; the
 * rendering edge words it in the viewer's language
 * ({@link renderListingPrice} with that language's {@link ListingPriceWords}).
 * `null` (no value) is "no price to show": cards print their "See details"
 * fallback, the calendar prints nothing.
 *
 *   - `free`: only genuinely free tiers are on sale.
 *   - `freePlus`: free AND paid tiers.
 *   - `payWhatYouWant`: a floor-0 pay-what-you-want tier is on sale, with or
 *     without free or paid tiers beside it.
 *   - `amount`: the ALL-IN figure of the cheapest paid tier. `from` is true
 *     when the caller asked for "From $X" wording and several paid tiers exist.
 */
export type ListingPrice =
  | { kind: "free" }
  | { kind: "freePlus" }
  | { kind: "payWhatYouWant" }
  | { kind: "amount"; cents: number; currency: string; from: boolean };

/**
 * The price an event LISTING shows — owner ruling 2026-10-02: every listing
 * price is the ALL-IN figure, never the face price.
 *
 *   - a floor-0 pay-what-you-want tier on sale: `payWhatYouWant`, whatever
 *     sits beside it (owner ruling 2026-10-06, F2: such a tier never reads
 *     "Free"). With paid tiers too it stays `payWhatYouWant`, not a "+"
 *     variant and not the paid minimum: the least a buyer can pay is still
 *     whatever they choose, and "Pay what you want" already says the amount
 *     goes up from there — it is the claim "Free+" made, minus the word Free.
 *     Quoting the paid tier's all-in figure would overstate the least a buyer
 *     pays;
 *   - no paid tier: `free` when a free tier exists, else `null`;
 *   - free AND paid tiers: `freePlus`;
 *   - paid, all-in unknown (`lowestBuyerTotalCents == null`): `null`. The
 *     caller renders its own fallback — "See details" on a card, nothing on
 *     the calendar. Falling back to the face price instead would understate
 *     what checkout charges;
 *   - paid, all-in known: the all-in `amount`.
 *
 * `minPaidPriceCents` is not used here. It is part of the input so a caller
 * holding a possibly STALE total (the search index) can run
 * {@link isPlausibleIndexedBuyerTotal} against it before passing the total in.
 */
export function resolveListingPrice(
  input: ListingPriceLabelInput,
): ListingPrice | null {
  const { hasFreeTier, paidTierCount, lowestBuyerTotalCents } = input;
  if (input.hasPayWhatYouWantTier === true) return { kind: "payWhatYouWant" };
  if (paidTierCount <= 0) return hasFreeTier ? { kind: "free" } : null;
  // "Free+" is a distinct claim (free AND paid tiers exist), not a price.
  if (hasFreeTier) return { kind: "freePlus" };
  if (lowestBuyerTotalCents == null || lowestBuyerTotalCents <= 0) return null;
  return {
    kind: "amount",
    cents: lowestBuyerTotalCents,
    currency: (input.currency || "USD").toUpperCase(),
    from: paidTierCount > 1 && input.multiTier === "from",
  };
}

/**
 * The words a {@link ListingPrice} is rendered with, in one language. The web
 * builds these from its catalog (`useListingPriceWords` in `@th/ui`); the
 * server-side English string (`formatListingPriceLabel`, the DTO's
 * `priceLabel`, which native apps print) uses
 * {@link ENGLISH_LISTING_PRICE_WORDS}.
 */
export interface ListingPriceWords {
  free: string;
  freePlus: string;
  payWhatYouWant: string;
  /** Wraps an already-formatted amount: "From $15" / "Desde $15". */
  fromPrice: (formattedAmount: string) => string;
}

export const ENGLISH_LISTING_PRICE_WORDS: ListingPriceWords = {
  free: "Free",
  freePlus: "Free+",
  payWhatYouWant: "Pay what you want",
  fromPrice: (formattedAmount) => `From ${formattedAmount}`,
};

/**
 * Put a {@link ListingPrice} into words. The amount itself is formatted the
 * same way in every language (`formatPriceCents`, en-US grouping: "$28.62"),
 * so a Spanish card reads "Desde $28.62" and the figure matches the event page
 * and checkout; only the words around it change.
 */
export function renderListingPrice(
  price: ListingPrice,
  words: ListingPriceWords = ENGLISH_LISTING_PRICE_WORDS,
): string {
  switch (price.kind) {
    case "free":
      return words.free;
    case "freePlus":
      return words.freePlus;
    case "payWhatYouWant":
      return words.payWhatYouWant;
    case "amount": {
      const formatted = formatPriceCents(price.cents, {
        currency: price.currency,
      });
      return price.from ? words.fromPrice(formatted) : formatted;
    }
  }
}

/**
 * The listing price label in ENGLISH — {@link resolveListingPrice} rendered
 * with {@link ENGLISH_LISTING_PRICE_WORDS}. This is the server-side string
 * (the DTO's `priceLabel`, which native apps print as is); web surfaces carry
 * the structured {@link ListingPrice} as well and word it in the viewer's
 * language. `null` means no price to show.
 */
export function formatListingPriceLabel(
  input: ListingPriceLabelInput,
): string | null {
  const price = resolveListingPrice(input);
  return price ? renderListingPrice(price) : null;
}

/**
 * Absolute headroom, in minor units, a stored all-in total may sit above
 * twice its face price and still be believed. See
 * {@link isPlausibleIndexedBuyerTotal}.
 */
export const INDEXED_BUYER_TOTAL_ALLOWANCE_CENTS = 300;

/**
 * Stale-index guard for an all-in total read from the SEARCH INDEX (a live DB
 * read needs none — it was computed this request). The index stores the total
 * and the face price at index time; a price edit that has not been re-indexed
 * yet can leave a total that no longer belongs to the face beside it.
 *
 *   - FLOOR: `total >= face`. Fees and tax never reduce a price, so a total
 *     below face is stale (the price was raised).
 *   - CEILING: `total <= 2 × face + 300`. The old bare `2 × face` rejected
 *     legitimate small tickets: the processing fee's fixed $0.30 and the
 *     platform fee (3.33% capped at $0.50 under the current GLOBAL policy) make
 *     a $1 ticket's all-in figure ~1.5× face and a $0.50 ticket's ~1.8×. The
 *     fixed parts of the fee schedule total at most $0.80 per ticket today; a
 *     $3 allowance covers those with tax on top and room for a policy change,
 *     while still rejecting a total left behind by a large price cut (a $50
 *     ticket cut to $20 leaves a ~$55 total, above the $43 ceiling).
 *
 * The bound is an absolute allowance rather than derived from the fee policy
 * because the policy is not on the index-read path.
 */
export function isPlausibleIndexedBuyerTotal(
  buyerTotalCents: number,
  minPaidPriceCents: number,
): boolean {
  return (
    buyerTotalCents >= minPaidPriceCents &&
    buyerTotalCents <=
      minPaidPriceCents * 2 + INDEXED_BUYER_TOTAL_ALLOWANCE_CENTS
  );
}
