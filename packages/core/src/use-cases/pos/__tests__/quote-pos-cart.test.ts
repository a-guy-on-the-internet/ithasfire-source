import { describe, expect, it, vi } from "vitest";

import { TaxRateLookupError } from "@th/ports/tax-rate-lookup";

import type { LocalTaxImpositionRule } from "../../../lib/pricing/tax-impositions";
import { MANUAL_EVENT_TAX_RATE_SOURCE } from "../../../lib/tax/manual-event-tax-rate";
import { quotePosCart } from "../quote-pos-cart";
import {
  CART,
  EVENT_ID,
  GA_ID,
  MINNEAPOLIS,
  MPLS_LINE,
  NASHVILLE,
  OPERATOR_ID,
  PORTLAND,
  ST_PAUL,
  VIP_ID,
  makeWorld,
  sellCard,
  sellCash,
  type Scenario,
  type World,
} from "./door-sale-world";

/**
 * `pos.quoteCart` (spec 2026-10-07 door-sales-same-price-and-tax, FR-010,
 * owner ruling R7): the Sell screen's totals, card AND cash, from the same
 * pricing the sale charges. Quote == charge to the cent, for the TN / MN /
 * no-tax carts the parity suites pin (door-card-parity.test.ts PINNED,
 * door-cash-parity.test.ts CASH; 2 × $25 GA + 1 × $40 VIP, 5% + 50¢ platform
 * fee, 2.9% + 30¢ processing). Read-only: no transaction, order, hold,
 * reservation or tax stamp.
 */
const localTaxRules = vi.hoisted(() => ({
  rules: [] as LocalTaxImpositionRule[],
}));
vi.mock("../../../lib/pricing/tax-impositions", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../lib/pricing/tax-impositions")>();
  return {
    ...actual,
    resolveTaxImpositions: (
      args: Parameters<typeof actual.resolveTaxImpositions>[0],
    ) => actual.resolveTaxImpositions(args, localTaxRules.rules),
  };
});

async function withRules<T>(
  rules: LocalTaxImpositionRule[] | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  localTaxRules.rules = rules ?? [];
  try {
    return await fn();
  } finally {
    localTaxRules.rules = [];
  }
}

function quoteDeps(w: World) {
  return {
    repos: w.repos,
    authz: w.authz,
    clock: w.clock,
    logger: w.logger,
    reportError: w.reportError,
    taxRateLookup: w.taxRateLookup as never,
  };
}

async function quote(
  w: World,
  scenario: Scenario,
  extra: { comp?: boolean; items?: typeof CART } = {},
) {
  return quotePosCart(quoteDeps(w), {
    actorHumanId: OPERATOR_ID,
    eventId: EVENT_ID,
    items: extra.items ?? CART,
    ...(scenario.promo ? { promoCodes: ["save"] } : {}),
    ...(extra.comp !== undefined ? { comp: extra.comp } : {}),
  });
}

/**
 * Everything the quote must never do (the sale's writes and reservations).
 * The tax self-heal stamp is checked too, except where a test asserts it: a
 * fresh lookup is the one thing the quote keeps.
 */
function expectNoWrites(w: World, opts: { taxStamp?: boolean } = {}): void {
  expect(w.callLog).not.toContain("tx");
  expect(w.tx.orders.createPending).not.toHaveBeenCalled();
  expect(w.tx.orders.createTaxLines).not.toHaveBeenCalled();
  expect(w.tx.feeWaivers.reserve).not.toHaveBeenCalled();
  expect(w.tx.feeWaivers.settle).not.toHaveBeenCalled();
  expect(w.tx.promos.createHolds).not.toHaveBeenCalled();
  expect(w.tx.promos.confirmHoldsForOrder).not.toHaveBeenCalled();
  expect(w.tx.humans.create).not.toHaveBeenCalled();
  expect(w.tx.humans.ensureGuestHuman).not.toHaveBeenCalled();
  expect(w.tx.audit.log).not.toHaveBeenCalled();
  if (!opts.taxStamp) {
    expect(w.tx.events.fillTaxRateIfUnset).not.toHaveBeenCalled();
  }
  expect(w.tx.events.lockRows).not.toHaveBeenCalled();
  expect(w.tx.payees.upsertForSubject).not.toHaveBeenCalled();
  expect(w.ledger.entries).toHaveLength(0);
  expect(w.idempotency.begin).not.toHaveBeenCalled();
  expect(w.payments.createCardPresentPaymentIntent).not.toHaveBeenCalled();
}

