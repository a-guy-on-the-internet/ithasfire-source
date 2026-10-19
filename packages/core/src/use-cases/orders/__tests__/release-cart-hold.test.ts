import { describe, expect, it, vi } from "vitest";

import { releaseCartHold } from "../release-cart-hold";
import type { ReleaseCartHoldDeps } from "../release-cart-hold";
import type { OrderRecord } from "@th/ports/repos/orders";

/** When the beacon fires — twenty minutes after the cart was created. */
const BASE_DATE = new Date("2024-02-01T00:20:00.000Z");
/**
 * When the cart was created AND — matching `create-checkout`, which inserts
 * the order and stamps its seats HELD in one transaction from one `now` — when
 * its seats were stamped.
 */
const HELD_AT = new Date("2024-02-01T00:00:00.000Z");
/** `ORDER_HOLD_TTL_SECONDS` in `_shared/cart-seat-release.ts`. */
const HOLD_TTL_SECONDS = 900;
/** `SEAT_FENCE_SLACK_SECONDS` in the same module. */
const FENCE_SLACK_SECONDS = 60;

const secondsAfterHold = (seconds: number) =>
  new Date(HELD_AT.getTime() + seconds * 1000);

const DEFAULT_ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const DEFAULT_ORDER_ID = "22222222-2222-4222-8222-222222222222";
const DEFAULT_PI_ID = "pi_test_123";
const SEAT_A = "seat-a";
const SEAT_B = "seat-b";

type SeatStatus = "AVAILABLE" | "HELD" | "SOLD";

function buildOrder(overrides: Partial<OrderRecord> = {}): OrderRecord {
  return {
    id: DEFAULT_ORDER_ID,
    eventId: "evt-1",
    buyerHumanId: DEFAULT_ACTOR_ID,
    amountGrossCents: 5000,
    feesPlatformCents: 500,
    currency: "usd",
    feePolicySnapshot: {},
    status: "PENDING",
    stripePaymentIntentId: DEFAULT_PI_ID,
    source: "PRIMARY",
    nonRefundable: false,
    occurredAt: HELD_AT,
    parentOrderId: null,
    taxAmountCents: 0,
    billingAddressLine1: null,
    billingAddressLine2: null,
    billingCity: null,
    billingState: null,
    billingPostalCode: null,
    billingCountry: null,
    stripeTaxCalculationId: null,
    items: [],
    ...overrides,
  } as OrderRecord;
}

/**
 * A ticket line carrying seats, stamped the way both writers stamp it:
 * `holdExpiresAt = <the instant the seats were held> + ORDER_HOLD_TTL_SECONDS`.
 * `resolveSeatHoldFence` inverts exactly this.
 */
function seatItem(seatIds: string[], heldAt: Date = HELD_AT) {
  return {
    id: `item-${seatIds.join("-")}`,
    orderId: DEFAULT_ORDER_ID,
    kind: "ticket" as const,
    ticketTypeId: "tt-1",
    qty: 1,
    unitPriceCents: 5000,
    amountCents: 5000,
    meta: {
      seatIds,
      holdExpiresAt: new Date(
        heldAt.getTime() + HOLD_TTL_SECONDS * 1000,
      ).toISOString(),
    },
  };
}

