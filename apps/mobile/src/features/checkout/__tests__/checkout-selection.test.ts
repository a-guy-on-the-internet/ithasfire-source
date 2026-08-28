import { describe, expect, it } from "vitest";

import {
  addPromoCode,
  adjustItemQty,
  checkoutSelectionReducer,
  clampDonationCents,
  createInitialCheckoutState,
  defaultDonationCents,
  estimateSubtotalCents,
  formatCentsAsDollarsInput,
  maxSelectableQty,
  MAX_PROMO_CODES,
  MAX_QTY_PER_TYPE,
  parseDollarsToCents,
  removePromoCode,
  setItemDonationCents,
  toCheckoutItems,
  totalSelectedQty,
  type CheckoutItems,
  type CheckoutSelectionState,
  type CheckoutTicketType,
} from "../checkout-selection";

const fixed = (overrides: Partial<CheckoutTicketType> = {}): CheckoutTicketType => ({
  id: "tt-fixed",
  pricingMode: "FIXED",
  priceCents: 2500,
  minimumCents: null,
  suggestedCents: null,
  capacity: 100,
  ...overrides,
});

const adjustable = (
  overrides: Partial<CheckoutTicketType> = {},
): CheckoutTicketType => ({
  id: "tt-adjustable",
  pricingMode: "ADJUSTABLE",
  priceCents: 0,
  minimumCents: 500,
  suggestedCents: 1500,
  capacity: 100,
  ...overrides,
});

describe("maxSelectableQty", () => {
  it("caps at MAX_QTY_PER_TYPE when capacity is plentiful", () => {
    expect(maxSelectableQty(fixed({ capacity: 100 }))).toBe(MAX_QTY_PER_TYPE);
  });

  it("uses capacity when below the UI cap", () => {
    expect(maxSelectableQty(fixed({ capacity: 3 }))).toBe(3);
  });

  it("treats null capacity as unbounded (UI cap applies)", () => {
    expect(maxSelectableQty(fixed({ capacity: null }))).toBe(MAX_QTY_PER_TYPE);
  });

  it("returns 0 for sold out (capacity <= 0)", () => {
    expect(maxSelectableQty(fixed({ capacity: 0 }))).toBe(0);
    expect(maxSelectableQty(fixed({ capacity: -2 }))).toBe(0);
  });
});

describe("quantity adjustments", () => {
  it("increments and decrements within bounds", () => {
    const tt = fixed({ capacity: 2 });
    let items: CheckoutItems = {};
    items = adjustItemQty(items, tt, 1);
    expect(items[tt.id]?.qty).toBe(1);
    items = adjustItemQty(items, tt, 1);
    expect(items[tt.id]?.qty).toBe(2);
    items = adjustItemQty(items, tt, 1); // capacity bound
    expect(items[tt.id]?.qty).toBe(2);
  });

  it("never goes below zero and removes the entry at zero", () => {
    const tt = fixed();
    let items = adjustItemQty({}, tt, 1);
    items = adjustItemQty(items, tt, -1);
    expect(items[tt.id]).toBeUndefined();
    expect(adjustItemQty(items, tt, -1)).toEqual({});
  });

  it("clamps at the UI cap even with unbounded capacity", () => {
    const tt = fixed({ capacity: null });
    let items: CheckoutItems = {};
    for (let i = 0; i < 15; i += 1) items = adjustItemQty(items, tt, 1);
    expect(items[tt.id]?.qty).toBe(MAX_QTY_PER_TYPE);
  });

  it("seeds the default donation when an ADJUSTABLE type is first selected", () => {
    const tt = adjustable();
    const items = adjustItemQty({}, tt, 1);
    expect(items[tt.id]).toEqual({ qty: 1, donationAmountCents: 1500 });
  });

  it("preserves a customized donation when the qty changes", () => {
    const tt = adjustable();
    let items = adjustItemQty({}, tt, 1);
    items = setItemDonationCents(items, tt, 2200);
    items = adjustItemQty(items, tt, 1);
    expect(items[tt.id]).toEqual({ qty: 2, donationAmountCents: 2200 });
  });

  it("does not attach a donation to FIXED types", () => {
    const tt = fixed();
    const items = adjustItemQty({}, tt, 1);
    expect(items[tt.id]).toEqual({ qty: 1 });
  });
});

