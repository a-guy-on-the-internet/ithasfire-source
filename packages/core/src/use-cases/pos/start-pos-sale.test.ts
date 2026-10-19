import { describe, expect, it, vi } from "vitest";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";
import type { Repos } from "@th/ports/repos";

import { SEAT_FENCE_SLACK_SECONDS } from "../orders/_shared/cart-seat-release";
import { computeExpectedPaymentAmount } from "../../lib/orders/compute-expected-payment-amount";
import { startPosSale } from "./start-pos-sale";
import { SCANNER_TERMS_VERSION } from "@th/types";
import { formatOrderCode } from "@th/types/order-identifier";

const denyingAuthz = {
  hasStaffRole: vi.fn(async () => ({ allowed: false })),
} as unknown as AuthZPort;

const ACTOR = "00000000-0000-4000-8000-000000000001";
const ORG_ID = "00000000-0000-4000-8000-0000000000a1";
const EVENT_ID = "00000000-0000-4000-8000-0000000000e1";
const TT_GA = "00000000-0000-4000-8000-0000000000a2";
const PAYEE_ID = "00000000-0000-4000-8000-0000000000a9";
const STRIPE_ACCT = "acct_test_punkhouse";
const PHANTOM_ID = "00000000-0000-4000-8000-0000000000d1";
const ORDER_ID = "00000000-0000-4000-8000-0000000000f1";
const PI_ID = "pi_test_card_present_1";
const CS = "pi_test_secret_1";
const NOW = new Date("2026-04-26T20:00:00Z");
/** 2 × $30 at 5% + 50¢ platform, 2.9% + 30¢ processing, passed through. */
const CHARGE_6000_FACE = 6623; // 6623 − ceil(0.029·6623 + 30) = 6400 = 6000 + 400
const TERMS_ID = "00000000-0000-4000-8000-0000000000b1";
const POLICY_ID = "00000000-0000-4000-8000-0000000000b2";

