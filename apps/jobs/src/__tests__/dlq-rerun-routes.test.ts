import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  RELEASE_RERUN_CLAIM_LUA,
  RedisJobDiagnosticsAdapter,
  SWAP_DLQ_MEMBER_LUA,
} from "@th/adapters/job-diagnostics/redis-dlq-adapter";
import {
  createJobDiagnosticsError,
  type RerunJobFromDlqResult,
} from "@th/ports/job-diagnostics";

import { createDlqRerunJob } from "../lib/dlq-rerun";

/**
 * Rerunning a dead-letter entry.
 *
 * Two defects, both seen against a running jobs service:
 *  1. rerunning an entry of a PAUSED job answered 200 and deleted the entry,
 *     although nothing ran (the run route answers 200 `{ skipped: true }`);
 *  2. a rerun that FAILED left two entries: the original, plus a new one
 *     pushed by the failed run itself.
 *
 * The rule now: the entry is deleted only when the run route confirms the run
 * ran AND the job did not report its own failure; a failed rerun leaves one
 * entry; the caller is told which.
 *
 * And one rerun per entry at a time: the rerun route holds a claim on the
 * entry while its rerun runs, and the run route rewrites an entry only for a
 * run that carries that claim's token.
 * Harness copied from dlq-push-report.test.ts.
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

function makeJob(handler: () => Promise<unknown>) {
  const input = { parse: vi.fn((value: unknown) => value ?? {}) };
  const handlerMock = vi.fn(handler);
  return {
    name: "demo.job",
    notify: false,
    input,
    handler: handlerMock,
    load: vi.fn(async () => ({ name: "demo.job", input, handler: handlerMock })),
  };
}

const failingHandler = async () => {
  throw new Error("job blew up");
};

async function makeApp(options: {
  diagnostics: unknown;
  handler?: () => Promise<unknown>;
  isEnabled?: () => Promise<boolean>;
}) {
  const logger = makeLogger();
  const job = makeJob(options.handler ?? failingHandler);
  delete process.env.K_SERVICE;
  buildContainerMock.mockResolvedValue({
    logger,
    runTracker: {
      isEnabled: vi.fn(options.isEnabled ?? (async () => true)),
      setEnabled: vi.fn(async () => undefined),
      latestAll: vi.fn(async () => new Map()),
      pruneRuns: vi.fn(async () => 0),
      runs: vi.fn(async () => []),
      record: vi.fn(async () => undefined),
    },
    diagnostics: options.diagnostics,
    env: {},
    prisma: undefined,
    reportError: reportErrorMock,
    close: vi.fn(async () => undefined),
  });
  getJobMock.mockReturnValue(job);
  const { createApp } = await import("../app");
  const { app } = await createApp();
  return { app, logger, job };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.resetModules();
  reportErrorMock.mockImplementation(() => "evt_1");
});

const RERUN_HEADERS = {
  "x-dlq-rerun-of": "entry-1",
  "x-dlq-rerun-claim": "claim-token-1",
};

describe("jobs run route: a failed run that is a rerun of a DLQ entry", () => {
  function makeDlq(
    recordRerunFailure: () => Promise<boolean>,
    holdsRerunClaim: () => Promise<boolean> = async () => true,
  ) {
    return {
      pushToDLQ: vi.fn(async () => undefined),
      recordRerunFailure: vi.fn(recordRerunFailure),
      holdsRerunClaim: vi.fn(holdsRerunClaim),
    };
  }

  it("records the failure on the named entry and pushes no second entry", async () => {
    const dlq = makeDlq(async () => true);
    const { app } = await makeApp({ diagnostics: dlq });

    const res = await app.inject({
      method: "POST",
      url: "/jobs/demo.job",
      headers: RERUN_HEADERS,
      payload: { secret: "s3cr3t" },
    });

    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body).toEqual({ error: "internal_error", runId: expect.any(String) });
    // Asked first whether this run holds the entry's claim.
    expect(dlq.holdsRerunClaim).toHaveBeenCalledTimes(1);
    expect(dlq.holdsRerunClaim).toHaveBeenCalledWith({
      queue: "demo.job",
      jobId: "entry-1",
      token: "claim-token-1",
    });
    expect(dlq.recordRerunFailure).toHaveBeenCalledTimes(1);
    expect(dlq.recordRerunFailure).toHaveBeenCalledWith({
      queue: "demo.job",
      jobId: "entry-1",
      runId: body.runId,
      failedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT[\d:.]+Z$/),
      error: { message: "job blew up", code: undefined },
    });
    expect(dlq.pushToDLQ).not.toHaveBeenCalled();
    expect(reportErrorMock).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tags: expect.objectContaining({ area: "job-dlq" }) }),
    );
  });

  it("pushes one new entry when the named entry is gone", async () => {
    const dlq = makeDlq(async () => false);
    const { app } = await makeApp({ diagnostics: dlq });

    const res = await app.inject({
      method: "POST",
      url: "/jobs/demo.job",
      headers: RERUN_HEADERS,
      payload: { orderId: "o-1" },
    });

    expect(res.statusCode).toBe(500);
    expect(dlq.recordRerunFailure).toHaveBeenCalledTimes(1);
    expect(dlq.pushToDLQ).toHaveBeenCalledTimes(1);
    expect(dlq.pushToDLQ).toHaveBeenCalledWith({
      ref: { queue: "demo.job", id: res.json().runId },
      failedAt: expect.any(String),
      payload: { orderId: "o-1" },
      attempt: 1,
      error: { message: "job blew up", code: undefined },
    });
  });

  it("falls back to one pushed entry and reports when recording throws", async () => {
    const recordErr = Object.assign(
      new Error("redis dlq rerun record aborted (keyHash=0123456789ab)"),
      { command: { name: "zadd", args: ["th:jobs:dlq:demo.job", 1, '{"secret":"s3cr3t"}'] } },
    );
    const dlq = makeDlq(async () => {
      throw recordErr;
    });
    const { app, logger } = await makeApp({ diagnostics: dlq });

    const res = await app.inject({
      method: "POST",
      url: "/jobs/demo.job",
      headers: RERUN_HEADERS,
      payload: {},
    });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "internal_error", runId: expect.any(String) });
    expect(dlq.pushToDLQ).toHaveBeenCalledTimes(1);
    expect(reportErrorMock).toHaveBeenCalledWith(recordErr, {
      tags: { area: "job-dlq", job: "demo.job", phase: "rerun-record" },
      extra: { runId: res.json().runId },
    });
    // Name and message only: an ioredis error carries the stored entry.
    expect(logger.error).toHaveBeenCalledWith("dlq_rerun_record_failed", {
      runId: res.json().runId,
      error: { name: "Error", message: recordErr.message },
    });
    const recordLog = logger.error.mock.calls.find(
      (call: unknown[]) => call[0] === "dlq_rerun_record_failed",
    );
    expect(JSON.stringify(recordLog)).not.toContain("s3cr3t");
  });

  it("a throwing reporter does not change the outcome", async () => {
    reportErrorMock.mockImplementation(() => {
      throw new Error("reporter down");
    });
    const dlq = makeDlq(async () => {
      throw new Error("redis down");
    });
    const { app } = await makeApp({ diagnostics: dlq });

    const res = await app.inject({
      method: "POST",
      url: "/jobs/demo.job",
      headers: RERUN_HEADERS,
      payload: {},
    });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "internal_error", runId: expect.any(String) });
    expect(dlq.pushToDLQ).toHaveBeenCalledTimes(1);
  });

  it("without the header the entry is pushed as before and nothing is rewritten", async () => {
    const dlq = makeDlq(async () => true);
    const { app, logger } = await makeApp({ diagnostics: dlq });

    const res = await app.inject({ method: "POST", url: "/jobs/demo.job", payload: {} });

    expect(res.statusCode).toBe(500);
    expect(dlq.holdsRerunClaim).not.toHaveBeenCalled();
    expect(dlq.recordRerunFailure).not.toHaveBeenCalled();
    expect(dlq.pushToDLQ).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalledWith("dlq_rerun_claim_not_held", expect.anything());
  });

  describe("the header alone does not make a run a rerun: it needs the entry's live claim", () => {
    /** An ordinary failed run: its own entry, and the named one left alone. */
    function expectOwnEntry(
      dlq: ReturnType<typeof makeDlq>,
      res: { statusCode: number; json: () => any },
    ) {
      expect(res.statusCode).toBe(500);
      expect(dlq.recordRerunFailure).not.toHaveBeenCalled();
      expect(dlq.pushToDLQ).toHaveBeenCalledTimes(1);
      expect(dlq.pushToDLQ).toHaveBeenCalledWith(
        expect.objectContaining({ ref: { queue: "demo.job", id: res.json().runId }, attempt: 1 }),
      );
    }

    it("no token: the claim is not even looked up", async () => {
      const dlq = makeDlq(async () => true);
      const { app, logger } = await makeApp({ diagnostics: dlq });

      const res = await app.inject({
        method: "POST",
        url: "/jobs/demo.job",
        headers: { "x-dlq-rerun-of": "entry-1" },
        payload: {},
      });

      expectOwnEntry(dlq, res);
      expect(dlq.holdsRerunClaim).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith("dlq_rerun_claim_not_held", {
        runId: res.json().runId,
        hasToken: false,
      });
    });

    it("an empty token counts as no token", async () => {
      const dlq = makeDlq(async () => true);
      const { app } = await makeApp({ diagnostics: dlq });

      const res = await app.inject({
        method: "POST",
        url: "/jobs/demo.job",
        headers: { "x-dlq-rerun-of": "entry-1", "x-dlq-rerun-claim": "" },
        payload: {},
      });

      expectOwnEntry(dlq, res);
      expect(dlq.holdsRerunClaim).not.toHaveBeenCalled();
    });

    it("a token that is not the live claim (wrong, stale, or no claim at all)", async () => {
      const dlq = makeDlq(
        async () => true,
        async () => false,
      );
      const { app, logger } = await makeApp({ diagnostics: dlq });

      const res = await app.inject({
        method: "POST",
        url: "/jobs/demo.job",
        headers: { "x-dlq-rerun-of": "entry-1", "x-dlq-rerun-claim": "gu3ssed-token" },
        payload: {},
      });

      expectOwnEntry(dlq, res);
      expect(dlq.holdsRerunClaim).toHaveBeenCalledWith({
        queue: "demo.job",
        jobId: "entry-1",
        token: "gu3ssed-token",
      });
      expect(logger.warn).toHaveBeenCalledWith("dlq_rerun_claim_not_held", {
        runId: res.json().runId,
        hasToken: true,
      });
      // Not a swallowed error, so nothing is reported for it.
      expect(reportErrorMock).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ tags: expect.objectContaining({ area: "job-dlq" }) }),
      );
    });

    it("the claim check throws: logged, reported, and the run still gets its entry", async () => {
      const checkErr = Object.assign(
        new Error("redis dlq rerun claim check rejected [TIMEOUT] (keyHash=0123456789ab)"),
        { command: { name: "get", args: ["th:jobs:dlq-rerun-claim:demo.job:entry-1"] } },
      );
      const dlq = makeDlq(
        async () => true,
        async () => {
          throw checkErr;
        },
      );
      const { app, logger } = await makeApp({ diagnostics: dlq });

      const res = await app.inject({
        method: "POST",
        url: "/jobs/demo.job",
        headers: { "x-dlq-rerun-of": "entry-1", "x-dlq-rerun-claim": "s3cr3t-token" },
        payload: {},
      });

      expectOwnEntry(dlq, res);
      expect(res.json()).toEqual({ error: "internal_error", runId: expect.any(String) });
      expect(reportErrorMock).toHaveBeenCalledWith(checkErr, {
        tags: { area: "job-dlq", job: "demo.job", phase: "rerun-claim-check" },
        extra: { runId: res.json().runId },
      });
      // Name and message only, and never the token.
      expect(logger.error).toHaveBeenCalledWith("dlq_rerun_claim_check_failed", {
        runId: res.json().runId,
        error: { name: "Error", message: checkErr.message },
      });
      const claimLogs = [...logger.error.mock.calls, ...logger.warn.mock.calls].filter(
        (call: unknown[]) => String(call[0]).startsWith("dlq_rerun_claim"),
      );
      expect(claimLogs).toHaveLength(2);
      expect(JSON.stringify(claimLogs)).not.toContain("s3cr3t-token");
    });

    it("the claim check throws and so does the reporter: same outcome", async () => {
      reportErrorMock.mockImplementation(() => {
        throw new Error("reporter down");
      });
      const dlq = makeDlq(
        async () => true,
        async () => {
          throw new Error("redis down");
        },
      );
      const { app } = await makeApp({ diagnostics: dlq });

      const res = await app.inject({
        method: "POST",
        url: "/jobs/demo.job",
        headers: RERUN_HEADERS,
        payload: {},
      });

      expectOwnEntry(dlq, res);
    });
  });

  it("an empty header counts as no header", async () => {
    const dlq = makeDlq(async () => true);
    const { app } = await makeApp({ diagnostics: dlq });

    await app.inject({
      method: "POST",
      url: "/jobs/demo.job",
      headers: { "x-dlq-rerun-of": "", "x-dlq-rerun-claim": "claim-token-1" },
      payload: {},
    });

    expect(dlq.holdsRerunClaim).not.toHaveBeenCalled();
    expect(dlq.recordRerunFailure).not.toHaveBeenCalled();
    expect(dlq.pushToDLQ).toHaveBeenCalledTimes(1);
  });

  it("a rerun that succeeds touches neither", async () => {
    const dlq = makeDlq(async () => true);
    const { app } = await makeApp({ diagnostics: dlq, handler: async () => ({ ok: true }) });

    const res = await app.inject({
      method: "POST",
      url: "/jobs/demo.job",
      headers: RERUN_HEADERS,
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ success: true, runId: expect.any(String) });
    // The claim only matters to a failed run.
    expect(dlq.holdsRerunClaim).not.toHaveBeenCalled();
    expect(dlq.recordRerunFailure).not.toHaveBeenCalled();
    expect(dlq.pushToDLQ).not.toHaveBeenCalled();
  });
});