type ChannelPin = {
  ticketTotalCents: number;
  platformFeeCents: number;
  processingFeeCents: number;
  taxLines: Array<[string, number]>;
  taxAmountCents: number;
  totalCents: number;
};

// Card = door-card-parity PINNED (= online checkout); cash =
// door-cash-parity CASH. Literal cents, copied, not recomputed. Cash is the
// face (after any promo) + tax, no platform fee and no processing fee (owner
// ruling 2026-10-08), tax re-solved on the face: e.g. TN 9000 + round(9.75% ×
// 9000) = 9000 + 878 = 9878.
const MATRIX: Array<{
  name: string;
  scenario: Scenario;
  rules?: LocalTaxImpositionRule[];
  card: ChannelPin;
  cash: ChannelPin;
}> = [
  {
    name: "TN, Nashville (buyer-total base)",
    scenario: { situs: NASHVILLE, admissionTaxRateBps: 975 },
    card: {
      ticketTotalCents: 9000,
      platformFeeCents: 600,
      processingFeeCents: 347,
      taxLines: [["SALES", 970]],
      taxAmountCents: 970,
      totalCents: 10917,
    },
    cash: {
      ticketTotalCents: 9000,
      platformFeeCents: 0,
      processingFeeCents: 0,
      taxLines: [["SALES", 878]],
      taxAmountCents: 878,
      totalCents: 9878,
    },
  },
  {
    name: "MN, Minneapolis (state line + city entertainment line)",
    scenario: { situs: MINNEAPOLIS, admissionTaxRateBps: 903 },
    rules: [MPLS_LINE],
    card: {
      ticketTotalCents: 9000,
      platformFeeCents: 600,
      processingFeeCents: 353,
      taxLines: [
        ["SALES", 899],
        ["TEST_MPLS_ENTERTAINMENT", 270],
      ],
      taxAmountCents: 1169,
      totalCents: 11122,
    },
    // 9000 × 9.03% = 812.7 → 813; 9000 × 3% = 270.
    cash: {
      ticketTotalCents: 9000,
      platformFeeCents: 0,
      processingFeeCents: 0,
      taxLines: [
        ["SALES", 813],
        ["TEST_MPLS_ENTERTAINMENT", 270],
      ],
      taxAmountCents: 1083,
      totalCents: 10083,
    },
  },
  {
    name: "MN, St Paul (no city line)",
    scenario: { situs: ST_PAUL, admissionTaxRateBps: 888 },
    rules: [MPLS_LINE],
    card: {
      ticketTotalCents: 9000,
      platformFeeCents: 600,
      processingFeeCents: 344,
      taxLines: [["SALES", 883]],
      taxAmountCents: 883,
      totalCents: 10827,
    },
    // 9000 × 8.88% = 799.2 → 799.
    cash: {
      ticketTotalCents: 9000,
      platformFeeCents: 0,
      processingFeeCents: 0,
      taxLines: [["SALES", 799]],
      taxAmountCents: 799,
      totalCents: 9799,
    },
  },
  {
    name: "OR, Portland (no sales tax)",
    scenario: { situs: PORTLAND, admissionTaxRateBps: 0 },
    card: {
      ticketTotalCents: 9000,
      platformFeeCents: 600,
      processingFeeCents: 318,
      taxLines: [],
      taxAmountCents: 0,
      totalCents: 9918,
    },
    cash: {
      ticketTotalCents: 9000,
      platformFeeCents: 0,
      processingFeeCents: 0,
      taxLines: [],
      taxAmountCents: 0,
      totalCents: 9000,
    },
  },
  {
    name: "TN with an organiser fee waiver on one ticket (previewed, not reserved)",
    scenario: { situs: NASHVILLE, admissionTaxRateBps: 975, waiverTickets: 1 },
    card: {
      ticketTotalCents: 9000,
      platformFeeCents: 350,
      processingFeeCents: 339,
      taxLines: [["SALES", 945]],
      taxAmountCents: 945,
      totalCents: 10634,
    },
    // The waiver applies to the card only: cash has no fee to waive, so it
    // prices exactly as the TN row.
    cash: {
      ticketTotalCents: 9000,
      platformFeeCents: 0,
      processingFeeCents: 0,
      taxLines: [["SALES", 878]],
      taxAmountCents: 878,
      totalCents: 9878,
    },
  },
  {
    name: "TN with a $5 promo",
    scenario: {
      situs: NASHVILLE,
      admissionTaxRateBps: 975,
      promo: { value: 500 },
    },
    card: {
      ticketTotalCents: 8500,
      platformFeeCents: 600,
      processingFeeCents: 331,
      taxLines: [["SALES", 920]],
      taxAmountCents: 920,
      totalCents: 10351,
    },
    // 8500 × 9.75% = 828.75 → 829.
    cash: {
      ticketTotalCents: 8500,
      platformFeeCents: 0,
      processingFeeCents: 0,
      taxLines: [["SALES", 829]],
      taxAmountCents: 829,
      totalCents: 9329,
    },
  },
];