function makeTx(opts: {
  payee?: {
    id: string;
    stripeAccountId: string | null;
    chargesEnabled: boolean;
  } | null;
  payeeRef?: { id: string } | null;
  membership?: { role: "SCANNER" } | null;
  ticketTypes?: Array<{
    id: string;
    priceCents: number;
    /** FR-014 per-type sales window; independent bounds, null = no bound. */
    salesOpenAt?: Date | null;
    salesCloseAt?: Date | null;
    /** Defaults to FIXED — ADJUSTABLE is "pay what you can". */
    pricingMode?: "FIXED" | "ADJUSTABLE";
    /** ADJUSTABLE floor. */
    minimumCents?: number | null;
    suggestedCents?: number | null;
    /** Points the tier at a RESERVED section so the seat path runs. */
    seatSectionId?: string | null;
    /**
     * Port status (the adapter folds the DB's INACTIVE/ARCHIVED to DRAFT).
     * Defaults to ACTIVE — the only sellable status (money audit #14).
     */
    status?: "ACTIVE" | "DRAFT";
  }>;
  event?: any;
  operator?: {
    scannerTermsAckAt: Date | null;
    scannerTermsAckVersion: string | null;
  } | null;
  /** Capacity accounting overrides — ticket types are seeded at capacity 100. */
  issued?: number;
  held?: number;
  /**
   * Seat table for RESERVED-section tests. Absent (the default) means every
   * ticket type has `seatSectionId: null` and no seat is ever touched, which
   * is what every pre-existing case here assumes.
   */
  seats?: {
    sectionId: string;
    sectionType?: "RESERVED" | "GA";
    /** Seat ids `pickContiguousAvailable` hands back, in order. */
    available: string[];
    /** Mutated in place so a test can assert the end state. */
    table: Map<string, { status: string; updatedAt: Date }>;
  };
  /**
   * Fee-policy rates. Defaults to ALL ZERO so the cases below — seats,
   * windows, idempotency, unwind — keep reading a plain face total. The fee
   * and tax math a door card sale charges is pinned against online checkout
   * in `__tests__/door-card-parity.test.ts`; the first case below runs a
   * real policy end to end.
   */
  feePolicy?: {
    buyerFeePct: number;
    platformFixedCents: number;
    processsorFeePct: number;
    processorFixedCents: number;
  };
}) {
  const event = opts.event ?? {
    id: EVENT_ID,
    orgId: ORG_ID,
    currency: "usd",
    status: "PUBLISHED",
    title: "Launch Party",
  };
  const ticketTypes = opts.ticketTypes ?? [
    { id: TT_GA, priceCents: 3000 },
  ];

  const seatOpts = opts.seats;

  const terms = {
    id: TERMS_ID,
    kind: "PRIMARY",
    status: "ACTIVE",
    feeMode: "PASS_THROUGH",
    feePolicyId: POLICY_ID,
    version: 1,
  };
  const feePolicy = {
    id: POLICY_ID,
    version: 1,
    feeMode: "PASS_THROUGH",
    buyerFeePct: opts.feePolicy?.buyerFeePct ?? 0,
    platformFixedCents: opts.feePolicy?.platformFixedCents ?? 0,
    processsorFeePct: opts.feePolicy?.processsorFeePct ?? 0,
    processorFixedCents: opts.feePolicy?.processorFixedCents ?? 0,
    minFeeCents: 0,
    maxFeeCents: null,
    maxPlatformFeeCents: null,
    payoutPct: 0,
    payoutFixedCents: 0,
    monthlyPayoutCents: 0,
  };

  const tx = {
    seats: seatOpts
      ? {
          getSectionById: vi.fn(async () => ({
            id: seatOpts.sectionId,
            type: seatOpts.sectionType ?? ("RESERVED" as const),
          })),
          pickContiguousAvailable: vi.fn(
            async ({ qty }: { qty: number }) =>
              seatOpts.available.slice(0, qty).map((id) => ({ id })),
          ),
          updateStatuses: vi.fn(
            async ({
              seatIds,
              status,
              updatedAt,
            }: {
              seatIds: string[];
              status: string;
              updatedAt: Date;
            }) => {
              for (const id of seatIds) {
                seatOpts.table.set(id, { status, updatedAt });
              }
            },
          ),
        }
      : undefined,
    tickets: {
      // Capacity accounting: empty by default so existing cases are unaffected.
      lockAndCountCapacityForTicketType: vi.fn(async () => ({
        issued: opts.issued ?? 0,
        held: opts.held ?? 0,
      })),
    },
    events: {
      lockRows: vi.fn(async () => undefined),
      getById: vi.fn(async () => event),
      listTicketTypes: vi.fn(async () =>
        ticketTypes.map((tt) => ({
          ...tt,
          name: tt.id,
          pricingMode: tt.pricingMode ?? ("FIXED" as const),
          minimumCents: tt.minimumCents ?? null,
          suggestedCents: tt.suggestedCents ?? null,
          capacity: 100,
          status: tt.status ?? ("ACTIVE" as const),
          seatSectionId: tt.seatSectionId ?? null,
          resaleAllowed: false,
          resaleCapCents: null,
          transferAllowed: true,
          salesOpenAt: tt.salesOpenAt ?? null,
          salesCloseAt: tt.salesCloseAt ?? null,
        })),
      ),
    },
    authz: {
      getOrgMembership: vi.fn(async () =>
        opts.membership === undefined
          ? { orgId: ORG_ID, humanId: ACTOR, role: "SCANNER" as const }
          : opts.membership,
      ),
    },
    payees: {
      getBySubject: vi.fn(async () =>
        opts.payeeRef === undefined ? { id: PAYEE_ID } : opts.payeeRef,
      ),
      getById: vi.fn(async () =>
        opts.payee === undefined
          ? { id: PAYEE_ID, stripeAccountId: STRIPE_ACCT, chargesEnabled: true }
          : opts.payee,
      ),
    },
    humans: {
      create: vi.fn(async () => ({ id: PHANTOM_ID })),
      getById: vi.fn(async () => {
        const operator =
          opts.operator === undefined
            ? {
                scannerTermsAckAt: new Date("2026-04-01T00:00:00Z"),
                scannerTermsAckVersion: SCANNER_TERMS_VERSION,
              }
            : opts.operator;
        return operator ? { id: ACTOR, ...operator } : null;
      }),
    },
    orders: {
      createPending: vi.fn(async (input: any) => ({
        id: ORDER_ID,
        amountGrossCents: input.amountGrossCents,
        feesPlatformCents: input.feesPlatformCents,
        currency: input.currency,
      })),
      createTaxLines: vi.fn(async () => undefined),
    },
    payoutTerms: {
      listByEvent: vi.fn(async () => [terms]),
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
    feePolicies: { getById: vi.fn(async () => feePolicy) },
    feeWaivers: {
      resolveApplicable: vi.fn(async () => []),
      reserve: vi.fn(),
    },
  };
  return tx;
}

function makeDeps(
  tx: ReturnType<typeof makeTx>,
  opts?: {
    piError?: unknown;
    idempState?: Map<string, any>;
    cancelPendingOrderError?: unknown;
    /** Drives the Phase-3 link failure — the PI exists but can't be attached. */
    linkError?: unknown;
    /** Fails AFTER the PI is linked, to prove the outer catch still unwinds. */
    commitError?: unknown;
    cancelPaymentIntentError?: unknown;
    /** Overrides the injected clock so a test can sit on a window boundary. */
    now?: Date;
    /**
     * Shared with `makeTx({ seats })` so the unwind's release is graded
     * against the same rows the hold stamped.
     */
    seatTable?: Map<string, { status: string; updatedAt: Date }>;
    releaseSeatsError?: unknown;
    /**
     * Runs the moment the PaymentIntent call is made — the seam a test uses to
     * simulate the world moving on between the seat hold and the unwind.
     */
    onPaymentIntent?: () => void;
  },
) {
  const idempState = opts?.idempState ?? new Map<string, any>();
  const repos = {
    tx: vi.fn(async (fn: any) => fn(tx)),
    orders: {
      linkPaymentIntent: vi.fn(async () => {
        if (opts?.linkError) throw opts.linkError;
      }),
      // Unwind path: a sale that dies after its PENDING order is committed
      // must cancel that order, or its capacity hold outlives the failure.
      cancelPendingOrder: opts?.cancelPendingOrderError
        ? vi.fn(async () => {
            throw opts.cancelPendingOrderError;
          })
        : vi.fn(async () => true),
    },
    seats: {
      /**
       * Mirrors the Prisma adapter's predicate
       * (`packages/adapters/src/db/prisma/seats.ts`): `status = "HELD"`, plus
       * `updatedAt <= heldBefore` when the caller passes the ownership fence.
       * A mock that ignored `heldBefore` could not tell a fenced release from
       * an unfenced one.
       */
      releaseSeats: vi.fn(
        async (input: {
          seatIds: string[];
          releasedAt: Date;
          heldBefore?: Date;
        }) => {
          if (opts?.releaseSeatsError) throw opts.releaseSeatsError;
          const table = opts?.seatTable;
          if (!table) return;
          for (const id of input.seatIds) {
            const row = table.get(id);
            if (!row || row.status !== "HELD") continue;
            if (input.heldBefore && row.updatedAt > input.heldBefore) continue;
            table.set(id, {
              status: "AVAILABLE",
              updatedAt: input.releasedAt,
            });
          }
        },
      ),
    },
    promos: { releaseHoldsForOrder: vi.fn(async () => {}) },
    feeWaivers: { release: vi.fn(async () => ({ releasedTickets: 0 })) },
    // Plain reads before the transaction: the scanner-role pre-check and the
    // tax prepare (spec 2026-10-07 NFR-002) read the same rows.
    events: tx.events,
    authz: tx.authz,
  } as unknown as Repos;

  const payments = {
    createCardPresentPaymentIntent: vi.fn(async () => {
      opts?.onPaymentIntent?.();
      if (opts?.piError) throw opts.piError;
      return { paymentIntentId: PI_ID, clientSecret: CS };
    }),
    cancelPaymentIntent: vi.fn(async () => {
      if (opts?.cancelPaymentIntentError) throw opts.cancelPaymentIntentError;
      return { status: "canceled" as const };
    }),
  } as unknown as PaymentProcessorPort;

  const idempotency = {
    get: vi.fn(async (k: string) => idempState.get(k) ?? null),
    begin: vi.fn(async (k: string) => {
      if (idempState.has(k)) return false;
      idempState.set(k, "__pending__");
      return true;
    }),
    commit: vi.fn(async (k: string, v: any) => {
      if (opts?.commitError) throw opts.commitError;
      idempState.set(k, v);
    }),
    fail: vi.fn(async (k: string) => {
      idempState.delete(k);
    }),
    run: vi.fn(),
    purgeExpired: async () => 0,
  } as unknown as IdempotencyPort;

  const clock: ClockPort = { now: () => opts?.now ?? NOW };

  return { repos, payments, idempotency, clock, idempState };
}

describe("startPosSale", () => {
  it("creates a PENDING POS order, calls card-present PI on platform, and links it", async () => {
    // A real fee policy (5% + 50¢ platform, 2.9% + 30¢ processing). Before the
    // door-sales fix (spec 2026-10-07 FR-002) this case asserted a 6000 charge
    // with `feesPlatformCents: 0` and an empty snapshot: the door charged the
    // face only. Card at the door = online (owner ruling R2).
    const tx = makeTx({
      feePolicy: {
        buyerFeePct: 0.05,
        platformFixedCents: 50,
        processsorFeePct: 0.029,
        processorFixedCents: 30,
      },
    });
    const { repos, payments, idempotency, clock } = makeDeps(tx);

    const result = await startPosSale(
      { repos, authz: denyingAuthz, payments, idempotency, clock },
      {
        actorHumanId: ACTOR,
        eventId: EVENT_ID,
        clientKey: "client-key-1",
        items: [{ ticketTypeId: TT_GA, qty: 2 }],
      },
    );

    expect(result.orderId).toBe(ORDER_ID);
    expect(result.clientSecret).toBe(CS);
    // 6000 face + 400 platform fee (2 × (150 + 50)) + processing fee grossed
    // up over both (no tax: the event has no location).
    expect(result.amountCents).toBe(CHARGE_6000_FACE);
    expect(result.currency).toBe("usd");

    // Order created with paymentChannel=POS
    const createdArgs = tx.orders.createPending.mock.calls[0]?.[0] as any;
    expect(createdArgs.paymentChannel).toBe("POS");
    expect(createdArgs.buyerHumanId).toBe(PHANTOM_ID);
    expect(createdArgs.amountGrossCents).toBe(6000);
    expect(createdArgs.feesPlatformCents).toBe(400);
    expect(createdArgs.taxAmountCents).toBe(0);
    expect(createdArgs.feePolicySnapshot).toMatchObject({
      payoutTermsId: TERMS_ID,
      feePolicyId: POLICY_ID,
      feePolicyVersion: 1,
      feeMode: "PASS_THROUGH",
    });
    // Per-item buyer totals, so the finalize AMOUNT_MISMATCH guard sums to
    // the PaymentIntent.
    expect(computeExpectedPaymentAmount(createdArgs)).toBe(CHARGE_6000_FACE);

    // PI created on PLATFORM (no stripeAccount header in our port shape;
    // destinationAccountId goes into metadata only — D-2026-04-26).
    const piArgs = (payments.createCardPresentPaymentIntent as any).mock
      .calls[0][0];
    expect(piArgs.amountCents).toBe(CHARGE_6000_FACE);
    expect(piArgs.destinationAccountId).toBe(STRIPE_ACCT);
    expect(piArgs.metadata.paymentChannel).toBe("POS");
    expect(piArgs.metadata.orderId).toBe(ORDER_ID);
    expect(piArgs.metadata.eventId).toBe(EVENT_ID);

    // Dashboard/exports summary — carries the POS segment and counts the two
    // TICKET drafts, keyed by the canonical 8-hex order code (the TAIL of
    // ORDER_ID, which differs from its head here).
    expect(piArgs.description).toBe(
      `Launch Party — 2 tickets · POS · Order ${formatOrderCode(ORDER_ID)}`,
    );
    // Out of scope and deliberately unchanged: POS still sets no statement
    // descriptor suffix.
    expect(piArgs.statementDescriptorSuffix).toBeUndefined();

    // PI linked to order
    expect((repos as any).orders.linkPaymentIntent).toHaveBeenCalledWith(
      ORDER_ID,
      PI_ID,
    );
  });

  it("rejects when Payee.chargesEnabled is false", async () => {
    const tx = makeTx({
      payee: {
        id: PAYEE_ID,
        stripeAccountId: STRIPE_ACCT,
        chargesEnabled: false,
      },
    });
    const { repos, payments, idempotency, clock } = makeDeps(tx);

    await expect(
      startPosSale(
        { repos, authz: denyingAuthz, payments, idempotency, clock },
        {
          actorHumanId: ACTOR,
          eventId: EVENT_ID,
          clientKey: "client-key-x",
          items: [{ ticketTypeId: TT_GA, qty: 1 }],
        },
      ),
    ).rejects.toMatchObject({ code: "PAYEE_CHARGES_DISABLED" });

    expect(payments.createCardPresentPaymentIntent).not.toHaveBeenCalled();
  });

  it("rejects when org has no Payee", async () => {
    const tx = makeTx({ payeeRef: null });
    const { repos, payments, idempotency, clock } = makeDeps(tx);

    await expect(
      startPosSale(
        { repos, authz: denyingAuthz, payments, idempotency, clock },
        {
          actorHumanId: ACTOR,
          eventId: EVENT_ID,
          clientKey: "client-key-y",
          items: [{ ticketTypeId: TT_GA, qty: 1 }],
        },
      ),
    ).rejects.toMatchObject({ code: "PAYEE_NOT_CONNECTED" });
  });

  it("returns the same result on idempotent replay (same payload)", async () => {
    const tx = makeTx({});
    const idempState = new Map<string, any>();
    const { repos, payments, idempotency, clock } = makeDeps(tx, {
      idempState,
    });

    const input = {
      actorHumanId: ACTOR,
      eventId: EVENT_ID,
      clientKey: "client-key-replay",
      items: [{ ticketTypeId: TT_GA, qty: 1 }],
    };

    const a = await startPosSale(
      { repos, authz: denyingAuthz, payments, idempotency, clock },
      input,
    );
    const b = await startPosSale(
      { repos, authz: denyingAuthz, payments, idempotency, clock },
      input,
    );

    expect(b).toEqual(a);
    expect(payments.createCardPresentPaymentIntent).toHaveBeenCalledTimes(1);
    expect(tx.orders.createPending).toHaveBeenCalledTimes(1);
  });

  it("rejects on payload conflict for a reused clientKey", async () => {
    const tx = makeTx({});
    const idempState = new Map<string, any>();
    const { repos, payments, idempotency, clock } = makeDeps(tx, {
      idempState,
    });

    await startPosSale(
      { repos, authz: denyingAuthz, payments, idempotency, clock },
      {
        actorHumanId: ACTOR,
        eventId: EVENT_ID,
        clientKey: "client-key-conflict",
        items: [{ ticketTypeId: TT_GA, qty: 1 }],
      },
    );

    await expect(
      startPosSale(
        { repos, authz: denyingAuthz, payments, idempotency, clock },
        {
          actorHumanId: ACTOR,
          eventId: EVENT_ID,
          clientKey: "client-key-conflict",
          items: [{ ticketTypeId: TT_GA, qty: 5 }], // different qty
        },
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_CONFLICT" });
  });

  it("propagates Stripe failures from createCardPresentPaymentIntent", async () => {
    const tx = makeTx({});
    const stripeErr = new Error("connect_account_capability_inactive");
    const { repos, payments, idempotency, clock } = makeDeps(tx, {
      piError: stripeErr,
    });

    await expect(
      startPosSale(
        { repos, authz: denyingAuthz, payments, idempotency, clock },
        {
          actorHumanId: ACTOR,
          eventId: EVENT_ID,
          clientKey: "client-key-stripe-fail",
          items: [{ ticketTypeId: TT_GA, qty: 1 }],
        },
      ),
    ).rejects.toMatchObject({
      code: "dependency_failed",
      cause: stripeErr,
    });

    // The order was created (PENDING) but no PI was linked.
    expect(tx.orders.createPending).toHaveBeenCalledTimes(1);
  });

  it("rejects amount=0 carts (use cash path for $0/comp)", async () => {
    const tx = makeTx({
      ticketTypes: [{ id: TT_GA, priceCents: 0 }],
    });
    const { repos, payments, idempotency, clock } = makeDeps(tx);

    await expect(
      startPosSale(
        { repos, authz: denyingAuthz, payments, idempotency, clock },
        {
          actorHumanId: ACTOR,
          eventId: EVENT_ID,
          clientKey: "client-key-zero",
          items: [{ ticketTypeId: TT_GA, qty: 1 }],
        },
      ),
    ).rejects.toMatchObject({ code: "AMOUNT_MUST_BE_POSITIVE" });
  });

  it("rejects before creating an order when the operator has not acknowledged scanner terms", async () => {
    const tx = makeTx({
      operator: { scannerTermsAckAt: null, scannerTermsAckVersion: null },
    });
    const { repos, payments, idempotency, clock } = makeDeps(tx);

    await expect(
      startPosSale(
        { repos, authz: denyingAuthz, payments, idempotency, clock },
        {
          actorHumanId: ACTOR,
          eventId: EVENT_ID,
          clientKey: "client-key-noack",
          items: [{ ticketTypeId: TT_GA, qty: 1 }],
        },
      ),
    ).rejects.toMatchObject({ code: "SCANNER_TERMS_REQUIRED" });

    expect(tx.orders.createPending).not.toHaveBeenCalled();
    expect(payments.createCardPresentPaymentIntent).not.toHaveBeenCalled();
  });

  it("rejects when the operator's scanner-terms ack is a stale version", async () => {
    const tx = makeTx({
      operator: {
        scannerTermsAckAt: new Date("2026-01-01T00:00:00Z"),
        scannerTermsAckVersion: "0",
      },
    });
    const { repos, payments, idempotency, clock } = makeDeps(tx);

    await expect(
      startPosSale(
        { repos, authz: denyingAuthz, payments, idempotency, clock },
        {
          actorHumanId: ACTOR,
          eventId: EVENT_ID,
          clientKey: "client-key-staleack",
          items: [{ ticketTypeId: TT_GA, qty: 1 }],
        },
      ),
    ).rejects.toMatchObject({ code: "SCANNER_TERMS_REQUIRED" });

    expect(tx.orders.createPending).not.toHaveBeenCalled();
    expect(payments.createCardPresentPaymentIntent).not.toHaveBeenCalled();
  });

  describe("capacity", () => {
    it("refuses to create a PaymentIntent for an overselling cart", async () => {
      // The whole point: minting happens in the webhook, so discovering this
      // late means the buyer has already paid for a ticket that doesn't exist.
      const tx = makeTx({ issued: 100 });
      const { repos, payments, idempotency, clock } = makeDeps(tx);

      await expect(
        startPosSale(
          { repos, authz: denyingAuthz, payments, idempotency, clock },
          {
            actorHumanId: ACTOR,
            eventId: EVENT_ID,
            clientKey: "client-key-soldout",
            items: [{ ticketTypeId: TT_GA, qty: 1 }],
          },
        ),
      ).rejects.toMatchObject({ code: "TICKET_TYPE_SOLD_OUT" });

      // No order, and above all NO CHARGE.
      expect(tx.orders.createPending).not.toHaveBeenCalled();
      expect(payments.createCardPresentPaymentIntent).not.toHaveBeenCalled();
    });

    it("counts a concurrent sale's hold, not just issued tickets", async () => {
      // 99 issued + 1 held against capacity 100: nothing is sold out yet, but
      // the last one is spoken for by a tap in flight.
      const tx = makeTx({ issued: 99, held: 1 });
      const { repos, payments, idempotency, clock } = makeDeps(tx);

      await expect(
        startPosSale(
          { repos, authz: denyingAuthz, payments, idempotency, clock },
          {
            actorHumanId: ACTOR,
            eventId: EVENT_ID,
            clientKey: "client-key-held",
            items: [{ ticketTypeId: TT_GA, qty: 1 }],
          },
        ),
      ).rejects.toMatchObject({ code: "TICKET_TYPE_TEMPORARILY_HELD" });

      expect(payments.createCardPresentPaymentIntent).not.toHaveBeenCalled();
    });

    it("does not stamp a hold — the order's own age is the reservation", async () => {
      // A per-line expiry stamp would be a SECOND clock, drifting against the
      // expired-cart reaper that actually cancels the PaymentIntent. Capacity
      // is derived from Order.occurredAt instead, so there is nothing to drift.
      const tx = makeTx({});
      const { repos, payments, idempotency, clock } = makeDeps(tx);

      await startPosSale(
        { repos, authz: denyingAuthz, payments, idempotency, clock },
        {
          actorHumanId: ACTOR,
          eventId: EVENT_ID,
          clientKey: "client-key-nostamp",
          items: [{ ticketTypeId: TT_GA, qty: 2 }],
        },
      );

      const created = tx.orders.createPending.mock.calls[0]![0] as {
        items: Array<{ meta?: Record<string, unknown> }>;
      };
      expect(created.items).toHaveLength(2);
      for (const item of created.items) {
        expect(item.meta?.holdExpiresAt).toBeUndefined();
      }
    });

    it("cancels the order when the PaymentIntent fails, so the hold dies with it", async () => {
      // Regression: the failed order used to stay PENDING with a live hold,
      // so the operator's own failed attempt made the last ticket unsellable
      // until the hold expired. At a door with a queue, the worst moment.
      const tx = makeTx({});
      const stripeErr = new Error("connect_account_capability_inactive");
      const { repos, payments, idempotency, clock } = makeDeps(tx, {
        piError: stripeErr,
      });

      await expect(
        startPosSale(
          { repos, authz: denyingAuthz, payments, idempotency, clock },
          {
            actorHumanId: ACTOR,
            eventId: EVENT_ID,
            clientKey: "client-key-pifail-cancels",
            items: [{ ticketTypeId: TT_GA, qty: 1 }],
          },
        ),
      ).rejects.toMatchObject({ cause: stripeErr });

      expect((repos as any).orders.cancelPendingOrder).toHaveBeenCalledWith(
        ORDER_ID,
      );
    });

    it("still surfaces the original error if cancelling the dead order fails", async () => {
      // Cleanup must never replace the error that explains what went wrong.
      const tx = makeTx({});
      const stripeErr = new Error("connect_account_capability_inactive");
      const { repos, payments, idempotency, clock } = makeDeps(tx, {
        piError: stripeErr,
        cancelPendingOrderError: new Error("db down"),
      });

      await expect(
        startPosSale(
          { repos, authz: denyingAuthz, payments, idempotency, clock },
          {
            actorHumanId: ACTOR,
            eventId: EVENT_ID,
            clientKey: "client-key-cancel-fails",
            items: [{ ticketTypeId: TT_GA, qty: 1 }],
          },
        ),
      ).rejects.toMatchObject({ cause: stripeErr });
    });

    it("cancels the PaymentIntent when it cannot be linked to the order", async () => {
      // The PI exists but nothing points at it, so releaseExpiredCarts — which
      // finds PIs via Order.stripePaymentIntentId — can never reach it. If we
      // don't cancel here, a confirmable charge is left with no owner.
      const tx = makeTx({});
      const linkErr = new Error("pool exhausted");
      const { repos, payments, idempotency, clock } = makeDeps(tx, {
        linkError: linkErr,
      });

      await expect(
        startPosSale(
          { repos, authz: denyingAuthz, payments, idempotency, clock },
          {
            actorHumanId: ACTOR,
            eventId: EVENT_ID,
            clientKey: "client-key-linkfail",
            items: [{ ticketTypeId: TT_GA, qty: 1 }],
          },
        ),
      ).rejects.toMatchObject({ cause: linkErr });

      expect(payments.cancelPaymentIntent).toHaveBeenCalledWith({
        paymentIntentId: PI_ID,
      });
      expect((repos as any).orders.cancelPendingOrder).toHaveBeenCalledWith(
        ORDER_ID,
      );
    });

    it("reports, and still surfaces the original error, when the PI cancel fails", async () => {
      const tx = makeTx({});
      const linkErr = new Error("pool exhausted");
      const reportError = vi.fn();
      const { repos, payments, idempotency, clock } = makeDeps(tx, {
        linkError: linkErr,
        cancelPaymentIntentError: new Error("stripe 500"),
      });

      await expect(
        startPosSale(
          { repos, authz: denyingAuthz, payments, idempotency, clock, reportError },
          {
            actorHumanId: ACTOR,
            eventId: EVENT_ID,
            clientKey: "client-key-cancelfail",
            items: [{ ticketTypeId: TT_GA, qty: 1 }],
          },
        ),
      ).rejects.toMatchObject({ cause: linkErr });

      // A live PI with no owner and no reaper backstop must not be silent.
      expect(reportError).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          tags: expect.objectContaining({ step: "cancelOrphanPaymentIntent" }),
        }),
      );
    });

    it("unwinds when a failure lands AFTER the PI is linked", async () => {
      // Regression: the unwind used to live in per-phase catches, so anything
      // failing after the last one — the idempotency commit, the output parse
      // — leaked a PENDING order holding capacity plus a confirmable PI.
      const tx = makeTx({});
      const commitErr = new Error("redis down");
      const { repos, payments, idempotency, clock } = makeDeps(tx, {
        commitError: commitErr,
      });

      await expect(
        startPosSale(
          { repos, authz: denyingAuthz, payments, idempotency, clock },
          {
            actorHumanId: ACTOR,
            eventId: EVENT_ID,
            clientKey: "client-key-postlink",
            items: [{ ticketTypeId: TT_GA, qty: 1 }],
          },
        ),
      ).rejects.toMatchObject({ cause: commitErr });

      expect(payments.cancelPaymentIntent).toHaveBeenCalledWith({
        paymentIntentId: PI_ID,
      });
      expect((repos as any).orders.cancelPendingOrder).toHaveBeenCalledWith(
        ORDER_ID,
      );
    });

    it("does not unwind a sale that succeeded", async () => {
      const tx = makeTx({});
      const { repos, payments, idempotency, clock } = makeDeps(tx);

      await startPosSale(
        { repos, authz: denyingAuthz, payments, idempotency, clock },
        {
          actorHumanId: ACTOR,
          eventId: EVENT_ID,
          clientKey: "client-key-happy-nounwind",
          items: [{ ticketTypeId: TT_GA, qty: 1 }],
        },
      );

      expect(payments.cancelPaymentIntent).not.toHaveBeenCalled();
      expect((repos as any).orders.cancelPendingOrder).not.toHaveBeenCalled();
    });

    it("takes the capacity lock before creating the order", async () => {
      // The lock is only worth anything if it precedes the write it guards.
      const tx = makeTx({});
      const { repos, payments, idempotency, clock } = makeDeps(tx);
      const order: string[] = [];
      tx.tickets.lockAndCountCapacityForTicketType.mockImplementation(
        async () => {
          order.push("lock");
          return { issued: 0, held: 0 };
        },
      );
      tx.orders.createPending.mockImplementation(async () => {
        order.push("create");
        return { id: ORDER_ID, currency: "usd" };
      });

      await startPosSale(
        { repos, authz: denyingAuthz, payments, idempotency, clock },
        {
          actorHumanId: ACTOR,
          eventId: EVENT_ID,
          clientKey: "client-key-lockorder",
          items: [{ ticketTypeId: TT_GA, qty: 1 }],
        },
      );

      expect(order).toEqual(["lock", "create"]);
    });
  });

  /**
   * The unwind's seat release.
   *
   * Unlike every other `releaseSeats` caller, this one is not working from a
   * stale `meta.seatIds` — it frees seats it stamped HELD moments earlier in
   * the same request. So the ownership fence is a no-op in the normal case and
   * is here for consistency; what these pin is that it is PASSED (the
   * invariant), that it is derived from the instant the seats were actually
   * stamped, and that a failed release is no longer silent.
   */
  describe("unwind — seat release", () => {
    const SECTION_ID = "00000000-0000-4000-8000-0000000000b7";
    const SEAT_A = "seat-a";

    function seatedSale(
      deps: Parameters<typeof makeDeps>[1] & {
        table: Map<string, { status: string; updatedAt: Date }>;
      },
    ) {
      const { table, ...depsOpts } = deps;
      const tx = makeTx({
        // The tier has to point at the section for the seat path to run.
        ticketTypes: [
          {
            id: TT_GA,
            priceCents: 3000,
            seatSectionId: SECTION_ID,
          },
        ],
        seats: { sectionId: SECTION_ID, available: [SEAT_A], table },
      });
      return { tx, ...makeDeps(tx, { ...depsOpts, seatTable: table }) };
    }

    it("fences the release on the instant the seats were stamped HELD", async () => {
      const table = new Map<string, { status: string; updatedAt: Date }>();
      const { repos, payments, idempotency, clock } = seatedSale({
        table,
        commitError: new Error("redis down"),
      });

      await expect(
        startPosSale(
          { repos, authz: denyingAuthz, payments, idempotency, clock },
          {
            actorHumanId: ACTOR,
            eventId: EVENT_ID,
            clientKey: "client-key-seat-unwind",
            items: [{ ticketTypeId: TT_GA, qty: 1 }],
          },
        ),
      ).rejects.toThrow();

      expect((repos as any).seats.releaseSeats).toHaveBeenCalledWith(
        expect.objectContaining({
          seatIds: [SEAT_A],
          heldBefore: new Date(NOW.getTime() + SEAT_FENCE_SLACK_SECONDS * 1000),
        }),
      );
      // Its own seat, so the fence lets it through.
      expect(table.get(SEAT_A)).toMatchObject({ status: "AVAILABLE" });
    });

    it("does not free a seat something else re-stamped after our hold", async () => {
      // Only reachable if the unwind falls far enough behind that the 900s
      // seat reaper freed our hold and the next buyer took it. The fence has
      // to survive that, or the unwind hands away a live hold.
      const table = new Map<string, { status: string; updatedAt: Date }>();
      const reheldAt = new Date(NOW.getTime() + 16 * 60_000);
      const { repos, payments, idempotency, clock } = seatedSale({
        table,
        commitError: new Error("redis down"),
        onPaymentIntent: () => {
          table.set(SEAT_A, { status: "HELD", updatedAt: reheldAt });
        },
      });

      await expect(
        startPosSale(
          { repos, authz: denyingAuthz, payments, idempotency, clock },
          {
            actorHumanId: ACTOR,
            eventId: EVENT_ID,
            clientKey: "client-key-seat-stolen",
            items: [{ ticketTypeId: TT_GA, qty: 1 }],
          },
        ),
      ).rejects.toThrow();

      expect(table.get(SEAT_A)).toEqual({
        status: "HELD",
        updatedAt: reheldAt,
      });
    });

    it("reports a failed release instead of swallowing it silently", async () => {
      // Was a bare `.catch(() => {})`, unlike the promo release right above it.
      // `logger.warn` would not do: it is not captured by Sentry.
      const table = new Map<string, { status: string; updatedAt: Date }>();
      const releaseErr = new Error("deadlock detected");
      const { repos, payments, idempotency, clock } = seatedSale({
        table,
        commitError: new Error("redis down"),
        releaseSeatsError: releaseErr,
      });
      const reportError = vi.fn();
      const logger = {
        error: vi.fn(),
        warn: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
        child: vi.fn(),
        withTime: vi.fn(),
      };
      logger.child.mockReturnValue(logger);
      logger.withTime.mockImplementation(
        async (_name: string, fn: () => unknown) => fn(),
      );

      await expect(
        startPosSale(
          {
            repos,
            authz: denyingAuthz,
            payments,
            idempotency,
            clock,
            reportError,
            logger: logger as never,
          },
          {
            actorHumanId: ACTOR,
            eventId: EVENT_ID,
            clientKey: "client-key-seat-release-fails",
            items: [{ ticketTypeId: TT_GA, qty: 1 }],
          },
        ),
      ).rejects.toThrow();

      expect(reportError).toHaveBeenCalledWith(
        releaseErr,
        expect.objectContaining({
          tags: expect.objectContaining({
            useCase: "startPosSale",
            step: "releaseSeats",
          }),
        }),
      );
      expect(logger.error).toHaveBeenCalledWith(
        "pos.start_sale.release_seats_failed",
        expect.objectContaining({ orderId: ORDER_ID }),
      );
    });
  });
});

