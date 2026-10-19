import { describe, expect, it } from "vitest";

import {
  estimateCartTotal,
  type FeeRatesForOrderEstimate,
} from "@/lib/pricing/order-estimate";

import {
  heldSeatQuotes,
  mapSeatQuotes,
  shownCartLines,
  shownLineCentsByTicketType,
  withSeatQuotes,
} from "./checkout-seat-quotes";

const RES = { id: "tt-res", pricingMode: "FIXED" as const };
const PWYW = {
  id: "tt-pwyw",
  pricingMode: "ADJUSTABLE" as const,
  minimumCents: 500,
};

const mapSeats = [
  { id: "s-override", priceOverride: { priceCents: 5000 } },
  { id: "s-free", priceOverride: { priceCents: 0 } },
  { id: "s-plain", priceOverride: null },
  { id: "s-bad", priceOverride: { priceCents: 12.5 } },
];

const line = (meta: unknown, unitPriceCents: number, kind = "ticket") => ({
  kind,
  ticketTypeId: RES.id,
  unitPriceCents,
  meta,
});

describe("mapSeatQuotes: the hold quotes override seats only", () => {
  it("quotes each override at its amount ($0 included) and skips plain seats", () => {
    expect([...mapSeatQuotes(mapSeats)]).toEqual([
      ["s-override", 5000],
      ["s-free", 0],
    ]);
  });

  it("an unloaded map quotes nothing", () => {
    expect(mapSeatQuotes(undefined).size).toBe(0);
  });
});

describe("heldSeatQuotes: Pay quotes the held summary's seat lines", () => {
  it("reads meta.seatId, or a one-seat meta.seatIds, at the line's unit price", () => {
    expect([
      ...heldSeatQuotes([
        line({ seatId: "s1", seatIds: ["s1"] }, 5000),
        line({ seatIds: ["s2"] }, 3000),
      ]),
    ]).toEqual([
      ["s1", 5000],
      ["s2", 3000],
    ]);
  });

  it("skips multi-seat lines, unseated lines and non-ticket lines", () => {
    expect(
      heldSeatQuotes([
        line({ seatIds: ["s1", "s2"] }, 4000),
        line({}, 3000),
        line({ seatId: "s3" }, -500, "discount"),
      ]).size,
    ).toBe(0);
  });
});

describe("withSeatQuotes", () => {
  const quotes = new Map([
    ["s-override", 5000],
    ["s-plain", 3000],
  ]);

  it("attaches a quote for each picked seat the map names", () => {
    expect(
      withSeatQuotes(
        [{ ticketTypeId: RES.id, qty: 3, seatIds: ["s-override", "s-plain", "s-x"] }],
        [RES],
        quotes,
      ),
    ).toEqual([
      {
        ticketTypeId: RES.id,
        qty: 3,
        seatIds: ["s-override", "s-plain", "s-x"],
        seatQuotes: [
          { seatId: "s-override", unitPriceCents: 5000 },
          { seatId: "s-plain", unitPriceCents: 3000 },
        ],
      },
    ]);
  });

  it("never quotes a pay-what-you-want seat, an unseated item, or with no quotes", () => {
    const pwyw = [
      { ticketTypeId: PWYW.id, qty: 1, seatIds: ["s-override"], donationAmountCents: 2500 },
    ];
    expect(withSeatQuotes(pwyw, [PWYW], quotes)).toEqual(pwyw);
    const ga = [{ ticketTypeId: RES.id, qty: 2 }];
    expect(withSeatQuotes(ga, [RES], quotes)).toEqual(ga);
    const seated = [{ ticketTypeId: RES.id, qty: 1, seatIds: ["s-override"] }];
    expect(withSeatQuotes(seated, [RES], new Map())).toEqual(seated);
  });
});

