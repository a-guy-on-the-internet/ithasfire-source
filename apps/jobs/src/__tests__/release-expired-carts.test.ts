/**
 * Release Expired Carts Job Tests
 *
 * Verifies the release-expired-carts scheduled task is correctly wired:
 * - Job registration and schedule configuration
 * - Input validation (ttlSeconds, limit)
 * - Handler delegates to the use case with the right deps
 * - PI cancellation flows through the payments adapter
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ZodError } from "zod";

import {
  CART_REAPER_CRON_SOURCE,
  CART_REAPER_PERIOD_SECONDS,
} from "@th/core/use-cases/orders/_shared/cart-reaper-cycle";

import { ticketJobs } from "../jobs/tickets";
import { nextCronRun } from "../lib/cron-schedule";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * NOTE ON SHARED STATE: `tickets.ts` builds ONE cart-reap quarantine at module
 * scope (deliberately — a per-invocation one remembers nothing and a wedged
 * cart is re-probed every 5 minutes forever). This module is imported once, so
 * every test in this file shares it. Give each test its OWN order ids, or a
 * refusal in one test silently excludes the same id from the scan in the next.
 */
/** 20 minutes (the cart TTL) before the default clock below. */
const ORDER_OCCURRED_AT = new Date("2026-02-01T00:00:00.000Z");

