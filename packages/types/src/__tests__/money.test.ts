import { describe, expect, it } from "vitest";

import {
  ZERO_DECIMAL_CURRENCIES,
  currencyFractionDigits,
  formatCents,
  formatDollarsFromCents,
  formatMoneyCents,
  formatListingPriceLabel,
  formatPriceCents,
  isPlausibleIndexedBuyerTotal,
  isZeroDecimalCurrency,
  renderListingPrice,
  resolveListingPrice,
  toMajorUnits,
  toMinorUnits,
  type ListingPriceWords,
} from "../money";

// `@th/types/money` is the ONE implementation of "format cents as a price
// string" for the whole monorepo — the lowest layer, so both `@th/core` (which
// re-exports it as `@th/core/lib/currency-utils`) and `@th/ui` (which cannot
// import `@th/core` at all) share it. Five divergent copies preceded it, three
// of which hardcoded `$` and divided by 100 unconditionally.

// ─────────────────────────────────────────────────────────────────────────────
// COMPACT contract — browse/discovery price labels
// ─────────────────────────────────────────────────────────────────────────────

describe("formatPriceCents (COMPACT contract)", () => {
  // Pins the exact pre-consolidation output of `formatDollarsFromCents`, which
  // rendered the event-card badge (`event-summary-mapper.ts`), its hover reveal
  // (`EventCardPriceReveal.tsx`), the embed grid and the local-events list. A
  // migration that silently turned "$45" into "$45.00" would be a site-wide
  // visual regression on every price on the site.
  it("drops the fraction for whole dollars (USD)", () => {
    expect(formatPriceCents(4500)).toBe("$45");
    expect(formatPriceCents(0)).toBe("$0");
    expect(formatPriceCents(100)).toBe("$1");
    expect(formatPriceCents(12000)).toBe("$120");
  });

  it("keeps exactly two places for fractional amounts, never rounding (USD)", () => {
    expect(formatPriceCents(4550)).toBe("$45.50");
    expect(formatPriceCents(3985)).toBe("$39.85");
    expect(formatPriceCents(8444)).toBe("$84.44");
    expect(formatPriceCents(1)).toBe("$0.01");
  });

  it("groups thousands like every other price surface in the app", () => {
    // The ONE deliberate output change vs. `formatDollarsFromCents`, which
    // produced the ungrouped "$4500". Everything below $1,000 — i.e. very
    // nearly every ticket — is byte-identical to the old helper.
    expect(formatPriceCents(450000)).toBe("$4,500");
    expect(formatPriceCents(450050)).toBe("$4,500.50");
  });

  // THE BUG THIS CONSOLIDATION EXISTS TO KILL: `formatDollarsFromCents(2500)`
  // rendered a ¥2,500 JPY event as "$25" — wrong symbol AND wrong magnitude by
  // ~100x. JPY is zero-decimal, so 2500 minor units IS ¥2,500.
  it("renders zero-decimal currencies with no division and no fraction (JPY)", () => {
    expect(formatPriceCents(2500, { currency: "jpy" })).toBe("¥2,500");
    expect(formatPriceCents(500, { currency: "JPY" })).toBe("¥500");
    expect(formatPriceCents(12000, { currency: "krw" })).toBe("₩12,000");
  });

  it("is a no-op for `compact` on zero-decimal currencies (nothing to trim)", () => {
    expect(formatPriceCents(2500, { currency: "jpy" })).toBe(
      formatCents(2500, "jpy"),
    );
  });

  it("respects the locale", () => {
    expect(formatPriceCents(4550, { currency: "eur", locale: "de-DE" })).toBe(
      "45,50\u00A0€",
    );
    expect(formatPriceCents(4500, { currency: "eur", locale: "de-DE" })).toBe(
      "45\u00A0€",
    );
  });

  it("accepts bigint cents", () => {
    expect(formatPriceCents(4500n)).toBe("$45");
    expect(formatPriceCents(4550n)).toBe("$45.50");
  });

  it("degrades to a scaled, code-prefixed string on a malformed currency code", () => {
    // `Intl` throws RangeError on anything that is not 3 ASCII letters. Only
    // reachable from a corrupt/stale payload. It must NOT silently claim USD —
    // that turns an unrenderable amount into a lie about what the buyer pays.
    expect(formatPriceCents(4550, { currency: "USDD" })).toBe("USDD 45.50");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// EXACT contract — receipts, ledgers, order summaries
// ─────────────────────────────────────────────────────────────────────────────

describe("formatCents / formatMoneyCents (EXACT contract)", () => {
  it("always shows the currency's full fraction digits", () => {
    expect(formatCents(4500, "usd")).toBe("$45.00");
    expect(formatCents(1250, "usd")).toBe("$12.50");
    expect(formatMoneyCents(1099)).toBe("$10.99");
    expect(formatMoneyCents(4500)).toBe("$45.00");
  });

  it("differs from the compact contract exactly where it should", () => {
    expect(formatMoneyCents(4500)).toBe("$45.00");
    expect(formatPriceCents(4500)).toBe("$45");
    // Fractional amounts agree — only the whole-unit trim differs.
    expect(formatMoneyCents(4550)).toBe(formatPriceCents(4550));
  });

  it("handles zero-decimal currencies", () => {
    expect(formatCents(500, "jpy")).toBe("¥500");
    expect(formatMoneyCents(1000, { currency: "JPY" })).toBe("¥1,000");
  });

  it("accepts bigint and honours the locale", () => {
    expect(formatMoneyCents(1099n)).toBe("$10.99");
    expect(formatMoneyCents(1099, { locale: "de-DE" })).toBe("10,99\u00A0$");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Deprecated alias — must keep its exact USD contract
// ─────────────────────────────────────────────────────────────────────────────

describe("formatDollarsFromCents (deprecated alias)", () => {
  it("drops decimals for whole dollars", () => {
    expect(formatDollarsFromCents(4500)).toBe("$45");
    expect(formatDollarsFromCents(0)).toBe("$0");
    expect(formatDollarsFromCents(100)).toBe("$1");
  });

  it("keeps exactly two places for fractional amounts (never rounds)", () => {
    expect(formatDollarsFromCents(4550)).toBe("$45.50");
    expect(formatDollarsFromCents(3985)).toBe("$39.85");
    expect(formatDollarsFromCents(8444)).toBe("$84.44");
    expect(formatDollarsFromCents(1)).toBe("$0.01");
  });

  it("is exactly the USD compact helper (cannot drift)", () => {
    for (const cents of [0, 1, 100, 4500, 4550, 3985, 8444, 450000]) {
      expect(formatDollarsFromCents(cents)).toBe(formatPriceCents(cents));
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Primitives — moved down from `@th/core/lib/currency-utils`, which now
// re-exports them. Duplicated coverage there is deliberate: it proves the
// re-export keeps `@th/core`'s public surface intact.
// ─────────────────────────────────────────────────────────────────────────────

describe("zero-decimal primitives", () => {
  it("carries all 16 Stripe zero-decimal currencies", () => {
    expect(ZERO_DECIMAL_CURRENCIES.size).toBe(16);
  });

  it("is case-insensitive", () => {
    expect(isZeroDecimalCurrency("JPY")).toBe(true);
    expect(isZeroDecimalCurrency("jpy")).toBe(true);
    expect(isZeroDecimalCurrency("usd")).toBe(false);
  });

  it("converts between minor and major units", () => {
    expect(toMajorUnits(1000, "usd")).toBe(10);
    expect(toMajorUnits(500, "jpy")).toBe(500);
    expect(toMinorUnits(10, "usd")).toBe(1000);
    expect(toMinorUnits(500, "jpy")).toBe(500);
  });

  it("reports fraction digits", () => {
    expect(currencyFractionDigits("usd")).toBe(2);
    expect(currencyFractionDigits("jpy")).toBe(0);
  });
});

describe("formatListingPriceLabel (owner ruling 2026-10-02: listings quote ALL-IN)", () => {
  const base = {
    hasFreeTier: false,
    paidTierCount: 1,
    minPaidPriceCents: 2500,
    lowestBuyerTotalCents: 2862,
  };

  it.each([
    ["free only", { hasFreeTier: true, paidTierCount: 0, minPaidPriceCents: null, lowestBuyerTotalCents: null }, "Free"],
    ["nothing on sale", { paidTierCount: 0, minPaidPriceCents: null, lowestBuyerTotalCents: null }, null],
    ["free + paid", { hasFreeTier: true, paidTierCount: 1 }, "Free+"],
    ["free + paid, total unknown", { hasFreeTier: true, lowestBuyerTotalCents: null }, "Free+"],
    ["one paid tier: the all-in figure", {}, "$28.62"],
    ["paid, all-in unknown: null, never the face", { lowestBuyerTotalCents: null }, null],
    ["multi-tier, bare (cards)", { paidTierCount: 3 }, "$28.62"],
    ["multi-tier, from (calendar)", { paidTierCount: 3, multiTier: "from" as const }, "From $28.62"],
    ["single tier, from: no prefix", { multiTier: "from" as const }, "$28.62"],
    ["whole-dollar total drops the fraction", { lowestBuyerTotalCents: 3000 }, "$30"],
    ["currency is honoured", { currency: "cad" }, "CA$28.62"],
    // Owner ruling 2026-10-06 (F2): floor-0 pay-what-you-want never reads "Free".
    ["floor-0 PWYW only", { hasPayWhatYouWantTier: true, paidTierCount: 0, minPaidPriceCents: null, lowestBuyerTotalCents: null }, "Pay what you want"],
    ["floor-0 PWYW + free", { hasPayWhatYouWantTier: true, hasFreeTier: true, paidTierCount: 0, minPaidPriceCents: null, lowestBuyerTotalCents: null }, "Pay what you want"],
    ["floor-0 PWYW + paid: not Free+, not the paid minimum", { hasPayWhatYouWantTier: true }, "Pay what you want"],
    ["floor-0 PWYW + free + paid", { hasPayWhatYouWantTier: true, hasFreeTier: true, paidTierCount: 2 }, "Pay what you want"],
    ["floor-0 PWYW + paid on the calendar", { hasPayWhatYouWantTier: true, paidTierCount: 3, multiTier: "from" as const }, "Pay what you want"],
    ["PWYW flag false is the old rule", { hasPayWhatYouWantTier: false }, "$28.62"],
  ])("%s", (_name, overrides, expected) => {
    expect(formatListingPriceLabel({ ...base, ...overrides })).toBe(expected);
  });
});

describe("resolveListingPrice / renderListingPrice (structured, localised at the edge)", () => {
  const base = {
    hasFreeTier: false,
    paidTierCount: 1,
    minPaidPriceCents: 2500,
    lowestBuyerTotalCents: 2862,
  };
  const SPANISH: ListingPriceWords = {
    free: "Gratis",
    freePlus: "Gratis+",
    payWhatYouWant: "Paga lo que quieras",
    fromPrice: (amount) => `Desde ${amount}`,
  };

  it("returns data, not English", () => {
    expect(resolveListingPrice(base)).toEqual({
      kind: "amount",
      cents: 2862,
      currency: "USD",
      from: false,
    });
    expect(
      resolveListingPrice({ ...base, paidTierCount: 3, multiTier: "from" }),
    ).toEqual({ kind: "amount", cents: 2862, currency: "USD", from: true });
    expect(
      resolveListingPrice({ ...base, hasPayWhatYouWantTier: true }),
    ).toEqual({ kind: "payWhatYouWant" });
    expect(resolveListingPrice({ ...base, hasFreeTier: true })).toEqual({
      kind: "freePlus",
    });
    expect(
      resolveListingPrice({ ...base, lowestBuyerTotalCents: null }),
    ).toBeNull();
  });

  it.each([
    [{ kind: "free" as const }, "Free", "Gratis"],
    [{ kind: "freePlus" as const }, "Free+", "Gratis+"],
    [{ kind: "payWhatYouWant" as const }, "Pay what you want", "Paga lo que quieras"],
    [{ kind: "amount" as const, cents: 1500, currency: "USD", from: true }, "From $15", "Desde $15"],
    [{ kind: "amount" as const, cents: 2862, currency: "USD", from: false }, "$28.62", "$28.62"],
  ])("renders case %# in English and Spanish", (price, en, es) => {
    expect(renderListingPrice(price)).toBe(en);
    expect(renderListingPrice(price, SPANISH)).toBe(es);
  });

  it("formatListingPriceLabel is the English rendering of resolveListingPrice", () => {
    const inputs = [
      base,
      { ...base, hasFreeTier: true },
      { ...base, hasPayWhatYouWantTier: true },
      { ...base, paidTierCount: 0, hasFreeTier: true },
      { ...base, paidTierCount: 2, multiTier: "from" as const },
    ];
    for (const input of inputs) {
      const price = resolveListingPrice(input);
      expect(formatListingPriceLabel(input)).toBe(
        price ? renderListingPrice(price) : null,
      );
    }
  });
});

describe("isPlausibleIndexedBuyerTotal (stale search-index guard)", () => {
  it.each([
    ["below face (price raised since indexing)", 2400, 2500, false],
    ["equal to face (no fees, no tax)", 2500, 2500, true],
    ["ordinary all-in", 2862, 2500, true],
    ["a $1 ticket's real total (~$1.50)", 150, 100, true],
    ["a $0.50 ticket's real total (~$0.88)", 88, 50, true],
    ["just inside 2x face + $3", 2 * 100 + 300, 100, true],
    ["just outside 2x face + $3", 2 * 100 + 301, 100, false],
    ["stale total after a $50 → $20 price cut", 5500, 2000, false],
  ])("%s", (_name, total, face, expected) => {
    expect(isPlausibleIndexedBuyerTotal(total, face)).toBe(expected);
  });
});