function buildDeps(
  overrides: {
    order?: OrderRecord | null;
    /** Starting seat statuses. Anything referenced but unlisted starts HELD. */
    seatStatuses?: Record<string, SeatStatus>;
    /**
     * `Seat.updatedAt` per seat. Anything unlisted was stamped at `HELD_AT` —
     * i.e. by the cart under test. Modelled because `Seat` has NO holder
     * column: `updatedAt` is the only thing separating "still held by this
     * abandoned cart" from "re-held by the buyer who took the seat after the
     * seat reaper freed it", and the second must survive.
     */
    seatUpdatedAt?: Record<string, Date>;
    /** Stripe's answer to `cancelPaymentIntent`. */
    piCancelResult?: { canceled: boolean };
    /** Status the follow-up `retrievePaymentIntent` probe reports. */
    piStatus?: string;
    /** Omit the payment processor entirely. */
    noPayments?: boolean;
    /** The listing a RESALE order holds, with its hold as `hold()` wrote it. */
    listing?: { id: string; buyerHumanId: string; heldUntil: Date };
  } = {},
) {
  const order = overrides.order === undefined ? buildOrder() : overrides.order;

  // ── Real, rollback-aware state ───────────────────────────────────────────
  // The whole point of the change under test is that the cancel and the seat
  // release are ONE transaction, so the fake has to be able to undo them. `tx`
  // snapshots every mutable table on entry and restores it if the callback
  // throws. Asserting on call counts alone cannot tell a committed write from
  // a rolled-back one.
  let orderStatus: OrderRecord["status"] = order?.status ?? "PENDING";
  const seatStatuses = new Map<string, SeatStatus>();
  const seatUpdatedAt = new Map<string, Date>();
  const releasedHolds = { promos: 0, feeWaivers: 0, credits: 0 };
  // The listing row + its hold row, as `resaleListings.releaseHold` sees them.
  let listingState: {
    status: "ACTIVE" | "HELD";
    hold: { buyerHumanId: string; heldUntil: Date } | null;
  } | null = overrides.listing
    ? {
        status: "HELD",
        hold: {
          buyerHumanId: overrides.listing.buyerHumanId,
          heldUntil: overrides.listing.heldUntil,
        },
      }
    : null;

  const referencedSeatIds = new Set<string>([
    ...Object.keys(overrides.seatStatuses ?? {}),
    ...Object.keys(overrides.seatUpdatedAt ?? {}),
  ]);
  for (const item of order?.items ?? []) {
    const meta = item.meta as { seatIds?: unknown } | null;
    if (Array.isArray(meta?.seatIds)) {
      for (const id of meta.seatIds as string[]) referencedSeatIds.add(id);
    }
  }
  for (const id of referencedSeatIds) {
    seatStatuses.set(id, overrides.seatStatuses?.[id] ?? "HELD");
    seatUpdatedAt.set(id, overrides.seatUpdatedAt?.[id] ?? HELD_AT);
  }

  let txDepth = 0;
  const cancelTxDepths: number[] = [];
  const releaseSeatsTxDepths: number[] = [];
  /** Call order across the transaction, so "cancel before seats" is provable. */
  const callLog: string[] = [];

  const ordersRepo = {
    // Reads live state, so a SECOND invocation sees what the first one did —
    // which is how "safe to call repeatedly" gets tested rather than asserted.
    getById: vi.fn(async (id: string) => {
      if (!order || id !== order.id) return null;
      return { ...order, status: orderStatus };
    }),
    cancelPendingOrder: vi.fn(async (_id: string) => {
      cancelTxDepths.push(txDepth);
      callLog.push("cancelPendingOrder");
      // CAS on PENDING — exactly like the Prisma repo.
      if (orderStatus !== "PENDING") return false;
      orderStatus = "CANCELLED";
      return true;
    }),
  };

  const seatsRepo = {
    // Mirrors the Prisma `where` exactly: `status: "HELD"` plus, when the
    // caller passes one, `updatedAt: { lte: heldBefore }`. A call-shape
    // assertion cannot tell you whether the row actually moved.
    releaseSeats: vi.fn(
      async (input: {
        seatIds: string[];
        releasedAt: Date;
        heldBefore?: Date;
      }) => {
        releaseSeatsTxDepths.push(txDepth);
        callLog.push("releaseSeats");
        for (const id of input.seatIds) {
          if (seatStatuses.get(id) !== "HELD") continue;
          const stamp = seatUpdatedAt.get(id);
          if (
            input.heldBefore &&
            stamp &&
            stamp.getTime() > input.heldBefore.getTime()
          ) {
            continue;
          }
          seatStatuses.set(id, "AVAILABLE");
          seatUpdatedAt.set(id, input.releasedAt);
        }
      },
    ),
    // Present so a regression back to the blind, predicate-free write is
    // visible as a call on a method nothing should be using here.
    updateStatuses: vi.fn(async () => undefined),
  };

  const promosRepo = {
    releaseHoldsForOrder: vi.fn(async () => {
      releasedHolds.promos++;
      callLog.push("promos.releaseHoldsForOrder");
    }),
  };

  const feeWaiversRepo = {
    release: vi.fn(async () => {
      releasedHolds.feeWaivers++;
      callLog.push("feeWaivers.release");
      return { releasedTickets: 0 };
    }),
  };

  const creditsRepo = {
    releaseForOrder: vi.fn(async () => {
      releasedHolds.credits++;
      callLog.push("credits.releaseForOrder");
      return { releasedCents: 0, creditIds: [] };
    }),
  };

  const payments = {
    cancelPaymentIntent: vi.fn(
      async () => overrides.piCancelResult ?? { canceled: true },
    ),
    retrievePaymentIntent: vi.fn(async () => ({
      id: DEFAULT_PI_ID,
      status: overrides.piStatus ?? "canceled",
      amountReceived: 0,
      currency: "usd",
      metadata: {},
    })),
  };

  const reportError = vi.fn();
  const clock = { now: vi.fn(() => BASE_DATE) };

  const resaleListingsRepo = {
    // Fenced exactly like the Prisma adapter: HELD, and the hold row still
    // this buyer's with this `heldUntil` to the millisecond.
    releaseHold: vi.fn(
      async (
        listingId: string,
        fence: { buyerHumanId: string; heldUntil: Date },
      ) => {
        callLog.push("releaseHold");
        const none = { released: false as const };
        if (!listingState || listingId !== overrides.listing?.id) return none;
        if (listingState.status !== "HELD" || !listingState.hold) return none;
        if (
          listingState.hold.buyerHumanId !== fence.buyerHumanId ||
          listingState.hold.heldUntil.getTime() !== fence.heldUntil.getTime()
        ) {
          return none;
        }
        listingState = { status: "ACTIVE", hold: null };
        return { released: true as const, listingStatus: "ACTIVE" as const };
      },
    ),
  };

  const txRepos = {
    orders: ordersRepo,
    seats: seatsRepo,
    promos: promosRepo,
    feeWaivers: feeWaiversRepo,
    credits: creditsRepo,
    resaleListings: resaleListingsRepo,
  };

  const tx = vi.fn(async (fn: (t: typeof txRepos) => Promise<unknown>) => {
    const snapshot = {
      orderStatus,
      seatStatuses: new Map(seatStatuses),
      seatUpdatedAt: new Map(seatUpdatedAt),
      releasedHolds: { ...releasedHolds },
      listingState,
    };
    txDepth++;
    try {
      return await fn(txRepos);
    } catch (err) {
      // ROLLBACK. Without this the fake would happily "commit" a half-written
      // transaction and the atomicity tests below would prove nothing.
      orderStatus = snapshot.orderStatus;
      seatStatuses.clear();
      for (const [k, v] of snapshot.seatStatuses) seatStatuses.set(k, v);
      seatUpdatedAt.clear();
      for (const [k, v] of snapshot.seatUpdatedAt) seatUpdatedAt.set(k, v);
      Object.assign(releasedHolds, snapshot.releasedHolds);
      listingState = snapshot.listingState;
      throw err;
    } finally {
      txDepth--;
    }
  });

  const deps: ReleaseCartHoldDeps = {
    repos: {
      tx: tx as unknown as ReleaseCartHoldDeps["repos"]["tx"],
      orders: { getById: ordersRepo.getById } as unknown as
        ReleaseCartHoldDeps["repos"]["orders"],
    },
    ...(overrides.noPayments
      ? {}
      : {
          payments:
            payments as unknown as NonNullable<ReleaseCartHoldDeps["payments"]>,
        }),
    reportError,
    clock,
  };

  return {
    deps,
    mocks: {
      tx,
      ordersRepo,
      seatsRepo,
      promosRepo,
      feeWaiversRepo,
      creditsRepo,
      resaleListingsRepo,
      payments,
      reportError,
    },
    seatStatuses,
    seatUpdatedAt,
    releasedHolds,
    cancelTxDepths,
    releaseSeatsTxDepths,
    callLog,
    get orderStatus() {
      return orderStatus;
    },
    get listingState() {
      return listingState;
    },
  };
}

