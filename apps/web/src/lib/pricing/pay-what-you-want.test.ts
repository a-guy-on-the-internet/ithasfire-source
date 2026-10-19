import { describe, expect, it } from "vitest";

import {
  MAX_DONATION_AMOUNT_CENTS,
  amountSliderMaxCents,
  defaultChosenAmountCents,
  isChosenAmountValid,
  magnetizeAmountCents,
  parseAmountDraft,
  payWhatYouWantFromCents,
  payWhatYouWantSliderMaxCents,
  presetAmountsCents,
  sanitizeAmountDraft,
} from "./pay-what-you-want";
import { getBuyerAllInDisplayCents } from "./buyer-display";
import { estimateCartTotal } from "./order-estimate";
import {
  PWYW_FLOOR_ALL_IN_CENTS,
  PWYW_FLOOR_CENTS,
  RATES_888,
  serverRowAt,
} from "./__fixtures__/pwyw-floor";

const TIER = {
  pricingMode: "ADJUSTABLE" as const,
  minimumCents: 500,
  suggestedCents: 1500,
};

describe("pay-what-you-want helpers", () => {
  it("the cap is the ONE shared core constant: $10,000.00", () => {
    expect(MAX_DONATION_AMOUNT_CENTS).toBe(1_000_000);
  });

  it("valid = at least the minimum, at most the cap", () => {
    expect(isChosenAmountValid(TIER, 499)).toBe(false);
    expect(isChosenAmountValid(TIER, 500)).toBe(true);
    expect(isChosenAmountValid(TIER, 1_000_000)).toBe(true);
    expect(isChosenAmountValid(TIER, 1_000_001)).toBe(false);
  });

  it("the field accepts five whole digits (enough to type past the cap) and no more", () => {
    expect(sanitizeAmountDraft("10000.01")).toBe("10000.01");
    expect(sanitizeAmountDraft("99999")).toBe("99999");
    expect(sanitizeAmountDraft("100000")).toBeNull();
  });

  it("the default never exceeds the cap or undercuts the minimum", () => {
    expect(defaultChosenAmountCents(TIER)).toBe(1500);
    expect(defaultChosenAmountCents({ ...TIER, suggestedCents: 100 })).toBe(500);
    expect(
      defaultChosenAmountCents({ ...TIER, suggestedCents: 5_000_000 }),
    ).toBe(1_000_000);
  });

  it("every preset chip is clamped into [minimum, cap]", () => {
    expect(presetAmountsCents(TIER)).toEqual([750, 1500, 3000, 7500]);
    expect(presetAmountsCents({ ...TIER, suggestedCents: 400 })).toEqual([
      500, 800, 2000,
    ]);
    expect(
      presetAmountsCents({ ...TIER, suggestedCents: 400_000 }),
    ).toEqual([200_000, 400_000, 800_000, 1_000_000]);
  });
});

describe("comma handling", () => {
  it.each([
    ["1,000", 100_000],
    ["10,000", 1_000_000],
    ["1,000.50", 100_050],
    ["12,50", 1250],
    ["1,5", 150],
    ["12,", 1200],
  ])("%s → %i cents", (text, cents) => {
    expect(parseAmountDraft(text)).toBe(cents);
  });

  it("regression: '1,000' is one thousand dollars, never $1.00", () => {
    expect(parseAmountDraft("1,000")).not.toBe(100);
  });

  it("keeps the typed text so '1,0' can still grow into '1,000'", () => {
    expect(sanitizeAmountDraft("1,0")).toBe("1,0");
    expect(sanitizeAmountDraft("1,00")).toBe("1,00");
    expect(sanitizeAmountDraft("1,000")).toBe("1,000");
    // A sixth whole digit is still refused, commas or not.
    expect(sanitizeAmountDraft("100,000")).toBeNull();
  });
});

