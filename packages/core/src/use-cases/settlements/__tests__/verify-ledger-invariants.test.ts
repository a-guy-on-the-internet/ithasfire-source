import { describe, it, expect, vi } from "vitest";

import type { Repos } from "@th/ports/repos";
import type {
  PayeeLedgerCancelledEventCashDebitRow,
  PayeeLedgerCompletenessGapRow,
  PayeeLedgerConservationViolationRow,
  PayeeLedgerInvariantScan,
  PayeeLedgerRollupDriftRow,
} from "@th/ports/repos/payee-ledger";
import type { CancelledEventOpenDoorCardSaleRow } from "@th/types/repos/orders";
import { verifyLedgerInvariants } from "../verify-ledger-invariants";

/**
 * Unit coverage for the reconciliation sweep's REPORTING DISCIPLINE — the
 * part a green integration test cannot prove:
 *
 *  - exactly ONE grouped `reportError` per violated invariant CLASS per run
 *    (never per-row: a per-row report on a mass drift floods Sentry and
 *    destroys the signal the job exists to protect);
 *  - a clean ledger produces ZERO reports and zero error logs;
 *  - a THROWING reporter/logger never breaks the sweep (regression pattern:
 *    search/__tests__ reporter tests);
 *  - counts come from the scan's `total`, not the capped sample length.
 *
 * The SQL itself is proven against real Postgres in
 * adapters/.../payee-ledger-invariants.integration.test.ts.
 */

const NOW = new Date("2026-08-18T12:00:00.000Z");

const cleanScan = <T>(): PayeeLedgerInvariantScan<T> => ({
  total: 0,
  rows: [],
});

const DRIFT_ROW: PayeeLedgerRollupDriftRow = {
  payeeId: "payee-1",
  currency: "usd",
  cachedLedgerBalanceCents: 10_000,
  expectedLedgerBalanceCents: 10_000,
  cachedPendingHoldCents: 0,
  expectedPendingHoldCents: 8_000,
  cachedReserveCents: 0,
  expectedReserveCents: 0,
  rollupRowMissing: false,
  orphanRollupRow: false,
};

const CONSERVATION_ROW: PayeeLedgerConservationViolationRow = {
  orderId: "order-1",
  payeeId: "payee-1",
  currency: "usd",
  creditCents: 5_000,
  refundDebitCents: 6_000,
  transferReversalCreditCents: 0,
  disputeDebitCents: 0,
  disputeDebitReversalCents: 0,
  disputeFeeDebitCents: 0,
  cashSaleDebitCents: 0,
  cashSaleDebitReversalCents: 0,
};

const COMPLETENESS_ROW: PayeeLedgerCompletenessGapRow = {
  orderId: "order-2",
  payeeId: "payee-2",
  currency: "usd",
  expectedFromSplitsCents: 3_450,
  creditCents: 0,
};

const CANCELLED_CASH_ROW: PayeeLedgerCancelledEventCashDebitRow = {
  orderId: "order-3",
  eventId: "event-3",
  payeeId: "payee-3",
  currency: "usd",
  cashSaleDebitCents: 872,
};

const OPEN_DOOR_CARD_ROW: CancelledEventOpenDoorCardSaleRow = {
  orderId: "order-4",
  eventId: "event-3",
  status: "SUCCEEDED",
  paymentIntentId: "pi_door_paid",
  currency: "usd",
  amountGrossCents: 2_675,
};

function makeDeps(scans: {
  rollup?: PayeeLedgerInvariantScan<PayeeLedgerRollupDriftRow>;
  conservation?: PayeeLedgerInvariantScan<PayeeLedgerConservationViolationRow>;
  completeness?: PayeeLedgerInvariantScan<PayeeLedgerCompletenessGapRow>;
  cancelledCash?: PayeeLedgerInvariantScan<PayeeLedgerCancelledEventCashDebitRow>;
  openDoorCard?: PayeeLedgerInvariantScan<CancelledEventOpenDoorCardSaleRow>;
}) {
  const listRollupDrift = vi
    .fn()
    .mockResolvedValue(scans.rollup ?? cleanScan());
  const listConservationViolations = vi
    .fn()
    .mockResolvedValue(scans.conservation ?? cleanScan());
  const listCompletenessGaps = vi
    .fn()
    .mockResolvedValue(scans.completeness ?? cleanScan());
  const listUnreversedCashSaleDebitsOnCancelledEvents = vi
    .fn()
    .mockResolvedValue(scans.cancelledCash ?? cleanScan());
  const listOpenDoorCardSalesOnCancelledEvents = vi
    .fn()
    .mockResolvedValue(scans.openDoorCard ?? cleanScan());

  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  const reportError = vi.fn();

  const deps = {
    repos: {
      payeeLedger: {
        listRollupDrift,
        listConservationViolations,
        listCompletenessGaps,
        listUnreversedCashSaleDebitsOnCancelledEvents,
      },
      orders: { listOpenDoorCardSalesOnCancelledEvents },
    } as unknown as Repos,
    clock: { now: () => NOW },
    logger: logger as never,
    reportError,
  };

  return {
    deps,
    logger,
    reportError,
    listRollupDrift,
    listConservationViolations,
    listCompletenessGaps,
    listUnreversedCashSaleDebitsOnCancelledEvents,
    listOpenDoorCardSalesOnCancelledEvents,
  };
}

