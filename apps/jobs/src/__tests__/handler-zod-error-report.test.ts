import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

/**
 * A ZodError out of the run route (`POST /jobs/:name`) has two possible
 * sources, and the route answers 400 `invalid_input` for both:
 *  - the REQUEST's input did not parse: the caller's mistake, never reported;
 *  - the HANDLER threw one (a use case ending in a raw output-schema `.parse`
 *    met one bad row): a failed run. A 400 and a warn line reach nobody, so
 *    it is reported, or a job could fail that way every night in silence.
 *
 * The wire answer and the warn line are the same for both; only the report
 * and one error-level line differ. Harness copied from
 * drain-trigger-coalescing.test.ts.
 */

const buildContainerMock = vi.fn();
const getJobMock = vi.fn();

vi.mock("../lib/container", () => ({ buildContainer: buildContainerMock }));
vi.mock("../jobs", () => ({ allJobs: [], getJob: getJobMock }));
vi.mock("../lib/discord-alerts", () => ({
  fireDiscordAlert: vi.fn(async () => undefined),
  buildCloudLoggingUrl: () => null,
}));
vi.mock("../instrument", () => ({
  Sentry: { captureException: vi.fn(() => "evt_sentry") },
}));

const DRAIN_JOB = "community.dispatch-rsvp-confirmations";
const WAKE_UP = { freshOnly: true };

/** A real ZodError, as a schema's `.parse` throws it. */
function zodError(): z.ZodError {
  const parsed = z.object({ url: z.string(), lastModified: z.string() }).safeParse({ url: 7 });
  if (parsed.success) throw new Error("expected a ZodError");
  return parsed.error;
}

function makeLogger() {
  const logger: any = {
    child: vi.fn(() => logger),
    withTime: vi.fn(async (_n: string, fn: () => Promise<unknown>) => fn()),
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  return logger;
}

async function makeApp(options: {
  name?: string;
  parse?: (value: unknown) => unknown;
  handler: (args: { input: unknown }) => Promise<unknown>;
  reportError?: (...args: unknown[]) => unknown;
}) {
  const name = options.name ?? "demo.job";
  const logger = makeLogger();
  const reportError = vi.fn(options.reportError ?? (() => "evt_1"));
  buildContainerMock.mockResolvedValue({
    logger,
    runTracker: {
      isEnabled: vi.fn(async () => true),
      setEnabled: vi.fn(async () => undefined),
      latestAll: vi.fn(async () => new Map()),
      runs: vi.fn(async () => []),
      record: vi.fn(async () => undefined),
    },
    diagnostics: null,
    env: {},
    prisma: undefined,
    reportError,
    jobTrigger: { trigger: vi.fn(async () => undefined) },
    close: vi.fn(async () => undefined),
  });
  const input = { parse: vi.fn(options.parse ?? ((value: unknown) => value ?? {})) };
  const handler = vi.fn(options.handler);
  getJobMock.mockReturnValue({
    name,
    notify: false,
    load: async () => ({ name, input, handler }),
  });
  const { createApp } = await import("../app");
  const { app } = await createApp();
  /** This route's reports only: createApp's migration-drift check shares the mock. */
  const handlerReports = () =>
    reportError.mock.calls.filter(
      ([, ctx]) => (ctx as { tags?: { phase?: string } })?.tags?.phase === "handler-zod-error",
    );
  return { app, logger, reportError, handlerReports, handler, input };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.resetModules());

describe("jobs run route: a ZodError thrown by the handler", () => {
  it("still answers 400 invalid_input, and is reported once", async () => {
    const thrown = zodError();
    const { app, logger, handlerReports } = await makeApp({
      handler: async () => {
        throw thrown;
      },
    });

    const res = await app.inject({ method: "POST", url: "/jobs/demo.job", payload: {} });

    // The wire answer is unchanged.
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body).toEqual({
      error: "invalid_input",
      runId: expect.any(String),
      details: JSON.parse(JSON.stringify(thrown.issues)),
    });
    // So is the warn line.
    expect(logger.warn).toHaveBeenCalledWith("job_invalid_input", {
      runId: body.runId,
      appCode: "INVALID_INPUT",
      errors: thrown.issues,
    });

    expect(handlerReports()).toEqual([
      [
        thrown,
        {
          tags: { area: "job-run", job: "demo.job", phase: "handler-zod-error" },
          extra: { runId: body.runId },
        },
      ],
    ]);
    // Count only at error level.
    expect(logger.error).toHaveBeenCalledWith("job_handler_schema_error", {
      runId: body.runId,
      issueCount: thrown.issues.length,
    });
  });

  it("a throwing reporter does not change the answer", async () => {
    const { app } = await makeApp({
      handler: async () => {
        throw zodError();
      },
      reportError: () => {
        throw new Error("reporter down");
      },
    });

    const res = await app.inject({ method: "POST", url: "/jobs/demo.job", payload: {} });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid_input", runId: expect.any(String) });
  });
});

