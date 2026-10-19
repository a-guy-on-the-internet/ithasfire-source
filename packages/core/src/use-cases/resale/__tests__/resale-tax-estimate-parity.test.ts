import { describe, expect, it, vi } from "vitest";

import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";
import type { Repos } from "@th/ports/repos";

import { computeExpectedPaymentAmount } from "../../../lib/orders/compute-expected-payment-amount";
import { solveProcessingFee } from "../../../lib/pricing/processing-cost-schedule";
import { solveResaleCharge } from "../../../lib/pricing/resale-charge";
import {
  computeResaleShare,
  resaleClauseFromRecord,
} from "../../../lib/pricing/resale-pricing";
import { resolveTaxImpositions } from "../../../lib/pricing/tax-impositions";
import {
  aggregateItems,
  type PayoutTermsContext,
  type TicketTypeSummary,
} from "../../orders/checkout-helpers";
import { priceCart } from "../../orders/_shared/price-cart";
import { computeAgreementBasis } from "../../orders/finalize-from-payment-intent";
import { createResaleCheckout } from "../create-resale-checkout";
import { getResaleListing } from "../get-resale-listing";
import { resolveResaleSellerSplit } from "../resolve-resale-seller-split";

// Parity: the estimate the listing page shows before the order exists equals
// what `createResaleCheckout` charges, run on ONE fixture through BOTH use
// cases. The page labels Pay with this estimate, so a drift between the two
// solves is a buyer shown one price and charged another.
//
// Minneapolis: both use cases resolve tax with sale RESALE, so neither adds
// the 3% entertainment line (owner ruling 2026-10-05: "Assume not. We will
// seek counsel later.").

const BUYER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SELLER_ID = "aa111111-aa11-4a11-8a11-aa1111111111";
const LISTING_ID = "aa222222-aa22-4a22-8a22-aa2222222222";
const EVENT_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const TICKET_ID = "aa333333-aa33-4a33-8a33-aa3333333333";
const TT_ID = "aa444444-aa44-4a44-8a44-aa4444444444";
const TERMS_ID = "aa666666-aa66-4a66-8a66-aa6666666666";
const ITEM_ID = "aa777777-aa77-4a77-8a77-aa7777777777";
const PLACE_ID = "aa888888-aa88-4a88-8a88-aa8888888888";
const NOW = new Date("2026-03-10T12:00:00Z");

type Payer = "SELLER" | "BUYER";

function sellerItem(payer: Payer, bps: number) {
  return {
    id: ITEM_ID,
    orderId: "orig-order-1",
    kind: "ticket",
    ticketTypeId: TT_ID,
    qty: 1,
    unitPriceCents: 4000,
    amountCents: 4000,
    meta: {},
    status: "active",
    resaleClauseType: "PERCENT" as const,
    resaleClauseBps: bps,
    resaleClauseCents: null,
    resaleClausePayer: payer,
    resaleClauseTermsId: TERMS_ID,
    resaleClauseTermsVersion: 1,
    originalUnitPriceCents: 4000,
  };
}