const release = (deps: ReleaseCartHoldDeps) =>
  releaseCartHold(deps, {
    actorHumanId: DEFAULT_ACTOR_ID,
    orderId: DEFAULT_ORDER_ID,
  });

// ─────────────────────────────────────────────────────────────────────────────

describe("releaseCartHold — guards", () => {
  it("returns released:false, gone, for an order that does not exist", async () => {
    const ctx = buildDeps({ order: null });
    await expect(release(ctx.deps)).resolves.toEqual({
      released: false,
      gone: true,
    });
    expect(ctx.mocks.tx).not.toHaveBeenCalled();
  });

  it("calls a CANCELLED cart gone: it holds nothing, the buyer may hold afresh", async () => {
    const ctx = buildDeps({ order: buildOrder({ status: "CANCELLED" }) });
    await expect(release(ctx.deps)).resolves.toEqual({
      released: false,
      gone: true,
    });
    expect(ctx.mocks.payments.cancelPaymentIntent).not.toHaveBeenCalled();
    expect(ctx.mocks.tx).not.toHaveBeenCalled();
  });

  it("refuses somebody else's order", async () => {
    const ctx = buildDeps({
      order: buildOrder({ buyerHumanId: "someone-else" }),
    });
    await expect(release(ctx.deps)).rejects.toMatchObject({
      code: "NOT_RESOURCE_OWNER",
    });
    expect(ctx.mocks.tx).not.toHaveBeenCalled();
    expect(ctx.mocks.payments.cancelPaymentIntent).not.toHaveBeenCalled();
  });

  it("does nothing to an already-finalized order, and never calls a paid one gone", async () => {
    const ctx = buildDeps({ order: buildOrder({ status: "SUCCEEDED" }) });
    // toEqual: no `gone` key. A paid order must never be held afresh.
    await expect(release(ctx.deps)).resolves.toEqual({ released: false });
    expect(ctx.mocks.payments.cancelPaymentIntent).not.toHaveBeenCalled();
    expect(ctx.mocks.tx).not.toHaveBeenCalled();
  });
});