describe("jobs run route: a request whose input does not parse", () => {
  it("answers the same 400, and reports nothing", async () => {
    const rejected = zodError();
    const { app, logger, handlerReports, handler } = await makeApp({
      parse: () => {
        throw rejected;
      },
      handler: async () => ({ ok: true }),
    });

    const res = await app.inject({ method: "POST", url: "/jobs/demo.job", payload: { url: 7 } });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid_input", runId: expect.any(String) });
    expect(handler).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "job_invalid_input",
      expect.objectContaining({ errors: rejected.issues }),
    );
    expect(handlerReports()).toEqual([]);
    expect(logger.error).not.toHaveBeenCalledWith("job_handler_schema_error", expect.anything());
  });

  it("the payload of a coalesced follow-up pass is input too: parsed AFTER the handler ran, still not reported", async () => {
    // A drain wake-up lands while the drain runs and is folded into a
    // follow-up pass, whose payload is parsed once the first pass returned.
    let release!: (value: unknown) => void;
    const firstPass = new Promise((resolve) => {
      release = resolve;
    });
    const rejected = zodError();
    let parses = 0;
    const { app, logger, handlerReports, handler, input } = await makeApp({
      name: DRAIN_JOB,
      parse: (value) => {
        parses += 1;
        if (parses === 2) throw rejected;
        return value ?? {};
      },
      handler: () => firstPass,
    });

    const running = app.inject({ method: "POST", url: `/jobs/${DRAIN_JOB}`, payload: WAKE_UP });
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    const coalesced = await app.inject({
      method: "POST",
      url: `/jobs/${DRAIN_JOB}`,
      payload: WAKE_UP,
    });
    expect(coalesced.json()).toEqual({ success: true, coalesced: true });
    release({ processed: 1, hasMore: false });
    const res = await running;

    // The second parse really was the follow-up pass's, after one handler run.
    expect(input.parse).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid_input" });
    expect(handlerReports()).toEqual([]);
    expect(logger.error).not.toHaveBeenCalledWith("job_handler_schema_error", expect.anything());
  });

  it("a ZodError the handler throws on a follow-up pass IS reported", async () => {
    let release!: (value: unknown) => void;
    const firstPass = new Promise((resolve) => {
      release = resolve;
    });
    const thrown = zodError();
    let runs = 0;
    const { app, handlerReports, handler } = await makeApp({
      name: DRAIN_JOB,
      handler: async () => {
        runs += 1;
        if (runs === 1) return firstPass;
        throw thrown;
      },
    });

    const running = app.inject({ method: "POST", url: `/jobs/${DRAIN_JOB}`, payload: WAKE_UP });
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    await app.inject({ method: "POST", url: `/jobs/${DRAIN_JOB}`, payload: WAKE_UP });
    release({ processed: 1, hasMore: false });
    const res = await running;

    expect(handler).toHaveBeenCalledTimes(2);
    expect(res.statusCode).toBe(400);
    expect(handlerReports()).toHaveLength(1);
    expect(handlerReports()[0]![0]).toBe(thrown);
  });
});
