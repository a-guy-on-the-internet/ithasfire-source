import { beforeEach, describe, expect, it, vi } from "vitest";

type AlertPayload = {
  title: string;
  description: string;
  fields: Array<{ name: string; value: string }>;
};

// Typed as taking an `AlertPayload` so `mock.calls[0]?.[0]` is that payload
// rather than `never` — `vi.fn(async () => undefined)` infers a zero-argument
// signature, and the cast that papers over it fails `tsc` in this app (which,
// unlike the shared base config, DOES typecheck test files).
const fireDiscordAlertMock = vi.hoisted(() =>
  vi.fn(async (_payload: unknown) => undefined),
);

vi.mock("../lib/discord-alerts", () => ({
  fireDiscordAlert: fireDiscordAlertMock,
  buildCloudLoggingUrl: (runId: string) =>
    `https://logs.example/${encodeURIComponent(runId)}`,
}));

import { reportMembershipHealthJob } from "../jobs/memberships";

/**
 * The membership health job is a thin wrapper over `reportMembershipHealth`,
 * whose counting and suppression are covered in
 * `packages/core/src/use-cases/memberships/__tests__/report-membership-health.test.ts`.
 *
 * What is covered HERE is the wiring the use case cannot see: that the job
 * obeys `shouldAlert` rather than `unhealthy`, that the Discord fields carry
 * the three counts, that a heartbeat reads differently from a new problem, and
 * that the completion line fires on every run so a quiet Discord never means a
 * silent job.
 */

const NOW = new Date("2026-09-11T06:10:00.000Z");

function makeCtx(
  options: { settingValue?: string | null; counts?: Record<string, number> } = {},
) {
  // `log(level, …)` is what `logAndAlert` calls; the named levels are what the
  // use case and this job call directly. Both are needed or the alert branch
  // throws inside the swallow that is supposed to keep it harmless.
  const logger = {
    child: () => logger,
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    withTime: vi.fn(async (_l: string, fn: () => Promise<unknown>) => fn()),
  };

  const rows = new Map<string, { key: string; value: string; updatedAt: Date; createdAt: Date }>();
  if (options.settingValue != null) {
    rows.set("memberships:healthAlertState", {
      key: "memberships:healthAlertState",
      value: options.settingValue,
      updatedAt: NOW,
      createdAt: NOW,
    });
  }

  const platformSettings = {
    get: vi.fn(async (key: string) => rows.get(key) ?? null),
    getAll: vi.fn(async () => [...rows.values()]),
    upsert: vi.fn(async (key: string, value: string) => {
      const row = { key, value, updatedAt: NOW, createdAt: NOW };
      rows.set(key, row);
      return row;
    }),
  };

  const countHealth = vi.fn(async () => ({
    paymentFailing: 0,
    stuckIncomplete: 0,
    leavingSoon: 0,
    ...(options.counts ?? {}),
  }));

  return {
    logger,
    platformSettings,
    countHealth,
    rows,
    ctx: {
      repos: { memberships: { countHealth }, platformSettings },
      clock: { now: () => NOW },
      logger,
      reportError: vi.fn(),
      runId: "run-123",
    },
  };
}

const run = async (ctx: unknown, input: Record<string, unknown> = {}) =>
  (await reportMembershipHealthJob.handler({
    input: {
      incompleteGraceHours: 24,
      leavingWithinDays: 14,
      reAlertAfterHours: 168,
      ...input,
    } as never,
    ctx: ctx as never,
  })) as Record<string, unknown>;

beforeEach(() => {
  fireDiscordAlertMock.mockClear();
});