describe("releaseCartHold — the PaymentIntent decides", () => {
  it("cancels the PI, then cancels the cart and frees its seats", async () => {
    const ctx = buildDeps({ order: buildOrder({ items: [seatItem([SEAT_A])] }) });

    await expect(release(ctx.deps)).resolves.toEqual({ released: true });

    expect(ctx.mocks.payments.cancelPaymentIntent).toHaveBeenCalledWith({
      paymentIntentId: DEFAULT_PI_ID,
    });
    expect(ctx.orderStatus).toBe("CANCELLED");
    expect(ctx.seatStatuses.get(SEAT_A)).toBe("AVAILABLE");
    expect(ctx.releasedHolds).toEqual({
      promos: 1,
      feeWaivers: 1,
      credits: 1,
    });
    expect(ctx.mocks.reportError).not.toHaveBeenCalled();
  });

  // ── THE test. ────────────────────────────────────────────────────────────
  // The buyer pays, then closes the tab; `sendBeacon` fires before Stripe's
  // webhook does. Cancelling the order here strands a real charge: finalize
  // hits its terminal-status guard, throws ORDER_NOT_PROCESSABLE into the DLQ,
  // and mints nothing. Charged, no ticket, no refund.
  //
  // `cancelPaymentIntent` returns `{ canceled: false }` WITHOUT throwing for an
  // an already-`succeeded` PI (the Stripe adapter swallows
  // `payment_intent_unexpected_state`), so nothing about the cancel call
  // signals danger. Only the status probe does.
  describe("when the PaymentIntent already SUCCEEDED", () => {
    const paidCart = () =>
      buildDeps({
        order: buildOrder({ items: [seatItem([SEAT_A])] }),
        piCancelResult: { canceled: false },
        piStatus: "succeeded",
      });

    it("KEEPS the cart: the order stays PENDING", async () => {
      const ctx = paidCart();
      await expect(release(ctx.deps)).resolves.toEqual({ released: false });
      expect(ctx.mocks.ordersRepo.cancelPendingOrder).not.toHaveBeenCalled();
      expect(ctx.orderStatus).toBe("PENDING");
      expect(ctx.mocks.tx).not.toHaveBeenCalled();
    });

    it("KEEPS the cart's seats — mint still claims them", async () => {
      // `mintTicketsForOrder` reads `meta.seatIds`, so a released seat is one
      // the paid order will still assign: sold twice, minted once.
      const ctx = paidCart();
      await release(ctx.deps);
      expect(ctx.seatStatuses.get(SEAT_A)).toBe("HELD");
      expect(ctx.mocks.seatsRepo.releaseSeats).not.toHaveBeenCalled();
      expect(ctx.mocks.seatsRepo.updateStatuses).not.toHaveBeenCalled();
    });

    it("KEEPS the promo, fee-waiver and credit holds", async () => {
      const ctx = paidCart();
      await release(ctx.deps);
      expect(ctx.releasedHolds).toEqual({
        promos: 0,
        feeWaivers: 0,
        credits: 0,
      });
    });

    it("REPORTS it — `logger.warn` was invisible to Sentry", async () => {
      const ctx = paidCart();
      await release(ctx.deps);
      expect(ctx.mocks.reportError).toHaveBeenCalledTimes(1);
      const [err, context] = ctx.mocks.reportError.mock.calls[0]!;
      expect(String((err as Error).message)).toContain("succeeded");
      expect(context).toMatchObject({
        tags: { caller: "releaseCartHold" },
        extra: { orderId: DEFAULT_ORDER_ID, status: "succeeded" },
      });
    });
  });

  it("KEEPS the cart when the PI is still `processing`", async () => {
    // Resolves to succeeded or back to requires_payment_method; either way the
    // charge may still land.
    const ctx = buildDeps({
      order: buildOrder({ items: [seatItem([SEAT_A])] }),
      piCancelResult: { canceled: false },
      piStatus: "processing",
    });

    await expect(release(ctx.deps)).resolves.toEqual({ released: false });
    expect(ctx.orderStatus).toBe("PENDING");
    expect(ctx.seatStatuses.get(SEAT_A)).toBe("HELD");
    expect(ctx.mocks.reportError).toHaveBeenCalledTimes(1);
  });

  it("KEEPS the cart when Stripe throws — unknown status is unsafe status", async () => {
    const ctx = buildDeps({ order: buildOrder({ items: [seatItem([SEAT_A])] }) });
    ctx.mocks.payments.cancelPaymentIntent.mockRejectedValue(
      new Error("Stripe is down"),
    );

    await expect(release(ctx.deps)).resolves.toEqual({ released: false });
    expect(ctx.orderStatus).toBe("PENDING");
    expect(ctx.seatStatuses.get(SEAT_A)).toBe("HELD");
    expect(ctx.mocks.tx).not.toHaveBeenCalled();
    expect(ctx.mocks.reportError).toHaveBeenCalledTimes(1);
  });

  it("KEEPS a PI-bearing cart when no processor is wired", async () => {
    // Deliberate behaviour change: this used to cancel the order and free the
    // seats without ever asking Stripe anything.
    const ctx = buildDeps({
      order: buildOrder({ items: [seatItem([SEAT_A])] }),
      noPayments: true,
    });

    await expect(release(ctx.deps)).resolves.toEqual({ released: false });
    expect(ctx.orderStatus).toBe("PENDING");
    expect(ctx.seatStatuses.get(SEAT_A)).toBe("HELD");
    expect(ctx.mocks.reportError).toHaveBeenCalledTimes(1);
  });

  it("releases a cart that never had a PaymentIntent, processor or not", async () => {
    const ctx = buildDeps({
      order: buildOrder({
        stripePaymentIntentId: null,
        items: [seatItem([SEAT_A])],
      }),
      noPayments: true,
    });

    await expect(release(ctx.deps)).resolves.toEqual({ released: true });
    expect(ctx.orderStatus).toBe("CANCELLED");
    expect(ctx.seatStatuses.get(SEAT_A)).toBe("AVAILABLE");
    expect(ctx.mocks.reportError).not.toHaveBeenCalled();
  });

  it("leaves alone an order that gained a PaymentIntent after it was read", async () => {
    // `createCheckout` links its PaymentIntent AFTER the order commits. Read
    // here with no PI (nothing to settle), the order can carry a live one by
    // the time the cancel lands; cancelling it then would strand a payable
    // charge on a CANCELLED order. The cancel CAS carries the PI that was
    // settled (`null`), so the adapter matches nothing.
    const ctx = buildDeps({
      order: buildOrder({
        stripePaymentIntentId: null,
        items: [seatItem([SEAT_A])],
      }),
    });
    const linkedMeanwhile = "pi_linked_meanwhile";
    ctx.mocks.ordersRepo.cancelPendingOrder.mockImplementationOnce(
      async (_id: string, opts?: { expectedPaymentIntentId: string | null }) =>
        // The adapter's WHERE: status PENDING AND stripePaymentIntentId = expected.
        opts !== undefined && opts.expectedPaymentIntentId === linkedMeanwhile,
    );

    await expect(release(ctx.deps)).resolves.toEqual({ released: false });

    expect(ctx.mocks.ordersRepo.cancelPendingOrder).toHaveBeenCalledWith(
      DEFAULT_ORDER_ID,
      { expectedPaymentIntentId: null },
    );
    expect(ctx.mocks.payments.cancelPaymentIntent).not.toHaveBeenCalled();
    expect(ctx.orderStatus).toBe("PENDING");
    expect(ctx.seatStatuses.get(SEAT_A)).toBe("HELD");
  });

  it("retires a cart whose PI was already `canceled` (idempotent replay)", async () => {
    const ctx = buildDeps({
      order: buildOrder({ items: [seatItem([SEAT_A])] }),
      piCancelResult: { canceled: false },
      piStatus: "canceled",
    });

    await expect(release(ctx.deps)).resolves.toEqual({ released: true });
    expect(ctx.mocks.payments.retrievePaymentIntent).toHaveBeenCalled();
    expect(ctx.orderStatus).toBe("CANCELLED");
    expect(ctx.seatStatuses.get(SEAT_A)).toBe("AVAILABLE");
    expect(ctx.mocks.reportError).not.toHaveBeenCalled();
  });
});

