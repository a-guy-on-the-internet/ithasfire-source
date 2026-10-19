import { describe, expect, it, vi } from "vitest";

import { updateOrderItems } from "../update-order-items";
import { referenceBuyerTotalTax } from "../../../lib/pricing/__fixtures__/buyer-total-tax-oracle";
import type { UpdateOrderItemsDeps } from "../update-order-items";
import type { Repos, TxRepos } from "@th/ports/repos";
import type {
  PayoutTermsRecord,
  PayoutTermsRepo,
} from "@th/ports/repos/payout-terms";
import type { AuditRepo } from "@th/ports/repos/audit";
import type { EventsRepo } from "@th/ports/repos/events";
import type {
  FeePoliciesRepo,
  FeePolicyRecord,
} from "@th/ports/repos/fee-policies";
import type {
  OrderItemRecord,
  OrderRecord,
  OrdersRepo,
} from "@th/ports/repos/orders";
import { createTestLogger } from "@th/test-utils/fakes/logger";
import { solveProcessingFeeGrossUp } from "../../../lib/pricing/processing-cost-schedule";
import type { LocalTaxImpositionRule } from "../../../lib/pricing/tax-impositions";

/** Seam for the (shipped-empty) local imposition table; null = shipped table. */
const localTaxRules = vi.hoisted(() => ({
  rules: null as LocalTaxImpositionRule[] | null,
}));
vi.mock("../../../lib/pricing/tax-impositions", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../lib/pricing/tax-impositions")>();
  return {
    ...actual,
    resolveTaxImpositions: (
      args: Parameters<typeof actual.resolveTaxImpositions>[0],
    ) =>
      actual.resolveTaxImpositions(
        args,
        localTaxRules.rules ?? actual.LOCAL_TAX_IMPOSITION_RULES,
      ),
  };
});

const DEFAULT_EVENT_ID = "11111111-1111-4111-8111-111111111111";
const DEFAULT_ACTOR_ID = "22222222-2222-4222-8222-222222222222";
const DEFAULT_TICKET_TYPE_ID = "33333333-3333-4333-8333-333333333333";
const DEFAULT_AGREEMENT_ID = "44444444-4444-4444-8444-444444444444";
const DEFAULT_FEE_POLICY_ID = "55555555-5555-4555-8555-555555555555";
const DEFAULT_ORDER_ID = "66666666-6666-4666-8666-666666666666";
const ITEM_IDS = [
  "77777777-7777-4777-8777-777777777777",
  "88888888-8888-4888-8888-888888888888",
  "99999999-9999-4999-8999-999999999999",
];
let itemIndex = 0;

const nextItemId = () => {
  const id = ITEM_IDS[itemIndex % ITEM_IDS.length]!;
  itemIndex += 1;
  return id;
};

const makeOrderItem = (
  overrides?: Partial<OrderItemRecord>,
): OrderItemRecord => ({
  id: nextItemId(),
  orderId: DEFAULT_ORDER_ID,
  kind: "ticket",
  ticketTypeId: DEFAULT_TICKET_TYPE_ID,
  qty: 1,
  unitPriceCents: 1000,
  amountCents: 1000,
  meta: {},
  paidOutAt: null,
  refundedAt: null,
  transferredAt: null,
  status: "active",
  ...overrides,
});

const makeOrderRecord = (overrides?: Partial<OrderRecord>): OrderRecord => ({
  id: DEFAULT_ORDER_ID,
  eventId: DEFAULT_EVENT_ID,
  buyerHumanId: DEFAULT_ACTOR_ID,
  amountGrossCents: 1000,
  feesPlatformCents: 50,
  currency: "usd",
  feePolicySnapshot: {},
  status: "PENDING",
  stripePaymentIntentId: null,
  source: "PRIMARY",
  nonRefundable: false,
  occurredAt: new Date("2025-01-01T00:00:00.000Z"),
  parentOrderId: null,
  taxAmountCents: 0,
  billingAddressLine1: null,
  billingAddressLine2: null,
  billingCity: null,
  billingState: null,
  billingPostalCode: null,
  billingCountry: null,
  stripeTaxCalculationId: null,
  items: [makeOrderItem()],
  ...overrides,
});

