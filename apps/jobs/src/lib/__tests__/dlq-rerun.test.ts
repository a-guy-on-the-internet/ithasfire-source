import { describe, expect, it, vi } from "vitest";

import {
  DLQ_RERUN_CLAIM_HEADER,
  DLQ_RERUN_OF_HEADER,
  DlqRerunNoAnswerError,
  classifyRerunResponse,
  createDlqRerunJob,
  isDlqRerunNoAnswer,
} from "../dlq-rerun";

/**
 * The run route answers 200 for anything that does not throw, so a rerun reads
 * the body before it believes the job ran. The shapes below are the run
 * route's real answers (apps/jobs/src/app.ts, `POST /jobs/:name`).
 */

describe("classifyRerunResponse: 2xx", () => {
  it("success with a run id is `ran`", () => {
    expect(
      classifyRerunResponse(200, {
        success: true,
        runId: "run-2",
        durationMs: 12,
        result: { ok: true },
      }),
    ).toEqual({ outcome: "ran", runId: "run-2" });
  });

  it("success without a run id is `ran` with a null run id", () => {
    expect(classifyRerunResponse(200, { success: true })).toEqual({
      outcome: "ran",
      runId: null,
    });
  });

  it("a paused job's skip is `not_run` / disabled", () => {
    expect(
      classifyRerunResponse(200, {
        success: false,
        skipped: true,
        reason: "disabled",
      }),
    ).toEqual({ outcome: "not_run", reason: "disabled" });
  });

  it("a skip for any other reason is `not_run` / unconfirmed", () => {
    expect(
      classifyRerunResponse(200, { success: false, skipped: true, reason: "quota" }),
    ).toEqual({ outcome: "not_run", reason: "unconfirmed" });
    expect(classifyRerunResponse(200, { skipped: true })).toEqual({
      outcome: "not_run",
      reason: "unconfirmed",
    });
  });

  it("a skip wins over `success: true`", () => {
    expect(
      classifyRerunResponse(200, { success: true, skipped: true, reason: "disabled" }),
    ).toEqual({ outcome: "not_run", reason: "disabled" });
  });

  it("a coalesced wake-up is `not_run` / coalesced, although it says success", () => {
    expect(classifyRerunResponse(200, { success: true, coalesced: true })).toEqual({
      outcome: "not_run",
      reason: "coalesced",
    });
  });

  it.each([
    ["no success flag", {}],
    ["success false", { success: false }],
    ["a truthy non-boolean success", { success: "true", runId: "run-2" }],
    ["the old rerun answer", { jobId: "5b2c" }],
    ["an array", [{ success: true }]],
    ["null", null],
    ["a body that was not JSON", undefined],
    ["a JSON string", "ok"],
  ])("any other 2xx (%s) is `not_run` / unconfirmed", (_label, body) => {
    expect(classifyRerunResponse(200, body)).toEqual({
      outcome: "not_run",
      reason: "unconfirmed",
    });
    expect(classifyRerunResponse(204, body)).toEqual({
      outcome: "not_run",
      reason: "unconfirmed",
    });
  });
});

