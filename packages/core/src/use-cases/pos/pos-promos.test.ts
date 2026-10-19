import { describe, expect, it, vi } from "vitest";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";
import type { Repos } from "@th/ports/repos";

import { POS_HELD_WINDOW_SECONDS } from "./assert-pos-capacity";
import { recordCashSale } from "./record-cash-sale";
import { startPosSale } from "./start-pos-sale";
import { formatOrderCode } from "@th/types/order-identifier";
import { SCANNER_TERMS_VERSION } from "@th/types";

// ─────────────────────────────────────────────────────────────────────────────
// POS promo discounts — card (startPosSale) and cash (recordCashSale) paths
// share evaluatePromoApplications + the PromoHold/PromoRedemption ledger with
// web checkout. These tests lock the POS-specific wiring:
//   - net-of-discount amountGrossCents / PaymentIntent amount (card: the
//     ticket items carry buyerTotalCents and the negative "discount" lines
//     fold into the finalize AMOUNT_MISMATCH sum, exactly as online)
//   - the card harness prices under an ALL-ZERO fee policy so these cases
//     read a plain face total; the door card fee/tax math is pinned against
//     online checkout in `__tests__/door-card-parity.test.ts`
//   - promo holds on the POS capacity TTL (card) / inline confirm (cash)
//   - idempotency payload hash includes the promo codes
// ─────────────────────────────────────────────────────────────────────────────

const denyingAuthz = {
  hasStaffRole: vi.fn(async () => ({ allowed: false })),
} as unknown as AuthZPort;

const ACTOR = "00000000-0000-4000-8000-000000000001";
const ORG_ID = "00000000-0000-4000-8000-0000000000a1";
const EVENT_ID = "00000000-0000-4000-8000-0000000000e1";
const TT_GA = "00000000-0000-4000-8000-0000000000a2";
const PAYEE_ID = "00000000-0000-4000-8000-0000000000a9";
const PHANTOM_ID = "00000000-0000-4000-8000-0000000000d1";
const ORDER_ID = "00000000-0000-4000-8000-0000000000f1";
const PROMO_ID = "00000000-0000-4000-8000-0000000000b1";
const NOW = new Date("2026-04-26T20:00:00Z");

function makePromo(overrides: Record<string, unknown> = {}) {
  return {
    id: PROMO_ID,
    code: "DOOR10",
    codeNormalized: "DOOR10",
    kind: "AMOUNT" as const,
    value: 1000,
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
    ...overrides,
  };
}

function makePromosRepo(promo: ReturnType<typeof makePromo> | null) {
  return {
    findActiveByCodes: vi.fn(async () => (promo ? [promo] : [])),
    getRedemptionStats: vi.fn(async () => ({
      totalRedemptions: 0,
      redemptionsForHuman: 0,
    })),
    createHolds: vi.fn(async (inputs: unknown[]) => inputs),
    confirmHoldsForOrder: vi.fn(async () => []),
    releaseHoldsForOrder: vi.fn(async () => {}),
  };
}

// ── Card path harness ────────────────────────────────────────────────────────