/**
 * FR-014 at the CARD till.
 *
 * `startPosSale` mints no tickets — it creates a PENDING order that HOLDS
 * capacity and opens a card-present PaymentIntent, and the webhook mints later.
 * So the thing a refusal must prevent here is the order and the PI: a tier
 * outside its window that still reserved inventory and armed a charge would be
 * the worst of both worlds.
 *
 * As with cash, the POS has no event-level sales close, so the per-type window
 * is the only window gate at this till.
 */
describe("startPosSale — sales window (FR-014)", () => {
  const OPENS_AT = new Date("2026-04-26T19:00:00Z");
  const CLOSES_AT = new Date("2026-04-26T23:00:00Z");

  function sellAt(
    now: Date,
    window: { salesOpenAt?: Date | null; salesCloseAt?: Date | null },
  ) {
    const tx = makeTx({
      ticketTypes: [
        { id: TT_GA, priceCents: 3000, ...window },
      ],
    });
    const { repos, payments, idempotency, clock } = makeDeps(tx, { now });

    const run = () =>
      startPosSale(
        { repos, authz: denyingAuthz, payments, idempotency, clock },
        {
          actorHumanId: ACTOR,
          eventId: EVENT_ID,
          clientKey: `win-${now.getTime()}`,
          items: [{ ticketTypeId: TT_GA, qty: 2 }],
        },
      );

    return { tx, payments, run };
  }

  it("refuses BEFORE the tier opens — no order, no PaymentIntent", async () => {
    const { tx, payments, run } = sellAt(new Date(OPENS_AT.getTime() - 1), {
      salesOpenAt: OPENS_AT,
      salesCloseAt: CLOSES_AT,
    });

    await expect(run()).rejects.toMatchObject({
      code: "TICKET_TYPE_NOT_YET_ON_SALE",
    });
    expect(tx.orders.createPending).not.toHaveBeenCalled();
    expect(payments.createCardPresentPaymentIntent).not.toHaveBeenCalled();
  });

  it("sells at exactly the open instant (INCLUSIVE)", async () => {
    const { run } = sellAt(new Date(OPENS_AT.getTime()), {
      salesOpenAt: OPENS_AT,
      salesCloseAt: CLOSES_AT,
    });

    const result = await run();

    expect(result.amountCents).toBe(6000); // 3000 × 2
  });

  it("refuses AT the close instant (EXCLUSIVE) — no order, no PaymentIntent", async () => {
    const { tx, payments, run } = sellAt(new Date(CLOSES_AT.getTime()), {
      salesOpenAt: OPENS_AT,
      salesCloseAt: CLOSES_AT,
    });

    await expect(run()).rejects.toMatchObject({
      code: "TICKET_TYPE_SALES_ENDED",
    });
    expect(tx.orders.createPending).not.toHaveBeenCalled();
    expect(payments.createCardPresentPaymentIntent).not.toHaveBeenCalled();
  });

  it("a CLOSE bound alone shuts an advance tier at the till", async () => {
    const open = sellAt(new Date(CLOSES_AT.getTime() - 1), {
      salesCloseAt: CLOSES_AT,
    });
    await expect(open.run()).resolves.toBeTruthy();

    const shut = sellAt(new Date(CLOSES_AT.getTime() + 1), {
      salesCloseAt: CLOSES_AT,
    });
    await expect(shut.run()).rejects.toMatchObject({
      code: "TICKET_TYPE_SALES_ENDED",
    });
  });

  it("NFR-001: an unwindowed tier sells at every one of those instants", async () => {
    for (const now of [
      new Date(OPENS_AT.getTime() - 1),
      new Date(CLOSES_AT.getTime()),
    ]) {
      const { run } = sellAt(now, {});
      await expect(run()).resolves.toBeTruthy();
    }
  });
});