function pinOf(q: {
  ticketTotalCents: number;
  platformFeeCents: number;
  processingFeeCents: number;
  taxLines: Array<{ code: string; amountCents: number }>;
  taxAmountCents: number;
  totalCents: number;
}): ChannelPin {
  return {
    ticketTotalCents: q.ticketTotalCents,
    platformFeeCents: q.platformFeeCents,
    processingFeeCents: q.processingFeeCents,
    taxLines: q.taxLines.map((l) => [l.code, l.amountCents]),
    taxAmountCents: q.taxAmountCents,
    totalCents: q.totalCents,
  };
}

describe("quotePosCart: quote == charge to the cent (FR-010, NFR-001)", () => {
  for (const row of MATRIX) {
    it(row.name, async () => {
      await withRules(row.rules, async () => {
        const w = makeWorld(row.scenario);
        const q = await quote(w, row.scenario);

        // The quote, pinned.
        expect(q.card).not.toBeNull();
        expect(pinOf(q.card!)).toEqual(row.card);
        expect(pinOf(q.cash)).toEqual(row.cash);
        expect(q.isComp).toBe(false);
        expect(q.currency).toBe("usd");
        // Face before discounts is the same on both channels.
        expect(q.card!.ticketSubtotalCents).toBe(9000);
        expect(q.cash.ticketSubtotalCents).toBe(9000);
        expect(q.card!.discountCents).toBe(row.scenario.promo ? 500 : 0);
        expect(q.lines).toEqual([
          { ticketTypeId: GA_ID, qty: 2, unitPriceCents: 2500, amountCents: 5000 },
          { ticketTypeId: VIP_ID, qty: 1, unitPriceCents: 4000, amountCents: 4000 },
        ]);
        // The card's waiver (cash reserves none: it charges no fee).
        expect(q.feesWaivedCents).toBe(row.scenario.waiverTickets ? 250 : 0);
        expect(q.cash.platformFeeCents).toBe(0);
        // Each channel adds up.
        for (const c of [q.card!, q.cash]) {
          expect(
            c.ticketTotalCents +
              c.platformFeeCents +
              c.processingFeeCents +
              c.taxAmountCents,
          ).toBe(c.totalCents);
          expect(c.taxLines.reduce((s, l) => s + l.amountCents, 0)).toBe(
            c.taxAmountCents,
          );
        }
        // Read-only.
        expectNoWrites(w);

        // ── The charges, in fresh worlds ───────────────────────────────
        const card = await sellCard(row.scenario);
        expect(card.paymentIntent!.amountCents).toBe(q.card!.totalCents);
        const cardOrder = card.order()!;
        expect(cardOrder.taxAmountCents).toBe(q.card!.taxAmountCents);
        expect(cardOrder.feesPlatformCents).toBe(q.card!.platformFeeCents);
        expect(
          card.taxLines().map((l) => [l.code, l.amountCents]),
        ).toEqual(row.card.taxLines);

        const cw = makeWorld(row.scenario);
        // Exactly the quoted cash total: accepted, no change.
        const cash = await sellCash(cw, row.scenario, q.cash.totalCents);
        expect(cash.amountCents).toBe(q.cash.totalCents);
        expect(cash.changeCents).toBe(0);
        expect(cash.taxAmountCents).toBe(q.cash.taxAmountCents);
        expect(cash.feesPlatformCents).toBe(q.cash.platformFeeCents);
        expect(cw.taxLines().map((l) => [l.code, l.amountCents])).toEqual(
          row.cash.taxLines,
        );
      });
    });
  }

  it("a cent below the quoted cash total is refused as short (the quote is the floor)", async () => {
    const scenario: Scenario = { situs: NASHVILLE, admissionTaxRateBps: 975 };
    const q = await quote(makeWorld(scenario), scenario);
    await expect(
      sellCash(makeWorld(scenario), scenario, q.cash.totalCents - 1),
    ).rejects.toMatchObject({
      code: "CASH_AMOUNT_SHORT",
      meta: { requiredTotalCents: q.cash.totalCents },
    });
  });

  it("the tax lines carry the imposition label and rate the order stores", async () => {
    const scenario: Scenario = { situs: MINNEAPOLIS, admissionTaxRateBps: 903 };
    await withRules([MPLS_LINE], async () => {
      const q = await quote(makeWorld(scenario), scenario);
      expect(q.cash.taxLines).toEqual([
        { code: "SALES", label: "Sales tax", rateBps: 903, amountCents: 813 },
        {
          code: "TEST_MPLS_ENTERTAINMENT",
          label: "Test Minneapolis entertainment tax",
          rateBps: 300,
          amountCents: 270,
        },
      ]);
    });
  });
});