function fixture(opts: {
  payer: Payer;
  bps: number;
  askCents: number;
  processingCents: number;
  event: Record<string, unknown>;
  place?: Record<string, unknown>;
}) {
  const item = sellerItem(opts.payer, opts.bps);
  const share = computeResaleShare({
    askCents: opts.askCents,
    clause: resaleClauseFromRecord(item),
  });
  const listingRow = {
    id: LISTING_ID,
    eventId: EVENT_ID,
    ticketId: TICKET_ID,
    resalePayoutTermsId: TERMS_ID,
    sellerHumanId: SELLER_ID,
    askPriceCents: opts.askCents,
    faceValueCents: 4000,
    processingPassThroughCents: opts.processingCents,
    processingFeeConfigRef: "stripe-standard",
    saleCutoffAt: new Date("2026-04-01T19:00:00Z"),
    payoutReleaseAt: new Date("2026-04-08T19:00:00Z"),
    currency: "usd",
    eventShareCents: share.shareCents,
    sharePayer: share.payer,
    status: "ACTIVE",
    source: "internal",
    externalRef: null,
    buyerOrderId: null,
    expiresAt: new Date("2026-04-01T00:00:00Z"),
    createdAt: NOW,
    updatedAt: NOW,
  };
  const eventRow = {
    id: EVENT_ID,
    title: "Launch Party",
    slug: "launch-party",
    status: "PUBLISHED",
    locationLabel: null,
    resalePayoutTermsId: TERMS_ID,
    currency: "usd",
    startsAt: new Date("2026-04-01T19:00:00Z"),
    endsAt: new Date("2026-06-01T00:00:00Z"),
    resalePayoutReleaseDaysOverride: null,
    placeId: null,
    savedLocationId: null,
    ...opts.event,
  };

  const createPending = vi.fn(async (data: Record<string, unknown>) => ({
    ...data,
  }));
  const repos = {
    resaleListings: {
      getById: vi.fn(async () => listingRow),
      hold: vi.fn(async () => ({ ok: true })),
      lockHold: vi.fn(async () => true),
      releaseHold: vi.fn(async () => ({ released: true, listingStatus: "ACTIVE" })),
    },
    events: {
      getById: vi.fn(async () => eventRow),
      fillTaxRateIfUnset: vi.fn(async () => true),
    },
    tickets: {
      getById: vi.fn(async () => ({
        id: TICKET_ID,
        ticketTypeId: TT_ID,
        seatId: null,
        ownerHumanId: SELLER_ID,
        orderId: "orig-order-1",
        orderItemId: ITEM_ID,
        status: "LISTED",
      })),
      getTicketTypeById: vi.fn(async () => ({
        id: TT_ID,
        name: "GA",
        priceCents: 4000,
        scheduledPriceCents: null,
        scheduledPriceAt: null,
        pricingMode: "FIXED",
        minimumCents: null,
        seatSectionId: null,
        resaleAllowed: true,
        resaleCapCents: null,
      })),
    },
    orderItems: { getById: vi.fn(async () => item) },
    payoutTerms: {
      listLines: vi.fn(async () => [
        {
          id: "aa000001-aa00-4a00-8a00-aa0000000001",
          payoutTermsId: TERMS_ID,
          payeeId: SELLER_ID,
          percent: 100,
          floorCents: 0,
          capPercent: null,
          priority: 0,
          rounding: "FLOOR",
        },
      ]),
    },
    orders: {
      createPending,
      linkPaymentIntentIfPending: vi.fn(async () => true),
      cancelPendingOrder: vi.fn(async () => true),
      getById: vi.fn(async () => null),
      createTaxLines: vi.fn(async () => {}),
    },
    audit: { log: vi.fn(async () => {}) },
    acceptances: {
      findCurrent: vi.fn(async () => null),
      create: vi.fn(async (r: Record<string, unknown>) => ({ id: "acc", ...r })),
    },
    seats: {
      getSectionById: vi.fn(async () => null),
      findLabelsByIds: vi.fn(async () => []),
    },
    places: { getById: vi.fn(async () => opts.place ?? null) },
    savedLocations: { getById: vi.fn(async () => null) },
    // The fee policy the listing froze (`processingFeeConfigRef`): both the
    // estimate and checkout solve processing from its rate.
    feePolicies: {
      getById: vi.fn(async () => ({
        id: "stripe-standard",
        processsorFeePct: 0.029,
        processorFixedCents: 30,
      })),
      getByIds: vi.fn(
        async (ids: readonly string[]) =>
          new Map(
            ids.map((id) => [
              id,
              { id, processsorFeePct: 0.029, processorFixedCents: 30 },
            ]),
          ),
      ),
    },
    tx: vi.fn(async (fn: (tx: unknown) => unknown) => fn(repos)),
  };

  const payments = {
    createPaymentIntent: vi.fn(async () => ({
      id: "pi_test_1",
      clientSecret: "pi_test_1_secret",
    })),
    cancelPaymentIntent: vi.fn(async () => ({ canceled: true })),
    retrievePaymentIntent: vi.fn(),
  } as unknown as PaymentProcessorPort;
  const idempotency = {
    get: vi.fn(async () => null),
    begin: vi.fn(async () => true),
    commit: vi.fn(async () => {}),
    fail: vi.fn(async () => {}),
    release: vi.fn(async () => true),
  } as unknown as IdempotencyPort;
  const clock: ClockPort = { now: () => NOW };
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
    withTime: vi.fn(),
  } as unknown as LoggerPort;

  return {
    repos: repos as unknown as Repos,
    payments,
    idempotency,
    clock,
    logger,
    createPayment: payments.createPaymentIntent as ReturnType<typeof vi.fn>,
    createPending,
    listingRow,
  };
}