/**
 * Pay-what-you-can at the till.
 *
 * `startPosSaleInputSchema` has carried `donationAmountCents` since it
 * shipped, with a doc comment promising "server validates >= minimumCents".
 * Nothing read it. Every line priced through `resolveUnitPriceCents`, which
 * for an ADJUSTABLE type returns `priceCents` — and `upsertTicketType`
 * deliberately stores that as 0 for ADJUSTABLE tiers ("priceCents is ignored
 * — use 0 as the stored value").
 *
 * So the card path did not merely ignore the buyer's amount: it computed a
 * $0 charge, hit `amountCents <= 0`, and refused the sale outright with
 * POS_ZERO_AMOUNT. A pay-what-you-can tier was UNSELLABLE at a door, and the
 * suite had no ADJUSTABLE case anywhere to say so.
 */
describe("startPosSale — pay what you can (ADJUSTABLE)", () => {
  const TT_PWYC = "00000000-0000-4000-8000-0000000000b7";

  const pwycTx = (over?: { minimumCents?: number | null }) =>
    makeTx({
      ticketTypes: [
        {
          id: TT_PWYC,
          // The trap: an ADJUSTABLE tier stores priceCents 0, and the buyer
          // names the number.
          priceCents: 0,
          pricingMode: "ADJUSTABLE",
          minimumCents:
            over?.minimumCents === undefined ? 500 : over.minimumCents,
          suggestedCents: 2000,
        },
      ],
    });

  it("charges the operator-entered amount, not the tier's stored price", async () => {
    const tx = pwycTx();
    const { repos, payments, idempotency, clock } = makeDeps(tx);

    const result = await startPosSale(
      { repos, authz: denyingAuthz, payments, idempotency, clock },
      {
        actorHumanId: ACTOR,
        eventId: EVENT_ID,
        clientKey: "pwyc-key-1",
        items: [
          { ticketTypeId: TT_PWYC, qty: 2, donationAmountCents: 3500 },
        ],
      },
    );

    // 2 × $35.00 — the named amount, per ticket.
    expect(result.amountCents).toBe(7000);

    const order = tx.orders.createPending.mock.calls[0]![0];
    expect(order.amountGrossCents).toBe(7000);
    // One OrderItem per ticket, each snapshotting the named unit price. This
    // is what every historical read (refunds, resale face value, wallet
    // passes) will use forever after.
    expect(order.items).toHaveLength(2);
    for (const item of order.items) {
      expect(item.unitPriceCents).toBe(3500);
      expect(item.amountCents).toBe(3500);
    }
  });

  it("honours an amount ABOVE the suggested price", async () => {
    const tx = pwycTx();
    const { repos, payments, idempotency, clock } = makeDeps(tx);

    const result = await startPosSale(
      { repos, authz: denyingAuthz, payments, idempotency, clock },
      {
        actorHumanId: ACTOR,
        eventId: EVENT_ID,
        clientKey: "pwyc-key-generous",
        items: [
          { ticketTypeId: TT_PWYC, qty: 1, donationAmountCents: 25_000 },
        ],
      },
    );

    expect(result.amountCents).toBe(25_000);
  });

  it("sells at exactly the floor — the floor is a full-price ticket", async () => {
    const tx = pwycTx();
    const { repos, payments, idempotency, clock } = makeDeps(tx);

    const result = await startPosSale(
      { repos, authz: denyingAuthz, payments, idempotency, clock },
      {
        actorHumanId: ACTOR,
        eventId: EVENT_ID,
        clientKey: "pwyc-key-floor",
        items: [{ ticketTypeId: TT_PWYC, qty: 1, donationAmountCents: 500 }],
      },
    );

    expect(result.amountCents).toBe(500);
  });

  it("refuses an amount below the floor", async () => {
    const tx = pwycTx();
    const { repos, payments, idempotency, clock } = makeDeps(tx);

    await expect(
      startPosSale(
        { repos, authz: denyingAuthz, payments, idempotency, clock },
        {
          actorHumanId: ACTOR,
          eventId: EVENT_ID,
          clientKey: "pwyc-key-under",
          items: [{ ticketTypeId: TT_PWYC, qty: 1, donationAmountCents: 499 }],
        },
      ),
    ).rejects.toMatchObject({ message: "donation_below_minimum" });

    expect(tx.orders.createPending).not.toHaveBeenCalled();
  });

  it("refuses an ADJUSTABLE line with no amount at all", async () => {
    const tx = pwycTx();
    const { repos, payments, idempotency, clock } = makeDeps(tx);

    await expect(
      startPosSale(
        { repos, authz: denyingAuthz, payments, idempotency, clock },
        {
          actorHumanId: ACTOR,
          eventId: EVENT_ID,
          clientKey: "pwyc-key-missing",
          items: [{ ticketTypeId: TT_PWYC, qty: 1 }],
        },
      ),
    ).rejects.toMatchObject({ message: "donation_amount_required" });
  });

  it("ignores a stray amount on a FIXED line (the resolved price still wins)", async () => {
    const tx = makeTx({});
    const { repos, payments, idempotency, clock } = makeDeps(tx);

    const result = await startPosSale(
      { repos, authz: denyingAuthz, payments, idempotency, clock },
      {
        actorHumanId: ACTOR,
        eventId: EVENT_ID,
        clientKey: "fixed-with-stray",
        // TT_GA is FIXED at priceCents 3000. A client
        // that leaks a donation amount onto a fixed tier must not be able to
        // set its own price.
        items: [{ ticketTypeId: TT_GA, qty: 1, donationAmountCents: 1 }],
      },
    );

    expect(result.amountCents).toBe(3000);
  });

  it("a replay with a DIFFERENT amount conflicts instead of returning the cached sale", async () => {
    const idempState = new Map<string, any>();

    const first = makeDeps(pwycTx(), { idempState });
    await startPosSale(
      {
        repos: first.repos,
        authz: denyingAuthz,
        payments: first.payments,
        idempotency: first.idempotency,
        clock: first.clock,
      },
      {
        actorHumanId: ACTOR,
        eventId: EVENT_ID,
        clientKey: "pwyc-replay",
        items: [{ ticketTypeId: TT_PWYC, qty: 1, donationAmountCents: 2000 }],
      },
    );

    // Same operator, same key, same cart — but the buyer changed their mind
    // about the number. Without the amount in the payload hash this silently
    // returns the $20 sale while the operator believes they charged $50.
    const second = makeDeps(pwycTx(), { idempState });
    await expect(
      startPosSale(
        {
          repos: second.repos,
          authz: denyingAuthz,
          payments: second.payments,
          idempotency: second.idempotency,
          clock: second.clock,
        },
        {
          actorHumanId: ACTOR,
          eventId: EVENT_ID,
          clientKey: "pwyc-replay",
          items: [{ ticketTypeId: TT_PWYC, qty: 1, donationAmountCents: 5000 }],
        },
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_CONFLICT" });
  });

  it("replays identically when the amount is unchanged", async () => {
    const idempState = new Map<string, any>();
    const args = {
      actorHumanId: ACTOR,
      eventId: EVENT_ID,
      clientKey: "pwyc-replay-same",
      items: [{ ticketTypeId: TT_PWYC, qty: 1, donationAmountCents: 2000 }],
    };

    const first = makeDeps(pwycTx(), { idempState });
    const a = await startPosSale(
      {
        repos: first.repos,
        authz: denyingAuthz,
        payments: first.payments,
        idempotency: first.idempotency,
        clock: first.clock,
      },
      args,
    );

    const second = makeDeps(pwycTx(), { idempState });
    const b = await startPosSale(
      {
        repos: second.repos,
        authz: denyingAuthz,
        payments: second.payments,
        idempotency: second.idempotency,
        clock: second.clock,
      },
      args,
    );

    expect(b).toEqual(a);
    // The replay must not mint a second PaymentIntent.
    expect(second.payments.createCardPresentPaymentIntent).not.toHaveBeenCalled();
  });

  it("treats a null minimum as a zero floor, but still requires an amount", async () => {
    const tx = pwycTx({ minimumCents: null });
    const { repos, payments, idempotency, clock } = makeDeps(tx);

    const result = await startPosSale(
      { repos, authz: denyingAuthz, payments, idempotency, clock },
      {
        actorHumanId: ACTOR,
        eventId: EVENT_ID,
        clientKey: "pwyc-null-floor",
        items: [{ ticketTypeId: TT_PWYC, qty: 1, donationAmountCents: 100 }],
      },
    );

    expect(result.amountCents).toBe(100);
  });
});

describe("startPosSale — only ACTIVE ticket types are sellable (money audit 2026-09-08 #14)", () => {
  // Same `status === "ACTIVE"` rule `listSellableItems` uses to build the till
  // screen: an archived or unpublished tier is not on the screen, and it must
  // not be sellable by id either. At the port those are ONE value — the
  // adapter folds the DB's INACTIVE and ARCHIVED to "DRAFT" — so that is the
  // value fed here.
  const TT_HIDDEN = "00000000-0000-4000-8000-0000000000a7";

  function twoTiers() {
    return makeTx({
      ticketTypes: [
        { id: TT_GA, priceCents: 3000 },
        {
          id: TT_HIDDEN,
          priceCents: 3000,
          status: "DRAFT",
        },
      ],
    });
  }

  {
    it("refuses an archived or unpublished (DRAFT) tier named by id — no order, no PaymentIntent", async () => {
      const tx = twoTiers();
      const { repos, payments, idempotency, clock } = makeDeps(tx);

      await expect(
        startPosSale(
          { repos, authz: denyingAuthz, payments, idempotency, clock },
          {
            actorHumanId: ACTOR,
            eventId: EVENT_ID,
            clientKey: "client-key-draft-tier",
            items: [{ ticketTypeId: TT_HIDDEN, qty: 1 }],
          },
        ),
      ).rejects.toMatchObject({ code: "TICKET_TYPE_NOT_FOUND" });

      expect(tx.orders.createPending).not.toHaveBeenCalled();
      expect(payments.createCardPresentPaymentIntent).not.toHaveBeenCalled();
    });
  }

  it("still sells the ACTIVE tier listed alongside a DRAFT one", async () => {
    const tx = twoTiers();
    const { repos, payments, idempotency, clock } = makeDeps(tx);

    const result = await startPosSale(
      { repos, authz: denyingAuthz, payments, idempotency, clock },
      {
        actorHumanId: ACTOR,
        eventId: EVENT_ID,
        clientKey: "client-key-active-beside-hidden",
        items: [{ ticketTypeId: TT_GA, qty: 1 }],
      },
    );

    expect(result.orderId).toBe(ORDER_ID);
    expect(result.amountCents).toBe(3000);
  });
});

describe("startPosSale — door card = online (spec 2026-10-07 FR-002)", () => {
  const REAL_POLICY = {
    buyerFeePct: 0.05,
    platformFixedCents: 50,
    processsorFeePct: 0.029,
    processorFixedCents: 30,
  };

  it("an organiser-side fee waiver applies at the door, and the unwind hands the allowance back", async () => {
    const tx = makeTx({ feePolicy: REAL_POLICY });
    // One ticket of ORGANIZER-side allowance, as checkout would find it.
    tx.feeWaivers.resolveApplicable.mockResolvedValue([
      { id: "waiver-1", ticketsGranted: 5, ticketsUsed: 4 },
    ] as never);
    tx.feeWaivers.reserve.mockImplementation((async (input: {
      waivableTicketFeesCents: number[];
    }) => ({
      reservedTickets: 1,
      feeWaivedCents: input.waivableTicketFeesCents[0]!,
      redemptionId: "redemption-1",
    })) as never);
    // Keep the id the sale mints, as the Prisma adapter does.
    tx.orders.createPending.mockImplementation((async (input: any) => ({
      id: input.id,
      amountGrossCents: input.amountGrossCents,
      feesPlatformCents: input.feesPlatformCents,
      currency: input.currency,
    })) as never);
    const { repos, payments, idempotency, clock } = makeDeps(tx, {
      piError: new Error("stripe down"),
    });

    await expect(
      startPosSale(
        { repos, authz: denyingAuthz, payments, idempotency, clock },
        {
          actorHumanId: ACTOR,
          eventId: EVENT_ID,
          clientKey: "client-key-waiver",
          items: [{ ticketTypeId: TT_GA, qty: 2 }],
        },
      ),
    ).rejects.toBeDefined();

    // The phantom buyer holds no BUYER-side waiver: only organiser-side ones
    // are looked up.
    expect(tx.feeWaivers.resolveApplicable).toHaveBeenCalledWith(
      expect.objectContaining({ buyerHumanId: null, organizerOrgId: ORG_ID }),
    );
    // Reserved against the order the sale wrote, and priced in: one of the two
    // $2 platform fees is waived.
    const created = tx.orders.createPending.mock.calls[0]?.[0] as any;
    expect(tx.feeWaivers.reserve).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: created.id }),
    );
    expect(created.feesPlatformCents).toBe(200);
    // The PI failed, so the sale unwound: the allowance comes back.
    expect(
      (repos as any).feeWaivers.release,
    ).toHaveBeenCalledWith(created.id);
  });

  it("reports a failed fee-waiver release in the unwind, and still surfaces the original error", async () => {
    const tx = makeTx({});
    const stripeErr = new Error("stripe down");
    const { repos, payments, idempotency, clock } = makeDeps(tx, {
      piError: stripeErr,
    });
    const releaseErr = new Error("waiver release exploded");
    (repos as any).feeWaivers.release.mockRejectedValue(releaseErr);
    const reportError = vi.fn();

    await expect(
      startPosSale(
        { repos, authz: denyingAuthz, payments, idempotency, clock, reportError },
        {
          actorHumanId: ACTOR,
          eventId: EVENT_ID,
          clientKey: "client-key-release-fails",
          items: [{ ticketTypeId: TT_GA, qty: 1 }],
        },
      ),
    ).rejects.toMatchObject({ cause: stripeErr });

    expect(reportError).toHaveBeenCalledWith(
      releaseErr,
      expect.objectContaining({
        tags: { useCase: "startPosSale", step: "releaseFeeWaiver" },
        extra: { orderId: ORDER_ID },
      }),
    );
    // The rest of the unwind still ran.
    expect((repos as any).orders.cancelPendingOrder).toHaveBeenCalledWith(
      ORDER_ID,
    );
  });

  it("takes locks in online checkout's order: fee waiver, then capacity, then seats", async () => {
    const table = new Map<string, { status: string; updatedAt: Date }>();
    const tx = makeTx({
      feePolicy: REAL_POLICY,
      ticketTypes: [{ id: TT_GA, priceCents: 3000, seatSectionId: "sec-1" }],
      seats: { sectionId: "sec-1", available: ["seat-1", "seat-2"], table },
    });
    tx.feeWaivers.resolveApplicable.mockResolvedValue([
      { id: "waiver-1", ticketsGranted: 5, ticketsUsed: 0 },
    ] as never);
    tx.feeWaivers.reserve.mockResolvedValue({
      reservedTickets: 0,
      feeWaivedCents: 0,
      redemptionId: null,
    } as never);
    const { repos, payments, idempotency, clock } = makeDeps(tx, {
      seatTable: table,
    });

    await startPosSale(
      { repos, authz: denyingAuthz, payments, idempotency, clock },
      {
        actorHumanId: ACTOR,
        eventId: EVENT_ID,
        clientKey: "client-key-lock-order",
        items: [{ ticketTypeId: TT_GA, qty: 2 }],
      },
    );

    const order = (fn: { mock: { invocationCallOrder: number[] } }) =>
      fn.mock.invocationCallOrder[0]!;
    const waiver = order(tx.feeWaivers.reserve as never);
    const capacity = order(tx.tickets.lockAndCountCapacityForTicketType as never);
    const seats = order(tx.seats!.pickContiguousAvailable as never);
    expect(waiver).toBeLessThan(capacity);
    expect(capacity).toBeLessThan(seats);
  });

  it("refuses an operator without a scanner role BEFORE any (paid) tax lookup", async () => {
    const tx = makeTx({
      membership: null,
      event: {
        id: EVENT_ID,
        orgId: ORG_ID,
        currency: "usd",
        status: "PUBLISHED",
        title: "Launch Party",
        // Unstamped, with a location: a prepare would call the provider.
        admissionTaxRateBps: null,
        placeId: null,
        savedLocationId: null,
        postalCode: "37203",
        countryCode: "US",
        region: "TN",
        startsAt: new Date("2026-04-26T19:00:00Z"),
        endsAt: null,
      },
    });
    const { repos, payments, idempotency, clock } = makeDeps(tx);
    const lookupByPostalCode = vi.fn(async () => ({
      rateBps: 975,
      source: "ziptax",
    }));

    await expect(
      startPosSale(
        {
          repos,
          authz: denyingAuthz,
          payments,
          idempotency,
          clock,
          taxRateLookup: { lookupByPostalCode },
        },
        {
          actorHumanId: ACTOR,
          eventId: EVENT_ID,
          clientKey: "client-key-outsider",
          items: [{ ticketTypeId: TT_GA, qty: 1 }],
        },
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });

    expect(lookupByPostalCode).not.toHaveBeenCalled();
    expect(repos.tx).not.toHaveBeenCalled();
  });

  it("refuses a personal (no-org) event with EVENT_NOT_ORG_OWNED BEFORE any (paid) tax lookup", async () => {
    const tx = makeTx({
      event: {
        id: EVENT_ID,
        orgId: null,
        currency: "usd",
        // A DRAFT, unstamped, located event: the door prepare skips the
        // unpublished and event-ended shortcuts, so it WOULD call the provider.
        status: "DRAFT",
        title: "My house show",
        admissionTaxRateBps: null,
        placeId: null,
        savedLocationId: null,
        postalCode: "37203",
        countryCode: "US",
        region: "TN",
        startsAt: new Date("2026-04-26T19:00:00Z"),
        endsAt: null,
      },
    });
    const { repos, payments, idempotency, clock } = makeDeps(tx);
    const lookupByPostalCode = vi.fn(async () => ({
      rateBps: 975,
      source: "ziptax",
    }));

    await expect(
      startPosSale(
        {
          repos,
          authz: denyingAuthz,
          payments,
          idempotency,
          clock,
          taxRateLookup: { lookupByPostalCode },
        },
        {
          actorHumanId: ACTOR,
          eventId: EVENT_ID,
          clientKey: "client-key-personal",
          items: [{ ticketTypeId: TT_GA, qty: 1 }],
        },
      ),
    ).rejects.toMatchObject({ code: "EVENT_NOT_ORG_OWNED" });

    expect(lookupByPostalCode).not.toHaveBeenCalled();
    expect(repos.tx).not.toHaveBeenCalled();
  });
});

