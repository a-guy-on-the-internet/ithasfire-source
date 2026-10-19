import { createHash } from "node:crypto";

import { GoogleAuth } from "google-auth-library";

import type { LineupSweepContinuation } from "@th/core/use-cases/event-humans/_shared/lineup-sweep-continuation";
import type { SearchReindexDrainTrigger } from "@th/core/use-cases/search/search-reindex-marks";
import {
  ScheduleNotSentError,
  type DelayedJobSchedulerPort,
  type ScheduleJobOnceInput,
  type ScheduleJobOnceResult,
} from "@th/ports/delayed-jobs";

/**
 * `DelayedJobSchedulerPort` on Cloud Tasks: one HTTP task per run, delivered
 * at `scheduleTime` to `POST <jobsServiceUrl>/jobs/<jobName>` with a Google
 * OIDC token (Cloud Run IAM + the jobs service's JWT path both accept it).
 *
 * WHY CLOUD TASKS: it delivers LATER without anyone polling. Pub/Sub cannot
 * delay a message, and a Redis/Postgres "due work" table would need a poller —
 * the exact thing the edit-triggered reindex exists to avoid.
 *
 * DEDUPE is the task NAME. The task id is derived from `dedupeKey`, so a
 * second create for the same key answers 409 ALREADY_EXISTS, reported here as
 * `duplicate`. Cloud Tasks also refuses a name for ~1h after its task ran or
 * was deleted; callers key per time slot, so a key is never meant to be
 * reused.
 *
 * Infra this needs (NOT created by this module): the queue, the
 * `cloudtasks.googleapis.com` API, `roles/cloudtasks.enqueuer` for the
 * calling service account, `roles/iam.serviceAccountUser` on the OIDC
 * service account for that caller, and `roles/run.invoker` on the jobs
 * service for the OIDC service account.
 */
export type CloudTasksSchedulerOptions = {
  /** `projects/<project>/locations/<region>/queues/<queue>` */
  queuePath: string;
  /** Jobs service base URL; also the OIDC audience. */
  jobsServiceUrl: string;
  /** Service account whose OIDC token the task carries. */
  invokerServiceAccountEmail: string;
  /**
   * How long Cloud Tasks waits for the job's HTTP answer. Default and cap
   * 300s (the jobs service's request timeout); the drain budgets itself at
   * 120s of work.
   */
  dispatchDeadlineSeconds?: number;
  /** Test seam. Defaults to ADC (metadata server on Cloud Run). */
  getAccessToken?: () => Promise<string | null | undefined>;
  /** Test seam. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout. Default 3s (callers await this inside a request). */
  timeoutMs?: number;
  /**
   * Budget for getting the access token, BEFORE the request. Default 1.5s.
   * See {@link CLOUD_TASKS_DEFAULT_TOKEN_TIMEOUT_MS}.
   */
  tokenTimeoutMs?: number;
  /**
   * Fetch the access token once at construction so the first scheduleOnce
   * finds it cached. Default: on for the real ADC source, OFF when
   * `getAccessToken` is injected (a test seam would see an extra call).
   */
  warmAccessToken?: boolean;
};

const CLOUD_TASKS_API = "https://cloudtasks.googleapis.com/v2";
/**
 * Cloud Run's request timeout on the jobs service is 300s; a longer dispatch
 * deadline would only let Cloud Tasks wait on a request Cloud Run already cut.
 */
const MAX_DISPATCH_DEADLINE_S = 300;
const DEFAULT_DISPATCH_DEADLINE_S = MAX_DISPATCH_DEADLINE_S;
/** Default per-request timeout on the create call. */
export const CLOUD_TASKS_DEFAULT_TIMEOUT_MS = 3_000;
/**
 * Default budget for the access token. On Cloud Run that is a metadata-server
 * call, normally cached and instant, but it has no timeout of its own, and a
 * stalled one used to run OUTSIDE every budget: the lineup sweep's caller
 * (`LINEUP_SWEEP_SCHEDULE_TIMEOUT_MS`, 5s in core) then timed out first and
 * read a task that was never sent as "may exist" — and never retried it.
 * Token (1.5s) + request (3s) = 4.5s, inside that 5s with a margin, so the
 * caller always sees this adapter's own answer.
 *
 * COLD START. The FIRST token on a fresh instance is the slow one:
 * `GoogleAuth.getClient()` detects the environment, then asks the metadata
 * server — easily past 1.5s on a cold instance, which would fail the first
 * search drain or lineup hop as not-sent. So the constructor WARMS the token
 * (`warmAccessToken`): schedulers are built once at boot (api buildDeps, jobs
 * buildContainer, better-auth module load), and the first hop comes long
 * after — a lineup continuation only after the publish sweep's ~10s budget.
 * A hop that arrives while the warm-up is still in flight joins it rather
 * than starting a second cold fetch; if that warm-up then fails, the hop
 * fetches once on its own, inside the same 1.5s.
 */
