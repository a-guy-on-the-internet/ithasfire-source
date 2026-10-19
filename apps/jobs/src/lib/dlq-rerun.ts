import type { RerunJobRunOutcome } from "@th/ports/job-diagnostics";

/**
 * Rerunning a dead-letter entry: the request back to the run route, and how
 * its answer is read.
 *
 * The run route (`POST /jobs/:name` in app.ts) answers 200 for anything that
 * does not throw. A paused job answers `200 { success: false, skipped: true }`
 * and a drain wake-up folded into a running drain answers
 * `200 { success: true, coalesced: true }`, so a 2xx alone never shows that
 * the work ran. Only `success: true` with neither flag does, and only that
 * lets the DLQ entry be deleted.
 *
 * `success: true` is the ROUTE's word, not the job's: the route wraps whatever
 * the handler returned as `{ success: true, runId, durationMs, result }`.
 * A handler whose work fails throws, and the route answers non-2xx. But a
 * RETURNED value can still say the work was not done: a computed flag (the
 * multi-document search jobs and lineup-notices return
 * `{ success: result.errors.length === 0, result }` and the like), or a "not
 * configured" answer (`{ success: false, reason }`, `{ skipped: true, reason }`,
 * `{ skipped: "<why>" }`). Neither is a run that did the work, so `result` is
 * read too (`handlerVerdict`), and `{ success: false, error }` is read the same
 * way whoever returns it. The reading leans toward keeping the entry: a kept
 * entry costs a click, a deleted one cannot be brought back.
 *
 * No env import here on purpose: app.ts imports this module in unit tests
 * where the environment is not set up.
 */

/**
 * Request header naming the DLQ entry a run is a rerun of. When that run
 * fails, the run route rewrites the named entry instead of pushing a second
 * one. Lower-case, as Node reports incoming header names.
 */
export const DLQ_RERUN_OF_HEADER = "x-dlq-rerun-of";

/**
 * Request header carrying the rerun claim token (the adapter's
 * `rerunFromDLQ` holds a claim on the entry while the rerun runs). The run
 * route honours `X-Dlq-Rerun-Of` only when this token is the live claim on the
 * named entry: a caller that hits the run route directly with that header
 * alone gets an entry of its own, like any failed run, and cannot rewrite
 * someone else's. Lower-case, as Node reports incoming header names.
 */
export const DLQ_RERUN_CLAIM_HEADER = "x-dlq-rerun-claim";

/** Cap on error text carried out of a run-route response. */
const MAX_ERROR_TEXT = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text.length > 0 ? text.slice(0, MAX_ERROR_TEXT) : undefined;
}

function runIdOf(body: Record<string, unknown> | null): string | null {
  return boundedText(body?.runId) ?? null;
}

/** Message for a job that returned `success: false` with no text of its own. */
const JOB_REPORTED_FAILURE = "The job reported that it did not succeed.";

/** What a handler's returned value says about its own run; null = nothing. */
type HandlerVerdict =
  | { kind: "failed"; error: { message: string; code?: string } }
  | { kind: "skipped" }
  | null;

/**
 * `skipped: true` (memberships) and `skipped: "<why>"` (attendee-reviews,
 * settlements) both mean the work was not done. `skipped: false` is what a
 * real run returns, and an empty string or a number says nothing.
 */
function saysSkipped(value: unknown): boolean {
  return value === true || (typeof value === "string" && value.length > 0);
}

/** The verdict of ONE handler result. A failure wins over a skip. */
function verdictOfOne(result: unknown): HandlerVerdict {
  if (!isRecord(result)) return null;
  if (result.success === false) {
    const message =
      boundedText(result.error) ??
      boundedText(result.reason) ??
      boundedText(result.message) ??
      JOB_REPORTED_FAILURE;
    const code = boundedText(result.code);
    return { kind: "failed", error: code ? { message, code } : { message } };
  }
  return saysSkipped(result.skipped) ? { kind: "skipped" } : null;
}

/**
 * The verdict of the run route's `result`.
 *
 * Usually that is the handler's returned value. A drain wake-up that absorbed
 * follow-up passes is rewrapped by the route as
 * `{ first: <result>, coalescedReruns: <n>, last: <result> }`, so there the
 * verdict is also read from `first` and `last`.
 *
 * The wrapper is recognised by a numeric `coalescedReruns` ALONE: a pass that
 * returned `undefined` loses its key in JSON, so `first` (or `last`) can be
 * missing from a real wrapper. The top level is read in every case, so a
 * plain handler result that happens to carry a numeric `coalescedReruns`
 * keeps its own verdict. A failure anywhere wins (top level, then `first`,
 * then `last`), then a skip anywhere.
 */
function handlerVerdict(result: unknown): HandlerVerdict {
  const verdicts = [verdictOfOne(result)];
  if (isRecord(result) && typeof result.coalescedReruns === "number") {
    verdicts.push(verdictOfOne(result.first), verdictOfOne(result.last));
  }
  return (
    verdicts.find((verdict) => verdict?.kind === "failed") ??
    verdicts.find((verdict) => verdict?.kind === "skipped") ??
    null
  );
}

/**
 * Read the run route's answer (HTTP status and parsed JSON body; pass
 * `undefined` for a body that was not JSON).
 *
 * The error of a `failed` outcome is built from string fields only: the
 * body's `error` code and `message` for a non-2xx, and the handler result's
 * `error`, `reason`, `message` and `code` for a 2xx whose job reported its
 * own failure (see `handlerVerdict`). Nothing else in the body is read, so a request payload echoed
 * back by the route can never land in the message.
 */
