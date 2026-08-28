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

import { ticketJobs } from "../jobs/tickets";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function buildMockContext(
  overrides: {
    expiredOrders?: {
      id: string;
      stripePaymentIntentId: string | null;
      buyerHumanId: string;
    }[];
  } = {},
) {
  const expiredOrders = overrides.expiredOrders ?? [];

  const repos = {
    orders: {
      listExpiredPending: vi.fn(async () => expiredOrders),
      cancelPendingOrder: vi.fn(async () => true),
      getById: vi.fn(async () => ({ id: "order-1", items: [] })),
    },
    seats: {
      updateStatuses: vi.fn(async () => undefined),
    },
    promos: {
      releaseHoldsForOrder: vi.fn(async () => undefined),
    },
    // The use case returns any fee-waiver allowance the abandoned cart was
    // holding, and does so BEFORE cancelling the Stripe PI. Without this mock
    // the release throws and the PI cancel never runs, so `piCancelledCount`
    // silently drops — which is how this surfaced.
    feeWaivers: {
      release: vi.fn(async () => undefined),
    },
  };

  const payments = {
    cancelPaymentIntent: vi.fn(async () => ({ canceled: true })),
  };

  const clock = { now: () => new Date("2026-02-01T00:20:00.000Z") };

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
      clock,
      logger: logger as any,
      idempotency: {} as any,
      fileStorage: {} as any,
      searchIndex: {} as any,
      multiSearch: null,
      enqueue: vi.fn(),
    },
    mocks: { repos, payments, logger },
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

  it("is a scheduled task running every 5 minutes", () => {
    expect(job).toHaveProperty("schedule");
    const schedule = (job as any).schedule;
    expect(schedule.cron).toBe("*/5 * * * *");
    expect(schedule.timezone).toBe("Etc/UTC");
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

    it("continues processing when PI cancel fails for one order", async () => {
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

      mocks.payments.cancelPaymentIntent
        .mockRejectedValueOnce(new Error("Stripe timeout"))
        .mockResolvedValueOnce({ canceled: true });

      const result = await job.handler({ input: {} as any, ctx: ctx as any });

      expect(result).toEqual(
        expect.objectContaining({ cancelledCount: 2, piCancelledCount: 1 }),
      );
    });

    it("releases seat holds for orders with seatIds", async () => {
      const { ctx, mocks } = buildMockContext({
        expiredOrders: [
          { id: "order-1", stripePaymentIntentId: null, buyerHumanId: "h1" },
        ],
      });

      mocks.repos.orders.getById.mockResolvedValueOnce({
        id: "order-1",
        items: [
          { meta: { seatIds: ["seat-1", "seat-2"] } },
          { meta: { seatIds: ["seat-3"] } },
        ] as any,
      });

      await job.handler({ input: {} as any, ctx: ctx as any });

      expect(mocks.repos.seats.updateStatuses).toHaveBeenCalledWith(
        expect.objectContaining({
          seatIds: ["seat-1", "seat-2", "seat-3"],
          status: "AVAILABLE",
        }),
      );
    });
  });
});