describe("POST /dlq/:queue/:jobId/rerun", () => {
  async function rerun(result: RerunJobFromDlqResult | Error, payload: unknown = {}) {
    const dlq = {
      rerunFromDLQ: vi.fn(async () => {
        if (result instanceof Error) throw result;
        return result;
      }),
    };
    const { app, logger } = await makeApp({ diagnostics: dlq });
    const res = await app.inject({
      method: "POST",
      url: "/dlq/demo.job/entry-1/rerun",
      payload: payload as object,
    });
    return { res, dlq, logger };
  }

  it("200 for a confirmed run, with the run id and no made-up job id", async () => {
    const { res, dlq, logger } = await rerun(
      { outcome: "ran", runId: "run-2", entryDeleted: true },
      { payloadOverride: { secret: "s3cr3t" } },
    );

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ outcome: "ran", runId: "run-2", entryDeleted: true });
    expect(dlq.rerunFromDLQ).toHaveBeenCalledWith({
      queue: "demo.job",
      jobId: "entry-1",
      payloadOverride: { secret: "s3cr3t" },
    });
    expect(logger.info).toHaveBeenCalledWith("dlq_rerun", {
      queue: "demo.job",
      jobId: "entry-1",
      outcome: "ran",
      runId: "run-2",
      entryDeleted: true,
    });
    expect(JSON.stringify([logger.info.mock.calls, logger.warn.mock.calls])).not.toContain(
      "s3cr3t",
    );
  });

  it("still 200 `ran` when the job ran but its entry is still there", async () => {
    const { res, logger } = await rerun({ outcome: "ran", runId: "run-2", entryDeleted: false });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ outcome: "ran", runId: "run-2", entryDeleted: false });
    expect(logger.warn).toHaveBeenCalledWith("dlq_rerun", {
      queue: "demo.job",
      jobId: "entry-1",
      outcome: "ran",
      runId: "run-2",
      entryDeleted: false,
    });
  });

  it.each([
    ["disabled", "job_paused"],
    ["coalesced", "run_in_flight"],
    ["unconfirmed", "run_unconfirmed"],
    ["claimed", "rerun_in_progress"],
  ] as const)("409 for not_run / %s: the entry was kept", async (reason, error) => {
    const { res, logger } = await rerun({ outcome: "not_run", reason });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      outcome: "not_run",
      reason,
      error,
      entryKept: true,
      message: expect.stringMatching(/the entry was kept/),
    });
    expect(logger.warn).toHaveBeenCalledWith("dlq_rerun", {
      queue: "demo.job",
      jobId: "entry-1",
      outcome: "not_run",
      reason,
    });
  });

  it("the disabled answer says nothing ran and how to proceed, in the console's words", async () => {
    const { res } = await rerun({ outcome: "not_run", reason: "disabled" });

    // The console's control reads Enable / Disable. The code stays `job_paused`.
    expect(res.json().error).toBe("job_paused");
    expect(res.json().message).toBe(
      "This job is disabled, so nothing ran and the entry was kept. Enable the job, then rerun the entry.",
    );
  });

  it("the claimed answer says someone else's rerun is in progress", async () => {
    const { res } = await rerun({ outcome: "not_run", reason: "claimed" });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      outcome: "not_run",
      reason: "claimed",
      error: "rerun_in_progress",
      entryKept: true,
      message:
        "Someone else is rerunning this entry right now, so nothing ran and the entry was kept. Wait for that run to finish, then check the entry.",
    });
  });

  it("409 for a failed rerun, with the run's status and error", async () => {
    const { res, logger } = await rerun({
      outcome: "failed",
      runId: "run-2",
      status: 500,
      error: { message: "internal_error", code: "internal_error" },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      outcome: "failed",
      error: "rerun_failed",
      runId: "run-2",
      status: 500,
      runError: { message: "internal_error", code: "internal_error" },
      entryKept: true,
      message: "The rerun failed. The entry was kept.",
    });
    expect(logger.warn).toHaveBeenCalledWith("dlq_rerun", {
      queue: "demo.job",
      jobId: "entry-1",
      outcome: "failed",
      runId: "run-2",
      status: 500,
      errorCode: "internal_error",
    });
  });

  describe("a rerun turned away before any run started (no run id)", () => {
    const refused = (status: number, code?: string): RerunJobFromDlqResult => ({
      outcome: "failed",
      runId: null,
      status,
      error: code ? { message: code, code } : { message: `HTTP ${status}` },
    });
    const refusedReport = expect.objectContaining({
      tags: { area: "job-dlq", phase: "rerun-refused" },
    });

    it.each([
      ["401 on the self-call", refused(401, "unauthorized")],
      ["a 500 with no run id", refused(500)],
      ["a 503 that is not migration drift", refused(503, "JOB_MODULE_LOAD_FAILED")],
    ])("reports %s, and still answers 409", async (_label, result) => {
      const { res, logger } = await rerun(result);

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({
        outcome: "failed",
        error: "rerun_failed",
        runId: null,
        status: result.outcome === "failed" ? result.status : undefined,
        entryKept: true,
      });
      // createApp's migration-drift check reports through the same mock (no
      // database here), so pick this route's reports out by their tags.
      const refusedReports = reportErrorMock.mock.calls.filter(
        ([, ctx]) => (ctx as { tags?: { phase?: string } })?.tags?.phase === "rerun-refused",
      );
      expect(refusedReports).toHaveLength(1);
      const [reported, context] = refusedReports[0]!;
      expect(reported).toBeInstanceOf(Error);
      expect((reported as Error).message).toMatch(/^DLQ rerun refused before the run started: HTTP \d{3}$/);
      expect(context).toEqual({
        tags: { area: "job-dlq", phase: "rerun-refused" },
        extra: {
          queue: "demo.job",
          jobId: "entry-1",
          status: result.outcome === "failed" ? result.status : undefined,
        },
      });
      expect(logger.error).toHaveBeenCalledWith(
        "dlq_rerun_refused",
        expect.objectContaining({ queue: "demo.job", jobId: "entry-1" }),
      );
    });

    it("a throwing reporter does not change the answer", async () => {
      reportErrorMock.mockImplementation(() => {
        throw new Error("reporter down");
      });
      const { res } = await rerun(refused(401, "unauthorized"));

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ outcome: "failed", status: 401, entryKept: true });
    });

    it.each([
      ["a 404 (the job no longer exists)", refused(404, "job_not_found")],
      ["the migration-drift 503 (the run route reports it once)", refused(503, "migration_drift")],
    ])("does not report %s", async (_label, result) => {
      const { res, logger } = await rerun(result);

      expect(res.statusCode).toBe(409);
      expect(reportErrorMock).not.toHaveBeenCalledWith(expect.anything(), refusedReport);
      expect(logger.error).not.toHaveBeenCalledWith("dlq_rerun_refused", expect.anything());
    });

    it.each([
      ["a run that threw", 500],
      ["a job that returned its own failure", 200],
    ])("does not report %s: it has a run id", async (_label, status) => {
      const { res, logger } = await rerun({
        outcome: "failed",
        runId: "run-2",
        status,
        error: { message: "boom" },
      });

      expect(res.statusCode).toBe(409);
      expect(reportErrorMock).not.toHaveBeenCalledWith(expect.anything(), refusedReport);
      expect(logger.error).not.toHaveBeenCalledWith("dlq_rerun_refused", expect.anything());
    });
  });

  it("404 when the entry does not exist", async () => {
    const { res } = await rerun(
      createJobDiagnosticsError("not_found", "DLQ item entry-1 not found in queue demo.job"),
    );

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not_found" });
  });

  it("any other error still answers 500", async () => {
    const { res } = await rerun(new TypeError("fetch failed"));

    expect(res.statusCode).toBe(500);
  });

  it("another JobDiagnosticsError code still answers 500", async () => {
    const { res } = await rerun(createJobDiagnosticsError("transient", "redis down"));

    expect(res.statusCode).toBe(500);
  });
});