async function bothSides(opts: Parameters<typeof fixture>[0]) {
  const f = fixture(opts);
  const read = await getResaleListing(
    { repos: f.repos, clock: f.clock },
    { listingId: LISTING_ID, viewerHumanId: BUYER_ID },
  );
  const charge = await createResaleCheckout(
    {
      repos: f.repos,
      payments: f.payments,
      idempotency: f.idempotency,
      clock: f.clock,
      logger: f.logger,
    },
    {
      actorHumanId: BUYER_ID,
      buyerHumanId: BUYER_ID,
      listingId: LISTING_ID,
      clientKey: "ck_parity_1",
      termsAccepted: true,
      refundPolicyAccepted: true,
    },
  );
  const chargedCents =
    charge.amountGrossCents + charge.buyerFeesCents + charge.taxAmountCents;
  // What Stripe was asked to charge, not just the response's parts.
  const piAmount = (f.createPayment.mock.calls.at(-1)?.[0] as {
    amountCents: number;
  }).amountCents;
  return { read, charge, chargedCents, piAmount, f };
}

const NY = { postalCode: "10001", countryCode: "US", region: "NY" };
const TN = { postalCode: "37203", countryCode: "US", region: "TN" };
const MPLS = { postalCode: "55403", countryCode: "US", region: "MN" };

