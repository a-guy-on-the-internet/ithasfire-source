import { afterEach, describe, expect, it, vi } from "vitest";

import { createCaller } from "./test-helpers";
import { platformJobsRouter } from "../platform-jobs";

/**
 * `platformJobs.rerunDlqItem` proxies `POST /dlq/:queue/:jobId/rerun` on the
 * jobs service. That route answers 200 only when the run was confirmed (the
 * entry is deleted) and 409 when nothing ran or the run failed (the entry is
 * kept). Both arrive here as DATA, so the console branches on `outcome`; a
 * rerun that did not run must never look like a plain success.
 */

const JOBS_URL = "http://jobs.test";
const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const RERUN_URL = `${JOBS_URL}/dlq/demo.job/entry-1/rerun`;

function setup(respond: () => Response | Promise<Response>, allowed = true) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      // Off GCP: no metadata server, so no identity token.
      if (u.startsWith("http://metadata.google.internal/")) {
        throw new TypeError("fetch failed");
      }
      calls.push({ url: u, init: init ?? {} });
      return respond();
    }),
  );
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const { caller, ctx } = createCaller(
    {
      rerunDlqItem: platformJobsRouter.rerunDlqItem,
      deleteDlqItem: platformJobsRouter.deleteDlqItem,
      peekDlq: platformJobsRouter.peekDlq,
    },
    {
      actorHumanId: ACTOR_ID,
      authz: { hasStaffRole: vi.fn(async () => ({ allowed })) } as any,
    } as any,
  );
  Object.assign(ctx, { jobsServiceUrl: JOBS_URL });
  return { caller, calls };
}

const json = (status: number, body: unknown) => () =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const INPUT = { queue: "demo.job", jobId: "entry-1" };

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("platformJobs.rerunDlqItem", () => {
  it("200 `ran` resolves with the run id", async () => {
    vi.stubEnv("JOBS_API_KEY", "k".repeat(32));
    const { caller, calls } = setup(
      json(200, { outcome: "ran", runId: "run-2", entryDeleted: true }),
    );

    await expect(caller.rerunDlqItem(INPUT)).resolves.toEqual({
      outcome: "ran",
      runId: "run-2",
      entryDeleted: true,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(RERUN_URL);
    expect(calls[0]!.init.method).toBe("POST");
    // Same auth headers as every other jobs proxy call.
    expect(calls[0]!.init.headers).toEqual({
      "Content-Type": "application/json",
      "X-Jobs-API-Key": "k".repeat(32),
    });
  });

  it("200 `ran` with the entry still there resolves with entryDeleted false", async () => {
    const { caller } = setup(json(200, { outcome: "ran", runId: null, entryDeleted: false }));

    await expect(caller.rerunDlqItem(INPUT)).resolves.toEqual({
      outcome: "ran",
      runId: null,
      entryDeleted: false,
    });
  });

  it.each([["disabled"], ["coalesced"], ["unconfirmed"], ["claimed"]] as const)(
    "409 `not_run` / %s resolves as data and drops the wire-only fields",
    async (reason) => {
      const { caller } = setup(
        json(409, {
          outcome: "not_run",
          reason,
          error: "job_paused",
          entryKept: true,
          message: "This job is paused, so nothing ran and the entry was kept.",
        }),
      );

      await expect(caller.rerunDlqItem(INPUT)).resolves.toEqual({
        outcome: "not_run",
        reason,
      });
    },
  );

  it("409 `rerun_in_progress` (someone else holds the entry) resolves as `not_run` / `claimed`", async () => {
    // The jobs service's answer, verbatim.
    const { caller } = setup(
      json(409, {
        outcome: "not_run",
        reason: "claimed",
        entryKept: true,
        error: "rerun_in_progress",
        message:
          "Someone else is rerunning this entry right now, so nothing ran and the entry was kept. Wait for that run to finish, then check the entry.",
      }),
    );

    await expect(caller.rerunDlqItem(INPUT)).resolves.toEqual({
      outcome: "not_run",
      reason: "claimed",
    });
  });

  it("409 `failed` resolves as data with the run's status and error", async () => {
    const { caller } = setup(
      json(409, {
        outcome: "failed",
        error: "rerun_failed",
        runId: "run-2",
        status: 500,
        runError: { message: "internal_error", code: "internal_error" },
        entryKept: true,
        message: "The rerun failed. The entry was kept.",
      }),
    );

    await expect(caller.rerunDlqItem(INPUT)).resolves.toEqual({
      outcome: "failed",
      runId: "run-2",
      status: 500,
      error: { message: "internal_error", code: "internal_error" },
    });
  });

  it("409 `failed` for a run that never started has a null run id", async () => {
    const { caller } = setup(
      json(409, {
        outcome: "failed",
        error: "rerun_failed",
        runId: null,
        status: 503,
        runError: { message: "Database is behind this build." },
        entryKept: true,
        message: "The rerun failed. The entry was kept.",
      }),
    );

    await expect(caller.rerunDlqItem(INPUT)).resolves.toEqual({
      outcome: "failed",
      runId: null,
      status: 503,
      error: { message: "Database is behind this build." },
    });
  });

  it.each([
    ["not JSON", () => new Response("Conflict", { status: 409 })],
    ["JSON without an outcome", json(409, { error: "conflict" })],
    ["an unknown reason", json(409, { outcome: "not_run", reason: "sleepy" })],
    ["`ran` on a 409", json(409, { outcome: "ran", runId: "run-2", entryDeleted: true })],
    ["`failed` without its error", json(409, { outcome: "failed", runId: null, status: 500 })],
  ])("a 409 that does not parse (%s) throws PRECONDITION_FAILED", async (_label, respond) => {
    const { caller } = setup(respond);

    await expect(caller.rerunDlqItem(INPUT)).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("Jobs API 409"),
    });
  });

  it("404 throws NOT_FOUND", async () => {
    const { caller } = setup(json(404, { error: "not_found" }));

    await expect(caller.rerunDlqItem(INPUT)).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: 'Jobs API 404: {"error":"not_found"}',
    });
  });

  it("500 throws INTERNAL_SERVER_ERROR", async () => {
    const { caller } = setup(() => new Response("Internal Server Error", { status: 500 }));

    await expect(caller.rerunDlqItem(INPUT)).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: "Jobs API 500: Internal Server Error",
    });
  });

  it.each([
    ["the pre-contract `{ jobId }` answer", json(200, { jobId: "5b2c" })],
    ["a `not_run` body on a 200", json(200, { outcome: "not_run", reason: "disabled" })],
    ["`ran` that does not say what happened to the entry", json(200, { outcome: "ran", runId: "run-2" })],
    ["a body that is not JSON", () => new Response("OK", { status: 200 })],
  ])("a 200 that does not say `ran` (%s) throws instead of guessing", async (_label, respond) => {
    const { caller } = setup(respond);

    await expect(caller.rerunDlqItem(INPUT)).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: "Jobs API 200: unrecognised rerun response",
    });
  });

  it("an unreachable jobs service throws INTERNAL_SERVER_ERROR", async () => {
    const { caller } = setup(() => {
      throw new TypeError("fetch failed");
    });

    await expect(caller.rerunDlqItem(INPUT)).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: "Jobs service unreachable: fetch failed",
    });
  });

  it("non-staff callers are refused before any request is sent", async () => {
    const { caller, calls } = setup(
      json(200, { outcome: "ran", runId: "run-2", entryDeleted: true }),
      false,
    );

    await expect(caller.rerunDlqItem(INPUT)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(calls).toHaveLength(0);
  });
});

