import { describe, expect, it } from "vitest";

import {
  adjustableSliderMaxCents,
  cartEntries,
  cartTicketCount,
  centsToEditableDollars,
  defaultAdjustableAmountCents,
  isItemSellable,
  lineUnitPriceCents,
  parseDollarsToCents,
  setAdjustableAmount,
  stepQuantity,
  toSaleItems,
  type Cart,
  type SellableItem,
} from "../sell-cart";
import { magnetizeAmountCents } from "@/lib/pricing/pay-what-you-want";

const ga: SellableItem = {
  ticketTypeId: "tt-ga",
  name: "General admission",
  unitPriceCents: 2500,
  pricingMode: "FIXED",
  minimumCents: null,
  suggestedCents: null,
  capacityRemaining: 42,
  sellability: { available: true, reason: "ok", opensAt: null, closedAt: null },
};

const pwyc: SellableItem = {
  ticketTypeId: "tt-pwyc",
  name: "Pay what you can",
  // An ADJUSTABLE tier stores priceCents 0 — this field is informational only.
  unitPriceCents: 0,
  pricingMode: "ADJUSTABLE",
  minimumCents: 500,
  suggestedCents: 2000,
  capacityRemaining: 10,
  sellability: { available: true, reason: "ok", opensAt: null, closedAt: null },
};

const soldOut: SellableItem = {
  ...ga,
  ticketTypeId: "tt-soldout",
  name: "Early bird",
  capacityRemaining: 0,
};

const notYet: SellableItem = {
  ...ga,
  ticketTypeId: "tt-vip",
  name: "VIP",
  sellability: {
    available: false,
    reason: "not_yet_on_sale",
    opensAt: new Date("2026-08-26T20:00:00Z"),
    closedAt: null,
  },
};

const items = [ga, pwyc, soldOut, notYet];

describe("stepQuantity", () => {
  it("adds and removes tickets", () => {
    let cart: Cart = {};
    cart = stepQuantity(cart, ga, 1);
    cart = stepQuantity(cart, ga, 1);
    expect(cart["tt-ga"]?.qty).toBe(2);

    cart = stepQuantity(cart, ga, -1);
    expect(cart["tt-ga"]?.qty).toBe(1);
  });

  it("drops the line entirely at zero rather than keeping a qty-0 entry", () => {
    let cart = stepQuantity({}, ga, 1);
    cart = stepQuantity(cart, ga, -1);
    expect(cart).toEqual({});
  });

  it("forgets a pay-what-you-can amount when the line is removed", () => {
    let cart = stepQuantity({}, pwyc, 1);
    cart = setAdjustableAmount(cart, pwyc, 7500);
    expect(cart["tt-pwyc"]?.donationAmountCents).toBe(7500);

    // Removing and re-adding must NOT resurrect $75 — the operator would see
    // a price they never set for the next customer.
    cart = stepQuantity(cart, pwyc, -1);
    cart = stepQuantity(cart, pwyc, 1);
    expect(cart["tt-pwyc"]?.donationAmountCents).toBe(2000);
  });

  it("clamps to the remaining capacity", () => {
    const scarce: SellableItem = { ...ga, capacityRemaining: 2 };
    let cart: Cart = {};
    for (let i = 0; i < 5; i += 1) cart = stepQuantity(cart, scarce, 1);
    expect(cart[scarce.ticketTypeId]?.qty).toBe(2);
  });

  it("never goes negative", () => {
    const cart = stepQuantity({}, ga, -1);
    expect(cart).toEqual({});
  });

  it("seeds an ADJUSTABLE line at the suggested amount", () => {
    const cart = stepQuantity({}, pwyc, 1);
    expect(cart["tt-pwyc"]?.donationAmountCents).toBe(2000);
  });

  it("seeds at the FLOOR when there is no suggestion", () => {
    const noSuggestion: SellableItem = { ...pwyc, suggestedCents: null };
    const cart = stepQuantity({}, noSuggestion, 1);
    // Never 0 — a tier with a $5 floor prefilled to $0 puts the operator one
    // tap from a sale the server refuses, at a door, with someone waiting.
    expect(cart[noSuggestion.ticketTypeId]?.donationAmountCents).toBe(500);
  });

  it("keeps an already-set amount when quantity changes", () => {
    let cart = stepQuantity({}, pwyc, 1);
    cart = setAdjustableAmount(cart, pwyc, 3500);
    cart = stepQuantity(cart, pwyc, 1);
    expect(cart["tt-pwyc"]).toEqual({ qty: 2, donationAmountCents: 3500 });
  });
});

describe("defaultAdjustableAmountCents", () => {
  it("never suggests below the floor", () => {
    const weird: SellableItem = {
      ...pwyc,
      minimumCents: 3000,
      suggestedCents: 1000,
    };
    expect(defaultAdjustableAmountCents(weird)).toBe(3000);
  });
});

describe("setAdjustableAmount", () => {
  it("clamps up to the floor", () => {
    let cart = stepQuantity({}, pwyc, 1);
    cart = setAdjustableAmount(cart, pwyc, 100);
    expect(cart["tt-pwyc"]?.donationAmountCents).toBe(500);
  });

  it("does NOT clamp at the top — the slider ceiling is a convenience", () => {
    let cart = stepQuantity({}, pwyc, 1);
    cart = setAdjustableAmount(cart, pwyc, 500_00);
    expect(cart["tt-pwyc"]?.donationAmountCents).toBe(50_000);
  });

  it("is a no-op for a tier that isn't in the cart", () => {
    const cart = setAdjustableAmount({}, pwyc, 3000);
    expect(cart).toEqual({});
  });
});

