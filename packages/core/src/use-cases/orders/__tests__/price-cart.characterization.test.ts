import { describe, expect, it, vi } from "vitest";

import type { CreateCheckoutDeps } from "../create-checkout";
import { createCheckout } from "../create-checkout";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { PromoRecord } from "@th/ports/repos/promos";
import { createTestLogger } from "@th/test-utils/fakes/logger";
import { computeExpectedPaymentAmount } from "../../../lib/orders/compute-expected-payment-amount";
import type { LocalTaxImpositionRule } from "../../../lib/pricing/tax-impositions";

/**
 * CHARACTERIZATION FIXTURES for the `priceCart` extraction
 * (docs/specs/2026-10-07/door-sales-same-price-and-tax.spec.yaml, step 1).
 *
 * Every expected value in this file was recorded by running `createCheckout`
 * BEFORE the pricing pipeline moved into `_shared/price-cart.ts` (the credit
 * boundary and error-precedence cases were added afterwards and checked
 * against that pre-extraction checkout too). The extraction must leave every
 * number byte-identical. If one of these changes, that is an online cent
 * moving: fix the code, never the fixture.
 *
 * Money fields are asserted as EXPLICIT literals (`moneyOf`), so `vitest -u`
 * cannot rewrite them; the inline snapshots pin the rest of the shape.
 *
 * The harness is self-contained on purpose (no shared fixture module) and
 * covers only the surface the paid and free checkout paths touch.
 *
 * Local tax impositions come from a test seam that defaults to NO local rows,
 * so these numbers do not depend on what the shipped imposition table holds
 * (a city row landing there must not rewrite a fixture). One case injects its
 * own two-line table to pin the multi-imposition path.
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

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const BUYER_ID = "22222222-2222-4222-8222-222222222222";
const GA_ID = "33333333-3333-4333-8333-333333333333";
const VIP_ID = "33333333-3333-4333-8333-333333333334";
const PWYW_ID = "33333333-3333-4333-8333-333333333335";
const FREE_ID = "33333333-3333-4333-8333-333333333336";
const TERMS_ID = "44444444-4444-4444-8444-444444444444";
const POLICY_ID = "55555555-5555-4555-8555-555555555555";
const ORDER_ID = "66666666-6666-4666-8666-666666666666";
const NOW = new Date("2026-03-01T12:00:00.000Z");

type TicketTypeFixture = {
  id: string;
  priceCents: number;
  pricingMode?: "FIXED" | "ADJUSTABLE";
  minimumCents?: number | null;
  scheduledPriceCents?: number | null;
  scheduledPriceAt?: Date | null;
};

type Scenario = {
  ticketTypes?: TicketTypeFixture[];
  buyerFeePct?: number;
  platformFixedCents?: number;
  minFeeCents?: number;
  maxFeeCents?: number | null;
  maxPlatformFeeCents?: number | null;
  processorFeePct?: number;
  processorFixedCents?: number;
  storedFeeMode?: "PASS_THROUGH" | "ABSORB";
  admissionTaxRateBps?: number;
  situs?: { countryCode: string; region: string; postalCode: string };
  waiverReservedTickets?: number;
  promo?: Partial<PromoRecord>;
  /**
   * The promo's value as the PAID path reads it (second lookup); the routing
   * probe (first lookup) sees `promo.value`. Models an owner editing the code
   * between the two reads: the race that lands a free cart on the paid path.
   */
  promoValueOnPaidPath?: number;
  creditCents?: number;
};

const DEFAULT_TICKET_TYPES: TicketTypeFixture[] = [
  { id: GA_ID, priceCents: 2500 },
];

function makeHarness(scenario: Scenario) {
  const ticketTypes = scenario.ticketTypes ?? DEFAULT_TICKET_TYPES;
  const storedFeeMode = scenario.storedFeeMode ?? "PASS_THROUGH";

  const event = {
    id: EVENT_ID,
    orgId: "org-1",
    humanId: null,
    title: "Characterization Night",
    status: "PUBLISHED" as const,
    visibility: "PUBLIC" as const,
    gateType: "NONE" as const,
    attendanceMode: "TICKETED" as const,
    waiverTemplateId: null,
    startsAt: new Date("2026-04-01T20:00:00.000Z"),
    endsAt: new Date("2026-04-01T23:00:00.000Z"),
    placeId: null,
    savedLocationId: null,
    postalCode: scenario.situs?.postalCode ?? null,
    countryCode: scenario.situs?.countryCode ?? null,
    region: scenario.situs?.region ?? null,
    admissionTaxRateBps: scenario.admissionTaxRateBps ?? 0,
    taxRateSource: "ziptax",
    instructionalAdmission: false,
    timezone: "America/Chicago",
    updatedAt: new Date("2026-02-01T00:00:00.000Z"),
    publishedAt: NOW,
    agreementPrimaryId: TERMS_ID,
    currency: "usd",
    ownerBanned: false,
  };

  const terms = {
    id: TERMS_ID,
    kind: "PRIMARY",
    status: "ACTIVE",
    feeMode: storedFeeMode,
    feePolicyId: POLICY_ID,
    payoutSchedule: "WEEK_OF_EVENT",
    isDefault: false,
    settlementCurrency: "usd",
    version: 3,
    createdAt: NOW,
    updatedAt: NOW,
  };

  const feePolicy = {
    id: POLICY_ID,
    scopeType: "EVENT",
    scopeId: EVENT_ID,
    status: "ACTIVE",
    version: 7,
    buyerFeePct: scenario.buyerFeePct ?? 0.05,
    maxFeeCents: scenario.maxFeeCents ?? null,
    minFeeCents: scenario.minFeeCents ?? 0,
    maxPlatformFeeCents: scenario.maxPlatformFeeCents ?? null,
    platformFixedCents: scenario.platformFixedCents ?? 50,
    feeMode: storedFeeMode,
    processsorFeePct: scenario.processorFeePct ?? 0.029,
    processorFixedCents: scenario.processorFixedCents ?? 30,
    payoutPct: 0,
    payoutFixedCents: 0,
    monthlyPayoutCents: 0,
    effectiveFrom: NOW,
    effectiveTo: null,
  };

  let createPendingInput: Record<string, any> | null = null;
  let createTaxLinesInput: Record<string, any> | null = null;
  let createPaymentIntentInput: Record<string, any> | null = null;
  const orderState: Record<string, any> = {
    id: ORDER_ID,
    status: "PENDING",
    stripePaymentIntentId: null,
  };

  let creditBalance = scenario.creditCents ?? 0;
  let promoLookups = 0;
  let splitRows: Array<Record<string, unknown>> = [];

  const promo: PromoRecord | null = scenario.promo
    ? ({
        id: "promo-1",
        code: "SAVE",
        codeNormalized: "SAVE",
        status: "ACTIVE",
        kind: "AMOUNT",
        scope: "EVENT",
        scopeId: EVENT_ID,
        value: 500,
        currency: "usd",
        minOrderCents: 0,
        maxRedemptions: undefined,
        maxRedemptionsPerHuman: undefined,
        maxDiscountCents: undefined,
        stackable: false,
        isPublic: false,
        startsAt: undefined,
        endsAt: undefined,
        createdAt: NOW,
        updatedAt: NOW,
        ...scenario.promo,
      } as PromoRecord)
    : null;

  const tx = {
    events: {
      getById: vi.fn(async (id: string) => (id === EVENT_ID ? event : null)),
      listTicketTypes: vi.fn(async () =>
        ticketTypes.map((tt) => ({
          id: tt.id,
          priceCents: tt.priceCents,
          status: "ACTIVE" as const,
          capacity: 1000,
          pricingMode: tt.pricingMode ?? "FIXED",
          minimumCents: tt.minimumCents ?? null,
          seatSectionId: null,
          scheduledPriceCents: tt.scheduledPriceCents ?? null,
          scheduledPriceAt: tt.scheduledPriceAt ?? null,
          salesOpenAt: null,
          salesCloseAt: null,
        })),
      ),
      fillTaxRateIfUnset: vi.fn(async () => true),
    },
    payoutTerms: {
      listByEvent: vi.fn(async () => [terms]),
      getById: vi.fn(async (id: string) => (id === TERMS_ID ? terms : null)),
      listLines: vi.fn(async () => [
        {
          id: "line-1",
          agreementId: TERMS_ID,
          payeeId: "77777777-7777-4777-8777-777777777777",
          percent: 100,
          floorCents: 0,
          capPercent: null,
          priority: 0,
          rounding: "FLOOR",
        },
      ]),
    },
    feePolicies: {
      getById: vi.fn(async (id: string) => (id === POLICY_ID ? feePolicy : null)),
    },
    eventUnlocks: { isUnlocked: vi.fn(async () => true) },
    memberships: { listForMember: vi.fn(async () => []) },
    membershipTiers: {
      listByIds: vi.fn(async () => []),
      listBenefitsForTiers: vi.fn(async () => []),
    },
    promos: {
      findActiveByCodes: vi.fn(async () => {
        promoLookups += 1;
        if (!promo) return [];
        if (scenario.promoValueOnPaidPath != null && promoLookups > 1) {
          return [{ ...promo, value: scenario.promoValueOnPaidPath }];
        }
        return [promo];
      }),
      findActiveByIds: vi.fn(async () => []),
      getRedemptionStats: vi.fn(async () => ({
        totalRedemptions: 0,
        redemptionsForHuman: 0,
      })),
      createHolds: vi.fn(async () => []),
      confirmHoldsForOrder: vi.fn(async () => []),
      releaseHoldsForOrder: vi.fn(async () => undefined),
      listHoldsForOrder: vi.fn(async () => []),
    },
    feeWaivers: {
      resolveApplicable: vi.fn(async () =>
        (scenario.waiverReservedTickets ?? 0) > 0
          ? [{ id: "waiver-1", ticketsGranted: 10, ticketsUsed: 0 }]
          : [],
      ),
      reserve: vi.fn(async (input: { waivableTicketFeesCents: number[] }) => {
        const n = Math.min(
          scenario.waiverReservedTickets ?? 0,
          input.waivableTicketFeesCents.length,
        );
        return {
          reservedTickets: n,
          feeWaivedCents: input.waivableTicketFeesCents
            .slice(0, n)
            .reduce((s, c) => s + c, 0),
          redemptionId: n > 0 ? "redemption-1" : null,
        };
      }),
      release: vi.fn(async () => ({ releasedTickets: 0 })),
    },
    credits: {
      listActiveForHuman: vi.fn(async () =>
        creditBalance > 0
          ? [
              {
                id: "credit-1",
                humanId: BUYER_ID,
                amountCents: creditBalance,
                balanceCents: creditBalance,
                currency: "usd",
                reason: "Test credit",
                sourceType: "MANUAL_STAFF_GRANT",
                status: "ACTIVE",
                createdAt: NOW,
                updatedAt: NOW,
              },
            ]
          : [],
      ),
      redeemConditional: vi.fn(
        async (input: { creditId: string; requestedCents: number }) => {
          const applied = Math.min(creditBalance, input.requestedCents);
          creditBalance -= applied;
          return { appliedCents: applied, balanceAfterCents: creditBalance };
        },
      ),
      recordRedemption: vi.fn(async () => ({})),
      releaseForOrder: vi.fn(async () => ({ releasedCents: 0, creditIds: [] })),
    },
    organizations: {
      getById: vi.fn(async () => ({
        id: "org-1",
        name: "Org One",
        status: "ACTIVE",
        chargebackTermsVersion: "2000-01-01",
        chargebackTermsAcceptedAt: new Date("2025-01-01T00:00:00.000Z"),
        chargebackTermsAcceptedByHumanId: BUYER_ID,
      })),
    },
    humans: { getById: vi.fn(async () => null) },
    tickets: {
      lockAndCountCapacityForTicketType: vi.fn(async () => ({
        issued: 0,
        held: 0,
      })),
      countIssuedForTicketType: vi.fn(async () => 0),
      countCapacityConsumingForTicketType: vi.fn(async () => 0),
      findBySeatIds: vi.fn(async () => []),
      create: vi.fn(async (input: Record<string, unknown>) => ({
        id: `ticket-${Math.random().toString(36).slice(2, 10)}`,
        ...input,
        scannedAt: null,
      })),
      countForOrderTicketType: vi.fn(async () => 0),
      getByOrderItemId: vi.fn(async () => null),
    },
    seats: {
      releaseExpiredHolds: vi.fn(async () => 0),
      releaseSeats: vi.fn(async () => 0),
    },
    orders: {
      getById: vi.fn(async (id: string) =>
        id === ORDER_ID && createPendingInput
          ? {
              ...orderState,
              ...createPendingInput,
              id: ORDER_ID,
              items: (createPendingInput.items as any[]).map((item, i) => ({
                id: `item-${i}`,
                ...item,
                meta: item.meta ?? {},
              })),
            }
          : null,
      ),
      createPending: vi.fn(async (input: Record<string, any>) => {
        createPendingInput = input;
        return {
          id: ORDER_ID,
          amountGrossCents: input.amountGrossCents,
          feesPlatformCents: input.feesPlatformCents,
          currency: input.currency,
        };
      }),
      createTaxLines: vi.fn(async (input: Record<string, any>) => {
        createTaxLinesInput = input;
      }),
      linkPaymentIntentIfPending: vi.fn(async (_id: string, pi: string) => {
        orderState.stripePaymentIntentId = pi;
        return true;
      }),
      markSucceeded: vi.fn(async () => {
        orderState.status = "SUCCEEDED";
      }),
    },
    acceptances: {
      findCurrent: vi.fn(async () => null),
      create: vi.fn(async (record: Record<string, unknown>) => ({
        id: "acceptance-1",
        ...record,
      })),
    },
    payees: {
      getBySubject: vi.fn(async () => ({ id: "acct_connected" })),
      getById: vi.fn(async () => ({
        id: "acct_connected",
        subjectType: "ORGANIZATION",
        subjectId: "org-1",
        status: "ACTIVE",
        payoutsEnabled: true,
        chargesEnabled: true,
        defaultCurrency: "usd",
      })),
    },
    splits: {
      upsertForOrder: vi.fn(
        async (
          orderId: string,
          rows: Array<{ payeeId: string; amountCents: number }>,
        ) => {
          splitRows = rows.map((row, i) => ({
            id: `split-${i}`,
            orderId,
            orderSplitId: `split-${i}`,
            ...row,
          }));
        },
      ),
      getForOrder: vi.fn(async () => splitRows),
    },
    orderItems: {
      listByOrderId: vi.fn(async () =>
        ((createPendingInput?.items ?? []) as any[]).map((item, i) => ({
          id: `item-${i}`,
          ...item,
          meta: item.meta ?? {},
        })),
      ),
    },
    payeeLedger: {
      settlementCredit: vi.fn(async (input: Record<string, unknown>) => ({
        id: "ledger-1",
        type: "SETTLEMENT_CREDIT",
        ...input,
        createdAt: NOW,
      })),
    },
    ticketAttributions: {
      findByIdempotencyKey: vi.fn(async () => null),
      create: vi.fn(async () => ({})),
      findByEventAndOrder: vi.fn(async () => null),
    },
    eventHumans: { getById: vi.fn(async () => null) },
    audit: { log: vi.fn(async () => undefined) },
  };

  const repos = {
    ...tx,
    tx: async <T>(fn: (t: TxRepos) => Promise<T>) =>
      fn(tx as unknown as TxRepos),
  } as unknown as Repos;

  const store = new Map<string, unknown>();
  const holds = new Map<string, string | null>();
  const idempotency = {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    begin: vi.fn(async (k: string, _ttl: number, owner?: string) => {
      if (holds.has(k)) return false;
      holds.set(k, owner ?? null);
      return true;
    }),
    commit: vi.fn(async (k: string, v: unknown) => {
      store.set(k, v);
    }),
    fail: vi.fn(async () => undefined),
    release: vi.fn(async (k: string) => {
      holds.delete(k);
      return true;
    }),
    run: vi.fn(),
    purgeExpired: async () => 0,
  } as unknown as IdempotencyPort;

  const payments = {
    createPaymentIntent: vi.fn(async (input: Record<string, any>) => {
      createPaymentIntentInput = input;
      return { id: "pi_char", clientSecret: "secret_char" };
    }),
    cancelPaymentIntent: vi.fn(async () => ({ canceled: true })),
    retrievePaymentIntent: vi.fn(),
  } as unknown as PaymentProcessorPort;

  const logger = createTestLogger();
  vi.mocked(logger.child).mockReturnValue(logger);
  const reportError = vi.fn();

  const deps: CreateCheckoutDeps = {
    repos,
    payments,
    idempotency,
    clock: { now: () => NOW },
    logger,
    reportError,
    devInstantPayouts: true,
  };

  return {
    deps,
    reportError,
    get createPendingInput() {
      return createPendingInput;
    },
    get createTaxLinesInput() {
      return createTaxLinesInput;
    },
    get createPaymentIntentInput() {
      return createPaymentIntentInput;
    },
  };
}

