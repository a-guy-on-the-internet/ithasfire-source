import { beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";

vi.mock(
  "@th/core/use-cases/disputes/evidence/sweep-dispute-evidence-deadlines",
  () => ({
    sweepDisputeEvidenceDeadlines: vi.fn(),
  }),
);

vi.mock("../lib/discord-alerts", () => ({
  fireDiscordAlert: vi.fn(async () => undefined),
  // No GCP project in the test env — helper returns null and the alert
  // payload omits the Logs field, matching production behaviour for
  // unconfigured environments.
  buildCloudLoggingUrl: vi.fn(() => null),
}));

import {
  sweepDisputeEvidenceDeadlines,
  type DisputeEvidenceDeadlineAlert,
} from "@th/core/use-cases/disputes/evidence/sweep-dispute-evidence-deadlines";

import {
  DISPUTE_CHASE_MAX_ALERT_LINES,
  disputeJobs,
  formatDisputeAlertLine,
  formatDueRelative,
} from "../jobs/disputes";
import { fireDiscordAlert } from "../lib/discord-alerts";

const NOW = new Date("2026-09-01T19:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const daysFromNow = (days: number) => new Date(NOW.getTime() + days * DAY_MS);

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
    clock: { now: () => NOW },
    logger: buildLogger() as any,
    enqueue: vi.fn(),
    searchIndex: {} as any,
    multiSearch: null,
    mailer: null,
    reportError: vi.fn(),
    appBaseUrl: "https://ithasfire.com",
    runId: "test-run-12345",
  } as const;
}

function alert(
  overrides: Partial<DisputeEvidenceDeadlineAlert> = {},
): DisputeEvidenceDeadlineAlert {
  return {
    disputeId: "dispute_1",
    stripeDisputeId: "dp_1",
    bucket: "due_soon",
    dueBy: daysFromNow(2),
    evidenceStatus: "DRAFT",
    amountCents: 5_000,
    currency: "usd",
    eventTitle: "Rock Show",
    owner: "Drkmttr Collective",
    deskUrl: "https://ithasfire.com/platform/disputes?dispute=dispute_1",
    ...overrides,
  };
}

const EMPTY_RESULT = {
  ok: true as const,
  scanned: 0,
  healed: 0,
  healFailed: 0,
  alerts: [] as DisputeEvidenceDeadlineAlert[],
};

