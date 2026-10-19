import { describe, expect, it, vi } from "vitest";

import {
  CART_REAPER_PERIOD_SECONDS,
  releaseExpiredCarts,
} from "../release-expired-carts";
import type { ReleaseExpiredCartsDeps } from "../release-expired-carts";
import { createCartReapQuarantine } from "../_shared/cart-reap-quarantine";

const BASE_DATE = new Date("2024-02-01T00:20:00.000Z"); // 20 min past the hour
/**
 * When the carts under test were created, i.e. exactly `DEFAULT_CART_TTL_SECONDS`
 * (1200s) before `BASE_DATE`, and — matching `create-checkout`, which inserts
 * the order and stamps its seats HELD in one transaction — also when their
 * seats were last held.
 */
const OCCURRED_AT = new Date("2024-02-01T00:00:00.000Z");
const secondsAfterOccurred = (seconds: number) =>
  new Date(OCCURRED_AT.getTime() + seconds * 1000);
/**
 * `SEAT_FENCE_SLACK_SECONDS` in the use case — the slack the seat fence adds
 * to `occurredAt` so a stamp written by the app clock inside the same
 * transaction as the DB-clock `occurredAt` is still recognised as this cart's.
 */
const FENCE = secondsAfterOccurred(60);

type ExpiredOrder = {
  id: string;
  stripePaymentIntentId: string | null;
  buyerHumanId: string;
};

type SeatStatus = "AVAILABLE" | "HELD" | "SOLD";