type CartLine = {
  ticketTypeId: string;
  qty: number;
  donationAmountCents?: number;
};

async function runCheckout(scenario: Scenario, items: CartLine[]) {
  const h = makeHarness(scenario);
  const result = await createCheckout(h.deps, {
    actorHumanId: BUYER_ID,
    buyerHumanId: BUYER_ID,
    eventId: EVENT_ID,
    clientKey: "characterization-key",
    termsAccepted: true,
    refundPolicyAccepted: true,
    items,
    ...(scenario.promo ? { promoCodes: ["save"] } : {}),
  });

  const order = h.createPendingInput;
  const pi = h.createPaymentIntentInput;
  const { orderId: _orderId, ...piMetadata } = (pi?.metadata ?? {}) as Record<
    string,
    string
  >;

  const summary = {
    result,
    order: order && {
      amountGrossCents: order.amountGrossCents,
      feesPlatformCents: order.feesPlatformCents,
      taxAmountCents: order.taxAmountCents,
      currency: order.currency,
      source: order.source,
      nonRefundable: order.nonRefundable,
      feePolicySnapshot: order.feePolicySnapshot,
      taxSitusCountry: order.taxSitusCountry,
      taxSitusState: order.taxSitusState,
      taxSitusPostal: order.taxSitusPostal,
      taxRateSource: order.taxRateSource,
      items: (order.items as Array<Record<string, unknown>>).map((item) => ({
        kind: item.kind,
        ticketTypeId: item.ticketTypeId,
        qty: item.qty,
        unitPriceCents: item.unitPriceCents,
        amountCents: item.amountCents,
        meta: item.meta,
      })),
    },
    taxLines: h.createTaxLinesInput?.lines ?? null,
    paymentIntent: pi && {
      amountCents: pi.amountCents,
      currency: pi.currency,
      metadata: piMetadata,
    },
  };

  // The finalize AMOUNT_MISMATCH contract: what the order rows say the buyer
  // owes is exactly what the PaymentIntent charges.
  if (order && pi) {
    expect(computeExpectedPaymentAmount(order as never)).toBe(pi.amountCents);
  }
  expect(h.reportError).not.toHaveBeenCalled();

  return summary;
}

/**
 * The money fields of a summary, asserted with EXPLICIT literals in every
 * case below (an inline snapshot alone would be rewritten by `vitest -u`).
 */
function moneyOf(summary: Awaited<ReturnType<typeof runCheckout>>) {
  const items = (summary.order?.items ?? []) as Array<{
    kind: unknown;
    meta: unknown;
  }>;
  return {
    amountGrossCents: summary.result.amountGrossCents,
    feesPlatformCents: summary.result.feesPlatformCents,
    buyerFeesCents: summary.result.buyerFeesCents,
    taxAmountCents: summary.result.taxAmountCents,
    processorFeeCents: summary.result.processorFeeCents,
    creditAppliedCents: summary.result.creditAppliedCents,
    paymentIntentAmountCents: summary.paymentIntent?.amountCents ?? null,
    orderAmountGrossCents: summary.order?.amountGrossCents ?? null,
    orderFeesPlatformCents: summary.order?.feesPlatformCents ?? null,
    orderTaxAmountCents: summary.order?.taxAmountCents ?? null,
    itemBuyerTotalCents: items
      .filter((item) => item.kind === "ticket")
      .map((item) => (item.meta as Record<string, number>).buyerTotalCents),
    itemAmountCents: items.map(
      (item) => (item as unknown as { amountCents: number }).amountCents,
    ),
    taxLines: ((summary.taxLines ?? []) as Array<Record<string, unknown>>).map(
      (line) => [line.code, line.taxableAmountCents, line.amountCents],
    ),
  };
}

const TN = { countryCode: "US", region: "TN", postalCode: "37203" };
// Saint Paul — Minnesota, BUYER_TOTAL, and outside every Minneapolis ZIP.
const MN = { countryCode: "US", region: "MN", postalCode: "55101" };
const OR = { countryCode: "US", region: "OR", postalCode: "97201" };

