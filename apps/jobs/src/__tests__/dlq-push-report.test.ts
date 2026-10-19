import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A failed DLQ push in the run route is a deliberate swallow: the real job
 * failure must still be handled. apps/jobs has no Sentry pino integration, so
 * the swallow must call reportError (CLAUDE.md) or a broken DLQ loses failed
 * jobs silently. Harness copied from migration-drift.test.ts.
 */

const buildContainerMock = vi.fn();
const getJobMock = vi.fn();
const reportErrorMock = vi.fn((_err: unknown, _ctx?: unknown) => "evt_1");

vi.mock("../lib/container", () => ({ buildContainer: buildContainerMock }));
vi.mock("../jobs", () => ({ allJobs: [], getJob: getJobMock }));
vi.mock("../lib/discord-alerts", () => ({
  fireDiscordAlert: vi.fn(async () => undefined),
  buildCloudLoggingUrl: () => null,
}));
vi.mock("../instrument", () => ({
  Sentry: { captureException: vi.fn(() => "evt_sentry") },
}));

function makeLogger() {
  const logger: any = {
    child: vi.fn(() => logger),
    withTime: vi.fn(async (_n: string, fn: () => Promise<unknown>) => await fn()),
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  return logger;
}

function makeFailingJob() {
  const input = { parse: vi.fn((value: unknown) => value ?? {}) };
  const handler = vi.fn(async () => {
    throw new Error("job blew up");
  });
  return {
    name: "demo.job",
    notify: false,
    input,
    handler,
    load: vi.fn(async () => ({ name: "demo.job", input, handler })),
  };
}

function makeSucceedingJob() {
  const input = { parse: vi.fn((value: unknown) => value ?? {}) };
  const handler = vi.fn(async () => ({ ok: true }));
  return {
    name: "demo.job",
    notify: false,
    input,
    handler,
    load: vi.fn(async () => ({ name: "demo.job", input, handler })),
  };
}

async function makeApp(
  pushToDLQ: () => Promise<void>,
  options: { record?: () => Promise<void>; jobSucceeds?: boolean } = {},
) {
  const logger = makeLogger();
  const dlq = { pushToDLQ: vi.fn(pushToDLQ) };
  delete process.env.K_SERVICE;
  buildContainerMock.mockResolvedValue({
    logger,
    runTracker: {
      isEnabled: vi.fn(async () => true),
      setEnabled: vi.fn(async () => undefined),
      latestAll: vi.fn(async () => new Map()),
      pruneRuns: vi.fn(async () => 0),
      runs: vi.fn(async () => []),
      record: vi.fn(options.record ?? (async () => undefined)),
    },
    diagnostics: dlq,
    env: {},
    prisma: undefined,
    reportError: reportErrorMock,
    close: vi.fn(async () => undefined),
  });
  getJobMock.mockReturnValue(options.jobSucceeds ? makeSucceedingJob() : makeFailingJob());
  const { createApp } = await import("../app");
  const { app } = await createApp();
  return { app, logger, dlq };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.resetModules();
  reportErrorMock.mockImplementation(() => "evt_1");
});

/** An ioredis-shaped error: the client attaches the command arguments. */
function redisErrorWithArgs(message: string) {
  return Object.assign(new Error(message), {
    command: { name: "zadd", args: ["th:jobs:dlq:demo.job", 1, '{"secret":"s3cr3t"}'] },
    previousErrors: [new Error('ERR {"secret":"s3cr3t"}')],
  });
}

function loggedText(logger: { error: { mock: { calls: unknown[][] } } }): string {
  return JSON.stringify(logger.error.mock.calls, (_k, v) =>
    v instanceof Error ? { ...v, message: v.message, stack: v.stack } : v,
  );
}

describe("jobs run route: DLQ push failure", () => {
  it("reports the DLQ error and still answers with the job's own failure", async () => {
    const dlqErr = new Error("redis dlq push aborted (keyHash=0123456789ab)");
    const { app, logger, dlq } = await makeApp(async () => {
      throw dlqErr;
    });

    const res = await app.inject({ method: "POST", url: "/jobs/demo.job", payload: {} });

    expect(dlq.pushToDLQ).toHaveBeenCalledTimes(1);
    expect(reportErrorMock).toHaveBeenCalledWith(
      dlqErr,
      expect.objectContaining({
        tags: { area: "job-dlq", job: "demo.job", phase: "push" },
        extra: { runId: expect.any(String) },
      }),
    );
    expect(logger.error).toHaveBeenCalledWith(
      "dlq_push_failed",
      expect.objectContaining({ error: { name: "Error", message: dlqErr.message } }),
    );
    // The DLQ error never replaces the real one.
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.body).not.toContain("dlq push");
  });

  it("a throwing reporter does not change the outcome", async () => {
    const baseline = await makeApp(async () => undefined);
    const ok = await baseline.app.inject({ method: "POST", url: "/jobs/demo.job", payload: {} });
    vi.resetModules();

    reportErrorMock.mockImplementation(() => {
      throw new Error("reporter down");
    });
    const { app } = await makeApp(async () => {
      throw new Error("dlq down");
    });
    const res = await app.inject({ method: "POST", url: "/jobs/demo.job", payload: {} });

    expect(res.statusCode).toBe(ok.statusCode);
  });

  it("logs only the error's name and message, never ioredis command args", async () => {
    const { app, logger } = await makeApp(async () => {
      throw redisErrorWithArgs("EXECABORT Transaction discarded");
    });
    await app.inject({ method: "POST", url: "/jobs/demo.job", payload: {} });

    expect(logger.error).toHaveBeenCalledWith(
      "dlq_push_failed",
      expect.objectContaining({
        error: { name: "Error", message: "EXECABORT Transaction discarded" },
      }),
    );
    expect(loggedText(logger)).not.toContain("s3cr3t");
  });

  it("does not report when the DLQ push succeeds", async () => {
    const { app, dlq } = await makeApp(async () => undefined);
    await app.inject({ method: "POST", url: "/jobs/demo.job", payload: {} });

    expect(dlq.pushToDLQ).toHaveBeenCalledTimes(1);
    expect(reportErrorMock).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tags: expect.objectContaining({ area: "job-dlq" }) }),
    );
  });
});

describe("jobs run route: run-tracker record failure", () => {
  it("success path: reports, logs safely, and still answers 200", async () => {
    const recordErr = redisErrorWithArgs("OOM command not allowed");
    const { app, logger } = await makeApp(async () => undefined, {
      jobSucceeds: true,
      record: async () => {
        throw recordErr;
      },
    });

    const res = await app.inject({ method: "POST", url: "/jobs/demo.job", payload: {} });

    expect(res.statusCode).toBe(200);
    expect(reportErrorMock).toHaveBeenCalledWith(
      recordErr,
      expect.objectContaining({
        tags: { area: "job-run-tracker", job: "demo.job", phase: "success" },
      }),
    );
    expect(loggedText(logger)).not.toContain("s3cr3t");
  });

  it("error path: reports and still pushes the job to the DLQ", async () => {
    const recordErr = new Error("redis job run record aborted (keyHash=abc)");
    const { app, dlq } = await makeApp(async () => undefined, {
      record: async () => {
        throw recordErr;
      },
    });

    const res = await app.inject({ method: "POST", url: "/jobs/demo.job", payload: {} });

    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(dlq.pushToDLQ).toHaveBeenCalledTimes(1);
    expect(reportErrorMock).toHaveBeenCalledWith(
      recordErr,
      expect.objectContaining({
        tags: { area: "job-run-tracker", job: "demo.job", phase: "error" },
      }),
    );
  });
});