function makeContext(options?: {
  existingOrder?: OrderRecord | null;
  gateType?: "NONE" | "PASSWORD" | "APPLICATION";
  isUnlocked?: boolean;
  feeMode?: "ABSORB" | "PASS_THROUGH";
  /** Scheduled price change on the default ticket type (FR-005). */
  scheduledPriceCents?: number | null;
  scheduledPriceAt?: Date | null;
  /** Per-type sales window on the default ticket type (FR-014). */
  salesOpenAt?: Date | null;
  salesCloseAt?: Date | null;
  /**
   * Authored capacity of the default ticket type. Defaults to the fixture's
   * 100 so the capacity gate is a no-op for tests that aren't about inventory.
   */
  capacity?: number;
  /** Tickets already minted for the default type — the `issued` half. */
  issuedForTicketType?: number;
  /** Qty on OTHER carts' unexpired holds — the `held` half. */
  heldForTicketType?: number;
  /**
   * Overrides the injected clock so a test can sit either side of a flip — or
   * of a sales-window boundary.
   */
  now?: Date;
  /**
   * The fee-waiver allowances that apply to this buyer/event (headroom =
   * granted − used), or "throws" for a broken lookup. Default: none.
   */
  feeWaivers?: Array<{ ticketsGranted: number; ticketsUsed: number }> | "throws";
}) {
  const feeMode = options?.feeMode ?? "PASS_THROUGH";
  const now = options?.now ?? new Date("2025-01-01T00:00:00.000Z");
  const capacity = options?.capacity ?? 100;
  const issuedForTicketType = options?.issuedForTicketType ?? 0;
  const heldForTicketType = options?.heldForTicketType ?? 0;
  itemIndex = 0;
  let orderStore: OrderRecord | null = options?.existingOrder ?? null;
  let lastUpdateInput: Parameters<OrdersRepo["updatePendingItems"]>[0] | null =
    null;
  let lastCreateInput: Parameters<OrdersRepo["createPending"]>[0] | null = null;

  const eventRecord = {
    id: DEFAULT_EVENT_ID,
    orgId: "org-1",
    humanId: null,
    title: "Launch Party",
    status: "PUBLISHED" as const,
    startsAt: new Date("2025-02-01T20:00:00.000Z"),
    endsAt: null,
    placeId: null,
    savedLocationId: null,
    categoryId: null,
    addressText: null,
    lat: null,
    lng: null,
    slug: "launch-party",
    shortId: "launchpr",
    regionCode: null,
    publishedAt: now,
    agreementPrimaryId: DEFAULT_AGREEMENT_ID,
    agreementResaleId: null,
    defaultLocale: null,
    gateType: options?.gateType ?? "NONE",
  };

  const eventsRepo: EventsRepo = {
    getById: vi.fn(async (id: string) =>
      id === eventRecord.id ? (eventRecord as any) : null,
    ),
    listTicketTypes: vi.fn(async (eventId: string) =>
      eventId === eventRecord.id
        ? [
            {
              id: DEFAULT_TICKET_TYPE_ID,
              name: "General Admission",
              priceCents: 1000,
              pricingMode: "FIXED" as const,
              minimumCents: null as number | null,
              capacity,
              status: "ACTIVE",
              seatSectionId: null,
              scheduledPriceCents: options?.scheduledPriceCents ?? null,
              scheduledPriceAt: options?.scheduledPriceAt ?? null,
              salesOpenAt: options?.salesOpenAt ?? null,
              salesCloseAt: options?.salesCloseAt ?? null,
            },
          ]
        : [],
    ),
    ensureHostPermission: vi.fn(async () => true),
    upsertDraft: vi.fn(),
    listPublishedForSitemap: vi.fn(async () => []),
  } as unknown as EventsRepo;

  const agreement: PayoutTermsRecord = {
    id: DEFAULT_AGREEMENT_ID,
    kind: "PRIMARY_SPLIT",
    status: "ACTIVE",
    feeMode,
    feePolicyId: DEFAULT_FEE_POLICY_ID,
    payoutSchedule: "WEEK_OF_EVENT",
    isDefault: false,
    settlementCurrency: "usd",
    version: 1,
    createdAt: now,
    updatedAt: now,
  };

  const agreementsRepo: PayoutTermsRepo = {
    listByEvent: vi.fn(async () => [agreement]),
    listLines: vi.fn(async () => [
      {
        id: "line-1",
        agreementId: DEFAULT_AGREEMENT_ID,
        payeeId: "payee-1",
        percent: 100,
        floorCents: 0,
        capPercent: null,
        priority: 0,
        rounding: "FLOOR",
      },
    ]),
    getById: vi.fn(async () => agreement),
    createDraft: vi.fn(),
    updateDraft: vi.fn(),
    replaceLines: vi.fn(async () => undefined),
    pinFeePolicy: vi.fn(async () => agreement),
  } as PayoutTermsRepo;

  const feePolicy: FeePolicyRecord = {
    id: DEFAULT_FEE_POLICY_ID,
    scopeType: "EVENT",
    scopeId: eventRecord.id,
    status: "ACTIVE",
    version: 1,
    effectiveFrom: now,
    effectiveTo: null,
    buyerFeePct: 0.05,
    maxFeeCents: null,
    minFeeCents: 0,
    platformFixedCents: 0,
    feeMode,
    processsorFeePct: 0.029,
    processorFixedCents: 30,
    payoutPct: 0.9,
    payoutFixedCents: 0,
    monthlyPayoutCents: 0,
  };

  const feePoliciesRepo: FeePoliciesRepo = {
    getById: vi.fn(async (id: string) =>
      id === feePolicy.id ? feePolicy : null,
    ),
    resolveEffective: vi.fn(async () => feePolicy),
  } as FeePoliciesRepo;

  const auditRepo: AuditRepo = {
    log: vi.fn(async () => undefined),
  } as AuditRepo;

  const eventUnlocksRepo = {
    isUnlocked: vi.fn(async () => options?.isUnlocked ?? false),
  };

  const seatsRepo = {
    findByIdsForUpdate: vi.fn(async () => []),
    updateStatuses: vi.fn(async () => undefined),
    reserveForHold: vi.fn(async () => []),
    releaseSeats: vi.fn(async () => undefined),
    releaseExpiredHolds: vi.fn(async () => 0),
  };

  const ordersRepo: OrdersRepo = {
    createPending: vi.fn(async (input) => {
      lastCreateInput = input;
      const items = input.items.map((item, index) =>
        makeOrderItem({
          id: nextItemId(),
          qty: item.qty,
          unitPriceCents: item.unitPriceCents,
          amountCents: item.amountCents,
          meta: item.meta ?? {},
        }),
      );
      orderStore = makeOrderRecord({
        id: DEFAULT_ORDER_ID,
        amountGrossCents: input.amountGrossCents,
        feesPlatformCents: input.feesPlatformCents,
        currency: input.currency,
        items,
      });
      return {
        id: DEFAULT_ORDER_ID,
        amountGrossCents: input.amountGrossCents,
        feesPlatformCents: input.feesPlatformCents,
        currency: input.currency,
      };
    }),
    getById: vi.fn(async (orderId: string) =>
      orderId === DEFAULT_ORDER_ID ? orderStore : null,
    ),
    updatePendingItems: vi.fn(async (input) => {
      lastUpdateInput = input;
      const items = input.items.map((item, index) =>
        makeOrderItem({
          id: nextItemId(),
          qty: item.qty,
          unitPriceCents: item.unitPriceCents,
          amountCents: item.amountCents,
          meta: item.meta ?? {},
        }),
      );
      orderStore = makeOrderRecord({
        id: input.orderId,
        amountGrossCents: input.amountGrossCents,
        feesPlatformCents: input.feesPlatformCents,
        currency: input.currency,
        items,
      });
      return orderStore;
    }),
    listForOrg: vi.fn(async () => ({
      items: [],
      total: 0,
      limit: 0,
      offset: 0,
    })),
    listForHumanOwnedEvents: vi.fn(async () => ({
      items: [],
      total: 0,
      limit: 0,
      offset: 0,
    })),
    listByBuyer: vi.fn(async () => ({
      items: [],
      total: 0,
      limit: 0,
      offset: 0,
    })),
    linkPaymentIntent: vi.fn(async () => undefined),
    findByPaymentIntent: vi.fn(async () => null),
    markSucceeded: vi.fn(async () => undefined),
    markProcessing: vi.fn(async () => undefined),
    markRefunded: vi.fn(async () => undefined),
    markPaidOut: vi.fn(async () => undefined),
    cancelProcessingOrder: vi.fn(async () => true),
    setPaymentMethodType: vi.fn(),
  } as OrdersRepo;

  // Inventory side of the pre-charge capacity gate. `held` models OTHER
  // buyers' carts only — the order under edit is excluded by the use case via
  // `excludeOrderId`, which the capacity specs assert on directly.
  const ticketsRepo = {
    lockAndCountCapacityForTicketType: vi.fn(async () => ({
      issued: issuedForTicketType,
      held: heldForTicketType,
    })),
    countIssuedForTicketType: vi.fn(async () => issuedForTicketType),
  };

  // The hold looks allowance up on the NON-transaction repos, before its
  // transaction opens (a failed SELECT would abort the transaction).
  // `reserve` must never be called from here (the charge reserves).
  const feeWaiversRepo = {
    resolveApplicable: vi.fn(async () => {
      const waivers = options?.feeWaivers ?? [];
      if (waivers === "throws") throw new Error("fee_waivers_down");
      return waivers.map((w, i) => ({
        id: `waiver-${i}`,
        ...w,
        ticketsRemaining: w.ticketsGranted - w.ticketsUsed,
      }));
    }),
    reserve: vi.fn(),
  };
  // The transaction's handle models Postgres: ANY fee-waiver statement on it
  // is a test failure (it must not be there), and once one has failed every
  // later statement on the transaction would raise 25P02.
  const txFeeWaiversRepo = {
    resolveApplicable: vi.fn(async () => {
      throw new Error("fee-waiver lookup ran ON the transaction");
    }),
    reserve: vi.fn(async () => {
      throw new Error("the hold must never reserve");
    }),
  };

  // The tax self-heal stamp is written AFTER the hold's transaction commits,
  // on the non-transaction repos. On the transaction's handle it is a test
  // failure (a swallowed failed write there condemns the transaction). Same
  // vi.fn method objects otherwise, so mockImplementation reaches both.
  const txEventsUpdateTaxRate = vi.fn(async () => {
    throw new Error("tax self-heal written ON the hold's transaction");
  });
  // The after-commit write is the compare-and-set `fillTaxRateIfUnset`.
  const nonTxEventsUpdateTaxRate = vi.fn(async () => true);
  (eventsRepo as any).fillTaxRateIfUnset = nonTxEventsUpdateTaxRate;

  const txRepos: TxRepos = {
    feeWaivers: txFeeWaiversRepo as any,
    events: {
      ...eventsRepo,
      updateTaxRate: txEventsUpdateTaxRate,
      fillTaxRateIfUnset: txEventsUpdateTaxRate,
    } as EventsRepo,
    agreements: agreementsRepo,
    payoutTerms: agreementsRepo,
    feePolicies: feePoliciesRepo,
    orders: ordersRepo,
    audit: auditRepo,
    profiles: {} as any,
    tickets: ticketsRepo as any,
    seats: seatsRepo as any,
    eventUnlocks: eventUnlocksRepo as any,
    humans: {} as any,
    payees: {} as any,
    settlements: {} as any,
    resaleListings: {} as any,
    idempotency: {} as any,
    authz: {} as any,
    apiKeys: {} as any,
    organizations: {} as any,
    places: {} as any,
    savedLocations: {} as any,
    splits: {} as any,
  } as unknown as TxRepos;

  const repos: Repos = {
    events: eventsRepo,
    agreements: agreementsRepo,
    payoutTerms: agreementsRepo,
    feePolicies: feePoliciesRepo,
    orders: ordersRepo,
    audit: auditRepo,
    profiles: {} as any,
    tickets: ticketsRepo as any,
    seats: seatsRepo as any,
    eventUnlocks: eventUnlocksRepo as any,
    humans: {} as any,
    payees: {} as any,
    settlements: {} as any,
    resaleListings: {} as any,
    idempotency: {} as any,
    authz: {} as any,
    apiKeys: {} as any,
    organizations: {} as any,
    places: {} as any,
    savedLocations: {} as any,
    splits: {} as any,
    feeWaivers: feeWaiversRepo as any,
    tx: async <T>(fn: (tx: TxRepos) => Promise<T>) => fn(txRepos),
  } as unknown as Repos;

  const deps: UpdateOrderItemsDeps = {
    repos,
    clock: { now: () => now },
    logger: createTestLogger(),
  };

  return {
    deps,
    now,
    state: {
      get order() {
        return orderStore;
      },
      get lastUpdateInput() {
        return lastUpdateInput;
      },
      get lastCreateInput() {
        return lastCreateInput;
      },
    },
    fakes: {
      feeWaiversRepo,
      txFeeWaiversRepo,
      txEventsUpdateTaxRate,
      nonTxEventsUpdateTaxRate,
      eventsRepo,
      ordersRepo,
      seatsRepo,
      auditRepo,
      eventUnlocksRepo,
      ticketsRepo,
    },
  };
}

