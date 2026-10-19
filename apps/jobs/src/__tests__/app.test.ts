import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";

const buildContainerMock = vi.fn();
const getJobMock = vi.fn();
const fireDiscordAlertMock = vi.fn(
  async (_opts: { title?: string; description?: string }) => undefined,
);
const captureExceptionMock = vi.fn((_err: unknown, _ctx?: unknown) => "evt_1");

vi.mock("../lib/container", () => ({
  buildContainer: buildContainerMock,
}));

vi.mock("../jobs", () => ({
  allJobs: [],
  getJob: getJobMock,
}));

vi.mock("../lib/discord-alerts", () => ({
  fireDiscordAlert: fireDiscordAlertMock,
  // Mirror the real helper's null-safe contract: a real URL when a GCP project
  // is configured (deployed envs), null in local/unit-test so callers omit the
  // link. Driven off process.env.GCP_PROJECT_ID like the real implementation.
  buildCloudLoggingUrl: (runId: string) =>
    process.env.GCP_PROJECT_ID
      ? `https://console.cloud.google.com/logs/query;query=runId%3D${runId}?project=${process.env.GCP_PROJECT_ID}`
      : null,
}));

vi.mock("../instrument", () => ({
  Sentry: { captureException: captureExceptionMock },
}));

function makeLogger() {
  const logger = {
    child: vi.fn(() => logger),
    withTime: vi.fn(
      async (_name: string, fn: () => Promise<unknown>) => await fn(),
    ),
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  return logger;
}

function makeTracker() {
  return {
    isEnabled: vi.fn(async () => true),
    setEnabled: vi.fn(async () => undefined),
    latestAll: vi.fn(async () => new Map()),
    pruneRuns: vi.fn(async () => 0),
    runs: vi.fn(async () => []),
    record: vi.fn(async () => undefined),
  };
}

/**
 * A registry HANDLE, which is what `getJob` returns: eager metadata plus a
 * `load()` that imports the handler module on dispatch. `input` and `handler`
 * are also exposed on the handle purely so tests can reach the spies — the
 * app only ever sees them through `load()`.
 */
function makeJob(
  overrides: {
    handler?: (args: { input: unknown; ctx: unknown }) => Promise<unknown>;
    /** Make the handler module fail to import. */
    load?: () => Promise<unknown>;
  } = {},
) {
  const input = { parse: vi.fn((value: unknown) => value ?? {}) };
  const handler = vi.fn(
    overrides.handler ??
      (async () => ({
        ok: true,
      })),
  );

  return {
    name: "demo.job",
    notify: true,
    input,
    handler,
    load: vi.fn(overrides.load ?? (async () => ({ name: "demo.job", input, handler }))),
  };
}

async function makeApp(job = makeJob()) {
  const logger = makeLogger();
  const tracker = makeTracker();
  const close = vi.fn(async () => undefined);

  buildContainerMock.mockResolvedValue({
    logger,
    runTracker: tracker,
    diagnostics: null,
    env: {},
    close,
  });
  getJobMock.mockReturnValue(job);

  const { createApp } = await import("../app");
  const { app } = await createApp();

  return { app, close, job, logger, tracker };
}

describe("jobs app lifecycle observability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default to the local/unit-test posture: no GCP project → no logs link.
    delete process.env.GCP_PROJECT_ID;
  });

  afterEach(async () => {
    vi.resetModules();
    delete process.env.GCP_PROJECT_ID;
  });

  it("uses the shared helper path for notify-on-start and notify-on-success", async () => {
    const { app, logger, tracker } = await makeApp();

    const response = await app.inject({
      method: "POST",
      url: "/jobs/demo.job",
      payload: { hello: "world" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ success: true });
    expect(fireDiscordAlertMock).toHaveBeenCalledTimes(2);
    expect(logger.log).toHaveBeenNthCalledWith(
      1,
      "info",
      "job_start",
      expect.objectContaining({ payload: { hello: "world" } }),
    );
    expect(logger.log).toHaveBeenNthCalledWith(
      2,
      "info",
      "job_complete",
      expect.objectContaining({ result: { ok: true } }),
    );
    expect(logger.info).not.toHaveBeenCalledWith(
      "job_start",
      expect.anything(),
    );
    expect(logger.info).not.toHaveBeenCalledWith(
      "job_complete",
      expect.anything(),
    );
    expect(tracker.record).toHaveBeenCalledWith(
      expect.objectContaining({ status: "success", jobName: "demo.job" }),
    );

    await app.close();
  });

  it("uses the shared helper path for notify-on-failure and keeps Discord copy generic", async () => {
    const { app, logger, tracker } = await makeApp(
      makeJob({
        handler: async () => {
          throw new Error("database unavailable");
        },
      }),
    );

    const response = await app.inject({
      method: "POST",
      url: "/jobs/demo.job",
      payload: { hello: "world" },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ error: "internal_error" });
    expect(fireDiscordAlertMock).toHaveBeenCalledTimes(2);
    const failureAlert = vi.mocked(fireDiscordAlertMock).mock.lastCall?.[0];
    expect(fireDiscordAlertMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        title: "[local] Job failed: demo.job",
        description:
          "A background job failed. Check structured logs for run details.",
      }),
    );
    expect(failureAlert?.description ?? "").not.toContain(
      "database unavailable",
    );
    expect(logger.log).toHaveBeenNthCalledWith(
      2,
      "error",
      "job_failed",
      expect.objectContaining({ errorMessage: "database unavailable" }),
    );
    expect(tracker.record).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "error",
        errorMessage: "database unavailable",
      }),
    );

    await app.close();
  });

  it("captures a handler throw to Sentry with job/runId tags", async () => {
    const { app } = await makeApp(
      makeJob({
        handler: async () => {
          throw new Error("database unavailable");
        },
      }),
    );

    const response = await app.inject({
      method: "POST",
      url: "/jobs/demo.job",
      payload: { hello: "world" },
    });

    expect(response.statusCode).toBe(500);
    // A genuine unhandled job error is always incident-worthy — captured
    // regardless of `job.notify`.
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [capturedError, capturedCtx] = captureExceptionMock.mock.calls[0]!;
    expect(capturedError).toBeInstanceOf(Error);
    expect((capturedError as Error).message).toBe("database unavailable");
    expect(capturedCtx).toMatchObject({
      tags: expect.objectContaining({ job: "demo.job" }),
    });
    expect((capturedCtx as { tags: { runId?: string } }).tags.runId).toEqual(
      expect.any(String),
    );

    await app.close();
  });

  it("attaches a Cloud Logging deep-link to the Sentry issue and the failed Discord alert when a GCP project is configured", async () => {
    process.env.GCP_PROJECT_ID = "hearth-fire-dev";

    const { app } = await makeApp(
      makeJob({
        handler: async () => {
          throw new Error("database unavailable");
        },
      }),
    );

    const response = await app.inject({
      method: "POST",
      url: "/jobs/demo.job",
      payload: { hello: "world" },
    });

    expect(response.statusCode).toBe(500);

    // Sentry issue carries the run-scoped log deep-link.
    const [, capturedCtx] = captureExceptionMock.mock.calls[0]!;
    const logsUrl = (capturedCtx as { extra: { logsUrl?: string } }).extra
      .logsUrl;
    expect(logsUrl).toEqual(expect.stringContaining("console.cloud.google.com"));
    expect(logsUrl).toEqual(expect.stringContaining("hearth-fire-dev"));

    // Failed Discord alert carries a "Logs" field with a clickable markdown link.
    const failureAlert = vi.mocked(fireDiscordAlertMock).mock.lastCall?.[0] as
      | { fields?: Array<{ name: string; value: string }> }
      | undefined;
    const logsField = failureAlert?.fields?.find((f) => f.name === "Logs");
    expect(logsField).toBeDefined();
    expect(logsField?.value).toMatch(/^\[View logs\]\(https:\/\//);

    await app.close();
  });

  it("omits the Cloud Logging link when no GCP project is configured (local/test)", async () => {
    const { app } = await makeApp(
      makeJob({
        handler: async () => {
          throw new Error("database unavailable");
        },
      }),
    );

    const response = await app.inject({
      method: "POST",
      url: "/jobs/demo.job",
      payload: { hello: "world" },
    });

    expect(response.statusCode).toBe(500);

    const [, capturedCtx] = captureExceptionMock.mock.calls[0]!;
    expect(
      (capturedCtx as { extra: { logsUrl?: string } }).extra.logsUrl,
    ).toBeUndefined();

    const failureAlert = vi.mocked(fireDiscordAlertMock).mock.lastCall?.[0] as
      | { fields?: Array<{ name: string }> }
      | undefined;
    expect(failureAlert?.fields?.some((f) => f.name === "Logs")).toBe(false);

    await app.close();
  });

  it("fails only that job — 503 + typed code — when its handler module will not import", async () => {
    const { AppError } = await import("@th/errors");
    const cause = new Error("Cannot find module './settlements'");
    const job = makeJob({
      load: async () => {
        throw new AppError("JOB_MODULE_LOAD_FAILED", {
          message: 'Job "demo.job" could not run: its handler module "demo" failed to import.',
          meta: { job: "demo.job", module: "demo" },
          cause,
        });
      },
    });

    const { app, tracker } = await makeApp(job);

    const response = await app.inject({
      method: "POST",
      url: "/jobs/demo.job",
      payload: {},
    });

    // 503, not 400: the request is well-formed and the caller is blameless —
    // the SERVER cannot service it. Same code as the migration-drift 503, and
    // distinguishable from a 400 in Cloud Scheduler's job status. It buys no
    // retry (the generated schedulers set retryCount = 0); `Retry-After` is
    // parity with the drift 503 for any caller that does honour it.
    expect(response.statusCode).toBe(503);
    expect(response.headers["retry-after"]).toBe("60");
    expect(response.json()).toMatchObject({ error: "JOB_MODULE_LOAD_FAILED" });

    // The handler was never reached, but the run was still recorded and the
    // failure still reported — it is an incident, not a silent no-op.
    expect(job.handler).not.toHaveBeenCalled();
    expect(tracker.record).toHaveBeenCalledWith(
      expect.objectContaining({ jobName: "demo.job", status: "error" }),
    );
    expect(captureExceptionMock).toHaveBeenCalled();

    // The service is still up and the registry is intact: another request
    // still routes.
    const stillAlive = await app.inject({ method: "GET", url: "/health" });
    expect(stillAlive.statusCode).toBe(200);

    await app.close();
  });

  it("captures a repeating module-load failure ONCE per process, but logs every tick", async () => {
    // A module that will not import is usually a PERMANENT fault, and the
    // registry no longer crashes the service at boot over it — so the owning
    // job just keeps failing on its cron. Without a latch, a job on a
    // two-minute cron would file ~720 Sentry events a day for one unchanging
    // fault. Mirrors the `driftReported` latch in the same file.
    const { AppError } = await import("@th/errors");
    const job = makeJob({
      load: async () => {
        throw new AppError("JOB_MODULE_LOAD_FAILED", {
          message: "boom",
          meta: { job: "demo.job", module: "moderation" },
        });
      },
    });

    const { app, logger, tracker } = await makeApp(job);

    for (let tick = 0; tick < 5; tick++) {
      const response = await app.inject({
        method: "POST",
        url: "/jobs/demo.job",
        payload: {},
      });
      expect(response.statusCode).toBe(503);
    }

    // ONE Sentry event for five ticks.
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);

    // Every tick still logs and still records a run — the fault stays visible
    // in Cloud Logging and in run history, it just stops paging.
    // `logAndReport` logs via `logger.log(level, message, extra)`.
    const errorLogs = logger.log.mock.calls
      .filter(([, message]) => message === "job_error")
      .map(([, , extra]) => ["job_error", extra] as const);
    expect(errorLogs).toHaveLength(5);
    expect(tracker.record).toHaveBeenCalledTimes(5);

    // The suppressed ticks say so, so a reader is not left wondering why
    // Sentry has one event and Cloud Logging has five lines.
    expect(errorLogs[0]![1]).not.toMatchObject({ captureSuppressed: true });
    for (const [, extra] of errorLogs.slice(1)) {
      expect(extra).toMatchObject({ captureSuppressed: true });
    }

    await app.close();
  });

  it("latches the capture per MODULE, so a second broken module still reports", async () => {
    const { AppError } = await import("@th/errors");
    const failing = (module: string) => async () => {
      throw new AppError("JOB_MODULE_LOAD_FAILED", {
        message: "boom",
        meta: { job: "demo.job", module },
      });
    };

    const job = makeJob({ load: failing("moderation") });
    const { app } = await makeApp(job);

    await app.inject({ method: "POST", url: "/jobs/demo.job", payload: {} });
    await app.inject({ method: "POST", url: "/jobs/demo.job", payload: {} });
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);

    // A DIFFERENT broken module is a different fault and must not be masked by
    // the first one's latch.
    job.load.mockImplementation(failing("settlements"));
    await app.inject({ method: "POST", url: "/jobs/demo.job", payload: {} });
    expect(captureExceptionMock).toHaveBeenCalledTimes(2);

    await app.close();
  });

  it("does NOT capture a ZodError (invalid input, not an incident)", async () => {
    const job = makeJob();
    // Force input validation to fail with a ZodError.
    job.input.parse = vi.fn(() => {
      throw new ZodError([]);
    });

    const { app } = await makeApp(job);

    const response = await app.inject({
      method: "POST",
      url: "/jobs/demo.job",
      payload: { hello: "world" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "invalid_input" });
    expect(captureExceptionMock).not.toHaveBeenCalled();

    await app.close();
  });
});