describe("platformJobs: every other procedure keeps the old error mapping", () => {
  it("a 404 from another route is still PRECONDITION_FAILED", async () => {
    const { caller } = setup(json(404, { error: "not_found" }));

    await expect(caller.deleteDlqItem(INPUT)).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: 'Jobs API 404: {"error":"not_found"}',
    });
  });

  it("a 409 from another route is still thrown, never returned", async () => {
    const { caller } = setup(json(409, { outcome: "not_run", reason: "disabled" }));

    await expect(caller.deleteDlqItem(INPUT)).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
  });

  it("a 2xx is returned as parsed JSON", async () => {
    const { caller } = setup(json(200, { deleted: true }));

    await expect(caller.deleteDlqItem(INPUT)).resolves.toEqual({ deleted: true });
  });
});

describe("platformJobs.peekDlq", () => {
  const entry = {
    ref: { queue: "demo.job", id: "entry-1" },
    failedAt: "2026-10-08T09:30:00.000Z",
    payload: { orderId: "o-1" },
    attempt: 2,
    error: { message: "boom again", code: "E_AGAIN" },
  };
  const metadata = { firstFailedAt: "2026-10-07T12:00:00.000Z", lastRunId: "run-2" };

  it("passes an entry's metadata through to the console (it used to be stripped)", async () => {
    const { caller, calls } = setup(
      json(200, { queue: "demo.job", items: [{ ...entry, metadata }], count: 1 }),
    );

    await expect(caller.peekDlq({ queue: "demo.job" })).resolves.toEqual({
      items: [{ ...entry, metadata }],
    });
    expect(calls[0]!.url).toBe(`${JOBS_URL}/dlq/demo.job?max=50`);
  });

  it("an entry that never had a failed rerun has no metadata", async () => {
    const first = { ...entry, attempt: 1 };
    const { caller } = setup(json(200, { queue: "demo.job", items: [first], count: 1 }));

    const { items } = await caller.peekDlq({ queue: "demo.job" });

    expect(items).toEqual([first]);
    expect(items[0]).not.toHaveProperty("metadata");
  });

  it("metadata that is not string-to-string fails the output check instead of reaching the console", async () => {
    const { caller } = setup(
      json(200, { items: [{ ...entry, metadata: { firstFailedAt: 1791360000000 } }] }),
    );

    await expect(caller.peekDlq({ queue: "demo.job" })).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
    });
  });
});