describe("updateOrderItems", () => {
  it("creates a pending order and assigns a hold timer", async () => {
    const ctx = makeContext();

    const result = await updateOrderItems(ctx.deps, {
      actorHumanId: DEFAULT_ACTOR_ID,
      eventId: DEFAULT_EVENT_ID,
      items: [{ ticketTypeId: DEFAULT_TICKET_TYPE_ID, qty: 2 }],
    });

    expect(result.order.id).toEqual(DEFAULT_ORDER_ID);
    expect(ctx.state.lastCreateInput).not.toBeNull();
    const holdExpiresAt = new Date(result.holdExpiresAt);
    expect(holdExpiresAt.getTime()).toBeGreaterThan(ctx.now.getTime());
    expect(ctx.state.order?.items[0]?.meta).toMatchObject({
      holdExpiresAt: result.holdExpiresAt,
    });
  });

  it("updates a pending order when an order id is provided", async () => {
    const existingOrder = makeOrderRecord();
    const ctx = makeContext({ existingOrder });

    const result = await updateOrderItems(ctx.deps, {
      actorHumanId: DEFAULT_ACTOR_ID,
      eventId: DEFAULT_EVENT_ID,
      orderId: DEFAULT_ORDER_ID,
      items: [{ ticketTypeId: DEFAULT_TICKET_TYPE_ID, qty: 3 }],
    });

    expect(result.order.id).toEqual(DEFAULT_ORDER_ID);
    expect(ctx.state.lastUpdateInput?.orderId).toEqual(DEFAULT_ORDER_ID);
    // With item-per-ticket model, 3 tickets = 3 OrderItems with qty=1 each
    expect(ctx.state.order?.items.length).toEqual(3);
    expect(ctx.state.order?.items.every((item) => item.qty === 1)).toBe(true);
  });

  it("refuses to edit a PENDING order once a PaymentIntent is linked, before any read or write", async () => {
    // Money audit 2026-09-08 #11. `createCheckout` mints the PaymentIntent at
    // the order's CURRENT amount. Re-pricing the lines afterwards leaves the
    // PI's amount != the order's, and `finalizePaymentIntent` refuses that
    // with AMOUNT_MISMATCH into the DLQ: buyer charged, no tickets. The web
    // client never does this (it re-runs `createCheckout` with
    // `pendingOrderId`, which retires the cart); this is the API-level guard.
    const existingOrder = makeOrderRecord({
      stripePaymentIntentId: "pi_fixed_amount",
    });
    const ctx = makeContext({ existingOrder });

    await expect(
      updateOrderItems(ctx.deps, {
        actorHumanId: DEFAULT_ACTOR_ID,
        eventId: DEFAULT_EVENT_ID,
        orderId: DEFAULT_ORDER_ID,
        items: [{ ticketTypeId: DEFAULT_TICKET_TYPE_ID, qty: 3 }],
      }),
    ).rejects.toMatchObject({ code: "ORDER_HAS_PAYMENT_INTENT" });

    // Refused at the order guard: nothing past it is read, nothing is written.
    expect(ctx.fakes.eventsRepo.listTicketTypes).not.toHaveBeenCalled();
    expect(ctx.fakes.ordersRepo.updatePendingItems).not.toHaveBeenCalled();
    expect(ctx.fakes.seatsRepo.releaseSeats).not.toHaveBeenCalled();
    expect(ctx.fakes.auditRepo.log).not.toHaveBeenCalled();
    expect(ctx.state.order?.stripePaymentIntentId).toBe("pi_fixed_amount");
    expect(ctx.state.order?.items).toHaveLength(1);
  });

  it("refuses a checkout order whose PaymentIntent is still being created (no PI linked yet)", async () => {
    // `createCheckout` commits the order first and links its PaymentIntent in
    // a second write, so no Stripe call runs inside its transaction. In
    // between, the row is PENDING with no PI, exactly like a cart. Re-pricing
    // it there reopens #11: the PI is created at the amount checkout priced,
    // the lines no longer match, finalize refuses with AMOUNT_MISMATCH.
    // Checkout stamps `termsAcceptedAt` in the creating INSERT; carts never do.
    const existingOrder = makeOrderRecord({
      stripePaymentIntentId: null,
      termsAcceptedAt: new Date("2025-01-01T00:00:00.000Z"),
    });
    const ctx = makeContext({ existingOrder });

    await expect(
      updateOrderItems(ctx.deps, {
        actorHumanId: DEFAULT_ACTOR_ID,
        eventId: DEFAULT_EVENT_ID,
        orderId: DEFAULT_ORDER_ID,
        items: [{ ticketTypeId: DEFAULT_TICKET_TYPE_ID, qty: 3 }],
      }),
    ).rejects.toMatchObject({ code: "ORDER_HAS_PAYMENT_INTENT" });

    expect(ctx.fakes.eventsRepo.listTicketTypes).not.toHaveBeenCalled();
    expect(ctx.fakes.ordersRepo.updatePendingItems).not.toHaveBeenCalled();
    expect(ctx.fakes.seatsRepo.releaseSeats).not.toHaveBeenCalled();
    expect(ctx.fakes.auditRepo.log).not.toHaveBeenCalled();
    expect(ctx.state.order?.items).toHaveLength(1);
  });

  it("still edits a PENDING order that has no PaymentIntent yet", async () => {
    const existingOrder = makeOrderRecord({ stripePaymentIntentId: null });
    const ctx = makeContext({ existingOrder });

    const result = await updateOrderItems(ctx.deps, {
      actorHumanId: DEFAULT_ACTOR_ID,
      eventId: DEFAULT_EVENT_ID,
      orderId: DEFAULT_ORDER_ID,
      items: [{ ticketTypeId: DEFAULT_TICKET_TYPE_ID, qty: 2 }],
    });

    expect(result.order.id).toEqual(DEFAULT_ORDER_ID);
    expect(ctx.fakes.ordersRepo.updatePendingItems).toHaveBeenCalledTimes(1);
    expect(ctx.state.order?.items).toHaveLength(2);
  });

  it("refuses with ORDER_NOT_PENDING when the order is finalized between the check and the guarded write", async () => {
    // TOCTOU: the order is PENDING when the transaction reads it, but finalize
    // commits SUCCEEDED before the re-price lands. The repo's guarded write
    // matches no row and returns null; the use case must refuse, not audit a
    // write that never happened (the real transaction rolls back the seat work on the throw; the fake
    // cannot show it).
    const existingOrder = makeOrderRecord({ stripePaymentIntentId: null });
    const ctx = makeContext({ existingOrder });
    vi.mocked(ctx.fakes.ordersRepo.updatePendingItems).mockImplementationOnce(
      async () => {
        vi.mocked(ctx.fakes.ordersRepo.getById).mockResolvedValue(
          makeOrderRecord({ status: "SUCCEEDED" }),
        );
        return null;
      },
    );

    await expect(
      updateOrderItems(ctx.deps, {
        actorHumanId: DEFAULT_ACTOR_ID,
        eventId: DEFAULT_EVENT_ID,
        orderId: DEFAULT_ORDER_ID,
        items: [{ ticketTypeId: DEFAULT_TICKET_TYPE_ID, qty: 3 }],
      }),
    ).rejects.toMatchObject({ code: "ORDER_NOT_PENDING" });

    expect(ctx.fakes.ordersRepo.updatePendingItems).toHaveBeenCalledTimes(1);
    expect(ctx.fakes.auditRepo.log).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "pending_updated" }),
    );
  });

  it("refuses with ORDER_HAS_PAYMENT_INTENT when checkout claims the cart between the check and the guarded write", async () => {
    const existingOrder = makeOrderRecord({ stripePaymentIntentId: null });
    const ctx = makeContext({ existingOrder });
    vi.mocked(ctx.fakes.ordersRepo.updatePendingItems).mockImplementationOnce(
      async () => {
        vi.mocked(ctx.fakes.ordersRepo.getById).mockResolvedValue(
          makeOrderRecord({ stripePaymentIntentId: "pi_raced" }),
        );
        return null;
      },
    );

    await expect(
      updateOrderItems(ctx.deps, {
        actorHumanId: DEFAULT_ACTOR_ID,
        eventId: DEFAULT_EVENT_ID,
        orderId: DEFAULT_ORDER_ID,
        items: [{ ticketTypeId: DEFAULT_TICKET_TYPE_ID, qty: 3 }],
      }),
    ).rejects.toMatchObject({ code: "ORDER_HAS_PAYMENT_INTENT" });

    expect(ctx.fakes.auditRepo.log).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "pending_updated" }),
    );
  });

  it("PASS_THROUGH: returns the grossed-up processor fee over the post-tax base", async () => {
    // Default fixture is PASS_THROUGH (agreement + policy feeMode), $10 ticket,
    // 5% buyer fee → $0.50 platform fee, 2.9% + $0.30 processor, no tax.
    const ctx = makeContext();

    const result = await updateOrderItems(ctx.deps, {
      actorHumanId: DEFAULT_ACTOR_ID,
      eventId: DEFAULT_EVENT_ID,
      items: [{ ticketTypeId: DEFAULT_TICKET_TYPE_ID, qty: 1 }],
    });

    // gross-up base = 1000 (ticket) + 50 (platform) + 0 (tax) = 1050;
    // simple markup would be ceil(1050*0.029+30)=61, the gross-up is 63 so the
    // net lands exactly on 1050 after Stripe's ceil'd deduction.
    expect(result.order.processorFeeCents).toBe(63);
  });

  it("PASS_THROUGH: gross-up base includes order tax", async () => {
    const ctx = makeContext();
    // Stamp a 10% admission tax on the event the fakes return.
    (ctx.fakes.eventsRepo.getById as any).mockImplementation(
      async (id: string) =>
        id === DEFAULT_EVENT_ID
          ? {
              id: DEFAULT_EVENT_ID,
              orgId: "org-1",
              humanId: null,
              title: "Launch Party",
              status: "PUBLISHED",
              startsAt: new Date("2025-02-01T20:00:00.000Z"),
              endsAt: null,
              currency: "usd",
              gateType: "NONE",
              admissionTaxRateBps: 1000,
            }
          : null,
    );

    const result = await updateOrderItems(ctx.deps, {
      actorHumanId: DEFAULT_ACTOR_ID,
      eventId: DEFAULT_EVENT_ID,
      items: [{ ticketTypeId: DEFAULT_TICKET_TYPE_ID, qty: 1 }],
    });

    // tax = round(1000 * 1000 / 10_000) = 100; base = 1000 + 50 + 100 = 1150.
    const expected = (() => {
      const spf = (b: number) => Math.ceil(b * 0.029 + 30);
      let charge = Math.ceil((1150 + 30) / (1 - 0.029));
      while (charge > 1150 && charge - 1 - spf(charge - 1) >= 1150) charge -= 1;
      while (charge - spf(charge) < 1150) charge += 1;
      return charge - 1150;
    })();
    expect(result.order.processorFeeCents).toBe(expected);
  });

  it("US/TN: the HELD estimate solves the fee against the widened tax base", async () => {
    // The hold has to quote what create-checkout will charge. In Tennessee the
    // tax covers the processing fee and the fee is grossed up over the tax, so
    // a hold that priced the fee against a face-only tax would move the total
    // under the buyer at the charge step.
    const ctx = makeContext();
    (ctx.fakes.eventsRepo.getById as any).mockImplementation(
      async (id: string) =>
        id === DEFAULT_EVENT_ID
          ? {
              id: DEFAULT_EVENT_ID,
              orgId: "org-1",
              humanId: null,
              title: "Launch Party",
              status: "PUBLISHED",
              startsAt: new Date("2025-02-01T20:00:00.000Z"),
              endsAt: null,
              currency: "usd",
              gateType: "NONE",
              admissionTaxRateBps: 1000,
              // Inline Nashville jurisdiction — no Place / SavedLocation read.
              placeId: null,
              savedLocationId: null,
              postalCode: "37203",
              countryCode: "US",
              region: "TN",
            }
          : null,
    );

    const result = await updateOrderItems(ctx.deps, {
      actorHumanId: DEFAULT_ACTOR_ID,
      eventId: DEFAULT_EVENT_ID,
      items: [{ ticketTypeId: DEFAULT_TICKET_TYPE_ID, qty: 1 }],
    });

    // netBase = 1000 gross + 50 platform = 1050. The expectation comes from the
    // INDEPENDENT brute-force oracle (smallest self-consistent tax/fee pair),
    // not from a second copy of the production loop — a copy would agree with a
    // drifted loop.
    const { taxCents, processorFeeCents } = referenceBuyerTotalTax(
      1050,
      1000,
      0.029,
      30,
    );
    expect(taxCents).toBe(112);
    expect(result.order.processorFeeCents).toBe(processorFeeCents);
    // Strictly MORE than the face-only base charged (that case is the test
    // above: tax 100 → fee 63).
    expect(result.order.processorFeeCents).toBeGreaterThan(63);
  });

  it("a local BUYER_TOTAL imposition moves the HELD fee exactly as the charge does", async () => {
    const ctx = makeContext();
    (ctx.fakes.eventsRepo.getById as any).mockImplementation(
      async (id: string) =>
        id === DEFAULT_EVENT_ID
          ? {
              id: DEFAULT_EVENT_ID,
              orgId: "org-1",
              humanId: null,
              title: "Launch Party",
              status: "PUBLISHED",
              startsAt: new Date("2025-02-01T20:00:00.000Z"),
              endsAt: null,
              currency: "usd",
              gateType: "NONE",
              admissionTaxRateBps: 1000,
              placeId: null,
              savedLocationId: null,
              postalCode: "60614",
              countryCode: "US",
              region: "IL",
            }
          : null,
    );
    localTaxRules.rules = [
      {
        code: "CHI_AMUSEMENT",
        label: "Chicago amusement tax",
        jurisdiction: "US/IL/Chicago",
        countryCode: "US",
        region: "IL",
        postalCodes: ["60614"],
        rateBps: 900,
        base: "BUYER_TOTAL",
        collector: "PLATFORM",
        source: "TEST FIXTURE — not a real citation",
      },
    ];
    let result;
    try {
      result = await updateOrderItems(ctx.deps, {
        actorHumanId: DEFAULT_ACTOR_ID,
        eventId: DEFAULT_EVENT_ID,
        items: [{ ticketTypeId: DEFAULT_TICKET_TYPE_ID, qty: 1 }],
      });
    } finally {
      localTaxRules.rules = null;
    }

    // Independent brute force: IL sales tax is face-only (100¢ on 1000); the
    // city line taxes net + fee, and the fee is grossed up over BOTH taxes.
    const net = 1050;
    const faceTax = 100;
    let expectedFee = -1;
    for (let cityTax = 0; cityTax < 1000; cityTax += 1) {
      const fee = solveProcessingFeeGrossUp(net + faceTax + cityTax, 0.029, 30);
      if (Math.round(((net + fee) * 900) / 10_000) === cityTax) {
        expectedFee = fee;
        break;
      }
    }
    expect(result.order.processorFeeCents).toBe(expectedFee);
    // Sales-only would have been 63 (the 10% face-tax test above).
    expect(result.order.processorFeeCents).toBeGreaterThan(63);
  });

  it("terms and policy still saying ABSORB: the held cart quotes the PASS_THROUGH gross-up", async () => {
    // ABSORB is removed (docs/decisions/absorb-removed.md). This used to keep
    // the simple markup (61). A legacy row now prices exactly like the
    // PASS_THROUGH default above: the exact gross-up, 63.
    const ctx = makeContext({ feeMode: "ABSORB" });

    const result = await updateOrderItems(ctx.deps, {
      actorHumanId: DEFAULT_ACTOR_ID,
      eventId: DEFAULT_EVENT_ID,
      items: [{ ticketTypeId: DEFAULT_TICKET_TYPE_ID, qty: 1 }],
    });

    expect(result.order.processorFeeCents).toBe(63);
  });

  it("rejects gated events before ticket lookup, seat holds, or order creation", async () => {
    const ctx = makeContext({ gateType: "PASSWORD", isUnlocked: false });

    await expect(
      updateOrderItems(ctx.deps, {
        actorHumanId: DEFAULT_ACTOR_ID,
        eventId: DEFAULT_EVENT_ID,
        items: [{ ticketTypeId: DEFAULT_TICKET_TYPE_ID, qty: 1 }],
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(ctx.fakes.eventUnlocksRepo.isUnlocked).toHaveBeenCalledWith(
      DEFAULT_EVENT_ID,
      DEFAULT_ACTOR_ID,
    );
    expect(ctx.fakes.eventsRepo.listTicketTypes).not.toHaveBeenCalled();
    expect(ctx.fakes.seatsRepo.reserveForHold).not.toHaveBeenCalled();
    expect(ctx.fakes.ordersRepo.createPending).not.toHaveBeenCalled();
    expect(ctx.fakes.auditRepo.log).not.toHaveBeenCalled();
  });
});


/**
 * FR-005 on the cart-hold path. `updateOrderItems` is the number the buyer
 * sees BEFORE they reach the PaymentIntent, so it has to resolve the schedule
 * at the same instant `createCheckout` will — otherwise the cart quotes $12
 * and the charge takes $20.
 */
describe("updateOrderItems — scheduled price change (FR-005)", () => {
  const FLIP_AT = new Date("2025-01-15T12:00:00.000Z");

  async function priceCart(now: Date, scheduled = true) {
    const ctx = makeContext({
      now,
      scheduledPriceCents: scheduled ? 2000 : null,
      scheduledPriceAt: scheduled ? FLIP_AT : null,
    });

    const result = await updateOrderItems(ctx.deps, {
      actorHumanId: DEFAULT_ACTOR_ID,
      eventId: DEFAULT_EVENT_ID,
      items: [{ ticketTypeId: DEFAULT_TICKET_TYPE_ID, qty: 2 }],
    });

    return { ctx, result };
  }

  it("holds at the pre-flip price before T", async () => {
    const { result } = await priceCart(new Date(FLIP_AT.getTime() - 1));
    // 2 × the harness's $10 list price
    expect(result.order.amountGrossCents).toBe(2000);
  });

  it("holds at the post-flip price at exactly T", async () => {
    const { result } = await priceCart(new Date(FLIP_AT.getTime()));
    // 2 × $20
    expect(result.order.amountGrossCents).toBe(4000);
  });

  it("NFR-001: an unscheduled type prices identically on both sides of T", async () => {
    const before = await priceCart(new Date(FLIP_AT.getTime() - 1), false);
    const at = await priceCart(new Date(FLIP_AT.getTime()), false);
    expect(before.result.order.amountGrossCents).toBe(2000);
    expect(at.result.order.amountGrossCents).toBe(2000);
  });
});

/**
 * FR-014 on the cart-hold path. `updateOrderItems` is a MUTATION — it holds
 * seats and writes a PENDING order — so it is a money site in its own right,
 * not merely a quote. A tier outside its window must be refused here as well as
 * at createCheckout; otherwise a buyer holds inventory for something they can
 * never be charged for.
 */
describe("updateOrderItems — sales window (FR-014)", () => {
  const OPENS_AT = new Date("2025-01-10T12:00:00.000Z");
  const CLOSES_AT = new Date("2025-01-20T12:00:00.000Z");

  const hold = (ctx: ReturnType<typeof makeContext>) =>
    updateOrderItems(ctx.deps, {
      actorHumanId: DEFAULT_ACTOR_ID,
      eventId: DEFAULT_EVENT_ID,
      items: [{ ticketTypeId: DEFAULT_TICKET_TYPE_ID, qty: 2 }],
    });

  const assertNothingHeld = (ctx: ReturnType<typeof makeContext>) => {
    expect(ctx.fakes.ordersRepo.createPending).not.toHaveBeenCalled();
    expect(ctx.fakes.ordersRepo.updatePendingItems).not.toHaveBeenCalled();
    expect(ctx.fakes.seatsRepo.reserveForHold).not.toHaveBeenCalled();
  };

  it("refuses before the window opens and holds nothing", async () => {
    const ctx = makeContext({
      salesOpenAt: OPENS_AT,
      salesCloseAt: CLOSES_AT,
      now: new Date(OPENS_AT.getTime() - 1),
    });

    await expect(hold(ctx)).rejects.toMatchObject({
      code: "TICKET_TYPE_NOT_YET_ON_SALE",
    });
    assertNothingHeld(ctx);
  });

  it("holds at exactly the open instant (INCLUSIVE)", async () => {
    const ctx = makeContext({
      salesOpenAt: OPENS_AT,
      salesCloseAt: CLOSES_AT,
      now: new Date(OPENS_AT.getTime()),
    });

    const result = await hold(ctx);

    expect(result.order.amountGrossCents).toBe(2000);
  });

  it("refuses at exactly the close instant (EXCLUSIVE) and holds nothing", async () => {
    const ctx = makeContext({
      salesOpenAt: OPENS_AT,
      salesCloseAt: CLOSES_AT,
      now: new Date(CLOSES_AT.getTime()),
    });

    await expect(hold(ctx)).rejects.toMatchObject({
      code: "TICKET_TYPE_SALES_ENDED",
    });
    assertNothingHeld(ctx);
  });

  it("NFR-001: an unwindowed type holds at every one of those instants", async () => {
    for (const now of [
      new Date(OPENS_AT.getTime() - 1),
      new Date(CLOSES_AT.getTime()),
    ]) {
      const ctx = makeContext({ now });
      const result = await hold(ctx);
      expect(result.order.amountGrossCents).toBe(2000);
    }
  });
});

// ── Pre-charge capacity gate ────────────────────────────────────────────────
//
// A cart hold is a reservation, so it is refused for the same reason a charge
// is. Letting a buyer hold stock that does not exist just moves the failure to
// the payment step — or, before this gate existed, to the mint webhook, after
// the card was charged.
describe("updateOrderItems — capacity", () => {
  const holdFor = (
    ctx: ReturnType<typeof makeContext>,
    qty: number,
    orderId?: string,
  ) =>
    updateOrderItems(ctx.deps, {
      actorHumanId: DEFAULT_ACTOR_ID,
      eventId: DEFAULT_EVENT_ID,
      ...(orderId ? { orderId } : {}),
      items: [{ ticketTypeId: DEFAULT_TICKET_TYPE_ID, qty }],
    });

  it("refuses a hold on a fully-issued tier and writes no order", async () => {
    const ctx = makeContext({ capacity: 10, issuedForTicketType: 10 });

    await expect(holdFor(ctx, 2)).rejects.toMatchObject({
      code: "TICKET_TYPE_SOLD_OUT",
    });
    expect(ctx.fakes.ordersRepo.createPending).not.toHaveBeenCalled();
    expect(ctx.fakes.ordersRepo.updatePendingItems).not.toHaveBeenCalled();
  });

  it("permits issued + requested === capacity", async () => {
    const ctx = makeContext({ capacity: 10, issuedForTicketType: 8 });

    await expect(holdFor(ctx, 2)).resolves.toMatchObject({
      order: { id: DEFAULT_ORDER_ID },
    });
    expect(ctx.fakes.ordersRepo.createPending).toHaveBeenCalledTimes(1);
  });

  it("refuses issued + requested === capacity + 1", async () => {
    const ctx = makeContext({ capacity: 10, issuedForTicketType: 9 });

    await expect(holdFor(ctx, 2)).rejects.toMatchObject({
      code: "TICKET_TYPE_SOLD_OUT",
    });
    expect(ctx.fakes.ordersRepo.createPending).not.toHaveBeenCalled();
  });

  it("counts another cart's live hold against a new hold", async () => {
    const ctx = makeContext({
      capacity: 10,
      issuedForTicketType: 8,
      heldForTicketType: 1,
    });

    await expect(holdFor(ctx, 2)).rejects.toMatchObject({
      code: "TICKET_TYPE_TEMPORARILY_HELD",
    });
    expect(ctx.fakes.ordersRepo.createPending).not.toHaveBeenCalled();
  });

  it("excludes the order being edited from its own held count", async () => {
    // Without this a buyer holding 2 of a 10-capacity tier could not change
    // their own cart: their existing lines would be counted against them.
    const ctx = makeContext({
      capacity: 10,
      existingOrder: makeOrderRecord(),
    });

    await holdFor(ctx, 2, DEFAULT_ORDER_ID);

    expect(
      ctx.fakes.ticketsRepo.lockAndCountCapacityForTicketType,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ excludeOrderId: DEFAULT_ORDER_ID }),
    );
  });

  it("excludes nothing when creating a brand-new cart", async () => {
    const ctx = makeContext({ capacity: 10 });

    await holdFor(ctx, 2);

    expect(
      ctx.fakes.ticketsRepo.lockAndCountCapacityForTicketType,
    ).toHaveBeenCalledWith(expect.objectContaining({ excludeOrderId: null }));
  });

  it("takes the capacity lock before any seat lock", async () => {
    const ctx = makeContext({ capacity: 10 });
    const order: string[] = [];

    ctx.fakes.ticketsRepo.lockAndCountCapacityForTicketType.mockImplementation(
      async () => {
        order.push("capacity");
        return { issued: 0, held: 0 };
      },
    );
    ctx.fakes.seatsRepo.releaseExpiredHolds.mockImplementation(async () => {
      order.push("seats");
      return 0;
    });

    await holdFor(ctx, 2);

    expect(order).toEqual(["capacity", "seats"]);
  });
});

