import { describe, expect, it, vi } from "vitest";

import type { CreateCheckoutDeps } from "../create-checkout";
import { createCheckout } from "../create-checkout";
import { claimFreeTickets } from "../claim-free-tickets";
import { updateOrderItems } from "../update-order-items";
import { quoteItemRefund } from "../quote-item-refund";
import { resolvePurchasedUnitPriceCents } from "../_shared/resolve-purchased-unit-price";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";
import type { Repos, TxRepos } from "@th/ports/repos";
import { createTestLogger } from "@th/test-utils/fakes/logger";
import { computeExpectedPaymentAmount } from "../../../lib/orders/compute-expected-payment-amount";
import type { LocalTaxImpositionRule } from "../../../lib/pricing/tax-impositions";

/**
 * Seat price overrides are CHARGED, not just shown
 * (docs/specs/2026-08-12/seat-price-overrides.spec.yaml, A-001..A-008).
 *
 * Before the fix `computeOrderAmounts` priced every seat at its ticket type's
 * price, so a $30 tier with seat A1 overridden to $50 showed $50 and charged
 * $30, and the wrong number snapshotted into `OrderItem.unitPriceCents`.
 *
 * The harness drives the real `createCheckout` end to end (routing probe, the
 * two fee-waiver passes, the seat lock, the PaymentIntent) over in-memory
 * repos. It is modelled on `price-cart.characterization.test.ts` and adds a
 * seat store. The seat repo fake keeps the adapter's contract: the unlocked
 * `findPriceOverridesByIds` and the locked `findByIdsForUpdate` read the same
 * column, except where a test makes the locked read see an edit landing in
 * between, and `reserveForHold` never auto-assigns an overridden seat.
 *
 * Fee policy throughout: 5% + 50¢ platform fee per ticket, processor
 * 2.9% + 30¢. So a $30 ticket carries a 200¢ fee, $50 → 300¢, $10 → 100¢.
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
/** $30 general admission, unseated. */
const GA_ID = "33333333-3333-4333-8333-333333333333";
/** $30 reserved seating, section SECTION_ID. */
const RES_ID = "33333333-3333-4333-8333-333333333334";
/** $0 reserved seating, section SECTION_ID. */
const FREE_RES_ID = "33333333-3333-4333-8333-333333333335";
const TERMS_ID = "44444444-4444-4444-8444-444444444444";
const POLICY_ID = "55555555-5555-4555-8555-555555555555";
const ORDER_ID = "66666666-6666-4666-8666-666666666666";
const SECTION_ID = "77777777-7777-4777-8777-777777777777";
const SEAT_A1 = "88888888-8888-4888-8888-888888888801";
const SEAT_A2 = "88888888-8888-4888-8888-888888888802";
const SEAT_A3 = "88888888-8888-4888-8888-888888888803";
const NOW = new Date("2026-03-01T12:00:00.000Z");

type TicketTypeFixture = {
  id: string;
  priceCents: number;
  pricingMode?: "FIXED" | "ADJUSTABLE";
  minimumCents?: number | null;
  seatSectionId?: string | null;
  scheduledPriceCents?: number | null;
  scheduledPriceAt?: Date | null;
};

type SeatFixture = {
  id: string;
  label: string;
  /**
   * Override in cents, or null for none. `INVALID` is the repo's marker for
   * a stored value it could not read as `{ priceCents: number }`.
   */
  overrideCents: OverrideFixture;
  status?: "AVAILABLE" | "HELD" | "SOLD" | "BLOCKED";
};

type Scenario = {
  ticketTypes?: TicketTypeFixture[];
  seats?: SeatFixture[];
  /**
   * What the LOCKED read sees for a seat, when it differs from the unlocked
   * pre-read: an organiser's edit committing between the two (A-007).
   */
  overrideAtLock?: Map<string, OverrideFixture>;
  admissionTaxRateBps?: number;
  situs?: { countryCode: string; region: string; postalCode: string };
  waiverReservedTickets?: number;
};

const DEFAULT_TICKET_TYPES: TicketTypeFixture[] = [
  { id: GA_ID, priceCents: 3000 },
  { id: RES_ID, priceCents: 3000, seatSectionId: SECTION_ID },
  { id: FREE_RES_ID, priceCents: 0, seatSectionId: SECTION_ID },
];

const OR = { countryCode: "US", region: "OR", postalCode: "97201" };
const TN = { countryCode: "US", region: "TN", postalCode: "37203" };

const INVALID = { invalid: true } as const;
type OverrideFixture = number | null | typeof INVALID;

function overrideJson(cents: OverrideFixture) {
  if (cents === null) return null;
  if (typeof cents === "object") return cents;
  return { priceCents: cents, reason: "test" };
}

