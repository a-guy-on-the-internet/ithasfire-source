import { describe, expect, it, vi } from "vitest";

import type { Repos } from "@th/ports/repos";

import * as checkoutPromos from "../../orders/checkout-promos";
import {
  aggregateItems,
  computeOrderAmounts,
  type PayoutTermsContext,
  type TicketTypeSummary,
} from "../../orders/checkout-helpers";
import { previewPromos } from "../preview-promos";

// Pass-through spy: the preview's promo lines are captured and compared with
// the lines checkout hands to the same evaluator.
vi.mock("../../orders/checkout-promos", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../orders/checkout-promos")>();
  return {
    ...actual,
    evaluatePromoApplications: vi.fn(actual.evaluatePromoApplications),
  };
});

// ─────────────────────────────────────────────────────────────────────────────
// previewPromos with picked seats (seat-price-overrides, step 7a).
//
// Checkout charges a seat with a price override at that override and hands
// promo evaluation one line per distinct unit price (`computeOrderAmounts`).
// The preview must discount the same numbers, or a % code on a $50 seat in a
// $30 tier previews $15 off and charges $25 off.
// ─────────────────────────────────────────────────────────────────────────────

const EVENT_ID = "00000000-0000-4000-8000-0000000000e1";
const ORG_ID = "00000000-0000-4000-8000-0000000000a1";
const TT_RES = "00000000-0000-4000-8000-0000000000a2";
const TT_PWYW = "00000000-0000-4000-8000-0000000000a3";
const SECTION = "00000000-0000-4000-8000-0000000000c1";
const OTHER_SECTION = "00000000-0000-4000-8000-0000000000c2";
const S1 = "00000000-0000-4000-8000-0000000000d1";
const S2 = "00000000-0000-4000-8000-0000000000d2";
const S3 = "00000000-0000-4000-8000-0000000000d3";
const GONE = "00000000-0000-4000-8000-0000000000d9";
const NOW = new Date("2026-04-26T20:00:00Z");

const RES_TIER = {
  id: TT_RES,
  name: "Reserved",
  priceCents: 3000,
  pricingMode: "FIXED" as const,
  minimumCents: null,
  suggestedCents: null,
  capacity: 100,
  status: "ACTIVE" as const,
  seatSectionId: SECTION,
  scheduledPriceCents: null,
  scheduledPriceAt: null,
  salesOpenAt: null,
  salesCloseAt: null,
};

const PWYW_TIER = {
  ...RES_TIER,
  id: TT_PWYW,
  name: "Pay what you want",
  priceCents: 0,
  pricingMode: "ADJUSTABLE" as const,
  minimumCents: 500,
  suggestedCents: 1500,
};

type OverrideRow = {
  id: string;
  seatSectionId: string;
  priceOverride: { priceCents: number } | { invalid: true } | null;
};

const DEFAULT_SEATS: OverrideRow[] = [
  { id: S1, seatSectionId: SECTION, priceOverride: { priceCents: 5000 } },
  { id: S2, seatSectionId: SECTION, priceOverride: null },
  { id: S3, seatSectionId: SECTION, priceOverride: { priceCents: 5000 } },
];

function makeRepos(
  seats: OverrideRow[] = DEFAULT_SEATS,
  eventStatus: string = "PUBLISHED",
) {
  const promo = {
    id: "00000000-0000-4000-8000-0000000000b1",
    code: "HALF",
    codeNormalized: "HALF",
    kind: "PERCENT" as const,
    value: 50,
    currency: "usd",
    scope: "ORG" as const,
    scopeId: ORG_ID,
    startsAt: null,
    endsAt: null,
    maxRedemptions: null,
    maxRedemptionsPerHuman: null,
    minOrderCents: 0,
    maxDiscountCents: null,
    stackable: false,
    isPublic: false,
    status: "ACTIVE" as const,
  };
  const findPriceOverridesByIds = vi.fn(
    async ({ seatIds }: { seatIds: string[]; eventId: string }) =>
      seats.filter((seat) => seatIds.includes(seat.id)),
  );
  const repos = {
    events: {
      getById: vi.fn(async () => ({
        id: EVENT_ID,
        orgId: ORG_ID,
        humanId: null,
        currency: "usd",
        status: eventStatus,
      })),
      listTicketTypes: vi.fn(async () => [RES_TIER, PWYW_TIER]),
    },
    promos: {
      findActiveByCodes: vi.fn(async () => [promo]),
      getRedemptionStats: vi.fn(async () => ({
        totalRedemptions: 0,
        redemptionsForHuman: 0,
      })),
    },
    seats: { findPriceOverridesByIds },
  } as unknown as Repos;
  return { repos, findPriceOverridesByIds };
}