describe("releaseCartHold — one transaction", () => {
  it("runs the cancel AND the seat release inside repos.tx", async () => {
    const ctx = buildDeps({ order: buildOrder({ items: [seatItem([SEAT_A])] }) });

    await release(ctx.deps);

    expect(ctx.mocks.tx).toHaveBeenCalledTimes(1);
    expect(ctx.cancelTxDepths).toEqual([1]);
    expect(ctx.releaseSeatsTxDepths).toEqual([1]);
  });

  it("cancels the order BEFORE freeing its seats", async () => {
    // The old order was inverted: seats first, cancel second, no transaction.
    const ctx = buildDeps({ order: buildOrder({ items: [seatItem([SEAT_A])] }) });

    await release(ctx.deps);

    expect(ctx.callLog.indexOf("cancelPendingOrder")).toBeLessThan(
      ctx.callLog.indexOf("releaseSeats"),
    );
  });

  it("rolls the cancel back when the seat release throws", async () => {
    // The defect this replaces: seats were freed on the bare repos before the
    // CAS, so any failure left the order PENDING — still payable, still
    // minting against `meta.seatIds` — with its seats already handed out.
    const ctx = buildDeps({ order: buildOrder({ items: [seatItem([SEAT_A])] }) });
    ctx.mocks.seatsRepo.releaseSeats.mockRejectedValueOnce(
      new Error("deadlock detected"),
    );

    await expect(release(ctx.deps)).rejects.toThrow("deadlock detected");

    expect(ctx.mocks.ordersRepo.cancelPendingOrder).toHaveBeenCalledTimes(1);
    expect(ctx.orderStatus).toBe("PENDING");
    expect(ctx.seatStatuses.get(SEAT_A)).toBe("HELD");
    expect(ctx.releasedHolds).toEqual({
      promos: 0,
      feeWaivers: 0,
      credits: 0,
    });
  });

  it("touches nothing when the CAS cancel loses the race", async () => {
    const ctx = buildDeps({ order: buildOrder({ items: [seatItem([SEAT_A])] }) });
    ctx.mocks.ordersRepo.cancelPendingOrder.mockResolvedValueOnce(false);

    await expect(release(ctx.deps)).resolves.toEqual({ released: false });
    expect(ctx.mocks.promosRepo.releaseHoldsForOrder).not.toHaveBeenCalled();
    expect(ctx.mocks.feeWaiversRepo.release).not.toHaveBeenCalled();
    expect(ctx.mocks.creditsRepo.releaseForOrder).not.toHaveBeenCalled();
    expect(ctx.mocks.seatsRepo.releaseSeats).not.toHaveBeenCalled();
    expect(ctx.seatStatuses.get(SEAT_A)).toBe("HELD");
  });
});

