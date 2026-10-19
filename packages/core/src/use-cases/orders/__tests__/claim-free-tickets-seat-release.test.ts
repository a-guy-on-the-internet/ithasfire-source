/**
 * The carried-over cart's seat release, on the FREE-claim path.
 *
 * `claimFreeTickets` supersedes a prior PENDING cart exactly as `createCheckout`
 * does — retire it, then hand its seats back so the re-hold below does not trip
 * over its own HELD rows. And it had exactly the same hole: the release carried
 * no ownership fence.
 *
 * `Seat` has no holder column, so `status = "HELD"` proves somebody holds the
 * seat, not that this cart does. The seat-hold TTL (900s) is shorter than the
 * cart TTL (1200s), so by the time a cart is superseded its seats may long since
 * have been freed by the seat reaper and re-let to another buyer. Releasing one
 * of those hands a live hold — possibly a PAID one — back to the pool, and the
 * free claim then takes it: two admissions, one chair.
 *
 * The fence is the cart's own LAST hold instant (see `resolveSeatHoldFence`),
 * not its `occurredAt`: `updateOrderItems` re-holds on every edit without
 * rewriting `occurredAt`, and an `occurredAt`-only fence would decline a
 * legitimately re-held seat, leave it HELD, and make `holdSeatsForCheckout`
 * refuse the buyer their own seats with `seat_unavailable`.
 *
 * The second describe covers the OTHER half of the same verdict: the capacity
 * gate's `excludeOrderId`. Seats and capacity are the two things a superseded
 * cart holds, and both may only be discounted once retirement has proven that
 * cart dead. The seat half was gated from the start; the capacity half was not.
 */
import { describe, expect, it, vi } from "vitest";

import type { Repos, TxRepos } from "@th/ports/repos";
import type { EventRecord } from "@th/ports/repos/events";
import { makeStubEventRecord } from "@th/test-utils/fakes/stub-records";

import {
  ORDER_HOLD_TTL_SECONDS,
  SEAT_FENCE_SLACK_SECONDS,
} from "../_shared/cart-seat-release";
import { claimFreeTickets } from "../claim-free-tickets";

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const ACTOR_ID = "22222222-2222-4222-8222-222222222222";
const TICKET_TYPE_ID = "33333333-3333-4333-8333-333333333333";
const TERMS_ID = "44444444-4444-4444-8444-444444444444";
const FEE_POLICY_ID = "55555555-5555-4555-8555-555555555555";
const CART_ID = "77777777-7777-4777-8777-777777777777";
const SEAT_ID = "seat-1";
const PI_ID = "pi_test_free_claim_carryover";

const NOW = new Date("2026-07-10T18:00:00.000Z");
/** The superseded cart was opened eighteen minutes ago. */
const CART_OCCURRED_AT = new Date(NOW.getTime() - 18 * 60_000);

const SLACK_MS = SEAT_FENCE_SLACK_SECONDS * 1000;

type SeatRow = { status: "HELD" | "AVAILABLE" | "SOLD"; updatedAt: Date };

function makeEvent(): EventRecord {
  return makeStubEventRecord({
    id: EVENT_ID,
    orgId: null,
    humanId: ACTOR_ID,
    status: "PUBLISHED",
    attendanceMode: "TICKETED",
    startsAt: new Date("2026-08-01T19:00:00.000Z"),
    endsAt: new Date("2026-08-01T22:00:00.000Z"),
    gateType: "NONE",
    currency: "usd",
  });
}

/**
 * Same sentinel shape as `claim-free-tickets-sales-window.test.ts`:
 * `orders.createPending` THROWS rather than succeeding, so the harness stops at
 * the first write. The seat release runs before that line, so everything these
 * cases assert has already happened by the time the sentinel fires.
 */