/**
 * `lineup-notices.continue-sweep` refuses to run without the API's ledger or
 * without a mailer, and a refusal is only useful if Cloud Tasks RETRIES it.
 * That depends entirely on the HTTP status, which no handler-level test can
 * see: app.ts answers `{ success: true, result }` with a 200 for ANY value a
 * handler returns, so a refusal that returns `{ success: false }` is read as
 * delivered, the hop is consumed, and the chain ends with nothing queued.
 * These two drive the real handler through the real route for the status code.
 */
describe("a job that refuses by throwing answers non-2xx (Cloud Tasks retries)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.GCP_PROJECT_ID;
  });

  afterEach(async () => {
    vi.resetModules();
  });

  async function makeLineupSweepApp(ctxOverrides: Record<string, unknown>) {
    const { continueLineupNoticeSweepJob } = await import(
      "../jobs/lineup-notices"
    );
    // The registry handle shape, with the REAL input schema and handler.
    const job = {
      name: continueLineupNoticeSweepJob.name,
      notify: true,
      input: continueLineupNoticeSweepJob.input,
      handler: continueLineupNoticeSweepJob.handler,
      load: vi.fn(async () => continueLineupNoticeSweepJob),
    };
    const logger = makeLogger();
    const reportError = vi.fn();

    buildContainerMock.mockResolvedValue({
      logger,
      runTracker: makeTracker(),
      diagnostics: null,
      env: {},
      close: vi.fn(async () => undefined),
      reportError,
      ...ctxOverrides,
    });
    getJobMock.mockReturnValue(job);

    const { createApp } = await import("../app");
    const { app } = await createApp();
    // createApp's migration-drift probe reports once here: this container has
    // no prisma, which is an INDETERMINATE outcome (reported, resolves
    // healthy). Clear it so the assertions below see only the handler's own
    // report.
    reportError.mockClear();
    return { app, reportError, jobName: job.name };
  }

  it("500s with no lineupNoticeLedger, instead of a 200 that ends the chain", async () => {
    const { app, reportError, jobName } = await makeLineupSweepApp({
      // Absent on purpose. mailer is irrelevant: the ledger is checked first.
      mailer: { send: vi.fn() },
    });

    const response = await app.inject({
      method: "POST",
      url: `/jobs/${jobName}`,
      payload: { eventId: "11111111-1111-4111-8111-111111111111", attempt: 1 },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ error: "internal_error" });
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]![1]).toMatchObject({
      tags: { job: "lineup-notices.continue-sweep", reason: "no_ledger" },
    });

    await app.close();
  });

  it("500s with no mailer, instead of a 200 that would commit in-app-only notices for 10 years", async () => {
    const { app, reportError, jobName } = await makeLineupSweepApp({
      lineupNoticeLedger: {
        begin: vi.fn(),
        commit: vi.fn(),
        get: vi.fn(),
      },
      mailer: null,
    });

    const response = await app.inject({
      method: "POST",
      url: `/jobs/${jobName}`,
      payload: { eventId: "11111111-1111-4111-8111-111111111111", attempt: 1 },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ error: "internal_error" });
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]![1]).toMatchObject({
      tags: { job: "lineup-notices.continue-sweep", reason: "no_mailer" },
    });

    await app.close();
  });
});