function buildMockContext(
  overrides: {
    expiredOrders?: {
      id: string;
      stripePaymentIntentId: string | null;
      buyerHumanId: string;
    }[];
    /** Simulates an environment with no STRIPE_SECRET_KEY. */
    paymentsConfigured?: boolean;
    now?: Date;
  } = {},
) {
  const expiredOrders = overrides.expiredOrders ?? [];

  const txRepos = {
    orders: {
      // Honours `excludeOrderIds` because the wiring under test depends on
      // it: a mock that ignored the filter would report the quarantine as
      // working while the real query kept the wedged cart at the head of the
      // page.
      listExpiredPending: vi.fn(
        async (input: { excludeOrderIds?: string[] }) => {
          const excluded = new Set(input.excludeOrderIds ?? []);
          return expiredOrders.filter((o) => !excluded.has(o.id));
        },
      ),
      cancelPendingOrder: vi.fn(async () => true),
      // The door sweep's scan (settleDoorOrdersOnCancelledEvents). Empty by
      // default: no cancelled event has door orders left.
      listCancelledEventIdsWithOpenDoorOrders: vi.fn(
        async (_q?: any): Promise<string[]> => [],
      ),
      listAll: vi.fn(async (_q: any) => ({ items: [] as any[], total: 0 })),
      // The cancellation's cash candidates (the sweep asks for those with an
      // unreversed debit). None by default.
      listSucceededCashOrderIdsForEvent: vi.fn(
        async (_q: any): Promise<string[]> => [],
      ),
      // `occurredAt` is load-bearing, not decoration: the reaper fences its
      // seat release on it (`releaseSeats({ heldBefore })`) so it cannot free
      // a seat another buyer re-held after this cart expired. A mock without
      // it exercises the fence-missing branch, which releases nothing.
      getById: vi.fn(async (id: string) => ({
        id,
        occurredAt: ORDER_OCCURRED_AT,
        items: [],
      })),
    },
    seats: {
      // HELD-guarded; `updateStatuses` is the blind one and must not be used
      // here (it would un-sell a seat another buyer already paid for).
      releaseSeats: vi.fn(async () => undefined),
      updateStatuses: vi.fn(async () => undefined),
    },
    promos: {
      releaseHoldsForOrder: vi.fn(async () => undefined),
    },
    // The use case returns any fee-waiver allowance and platform credit the
    // abandoned cart was holding, inside the per-cart transaction. Without
    // these mocks the release throws into the outer catch and every
    // `cancelledCount` reads 0 — which is how the fee-waiver one surfaced.
    // The return shape matches the port (`Promise<{ releasedTickets }>`);
    // an `undefined` here is the mock-drift class that has bitten this repo.
    feeWaivers: {
      release: vi.fn(async () => ({ releasedTickets: 0 })),
    },
    credits: {
      releaseForOrder: vi.fn(async () => ({ releasedCents: 0, creditIds: [] })),
    },
  };

  // One `repos.tx` per cart; the tx surface is the same set of mocks.
  const repos = {
    ...txRepos,
    tx: vi.fn(async (fn: (t: typeof txRepos) => Promise<unknown>) =>
      fn(txRepos),
    ),
  };

  const payments = {
    cancelPaymentIntent: vi.fn(async () => ({ canceled: true })),
    // The status probe the retire helper falls back to on `{ canceled: false }`.
    retrievePaymentIntent: vi.fn(async () => ({
      id: "pi_x",
      status: "canceled",
      amountReceived: 0,
      currency: "usd",
      metadata: {},
    })),
  };

  const reportError = vi.fn();

  const clock = { now: () => overrides.now ?? new Date("2026-02-01T00:20:00.000Z") };

  const logger = {
    child: () => logger,
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    withTime: vi.fn(async (_label: string, fn: () => Promise<unknown>) => fn()),
  };

  return {
    ctx: {
      repos: repos as any,
      payments: payments as any,
      // The container hands out a throwing stub, never null, when Stripe is
      // unconfigured; the job must branch on this flag rather than on
      // `payments` being falsy.
      paymentsConfigured: overrides.paymentsConfigured ?? true,
      clock,
      logger: logger as any,
      idempotency: {} as any,
      fileStorage: {} as any,
      searchIndex: {} as any,
      multiSearch: null,
      enqueue: vi.fn(),
      reportError,
    },
    mocks: { repos, payments, logger, reportError },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("release-expired-carts job", () => {
  const job = ticketJobs.find(
    (j) => j.name === "tickets.release-expired-carts",
  )!;

  it("is registered in ticketJobs", () => {
    expect(job).toBeDefined();
  });

  it("is a scheduled task running every 30 minutes — the period core's capacity window assumes", () => {
    expect(job).toHaveProperty("schedule");
    const schedule = (job as any).schedule;
    expect(schedule.cron).toBe("*/30 * * * *");
    expect(schedule.cron).toBe(CART_REAPER_CRON_SOURCE);
    expect(schedule.timezone).toBe("Etc/UTC");
  });

  it("CART_REAPER_PERIOD_SECONDS is the longest gap between two runs of CART_REAPER_CRON_SOURCE", () => {
    // validate-manifest pins the cron STRING to the manifest; nothing else ties
    // the PERIOD to that string. Change the cron and forget the period, and
    // the capacity window (TTL + 2 periods) is sized for a faster reaper than
    // the one that runs: a ticket can be resold while the first charge lands.
    let at = new Date("2026-10-08T00:00:00.000Z");
    let longestGapMs = 0;
    for (let i = 0; i < 200; i += 1) {
      const next = nextCronRun(CART_REAPER_CRON_SOURCE, "Etc/UTC", at);
      expect(next).not.toBeNull();
      const nextDate = new Date(next!);
      if (i > 0) longestGapMs = Math.max(longestGapMs, nextDate.getTime() - at.getTime());
      at = nextDate;
    }
    expect(longestGapMs).toBe(CART_REAPER_PERIOD_SECONDS * 1000);
  });

  describe("input validation", () => {
    it("accepts empty input", () => {
      const parsed = job.input.parse({});
      expect(parsed).toEqual({});
    });

    it("accepts valid ttlSeconds and limit", () => {
      const parsed = job.input.parse({ ttlSeconds: 600, limit: 50 });
      expect(parsed).toEqual({ ttlSeconds: 600, limit: 50 });
    });

    it("rejects non-positive ttlSeconds", () => {
      expect(() => job.input.parse({ ttlSeconds: 0 })).toThrow(ZodError);
      expect(() => job.input.parse({ ttlSeconds: -1 })).toThrow(ZodError);
    });

    it("rejects non-positive limit", () => {
      expect(() => job.input.parse({ limit: 0 })).toThrow(ZodError);
    });
  });

  describe("handler", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("returns zero counts when no expired orders exist", async () => {
      const { ctx } = buildMockContext({ expiredOrders: [] });

      const result = await job.handler({ input: {} as any, ctx: ctx as any });

      expect(result).toEqual(
        expect.objectContaining({ cancelledCount: 0, piCancelledCount: 0 }),
      );
    });

    it("cancels expired orders and their Stripe PIs", async () => {
      const { ctx, mocks } = buildMockContext({
        expiredOrders: [
          {
            id: "order-1",
            stripePaymentIntentId: "pi_abc",
            buyerHumanId: "h1",
          },
          {
            id: "order-2",
            stripePaymentIntentId: "pi_def",
            buyerHumanId: "h2",
          },
        ],
      });

      const result = await job.handler({ input: {} as any, ctx: ctx as any });

      expect(result).toEqual(
        expect.objectContaining({ cancelledCount: 2, piCancelledCount: 2 }),
      );
      expect(mocks.repos.orders.cancelPendingOrder).toHaveBeenCalledTimes(2);
      expect(mocks.payments.cancelPaymentIntent).toHaveBeenCalledWith({
        paymentIntentId: "pi_abc",
      });
      expect(mocks.payments.cancelPaymentIntent).toHaveBeenCalledWith({
        paymentIntentId: "pi_def",
      });
    });

    it("skips PI cancellation for orders without stripePaymentIntentId", async () => {
      const { ctx, mocks } = buildMockContext({
        expiredOrders: [
          { id: "order-1", stripePaymentIntentId: null, buyerHumanId: "h1" },
        ],
      });

      const result = await job.handler({ input: {} as any, ctx: ctx as any });

      expect(result).toEqual(
        expect.objectContaining({ cancelledCount: 1, piCancelledCount: 0 }),
      );
      expect(mocks.payments.cancelPaymentIntent).not.toHaveBeenCalled();
    });

    it("KEEPS a cart whose PI cancel fails, reports it via ctx.reportError, and continues", async () => {
      // PI first, order second: a Stripe failure means the PI may still be
      // confirmable, so the order is NOT cancelled (money audit #26). The
      // report proves `reportError` is actually wired through tickets.ts —
      // the jobs process has no pino→Sentry bridge, so a log alone is dark.
      const { ctx, mocks } = buildMockContext({
        expiredOrders: [
          {
            id: "stripe-throw-1",
            stripePaymentIntentId: "pi_abc",
            buyerHumanId: "h1",
          },
          {
            id: "stripe-throw-2",
            stripePaymentIntentId: "pi_def",
            buyerHumanId: "h2",
          },
        ],
      });

      mocks.payments.cancelPaymentIntent
        .mockRejectedValueOnce(new Error("Stripe timeout"))
        .mockResolvedValueOnce({ canceled: true });

      const result = await job.handler({ input: {} as any, ctx: ctx as any });

      expect(result).toEqual(
        expect.objectContaining({ cancelledCount: 1, piCancelledCount: 1 }),
      );
      expect(mocks.repos.orders.cancelPendingOrder).toHaveBeenCalledTimes(1);
      expect(mocks.repos.orders.cancelPendingOrder).toHaveBeenCalledWith(
        "stripe-throw-2",
        { expectedPaymentIntentId: "pi_def" },
      );
      expect(mocks.reportError).toHaveBeenCalledTimes(1);
      expect(mocks.reportError).toHaveBeenCalledWith(
        expect.objectContaining({ message: "Stripe timeout" }),
        expect.objectContaining({
          tags: expect.objectContaining({ caller: "releaseExpiredCarts" }),
          extra: expect.objectContaining({ orderId: "stripe-throw-1" }),
        }),
      );
    });

    it("REMEMBERS a refusal across handler invocations", async () => {
      // The quarantine lives at module scope in tickets.ts on purpose. Wired
      // per-invocation it would remember nothing, and a cart whose PI
      // succeeded but whose finalize DLQ'd would be re-probed — and
      // re-reported — every 5 minutes forever while displacing a reapable
      // cart at the head of an oldest-first page.
      const orders = [
        {
          id: "wedged-cart",
          stripePaymentIntentId: "pi_paid",
          buyerHumanId: "h1",
        },
      ];

      const first = buildMockContext({ expiredOrders: orders });
      first.mocks.payments.cancelPaymentIntent.mockResolvedValue({
        canceled: false,
      });
      first.mocks.payments.retrievePaymentIntent.mockResolvedValue({
        id: "pi_paid",
        status: "succeeded",
        amountReceived: 1000,
        currency: "usd",
        metadata: {},
      });

      await job.handler({ input: {} as any, ctx: first.ctx as any });
      expect(first.mocks.reportError).toHaveBeenCalledTimes(1);

      // A DIFFERENT context — new mocks, new reporter — a day later.
      const second = buildMockContext({
        expiredOrders: orders,
        now: new Date("2026-02-02T00:20:00.000Z"),
      });
      const result = await job.handler({
        input: {} as any,
        ctx: second.ctx as any,
      });

      expect(result).toEqual(
        expect.objectContaining({ quarantinedCount: 1, refusedCount: 0 }),
      );
      expect(second.mocks.payments.cancelPaymentIntent).not.toHaveBeenCalled();
      expect(second.mocks.reportError).not.toHaveBeenCalled();
    });

    it("passes NO processor rather than the throwing stub when Stripe is unconfigured", async () => {
      // `ctx.payments` is never null — without a key the container hands out
      // a stub that throws on every call. Passing it would make the use case
      // read "no Stripe configured" as "Stripe is down" and retry forever.
      const { ctx, mocks } = buildMockContext({
        paymentsConfigured: false,
        expiredOrders: [
          {
            id: "unstriped-cart",
            stripePaymentIntentId: "pi_ghi",
            buyerHumanId: "h1",
          },
          {
            id: "unstriped-free-cart",
            stripePaymentIntentId: null,
            buyerHumanId: "h2",
          },
        ],
      });

      const result = await job.handler({ input: {} as any, ctx: ctx as any });

      expect(mocks.payments.cancelPaymentIntent).not.toHaveBeenCalled();
      // The PI-bearing cart is still KEPT — this process cannot prove the
      // charge is dead — but it is reported once and quarantined, not spun
      // on. The cart with no PI has nothing to prove and is reaped.
      expect(result).toEqual(
        expect.objectContaining({ cancelledCount: 1, refusedCount: 1 }),
      );
      expect(mocks.repos.orders.cancelPendingOrder).toHaveBeenCalledWith(
        "unstriped-free-cart",
        { expectedPaymentIntentId: null },
      );
      expect(mocks.reportError).toHaveBeenCalledTimes(1);
    });

    it("releases seat holds for orders with seatIds, via the HELD-guarded path", async () => {
      const { ctx, mocks } = buildMockContext({
        expiredOrders: [
          { id: "seated-cart", stripePaymentIntentId: null, buyerHumanId: "h1" },
        ],
      });

      // Not `Once`: the cancel reads the order back too (resale listing
      // release in `releaseRetiredCartHolds`) before the seat release does.
      mocks.repos.orders.getById.mockResolvedValue({
        id: "seated-cart",
        occurredAt: ORDER_OCCURRED_AT,
        items: [
          { meta: { seatIds: ["seat-1", "seat-2"] } },
          { meta: { seatIds: ["seat-3"] } },
        ] as any,
      });

      await job.handler({ input: {} as any, ctx: ctx as any });

      expect(mocks.repos.seats.releaseSeats).toHaveBeenCalledWith(
        expect.objectContaining({
          seatIds: ["seat-1", "seat-2", "seat-3"],
          // The ownership fence, wired all the way through the job: without
          // it a seat another buyer is holding RIGHT NOW is still HELD, so
          // the status predicate waves it through and the reaper steals it.
          // `occurredAt` + the use case's 60s slack.
          heldBefore: new Date(ORDER_OCCURRED_AT.getTime() + 60_000),
        }),
      );
      // The blind `updateMany` with no status predicate would flip a seat
      // another buyer already SOLD back to AVAILABLE.
      expect(mocks.repos.seats.updateStatuses).not.toHaveBeenCalled();
    });
  });
  describe("door sweep (cancelled events' door orders)", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("runs after the reaper on every invocation and returns its counts", async () => {
      const { ctx, mocks } = buildMockContext({ expiredOrders: [] });

      const result = await job.handler({ input: {} as any, ctx: ctx as any });

      expect(
        mocks.repos.orders.listCancelledEventIdsWithOpenDoorOrders,
      ).toHaveBeenCalledWith({ limit: 50, excludeOrderIds: [] });
      expect(result).toEqual(
        expect.objectContaining({
          cancelledCount: 0,
          doorSweep: expect.objectContaining({
            eventCount: 0,
            failedCashRefundCount: 0,
          }),
        }),
      );
    });

    it("THROWS when a cash order on a cancelled event could not be refunded, after reporting it", async () => {
      const { ctx, mocks } = buildMockContext({ expiredOrders: [] });
      mocks.repos.orders.listCancelledEventIdsWithOpenDoorOrders.mockResolvedValueOnce(
        ["ev-cancelled"],
      );
      // One cash sale with an unreversed debit on the event...
      mocks.repos.orders.listSucceededCashOrderIdsForEvent.mockImplementation(
        async (q: any) => {
          expect(q.unreversedCashSaleDebitOnly).toBe(true);
          return q.afterId ? [] : ["cash-1"];
        },
      );
      mocks.repos.orders.getById.mockImplementation(async (id: string) => ({
        id,
        eventId: "ev-cancelled",
        paymentChannel: "CASH",
        status: "SUCCEEDED",
        occurredAt: ORDER_OCCURRED_AT,
        items: [],
      }));
      // ...whose refund fails (this context models no event repo).

      await expect(
        job.handler({ input: {} as any, ctx: ctx as any }),
      ).rejects.toThrow(/door_sweep_incomplete: 1 cash refund/);
      expect(mocks.reportError).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          tags: expect.objectContaining({ step: "refundCashOrders" }),
          extra: expect.objectContaining({ orderId: "cash-1" }),
        }),
      );
    });

    /** One PENDING door card sale on a cancelled event, PI status `piStatus`. */
    function stuckDoorSale(
      mocks: ReturnType<typeof buildMockContext>["mocks"],
      orderId: string,
      piStatus: "succeeded" | "canceled",
    ) {
      mocks.repos.orders.listCancelledEventIdsWithOpenDoorOrders.mockImplementation(
        async (q: any) =>
          (q.excludeOrderIds ?? []).includes(orderId) ? [] : ["ev-door-card"],
      );
      mocks.repos.orders.listAll.mockImplementation(async (q: any) =>
        q.statuses?.[0] === "PENDING" && q.eventId === "ev-door-card"
          ? { items: [{ id: orderId, stripePaymentIntentId: `pi_${orderId}` }], total: 1 }
          : { items: [], total: 0 },
      );
      mocks.repos.orders.getById.mockImplementation(async (id: string) => ({
        id,
        eventId: "ev-door-card",
        paymentChannel: "POS",
        status: "PENDING",
        stripePaymentIntentId: `pi_${id}`,
        occurredAt: ORDER_OCCURRED_AT,
        items: [],
      }));
      mocks.payments.cancelPaymentIntent.mockResolvedValue({ canceled: false });
      mocks.payments.retrievePaymentIntent.mockResolvedValue({
        id: `pi_${orderId}`,
        status: piStatus,
        amountReceived: piStatus === "succeeded" ? 2675 : 0,
        currency: "usd",
        metadata: {},
      });
    }

    it("a PAID door card sale on a cancelled event is reported once and does NOT fail the run; later runs are quiet", async () => {
      // Own order id: the module-scope quarantine outlives this test.
      const orderId = "pos-paid-door-1";
      const first = buildMockContext({ expiredOrders: [] });
      stuckDoorSale(first.mocks, orderId, "succeeded");

      const result: any = await job.handler({
        input: {} as any,
        ctx: first.ctx as any,
      });

      expect(result.doorSweep).toMatchObject({
        keptPendingPosOrderCount: 1,
        failedPendingPosVoidCount: 0,
      });
      expect(
        first.mocks.reportError.mock.calls.filter(
          ([, c]: any[]) => c?.tags?.step === "voidPendingPosOrders",
        ),
      ).toHaveLength(1);

      const later = buildMockContext({ expiredOrders: [] });
      stuckDoorSale(later.mocks, orderId, "succeeded");
      const again: any = await job.handler({
        input: {} as any,
        ctx: later.ctx as any,
      });

      expect(again.doorSweep).toMatchObject({
        eventCount: 0,
        keptPendingPosOrderCount: 0,
      });
      expect(later.mocks.reportError).not.toHaveBeenCalled();
      expect(later.mocks.payments.cancelPaymentIntent).not.toHaveBeenCalled();
    });

    it("a door card sale Stripe could not settle (may clear on its own) still FAILS the run, every run", async () => {
      const orderId = "pos-transient-door-1";
      for (let run = 0; run < 2; run++) {
        const { ctx, mocks } = buildMockContext({ expiredOrders: [] });
        stuckDoorSale(mocks, orderId, "canceled");
        mocks.payments.cancelPaymentIntent.mockRejectedValue(
          new Error("stripe unavailable"),
        );

        await expect(
          job.handler({ input: {} as any, ctx: ctx as any }),
        ).rejects.toThrow(/door_sweep_incomplete: 0 cash refund\(s\), 1 card sale void/);
      }
    });
  });
});