function makeHarness(
  opts: {
    /** Overrides on the superseded cart. */
    cart?: Record<string, unknown>;
    seats?: Record<string, SeatRow>;
    /** What `retrievePaymentIntent` answers after a no-op cancel. */
    piStatus?: string;
    piCanceled?: boolean;
    /**
     * Authored capacity of the free tier. High by default so the capacity gate
     * is a no-op for the seat cases; set to 1 with `cartHoldQty` to exercise
     * the gate on the last ticket.
     */
    capacity?: number;
    /** Qty the superseded cart is holding on that tier. */
    cartHoldQty?: number;
  } = {},
) {
  // Live ledger of the superseded cart's PENDING hold, deleted by
  // `cancelPendingOrder` — so "a retired cart stops counting" is observable
  // rather than asserted off a call.
  const cartHolds = new Map<string, number>(
    opts.cartHoldQty ? [[CART_ID, opts.cartHoldQty]] : [],
  );
  const seats = new Map<string, SeatRow>(
    Object.entries(
      opts.seats ?? {
        [SEAT_ID]: { status: "HELD", updatedAt: CART_OCCURRED_AT },
      },
    ),
  );

  const createPending = vi.fn(async () => {
    throw Object.assign(new Error("reached create pending"), {
      code: "REACHED_CREATE_PENDING",
    });
  });

  const carriedOverCart = {
    id: CART_ID,
    buyerHumanId: ACTOR_ID,
    eventId: EVENT_ID,
    status: "PENDING",
    stripePaymentIntentId: PI_ID,
    occurredAt: CART_OCCURRED_AT,
    items: [{ kind: "ticket", meta: { seatIds: [SEAT_ID] } }],
    ...(opts.cart ?? {}),
  };

  const releaseSeats = vi.fn(
    async (input: {
      seatIds: string[];
      releasedAt: Date;
      heldBefore?: Date;
    }) => {
      // Mirrors the Prisma adapter's predicate
      // (`packages/adapters/src/db/prisma/seats.ts`): HELD only, and
      // `updatedAt <= heldBefore` when the fence is supplied.
      for (const id of input.seatIds) {
        const row = seats.get(id);
        if (!row || row.status !== "HELD") continue;
        if (input.heldBefore && row.updatedAt > input.heldBefore) continue;
        seats.set(id, { status: "AVAILABLE", updatedAt: input.releasedAt });
      }
    },
  );

  const txRepos = {
    events: {
      getById: vi.fn(async (id: string) =>
        id === EVENT_ID ? makeEvent() : null,
      ),
      listTicketTypes: vi.fn(async () => [
        {
          id: TICKET_TYPE_ID,
          name: "Free RSVP",
          description: null,
          priceCents: 0,
          pricingMode: "FIXED" as const,
          minimumCents: null,
          suggestedCents: null,
          capacity: opts.capacity ?? 100,
          status: "ACTIVE" as const,
          seatSectionId: null,
          resaleAllowed: false,
          resaleCapCents: null,
          transferAllowed: true,
          scheduledPriceCents: null,
          scheduledPriceAt: null,
          salesOpenAt: null,
          salesCloseAt: null,
        },
      ]),
    },
    payoutTerms: {
      listByEvent: vi.fn(async () => [
        {
          id: TERMS_ID,
          kind: "PRIMARY",
          status: "ACTIVE",
          feeMode: "ABSORB",
          feePolicyId: FEE_POLICY_ID,
          payoutSchedule: "WEEK_OF_EVENT",
          isDefault: false,
          settlementCurrency: "usd",
          version: 1,
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        },
      ]),
      listLines: vi.fn(async () => [
        {
          id: "line-1",
          payoutTermsId: TERMS_ID,
          payeeId: "66666666-6666-4666-8666-666666666666",
          percent: 100,
          floorCents: 0,
          capPercent: null,
          priority: 0,
          rounding: "FLOOR" as const,
        },
      ]),
    },
    feePolicies: {
      getById: vi.fn(async () => ({
        id: FEE_POLICY_ID,
        scopeType: "EVENT",
        scopeId: EVENT_ID,
        status: "ACTIVE",
        version: 1,
        buyerFeePct: 0,
        maxFeeCents: null,
        minFeeCents: 0,
        platformFixedCents: 0,
        feeMode: "ABSORB",
        processsorFeePct: 0.029,
        processorFixedCents: 30,
        payoutPct: 0.9,
        payoutFixedCents: 0,
        monthlyPayoutCents: 0,
        effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
        effectiveTo: null,
      })),
    },
    eventUnlocks: { isUnlocked: vi.fn(async () => true) },
    memberships: {
      listForMember: vi.fn(async () => []),
      listActiveForHuman: vi.fn(async () => []),
      listActiveBenefitsForHuman: vi.fn(async () => []),
    },
    promos: {
      findActiveByCodes: vi.fn(async () => []),
      findByCodeNormalized: vi.fn(async () => null),
      createHolds: vi.fn(async () => []),
      releaseHoldsForOrder: vi.fn(async () => {}),
    },
    feeWaivers: { release: vi.fn(async () => {}) },
    credits: { releaseForOrder: vi.fn(async () => {}) },
    seats: {
      releaseExpiredHolds: vi.fn(async () => 0),
      releaseSeats,
      findByIdsForUpdate: vi.fn(async () => []),
    },
    orders: {
      createPending,
      getById: vi.fn(async (id: string) =>
        id === CART_ID ? carriedOverCart : null,
      ),
      // CAS on PENDING, like the adapter. Retiring the cart removes its hold
      // from the ledger, so the next capacity read sees the freed unit.
      cancelPendingOrder: vi.fn(async (id: string) => {
        cartHolds.delete(id);
        return true;
      }),
    },
    tickets: {
      createMany: vi.fn(),
      // Mirrors the Prisma adapter
      // (`AND o.id IS DISTINCT FROM $excludeOrderId`): `held` sums every live
      // PENDING cart hold EXCEPT the one the caller is superseding.
      lockAndCountCapacityForTicketType: vi.fn(
        async ({ excludeOrderId }: { excludeOrderId?: string | null } = {}) => {
          let held = 0;
          for (const [orderId, qty] of cartHolds) {
            if (orderId !== excludeOrderId) held += qty;
          }
          return { issued: 0, held };
        },
      ),
    },
  } as unknown as TxRepos;

  const repos = {
    ...(txRepos as unknown as Record<string, unknown>),
    tx: async <T>(fn: (tx: TxRepos) => Promise<T>) => fn(txRepos),
  } as unknown as Repos;

  const payments = {
    cancelPaymentIntent: vi.fn(async () => ({
      canceled: opts.piCanceled ?? true,
    })),
    retrievePaymentIntent: vi.fn(async () => ({
      id: PI_ID,
      status: opts.piStatus ?? "canceled",
      amountReceived: 0,
      currency: "usd",
      metadata: {},
    })),
  };

  return {
    repos,
    txRepos,
    payments,
    seats,
    releaseSeats,
    createPending,
    cartHolds,
    lockAndCount: (txRepos as unknown as TxRepos).tickets
      .lockAndCountCapacityForTicketType as unknown as ReturnType<typeof vi.fn>,
    cancelPendingOrder: (txRepos as unknown as TxRepos).orders
      .cancelPendingOrder as unknown as ReturnType<typeof vi.fn>,
    releaseExpiredHolds: (txRepos as unknown as TxRepos).seats
      .releaseExpiredHolds as unknown as ReturnType<typeof vi.fn>,
  };
}