describe("releaseCartHold — the seat fence", () => {
  it("does NOT free a seat re-held by a different, live order", async () => {
    // `Seat` has no holder column. The seat-hold TTL (900s) is shorter than
    // the life of a PENDING cart, so by the time the beacon fires the seat
    // reaper may already have freed SEAT_B and another buyer may be holding —
    // or paying for — it. Both seats are HELD; only one of them is ours.
    const ctx = buildDeps({
      order: buildOrder({ items: [seatItem([SEAT_A, SEAT_B])] }),
      seatUpdatedAt: {
        [SEAT_A]: HELD_AT,
        [SEAT_B]: secondsAfterHold(960),
      },
    });

    await expect(release(ctx.deps)).resolves.toEqual({ released: true });

    expect(ctx.seatStatuses.get(SEAT_A)).toBe("AVAILABLE");
    expect(ctx.seatStatuses.get(SEAT_B)).toBe("HELD");
    // And the fence really is this cart's own hold plus the slack.
    expect(ctx.mocks.seatsRepo.releaseSeats).toHaveBeenCalledWith({
      seatIds: [SEAT_A, SEAT_B],
      releasedAt: BASE_DATE,
      heldBefore: secondsAfterHold(FENCE_SLACK_SECONDS),
    });
  });

  it("does NOT flip a seat the next buyer already PAID for", async () => {
    const ctx = buildDeps({
      order: buildOrder({ items: [seatItem([SEAT_A])] }),
      seatStatuses: { [SEAT_A]: "SOLD" },
      seatUpdatedAt: { [SEAT_A]: secondsAfterHold(960) },
    });

    await release(ctx.deps);
    expect(ctx.seatStatuses.get(SEAT_A)).toBe("SOLD");
  });

  it("fences on the cart's LAST hold, not on `occurredAt`", async () => {
    // `updateOrderItems` re-holds the seats on every cart edit and never
    // rewrites `occurredAt`. An `occurredAt`-only fence would decline this
    // seat — the buyer edited their cart five minutes in, then closed the tab
    // — and leak it until the seat reaper's TTL.
    const editedAt = secondsAfterHold(300);
    const ctx = buildDeps({
      order: buildOrder({ items: [seatItem([SEAT_A], editedAt)] }),
      seatUpdatedAt: { [SEAT_A]: editedAt },
    });

    await expect(release(ctx.deps)).resolves.toEqual({ released: true });
    expect(ctx.seatStatuses.get(SEAT_A)).toBe("AVAILABLE");
    expect(ctx.mocks.seatsRepo.releaseSeats).toHaveBeenCalledWith(
      expect.objectContaining({
        heldBefore: new Date(
          editedAt.getTime() + FENCE_SLACK_SECONDS * 1000,
        ),
      }),
    );
  });

  it("releases NOTHING and reports when no fence can be computed", async () => {
    // Unreachable through Prisma (`occurredAt` is NOT NULL). An
    // ownership-blind release is the double-sell; the seat reaper is the
    // backstop.
    const order = buildOrder({
      items: [
        {
          ...seatItem([SEAT_A]),
          meta: { seatIds: [SEAT_A] },
        },
      ],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (order as any).occurredAt;

    const ctx = buildDeps({ order });

    await expect(release(ctx.deps)).resolves.toEqual({ released: true });
    expect(ctx.mocks.seatsRepo.releaseSeats).not.toHaveBeenCalled();
    expect(ctx.seatStatuses.get(SEAT_A)).toBe("HELD");
    expect(ctx.mocks.reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "release_cart_hold_seat_fence_missing",
      }),
      expect.objectContaining({
        extra: { orderId: DEFAULT_ORDER_ID, seatCount: 1 },
      }),
    );
  });

  it("never uses the blind `updateStatuses` write", async () => {
    const ctx = buildDeps({ order: buildOrder({ items: [seatItem([SEAT_A])] }) });
    await release(ctx.deps);
    expect(ctx.mocks.seatsRepo.updateStatuses).not.toHaveBeenCalled();
  });
});