function makeCardTx(promo: ReturnType<typeof makePromo> | null) {
  return {
    tickets: {
      lockAndCountCapacityForTicketType: vi.fn(async () => ({
        issued: 0,
        held: 0,
      })),
    },
    events: {
      lockRows: vi.fn(async () => undefined),
      getById: vi.fn(async () => ({
        id: EVENT_ID,
        orgId: ORG_ID,
        currency: "usd",
        status: "PUBLISHED",
        title: "Door Sale",
      })),
      listTicketTypes: vi.fn(async () => [
        {
          id: TT_GA,
          name: "GA",
          priceCents: 3000,
          pricingMode: "FIXED" as const,
          minimumCents: null,
          suggestedCents: null,
          capacity: 100,
          status: "ACTIVE" as const,
          seatSectionId: null,
          resaleAllowed: false,
          resaleCapCents: null,
          transferAllowed: true,
        },
      ]),
    },
    authz: {
      getOrgMembership: vi.fn(async () => ({
        orgId: ORG_ID,
        humanId: ACTOR,
        role: "SCANNER" as const,
      })),
    },
    payees: {
      getBySubject: vi.fn(async () => ({ id: PAYEE_ID })),
      getById: vi.fn(async () => ({
        id: PAYEE_ID,
        stripeAccountId: "acct_test",
        chargesEnabled: true,
      })),
    },
    humans: {
      create: vi.fn(async () => ({ id: PHANTOM_ID })),
      getById: vi.fn(async () => ({
        id: ACTOR,
        scannerTermsAckAt: new Date("2026-04-01T00:00:00Z"),
        scannerTermsAckVersion: SCANNER_TERMS_VERSION,
      })),
    },
    orders: {
      createPending: vi.fn(async (input: { amountGrossCents: number; currency: string }) => ({
        id: ORDER_ID,
        amountGrossCents: input.amountGrossCents,
        feesPlatformCents: 0,
        currency: input.currency,
      })),
      createTaxLines: vi.fn(async () => undefined),
    },
    promos: makePromosRepo(promo),
    payoutTerms: {
      listByEvent: vi.fn(async () => [
        {
          id: "terms-1",
          kind: "PRIMARY",
          status: "ACTIVE",
          feeMode: "PASS_THROUGH",
          feePolicyId: "policy-1",
          version: 1,
        },
      ]),
      listLines: vi.fn(async () => [
        {
          id: "line-1",
          agreementId: "terms-1",
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
      getById: vi.fn(async () => ({
        id: "policy-1",
        version: 1,
        feeMode: "PASS_THROUGH",
        buyerFeePct: 0,
        platformFixedCents: 0,
        processsorFeePct: 0,
        processorFixedCents: 0,
        minFeeCents: 0,
        maxFeeCents: null,
        maxPlatformFeeCents: null,
        payoutPct: 0,
        payoutFixedCents: 0,
        monthlyPayoutCents: 0,
      })),
    },
    feeWaivers: {
      resolveApplicable: vi.fn(async () => []),
      reserve: vi.fn(),
    },
  };
}

function makeCardDeps(
  tx: ReturnType<typeof makeCardTx>,
  opts?: { piError?: unknown; idempState?: Map<string, unknown> },
) {
  const idempState = opts?.idempState ?? new Map<string, unknown>();
  const outerPromos = { releaseHoldsForOrder: vi.fn(async () => {}) };
  const repos = {
    tx: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
    orders: {
      linkPaymentIntent: vi.fn(async () => {}),
      cancelPendingOrder: vi.fn(async () => true),
    },
    seats: { releaseSeats: vi.fn(async () => {}) },
    promos: outerPromos,
    feeWaivers: { release: vi.fn(async () => ({ releasedTickets: 0 })) },
    // Plain reads before the transaction (scanner-role pre-check, tax prepare).
    events: tx.events,
    authz: tx.authz,
  } as unknown as Repos;

  const payments = {
    createCardPresentPaymentIntent: vi.fn(async () => {
      if (opts?.piError) throw opts.piError;
      return { paymentIntentId: "pi_1", clientSecret: "cs_1" };
    }),
  } as unknown as PaymentProcessorPort;

  const idempotency = {
    get: vi.fn(async (k: string) => idempState.get(k) ?? null),
    begin: vi.fn(async (k: string) => {
      if (idempState.has(k)) return false;
      idempState.set(k, "__pending__");
      return true;
    }),
    commit: vi.fn(async (k: string, v: unknown) => {
      idempState.set(k, v);
    }),
    fail: vi.fn(async (k: string) => {
      idempState.delete(k);
    }),
  } as unknown as IdempotencyPort;

  const clock: ClockPort = { now: () => NOW };
  return { repos, payments, idempotency, clock, outerPromos, idempState };
}

describe("startPosSale — promo codes", () => {
  it("charges net of discount, writes a discount line, and holds on the POS TTL", async () => {
    const tx = makeCardTx(makePromo());
    const deps = makeCardDeps(tx);

    const result = await startPosSale(
      {
        repos: deps.repos,
        authz: denyingAuthz,
        payments: deps.payments,
        idempotency: deps.idempotency,
        clock: deps.clock,
      },
      {
        actorHumanId: ACTOR,
        eventId: EVENT_ID,
        clientKey: "client-key-0001",
        items: [{ ticketTypeId: TT_GA, qty: 2 }],
        promoCodes: ["door10"],
      },
    );

    // 2 × $30 − $10 promo
    expect(result.amountCents).toBe(5000);
    expect(result.discountCents).toBe(1000);

    const created = tx.orders.createPending.mock.calls[0]![0] as {
      amountGrossCents: number;
      items: Array<{ kind: string; amountCents: number }>;
    };
    // NET gross — the AMOUNT_MISMATCH guard ignores discount lines on POS.
    expect(created.amountGrossCents).toBe(5000);
    const discountItems = created.items.filter((i) => i.kind === "discount");
    expect(discountItems).toHaveLength(1);
    expect(discountItems[0]!.amountCents).toBe(-1000);

    // PI is charged the net amount.
    const piInput = (
      deps.payments.createCardPresentPaymentIntent as ReturnType<typeof vi.fn>
    ).mock.calls[0]![0] as { amountCents: number; description: string };
    expect(piInput.amountCents).toBe(5000);

    // REGRESSION GUARD for the description's ticket count: `itemDrafts` here
    // is 2 ticket lines and the promo appends a negative `discount` line, so a
    // reducer that dropped `item.kind === "ticket"` would say "3 tickets".
    expect(piInput.description).toBe(
      `Door Sale \u2014 2 tickets \u00b7 POS \u00b7 Order ${formatOrderCode(ORDER_ID)}`,
    );

    // Hold uses the 20-min POS capacity TTL, not the web 15-min TTL.
    const holds = tx.promos.createHolds.mock.calls[0]![0] as Array<{
      promoId: string;
      humanId: string;
      expiresAt: Date;
      amountDiscountCents: number;
    }>;
    expect(holds).toHaveLength(1);
    expect(holds[0]!.promoId).toBe(PROMO_ID);
    expect(holds[0]!.humanId).toBe(PHANTOM_ID);
    expect(holds[0]!.amountDiscountCents).toBe(1000);
    expect(holds[0]!.expiresAt.getTime()).toBe(
      NOW.getTime() + POS_HELD_WINDOW_SECONDS * 1000,
    );
  });

  it("conflicts when the same clientKey is replayed with different promo codes", async () => {
    const idempState = new Map<string, unknown>();
    const tx1 = makeCardTx(null);
    const deps1 = makeCardDeps(tx1, { idempState });

    await startPosSale(
      {
        repos: deps1.repos,
        authz: denyingAuthz,
        payments: deps1.payments,
        idempotency: deps1.idempotency,
        clock: deps1.clock,
      },
      {
        actorHumanId: ACTOR,
        eventId: EVENT_ID,
        clientKey: "client-key-0002",
        items: [{ ticketTypeId: TT_GA, qty: 1 }],
      },
    );

    const tx2 = makeCardTx(makePromo());
    const deps2 = makeCardDeps(tx2, { idempState });
    await expect(
      startPosSale(
        {
          repos: deps2.repos,
          authz: denyingAuthz,
          payments: deps2.payments,
          idempotency: deps2.idempotency,
          clock: deps2.clock,
        },
        {
          actorHumanId: ACTOR,
          eventId: EVENT_ID,
          clientKey: "client-key-0002",
          items: [{ ticketTypeId: TT_GA, qty: 1 }],
          promoCodes: ["DOOR10"],
        },
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_CONFLICT" });
  });

  it("rejects a discount that zeroes the card charge (cash/comp path instead)", async () => {
    // $10-off promo × a single $30 ticket is fine; a $60-off promo zeroes
    // the 2-ticket order → card path must refuse (Stripe can't charge $0).
    const tx = makeCardTx(makePromo({ value: 6000 }));
    const deps = makeCardDeps(tx);

    await expect(
      startPosSale(
        {
          repos: deps.repos,
          authz: denyingAuthz,
          payments: deps.payments,
          idempotency: deps.idempotency,
          clock: deps.clock,
        },
        {
          actorHumanId: ACTOR,
          eventId: EVENT_ID,
          clientKey: "client-key-0003",
          items: [{ ticketTypeId: TT_GA, qty: 2 }],
          promoCodes: ["DOOR10"],
        },
      ),
    ).rejects.toMatchObject({ code: "AMOUNT_MUST_BE_POSITIVE" });
    expect(tx.orders.createPending).not.toHaveBeenCalled();
    expect(tx.promos.createHolds).not.toHaveBeenCalled();
  });

  it("releases promo holds when the PaymentIntent fails after the order commits", async () => {
    const tx = makeCardTx(makePromo());
    const deps = makeCardDeps(tx, { piError: new Error("terminal_offline") });

    await expect(
      startPosSale(
        {
          repos: deps.repos,
          authz: denyingAuthz,
          payments: deps.payments,
          idempotency: deps.idempotency,
          clock: deps.clock,
        },
        {
          actorHumanId: ACTOR,
          eventId: EVENT_ID,
          clientKey: "client-key-0004",
          items: [{ ticketTypeId: TT_GA, qty: 2 }],
          promoCodes: ["DOOR10"],
        },
      ),
    ).rejects.toBeTruthy();

    expect(deps.outerPromos.releaseHoldsForOrder).toHaveBeenCalledWith(
      ORDER_ID,
    );
  });

  it("rejects an unknown promo code instead of silently charging full price", async () => {
    const tx = makeCardTx(null);
    const deps = makeCardDeps(tx);

    await expect(
      startPosSale(
        {
          repos: deps.repos,
          authz: denyingAuthz,
          payments: deps.payments,
          idempotency: deps.idempotency,
          clock: deps.clock,
        },
        {
          actorHumanId: ACTOR,
          eventId: EVENT_ID,
          clientKey: "client-key-0005",
          items: [{ ticketTypeId: TT_GA, qty: 1 }],
          promoCodes: ["NOPE"],
        },
      ),
    ).rejects.toMatchObject({ message: "promo_not_found" });
    expect(tx.orders.createPending).not.toHaveBeenCalled();
  });
});

// ── Cash path harness ────────────────────────────────────────────────────────

function makeCashTx(promo: ReturnType<typeof makePromo> | null) {
  const orderItemsByOrder = new Map<string, unknown[]>();
  return {
    events: {
      lockRows: vi.fn(async () => undefined),
      getById: vi.fn(async () => ({
        id: EVENT_ID,
        orgId: ORG_ID,
        currency: "usd",
        status: "PUBLISHED",
        title: "Door Sale",
      })),
      listTicketTypes: vi.fn(async () => [
        {
          id: TT_GA,
          name: "GA",
          priceCents: 3000,
          pricingMode: "FIXED" as const,
          minimumCents: null,
          suggestedCents: null,
          capacity: 100,
          status: "ACTIVE" as const,
          seatSectionId: null,
          resaleAllowed: false,
          resaleCapCents: null,
          transferAllowed: true,
        },
      ]),
    },
    authz: {
      getOrgMembership: vi.fn(async () => ({
        orgId: ORG_ID,
        humanId: ACTOR,
        role: "SCANNER" as const,
      })),
    },
    humans: {
      create: vi.fn(async () => ({ id: PHANTOM_ID })),
      getById: vi.fn(async () => ({
        id: ACTOR,
        scannerTermsAckAt: new Date("2026-04-01T00:00:00Z"),
        scannerTermsAckVersion: SCANNER_TERMS_VERSION,
      })),
    },
    orders: {
      createPending: vi.fn(
        async (input: { amountGrossCents: number; currency: string; items: unknown[] }) => {
          orderItemsByOrder.set(ORDER_ID, input.items);
          return {
            id: ORDER_ID,
            amountGrossCents: input.amountGrossCents,
            feesPlatformCents: 0,
            currency: input.currency,
          };
        },
      ),
      createTaxLines: vi.fn(async () => undefined),
      markSucceeded: vi.fn(async () => {}),
      getById: vi.fn(async (id: string) => ({
        id,
        eventId: EVENT_ID,
        buyerHumanId: PHANTOM_ID,
        status: "SUCCEEDED",
        paymentChannel: "CASH",
        items: (orderItemsByOrder.get(id) ?? []).map(
          (it: unknown, i: number) => ({
            id: `00000000-0000-4000-8000-00000000c1${i
              .toString(16)
              .padStart(2, "0")}`,
            ...(it as Record<string, unknown>),
          }),
        ),
      })),
    },
    tickets: {
      lockAndCountCapacityForTicketType: vi.fn(async () => ({
        issued: 0,
        held: 0,
      })),
      countForOrderTicketType: vi.fn(async () => 0),
      countIssuedForTicketType: vi.fn(async () => 0),
      countCapacityConsumingForTicketType: vi.fn(async () => 0),
      getByOrderItemId: vi.fn(async () => null),
      create: vi.fn(async (input: { orderItemId: string }) => ({
        id: `00000000-0000-4000-8000-00000000e2${Math.floor(
          Math.random() * 256,
        )
          .toString(16)
          .padStart(2, "0")}`,
        code: `CASH-${input.orderItemId}`,
        orderItemId: input.orderItemId,
        status: "VALID" as const,
      })),
      findBySeatIds: vi.fn(async () => []),
      markScanned: vi.fn(async () => ({ ok: true, scannedAt: NOW })),
      recordScan: vi.fn(async () => {}),
    },
    seats: {
      updateStatuses: vi.fn(async () => {}),
      findByIdsForUpdate: vi.fn(async () => []),
    },
    audit: { log: vi.fn(async () => {}) },
    promos: makePromosRepo(promo),
    // Cash is priced through `priceCart` (DOOR_CASH) now, from the same
    // payout terms and ALL-ZERO fee policy the card harness uses, so these
    // cases still read a plain face total. The door cash fee/tax/ledger math
    // is pinned in `__tests__/door-cash-parity.test.ts`.
    payoutTerms: makeCardTx(null).payoutTerms,
    feePolicies: makeCardTx(null).feePolicies,
    feeWaivers: {
      resolveApplicable: vi.fn(async () => []),
      reserve: vi.fn(),
      settle: vi.fn(async () => ({ settledTickets: 0 })),
    },
    payees: { getBySubject: vi.fn(async () => ({ id: PAYEE_ID })) },
    payeeLedger: { cashSaleDebit: vi.fn() },
  };
}

function makeCashDeps() {
  const idempState = new Map<string, unknown>();
  const idempotency = {
    get: vi.fn(async (k: string) => idempState.get(k) ?? null),
    begin: vi.fn(async (k: string) => {
      if (idempState.has(k)) return false;
      idempState.set(k, "__pending__");
      return true;
    }),
    commit: vi.fn(async (k: string, v: unknown) => {
      idempState.set(k, v);
    }),
    fail: vi.fn(async (k: string) => {
      idempState.delete(k);
    }),
  } as unknown as IdempotencyPort;
  const clock: ClockPort = { now: () => NOW };
  return { idempotency, clock };
}

describe("recordCashSale — promo codes", () => {
  it("computes expectedDueCents, confirms holds inline, prices the sale net of the discount", async () => {
    const tx = makeCashTx(makePromo());
    const { idempotency, clock } = makeCashDeps();
    // Top-level reads too: the role check runs before the tax lookup,
    // outside the transaction.
    const repos = {
      ...tx,
      tx: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
    } as unknown as Repos;

    const result = await recordCashSale(
      { repos, authz: denyingAuthz, idempotency, clock },
      {
        actorHumanId: ACTOR,
        eventId: EVENT_ID,
        clientKey: "client-key-1001",
        items: [{ ticketTypeId: TT_GA, qty: 2 }],
        // Operator collected exactly the discounted amount.
        amountCollectedCents: 5000,
        promoCodes: ["door10"],
      },
    );

    expect(result.discountCents).toBe(1000);
    // Typed lower-case, reported as redeemed: normalized.
    expect(result.promoCodes).toEqual(["DOOR10"]);
    expect(result.isComp).toBe(false);
    expect(result.expectedDueCents).toBe(5000); // 2 × $30 − $10
    // The server's price (no fee, no tax under this policy), not the typed
    // amount: they coincide here, and the change is 0.
    expect(result.amountCents).toBe(5000);
    expect(result.changeCents).toBe(0);
    expect(result.ticketCount).toBe(2);

    // Holds created for the phantom buyer, then confirmed inline — the
    // confirm is what writes the PromoRedemption ledger row.
    const holds = tx.promos.createHolds.mock.calls[0]![0] as Array<{
      humanId: string;
    }>;
    expect(holds).toHaveLength(1);
    expect(holds[0]!.humanId).toBe(PHANTOM_ID);
    expect(tx.promos.confirmHoldsForOrder).toHaveBeenCalledWith({
      orderId: ORDER_ID,
      confirmedAt: NOW,
    });

    // Discount line recorded on the order; gross is face net of discount.
    const created = tx.orders.createPending.mock.calls[0]![0] as {
      amountGrossCents: number;
      items: Array<{ kind: string; amountCents: number }>;
    };
    expect(created.amountGrossCents).toBe(5000);
    expect(
      created.items.filter((i) => i.kind === "discount"),
    ).toHaveLength(1);
  });

  it("conflicts when the same clientKey is replayed with different promo codes", async () => {
    const tx = makeCashTx(makePromo());
    const { idempotency, clock } = makeCashDeps();
    // Top-level reads too: the role check runs before the tax lookup,
    // outside the transaction.
    const repos = {
      ...tx,
      tx: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
    } as unknown as Repos;

    const base = {
      actorHumanId: ACTOR,
      eventId: EVENT_ID,
      clientKey: "client-key-1003",
      items: [{ ticketTypeId: TT_GA, qty: 1 }],
      amountCollectedCents: 3000,
    };
    await recordCashSale({ repos, authz: denyingAuthz, idempotency, clock }, base);

    await expect(
      recordCashSale(
        { repos, authz: denyingAuthz, idempotency, clock },
        { ...base, promoCodes: ["DOOR10"] },
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_CONFLICT" });
    expect(tx.orders.createPending).toHaveBeenCalledTimes(1);
  });

  it("unwraps a pre-payload-hash legacy cache entry without conflicting", async () => {
    // Entries cached before the hash check shipped are the bare output
    // object. They must replay cleanly for their 24h keep window.
    const tx = makeCashTx(null);
    const { idempotency, clock } = makeCashDeps();
    // Top-level reads too: the role check runs before the tax lookup,
    // outside the transaction.
    const repos = {
      ...tx,
      tx: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
    } as unknown as Repos;

    const legacy = {
      orderId: ORDER_ID,
      ticketCount: 1,
      ticketCodes: ["LEGACY"],
      seatLabels: [],
      amountCents: 3000,
      discountCents: 0,
      expectedDueCents: 3000,
      isComp: false,
      autoAdmitted: true,
    };
    (idempotency.get as ReturnType<typeof vi.fn>).mockResolvedValue(legacy);

    const result = await recordCashSale(
      { repos, authz: denyingAuthz, idempotency, clock },
      {
        actorHumanId: ACTOR,
        eventId: EVENT_ID,
        clientKey: "client-key-1004",
        items: [{ ticketTypeId: TT_GA, qty: 1 }],
        amountCollectedCents: 3000,
      },
    );

    expect(result.orderId).toBe(ORDER_ID);
    // Cached before `promoCodes` existed: defaulted, not a parse failure.
    expect(result.promoCodes).toEqual([]);
    expect(tx.orders.createPending).not.toHaveBeenCalled();
  });

  it("does not touch the promo ledger when no codes are given", async () => {
    const tx = makeCashTx(null);
    const { idempotency, clock } = makeCashDeps();
    // Top-level reads too: the role check runs before the tax lookup,
    // outside the transaction.
    const repos = {
      ...tx,
      tx: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
    } as unknown as Repos;

    const result = await recordCashSale(
      { repos, authz: denyingAuthz, idempotency, clock },
      {
        actorHumanId: ACTOR,
        eventId: EVENT_ID,
        clientKey: "client-key-1002",
        items: [{ ticketTypeId: TT_GA, qty: 1 }],
        amountCollectedCents: 3000,
      },
    );

    expect(result.discountCents).toBe(0);
    expect(result.promoCodes).toEqual([]);
    expect(result.expectedDueCents).toBe(3000);
    expect(tx.promos.createHolds).not.toHaveBeenCalled();
    expect(tx.promos.confirmHoldsForOrder).not.toHaveBeenCalled();
  });

  it("a 100%-off code makes a $0 SALE that carries its code, not a comp", async () => {
    // Owner ruling: a comp is ONLY the explicit Comp action. $0 collected
    // with `comp` unset and a code is a sale: the code is redeemed and the
    // done screen reads "Free with FREEALL".
    const tx = makeCashTx(
      makePromo({
        code: "FreeAll",
        codeNormalized: "FREEALL",
        kind: "PERCENT",
        value: 100,
      }),
    );
    const { idempotency, clock } = makeCashDeps();
    const repos = {
      ...tx,
      tx: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
    } as unknown as Repos;

    const result = await recordCashSale(
      { repos, authz: denyingAuthz, idempotency, clock },
      {
        actorHumanId: ACTOR,
        eventId: EVENT_ID,
        clientKey: "client-key-1005",
        items: [{ ticketTypeId: TT_GA, qty: 2 }],
        amountCollectedCents: 0,
        promoCodes: ["freeall"],
      },
    );

    expect(result.isComp).toBe(false);
    expect(result.amountCents).toBe(0);
    expect(result.discountCents).toBe(6000);
    expect(result.promoCodes).toEqual(["FREEALL"]);
    expect(result.ticketCount).toBe(2);
    // Redeemed like any sale.
    expect(tx.promos.createHolds).toHaveBeenCalledTimes(1);
    expect(tx.promos.confirmHoldsForOrder).toHaveBeenCalledWith({
      orderId: ORDER_ID,
      confirmedAt: NOW,
    });
  });

  it("an explicit comp ignores the code: no redemption, no promoCodes", async () => {
    const tx = makeCashTx(makePromo());
    const { idempotency, clock } = makeCashDeps();
    const repos = {
      ...tx,
      tx: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
    } as unknown as Repos;

    const result = await recordCashSale(
      { repos, authz: denyingAuthz, idempotency, clock },
      {
        actorHumanId: ACTOR,
        eventId: EVENT_ID,
        clientKey: "client-key-1006",
        items: [{ ticketTypeId: TT_GA, qty: 1 }],
        amountCollectedCents: 0,
        comp: true,
        promoCodes: ["DOOR10"],
      },
    );

    expect(result.isComp).toBe(true);
    expect(result.promoCodes).toEqual([]);
    expect(tx.promos.createHolds).not.toHaveBeenCalled();
  });
});