const input = {
  actorHumanId: ACTOR_ID,
  buyerHumanId: ACTOR_ID,
  eventId: EVENT_ID,
  clientKey: "client-key-12345",
  pendingOrderId: CART_ID,
  items: [{ ticketTypeId: TICKET_TYPE_ID, qty: 1 }],
  termsAccepted: true,
  refundPolicyAccepted: true,
  allowRedirectPaymentMethods: true,
  allowBankDebit: true,
  applyPlatformCredit: true,
};

function run(
  h: ReturnType<typeof makeHarness>,
  extra: { reportError?: ReturnType<typeof vi.fn> } = {},
) {
  return claimFreeTickets(
    {
      repos: h.repos,
      clock: { now: () => NOW },
      payments: h.payments as never,
      ...(extra.reportError ? { reportError: extra.reportError } : {}),
    },
    input,
    [],
    undefined,
  );
}

describe("claimFreeTickets — carried-over cart promo holds", () => {
  it("excludes the superseded cart from the redemption stats so its own 1-per-person hold cannot refuse the retry", async () => {
    // Money audit #8 follow-up: stats count LIVE holds, and this path
    // evaluates promos BEFORE retiring the cart that holds them.
    const h = makeHarness();
    const promos = h.txRepos.promos as unknown as {
      findActiveByCodes: ReturnType<typeof vi.fn>;
      getRedemptionStats: ReturnType<typeof vi.fn>;
    };
    promos.findActiveByCodes.mockResolvedValue([
      {
        id: "promo-once",
        code: "ONCE",
        codeNormalized: "ONCE",
        status: "ACTIVE",
        kind: "PERCENT",
        scope: "EVENT",
        scopeId: EVENT_ID,
        value: 10000,
        currency: "usd",
        minOrderCents: 0,
        maxRedemptions: undefined,
        maxRedemptionsPerHuman: 1,
        maxDiscountCents: undefined,
        stackable: false,
        isPublic: false,
        startsAt: undefined,
        endsAt: undefined,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);
    // The ledger: the superseded cart holds the code for this buyer.
    promos.getRedemptionStats = vi.fn(
      async (params: { excludeOrderId?: string }) => ({
        totalRedemptions: params.excludeOrderId === CART_ID ? 0 : 1,
        redemptionsForHuman: params.excludeOrderId === CART_ID ? 0 : 1,
      }),
    );

    // The $0 tier makes the code itself inapplicable (nothing to discount),
    // which is the error we expect to reach — NOT the cap refusal that a
    // counted own-hold would have produced first.
    await expect(
      claimFreeTickets(
        { repos: h.repos, clock: { now: () => NOW }, payments: h.payments as never },
        input,
        [{ original: "ONCE", normalized: "ONCE" }],
        undefined,
      ),
    ).rejects.toMatchObject({
      code: "invalid_input",
      message: "promo_not_applicable",
    });

    expect(promos.getRedemptionStats).toHaveBeenCalledWith(
      expect.objectContaining({
        promoId: "promo-once",
        humanId: ACTOR_ID,
        excludeOrderId: CART_ID,
      }),
    );
  });
});

describe("claimFreeTickets — carried-over cart seat release", () => {
  it("fences the release on the cart's own hold and frees its seat", async () => {
    const h = makeHarness();

    await expect(run(h)).rejects.toMatchObject({
      code: "REACHED_CREATE_PENDING",
    });

    expect(h.releaseSeats).toHaveBeenCalledWith({
      seatIds: [SEAT_ID],
      releasedAt: NOW,
      heldBefore: new Date(CART_OCCURRED_AT.getTime() + SLACK_MS),
    });
    expect(h.seats.get(SEAT_ID)?.status).toBe("AVAILABLE");
  });

  it("does not free a seat a DIFFERENT, live order is holding", async () => {
    // The 900s seat reaper freed this cart's hold at minute 15; another buyer
    // took the seat at minute 16 and their PaymentIntent is live right now.
    // The cart still lists it in `meta.seatIds`.
    const reheldAt = new Date(CART_OCCURRED_AT.getTime() + 16 * 60_000);
    const h = makeHarness({
      seats: { [SEAT_ID]: { status: "HELD", updatedAt: reheldAt } },
    });

    await expect(run(h)).rejects.toMatchObject({
      code: "REACHED_CREATE_PENDING",
    });

    expect(h.seats.get(SEAT_ID)).toEqual({
      status: "HELD",
      updatedAt: reheldAt,
    });
  });

  it("frees the cart's OWN re-held seat — the edited-cart regression", async () => {
    // `updateOrderItems` re-holds on every edit and never rewrites
    // `occurredAt`, so this cart's seat carries a stamp ten minutes newer than
    // the order row. An `occurredAt + slack` fence declines it, the seat stays
    // HELD, and `holdSeatsForCheckout` then refuses this claim with
    // `seat_unavailable` — for the buyer's own seat.
    const reheldAt = new Date(CART_OCCURRED_AT.getTime() + 10 * 60_000);
    const h = makeHarness({
      cart: {
        items: [
          {
            kind: "ticket",
            meta: {
              seatIds: [SEAT_ID],
              // Written from the same `now` as the seat stamp.
              holdExpiresAt: new Date(
                reheldAt.getTime() + ORDER_HOLD_TTL_SECONDS * 1000,
              ).toISOString(),
            },
          },
        ],
      },
      seats: { [SEAT_ID]: { status: "HELD", updatedAt: reheldAt } },
    });

    await expect(run(h)).rejects.toMatchObject({
      code: "REACHED_CREATE_PENDING",
    });

    expect(h.releaseSeats).toHaveBeenCalledWith(
      expect.objectContaining({
        heldBefore: new Date(reheldAt.getTime() + SLACK_MS),
      }),
    );
    expect(h.seats.get(SEAT_ID)?.status).toBe("AVAILABLE");
  });

  it("releases nothing and reports when the cart carries no usable fence", async () => {
    const h = makeHarness({ cart: { occurredAt: null } });
    const reportError = vi.fn();

    await expect(run(h, { reportError })).rejects.toMatchObject({
      code: "REACHED_CREATE_PENDING",
    });

    // An ownership-blind release is the double-sell this fence exists to
    // prevent, and the seat reaper frees these seats anyway.
    expect(h.releaseSeats).not.toHaveBeenCalled();
    expect(h.seats.get(SEAT_ID)?.status).toBe("HELD");
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "claim_free_tickets_seat_fence_missing",
      }),
      expect.objectContaining({
        tags: expect.objectContaining({ useCase: "claimFreeTickets" }),
      }),
    );
  });

  it("releases nothing when retirement declined because the cart was PAID", async () => {
    // Guard, not a regression: this half already held. A cart whose PI
    // succeeded still mints against these seat ids, so they are not ours.
    const h = makeHarness({ piCanceled: false, piStatus: "succeeded" });

    await expect(run(h)).rejects.toMatchObject({
      code: "REACHED_CREATE_PENDING",
    });

    expect(h.releaseSeats).not.toHaveBeenCalled();
    expect(h.seats.get(SEAT_ID)?.status).toBe("HELD");
  });
});

