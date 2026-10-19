import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Write-triggered drains through the real `POST /jobs/:name` route:
 * wake-ups that land while the drain is running are acked and folded into one
 * follow-up pass; a run that stops on its budget (`hasMore`) wakes itself
 * again; the flight is released on failure so the next wake-up still runs.
 */

const buildContainerMock = vi.fn();
const getJobMock = vi.fn();
const captureExceptionMock = vi.fn();

vi.mock("../lib/container", () => ({ buildContainer: buildContainerMock }));
vi.mock("../jobs", () => ({ allJobs: [], getJob: getJobMock }));
vi.mock("../lib/discord-alerts", () => ({
  fireDiscordAlert: vi.fn(async () => undefined),
  buildCloudLoggingUrl: () => null,
}));
vi.mock("../instrument", () => ({
  Sentry: { captureException: captureExceptionMock },
}));

const JOB = "community.dispatch-rsvp-confirmations";
const WAKE_UP = { freshOnly: true };

function makeLogger() {
  const logger = {
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

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function makeApp(
  handler: (args: { input: unknown }) => Promise<unknown>,
  opts: { trigger?: ReturnType<typeof vi.fn> | null; job?: string } = {},
) {
  const jobName = opts.job ?? JOB;
  const tracker = {
    isEnabled: vi.fn(async () => true),
    setEnabled: vi.fn(),
    latestAll: vi.fn(async () => new Map()),
    runs: vi.fn(async () => []),
    record: vi.fn(async () => undefined),
  };
  const reportError = vi.fn();
  const trigger = opts.trigger === undefined ? vi.fn(async () => undefined) : opts.trigger;
  buildContainerMock.mockResolvedValue({
    logger: makeLogger(),
    runTracker: tracker,
    diagnostics: null,
    env: {},
    close: vi.fn(async () => undefined),
    reportError,
    jobTrigger: trigger ? { trigger } : null,
  });
  const handlerSpy = vi.fn(handler);
  const input = { parse: vi.fn((v: unknown) => v ?? {}) };
  getJobMock.mockReturnValue({
    name: jobName,
    notify: false,
    load: async () => ({ name: jobName, input, handler: handlerSpy }),
  });
  const { createApp } = await import("../app");
  const { app } = await createApp();
  return { app, tracker, reportError, trigger, handler: handlerSpy };
}

/** Let the in-flight request reach its handler. */
async function settle() {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

describe("write-triggered drain coalescing", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.resetModules());

  it("acks a wake-up that lands mid-run and folds it into ONE follow-up pass", async () => {
    const first = deferred<unknown>();
    let call = 0;
    const { app, tracker, handler } = await makeApp(async () => {
      call += 1;
      if (call === 1) return first.promise;
      return { processed: 1, hasMore: false };
    });

    const running = app.inject({ method: "POST", url: `/jobs/${JOB}`, payload: WAKE_UP });
    await settle();
    expect(handler).toHaveBeenCalledTimes(1);

    // Three wake-ups while the first run is still draining.
    const coalesced = await Promise.all(
      [0, 1, 2].map(() =>
        app.inject({ method: "POST", url: `/jobs/${JOB}`, payload: WAKE_UP }),
      ),
    );
    for (const res of coalesced) {
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true, coalesced: true });
    }
    // A coalesced wake-up costs no database round trip.
    expect(tracker.isEnabled).toHaveBeenCalledTimes(1);

    first.resolve({ processed: 0, hasMore: false });
    const res = await running;
    expect(res.statusCode).toBe(200);
    // Initial run + exactly one follow-up, with the wake-up payload.
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[1]![0]).toMatchObject({ input: WAKE_UP });
    expect(res.json().result).toMatchObject({ coalescedReruns: 1 });
    expect(tracker.record).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("a BURST of wake-ups arriving together runs the drain once plus one follow-up, not once each", async () => {
    // Regression: the flight used to be registered after the awaited enabled
    // read, so simultaneous wake-ups all slipped past the check (seen live:
    // 5 concurrent wake-ups → 5 runs).
    const { app, handler, tracker } = await makeApp(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return { processed: 0, hasMore: false };
    });

    const responses = await Promise.all(
      [0, 1, 2, 3, 4].map(() =>
        app.inject({ method: "POST", url: `/jobs/${JOB}`, payload: WAKE_UP }),
      ),
    );

    const coalesced = responses.filter((r) => r.json().coalesced === true);
    expect(coalesced).toHaveLength(4);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(tracker.isEnabled).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("releases the flight when the enabled read itself throws (outside the run's try)", async () => {
    const { app, tracker, handler } = await makeApp(async () => ({ hasMore: false }));
    tracker.isEnabled.mockRejectedValueOnce(new Error("db unreachable"));

    const failed = await app.inject({ method: "POST", url: `/jobs/${JOB}`, payload: WAKE_UP });
    expect(failed.statusCode).toBe(500);

    const next = await app.inject({ method: "POST", url: `/jobs/${JOB}`, payload: WAKE_UP });
    expect(next.json()).not.toHaveProperty("coalesced");
    expect(handler).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("does NOT coalesce a scheduled run (different body) — the safety net must retry", async () => {
    const first = deferred<unknown>();
    let call = 0;
    const { app, handler } = await makeApp(async () => {
      call += 1;
      return call === 1 ? first.promise : { hasMore: false };
    });

    const running = app.inject({ method: "POST", url: `/jobs/${JOB}`, payload: WAKE_UP });
    await settle();
    const scheduled = await app.inject({ method: "POST", url: `/jobs/${JOB}`, payload: {} });
    expect(scheduled.json()).not.toHaveProperty("coalesced");
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[1]![0]).toMatchObject({ input: {} });

    first.resolve({ hasMore: false });
    await running;
    await app.close();
  });

  it.each([
    ["application/octet-stream"],
    ["application/x-pubsub"],
    [undefined],
  ])(
    "accepts an unwrapped Pub/Sub push with content-type %s (no 415 before the handler)",
    async (contentType) => {
      const { app, handler } = await makeApp(async () => ({ hasMore: false }));
      const res = await app.inject({
        method: "POST",
        url: `/jobs/${JOB}`,
        headers: contentType ? { "content-type": contentType } : {},
        payload: Buffer.from(JSON.stringify(WAKE_UP)),
      });
      expect(res.statusCode).toBe(200);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ input: WAKE_UP }),
      );
      await app.close();
    },
  );

  it("reads an empty non-JSON-typed body as {} and rejects garbage with 400", async () => {
    const { app, handler } = await makeApp(async () => ({ hasMore: false }));
    const empty = await app.inject({
      method: "POST",
      url: `/jobs/${JOB}`,
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.alloc(0),
    });
    expect(empty.statusCode).toBe(200);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ input: {} }));

    const garbage = await app.inject({
      method: "POST",
      url: `/jobs/${JOB}`,
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from("not json"),
    });
    expect(garbage.statusCode).toBe(400);

    // Fastify's own JSON parser is in the path: prototype poisoning is refused.
    const poisoned = await app.inject({
      method: "POST",
      url: `/jobs/${JOB}`,
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from('{"__proto__":{"polluted":true}}'),
    });
    expect(poisoned.statusCode).toBe(400);
    await app.close();
  });

  it("a scheduled run that absorbs a wake-up does NOT lengthen itself — it hands the wake-up to a fresh request", async () => {
    const first = deferred<unknown>();
    const { app, handler, trigger } = await makeApp(async () => first.promise);

    const scheduled = app.inject({ method: "POST", url: `/jobs/${JOB}`, payload: {} });
    await settle();
    const woken = await app.inject({ method: "POST", url: `/jobs/${JOB}`, payload: WAKE_UP });
    expect(woken.json()).toEqual({ success: true, coalesced: true });

    first.resolve({ hasMore: false });
    await scheduled;
    expect(handler).toHaveBeenCalledTimes(1);
    expect(trigger).toHaveBeenCalledWith(JOB);
    await app.close();
  });

  it("image moderation: the scheduled run ({origin:'schedule'}) is NOT a wake-up even though the wake-up body is {}", async () => {
    const MOD = "moderation.drain-image-moderations";
    const first = deferred<unknown>();
    const { app, handler, trigger } = await makeApp(async () => first.promise, {
      job: MOD,
    });

    // Scheduled safety-net run (manifest payload) in flight...
    const scheduled = app.inject({
      method: "POST",
      url: `/jobs/${MOD}`,
      payload: { origin: "schedule" },
    });
    await settle();
    // ...a wake-up ({}) arrives: it coalesces into the scheduled flight.
    const woken = await app.inject({ method: "POST", url: `/jobs/${MOD}`, payload: {} });
    expect(woken.json()).toEqual({ success: true, coalesced: true });

    first.resolve({ hasMore: false });
    await scheduled;
    // The scheduled request did NOT run a follow-up itself (it must stay one
    // pass-loop long for Cloud Scheduler's deadline); it handed the wake-up on.
    expect(handler).toHaveBeenCalledTimes(1);
    expect(trigger).toHaveBeenCalledWith(MOD);
    await app.close();
  });

  it("image moderation: a scheduled run arriving during a wake-up run is not swallowed as a coalesced wake-up", async () => {
    const MOD = "moderation.drain-image-moderations";
    const first = deferred<unknown>();
    let call = 0;
    const { app, handler } = await makeApp(
      async () => {
        call += 1;
        return call === 1 ? first.promise : { hasMore: false };
      },
      { job: MOD },
    );

    const woken = app.inject({ method: "POST", url: `/jobs/${MOD}`, payload: {} });
    await settle();
    const scheduled = await app.inject({
      method: "POST",
      url: `/jobs/${MOD}`,
      payload: { origin: "schedule" },
    });
    expect(scheduled.json()).not.toHaveProperty("coalesced");
    expect(handler.mock.calls[1]![0]).toMatchObject({ input: { origin: "schedule" } });

    first.resolve({ hasMore: false });
    await woken;
    await app.close();
  });

  it("wakes the drain again when a run stops on its budget (hasMore)", async () => {
    const { app, trigger, reportError } = await makeApp(async () => ({
      processed: 1000,
      hasMore: true,
    }));

    const res = await app.inject({ method: "POST", url: `/jobs/${JOB}`, payload: WAKE_UP });
    expect(res.statusCode).toBe(200);
    expect(trigger).toHaveBeenCalledWith(JOB);
    // (The migration-drift monitor reports its no-prisma boot here; only the
    // re-wake path is under test.)
    expect(reportError).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tags: expect.objectContaining({ area: "job-trigger" }),
      }),
    );
    await app.close();
  });

  it("reports a failed re-wake and still answers 200 (the rows wait for the safety net)", async () => {
    const trigger = vi.fn(async () => {
      throw new Error("pubsub 403");
    });
    const { app, reportError } = await makeApp(
      async () => ({ hasMore: true }),
      { trigger },
    );

    const res = await app.inject({ method: "POST", url: `/jobs/${JOB}`, payload: WAKE_UP });
    expect(res.statusCode).toBe(200);
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "pubsub 403" }),
      expect.objectContaining({
        tags: expect.objectContaining({ area: "job-trigger", job: JOB, phase: "rekick" }),
      }),
    );
    await app.close();
  });

  it("does not re-wake a drain that emptied its queue", async () => {
    const { app, trigger } = await makeApp(async () => ({ hasMore: false }));
    await app.inject({ method: "POST", url: `/jobs/${JOB}`, payload: WAKE_UP });
    expect(trigger).not.toHaveBeenCalled();
    await app.close();
  });

  it("releases the flight when the run throws, so the next wake-up runs instead of being swallowed", async () => {
    let call = 0;
    const { app, handler } = await makeApp(async () => {
      call += 1;
      if (call === 1) throw new Error("db down");
      return { hasMore: false };
    });

    const failed = await app.inject({ method: "POST", url: `/jobs/${JOB}`, payload: WAKE_UP });
    expect(failed.statusCode).toBe(500);

    const next = await app.inject({ method: "POST", url: `/jobs/${JOB}`, payload: WAKE_UP });
    expect(next.json()).not.toHaveProperty("coalesced");
    expect(handler).toHaveBeenCalledTimes(2);
    await app.close();
  });
});