describe("createCheckout pricing — characterization (frozen before the priceCart extraction)", () => {
  it("no-tax state (OR, rate 0): 2 × $25", async () => {
    const summary = await runCheckout({ situs: OR, admissionTaxRateBps: 0 }, [
      { ticketTypeId: GA_ID, qty: 2 },
    ]);
    // Money as explicit literals; each also passes on the pre-extraction checkout.
    expect(moneyOf(summary)).toEqual({
      amountGrossCents: 5000,
      feesPlatformCents: 350,
      buyerFeesCents: 350,
      taxAmountCents: 0,
      processorFeeCents: 191,
      creditAppliedCents: 0,
      paymentIntentAmountCents: 5541,
      orderAmountGrossCents: 5000,
      orderFeesPlatformCents: 350,
      orderTaxAmountCents: 0,
      itemBuyerTotalCents: [2770, 2771],
      itemAmountCents: [2500, 2500],
      taxLines: [],
    });
    expect(summary).toMatchInlineSnapshot(`
      {
        "order": {
          "amountGrossCents": 5000,
          "currency": "usd",
          "feePolicySnapshot": {
            "agreementId": "44444444-4444-4444-8444-444444444444",
            "agreementVersion": 3,
            "computedAt": "2026-03-01T12:00:00.000Z",
            "feeMode": "PASS_THROUGH",
            "feePolicyId": "55555555-5555-4555-8555-555555555555",
            "feePolicyVersion": 7,
            "organiserCredit": "FULL_PRICE",
            "payoutTermsId": "44444444-4444-4444-8444-444444444444",
            "payoutTermsVersion": 3,
          },
          "feesPlatformCents": 350,
          "items": [
            {
              "amountCents": 2500,
              "kind": "ticket",
              "meta": {
                "buyerTotalCents": 2770,
                "buyerUnitTotalCents": 2770,
                "effectiveFeeMode": "PASS_THROUGH",
                "holdExpiresAt": "2026-03-01T12:15:00.000Z",
                "platformFeePerTicketCents": 175,
                "processorFeeShareCents": 95,
                "ticketIndex": 0,
              },
              "qty": 1,
              "ticketTypeId": "33333333-3333-4333-8333-333333333333",
              "unitPriceCents": 2500,
            },
            {
              "amountCents": 2500,
              "kind": "ticket",
              "meta": {
                "buyerTotalCents": 2771,
                "buyerUnitTotalCents": 2771,
                "effectiveFeeMode": "PASS_THROUGH",
                "holdExpiresAt": "2026-03-01T12:15:00.000Z",
                "platformFeePerTicketCents": 175,
                "processorFeeShareCents": 96,
                "ticketIndex": 1,
              },
              "qty": 1,
              "ticketTypeId": "33333333-3333-4333-8333-333333333333",
              "unitPriceCents": 2500,
            },
          ],
          "nonRefundable": false,
          "source": "PRIMARY",
          "taxAmountCents": 0,
          "taxRateSource": "ziptax",
          "taxSitusCountry": "US",
          "taxSitusPostal": "97201",
          "taxSitusState": "OR",
        },
        "paymentIntent": {
          "amountCents": 5541,
          "currency": "usd",
          "metadata": {
            "buyerHumanId": "22222222-2222-4222-8222-222222222222",
            "currency": "usd",
            "eventId": "11111111-1111-4111-8111-111111111111",
            "source": "primary",
          },
        },
        "result": {
          "amountGrossCents": 5000,
          "buyerFeesCents": 350,
          "clientSecret": "secret_char",
          "creditAppliedCents": 0,
          "feeMode": "PASS_THROUGH",
          "feeWaivedCents": 0,
          "feesPlatformCents": 350,
          "holdExpiresAt": "2026-03-01T12:15:00.000Z",
          "orderId": "66666666-6666-4666-8666-666666666666",
          "processorFeeCents": 191,
          "taxAmountCents": 0,
        },
        "taxLines": null,
      }
    `);
  });

  it("TN (BUYER_TOTAL, 9.75%): 2 × $25", async () => {
    const summary = await runCheckout({ situs: TN, admissionTaxRateBps: 975 }, [
      { ticketTypeId: GA_ID, qty: 2 },
    ]);
    // Money as explicit literals; each also passes on the pre-extraction checkout.
    expect(moneyOf(summary)).toEqual({
      amountGrossCents: 5000,
      feesPlatformCents: 350,
      buyerFeesCents: 350,
      taxAmountCents: 542,
      processorFeeCents: 207,
      creditAppliedCents: 0,
      paymentIntentAmountCents: 6099,
      orderAmountGrossCents: 5000,
      orderFeesPlatformCents: 350,
      orderTaxAmountCents: 542,
      itemBuyerTotalCents: [2778, 2779],
      itemAmountCents: [2500, 2500],
      taxLines: [["SALES", 5557, 542]],
    });
    expect(summary).toMatchInlineSnapshot(`
      {
        "order": {
          "amountGrossCents": 5000,
          "currency": "usd",
          "feePolicySnapshot": {
            "agreementId": "44444444-4444-4444-8444-444444444444",
            "agreementVersion": 3,
            "computedAt": "2026-03-01T12:00:00.000Z",
            "feeMode": "PASS_THROUGH",
            "feePolicyId": "55555555-5555-4555-8555-555555555555",
            "feePolicyVersion": 7,
            "organiserCredit": "FULL_PRICE",
            "payoutTermsId": "44444444-4444-4444-8444-444444444444",
            "payoutTermsVersion": 3,
          },
          "feesPlatformCents": 350,
          "items": [
            {
              "amountCents": 2500,
              "kind": "ticket",
              "meta": {
                "buyerTotalCents": 2778,
                "buyerUnitTotalCents": 2778,
                "effectiveFeeMode": "PASS_THROUGH",
                "holdExpiresAt": "2026-03-01T12:15:00.000Z",
                "platformFeePerTicketCents": 175,
                "processorFeeShareCents": 103,
                "ticketIndex": 0,
              },
              "qty": 1,
              "ticketTypeId": "33333333-3333-4333-8333-333333333333",
              "unitPriceCents": 2500,
            },
            {
              "amountCents": 2500,
              "kind": "ticket",
              "meta": {
                "buyerTotalCents": 2779,
                "buyerUnitTotalCents": 2779,
                "effectiveFeeMode": "PASS_THROUGH",
                "holdExpiresAt": "2026-03-01T12:15:00.000Z",
                "platformFeePerTicketCents": 175,
                "processorFeeShareCents": 104,
                "ticketIndex": 1,
              },
              "qty": 1,
              "ticketTypeId": "33333333-3333-4333-8333-333333333333",
              "unitPriceCents": 2500,
            },
          ],
          "nonRefundable": false,
          "source": "PRIMARY",
          "taxAmountCents": 542,
          "taxRateSource": "ziptax",
          "taxSitusCountry": "US",
          "taxSitusPostal": "37203",
          "taxSitusState": "TN",
        },
        "paymentIntent": {
          "amountCents": 6099,
          "currency": "usd",
          "metadata": {
            "buyerHumanId": "22222222-2222-4222-8222-222222222222",
            "currency": "usd",
            "eventId": "11111111-1111-4111-8111-111111111111",
            "source": "primary",
            "taxAmountCents": "542",
          },
        },
        "result": {
          "amountGrossCents": 5000,
          "buyerFeesCents": 350,
          "clientSecret": "secret_char",
          "creditAppliedCents": 0,
          "feeMode": "PASS_THROUGH",
          "feeWaivedCents": 0,
          "feesPlatformCents": 350,
          "holdExpiresAt": "2026-03-01T12:15:00.000Z",
          "orderId": "66666666-6666-4666-8666-666666666666",
          "processorFeeCents": 207,
          "taxAmountCents": 542,
        },
        "taxLines": [
          {
            "amountCents": 542,
            "base": "BUYER_TOTAL",
            "code": "SALES",
            "collector": "PLATFORM",
            "jurisdiction": "US/TN",
            "label": "Sales tax",
            "rateBps": 975,
            "taxableAmountCents": 5557,
          },
        ],
      }
    `);
  });

  it("MN outside Minneapolis (BUYER_TOTAL, 8.875%): 3 × $25", async () => {
    const summary = await runCheckout({ situs: MN, admissionTaxRateBps: 888 }, [
      { ticketTypeId: GA_ID, qty: 3 },
    ]);
    // Money as explicit literals; each also passes on the pre-extraction checkout.
    expect(moneyOf(summary)).toEqual({
      amountGrossCents: 7500,
      feesPlatformCents: 525,
      buyerFeesCents: 525,
      taxAmountCents: 739,
      processorFeeCents: 293,
      creditAppliedCents: 0,
      paymentIntentAmountCents: 9057,
      orderAmountGrossCents: 7500,
      orderFeesPlatformCents: 525,
      orderTaxAmountCents: 739,
      itemBuyerTotalCents: [2772, 2772, 2774],
      itemAmountCents: [2500, 2500, 2500],
      taxLines: [["SALES", 8318, 739]],
    });
    expect(summary).toMatchInlineSnapshot(`
      {
        "order": {
          "amountGrossCents": 7500,
          "currency": "usd",
          "feePolicySnapshot": {
            "agreementId": "44444444-4444-4444-8444-444444444444",
            "agreementVersion": 3,
            "computedAt": "2026-03-01T12:00:00.000Z",
            "feeMode": "PASS_THROUGH",
            "feePolicyId": "55555555-5555-4555-8555-555555555555",
            "feePolicyVersion": 7,
            "organiserCredit": "FULL_PRICE",
            "payoutTermsId": "44444444-4444-4444-8444-444444444444",
            "payoutTermsVersion": 3,
          },
          "feesPlatformCents": 525,
          "items": [
            {
              "amountCents": 2500,
              "kind": "ticket",
              "meta": {
                "buyerTotalCents": 2772,
                "buyerUnitTotalCents": 2772,
                "effectiveFeeMode": "PASS_THROUGH",
                "holdExpiresAt": "2026-03-01T12:15:00.000Z",
                "platformFeePerTicketCents": 175,
                "processorFeeShareCents": 97,
                "ticketIndex": 0,
              },
              "qty": 1,
              "ticketTypeId": "33333333-3333-4333-8333-333333333333",
              "unitPriceCents": 2500,
            },
            {
              "amountCents": 2500,
              "kind": "ticket",
              "meta": {
                "buyerTotalCents": 2772,
                "buyerUnitTotalCents": 2772,
                "effectiveFeeMode": "PASS_THROUGH",
                "holdExpiresAt": "2026-03-01T12:15:00.000Z",
                "platformFeePerTicketCents": 175,
                "processorFeeShareCents": 97,
                "ticketIndex": 1,
              },
              "qty": 1,
              "ticketTypeId": "33333333-3333-4333-8333-333333333333",
              "unitPriceCents": 2500,
            },
            {
              "amountCents": 2500,
              "kind": "ticket",
              "meta": {
                "buyerTotalCents": 2774,
                "buyerUnitTotalCents": 2774,
                "effectiveFeeMode": "PASS_THROUGH",
                "holdExpiresAt": "2026-03-01T12:15:00.000Z",
                "platformFeePerTicketCents": 175,
                "processorFeeShareCents": 99,
                "ticketIndex": 2,
              },
              "qty": 1,
              "ticketTypeId": "33333333-3333-4333-8333-333333333333",
              "unitPriceCents": 2500,
            },
          ],
          "nonRefundable": false,
          "source": "PRIMARY",
          "taxAmountCents": 739,
          "taxRateSource": "ziptax",
          "taxSitusCountry": "US",
          "taxSitusPostal": "55101",
          "taxSitusState": "MN",
        },
        "paymentIntent": {
          "amountCents": 9057,
          "currency": "usd",
          "metadata": {
            "buyerHumanId": "22222222-2222-4222-8222-222222222222",
            "currency": "usd",
            "eventId": "11111111-1111-4111-8111-111111111111",
            "source": "primary",
            "taxAmountCents": "739",
          },
        },
        "result": {
          "amountGrossCents": 7500,
          "buyerFeesCents": 525,
          "clientSecret": "secret_char",
          "creditAppliedCents": 0,
          "feeMode": "PASS_THROUGH",
          "feeWaivedCents": 0,
          "feesPlatformCents": 525,
          "holdExpiresAt": "2026-03-01T12:15:00.000Z",
          "orderId": "66666666-6666-4666-8666-666666666666",
          "processorFeeCents": 293,
          "taxAmountCents": 739,
        },
        "taxLines": [
          {
            "amountCents": 739,
            "base": "BUYER_TOTAL",
            "code": "SALES",
            "collector": "PLATFORM",
            "jurisdiction": "US/MN",
            "label": "Sales tax",
            "rateBps": 888,
            "taxableAmountCents": 8318,
          },
        ],
      }
    `);
  });

  it("order-level platform fee cap hit (TN): 5 × $50, cap 300", async () => {
    const summary = await runCheckout(
      {
        situs: TN,
        admissionTaxRateBps: 975,
        ticketTypes: [{ id: GA_ID, priceCents: 5000 }],
        maxPlatformFeeCents: 300,
      },
      [{ ticketTypeId: GA_ID, qty: 5 }],
    );
    // Money as explicit literals; each also passes on the pre-extraction checkout.
    expect(moneyOf(summary)).toEqual({
      amountGrossCents: 25_000,
      feesPlatformCents: 300,
      buyerFeesCents: 300,
      taxAmountCents: 2551,
      processorFeeCents: 863,
      creditAppliedCents: 0,
      paymentIntentAmountCents: 28_714,
      orderAmountGrossCents: 25_000,
      orderFeesPlatformCents: 300,
      orderTaxAmountCents: 2551,
      itemBuyerTotalCents: [5232, 5232, 5232, 5232, 5235],
      itemAmountCents: [5000, 5000, 5000, 5000, 5000],
      taxLines: [["SALES", 26_163, 2551]],
    });
    expect(summary).toMatchInlineSnapshot(`
      {
        "order": {
          "amountGrossCents": 25000,
          "currency": "usd",
          "feePolicySnapshot": {
            "agreementId": "44444444-4444-4444-8444-444444444444",
            "agreementVersion": 3,
            "computedAt": "2026-03-01T12:00:00.000Z",
            "feeMode": "PASS_THROUGH",
            "feePolicyId": "55555555-5555-4555-8555-555555555555",
            "feePolicyVersion": 7,
            "organiserCredit": "FULL_PRICE",
            "payoutTermsId": "44444444-4444-4444-8444-444444444444",
            "payoutTermsVersion": 3,
          },
          "feesPlatformCents": 300,
          "items": [
            {
              "amountCents": 5000,
              "kind": "ticket",
              "meta": {
                "buyerTotalCents": 5232,
                "buyerUnitTotalCents": 5232,
                "effectiveFeeMode": "PASS_THROUGH",
                "holdExpiresAt": "2026-03-01T12:15:00.000Z",
                "platformFeeCapped": true,
                "platformFeePerTicketCents": 60,
                "processorFeeShareCents": 172,
                "ticketIndex": 0,
              },
              "qty": 1,
              "ticketTypeId": "33333333-3333-4333-8333-333333333333",
              "unitPriceCents": 5000,
            },
            {
              "amountCents": 5000,
              "kind": "ticket",
              "meta": {
                "buyerTotalCents": 5232,
                "buyerUnitTotalCents": 5232,
                "effectiveFeeMode": "PASS_THROUGH",
                "holdExpiresAt": "2026-03-01T12:15:00.000Z",
                "platformFeeCapped": true,
                "platformFeePerTicketCents": 60,
                "processorFeeShareCents": 172,
                "ticketIndex": 1,
              },
              "qty": 1,
              "ticketTypeId": "33333333-3333-4333-8333-333333333333",
              "unitPriceCents": 5000,
            },
            {
              "amountCents": 5000,
              "kind": "ticket",
              "meta": {
                "buyerTotalCents": 5232,
                "buyerUnitTotalCents": 5232,
                "effectiveFeeMode": "PASS_THROUGH",
                "holdExpiresAt": "2026-03-01T12:15:00.000Z",
                "platformFeeCapped": true,
                "platformFeePerTicketCents": 60,
                "processorFeeShareCents": 172,
                "ticketIndex": 2,
              },
              "qty": 1,
              "ticketTypeId": "33333333-3333-4333-8333-333333333333",
              "unitPriceCents": 5000,
            },
            {
              "amountCents": 5000,
              "kind": "ticket",
              "meta": {
                "buyerTotalCents": 5232,
                "buyerUnitTotalCents": 5232,
                "effectiveFeeMode": "PASS_THROUGH",
                "holdExpiresAt": "2026-03-01T12:15:00.000Z",
                "platformFeeCapped": true,
                "platformFeePerTicketCents": 60,
                "processorFeeShareCents": 172,
                "ticketIndex": 3,
              },
              "qty": 1,
              "ticketTypeId": "33333333-3333-4333-8333-333333333333",
              "unitPriceCents": 5000,
            },
            {
              "amountCents": 5000,
              "kind": "ticket",
              "meta": {
                "buyerTotalCents": 5235,
                "buyerUnitTotalCents": 5235,
                "effectiveFeeMode": "PASS_THROUGH",
                "holdExpiresAt": "2026-03-01T12:15:00.000Z",
                "platformFeeCapped": true,
                "platformFeePerTicketCents": 60,
                "processorFeeShareCents": 175,
                "ticketIndex": 4,
              },
              "qty": 1,
              "ticketTypeId": "33333333-3333-4333-8333-333333333333",
              "unitPriceCents": 5000,
            },
          ],
          "nonRefundable": false,
          "source": "PRIMARY",
          "taxAmountCents": 2551,
          "taxRateSource": "ziptax",
          "taxSitusCountry": "US",
          "taxSitusPostal": "37203",
          "taxSitusState": "TN",
        },
        "paymentIntent": {
          "amountCents": 28714,
          "currency": "usd",
          "metadata": {
            "buyerHumanId": "22222222-2222-4222-8222-222222222222",
            "currency": "usd",
            "eventId": "11111111-1111-4111-8111-111111111111",
            "source": "primary",
            "taxAmountCents": "2551",
          },
        },
        "result": {
          "amountGrossCents": 25000,
          "buyerFeesCents": 300,
          "clientSecret": "secret_char",
          "creditAppliedCents": 0,
          "feeMode": "PASS_THROUGH",
          "feeWaivedCents": 0,
          "feesPlatformCents": 300,
          "holdExpiresAt": "2026-03-01T12:15:00.000Z",
          "orderId": "66666666-6666-4666-8666-666666666666",
          "processorFeeCents": 863,
          "taxAmountCents": 2551,
        },
        "taxLines": [
          {
            "amountCents": 2551,
            "base": "BUYER_TOTAL",
            "code": "SALES",
            "collector": "PLATFORM",
            "jurisdiction": "US/TN",
            "label": "Sales tax",
            "rateBps": 975,
            "taxableAmountCents": 26163,
          },
        ],
      }
    `);
  });

  it("fee waiver reserves 1 of 3 tickets (MN)", async () => {
    const summary = await runCheckout(
      { situs: MN, admissionTaxRateBps: 888, waiverReservedTickets: 1 },
      [{ ticketTypeId: GA_ID, qty: 3 }],
    );
    // Money as explicit literals; each also passes on the pre-extraction checkout.
    expect(moneyOf(summary)).toEqual({
      amountGrossCents: 7500,
      feesPlatformCents: 350,
      buyerFeesCents: 350,
      taxAmountCents: 723,
      processorFeeCents: 287,
      creditAppliedCents: 0,
      paymentIntentAmountCents: 8860,
      orderAmountGrossCents: 7500,
      orderFeesPlatformCents: 350,
      orderTaxAmountCents: 723,
      itemBuyerTotalCents: [2591, 2772, 2774],
      itemAmountCents: [2500, 2500, 2500],
      taxLines: [["SALES", 8137, 723]],
    });
    expect(summary).toMatchInlineSnapshot(`
      {
        "order": {
          "amountGrossCents": 7500,
          "currency": "usd",
          "feePolicySnapshot": {
            "agreementId": "44444444-4444-4444-8444-444444444444",
            "agreementVersion": 3,
            "computedAt": "2026-03-01T12:00:00.000Z",
            "feeMode": "PASS_THROUGH",
            "feePolicyId": "55555555-5555-4555-8555-555555555555",
            "feePolicyVersion": 7,
            "organiserCredit": "FULL_PRICE",
            "payoutTermsId": "44444444-4444-4444-8444-444444444444",
            "payoutTermsVersion": 3,
          },
          "feesPlatformCents": 350,
          "items": [
            {
              "amountCents": 2500,
              "kind": "ticket",
              "meta": {
                "buyerTotalCents": 2591,
                "buyerUnitTotalCents": 2591,
                "effectiveFeeMode": "PASS_THROUGH",
                "holdExpiresAt": "2026-03-01T12:15:00.000Z",
                "platformFeePerTicketCents": 0,
                "platformFeeWaivedCents": 175,
                "processorFeeShareCents": 91,
                "ticketIndex": 0,
              },
              "qty": 1,
              "ticketTypeId": "33333333-3333-4333-8333-333333333333",
              "unitPriceCents": 2500,
            },
            {
              "amountCents": 2500,
              "kind": "ticket",
              "meta": {
                "buyerTotalCents": 2772,
                "buyerUnitTotalCents": 2772,
                "effectiveFeeMode": "PASS_THROUGH",
                "holdExpiresAt": "2026-03-01T12:15:00.000Z",
                "platformFeePerTicketCents": 175,
                "processorFeeShareCents": 97,
                "ticketIndex": 1,
              },
              "qty": 1,
              "ticketTypeId": "33333333-3333-4333-8333-333333333333",
              "unitPriceCents": 2500,
            },
            {
              "amountCents": 2500,
              "kind": "ticket",
              "meta": {
                "buyerTotalCents": 2774,
                "buyerUnitTotalCents": 2774,
                "effectiveFeeMode": "PASS_THROUGH",
                "holdExpiresAt": "2026-03-01T12:15:00.000Z",
                "platformFeePerTicketCents": 175,
                "processorFeeShareCents": 99,
                "ticketIndex": 2,
              },
              "qty": 1,
              "ticketTypeId": "33333333-3333-4333-8333-333333333333",
              "unitPriceCents": 2500,
            },
          ],
          "nonRefundable": false,
          "source": "PRIMARY",
          "taxAmountCents": 723,
          "taxRateSource": "ziptax",
          "taxSitusCountry": "US",
          "taxSitusPostal": "55101",
          "taxSitusState": "MN",
        },
        "paymentIntent": {
          "amountCents": 8860,
          "currency": "usd",
          "metadata": {
            "buyerHumanId": "22222222-2222-4222-8222-222222222222",
            "currency": "usd",
            "eventId": "11111111-1111-4111-8111-111111111111",
            "source": "primary",
            "taxAmountCents": "723",
          },
        },
        "result": {
          "amountGrossCents": 7500,
          "buyerFeesCents": 350,
          "clientSecret": "secret_char",
          "creditAppliedCents": 0,
          "feeMode": "PASS_THROUGH",
          "feeWaivedCents": 175,
          "feesPlatformCents": 350,
          "holdExpiresAt": "2026-03-01T12:15:00.000Z",
          "orderId": "66666666-6666-4666-8666-666666666666",
          "processorFeeCents": 287,
          "taxAmountCents": 723,
        },
        "taxLines": [
          {
            "amountCents": 723,
            "base": "BUYER_TOTAL",
            "code": "SALES",
            "collector": "PLATFORM",
            "jurisdiction": "US/MN",
            "label": "Sales tax",
            "rateBps": 888,
            "taxableAmountCents": 8137,
          },
        ],
      }
    `);
  });

  it("free order ($0 tier) routes to the free claim with zero fees and tax", async () => {
    const summary = await runCheckout(
      {
        situs: TN,
        admissionTaxRateBps: 975,
        ticketTypes: [{ id: FREE_ID, priceCents: 0 }],
      },
      [{ ticketTypeId: FREE_ID, qty: 2 }],
    );
    // Money as explicit literals; each also passes on the pre-extraction checkout.
    expect(moneyOf(summary)).toEqual({
      amountGrossCents: 0,
      feesPlatformCents: 0,
      buyerFeesCents: 0,
      taxAmountCents: 0,
      processorFeeCents: 0,
      creditAppliedCents: 0,
      paymentIntentAmountCents: null,
      orderAmountGrossCents: 0,
      orderFeesPlatformCents: 0,
      orderTaxAmountCents: 0,
      itemBuyerTotalCents: [0, 0],
      itemAmountCents: [0, 0],
      taxLines: [],
    });
    expect(summary).toMatchInlineSnapshot(`
      {
        "order": {
          "amountGrossCents": 0,
          "currency": "usd",
          "feePolicySnapshot": {
            "agreementId": "44444444-4444-4444-8444-444444444444",
            "agreementVersion": 3,
            "computedAt": "2026-03-01T12:00:00.000Z",
            "feeMode": "PASS_THROUGH",
            "feePolicyId": "55555555-5555-4555-8555-555555555555",
            "feePolicyVersion": 7,
            "organiserCredit": "FULL_PRICE",
            "payoutTermsId": "44444444-4444-4444-8444-444444444444",
            "payoutTermsVersion": 3,
          },
          "feesPlatformCents": 0,
          "items": [
            {
              "amountCents": 0,
              "kind": "ticket",
              "meta": {
                "buyerTotalCents": 0,
                "buyerUnitTotalCents": 0,
                "effectiveFeeMode": "PASS_THROUGH",
                "platformFeePerTicketCents": 0,
                "processorFeeShareCents": 0,
                "ticketIndex": 0,
              },
              "qty": 1,
              "ticketTypeId": "33333333-3333-4333-8333-333333333336",
              "unitPriceCents": 0,
            },
            {
              "amountCents": 0,
              "kind": "ticket",
              "meta": {
                "buyerTotalCents": 0,
                "buyerUnitTotalCents": 0,
                "effectiveFeeMode": "PASS_THROUGH",
                "platformFeePerTicketCents": 0,
                "processorFeeShareCents": 0,
                "ticketIndex": 1,
              },
              "qty": 1,
              "ticketTypeId": "33333333-3333-4333-8333-333333333336",
              "unitPriceCents": 0,
            },
          ],
          "nonRefundable": false,
          "source": "PRIMARY",
          "taxAmountCents": 0,
          "taxRateSource": undefined,
          "taxSitusCountry": undefined,
          "taxSitusPostal": undefined,
          "taxSitusState": undefined,
        },
        "paymentIntent": null,
        "result": {
          "amountGrossCents": 0,
          "buyerFeesCents": 0,
          "clientSecret": null,
          "creditAppliedCents": 0,
          "feeMode": "PASS_THROUGH",
          "feesPlatformCents": 0,
          "holdExpiresAt": null,
          "orderId": "66666666-6666-4666-8666-666666666666",
          "processorFeeCents": 0,
          "taxAmountCents": 0,
        },
        "taxLines": null,
      }
    `);
  });

  it("pay-what-you-want (TN): 2 × $12.34 over a $5 minimum", async () => {
    const summary = await runCheckout(
      {
        situs: TN,
        admissionTaxRateBps: 975,
        ticketTypes: [
          {
            id: PWYW_ID,
            priceCents: 0,
            pricingMode: "ADJUSTABLE",
            minimumCents: 500,
          },
        ],
      },
      [{ ticketTypeId: PWYW_ID, qty: 2, donationAmountCents: 1234 }],
    );
    // Money as explicit literals; each also passes on the pre-extraction checkout.
    expect(moneyOf(summary)).toEqual({
      amountGrossCents: 2468,
      feesPlatformCents: 224,
      buyerFeesCents: 224,
      taxAmountCents: 274,
      processorFeeCents: 120,
      creditAppliedCents: 0,
      paymentIntentAmountCents: 3086,
      orderAmountGrossCents: 2468,
      orderFeesPlatformCents: 224,
      orderTaxAmountCents: 274,
      itemBuyerTotalCents: [1406, 1406],
      itemAmountCents: [1234, 1234],
      taxLines: [["SALES", 2812, 274]],
    });
    expect(summary).toMatchInlineSnapshot(`
      {
        "order": {
          "amountGrossCents": 2468,
          "currency": "usd",
          "feePolicySnapshot": {
            "agreementId": "44444444-4444-4444-8444-444444444444",
            "agreementVersion": 3,
            "computedAt": "2026-03-01T12:00:00.000Z",
            "feeMode": "PASS_THROUGH",
            "feePolicyId": "55555555-5555-4555-8555-555555555555",
            "feePolicyVersion": 7,
            "organiserCredit": "FULL_PRICE",
            "payoutTermsId": "44444444-4444-4444-8444-444444444444",
            "payoutTermsVersion": 3,
          },
          "feesPlatformCents": 224,
          "items": [
            {
              "amountCents": 1234,
              "kind": "ticket",
              "meta": {
                "buyerTotalCents": 1406,
                "buyerUnitTotalCents": 1406,
                "effectiveFeeMode": "PASS_THROUGH",
                "holdExpiresAt": "2026-03-01T12:15:00.000Z",
                "platformFeePerTicketCents": 112,
                "processorFeeShareCents": 60,
                "ticketIndex": 0,
              },
              "qty": 1,
              "ticketTypeId": "33333333-3333-4333-8333-333333333335",
              "unitPriceCents": 1234,
            },
            {
              "amountCents": 1234,
              "kind": "ticket",
              "meta": {
                "buyerTotalCents": 1406,
                "buyerUnitTotalCents": 1406,
                "effectiveFeeMode": "PASS_THROUGH",
                "holdExpiresAt": "2026-03-01T12:15:00.000Z",
                "platformFeePerTicketCents": 112,
                "processorFeeShareCents": 60,
                "ticketIndex": 1,
              },
              "qty": 1,
              "ticketTypeId": "33333333-3333-4333-8333-333333333335",
              "unitPriceCents": 1234,
            },
          ],
          "nonRefundable": true,
          "source": "PRIMARY",
          "taxAmountCents": 274,
          "taxRateSource": "ziptax",
          "taxSitusCountry": "US",
          "taxSitusPostal": "37203",
          "taxSitusState": "TN",
        },
        "paymentIntent": {
          "amountCents": 3086,
          "currency": "usd",
          "metadata": {
            "buyerHumanId": "22222222-2222-4222-8222-222222222222",
            "currency": "usd",
            "donationTotalCents": "2468",
            "eventId": "11111111-1111-4111-8111-111111111111",
            "nonRefundable": "true",
            "source": "primary",
            "taxAmountCents": "274",
          },
        },
        "result": {
          "amountGrossCents": 2468,
          "buyerFeesCents": 224,
          "clientSecret": "secret_char",
          "creditAppliedCents": 0,
          "feeMode": "PASS_THROUGH",
          "feeWaivedCents": 0,
          "feesPlatformCents": 224,
          "holdExpiresAt": "2026-03-01T12:15:00.000Z",
          "orderId": "66666666-6666-4666-8666-666666666666",
          "processorFeeCents": 120,
          "taxAmountCents": 274,
        },
        "taxLines": [
          {
            "amountCents": 274,
            "base": "BUYER_TOTAL",
            "code": "SALES",
            "collector": "PLATFORM",
            "jurisdiction": "US/TN",
            "label": "Sales tax",
            "rateBps": 975,
            "taxableAmountCents": 2812,
          },
        ],
      }
    `);
  });

  it("a $5 promo (TN): 2 × $25", async () => {
    const summary = await runCheckout(
      { situs: TN, admissionTaxRateBps: 975, promo: { value: 500 } },
      [{ ticketTypeId: GA_ID, qty: 2 }],
    );
    // Money as explicit literals; each also passes on the pre-extraction checkout.
    expect(moneyOf(summary)).toEqual({
      amountGrossCents: 4500,
      feesPlatformCents: 350,
      buyerFeesCents: 350,
      taxAmountCents: 491,
      processorFeeCents: 191,
      creditAppliedCents: 0,
      paymentIntentAmountCents: 5532,
      orderAmountGrossCents: 4500,
      orderFeesPlatformCents: 350,
      orderTaxAmountCents: 491,
      itemBuyerTotalCents: [2770, 2771],
      itemAmountCents: [2500, 2500, -500],
      taxLines: [["SALES", 5041, 491]],
    });
    expect(summary).toMatchInlineSnapshot(`
      {
        "order": {
          "amountGrossCents": 4500,
          "currency": "usd",
          "feePolicySnapshot": {
            "agreementId": "44444444-4444-4444-8444-444444444444",
            "agreementVersion": 3,
            "computedAt": "2026-03-01T12:00:00.000Z",
            "feeMode": "PASS_THROUGH",
            "feePolicyId": "55555555-5555-4555-8555-555555555555",
            "feePolicyVersion": 7,
            "organiserCredit": "FULL_PRICE",
            "payoutTermsId": "44444444-4444-4444-8444-444444444444",
            "payoutTermsVersion": 3,
          },
          "feesPlatformCents": 350,
          "items": [
            {
              "amountCents": 2500,
              "kind": "ticket",
              "meta": {
                "buyerTotalCents": 2770,
                "buyerUnitTotalCents": 2770,
                "effectiveFeeMode": "PASS_THROUGH",
                "holdExpiresAt": "2026-03-01T12:15:00.000Z",
                "platformFeePerTicketCents": 175,
                "processorFeeShareCents": 95,
                "ticketIndex": 0,
              },
              "qty": 1,
              "ticketTypeId": "33333333-3333-4333-8333-333333333333",
              "unitPriceCents": 2500,
            },
            {
              "amountCents": 2500,
              "kind": "ticket",
              "meta": {
                "buyerTotalCents": 2771,
                "buyerUnitTotalCents": 2771,
                "effectiveFeeMode": "PASS_THROUGH",
                "holdExpiresAt": "2026-03-01T12:15:00.000Z",
                "platformFeePerTicketCents": 175,
                "processorFeeShareCents": 96,
                "ticketIndex": 1,
              },
              "qty": 1,
              "ticketTypeId": "33333333-3333-4333-8333-333333333333",
              "unitPriceCents": 2500,
            },
            {
              "amountCents": -500,
              "kind": "discount",
              "meta": {
                "appliedDiscountCents": 500,
                "code": "save",
                "kind": "AMOUNT",
                "normalizedCode": "SAVE",
                "promoId": "promo-1",
                "scope": "EVENT",
                "value": 500,
              },
              "qty": 1,
              "ticketTypeId": undefined,
              "unitPriceCents": -500,
            },
          ],
          "nonRefundable": false,
          "source": "PRIMARY",
          "taxAmountCents": 491,
          "taxRateSource": "ziptax",
          "taxSitusCountry": "US",
          "taxSitusPostal": "37203",
          "taxSitusState": "TN",
        },
        "paymentIntent": {
          "amountCents": 5532,
          "currency": "usd",
          "metadata": {
            "buyerHumanId": "22222222-2222-4222-8222-222222222222",
            "currency": "usd",
            "discountTotalCents": "500",
            "eventId": "11111111-1111-4111-8111-111111111111",
            "promoCodes": "SAVE",
            "source": "primary",
            "taxAmountCents": "491",
          },
        },
        "result": {
          "amountGrossCents": 4500,
          "buyerFeesCents": 350,
          "clientSecret": "secret_char",
          "creditAppliedCents": 0,
          "feeMode": "PASS_THROUGH",
          "feeWaivedCents": 0,
          "feesPlatformCents": 350,
          "holdExpiresAt": "2026-03-01T12:15:00.000Z",
          "orderId": "66666666-6666-4666-8666-666666666666",
          "processorFeeCents": 191,
          "taxAmountCents": 491,
        },
        "taxLines": [
          {
            "amountCents": 491,
            "base": "BUYER_TOTAL",
            "code": "SALES",
            "collector": "PLATFORM",
            "jurisdiction": "US/TN",
            "label": "Sales tax",
            "rateBps": 975,
            "taxableAmountCents": 5041,
          },
        ],
      }
    `);
  });

  it("a 15% promo across mixed tiers (MN)", async () => {
    const summary = await runCheckout(
      {
        situs: MN,
        admissionTaxRateBps: 888,
        promo: { kind: "PERCENT", value: 15 } as Partial<PromoRecord>,
        ticketTypes: [
          { id: GA_ID, priceCents: 2500 },
          { id: VIP_ID, priceCents: 8000 },
        ],
      },
      [
        { ticketTypeId: GA_ID, qty: 2 },
        { ticketTypeId: VIP_ID, qty: 1 },
      ],
    );
    // Money as explicit literals; each also passes on the pre-extraction checkout.
    expect(moneyOf(summary)).toEqual({
      amountGrossCents: 11_050,
      feesPlatformCents: 800,
      buyerFeesCents: 800,
      taxAmountCents: 1089,
      processorFeeCents: 418,
      creditAppliedCents: 0,
      paymentIntentAmountCents: 13_357,
      orderAmountGrossCents: 11_050,
      orderFeesPlatformCents: 800,
      orderTaxAmountCents: 1089,
      itemBuyerTotalCents: [2756, 2756, 8706],
      itemAmountCents: [2500, 2500, 8000, -1950],
      taxLines: [["SALES", 12_268, 1089]],
    });
    expect(summary).toMatchInlineSnapshot(`
      {
        "order": {
          "amountGrossCents": 11050,
          "currency": "usd",
          "feePolicySnapshot": {
            "agreementId": "44444444-4444-4444-8444-444444444444",
            "agreementVersion": 3,
            "computedAt": "2026-03-01T12:00:00.000Z",
            "feeMode": "PASS_THROUGH",
            "feePolicyId": "55555555-5555-4555-8555-555555555555",
            "feePolicyVersion": 7,
            "organiserCredit": "FULL_PRICE",
            "payoutTermsId": "44444444-4444-4444-8444-444444444444",
            "payoutTermsVersion": 3,
          },
          "feesPlatformCents": 800,
          "items": [
            {
              "amountCents": 2500,
              "kind": "ticket",
              "meta": {
                "buyerTotalCents": 2756,
                "buyerUnitTotalCents": 2756,
                "effectiveFeeMode": "PASS_THROUGH",
                "holdExpiresAt": "2026-03-01T12:15:00.000Z",
                "platformFeePerTicketCents": 175,
                "processorFeeShareCents": 81,
                "ticketIndex": 0,
              },
              "qty": 1,
              "ticketTypeId": "33333333-3333-4333-8333-333333333333",
              "unitPriceCents": 2500,
            },
            {
              "amountCents": 2500,
              "kind": "ticket",
              "meta": {
                "buyerTotalCents": 2756,
                "buyerUnitTotalCents": 2756,
                "effectiveFeeMode": "PASS_THROUGH",
                "holdExpiresAt": "2026-03-01T12:15:00.000Z",
                "platformFeePerTicketCents": 175,
                "processorFeeShareCents": 81,
                "ticketIndex": 1,
              },
              "qty": 1,
              "ticketTypeId": "33333333-3333-4333-8333-333333333333",
              "unitPriceCents": 2500,
            },
            {
              "amountCents": 8000,
              "kind": "ticket",
              "meta": {
                "buyerTotalCents": 8706,
                "buyerUnitTotalCents": 8706,
                "effectiveFeeMode": "PASS_THROUGH",
                "holdExpiresAt": "2026-03-01T12:15:00.000Z",
                "platformFeePerTicketCents": 450,
                "processorFeeShareCents": 256,
                "ticketIndex": 0,
              },
              "qty": 1,
              "ticketTypeId": "33333333-3333-4333-8333-333333333334",
              "unitPriceCents": 8000,
            },
            {
              "amountCents": -1950,
              "kind": "discount",
              "meta": {
                "appliedDiscountCents": 1950,
                "code": "save",
                "kind": "PERCENT",
                "normalizedCode": "SAVE",
                "promoId": "promo-1",
                "scope": "EVENT",
                "value": 15,
              },
              "qty": 1,
              "ticketTypeId": undefined,
              "unitPriceCents": -1950,
            },
          ],
          "nonRefundable": false,
          "source": "PRIMARY",
          "taxAmountCents": 1089,
          "taxRateSource": "ziptax",
          "taxSitusCountry": "US",
          "taxSitusPostal": "55101",
          "taxSitusState": "MN",
        },
        "paymentIntent": {
          "amountCents": 13357,
          "currency": "usd",
          "metadata": {
            "buyerHumanId": "22222222-2222-4222-8222-222222222222",
            "currency": "usd",
            "discountTotalCents": "1950",
            "eventId": "11111111-1111-4111-8111-111111111111",
            "promoCodes": "SAVE",
            "source": "primary",
            "taxAmountCents": "1089",
          },
        },
        "result": {
          "amountGrossCents": 11050,
          "buyerFeesCents": 800,
          "clientSecret": "secret_char",
          "creditAppliedCents": 0,
          "feeMode": "PASS_THROUGH",
          "feeWaivedCents": 0,
          "feesPlatformCents": 800,
          "holdExpiresAt": "2026-03-01T12:15:00.000Z",
          "orderId": "66666666-6666-4666-8666-666666666666",
          "processorFeeCents": 418,
          "taxAmountCents": 1089,
        },
        "taxLines": [
          {
            "amountCents": 1089,
            "base": "BUYER_TOTAL",
            "code": "SALES",
            "collector": "PLATFORM",
            "jurisdiction": "US/MN",
            "label": "Sales tax",
            "rateBps": 888,
            "taxableAmountCents": 12268,
          },
        ],
      }
    `);
  });

  it("multi-line mixed tiers incl. pay-what-you-want (MN)", async () => {
    const summary = await runCheckout(
      {
        situs: MN,
        admissionTaxRateBps: 888,
        ticketTypes: [
          { id: GA_ID, priceCents: 2500 },
          { id: VIP_ID, priceCents: 8000 },
          {
            id: PWYW_ID,
            priceCents: 0,
            pricingMode: "ADJUSTABLE",
            minimumCents: 100,
          },
        ],
      },
      [
        { ticketTypeId: GA_ID, qty: 3 },
        { ticketTypeId: VIP_ID, qty: 1 },
        { ticketTypeId: PWYW_ID, qty: 1, donationAmountCents: 777 },
      ],
    );
    // Money as explicit literals; each also passes on the pre-extraction checkout.
    expect(moneyOf(summary)).toEqual({
      amountGrossCents: 16_277,
      feesPlatformCents: 1064,
      buyerFeesCents: 1064,
      taxAmountCents: 1593,
      processorFeeCents: 597,
      creditAppliedCents: 0,
      paymentIntentAmountCents: 19_531,
      orderAmountGrossCents: 16_277,
      orderFeesPlatformCents: 1064,
      orderTaxAmountCents: 1593,
      itemBuyerTotalCents: [2767, 2767, 2767, 8740, 897],
      itemAmountCents: [2500, 2500, 2500, 8000, 777],
      taxLines: [["SALES", 17_938, 1593]],
    });
    expect(summary).toMatchInlineSnapshot(`
      {
        "order": {
          "amountGrossCents": 16277,
          "currency": "usd",
          "feePolicySnapshot": {
            "agreementId": "44444444-4444-4444-8444-444444444444",
            "agreementVersion": 3,
            "computedAt": "2026-03-01T12:00:00.000Z",
            "feeMode": "PASS_THROUGH",
            "feePolicyId": "55555555-5555-4555-8555-555555555555",
            "feePolicyVersion": 7,
            "organiserCredit": "FULL_PRICE",
            "payoutTermsId": "44444444-4444-4444-8444-444444444444",
            "payoutTermsVersion": 3,
          },
          "feesPlatformCents": 1064,
          "items": [
            {
              "amountCents": 2500,
              "kind": "ticket",
              "meta": {
                "buyerTotalCents": 2767,
                "buyerUnitTotalCents": 2767,
                "effectiveFeeMode": "PASS_THROUGH",
                "holdExpiresAt": "2026-03-01T12:15:00.000Z",
                "platformFeePerTicketCents": 175,
                "processorFeeShareCents": 92,
                "ticketIndex": 0,
              },
              "qty": 1,
              "ticketTypeId": "33333333-3333-4333-8333-333333333333",
              "unitPriceCents": 2500,
            },
            {
              "amountCents": 2500,
              "kind": "ticket",
              "meta": {
                "buyerTotalCents": 2767,
                "buyerUnitTotalCents": 2767,
                "effectiveFeeMode": "PASS_THROUGH",
                "holdExpiresAt": "2026-03-01T12:15:00.000Z",
                "platformFeePerTicketCents": 175,
                "processorFeeShareCents": 92,
                "ticketIndex": 1,
              },
              "qty": 1,
              "ticketTypeId": "33333333-3333-4333-8333-333333333333",
              "unitPriceCents": 2500,
            },
            {
              "amountCents": 2500,
              "kind": "ticket",
              "meta": {
                "buyerTotalCents": 2767,
                "buyerUnitTotalCents": 2767,
                "effectiveFeeMode": "PASS_THROUGH",
                "holdExpiresAt": "2026-03-01T12:15:00.000Z",
                "platformFeePerTicketCents": 175,
                "processorFeeShareCents": 92,
                "ticketIndex": 2,
              },
              "qty": 1,
              "ticketTypeId": "33333333-3333-4333-8333-333333333333",
              "unitPriceCents": 2500,
            },
            {
              "amountCents": 8000,
              "kind": "ticket",
              "meta": {
                "buyerTotalCents": 8740,
                "buyerUnitTotalCents": 8740,
                "effectiveFeeMode": "PASS_THROUGH",
                "holdExpiresAt": "2026-03-01T12:15:00.000Z",
                "platformFeePerTicketCents": 450,
                "processorFeeShareCents": 290,
                "ticketIndex": 0,
              },
              "qty": 1,
              "ticketTypeId": "33333333-3333-4333-8333-333333333334",
              "unitPriceCents": 8000,
            },
            {
              "amountCents": 777,
              "kind": "ticket",
              "meta": {
                "buyerTotalCents": 897,
                "buyerUnitTotalCents": 897,
                "effectiveFeeMode": "PASS_THROUGH",
                "holdExpiresAt": "2026-03-01T12:15:00.000Z",
                "platformFeePerTicketCents": 89,
                "processorFeeShareCents": 31,
                "ticketIndex": 0,
              },
              "qty": 1,
              "ticketTypeId": "33333333-3333-4333-8333-333333333335",
              "unitPriceCents": 777,
            },
          ],
          "nonRefundable": false,
          "source": "PRIMARY",
          "taxAmountCents": 1593,
          "taxRateSource": "ziptax",
          "taxSitusCountry": "US",
          "taxSitusPostal": "55101",
          "taxSitusState": "MN",
        },
        "paymentIntent": {
          "amountCents": 19531,
          "currency": "usd",
          "metadata": {
            "buyerHumanId": "22222222-2222-4222-8222-222222222222",
            "currency": "usd",
            "donationTotalCents": "777",
            "eventId": "11111111-1111-4111-8111-111111111111",
            "source": "primary",
            "taxAmountCents": "1593",
          },
        },
        "result": {
          "amountGrossCents": 16277,
          "buyerFeesCents": 1064,
          "clientSecret": "secret_char",
          "creditAppliedCents": 0,
          "feeMode": "PASS_THROUGH",
          "feeWaivedCents": 0,
          "feesPlatformCents": 1064,
          "holdExpiresAt": "2026-03-01T12:15:00.000Z",
          "orderId": "66666666-6666-4666-8666-666666666666",
          "processorFeeCents": 597,
          "taxAmountCents": 1593,
        },
        "taxLines": [
          {
            "amountCents": 1593,
            "base": "BUYER_TOTAL",
            "code": "SALES",
            "collector": "PLATFORM",
            "jurisdiction": "US/MN",
            "label": "Sales tax",
            "rateBps": 888,
            "taxableAmountCents": 17938,
          },
        ],
      }
    `);
  });

  it("scheduled price already flipped: charges the scheduled price (no-tax state)", async () => {
    const summary = await runCheckout(
      {
        situs: OR,
        ticketTypes: [
          {
            id: GA_ID,
            priceCents: 2500,
            scheduledPriceCents: 3500,
            scheduledPriceAt: new Date("2026-02-15T00:00:00.000Z"),
          },
        ],
      },
      [{ ticketTypeId: GA_ID, qty: 2 }],
    );
    // Money as explicit literals; each also passes on the pre-extraction checkout.
    expect(moneyOf(summary)).toEqual({
      amountGrossCents: 7000,
      feesPlatformCents: 450,
      buyerFeesCents: 450,
      taxAmountCents: 0,
      processorFeeCents: 254,
      creditAppliedCents: 0,
      paymentIntentAmountCents: 7704,
      orderAmountGrossCents: 7000,
      orderFeesPlatformCents: 450,
      orderTaxAmountCents: 0,
      itemBuyerTotalCents: [3852, 3852],
      itemAmountCents: [3500, 3500],
      taxLines: [],
    });
    expect(summary).toMatchInlineSnapshot(`
      {
        "order": {
          "amountGrossCents": 7000,
          "currency": "usd",
          "feePolicySnapshot": {
            "agreementId": "44444444-4444-4444-8444-444444444444",
            "agreementVersion": 3,
            "computedAt": "2026-03-01T12:00:00.000Z",
            "feeMode": "PASS_THROUGH",
            "feePolicyId": "55555555-5555-4555-8555-555555555555",
            "feePolicyVersion": 7,
            "organiserCredit": "FULL_PRICE",
            "payoutTermsId": "44444444-4444-4444-8444-444444444444",
            "payoutTermsVersion": 3,
          },
          "feesPlatformCents": 450,
          "items": [
            {
              "amountCents": 3500,
              "kind": "ticket",
              "meta": {
                "buyerTotalCents": 3852,
                "buyerUnitTotalCents": 3852,
                "effectiveFeeMode": "PASS_THROUGH",
                "holdExpiresAt": "2026-03-01T12:15:00.000Z",
                "platformFeePerTicketCents": 225,
                "processorFeeShareCents": 127,
                "ticketIndex": 0,
              },
              "qty": 1,
              "ticketTypeId": "33333333-3333-4333-8333-333333333333",
              "unitPriceCents": 3500,
            },
            {
              "amountCents": 3500,
              "kind": "ticket",
              "meta": {
                "buyerTotalCents": 3852,
                "buyerUnitTotalCents": 3852,
                "effectiveFeeMode": "PASS_THROUGH",
                "holdExpiresAt": "2026-03-01T12:15:00.000Z",
                "platformFeePerTicketCents": 225,
                "processorFeeShareCents": 127,
                "ticketIndex": 1,
              },
              "qty": 1,
              "ticketTypeId": "33333333-3333-4333-8333-333333333333",
              "unitPriceCents": 3500,
            },
          ],
          "nonRefundable": false,
          "source": "PRIMARY",
          "taxAmountCents": 0,
          "taxRateSource": "ziptax",
          "taxSitusCountry": "US",
          "taxSitusPostal": "97201",
          "taxSitusState": "OR",
        },
        "paymentIntent": {
          "amountCents": 7704,
          "currency": "usd",
          "metadata": {
            "buyerHumanId": "22222222-2222-4222-8222-222222222222",
            "currency": "usd",
            "eventId": "11111111-1111-4111-8111-111111111111",
            "source": "primary",
          },
        },
        "result": {
          "amountGrossCents": 7000,
          "buyerFeesCents": 450,
          "clientSecret": "secret_char",
          "creditAppliedCents": 0,
          "feeMode": "PASS_THROUGH",
          "feeWaivedCents": 0,
          "feesPlatformCents": 450,
          "holdExpiresAt": "2026-03-01T12:15:00.000Z",
          "orderId": "66666666-6666-4666-8666-666666666666",
          "processorFeeCents": 254,
          "taxAmountCents": 0,
        },
        "taxLines": null,
      }
    `);
  });

  it("a fee policy row still saying ABSORB prices as PASS_THROUGH (TN)", async () => {
    const summary = await runCheckout(
      { situs: TN, admissionTaxRateBps: 975, storedFeeMode: "ABSORB" },
      [{ ticketTypeId: GA_ID, qty: 2 }],
    );
    // Money as explicit literals; each also passes on the pre-extraction checkout.
    expect(moneyOf(summary)).toEqual({
      amountGrossCents: 5000,
      feesPlatformCents: 350,
      buyerFeesCents: 350,
      taxAmountCents: 542,
      processorFeeCents: 207,
      creditAppliedCents: 0,
      paymentIntentAmountCents: 6099,
      orderAmountGrossCents: 5000,
      orderFeesPlatformCents: 350,
      orderTaxAmountCents: 542,
      itemBuyerTotalCents: [2778, 2779],
      itemAmountCents: [2500, 2500],
      taxLines: [["SALES", 5557, 542]],
    });
    expect(summary).toMatchInlineSnapshot(`
      {
        "order": {
          "amountGrossCents": 5000,
          "currency": "usd",
          "feePolicySnapshot": {
            "agreementId": "44444444-4444-4444-8444-444444444444",
            "agreementVersion": 3,
            "computedAt": "2026-03-01T12:00:00.000Z",
            "feeMode": "PASS_THROUGH",
            "feePolicyId": "55555555-5555-4555-8555-555555555555",
            "feePolicyVersion": 7,
            "organiserCredit": "FULL_PRICE",
            "payoutTermsId": "44444444-4444-4444-8444-444444444444",
            "payoutTermsVersion": 3,
          },
          "feesPlatformCents": 350,
          "items": [
            {
              "amountCents": 2500,
              "kind": "ticket",
              "meta": {
                "buyerTotalCents": 2778,
                "buyerUnitTotalCents": 2778,
                "effectiveFeeMode": "PASS_THROUGH",
                "holdExpiresAt": "2026-03-01T12:15:00.000Z",
                "platformFeePerTicketCents": 175,
                "processorFeeShareCents": 103,
                "ticketIndex": 0,
              },
              "qty": 1,
              "ticketTypeId": "33333333-3333-4333-8333-333333333333",
              "unitPriceCents": 2500,
            },
            {
              "amountCents": 2500,
              "kind": "ticket",
              "meta": {
                "buyerTotalCents": 2779,
                "buyerUnitTotalCents": 2779,
                "effectiveFeeMode": "PASS_THROUGH",
                "holdExpiresAt": "2026-03-01T12:15:00.000Z",
                "platformFeePerTicketCents": 175,
                "processorFeeShareCents": 104,
                "ticketIndex": 1,
              },
              "qty": 1,
              "ticketTypeId": "33333333-3333-4333-8333-333333333333",
              "unitPriceCents": 2500,
            },
          ],
          "nonRefundable": false,
          "source": "PRIMARY",
          "taxAmountCents": 542,
          "taxRateSource": "ziptax",
          "taxSitusCountry": "US",
          "taxSitusPostal": "37203",
          "taxSitusState": "TN",
        },
        "paymentIntent": {
          "amountCents": 6099,
          "currency": "usd",
          "metadata": {
            "buyerHumanId": "22222222-2222-4222-8222-222222222222",
            "currency": "usd",
            "eventId": "11111111-1111-4111-8111-111111111111",
            "source": "primary",
            "taxAmountCents": "542",
          },
        },
        "result": {
          "amountGrossCents": 5000,
          "buyerFeesCents": 350,
          "clientSecret": "secret_char",
          "creditAppliedCents": 0,
          "feeMode": "PASS_THROUGH",
          "feeWaivedCents": 0,
          "feesPlatformCents": 350,
          "holdExpiresAt": "2026-03-01T12:15:00.000Z",
          "orderId": "66666666-6666-4666-8666-666666666666",
          "processorFeeCents": 207,
          "taxAmountCents": 542,
        },
        "taxLines": [
          {
            "amountCents": 542,
            "base": "BUYER_TOTAL",
            "code": "SALES",
            "collector": "PLATFORM",
            "jurisdiction": "US/TN",
            "label": "Sales tax",
            "rateBps": 975,
            "taxableAmountCents": 5557,
          },
        ],
      }
    `);
  });

  it("per-ticket min/max fee clamps with a flat fee (TN)", async () => {
    const summary = await runCheckout(
      {
        situs: TN,
        admissionTaxRateBps: 975,
        buyerFeePct: 0.1,
        platformFixedCents: 0,
        minFeeCents: 150,
        maxFeeCents: 600,
        ticketTypes: [
          { id: GA_ID, priceCents: 900 },
          { id: VIP_ID, priceCents: 12000 },
        ],
      },
      [
        { ticketTypeId: GA_ID, qty: 2 },
        { ticketTypeId: VIP_ID, qty: 1 },
      ],
    );
    // Money as explicit literals; each also passes on the pre-extraction checkout.
    expect(moneyOf(summary)).toEqual({
      amountGrossCents: 13_800,
      feesPlatformCents: 900,
      buyerFeesCents: 900,
      taxAmountCents: 1483,
      processorFeeCents: 515,
      creditAppliedCents: 0,
      paymentIntentAmountCents: 16_698,
      orderAmountGrossCents: 13_800,
      orderFeesPlatformCents: 900,
      orderTaxAmountCents: 1483,
      itemBuyerTotalCents: [1086, 1086, 13_043],
      itemAmountCents: [900, 900, 12_000],
      taxLines: [["SALES", 15_215, 1483]],
    });
    expect(summary).toMatchInlineSnapshot(`
      {
        "order": {
          "amountGrossCents": 13800,
          "currency": "usd",
          "feePolicySnapshot": {
            "agreementId": "44444444-4444-4444-8444-444444444444",
            "agreementVersion": 3,
            "computedAt": "2026-03-01T12:00:00.000Z",
            "feeMode": "PASS_THROUGH",
            "feePolicyId": "55555555-5555-4555-8555-555555555555",
            "feePolicyVersion": 7,
            "organiserCredit": "FULL_PRICE",
            "payoutTermsId": "44444444-4444-4444-8444-444444444444",
            "payoutTermsVersion": 3,
          },
          "feesPlatformCents": 900,
          "items": [
            {
              "amountCents": 900,
              "kind": "ticket",
              "meta": {
                "buyerTotalCents": 1086,
                "buyerUnitTotalCents": 1086,
                "effectiveFeeMode": "PASS_THROUGH",
                "holdExpiresAt": "2026-03-01T12:15:00.000Z",
                "platformFeePerTicketCents": 150,
                "processorFeeShareCents": 36,
                "ticketIndex": 0,
              },
              "qty": 1,
              "ticketTypeId": "33333333-3333-4333-8333-333333333333",
              "unitPriceCents": 900,
            },
            {
              "amountCents": 900,
              "kind": "ticket",
              "meta": {
                "buyerTotalCents": 1086,
                "buyerUnitTotalCents": 1086,
                "effectiveFeeMode": "PASS_THROUGH",
                "holdExpiresAt": "2026-03-01T12:15:00.000Z",
                "platformFeePerTicketCents": 150,
                "processorFeeShareCents": 36,
                "ticketIndex": 1,
              },
              "qty": 1,
              "ticketTypeId": "33333333-3333-4333-8333-333333333333",
              "unitPriceCents": 900,
            },
            {
              "amountCents": 12000,
              "kind": "ticket",
              "meta": {
                "buyerTotalCents": 13043,
                "buyerUnitTotalCents": 13043,
                "effectiveFeeMode": "PASS_THROUGH",
                "holdExpiresAt": "2026-03-01T12:15:00.000Z",
                "platformFeePerTicketCents": 600,
                "processorFeeShareCents": 443,
                "ticketIndex": 0,
              },
              "qty": 1,
              "ticketTypeId": "33333333-3333-4333-8333-333333333334",
              "unitPriceCents": 12000,
            },
          ],
          "nonRefundable": false,
          "source": "PRIMARY",
          "taxAmountCents": 1483,
          "taxRateSource": "ziptax",
          "taxSitusCountry": "US",
          "taxSitusPostal": "37203",
          "taxSitusState": "TN",
        },
        "paymentIntent": {
          "amountCents": 16698,
          "currency": "usd",
          "metadata": {
            "buyerHumanId": "22222222-2222-4222-8222-222222222222",
            "currency": "usd",
            "eventId": "11111111-1111-4111-8111-111111111111",
            "source": "primary",
            "taxAmountCents": "1483",
          },
        },
        "result": {
          "amountGrossCents": 13800,
          "buyerFeesCents": 900,
          "clientSecret": "secret_char",
          "creditAppliedCents": 0,
          "feeMode": "PASS_THROUGH",
          "feeWaivedCents": 0,
          "feesPlatformCents": 900,
          "holdExpiresAt": "2026-03-01T12:15:00.000Z",
          "orderId": "66666666-6666-4666-8666-666666666666",
          "processorFeeCents": 515,
          "taxAmountCents": 1483,
        },
        "taxLines": [
          {
            "amountCents": 1483,
            "base": "BUYER_TOTAL",
            "code": "SALES",
            "collector": "PLATFORM",
            "jurisdiction": "US/TN",
            "label": "Sales tax",
            "rateBps": 975,
            "taxableAmountCents": 15215,
          },
        ],
      }
    `);
  });

  it("two impositions: BUYER_TOTAL sales + a TICKET_FACE local line + an ORGANISER line (MN)", async () => {
    // `primaryRule`: the rule type gains fields over time (e.g. a resale
    // flag); these rows set only what a PRIMARY sale reads.
    const primaryRule = (
      rule: Omit<LocalTaxImpositionRule, "appliesToResale">,
    ) => rule as LocalTaxImpositionRule;
    localTaxRules.rules = [
      primaryRule({
        code: "TEST_CITY",
        label: "Test city entertainment tax",
        jurisdiction: "US/MN/TestCity",
        countryCode: "US",
        region: "MN",
        postalCodes: ["55101"],
        rateBps: 300,
        base: "TICKET_FACE",
        collector: "PLATFORM",
        source: "characterization fixture",
      }),
      primaryRule({
        code: "TEST_VENUE_DUTY",
        label: "Test venue duty",
        jurisdiction: "US/MN/TestCity",
        countryCode: "US",
        region: "MN",
        postalCodes: ["55101"],
        rateBps: 200,
        base: "BUYER_TOTAL",
        collector: "ORGANISER",
        source: "characterization fixture",
      }),
    ];
    try {
      const summary = await runCheckout(
        { situs: MN, admissionTaxRateBps: 888 },
        [{ ticketTypeId: GA_ID, qty: 2 }],
      );
      // Money as explicit literals; each also passes on the pre-extraction checkout.
      expect(moneyOf(summary)).toEqual({
        amountGrossCents: 5000,
        feesPlatformCents: 350,
        buyerFeesCents: 350,
        taxAmountCents: 644,
        processorFeeCents: 210,
        creditAppliedCents: 0,
        paymentIntentAmountCents: 6204,
        orderAmountGrossCents: 5000,
        orderFeesPlatformCents: 350,
        orderTaxAmountCents: 644,
        itemBuyerTotalCents: [2780, 2780],
        itemAmountCents: [2500, 2500],
        taxLines: [["SALES", 5560, 494], ["TEST_CITY", 5000, 150], ["TEST_VENUE_DUTY", 5560, 111]],
      });
      expect(summary).toMatchInlineSnapshot(`
        {
          "order": {
            "amountGrossCents": 5000,
            "currency": "usd",
            "feePolicySnapshot": {
              "agreementId": "44444444-4444-4444-8444-444444444444",
              "agreementVersion": 3,
              "computedAt": "2026-03-01T12:00:00.000Z",
              "feeMode": "PASS_THROUGH",
              "feePolicyId": "55555555-5555-4555-8555-555555555555",
              "feePolicyVersion": 7,
              "organiserCredit": "FULL_PRICE",
              "payoutTermsId": "44444444-4444-4444-8444-444444444444",
              "payoutTermsVersion": 3,
            },
            "feesPlatformCents": 350,
            "items": [
              {
                "amountCents": 2500,
                "kind": "ticket",
                "meta": {
                  "buyerTotalCents": 2780,
                  "buyerUnitTotalCents": 2780,
                  "effectiveFeeMode": "PASS_THROUGH",
                  "holdExpiresAt": "2026-03-01T12:15:00.000Z",
                  "platformFeePerTicketCents": 175,
                  "processorFeeShareCents": 105,
                  "ticketIndex": 0,
                },
                "qty": 1,
                "ticketTypeId": "33333333-3333-4333-8333-333333333333",
                "unitPriceCents": 2500,
              },
              {
                "amountCents": 2500,
                "kind": "ticket",
                "meta": {
                  "buyerTotalCents": 2780,
                  "buyerUnitTotalCents": 2780,
                  "effectiveFeeMode": "PASS_THROUGH",
                  "holdExpiresAt": "2026-03-01T12:15:00.000Z",
                  "platformFeePerTicketCents": 175,
                  "processorFeeShareCents": 105,
                  "ticketIndex": 1,
                },
                "qty": 1,
                "ticketTypeId": "33333333-3333-4333-8333-333333333333",
                "unitPriceCents": 2500,
              },
            ],
            "nonRefundable": false,
            "source": "PRIMARY",
            "taxAmountCents": 644,
            "taxRateSource": "ziptax",
            "taxSitusCountry": "US",
            "taxSitusPostal": "55101",
            "taxSitusState": "MN",
          },
          "paymentIntent": {
            "amountCents": 6204,
            "currency": "usd",
            "metadata": {
              "buyerHumanId": "22222222-2222-4222-8222-222222222222",
              "currency": "usd",
              "eventId": "11111111-1111-4111-8111-111111111111",
              "source": "primary",
              "taxAmountCents": "644",
            },
          },
          "result": {
            "amountGrossCents": 5000,
            "buyerFeesCents": 350,
            "clientSecret": "secret_char",
            "creditAppliedCents": 0,
            "feeMode": "PASS_THROUGH",
            "feeWaivedCents": 0,
            "feesPlatformCents": 350,
            "holdExpiresAt": "2026-03-01T12:15:00.000Z",
            "orderId": "66666666-6666-4666-8666-666666666666",
            "processorFeeCents": 210,
            "taxAmountCents": 644,
          },
          "taxLines": [
            {
              "amountCents": 494,
              "base": "BUYER_TOTAL",
              "code": "SALES",
              "collector": "PLATFORM",
              "jurisdiction": "US/MN",
              "label": "Sales tax",
              "rateBps": 888,
              "taxableAmountCents": 5560,
            },
            {
              "amountCents": 150,
              "base": "TICKET_FACE",
              "code": "TEST_CITY",
              "collector": "PLATFORM",
              "jurisdiction": "US/MN/TestCity",
              "label": "Test city entertainment tax",
              "rateBps": 300,
              "taxableAmountCents": 5000,
            },
            {
              "amountCents": 111,
              "base": "BUYER_TOTAL",
              "code": "TEST_VENUE_DUTY",
              "collector": "ORGANISER",
              "jurisdiction": "US/MN/TestCity",
              "label": "Test venue duty",
              "rateBps": 200,
              "taxableAmountCents": 5560,
            },
          ],
        }
      `);
    } finally {
      localTaxRules.rules = [];
    }
  });

  it("platform credit partially covers the face (TN)", async () => {
    const summary = await runCheckout(
      { situs: TN, admissionTaxRateBps: 975, creditCents: 1200 },
      [{ ticketTypeId: GA_ID, qty: 2 }],
    );
    // Money as explicit literals; each also passes on the pre-extraction checkout.
    expect(moneyOf(summary)).toEqual({
      amountGrossCents: 5000,
      feesPlatformCents: 350,
      buyerFeesCents: 350,
      taxAmountCents: 542,
      processorFeeCents: 207,
      creditAppliedCents: 1200,
      paymentIntentAmountCents: 4899,
      orderAmountGrossCents: 5000,
      orderFeesPlatformCents: 350,
      orderTaxAmountCents: 542,
      itemBuyerTotalCents: [2778, 2779],
      itemAmountCents: [2500, 2500, -1200],
      taxLines: [["SALES", 5557, 542]],
    });
    expect(summary).toMatchInlineSnapshot(`
      {
        "order": {
          "amountGrossCents": 5000,
          "currency": "usd",
          "feePolicySnapshot": {
            "agreementId": "44444444-4444-4444-8444-444444444444",
            "agreementVersion": 3,
            "computedAt": "2026-03-01T12:00:00.000Z",
            "feeMode": "PASS_THROUGH",
            "feePolicyId": "55555555-5555-4555-8555-555555555555",
            "feePolicyVersion": 7,
            "organiserCredit": "FULL_PRICE",
            "payoutTermsId": "44444444-4444-4444-8444-444444444444",
            "payoutTermsVersion": 3,
          },
          "feesPlatformCents": 350,
          "items": [
            {
              "amountCents": 2500,
              "kind": "ticket",
              "meta": {
                "buyerTotalCents": 2778,
                "buyerUnitTotalCents": 2778,
                "effectiveFeeMode": "PASS_THROUGH",
                "holdExpiresAt": "2026-03-01T12:15:00.000Z",
                "platformFeePerTicketCents": 175,
                "processorFeeShareCents": 103,
                "ticketIndex": 0,
              },
              "qty": 1,
              "ticketTypeId": "33333333-3333-4333-8333-333333333333",
              "unitPriceCents": 2500,
            },
            {
              "amountCents": 2500,
              "kind": "ticket",
              "meta": {
                "buyerTotalCents": 2779,
                "buyerUnitTotalCents": 2779,
                "effectiveFeeMode": "PASS_THROUGH",
                "holdExpiresAt": "2026-03-01T12:15:00.000Z",
                "platformFeePerTicketCents": 175,
                "processorFeeShareCents": 104,
                "ticketIndex": 1,
              },
              "qty": 1,
              "ticketTypeId": "33333333-3333-4333-8333-333333333333",
              "unitPriceCents": 2500,
            },
            {
              "amountCents": -1200,
              "kind": "platform_credit",
              "meta": {
                "appliedCreditCents": 1200,
                "creditId": "credit-1",
                "reason": "Test credit",
                "sourceType": "MANUAL_STAFF_GRANT",
              },
              "qty": 1,
              "ticketTypeId": undefined,
              "unitPriceCents": -1200,
            },
          ],
          "nonRefundable": false,
          "source": "PRIMARY",
          "taxAmountCents": 542,
          "taxRateSource": "ziptax",
          "taxSitusCountry": "US",
          "taxSitusPostal": "37203",
          "taxSitusState": "TN",
        },
        "paymentIntent": {
          "amountCents": 4899,
          "currency": "usd",
          "metadata": {
            "buyerHumanId": "22222222-2222-4222-8222-222222222222",
            "currency": "usd",
            "eventId": "11111111-1111-4111-8111-111111111111",
            "source": "primary",
            "taxAmountCents": "542",
          },
        },
        "result": {
          "amountGrossCents": 5000,
          "buyerFeesCents": 350,
          "clientSecret": "secret_char",
          "creditAppliedCents": 1200,
          "feeMode": "PASS_THROUGH",
          "feeWaivedCents": 0,
          "feesPlatformCents": 350,
          "holdExpiresAt": "2026-03-01T12:15:00.000Z",
          "orderId": "66666666-6666-4666-8666-666666666666",
          "processorFeeCents": 207,
          "taxAmountCents": 542,
        },
        "taxLines": [
          {
            "amountCents": 542,
            "base": "BUYER_TOTAL",
            "code": "SALES",
            "collector": "PLATFORM",
            "jurisdiction": "US/TN",
            "label": "Sales tax",
            "rateBps": 975,
            "taxableAmountCents": 5557,
          },
        ],
      }
    `);
  });

  it("zero processor rates: no processor fee, tax on face + platform (TN)", async () => {
    const summary = await runCheckout(
      {
        situs: TN,
        admissionTaxRateBps: 975,
        processorFeePct: 0,
        processorFixedCents: 0,
      },
      [{ ticketTypeId: GA_ID, qty: 2 }],
    );
    // Money as explicit literals; each also passes on the pre-extraction checkout.
    expect(moneyOf(summary)).toEqual({
      amountGrossCents: 5000,
      feesPlatformCents: 350,
      buyerFeesCents: 350,
      taxAmountCents: 522,
      processorFeeCents: 0,
      creditAppliedCents: 0,
      paymentIntentAmountCents: 5872,
      orderAmountGrossCents: 5000,
      orderFeesPlatformCents: 350,
      orderTaxAmountCents: 522,
      itemBuyerTotalCents: [2675, 2675],
      itemAmountCents: [2500, 2500],
      taxLines: [["SALES", 5350, 522]],
    });
    expect(summary).toMatchInlineSnapshot(`
      {
        "order": {
          "amountGrossCents": 5000,
          "currency": "usd",
          "feePolicySnapshot": {
            "agreementId": "44444444-4444-4444-8444-444444444444",
            "agreementVersion": 3,
            "computedAt": "2026-03-01T12:00:00.000Z",
            "feeMode": "PASS_THROUGH",
            "feePolicyId": "55555555-5555-4555-8555-555555555555",
            "feePolicyVersion": 7,
            "organiserCredit": "FULL_PRICE",
            "payoutTermsId": "44444444-4444-4444-8444-444444444444",
            "payoutTermsVersion": 3,
          },
          "feesPlatformCents": 350,
          "items": [
            {
              "amountCents": 2500,
              "kind": "ticket",
              "meta": {
                "buyerTotalCents": 2675,
                "buyerUnitTotalCents": 2675,
                "effectiveFeeMode": "PASS_THROUGH",
                "holdExpiresAt": "2026-03-01T12:15:00.000Z",
                "platformFeePerTicketCents": 175,
                "ticketIndex": 0,
              },
              "qty": 1,
              "ticketTypeId": "33333333-3333-4333-8333-333333333333",
              "unitPriceCents": 2500,
            },
            {
              "amountCents": 2500,
              "kind": "ticket",
              "meta": {
                "buyerTotalCents": 2675,
                "buyerUnitTotalCents": 2675,
                "effectiveFeeMode": "PASS_THROUGH",
                "holdExpiresAt": "2026-03-01T12:15:00.000Z",
                "platformFeePerTicketCents": 175,
                "ticketIndex": 1,
              },
              "qty": 1,
              "ticketTypeId": "33333333-3333-4333-8333-333333333333",
              "unitPriceCents": 2500,
            },
          ],
          "nonRefundable": false,
          "source": "PRIMARY",
          "taxAmountCents": 522,
          "taxRateSource": "ziptax",
          "taxSitusCountry": "US",
          "taxSitusPostal": "37203",
          "taxSitusState": "TN",
        },
        "paymentIntent": {
          "amountCents": 5872,
          "currency": "usd",
          "metadata": {
            "buyerHumanId": "22222222-2222-4222-8222-222222222222",
            "currency": "usd",
            "eventId": "11111111-1111-4111-8111-111111111111",
            "source": "primary",
            "taxAmountCents": "522",
          },
        },
        "result": {
          "amountGrossCents": 5000,
          "buyerFeesCents": 350,
          "clientSecret": "secret_char",
          "creditAppliedCents": 0,
          "feeMode": "PASS_THROUGH",
          "feeWaivedCents": 0,
          "feesPlatformCents": 350,
          "holdExpiresAt": "2026-03-01T12:15:00.000Z",
          "orderId": "66666666-6666-4666-8666-666666666666",
          "processorFeeCents": 0,
          "taxAmountCents": 522,
        },
        "taxLines": [
          {
            "amountCents": 522,
            "base": "BUYER_TOTAL",
            "code": "SALES",
            "collector": "PLATFORM",
            "jurisdiction": "US/TN",
            "label": "Sales tax",
            "rateBps": 975,
            "taxableAmountCents": 5350,
          },
        ],
      }
    `);
  });

  // ── Credit boundary ────────────────────────────────────────────────
  // Credit offsets only the ticket subtotal, never fees, tax or the
  // processor fee, so a processor fee always leaves a charge behind.

  it("credit larger than the face (TN): credit stops at the face, the buyer pays fees + tax + processor fee", async () => {
    const summary = await runCheckout(
      { situs: TN, admissionTaxRateBps: 975, creditCents: 10_000 },
      [{ ticketTypeId: GA_ID, qty: 2 }],
    );
    // Money as explicit literals; each also passes on the pre-extraction checkout.
    expect(moneyOf(summary)).toEqual({
      amountGrossCents: 5000,
      feesPlatformCents: 350,
      buyerFeesCents: 350,
      taxAmountCents: 542,
      processorFeeCents: 207,
      creditAppliedCents: 5000,
      paymentIntentAmountCents: 1099,
      orderAmountGrossCents: 5000,
      orderFeesPlatformCents: 350,
      orderTaxAmountCents: 542,
      itemBuyerTotalCents: [2778, 2779],
      itemAmountCents: [2500, 2500, -5000],
      taxLines: [["SALES", 5557, 542]],
    });
    expect(summary).toMatchInlineSnapshot(`
      {
        "order": {
          "amountGrossCents": 5000,
          "currency": "usd",
          "feePolicySnapshot": {
            "agreementId": "44444444-4444-4444-8444-444444444444",
            "agreementVersion": 3,
            "computedAt": "2026-03-01T12:00:00.000Z",
            "feeMode": "PASS_THROUGH",
            "feePolicyId": "55555555-5555-4555-8555-555555555555",
            "feePolicyVersion": 7,
            "organiserCredit": "FULL_PRICE",
            "payoutTermsId": "44444444-4444-4444-8444-444444444444",
            "payoutTermsVersion": 3,
          },
          "feesPlatformCents": 350,
          "items": [
            {
              "amountCents": 2500,
              "kind": "ticket",
              "meta": {
                "buyerTotalCents": 2778,
                "buyerUnitTotalCents": 2778,
                "effectiveFeeMode": "PASS_THROUGH",
                "holdExpiresAt": "2026-03-01T12:15:00.000Z",
                "platformFeePerTicketCents": 175,
                "processorFeeShareCents": 103,
                "ticketIndex": 0,
              },
              "qty": 1,
              "ticketTypeId": "33333333-3333-4333-8333-333333333333",
              "unitPriceCents": 2500,
            },
            {
              "amountCents": 2500,
              "kind": "ticket",
              "meta": {
                "buyerTotalCents": 2779,
                "buyerUnitTotalCents": 2779,
                "effectiveFeeMode": "PASS_THROUGH",
                "holdExpiresAt": "2026-03-01T12:15:00.000Z",
                "platformFeePerTicketCents": 175,
                "processorFeeShareCents": 104,
                "ticketIndex": 1,
              },
              "qty": 1,
              "ticketTypeId": "33333333-3333-4333-8333-333333333333",
              "unitPriceCents": 2500,
            },
            {
              "amountCents": -5000,
              "kind": "platform_credit",
              "meta": {
                "appliedCreditCents": 5000,
                "creditId": "credit-1",
                "reason": "Test credit",
                "sourceType": "MANUAL_STAFF_GRANT",
              },
              "qty": 1,
              "ticketTypeId": undefined,
              "unitPriceCents": -5000,
            },
          ],
          "nonRefundable": false,
          "source": "PRIMARY",
          "taxAmountCents": 542,
          "taxRateSource": "ziptax",
          "taxSitusCountry": "US",
          "taxSitusPostal": "37203",
          "taxSitusState": "TN",
        },
        "paymentIntent": {
          "amountCents": 1099,
          "currency": "usd",
          "metadata": {
            "buyerHumanId": "22222222-2222-4222-8222-222222222222",
            "currency": "usd",
            "eventId": "11111111-1111-4111-8111-111111111111",
            "source": "primary",
            "taxAmountCents": "542",
          },
        },
        "result": {
          "amountGrossCents": 5000,
          "buyerFeesCents": 350,
          "clientSecret": "secret_char",
          "creditAppliedCents": 5000,
          "feeMode": "PASS_THROUGH",
          "feeWaivedCents": 0,
          "feesPlatformCents": 350,
          "holdExpiresAt": "2026-03-01T12:15:00.000Z",
          "orderId": "66666666-6666-4666-8666-666666666666",
          "processorFeeCents": 207,
          "taxAmountCents": 542,
        },
        "taxLines": [
          {
            "amountCents": 542,
            "base": "BUYER_TOTAL",
            "code": "SALES",
            "collector": "PLATFORM",
            "jurisdiction": "US/TN",
            "label": "Sales tax",
            "rateBps": 975,
            "taxableAmountCents": 5557,
          },
        ],
      }
    `);
  });

  it("zero-fee policy, credit covers the face (no tax): zero-charge completion, no PaymentIntent", async () => {
    const summary = await runCheckout(
      {
        situs: OR,
        buyerFeePct: 0,
        platformFixedCents: 0,
        processorFeePct: 0,
        processorFixedCents: 0,
        creditCents: 6_000,
      },
      [{ ticketTypeId: GA_ID, qty: 2 }],
    );
    // Money as explicit literals; each also passes on the pre-extraction checkout.
    expect(moneyOf(summary)).toEqual({
      amountGrossCents: 5000,
      feesPlatformCents: 0,
      buyerFeesCents: 0,
      taxAmountCents: 0,
      processorFeeCents: 0,
      creditAppliedCents: 5000,
      paymentIntentAmountCents: null,
      orderAmountGrossCents: 5000,
      orderFeesPlatformCents: 0,
      orderTaxAmountCents: 0,
      itemBuyerTotalCents: [2500, 2500],
      itemAmountCents: [2500, 2500, -5000],
      taxLines: [],
    });
    expect(summary).toMatchInlineSnapshot(`
      {
        "order": {
          "amountGrossCents": 5000,
          "currency": "usd",
          "feePolicySnapshot": {
            "agreementId": "44444444-4444-4444-8444-444444444444",
            "agreementVersion": 3,
            "computedAt": "2026-03-01T12:00:00.000Z",
            "feeMode": "PASS_THROUGH",
            "feePolicyId": "55555555-5555-4555-8555-555555555555",
            "feePolicyVersion": 7,
            "organiserCredit": "FULL_PRICE",
            "payoutTermsId": "44444444-4444-4444-8444-444444444444",
            "payoutTermsVersion": 3,
          },
          "feesPlatformCents": 0,
          "items": [
            {
              "amountCents": 2500,
              "kind": "ticket",
              "meta": {
                "buyerTotalCents": 2500,
                "buyerUnitTotalCents": 2500,
                "effectiveFeeMode": "PASS_THROUGH",
                "holdExpiresAt": "2026-03-01T12:15:00.000Z",
                "platformFeePerTicketCents": 0,
                "ticketIndex": 0,
              },
              "qty": 1,
              "ticketTypeId": "33333333-3333-4333-8333-333333333333",
              "unitPriceCents": 2500,
            },
            {
              "amountCents": 2500,
              "kind": "ticket",
              "meta": {
                "buyerTotalCents": 2500,
                "buyerUnitTotalCents": 2500,
                "effectiveFeeMode": "PASS_THROUGH",
                "holdExpiresAt": "2026-03-01T12:15:00.000Z",
                "platformFeePerTicketCents": 0,
                "ticketIndex": 1,
              },
              "qty": 1,
              "ticketTypeId": "33333333-3333-4333-8333-333333333333",
              "unitPriceCents": 2500,
            },
            {
              "amountCents": -5000,
              "kind": "platform_credit",
              "meta": {
                "appliedCreditCents": 5000,
                "creditId": "credit-1",
                "reason": "Test credit",
                "sourceType": "MANUAL_STAFF_GRANT",
              },
              "qty": 1,
              "ticketTypeId": undefined,
              "unitPriceCents": -5000,
            },
          ],
          "nonRefundable": false,
          "source": "PRIMARY",
          "taxAmountCents": 0,
          "taxRateSource": "ziptax",
          "taxSitusCountry": "US",
          "taxSitusPostal": "97201",
          "taxSitusState": "OR",
        },
        "paymentIntent": null,
        "result": {
          "amountGrossCents": 5000,
          "buyerFeesCents": 0,
          "clientSecret": null,
          "creditAppliedCents": 5000,
          "feeMode": "PASS_THROUGH",
          "feeWaivedCents": 0,
          "feesPlatformCents": 0,
          "holdExpiresAt": null,
          "orderId": "66666666-6666-4666-8666-666666666666",
          "processorFeeCents": 0,
          "taxAmountCents": 0,
        },
        "taxLines": null,
      }
    `);
  });

  it("zero-fee policy, credit 20¢ short of the face: credit is capped so the charge is the 50¢ minimum", async () => {
    const summary = await runCheckout(
      {
        situs: OR,
        buyerFeePct: 0,
        platformFixedCents: 0,
        processorFeePct: 0,
        processorFixedCents: 0,
        creditCents: 4_980,
      },
      [{ ticketTypeId: GA_ID, qty: 2 }],
    );
    // Money as explicit literals; each also passes on the pre-extraction checkout.
    expect(moneyOf(summary)).toEqual({
      amountGrossCents: 5000,
      feesPlatformCents: 0,
      buyerFeesCents: 0,
      taxAmountCents: 0,
      processorFeeCents: 0,
      creditAppliedCents: 4950,
      paymentIntentAmountCents: 50,
      orderAmountGrossCents: 5000,
      orderFeesPlatformCents: 0,
      orderTaxAmountCents: 0,
      itemBuyerTotalCents: [2500, 2500],
      itemAmountCents: [2500, 2500, -4950],
      taxLines: [],
    });
    expect(summary).toMatchInlineSnapshot(`
      {
        "order": {
          "amountGrossCents": 5000,
          "currency": "usd",
          "feePolicySnapshot": {
            "agreementId": "44444444-4444-4444-8444-444444444444",
            "agreementVersion": 3,
            "computedAt": "2026-03-01T12:00:00.000Z",
            "feeMode": "PASS_THROUGH",
            "feePolicyId": "55555555-5555-4555-8555-555555555555",
            "feePolicyVersion": 7,
            "organiserCredit": "FULL_PRICE",
            "payoutTermsId": "44444444-4444-4444-8444-444444444444",
            "payoutTermsVersion": 3,
          },
          "feesPlatformCents": 0,
          "items": [
            {
              "amountCents": 2500,
              "kind": "ticket",
              "meta": {
                "buyerTotalCents": 2500,
                "buyerUnitTotalCents": 2500,
                "effectiveFeeMode": "PASS_THROUGH",
                "holdExpiresAt": "2026-03-01T12:15:00.000Z",
                "platformFeePerTicketCents": 0,
                "ticketIndex": 0,
              },
              "qty": 1,
              "ticketTypeId": "33333333-3333-4333-8333-333333333333",
              "unitPriceCents": 2500,
            },
            {
              "amountCents": 2500,
              "kind": "ticket",
              "meta": {
                "buyerTotalCents": 2500,
                "buyerUnitTotalCents": 2500,
                "effectiveFeeMode": "PASS_THROUGH",
                "holdExpiresAt": "2026-03-01T12:15:00.000Z",
                "platformFeePerTicketCents": 0,
                "ticketIndex": 1,
              },
              "qty": 1,
              "ticketTypeId": "33333333-3333-4333-8333-333333333333",
              "unitPriceCents": 2500,
            },
            {
              "amountCents": -4950,
              "kind": "platform_credit",
              "meta": {
                "appliedCreditCents": 4950,
                "creditId": "credit-1",
                "reason": "Test credit",
                "sourceType": "MANUAL_STAFF_GRANT",
              },
              "qty": 1,
              "ticketTypeId": undefined,
              "unitPriceCents": -4950,
            },
          ],
          "nonRefundable": false,
          "source": "PRIMARY",
          "taxAmountCents": 0,
          "taxRateSource": "ziptax",
          "taxSitusCountry": "US",
          "taxSitusPostal": "97201",
          "taxSitusState": "OR",
        },
        "paymentIntent": {
          "amountCents": 50,
          "currency": "usd",
          "metadata": {
            "buyerHumanId": "22222222-2222-4222-8222-222222222222",
            "currency": "usd",
            "eventId": "11111111-1111-4111-8111-111111111111",
            "source": "primary",
          },
        },
        "result": {
          "amountGrossCents": 5000,
          "buyerFeesCents": 0,
          "clientSecret": "secret_char",
          "creditAppliedCents": 4950,
          "feeMode": "PASS_THROUGH",
          "feeWaivedCents": 0,
          "feesPlatformCents": 0,
          "holdExpiresAt": "2026-03-01T12:15:00.000Z",
          "orderId": "66666666-6666-4666-8666-666666666666",
          "processorFeeCents": 0,
          "taxAmountCents": 0,
        },
        "taxLines": null,
      }
    `);
  });

  // ── Error precedence ───────────────────────────────────────────────

  it("a promo that zeroes the cart only on the paid path refuses EXPECTED_PAID_ORDER before any tax solve", async () => {
    // An imposition the solver would refuse as INTERNAL: the refusal must
    // still be the routing one, because the free check runs first.
    localTaxRules.rules = [
      {
        code: "TEST_BAD_BASE",
        label: "Unknown base",
        jurisdiction: "US/TN/Test",
        countryCode: "US",
        region: "TN",
        postalCodes: null,
        rateBps: 100,
        base: "NOT_A_BASE",
        collector: "PLATFORM",
        source: "characterization fixture",
      } as unknown as LocalTaxImpositionRule,
    ];
    try {
      const h = makeHarness({
        situs: TN,
        admissionTaxRateBps: 975,
        promo: { value: 100 },
        promoValueOnPaidPath: 5_000,
      });
      await expect(
        createCheckout(h.deps, {
          actorHumanId: BUYER_ID,
          buyerHumanId: BUYER_ID,
          eventId: EVENT_ID,
          clientKey: "characterization-key",
          termsAccepted: true,
          refundPolicyAccepted: true,
          items: [{ ticketTypeId: GA_ID, qty: 2 }],
          promoCodes: ["save"],
        }),
      ).rejects.toMatchObject({
        code: expect.stringMatching(/^expected_paid_order$/i),
      });
      expect(h.createPendingInput).toBeNull();
    } finally {
      localTaxRules.rules = [];
    }
  });
});