function buildDeps(
  overrides: {
    expiredOrders?: ExpiredOrder[];
    /** `meta.seatIds` returned by `orders.getById` for every order. */
    seatIds?: string[];
    /** Per-order `meta.seatIds`, for tests where the carts differ. */
    seatIdsByOrder?: Record<string, string[]>;
    /** Starting seat statuses. Anything not listed starts HELD. */
    seatStatuses?: Record<string, SeatStatus>;
    /**
     * `Seat.updatedAt` per seat. Anything not listed was stamped at
     * `OCCURRED_AT` — i.e. by the cart under test.
     *
     * Modelled because `Seat` has NO holder column: `updatedAt` is the only
     * thing that distinguishes "still held by this dead cart" from "re-held
     * by the buyer who took the seat after it expired", and the second one
     * must survive the reaper.
     */
    seatUpdatedAt?: Record<string, Date>;
    /** `Order.occurredAt` per order. Defaults to `OCCURRED_AT`. */
    occurredAtByOrder?: Record<string, Date>;
    /** Drop `occurredAt` from `orders.getById` entirely (fence-missing path). */
    omitOccurredAt?: boolean;
    /** Orders that are RESALE, with the listing + hold expiry their item records. */
    resaleByOrder?: Record<string, { listingId: string; holdExpiresAt: string }>;
  } = {},
) {
  const expiredOrders = overrides.expiredOrders ?? [];
  const seatIds = overrides.seatIds ?? [];
  const seatIdsByOrder = overrides.seatIdsByOrder ?? {};

  // `txDepth` is read by the tx-surface mocks so a test can prove a call
  // happened INSIDE `repos.tx` rather than on the bare repos.
  let txDepth = 0;
  const cancelTxDepths: number[] = [];
  const txRejections: unknown[] = [];

  // The clock is mutable so a test can run SEVERAL passes and watch what the
  // reaper remembers between them.
  let nowValue = BASE_DATE;
  const setNow = (next: Date) => {
    nowValue = next;
  };
  const advance = (seconds: number) => {
    nowValue = new Date(nowValue.getTime() + seconds * 1000);
  };

  const metaFor = (id: string) => seatIdsByOrder[id] ?? seatIds;
  const occurredAtFor = (id: string) =>
    overrides.occurredAtByOrder?.[id] ?? OCCURRED_AT;

  const ordersRepo = {
    // A real mini-query, not a constant: `limit` and `excludeOrderIds` are
    // load-bearing for head-of-line starvation, so the fake has to honour
    // them or the starvation test proves nothing.
    listExpiredPending: vi.fn(
      async (input: { limit?: number; excludeOrderIds?: string[] }) => {
        const excluded = new Set(input.excludeOrderIds ?? []);
        return expiredOrders
          .filter((o) => !excluded.has(o.id))
          .slice(0, input.limit ?? 100);
      },
    ),
    cancelPendingOrder: vi.fn(async (_id: string) => {
      cancelTxDepths.push(txDepth);
      return true;
    }),
    getById: vi.fn(async (id: string) => {
      const resale = overrides.resaleByOrder?.[id];
      return {
        id,
        source: resale ? "RESALE" : "PRIMARY",
        buyerHumanId: "buyer-1",
        ...(overrides.omitOccurredAt ? {} : { occurredAt: occurredAtFor(id) }),
        items: resale
          ? [
              {
                id: `${id}-item`,
                resaleListingId: resale.listingId,
                meta: {
                  holdExpiresAt: resale.holdExpiresAt,
                  resaleListingId: resale.listingId,
                },
              },
            ]
          : metaFor(id).length > 0
            ? [{ meta: { seatIds: metaFor(id) } }]
            : [],
      };
    }),
  };

  // Seat status AND `updatedAt` are REAL state here, and both methods behave
  // exactly like the Prisma adapter: `updateStatuses` is a blind
  // `updateMany({ where: { id: { in } } })` with no predicate at all
  // (packages/adapters/src/db/prisma/seats.ts), while `releaseSeats` carries
  // `status: "HELD"` plus the optional `updatedAt: { lte: heldBefore }`
  // fence. Both differences are the whole point of the tests below — a call-
  // shape assertion cannot tell you whether the row actually moved — so the
  // fake models the columns rather than the calls.
  const seatStatuses = new Map<string, SeatStatus>(
    Object.entries(overrides.seatStatuses ?? {}),
  );
  const seatUpdatedAt = new Map<string, Date>(
    Object.entries(overrides.seatUpdatedAt ?? {}),
  );
  const allSeatIds = new Set<string>([
    ...seatIds,
    ...Object.values(seatIdsByOrder).flat(),
    ...Object.keys(overrides.seatStatuses ?? {}),
    ...Object.keys(overrides.seatUpdatedAt ?? {}),
  ]);
  for (const id of allSeatIds) {
    if (!seatStatuses.has(id)) seatStatuses.set(id, "HELD");
    if (!seatUpdatedAt.has(id)) seatUpdatedAt.set(id, OCCURRED_AT);
  }

  const seatsRepo = {
    updateStatuses: vi.fn(
      async (input: {
        seatIds: string[];
        status: SeatStatus;
        updatedAt: Date;
      }) => {
        for (const id of input.seatIds) {
          seatStatuses.set(id, input.status);
          seatUpdatedAt.set(id, input.updatedAt);
        }
      },
    ),
    releaseSeats: vi.fn(
      async (input: {
        seatIds: string[];
        releasedAt: Date;
        heldBefore?: Date;
      }) => {
        for (const id of input.seatIds) {
          if (seatStatuses.get(id) !== "HELD") continue;
          // Mirrors the Prisma `where` exactly: `status: "HELD"` plus, when
          // the caller passes one, `updatedAt: { lte: heldBefore }`.
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
  };

  const promosRepo = {
    releaseHoldsForOrder: vi.fn(async () => undefined),
  };

  const feeWaiversRepo = {
    release: vi.fn(async () => ({ releasedTickets: 0 })),
  };

  const creditsRepo = {
    releaseForOrder: vi.fn(async () => ({ releasedCents: 0, creditIds: [] })),
  };

  const releaseHoldTxDepths: number[] = [];
  const resaleListingsRepo = {
    releaseHold: vi.fn(async () => {
      releaseHoldTxDepths.push(txDepth);
      return { released: true, listingStatus: "ACTIVE" };
    }),
  };

  // `cancelPaymentIntent` is what the reaper asks for; `retrievePaymentIntent`
  // is the status probe the settle helper falls back to when the cancel is a
  // graceful no-op (`{ canceled: false }`). See retire-carried-over-cart.ts.
  const payments = {
    cancelPaymentIntent: vi.fn(async () => ({ canceled: true })),
    retrievePaymentIntent: vi.fn(async () => ({
      id: "pi_1",
      status: "canceled",
      amountReceived: 0,
      currency: "usd",
      metadata: {},
    })),
  };

  const reportError = vi.fn();

  const clock = { now: vi.fn(() => nowValue) };

  const txRepos = {
    orders: ordersRepo,
    seats: seatsRepo,
    promos: promosRepo,
    feeWaivers: feeWaiversRepo,
    credits: creditsRepo,
    resaleListings: resaleListingsRepo,
  };

  const tx = vi.fn(async (fn: (t: typeof txRepos) => Promise<unknown>) => {
    txDepth++;
    try {
      return await fn(txRepos);
    } catch (err) {
      txRejections.push(err);
      throw err;
    } finally {
      txDepth--;
    }
  });

  // The real quarantine, not a mock: the property under test ("a refusing
  // cart stops being probed") lives in the interaction between the two.
  const quarantine = createCartReapQuarantine();

  // The NON-tx surface deliberately carries only what the reaper may touch
  // outside a transaction (the expired-order scan). The deps type now says
  // exactly that, so this needs no `as any` — only a targeted cast on the
  // transaction handle, whose callback receives a partial TxRepos.
  const deps: ReleaseExpiredCartsDeps = {
    repos: {
      tx: tx as unknown as ReleaseExpiredCartsDeps["repos"]["tx"],
      orders: { listExpiredPending: ordersRepo.listExpiredPending },
    },
    payments: payments as unknown as ReleaseExpiredCartsDeps["payments"],
    reportError,
    clock,
    quarantine,
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
    releaseHoldTxDepths,
    quarantine,
    seatStatuses,
    setNow,
    advance,
    cancelTxDepths,
    txRejections,
    seatUpdatedAt,
  };
}

const withPi = (id: string, pi: string): ExpiredOrder => ({
  id,
  stripePaymentIntentId: pi,
  buyerHumanId: `human-${id}`,
});
const withoutPi = (id: string): ExpiredOrder => ({
  id,
  stripePaymentIntentId: null,
  buyerHumanId: `human-${id}`,
});

/** Makes every PI probe report the cart as paid — a refusal that never clears. */
function wedgeOnSucceededPi(mocks: ReturnType<typeof buildDeps>["mocks"]) {
  mocks.payments.cancelPaymentIntent.mockResolvedValue({ canceled: false });
  mocks.payments.retrievePaymentIntent.mockResolvedValue({
    id: "pi_1",
    status: "succeeded",
    amountReceived: 1000,
    currency: "usd",
    metadata: {},
  });
}

describe("releaseExpiredCarts", () => {
  it("returns zero counts when no expired orders exist", async () => {
    const { deps } = buildDeps({ expiredOrders: [] });
    const result = await releaseExpiredCarts(deps, {});

    expect(result.cancelledCount).toBe(0);
    expect(result.piCancelledCount).toBe(0);
  });

  it("cancels expired orders and their PIs", async () => {
    const { deps, mocks } = buildDeps({
      expiredOrders: [withPi("order-1", "pi_1"), withPi("order-2", "pi_2")],
    });

    const result = await releaseExpiredCarts(deps, {});

    expect(result.cancelledCount).toBe(2);
    expect(result.piCancelledCount).toBe(2);
    expect(mocks.ordersRepo.cancelPendingOrder).toHaveBeenCalledTimes(2);
    expect(mocks.payments.cancelPaymentIntent).toHaveBeenCalledTimes(2);
  });

  // ── The PaymentIntent-first rule (money audit #26) ─────────────────────
  //
  // A PENDING order's PI stays confirmable until it is cancelled. If the
  // reaper cancels the ORDER first and the PI cancel then fails (or the PI
  // has just gone `succeeded`), the buyer's webhook finds a CANCELLED order,
  // throws ORDER_NOT_PROCESSABLE into the DLQ, and they are charged with no
  // ticket — the exact failure 0479f975 fixed for finalize's stale-cart path.

  it("cancels the PaymentIntent BEFORE cancelling the order", async () => {
    const { deps, mocks } = buildDeps({
      expiredOrders: [withPi("order-1", "pi_1")],
    });
    const order: string[] = [];
    mocks.payments.cancelPaymentIntent.mockImplementation(async () => {
      order.push("cancel_pi");
      return { canceled: true };
    });
    mocks.ordersRepo.cancelPendingOrder.mockImplementation(async () => {
      order.push("cancel_order");
      return true;
    });

    await releaseExpiredCarts(deps, {});

    expect(mocks.payments.cancelPaymentIntent).toHaveBeenCalledWith({
      paymentIntentId: "pi_1",
    });
    expect(order).toEqual(["cancel_pi", "cancel_order"]);
  });

  it("settles the PaymentIntent with NO transaction open", async () => {
    // The Stripe client is `timeout: 60_000, maxNetworkRetries: 1` — 240s
    // worst case for the cancel + retrieve pair, against a 30s `repos.tx`
    // budget and a pool of 10. Holding a pooled connection across that for
    // every expired cart is how a Stripe slowdown becomes a database outage.
    const { deps, mocks } = buildDeps({
      expiredOrders: [withPi("order-1", "pi_1")],
    });
    let txOpenDuringSettle: boolean | null = null;
    mocks.payments.cancelPaymentIntent.mockImplementation(async () => {
      txOpenDuringSettle = mocks.tx.mock.calls.length > 0;
      return { canceled: true };
    });

    await releaseExpiredCarts(deps, {});

    expect(txOpenDuringSettle).toBe(false);
    expect(mocks.tx).toHaveBeenCalledTimes(1);
  });

  it("KEEPS the order and its seats when the PI already SUCCEEDED, and reports it", async () => {
    // `cancelPaymentIntent` is a graceful no-op on a terminal PI; the helper
    // reads the status back and refuses when the buyer has actually paid.
    const { deps, mocks } = buildDeps({
      expiredOrders: [withPi("order-1", "pi_1")],
      seatIds: ["seat-a", "seat-b"],
    });
    wedgeOnSucceededPi(mocks);

    const result = await releaseExpiredCarts(deps, {});

    expect(result.cancelledCount).toBe(0);
    expect(result.piCancelledCount).toBe(0);
    expect(mocks.ordersRepo.cancelPendingOrder).not.toHaveBeenCalled();
    expect(mocks.seatsRepo.releaseSeats).not.toHaveBeenCalled();
    expect(mocks.seatsRepo.updateStatuses).not.toHaveBeenCalled();
    expect(mocks.promosRepo.releaseHoldsForOrder).not.toHaveBeenCalled();
    expect(mocks.feeWaiversRepo.release).not.toHaveBeenCalled();
    expect(mocks.creditsRepo.releaseForOrder).not.toHaveBeenCalled();
    expect(mocks.reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("succeeded"),
      }),
      expect.objectContaining({
        tags: expect.objectContaining({
          step: "retireCarriedOverCart",
          caller: "releaseExpiredCarts",
        }),
      }),
    );
  });

  it("KEEPS the order when Stripe throws on the PI cancel, reports it, and moves on", async () => {
    const { deps, mocks } = buildDeps({
      expiredOrders: [withPi("order-1", "pi_1"), withPi("order-2", "pi_2")],
    });

    mocks.payments.cancelPaymentIntent
      .mockRejectedValueOnce(new Error("Stripe error"))
      .mockResolvedValueOnce({ canceled: true });

    const result = await releaseExpiredCarts(deps, {});

    expect(result.cancelledCount).toBe(1);
    expect(result.piCancelledCount).toBe(1);
    expect(mocks.ordersRepo.cancelPendingOrder).toHaveBeenCalledTimes(1);
    expect(mocks.ordersRepo.cancelPendingOrder).toHaveBeenCalledWith(
      "order-2",
      { expectedPaymentIntentId: "pi_2" },
    );
    expect(mocks.seatsRepo.releaseSeats).not.toHaveBeenCalled();
    expect(mocks.reportError).toHaveBeenCalledTimes(1);
    expect(mocks.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ caller: "releaseExpiredCarts" }),
        extra: expect.objectContaining({ orderId: "order-1" }),
      }),
    );
  });

  it("cancels an order with no PaymentIntent without touching Stripe", async () => {
    const { deps, mocks } = buildDeps({
      expiredOrders: [withoutPi("order-1")],
    });

    const result = await releaseExpiredCarts(deps, {});

    expect(result.cancelledCount).toBe(1);
    expect(result.piCancelledCount).toBe(0);
    expect(mocks.payments.cancelPaymentIntent).not.toHaveBeenCalled();
    expect(mocks.payments.retrievePaymentIntent).not.toHaveBeenCalled();
    expect(mocks.ordersRepo.cancelPendingOrder).toHaveBeenCalledWith(
      "order-1",
      { expectedPaymentIntentId: null },
    );
  });

  it("REFUSES to cancel a PI-bearing order when no processor is wired in", async () => {
    // De-holding under a live PI is the unsafe direction; an order with no PI
    // has nothing to prove and is still reaped.
    const { deps, mocks } = buildDeps({
      expiredOrders: [withPi("order-1", "pi_1"), withoutPi("order-2")],
    });
    deps.payments = undefined;

    const result = await releaseExpiredCarts(deps, {});

    expect(result.cancelledCount).toBe(1);
    expect(result.piCancelledCount).toBe(0);
    expect(mocks.ordersRepo.cancelPendingOrder).toHaveBeenCalledTimes(1);
    expect(mocks.ordersRepo.cancelPendingOrder).toHaveBeenCalledWith(
      "order-2",
      { expectedPaymentIntentId: null },
    );
    expect(mocks.reportError).toHaveBeenCalledTimes(1);
  });

  it("stops re-reporting the no-processor refusal on every pass", async () => {
    // The container's stub processor is built once at boot, so this refusal
    // cannot resolve while the process lives. Re-asking is pure noise.
    const { deps, mocks, advance } = buildDeps({
      expiredOrders: [withPi("order-1", "pi_1")],
    });
    deps.payments = undefined;

    for (let pass = 0; pass < 5; pass++) {
      await releaseExpiredCarts(deps, {});
      advance(60 * 60);
    }

    expect(mocks.reportError).toHaveBeenCalledTimes(1);
  });

  // ── Seats ──────────────────────────────────────────────────────────────

  it("releases the seats of a retired order", async () => {
    const { deps, mocks, seatStatuses } = buildDeps({
      expiredOrders: [withPi("order-1", "pi_1")],
      seatIds: ["seat-a", "seat-b"],
    });

    await releaseExpiredCarts(deps, {});

    expect(mocks.seatsRepo.releaseSeats).toHaveBeenCalledTimes(1);
    expect(mocks.seatsRepo.releaseSeats).toHaveBeenCalledWith({
      seatIds: ["seat-a", "seat-b"],
      releasedAt: BASE_DATE,
      heldBefore: FENCE,
    });
    expect(seatStatuses.get("seat-a")).toBe("AVAILABLE");
    expect(seatStatuses.get("seat-b")).toBe("AVAILABLE");
  });

  it("does NOT un-sell a seat that another buyer has already bought", async () => {
    // This is guaranteed by configuration, not a rare race. The seat-hold TTL
    // is 900s (`tickets/release-expired-holds`); the cart TTL is 1200s plus up
    // to one 300s cron period. The seat reaper is order-state-blind, so it
    // ALWAYS frees this cart's seats 5-10 minutes before the cart reaper gets
    // here — long enough for another buyer to take one and pay for it.
    //
    // A blind `updateStatuses` then flips a SOLD seat with a Ticket attached
    // back to AVAILABLE, a third buyer takes it, and two people show up at the
    // door with a valid ticket for one chair. Every other release path in the
    // codebase (`create-checkout`, `claim-free-tickets`, `update-order-items`,
    // both POS paths) guards on HELD; so must this one.
    const { deps, mocks, seatStatuses } = buildDeps({
      expiredOrders: [withPi("order-1", "pi_1")],
      seatIds: ["seat-sold", "seat-still-held"],
      seatStatuses: { "seat-sold": "SOLD", "seat-still-held": "HELD" },
    });

    const result = await releaseExpiredCarts(deps, {});

    expect(result.cancelledCount).toBe(1);
    // The stale cart still gives up what it genuinely still holds …
    expect(seatStatuses.get("seat-still-held")).toBe("AVAILABLE");
    // … and cannot touch what somebody else has paid for.
    expect(seatStatuses.get("seat-sold")).toBe("SOLD");
    expect(mocks.seatsRepo.updateStatuses).not.toHaveBeenCalled();
  });

  it("does NOT free a seat another buyer is holding RIGHT NOW", async () => {
    // The half `86066f24` left open, and the MORE reachable half.
    //
    // `Seat` has no holder column — only `status` and `updatedAt` — so
    // `status: "HELD"` proves somebody holds the seat, not that this cart
    // does. And the commit's own premise guarantees somebody else will:
    //
    //   T+0     cart A holds seat S (HELD, updatedAt = T+0)
    //   T+900   tickets/release-expired-holds frees S -> AVAILABLE
    //   T+960   buyer B checks out; S is AVAILABLE with no ticket, so it goes
    //           HELD under B's PENDING order behind a live PaymentIntent
    //   T+1200… the cart reaper takes A and reads S out of A's STALE meta
    //
    // Un-holding S there hands B's seat to buyer C, who pays and mints a
    // ticket on it; B's PaymentIntent is still confirmable, B pays, and
    // finalize mints against B's `meta.seatIds`. Two valid tickets, one chair.
    const { deps, mocks, seatStatuses } = buildDeps({
      expiredOrders: [withPi("order-1", "pi_1")],
      seatIds: ["seat-mine", "seat-reheld"],
      seatStatuses: { "seat-mine": "HELD", "seat-reheld": "HELD" },
      seatUpdatedAt: {
        // Stamped by this cart, in the transaction that inserted it.
        "seat-mine": OCCURRED_AT,
        // Freed by the seat reaper at +900 and taken by another buyer at +960.
        "seat-reheld": secondsAfterOccurred(960),
      },
    });

    const result = await releaseExpiredCarts(deps, {});

    expect(result.cancelledCount).toBe(1);
    // The dead cart still gives up what it genuinely still holds …
    expect(seatStatuses.get("seat-mine")).toBe("AVAILABLE");
    // … and cannot take a seat out from under a live checkout.
    expect(seatStatuses.get("seat-reheld")).toBe("HELD");
    expect(mocks.seatsRepo.updateStatuses).not.toHaveBeenCalled();
  });

  it("fences on the cart's OWN occurredAt, not on the pass cutoff", async () => {
    // Why the fence cannot be the `now - ttlSeconds` cutoff the scan used:
    // that instant is pass-relative, not cart-relative. Let the reaper fall
    // behind — a backlog longer than `limit`, or the job down for an hour —
    // and the cutoff marches past holds taken long after this cart died.
    //
    // Here the cart is three hours old and the competing hold is 30 minutes
    // old: comfortably before the 20-minute cutoff, comfortably after the
    // cart's `occurredAt`.
    const staleCartOccurredAt = new Date(
      BASE_DATE.getTime() - 3 * 60 * 60 * 1000,
    );
    const { deps, seatStatuses } = buildDeps({
      expiredOrders: [withPi("order-1", "pi_1")],
      seatIds: ["seat-reheld"],
      occurredAtByOrder: { "order-1": staleCartOccurredAt },
      seatUpdatedAt: {
        "seat-reheld": new Date(BASE_DATE.getTime() - 30 * 60 * 1000),
      },
    });

    const result = await releaseExpiredCarts(deps, {});

    expect(result.cancelledCount).toBe(1);
    expect(seatStatuses.get("seat-reheld")).toBe("HELD");
  });

  it("frees a seat stamped just AFTER occurredAt, inside the same transaction", async () => {
    // `Order.occurredAt` is `@default(now())` — Postgres, at transaction
    // start — while `Seat.updatedAt` is written by the application clock, so
    // which of the two reads earlier is not something this code gets to
    // decide. A bare `occurredAt` fence would silently decline every seat if
    // the seat stamp landed a second later, turning the whole release into a
    // no-op that no test would notice. The slack is what stops that.
    const { deps, seatStatuses } = buildDeps({
      expiredOrders: [withPi("order-1", "pi_1")],
      seatIds: ["seat-late-stamp"],
      // Later than `occurredAt`, well inside the 30s `repos.tx` budget.
      seatUpdatedAt: { "seat-late-stamp": secondsAfterOccurred(20) },
    });

    await releaseExpiredCarts(deps, {});

    expect(seatStatuses.get("seat-late-stamp")).toBe("AVAILABLE");
  });

  it("still frees seats re-held by the SAME cart before it expired", async () => {
    // `updateOrderItems` re-stamps the seats on every cart edit and never
    // rewrites `occurredAt`, so an edited cart's seats carry a stamp AFTER
    // its `occurredAt` and the fence declines them. That is the leak
    // direction, not the theft direction — `tickets/release-expired-holds`
    // frees them 900s after the edit — but the untouched cart, which is the
    // overwhelmingly common one, must still be released here.
    const { deps, seatStatuses } = buildDeps({
      expiredOrders: [withPi("order-1", "pi_1")],
      seatIds: ["seat-a"],
      seatUpdatedAt: { "seat-a": OCCURRED_AT },
    });

    await releaseExpiredCarts(deps, {});

    expect(seatStatuses.get("seat-a")).toBe("AVAILABLE");
  });

  it("reports instead of releasing unfenced when the cart has no occurredAt", async () => {
    // Unreachable through the Prisma repo (`occurredAt` is NOT NULL and
    // always mapped), and asserted anyway: silently falling back to an
    // ownership-blind release is the double-sell this fence exists to stop,
    // so the fallback has to be a Sentry event and a no-op.
    const { deps, mocks, seatStatuses } = buildDeps({
      expiredOrders: [withPi("order-1", "pi_1")],
      seatIds: ["seat-a"],
      omitOccurredAt: true,
    });

    const result = await releaseExpiredCarts(deps, {});

    expect(result.cancelledCount).toBe(1);
    expect(mocks.seatsRepo.releaseSeats).not.toHaveBeenCalled();
    expect(mocks.seatsRepo.updateStatuses).not.toHaveBeenCalled();
    expect(seatStatuses.get("seat-a")).toBe("HELD");
    expect(mocks.reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "release_expired_cart_seat_fence_missing",
      }),
      expect.objectContaining({
        extra: expect.objectContaining({ orderId: "order-1" }),
      }),
    );
  });

  it("does not release seats when the order holds none", async () => {
    const { deps, mocks } = buildDeps({
      expiredOrders: [withPi("order-1", "pi_1")],
    });

    await releaseExpiredCarts(deps, {});

    expect(mocks.seatsRepo.releaseSeats).not.toHaveBeenCalled();
  });

  it("releases the well-formed seat ids and skips the junk instead of rolling the cart back", async () => {
    // `extractSeatIdsFromMeta` throws SEAT_IDS_INVALID on this input, which is
    // right at checkout and wrong here: a throw inside the reaper's tx rolls
    // back an otherwise-good cancel and wedges the cart at the head of every
    // future page.
    const { deps, mocks, seatStatuses } = buildDeps({
      expiredOrders: [withPi("order-1", "pi_1")],
      seatIds: ["seat-a"],
      seatStatuses: { "seat-a": "HELD" },
    });
    mocks.ordersRepo.getById.mockResolvedValue({
      id: "order-1",
      occurredAt: OCCURRED_AT,
      items: [
        { meta: { seatIds: ["seat-a", "", 42, null, "seat-a"] } },
        { meta: null },
        { meta: { seatIds: "not-an-array" } },
        {},
      ],
    } as never);

    const result = await releaseExpiredCarts(deps, {});

    expect(result.cancelledCount).toBe(1);
    expect(mocks.seatsRepo.releaseSeats).toHaveBeenCalledWith({
      seatIds: ["seat-a"],
      releasedAt: BASE_DATE,
      heldBefore: FENCE,
    });
    expect(seatStatuses.get("seat-a")).toBe("AVAILABLE");
  });

  it("reports rather than silently skipping when the cancelled order cannot be read back", async () => {
    const { deps, mocks } = buildDeps({
      expiredOrders: [withPi("order-1", "pi_1")],
      seatIds: ["seat-a"],
    });
    mocks.ordersRepo.getById.mockResolvedValue(null as never);

    const result = await releaseExpiredCarts(deps, {});

    expect(result.cancelledCount).toBe(1);
    expect(mocks.seatsRepo.releaseSeats).not.toHaveBeenCalled();
    expect(mocks.reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "release_expired_cart_order_vanished",
      }),
      expect.objectContaining({
        extra: expect.objectContaining({ orderId: "order-1" }),
      }),
    );
  });

  // ── CAS / already-cancelled ────────────────────────────────────────────

  it("skips orders the CAS did not cancel and releases nothing for them", async () => {
    const { deps, mocks } = buildDeps({
      expiredOrders: [withPi("order-1", "pi_1")],
      seatIds: ["seat-a"],
    });

    mocks.ordersRepo.cancelPendingOrder.mockResolvedValue(false);

    const result = await releaseExpiredCarts(deps, {});

    expect(result.cancelledCount).toBe(0);
    expect(result.piCancelledCount).toBe(0);
    expect(mocks.seatsRepo.releaseSeats).not.toHaveBeenCalled();
    expect(mocks.promosRepo.releaseHoldsForOrder).not.toHaveBeenCalled();
    expect(mocks.feeWaiversRepo.release).not.toHaveBeenCalled();
    expect(mocks.creditsRepo.releaseForOrder).not.toHaveBeenCalled();
  });

  it("uses custom TTL when provided", async () => {
    const { deps, mocks } = buildDeps();

    await releaseExpiredCarts(deps, { ttlSeconds: 600 });

    const callArgs = mocks.ordersRepo.listExpiredPending.mock.calls[0][0] as {
      createdBefore: Date;
    };
    // With BASE_DATE at :20 and TTL 600s (10 min), cutoff should be at :10
    const expectedCutoff = new Date(BASE_DATE.getTime() - 600 * 1000);
    expect(callArgs.createdBefore.getTime()).toBe(expectedCutoff.getTime());
  });

  // ── Holds released alongside the order ─────────────────────────────────

  it("releases promo holds for each cancelled order", async () => {
    const { deps, mocks } = buildDeps({
      expiredOrders: [withPi("order-1", "pi_1"), withoutPi("order-2")],
    });

    await releaseExpiredCarts(deps, {});

    expect(mocks.promosRepo.releaseHoldsForOrder).toHaveBeenCalledTimes(2);
    expect(mocks.promosRepo.releaseHoldsForOrder).toHaveBeenCalledWith(
      "order-1",
    );
    expect(mocks.promosRepo.releaseHoldsForOrder).toHaveBeenCalledWith(
      "order-2",
    );
  });

  it("returns the fee-waiver allowance for each cancelled order", async () => {
    const { deps, mocks } = buildDeps({
      expiredOrders: [withPi("order-1", "pi_1"), withoutPi("order-2")],
    });

    await releaseExpiredCarts(deps, {});

    expect(mocks.feeWaiversRepo.release).toHaveBeenCalledTimes(2);
    expect(mocks.feeWaiversRepo.release).toHaveBeenCalledWith("order-1");
    expect(mocks.feeWaiversRepo.release).toHaveBeenCalledWith("order-2");
  });

  it("restores the platform credit each expired cart had spent", async () => {
    // The reaper is the LAST line of defence for a cart nobody came back to.
    // Credit is debited at checkout (not held), so if the reaper does not
    // return it the buyer's balance stays at zero forever.
    const { deps, mocks } = buildDeps({
      expiredOrders: [withPi("order-1", "pi_1"), withoutPi("order-2")],
    });

    await releaseExpiredCarts(deps, {});

    expect(mocks.creditsRepo.releaseForOrder).toHaveBeenCalledTimes(2);
    expect(mocks.creditsRepo.releaseForOrder).toHaveBeenCalledWith("order-1", {
      now: BASE_DATE,
    });
    expect(mocks.creditsRepo.releaseForOrder).toHaveBeenCalledWith("order-2", {
      now: BASE_DATE,
    });
  });

  // ── One transaction per cart ───────────────────────────────────────────
  //
  // The order cancel, hold releases and seat release are one `repos.tx` per
  // cart, so a throw after `cancelPendingOrder` is a ROLLBACK — the cart
  // stays PENDING and the next pass retries it — instead of a CANCELLED order
  // nobody revisits (`listExpiredPending` reads PENDING only) whose credit
  // and fee-waiver allowance leak for good.

  it("runs each cart's cancel and releases inside one repos.tx", async () => {
    const { deps, mocks, cancelTxDepths } = buildDeps({
      expiredOrders: [withPi("order-1", "pi_1"), withoutPi("order-2")],
      seatIds: ["seat-a"],
    });

    await releaseExpiredCarts(deps, {});

    expect(mocks.tx).toHaveBeenCalledTimes(2);
    expect(cancelTxDepths).toEqual([1, 1]);
    expect(mocks.seatsRepo.releaseSeats).toHaveBeenCalledTimes(2);
  });

  it("keeps going when one order's release throws, reports it, and leaves that cart's seats alone", async () => {
    const { deps, mocks } = buildDeps({
      expiredOrders: [withoutPi("order-1"), withoutPi("order-2")],
      seatIds: ["seat-a"],
    });
    mocks.promosRepo.releaseHoldsForOrder
      .mockRejectedValueOnce(new Error("db hiccup"))
      .mockResolvedValueOnce(undefined);

    const result = await releaseExpiredCarts(deps, {});

    expect(mocks.ordersRepo.cancelPendingOrder).toHaveBeenCalledTimes(2);
    // `cancelledCount` is carts that FINISHED retiring; the one whose hold
    // release threw was rolled back and not counted.
    expect(result.cancelledCount).toBe(1);
    // Seats are released only for the surviving cart.
    expect(mocks.seatsRepo.releaseSeats).toHaveBeenCalledTimes(1);
    expect(mocks.reportError).toHaveBeenCalledTimes(1);
    expect(mocks.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "db hiccup" }),
      expect.objectContaining({
        tags: expect.objectContaining({
          step: "releaseExpiredCarts",
          caller: "releaseExpiredCarts",
        }),
        extra: expect.objectContaining({ orderId: "order-1" }),
      }),
    );
  });

  it("a throwing credit release rejects the cart's tx after cancelPendingOrder ran inside it", async () => {
    // The jobs process has no pino→Sentry bridge, so `logger.error` alone
    // would make this leak invisible. The tx rollback is what makes it
    // recoverable; the report is what makes it seen.
    const { deps, mocks, cancelTxDepths, txRejections } = buildDeps({
      expiredOrders: [withPi("order-1", "pi_1"), withPi("order-2", "pi_2")],
      seatIds: ["seat-a"],
    });
    mocks.creditsRepo.releaseForOrder
      .mockRejectedValueOnce(new Error("credits down"))
      .mockResolvedValueOnce({ releasedCents: 0, creditIds: [] });

    const result = await releaseExpiredCarts(deps, {});

    expect(mocks.tx).toHaveBeenCalledTimes(2);
    expect(txRejections).toHaveLength(1);
    expect((txRejections[0] as Error).message).toBe("credits down");
    // The cancel was inside the transaction that then rejected.
    expect(cancelTxDepths).toEqual([1, 1]);
    expect(mocks.reportError).toHaveBeenCalledTimes(1);
    expect(mocks.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "credits down" }),
      expect.objectContaining({
        extra: expect.objectContaining({
          orderId: "order-1",
          paymentIntentId: "pi_1",
        }),
      }),
    );
    // The next cart still went through.
    expect(result.cancelledCount).toBe(1);
    expect(mocks.ordersRepo.cancelPendingOrder).toHaveBeenLastCalledWith(
      "order-2",
      { expectedPaymentIntentId: "pi_2" },
    );
    expect(mocks.seatsRepo.releaseSeats).toHaveBeenCalledTimes(1);
  });

  // ── Quarantine: a refusing cart must not wedge the queue ────────────────
  //
  // `listExpiredPending` is `orderBy: occurredAt asc, take: limit`. A cart
  // that can NEVER be retired — its PaymentIntent succeeded but finalize
  // DLQ'd, so it stays PENDING forever — is by definition among the oldest
  // rows and sits at the head of every page. Before the quarantine that cost
  // two Stripe calls and one Sentry event every pass (288/day for one cart)
  // and permanently displaced a cart that could actually be reaped.

  it("excludes an already-refused cart from the NEXT pass's scan", async () => {
    const { deps, mocks, advance } = buildDeps({
      expiredOrders: [withPi("order-stuck", "pi_stuck")],
    });
    wedgeOnSucceededPi(mocks);

    await releaseExpiredCarts(deps, {});
    advance(300);
    const second = await releaseExpiredCarts(deps, {});

    const secondScan = mocks.ordersRepo.listExpiredPending.mock
      .calls[1][0] as { excludeOrderIds?: string[] };
    expect(secondScan.excludeOrderIds).toEqual(["order-stuck"]);
    expect(second.quarantinedCount).toBe(1);
    // Probed once, ever — the report rides the probe, so this is also what
    // rate-limits Sentry.
    expect(mocks.payments.cancelPaymentIntent).toHaveBeenCalledTimes(1);
    expect(mocks.reportError).toHaveBeenCalledTimes(1);
  });

  it("does not let a permanently-refusing cart starve the reapable cart behind it", async () => {
    // `limit: 1` stands in for a full page of wedged carts: the stuck one is
    // OLDER, so it takes the only slot and the good cart is never seen.
    // `maxPages: 1` isolates the quarantine: without it the pass would take
    // a second page in the same run (see "paging" below).
    const { deps, mocks, advance } = buildDeps({
      expiredOrders: [withPi("order-stuck", "pi_stuck"), withoutPi("order-ok")],
    });
    wedgeOnSucceededPi(mocks);

    const first = await releaseExpiredCarts(deps, { limit: 1, maxPages: 1 });
    expect(first.cancelledCount).toBe(0);
    expect(first.refusedCount).toBe(1);
    expect(mocks.ordersRepo.cancelPendingOrder).not.toHaveBeenCalled();

    advance(300);
    const second = await releaseExpiredCarts(deps, { limit: 1, maxPages: 1 });

    expect(second.cancelledCount).toBe(1);
    expect(mocks.ordersRepo.cancelPendingOrder).toHaveBeenCalledWith(
      "order-ok",
      { expectedPaymentIntentId: null },
    );
  });

  it("reports a permanently-refusing cart ONCE, not once per pass, forever", async () => {
    const { deps, mocks, advance } = buildDeps({
      expiredOrders: [withPi("order-stuck", "pi_stuck")],
    });
    wedgeOnSucceededPi(mocks);

    // A full day of 5-minute passes.
    for (let pass = 0; pass < 288; pass++) {
      await releaseExpiredCarts(deps, {});
      advance(300);
    }

    expect(mocks.reportError).toHaveBeenCalledTimes(1);
    expect(mocks.payments.cancelPaymentIntent).toHaveBeenCalledTimes(1);
    expect(mocks.payments.retrievePaymentIntent).toHaveBeenCalledTimes(1);
  });

  it("re-probes a cart that failed ONCE on the very next tick, even one that starts early in its slot", async () => {
    // Money: the cart's tickets are reserved for TTL + 2 periods (80 min).
    // If one failure made it sit out the next tick too, it would be reaped
    // at ~89 min, after the reservation lapsed while its PaymentIntent could
    // still be confirmed. The next tick may start a little EARLIER in its
    // slot than the failing one did (cold start, then warm), so it is
    // modelled a full minute short of a period.
    const { deps, mocks, advance } = buildDeps({
      expiredOrders: [withPi("order-1", "pi_1")],
    });
    mocks.payments.cancelPaymentIntent.mockRejectedValueOnce(
      new Error("Stripe timeout"),
    );

    await releaseExpiredCarts(deps, {});
    expect(mocks.payments.cancelPaymentIntent).toHaveBeenCalledTimes(1);

    advance(CART_REAPER_PERIOD_SECONDS - 60);
    const next = await releaseExpiredCarts(deps, {});
    expect(mocks.payments.cancelPaymentIntent).toHaveBeenCalledTimes(2);
    expect(next.cancelledCount).toBe(1);
  });

  it("a rerun within the 5-minute base cooldown does not re-probe the cart", async () => {
    // A manual run from the platform jobs page minutes after a failure: the
    // cooldown still spaces the probes.
    const { deps, mocks, advance } = buildDeps({
      expiredOrders: [withPi("order-1", "pi_1")],
    });
    mocks.payments.cancelPaymentIntent.mockRejectedValueOnce(
      new Error("Stripe timeout"),
    );

    await releaseExpiredCarts(deps, {});
    advance(5 * 60 - 1);
    await releaseExpiredCarts(deps, {});
    expect(mocks.payments.cancelPaymentIntent).toHaveBeenCalledTimes(1);

    advance(2);
    await releaseExpiredCarts(deps, {});
    expect(mocks.payments.cancelPaymentIntent).toHaveBeenCalledTimes(2);
  });

  it("backs a repeatedly-throwing transaction off instead of retrying it every pass", async () => {
    // Not a PI refusal at all — a poisoned row would otherwise wedge the head
    // of the page exactly the same way.
    const { deps, mocks, advance } = buildDeps({
      expiredOrders: [withoutPi("order-1")],
    });
    mocks.promosRepo.releaseHoldsForOrder.mockRejectedValue(
      new Error("db hiccup"),
    );

    // Strike 1 holds 5 min; strike 2 doubles to 10, so a pass 301s after
    // the second strike is skipped. (On the real 30-minute tick the doubling
    // only starts skipping ticks at strike 4, 40 min.)
    await releaseExpiredCarts(deps, {});
    advance(301);
    await releaseExpiredCarts(deps, {});
    advance(301);
    await releaseExpiredCarts(deps, {});

    expect(mocks.ordersRepo.cancelPendingOrder).toHaveBeenCalledTimes(2);
    expect(mocks.reportError).toHaveBeenCalledTimes(2);
  });

  it("forgets a cart once it actually retires, so a later refusal starts clean", async () => {
    const { deps, mocks, quarantine, advance } = buildDeps({
      expiredOrders: [withPi("order-1", "pi_1")],
    });
    mocks.payments.cancelPaymentIntent
      .mockRejectedValueOnce(new Error("Stripe timeout"))
      .mockResolvedValue({ canceled: true });

    await releaseExpiredCarts(deps, {});
    expect(quarantine.size()).toBe(1);

    advance(301);
    await releaseExpiredCarts(deps, {});

    expect(quarantine.size()).toBe(0);
  });

  describe("RESALE orders give their listing hold back (G1)", () => {
    const HOLD_EXPIRES_AT = "2026-01-01T00:15:00.000Z";

    it("a reaped resale order releases its listing, fenced, inside the cancel transaction", async () => {
      const { deps, mocks, releaseHoldTxDepths } = buildDeps({
        expiredOrders: [withPi("ord-r", "pi_r")],
        resaleByOrder: {
          "ord-r": { listingId: "listing-1", holdExpiresAt: HOLD_EXPIRES_AT },
        },
      });

      const result = await releaseExpiredCarts(deps, {});

      expect(result.cancelledCount).toBe(1);
      expect(mocks.resaleListingsRepo.releaseHold).toHaveBeenCalledWith(
        "listing-1",
        { buyerHumanId: "buyer-1", heldUntil: new Date(HOLD_EXPIRES_AT) },
        // The pass's bound instant decides the listing's own expiry.
        { now: expect.any(Date) },
      );
      expect(releaseHoldTxDepths).toEqual([1]);
      // After the PI was proven dead and the order cancelled.
      expect(
        mocks.resaleListingsRepo.releaseHold.mock.invocationCallOrder[0],
      ).toBeGreaterThan(
        mocks.ordersRepo.cancelPendingOrder.mock.invocationCallOrder[0]!,
      );
    });

    it("cancel CAS lost (the order finalized or gained a PI): the listing stays held", async () => {
      const { deps, mocks } = buildDeps({
        expiredOrders: [withPi("ord-r", "pi_r")],
        resaleByOrder: {
          "ord-r": { listingId: "listing-1", holdExpiresAt: HOLD_EXPIRES_AT },
        },
      });
      mocks.ordersRepo.cancelPendingOrder.mockResolvedValue(false);

      await releaseExpiredCarts(deps, {});

      expect(mocks.resaleListingsRepo.releaseHold).not.toHaveBeenCalled();
    });

    it("PI not proven dead: neither the order nor the listing is touched", async () => {
      const { deps, mocks } = buildDeps({
        expiredOrders: [withPi("ord-r", "pi_r")],
        resaleByOrder: {
          "ord-r": { listingId: "listing-1", holdExpiresAt: HOLD_EXPIRES_AT },
        },
      });
      mocks.payments.cancelPaymentIntent.mockRejectedValue(new Error("stripe down"));

      await releaseExpiredCarts(deps, {});

      expect(mocks.ordersRepo.cancelPendingOrder).not.toHaveBeenCalled();
      expect(mocks.resaleListingsRepo.releaseHold).not.toHaveBeenCalled();
    });
  });
});