describe("DELETE /dlq/:queue/:jobId", () => {
  async function del(deleteFromDLQ: () => Promise<boolean>) {
    const dlq = { deleteFromDLQ: vi.fn(deleteFromDLQ) };
    const { app } = await makeApp({ diagnostics: dlq });
    const res = await app.inject({ method: "DELETE", url: "/dlq/demo.job/entry-1" });
    return { res, dlq };
  }

  it.each([[true], [false]])("answers { deleted: %s } as the adapter did", async (deleted) => {
    const { res, dlq } = await del(async () => deleted);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deleted });
    expect(dlq.deleteFromDLQ).toHaveBeenCalledWith({ queue: "demo.job", jobId: "entry-1" });
  });

  it("an entry rewritten under every attempt is a 500 with the adapter's fixed text, not a 404 or `deleted: false`", async () => {
    // What the adapter throws on contention: op and key hash, no member.
    const message = "redis dlq delete contended after 3 attempts (keyHash=0123456789ab)";
    const { res } = await del(async () => {
      throw new Error(message);
    });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ statusCode: 500, error: "Internal Server Error", message });
  });
});

/**
 * The whole loop, with the real adapter over an in-memory sorted set and the
 * real `rerunJob` callback pointed back at this app: the rerun route calls the
 * adapter, the adapter POSTs the run route, the run route answers, and the
 * entry count is read at the end.
 */