describe("resale tax estimate === resale checkout charge (one fixture, both use cases)", () => {
  it.each([
    ["stamped NY, SELLER pays a 10% share", "SELLER", NY, 888],
    ["stamped NY, BUYER pays a 10% share", "BUYER", NY, 888],
    ["stamped TN (BUYER_TOTAL), BUYER pays a 10% share", "BUYER", TN, 975],
    ["stamped TN (BUYER_TOTAL), SELLER pays a 10% share", "SELLER", TN, 975],
  ] as const)("%s", async (_label, payer, situs, rateBps) => {
    const { read, charge, chargedCents, piAmount } = await bothSides({
      payer,
      bps: 1000,
      askCents: 5000,
      processingCents: 175,
      event: { ...situs, admissionTaxRateBps: rateBps, taxRateSource: "ziptax" },
    });

    expect(charge.taxAmountCents).toBeGreaterThan(0);
    expect(read.estimatedTaxCents).toBe(charge.taxAmountCents);
    expect(read.estimatedProcessingCents).toBe(charge.buyerFeesCents);
    expect(read.estimatedTotalCents).toBe(chargedCents);
    expect(read.estimatedTotalCents).toBe(piAmount);
  });

  it.each(["SELLER", "BUYER"] as const)(
    "Minneapolis 55403, %s pays: no entertainment line on resale, estimate === charge",
    async (payer) => {
      const { read, charge, chargedCents, piAmount, f } = await bothSides({
        payer,
        bps: 1000,
        askCents: 5000,
        processingCents: 175,
        event: { ...MPLS, admissionTaxRateBps: 903, taxRateSource: "ziptax" },
      });

      const lines = (
        f.repos.orders.createTaxLines as ReturnType<typeof vi.fn>
      ).mock.calls.at(-1)?.[0] as { lines: Array<{ code: string; amountCents: number }> };
      expect(lines.lines.map((l) => l.code)).toEqual(["SALES"]);
      expect(charge.taxAmountCents).toBe(lines.lines[0]!.amountCents);
      expect(read.estimatedTaxCents).toBe(charge.taxAmountCents);
      expect(read.estimatedProcessingCents).toBe(charge.buyerFeesCents);
      expect(read.estimatedTotalCents).toBe(chargedCents);
      expect(read.estimatedTotalCents).toBe(piAmount);
    },
  );

  it.each([
    ["NY place, SELLER pays", "SELLER", { region: "NY", postalCode: "10001", city: "New York" }, 888],
    ["TN place (BUYER_TOTAL), BUYER pays", "BUYER", { region: "TN", postalCode: "37203", city: "Nashville" }, 975],
  ] as const)("unstamped event, the place's cached rate: %s", async (_label, payer, where, cachedBps) => {
    const { read, charge, chargedCents, piAmount } = await bothSides({
      payer,
      bps: 1000,
      askCents: 5000,
      processingCents: 175,
      event: { placeId: PLACE_ID, admissionTaxRateBps: null, taxRateSource: null },
      place: {
        id: PLACE_ID,
        countryCode: "US",
        addressLine1: "1 Main St",
        admissionTaxRateBps: cachedBps,
        taxRateSource: "ziptax",
        ...where,
      },
    });

    expect(charge.taxAmountCents).toBeGreaterThan(0);
    expect(read.estimatedTaxCents).toBe(charge.taxAmountCents);
    expect(read.estimatedProcessingCents).toBe(charge.buyerFeesCents);
    expect(read.estimatedTotalCents).toBe(chargedCents);
    expect(read.estimatedTotalCents).toBe(piAmount);
  });
});

// ── Processing covers the tax (owner 2026-10-14) ──────────────────────────
//
// "WE DO NOT ABSORB THE 2.9% PROCESSING FEE. YEP FOR CONSISTENCY." A resale
// passes processing through on the full charge, tax included, exactly as a
// primary sale does. The primary path here is `priceCart` itself (the
// pipeline `createCheckout` and the door card run), for one ticket priced at
// the resale basis, with no platform fee (a resale takes none, R11), the same
// processor rate and the same tax lines. Same charge in, same processing out.

const PROCESSOR = { pct: 0.029, fixedCents: 30 };
const PRIMARY_TT = "bb444444-bb44-4b44-8b44-bb4444444444";

function primarySaleAt(basisCents: number, situs: typeof NY, rateBps: number) {
  const ticketTypes = new Map<string, TicketTypeSummary>([
    [
      PRIMARY_TT,
      {
        id: PRIMARY_TT,
        priceCents: basisCents,
        pricingMode: "FIXED",
        minimumCents: null,
        seatSectionId: null,
        scheduledPriceCents: null,
        scheduledPriceAt: null,
        salesOpenAt: null,
        salesCloseAt: null,
      } as TicketTypeSummary,
    ],
  ]);
  const terms = {
    agreement: {
      id: "terms-1",
      kind: "PRIMARY",
      status: "ACTIVE",
      feeMode: "PASS_THROUGH",
      feePolicyId: "stripe-standard",
      version: 1,
    },
    lines: [
      {
        id: "line-1",
        agreementId: "terms-1",
        payeeId: "payee-1",
        percent: 100,
        floorCents: 0,
        capPercent: null,
        priority: 0,
        rounding: "FLOOR",
      },
    ],
    feePolicy: {
      id: "stripe-standard",
      version: 1,
      feeMode: "PASS_THROUGH",
      buyerFeePct: 0,
      maxFeeCents: null,
      minFeeCents: 0,
      maxPlatformFeeCents: null,
      platformFixedCents: 0,
      processsorFeePct: PROCESSOR.pct,
      processorFixedCents: PROCESSOR.fixedCents,
      payoutPct: 0,
      payoutFixedCents: 0,
      monthlyPayoutCents: 0,
    },
  } as unknown as PayoutTermsContext;
  return priceCart({
    channel: "ONLINE",
    items: aggregateItems([{ ticketTypeId: PRIMARY_TT, qty: 1 }]),
    ticketTypes,
    payoutTerms: terms,
    now: NOW,
    seatPrices: new Map(),
    taxImpositions: resolveTaxImpositions({ situs, salesTaxRateBps: rateBps }),
  } as Parameters<typeof priceCart>[0]);
}

