import { describe, it, expect, vi } from "vitest";

import {
  backfillProcessorFees,
  PROCESSOR_FEE_MAX_READ_FAILURES,
  PROCESSOR_FEE_RETRY_BACKOFF_MS,
} from "../backfill-processor-fees";

/**
 * The sweep's job is to store a MEASURED number or nothing at all. Most of
 * these tests are about the "or nothing at all" half, because that is the side
 * that fails silently: a stamped guess is indistinguishable from a stamped
 * measurement once written, and the consumer would then report full coverage
 * over partly-fictional data.
 *
 * The second half pins the failure BOOKKEEPING: every refusal is recorded on
 * the row with the sweep's clock, Sentry hears about a row on its first
 * failure and when it is parked — never on the retries in between — and a
 * row a concurrent run has already stamped is never marked failed.
 */

const NOW = new Date("2026-09-15T12:00:00.000Z");

const ORDER = (over: Partial<Record<string, unknown>> = {}) => ({
  id: "order-1",
  stripePaymentIntentId: "pi_1",
  currency: "usd",
  occurredAt: new Date("2026-09-01T00:00:00.000Z"),
  processorFeeReadFailures: 0,
  ...over,
});

function makeDeps(
  orders: ReturnType<typeof ORDER>[],
  fee: unknown,
  overrides: Record<string, unknown> = {},
) {
  const stampProcessorFee = vi.fn(async () => true);
  // Default: the record lands and this is the row's FIRST failure.
  const recordProcessorFeeReadFailure = vi.fn(async () => 1);
  const listOrdersMissingProcessorFee = vi.fn(async () => orders);
  const getProcessingFeeForPaymentIntent =
    typeof fee === "function"
      ? (fee as () => Promise<unknown>)
      : vi.fn(async () => fee);
  return {
    deps: {
      repos: {
        orders: {
          listOrdersMissingProcessorFee,
          stampProcessorFee,
          recordProcessorFeeReadFailure,
          ...(overrides.ordersRepo as object),
        },
      },
      payments: { getProcessingFeeForPaymentIntent },
      clock: { now: () => NOW },
      ...overrides,
    } as never,
    stampProcessorFee,
    recordProcessorFeeReadFailure,
    listOrdersMissingProcessorFee,
    getProcessingFeeForPaymentIntent,
  };
}

const STRIPE_DOWN = async () => {
  throw new Error("stripe down");
};