/**
 * The previous-seat release: the buyer edits a cart that already holds seats,
 * so those seats have to go back before the re-hold can take them.
 *
 * The list comes from `existing.items[].meta.seatIds`, and it is NOT
 * self-evidently still ours. A PENDING cart lives up to the cart TTL (1200s)
 * plus a cron period; the seat-hold TTL is 900s. So the seat reaper can free
 * these seats out from under the cart, another buyer can hold and PAY for one,
 * and an unfenced `releaseSeats` — which only knows `status = "HELD"` — hands
 * that seat straight back to the pool. Sold twice, minted once.
 */
describe("updateOrderItems — the previous-seat release is fenced", () => {
  const T0 = new Date("2025-01-01T00:00:00.000Z");
  const ORDER_HOLD_TTL_SECONDS = 900;
  const FENCE_SLACK_SECONDS = 60;
  const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);
  const holdStampedAt = (instant: Date) =>
    new Date(
      instant.getTime() + ORDER_HOLD_TTL_SECONDS * 1000,
    ).toISOString();

  const SEAT_MINE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const SEAT_THEIRS = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

  function cartHolding(seatIds: string[], heldAt: Date = T0) {
    return makeOrderRecord({
      occurredAt: T0,
      items: [
        makeOrderItem({
          meta: { seatIds, holdExpiresAt: holdStampedAt(heldAt) },
        }),
      ],
    });
  }

  /**
   * Seat status AND `updatedAt` as real state, behaving exactly like the
   * Prisma adapter's `releaseSeats`: `status: "HELD"` plus, when the caller
   * passes one, `updatedAt: { lte: heldBefore }`. A call-shape assertion
   * cannot tell you whether the row actually moved.
   */
  function withSeatState(
    ctx: ReturnType<typeof makeContext>,
    updatedAt: Record<string, Date>,
  ) {
    const status = new Map<string, "AVAILABLE" | "HELD">();
    const stamps = new Map<string, Date>();
    for (const [id, when] of Object.entries(updatedAt)) {
      status.set(id, "HELD");
      stamps.set(id, when);
    }
    ctx.fakes.seatsRepo.releaseSeats.mockImplementation(
      async (input: {
        seatIds: string[];
        releasedAt: Date;
        heldBefore?: Date;
      }) => {
        for (const id of input.seatIds) {
          if (status.get(id) !== "HELD") continue;
          const stamp = stamps.get(id);
          if (
            input.heldBefore &&
            stamp &&
            stamp.getTime() > input.heldBefore.getTime()
          ) {
            continue;
          }
          status.set(id, "AVAILABLE");
          stamps.set(id, input.releasedAt);
        }
      },
    );
    return status;
  }

  it("fences the release to the cart's own hold plus the slack", async () => {
    const ctx = makeContext({
      existingOrder: cartHolding([SEAT_MINE]),
      now: at(1000),
    });

    await updateOrderItems(ctx.deps, {
      actorHumanId: DEFAULT_ACTOR_ID,
      eventId: DEFAULT_EVENT_ID,
      orderId: DEFAULT_ORDER_ID,
      items: [{ ticketTypeId: DEFAULT_TICKET_TYPE_ID, qty: 1 }],
    });

    expect(ctx.fakes.seatsRepo.releaseSeats).toHaveBeenCalledWith({
      seatIds: [SEAT_MINE],
      releasedAt: at(1000),
      heldBefore: at(FENCE_SLACK_SECONDS),
    });
  });

  it("does NOT free a seat re-held by a different, live order", async () => {
    // The seat reaper freed SEAT_THEIRS at T0+900; another buyer took it at
    // T0+960 and their PaymentIntent is live. It is HELD, exactly like ours.
    const ctx = makeContext({
      existingOrder: cartHolding([SEAT_MINE, SEAT_THEIRS]),
      now: at(1000),
    });
    const status = withSeatState(ctx, {
      [SEAT_MINE]: T0,
      [SEAT_THEIRS]: at(960),
    });

    await updateOrderItems(ctx.deps, {
      actorHumanId: DEFAULT_ACTOR_ID,
      eventId: DEFAULT_EVENT_ID,
      orderId: DEFAULT_ORDER_ID,
      items: [{ ticketTypeId: DEFAULT_TICKET_TYPE_ID, qty: 1 }],
    });

    expect(status.get(SEAT_MINE)).toBe("AVAILABLE");
    expect(status.get(SEAT_THEIRS)).toBe("HELD");
  });

  it("still frees the seats of a cart the buyer already edited once", async () => {
    // THE regression this fence must not cause. `updateOrderItems` re-holds
    // on every edit and never rewrites `occurredAt`, so an `occurredAt`-only
    // fence would decline the buyer's OWN seat on their second edit — and
    // `holdSeatsForCheckout` would then refuse them with `seat_unavailable`,
    // because a declined seat stays HELD.
    const firstEdit = at(300);
    const ctx = makeContext({
      existingOrder: cartHolding([SEAT_MINE], firstEdit),
      now: at(600),
    });
    const status = withSeatState(ctx, { [SEAT_MINE]: firstEdit });

    await updateOrderItems(ctx.deps, {
      actorHumanId: DEFAULT_ACTOR_ID,
      eventId: DEFAULT_EVENT_ID,
      orderId: DEFAULT_ORDER_ID,
      items: [{ ticketTypeId: DEFAULT_TICKET_TYPE_ID, qty: 1 }],
    });

    expect(status.get(SEAT_MINE)).toBe("AVAILABLE");
    expect(ctx.fakes.seatsRepo.releaseSeats).toHaveBeenCalledWith(
      expect.objectContaining({
        heldBefore: new Date(
          firstEdit.getTime() + FENCE_SLACK_SECONDS * 1000,
        ),
      }),
    );
  });

  it("releases NOTHING and reports when no fence can be computed", async () => {
    // Unreachable through the Prisma repo (`occurredAt` is NOT NULL). An
    // ownership-blind release is the double-sell above; the seat reaper is
    // the backstop.
    const order = cartHolding([SEAT_MINE]);
    order.items[0]!.meta = { seatIds: [SEAT_MINE] };
    delete (order as { occurredAt?: Date }).occurredAt;

    const reportError = vi.fn();
    const ctx = makeContext({ existingOrder: order, now: at(1000) });
    ctx.deps.reportError = reportError;

    await updateOrderItems(ctx.deps, {
      actorHumanId: DEFAULT_ACTOR_ID,
      eventId: DEFAULT_EVENT_ID,
      orderId: DEFAULT_ORDER_ID,
      items: [{ ticketTypeId: DEFAULT_TICKET_TYPE_ID, qty: 1 }],
    });

    expect(ctx.fakes.seatsRepo.releaseSeats).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "update_order_items_seat_fence_missing",
      }),
      expect.objectContaining({
        tags: expect.objectContaining({ useCase: "updateOrderItems" }),
      }),
    );
  });
});