describe("quotePosCart: carts the card till cannot take", () => {
  it("a comp quotes $0 on cash, no card, and prices nothing (no lookup, no terms read)", async () => {
    const lookupByPostalCode = vi.fn(async () => {
      throw new TaxRateLookupError("down", { providerCode: 108, httpStatus: 429 });
    });
    const scenario: Scenario = {
      situs: NASHVILLE,
      admissionTaxRateBps: null,
      taxRateLookup: { lookupByPostalCode },
    };
    const w = makeWorld(scenario);
    const q = await quote(w, scenario, { comp: true });

    expect(q.isComp).toBe(true);
    expect(q.card).toBeNull();
    expect(q.cash).toEqual({
      ticketSubtotalCents: 0,
      discountCents: 0,
      ticketTotalCents: 0,
      platformFeeCents: 0,
      processingFeeCents: 0,
      taxLines: [],
      taxAmountCents: 0,
      totalCents: 0,
    });
    expect(q.lines).toEqual([
      { ticketTypeId: GA_ID, qty: 2, unitPriceCents: 0, amountCents: 0 },
      { ticketTypeId: VIP_ID, qty: 1, unitPriceCents: 0, amountCents: 0 },
    ]);
    expect(lookupByPostalCode).not.toHaveBeenCalled();
    expect(w.tx.payoutTerms.listByEvent).not.toHaveBeenCalled();
    expectNoWrites(w);

    // What the comp records: $0.
    const cw = makeWorld(scenario);
    const comp = await sellCash(cw, scenario, 0, { comp: true });
    expect(comp.amountCents).toBe(q.cash.totalCents);
    expect(comp.isComp).toBe(true);
  });

  it("an organiser waiver allowance is previewed for the CARD only: cash charges no fee, so a cart only cash can take shows no waiver", async () => {
    // With a card total the waiver is the card's (the MATRIX waiver row, 250).
    // Here a promo zeroes the cart, so no card: before the 2026-10-08 ruling
    // the cash quote previewed the VIP's 250 waived; now nothing is waived.
    const scenario: Scenario = {
      situs: NASHVILLE,
      admissionTaxRateBps: 975,
      promo: { value: 9000 },
      waiverTickets: 1,
    };
    const w = makeWorld(scenario);
    const q = await quote(w, scenario);
    expect(q.card).toBeNull();
    expect(q.feesWaivedCents).toBe(0);
    expect(q.cash.platformFeeCents).toBe(0);
    expect(q.cash.totalCents).toBe(0);
    expect(w.tx.feeWaivers.reserve).not.toHaveBeenCalled();
  });

  it("a promo that zeroes the cart: no card (AMOUNT_MUST_BE_POSITIVE), cash $0 — as the sales do", async () => {
    const scenario: Scenario = {
      situs: NASHVILLE,
      admissionTaxRateBps: 975,
      promo: { value: 9000 },
    };
    const w = makeWorld(scenario);
    const q = await quote(w, scenario);
    expect(q.card).toBeNull();
    expect(q.cash.ticketSubtotalCents).toBe(9000);
    expect(q.cash.discountCents).toBe(9000);
    expect(q.cash.ticketTotalCents).toBe(0);
    expect(q.cash.platformFeeCents).toBe(0);
    expect(q.cash.totalCents).toBe(0);
    expectNoWrites(w);

    await expect(sellCard(scenario)).rejects.toMatchObject({
      code: "AMOUNT_MUST_BE_POSITIVE",
    });
    const cash = await sellCash(makeWorld(scenario), scenario, 0, { comp: false });
    expect(cash.amountCents).toBe(0);
    expect(cash.isComp).toBe(false);
  });
});