export const CLOUD_TASKS_DEFAULT_TOKEN_TIMEOUT_MS = 1_500;

/**
 * Task id for a dedupe key: `[A-Za-z0-9_-]`, at most 500 chars. A short hash
 * prefix spreads sequential (time-slot) keys across Cloud Tasks' keyspace, as
 * its docs recommend for high-throughput queues, and makes the id unique even
 * after the key is sanitized.
 */
export function cloudTaskIdFor(dedupeKey: string): string {
  const hash = createHash("sha256")
    .update(dedupeKey)
    .digest("hex")
    .slice(0, 12);
  const safe = dedupeKey.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 400);
  return `${hash}-${safe}`;
}

export class CloudTasksScheduler implements DelayedJobSchedulerPort {
  private readonly options: CloudTasksSchedulerOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly getAccessToken: () => Promise<string | null | undefined>;
  /** The warm-up's fetch while it is in flight; see `warmAccessToken`. */
  private pendingWarmToken: Promise<string | null | undefined> | undefined;

  constructor(options: CloudTasksSchedulerOptions) {
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? fetch;
    if (options.getAccessToken) {
      this.getAccessToken = options.getAccessToken;
    } else {
      // One GoogleAuth per instance: it caches and refreshes the token.
      const auth = new GoogleAuth({
        scopes: ["https://www.googleapis.com/auth/cloud-platform"],
      });
      this.getAccessToken = async () => {
        const client = await auth.getClient();
        return (await client.getAccessToken())?.token;
      };
    }
    if (options.warmAccessToken ?? !options.getAccessToken) {
      this.warmAccessToken();
    }
  }

  /** Fire-and-forget; never throws, never rejects unhandled. */
  private warmAccessToken(): void {
    let fetching: Promise<string | null | undefined>;
    try {
      fetching = this.getAccessToken();
    } catch {
      return;
    }
    const warm = fetching.finally(() => {
      if (this.pendingWarmToken === warm) this.pendingWarmToken = undefined;
    });
    this.pendingWarmToken = warm;
    // Ignored on purpose, and NOT a swallow site needing reportError: the
    // warm-up only saves time. If the token cannot be had, the real
    // scheduleOnce fails on its own fetch, and that failure is thrown to the
    // caller and reported there.
    warm.catch(() => {});
  }

  async scheduleOnce(
    input: ScheduleJobOnceInput,
  ): Promise<ScheduleJobOnceResult> {
    // Everything before the fetch fails as ScheduleNotSentError: the task was
    // certainly not created, and the caller may retry without risking a
    // second one.
    const token = await this.accessTokenWithin(
      this.options.tokenTimeoutMs ?? CLOUD_TASKS_DEFAULT_TOKEN_TIMEOUT_MS,
    );

    const base = this.options.jobsServiceUrl.replace(/\/+$/, "");
    const taskName = `${this.options.queuePath}/tasks/${cloudTaskIdFor(input.dedupeKey)}`;
    const body = {
      task: {
        name: taskName,
        scheduleTime: input.runAt.toISOString(),
        dispatchDeadline: `${Math.min(
          this.options.dispatchDeadlineSeconds ?? DEFAULT_DISPATCH_DEADLINE_S,
          MAX_DISPATCH_DEADLINE_S,
        )}s`,
        httpRequest: {
          httpMethod: "POST",
          url: `${base}/jobs/${encodeURIComponent(input.jobName)}`,
          headers: { "Content-Type": "application/json" },
          body: Buffer.from(JSON.stringify(input.payload ?? {})).toString(
            "base64",
          ),
          oidcToken: {
            serviceAccountEmail: this.options.invokerServiceAccountEmail,
            audience: base,
          },
        },
      },
    };

    const res = await this.fetchImpl(
      `${CLOUD_TASKS_API}/${this.options.queuePath}/tasks`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        signal: AbortSignal.timeout(
          this.options.timeoutMs ?? CLOUD_TASKS_DEFAULT_TIMEOUT_MS,
        ),
        body: JSON.stringify(body),
      },
    );
    if (res.ok) return { status: "scheduled" };
    // ALREADY_EXISTS: a task with this name is queued, or ran within ~1h.
    if (res.status === 409) return { status: "duplicate" };
    const text = await res.text().catch(() => "");
    throw new Error(
      `cloud_tasks_create_failed: ${res.status} ${text.slice(0, 300)}`,
    );
  }

  private async accessTokenWithin(budgetMs: number): Promise<string> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let expired = false;
    let token: string | null | undefined;
    const joined = this.pendingWarmToken;
    const fetchToken = async () => {
      if (!joined) return this.getAccessToken();
      try {
        return await joined;
      } catch (error) {
        // The warm-up this hop joined failed (a transient metadata-server
        // error, say) — not this hop's own attempt, so it gets ONE fetch of
        // its own, inside the same deadline. A hop's own fetch failing is
        // not retried.
        if (expired) throw error;
        // Dropping the warm-up's error on a successful retry is deliberate: this is a retry, not a degraded fallback, so no reportError.
        return this.getAccessToken();
      }
    };
    try {
      token = await Promise.race([
        fetchToken(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            expired = true;
            reject(
              new ScheduleNotSentError(
                `cloud_tasks_access_token_timeout: no token within ${budgetMs}ms`,
              ),
            );
          }, budgetMs);
        }),
      ]);
    } catch (error) {
      if (error instanceof ScheduleNotSentError) throw error;
      throw new ScheduleNotSentError("cloud_tasks_access_token_failed", {
        cause: error,
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!token) throw new ScheduleNotSentError("cloud_tasks_no_access_token");
    return token;
  }
}