describe("classifyRerunResponse: 2xx whose job returned its own verdict", () => {
  // The run route wraps ANY returned value as `{ success: true, runId, result }`.
  const wrapped = (result: unknown) => ({
    success: true,
    runId: "run-2",
    durationMs: 12,
    result,
  });

  it("`result.success === false` with an error is `failed`, status 200", () => {
    expect(
      classifyRerunResponse(200, wrapped({ success: false, error: "connect ECONNREFUSED" })),
    ).toEqual({
      outcome: "failed",
      runId: "run-2",
      status: 200,
      error: { message: "connect ECONNREFUSED" },
    });
  });

  it("falls back to `reason`, then `message`, for the error text", () => {
    expect(
      classifyRerunResponse(200, wrapped({ success: false, reason: "search_not_configured" })),
    ).toMatchObject({ outcome: "failed", error: { message: "search_not_configured" } });
    expect(
      classifyRerunResponse(200, wrapped({ success: false, message: "nothing indexed" })),
    ).toMatchObject({ outcome: "failed", error: { message: "nothing indexed" } });
    expect(
      classifyRerunResponse(
        200,
        wrapped({ success: false, error: "first", reason: "second", message: "third" }),
      ),
    ).toMatchObject({ outcome: "failed", error: { message: "first" } });
  });

  it.each([
    ["no text at all", { success: false }],
    ["an error that is not a string", { success: false, error: { nested: "s3cr3t" } }],
    ["blank text", { success: false, error: "  ", reason: "" }],
  ])("uses a fixed sentence for %s", (_label, result) => {
    const outcome = classifyRerunResponse(200, wrapped(result));
    expect(outcome).toEqual({
      outcome: "failed",
      runId: "run-2",
      status: 200,
      error: { message: "The job reported that it did not succeed." },
    });
    expect(JSON.stringify(outcome)).not.toContain("s3cr3t");
  });

  it("carries `result.code` only when it is a string", () => {
    expect(
      classifyRerunResponse(200, wrapped({ success: false, error: "boom", code: "E_DB" })),
    ).toMatchObject({ error: { message: "boom", code: "E_DB" } });
    const numeric = classifyRerunResponse(200, wrapped({ success: false, error: "boom", code: 503 }));
    expect(numeric).toMatchObject({ outcome: "failed", error: { message: "boom" } });
    expect(numeric.outcome === "failed" && "code" in numeric.error).toBe(false);
  });

  it("bounds the job's error text", () => {
    const outcome = classifyRerunResponse(200, wrapped({ success: false, error: "e".repeat(2000) }));
    expect(outcome.outcome === "failed" && outcome.error.message).toBe("e".repeat(500));
  });

  it("`result.skipped === true` is `not_run` / unconfirmed", () => {
    expect(
      classifyRerunResponse(200, wrapped({ skipped: true, reason: "ziptax_not_configured" })),
    ).toEqual({ outcome: "not_run", reason: "unconfirmed" });
  });

  it.each([
    ["attendee-reviews, no mailer", { skipped: "mailer_unconfigured" }],
    ["attendee-reviews, no unsubscribe secret", { skipped: "unsubscribe_secret_unconfigured" }],
    [
      "settlements, payments not configured",
      { processed: 0, settled: 0, skipped: "payments_not_configured" },
    ],
  ])("`skipped: \"<why>\"` is `not_run` / unconfirmed (%s)", (_label, result) => {
    expect(classifyRerunResponse(200, wrapped(result))).toEqual({
      outcome: "not_run",
      reason: "unconfirmed",
    });
  });

  it.each([
    ["skipped: false on a real run (memberships)", { skipped: false, refreshed: 4, failed: 0 }],
    ["skipped: \"\"", { skipped: "" }],
    ["skipped: 0", { skipped: 0 }],
    ["skipped: 3 (a count)", { processed: 10, skipped: 3 }],
    ["skipped: null", { skipped: null }],
  ])("%s says nothing: `ran`", (_label, result) => {
    expect(classifyRerunResponse(200, wrapped(result))).toEqual({
      outcome: "ran",
      runId: "run-2",
    });
  });

  it("a returned failure wins over a returned skip", () => {
    expect(
      classifyRerunResponse(200, wrapped({ success: false, skipped: true, reason: "off" })),
    ).toMatchObject({ outcome: "failed", error: { message: "off" } });
  });

  it.each([
    ["{ success: true }", { success: true }],
    ["an object without a verdict", { processed: 3, hasMore: false }],
    ["a falsy-but-not-false success", { success: 0 }],
    ["skipped: false", { skipped: false }],
    ["null", null],
    ["an array", [{ success: false }]],
    ["a string", "success: false"],
    ["a number", 0],
    ["undefined (the handler returned nothing)", undefined],
  ])("result = %s is `ran`", (_label, result) => {
    expect(classifyRerunResponse(200, wrapped(result))).toEqual({
      outcome: "ran",
      runId: "run-2",
    });
  });

  it("the route-level skip and coalesce still win over anything in `result`", () => {
    expect(
      classifyRerunResponse(200, {
        success: false,
        skipped: true,
        reason: "disabled",
        result: { success: false, error: "x" },
      }),
    ).toEqual({ outcome: "not_run", reason: "disabled" });
    expect(
      classifyRerunResponse(200, { success: true, coalesced: true, result: { success: false } }),
    ).toEqual({ outcome: "not_run", reason: "coalesced" });
  });
});