describe("updateOrderItems — fee waivers price the hold like the charge", () => {
  // 2 × $10 at 5%, PASS_THROUGH: 50¢ platform fee per ticket.
  const hold = (ctx: ReturnType<typeof makeContext>) =>
    updateOrderItems(ctx.deps, {
      actorHumanId: DEFAULT_ACTOR_ID,
      eventId: DEFAULT_EVENT_ID,
      items: [{ ticketTypeId: DEFAULT_TICKET_TYPE_ID, qty: 2 }],
    });

  it("no allowance → the full fee (control)", async () => {
    const result = await hold(makeContext());
    expect(result.order.feesPlatformCents).toBe(100);
    expect(result.order.buyerFeesCents).toBe(100);
  });

  it("regression: one waived ticket → the hold's fee drops by that ticket's fee (was the full fee)", async () => {
    const ctx = makeContext({ feeWaivers: [{ ticketsGranted: 5, ticketsUsed: 4 }] });
    const result = await hold(ctx);
    expect(result.order.feesPlatformCents).toBe(50);
    expect(result.order.buyerFeesCents).toBe(50);
    // Persisted on the hold, not only returned.
    expect(ctx.state.lastCreateInput?.feesPlatformCents).toBe(50);
    // Read-only: the hold never reserves allowance.
    expect(ctx.fakes.feeWaiversRepo.reserve).not.toHaveBeenCalled();
  });

  it("regression: the lookup runs on the NON-transaction repos, never on the hold's transaction", async () => {
    const ctx = makeContext({ feeWaivers: [{ ticketsGranted: 5, ticketsUsed: 4 }] });
    await hold(ctx);
    expect(ctx.fakes.feeWaiversRepo.resolveApplicable).toHaveBeenCalledTimes(1);
    expect(ctx.fakes.txFeeWaiversRepo.resolveApplicable).not.toHaveBeenCalled();
    expect(ctx.fakes.txFeeWaiversRepo.reserve).not.toHaveBeenCalled();
  });

  it("headroom across allowances adds up, capped at the tickets in the cart", async () => {
    const ctx = makeContext({
      feeWaivers: [
        { ticketsGranted: 1, ticketsUsed: 0 },
        { ticketsGranted: 10, ticketsUsed: 0 },
      ],
    });
    const result = await hold(ctx);
    expect(result.order.feesPlatformCents).toBe(0);
    expect(result.order.buyerFeesCents).toBe(0);
  });

  it("a broken lookup (before the transaction) prices at the full fee and REPORTS — the transaction is never touched by it", async () => {
    const reportError = vi.fn();
    const ctx = makeContext({ feeWaivers: "throws" });
    ctx.deps.reportError = reportError;
    const result = await hold(ctx);
    expect(result.order.feesPlatformCents).toBe(100);
    // The failure happened on the non-transaction repos; the hold's
    // transaction ran clean and wrote the cart.
    expect(ctx.fakes.feeWaiversRepo.resolveApplicable).toHaveBeenCalledTimes(1);
    expect(ctx.fakes.txFeeWaiversRepo.resolveApplicable).not.toHaveBeenCalled();
    expect(ctx.state.lastCreateInput?.feesPlatformCents).toBe(100);
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "fee_waivers_down" }),
      expect.objectContaining({
        tags: expect.objectContaining({
          useCase: "updateOrderItems",
          step: "estimateFeeWaiver",
        }),
      }),
    );
  });
});