describe("shownCartLines: step 1 prices the cart as the map shows it", () => {
  const RES_35 = { ...RES, priceCents: 3500 };
  const PWYW_0 = { ...PWYW, priceCents: 0 };
  const chosen = () => 2500;

  it("each picked override seat at its override, the rest of the qty at the tier price", () => {
    const lines = shownCartLines(
      [RES_35],
      { [RES.id]: 3 },
      { [RES.id]: ["s-override", "s-plain", "s-free"] },
      mapSeats,
      chosen,
    );
    expect(lines).toEqual([
      { ticketTypeId: RES.id, qty: 1, priceCents: 3500, chosenAmountCents: null },
      { ticketTypeId: RES.id, qty: 1, priceCents: 5000, chosenAmountCents: 5000 },
      { ticketTypeId: RES.id, qty: 1, priceCents: 0, chosenAmountCents: 0 },
    ]);
    expect(shownLineCentsByTicketType(lines)).toEqual({ [RES.id]: 8500 });
  });

  it("seats sharing an override are one line; a corrupt override is the tier price", () => {
    const seats = [
      { id: "a", priceOverride: { priceCents: 5000 } },
      { id: "b", priceOverride: { priceCents: 5000 } },
      { id: "c", priceOverride: { priceCents: 12.5 } },
    ];
    expect(
      shownCartLines([RES_35], { [RES.id]: 3 }, { [RES.id]: ["a", "b", "c"] }, seats, chosen),
    ).toEqual([
      { ticketTypeId: RES.id, qty: 1, priceCents: 3500, chosenAmountCents: null },
      { ticketTypeId: RES.id, qty: 2, priceCents: 5000, chosenAmountCents: 5000 },
    ]);
  });

  it("CONTROL: no map loaded, GA (no seats), or no quantity → the tier price (or nothing)", () => {
    const tierOnly = [
      { ticketTypeId: RES.id, qty: 2, priceCents: 3500, chosenAmountCents: null },
    ];
    expect(
      shownCartLines([RES_35], { [RES.id]: 2 }, { [RES.id]: ["s-override", "s-plain"] }, undefined, chosen),
    ).toEqual(tierOnly);
    expect(shownCartLines([RES_35], { [RES.id]: 2 }, {}, mapSeats, chosen)).toEqual(tierOnly);
    expect(shownCartLines([RES_35], { [RES.id]: 0 }, { [RES.id]: ["s-override"] }, mapSeats, chosen)).toEqual([]);
  });

  it("a pay-what-you-want tier is the buyer's amount; a seat override never applies there", () => {
    expect(
      shownCartLines([PWYW_0], { [PWYW.id]: 1 }, { [PWYW.id]: ["s-override"] }, mapSeats, chosen),
    ).toEqual([
      { ticketTypeId: PWYW.id, qty: 1, priceCents: 0, chosenAmountCents: 2500 },
    ]);
  });

  it("parity: the estimated total of a $50 override seat equals a $50 ticket's, never the $35 tier's", () => {
    // 3.33% capped at 50¢, Stripe 2.9% + 30¢, 8.88% tax (order-estimate tests).
    const rates: FeeRatesForOrderEstimate = {
      feeMode: "PASS_THROUGH",
      admissionTaxRateBps: 888,
      taxImpositions: [
        {
          code: "SALES",
          label: "Sales tax",
          jurisdiction: "US/GA",
          rateBps: 888,
          base: "TICKET_FACE",
          collector: "PLATFORM",
        },
      ],
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
        { ticketTypeId: RES.id, unitPriceCents: 3500, platformFeeCents: 50 },
        { ticketTypeId: "tt-50", unitPriceCents: 5000, platformFeeCents: 50 },
      ],
    };
    const seat = estimateCartTotal(
      rates,
      shownCartLines([RES_35], { [RES.id]: 1 }, { [RES.id]: ["s-override"] }, mapSeats, chosen),
    );
    const fixed50 = estimateCartTotal(rates, [
      { ticketTypeId: "tt-50", qty: 1, priceCents: 5000 },
    ]);
    const tier35 = estimateCartTotal(rates, [
      { ticketTypeId: RES.id, qty: 1, priceCents: 3500 },
    ]);
    expect(seat).not.toBeNull();
    expect(seat!.grossCents).toBe(5000);
    expect(seat).toEqual(fixed50);
    expect(seat!.totalCents).not.toBe(tier35!.totalCents);
  });
});