describe("verifyLedgerInvariants", () => {
  it("clean ledger: zero reports, zero error logs, zero counts", async () => {
    const { deps, logger, reportError } = makeDeps({});

    const result = await verifyLedgerInvariants(deps, {});

    expect(result).toEqual({
      rollupDriftCount: 0,
      conservationViolationCount: 0,
      completenessGapCount: 0,
      cancelledEventCashDebitCount: 0,
      cancelledEventOpenDoorCardSaleCount: 0,
      samples: {
        rollupDrift: [],
        conservation: [],
        completeness: [],
        cancelledEventCashDebit: [],
        cancelledEventOpenDoorCardSale: [],
      },
      // A clean sweep with no solvency probe wired reports `null` rather than
      // a zeroed figure — an unmeasured balance must not read as a measured one.
      solvency: null,
    });
    expect(reportError).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("passes the grace cutoff (now − graceMinutes) and the sample cap to the repo", async () => {
    const {
      deps,
      listCompletenessGaps,
      listRollupDrift,
      listUnreversedCashSaleDebitsOnCancelledEvents,
      listOpenDoorCardSalesOnCancelledEvents,
    } = makeDeps({});

    await verifyLedgerInvariants(deps, { graceMinutes: 45, sampleLimit: 5 });

    expect(listCompletenessGaps).toHaveBeenCalledWith(
      new Date(NOW.getTime() - 45 * 60_000),
      5,
    );
    // The cancelled-event cash scan gets the same grace: a cancellation whose
    // door phase is still running is not a violation yet.
    expect(listUnreversedCashSaleDebitsOnCancelledEvents).toHaveBeenCalledWith(
      new Date(NOW.getTime() - 45 * 60_000),
      5,
    );
    expect(listOpenDoorCardSalesOnCancelledEvents).toHaveBeenCalledWith(
      new Date(NOW.getTime() - 45 * 60_000),
      5,
    );
    expect(listRollupDrift).toHaveBeenCalledWith(5);
  });

  it("defaults the grace window to 30 minutes", async () => {
    const { deps, listCompletenessGaps } = makeDeps({});

    await verifyLedgerInvariants(deps, {});

    expect(listCompletenessGaps).toHaveBeenCalledWith(
      new Date(NOW.getTime() - 30 * 60_000),
      20,
    );
  });

  it("rejects unknown input keys (strict schema at the boundary)", async () => {
    const { deps } = makeDeps({});
    await expect(
      verifyLedgerInvariants(deps, { graceMinutes: 30, repair: true }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("violations in all five classes: exactly ONE grouped report per class, tagged with the invariant", async () => {
    const { deps, logger, reportError } = makeDeps({
      // totals larger than the sample arrays: MANY violating rows collapsed
      // into one grouped report each.
      rollup: { total: 3, rows: [DRIFT_ROW] },
      conservation: { total: 2, rows: [CONSERVATION_ROW] },
      completeness: { total: 1, rows: [COMPLETENESS_ROW] },
      cancelledCash: { total: 4, rows: [CANCELLED_CASH_ROW] },
      openDoorCard: { total: 5, rows: [OPEN_DOOR_CARD_ROW] },
    });

    const result = await verifyLedgerInvariants(deps, {});

    // Counts come from `total`, never from the capped sample length.
    expect(result.rollupDriftCount).toBe(3);
    expect(result.conservationViolationCount).toBe(2);
    expect(result.completenessGapCount).toBe(1);
    expect(result.cancelledEventCashDebitCount).toBe(4);
    expect(result.cancelledEventOpenDoorCardSaleCount).toBe(5);
    expect(result.samples.rollupDrift).toEqual([DRIFT_ROW]);
    expect(result.samples.cancelledEventCashDebit).toEqual([CANCELLED_CASH_ROW]);

    // ONE report per class — grouped, never per-row.
    expect(reportError).toHaveBeenCalledTimes(5);
    const calls = reportError.mock.calls;
    expect(
      calls.map((c) => (c[1] as { tags: { invariant: string } }).tags),
    ).toEqual([
      { job: "settlements.verify-ledger", invariant: "rollup_drift" },
      { job: "settlements.verify-ledger", invariant: "conservation" },
      { job: "settlements.verify-ledger", invariant: "completeness" },
      {
        job: "settlements.verify-ledger",
        invariant: "cancelled_event_cash_debit",
      },
      {
        job: "settlements.verify-ledger",
        invariant: "cancelled_event_open_door_card_sale",
      },
    ]);
    for (const [err, context] of calls) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe("ledger_invariant_violation");
      expect(
        (context as { extra: { samples: unknown[] } }).extra.samples.length,
      ).toBeGreaterThan(0);
    }

    // And the same payload rides logger.error (warn is NOT Sentry-captured,
    // so error is the required level — house convention).
    expect(logger.error).toHaveBeenCalledTimes(5);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("a cash debit left on a cancelled event alone reports once, with its sample", async () => {
    const { deps, reportError } = makeDeps({
      cancelledCash: { total: 1, rows: [CANCELLED_CASH_ROW] },
    });

    const result = await verifyLedgerInvariants(deps, {});

    expect(result.cancelledEventCashDebitCount).toBe(1);
    expect(result.rollupDriftCount).toBe(0);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]![1]).toMatchObject({
      tags: { invariant: "cancelled_event_cash_debit" },
      extra: {
        counts: { cancelled_event_cash_debit: 1 },
        samples: [CANCELLED_CASH_ROW],
      },
    });
  });

  it("a single violated class reports once; clean classes stay silent", async () => {
    const { deps, reportError } = makeDeps({
      conservation: { total: 1, rows: [CONSERVATION_ROW] },
    });

    await verifyLedgerInvariants(deps, {});

    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]![1]).toMatchObject({
      tags: { invariant: "conservation" },
      extra: { counts: { conservation: 1 } },
    });
  });

  it("an open door card sale on a cancelled event alone reports once, with its sample (report-only)", async () => {
    const { deps, reportError } = makeDeps({
      openDoorCard: { total: 1, rows: [OPEN_DOOR_CARD_ROW] },
    });

    const result = await verifyLedgerInvariants(deps, {});

    expect(result.cancelledEventOpenDoorCardSaleCount).toBe(1);
    expect(result.samples.cancelledEventOpenDoorCardSale).toEqual([
      OPEN_DOOR_CARD_ROW,
    ]);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]![1]).toMatchObject({
      tags: { invariant: "cancelled_event_open_door_card_sale" },
      extra: {
        counts: { cancelled_event_open_door_card_sale: 1 },
        samples: [OPEN_DOOR_CARD_ROW],
      },
    });
  });

  it("a THROWING reporter never breaks the sweep — every class still checked, output intact", async () => {
    const { deps, reportError, listCompletenessGaps } = makeDeps({
      rollup: { total: 1, rows: [DRIFT_ROW] },
      conservation: { total: 1, rows: [CONSERVATION_ROW] },
      completeness: { total: 1, rows: [COMPLETENESS_ROW] },
    });
    reportError.mockImplementation(() => {
      throw new Error("sentry is down");
    });

    const result = await verifyLedgerInvariants(deps, {});

    expect(result.rollupDriftCount).toBe(1);
    expect(result.conservationViolationCount).toBe(1);
    expect(result.completenessGapCount).toBe(1);
    // All three classes were still swept and reported-at (attempted).
    expect(reportError).toHaveBeenCalledTimes(3);
    expect(listCompletenessGaps).toHaveBeenCalledTimes(1);
  });

  it("a THROWING logger never breaks the sweep either", async () => {
    const { deps, logger, reportError } = makeDeps({
      rollup: { total: 1, rows: [DRIFT_ROW] },
    });
    logger.error.mockImplementation(() => {
      throw new Error("logger exploded");
    });

    const result = await verifyLedgerInvariants(deps, {});

    expect(result.rollupDriftCount).toBe(1);
    // The Sentry report still fired even though the log line threw.
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it("a missing reporter (undefined) is fine — the sweep is report-optional by contract", async () => {
    const { deps } = makeDeps({
      rollup: { total: 1, rows: [DRIFT_ROW] },
    });
    (deps as { reportError?: unknown }).reportError = undefined;

    const result = await verifyLedgerInvariants(deps, {});
    expect(result.rollupDriftCount).toBe(1);
  });
});
