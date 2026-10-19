import { describe, expect, it } from "vitest";

import enMessages from "@/i18n/messages/en";
import esMessages from "@/i18n/messages/es";

import {
  derivePriceBreakdown,
  priceBreakdownCaption,
  type PriceBreakdown,
} from "../price-breakdown";

const sum = (b: PriceBreakdown) => b.ticketCents + b.feesCents + b.taxCents;

// The owner's board example: a $40 ticket in NYC.
const NYC_PASS_THROUGH = {
  platformFeeCents: 50,
  processorFeeCents: 162,
  taxEstimateCents: 355,
  buyerUnitTotalCents: 4567,
};

/** Minimal ICU-free stand-in: `{name}` → value, straight off the catalog. */
const makeT =
  (catalog: Record<string, unknown>) =>
  (key: string, values: Record<string, string | number> = {}) => {
    const template = key
      .split(".")
      .reduce<unknown>(
        (node, part) => (node as Record<string, unknown>)?.[part],
        catalog,
      );
    if (typeof template !== "string") throw new Error(`missing key ${key}`);
    return template.replace(/\{(\w+)\}/g, (_, name: string) =>
      String(values[name]),
    );
  };
const formatPrice = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const en = { formatPrice, t: makeT(enMessages) };

describe("derivePriceBreakdown", () => {
  it("PASS_THROUGH: ticket + platform/processor fees + tax sum to the figure", () => {
    const b = derivePriceBreakdown({
      priceCents: 4000,
      figureCents: 4567,
      estimate: NYC_PASS_THROUGH,
      feeMode: "PASS_THROUGH",
    });
    expect(b).toEqual({ ticketCents: 4000, feesCents: 212, taxCents: 355 });
    expect(sum(b!)).toBe(4567);
  });

  it("ABSORB: the buyer pays face + tax; no fee part, and the parts sum", () => {
    const b = derivePriceBreakdown({
      priceCents: 4000,
      figureCents: 4355,
      estimate: {
        platformFeeCents: 0,
        processorFeeCents: 0,
        taxEstimateCents: 355,
        buyerUnitTotalCents: 4355,
      },
      feeMode: "ABSORB",
    });
    expect(b).toEqual({ ticketCents: 4000, feesCents: 0, taxCents: 355 });
    expect(sum(b!)).toBe(4355);
  });

  it("ABSORB: a populated platform fee is never shown as a buyer fee", () => {
    const b = derivePriceBreakdown({
      priceCents: 4000,
      figureCents: 4355,
      estimate: {
        platformFeeCents: 50,
        processorFeeCents: 0,
        taxEstimateCents: 355,
        buyerUnitTotalCents: 4355,
      },
      feeMode: "ABSORB",
    });
    expect(b?.feesCents).toBe(0);
    expect(sum(b!)).toBe(4355);
  });

  it("zero tax: ticket + fees sum to the figure, tax part is 0", () => {
    const b = derivePriceBreakdown({
      priceCents: 4000,
      figureCents: 4212,
      estimate: {
        platformFeeCents: 50,
        processorFeeCents: 162,
        taxEstimateCents: 0,
        buyerUnitTotalCents: 4212,
      },
      feeMode: "PASS_THROUGH",
    });
    expect(b).toEqual({ ticketCents: 4000, feesCents: 212, taxCents: 0 });
    expect(sum(b!)).toBe(4212);
  });

  it("no caption when fees and tax are both 0", () => {
    expect(
      derivePriceBreakdown({
        priceCents: 4000,
        figureCents: 4000,
        estimate: {
          platformFeeCents: 0,
          processorFeeCents: 0,
          taxEstimateCents: 0,
          buyerUnitTotalCents: 4000,
        },
        feeMode: "ABSORB",
      }),
    ).toBeNull();
  });

  it("no caption for a free tier", () => {
    expect(
      derivePriceBreakdown({
        priceCents: 0,
        figureCents: 0,
        estimate: {
          platformFeeCents: 0,
          processorFeeCents: 0,
          taxEstimateCents: 0,
          buyerUnitTotalCents: 0,
        },
        feeMode: "PASS_THROUGH",
      }),
    ).toBeNull();
  });

  it("no caption while the estimate is still calculating", () => {
    expect(
      derivePriceBreakdown({
        priceCents: 4000,
        figureCents: null,
        estimate: undefined,
        feeMode: "PASS_THROUGH",
      }),
    ).toBeNull();
  });

  it("no caption when the parts would not add up (face and estimate straddle a price flip)", () => {
    // The estimate was priced at a lower face while the tier now reads $40.
    // The figure IS the row's total (as `getBuyerAllInDisplayCents` prints
    // it), so only the sum guard can reject this.
    expect(
      derivePriceBreakdown({
        priceCents: 4000,
        figureCents: 4006,
        estimate: {
          platformFeeCents: 50,
          processorFeeCents: 145,
          taxEstimateCents: 311,
          buyerUnitTotalCents: 4006,
        },
        feeMode: "PASS_THROUGH",
      }),
    ).toBeNull();
  });

  it("no caption when the row was priced at a different face, even if the parts happen to sum", () => {
    expect(
      derivePriceBreakdown({
        priceCents: 4000,
        figureCents: 4567,
        estimate: { ...NYC_PASS_THROUGH, unitPriceCents: 3500 },
        feeMode: "PASS_THROUGH",
      }),
    ).toBeNull();
  });

  it("a row priced at the page's face still gets its caption", () => {
    expect(
      derivePriceBreakdown({
        priceCents: 4000,
        figureCents: 4567,
        estimate: { ...NYC_PASS_THROUGH, unitPriceCents: 4000 },
        feeMode: "PASS_THROUGH",
      }),
    ).toEqual({ ticketCents: 4000, feesCents: 212, taxCents: 355 });
  });

  it("no caption when the figure is not the estimate's all-in total", () => {
    expect(
      derivePriceBreakdown({
        priceCents: 4000,
        figureCents: 4600,
        estimate: NYC_PASS_THROUGH,
        feeMode: "PASS_THROUGH",
      }),
    ).toBeNull();
  });
});