const preview = (
  repos: Repos,
  ticketSelections: unknown[],
  extraDeps: { reportError?: (err: unknown, ctx?: unknown) => void } = {},
) =>
  previewPromos(
    { repos, clock: { now: () => NOW }, ...extraDeps },
    { eventId: EVENT_ID, codes: ["HALF"], ticketSelections },
  );

describe("previewPromos — picked seats on a FIXED tier", () => {
  it("prices an override seat at its override, and a % code discounts that price", async () => {
    const { repos, findPriceOverridesByIds } = makeRepos();
    const result = await preview(repos, [
      { ticketTypeId: TT_RES, qty: 1, seatIds: [S1] },
    ]);

    // $50 seat in a $30 tier: 50% of $50, not of $30.
    expect(result.orderSubtotalCents).toBe(5000);
    expect(result.totalDiscountCents).toBe(2500);
    expect(findPriceOverridesByIds).toHaveBeenCalledWith({
      seatIds: [S1],
      eventId: EVENT_ID,
    });
  });

  it("prices a mixed line per seat: override seats at theirs, the rest at the tier", async () => {
    const { repos } = makeRepos();
    const result = await preview(repos, [
      // Two picked seats ($50, plain) and one more ticket with no seat.
      { ticketTypeId: TT_RES, qty: 3, seatIds: [S1, S2] },
    ]);
    expect(result.orderSubtotalCents).toBe(5000 + 3000 + 3000);
    expect(result.totalDiscountCents).toBe(5500);
  });

  it("prices a stale seat id (gone, or another event's) at the tier, never throws", async () => {
    const { repos } = makeRepos();
    const result = await preview(repos, [
      { ticketTypeId: TT_RES, qty: 1, seatIds: [GONE] },
    ]);
    expect(result.orderSubtotalCents).toBe(3000);
    expect(result.totalDiscountCents).toBe(1500);
  });

  it("prices a seat outside the tier's section at the tier", async () => {
    const { repos } = makeRepos([
      {
        id: S1,
        seatSectionId: OTHER_SECTION,
        priceOverride: { priceCents: 5000 },
      },
    ]);
    const result = await preview(repos, [
      { ticketTypeId: TT_RES, qty: 1, seatIds: [S1] },
    ]);
    expect(result.orderSubtotalCents).toBe(3000);
  });

  it("prices a free override seat ($0) at $0, not the tier", async () => {
    const { repos } = makeRepos([
      { id: S1, seatSectionId: SECTION, priceOverride: { priceCents: 0 } },
      { id: S2, seatSectionId: SECTION, priceOverride: null },
    ]);
    const result = await preview(repos, [
      { ticketTypeId: TT_RES, qty: 2, seatIds: [S1, S2] },
    ]);
    // The free seat adds nothing; the plain one is the tier's $30.
    expect(result.orderSubtotalCents).toBe(3000);
    expect(result.totalDiscountCents).toBe(1500);
  });

  it("does not read seats when no line names any (the door / POS preview)", async () => {
    const { repos, findPriceOverridesByIds } = makeRepos();
    const result = await preview(repos, [{ ticketTypeId: TT_RES, qty: 2 }]);
    expect(result.orderSubtotalCents).toBe(6000);
    expect(findPriceOverridesByIds).not.toHaveBeenCalled();
  });

  it("an unpublished event's seats price at the tier, and are never read", async () => {
    // promos.preview is an unauthenticated read: it must not quote a seat
    // price the public seat map (PUBLISHED only) would not show.
    for (const status of ["DRAFT", "CANCELLED"]) {
      const { repos, findPriceOverridesByIds } = makeRepos(
        DEFAULT_SEATS,
        status,
      );
      const result = await preview(repos, [
        { ticketTypeId: TT_RES, qty: 1, seatIds: [S1] },
      ]);
      expect(result.orderSubtotalCents).toBe(3000);
      expect(findPriceOverridesByIds).not.toHaveBeenCalled();
    }
  });

  it("refuses a seat named on two lines", async () => {
    const { repos } = makeRepos();
    await expect(
      preview(repos, [
        { ticketTypeId: TT_RES, qty: 1, seatIds: [S1] },
        { ticketTypeId: TT_RES, qty: 1, seatIds: [S1] },
      ]),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("refuses more seats than tickets, and a seat named twice", async () => {
    const { repos } = makeRepos();
    await expect(
      preview(repos, [{ ticketTypeId: TT_RES, qty: 1, seatIds: [S1, S2] }]),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      preview(repos, [{ ticketTypeId: TT_RES, qty: 2, seatIds: [S1, S1] }]),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});

describe("previewPromos — a pay-what-you-want tier ignores seat ids (D-004)", () => {
  it("prices the buyer's amount and does not read the seats", async () => {
    const { repos, findPriceOverridesByIds } = makeRepos();
    const result = await preview(repos, [
      {
        ticketTypeId: TT_PWYW,
        qty: 1,
        donationAmountCents: 2000,
        seatIds: [S1],
      },
    ]);
    expect(result.orderSubtotalCents).toBe(2000);
    expect(result.totalDiscountCents).toBe(1000);
    expect(findPriceOverridesByIds).not.toHaveBeenCalled();
  });
});

describe("previewPromos — a corrupt stored override", () => {
  const corrupt = (): OverrideRow[] => [
    { id: S1, seatSectionId: SECTION, priceOverride: { invalid: true } },
  ];

  it("prices the seat at the tier and reports it", async () => {
    const { repos } = makeRepos(corrupt());
    const reportError = vi.fn();
    const result = await preview(
      repos,
      [{ ticketTypeId: TT_RES, qty: 1, seatIds: [S1] }],
      { reportError },
    );
    expect(result.orderSubtotalCents).toBe(3000);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "seat_price_override_invalid" }),
      {
        tags: { area: "promos", surface: "previewPromos" },
        extra: { eventId: EVENT_ID, seatId: S1 },
      },
    );
  });

  it("a throwing reporter does not change the preview", async () => {
    const { repos } = makeRepos(corrupt());
    const result = await preview(
      repos,
      [{ ticketTypeId: TT_RES, qty: 1, seatIds: [S1] }],
      {
        reportError: () => {
          throw new Error("reporter down");
        },
      },
    );
    expect(result.orderSubtotalCents).toBe(3000);
  });

  it("a fractional override is corrupt too", async () => {
    const { repos } = makeRepos([
      { id: S1, seatSectionId: SECTION, priceOverride: { priceCents: 12.5 } },
    ]);
    const reportError = vi.fn();
    const result = await preview(
      repos,
      [{ ticketTypeId: TT_RES, qty: 1, seatIds: [S1] }],
      { reportError },
    );
    expect(result.orderSubtotalCents).toBe(3000);
    expect(reportError).toHaveBeenCalledTimes(1);
  });
});

// ── Parity: the preview hands promo evaluation checkout's own lines ─────────

function checkoutContext(): PayoutTermsContext {
  return {
    agreement: {
      id: "agreement-1",
      kind: "PRIMARY",
      status: "ACTIVE",
      feeMode: null,
      feePolicyId: "policy-1",
      version: 1,
    },
    lines: [
      {
        id: "line-1",
        agreementId: "agreement-1",
        payeeId: "payee-1",
        percent: 100,
        floorCents: 0,
        capPercent: null,
        priority: 0,
        rounding: "FLOOR",
      },
    ],
    feePolicy: {
      id: "policy-1",
      version: 1,
      feeMode: "PASS_THROUGH",
      buyerFeePct: 0.05,
      maxFeeCents: null,
      minFeeCents: 0,
      maxPlatformFeeCents: null,
      platformFixedCents: 50,
      processsorFeePct: 0.029,
      processorFixedCents: 30,
      payoutPct: 0,
      payoutFixedCents: 0,
      monthlyPayoutCents: 0,
      payoutMinimumCents: 0,
    },
  } as unknown as PayoutTermsContext;
}

describe("previewPromos — parity with checkout's promo lines", () => {
  it("passes evaluatePromoApplications exactly the ticketLines and subtotal computeOrderAmounts produces", async () => {
    const evaluate = vi.mocked(checkoutPromos.evaluatePromoApplications);
    evaluate.mockClear();
    const { repos } = makeRepos();
    // S1 $50, S2 plain, S3 $50, then one unseated: first-seen order 50/30.
    const cart = [
      { ticketTypeId: TT_RES, qty: 4, seatIds: [S1, S2, S3] },
      { ticketTypeId: TT_PWYW, qty: 1, donationAmountCents: 1200 },
    ];
    await preview(repos, cart);

    const previewArgs = evaluate.mock.calls[0]![0];

    const checkout = computeOrderAmounts(
      // Checkout's own aggregation; it requires seatIds = qty, so the
      // unseated ticket rides as a second item of the same tier.
      aggregateItems([
        { ticketTypeId: TT_RES, qty: 3, seatIds: [S1, S2, S3] },
        { ticketTypeId: TT_PWYW, qty: 1, donationAmountCents: 1200 },
      ]),
      new Map<string, TicketTypeSummary>([
        [TT_RES, RES_TIER as unknown as TicketTypeSummary],
        [TT_PWYW, PWYW_TIER as unknown as TicketTypeSummary],
      ]),
      checkoutContext(),
      {
        now: NOW,
        seatPrices: new Map([
          [S1, 5000],
          [S2, null],
          [S3, 5000],
        ]),
      },
    );
    const unseated = computeOrderAmounts(
      aggregateItems([{ ticketTypeId: TT_RES, qty: 1 }]),
      new Map([[TT_RES, RES_TIER as unknown as TicketTypeSummary]]),
      checkoutContext(),
      { now: NOW, seatPrices: new Map() },
    );

    // The preview folds the unseated ticket into the tier's $30 line, which
    // checkout's two items yield as two $30 lines: same per-price totals.
    const byPrice = (
      lines: ReadonlyArray<{
        ticketTypeId: string;
        unitPriceCents: number;
        qty: number;
        lineGrossCents: number;
      }>,
    ) => {
      const out = new Map<string, { qty: number; gross: number }>();
      for (const l of lines) {
        const key = `${l.ticketTypeId}@${l.unitPriceCents}`;
        const prev = out.get(key) ?? { qty: 0, gross: 0 };
        out.set(key, { qty: prev.qty + l.qty, gross: prev.gross + l.lineGrossCents });
      }
      return out;
    };
    expect(byPrice(previewArgs.ticketLines)).toEqual(
      byPrice([...checkout.ticketLines, ...unseated.ticketLines]),
    );
    expect(previewArgs.orderSubtotalCents).toBe(
      checkout.amountGrossCents + unseated.amountGrossCents,
    );
  });

  it("a fully seated item yields line for line what checkout yields", async () => {
    const evaluate = vi.mocked(checkoutPromos.evaluatePromoApplications);
    evaluate.mockClear();
    const { repos } = makeRepos();
    await preview(repos, [
      { ticketTypeId: TT_RES, qty: 3, seatIds: [S2, S1, S3] },
    ]);
    const checkout = computeOrderAmounts(
      aggregateItems([{ ticketTypeId: TT_RES, qty: 3, seatIds: [S2, S1, S3] }]),
      new Map([[TT_RES, RES_TIER as unknown as TicketTypeSummary]]),
      checkoutContext(),
      {
        now: NOW,
        seatPrices: new Map([
          [S1, 5000],
          [S2, null],
          [S3, 5000],
        ]),
      },
    );
    expect(evaluate.mock.calls[0]![0].ticketLines).toEqual(
      checkout.ticketLines,
    );
    expect(evaluate.mock.calls[0]![0].orderSubtotalCents).toBe(
      checkout.amountGrossCents,
    );
  });
});