describe("donation clamping", () => {
  it("clamps below-minimum amounts up to minimumCents", () => {
    expect(clampDonationCents(adjustable(), 100)).toBe(500);
  });

  it("allows amounts at or above the minimum", () => {
    expect(clampDonationCents(adjustable(), 500)).toBe(500);
    expect(clampDonationCents(adjustable(), 9900)).toBe(9900);
  });

  it("treats a null minimum as 0", () => {
    expect(clampDonationCents(adjustable({ minimumCents: null }), 0)).toBe(0);
  });

  it("truncates fractional cents and rejects non-finite input", () => {
    expect(clampDonationCents(adjustable(), 1500.9)).toBe(1500);
    expect(clampDonationCents(adjustable(), Number.NaN)).toBe(500);
  });

  it("defaults to suggested → minimum → price, in that order", () => {
    expect(defaultDonationCents(adjustable())).toBe(1500);
    expect(defaultDonationCents(adjustable({ suggestedCents: null }))).toBe(
      500,
    );
    expect(
      defaultDonationCents(
        adjustable({
          suggestedCents: null,
          minimumCents: null,
          priceCents: 800,
        }),
      ),
    ).toBe(800);
  });

  it("setItemDonationCents ignores FIXED types and unselected types", () => {
    const items = adjustItemQty({}, fixed(), 1);
    expect(setItemDonationCents(items, fixed(), 9999)).toBe(items);
    expect(setItemDonationCents({}, adjustable(), 9999)).toEqual({});
  });
});

describe("promo codes", () => {
  it("adds a trimmed code", () => {
    const result = addPromoCode([], "  SUMMER25  ");
    expect(result).toEqual({ ok: true, codes: ["SUMMER25"] });
  });

  it("rejects codes shorter than 3 characters", () => {
    expect(addPromoCode([], "ab")).toEqual({ ok: false, reason: "too_short" });
  });

  it("rejects codes longer than 64 characters", () => {
    expect(addPromoCode([], "x".repeat(65))).toEqual({
      ok: false,
      reason: "too_long",
    });
  });

  it("dedupes case-insensitively", () => {
    expect(addPromoCode(["SUMMER25"], "summer25")).toEqual({
      ok: false,
      reason: "duplicate",
    });
  });

  it("caps the list at MAX_PROMO_CODES", () => {
    const five = ["AAA", "BBB", "CCC", "DDD", "EEE"];
    expect(five).toHaveLength(MAX_PROMO_CODES);
    expect(addPromoCode(five, "FFF")).toEqual({
      ok: false,
      reason: "limit_reached",
    });
  });

  it("removes only the matching code", () => {
    expect(removePromoCode(["AAA", "BBB"], "AAA")).toEqual(["BBB"]);
  });
});

describe("derived selection values", () => {
  const ticketTypes = [fixed(), adjustable()];

  it("sums total qty across types", () => {
    let items = adjustItemQty({}, fixed(), 1);
    items = adjustItemQty(items, fixed(), 1);
    items = adjustItemQty(items, adjustable(), 1);
    expect(totalSelectedQty(items, ticketTypes)).toBe(3);
  });

  it("excludes selections whose ticket type vanished from the list", () => {
    let items = adjustItemQty({}, fixed(), 1);
    items = adjustItemQty(items, fixed(), 1);
    items = adjustItemQty(items, adjustable(), 1);
    // A refetch dropped the adjustable type: its qty must not count.
    expect(totalSelectedQty(items, [fixed()])).toBe(2);
  });

  it("counts 0 when every selected type vanished (hasSelection false)", () => {
    let items = adjustItemQty({}, fixed(), 1);
    items = adjustItemQty(items, adjustable(), 1);
    expect(totalSelectedQty(items, [])).toBe(0);
  });

  it("estimates the subtotal as price×qty + donation×qty", () => {
    let items = adjustItemQty({}, fixed(), 1); // 2500
    items = adjustItemQty(items, fixed(), 1); // 5000
    items = adjustItemQty(items, adjustable(), 1); // + 1500 (suggested)
    items = setItemDonationCents(items, adjustable(), 2000); // + 2000 instead
    expect(estimateSubtotalCents(items, ticketTypes)).toBe(7000);
  });

  it("returns 0 for an empty selection", () => {
    expect(estimateSubtotalCents({}, ticketTypes)).toBe(0);
    expect(totalSelectedQty({}, ticketTypes)).toBe(0);
  });

  it("shapes items to the createCheckout schema (donation only when ADJUSTABLE)", () => {
    let items = adjustItemQty({}, fixed(), 1);
    items = adjustItemQty(items, fixed(), 1);
    items = adjustItemQty(items, adjustable(), 1);
    expect(toCheckoutItems(items, ticketTypes)).toEqual([
      { ticketTypeId: "tt-fixed", qty: 2 },
      { ticketTypeId: "tt-adjustable", qty: 1, donationAmountCents: 1500 },
    ]);
  });

  it("omits zero-qty rows from the payload", () => {
    expect(toCheckoutItems({}, ticketTypes)).toEqual([]);
  });
});