describe("backfillProcessorFees", () => {
  it("stamps the fee Stripe reported, per order", async () => {
    const { deps, stampProcessorFee, recordProcessorFeeReadFailure } =
      makeDeps(
        [ORDER(), ORDER({ id: "order-2", stripePaymentIntentId: "pi_2" })],
        { feeCents: 137, currency: "usd" },
      );

    const out = await backfillProcessorFees(deps, { limit: 10 });

    expect(out.considered).toBe(2);
    expect(out.stamped).toBe(2);
    expect(out.failed).toBe(0);
    expect(out.parked).toBe(0);
    expect(stampProcessorFee).toHaveBeenCalledWith({
      orderId: "order-1",
      feeCents: 137,
    });
    // A success touches no bookkeeping.
    expect(recordProcessorFeeReadFailure).not.toHaveBeenCalled();
    // Per currency, never summed across currencies.
    expect(out.stampedCentsByCurrency).toEqual([
      { currency: "usd", feeCents: 274 },
    ]);
  });

  it("claims with the clock's now and the exported retry policy", async () => {
    const { deps, listOrdersMissingProcessorFee } = makeDeps([], {
      feeCents: 0,
      currency: "usd",
    });

    await backfillProcessorFees(deps, { limit: 7 });

    expect(listOrdersMissingProcessorFee).toHaveBeenCalledWith({
      limit: 7,
      now: NOW,
      retryBackoffMs: PROCESSOR_FEE_RETRY_BACKOFF_MS,
      maxFailures: PROCESSOR_FEE_MAX_READ_FAILURES,
    });
    // The policy itself: a day-ish of hourly attempts, six hours apart.
    expect(PROCESSOR_FEE_RETRY_BACKOFF_MS).toBe(6 * 60 * 60 * 1000);
    expect(PROCESSOR_FEE_MAX_READ_FAILURES).toBe(24);
  });

  it("REFUSES a fee denominated in another currency rather than converting it", async () => {
    // Converting would require inventing an FX rate, and the stored result
    // would be indistinguishable from a measurement.
    const { deps, stampProcessorFee, recordProcessorFeeReadFailure } =
      makeDeps([ORDER()], { feeCents: 137, currency: "eur" });
    const reportError = vi.fn();

    const out = await backfillProcessorFees(
      { ...deps, reportError } as never,
      { limit: 10 },
    );

    expect(stampProcessorFee).not.toHaveBeenCalled();
    expect(out.stamped).toBe(0);
    expect(out.failed).toBe(1);
    // A mismatch is as permanent as a dead intent, so it is RECORDED the
    // same way and backs off the same way.
    expect(recordProcessorFeeReadFailure).toHaveBeenCalledWith({
      orderId: "order-1",
      failedAt: NOW,
    });
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ step: "currencyMismatch" }),
      }),
    );
  });

  it("carries on after a per-order read failure, and reports it", async () => {
    let call = 0;
    const getFee = vi.fn(async () => {
      call += 1;
      if (call === 1) throw new Error("no such payment_intent");
      return { feeCents: 200, currency: "usd" };
    });
    const { deps, stampProcessorFee } = makeDeps(
      [ORDER(), ORDER({ id: "order-2", stripePaymentIntentId: "pi_2" })],
      getFee,
    );
    const reportError = vi.fn();

    const out = await backfillProcessorFees(
      { ...deps, reportError } as never,
      { limit: 10 },
    );

    // One failed, the OTHER still got stamped — a single bad order must not
    // stop the batch.
    expect(out.failed).toBe(1);
    expect(out.stamped).toBe(1);
    expect(stampProcessorFee).toHaveBeenCalledTimes(1);
    expect(stampProcessorFee).toHaveBeenCalledWith({
      orderId: "order-2",
      feeCents: 200,
    });
    expect(reportError).toHaveBeenCalled();
  });

  it("NEVER stamps anything when the read fails — the row stays NULL", async () => {
    const { deps, stampProcessorFee } = makeDeps([ORDER()], STRIPE_DOWN);

    const out = await backfillProcessorFees(deps, { limit: 10 });

    // The whole contract: no fallback, no estimate, no zero.
    expect(stampProcessorFee).not.toHaveBeenCalled();
    expect(out.stamped).toBe(0);
    expect(out.stampedCentsByCurrency).toEqual([]);
  });

  it("a throwing reporter does not change the result", async () => {
    const reportError = vi.fn(() => {
      throw new Error("sentry exploded");
    });
    const { deps } = makeDeps([ORDER()], STRIPE_DOWN);

    const out = await backfillProcessorFees(
      { ...deps, reportError } as never,
      { limit: 10 },
    );

    expect(out.failed).toBe(1);
    expect(out.considered).toBe(1);
  });

  it("counts a lost stamp race as alreadyStamped, not as a failure", async () => {
    const { deps, recordProcessorFeeReadFailure } = makeDeps([ORDER()], {
      feeCents: 137,
      currency: "usd",
    });
    (
      deps as unknown as {
        repos: { orders: { stampProcessorFee: ReturnType<typeof vi.fn> } };
      }
    ).repos.orders.stampProcessorFee = vi.fn(async () => false);

    const out = await backfillProcessorFees(deps, { limit: 10 });

    expect(out.alreadyStamped).toBe(1);
    expect(out.stamped).toBe(0);
    expect(out.failed).toBe(0);
    expect(recordProcessorFeeReadFailure).not.toHaveBeenCalled();
    // A lost race contributes no cents — the winner already counted them.
    expect(out.stampedCentsByCurrency).toEqual([]);
  });

  it("reports the oldest unstamped order so the backlog's age is visible", async () => {
    const oldest = new Date("2026-01-01T00:00:00.000Z");
    const { deps } = makeDeps(
      [
        ORDER({ occurredAt: oldest }),
        ORDER({
          id: "order-2",
          stripePaymentIntentId: "pi_2",
          occurredAt: new Date("2026-09-01T00:00:00.000Z"),
        }),
      ],
      { feeCents: 1, currency: "usd" },
    );

    const out = await backfillProcessorFees(deps, { limit: 10 });

    // The claim query is oldest-first, so the head IS the oldest.
    expect(out.oldestUnstampedAt).toEqual(oldest);
  });

  it("returns an empty, honest result when there is nothing to do", async () => {
    const { deps } = makeDeps([], { feeCents: 0, currency: "usd" });
    const out = await backfillProcessorFees(deps, { limit: 10 });
    expect(out).toMatchObject({
      considered: 0,
      stamped: 0,
      failed: 0,
      parked: 0,
      oldestUnstampedAt: null,
    });
  });
});