describe("memberships.report-health", () => {
  it("is registered daily, and never on the hour", () => {
    // Every signal here is measured in DAYS. An hourly read would re-examine
    // the same rows twenty-four times to learn nothing.
    expect(reportMembershipHealthJob.name).toBe("memberships.report-health");
    // 06:30 (2026-10-08; was 06:15): on a :00/:30 slot the */30 jobs
    // already wake the database for, still off the hour.
    expect(reportMembershipHealthJob.schedule?.cron).toBe("30 6 * * *");
  });

  it("sends NOTHING and still logs completion on a healthy run", async () => {
    const { ctx, logger } = makeCtx();
    const result = await run(ctx);

    expect(result).toMatchObject({ unhealthy: false, shouldAlert: false });
    expect(fireDiscordAlertMock).not.toHaveBeenCalled();
    // The daily read must stay visible in logs even while Discord is quiet.
    expect(logger.info).toHaveBeenCalledWith(
      "memberships.report-health.completed",
      expect.objectContaining({ unhealthy: false }),
    );
  });

  it("alerts with all three counts, and a logs link, on a new problem", async () => {
    const { ctx } = makeCtx({
      counts: { paymentFailing: 4, stuckIncomplete: 2, leavingSoon: 1 },
    });
    await run(ctx);

    expect(fireDiscordAlertMock).toHaveBeenCalledOnce();
    const payload = fireDiscordAlertMock.mock.calls[0]?.[0] as AlertPayload;

    expect(payload.title).toBe("Memberships need attention");
    const byName = new Map(payload.fields.map((f) => [f.name, f.value]));
    expect(byName.get("Card failing")).toBe("4");
    expect(byName.get("Signup stuck")).toBe("2");
    expect(byName.get("Leaving soon")).toBe("1");
    expect(byName.get("Logs")).toBe("https://logs.example/run-123");
    // The consequence, not just the status.
    expect(payload.description).toMatch(/ALREADY DENIED/);
  });

  it("obeys shouldAlert, not unhealthy — a suppressed run stays silent", async () => {
    // Yesterday's alert for the same picture is still inside the week-long
    // window. Without this the job would post the identical message daily
    // forever, which is how an alerting channel stops being read.
    const { ctx, logger } = makeCtx({
      counts: { paymentFailing: 4 },
      settingValue: JSON.stringify({
        fingerprint: "paymentFailing",
        sentAt: "2026-09-10T06:10:00.000Z",
      }),
    });

    const result = await run(ctx);

    expect(result).toMatchObject({
      unhealthy: true,
      shouldAlert: false,
      alertReason: "suppressed",
    });
    expect(fireDiscordAlertMock).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      "memberships.report-health.completed",
      expect.objectContaining({ unhealthy: true, shouldAlert: false }),
    );
  });

  it("marks a HEARTBEAT as a reminder, not as news", async () => {
    const { ctx } = makeCtx({
      counts: { paymentFailing: 4 },
      settingValue: JSON.stringify({
        fingerprint: "paymentFailing",
        sentAt: "2026-09-01T06:10:00.000Z",
      }),
    });

    const result = await run(ctx);

    expect(result).toMatchObject({ alertReason: "heartbeat" });
    const payload = fireDiscordAlertMock.mock.calls[0]?.[0] as AlertPayload;
    expect(payload.title).toBe("Memberships — still unresolved");
    expect(payload.description).toMatch(/not a new problem/);
  });

  it("an unreachable Discord never fails the health check", async () => {
    // `logAndAlert` holds a sender that swallows its own failures; the job
    // must not turn an alerting outage into a failed run.
    fireDiscordAlertMock.mockRejectedValueOnce(new Error("discord is down"));
    const { ctx } = makeCtx({ counts: { paymentFailing: 1 } });

    await expect(run(ctx)).resolves.toMatchObject({ shouldAlert: true });
  });

  it("reads the membership health state row, not moderation's", async () => {
    const { ctx, platformSettings } = makeCtx({
      counts: { leavingSoon: 3 },
    });
    await run(ctx);
    expect(platformSettings.get).toHaveBeenCalledWith(
      "memberships:healthAlertState",
    );
    expect(platformSettings.upsert.mock.calls[0]?.[0]).toBe(
      "memberships:healthAlertState",
    );
  });
});