/**
 * The capacity half of the same verdict.
 *
 * `assertTicketTypeCapacity`'s `excludeOrderId` drops the named order's PENDING
 * ticket lines from `held`, so a buyer converting their own cart is not refused
 * their own hold. That is only sound once the cart is DEAD. Retirement declines
 * whenever the prior PaymentIntent succeeded or is still processing — and a
 * declined cart mints tickets against its own lines the moment its webhook
 * lands. Excluding it anyway under-counts live demand by exactly that qty.
 *
 * On a GA tier (`seatSectionId: null`) nothing downstream catches it:
 * `holdSeatsForCheckout` skips unseated types outright, and `mintTickets`'s
 * issued-only backstop cannot see a hold. The tier simply oversells.
 */
describe("claimFreeTickets — the carried-over cart's capacity exclusion", () => {
  it("counts a PAID carried-over cart against the gate instead of excluding it", async () => {
    // The last free admission, held by the buyer's own PENDING cart, whose PI
    // has already succeeded (they paid; the webhook has not landed yet). The
    // cart is alive and will mint that admission. Excluding it hands the same
    // unit out twice.
    const h = makeHarness({
      capacity: 1,
      cartHoldQty: 1,
      piCanceled: false,
      piStatus: "succeeded",
    });

    await expect(run(h)).rejects.toMatchObject({
      code: "TICKET_TYPE_TEMPORARILY_HELD",
    });

    // The gate was asked WITHOUT the exclusion...
    expect(h.lockAndCount).toHaveBeenCalledWith(
      expect.objectContaining({ excludeOrderId: null }),
    );
    // ...and the cart still holds its unit, because retirement declined.
    expect(h.cartHolds.get(CART_ID)).toBe(1);
    // No order, so no second admission minted against the same seatless unit.
    expect(h.createPending).not.toHaveBeenCalled();
  });

  it("refuses the claim when retirement declined on a Stripe blip", async () => {
    // `pi_settle_failed`: the PI's state is unknown, so the cart keeps its
    // reservation. Same refusal — an unknown status is treated exactly like an
    // unsafe one.
    const h = makeHarness({ capacity: 1, cartHoldQty: 1 });
    h.payments.cancelPaymentIntent.mockRejectedValue(new Error("stripe down"));

    await expect(run(h)).rejects.toMatchObject({
      code: "TICKET_TYPE_TEMPORARILY_HELD",
    });

    expect(h.lockAndCount).toHaveBeenCalledWith(
      expect.objectContaining({ excludeOrderId: null }),
    );
    expect(h.createPending).not.toHaveBeenCalled();
  });

  it("still excludes a cart that WAS retired — the buyer keeps their own hold", async () => {
    // The other direction, and the reason the exclusion exists at all: a
    // cleanly-cancelled PI means the cart is dead, so its unit is this
    // claimer's to take. Reaching the createPending sentinel IS the pass.
    const h = makeHarness({ capacity: 1, cartHoldQty: 1 });

    await expect(run(h)).rejects.toMatchObject({
      code: "REACHED_CREATE_PENDING",
    });

    expect(h.lockAndCount).toHaveBeenCalledWith(
      expect.objectContaining({ excludeOrderId: CART_ID }),
    );
    expect(h.cartHolds.has(CART_ID)).toBe(false);
  });

  it("retires BEFORE the capacity gate, and still locks capacity before seats", async () => {
    // The hoist that makes the verdict available to the gate, plus the rule it
    // must not disturb. Retirement takes Order / PromoHold / FeeWaiver /
    // UserCredit row locks and never a Seat, so the sequence is
    // Order → TicketType → Seat — the same order `createPaidCheckout` and
    // `startPosSale` take. Reversing capacity and seats is a deadlock.
    const h = makeHarness({ capacity: 5, cartHoldQty: 1 });
    const order: string[] = [];

    h.cancelPendingOrder.mockImplementation(async (id: string) => {
      order.push("retire");
      h.cartHolds.delete(id);
      return true;
    });
    h.lockAndCount.mockImplementation(async () => {
      order.push("capacity");
      return { issued: 0, held: 0 };
    });
    h.releaseSeats.mockImplementation(async () => {
      order.push("seat_release");
    });
    h.releaseExpiredHolds.mockImplementation(async () => {
      order.push("seat_hold");
      return 0;
    });

    await expect(run(h)).rejects.toMatchObject({
      code: "REACHED_CREATE_PENDING",
    });

    expect(order).toEqual(["retire", "capacity", "seat_release", "seat_hold"]);
  });
});