// ── Failure bookkeeping: back off, park, and do not flood ──────────────────
//
// Oldest-first with no failure memory retried a dead row every hour forever
// and fired a Sentry event for it every hour forever. These pin the fix:
// every failure is recorded with the sweep's clock; Sentry hears about a row
// only on the count-1 and count-cap transitions (so at most twice, and never
// twice for the same transition even under concurrent runs); and a row a
// concurrent run has stamped is never marked failed.

describe("backfillProcessorFees — failure bookkeeping", () => {
  it("records a read failure on the row, stamped with the clock's now", async () => {
    const { deps, recordProcessorFeeReadFailure } = makeDeps(
      [ORDER()],
      STRIPE_DOWN,
    );

    const out = await backfillProcessorFees(deps, { limit: 10 });

    expect(recordProcessorFeeReadFailure).toHaveBeenCalledTimes(1);
    expect(recordProcessorFeeReadFailure).toHaveBeenCalledWith({
      orderId: "order-1",
      failedAt: NOW,
    });
    expect(out.failed).toBe(1);
    expect(out.parked).toBe(0);
  });

  it("reports the FIRST failure of a row", async () => {
    const { deps } = makeDeps([ORDER()], STRIPE_DOWN, {
      ordersRepo: { recordProcessorFeeReadFailure: vi.fn(async () => 1) },
    });
    const reportError = vi.fn();

    await backfillProcessorFees({ ...deps, reportError } as never, {
      limit: 10,
    });

    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { useCase: "backfillProcessorFees", step: "readStripeFee" },
        extra: { orderId: "order-1", failures: 1, parked: false },
      }),
    );
  });

  it("does NOT report a repeat failure of the same row — that is the flood", async () => {
    // The row has failed before (count 1 → 2 after this run). It is still
    // logged, still counted, still recorded; it just does not page anyone.
    const { deps, recordProcessorFeeReadFailure } = makeDeps(
      [ORDER({ processorFeeReadFailures: 1 })],
      STRIPE_DOWN,
      {
        ordersRepo: { recordProcessorFeeReadFailure: vi.fn(async () => 2) },
      },
    );
    const reportError = vi.fn();
    const logger = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      child: vi.fn(),
    };
    logger.child.mockReturnValue(logger);

    const out = await backfillProcessorFees(
      { ...deps, reportError, logger } as never,
      { limit: 10 },
    );

    expect(reportError).not.toHaveBeenCalled();
    expect(recordProcessorFeeReadFailure).not.toHaveBeenCalled(); // replaced above
    expect(logger.error).toHaveBeenCalledWith(
      "backfill_processor_fee_read_failed",
      expect.objectContaining({ orderId: "order-1", priorFailures: 1 }),
    );
    expect(out.failed).toBe(1);
    expect(out.parked).toBe(0);
  });

  it("reports ONCE MORE when a row reaches the cap, and counts it as parked", async () => {
    const { deps } = makeDeps(
      [ORDER({ processorFeeReadFailures: PROCESSOR_FEE_MAX_READ_FAILURES - 1 })],
      STRIPE_DOWN,
      {
        ordersRepo: {
          recordProcessorFeeReadFailure: vi.fn(
            async () => PROCESSOR_FEE_MAX_READ_FAILURES,
          ),
        },
      },
    );
    const reportError = vi.fn();

    const out = await backfillProcessorFees(
      { ...deps, reportError } as never,
      { limit: 10 },
    );

    expect(out.failed).toBe(1);
    expect(out.parked).toBe(1);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ parked: "true" }),
        extra: {
          orderId: "order-1",
          failures: PROCESSOR_FEE_MAX_READ_FAILURES,
          parked: true,
        },
      }),
    );
  });

  it("a count PAST the cap is not a second parking — the other run already did it", async () => {
    // Cron and a manual trigger both claimed the row at cap−1; the atomic
    // increment gave the other run exactly cap (it parked and reported) and
    // this run cap+1. This run must neither count nor report a parking.
    const { deps } = makeDeps(
      [ORDER({ processorFeeReadFailures: PROCESSOR_FEE_MAX_READ_FAILURES - 1 })],
      STRIPE_DOWN,
      {
        ordersRepo: {
          recordProcessorFeeReadFailure: vi.fn(
            async () => PROCESSOR_FEE_MAX_READ_FAILURES + 1,
          ),
        },
      },
    );
    const reportError = vi.fn();

    const out = await backfillProcessorFees(
      { ...deps, reportError } as never,
      { limit: 10 },
    );

    expect(out.failed).toBe(1);
    expect(out.parked).toBe(0);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("a currency mismatch is recorded exactly like a read failure", async () => {
    const { deps, recordProcessorFeeReadFailure } = makeDeps(
      [ORDER({ processorFeeReadFailures: 3 })],
      { feeCents: 10, currency: "eur" },
      {
        ordersRepo: { recordProcessorFeeReadFailure: vi.fn(async () => 4) },
      },
    );
    const reportError = vi.fn();
    const record = (
      deps as unknown as {
        repos: { orders: { recordProcessorFeeReadFailure: ReturnType<typeof vi.fn> } };
      }
    ).repos.orders.recordProcessorFeeReadFailure;

    const out = await backfillProcessorFees(
      { ...deps, reportError } as never,
      { limit: 10 },
    );

    expect(record).toHaveBeenCalledWith({ orderId: "order-1", failedAt: NOW });
    expect(recordProcessorFeeReadFailure).not.toHaveBeenCalled(); // replaced
    // Fourth failure: in-between, so recorded and counted but not reported.
    expect(reportError).not.toHaveBeenCalled();
    expect(out.failed).toBe(1);
    expect(out.parked).toBe(0);
  });

  it("never marks a row failed once a concurrent run has stamped it", async () => {
    // The adapter's IS NULL guard returns 0 — nothing recorded. Whatever the
    // row's prior count, it is not parked and Sentry is not told: the
    // problem no longer exists.
    const { deps } = makeDeps(
      [ORDER({ processorFeeReadFailures: PROCESSOR_FEE_MAX_READ_FAILURES - 1 })],
      STRIPE_DOWN,
      {
        ordersRepo: { recordProcessorFeeReadFailure: vi.fn(async () => 0) },
      },
    );
    const reportError = vi.fn();

    const out = await backfillProcessorFees(
      { ...deps, reportError } as never,
      { limit: 10 },
    );

    // The read DID fail this run, so it is honest to count it...
    expect(out.failed).toBe(1);
    // ...but nothing was parked and nothing was reported.
    expect(out.parked).toBe(0);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("a failing bookkeeping write is the run's failure, not a swallowed one", async () => {
    // Bookkeeping is the anti-flood mechanism itself. If it cannot be
    // written, retrying forever is exactly the bug — so this is NOT caught.
    const { deps } = makeDeps([ORDER()], STRIPE_DOWN, {
      ordersRepo: {
        recordProcessorFeeReadFailure: vi.fn(async () => {
          throw new Error("db down");
        }),
      },
    });

    await expect(backfillProcessorFees(deps, { limit: 10 })).rejects.toThrow(
      "db down",
    );
  });
});
