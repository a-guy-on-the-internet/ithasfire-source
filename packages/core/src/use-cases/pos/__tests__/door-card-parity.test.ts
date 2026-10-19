import { describe, expect, it, vi } from "vitest";

import type { IdempotencyPort } from "@th/ports/idempotency";
import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { PromoRecord } from "@th/ports/repos/promos";
import { TaxRateLookupError } from "@th/ports/tax-rate-lookup";
import { SCANNER_TERMS_VERSION } from "@th/types";
import { createTestLogger } from "@th/test-utils/fakes/logger";

import { computeExpectedPaymentAmount } from "../../../lib/orders/compute-expected-payment-amount";
import type { LocalTaxImpositionRule } from "../../../lib/pricing/tax-impositions";
import { createCheckout } from "../../orders/create-checkout";
import { finalizePaymentIntent } from "../../orders/finalize-from-payment-intent";
import { prepareCheckoutTax } from "../../orders/_shared/resolve-checkout-tax-rate";
import { startPosSale } from "../start-pos-sale";

/**
 * NFR-001 PARITY (docs/specs/2026-10-07/door-sales-same-price-and-tax.spec.yaml):
 * the same cart bought online (`createCheckout`) and by card at the door
 * (`startPosSale`) produces identical face, platform fee, tax lines,
 * processor fee, charge total and per-item buyer totals — owner ruling R2,
 * "card at the door = online".
 *
 * Both use cases run against ONE self-contained harness per scenario (no
 * shared fixture module). Each scenario's online numbers are ALSO pinned as
 * literals, so a change that moved both paths together still fails here.
 *
 * Local tax impositions come from a test seam (same technique as
 * `orders/__tests__/price-cart.characterization.test.ts`), so the numbers do
 * not depend on what the shipped imposition table holds. The "Minneapolis"
 * case injects its own city line.
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
const OPERATOR_ID = "22222222-2222-4222-8222-222222222223";
const PHANTOM_ID = "22222222-2222-4222-8222-222222222224";
const GA_ID = "33333333-3333-4333-8333-333333333333";
const VIP_ID = "33333333-3333-4333-8333-333333333334";
const FREE_ID = "33333333-3333-4333-8333-333333333335";
const TERMS_ID = "44444444-4444-4444-8444-444444444444";
const POLICY_ID = "55555555-5555-4555-8555-555555555555";
const ORDER_ID = "66666666-6666-4666-8666-666666666666";
const PAYEE_ID = "77777777-7777-4777-8777-777777777777";
const NOW = new Date("2026-03-01T12:00:00.000Z");

type Situs = { countryCode: string; region: string; postalCode: string };

/** Downtown Nashville. TN taxes the buyer total. */
const NASHVILLE: Situs = { countryCode: "US", region: "TN", postalCode: "37203" };
/** Downtown Minneapolis: state sales tax + the city's entertainment line. */
const MINNEAPOLIS: Situs = { countryCode: "US", region: "MN", postalCode: "55403" };
/** St Paul: MN, but outside the Minneapolis city line. */
const ST_PAUL: Situs = { countryCode: "US", region: "MN", postalCode: "55101" };
/** Portland: no sales tax. */
const PORTLAND: Situs = { countryCode: "US", region: "OR", postalCode: "97201" };

/** Stand-in for the Minneapolis entertainment tax (3% of face, platform-collected). */
const MPLS_LINE = {
  code: "TEST_MPLS_ENTERTAINMENT",
  label: "Test Minneapolis entertainment tax",
  jurisdiction: "US/MN/Minneapolis",
  countryCode: "US",
  region: "MN",
  postalCodes: ["55403"],
  rateBps: 300,
  base: "TICKET_FACE",
  collector: "PLATFORM",
  appliesToResale: false,
  source: "door-card parity fixture",
} as LocalTaxImpositionRule;

type Scenario = {
  situs?: Situs | null;
  /** Publish-time stamp. `null` = unstamped (the prepare/lookup path). */
  admissionTaxRateBps: number | null;
  promo?: Partial<PromoRecord>;
  startsAt?: Date;
  endsAt?: Date | null;
  taxRateLookup?: {
    lookupByPostalCode: ReturnType<typeof vi.fn>;
  };
  /** Tickets of ORGANIZER-side fee-waiver allowance the reservation grants. */
  waiverTickets?: number;
  /** Event status; the door's transaction applies no status gate. */
  status?: "PUBLISHED" | "DRAFT";
};

const TICKET_TYPES = [
  { id: GA_ID, priceCents: 2500 },
  { id: VIP_ID, priceCents: 4000 },
  // In no scenario's cart but the "$0 ticket" ones below.
  { id: FREE_ID, priceCents: 0 },
];