describe("classifyRerunResponse: 2xx from a drain wake-up that absorbed follow-up passes", () => {
  // app.ts rewraps the handler results as { first, coalescedReruns, last }.
  const drained = (first: unknown, last: unknown, coalescedReruns = 2) => ({
    success: true,
    runId: "run-2",
    durationMs: 40,
    result: { first, coalescedReruns, last },
  });
  const fine = { processed: 5, hasMore: false };

  it("both passes fine is `ran`", () => {
    expect(classifyRerunResponse(200, drained(fine, fine))).toEqual({
      outcome: "ran",
      runId: "run-2",
    });
  });

  it("`first` failed is `failed`, with its message", () => {
    expect(
      classifyRerunResponse(200, drained({ success: false, error: "first pass broke" }, fine)),
    ).toEqual({
      outcome: "failed",
      runId: "run-2",
      status: 200,
      error: { message: "first pass broke" },
    });
  });

  it("`last` failed is `failed`, with its message", () => {
    expect(
      classifyRerunResponse(
        200,
        drained(fine, { success: false, reason: "search_not_configured", code: "E_CFG" }),
      ),
    ).toEqual({
      outcome: "failed",
      runId: "run-2",
      status: 200,
      error: { message: "search_not_configured", code: "E_CFG" },
    });
  });

  it("both failed: `first` gives the message", () => {
    expect(
      classifyRerunResponse(
        200,
        drained({ success: false, error: "first" }, { success: false, error: "last" }),
      ),
    ).toMatchObject({ outcome: "failed", error: { message: "first" } });
  });

  it.each([
    ["`last` skipped with a reason string", fine, { skipped: "mailer_unconfigured" }],
    ["`first` skipped with true", { skipped: true, reason: "off" }, fine],
  ])("%s is `not_run` / unconfirmed", (_label, first, last) => {
    expect(classifyRerunResponse(200, drained(first, last))).toEqual({
      outcome: "not_run",
      reason: "unconfirmed",
    });
  });

  it("a failure in one pass wins over a skip in the other", () => {
    expect(
      classifyRerunResponse(
        200,
        drained({ skipped: "mailer_unconfigured" }, { success: false, error: "last broke" }),
      ),
    ).toMatchObject({ outcome: "failed", error: { message: "last broke" } });
  });

  it.each([
    ["null and a string", null, "done"],
    ["arrays", [{ success: false }], [{ skipped: true }]],
    ["numbers", 0, 1],
    ["a missing `last`", fine, undefined],
  ])("`first` / `last` that are not objects (%s) is `ran`", (_label, first, last) => {
    expect(classifyRerunResponse(200, drained(first, last))).toEqual({
      outcome: "ran",
      runId: "run-2",
    });
  });

  describe("a pass that returned undefined loses its key in JSON", () => {
    // JSON.stringify({ first: undefined, coalescedReruns: 1, last }) has no `first`.
    const body = (result: Record<string, unknown>) =>
      JSON.parse(JSON.stringify({ success: true, runId: "run-2", durationMs: 40, result }));

    it("no `first`, failed `last` is `failed`", () => {
      const parsed = body({
        first: undefined,
        coalescedReruns: 1,
        last: { success: false, error: "last pass broke" },
      });
      expect("first" in parsed.result).toBe(false);
      expect(classifyRerunResponse(200, parsed)).toEqual({
        outcome: "failed",
        runId: "run-2",
        status: 200,
        error: { message: "last pass broke" },
      });
    });

    it("no `first`, skipped `last` is `not_run` / unconfirmed", () => {
      expect(
        classifyRerunResponse(
          200,
          body({ first: undefined, coalescedReruns: 1, last: { skipped: "mailer_unconfigured" } }),
        ),
      ).toEqual({ outcome: "not_run", reason: "unconfirmed" });
    });

    it("no `last`, failed `first` is `failed`", () => {
      expect(
        classifyRerunResponse(
          200,
          body({ first: { success: false, error: "first pass broke" }, coalescedReruns: 1, last: undefined }),
        ),
      ).toMatchObject({ outcome: "failed", error: { message: "first pass broke" } });
    });

    it("neither key is `ran`", () => {
      expect(
        classifyRerunResponse(200, body({ first: undefined, coalescedReruns: 1, last: undefined })),
      ).toEqual({ outcome: "ran", runId: "run-2" });
    });
  });

  describe("a plain handler result that happens to carry a numeric `coalescedReruns`", () => {
    it("keeps its own top-level failure", () => {
      expect(
        classifyRerunResponse(200, {
          success: true,
          runId: "run-2",
          result: { success: false, error: "own failure", coalescedReruns: 0 },
        }),
      ).toEqual({
        outcome: "failed",
        runId: "run-2",
        status: 200,
        error: { message: "own failure" },
      });
    });

    it("keeps its own top-level skip", () => {
      expect(
        classifyRerunResponse(200, {
          success: true,
          runId: "run-2",
          result: { skipped: "not_configured", coalescedReruns: 3 },
        }),
      ).toEqual({ outcome: "not_run", reason: "unconfirmed" });
    });

    it("with nothing else to say is `ran`", () => {
      expect(
        classifyRerunResponse(200, {
          success: true,
          runId: "run-2",
          result: { processed: 4, coalescedReruns: 0 },
        }),
      ).toEqual({ outcome: "ran", runId: "run-2" });
    });
  });

  it("without a numeric `coalescedReruns` it is an ordinary result, read at the top level", () => {
    // Not the route's wrapper: `first` here is the job's own business.
    expect(
      classifyRerunResponse(200, {
        success: true,
        runId: "run-2",
        result: { first: { success: false, error: "x" }, last: fine },
      }),
    ).toEqual({ outcome: "ran", runId: "run-2" });
  });
});