describe("updateOrderItems — the tax self-heal stamp is written after the commit", () => {
  const EVENT_VERSION = new Date("2024-12-31T08:00:00.000Z");
  const unstampedCanadianEvent = (ctx: ReturnType<typeof makeContext>) =>
    (ctx.fakes.eventsRepo.getById as any).mockImplementation(async (id: string) =>
      id === DEFAULT_EVENT_ID
        ? {
            id: DEFAULT_EVENT_ID,
            orgId: "org-1",
            humanId: null,
            title: "Launch Party",
            status: "PUBLISHED",
            startsAt: new Date("2025-02-01T20:00:00.000Z"),
            endsAt: null,
            currency: "cad",
            gateType: "NONE",
            // Never stamped: the hold resolves it (static CA map) and self-heals.
            admissionTaxRateBps: null,
            placeId: null,
            savedLocationId: null,
            postalCode: "T5J 3N9",
            countryCode: "CA",
            region: "AB",
            updatedAt: EVENT_VERSION,
          }
        : null,
    );

  it("regression: the stamp is written on the NON-transaction repos after the hold commits — never on its transaction", async () => {
    const ctx = makeContext();
    unstampedCanadianEvent(ctx);
    await updateOrderItems(ctx.deps, {
      actorHumanId: DEFAULT_ACTOR_ID,
      eventId: DEFAULT_EVENT_ID,
      items: [{ ticketTypeId: DEFAULT_TICKET_TYPE_ID, qty: 1 }],
    });
    expect(ctx.fakes.txEventsUpdateTaxRate).not.toHaveBeenCalled();
    expect(ctx.fakes.nonTxEventsUpdateTaxRate).toHaveBeenCalledWith({
      eventId: DEFAULT_EVENT_ID,
      admissionTaxRateBps: 500,
      taxRateSource: "ca_gst_hst",
      // Compare-and-set on the event row's version as the hold read it.
      expectedUpdatedAt: EVENT_VERSION,
    });
  });

  it("a failed stamp write doesn't touch the committed hold, and is REPORTED", async () => {
    const ctx = makeContext();
    unstampedCanadianEvent(ctx);
    const boom = new Error("23514 check violation");
    ctx.fakes.nonTxEventsUpdateTaxRate.mockRejectedValue(boom);
    const reportError = vi.fn();
    ctx.deps.reportError = reportError;

    const result = await updateOrderItems(ctx.deps, {
      actorHumanId: DEFAULT_ACTOR_ID,
      eventId: DEFAULT_EVENT_ID,
      items: [{ ticketTypeId: DEFAULT_TICKET_TYPE_ID, qty: 1 }],
    });

    expect(result.order.id).toBe(DEFAULT_ORDER_ID);
    expect(ctx.state.lastCreateInput).not.toBeNull();
    expect(ctx.fakes.txEventsUpdateTaxRate).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(
      boom,
      expect.objectContaining({
        extra: expect.objectContaining({
          event: "tax_rate_backfill_writeback_failed",
        }),
      }),
    );
  });
});