// ── Paging: one pass keeps the old hourly throughput at */30 ──────────────
//
// Until 2026-10-08 a pass took one page of 100 every 15 minutes. At */30 one
// page would halve that, and a backlog that outgrows the reaper outlives the
// 80-minute capacity window while its PaymentIntents stay confirmable: an
// oversell. So a pass takes pages until one is short, bounded by a time
// budget checked before every cart.

describe("releaseExpiredCarts — paging", () => {
  const manyWithoutPi = (n: number) =>
    Array.from({ length: n }, (_, i) => withoutPi(`order-${i}`));
  const isBacklogReport = (call: unknown[]) =>
    call[0] instanceof Error && call[0].message === "cart_reaper_backlog";

  it("reaps a 250-cart backlog in ONE pass: pages of 100 until a short one", async () => {
    const { deps, mocks } = buildDeps({ expiredOrders: manyWithoutPi(250) });

    const result = await releaseExpiredCarts(deps, {});

    expect(result.cancelledCount).toBe(250);
    expect(result.pages).toBe(3);
    expect(result.hasMore).toBe(false);
    expect(mocks.ordersRepo.cancelPendingOrder).toHaveBeenCalledTimes(250);
    // Later pages exclude what earlier pages handled (the fake, like a stale
    // read, still lists them), so no cart is visited twice.
    const second = mocks.ordersRepo.listExpiredPending.mock.calls[1][0] as {
      excludeOrderIds?: string[];
    };
    expect(second.excludeOrderIds).toHaveLength(100);
    expect(second.excludeOrderIds).toContain("order-0");
    expect(mocks.reportError.mock.calls.some(isBacklogReport)).toBe(false);
  });

  it("an exactly-full last page costs one empty scan, not a backlog report", async () => {
    const { deps, mocks } = buildDeps({ expiredOrders: manyWithoutPi(200) });

    const result = await releaseExpiredCarts(deps, {});

    expect(result.cancelledCount).toBe(200);
    expect(result.pages).toBe(3);
    expect(result.hasMore).toBe(false);
    expect(mocks.reportError).not.toHaveBeenCalled();
  });

  it("stops on the time budget before the next cart, and reports the backlog", async () => {
    const { deps, mocks, advance } = buildDeps({
      expiredOrders: manyWithoutPi(20),
    });
    // Every cart takes one second, spent in its cancel transaction (these
    // carts carry no PaymentIntent, so there is no Stripe call to slow down).
    mocks.ordersRepo.cancelPendingOrder.mockImplementation(async () => {
      advance(1);
      return true;
    });

    const result = await releaseExpiredCarts(deps, { timeBudgetMs: 5_000 });

    expect(result.cancelledCount).toBe(5);
    expect(result.hasMore).toBe(true);
    expect(mocks.reportError.mock.calls.filter(isBacklogReport)).toHaveLength(
      1,
    );
    expect(mocks.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "cart_reaper_backlog" }),
      expect.objectContaining({
        tags: expect.objectContaining({
          step: "releaseExpiredCarts",
          reason: "time_budget",
        }),
        extra: expect.objectContaining({ pages: 1, checked: 5 }),
      }),
    );
  });

  it("stops on maxPages and reports the backlog", async () => {
    const { deps, mocks } = buildDeps({ expiredOrders: manyWithoutPi(3) });

    const result = await releaseExpiredCarts(deps, { limit: 1, maxPages: 2 });

    expect(result.cancelledCount).toBe(2);
    expect(result.pages).toBe(2);
    expect(result.hasMore).toBe(true);
    expect(mocks.reportError.mock.calls.filter(isBacklogReport)).toHaveLength(
      1,
    );
  });

  it("ONE Stripe failure on a page is a bad row, not trouble: the pass keeps going", async () => {
    const { deps, mocks } = buildDeps({
      expiredOrders: [
        withPi("order-a", "pi_a"),
        withoutPi("order-b"),
        withoutPi("order-c"),
        withoutPi("order-d"),
      ],
    });
    mocks.payments.cancelPaymentIntent.mockRejectedValueOnce(
      new Error("Stripe timeout"),
    );

    const result = await releaseExpiredCarts(deps, { limit: 2 });

    expect(result.refusedCount).toBe(1);
    expect(result.cancelledCount).toBe(3);
    expect(result.hasMore).toBe(false);
    expect(mocks.reportError.mock.calls.some(isBacklogReport)).toBe(false);
  });

  it("a short page whose failures stay under the threshold ran dry: hasMore is false", async () => {
    const { deps, mocks } = buildDeps({
      expiredOrders: [withPi("order-a", "pi_a"), withPi("order-b", "pi_b")],
    });
    mocks.payments.cancelPaymentIntent.mockRejectedValue(
      new Error("Stripe timeout"),
    );

    const result = await releaseExpiredCarts(deps, {});

    // Both refused and quarantined: not "left over", so not hasMore.
    expect(result.refusedCount).toBe(2);
    expect(result.hasMore).toBe(false);
    expect(mocks.reportError.mock.calls.some(isBacklogReport)).toBe(false);
  });

  it("dependency trouble on a FULL page stops the pass at the threshold and reports the backlog", async () => {
    const { deps, mocks } = buildDeps({
      expiredOrders: Array.from({ length: 20 }, (_, i) =>
        withPi(`order-${i}`, `pi_${i}`),
      ),
    });
    mocks.payments.cancelPaymentIntent.mockRejectedValue(
      new Error("Stripe 503"),
    );

    const result = await releaseExpiredCarts(deps, { limit: 10 });

    // Threshold on a page of 10 is max(3, 10%) = 3: three failures, then
    // stop, instead of ten timeouts against a Stripe that is down.
    expect(mocks.payments.cancelPaymentIntent).toHaveBeenCalledTimes(3);
    expect(result.refusedCount).toBe(3);
    expect(result.pages).toBe(1);
    expect(result.hasMore).toBe(true);
    expect(mocks.reportError.mock.calls.filter(isBacklogReport)).toHaveLength(
      1,
    );
    expect(mocks.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "cart_reaper_backlog" }),
      expect.objectContaining({
        tags: expect.objectContaining({ reason: "trouble" }),
      }),
    );
  });

  it("a page that reaches the threshold on its LAST cart still stops and reports when full", async () => {
    const { deps, mocks } = buildDeps({
      expiredOrders: [
        withoutPi("order-ok-1"),
        withPi("order-a", "pi_a"),
        withPi("order-b", "pi_b"),
        withPi("order-c", "pi_c"),
        withoutPi("order-ok-2"),
      ],
    });
    mocks.payments.cancelPaymentIntent.mockRejectedValue(
      new Error("Stripe 503"),
    );

    const result = await releaseExpiredCarts(deps, { limit: 4 });

    expect(result.cancelledCount).toBe(1);
    expect(result.refusedCount).toBe(3);
    expect(result.pages).toBe(1);
    expect(result.hasMore).toBe(true);
    expect(mocks.reportError.mock.calls.filter(isBacklogReport)).toHaveLength(
      1,
    );
  });

  it("a PROCESSING PaymentIntent is Stripe answering, not trouble: the pass keeps going", async () => {
    const { deps, mocks } = buildDeps({
      expiredOrders: [
        withPi("order-p1", "pi_p1"),
        withPi("order-p2", "pi_p2"),
        withPi("order-p3", "pi_p3"),
        withPi("order-p4", "pi_p4"),
        withoutPi("order-ok"),
      ],
    });
    mocks.payments.cancelPaymentIntent.mockResolvedValue({ canceled: false });
    mocks.payments.retrievePaymentIntent.mockResolvedValue({
      id: "pi_p",
      status: "processing",
      amountReceived: 0,
      currency: "usd",
      metadata: {},
    });

    const result = await releaseExpiredCarts(deps, { limit: 2 });

    expect(result.refusedCount).toBe(4);
    expect(result.cancelledCount).toBe(1);
    expect(result.hasMore).toBe(false);
  });

  it("a cart whose transaction throws EVERY pass does not cap the reaper: 250 good carts reaped within two passes", async () => {
    // The poisoned cart is the oldest, so it heads page 1 of every pass. Its
    // quarantine is NOT relied on: a fresh quarantine per pass models the
    // jobs service scaling to zero between ticks.
    const orders = [withoutPi("order-poison"), ...manyWithoutPi(250)];
    const { deps, mocks, advance } = buildDeps({ expiredOrders: orders });
    const cancelled = new Set<string>();
    mocks.ordersRepo.listExpiredPending.mockImplementation(
      async (input: { limit?: number; excludeOrderIds?: string[] }) => {
        const excluded = new Set(input.excludeOrderIds ?? []);
        return orders
          .filter((o) => !excluded.has(o.id) && !cancelled.has(o.id))
          .slice(0, input.limit ?? 100);
      },
    );
    // The poisoned cart's cancel rolls back with its transaction, so it stays
    // PENDING and comes back at the head of the next pass.
    mocks.ordersRepo.cancelPendingOrder.mockImplementation(
      async (id: string) => {
        if (id !== "order-poison") cancelled.add(id);
        return true;
      },
    );
    mocks.promosRepo.releaseHoldsForOrder.mockImplementation(
      async (...args: unknown[]) => {
        if (args[0] === "order-poison") throw new Error("constraint");
        return undefined;
      },
    );

    const first = await releaseExpiredCarts(deps, {});
    advance(CART_REAPER_PERIOD_SECONDS);
    const second = await releaseExpiredCarts(
      { ...deps, quarantine: createCartReapQuarantine() },
      {},
    );

    expect(cancelled.size).toBe(250);
    // Probed (and refused) on BOTH passes: it really did head each one.
    expect(first.refusedCount).toBe(1);
    expect(second.refusedCount).toBe(1);
    expect(first.hasMore || second.hasMore).toBe(false);
  });

  it("starts no PaymentIntent cart in the last PI_CART_RESERVE_MS of the budget, but still takes carts without one", async () => {
    const { deps, mocks, advance } = buildDeps({
      expiredOrders: [
        withPi("order-1", "pi_1"),
        withPi("order-2", "pi_2"),
        withPi("order-3", "pi_3"),
        withoutPi("order-4"),
        withPi("order-5", "pi_5"),
        withoutPi("order-6"),
        withPi("order-7", "pi_7"),
        withoutPi("order-8"),
      ],
    });
    // 30s of Stripe per PaymentIntent cart. Default budget 210s, reserve
    // 120s: PaymentIntent carts may start until 90s, others until 210s.
    mocks.payments.cancelPaymentIntent.mockImplementation(async () => {
      advance(30);
      return { canceled: true };
    });

    const result = await releaseExpiredCarts(deps, {});

    // 1 (0s), 2 (30s), 3 (60s) run; at 90s order-5 and order-7 are held back
    // (a 120s Stripe call could push the reaper past the door sweep's turn),
    // while order-4, order-6 and order-8, which carry no PaymentIntent, run.
    expect(mocks.payments.cancelPaymentIntent).toHaveBeenCalledTimes(3);
    expect(result.cancelledCount).toBe(6);
    const cancelledIds = mocks.ordersRepo.cancelPendingOrder.mock.calls.map(
      (c) => c[0],
    );
    expect(cancelledIds).toEqual(
      expect.arrayContaining(["order-4", "order-6", "order-8"]),
    );
    expect(cancelledIds).not.toContain("order-5");
    expect(cancelledIds).not.toContain("order-7");
    expect(result.hasMore).toBe(true);
    expect(mocks.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "cart_reaper_backlog" }),
      expect.objectContaining({
        tags: expect.objectContaining({ reason: "time_budget" }),
      }),
    );
  });

  it("on a full page of 100 the trouble threshold is 10, not 3", async () => {
    const { deps, mocks } = buildDeps({
      expiredOrders: Array.from({ length: 150 }, (_, i) =>
        withPi(`order-${i}`, `pi_${i}`),
      ),
    });
    mocks.payments.cancelPaymentIntent.mockRejectedValue(
      new Error("Stripe 503"),
    );

    const result = await releaseExpiredCarts(deps, { limit: 100 });

    // max(3, ceil(100 × 10%)) = 10: stops at the 10th failure.
    expect(mocks.payments.cancelPaymentIntent).toHaveBeenCalledTimes(10);
    expect(result.refusedCount).toBe(10);
    expect(result.hasMore).toBe(true);
  });

  it("a PERMANENT refusal (paid PI) is not trouble: the pass moves on to the next page", async () => {
    const { deps, mocks } = buildDeps({
      expiredOrders: [withPi("order-stuck", "pi_stuck"), withoutPi("order-ok")],
    });
    wedgeOnSucceededPi(mocks);

    const result = await releaseExpiredCarts(deps, { limit: 1 });

    expect(result.refusedCount).toBe(1);
    expect(result.cancelledCount).toBe(1);
    expect(mocks.ordersRepo.cancelPendingOrder).toHaveBeenCalledWith(
      "order-ok",
      { expectedPaymentIntentId: null },
    );
  });

  it("a throwing reporter does not change the pass's result", async () => {
    const { deps, mocks } = buildDeps({ expiredOrders: manyWithoutPi(3) });
    mocks.reportError.mockImplementation(() => {
      throw new Error("sentry down");
    });

    const result = await releaseExpiredCarts(deps, { limit: 1, maxPages: 2 });

    expect(result.cancelledCount).toBe(2);
    expect(result.hasMore).toBe(true);
  });
});
