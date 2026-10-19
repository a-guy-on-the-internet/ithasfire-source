import { describe, expect, it } from "vitest";

import {
  estimateCartTotal,
  type FeeRatesForOrderEstimate,
} from "@/lib/pricing/order-estimate";

import {
  embedCheckoutItems,
  embedEstimateItems,
  embedShownLineCents,
} from "./embed-pwyw";
import {
  pickedSeatQuotes,
  seatPickCartItem,
  seatSectionsInCart,
  withRefreshedSeatQuotes,
} from "./embed-seat-quotes";
import type { CartItem } from "./embed-types";

/**
 * The embed cart with picked seats that carry a price override
 * (seat-price-overrides, step 7a). The picker shows an override seat at its
 * own price; the summary must price it there, and checkout must quote it, so
 * the server refuses rather than charge a number the buyer did not see.
 */

const RES = {
  id: "tt-res",
  name: "Reserved",
  priceCents: 3000,
  pricingMode: "FIXED" as const,
  minimumCents: null,
  suggestedCents: null,
};
const PWYW = {
  id: "tt-pwyw",
  name: "Pay what you want",
  priceCents: 0,
  pricingMode: "ADJUSTABLE" as const,
  minimumCents: 500,
  suggestedCents: 1500,
};

// The seat data the picker shows: S1 overridden to $60, S2 plain, S3 at $10.
// (Chosen so the seats' sum, $100, differs from 3 × the $30 tier.)
const SEATS = [
  { id: "s1", priceOverride: { priceCents: 6000, buyerTotalCents: 6700 } },
  { id: "s2", priceOverride: null },
  { id: "s3", priceOverride: { priceCents: 1000, buyerTotalCents: 1150 } },
];

const feeRates: FeeRatesForOrderEstimate = {
  feeMode: "PASS_THROUGH",
  admissionTaxRateBps: 0,
  taxImpositions: [],
  processorPct: 0.029,
  processorFixedCents: 30,
  maxPlatformFeeCents: null,
  platformFeeRates: {
    buyerFeePct: 0.0333,
    maxFeeCents: 50,
    minFeeCents: 0,
    platformFixedCents: 0,
  },
  perTicketEstimates: [
    { ticketTypeId: RES.id, unitPriceCents: 3000, platformFeeCents: 50 },
    { ticketTypeId: PWYW.id, unitPriceCents: 500, platformFeeCents: 17 },
  ],
};

describe("the seat picker's confirmation", () => {
  it("keeps each picked seat that shows an override at that price, and no plain seat", () => {
    expect(pickedSeatQuotes(SEATS, ["s1", "s2"])).toEqual([
      { seatId: "s1", unitPriceCents: 6000 },
    ]);
  });

  it("stores the seats, their section and the quotes as one cart line", () => {
    expect(seatPickCartItem(RES.id, "sec-a", ["s1", "s2", "s3"], SEATS)).toEqual(
      {
        ticketTypeId: RES.id,
        qty: 3,
        seatIds: ["s1", "s2", "s3"],
        seatSectionId: "sec-a",
        seatQuotes: [
          { seatId: "s1", unitPriceCents: 6000 },
          { seatId: "s3", unitPriceCents: 1000 },
        ],
      },
    );
  });

  it("plain seats only: no quotes at all", () => {
    expect(seatPickCartItem(RES.id, "sec-a", ["s2"], SEATS)).toEqual({
      ticketTypeId: RES.id,
      qty: 1,
      seatIds: ["s2"],
      seatSectionId: "sec-a",
    });
  });

  it("a seat the seat data does not cover keeps its earlier quote (no data → never a silent drop)", () => {
    // Re-opened picker confirmed before its data arrived: seats = [].
    expect(
      seatPickCartItem(RES.id, "sec-a", ["s1", "s2"], [], [
        { seatId: "s1", unitPriceCents: 6000 },
      ]),
    ).toEqual({
      ticketTypeId: RES.id,
      qty: 2,
      seatIds: ["s1", "s2"],
      seatSectionId: "sec-a",
      seatQuotes: [{ seatId: "s1", unitPriceCents: 6000 }],
    });
  });

  it("…but fresh seat data wins: a listed seat is quoted from it alone", () => {
    const fresh = [
      { id: "s1", priceOverride: null },
      { id: "s3", priceOverride: { priceCents: 1200 } },
    ];
    expect(
      seatPickCartItem(RES.id, "sec-a", ["s1", "s3"], fresh, [
        { seatId: "s1", unitPriceCents: 6000 },
        { seatId: "s3", unitPriceCents: 1000 },
      ])?.seatQuotes,
    ).toEqual([{ seatId: "s3", unitPriceCents: 1200 }]);
  });

  it("a dropped seat's earlier quote is not carried", () => {
    expect(
      seatPickCartItem(RES.id, "sec-a", ["s2"], [], [
        { seatId: "s1", unitPriceCents: 6000 },
      ])?.seatQuotes,
    ).toBeUndefined();
  });

  it("nothing picked: no cart line", () => {
    expect(seatPickCartItem(RES.id, "sec-a", [], SEATS)).toBeNull();
  });
});