export type SearchReindexDrainEnv = {
  /** `projects/<project>/locations/<region>/queues/<queue>`. Unset = off. */
  CLOUD_TASKS_QUEUE?: string;
  /** OIDC service account the tasks carry. Unset = off. */
  CLOUD_TASKS_INVOKER_SA?: string;
  JOBS_SERVICE_URL?: string;
  /** Earliest drain after an edit, seconds (core default 60, floor 30). */
  SEARCH_REINDEX_DRAIN_DELAY_S?: number;
  /** Width of the slot edits share one drain in, seconds (core default 30). */
  SEARCH_REINDEX_DRAIN_WINDOW_S?: number;
};

/**
 * The drain trigger when Cloud Tasks is configured, else `null` (marks still
 * commit; leftovers wait for the nightly full reindex). The queue and invoker
 * come from Terraform; nothing here polls.
 */
export function createSearchReindexDrainTrigger(
  env: SearchReindexDrainEnv,
): SearchReindexDrainTrigger | null {
  if (!env.CLOUD_TASKS_QUEUE || !env.CLOUD_TASKS_INVOKER_SA) return null;
  if (!env.JOBS_SERVICE_URL) return null;
  return {
    scheduler: new CloudTasksScheduler({
      queuePath: env.CLOUD_TASKS_QUEUE,
      jobsServiceUrl: env.JOBS_SERVICE_URL,
      invokerServiceAccountEmail: env.CLOUD_TASKS_INVOKER_SA,
    }),
    ...(env.SEARCH_REINDEX_DRAIN_DELAY_S !== undefined
      ? { minDelayMs: env.SEARCH_REINDEX_DRAIN_DELAY_S * 1000 }
      : {}),
    ...(env.SEARCH_REINDEX_DRAIN_WINDOW_S !== undefined
      ? { windowMs: env.SEARCH_REINDEX_DRAIN_WINDOW_S * 1000 }
      : {}),
  };
}

export type LineupSweepContinuationEnv = {
  /**
   * The DEDICATED queue for `lineup-notices.continue-sweep`,
   * `projects/<project>/locations/<region>/queues/<queue>`
   * (infra/terraform/lineup-notice-sweep.tf). Unset = use the fallback.
   */
  CLOUD_TASKS_LINEUP_SWEEP_QUEUE?: string;
  /** OIDC service account the tasks carry. Shared with the search drain. */
  CLOUD_TASKS_INVOKER_SA?: string;
  /**
   * Jobs service base URL, and the tasks' OIDC audience. The API passes
   * JOBS_SERVICE_URL; the jobs service passes SEARCH_DRAIN_TARGET_URL — NOT
   * JOBS_SELF_URL, which is the API-key self-enqueue base (apps/jobs/src/lib/env.ts).
   */
  JOBS_SERVICE_URL?: string;
};