// ── The tax-provider lookup runs BEFORE the hold's transaction ──────────────
// `prepareCheckoutTax` does the ZipTax round trip before `repos.tx` opens;
// inside, only the prepared result is used. It used to run inside, while the
// hold held its seat / order locks.
describe("updateOrderItems — the tax-provider lookup is outside the transaction", () => {
  // Measured on the pre-change code (lookup inside the transaction). The
  // hold persists no tax, but its processor-fee quote is solved WITH the tax
  // (9.75% on the TN buyer total), so a different rate moves it.
  const PINNED_HOLD = {
    amountGrossCents: 2000,
    feesPlatformCents: 100,
    buyerFeesCents: 100,
    processorFeeCents: 101,
  };

  const unstampedNashville = (ctx: ReturnType<typeof makeContext>) => {
    const original = (ctx.fakes.eventsRepo.getById as any).getMockImplementation();
    (ctx.fakes.eventsRepo.getById as any).mockImplementation(
      async (...args: unknown[]) => {
        const event = await original(...args);
        return event
          ? {
              ...event,
              admissionTaxRateBps: null,
              placeId: null,
              savedLocationId: null,
              postalCode: "37203",
              countryCode: "US",
              region: "TN",
              updatedAt: new Date("2024-12-31T08:00:00.000Z"),
            }
          : null;
      },
    );
  };

  const trackTx = (ctx: ReturnType<typeof makeContext>) => {
    const state = { inTx: false };
    const repos = ctx.deps.repos as unknown as {
      tx: (fn: unknown, opts?: unknown) => Promise<unknown>;
    };
    const original = repos.tx;
    repos.tx = async (fn, opts) => {
      state.inTx = true;
      try {
        return await original(fn, opts);
      } finally {
        state.inTx = false;
      }
    };
    return state;
  };

  const hold = (ctx: ReturnType<typeof makeContext>, lookup: unknown) =>
    updateOrderItems(
      { ...ctx.deps, taxRateLookup: lookup as never },
      {
        actorHumanId: DEFAULT_ACTOR_ID,
        eventId: DEFAULT_EVENT_ID,
        items: [{ ticketTypeId: DEFAULT_TICKET_TYPE_ID, qty: 2 }],
      },
    );

  it("regression: the provider is called once, BEFORE the hold's transaction opens — never inside it", async () => {
    const ctx = makeContext();
    unstampedNashville(ctx);
    const tx = trackTx(ctx);
    const calledInsideTx: boolean[] = [];
    const lookupByPostalCode = vi.fn(async () => {
      calledInsideTx.push(tx.inTx);
      if (tx.inTx) throw new Error("tax provider called INSIDE the transaction");
      return { rateBps: 975, source: "ziptax" };
    });

    await hold(ctx, { lookupByPostalCode });

    expect(lookupByPostalCode).toHaveBeenCalledTimes(1);
    expect(calledInsideTx).toEqual([false]);
  });

  it("parity: the held quote for a provider-priced (unstamped) event is byte-identical to before the move", async () => {
    const ctx = makeContext();
    unstampedNashville(ctx);
    const result = await hold(ctx, {
      lookupByPostalCode: vi.fn(async () => ({ rateBps: 975, source: "ziptax" })),
    });
    expect({
      amountGrossCents: result.order.amountGrossCents,
      feesPlatformCents: result.order.feesPlatformCents,
      buyerFeesCents: result.order.buyerFeesCents,
      processorFeeCents: result.order.processorFeeCents,
    }).toEqual(PINNED_HOLD);
  });
});