describe("payWhatYouWantFromCents — the all-in 'From' figure (owner ruling 2026-10-02)", () => {
  const FLOOR_TIER = { ...TIER, minimumCents: PWYW_FLOOR_CENTS };
  const row = serverRowAt("tt-pwyw", PWYW_FLOOR_CENTS);

  it("a $5 floor at 8.88% tax, fees on top, is $6.09 — the server's floor row", () => {
    expect(row.buyerUnitTotalCents).toBe(PWYW_FLOOR_ALL_IN_CENTS);
    expect(payWhatYouWantFromCents(FLOOR_TIER, row)).toBe(609);
  });

  it("is exactly what the charge math prices one ticket at the floor at", () => {
    // `estimateCartTotal` is pinned to the charge (`computeOrderAmounts` +
    // the create-checkout solve) by pay-what-you-want-parity.test.ts.
    const charged = estimateCartTotal(RATES_888, [
      {
        ticketTypeId: "tt-pwyw",
        qty: 1,
        priceCents: 0,
        chosenAmountCents: PWYW_FLOOR_CENTS,
      },
    ]);
    expect(charged?.totalCents).toBe(payWhatYouWantFromCents(FLOOR_TIER, row));
  });

  it("is the embed header's figure: the same row through the same helper", () => {
    // The embed's hero used to receive the tier as a fixed $0 ticket plus
    // this row, which is how it showed "From $6.09".
    expect(
      getBuyerAllInDisplayCents({
        priceCents: 0,
        buyerUnitTotalCents: row.buyerUnitTotalCents,
      }),
    ).toBe(payWhatYouWantFromCents(FLOOR_TIER, row));
  });

  it("floor 0 → 0 (worded 'Pay what you want'), whatever the row says", () => {
    expect(payWhatYouWantFromCents({ ...TIER, minimumCents: 0 }, undefined)).toBe(0);
    expect(payWhatYouWantFromCents({ ...TIER, minimumCents: null }, row)).toBe(0);
  });

  it("no row yet → null ('Calculating total…'), never the bare floor", () => {
    expect(payWhatYouWantFromCents(FLOOR_TIER, undefined)).toBeNull();
    expect(payWhatYouWantFromCents(FLOOR_TIER, { buyerUnitTotalCents: null })).toBeNull();
  });

  it("a row priced at another face (the minimum changed since) → null", () => {
    expect(
      payWhatYouWantFromCents({ ...TIER, minimumCents: 700 }, row),
    ).toBeNull();
  });
});

describe("the amount slider's range and magnet", () => {
  it("the box office's track: four times the suggestion, at least $50 and $10 over the floor", () => {
    expect(amountSliderMaxCents(TIER)).toBe(6000);
    expect(amountSliderMaxCents({ minimumCents: 200, suggestedCents: 300 })).toBe(5000);
    expect(amountSliderMaxCents({ minimumCents: 500, suggestedCents: null })).toBe(10_000);
    expect(amountSliderMaxCents({ minimumCents: 8000, suggestedCents: 8000 })).toBe(32_000);
  });

  it("regression (live run): the buyer's track reaches the largest preset chip", () => {
    // Gallery walk: chips $7.50 / $15 / $30 / $75 — the track used to end at $60.
    expect(presetAmountsCents(TIER)).toEqual([750, 1500, 3000, 7500]);
    expect(payWhatYouWantSliderMaxCents(TIER)).toBe(7500);
    expect(payWhatYouWantSliderMaxCents({ minimumCents: 8000, suggestedCents: 8000 })).toBe(40_000);
    // Where the box-office track is already longer, it stays.
    expect(payWhatYouWantSliderMaxCents({ minimumCents: 500, suggestedCents: null })).toBe(10_000);
    for (const tier of [
      TIER,
      { minimumCents: 200, suggestedCents: 300 },
      { minimumCents: 0, suggestedCents: 2500 },
      { minimumCents: 1234, suggestedCents: null },
    ]) {
      const max = payWhatYouWantSliderMaxCents(tier);
      for (const chip of presetAmountsCents(tier)) expect(chip).toBeLessThanOrEqual(max);
    }
  });

  it("never runs past the $10,000 cap (the box office's ceiling can)", () => {
    const big = { minimumCents: 100_000, suggestedCents: 500_000 };
    expect(amountSliderMaxCents(big)).toBe(2_000_000);
    expect(payWhatYouWantSliderMaxCents(big)).toBe(MAX_DONATION_AMOUNT_CENTS);
  });

  it("a drag lands on round money, and on an anchor within 40¢", () => {
    expect(magnetizeAmountCents(1985)).toBe(2000);
    expect(magnetizeAmountCents(1735)).toBe(1735);
    expect(magnetizeAmountCents(1245)).toBe(1245);
    expect(magnetizeAmountCents(1245, [1250])).toBe(1250);
    expect(magnetizeAmountCents(1265, [1250])).toBe(1250);
    // The nearer anchor wins.
    expect(magnetizeAmountCents(1285, [1250, 1300])).toBe(1300);
  });
});