/**
 * `LineupSweepContinuation` on the dedicated lineup-sweep queue when one is
 * configured, else on `fallbackScheduler`, else null.
 *
 * WHY A FALLBACK AND NOT NULL. Continuations shipped on the search-drain
 * queue (`CLOUD_TASKS_QUEUE`), which is pinned to one dispatch at a time for
 * a reason that belongs to search drains alone (overlapping drains read the
 * same marks). The dedicated queue fixes that — but it arrives with a
 * terraform apply, not with this code, so every revision in between has no
 * `CLOUD_TASKS_LINEUP_SWEEP_QUEUE`. Falling back to the search-drain
 * scheduler keeps exactly the behaviour those revisions already had: worse
 * isolation, continuations still running. Returning null instead would make
 * an overflowing publish report its leftover rows and leave them for a future
 * publish of the event, which usually never comes.
 *
 * Pass `null` as the fallback only where there is genuinely no scheduler at
 * all (no Cloud Tasks configured); the caller then gets null and the sweep
 * degrades to that reported-and-waiting behaviour on purpose.
 */
export function createLineupSweepContinuation(
  env: LineupSweepContinuationEnv,
  fallbackScheduler: DelayedJobSchedulerPort | null,
  /**
   * Test seams, forwarded verbatim to `CloudTasksScheduler` (same two it
   * documents). Composition roots pass nothing; a test passes them so it can
   * observe the OUTBOUND task and prove which queue this built — an
   * `instanceof` check cannot tell a right queue path from a transposed one.
   */
  seams?: Pick<CloudTasksSchedulerOptions, "getAccessToken" | "fetchImpl">,
): LineupSweepContinuation | null {
  if (
    env.CLOUD_TASKS_LINEUP_SWEEP_QUEUE &&
    env.CLOUD_TASKS_INVOKER_SA &&
    env.JOBS_SERVICE_URL
  ) {
    return {
      scheduler: new CloudTasksScheduler({
        queuePath: env.CLOUD_TASKS_LINEUP_SWEEP_QUEUE,
        jobsServiceUrl: env.JOBS_SERVICE_URL,
        invokerServiceAccountEmail: env.CLOUD_TASKS_INVOKER_SA,
        ...(seams ?? {}),
      }),
    };
  }
  return fallbackScheduler ? { scheduler: fallbackScheduler } : null;
}

export type TaxRateFillSchedulerEnv = {
  /**
   * The DEDICATED queue for `tax.fill-location-rate`,
   * `projects/<project>/locations/<region>/queues/<queue>`
   * (infra/terraform/tax-rate-fill.tf). Unset = no scheduler.
   */
  CLOUD_TASKS_TAX_FILL_QUEUE?: string;
  /** OIDC service account the tasks carry. Shared with the search drain. */
  CLOUD_TASKS_INVOKER_SA?: string;
  /**
   * Jobs service base URL, and the tasks' OIDC audience. The API passes
   * JOBS_SERVICE_URL; the jobs service passes SEARCH_DRAIN_TARGET_URL (same
   * reason as {@link LineupSweepContinuationEnv}).
   */
  JOBS_SERVICE_URL?: string;
};

/**
 * The scheduler for background venue tax-rate fills, on their OWN queue, or
 * null.
 *
 * NO FALLBACK, unlike {@link createLineupSweepContinuation}. The search-drain
 * queue is pinned to one dispatch at a time; during a ZipTax error spell a
 * busy listing page would park hundreds of ~10s failing lookups ahead of
 * every drain. A missing fill costs little by comparison: the listing card
 * says "See details", and the venue fills on its next checkout, event-page
 * quote, or the nightly reindex's listing pass once the queue exists.
 */
export function createTaxRateFillScheduler(
  env: TaxRateFillSchedulerEnv,
  /** Test seams, forwarded verbatim to `CloudTasksScheduler`. */
  seams?: Pick<CloudTasksSchedulerOptions, "getAccessToken" | "fetchImpl">,
): DelayedJobSchedulerPort | null {
  if (
    !env.CLOUD_TASKS_TAX_FILL_QUEUE ||
    !env.CLOUD_TASKS_INVOKER_SA ||
    !env.JOBS_SERVICE_URL
  ) {
    return null;
  }
  return new CloudTasksScheduler({
    queuePath: env.CLOUD_TASKS_TAX_FILL_QUEUE,
    jobsServiceUrl: env.JOBS_SERVICE_URL,
    invokerServiceAccountEmail: env.CLOUD_TASKS_INVOKER_SA,
    ...(seams ?? {}),
  });
}