function makeHarness(scenario: Scenario) {
  const ticketTypes = scenario.ticketTypes ?? DEFAULT_TICKET_TYPES;

  const event = {
    id: EVENT_ID,
    orgId: "org-1",
    humanId: null,
    title: "Seat Override Night",
    status: "PUBLISHED" as const,
    visibility: "PUBLIC" as const,
    gateType: "NONE" as const,
    attendanceMode: "TICKETED" as const,
    waiverTemplateId: null,
    startsAt: new Date("2026-04-01T20:00:00.000Z"),
    endsAt: new Date("2026-04-01T23:00:00.000Z"),
    placeId: null,
    savedLocationId: null,
    postalCode: scenario.situs?.postalCode ?? OR.postalCode,
    countryCode: scenario.situs?.countryCode ?? OR.countryCode,
    region: scenario.situs?.region ?? OR.region,
    admissionTaxRateBps: scenario.admissionTaxRateBps ?? 0,
    taxRateSource: "ziptax",
    instructionalAdmission: false,
    timezone: "America/Chicago",
    updatedAt: new Date("2026-02-01T00:00:00.000Z"),
    publishedAt: NOW,
    agreementPrimaryId: TERMS_ID,
    currency: "usd",
    ownerBanned: false,
    resalePayoutReleaseDaysOverride: null,
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
    resaleProcessingFeeConfigRef: null,
    resalePayoutReleaseDays: 7,
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

  const seatStore = new Map(
    (scenario.seats ?? []).map((seat) => [
      seat.id,
      {
        id: seat.id,
        seatSectionId: SECTION_ID,
        eventId: EVENT_ID,
        label: seat.label,
        row: "A",
        number: Number(seat.label.slice(1)),
        status: seat.status ?? ("AVAILABLE" as string),
        priceOverride: overrideJson(seat.overrideCents),
      },
    ]),
  );

  let createPendingInput: Record<string, any> | null = null;
  let createTaxLinesInput: Record<string, any> | null = null;
  let createPaymentIntentInput: Record<string, any> | null = null;
  const orderState: Record<string, any> = {
    id: ORDER_ID,
    status: "PENDING",
    stripePaymentIntentId: null,
  };
  let splitRows: Array<Record<string, unknown>> = [];

  const seats = {
    releaseExpiredHolds: vi.fn(async () => 0),
    releaseSeats: vi.fn(async () => 0),
    findPriceOverridesByIds: vi.fn(
      async ({ seatIds, eventId }: { seatIds: string[]; eventId: string }) =>
        seatIds.flatMap((id) => {
          const seat = seatStore.get(id);
          return seat && seat.eventId === eventId
            ? [{ id, priceOverride: seat.priceOverride }]
            : [];
        }),
    ),
    findByIdsForUpdate: vi.fn(
      async ({ seatIds, eventId }: { seatIds: string[]; eventId: string }) =>
        seatIds.flatMap((id) => {
          const seat = seatStore.get(id);
          if (!seat || seat.eventId !== eventId) return [];
          const atLock = scenario.overrideAtLock;
          return [
            {
              ...seat,
              priceOverride:
                atLock && atLock.has(id)
                  ? overrideJson(atLock.get(id) ?? null)
                  : seat.priceOverride,
            },
          ];
        }),
    ),
    updateStatuses: vi.fn(
      async ({ seatIds, status }: { seatIds: string[]; status: string }) => {
        for (const id of seatIds) {
          const seat = seatStore.get(id);
          if (seat) seat.status = status;
        }
      },
    ),
    // The adapter contract: oldest AVAILABLE seats of the section, never one
    // that carries an override.
    reserveForHold: vi.fn(
      async ({ seatSectionId, qty }: { seatSectionId: string; qty: number }) => {
        const picked = [...seatStore.values()]
          .filter(
            (s) =>
              s.seatSectionId === seatSectionId &&
              s.status === "AVAILABLE" &&
              s.priceOverride === null,
          )
          .slice(0, qty);
        if (picked.length < qty) return [];
        for (const seat of picked) seat.status = "HELD";
        return picked.map((seat) => ({ ...seat, status: "HELD" }));
      },
    ),
  };

  const feeWaivers = {
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
  };

  const tx = {
    events: {
      getById: vi.fn(async (id: string) => (id === EVENT_ID ? event : null)),
      listTicketTypes: vi.fn(async () =>
        ticketTypes.map((tt) => ({
          id: tt.id,
          priceCents: tt.priceCents,
          status: "ACTIVE" as const,
          capacity: 1000,
          pricingMode: tt.pricingMode ?? ("FIXED" as const),
          minimumCents: tt.minimumCents ?? null,
          seatSectionId: tt.seatSectionId ?? null,
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
          payeeId: "99999999-9999-4999-8999-999999999999",
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
      findActiveByCodes: vi.fn(async () => []),
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
    feeWaivers,
    credits: {
      listActiveForHuman: vi.fn(async () => []),
      redeemConditional: vi.fn(async () => ({
        appliedCents: 0,
        balanceAfterCents: 0,
      })),
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
      findBySeatIdsIncludingTerminal: vi.fn(async () => []),
      create: vi.fn(async (input: Record<string, unknown>) => ({
        id: `ticket-${Math.random().toString(36).slice(2, 10)}`,
        ...input,
        scannedAt: null,
      })),
      countForOrderTicketType: vi.fn(async () => 0),
      getByOrderItemId: vi.fn(async () => null),
    },
    seats,
    orders: {
      getById: vi.fn(async (id: string) =>
        id === ORDER_ID && createPendingInput
          ? {
              ...orderState,
              ...createPendingInput,
              id: ORDER_ID,
              // uuid ids: updateOrderItems' output schema is strict.
              items: (createPendingInput.items as any[]).map((item, i) => ({
                id: `eeeeeeee-0000-4000-8000-${String(i).padStart(12, "0")}`,
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
      return { id: "pi_seat", clientSecret: "secret_seat" };
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
    event,
    terms,
    feePolicy,
    reportError,
    seats,
    seatStore,
    feeWaivers,
    payments,
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
  seatIds?: string[];
  donationAmountCents?: number;
  seatQuotes?: Array<{ seatId: string; unitPriceCents: number }>;
};

const checkoutInput = (items: CartLine[]) => ({
  actorHumanId: BUYER_ID,
  buyerHumanId: BUYER_ID,
  eventId: EVENT_ID,
  clientKey: "seat-override-key",
  termsAccepted: true,
  refundPolicyAccepted: true,
  items,
});

async function runCheckout(scenario: Scenario, items: CartLine[]) {
  const h = makeHarness(scenario);
  const result = await createCheckout(h.deps, checkoutInput(items));
  const order = h.createPendingInput;
  const pi = h.createPaymentIntentInput;
  // The finalize AMOUNT_MISMATCH contract: the order rows sum to the charge.
  if (order && pi) {
    expect(computeExpectedPaymentAmount(order as never)).toBe(pi.amountCents);
  }
  expect(h.reportError).not.toHaveBeenCalled();
  return { h, result, order, pi };
}

function ticketItems(order: Record<string, any> | null) {
  return ((order?.items ?? []) as Array<Record<string, any>>).filter(
    (item) => item.kind === "ticket",
  );
}

describe("seat price overrides are charged (seat-price-overrides spec)", () => {
  it("A-001: $30 tier, seat A1 overridden to $50 → the charge AND the snapshot are 5000", async () => {
    const { result, order, pi } = await runCheckout(
      { seats: [{ id: SEAT_A1, label: "A1", overrideCents: 5000 }] },
      [{ ticketTypeId: RES_ID, qty: 1, seatIds: [SEAT_A1] }],
    );

    const items = ticketItems(order);
    expect(items).toHaveLength(1);
    // The snapshot: what refunds, resale face value and the wallet pass read.
    expect(items[0]!.unitPriceCents).toBe(5000);
    expect(items[0]!.amountCents).toBe(5000);
    expect(items[0]!.meta).toMatchObject({
      seatId: SEAT_A1,
      seatIds: [SEAT_A1],
      platformFeePerTicketCents: 300,
    });

    // The charge: face 5000 + the $50 seat's own 300 platform fee + the
    // processor fee grossed up on top (no tax in OR). A tier-priced charge
    // would be built on 3000 + 200.
    expect(result.amountGrossCents).toBe(5000);
    expect(result.buyerFeesCents).toBe(300);
    expect(result.processorFeeCents).toBeGreaterThan(0);
    expect(pi!.amountCents).toBe(5000 + 300 + result.processorFeeCents);
    expect(order!.amountGrossCents).toBe(5000);
  });

  it("A-002: an override BELOW the tier price ($30 tier, A1 at $10) charges 1000", async () => {
    const { result, order, pi } = await runCheckout(
      { seats: [{ id: SEAT_A1, label: "A1", overrideCents: 1000 }] },
      [{ ticketTypeId: RES_ID, qty: 1, seatIds: [SEAT_A1] }],
    );

    expect(ticketItems(order)[0]!.unitPriceCents).toBe(1000);
    expect(result.amountGrossCents).toBe(1000);
    expect(result.buyerFeesCents).toBe(100);
    expect(pi!.amountCents).toBe(1000 + 100 + result.processorFeeCents);
  });

  it("A-003: mixed cart — 2× GA $30 + A1 at $50 + A2 unoverridden → 3000/3000/5000/3000, total = sum + fees", async () => {
    const { result, order, pi } = await runCheckout(
      {
        seats: [
          { id: SEAT_A1, label: "A1", overrideCents: 5000 },
          { id: SEAT_A2, label: "A2", overrideCents: null },
        ],
      },
      [
        { ticketTypeId: GA_ID, qty: 2 },
        { ticketTypeId: RES_ID, qty: 2, seatIds: [SEAT_A1, SEAT_A2] },
      ],
    );

    const items = ticketItems(order);
    expect(items.map((i) => i.unitPriceCents)).toEqual([3000, 3000, 5000, 3000]);
    expect(items.map((i) => i.amountCents)).toEqual([3000, 3000, 5000, 3000]);
    // Each seat line carries ITS seat, and the price followed it.
    expect(items[2]!.meta).toMatchObject({ seatId: SEAT_A1, seatIds: [SEAT_A1] });
    expect(items[3]!.meta).toMatchObject({ seatId: SEAT_A2, seatIds: [SEAT_A2] });
    expect(items.map((i) => i.meta.platformFeePerTicketCents)).toEqual([
      200, 200, 300, 200,
    ]);

    expect(result.amountGrossCents).toBe(14000);
    expect(result.feesPlatformCents).toBe(900);
    expect(result.buyerFeesCents).toBe(900);
    expect(pi!.amountCents).toBe(
      14000 + 900 + result.taxAmountCents + result.processorFeeCents,
    );
  });

  it("A-004: an override of 0 is a FREE seat, not a tier-priced one", async () => {
    const h = makeHarness({
      seats: [{ id: SEAT_A1, label: "A1", overrideCents: 0 }],
    });
    const result = await createCheckout(
      h.deps,
      checkoutInput([{ ticketTypeId: RES_ID, qty: 1, seatIds: [SEAT_A1] }]),
    );

    // Routed to the free claim: no PaymentIntent, a $0 snapshot.
    expect(h.payments.createPaymentIntent).not.toHaveBeenCalled();
    expect(result.amountGrossCents).toBe(0);
    const items = ticketItems(h.createPendingInput);
    expect(items).toHaveLength(1);
    expect(items[0]!.unitPriceCents).toBe(0);
    expect(items[0]!.meta).toMatchObject({ seatIds: [SEAT_A1] });
  });

  // Owner ruling, 2026-10-10: "If $0 is the cost of the tickets there shouldn't
  // be any fee." Before it, the $0 seat in this cart was charged the policy's
  // 50¢ fixed fee (plus processing, plus Tennessee tax on both) while the seat
  // picker showed it free.
  it.each([
    ["the $0 seat first", [SEAT_A1, SEAT_A2], [0, 3000], [0, 200]],
    ["the $0 seat last", [SEAT_A2, SEAT_A1], [3000, 0], [200, 0]],
  ])(
    "a seat overridden to $0 beside a paid seat of the same tier carries no fee (%s): the order is the paid seat's order",
    async (_name, seatIds, unitPrices, platformFees) => {
      const scenario: Scenario = {
        seats: [
          { id: SEAT_A1, label: "A1", overrideCents: 0 },
          { id: SEAT_A2, label: "A2", overrideCents: null },
        ],
        situs: TN,
        admissionTaxRateBps: 975,
      };
      const mixed = await runCheckout(scenario, [
        { ticketTypeId: RES_ID, qty: 2, seatIds },
      ]);
      const alone = await runCheckout(scenario, [
        { ticketTypeId: RES_ID, qty: 1, seatIds: [SEAT_A2] },
      ]);

      // What the order stores, per seat.
      const items = ticketItems(mixed.order);
      expect(items.map((i) => i.unitPriceCents)).toEqual(unitPrices);
      expect(items.map((i) => i.meta.seatId)).toEqual(seatIds);
      expect(items.map((i) => i.meta.platformFeePerTicketCents)).toEqual(
        platformFees,
      );
      const freeSeat = items.find((i) => i.meta.seatId === SEAT_A1)!;
      expect(freeSeat.meta).toMatchObject({
        platformFeePerTicketCents: 0,
        buyerTotalCents: 0,
        buyerUnitTotalCents: 0,
        processorFeeShareCents: 0,
      });
      const paidSeat = items.find((i) => i.meta.seatId === SEAT_A2)!;
      const paidSeatAlone = ticketItems(alone.order)[0]!;
      expect(paidSeat.meta.buyerTotalCents).toBe(paidSeatAlone.meta.buyerTotalCents);
      expect(paidSeat.meta.processorFeeShareCents).toBe(
        paidSeatAlone.meta.processorFeeShareCents,
      );

      // What the buyer is charged: the $30 seat's 200¢ fee, its processing fee
      // and its tax, exactly as when it is bought alone.
      expect(mixed.result.amountGrossCents).toBe(3000);
      expect(mixed.result.feesPlatformCents).toBe(200);
      expect(mixed.result.buyerFeesCents).toBe(200);
      expect({
        amountGrossCents: mixed.result.amountGrossCents,
        feesPlatformCents: mixed.result.feesPlatformCents,
        buyerFeesCents: mixed.result.buyerFeesCents,
        taxAmountCents: mixed.result.taxAmountCents,
        processorFeeCents: mixed.result.processorFeeCents,
        charge: mixed.pi!.amountCents,
        orderGross: mixed.order!.amountGrossCents,
        orderPlatformFee: mixed.order!.feesPlatformCents,
        orderTax: mixed.order!.taxAmountCents,
      }).toEqual({
        amountGrossCents: alone.result.amountGrossCents,
        feesPlatformCents: alone.result.feesPlatformCents,
        buyerFeesCents: alone.result.buyerFeesCents,
        taxAmountCents: alone.result.taxAmountCents,
        processorFeeCents: alone.result.processorFeeCents,
        charge: alone.pi!.amountCents,
        orderGross: alone.order!.amountGrossCents,
        orderPlatformFee: alone.order!.feesPlatformCents,
        orderTax: alone.order!.taxAmountCents,
      });
      // The recorded figure for one $30 seat in Tennessee on 5% + 50¢.
      expect(mixed.pi!.amountCents).toBe(3662);
    },
  );

  it("a $0 tier with a seat overridden to $10 routes to the PAID path and charges 1000", async () => {
    const { result, order, pi } = await runCheckout(
      { seats: [{ id: SEAT_A1, label: "A1", overrideCents: 1000 }] },
      [{ ticketTypeId: FREE_RES_ID, qty: 1, seatIds: [SEAT_A1] }],
    );

    expect(pi).not.toBeNull();
    expect(ticketItems(order)[0]!.unitPriceCents).toBe(1000);
    expect(result.amountGrossCents).toBe(1000);
    expect(pi!.amountCents).toBe(1000 + 100 + result.processorFeeCents);
  });

  it("claimFreeTickets refuses that $10 seat on a $0 tier (ORDER_NOT_FREE) and holds nothing", async () => {
    const h = makeHarness({
      seats: [{ id: SEAT_A1, label: "A1", overrideCents: 1000 }],
    });

    await expect(
      claimFreeTickets(
        { repos: h.deps.repos, clock: h.deps.clock },
        checkoutInput([
          { ticketTypeId: FREE_RES_ID, qty: 1, seatIds: [SEAT_A1] },
        ]),
        [],
      ),
    ).rejects.toMatchObject({ code: "ORDER_NOT_FREE" });
    expect(h.seatStore.get(SEAT_A1)!.status).toBe("AVAILABLE");
  });

  it("D-003: an overridden seat keeps its override after the tier's scheduled price flips", async () => {
    const { order } = await runCheckout(
      {
        ticketTypes: [
          {
            id: RES_ID,
            priceCents: 2000,
            seatSectionId: SECTION_ID,
            scheduledPriceCents: 3000,
            scheduledPriceAt: new Date("2026-02-01T00:00:00.000Z"),
          },
        ],
        seats: [
          { id: SEAT_A1, label: "A1", overrideCents: 5000 },
          { id: SEAT_A2, label: "A2", overrideCents: null },
        ],
      },
      [{ ticketTypeId: RES_ID, qty: 2, seatIds: [SEAT_A1, SEAT_A2] }],
    );

    // A1 is the override; A2 follows the tier, which has flipped to 3000.
    expect(ticketItems(order).map((i) => i.unitPriceCents)).toEqual([
      5000, 3000,
    ]);
  });

  it("auto-assigned seats (no seatIds on a seated tier) skip overridden seats and charge the tier price", async () => {
    const { h, order } = await runCheckout(
      {
        seats: [
          { id: SEAT_A1, label: "A1", overrideCents: 5000 },
          { id: SEAT_A2, label: "A2", overrideCents: null },
          { id: SEAT_A3, label: "A3", overrideCents: 1000 },
        ],
      },
      [{ ticketTypeId: RES_ID, qty: 1 }],
    );

    const items = ticketItems(order);
    expect(items).toHaveLength(1);
    expect(items[0]!.unitPriceCents).toBe(3000);
    expect(items[0]!.meta).toMatchObject({ seatIds: [SEAT_A2] });
    expect(items[0]!.meta.seatId).toBeUndefined();
    expect(h.seatStore.get(SEAT_A1)!.status).toBe("AVAILABLE");
    expect(h.seatStore.get(SEAT_A3)!.status).toBe("AVAILABLE");
  });

  it("a requested seat this event does not have is refused before pricing (SEAT_NOT_FOUND)", async () => {
    const h = makeHarness({ seats: [] });
    await expect(
      createCheckout(
        h.deps,
        checkoutInput([{ ticketTypeId: RES_ID, qty: 1, seatIds: [SEAT_A1] }]),
      ),
    ).rejects.toMatchObject({ code: "SEAT_NOT_FOUND" });
    expect(h.payments.createPaymentIntent).not.toHaveBeenCalled();
  });
});

describe("A-007: an override edited between quote and charge refuses the order", () => {
  it.each([
    ["raised", 5000, 6000],
    ["removed", 5000, null],
    ["added", null, 4000],
    ["set to free", 5000, 0],
  ] as const)(
    "override %s under the lock → conflict seat_price_changed, nothing held, nothing charged",
    async (_label, quoted, atLock) => {
      const h = makeHarness({
        seats: [
          { id: SEAT_A1, label: "A1", overrideCents: quoted },
          { id: SEAT_A2, label: "A2", overrideCents: null },
        ],
        overrideAtLock: new Map([[SEAT_A1, atLock]]),
      });

      await expect(
        createCheckout(
          h.deps,
          checkoutInput([
            { ticketTypeId: RES_ID, qty: 2, seatIds: [SEAT_A1, SEAT_A2] },
          ]),
        ),
      ).rejects.toMatchObject({
        code: "conflict",
        message: "seat_price_changed",
        seatId: SEAT_A1,
      });

      // Refused before the HELD flip: neither seat is left held, no order
      // row, no PaymentIntent.
      expect(h.seats.updateStatuses).not.toHaveBeenCalled();
      expect(h.seatStore.get(SEAT_A1)!.status).toBe("AVAILABLE");
      expect(h.seatStore.get(SEAT_A2)!.status).toBe("AVAILABLE");
      expect(h.createPendingInput).toBeNull();
      expect(h.payments.createPaymentIntent).not.toHaveBeenCalled();
    },
  );

  it("CONTROL: an unchanged override passes the locked comparison", async () => {
    const { h, order } = await runCheckout(
      {
        seats: [{ id: SEAT_A1, label: "A1", overrideCents: 5000 }],
        overrideAtLock: new Map([[SEAT_A1, 5000]]),
      },
      [{ ticketTypeId: RES_ID, qty: 1, seatIds: [SEAT_A1] }],
    );
    expect(ticketItems(order)[0]!.unitPriceCents).toBe(5000);
    expect(h.seatStore.get(SEAT_A1)!.status).toBe("HELD");
  });
});

describe("a corrupt override refuses checkout and names the seat", () => {
  it.each([
    ["unreadable (the repo's invalid marker)", INVALID],
    ["negative", -500],
    ["fractional", 1234.5],
  ] as const)(
    "%s at the pre-read → INTERNAL seat_price_override_invalid, nothing held, nothing charged",
    async (_label, stored) => {
      const h = makeHarness({
        seats: [
          { id: SEAT_A1, label: "A1", overrideCents: null },
          { id: SEAT_A2, label: "A2", overrideCents: stored },
        ],
      });

      await expect(
        createCheckout(
          h.deps,
          checkoutInput([
            { ticketTypeId: RES_ID, qty: 2, seatIds: [SEAT_A1, SEAT_A2] },
          ]),
        ),
      ).rejects.toMatchObject({
        code: "INTERNAL",
        message: "seat_price_override_invalid",
        meta: { seatId: SEAT_A2 },
      });

      expect(h.seats.findByIdsForUpdate).not.toHaveBeenCalled();
      expect(h.seats.updateStatuses).not.toHaveBeenCalled();
      expect(h.seatStore.get(SEAT_A1)!.status).toBe("AVAILABLE");
      expect(h.seatStore.get(SEAT_A2)!.status).toBe("AVAILABLE");
      expect(h.createPendingInput).toBeNull();
      expect(h.payments.createPaymentIntent).not.toHaveBeenCalled();
    },
  );

  it("an override that turns unreadable under the lock is refused the same way, before the HELD flip", async () => {
    const h = makeHarness({
      seats: [{ id: SEAT_A1, label: "A1", overrideCents: 5000 }],
      overrideAtLock: new Map([[SEAT_A1, INVALID]]),
    });

    await expect(
      createCheckout(
        h.deps,
        checkoutInput([{ ticketTypeId: RES_ID, qty: 1, seatIds: [SEAT_A1] }]),
      ),
    ).rejects.toMatchObject({
      code: "INTERNAL",
      message: "seat_price_override_invalid",
      meta: { seatId: SEAT_A1 },
    });

    expect(h.seats.findByIdsForUpdate).toHaveBeenCalled();
    expect(h.seats.updateStatuses).not.toHaveBeenCalled();
    expect(h.seatStore.get(SEAT_A1)!.status).toBe("AVAILABLE");
    expect(h.payments.createPaymentIntent).not.toHaveBeenCalled();
  });
});

describe("A-008: the fee waiver on a mixed-price cart", () => {
  it("waives the MOST EXPENSIVE ticket, and the ladder reserved is the ladder applied", async () => {
    const { h, result, order } = await runCheckout(
      {
        waiverReservedTickets: 1,
        seats: [
          { id: SEAT_A1, label: "A1", overrideCents: null },
          { id: SEAT_A2, label: "A2", overrideCents: 5000 },
        ],
      },
      [
        { ticketTypeId: GA_ID, qty: 1 },
        { ticketTypeId: RES_ID, qty: 2, seatIds: [SEAT_A1, SEAT_A2] },
      ],
    );

    // Pass 1 handed the reservation the PER-SEAT ladder (R-001): the $50
    // seat's 300¢ fee first. A tier-priced pass 1 would hand [200, 200, 200].
    expect(h.feeWaivers.reserve).toHaveBeenCalledTimes(1);
    const reserveInput = (h.feeWaivers.reserve.mock.calls[0] as unknown as [
      { waivableTicketFeesCents: number[] },
    ])[0];
    expect(reserveInput.waivableTicketFeesCents).toEqual([300, 200, 200]);

    // Pass 2 waived exactly that ticket: the $50 seat, A2.
    const items = ticketItems(order);
    expect(items.map((i) => i.unitPriceCents)).toEqual([3000, 3000, 5000]);
    expect(items.map((i) => i.meta.platformFeePerTicketCents)).toEqual([
      200, 200, 0,
    ]);
    expect(items[2]!.meta).toMatchObject({
      seatIds: [SEAT_A2],
      platformFeeWaivedCents: 300,
    });
    const reserved = await h.feeWaivers.reserve.mock.results[0]!.value;
    expect(reserved.feeWaivedCents).toBe(300);
    expect(result.feesPlatformCents).toBe(400);
    expect(result.buyerFeesCents).toBe(400);
  });
});

describe("D-001 downstream: refunds and resale read the per-seat snapshot", () => {
  it("A-005: refunding the $50 seat quotes against 5000 with a proportional Stripe-fee and tax share", async () => {
    const { h, order } = await runCheckout(
      {
        situs: TN,
        admissionTaxRateBps: 975,
        seats: [
          { id: SEAT_A1, label: "A1", overrideCents: 5000 },
          { id: SEAT_A2, label: "A2", overrideCents: null },
        ],
      },
      [
        { ticketTypeId: GA_ID, qty: 2 },
        { ticketTypeId: RES_ID, qty: 2, seatIds: [SEAT_A1, SEAT_A2] },
      ],
    );

    const itemIds = [
      "aaaaaaaa-0000-4000-8000-000000000001",
      "aaaaaaaa-0000-4000-8000-000000000002",
      "aaaaaaaa-0000-4000-8000-000000000003",
      "aaaaaaaa-0000-4000-8000-000000000004",
    ];
    const persisted = {
      ...order!,
      id: ORDER_ID,
      eventId: EVENT_ID,
      buyerHumanId: BUYER_ID,
      status: "SUCCEEDED",
      source: "PRIMARY",
      nonRefundable: false,
      stripePaymentIntentId: "pi_seat",
      items: (order!.items as Array<Record<string, any>>).map((item, i) => ({
        ...item,
        id: itemIds[i],
        status: "active",
        refundedAt: null,
        transferredAt: null,
        resaleListingId: null,
      })),
    };
    const taxLines = (h.createTaxLinesInput?.lines ?? []) as Array<
      Record<string, any>
    >;
    expect(persisted.taxAmountCents).toBeGreaterThan(0);

    const orderStripeFeeCents = 600;
    const refundRepos = {
      humans: { getById: vi.fn(async () => ({ id: BUYER_ID })) },
      orders: {
        getById: vi.fn(async () => persisted),
        listTaxLines: vi.fn(async () => taxLines),
      },
      events: { getById: vi.fn(async () => h.event) },
      payees: {
        getBySubject: vi.fn(async () => ({ id: "payee-1" })),
        getById: vi.fn(async () => ({
          id: "payee-1",
          stripeAccountId: "acct_connected",
        })),
      },
      tickets: { getByOrderItemId: vi.fn(async () => null) },
    } as unknown as Repos;
    const refundPayments = {
      getProcessingFeeForPaymentIntent: vi.fn(async () => ({
        feeCents: orderStripeFeeCents,
      })),
    } as unknown as PaymentProcessorPort;

    const quote = await quoteItemRefund(
      { repos: refundRepos, payments: refundPayments, _skipBuyerCheck: true },
      { actorHumanId: BUYER_ID, orderId: ORDER_ID, orderItemIds: [itemIds[2]] },
    );

    const seatItem = persisted.items[2]!;
    const seatBuyerTotal = seatItem.meta.buyerTotalCents as number;
    const allBuyerTotal = persisted.items
      .filter((i) => i.kind === "ticket")
      .reduce((s, i) => s + (i.meta.buyerTotalCents as number), 0);
    const q = quote.items[0]!;

    expect(q.unitPriceCents).toBe(5000);
    expect(q.buyerPaidCents).toBe(seatBuyerTotal);
    // Proportional to what this seat cost (5300 of 14900), not a quarter.
    const feeExact = (orderStripeFeeCents * seatBuyerTotal) / allBuyerTotal;
    const taxExact = (persisted.taxAmountCents * seatBuyerTotal) / allBuyerTotal;
    expect(Math.abs(q.stripeFeeShareCents - feeExact)).toBeLessThanOrEqual(1);
    expect(Math.abs(q.taxShareCents - taxExact)).toBeLessThanOrEqual(1);
    expect(q.stripeFeeShareCents).not.toBe(orderStripeFeeCents / 4);
    expect(q.taxShareCents).not.toBe(Math.round(persisted.taxAmountCents / 4));
    expect(q.refundableCents).toBe(
      q.buyerPaidCents + q.taxShareCents - q.stripeFeeShareCents,
    );
  });

  it("A-006: reselling the $50 seat records face value 5000 (what the seat cost, not the tier price)", async () => {
    const { order } = await runCheckout(
      { seats: [{ id: SEAT_A1, label: "A1", overrideCents: 5000 }] },
      [{ ticketTypeId: RES_ID, qty: 1, seatIds: [SEAT_A1] }],
    );
    const orderItem = { id: "order-item-1", ...ticketItems(order)[0]! };

    const faceValueCents = await resolvePurchasedUnitPriceCents(
      {
        orderItems: {
          getById: vi.fn(async (id: string) =>
            id === orderItem.id ? (orderItem as never) : null,
          ),
        },
      },
      { id: "ticket-1", orderItemId: orderItem.id },
    );
    expect(faceValueCents).toBe(5000);
  });
});

describe("updateOrderItems (the cart hold) prices and locks per seat too", () => {
  const holdInput = (items: CartLine[]) => ({
    actorHumanId: BUYER_ID,
    eventId: EVENT_ID,
    items,
  });

  it("an overridden seat's held line carries the override as unitPriceCents", async () => {
    const h = makeHarness({
      seats: [
        { id: SEAT_A1, label: "A1", overrideCents: 5000 },
        { id: SEAT_A2, label: "A2", overrideCents: null },
      ],
    });

    const out = await updateOrderItems(
      { repos: h.deps.repos, clock: h.deps.clock },
      holdInput([
        { ticketTypeId: RES_ID, qty: 2, seatIds: [SEAT_A1, SEAT_A2] },
      ]),
    );

    const items = ticketItems(h.createPendingInput);
    expect(items.map((i) => i.unitPriceCents)).toEqual([5000, 3000]);
    expect(items.map((i) => i.meta.seatIds)).toEqual([[SEAT_A1], [SEAT_A2]]);
    expect(h.createPendingInput!.amountGrossCents).toBe(8000);
    // The hold quotes the same per-seat fees the charge will (300 + 200).
    expect(out.order.buyerFeesCents).toBe(500);
    expect(h.seatStore.get(SEAT_A1)!.status).toBe("HELD");
  });

  it("a seat overridden to $0 beside a paid seat: the hold quotes no fee for it (owner ruling 2026-10-10)", async () => {
    const seats: SeatFixture[] = [
      { id: SEAT_A1, label: "A1", overrideCents: 0 },
      { id: SEAT_A2, label: "A2", overrideCents: null },
    ];
    const mixed = makeHarness({ seats });
    const mixedOut = await updateOrderItems(
      { repos: mixed.deps.repos, clock: mixed.deps.clock },
      holdInput([{ ticketTypeId: RES_ID, qty: 2, seatIds: [SEAT_A2, SEAT_A1] }]),
    );
    const alone = makeHarness({ seats });
    const aloneOut = await updateOrderItems(
      { repos: alone.deps.repos, clock: alone.deps.clock },
      holdInput([{ ticketTypeId: RES_ID, qty: 1, seatIds: [SEAT_A2] }]),
    );

    const items = ticketItems(mixed.createPendingInput);
    expect(items.map((i) => i.unitPriceCents)).toEqual([3000, 0]);
    expect(items.map((i) => i.meta.platformFeePerTicketCents)).toEqual([200, 0]);
    // The $0 seat is last: it used to take the processing-fee remainder too.
    expect(items[1]!.meta.buyerTotalCents).toBe(0);
    expect(items[1]!.meta.processorFeeShareCents).toBe(0);
    // The held order is the paid seat's held order.
    expect(mixedOut.order.buyerFeesCents).toBe(200);
    expect(mixedOut.order.buyerFeesCents).toBe(aloneOut.order.buyerFeesCents);
    expect(mixed.createPendingInput!.feesPlatformCents).toBe(
      alone.createPendingInput!.feesPlatformCents,
    );
    expect(mixed.createPendingInput!.amountGrossCents).toBe(3000);
    expect(mixed.seatStore.get(SEAT_A1)!.status).toBe("HELD");
  });

  it("an override changed between the read and the lock refuses seat_price_changed and holds nothing", async () => {
    const h = makeHarness({
      seats: [
        { id: SEAT_A1, label: "A1", overrideCents: 5000 },
        { id: SEAT_A2, label: "A2", overrideCents: null },
      ],
      overrideAtLock: new Map([[SEAT_A1, 7000]]),
    });

    await expect(
      updateOrderItems(
        { repos: h.deps.repos, clock: h.deps.clock },
        holdInput([
          { ticketTypeId: RES_ID, qty: 2, seatIds: [SEAT_A1, SEAT_A2] },
        ]),
      ),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "seat_price_changed",
      seatId: SEAT_A1,
    });
    expect(h.seats.updateStatuses).not.toHaveBeenCalled();
    expect(h.seatStore.get(SEAT_A1)!.status).toBe("AVAILABLE");
    expect(h.seatStore.get(SEAT_A2)!.status).toBe("AVAILABLE");
    expect(h.createPendingInput).toBeNull();
  });
});

describe("claimFreeTickets: a free price that is no longer free under the lock is refused", () => {
  it.each([
    ["a $0 override on a $30 tier, raised to $10", RES_ID, 0, 1000],
    ["a $0 tier's seat that gains a $5 override", FREE_RES_ID, null, 500],
  ] as const)(
    "%s → seat_price_changed, nothing held, nothing minted",
    async (_label, ticketTypeId, quoted, atLock) => {
      const h = makeHarness({
        seats: [{ id: SEAT_A1, label: "A1", overrideCents: quoted }],
        overrideAtLock: new Map([[SEAT_A1, atLock]]),
      });

      await expect(
        claimFreeTickets(
          { repos: h.deps.repos, clock: h.deps.clock },
          checkoutInput([{ ticketTypeId, qty: 1, seatIds: [SEAT_A1] }]),
          [],
        ),
      ).rejects.toMatchObject({
        code: "conflict",
        message: "seat_price_changed",
        seatId: SEAT_A1,
      });
      expect(h.seats.updateStatuses).not.toHaveBeenCalled();
      expect(h.seatStore.get(SEAT_A1)!.status).toBe("AVAILABLE");
      expect(h.createPendingInput).toBeNull();
    },
  );

  it("CONTROL: the same free seat with an unchanged override is claimed at $0", async () => {
    const h = makeHarness({
      seats: [{ id: SEAT_A1, label: "A1", overrideCents: 0 }],
      overrideAtLock: new Map([[SEAT_A1, 0]]),
    });
    await claimFreeTickets(
      { repos: h.deps.repos, clock: h.deps.clock },
      checkoutInput([{ ticketTypeId: RES_ID, qty: 1, seatIds: [SEAT_A1] }]),
      [],
    );
    expect(ticketItems(h.createPendingInput)[0]!.unitPriceCents).toBe(0);
  });
});

describe("D-007 / FR-004: the buyer's quoted seat price is an assertion, never a charge", () => {
  const PWYW_RES_ID = "33333333-3333-4333-8333-333333333336";
  const MANY_SEATS = Array.from(
    { length: 501 },
    (_, i) => `99999999-9999-4999-8999-${String(i).padStart(12, "0")}`,
  );
  const holdInput = (items: CartLine[]) => ({
    actorHumanId: BUYER_ID,
    eventId: EVENT_ID,
    items,
  });
  const quote = (seatId: string, unitPriceCents: number) => ({
    seatId,
    unitPriceCents,
  });
  const expectNothingHeldOrCharged = (h: ReturnType<typeof makeHarness>) => {
    // Refused before the seat lock: no row locked, none flipped to HELD, no
    // order row, no PaymentIntent.
    expect(h.seats.findByIdsForUpdate).not.toHaveBeenCalled();
    expect(h.seats.updateStatuses).not.toHaveBeenCalled();
    for (const seat of h.seatStore.values()) {
      expect(seat.status).toBe("AVAILABLE");
    }
    expect(h.createPendingInput).toBeNull();
    expect(h.payments.createPaymentIntent).not.toHaveBeenCalled();
  };

  it("HEADLINE: the map showed A1 at the $30 tier price, the organiser then set it to $50 → seat_price_changed, nothing held, no order, no PaymentIntent", async () => {
    const h = makeHarness({
      seats: [{ id: SEAT_A1, label: "A1", overrideCents: 5000 }],
    });

    await expect(
      createCheckout(
        h.deps,
        checkoutInput([
          {
            ticketTypeId: RES_ID,
            qty: 1,
            seatIds: [SEAT_A1],
            seatQuotes: [quote(SEAT_A1, 3000)],
          },
        ]),
      ),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "seat_price_changed",
      seatId: SEAT_A1,
    });
    expectNothingHeldOrCharged(h);
  });

  it("a quote matching the resolved price is charged that price (override seat and tier seat)", async () => {
    const { h, order, pi, result } = await runCheckout(
      { seats: [
        { id: SEAT_A1, label: "A1", overrideCents: 5000 },
        { id: SEAT_A2, label: "A2", overrideCents: null },
      ] },
      [
        {
          ticketTypeId: RES_ID,
          qty: 2,
          seatIds: [SEAT_A1, SEAT_A2],
          seatQuotes: [quote(SEAT_A1, 5000), quote(SEAT_A2, 3000)],
        },
      ],
    );
    expect(ticketItems(order).map((i) => i.unitPriceCents)).toEqual([
      5000, 3000,
    ]);
    expect(result.amountGrossCents).toBe(8000);
    expect(pi!.amountCents).toBe(8000 + 500 + result.processorFeeCents);
    expect(h.seatStore.get(SEAT_A1)!.status).toBe("HELD");
    expect(h.seatStore.get(SEAT_A2)!.status).toBe("HELD");
  });

  it("an absent quote (older client, mobile) is charged the locked price, as before", async () => {
    const { order, result } = await runCheckout(
      { seats: [
        { id: SEAT_A1, label: "A1", overrideCents: 5000 },
        { id: SEAT_A2, label: "A2", overrideCents: null },
      ] },
      // A2 quoted, A1 not: a partial quote list compares only what it names.
      [
        {
          ticketTypeId: RES_ID,
          qty: 2,
          seatIds: [SEAT_A1, SEAT_A2],
          seatQuotes: [quote(SEAT_A2, 3000)],
        },
      ],
    );
    expect(ticketItems(order).map((i) => i.unitPriceCents)).toEqual([
      5000, 3000,
    ]);
    expect(result.amountGrossCents).toBe(8000);
  });

  it.each([
    ["0 for a $50 seat", 0],
    ["1¢ under", 4999],
    ["1¢ over", 5001],
  ] as const)(
    "a quote can never move the charge: %s → refused, not charged the quote",
    async (_label, quoted) => {
      const h = makeHarness({
        seats: [{ id: SEAT_A1, label: "A1", overrideCents: 5000 }],
      });
      await expect(
        createCheckout(
          h.deps,
          checkoutInput([
            {
              ticketTypeId: RES_ID,
              qty: 1,
              seatIds: [SEAT_A1],
              seatQuotes: [quote(SEAT_A1, quoted)],
            },
          ]),
        ),
      ).rejects.toMatchObject({
        code: "conflict",
        message: "seat_price_changed",
        seatId: SEAT_A1,
      });
      expectNothingHeldOrCharged(h);
    },
  );

  it("a seat quoted free that now costs money is refused (by the routing probe, before either path runs)", async () => {
    const h = makeHarness({
      seats: [{ id: SEAT_A1, label: "A1", overrideCents: 500 }],
    });
    await expect(
      createCheckout(
        h.deps,
        checkoutInput([
          {
            ticketTypeId: FREE_RES_ID,
            qty: 1,
            seatIds: [SEAT_A1],
            seatQuotes: [quote(SEAT_A1, 0)],
          },
        ]),
      ),
    ).rejects.toMatchObject({ code: "conflict", message: "seat_price_changed" });
    expectNothingHeldOrCharged(h);
  });

  it("claimFreeTickets: a seat quoted at a $0 override whose override was cleared ($30 tier) → seat_price_changed before ORDER_NOT_FREE", async () => {
    const h = makeHarness({
      seats: [{ id: SEAT_A1, label: "A1", overrideCents: null }],
    });
    await expect(
      claimFreeTickets(
        { repos: h.deps.repos, clock: h.deps.clock },
        checkoutInput([
          {
            ticketTypeId: RES_ID,
            qty: 1,
            seatIds: [SEAT_A1],
            seatQuotes: [quote(SEAT_A1, 0)],
          },
        ]),
        [],
      ),
    ).rejects.toMatchObject({ code: "conflict", message: "seat_price_changed" });
    expect(h.seats.findByIdsForUpdate).not.toHaveBeenCalled();
    expect(h.createPendingInput).toBeNull();
  });

  it("the quote is compared against the SCHEDULE-resolved tier price: shown $30, flipped to $40 → refused", async () => {
    const h = makeHarness({
      ticketTypes: [
        {
          id: RES_ID,
          priceCents: 3000,
          seatSectionId: SECTION_ID,
          scheduledPriceCents: 4000,
          scheduledPriceAt: new Date(NOW.getTime() - 60_000),
        },
      ],
      seats: [{ id: SEAT_A1, label: "A1", overrideCents: null }],
    });
    await expect(
      createCheckout(
        h.deps,
        checkoutInput([
          {
            ticketTypeId: RES_ID,
            qty: 1,
            seatIds: [SEAT_A1],
            seatQuotes: [quote(SEAT_A1, 3000)],
          },
        ]),
      ),
    ).rejects.toMatchObject({ code: "conflict", message: "seat_price_changed" });
    expectNothingHeldOrCharged(h);
  });

  it("an ADJUSTABLE (pay-what-you-want) seat ignores its quote: the buyer's named amount is charged", async () => {
    const { order, result } = await runCheckout(
      {
        ticketTypes: [
          {
            id: PWYW_RES_ID,
            priceCents: 0,
            pricingMode: "ADJUSTABLE",
            minimumCents: 500,
            seatSectionId: SECTION_ID,
          },
        ],
        seats: [{ id: SEAT_A1, label: "A1", overrideCents: 5000 }],
      },
      [
        {
          ticketTypeId: PWYW_RES_ID,
          qty: 1,
          seatIds: [SEAT_A1],
          donationAmountCents: 2500,
          seatQuotes: [quote(SEAT_A1, 1)],
        },
      ],
    );
    expect(ticketItems(order)[0]!.unitPriceCents).toBe(2500);
    expect(result.amountGrossCents).toBe(2500);
  });

  it.each([
    [
      "a seat the item does not buy",
      { seatIds: [SEAT_A1], seatQuotes: [quote(SEAT_A2, 3000)] },
    ],
    [
      "a seat quoted twice",
      {
        seatIds: [SEAT_A1],
        seatQuotes: [quote(SEAT_A1, 3000), quote(SEAT_A1, 3000)],
      },
    ],
    ["an item with no seatIds", { seatQuotes: [quote(SEAT_A1, 3000)] }],
    [
      "a negative amount",
      { seatIds: [SEAT_A1], seatQuotes: [quote(SEAT_A1, -1)] },
    ],
    [
      "a fractional amount",
      { seatIds: [SEAT_A1], seatQuotes: [quote(SEAT_A1, 30.5)] },
    ],
    [
      "an amount over the INT4 ceiling",
      { seatIds: [SEAT_A1], seatQuotes: [quote(SEAT_A1, 2_147_483_648)] },
    ],
    ["an empty list", { seatIds: [SEAT_A1], seatQuotes: [] }],
    [
      "more than 500 seats on one item (seatIds share the cap)",
      { seatIds: MANY_SEATS, seatQuotes: [quote(SEAT_A1, 3000)] },
    ],
    [
      "more than 500 quotes on one item",
      {
        seatIds: [SEAT_A1],
        seatQuotes: MANY_SEATS.map((seatId) => quote(seatId, 3000)),
      },
    ],
  ] as const)("a quote for %s is invalid input", async (_label, extra) => {
    const h = makeHarness({
      seats: [
        { id: SEAT_A1, label: "A1", overrideCents: null },
        { id: SEAT_A2, label: "A2", overrideCents: null },
      ],
    });
    await expect(
      createCheckout(
        h.deps,
        checkoutInput([
          { ticketTypeId: RES_ID, qty: 1, ...(extra as object) } as CartLine,
        ]),
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(h.seats.findPriceOverridesByIds).not.toHaveBeenCalled();
    expect(h.createPendingInput).toBeNull();
  });

  it("updateOrderItems (the hold): a stale quote refuses seat_price_changed and holds nothing", async () => {
    const h = makeHarness({
      seats: [
        { id: SEAT_A1, label: "A1", overrideCents: 5000 },
        { id: SEAT_A2, label: "A2", overrideCents: null },
      ],
    });
    await expect(
      updateOrderItems(
        { repos: h.deps.repos, clock: h.deps.clock },
        holdInput([
          {
            ticketTypeId: RES_ID,
            qty: 2,
            seatIds: [SEAT_A1, SEAT_A2],
            seatQuotes: [quote(SEAT_A1, 3500), quote(SEAT_A2, 3000)],
          },
        ]),
      ),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "seat_price_changed",
      seatId: SEAT_A1,
    });
    expect(h.seats.findByIdsForUpdate).not.toHaveBeenCalled();
    expect(h.seats.updateStatuses).not.toHaveBeenCalled();
    expect(h.createPendingInput).toBeNull();
  });

  it("updateOrderItems (the hold): matching quotes hold at the resolved prices", async () => {
    const h = makeHarness({
      seats: [
        { id: SEAT_A1, label: "A1", overrideCents: 5000 },
        { id: SEAT_A2, label: "A2", overrideCents: null },
      ],
    });
    await updateOrderItems(
      { repos: h.deps.repos, clock: h.deps.clock },
      holdInput([
        {
          ticketTypeId: RES_ID,
          qty: 2,
          seatIds: [SEAT_A1, SEAT_A2],
          seatQuotes: [quote(SEAT_A1, 5000), quote(SEAT_A2, 3000)],
        },
      ]),
    );
    expect(
      ticketItems(h.createPendingInput).map((i) => i.unitPriceCents),
    ).toEqual([5000, 3000]);
    expect(h.seatStore.get(SEAT_A1)!.status).toBe("HELD");
  });
});