// ── A refused hold does not pay for a tax-provider lookup ───────────────────
// The lookup is a paid HTTP call and nothing is cached for a refused attempt,
// so every retry of a request the transaction refuses would pay again. The
// gates the transaction opens with must therefore run (or be mirrored) before
// `prepareCheckoutTax`.
describe("updateOrderItems — a refused hold makes no tax-provider call", () => {
  const unstampedNashvilleWith = (
    ctx: ReturnType<typeof makeContext>,
    extra: Record<string, unknown> = {},
  ) => {
    const original = (ctx.fakes.eventsRepo.getById as any).getMockImplementation();
    (ctx.fakes.eventsRepo.getById as any).mockImplementation(
      async (...args: unknown[]) => {
        const event = await original(...args);
        return event
          ? {
              ...event,
              admissionTaxRateBps: null,
              placeId: null,
              savedLocationId: null,
              postalCode: "37203",
              countryCode: "US",
              region: "TN",
              updatedAt: new Date("2024-12-31T08:00:00.000Z"),
              ...extra,
            }
          : null;
      },
    );
  };

  const run = (
    ctx: ReturnType<typeof makeContext>,
    lookupByPostalCode: ReturnType<typeof vi.fn>,
    orderId?: string,
  ) =>
    updateOrderItems(
      { ...ctx.deps, taxRateLookup: { lookupByPostalCode } as never },
      {
        actorHumanId: DEFAULT_ACTOR_ID,
        eventId: DEFAULT_EVENT_ID,
        ...(orderId ? { orderId } : {}),
        items: [{ ticketTypeId: DEFAULT_TICKET_TYPE_ID, qty: 2 }],
      },
    );

  const provider = () =>
    vi.fn(async () => ({ rateBps: 975, source: "ziptax" }));

  it("control: an owned, pending cart on an on-sale unstamped event DOES call the provider once", async () => {
    const ctx = makeContext({ existingOrder: makeOrderRecord() });
    unstampedNashvilleWith(ctx);
    const lookup = provider();
    await run(ctx, lookup, DEFAULT_ORDER_ID);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("an event whose sales have closed is refused (EVENT_SALES_CLOSED) with NO provider call", async () => {
    // The default event ends 2025-02-01T20:00Z (endsAt null → startsAt).
    const ctx = makeContext({ now: new Date("2025-03-01T00:00:00.000Z") });
    unstampedNashvilleWith(ctx);
    const lookup = provider();
    await expect(run(ctx, lookup)).rejects.toMatchObject({
      code: "EVENT_SALES_CLOSED",
    });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("someone else's cart is refused (ORDER_NOT_OWNED) with NO provider call", async () => {
    const ctx = makeContext({
      existingOrder: makeOrderRecord({
        buyerHumanId: "99999999-9999-4999-8999-999999999999",
      }),
    });
    unstampedNashvilleWith(ctx);
    const lookup = provider();
    await expect(run(ctx, lookup, DEFAULT_ORDER_ID)).rejects.toMatchObject({
      code: "ORDER_NOT_OWNED",
    });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("a cart that does not exist is refused (ORDER_NOT_FOUND) with NO provider call", async () => {
    const ctx = makeContext();
    unstampedNashvilleWith(ctx);
    const lookup = provider();
    await expect(run(ctx, lookup, DEFAULT_ORDER_ID)).rejects.toMatchObject({
      code: "ORDER_NOT_FOUND",
    });
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe("updateOrderItems — a hand-entered tax rate (owner ruling R5)", () => {
  it("the hold quotes the manual stamp as is: no provider call, no report", async () => {
    const ctx = makeContext();
    const original = (ctx.fakes.eventsRepo.getById as any).getMockImplementation();
    (ctx.fakes.eventsRepo.getById as any).mockImplementation(
      async (...args: unknown[]) => {
        const event = await original(...args);
        return event
          ? {
              ...event,
              admissionTaxRateBps: 975,
              taxRateSource: "manual:event",
              placeId: null,
              savedLocationId: null,
              postalCode: "37203",
              countryCode: "US",
              region: "TN",
              updatedAt: new Date("2024-12-31T08:00:00.000Z"),
            }
          : null;
      },
    );
    // The provider is down: a relookup would wait and report on every edit.
    const lookupByPostalCode = vi.fn(async () => {
      throw new Error("provider down");
    });
    const reportError = vi.fn();
    const deps = {
      ...ctx.deps,
      reportError,
      taxRateLookup: { lookupByPostalCode } as never,
    };

    await updateOrderItems(deps, {
      actorHumanId: DEFAULT_ACTOR_ID,
      eventId: DEFAULT_EVENT_ID,
      items: [{ ticketTypeId: DEFAULT_TICKET_TYPE_ID, qty: 2 }],
    });

    expect(lookupByPostalCode).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
    expect(ctx.fakes.ordersRepo.createPending).toHaveBeenCalledTimes(1);
  });
});

// ── organiser-resale-share FR-003: a cart edit re-stamps the record ─────────
// A cart edit re-prices every line at today's prices and replaces the cart's
// items; it writes the event's clause in force now on every ticket, from one
// read, beside the price it re-reads. Nothing is sold until the cart is paid.
describe("updateOrderItems — FR-003 resale clause record", () => {
  const RESALE_TERMS_ID = "resale-terms-cart";

  const withResaleTerms = (
    ctx: ReturnType<typeof makeContext>,
    clause: {
      resaleShareType: "PERCENT" | "FLAT" | null;
      resaleShareBps: number | null;
      resaleShareCents: number | null;
      resaleSharePayer: "SELLER" | "BUYER";
      version: number;
    },
  ) => {
    const live = { ...clause };
    const getEvent = vi.mocked(ctx.fakes.eventsRepo.getById);
    const originalEvent = getEvent.getMockImplementation()!;
    getEvent.mockImplementation(async (...args) => {
      const event = await originalEvent(...args);
      return event
        ? ({ ...event, resalePayoutTermsId: RESALE_TERMS_ID } as typeof event)
        : null;
    });
    const getTerms = vi.mocked(
      (ctx.deps.repos as unknown as Repos).payoutTerms.getById,
    );
    const originalTerms = getTerms.getMockImplementation()!;
    getTerms.mockImplementation(async (id: string) => {
      const primary = await originalTerms(id);
      return id === RESALE_TERMS_ID && primary
        ? { ...primary, id: RESALE_TERMS_ID, kind: "RESALE" as const, ...live }
        : primary;
    });
    return { live, getTerms };
  };

  const resaleReads = (getTerms: ReturnType<typeof withResaleTerms>["getTerms"]) =>
    getTerms.mock.calls.filter((call) => call[0] === RESALE_TERMS_ID).length;

  it("a new cart stamps every ticket with the clause and its price", async () => {
    const ctx = makeContext();
    const { getTerms } = withResaleTerms(ctx, {
      resaleShareType: "PERCENT",
      resaleShareBps: 1000,
      resaleShareCents: null,
      resaleSharePayer: "SELLER",
      version: 2,
    });

    await updateOrderItems(ctx.deps, {
      actorHumanId: DEFAULT_ACTOR_ID,
      eventId: DEFAULT_EVENT_ID,
      items: [{ ticketTypeId: DEFAULT_TICKET_TYPE_ID, qty: 2 }],
    });

    const items = ctx.state.lastCreateInput!.items;
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item).toMatchObject({
        resaleClauseType: "PERCENT",
        resaleClauseBps: 1000,
        resaleClausePayer: "SELLER",
        resaleClauseTermsId: RESALE_TERMS_ID,
        resaleClauseTermsVersion: 2,
        originalUnitPriceCents: item.unitPriceCents,
      });
    }
    expect(resaleReads(getTerms)).toBe(1);
  });

  it("editing a cart keeps a record on every ticket, re-stamped from the clause in force at the edit", async () => {
    const existingOrder = makeOrderRecord();
    const ctx = makeContext({ existingOrder });
    const { live, getTerms } = withResaleTerms(ctx, {
      resaleShareType: "PERCENT",
      resaleShareBps: 1000,
      resaleShareCents: null,
      resaleSharePayer: "SELLER",
      version: 2,
    });

    await updateOrderItems(ctx.deps, {
      actorHumanId: DEFAULT_ACTOR_ID,
      eventId: DEFAULT_EVENT_ID,
      orderId: DEFAULT_ORDER_ID,
      items: [{ ticketTypeId: DEFAULT_TICKET_TYPE_ID, qty: 3 }],
    });
    const firstEdit = ctx.state.lastUpdateInput!.items;
    expect(firstEdit).toHaveLength(3);
    for (const item of firstEdit) {
      expect(item).toMatchObject({
        resaleClauseBps: 1000,
        resaleClauseTermsVersion: 2,
        originalUnitPriceCents: item.unitPriceCents,
      });
    }

    // The organiser changes the clause before this cart is paid; the next
    // edit (which re-prices the lines) records the new clause.
    live.resaleShareType = "FLAT";
    live.resaleShareBps = null;
    live.resaleShareCents = 250;
    live.version = 3;

    await updateOrderItems(ctx.deps, {
      actorHumanId: DEFAULT_ACTOR_ID,
      eventId: DEFAULT_EVENT_ID,
      orderId: DEFAULT_ORDER_ID,
      items: [{ ticketTypeId: DEFAULT_TICKET_TYPE_ID, qty: 1 }],
    });
    const secondEdit = ctx.state.lastUpdateInput!.items;
    expect(secondEdit).toHaveLength(1);
    expect(secondEdit[0]).toMatchObject({
      resaleClauseType: "FLAT",
      resaleClauseBps: null,
      resaleClauseCents: 250,
      resaleClauseTermsId: RESALE_TERMS_ID,
      resaleClauseTermsVersion: 3,
      originalUnitPriceCents: secondEdit[0]!.unitPriceCents,
    });
    // One read per edit.
    expect(resaleReads(getTerms)).toBe(2);
  });

  it("an event whose clause is not set records no clause on a cart edit, but still the original price", async () => {
    const existingOrder = makeOrderRecord();
    const ctx = makeContext({ existingOrder });
    withResaleTerms(ctx, {
      resaleShareType: null,
      resaleShareBps: null,
      resaleShareCents: null,
      resaleSharePayer: "SELLER",
      version: 1,
    });

    await updateOrderItems(ctx.deps, {
      actorHumanId: DEFAULT_ACTOR_ID,
      eventId: DEFAULT_EVENT_ID,
      orderId: DEFAULT_ORDER_ID,
      items: [{ ticketTypeId: DEFAULT_TICKET_TYPE_ID, qty: 2 }],
    });

    for (const item of ctx.state.lastUpdateInput!.items) {
      expect(item).toMatchObject({
        resaleClauseType: null,
        resaleClauseTermsId: null,
        resaleClauseTermsVersion: null,
        originalUnitPriceCents: item.unitPriceCents,
      });
      expect(item.originalUnitPriceCents).not.toBeNull();
    }
  });
});