describe("startPosSale — the door sells published events only (owner ruling 2026-10-07)", () => {
  const eventWith = (status: string) => ({
    id: EVENT_ID,
    orgId: ORG_ID,
    currency: "usd",
    status,
    title: "Launch Party",
  });

  it.each(["DRAFT", "CANCELLED"])(
    "a %s event is refused before the tax lookup, the transaction and the PaymentIntent",
    async (status) => {
      const tx = makeTx({ event: eventWith(status) });
      const { repos, payments, idempotency, clock, idempState } = makeDeps(tx);
      const lookupByPostalCode = vi.fn(async () => ({
        rateBps: 975,
        source: "ziptax",
      }));

      await expect(
        startPosSale(
          {
            repos,
            authz: denyingAuthz,
            payments,
            idempotency,
            clock,
            taxRateLookup: { lookupByPostalCode } as never,
          },
          {
            actorHumanId: ACTOR,
            eventId: EVENT_ID,
            clientKey: `client-key-${status}`,
            items: [{ ticketTypeId: TT_GA, qty: 1 }],
          },
        ),
      ).rejects.toMatchObject({
        code: "EVENT_NOT_PUBLISHED",
        message: "door_sells_published_events_only",
        meta: { status },
      });

      expect(lookupByPostalCode).not.toHaveBeenCalled();
      expect(repos.tx).not.toHaveBeenCalled();
      expect(tx.orders.createPending).not.toHaveBeenCalled();
      expect(payments.createCardPresentPaymentIntent).not.toHaveBeenCalled();
      expect(idempState.size).toBe(0);
    },
  );

  it("an event cancelled while the sale waited on the lock is refused inside the transaction: no order, no PaymentIntent", async () => {
    const event = eventWith("PUBLISHED");
    const tx = makeTx({ event });
    // The cancellation commits while this sale waits for the share lock.
    tx.events.lockRows = vi.fn(async () => {
      event.status = "CANCELLED";
    }) as any;
    const { repos, payments, idempotency, clock } = makeDeps(tx);

    await expect(
      startPosSale(
        { repos, authz: denyingAuthz, payments, idempotency, clock },
        {
          actorHumanId: ACTOR,
          eventId: EVENT_ID,
          clientKey: "client-key-race",
          items: [{ ticketTypeId: TT_GA, qty: 1 }],
        },
      ),
    ).rejects.toMatchObject({ code: "EVENT_NOT_PUBLISHED" });

    expect(tx.events.lockRows).toHaveBeenCalledWith({
      ids: [EVENT_ID],
      mode: "share",
    });
    // The lock came first in the transaction, before its read of the event.
    const lockAt = tx.events.lockRows.mock.invocationCallOrder[0]!;
    expect(
      tx.events.getById.mock.invocationCallOrder.some((n: number) => n > lockAt),
    ).toBe(true);
    expect(tx.orders.createPending).not.toHaveBeenCalled();
    expect(payments.createCardPresentPaymentIntent).not.toHaveBeenCalled();
  });
});