describe("releaseCartHold — safe to call repeatedly", () => {
  // This runs on `sendBeacon`, so the request can be aborted mid-flight and
  // the client retries freely (page close, then cart-recovery UI).
  it("a second call is a no-op", async () => {
    const ctx = buildDeps({ order: buildOrder({ items: [seatItem([SEAT_A])] }) });

    await expect(release(ctx.deps)).resolves.toEqual({ released: true });
    // The first call cancelled it: the second finds the cart gone.
    await expect(release(ctx.deps)).resolves.toEqual({
      released: false,
      gone: true,
    });

    expect(ctx.mocks.ordersRepo.cancelPendingOrder).toHaveBeenCalledTimes(1);
    expect(ctx.mocks.seatsRepo.releaseSeats).toHaveBeenCalledTimes(1);
    expect(ctx.releasedHolds).toEqual({
      promos: 1,
      feeWaivers: 1,
      credits: 1,
    });
    // The second call short-circuits on status, before Stripe.
    expect(ctx.mocks.payments.cancelPaymentIntent).toHaveBeenCalledTimes(1);
  });

  it("completes on the retry after an abort between the PI settle and the tx", async () => {
    const ctx = buildDeps({ order: buildOrder({ items: [seatItem([SEAT_A])] }) });
    // Attempt 1: PI cancelled, then the transaction dies (connection dropped
    // when the browser aborted the beacon).
    ctx.mocks.tx.mockRejectedValueOnce(new Error("connection terminated"));
    await expect(release(ctx.deps)).rejects.toThrow("connection terminated");
    expect(ctx.orderStatus).toBe("PENDING");
    expect(ctx.seatStatuses.get(SEAT_A)).toBe("HELD");

    // Attempt 2: Stripe's graceful no-op on the now-`canceled` PI, then the
    // transaction completes.
    ctx.mocks.payments.cancelPaymentIntent.mockResolvedValueOnce({
      canceled: false,
    });
    await expect(release(ctx.deps)).resolves.toEqual({ released: true });
    expect(ctx.orderStatus).toBe("CANCELLED");
    expect(ctx.seatStatuses.get(SEAT_A)).toBe("AVAILABLE");
    expect(ctx.mocks.reportError).not.toHaveBeenCalled();
  });

  it("lets exactly one of two racing beacons release the cart", async () => {
    const ctx = buildDeps({ order: buildOrder({ items: [seatItem([SEAT_A])] }) });

    const [first, second] = await Promise.all([
      release(ctx.deps),
      release(ctx.deps),
    ]);

    expect([first.released, second.released].sort()).toEqual([false, true]);
    expect(ctx.seatStatuses.get(SEAT_A)).toBe("AVAILABLE");
    // The loser's CAS declined, so it released nothing a second time.
    expect(ctx.releasedHolds).toEqual({
      promos: 1,
      feeWaivers: 1,
      credits: 1,
    });
  });
});