describe("clientKey lifecycle (reducer)", () => {
  let counter = 0;
  const generateKey = () => `test-key-${(counter += 1)}`;

  const initial = (): CheckoutSelectionState =>
    createInitialCheckoutState(generateKey);

  it("generates a key (>= 8 chars) once at creation", () => {
    const state = initial();
    expect(state.clientKey.length).toBeGreaterThanOrEqual(8);
  });

  it("stays stable across cart edits (retry safety)", () => {
    let state = initial();
    const key = state.clientKey;
    state = checkoutSelectionReducer(state, {
      type: "ADJUST_QTY",
      ticketType: fixed(),
      delta: 1,
    });
    state = checkoutSelectionReducer(state, {
      type: "ADD_PROMO_CODE",
      code: "SUMMER25",
    });
    state = checkoutSelectionReducer(state, {
      type: "SET_DONATION_CENTS",
      ticketType: adjustable(),
      cents: 2000,
    });
    expect(state.clientKey).toBe(key);
  });

  it("rotates only via ROTATE_CLIENT_KEY", () => {
    const state = initial();
    const rotated = checkoutSelectionReducer(state, {
      type: "ROTATE_CLIENT_KEY",
      nextKey: generateKey(),
    });
    expect(rotated.clientKey).not.toBe(state.clientKey);
    expect(rotated.items).toBe(state.items);
    expect(rotated.promoCodes).toBe(state.promoCodes);
  });

  it("ignores invalid ADD_PROMO_CODE actions without state churn", () => {
    const state = initial();
    expect(
      checkoutSelectionReducer(state, { type: "ADD_PROMO_CODE", code: "ab" }),
    ).toBe(state);
  });
});

describe("parseDollarsToCents", () => {
  it.each([
    ["12", 1200],
    ["12.5", 1250],
    ["12.50", 1250],
    ["12.", 1200],
    ["0.99", 99],
    [".99", 99],
    ["$1,200.50", 120050],
    [" 25 ", 2500],
    ["0", 0],
    // Trailing decimal comma — fr/de/es decimal pads emit "," not ".".
    ["1,50", 150],
  ])("parses %s → %d cents", (input, expected) => {
    expect(parseDollarsToCents(input)).toBe(expected);
  });

  it.each([
    ["", null],
    [".", null],
    ["abc", null],
    ["12.345", null],
    ["-5", null],
    ["1.2.3", null],
    // European mixed style is REJECTED (pinned), not parsed as 1234.56.
    ["1.234,56", null],
    // Internal whitespace must not collapse to "12".
    ["1 2", null],
    // Comma that's neither a decimal comma nor strict thousands grouping.
    ["1,2345", null],
    // Overflow: Number.isSafeInteger guard.
    ["99999999999999999999", null],
  ])("rejects %s", (input, expected) => {
    expect(parseDollarsToCents(input)).toBe(expected);
  });
});

describe("formatCentsAsDollarsInput", () => {
  it.each([
    [1200, "12"],
    [1250, "12.50"],
    [99, "0.99"],
    [5, "0.05"],
    [0, "0"],
  ])("formats %d cents → %s", (cents, expected) => {
    expect(formatCentsAsDollarsInput(cents)).toBe(expected);
  });

  it("round-trips with parseDollarsToCents", () => {
    for (const cents of [0, 5, 99, 100, 1250, 120050]) {
      expect(parseDollarsToCents(formatCentsAsDollarsInput(cents))).toBe(cents);
    }
  });
});