describe("dispute jobs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const job = disputeJobs.find(
    (entry) => entry.name === "disputes.chase-evidence-deadlines",
  )!;

  describe("registration", () => {
    it("exports the chase job on a business-hours CT schedule", () => {
      expect(disputeJobs).toHaveLength(1);
      expect(job).toBeDefined();
      expect(job.schedule).toEqual({
        cron: "0 14 * * *",
        timezone: "America/Chicago",
      });
    });

    it("defaults dueWithinDays to 3 and bounds it to 1..14", () => {
      expect(job.input.parse({})).toEqual({ dueWithinDays: 3 });
      expect(() => job.input.parse({ dueWithinDays: 0 })).toThrow(ZodError);
      expect(() => job.input.parse({ dueWithinDays: 15 })).toThrow(ZodError);
      expect(() => job.input.parse({ dueWithinDays: 2.5 })).toThrow(ZodError);
    });
  });

  describe("formatting", () => {
    it("renders coarse relative deadlines", () => {
      expect(formatDueRelative(null, NOW)).toBe("no due date");
      expect(formatDueRelative(daysFromNow(2), NOW)).toBe("due in 2d");
      expect(formatDueRelative(new Date(NOW.getTime() + 5 * 3_600_000), NOW)).toBe(
        "due in 5h",
      );
      expect(formatDueRelative(daysFromNow(-1), NOW)).toBe("overdue 1d");
      expect(formatDueRelative(new Date(NOW.getTime() - 90 * 60_000), NOW)).toBe(
        "overdue 1h",
      );
      expect(formatDueRelative(new Date(NOW.getTime() + 20 * 60_000), NOW)).toBe(
        "due in <1h",
      );
      expect(formatDueRelative(new Date(NOW.getTime() - 1), NOW)).toBe(
        "overdue <1h",
      );
    });

    it("renders one line per dispute with the desk link, falling back to the id", () => {
      expect(formatDisputeAlertLine(alert(), NOW)).toBe(
        "`due in 2d` · $50.00 · Rock Show · Drkmttr Collective · evidence: DRAFT · [desk](https://ithasfire.com/platform/disputes?dispute=dispute_1)",
      );
      expect(
        formatDisputeAlertLine(
          alert({
            deskUrl: undefined,
            eventTitle: null,
            owner: null,
            evidenceStatus: null,
            dueBy: null,
          }),
          NOW,
        ),
      ).toBe(
        "`no due date` · $50.00 · (no event) · (unknown owner) · evidence: none · dispute_1",
      );
    });
  });

  describe("disputes.chase-evidence-deadlines", () => {
    it("wires the sweep with the job clock, reporter and app origin", async () => {
      const ctx = buildContext();
      vi.mocked(sweepDisputeEvidenceDeadlines).mockResolvedValueOnce(EMPTY_RESULT);

      await job.handler({ input: { dueWithinDays: 5 } as any, ctx: ctx as any });

      expect(sweepDisputeEvidenceDeadlines).toHaveBeenCalledTimes(1);
      const [deps, input] = vi.mocked(sweepDisputeEvidenceDeadlines).mock.calls[0]!;
      expect(deps).toMatchObject({
        repos: ctx.repos,
        idempotency: ctx.idempotency,
        clock: ctx.clock,
        logger: ctx.logger,
        publicAppUrl: "https://ithasfire.com",
        reportError: ctx.reportError,
      });
      expect(input).toEqual({ now: NOW, dueWithinDays: 5 });
    });

    it("logs a clean run and sends nothing when no dispute needs attention", async () => {
      const ctx = buildContext();
      vi.mocked(sweepDisputeEvidenceDeadlines).mockResolvedValueOnce({
        ...EMPTY_RESULT,
        scanned: 2,
        healed: 1,
      });

      const result = await job.handler({
        input: { dueWithinDays: 3 } as any,
        ctx: ctx as any,
      });

      expect(result).toMatchObject({ scanned: 2, healed: 1 });
      expect(fireDiscordAlert).not.toHaveBeenCalled();
      expect(ctx.reportError).not.toHaveBeenCalled();
      expect(ctx.logger.info).toHaveBeenCalledWith(
        "disputes.chase-evidence-deadlines.clean",
        expect.objectContaining({ scanned: 2, healed: 1, alerts: 0 }),
      );
    });

    it("fires ONE warning alert with a line per dispute, bucket counts, and no Sentry event when nothing is overdue", async () => {
      const ctx = buildContext();
      vi.mocked(sweepDisputeEvidenceDeadlines).mockResolvedValueOnce({
        ...EMPTY_RESULT,
        scanned: 3,
        healed: 1,
        alerts: [
          alert(),
          alert({
            disputeId: "dispute_2",
            bucket: "submit_failed",
            evidenceStatus: "SUBMIT_FAILED",
            dueBy: daysFromNow(9),
            deskUrl: "https://ithasfire.com/platform/disputes?dispute=dispute_2",
          }),
          alert({
            disputeId: "dispute_3",
            bucket: "unassembled",
            evidenceStatus: null,
            dueBy: null,
            deskUrl: undefined,
          }),
        ],
      });

      await job.handler({ input: { dueWithinDays: 3 } as any, ctx: ctx as any });

      expect(fireDiscordAlert).toHaveBeenCalledTimes(1);
      const payload = vi.mocked(fireDiscordAlert).mock.calls[0]![0];
      expect(payload.title).toBe("Dispute evidence deadlines need attention");
      expect(payload.colour).toBe("warning");
      expect(payload.description?.split("\n")).toEqual([
        "`due in 2d` · $50.00 · Rock Show · Drkmttr Collective · evidence: DRAFT · [desk](https://ithasfire.com/platform/disputes?dispute=dispute_1)",
        "`due in 9d` · $50.00 · Rock Show · Drkmttr Collective · evidence: SUBMIT_FAILED · [desk](https://ithasfire.com/platform/disputes?dispute=dispute_2)",
        "`no due date` · $50.00 · Rock Show · Drkmttr Collective · evidence: none · dispute_3",
      ]);
      expect(payload.fields).toEqual([
        { name: "Overdue", value: "0", inline: true },
        { name: "Due soon", value: "1", inline: true },
        { name: "No due date", value: "0", inline: true },
        { name: "Submit failed", value: "1", inline: true },
        { name: "No package", value: "1", inline: true },
        { name: "Healed", value: "1 assembled · 0 failed", inline: true },
        { name: "Run ID", value: "test-run-12345", inline: true },
      ]);
      expect(ctx.reportError).not.toHaveBeenCalled();
      expect(ctx.logger.log).toHaveBeenCalledWith(
        "warn",
        "disputes.chase-evidence-deadlines.attention",
        expect.objectContaining({
          alerts: 3,
          due_soon: 1,
          submit_failed: 1,
          unassembled: 1,
          disputeIds: ["dispute_1", "dispute_2", "dispute_3"],
        }),
      );
    });

    it("escalates to error colour and a Sentry event when any dispute is overdue", async () => {
      const ctx = buildContext();
      vi.mocked(sweepDisputeEvidenceDeadlines).mockResolvedValueOnce({
        ...EMPTY_RESULT,
        scanned: 2,
        alerts: [
          alert({
            disputeId: "dispute_late",
            bucket: "overdue",
            dueBy: daysFromNow(-2),
            deskUrl: "https://ithasfire.com/platform/disputes?dispute=dispute_late",
          }),
          alert(),
        ],
      });

      await job.handler({ input: { dueWithinDays: 3 } as any, ctx: ctx as any });

      expect(fireDiscordAlert).toHaveBeenCalledTimes(1);
      const payload = vi.mocked(fireDiscordAlert).mock.calls[0]![0];
      expect(payload.title).toBe("Dispute evidence OVERDUE");
      expect(payload.colour).toBe("error");
      expect(payload.description?.split("\n")[0]).toContain("`overdue 2d`");
      expect(ctx.reportError).toHaveBeenCalledTimes(1);
      expect(ctx.reportError).toHaveBeenCalledWith(
        expect.objectContaining({ message: "dispute_evidence_overdue" }),
        expect.objectContaining({
          tags: { job: "disputes.chase-evidence-deadlines" },
          extra: expect.objectContaining({ overdueDisputeIds: ["dispute_late"] }),
        }),
      );
      expect(ctx.logger.log).toHaveBeenCalledWith(
        "error",
        "disputes.chase-evidence-deadlines.attention",
        expect.objectContaining({ overdue: 1, overdueDisputeIds: ["dispute_late"] }),
      );
    });

    it("caps the embed at 15 lines and appends '+N more'", async () => {
      const ctx = buildContext();
      const alerts = Array.from({ length: 22 }, (_, i) =>
        alert({ disputeId: `dispute_${i}`, deskUrl: undefined }),
      );
      vi.mocked(sweepDisputeEvidenceDeadlines).mockResolvedValueOnce({
        ...EMPTY_RESULT,
        scanned: 22,
        alerts,
      });

      await job.handler({ input: { dueWithinDays: 3 } as any, ctx: ctx as any });

      expect(fireDiscordAlert).toHaveBeenCalledTimes(1);
      const lines = vi
        .mocked(fireDiscordAlert)
        .mock.calls[0]![0].description!.split("\n");
      expect(lines).toHaveLength(DISPUTE_CHASE_MAX_ALERT_LINES + 1);
      expect(lines[DISPUTE_CHASE_MAX_ALERT_LINES]).toBe("+7 more");
      expect(lines[0]).toContain("dispute_0");
      expect(lines[14]).toContain("dispute_14");
      expect(lines.join("\n")).not.toContain("dispute_15 ");
    });

    it("swallows a Discord delivery failure — the sweep result still returns and nothing escalates", async () => {
      const ctx = buildContext();
      vi.mocked(fireDiscordAlert).mockRejectedValueOnce(new Error("webhook 500"));
      vi.mocked(sweepDisputeEvidenceDeadlines).mockResolvedValueOnce({
        ...EMPTY_RESULT,
        scanned: 1,
        alerts: [alert()],
      });

      const result = await job.handler({
        input: { dueWithinDays: 3 } as any,
        ctx: ctx as any,
      });

      // The send was attempted once and its rejection was absorbed at the
      // logAndReport boundary; the structured log line still landed.
      expect(result.alerts).toHaveLength(1);
      expect(fireDiscordAlert).toHaveBeenCalledTimes(1);
      expect(ctx.logger.log).toHaveBeenCalledWith(
        "warn",
        "disputes.chase-evidence-deadlines.attention",
        expect.objectContaining({ alerts: 1 }),
      );
      expect(ctx.logger.error).not.toHaveBeenCalled();
      expect(ctx.reportError).not.toHaveBeenCalled();
    });

    it("lets an operational sweep failure ride the job error boundary", async () => {
      const ctx = buildContext();
      vi.mocked(sweepDisputeEvidenceDeadlines).mockRejectedValueOnce(
        new Error("database unavailable"),
      );

      await expect(
        job.handler({ input: { dueWithinDays: 3 } as any, ctx: ctx as any }),
      ).rejects.toThrow("database unavailable");
      expect(fireDiscordAlert).not.toHaveBeenCalled();
    });
  });
});