describe("priceBreakdownCaption", () => {
  const full = { ticketCents: 4000, feesCents: 212, taxCents: 355 };

  it("long form names all three parts", () => {
    expect(priceBreakdownCaption(full, "long", en)).toBe(
      "$40.00 ticket + $2.12 fees + $3.55 tax",
    );
  });

  it("short form names what sits on top of the face", () => {
    expect(priceBreakdownCaption(full, "short", en)).toBe(
      "incl. $2.12 fees + $3.55 tax",
    );
  });

  it("omits a zero tax part", () => {
    const b = { ticketCents: 4000, feesCents: 212, taxCents: 0 };
    expect(priceBreakdownCaption(b, "long", en)).toBe(
      "$40.00 ticket + $2.12 fees",
    );
    expect(priceBreakdownCaption(b, "short", en)).toBe("incl. $2.12 fees");
  });

  it("omits a zero fee part", () => {
    const b = { ticketCents: 4000, feesCents: 0, taxCents: 355 };
    expect(priceBreakdownCaption(b, "long", en)).toBe(
      "$40.00 ticket + $3.55 tax",
    );
    expect(priceBreakdownCaption(b, "short", en)).toBe("incl. $3.55 tax");
  });

  it("never formats a zero part (formatPrice(0) reads 'Free')", () => {
    const formatted: number[] = [];
    const spy = {
      formatPrice: (cents: number) => {
        formatted.push(cents);
        return formatPrice(cents);
      },
      t: en.t,
    };
    priceBreakdownCaption(
      { ticketCents: 4000, feesCents: 0, taxCents: 355 },
      "long",
      spy,
    );
    priceBreakdownCaption(
      { ticketCents: 4000, feesCents: 212, taxCents: 0 },
      "short",
      spy,
    );
    expect(formatted).not.toContain(0);
    expect(formatted).toEqual([4000, 355, 212]);
  });

  it("has a Spanish rendering of every variant", () => {
    const es = { formatPrice, t: makeT(esMessages) };
    expect(priceBreakdownCaption(full, "long", es)).toBe(
      "entrada $40.00 + tarifas $2.12 + impuestos $3.55",
    );
    expect(priceBreakdownCaption(full, "short", es)).toBe(
      "incl. tarifas $2.12 + impuestos $3.55",
    );
  });
});
