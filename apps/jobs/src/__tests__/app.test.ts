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

function makeJob(
  overrides: {
    handler?: (args: { input: unknown; ctx: unknown }) => Promise<unknown>;
  } = {},
) {
  return {
    name: "demo.job",
    notify: true,
    input: {
      parse: vi.fn((input: unknown) => input ?? {}),
    },
    handler: vi.fn(
      overrides.handler ??
        (async () => ({
          ok: true,
        })),
    ),
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