describe("releaseCartHold — fee-waiver and credit reservations", () => {
  it("returns the cancelled cart's fee-waiver allowance and credit", async () => {
    const ctx = buildDeps();

    await expect(release(ctx.deps)).resolves.toEqual({ released: true });

    expect(ctx.mocks.promosRepo.releaseHoldsForOrder).toHaveBeenCalledWith(
      DEFAULT_ORDER_ID,
    );
    expect(ctx.mocks.feeWaiversRepo.release).toHaveBeenCalledWith(
      DEFAULT_ORDER_ID,
    );
    // The use case's clock, not the adapter's wall clock, decides whether a
    // restored credit is still inside its window.
    expect(ctx.mocks.creditsRepo.releaseForOrder).toHaveBeenCalledWith(
      DEFAULT_ORDER_ID,
      { now: BASE_DATE },
    );
  });

  it("does not touch either on an already-finalized order", async () => {
    const ctx = buildDeps({ order: buildOrder({ status: "SUCCEEDED" }) });
    await release(ctx.deps);
    expect(ctx.mocks.feeWaiversRepo.release).not.toHaveBeenCalled();
    expect(ctx.mocks.creditsRepo.releaseForOrder).not.toHaveBeenCalled();
  });
});

describe("releaseCartHold — a RESALE cart gives its listing back (G1)", () => {
  const LISTING_ID = "listing-1";
  const HELD_UNTIL = new Date(HELD_AT.getTime() + HOLD_TTL_SECONDS * 1000);

  function resaleOrder(holdExpiresAt: Date = HELD_UNTIL) {
    return buildOrder({
      source: "RESALE",
      items: [
        {
          id: "item-resale",
          orderId: DEFAULT_ORDER_ID,
          kind: "ticket",
          ticketTypeId: "tt-1",
          qty: 1,
          unitPriceCents: 5000,
          amountCents: 5000,
          resaleListingId: LISTING_ID,
          meta: {
            holdExpiresAt: holdExpiresAt.toISOString(),
            resaleListingId: LISTING_ID,
            seatId: "seat-singular",
          },
        } as never,
      ],
    });
  }

  it("cancelled cart → listing ACTIVE, hold gone, after the cancel, in the same transaction", async () => {
    const ctx = buildDeps({
      order: resaleOrder(),
      listing: { id: LISTING_ID, buyerHumanId: DEFAULT_ACTOR_ID, heldUntil: HELD_UNTIL },
    });

    await expect(release(ctx.deps)).resolves.toEqual({ released: true });

    expect(ctx.orderStatus).toBe("CANCELLED");
    expect(ctx.listingState).toEqual({ status: "ACTIVE", hold: null });
    expect(ctx.callLog.indexOf("cancelPendingOrder")).toBeLessThan(
      ctx.callLog.indexOf("releaseHold"),
    );
    expect(ctx.mocks.tx).toHaveBeenCalledTimes(1);
  });

  it("CAS lost → the listing stays HELD with its hold", async () => {
    const ctx = buildDeps({
      order: resaleOrder(),
      listing: { id: LISTING_ID, buyerHumanId: DEFAULT_ACTOR_ID, heldUntil: HELD_UNTIL },
    });
    ctx.mocks.ordersRepo.cancelPendingOrder.mockResolvedValueOnce(false);

    await expect(release(ctx.deps)).resolves.toEqual({ released: false });

    expect(ctx.mocks.resaleListingsRepo.releaseHold).not.toHaveBeenCalled();
    expect(ctx.listingState?.status).toBe("HELD");
  });

  it("a newer hold on the listing (different heldUntil) is not freed by this stale cart", async () => {
    const ctx = buildDeps({
      order: resaleOrder(),
      listing: {
        id: LISTING_ID,
        buyerHumanId: DEFAULT_ACTOR_ID,
        heldUntil: new Date(HELD_UNTIL.getTime() + 60_000),
      },
    });

    await expect(release(ctx.deps)).resolves.toEqual({ released: true });

    expect(ctx.mocks.resaleListingsRepo.releaseHold).toHaveBeenCalledTimes(1);
    expect(ctx.listingState?.status).toBe("HELD");
  });

  it("a failed listing release rolls the cancel back with it", async () => {
    const ctx = buildDeps({
      order: resaleOrder(),
      listing: { id: LISTING_ID, buyerHumanId: DEFAULT_ACTOR_ID, heldUntil: HELD_UNTIL },
    });
    ctx.mocks.resaleListingsRepo.releaseHold.mockRejectedValueOnce(
      new Error("lock_timeout"),
    );

    await expect(release(ctx.deps)).rejects.toThrow("lock_timeout");

    expect(ctx.orderStatus).toBe("PENDING");
    expect(ctx.listingState?.status).toBe("HELD");
  });
});