function makeWorld(scenario: Scenario) {
  const situs = scenario.situs ?? null;
  const callLog: string[] = [];

  const event = {
    id: EVENT_ID,
    orgId: "org-1",
    humanId: null,
    title: "Parity Night",
    status: scenario.status ?? ("PUBLISHED" as const),
    visibility: "PUBLIC" as const,
    gateType: "NONE" as const,
    attendanceMode: "TICKETED" as const,
    waiverTemplateId: null,
    startsAt: scenario.startsAt ?? new Date("2026-04-01T20:00:00.000Z"),
    endsAt:
      scenario.endsAt === undefined
        ? new Date("2026-04-01T23:00:00.000Z")
        : scenario.endsAt,
    placeId: null,
    savedLocationId: null,
    postalCode: situs?.postalCode ?? null,
    countryCode: situs?.countryCode ?? null,
    region: situs?.region ?? null,
    admissionTaxRateBps: scenario.admissionTaxRateBps,
    taxRateSource: scenario.admissionTaxRateBps == null ? null : "ziptax",
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
    feeMode: "PASS_THROUGH",
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
    buyerFeePct: 0.05,
    maxFeeCents: null,
    minFeeCents: 0,
    maxPlatformFeeCents: null,
    platformFixedCents: 50,
    feeMode: "PASS_THROUGH",
    processsorFeePct: 0.029,
    processorFixedCents: 30,
    payoutPct: 0,
    payoutFixedCents: 0,
    monthlyPayoutCents: 0,
    effectiveFrom: NOW,
    effectiveTo: null,
  };

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

  let createPendingInput: Record<string, any> | null = null;
  let createTaxLinesInput: Record<string, any> | null = null;
  let paymentIntentInput: Record<string, any> | null = null;
  const orderState: Record<string, any> = {
    id: ORDER_ID,
    status: "PENDING",
    stripePaymentIntentId: null,
  };
  let splitRows: Array<Record<string, unknown>> = [];

  const tx = {
    events: {
      lockRows: vi.fn(async () => undefined),
      getById: vi.fn(async (id: string) => (id === EVENT_ID ? event : null)),
      listTicketTypes: vi.fn(async () =>
        TICKET_TYPES.map((tt) => ({
          id: tt.id,
          name: tt.id,
          priceCents: tt.priceCents,
          status: "ACTIVE" as const,
          capacity: 1000,
          pricingMode: "FIXED" as const,
          minimumCents: null,
          suggestedCents: null,
          seatSectionId: null,
          scheduledPriceCents: null,
          scheduledPriceAt: null,
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
          payeeId: PAYEE_ID,
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
      findActiveByCodes: vi.fn(async () => (promo ? [promo] : [])),
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
      // An ORGANIZER-side allowance: it applies to every buyer at the org's
      // events, so online and the door's phantom buyer both find it.
      resolveApplicable: vi.fn(async () =>
        (scenario.waiverTickets ?? 0) > 0
          ? [{ id: "waiver-org", ticketsGranted: 10, ticketsUsed: 0 }]
          : [],
      ),
      reserve: vi.fn(async (input: { waivableTicketFeesCents: number[] }) => {
        const n = Math.min(
          scenario.waiverTickets ?? 0,
          input.waivableTicketFeesCents.length,
        );
        return {
          reservedTickets: n,
          feeWaivedCents: input.waivableTicketFeesCents
            .slice(0, n)
            .reduce((sum, c) => sum + c, 0),
          redemptionId: n > 0 ? "redemption-1" : null,
        };
      }),
      release: vi.fn(async () => ({ releasedTickets: 0 })),
    },
    credits: {
      listActiveForHuman: vi.fn(async () => []),
      redeemConditional: vi.fn(),
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
    authz: {
      getOrgMembership: vi.fn(async () => ({
        orgId: "org-1",
        humanId: OPERATOR_ID,
        role: "SCANNER" as const,
      })),
    },
    humans: {
      getById: vi.fn(async (id: string) =>
        id === OPERATOR_ID
          ? {
              id,
              scannerTermsAckAt: new Date("2026-01-01T00:00:00.000Z"),
              scannerTermsAckVersion: SCANNER_TERMS_VERSION,
            }
          : null,
      ),
      create: vi.fn(async () => ({ id: PHANTOM_ID })),
    },
    tickets: {
      lockAndCountCapacityForTicketType: vi.fn(async () => ({
        issued: 0,
        held: 0,
      })),
      countIssuedForTicketType: vi.fn(async () => 0),
      findBySeatIds: vi.fn(async () => []),
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
        callLog.push("createPending");
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
      linkPaymentIntent: vi.fn(async (_id: string, pi: string) => {
        orderState.stripePaymentIntentId = pi;
      }),
      cancelPendingOrder: vi.fn(async () => true),
    },
    acceptances: {
      findCurrent: vi.fn(async () => null),
      create: vi.fn(async (record: Record<string, unknown>) => ({
        id: "acceptance-1",
        ...record,
      })),
    },
    payees: {
      getBySubject: vi.fn(async () => ({ id: PAYEE_ID })),
      getById: vi.fn(async () => ({
        id: PAYEE_ID,
        subjectType: "ORGANIZATION",
        subjectId: "org-1",
        status: "ACTIVE",
        payoutsEnabled: true,
        chargesEnabled: true,
        stripeAccountId: "acct_connected",
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
    audit: { log: vi.fn(async () => undefined) },
  };

  const repos = {
    ...tx,
    tx: async <T>(fn: (t: TxRepos) => Promise<T>) => {
      callLog.push("tx");
      return fn(tx as unknown as TxRepos);
    },
  } as unknown as Repos;

  const store = new Map<string, unknown>();
  const holds = new Set<string>();
  const idempotency = {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    begin: vi.fn(async (k: string) => {
      if (holds.has(k)) return false;
      holds.add(k);
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
      paymentIntentInput = input;
      return { id: "pi_online", clientSecret: "secret_online" };
    }),
    createCardPresentPaymentIntent: vi.fn(async (input: Record<string, any>) => {
      paymentIntentInput = input;
      return { paymentIntentId: "pi_door_card", clientSecret: "secret_door" };
    }),
    cancelPaymentIntent: vi.fn(async () => ({ canceled: true })),
    retrievePaymentIntent: vi.fn(),
  } as unknown as PaymentProcessorPort;

  const logger = createTestLogger();
  vi.mocked(logger.child).mockReturnValue(logger);
  const reportError = vi.fn();
  const taxRateLookup = scenario.taxRateLookup ?? null;
  if (taxRateLookup) {
    const inner = taxRateLookup.lookupByPostalCode.getMockImplementation();
    taxRateLookup.lookupByPostalCode.mockImplementation(async (...args) => {
      callLog.push("taxLookup");
      return inner?.(...args);
    });
  }

  return {
    repos,
    tx,
    idempotency,
    payments,
    logger,
    reportError,
    taxRateLookup,
    callLog,
    clock: { now: () => NOW },
    get order() {
      return createPendingInput;
    },
    get taxLines() {
      return (createTaxLinesInput?.lines ?? []) as Array<Record<string, any>>;
    },
    get paymentIntent() {
      return paymentIntentInput;
    },
  };
}

type World = ReturnType<typeof makeWorld>;

const CART = [
  { ticketTypeId: GA_ID, qty: 2 },
  { ticketTypeId: VIP_ID, qty: 1 },
];

type CartLine = { ticketTypeId: string; qty: number };

async function buyOnline(scenario: Scenario, items: CartLine[] = CART) {
  const w = makeWorld(scenario);
  await createCheckout(
    {
      repos: w.repos,
      payments: w.payments,
      idempotency: w.idempotency,
      clock: w.clock,
      logger: w.logger,
      reportError: w.reportError,
      taxRateLookup: w.taxRateLookup as never,
      devInstantPayouts: true,
    },
    {
      actorHumanId: BUYER_ID,
      buyerHumanId: BUYER_ID,
      eventId: EVENT_ID,
      clientKey: "parity-online-key",
      termsAccepted: true,
      refundPolicyAccepted: true,
      items,
      ...(scenario.promo ? { promoCodes: ["save"] } : {}),
    },
  );
  return w;
}

async function buyAtTheDoor(scenario: Scenario, items: CartLine[] = CART) {
  const w = makeWorld(scenario);
  await startPosSale(
    {
      repos: w.repos,
      authz: { hasStaffRole: vi.fn(async () => ({ allowed: false })) } as never,
      payments: w.payments,
      idempotency: w.idempotency,
      clock: w.clock,
      logger: w.logger,
      reportError: w.reportError,
      taxRateLookup: w.taxRateLookup as never,
    },
    {
      actorHumanId: OPERATOR_ID,
      eventId: EVENT_ID,
      clientKey: "parity-door-key",
      items,
      ...(scenario.promo ? { promoCodes: ["save"] } : {}),
    },
  );
  return w;
}

/** Everything FR-002 says must match, from what each path actually wrote. */
function moneyOf(w: World) {
  const order = w.order!;
  const items = order.items as Array<{
    kind: string;
    amountCents: number;
    meta: Record<string, unknown>;
  }>;
  const charge = w.paymentIntent!.amountCents as number;
  return {
    amountGrossCents: order.amountGrossCents,
    feesPlatformCents: order.feesPlatformCents,
    taxAmountCents: order.taxAmountCents,
    // What remains of the charge once face, platform fee and tax are paid.
    processorFeeCents:
      charge - order.amountGrossCents - order.feesPlatformCents - order.taxAmountCents,
    chargeTotalCents: charge,
    itemBuyerTotalCents: items
      .filter((i) => i.kind === "ticket")
      .map((i) => i.meta.buyerTotalCents),
    discountItemCents: items
      .filter((i) => i.kind === "discount")
      .map((i) => i.amountCents),
    taxLines: w.taxLines.map((l) => [l.code, l.taxableAmountCents, l.amountCents, l.collector]),
    taxSitus: [order.taxSitusCountry, order.taxSitusState, order.taxSitusPostal],
    taxRateSource: order.taxRateSource,
    feePolicySnapshot: order.feePolicySnapshot,
    nonRefundable: order.nonRefundable,
    // The finalize AMOUNT_MISMATCH sum.
    finalizeExpectedCents: computeExpectedPaymentAmount(order as never),
  };
}

// Recorded online values (cart: 2 × $25 GA + 1 × $40 VIP; 5% + 50¢ platform
// fee, 2.9% + 30¢ processing, passed through).
type Pinned = {
  amountGrossCents: number;
  feesPlatformCents: number;
  taxAmountCents: number;
  processorFeeCents: number;
  chargeTotalCents: number;
  itemBuyerTotalCents: number[];
  taxLines: Array<[string, number, number]>;
};

const PINNED: Record<
  "TN" | "MPLS" | "ST_PAUL" | "OR" | "TN_WAIVER" | "TN_PROMO",
  Pinned
> = {
  // 9947 × 9.75% = 969.8 → 970; ceil(0.029 × 10917 + 30) = 347.
  TN: {
    amountGrossCents: 9000,
    feesPlatformCents: 600,
    taxAmountCents: 970,
    processorFeeCents: 347,
    chargeTotalCents: 10917,
    itemBuyerTotalCents: [2771, 2771, 4405],
    taxLines: [["SALES", 9947, 970]],
  },
  // State line on the buyer total + the city line on face (9000 × 3% = 270).
  MPLS: {
    amountGrossCents: 9000,
    feesPlatformCents: 600,
    taxAmountCents: 1169,
    processorFeeCents: 353,
    chargeTotalCents: 11122,
    itemBuyerTotalCents: [2773, 2773, 4407],
    taxLines: [
      ["SALES", 9953, 899],
      ["TEST_MPLS_ENTERTAINMENT", 9000, 270],
    ],
  },
  ST_PAUL: {
    amountGrossCents: 9000,
    feesPlatformCents: 600,
    taxAmountCents: 883,
    processorFeeCents: 344,
    chargeTotalCents: 10827,
    itemBuyerTotalCents: [2770, 2770, 4404],
    taxLines: [["SALES", 9944, 883]],
  },
  OR: {
    amountGrossCents: 9000,
    feesPlatformCents: 600,
    taxAmountCents: 0,
    processorFeeCents: 318,
    chargeTotalCents: 9918,
    itemBuyerTotalCents: [2763, 2763, 4392],
    taxLines: [],
  },
  // The VIP's $2.50 fee is waived (most expensive first): 600 → 350.
  // 9689 × 9.75% = 944.7 → 945; ceil(0.029 × 10634 + 30) = 339.
  TN_WAIVER: {
    amountGrossCents: 9000,
    feesPlatformCents: 350,
    taxAmountCents: 945,
    processorFeeCents: 339,
    chargeTotalCents: 10634,
    itemBuyerTotalCents: [2771, 2771, 4147],
    taxLines: [["SALES", 9689, 945]],
  },
  TN_PROMO: {
    amountGrossCents: 8500,
    feesPlatformCents: 600,
    taxAmountCents: 920,
    processorFeeCents: 331,
    chargeTotalCents: 10351,
    itemBuyerTotalCents: [2767, 2767, 4397],
    taxLines: [["SALES", 9431, 920]],
  },
};

const MATRIX: Array<{
  name: string;
  scenario: Scenario;
  rules?: LocalTaxImpositionRule[];
  /** Online numbers, recorded from createCheckout; the door must equal them. */
  expected: Pick<
    ReturnType<typeof moneyOf>,
    | "amountGrossCents"
    | "feesPlatformCents"
    | "taxAmountCents"
    | "processorFeeCents"
    | "chargeTotalCents"
    | "itemBuyerTotalCents"
  > & { taxLines: Array<[string, number, number]> };
}> = [
  {
    name: "TN, Nashville (buyer-total base)",
    scenario: { situs: NASHVILLE, admissionTaxRateBps: 975 },
    expected: PINNED.TN,
  },
  {
    name: "MN, Minneapolis (state line + city entertainment line)",
    scenario: { situs: MINNEAPOLIS, admissionTaxRateBps: 903 },
    rules: [MPLS_LINE],
    expected: PINNED.MPLS,
  },
  {
    name: "MN, St Paul (no city line)",
    scenario: { situs: ST_PAUL, admissionTaxRateBps: 888 },
    rules: [MPLS_LINE],
    expected: PINNED.ST_PAUL,
  },
  {
    name: "OR, Portland (no sales tax)",
    scenario: { situs: PORTLAND, admissionTaxRateBps: 0 },
    expected: PINNED.OR,
  },
  {
    name: "TN with an organiser fee waiver on one ticket",
    scenario: { situs: NASHVILLE, admissionTaxRateBps: 975, waiverTickets: 1 },
    expected: PINNED.TN_WAIVER,
  },
  {
    name: "TN with a $5 promo",
    scenario: { situs: NASHVILLE, admissionTaxRateBps: 975, promo: { value: 500 } },
    expected: PINNED.TN_PROMO,
  },
];


describe("NFR-001: a door card sale charges exactly what online checkout charges", () => {
  for (const row of MATRIX) {
    it(row.name, async () => {
      localTaxRules.rules = row.rules ?? [];
      try {
        const online = await buyOnline(row.scenario);
        const door = await buyAtTheDoor(row.scenario);

        const onlineMoney = moneyOf(online);
        const doorMoney = moneyOf(door);

        // The whole point: field for field, the same sale.
        expect(doorMoney).toEqual(onlineMoney);

        // And what that sale is, so both moving together still fails.
        expect({
          amountGrossCents: onlineMoney.amountGrossCents,
          feesPlatformCents: onlineMoney.feesPlatformCents,
          taxAmountCents: onlineMoney.taxAmountCents,
          processorFeeCents: onlineMoney.processorFeeCents,
          chargeTotalCents: onlineMoney.chargeTotalCents,
          itemBuyerTotalCents: onlineMoney.itemBuyerTotalCents,
          taxLines: onlineMoney.taxLines.map(([code, base, amount]) => [
            code,
            base,
            amount,
          ]),
        }).toEqual(row.expected);

        // Finalize contract on the DOOR order: Σ buyer totals + discounts +
        // tax === the PaymentIntent amount.
        expect(doorMoney.finalizeExpectedCents).toBe(doorMoney.chargeTotalCents);
        // Σ PLATFORM tax lines === the order's tax.
        const platformTax = door.taxLines
          .filter((l) => l.collector === "PLATFORM")
          .reduce((s, l) => s + (l.amountCents as number), 0);
        expect(platformTax).toBe(doorMoney.taxAmountCents);
        // The tax rides the door PaymentIntent the way it rides checkout's.
        if (doorMoney.taxAmountCents > 0) {
          expect(door.paymentIntent!.metadata.taxAmountCents).toBe(
            `${doorMoney.taxAmountCents}`,
          );
        }
        expect(door.reportError).not.toHaveBeenCalled();
        expect(online.reportError).not.toHaveBeenCalled();
      } finally {
        localTaxRules.rules = [];
      }
    });
  }
});

// Owner ruling, 2026-10-10: "If $0 is the cost of the tickets there shouldn't
// be any fee." The policy here is 5% + 50¢ per ticket, so each free ticket in
// this paid cart used to be charged the 50¢ (plus processing and, in
// Tennessee, tax on it) by BOTH paths. Now the sale is the paid cart's sale,
// to the cent: the same pinned numbers as the matrix above.
describe("a $0 ticket in a paid cart adds nothing, online or by card at the door", () => {
  const FREE_LINE: CartLine = { ticketTypeId: FREE_ID, qty: 2 };

  for (const row of [
    { name: "TN (buyer-total base)", scenario: { situs: NASHVILLE, admissionTaxRateBps: 975 }, expected: PINNED.TN },
    { name: "OR (no sales tax)", scenario: { situs: PORTLAND, admissionTaxRateBps: 0 }, expected: PINNED.OR },
  ] as Array<{ name: string; scenario: Scenario; expected: Pinned }>) {
    for (const position of ["last", "first"] as const) {
      it(`${row.name}, free tickets ${position} in the cart`, async () => {
        const cart = position === "last" ? [...CART, FREE_LINE] : [FREE_LINE, ...CART];
        const online = await buyOnline(row.scenario, cart);
        const door = await buyAtTheDoor(row.scenario, cart);

        const onlineMoney = moneyOf(online);
        const doorMoney = moneyOf(door);
        expect(doorMoney).toEqual(onlineMoney);

        // The order is the paid cart's order: every figure the matrix pins
        // for the cart WITHOUT the free tickets.
        expect({
          amountGrossCents: onlineMoney.amountGrossCents,
          feesPlatformCents: onlineMoney.feesPlatformCents,
          taxAmountCents: onlineMoney.taxAmountCents,
          processorFeeCents: onlineMoney.processorFeeCents,
          chargeTotalCents: onlineMoney.chargeTotalCents,
          taxLines: onlineMoney.taxLines.map(([code, base, amount]) => [code, base, amount]),
        }).toEqual({
          amountGrossCents: row.expected.amountGrossCents,
          feesPlatformCents: row.expected.feesPlatformCents,
          taxAmountCents: row.expected.taxAmountCents,
          processorFeeCents: row.expected.processorFeeCents,
          chargeTotalCents: row.expected.chargeTotalCents,
          taxLines: row.expected.taxLines,
        });
        // Each paid ticket's stored buyer total is what it is without the
        // free tickets; each free ticket's is 0.
        expect(onlineMoney.itemBuyerTotalCents).toEqual(
          position === "last"
            ? [...row.expected.itemBuyerTotalCents, 0, 0]
            : [0, 0, ...row.expected.itemBuyerTotalCents],
        );

        // What each path WROTE on the free tickets' order items: no platform
        // fee, no processing-fee share, nothing for a refund to give back.
        for (const w of [online, door]) {
          const freeItems = (w.order!.items as Array<Record<string, any>>).filter(
            (item) => item.kind === "ticket" && item.ticketTypeId === FREE_ID,
          );
          expect(freeItems).toHaveLength(2);
          for (const item of freeItems) {
            expect(item.unitPriceCents).toBe(0);
            expect(item.amountCents).toBe(0);
            expect(item.meta.platformFeePerTicketCents).toBe(0);
            expect(item.meta.buyerTotalCents).toBe(0);
            expect(item.meta.buyerUnitTotalCents).toBe(0);
            expect(item.meta.processorFeeShareCents).toBe(0);
          }
        }

        expect(doorMoney.finalizeExpectedCents).toBe(doorMoney.chargeTotalCents);
        expect(onlineMoney.finalizeExpectedCents).toBe(onlineMoney.chargeTotalCents);
        expect(door.reportError).not.toHaveBeenCalled();
        expect(online.reportError).not.toHaveBeenCalled();
      });
    }
  }
});

// Owner ruling, 2026-10-10: "yes a promo brought down to $0 should have no fee
// too." A code for 100% off the VIP ticket type makes the $40 VIP ticket in
// this cart free. Both paths used to charge its 5% + 50¢ (250¢) anyway, plus
// processing and, in Tennessee, tax on it. Now the sale costs what the two
// GA tickets cost with no VIP ticket in the cart.
describe("a ticket a promo brings down to $0 pays no fee, online or by card at the door", () => {
  const VIP_FREE: Partial<PromoRecord> = {
    kind: "PERCENT",
    value: 100,
    scope: "TICKET_TYPE",
    scopeId: VIP_ID,
  };
  const GA_ONLY: CartLine[] = [{ ticketTypeId: GA_ID, qty: 2 }];

  const feesAndTotal = (money: ReturnType<typeof moneyOf>) => ({
    amountGrossCents: money.amountGrossCents,
    feesPlatformCents: money.feesPlatformCents,
    taxAmountCents: money.taxAmountCents,
    processorFeeCents: money.processorFeeCents,
    chargeTotalCents: money.chargeTotalCents,
    taxLines: money.taxLines,
  });

  for (const row of [
    {
      name: "TN (buyer-total base)",
      scenario: { situs: NASHVILLE, admissionTaxRateBps: 975 },
      // Two $25 tickets, 175¢ platform fee each.
      // (5350 + 30) × 1.0975 / (1 − 0.029 × 1.0975) = 6098.66, rounded up.
      pinned: { feesPlatformCents: 350, chargeTotalCents: 6099 },
    },
    {
      name: "OR (no sales tax)",
      scenario: { situs: PORTLAND, admissionTaxRateBps: 0 },
      pinned: { feesPlatformCents: 350, chargeTotalCents: 5541 },
    },
  ] as Array<{
    name: string;
    scenario: Scenario;
    pinned: { feesPlatformCents: number; chargeTotalCents: number };
  }>) {
    for (const position of ["last", "first"] as const) {
      it(`${row.name}, the free VIP ticket ${position} in the cart`, async () => {
        const cart: CartLine[] =
          position === "last"
            ? [...GA_ONLY, { ticketTypeId: VIP_ID, qty: 1 }]
            : [{ ticketTypeId: VIP_ID, qty: 1 }, ...GA_ONLY];
        const promoScenario = { ...row.scenario, promo: VIP_FREE };

        const online = await buyOnline(promoScenario, cart);
        const door = await buyAtTheDoor(promoScenario, cart);
        const alone = await buyOnline(row.scenario, GA_ONLY);

        const onlineMoney = moneyOf(online);
        const doorMoney = moneyOf(door);
        const aloneMoney = moneyOf(alone);
        expect(doorMoney).toEqual(onlineMoney);

        // The sale is the two GA tickets' sale: every fee, the tax and the
        // total.
        expect(feesAndTotal(onlineMoney)).toEqual(feesAndTotal(aloneMoney));
        expect({
          feesPlatformCents: onlineMoney.feesPlatformCents,
          chargeTotalCents: onlineMoney.chargeTotalCents,
        }).toEqual(row.pinned);
        expect(onlineMoney.discountItemCents).toEqual([-4000]);

        for (const w of [online, door]) {
          const items = w.order!.items as Array<Record<string, any>>;
          // Each GA ticket's stored figures are what they are without the
          // VIP ticket in the cart.
          const stored = (list: Array<Record<string, any>>) =>
            list
              .filter((item) => item.kind === "ticket" && item.ticketTypeId === GA_ID)
              .map((item) => ({
                platformFeePerTicketCents: item.meta.platformFeePerTicketCents,
                buyerTotalCents: item.meta.buyerTotalCents,
                buyerUnitTotalCents: item.meta.buyerUnitTotalCents,
                processorFeeShareCents: item.meta.processorFeeShareCents,
              }));
          expect(stored(items)).toEqual(
            stored(alone.order!.items as Array<Record<string, any>>),
          );

          // The VIP ticket keeps its list price (the discount line cancels
          // it) and carries no platform fee and no processing-fee share.
          const vip = items.filter(
            (item) => item.kind === "ticket" && item.ticketTypeId === VIP_ID,
          );
          expect(vip).toHaveLength(1);
          expect(vip[0]!.amountCents).toBe(4000);
          expect(vip[0]!.meta.platformFeePerTicketCents).toBe(0);
          expect(vip[0]!.meta.buyerTotalCents).toBe(4000);
          expect(vip[0]!.meta.buyerUnitTotalCents).toBe(4000);
          expect(vip[0]!.meta.processorFeeShareCents).toBe(0);
          expect(vip[0]!.meta.discountedToZero).toBe(true);
        }

        expect(doorMoney.finalizeExpectedCents).toBe(doorMoney.chargeTotalCents);
        expect(onlineMoney.finalizeExpectedCents).toBe(onlineMoney.chargeTotalCents);
        expect(door.reportError).not.toHaveBeenCalled();
        expect(online.reportError).not.toHaveBeenCalled();
      });
    }
  }

  it("the fee waiver is reserved against the tickets that still carry a fee, on both paths", async () => {
    const scenario: Scenario = {
      situs: NASHVILLE,
      admissionTaxRateBps: 975,
      promo: VIP_FREE,
      waiverTickets: 1,
    };
    const cart: CartLine[] = [...GA_ONLY, { ticketTypeId: VIP_ID, qty: 1 }];
    const online = await buyOnline(scenario, cart);
    const door = await buyAtTheDoor(scenario, cart);

    for (const w of [online, door]) {
      // The ladder is the two GA fees. Before the ruling it led with the VIP
      // ticket's 250¢, and the one-ticket allowance was spent there.
      expect(w.tx.feeWaivers.reserve).toHaveBeenCalledTimes(1);
      expect(
        w.tx.feeWaivers.reserve.mock.calls[0]![0].waivableTicketFeesCents,
      ).toEqual([175, 175]);
      // One GA fee waived, the other charged, none on the VIP ticket.
      expect(w.order!.feesPlatformCents).toBe(175);
      const fees = (w.order!.items as Array<Record<string, any>>)
        .filter((item) => item.kind === "ticket")
        .map((item) => item.meta.platformFeePerTicketCents);
      expect(fees).toEqual([0, 175, 0]);
    }
    expect(moneyOf(door)).toEqual(moneyOf(online));

    // And it is the price of the two GA tickets with one fee waived.
    const alone = await buyOnline(
      { situs: NASHVILLE, admissionTaxRateBps: 975, waiverTickets: 1 },
      GA_ONLY,
    );
    expect(moneyOf(online).chargeTotalCents).toBe(moneyOf(alone).chargeTotalCents);
    expect(moneyOf(online).taxAmountCents).toBe(moneyOf(alone).taxAmountCents);
  });

  it("a 50% code on the VIP type leaves every fee as it was", async () => {
    const scenario: Scenario = {
      situs: NASHVILLE,
      admissionTaxRateBps: 975,
      promo: { ...VIP_FREE, value: 50 },
    };
    const online = await buyOnline(scenario);
    const door = await buyAtTheDoor(scenario);
    expect(moneyOf(door)).toEqual(moneyOf(online));
    // 175 + 175 + 250: the undiscounted cart's platform fee (PINNED.TN).
    expect(moneyOf(online).feesPlatformCents).toBe(PINNED.TN.feesPlatformCents);
    for (const w of [online, door]) {
      for (const item of w.order!.items as Array<Record<string, any>>) {
        expect(item.meta?.discountedToZero).toBeUndefined();
      }
    }
  });
});

describe("finalize: a door card order passes the AMOUNT_MISMATCH guard", () => {
  /**
   * Drives the real `finalizePaymentIntent` on the order `startPosSale`
   * wrote. The step right AFTER the guard (loading the settlement payout
   * terms) throws a sentinel, so reaching the sentinel proves the guard
   * passed without standing up the whole mint/settle harness.
   */
  async function finalizeDoorOrder(centsOff: number) {
    localTaxRules.rules = [MPLS_LINE];
    try {
      const door = await buyAtTheDoor({
        situs: MINNEAPOLIS,
        admissionTaxRateBps: 903,
        promo: { value: 500 },
      });
      const order = {
        ...door.order!,
        id: ORDER_ID,
        kind: "TICKETING",
        status: "PENDING",
        stripePaymentIntentId: "pi_door_card",
        items: (door.order!.items as any[]).map((item, i) => ({
          id: `item-${i}`,
          ...item,
        })),
      };
      const txF = {
        orders: { getById: vi.fn(async () => order) },
        events: { getById: vi.fn(async () => ({ id: EVENT_ID, orgId: "org-1" })) },
        payoutTerms: {
          listByEvent: vi.fn(async () => {
            throw new Error("SENTINEL_PAST_AMOUNT_GUARD");
          }),
        },
      };
      const repos = {
        tx: async <T>(fn: (t: unknown) => Promise<T>) => fn(txF),
      } as unknown as Repos;
      const store = new Map<string, unknown>();
      const idempotency = {
        get: vi.fn(async (k: string) => store.get(k) ?? null),
        begin: vi.fn(async () => true),
        commit: vi.fn(async () => undefined),
        fail: vi.fn(async () => undefined),
        release: vi.fn(async () => true),
      } as unknown as IdempotencyPort;

      const run = finalizePaymentIntent(
        { repos, idempotency, clock: { now: () => NOW } },
        {
          stripeEvent: {
            id: "evt_door_parity",
            type: "payment_intent.succeeded",
            data: {
              object: {
                id: "pi_door_card",
                status: "succeeded",
                amount_received:
                  (door.paymentIntent!.amountCents as number) + centsOff,
                currency: "usd",
                metadata: {
                  orderId: ORDER_ID,
                  eventId: EVENT_ID,
                  actorHumanId: OPERATOR_ID,
                },
              },
            },
          },
        },
      );
      return { run, reachedPastGuard: txF.payoutTerms.listByEvent };
    } finally {
      localTaxRules.rules = [];
    }
  }

  it("the PaymentIntent amount passes (fees, tax, a promo and the processor fee included)", async () => {
    const { run, reachedPastGuard } = await finalizeDoorOrder(0);
    const err = await run.then(
      () => null,
      (e: unknown) => e,
    );
    // Stopped by the sentinel AFTER the guard (wrapped by asKnownError),
    // not by the guard itself.
    expect(err).not.toBeNull();
    expect(err).not.toMatchObject({ code: "AMOUNT_MISMATCH" });
    expect(reachedPastGuard).toHaveBeenCalledTimes(1);
  });

  it("one cent off is refused with AMOUNT_MISMATCH (the guard is live)", async () => {
    const { run, reachedPastGuard } = await finalizeDoorOrder(-1);
    await expect(run).rejects.toMatchObject({ code: "AMOUNT_MISMATCH" });
    expect(reachedPastGuard).not.toHaveBeenCalled();
  });
});

describe("door tax lookup (FR-006, NFR-002, owner ruling R5)", () => {
  const rateLimited = () =>
    new TaxRateLookupError("Ziptax rCode 108 (RESPONSE_CODE_REQUEST_LIMIT_MET)", {
      providerCode: 108,
      httpStatus: 429,
    });

  it("a failed lookup refuses the sale with TAX_RATE_UNAVAILABLE — no transaction, no order, no charge", async () => {
    const lookupByPostalCode = vi.fn(async () => {
      throw rateLimited();
    });
    const w = makeWorld({
      situs: NASHVILLE,
      admissionTaxRateBps: null,
      taxRateLookup: { lookupByPostalCode },
    });

    await expect(
      startPosSale(
        {
          repos: w.repos,
          authz: { hasStaffRole: vi.fn(async () => ({ allowed: false })) } as never,
          payments: w.payments,
          idempotency: w.idempotency,
          clock: w.clock,
          logger: w.logger,
          reportError: w.reportError,
          taxRateLookup: w.taxRateLookup as never,
        },
        {
          actorHumanId: OPERATOR_ID,
          eventId: EVENT_ID,
          clientKey: "parity-door-refused",
          items: CART,
        },
      ),
    ).rejects.toMatchObject({ code: "TAX_RATE_UNAVAILABLE" });

    // Retried, as online (3 attempts), then refused.
    expect(lookupByPostalCode).toHaveBeenCalledTimes(3);
    expect(w.callLog).not.toContain("tx");
    expect(w.order).toBeNull();
    expect(w.payments.createCardPresentPaymentIntent).not.toHaveBeenCalled();
    // Reported once, as checkout's refusal is.
    expect(
      w.reportError.mock.calls.filter(
        ([, ctx]) =>
          (ctx as { tags?: { useCase?: string } }).tags?.useCase ===
          "checkoutTaxRateUnavailable",
      ),
    ).toHaveLength(1);
  });

  it("a door sale AFTER the start of an event with no endsAt still looks the rate up, before the transaction, and charges it", async () => {
    const lookupByPostalCode = vi.fn(async () => ({
      rateBps: 975,
      source: "ziptax",
    }));
    const w = makeWorld({
      situs: NASHVILLE,
      admissionTaxRateBps: null,
      // Started an hour ago, no end: `isEventPast` says ended.
      startsAt: new Date(NOW.getTime() - 60 * 60 * 1000),
      endsAt: null,
      taxRateLookup: { lookupByPostalCode },
    });

    await startPosSale(
      {
        repos: w.repos,
        authz: { hasStaffRole: vi.fn(async () => ({ allowed: false })) } as never,
        payments: w.payments,
        idempotency: w.idempotency,
        clock: w.clock,
        logger: w.logger,
        reportError: w.reportError,
        taxRateLookup: w.taxRateLookup as never,
      },
      {
        actorHumanId: OPERATOR_ID,
        eventId: EVENT_ID,
        clientKey: "parity-door-after-start",
        items: CART,
      },
    );

    expect(lookupByPostalCode).toHaveBeenCalledTimes(1);
    // NFR-002: the lookup ran BEFORE the transaction opened, not inside it.
    expect(w.callLog.indexOf("taxLookup")).toBeLessThan(w.callLog.indexOf("tx"));
    expect(w.callLog.filter((c) => c === "taxLookup")).toHaveLength(1);
    // Charged at the looked-up rate — the same as the stamped-975 TN sale.
    expect(w.order!.taxAmountCents).toBe(PINNED.TN.taxAmountCents);
    expect(w.paymentIntent!.amountCents).toBe(PINNED.TN.chargeTotalCents);
  });

  it("an UNPUBLISHED, unstamped event is refused at the door before any lookup or transaction", async () => {
    // Owner ruling 2026-10-07: the door sells PUBLISHED events only. This
    // test used to pin that a draft sold at the door was looked up before the
    // transaction; the draft is now refused before the paid lookup is spent
    // and before the transaction opens.
    const lookupByPostalCode = vi.fn(async () => ({
      rateBps: 975,
      source: "ziptax",
    }));
    const w = makeWorld({
      situs: NASHVILLE,
      admissionTaxRateBps: null,
      status: "DRAFT",
      taxRateLookup: { lookupByPostalCode },
    });

    await expect(
      startPosSale(
        {
          repos: w.repos,
          authz: { hasStaffRole: vi.fn(async () => ({ allowed: false })) } as never,
          payments: w.payments,
          idempotency: w.idempotency,
          clock: w.clock,
          logger: w.logger,
          reportError: w.reportError,
          taxRateLookup: w.taxRateLookup as never,
        },
        {
          actorHumanId: OPERATOR_ID,
          eventId: EVENT_ID,
          clientKey: "parity-door-draft",
          items: CART,
        },
      ),
    ).rejects.toMatchObject({ code: "EVENT_NOT_PUBLISHED" });

    expect(lookupByPostalCode).not.toHaveBeenCalled();
    expect(w.callLog).not.toContain("taxLookup");
    expect(w.callLog).not.toContain("tx");
    expect(w.order).toBeFalsy();
    expect(w.paymentIntent).toBeFalsy();
  });

  it("online checkout's prepare still skips an unpublished event (behaviour unchanged)", async () => {
    const lookupByPostalCode = vi.fn(async () => ({
      rateBps: 975,
      source: "ziptax",
    }));
    const repos = {
      events: {
        getById: vi.fn(async () => ({
          id: EVENT_ID,
          status: "DRAFT",
          attendanceMode: "TICKETED",
          startsAt: new Date("2026-04-01T20:00:00.000Z"),
          endsAt: new Date("2026-04-01T23:00:00.000Z"),
          admissionTaxRateBps: null,
          placeId: null,
          savedLocationId: null,
          postalCode: NASHVILLE.postalCode,
          countryCode: NASHVILLE.countryCode,
          region: NASHVILLE.region,
          updatedAt: NOW,
        })),
      },
    } as unknown as Repos;
    const deps = {
      repos,
      taxRateLookup: { lookupByPostalCode },
      clock: { now: () => NOW },
    };

    expect(await prepareCheckoutTax(deps, EVENT_ID, undefined)).toEqual({
      refKey: null,
      prepared: null,
    });
    expect(lookupByPostalCode).not.toHaveBeenCalled();
    const door = await prepareCheckoutTax(deps, EVENT_ID, undefined, {
      channel: "door",
    });
    expect(door.prepared?.stamp?.rateBps).toBe(975);
  });

  it("online checkout's prepare still skips a past event (behaviour unchanged); the door channel does not", async () => {
    const pastEvent = {
      id: EVENT_ID,
      status: "PUBLISHED",
      attendanceMode: "TICKETED",
      startsAt: new Date(NOW.getTime() - 60 * 60 * 1000),
      endsAt: null,
      admissionTaxRateBps: null,
      taxRateSource: null,
      instructionalAdmission: false,
      placeId: null,
      savedLocationId: null,
      postalCode: NASHVILLE.postalCode,
      countryCode: NASHVILLE.countryCode,
      region: NASHVILLE.region,
      updatedAt: new Date("2026-02-01T00:00:00.000Z"),
    };
    const repos = {
      events: { getById: vi.fn(async () => pastEvent) },
    } as unknown as Repos;
    const lookupByPostalCode = vi.fn(async () => ({
      rateBps: 975,
      source: "ziptax",
    }));
    const deps = {
      repos,
      taxRateLookup: { lookupByPostalCode },
      clock: { now: () => NOW },
    };

    const online = await prepareCheckoutTax(deps, EVENT_ID, undefined);
    expect(online).toEqual({ refKey: null, prepared: null });
    expect(lookupByPostalCode).not.toHaveBeenCalled();

    const defaulted = await prepareCheckoutTax(deps, EVENT_ID, undefined, {
      channel: "online",
    });
    expect(defaulted).toEqual({ refKey: null, prepared: null });
    expect(lookupByPostalCode).not.toHaveBeenCalled();

    const door = await prepareCheckoutTax(deps, EVENT_ID, undefined, {
      channel: "door",
    });
    expect(door.prepared?.stamp?.rateBps).toBe(975);
    expect(lookupByPostalCode).toHaveBeenCalledTimes(1);
  });
});