describe("classifyRerunResponse: non-2xx", () => {
  it("an unhandled failure carries the code as the message", () => {
    expect(
      classifyRerunResponse(500, { error: "internal_error", runId: "run-2" }),
    ).toEqual({
      outcome: "failed",
      runId: "run-2",
      status: 500,
      error: { message: "internal_error", code: "internal_error" },
    });
  });

  it("a typed failure carries its code and message", () => {
    expect(
      classifyRerunResponse(400, {
        error: "order_not_found",
        runId: "run-2",
        message: "No such order",
      }),
    ).toEqual({
      outcome: "failed",
      runId: "run-2",
      status: 400,
      error: { message: "No such order", code: "order_not_found" },
    });
  });

  it("a blocked run (migration drift) has no run id", () => {
    expect(
      classifyRerunResponse(503, {
        success: false,
        error: "migration_drift",
        job: "demo.job",
        message: "Database is behind this build.",
      }),
    ).toEqual({
      outcome: "failed",
      runId: null,
      status: 503,
      error: { message: "Database is behind this build.", code: "migration_drift" },
    });
  });

  it.each([
    ["a body that was not JSON", undefined],
    ["an empty object", {}],
    ["non-string fields", { error: { nested: true }, message: 42, runId: 7 }],
    ["blank strings", { error: "  ", message: "" }],
  ])("falls back to `HTTP <status>` for %s", (_label, body) => {
    expect(classifyRerunResponse(403, body)).toEqual({
      outcome: "failed",
      runId: null,
      status: 403,
      error: { message: "HTTP 403" },
    });
  });

  it("bounds long error text", () => {
    const result = classifyRerunResponse(400, {
      error: "c".repeat(2000),
      message: "m".repeat(2000),
    });
    expect(result).toMatchObject({ outcome: "failed" });
    if (result.outcome !== "failed") throw new Error("unreachable");
    expect(result.error.message).toBe("m".repeat(500));
    expect(result.error.code).toBe("c".repeat(500));
  });

  it("never copies other body fields (a payload echo) into the error", () => {
    const result = classifyRerunResponse(400, {
      error: "invalid_input",
      runId: "run-2",
      details: [{ received: "s3cr3t" }],
      payload: { secret: "s3cr3t" },
    });
    expect(JSON.stringify(result)).not.toContain("s3cr3t");
    expect(result).toEqual({
      outcome: "failed",
      runId: "run-2",
      status: 400,
      error: { message: "invalid_input", code: "invalid_input" },
    });
  });
});