describe("pricing a cart's lines (the total is the server's quote)", () => {
  it("prices a FIXED line at the server-resolved price", () => {
    const cart = stepQuantity({}, ga, 1);
    expect(lineUnitPriceCents(ga, cart["tt-ga"]!)).toBe(2500);
    expect(cartEntries(cart, items)[0]!.unitPriceCents).toBe(2500);
  });

  it("prices an ADJUSTABLE line at the named amount, not the stored price", () => {
    let cart = stepQuantity({}, pwyc, 2);
    cart = setAdjustableAmount(cart, pwyc, 1500);
    // The trap: `unitPriceCents` on this row is 0.
    const [entry] = cartEntries(cart, items);
    expect(entry!.unitPriceCents).toBe(1500);
    expect(entry!.line.qty).toBe(2);
  });

  it("counts a mixed cart's tickets and keeps each line's price apart", () => {
    let cart = stepQuantity({}, ga, 2);
    cart = stepQuantity(cart, pwyc, 1);
    cart = setAdjustableAmount(cart, pwyc, 2000);
    expect(cartEntries(cart, items).map((e) => e.unitPriceCents)).toEqual([
      2500,
      2000,
    ]);
    expect(cartTicketCount(cart, items)).toBe(3);
  });

  it("returns entries in catalogue order and skips empty lines", () => {
    let cart = stepQuantity({}, pwyc, 1);
    cart = stepQuantity(cart, ga, 1);
    expect(cartEntries(cart, items).map((e) => e.item.ticketTypeId)).toEqual([
      "tt-ga",
      "tt-pwyc",
    ]);
  });
});

describe("isItemSellable", () => {
  it("refuses a sold-out tier", () => {
    expect(isItemSellable(soldOut)).toBe(false);
  });

  it("refuses a tier that isn't on sale yet", () => {
    expect(isItemSellable(notYet)).toBe(false);
  });

  it("allows a live tier with capacity", () => {
    expect(isItemSellable(ga)).toBe(true);
  });
});

describe("toSaleItems", () => {
  it("emits donationAmountCents ONLY for adjustable lines", () => {
    let cart = stepQuantity({}, ga, 2);
    cart = stepQuantity(cart, pwyc, 1);
    cart = setAdjustableAmount(cart, pwyc, 3500);

    expect(toSaleItems(cart, items)).toEqual([
      { ticketTypeId: "tt-ga", qty: 2 },
      { ticketTypeId: "tt-pwyc", qty: 1, donationAmountCents: 3500 },
    ]);
  });

  it("never leaks a stray amount onto a fixed line", () => {
    const cart: Cart = { "tt-ga": { qty: 1, donationAmountCents: 1 } };
    expect(toSaleItems(cart, items)).toEqual([
      { ticketTypeId: "tt-ga", qty: 1 },
    ]);
  });
});

describe("magnetizeAmountCents (the box office passes no anchors)", () => {
  it("pulls a near-$5 drag onto the $5", () => {
    expect(magnetizeAmountCents(1996)).toBe(2000);
    expect(magnetizeAmountCents(2035)).toBe(2000);
  });

  it("pulls a near-dollar drag onto the dollar", () => {
    expect(magnetizeAmountCents(1710)).toBe(1700);
    expect(magnetizeAmountCents(1685)).toBe(1700);
  });

  it("leaves a deliberate in-between amount alone", () => {
    // $17.35 is 35¢ off the nearest dollar and 165¢ off the nearest $5 — you
    // can still stop here, you just have to mean it.
    expect(magnetizeAmountCents(1735)).toBe(1735);
  });

  it("is idempotent on an already-round amount", () => {
    expect(magnetizeAmountCents(2000)).toBe(2000);
    expect(magnetizeAmountCents(1700)).toBe(1700);
  });
});

describe("parseDollarsToCents", () => {
  it("parses plain and decorated dollar strings", () => {
    expect(parseDollarsToCents("20")).toBe(2000);
    expect(parseDollarsToCents("17.35")).toBe(1735);
    expect(parseDollarsToCents("$1,250")).toBe(125_000);
    expect(parseDollarsToCents(" 20 ")).toBe(2000);
  });

  it("returns null for empty or junk rather than snapping the price to zero", () => {
    expect(parseDollarsToCents("")).toBeNull();
    expect(parseDollarsToCents("abc")).toBeNull();
    expect(parseDollarsToCents("-5")).toBeNull();
    expect(parseDollarsToCents("1.2.3")).toBeNull();
  });

  it("rounds sub-cent input rather than truncating", () => {
    expect(parseDollarsToCents("17.999")).toBe(1800);
  });
});

describe("centsToEditableDollars", () => {
  it("drops the decimals on whole dollars", () => {
    expect(centsToEditableDollars(2000)).toBe("20");
  });

  it("keeps them otherwise", () => {
    expect(centsToEditableDollars(1735)).toBe("17.35");
    expect(centsToEditableDollars(1750)).toBe("17.50");
  });
});

describe("adjustableSliderMaxCents", () => {
  it("leaves obvious room above the suggested amount", () => {
    expect(adjustableSliderMaxCents(pwyc)).toBe(8000);
  });

  it("still gives a draggable range for a tiny tier", () => {
    const tiny: SellableItem = {
      ...pwyc,
      minimumCents: 100,
      suggestedCents: 200,
    };
    // A $2 tier would otherwise get an $8 track — a one-pixel handle.
    expect(adjustableSliderMaxCents(tiny)).toBe(5000);
  });

  it("falls back to a multiple of the floor when there is no suggestion", () => {
    const noSuggestion: SellableItem = {
      ...pwyc,
      minimumCents: 1000,
      suggestedCents: null,
    };
    expect(adjustableSliderMaxCents(noSuggestion)).toBe(20_000);
  });
});