describe("quotePosCart: gates before the paid lookup", () => {
  function workingLookup() {
    return vi.fn(async () => ({ rateBps: 975, source: "ziptax" }));
  }

  it("no role on the org → INSUFFICIENT_ROLE, nothing looked up", async () => {
    const lookupByPostalCode = workingLookup();
    const scenario: Scenario = {
      situs: NASHVILLE,
      admissionTaxRateBps: null,
      taxRateLookup: { lookupByPostalCode },
      role: null,
    };
    const w = makeWorld(scenario);
    await expect(quote(w, scenario)).rejects.toMatchObject({
      code: "INSUFFICIENT_ROLE",
    });
    expect(lookupByPostalCode).not.toHaveBeenCalled();
  });

  it("an unpublished event → EVENT_NOT_PUBLISHED, nothing looked up", async () => {
    const lookupByPostalCode = workingLookup();
    const scenario: Scenario = {
      situs: NASHVILLE,
      admissionTaxRateBps: null,
      taxRateLookup: { lookupByPostalCode },
    };
    const w = makeWorld(scenario);
    (w.event as { status: string }).status = "DRAFT";
    await expect(quote(w, scenario)).rejects.toMatchObject({
      code: "EVENT_NOT_PUBLISHED",
    });
    expect(lookupByPostalCode).not.toHaveBeenCalled();
  });

  it("scanner terms not accepted → SCANNER_TERMS_REQUIRED, nothing looked up", async () => {
    const lookupByPostalCode = workingLookup();
    const scenario: Scenario = {
      situs: NASHVILLE,
      admissionTaxRateBps: null,
      taxRateLookup: { lookupByPostalCode },
    };
    const w = makeWorld(scenario);
    w.tx.humans.getById.mockResolvedValue(null as never);
    await expect(quote(w, scenario)).rejects.toMatchObject({
      code: "SCANNER_TERMS_REQUIRED",
    });
    expect(lookupByPostalCode).not.toHaveBeenCalled();
  });

  it("a ticket type that is not on sale → TICKET_TYPE_NOT_FOUND", async () => {
    const scenario: Scenario = { situs: NASHVILLE, admissionTaxRateBps: 975 };
    const w = makeWorld(scenario);
    await expect(
      quote(w, scenario, {
        items: [{ ticketTypeId: "99999999-9999-4999-8999-999999999999", qty: 1 }],
      }),
    ).rejects.toMatchObject({ code: "TICKET_TYPE_NOT_FOUND" });
  });

  it("extra input keys are refused at the boundary (.strict)", async () => {
    const scenario: Scenario = { situs: NASHVILLE, admissionTaxRateBps: 975 };
    await expect(
      quotePosCart(quoteDeps(makeWorld(scenario)), {
        actorHumanId: OPERATOR_ID,
        eventId: EVENT_ID,
        items: CART,
        amountCollectedCents: 100,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});

describe("quotePosCart: tax (R5, NFR-002)", () => {
  it("an unstamped event is looked up once: the first quote stamps the rate, the next tap reads it", async () => {
    const lookupByPostalCode = vi.fn(async () => ({
      rateBps: 975,
      source: "ziptax",
    }));
    const scenario: Scenario = {
      situs: NASHVILLE,
      admissionTaxRateBps: null,
      taxRateLookup: { lookupByPostalCode },
    };
    const w = makeWorld(scenario);
    const q = await quote(w, scenario);
    expect(lookupByPostalCode).toHaveBeenCalledTimes(1);
    expect(q.cash.totalCents).toBe(9878);
    expect(q.card!.totalCents).toBe(10917);
    // The fresh rate is kept, compare-and-set, as the sale keeps it...
    expect(w.tx.events.fillTaxRateIfUnset).toHaveBeenCalledTimes(1);
    expect(w.tx.events.fillTaxRateIfUnset).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: EVENT_ID,
        admissionTaxRateBps: 975,
        taxRateSource: "ziptax",
        expectedUpdatedAt: w.event.updatedAt,
      }),
    );
    expect(w.event.admissionTaxRateBps).toBe(975);
    // ...and nothing else a sale writes.
    expectNoWrites(w, { taxStamp: true });

    // The operator taps +1: no second lookup, the same rate.
    const again = await quote(w, scenario, {
      items: [
        { ticketTypeId: GA_ID, qty: 3 },
        { ticketTypeId: VIP_ID, qty: 1 },
      ],
    });
    expect(lookupByPostalCode).toHaveBeenCalledTimes(1);
    expect(again.cash.taxLines).toEqual([
      expect.objectContaining({ code: "SALES", rateBps: 975 }),
    ]);
    // Already stamped: nothing to write the second time.
    expect(w.tx.events.fillTaxRateIfUnset).toHaveBeenCalledTimes(1);
    expect(w.reportError).not.toHaveBeenCalled();
  });

  it("a failing stamp write is reported and the quote still returns, at the looked-up rate", async () => {
    const lookupByPostalCode = vi.fn(async () => ({
      rateBps: 975,
      source: "ziptax",
    }));
    const scenario: Scenario = {
      situs: NASHVILLE,
      admissionTaxRateBps: null,
      taxRateLookup: { lookupByPostalCode },
    };
    const w = makeWorld(scenario);
    const boom = new Error("connection reset");
    w.tx.events.fillTaxRateIfUnset.mockRejectedValueOnce(boom);

    const q = await quote(w, scenario);
    expect(q.cash.totalCents).toBe(9878);
    expect(q.card!.totalCents).toBe(10917);
    expect(w.reportError).toHaveBeenCalledTimes(1);
    expect(w.reportError).toHaveBeenCalledWith(
      boom,
      expect.objectContaining({
        tags: { useCase: "resolveCheckoutTax" },
        extra: expect.objectContaining({
          event: "tax_rate_backfill_writeback_failed",
          eventId: EVENT_ID,
        }),
      }),
    );
    expect(w.event.admissionTaxRateBps).toBeNull();
    expectNoWrites(w, { taxStamp: true });
  });

  it("a failed lookup refuses with the sale's TAX_RATE_UNAVAILABLE (never 0%); a Scanner cannot enter a rate", async () => {
    const lookupByPostalCode = vi.fn(async () => {
      throw new TaxRateLookupError("Ziptax rCode 108", {
        providerCode: 108,
        httpStatus: 429,
      });
    });
    const scenario: Scenario = {
      situs: NASHVILLE,
      admissionTaxRateBps: null,
      taxRateLookup: { lookupByPostalCode },
    };
    const w = makeWorld(scenario);
    await expect(quote(w, scenario)).rejects.toMatchObject({
      code: "TAX_RATE_UNAVAILABLE",
      meta: { canEnterManualTaxRate: false },
    });
    // Retried exactly as the sale retries, then refused.
    expect(lookupByPostalCode).toHaveBeenCalledTimes(3);
    expectNoWrites(w);
  });

  it("…and an Admin is told they may enter the rate", async () => {
    const lookupByPostalCode = vi.fn(async () => {
      throw new TaxRateLookupError("timeout", { providerCode: null, httpStatus: null });
    });
    const scenario: Scenario = {
      situs: NASHVILLE,
      admissionTaxRateBps: null,
      taxRateLookup: { lookupByPostalCode },
      role: "ADMIN",
    };
    await expect(quote(makeWorld(scenario), scenario)).rejects.toMatchObject({
      code: "TAX_RATE_UNAVAILABLE",
      meta: { canEnterManualTaxRate: true },
    });
  });

  it("a hand-entered rate is quoted as is, with no relookup (the sale does the one relookup)", async () => {
    const lookupByPostalCode = vi.fn(async () => ({
      rateBps: 925,
      source: "ziptax",
    }));
    const scenario: Scenario = {
      situs: NASHVILLE,
      admissionTaxRateBps: 975,
      taxRateLookup: { lookupByPostalCode },
    };
    const w = makeWorld(scenario);
    (w.event as { taxRateSource: string | null }).taxRateSource =
      MANUAL_EVENT_TAX_RATE_SOURCE;
    const q = await quote(w, scenario);
    expect(lookupByPostalCode).not.toHaveBeenCalled();
    // The TN numbers at the manual 9.75%.
    expect(q.cash.taxLines).toEqual([
      { code: "SALES", label: "Sales tax", rateBps: 975, amountCents: 878 },
    ]);
    expect(q.card!.totalCents).toBe(10917);
    // The hand-entered stamp stands: no replacement (it would run after the
    // commit, in `applyCheckoutTaxSelfHeal`) and no self-heal.
    expectNoWrites(w);
    expect(w.tx.events.replaceTaxRateIfUnchanged).not.toHaveBeenCalled();
    expect(w.event.admissionTaxRateBps).toBe(975);
    expect(w.event.taxRateSource).toBe(MANUAL_EVENT_TAX_RATE_SOURCE);
  });
});