async function sellerSplitOf(f: ReturnType<typeof fixture>) {
  const pending = f.createPending.mock.calls.at(-1)![0] as {
    id: string;
    eventId: string;
    amountGrossCents: number;
    feesPlatformCents: number;
    feePolicySnapshot: Record<string, unknown>;
    items: Array<Record<string, unknown>>;
  };
  const split = await resolveResaleSellerSplit(
    {
      resaleListings: { getById: vi.fn(async () => f.listingRow) },
      payees: {
        getBySubject: vi.fn(async () => ({ id: "seller-payee" })),
        upsertForSubject: vi.fn(),
      },
    } as never,
    {
      order: { ...pending, items: pending.items.map((i) => ({ id: "item", ...i })) } as never,
      basisCents: computeAgreementBasis(pending as never),
    },
  );
  return { pending, split };
}

describe("resale processing covers the tax, as a primary sale's does", () => {
  it.each([
    ["NY 8.88% (ticket face), SELLER pays", "SELLER", NY, 888, 5000],
    ["NY 8.88% (ticket face), BUYER pays", "BUYER", NY, 888, 5500],
    ["TN 9.75% (buyer total), SELLER pays", "SELLER", TN, 975, 5000],
    ["TN 9.75% (buyer total), BUYER pays", "BUYER", TN, 975, 5500],
  ] as const)("%s: processing, tax and charge equal the primary sale's on the same basis", async (_label, payer, situs, rateBps, basisCents) => {
    const { charge, piAmount, f } = await bothSides({
      payer,
      bps: 1000,
      askCents: 5000,
      processingCents: 175,
      event: { ...situs, admissionTaxRateBps: rateBps, taxRateSource: "ziptax" },
    });
    const primary = primarySaleAt(basisCents, situs, rateBps);

    // The primary sale carries no platform fee, so the two charges match
    // part for part.
    expect(primary.buyerFeesCents).toBe(0);
    expect(primary.amountGrossCents).toBe(basisCents);
    expect(charge.amountGrossCents).toBe(basisCents);

    expect(charge.buyerFeesCents).toBe(primary.processorFeeCents);
    expect(charge.taxAmountCents).toBe(primary.taxAmountCents);
    expect(piAmount).toBe(primary.chargeTotalCents);

    // Processing now covers the tax: above the old basis-only markup and
    // above the pre-tax gross-up the listing stores.
    const oldBasisOnly = solveProcessingFee(basisCents, PROCESSOR.pct, PROCESSOR.fixedCents);
    const preTax = solveResaleCharge({
      basisCents,
      taxLines: [],
      processorPct: PROCESSOR.pct,
      processorFixedCents: PROCESSOR.fixedCents,
    }).processingPassThroughCents;
    expect(charge.buyerFeesCents).toBeGreaterThan(oldBasisOnly);
    expect(charge.buyerFeesCents).toBeGreaterThan(preTax);

    // Stripe's own fee on the charge is covered: what is left after it is
    // at least basis + tax, so the platform pays none of the processing.
    const stripeFee = solveProcessingFee(piAmount, PROCESSOR.pct, PROCESSOR.fixedCents);
    expect(piAmount - stripeFee).toBeGreaterThanOrEqual(basisCents + charge.taxAmountCents);

    // Finalize's amount check sums to the charge.
    const { pending } = await sellerSplitOf(f);
    expect(
      computeExpectedPaymentAmount({ ...pending, taxAmountCents: charge.taxAmountCents } as never),
    ).toBe(piAmount);
  });

  it("no tax: processing is the pre-tax figure a new listing stores, equal to the primary sale's", async () => {
    const { read, charge, piAmount } = await bothSides({
      payer: "SELLER",
      bps: 1000,
      askCents: 5000,
      processingCents: 181,
      event: { ...NY, admissionTaxRateBps: 0, taxRateSource: "none" },
    });
    const primary = primarySaleAt(5000, NY, 0);

    expect(charge.taxAmountCents).toBe(0);
    expect(charge.buyerFeesCents).toBe(181);
    expect(charge.buyerFeesCents).toBe(primary.processorFeeCents);
    expect(piAmount).toBe(primary.chargeTotalCents);
    // The listing's figure and the estimate agree with the charge.
    expect(read.buyerTotalBeforeTaxCents).toBe(piAmount);
    expect(read.estimatedTotalCents).toBe(piAmount);
  });

  it.each(["SELLER", "BUYER"] as const)("%s pays: the seller's payout and the event side's share do not move with the tax", async (payer) => {
    const untaxed = await bothSides({
      payer,
      bps: 1000,
      askCents: 5000,
      processingCents: 175,
      event: { ...NY, admissionTaxRateBps: 0, taxRateSource: "none" },
    });
    const taxed = await bothSides({
      payer,
      bps: 1000,
      askCents: 5000,
      processingCents: 175,
      event: { ...TN, admissionTaxRateBps: 975, taxRateSource: "ziptax" },
    });
    const a = await sellerSplitOf(untaxed.f);
    const b = await sellerSplitOf(taxed.f);

    const expected =
      payer === "SELLER"
        ? { sellerCents: 4500, organiserShareCents: 500 }
        : { sellerCents: 5000, organiserShareCents: 500 };
    expect(a.split).toMatchObject(expected);
    expect(b.split).toMatchObject(expected);
    expect(b.pending.amountGrossCents).toBe(a.pending.amountGrossCents);
    // Only the buyer's processing and tax differ.
    expect(taxed.charge.buyerFeesCents).toBeGreaterThan(untaxed.charge.buyerFeesCents);
  });

  it("a retry of the same checkout solves the same amounts, and a replay returns the stored ones without a second charge", async () => {
    const opts = {
      payer: "BUYER" as const,
      bps: 1000,
      askCents: 5000,
      processingCents: 175,
      event: { ...TN, admissionTaxRateBps: 975, taxRateSource: "ziptax" },
    };
    const first = await bothSides(opts);
    const second = await bothSides(opts);
    expect(second.charge).toMatchObject({
      amountGrossCents: first.charge.amountGrossCents,
      buyerFeesCents: first.charge.buyerFeesCents,
      taxAmountCents: first.charge.taxAmountCents,
    });
    expect(second.piAmount).toBe(first.piAmount);

    // Replay under the same client key: the stored response, no new order,
    // no new PaymentIntent.
    const f = first.f;
    const commit = (f.idempotency.commit as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
    (f.idempotency.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce(commit[1]);
    const replay = await createResaleCheckout(
      {
        repos: f.repos,
        payments: f.payments,
        idempotency: f.idempotency,
        clock: f.clock,
        logger: f.logger,
      },
      {
        actorHumanId: BUYER_ID,
        buyerHumanId: BUYER_ID,
        listingId: LISTING_ID,
        clientKey: "ck_parity_1",
        termsAccepted: true,
        refundPolicyAccepted: true,
      },
    );
    expect(replay).toEqual(first.charge);
    expect(f.createPayment).toHaveBeenCalledTimes(1);
    expect(f.createPending).toHaveBeenCalledTimes(1);
  });
});
