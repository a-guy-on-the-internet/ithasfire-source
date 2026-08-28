import { beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";

vi.mock("@th/core/use-cases/settlements/run-batch", () => ({
  runPayoutBatch: vi.fn(),
}));

vi.mock("@th/core/use-cases/settlements/verify-ledger-invariants", () => ({
  verifyLedgerInvariants: vi.fn(),
}));

vi.mock("../lib/discord-alerts", () => ({
  fireDiscordAlert: vi.fn(async () => undefined),
  // No GCP project in the test env — helper returns null and the alert
  // payload omits the Logs field, matching production behaviour for
  // unconfigured environments.
  buildCloudLoggingUrl: vi.fn(() => null),
}));

import { runPayoutBatch } from "@th/core/use-cases/settlements/run-batch";
import { verifyLedgerInvariants } from "@th/core/use-cases/settlements/verify-ledger-invariants";

import { settlementJobs } from "../jobs/settlements";
import { fireDiscordAlert } from "../lib/discord-alerts";

function buildLogger() {
  const logger = {
    child: vi.fn(() => logger),
    withTime: vi.fn(
      async (_name: string, fn: () => Promise<unknown>) => await fn(),
    ),
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  return logger;
}

function buildContext() {
  return {
    repos: {} as any,
    payments: {} as any,
    idempotency: {} as any,
    fileStorage: {} as any,
    clock: { now: () => new Date("2026-04-22T00:00:00.000Z") },
    logger: buildLogger() as any,
    enqueue: vi.fn(),
    searchIndex: {} as any,
    multiSearch: null,
    mailer: null,
    runId: "test-run-12345",
  } as const;
}

const BASE_RESULT = {
  payoutId: null,
  payeesConsidered: 0,
  itemsCreated: 0,
  itemsTransferred: 0,
  itemsFailed: 0,
  itemsSkippedBelowMinimum: 0,
  itemsSkippedIneligible: 0,
  itemsSkippedPayableDropped: 0,
  itemsSkippedClaimLost: 0,
  payeesDeferredByLimit: 0,
  itemsLedgerHealed: 0,
  itemsHeldForSuspension: 0,
  itemsFullyWithheld: 0,
  totalTransferredCents: 0,
  totalPayableClaimedCents: 0,
  reserveHeldCents: 0,
  itemsWithReserveHeld: 0,
  reserveReleasedCents: 0,
  itemsWithReserveReleased: 0,
  connectFeeCents: 0,
  itemsWithConnectAccountFee: 0,
} satisfies Awaited<ReturnType<typeof runPayoutBatch>>;

describe("settlement jobs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("registration", () => {
    it("exports run-batch and verify-ledger — execute-transfer died with the settlement claim machinery", () => {
      expect(settlementJobs).toHaveLength(2);
      expect(
        settlementJobs.find((job) => job.name === "settlements.run-batch"),
      ).toBeDefined();
      expect(
        settlementJobs.find((job) => job.name === "settlements.verify-ledger"),
      ).toBeDefined();
      expect(
        settlementJobs.find(
          (job) => job.name === "settlements.execute-transfer",
        ),
      ).toBeUndefined();
    });
  });

  describe("settlements.run-batch", () => {
    const job = settlementJobs.find(
      (entry) => entry.name === "settlements.run-batch",
    )!;

    it("defaults limit to 100", () => {
      expect(job.input.parse({})).toEqual({ limit: 100 });
    });

    it("rejects invalid limits", () => {
      expect(() => job.input.parse({ limit: 0 })).toThrow(ZodError);
      expect(() => job.input.parse({ limit: 501 })).toThrow(ZodError);
    });

    it("logs skip-only batches without sending Discord alerts", async () => {
      const ctx = buildContext();
      vi.mocked(runPayoutBatch).mockResolvedValueOnce({
        ...BASE_RESULT,
        payeesConsidered: 4,
        itemsSkippedBelowMinimum: 2,
        itemsSkippedIneligible: 1,
        itemsHeldForSuspension: 1,
      });

      await job.handler({ input: { limit: 25 } as any, ctx: ctx as any });

      expect(fireDiscordAlert).not.toHaveBeenCalled();
      expect(ctx.logger.info).toHaveBeenCalledWith(
        "settlements.run-batch.completed",
        expect.objectContaining({
          payeesConsidered: 4,
          itemsTransferred: 0,
          itemsFailed: 0,
          itemsSkippedBelowMinimum: 2,
          itemsSkippedIneligible: 1,
          itemsHeldForSuspension: 1,
          totalPayableClaimedCents: 0,
        }),
      );
    });

    it("sends a Discord alert when transfers are processed", async () => {
      const ctx = buildContext();
      vi.mocked(runPayoutBatch).mockResolvedValueOnce({
        ...BASE_RESULT,
        payoutId: "payout_123",
        payeesConsidered: 2,
        itemsCreated: 2,
        itemsTransferred: 2,
        totalTransferredCents: 12500,
        totalPayableClaimedCents: 12500,
      });

      await job.handler({ input: { limit: 25 } as any, ctx: ctx as any });

      expect(fireDiscordAlert).toHaveBeenCalledTimes(1);
      expect(ctx.logger.log).toHaveBeenCalledWith(
        "info",
        "settlements.run-batch.completed",
        expect.objectContaining({ itemsTransferred: 2, itemsFailed: 0 }),
      );
      // The Discord alert reports payee throughput ("paid / considered"),
      // which is the unit the ledger batch works in.
      const alertPayload = vi.mocked(fireDiscordAlert).mock.calls[0]?.[0];
      expect(alertPayload?.fields).toEqual(
        expect.arrayContaining([
          { name: "Payees", value: "2/2 paid", inline: true },
        ]),
      );
      // Clean run (all skip counters 0) must NOT emit a noisy "Skipped" field.
      expect(
        alertPayload?.fields?.some((f) => f.name === "Skipped"),
      ).toBe(false);
    });

    it("includes a per-reason Skipped breakdown field when cells were skipped", async () => {
      const ctx = buildContext();
      vi.mocked(runPayoutBatch).mockResolvedValueOnce({
        ...BASE_RESULT,
        payoutId: "payout_456",
        payeesConsidered: 5,
        itemsCreated: 1,
        itemsTransferred: 1,
        itemsSkippedBelowMinimum: 3,
        itemsSkippedIneligible: 2,
        itemsSkippedPayableDropped: 1,
        itemsHeldForSuspension: 1,
        itemsFailed: 1,
        totalTransferredCents: 5000,
        totalPayableClaimedCents: 5000,
      });

      await job.handler({ input: { limit: 25 } as any, ctx: ctx as any });

      expect(fireDiscordAlert).toHaveBeenCalledTimes(1);
      const alertPayload = vi.mocked(fireDiscordAlert).mock.calls[0]?.[0];
      expect(alertPayload?.fields).toEqual(
        expect.arrayContaining([
          {
            name: "Skipped",
            value:
              "3 below-min · 2 ineligible · 1 payable-dropped · 0 claim-lost · 1 suspended",
            inline: true,
          },
        ]),
      );
      const names = alertPayload?.fields?.map((f) => f.name) ?? [];
      expect(names).toEqual([
        "Payout ID",
        "Transferred",
        "Failed",
        "Payees",
        "Skipped",
        "Total",
      ]);
    });

    it("surfaces backlog pressure and crash heals as their own alert fields", async () => {
      const ctx = buildContext();
      vi.mocked(runPayoutBatch).mockResolvedValueOnce({
        ...BASE_RESULT,
        payoutId: "payout_abc",
        payeesConsidered: 100,
        itemsCreated: 100,
        itemsTransferred: 100,
        payeesDeferredByLimit: 37,
        itemsLedgerHealed: 2,
        totalTransferredCents: 500_000,
        totalPayableClaimedCents: 500_000,
      });

      await job.handler({ input: { limit: 100 } as any, ctx: ctx as any });

      const alertPayload = vi.mocked(fireDiscordAlert).mock.calls[0]?.[0];
      expect(alertPayload?.fields).toEqual(
        expect.arrayContaining([
          {
            name: "Deferred by limit",
            value: "37 payee(s) — raise the batch limit if this persists",
            inline: true,
          },
          {
            name: "Ledger healed",
            value: "2 item(s) from a previous crashed run",
            inline: true,
          },
        ]),
      );
    });

    it("calls out fully-withheld items (no Stripe transfer) in the alert", async () => {
      const ctx = buildContext();
      vi.mocked(runPayoutBatch).mockResolvedValueOnce({
        ...BASE_RESULT,
        payoutId: "payout_789",
        payeesConsidered: 1,
        itemsCreated: 1,
        itemsTransferred: 1,
        itemsFullyWithheld: 1,
        totalTransferredCents: 0,
        totalPayableClaimedCents: 4000,
        reserveHeldCents: 4000,
        itemsWithReserveHeld: 1,
      });

      await job.handler({ input: { limit: 25 } as any, ctx: ctx as any });

      const alertPayload = vi.mocked(fireDiscordAlert).mock.calls[0]?.[0];
      expect(alertPayload?.fields).toEqual(
        expect.arrayContaining([
          {
            name: "Fully withheld",
            value: "1 item(s) — no Stripe transfer",
            inline: true,
          },
          {
            name: "Reserve",
            value: "held $40.00 · 1 item(s) · released $0.00 · 0 item(s)",
            inline: true,
          },
        ]),
      );
    });

    it("sends a crash alert with error/runId/limit fields and rethrows when the batch handler throws", async () => {
      const ctx = buildContext();
      vi.mocked(runPayoutBatch).mockRejectedValueOnce(
        new Error("database unavailable"),
      );

      await expect(
        job.handler({ input: { limit: 25 } as any, ctx: ctx as any }),
      ).rejects.toThrow("database unavailable");

      expect(fireDiscordAlert).toHaveBeenCalledTimes(1);
      const payload = vi.mocked(fireDiscordAlert).mock.calls[0]?.[0];
      expect(payload).toMatchObject({
        title: "Settlement Batch CRASHED",
        colour: "error",
        description:
          "Batch failed before completion. Manual investigation required.",
      });
      // Underlying error now flows into the Discord embed via fields so
      // operators don't have to dig through Cloud Logging to see what
      // actually died.
      expect(payload?.fields).toEqual(
        expect.arrayContaining([
          { name: "Error", value: "database unavailable", inline: false },
          { name: "Run ID", value: "test-run-12345", inline: true },
          { name: "Limit", value: "25", inline: true },
        ]),
      );
      // No GCP project in tests → buildCloudLoggingUrl returns null
      // → no Logs field. In prod a deep-link replaces this absence.
      expect(
        payload?.fields?.some((f) => f.name === "Logs"),
      ).toBe(false);
      expect(ctx.logger.log).toHaveBeenCalledWith(
        "error",
        "settlements.run-batch.crashed",
        expect.objectContaining({
          runId: "test-run-12345",
          limit: 25,
          error: "database unavailable",
        }),
      );
    });
  });

  describe("settlements.verify-ledger", () => {
    const job = settlementJobs.find(
      (entry) => entry.name === "settlements.verify-ledger",
    )!;

    const CLEAN_RESULT = {
      rollupDriftCount: 0,
      conservationViolationCount: 0,
      completenessGapCount: 0,
      samples: {
        rollupDrift: [],
        conservation: [],
        completeness: [],
      },
    } satisfies Awaited<ReturnType<typeof verifyLedgerInvariants>>;

    it("is registered with the manifest schedule (manifest entry parses)", () => {
      // getSchedule() THROWS at module load for a missing manifest entry, so
      // the job existing at all proves the manifest wiring; assert the
      // deliberate offset from the payout batch anyway.
      expect(job).toBeDefined();
      expect(
        (job as unknown as { schedule: { cron: string; timezone: string } })
          .schedule,
      ).toEqual({ cron: "0 4 * * *", timezone: "America/Chicago" });
    });

    it("defaults graceMinutes to 30 and rejects out-of-range values", () => {
      expect(job.input.parse({})).toEqual({ graceMinutes: 30 });
      expect(() => job.input.parse({ graceMinutes: -1 })).toThrow(ZodError);
      expect(() => job.input.parse({ graceMinutes: 1441 })).toThrow(ZodError);
    });

    it("clean sweep: logs, no Discord alert", async () => {
      const ctx = buildContext();
      vi.mocked(verifyLedgerInvariants).mockResolvedValueOnce(CLEAN_RESULT);

      const result = await job.handler({
        input: { graceMinutes: 30 } as any,
        ctx: ctx as any,
      });

      expect(result).toEqual(CLEAN_RESULT);
      expect(fireDiscordAlert).not.toHaveBeenCalled();
      expect(ctx.logger.info).toHaveBeenCalledWith(
        "settlements.verify-ledger.clean",
        {
          rollupDriftCount: 0,
          conservationViolationCount: 0,
          completenessGapCount: 0,
        },
      );
    });

    it("violations: ONE Discord alert with per-invariant counts, logged at error", async () => {
      const ctx = buildContext();
      vi.mocked(verifyLedgerInvariants).mockResolvedValueOnce({
        ...CLEAN_RESULT,
        rollupDriftCount: 2,
        completenessGapCount: 1,
      });

      await job.handler({ input: { graceMinutes: 30 } as any, ctx: ctx as any });

      expect(fireDiscordAlert).toHaveBeenCalledTimes(1);
      const payload = vi.mocked(fireDiscordAlert).mock.calls[0]?.[0];
      expect(payload).toMatchObject({
        title: "Ledger invariant violation",
        colour: "error",
      });
      expect(payload?.fields).toEqual(
        expect.arrayContaining([
          { name: "Rollup drift", value: "2", inline: true },
          { name: "Conservation", value: "0", inline: true },
          { name: "Completeness", value: "1", inline: true },
          { name: "Run ID", value: "test-run-12345", inline: true },
        ]),
      );
      expect(ctx.logger.log).toHaveBeenCalledWith(
        "error",
        "settlements.verify-ledger.violations",
        expect.objectContaining({
          runId: "test-run-12345",
          rollupDriftCount: 2,
          completenessGapCount: 1,
        }),
      );
    });

    it("hands the composition root's reportError to the use case (Sentry grouping happens in core)", async () => {
      const ctx = buildContext();
      vi.mocked(verifyLedgerInvariants).mockResolvedValueOnce(CLEAN_RESULT);

      await job.handler({ input: { graceMinutes: 15 } as any, ctx: ctx as any });

      expect(verifyLedgerInvariants).toHaveBeenCalledWith(
        expect.objectContaining({
          repos: ctx.repos,
          clock: ctx.clock,
          reportError: (ctx as { reportError?: unknown }).reportError,
        }),
        { graceMinutes: 15 },
      );
    });

    it("rethrows an operational crash (DB down) to the job error-boundary", async () => {
      const ctx = buildContext();
      vi.mocked(verifyLedgerInvariants).mockRejectedValueOnce(
        new Error("database unavailable"),
      );

      await expect(
        job.handler({ input: { graceMinutes: 30 } as any, ctx: ctx as any }),
      ).rejects.toThrow("database unavailable");
    });
  });
});