export function classifyRerunResponse(
  status: number,
  body: unknown,
): RerunJobRunOutcome {
  const json = isRecord(body) ? body : null;

  if (status >= 200 && status < 300) {
    if (!json) return { outcome: "not_run", reason: "unconfirmed" };
    if (json.skipped === true) {
      return {
        outcome: "not_run",
        reason: json.reason === "disabled" ? "disabled" : "unconfirmed",
      };
    }
    if (json.coalesced === true) {
      return { outcome: "not_run", reason: "coalesced" };
    }
    if (json.success !== true) {
      return { outcome: "not_run", reason: "unconfirmed" };
    }

    // The handler's own verdict, when it returned one.
    const verdict = handlerVerdict(json.result);
    if (verdict?.kind === "failed") {
      return {
        outcome: "failed",
        runId: runIdOf(json),
        status,
        error: verdict.error,
      };
    }
    if (verdict?.kind === "skipped") {
      return { outcome: "not_run", reason: "unconfirmed" };
    }
    return { outcome: "ran", runId: runIdOf(json) };
  }

  const code = boundedText(json?.error);
  const message = boundedText(json?.message) ?? code ?? `HTTP ${status}`;
  return {
    outcome: "failed",
    runId: runIdOf(json),
    status,
    error: code ? { message, code } : { message },
  };
}

/**
 * True when a non-2xx body is the jobs service's own answer: a JSON object
 * with a string `error` code. Every 4xx/5xx the jobs service sends has one:
 * the run route's own (`migration_drift`, `JOB_MODULE_LOAD_FAILED`,
 * `internal_error`, `unauthorized`), and Fastify's default error and
 * closing-server answers (`{ statusCode, error, message }`).
 */
export function isJobsServiceErrorBody(body: unknown): boolean {
  return isRecord(body) && typeof body.error === "string";
}

/**
 * The run route's request came back with a 5xx that is not the jobs
 * service's own answer (see `isJobsServiceErrorBody`): a gateway's page, such
 * as Cloud Run's 504 when `JOBS_SELF_URL` points through Cloud Run and the
 * request passes its 300s cap. In production the self-call is loopback, so
 * no gateway sits in the hop; there a long run ends in fetch's own header
 * timeout, which throws and also keeps the claim. The gateway gave up
 * on the request; the handler behind it may still be running the job. So this
 * is not "the run failed" and not "it never started": nothing is known about
 * the run.
 *
 * Thrown, not returned, so the adapter treats it like a request that broke
 * off: the rerun claim is kept and expires by its TTL, and nobody can start a
 * second run beside one that may still be going. The rerun route catches it
 * by `isDlqRerunNoAnswer` (a brand, not `instanceof`: module instances can
 * differ under test module resets). The message carries the status only.
 */
export class DlqRerunNoAnswerError extends Error {
  /**
   * The gateway's HTTP status. Not named `status` or `statusCode`: Fastify's
   * error handler answers with either one, and the rerun route's answer for
   * this is its backstop's 500, not the gateway's code.
   */
  readonly runRouteStatus: number;

  constructor(runRouteStatus: number) {
    super(
      `The run route gave no answer of its own (HTTP ${runRouteStatus}), so whether the job ran is not known.`,
    );
    this.name = "DlqRerunNoAnswerError";
    this.runRouteStatus = runRouteStatus;
  }
}

export function isDlqRerunNoAnswer(err: unknown): err is DlqRerunNoAnswerError {
  return (
    err instanceof Error &&
    err.name === "DlqRerunNoAnswerError" &&
    typeof (err as { runRouteStatus?: unknown }).runRouteStatus === "number"
  );
}

export type DlqRerunJobOptions = {
  /** Base URL of this jobs service (`JOBS_SELF_URL`, or localhost in dev). */
  selfUrl: string;
  /** `JOBS_API_KEY`; sent as the bearer token when set, as `enqueue` does. */
  apiKey?: string | null;
  /** Test seam. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
};

/**
 * Build the `rerunJob` callback for `RedisJobDiagnosticsAdapter`.
 *
 * It POSTs the payload to the run route and classifies the answer. Never with
 * `?force=true`: a paused job stays paused, and the run route alone decides
 * what "paused" means. A rejected fetch propagates to the caller, and so
 * does a 5xx that is not the jobs service's own answer
 * (`DlqRerunNoAnswerError`): neither shows that the run ended. A 5xx that IS
 * the jobs service's own (a migration-drift 503, a module that would not load,
 * a failed run) is classified like any other answer.
 */
export function createDlqRerunJob(options: DlqRerunJobOptions) {
  const base = options.selfUrl.replace(/\/+$/, "");

  return async (
    queue: string,
    payload: unknown,
    ctx: { dlqItemId: string; claimToken: string },
  ): Promise<RerunJobRunOutcome> => {
    const fetchImpl = options.fetch ?? fetch;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Dlq-Rerun-Of": ctx.dlqItemId,
      "X-Dlq-Rerun-Claim": ctx.claimToken,
    };
    if (options.apiKey) {
      headers["Authorization"] = `Bearer ${options.apiKey}`;
    }

    // Encoded so a queue name can never add a path segment or a query string
    // (`?force=true`) to the run-route URL.
    const res = await fetchImpl(`${base}/jobs/${encodeURIComponent(queue)}`, {
      method: "POST",
      headers,
      // A run stored without a body reads back as undefined; the run route
      // treats a missing body as `{}`.
      body: JSON.stringify(payload ?? {}),
    });

    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      // Not JSON: classified from the status alone.
      body = undefined;
    }
    if (res.status >= 500 && !isJobsServiceErrorBody(body)) {
      throw new DlqRerunNoAnswerError(res.status);
    }
    return classifyRerunResponse(res.status, body);
  };
}