describe("DLQ rerun, end to end through both routes", () => {
  /**
   * The Redis commands the adapter uses, over one in-memory sorted set and a
   * map of string keys (the rerun claims). The scripts are redone in JS, so
   * this shows how the routes use them, not that the Lua is right.
   */
  function memorySortedSet() {
    const members = new Map<string, number>();
    const strings = new Map<string, string>();
    const ascending = () =>
      [...members.entries()].sort((a, b) => a[1] - b[1]).map(([m]) => m);
    /** Set to make the delete after a confirmed run fail, as a Redis timeout would. */
    const faults = { failDelete: false };
    // `multi()` and `pipeline()`: queue, apply on exec, reply `[null, result]`
    // per command; a callback gets its command's reply, as in ioredis.
    const batch = () => {
      const queued: Array<() => unknown> = [];
      const names: string[] = [];
      const queue = (
        name: string,
        run: () => unknown,
        callback?: (err: Error | null, reply?: any) => void,
      ) => {
        names.push(name);
        queued.push(() => {
          const reply = run();
          callback?.(null, reply);
          return reply;
        });
        return chain;
      };
      const chain = {
        zadd: (_key: string, score: number, member: string) =>
          queue("zadd", () => members.set(member, score) && 1),
        zrem: (
          _key: string,
          member: string,
          callback?: (err: Error | null, reply?: number) => void,
        ) => queue("zrem", () => (members.delete(member) ? 1 : 0), callback),
        zremrangebyrank: () => queue("zremrangebyrank", () => 0),
        zrange: (
          _key: string,
          _start: number,
          _stop: number,
          callback?: (err: Error | null, reply?: string[]) => void,
        ) => queue("zrange", () => ascending(), callback),
        zrevrange: (
          _key: string,
          _start: number,
          _stop: number,
          callback?: (err: Error | null, reply?: string[]) => void,
        ) => queue("zrevrange", () => ascending().reverse(), callback),
        // SET key value EX seconds NX
        set: (key: string, value: string, ...rest: unknown[]) => {
          const callback = rest.pop() as (err: Error | null, reply?: "OK" | null) => void;
          return queue(
            "set",
            () => {
              if (strings.has(key)) return null;
              strings.set(key, value);
              return "OK";
            },
            callback,
          );
        },
        get: (key: string, callback?: (err: Error | null, reply?: string | null) => void) =>
          queue("get", () => strings.get(key) ?? null, callback),
        eval: (script: string, _numKeys: number, key: string, ...rest: unknown[]) => {
          const callback = rest.pop() as (err: Error | null, reply?: unknown) => void;
          return queue(
            "eval",
            () => {
              if (script === RELEASE_RERUN_CLAIM_LUA) {
                const [token] = rest as [string];
                return strings.get(key) === token && strings.delete(key) ? 1 : 0;
              }
              if (script !== SWAP_DLQ_MEMBER_LUA) throw new Error("unknown script");
              const [oldMember, score, newMember] = rest as [string, number, string];
              if (!members.has(oldMember)) return 0;
              members.set(newMember, Number(score));
              if (oldMember !== newMember) members.delete(oldMember);
              return 1;
            },
            callback,
          );
        },
        exec: async () => {
          if (faults.failDelete && names.length === 1 && names[0] === "zrem") {
            return [[new Error("Command timed out"), null]];
          }
          return queued.map((run) => [null, run()]);
        },
      };
      return chain;
    };
    // No bare `zrange`/`zrem`: the adapter sends everything as a batch.
    const redis = { multi: batch, pipeline: batch };
    return {
      redis,
      faults,
      entries: () => ascending().map((raw) => JSON.parse(raw)),
      /** The rerun claims held right now, by key. */
      claims: () => Object.fromEntries(strings),
    };
  }

  async function setup(options: {
    handler: () => Promise<unknown>;
    isEnabled?: () => Promise<boolean>;
    /**
     * True: the self-call reaches the run route, but the caller's side of it
     * breaks off (as a fetch that gave up waiting does). The run goes on and
     * its response lands in `lateRuns`.
     */
    breakOff?: () => boolean;
    /**
     * A status: the self-call reaches the run route and the run goes on (its
     * response lands in `lateRuns`), but the caller gets a gateway's page with
     * that status instead, as Cloud Run's front end answers 504 past 300s.
     */
    gateway?: () => number | null;
    /** A response: answered to the self-call instead; the run route never runs. */
    answer?: () => Response | null;
  }) {
    const { breakOff, gateway, answer, ...appOptions } = options;
    const lateRuns: Array<Promise<Response>> = [];
    const store = memorySortedSet();
    let inject: ((url: string, init: RequestInit) => Promise<Response>) | null = null;
    const selfCalls: Array<{ url: string; headers: Record<string, string> }> = [];
    const adapterLogger = { error: vi.fn() };
    const diagnostics = new RedisJobDiagnosticsAdapter({
      redis: store.redis as any,
      reportError: reportErrorMock,
      logger: adapterLogger,
      rerunJob: createDlqRerunJob({
        selfUrl: "http://jobs.test",
        fetch: (async (url: string, init: RequestInit) => {
          selfCalls.push({ url, headers: init.headers as Record<string, string> });
          if (breakOff?.()) {
            lateRuns.push(inject!(url, init));
            throw new TypeError("fetch failed");
          }
          const gatewayStatus = gateway?.() ?? null;
          if (gatewayStatus !== null) {
            lateRuns.push(inject!(url, init));
            return new Response("upstream request timeout", { status: gatewayStatus });
          }
          const answered = answer?.() ?? null;
          if (answered) return answered;
          return inject!(url, init);
        }) as unknown as typeof fetch,
      }),
    });
    const { app, job, logger } = await makeApp({ diagnostics, ...appOptions });
    inject = async (url, init) => {
      const target = new URL(url);
      const res = await app.inject({
        method: "POST",
        url: target.pathname + target.search,
        headers: init.headers as Record<string, string>,
        payload: init.body as string,
      });
      return new Response(res.body, { status: res.statusCode });
    };
    return { app, job, store, selfCalls, adapterLogger, lateRuns, logger };
  }

  /** Fail one run so the DLQ holds one entry; returns that entry. */
  async function seedOneFailure(
    app: Awaited<ReturnType<typeof setup>>["app"],
    store: ReturnType<typeof memorySortedSet>,
  ) {
    const first = await app.inject({
      method: "POST",
      url: "/jobs/demo.job",
      payload: { orderId: "o-1" },
    });
    expect(first.statusCode).toBe(500);
    expect(store.entries()).toHaveLength(1);
    return store.entries()[0];
  }

  it("a paused job: 409, nothing runs, the entry stays (was: 200 and the entry was lost)", async () => {
    let paused = false;
    const { app, job, store, selfCalls } = await setup({
      handler: failingHandler,
      isEnabled: async () => !paused,
    });
    const entry = await seedOneFailure(app, store);
    paused = true;
    job.handler.mockClear();

    const res = await app.inject({
      method: "POST",
      url: `/dlq/demo.job/${entry.ref.id}/rerun`,
      payload: {},
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      outcome: "not_run",
      reason: "disabled",
      error: "job_paused",
      entryKept: true,
    });
    expect(job.handler).not.toHaveBeenCalled();
    expect(store.entries()).toEqual([entry]);
    // Never forced past the pause.
    expect(selfCalls).toHaveLength(1);
    expect(selfCalls[0]!.url).toBe("http://jobs.test/jobs/demo.job");
  });

  it("a failed rerun: 409 and still ONE entry, rewritten (was: 500 and two entries)", async () => {
    const { app, store, selfCalls } = await setup({ handler: failingHandler });
    const entry = await seedOneFailure(app, store);

    const res = await app.inject({
      method: "POST",
      url: `/dlq/demo.job/${entry.ref.id}/rerun`,
      payload: {},
    });

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body).toMatchObject({
      outcome: "failed",
      error: "rerun_failed",
      status: 500,
      runError: { message: "internal_error", code: "internal_error" },
      entryKept: true,
    });
    expect(selfCalls[0]!.headers["X-Dlq-Rerun-Of"]).toBe(entry.ref.id);
    // The self-call carried the claim token, and the claim is released now.
    expect(selfCalls[0]!.headers["X-Dlq-Rerun-Claim"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(store.claims()).toEqual({});

    const entries = store.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      ref: entry.ref,
      payload: { orderId: "o-1" },
      attempt: 2,
      error: { message: "job blew up" },
      metadata: { firstFailedAt: entry.failedAt, lastRunId: body.runId },
    });
    expect(body.runId).not.toBe(entry.ref.id);

    // And again: still one entry, counted up.
    const again = await app.inject({
      method: "POST",
      url: `/dlq/demo.job/${entry.ref.id}/rerun`,
      payload: {},
    });
    expect(again.statusCode).toBe(409);
    expect(store.entries()).toHaveLength(1);
    expect(store.entries()[0]).toMatchObject({
      ref: entry.ref,
      attempt: 3,
      metadata: { firstFailedAt: entry.failedAt, lastRunId: again.json().runId },
    });
  });

  it("a rerun that runs: 200 with the run's id and the entry is deleted", async () => {
    let fail = true;
    const { app, job, store } = await setup({
      handler: async () => {
        if (fail) throw new Error("job blew up");
        return { ok: true };
      },
    });
    const entry = await seedOneFailure(app, store);
    fail = false;
    job.handler.mockClear();

    const res = await app.inject({
      method: "POST",
      url: `/dlq/demo.job/${entry.ref.id}/rerun`,
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      outcome: "ran",
      runId: expect.any(String),
      entryDeleted: true,
    });
    expect(job.handler).toHaveBeenCalledTimes(1);
    expect(job.handler).toHaveBeenCalledWith(
      expect.objectContaining({ input: { orderId: "o-1" } }),
    );
    expect(store.entries()).toEqual([]);
  });

  it("a job that RETURNS its failure: 409, and the entry survives (the route said 200)", async () => {
    let mode: "throw" | "return-failure" = "throw";
    const { app, job, store } = await setup({
      handler: async () => {
        if (mode === "throw") throw new Error("job blew up");
        // A handler that returns `{ success: false, error }` instead of
        // throwing. `classifyRerunResponse` must not read its 200 as a run.
        return { success: false, error: "connect ECONNREFUSED 127.0.0.1:5432" };
      },
    });
    const entry = await seedOneFailure(app, store);
    mode = "return-failure";
    job.handler.mockClear();

    const res = await app.inject({
      method: "POST",
      url: `/dlq/demo.job/${entry.ref.id}/rerun`,
      payload: {},
    });

    expect(job.handler).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      outcome: "failed",
      error: "rerun_failed",
      runId: expect.any(String),
      status: 200,
      runError: { message: "connect ECONNREFUSED 127.0.0.1:5432" },
      entryKept: true,
      message: "The rerun failed. The entry was kept.",
    });
    // Kept as it was: the run route's catch did not run, so nothing rewrote it.
    expect(store.entries()).toEqual([entry]);
  });

  it("a job that reports it skipped its work: 409 unconfirmed, and the entry survives", async () => {
    let mode: "throw" | "skip" = "throw";
    const { app, store } = await setup({
      handler: async () => {
        if (mode === "throw") throw new Error("job blew up");
        return { skipped: true, reason: "ziptax_not_configured" };
      },
    });
    const entry = await seedOneFailure(app, store);
    mode = "skip";

    const res = await app.inject({
      method: "POST",
      url: `/dlq/demo.job/${entry.ref.id}/rerun`,
      payload: {},
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      outcome: "not_run",
      reason: "unconfirmed",
      error: "run_unconfirmed",
      entryKept: true,
    });
    expect(store.entries()).toEqual([entry]);
  });

  it("a job that returns `skipped: \"<why>\"`: 409 unconfirmed, and the entry survives", async () => {
    let mode: "throw" | "skip" = "throw";
    const { app, job, store } = await setup({
      handler: async () => {
        if (mode === "throw") throw new Error("job blew up");
        // attendee-review-digests.send without a mailer (attendee-reviews.ts).
        return { skipped: "mailer_unconfigured" };
      },
    });
    const entry = await seedOneFailure(app, store);
    mode = "skip";
    job.handler.mockClear();

    const res = await app.inject({
      method: "POST",
      url: `/dlq/demo.job/${entry.ref.id}/rerun`,
      payload: {},
    });

    expect(job.handler).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      outcome: "not_run",
      reason: "unconfirmed",
      error: "run_unconfirmed",
      entryKept: true,
      message: "The jobs service did not confirm that the job ran, so the entry was kept.",
    });
    expect(store.entries()).toEqual([entry]);
  });

  it("the job ran but the delete failed: 200 `ran` with entryDeleted false, reported", async () => {
    let fail = true;
    const { app, job, store, adapterLogger } = await setup({
      handler: async () => {
        if (fail) throw new Error("job blew up");
        return { ok: true };
      },
    });
    const entry = await seedOneFailure(app, store);
    fail = false;
    store.faults.failDelete = true;
    job.handler.mockClear();
    reportErrorMock.mockClear();

    const res = await app.inject({
      method: "POST",
      url: `/dlq/demo.job/${entry.ref.id}/rerun`,
      payload: {},
    });

    // Not a 500: the job did its work, and an error would invite a second run.
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual({ outcome: "ran", runId: expect.any(String), entryDeleted: false });
    expect(job.handler).toHaveBeenCalledTimes(1);
    expect(store.entries()).toEqual([entry]);
    expect(reportErrorMock).toHaveBeenCalledTimes(1);
    expect(reportErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringMatching(
          /^redis dlq rerun delete failed at command 0 \[TIMEOUT\] \(keyHash=[0-9a-f]{12}\)$/,
        ),
      }),
      {
        tags: { area: "job-dlq", phase: "rerun-delete" },
        extra: { queue: "demo.job", jobId: entry.ref.id, runId: body.runId },
      },
    );
    expect(adapterLogger.error).toHaveBeenCalledWith(
      "dlq_rerun_delete_failed",
      expect.objectContaining({ queue: "demo.job", jobId: entry.ref.id, runId: body.runId }),
    );
  });

  it("an unknown entry: 404 and no run", async () => {
    const { app, job, store } = await setup({ handler: failingHandler });

    const res = await app.inject({
      method: "POST",
      url: "/dlq/demo.job/nope/rerun",
      payload: {},
    });

    expect(res.statusCode).toBe(404);
    expect(job.handler).not.toHaveBeenCalled();
    expect(store.entries()).toEqual([]);
    // The claim taken to look the entry up is not left behind.
    expect(store.claims()).toEqual({});
  });

  describe("several people rerun one entry at the same moment", () => {
    const rerunAtOnce = (app: Awaited<ReturnType<typeof setup>>["app"], id: string, n: number) =>
      Promise.all(
        Array.from({ length: n }, () =>
          app.inject({ method: "POST", url: `/dlq/demo.job/${id}/rerun`, payload: {} }),
        ),
      );

    it("five failing reruns: the job runs ONCE and one entry is left, at attempt 2 (was: five runs and an extra entry)", async () => {
      const { app, job, store, selfCalls } = await setup({ handler: failingHandler });
      const entry = await seedOneFailure(app, store);
      job.handler.mockClear();

      const responses = await rerunAtOnce(app, entry.ref.id, 5);

      expect(job.handler).toHaveBeenCalledTimes(1);
      expect(selfCalls).toHaveLength(1);

      const failed = responses.filter((res) => res.json().error === "rerun_failed");
      const claimed = responses.filter((res) => res.json().error === "rerun_in_progress");
      expect(failed).toHaveLength(1);
      expect(claimed).toHaveLength(4);
      for (const res of claimed) {
        expect(res.statusCode).toBe(409);
        expect(res.json()).toEqual({
          outcome: "not_run",
          reason: "claimed",
          error: "rerun_in_progress",
          entryKept: true,
          message: expect.stringMatching(/^Someone else is rerunning this entry right now/),
        });
      }

      const entries = store.entries();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        ref: entry.ref,
        payload: { orderId: "o-1" },
        attempt: 2,
        metadata: { firstFailedAt: entry.failedAt, lastRunId: failed[0]!.json().runId },
      });

      // The claim went with the rerun: the entry can be rerun again.
      expect(store.claims()).toEqual({});
      const [again] = await rerunAtOnce(app, entry.ref.id, 1);
      expect(again!.json().error).toBe("rerun_failed");
      expect(store.entries()).toHaveLength(1);
      expect(store.entries()[0]).toMatchObject({ ref: entry.ref, attempt: 3 });
    });

    it("five reruns of a job that now works: it runs ONCE and the entry is deleted", async () => {
      let fail = true;
      const { app, job, store } = await setup({
        handler: async () => {
          if (fail) throw new Error("job blew up");
          return { ok: true };
        },
      });
      const entry = await seedOneFailure(app, store);
      fail = false;
      job.handler.mockClear();

      const responses = await rerunAtOnce(app, entry.ref.id, 5);

      expect(job.handler).toHaveBeenCalledTimes(1);
      expect(responses.filter((res) => res.statusCode === 200)).toHaveLength(1);
      expect(responses.filter((res) => res.json().error === "rerun_in_progress")).toHaveLength(4);
      expect(store.entries()).toEqual([]);
      expect(store.claims()).toEqual({});
    });
  });

  it("the rerun request breaks off while the job still runs: the claim is kept, nobody can start a second run, and the late failure lands on the entry", async () => {
    let hold = false;
    let letGo!: () => void;
    const held = new Promise<void>((resolve) => {
      letGo = resolve;
    });
    const { app, job, store, lateRuns } = await setup({
      handler: async () => {
        if (hold) await held;
        throw new Error("job blew up");
      },
      breakOff: () => true,
    });
    const entry = await seedOneFailure(app, store);
    hold = true;
    job.handler.mockClear();
    const rerunUrl = `/dlq/demo.job/${entry.ref.id}/rerun`;

    // No answer from the run route: an error, and not "nothing ran".
    const first = await app.inject({ method: "POST", url: rerunUrl, payload: {} });
    expect(first.statusCode).toBe(500);
    await vi.waitFor(() => expect(job.handler).toHaveBeenCalledTimes(1));
    expect(Object.keys(store.claims())).toEqual([
      `th:jobs:dlq-rerun-claim:demo.job:${entry.ref.id}`,
    ]);

    // Someone presses Rerun again while that run is still going.
    const second = await app.inject({ method: "POST", url: rerunUrl, payload: {} });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ reason: "claimed", error: "rerun_in_progress" });
    expect(job.handler).toHaveBeenCalledTimes(1);
    expect(store.entries()).toEqual([entry]);

    // The run fails at last. Its token is still the live claim, so the failure
    // is written onto the entry instead of becoming a second one.
    letGo();
    const late = await lateRuns[0]!;
    expect(late.status).toBe(500);
    const lateRunId = ((await late.json()) as { runId: string }).runId;
    const entries = store.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      ref: entry.ref,
      attempt: 2,
      metadata: { firstFailedAt: entry.failedAt, lastRunId: lateRunId },
    });
  });

  describe("a gateway answers for the run route", () => {
    /** This route's reports with the given phase (createApp reports through the same mock). */
    const reportsWithPhase = (phase: string) =>
      reportErrorMock.mock.calls.filter(
        ([, ctx]) => (ctx as { tags?: { phase?: string } })?.tags?.phase === phase,
      );

    it("a non-JSON 504 while the job still runs: the claim is kept, it is not called a refusal, and the late failure lands on the entry", async () => {
      let hold = false;
      let letGo!: () => void;
      const held = new Promise<void>((resolve) => {
        letGo = resolve;
      });
      const { app, job, store, lateRuns, logger } = await setup({
        handler: async () => {
          if (hold) await held;
          throw new Error("job blew up");
        },
        gateway: () => 504,
      });
      const entry = await seedOneFailure(app, store);
      hold = true;
      job.handler.mockClear();
      reportErrorMock.mockClear();
      logger.error.mockClear();
      const rerunUrl = `/dlq/demo.job/${entry.ref.id}/rerun`;

      // Was: 409 `rerun_failed`, "refused before the run started: HTTP 504",
      // and the claim released under a live run.
      const first = await app.inject({ method: "POST", url: rerunUrl, payload: {} });
      expect(first.statusCode).toBe(500);
      expect(first.json()).toMatchObject({
        message:
          "The run route gave no answer of its own (HTTP 504), so whether the job ran is not known.",
      });
      await vi.waitFor(() => expect(job.handler).toHaveBeenCalledTimes(1));
      expect(Object.keys(store.claims())).toEqual([
        `th:jobs:dlq-rerun-claim:demo.job:${entry.ref.id}`,
      ]);

      // Worded as "no answer", never as a refusal.
      expect(reportsWithPhase("rerun-refused")).toEqual([]);
      expect(logger.error).not.toHaveBeenCalledWith("dlq_rerun_refused", expect.anything());
      expect(logger.error).toHaveBeenCalledWith("dlq_rerun_no_answer", {
        queue: "demo.job",
        jobId: entry.ref.id,
        status: 504,
      });
      const noAnswer = reportsWithPhase("rerun-no-answer");
      expect(noAnswer).toHaveLength(1);
      expect(noAnswer[0]![1]).toEqual({
        tags: { area: "job-dlq", phase: "rerun-no-answer" },
        extra: { queue: "demo.job", jobId: entry.ref.id, status: 504 },
      });

      // A second press while that run is still going starts nothing.
      const second = await app.inject({ method: "POST", url: rerunUrl, payload: {} });
      expect(second.statusCode).toBe(409);
      expect(second.json()).toMatchObject({ reason: "claimed", error: "rerun_in_progress" });
      expect(job.handler).toHaveBeenCalledTimes(1);

      // The run fails at last: its token is still the live claim, so the
      // failure is written onto the entry instead of becoming a second one.
      letGo();
      const late = await lateRuns[0]!;
      expect(late.status).toBe(500);
      const entries = store.entries();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ ref: entry.ref, attempt: 2 });
    });

    it("the jobs service's OWN JSON 503 (migration drift) still releases the claim: nothing started", async () => {
      let drift = false;
      const { app, job, store, logger } = await setup({
        handler: failingHandler,
        answer: () =>
          drift
            ? new Response(
                JSON.stringify({
                  success: false,
                  error: "migration_drift",
                  job: "demo.job",
                  message: "Database is missing migrations this build requires.",
                }),
                { status: 503 },
              )
            : null,
      });
      const entry = await seedOneFailure(app, store);
      drift = true;
      job.handler.mockClear();
      reportErrorMock.mockClear();
      logger.error.mockClear();

      const res = await app.inject({
        method: "POST",
        url: `/dlq/demo.job/${entry.ref.id}/rerun`,
        payload: {},
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({
        outcome: "failed",
        error: "rerun_failed",
        runId: null,
        status: 503,
        runError: { code: "migration_drift" },
        entryKept: true,
      });
      expect(job.handler).not.toHaveBeenCalled();
      expect(store.claims()).toEqual({});
      expect(store.entries()).toEqual([entry]);
      expect(reportsWithPhase("rerun-no-answer")).toEqual([]);
      expect(logger.error).not.toHaveBeenCalledWith("dlq_rerun_no_answer", expect.anything());
    });
  });

  describe("a direct caller of the run route naming an entry", () => {
    const direct = (
      app: Awaited<ReturnType<typeof setup>>["app"],
      headers: Record<string, string>,
    ) => app.inject({ method: "POST", url: "/jobs/demo.job", headers, payload: { direct: true } });

    it.each([
      ["no claim token", {}],
      ["a made-up token while nobody holds the claim", { "x-dlq-rerun-claim": "made-up" }],
    ])("%s: the named entry is untouched and each failed run gets its own", async (_label, extra) => {
      const { app, store } = await setup({ handler: failingHandler });
      const entry = await seedOneFailure(app, store);

      const responses = await Promise.all(
        Array.from({ length: 5 }, () =>
          direct(app, { "x-dlq-rerun-of": entry.ref.id, ...extra }),
        ),
      );

      const entries = store.entries();
      expect(entries).toHaveLength(6);
      // The entry they named: not rewritten, not counted up.
      expect(entries.filter((e) => e.ref.id === entry.ref.id)).toEqual([entry]);
      // One new entry per run, under the run's own id.
      expect(entries.map((e) => e.ref.id).sort()).toEqual(
        [entry.ref.id, ...responses.map((res) => res.json().runId)].sort(),
      );
    });

    it("a made-up token WHILE a real rerun holds the claim: still its own entry", async () => {
      let directRun: Promise<{ json: () => any }> | null = null;
      let calls = 0;
      const { app, store } = await setup({
        handler: async () => {
          calls += 1;
          // Second call = the real rerun, holding the claim. While it runs,
          // someone hits the run route directly with a guessed token.
          if (calls === 2) {
            directRun = direct(app, {
              "x-dlq-rerun-of": store.entries()[0].ref.id,
              "x-dlq-rerun-claim": "gu3ssed",
            });
            await directRun;
          }
          throw new Error("job blew up");
        },
      });
      const entry = await seedOneFailure(app, store);

      const res = await app.inject({
        method: "POST",
        url: `/dlq/demo.job/${entry.ref.id}/rerun`,
        payload: {},
      });

      expect(res.json()).toMatchObject({ outcome: "failed", error: "rerun_failed" });
      const entries = store.entries();
      expect(entries).toHaveLength(2);
      // Only the claim holder's failure was written onto the entry.
      expect(entries.find((e) => e.ref.id === entry.ref.id)).toMatchObject({
        attempt: 2,
        metadata: { lastRunId: res.json().runId },
      });
      const directRunId = (await directRun!).json().runId;
      expect(entries.find((e) => e.ref.id === directRunId)).toMatchObject({
        attempt: 1,
        payload: { direct: true },
      });
    });
  });
});