describe("the summary prices each override seat at its shown price", () => {
  const cart: CartItem[] = [
    seatPickCartItem(RES.id, "sec-a", ["s1", "s2", "s3"], SEATS)!,
    { ticketTypeId: PWYW.id, qty: 1, donationAmountCents: 2000 },
  ];

  it("regression: the line reads $60 + $30 + $10, not 3 × $30", () => {
    expect(embedShownLineCents(cart, [RES, PWYW])).toEqual({
      [RES.id]: 6000 + 3000 + 1000,
      [PWYW.id]: 2000,
    });
  });

  it("the estimate's subtotal equals the lines (the picker's prices), fees per seat price", () => {
    const estimate = estimateCartTotal(
      feeRates,
      embedEstimateItems(cart, [RES, PWYW]),
    )!;
    expect(estimate).not.toBeNull();
    const lines = embedShownLineCents(cart, [RES, PWYW]);
    expect(estimate.grossCents).toBe(
      Object.values(lines).reduce((a, b) => a + b, 0),
    );
    // 3.33% capped at 50¢ per ticket: $60 → 50¢, $30 → 50¢, $10 → 33¢,
    // $20 PWYW → 50¢. A tier-priced estimate would read 4 × 50¢.
    expect(estimate.platformFeeCents).toBe(50 + 50 + 33 + 50);
  });

  it("a seat a stale cart quotes for ANOTHER tier's line is not applied", () => {
    const strayQuote: CartItem[] = [
      { ticketTypeId: RES.id, qty: 1, seatIds: ["s2"], seatSectionId: "sec-a" },
      {
        ticketTypeId: "tt-other",
        qty: 1,
        seatIds: ["s9"],
        seatQuotes: [{ seatId: "s9", unitPriceCents: 9999 }],
      },
    ];
    expect(embedShownLineCents(strayQuote, [RES])).toEqual({ [RES.id]: 3000 });
  });
});

describe("the guest checkout's seatQuotes", () => {
  it("quotes override seats on a fixed tier only: never a plain seat", () => {
    const cart = [seatPickCartItem(RES.id, "sec-a", ["s1", "s2"], SEATS)!];
    expect(embedCheckoutItems(cart, [RES])).toEqual([
      {
        ticketTypeId: RES.id,
        qty: 2,
        seatIds: ["s1", "s2"],
        seatQuotes: [{ seatId: "s1", unitPriceCents: 6000 }],
      },
    ]);
  });

  it("never quotes a pay-what-you-want line, even with a stored quote", () => {
    const cart: CartItem[] = [
      {
        ticketTypeId: PWYW.id,
        qty: 1,
        seatIds: ["s1"],
        seatSectionId: "sec-a",
        donationAmountCents: 2000,
        seatQuotes: [{ seatId: "s1", unitPriceCents: 5000 }],
      },
    ];
    expect(embedCheckoutItems(cart, [PWYW])).toEqual([
      {
        ticketTypeId: PWYW.id,
        qty: 1,
        seatIds: ["s1"],
        donationAmountCents: 2000,
      },
    ]);
  });

  it("an unseated cart goes out unchanged", () => {
    expect(embedCheckoutItems([{ ticketTypeId: RES.id, qty: 2 }], [RES])).toEqual(
      [{ ticketTypeId: RES.id, qty: 2 }],
    );
  });
});

describe("after a seat_price_changed refusal", () => {
  const picked = (): CartItem[] => [
    seatPickCartItem(RES.id, "sec-a", ["s1", "s2"], SEATS)!,
    { ticketTypeId: PWYW.id, qty: 1, donationAmountCents: 2000 },
  ];

  it("re-quotes the seats from fresh data: the summary and the retry both carry the NEW price", () => {
    // The organizer moved S1 to $70 and gave S2 an override of $40.
    const fresh = new Map([
      [
        "sec-a",
        [
          { id: "s1", priceOverride: { priceCents: 7000 } },
          { id: "s2", priceOverride: { priceCents: 4000 } },
        ],
      ],
    ]);
    const cart = withRefreshedSeatQuotes(picked(), fresh);

    expect(embedShownLineCents(cart, [RES, PWYW])[RES.id]).toBe(7000 + 4000);
    expect(
      embedCheckoutItems(cart, [RES, PWYW]).find(
        (item) => item.ticketTypeId === RES.id,
      ),
    ).toEqual({
      ticketTypeId: RES.id,
      qty: 2,
      seatIds: ["s1", "s2"],
      seatQuotes: [
        { seatId: "s1", unitPriceCents: 7000 },
        { seatId: "s2", unitPriceCents: 4000 },
      ],
    });
    // The buyer's seats and other lines are kept.
    expect(cart[1]).toEqual(picked()[1]);
  });

  it("a seat whose override was removed is no longer quoted, and reads at the tier", () => {
    const fresh = new Map([
      [
        "sec-a",
        [
          { id: "s1", priceOverride: null },
          { id: "s2", priceOverride: null },
        ],
      ],
    ]);
    const cart = withRefreshedSeatQuotes(picked(), fresh);
    expect(cart[0]!.seatQuotes).toBeUndefined();
    expect(embedShownLineCents(cart, [RES])[RES.id]).toBe(6000);
    expect(embedCheckoutItems(cart, [RES])[0]!.seatQuotes).toBeUndefined();
  });

  it("a section whose re-read failed keeps its quote (refused again, never charged unseen)", () => {
    const before = picked();
    expect(withRefreshedSeatQuotes(before, new Map())).toEqual(before);
  });

  it("names each seated section once, and none for unseated lines", () => {
    expect(
      seatSectionsInCart([
        ...picked(),
        { ticketTypeId: "tt-b", qty: 1, seatIds: ["s7"], seatSectionId: "sec-a" },
        { ticketTypeId: "tt-c", qty: 1, seatIds: ["s8"], seatSectionId: "sec-b" },
      ]),
    ).toEqual(["sec-a", "sec-b"]);
  });
});
