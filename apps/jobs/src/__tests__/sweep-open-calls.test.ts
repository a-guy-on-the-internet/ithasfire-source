/**
 * events.sweep-open-calls (open calls v1 step 8)
 *
 * The jobs half: the handler refuses (THROWS, so the run is a non-2xx) when
 * the API's notice ledger or the mailer is missing, hands core the API-
 * namespace ledger (never the jobs one), builds the notifier over the same
 * ledger, and is registered with its hourly schedule.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeIdempotencyPort } from "@th/test-utils/fakes/idempotency";
import { createTestLogger } from "@th/test-utils/fakes/logger";

const { sweepMock, noticesMock, captured } = vi.hoisted(() => {
  const captured = {
    sweepDeps: null as Record<string, unknown> | null,
    noticeDeps: null as Record<string, unknown> | null,
  };
  const result = {
    due: 0,
    backstopRejected: 0,
    pulledExpired: 0,
    lostRace: 0,
    noticesSent: 0,
    noticesFailed: 0,
    reconcile: {},
  };
  return {
    captured,
    sweepMock: vi.fn(async (deps: Record<string, unknown>, _input?: unknown) => {
      captured.sweepDeps = deps;
      return result;
    }),
    noticesMock: vi.fn((deps: Record<string, unknown>) => {
      captured.noticeDeps = deps;
      return {
        notifyOpenCallNotThisTime: vi.fn(),
        notifyOpenCallPulled: vi.fn(),
        notifyOpenCallApplicationReceived: vi.fn(),
      };
    }),
  };
});

vi.mock("@th/core/use-cases/events/open-calls/sweep-open-calls", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@th/core/use-cases/events/open-calls/sweep-open-calls")>();
  return { ...actual, sweepOpenCalls: sweepMock };
});
vi.mock("@th/core/use-cases/events/open-calls/notify-open-call-notices", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@th/core/use-cases/events/open-calls/notify-open-call-notices")>();
  return { ...actual, makeOpenCallNotices: noticesMock };
});

const { sweepOpenCallsJob, eventJobs } = await import("../jobs/events");
const { REGISTERED_JOBS } = await import("../jobs/registry.generated");

function buildCtx(options: { ledger?: boolean; mailer?: boolean } = {}) {
  const jobsStore = createFakeIdempotencyPort({ withStatus: true });
  const apiLedger = createFakeIdempotencyPort({ withStatus: true });
  const reportError = vi.fn();
  const mailer = { send: vi.fn(), sendBatch: vi.fn(), health: vi.fn() };
  const ctx = {
    repos: {},
    logger: createTestLogger(),
    clock: { now: () => new Date("2026-10-07T12:00:00.000Z") },
    idempotency: jobsStore,
    lineupNoticeLedger: options.ledger === false ? undefined : apiLedger,
    mailer: options.mailer === false ? null : mailer,
    sms: null,
    push: null,
    appBaseUrl: "https://ithasfire.com",
    openCallStatusTokenSecret: "derived-status-token-secret-0123456789abcdef",
    reportError,
  };
  return { ctx, jobsStore, apiLedger, reportError, mailer };
}

const run = (ctx: unknown, input: unknown = {}) =>
  sweepOpenCallsJob.handler({
    input: sweepOpenCallsJob.input.parse(input),
    ctx: ctx as Parameters<typeof sweepOpenCallsJob.handler>[0]["ctx"],
  });

describe("events.sweep-open-calls", () => {
  beforeEach(() => {
    sweepMock.mockClear();
    noticesMock.mockClear();
    captured.sweepDeps = null;
    captured.noticeDeps = null;
  });

  it("runs the core sweep over the API ledger, never the jobs idempotency store", async () => {
    const { ctx, apiLedger, jobsStore, mailer } = buildCtx();
    await expect(run(ctx)).resolves.toMatchObject({ due: 0 });
    expect(captured.sweepDeps!.idempotency).toBe(apiLedger);
    expect(captured.sweepDeps!.idempotency).not.toBe(jobsStore);
    expect(captured.noticeDeps).toMatchObject({
      idempotency: apiLedger,
      mailer,
      publicAppUrl: "https://ithasfire.com",
      statusTokenSecret: "derived-status-token-secret-0123456789abcdef",
    });
    expect(typeof captured.noticeDeps!.notify).toBe("function");
    expect(captured.sweepDeps!.reportError).toBe(ctx.reportError);
  });

  it("THROWS (and reports) without the API ledger; nothing is swept", async () => {
    const { ctx, reportError } = buildCtx({ ledger: false });
    await expect(run(ctx)).rejects.toThrow(/ledger/);
    expect(sweepMock).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { job: "events.sweep-open-calls", reason: "no_ledger" } }),
    );
  });

  it("THROWS (and reports) without a mailer; nothing is swept", async () => {
    const { ctx, reportError } = buildCtx({ mailer: false });
    await expect(run(ctx)).rejects.toThrow(/mailer/);
    expect(sweepMock).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { job: "events.sweep-open-calls", reason: "no_mailer" } }),
    );
  });

  it("a systemic core failure propagates (so the run is not a 200)", async () => {
    const { ctx } = buildCtx();
    sweepMock.mockRejectedValueOnce(new Error("none settled"));
    await expect(run(ctx)).rejects.toThrow("none settled");
  });

  it("accepts the scheduler's empty body and passes a batchMax override through", async () => {
    const { ctx } = buildCtx();
    await run(ctx, {});
    expect(sweepMock.mock.calls[0]![1]).toEqual({});
    await run(ctx, { batchMax: 5 });
    expect(sweepMock.mock.calls[1]![1]).toEqual({ batchMax: 5 });
  });

  it("is registered hourly in the events module", () => {
    expect(eventJobs).toContain(sweepOpenCallsJob);
    expect(sweepOpenCallsJob.schedule).toEqual({ cron: "0 * * * *", timezone: "Etc/UTC" });
    expect(REGISTERED_JOBS.find((j) => j.name === "events.sweep-open-calls")).toMatchObject({
      module: "events",
      schedule: { cron: "0 * * * *", timezone: "Etc/UTC" },
    });
  });
});