describe("createDlqRerunJob", () => {
  const CTX = { dlqItemId: "run-1", claimToken: "claim-token-1" };

  // A factory, not a Response: a body can be read once and some tests call twice.
  function setup(respond: () => Response, apiKey?: string | null) {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => respond());
    const rerunJob = createDlqRerunJob({
      selfUrl: "http://localhost:3002",
      apiKey,
      fetch: fetchMock as unknown as typeof fetch,
    });
    return { fetchMock, rerunJob };
  }

  const ok = () =>
    new Response(JSON.stringify({ success: true, runId: "run-2" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  it("POSTs the payload to the run route, naming the entry, without force", async () => {
    const { fetchMock, rerunJob } = setup(ok, "k".repeat(32));

    await expect(
      rerunJob("demo.job", { orderId: "o-1" }, CTX),
    ).resolves.toEqual({ outcome: "ran", runId: "run-2" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://localhost:3002/jobs/demo.job");
    expect(String(url)).not.toContain("force");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify({ orderId: "o-1" }));
    expect(init?.headers).toEqual({
      "Content-Type": "application/json",
      "X-Dlq-Rerun-Of": "run-1",
      "X-Dlq-Rerun-Claim": "claim-token-1",
      Authorization: `Bearer ${"k".repeat(32)}`,
    });
    // The run route reads the headers by these (lower-case) names.
    expect(DLQ_RERUN_OF_HEADER).toBe("x-dlq-rerun-of");
    expect(new Headers(init?.headers).get(DLQ_RERUN_OF_HEADER)).toBe("run-1");
    expect(DLQ_RERUN_CLAIM_HEADER).toBe("x-dlq-rerun-claim");
    expect(new Headers(init?.headers).get(DLQ_RERUN_CLAIM_HEADER)).toBe("claim-token-1");
    // The token travels in a header only, never in the URL or the body.
    expect(String(url) + String(init?.body)).not.toContain("claim-token-1");
  });

  it("sends no Authorization header when no API key is set", async () => {
    const { fetchMock, rerunJob } = setup(ok, null);
    await rerunJob("demo.job", {}, CTX);

    expect(fetchMock.mock.calls[0]![1]?.headers).toEqual({
      "Content-Type": "application/json",
      "X-Dlq-Rerun-Of": "run-1",
      "X-Dlq-Rerun-Claim": "claim-token-1",
    });
  });

  it("a queue name cannot add a query string or a path segment", async () => {
    const { fetchMock, rerunJob } = setup(ok);
    await rerunJob("demo.job?force=true", {}, CTX);
    await rerunJob("a/b", {}, CTX);

    expect(fetchMock.mock.calls[0]![0]).toBe(
      "http://localhost:3002/jobs/demo.job%3Fforce%3Dtrue",
    );
    expect(fetchMock.mock.calls[1]![0]).toBe("http://localhost:3002/jobs/a%2Fb");
  });

  it("sends `{}` for an entry stored without a payload", async () => {
    const { fetchMock, rerunJob } = setup(ok);
    await rerunJob("demo.job", undefined, CTX);

    expect(fetchMock.mock.calls[0]![1]?.body).toBe("{}");
  });

  it("a paused job's 200 is not a run", async () => {
    const { rerunJob } = setup(
      () =>
        new Response(JSON.stringify({ success: false, skipped: true, reason: "disabled" }), {
          status: 200,
        }),
    );
    await expect(rerunJob("demo.job", {}, CTX)).resolves.toEqual({
      outcome: "not_run",
      reason: "disabled",
    });
  });

  it("a 2xx body that is not JSON is unconfirmed", async () => {
    const { rerunJob } = setup(() => new Response("OK", { status: 200 }));
    await expect(rerunJob("demo.job", {}, CTX)).resolves.toEqual({
      outcome: "not_run",
      reason: "unconfirmed",
    });
  });

  it("a failed run is `failed` with the run route's status and error", async () => {
    const { rerunJob } = setup(
      () =>
        new Response(JSON.stringify({ error: "internal_error", runId: "run-2" }), { status: 500 }),
    );
    await expect(rerunJob("demo.job", {}, CTX)).resolves.toEqual({
      outcome: "failed",
      runId: "run-2",
      status: 500,
      error: { message: "internal_error", code: "internal_error" },
    });
  });

  it("a non-JSON error page is `failed` from the status alone", async () => {
    const { rerunJob } = setup(() => new Response("<html>Forbidden</html>", { status: 403 }));
    await expect(rerunJob("demo.job", {}, CTX)).resolves.toEqual({
      outcome: "failed",
      runId: null,
      status: 403,
      error: { message: "HTTP 403" },
    });
  });

  describe("a 5xx that is not the jobs service's own answer: nothing is known about the run", () => {
    // Cloud Run's front end answers 504 past its 300s cap while the handler
    // behind it keeps running; a load balancer's 502/503 are pages too.
    it.each([
      [504, "upstream request timeout"],
      [502, "<html><title>502 Bad Gateway</title></html>"],
      [503, "Service Unavailable"],
      [500, "<html>Internal Server Error</html>"],
      [504, ""],
    ])("HTTP %i with a non-JSON body throws DlqRerunNoAnswerError", async (status, body) => {
      const { rerunJob } = setup(() => new Response(body, { status }));
      const err = await rerunJob("demo.job", {}, CTX).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(DlqRerunNoAnswerError);
      expect(isDlqRerunNoAnswer(err)).toBe(true);
      expect((err as DlqRerunNoAnswerError).runRouteStatus).toBe(status);
      // Not `status`: Fastify's error handler would answer with it.
      expect(err).not.toHaveProperty("status");
      expect(err).not.toHaveProperty("statusCode");
      expect((err as Error).message).toBe(
        `The run route gave no answer of its own (HTTP ${status}), so whether the job ran is not known.`,
      );
    });

    it("JSON without a string `error` code is not the jobs service's answer either", async () => {
      const { rerunJob } = setup(
        () => new Response(JSON.stringify({ message: "upstream timed out" }), { status: 504 }),
      );
      await expect(rerunJob("demo.job", {}, CTX)).rejects.toBeInstanceOf(DlqRerunNoAnswerError);
    });

    it("the jobs service's own migration-drift 503 still resolves `failed`, run never started", async () => {
      const { rerunJob } = setup(
        () =>
          new Response(
            JSON.stringify({
              success: false,
              error: "migration_drift",
              job: "demo.job",
              message: "Database is missing migrations this build requires.",
            }),
            { status: 503 },
          ),
      );
      await expect(rerunJob("demo.job", {}, CTX)).resolves.toEqual({
        outcome: "failed",
        runId: null,
        status: 503,
        error: {
          message: "Database is missing migrations this build requires.",
          code: "migration_drift",
        },
      });
    });

    it("the jobs service's own module-load 503 still resolves `failed`", async () => {
      const { rerunJob } = setup(
        () =>
          new Response(
            JSON.stringify({ error: "JOB_MODULE_LOAD_FAILED", runId: "run-9", message: "boom" }),
            { status: 503 },
          ),
      );
      await expect(rerunJob("demo.job", {}, CTX)).resolves.toEqual({
        outcome: "failed",
        runId: "run-9",
        status: 503,
        error: { message: "boom", code: "JOB_MODULE_LOAD_FAILED" },
      });
    });

    it("Fastify's own 500 answer (`{ statusCode, error, message }`) still resolves `failed`", async () => {
      const { rerunJob } = setup(
        () =>
          new Response(
            JSON.stringify({ statusCode: 500, error: "Internal Server Error", message: "boom" }),
            { status: 500 },
          ),
      );
      await expect(rerunJob("demo.job", {}, CTX)).resolves.toMatchObject({
        outcome: "failed",
        runId: null,
        status: 500,
      });
    });
  });

  it("isDlqRerunNoAnswer recognises the error by its brand, not its class", () => {
    const lookalike = Object.assign(new Error("x"), {
      name: "DlqRerunNoAnswerError",
      runRouteStatus: 504,
    });
    expect(isDlqRerunNoAnswer(lookalike)).toBe(true);
    expect(isDlqRerunNoAnswer(new TypeError("fetch failed"))).toBe(false);
    expect(isDlqRerunNoAnswer({ name: "DlqRerunNoAnswerError", runRouteStatus: 504 })).toBe(false);
  });

  it("a rejected fetch propagates", async () => {
    const rerunJob = createDlqRerunJob({
      selfUrl: "http://localhost:3002/",
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });
    await expect(rerunJob("demo.job", {}, CTX)).rejects.toThrow("fetch failed");
  });
});
