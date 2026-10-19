import { TRPCError } from "@trpc/server";
import type { HumanRole } from "@th/ports/authz";
import {
  rerunJobFromDlqResultSchema,
  rerunNotRunReasonSchema,
  type RerunJobFromDlqResult,
} from "@th/ports/job-diagnostics";
import { z } from "zod";

import { authedProcedure } from "../init";

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────

const PLATFORM_STAFF_ROLES: HumanRole[] = [
  "ADMIN",
  "REVIEWER",
  "SUPPORT",
  "DEVELOPER",
];

/** Ensure the caller is an authenticated staff member and the jobs service is configured. */
async function requireStaffAndJobsUrl(ctx: {
  actorHumanId: string | null;
  authz: {
    hasStaffRole: (input: {
      actorHumanId: string;
      requiredRoles: HumanRole[];
    }) => Promise<{ allowed: boolean }>;
  };
  jobsServiceUrl?: string | null;
}): Promise<string> {
  if (!ctx.actorHumanId) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Missing actor" });
  }
  const { allowed } = await ctx.authz.hasStaffRole({
    actorHumanId: ctx.actorHumanId,
    requiredRoles: PLATFORM_STAFF_ROLES,
  });
  if (!allowed) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Staff access required",
    });
  }
  if (!ctx.jobsServiceUrl) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Jobs service URL not configured",
    });
  }
  return ctx.jobsServiceUrl;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cloud Run service-to-service auth helper
// ─────────────────────────────────────────────────────────────────────────────

const METADATA_URL = "http://metadata.google.internal/computeMetadata/v1";
const METADATA_HEADERS = { "Metadata-Flavor": "Google" };

/**
 * On Cloud Run, fetch an OIDC identity token for the given audience from the
 * metadata server. Returns `null` when not running on GCP (local dev).
 */
async function fetchIdToken(audience: string): Promise<string | null> {
  try {
    const res = await fetch(
      `${METADATA_URL}/instance/service-accounts/default/identity?audience=${encodeURIComponent(audience)}`,
      { headers: METADATA_HEADERS },
    );
    if (!res.ok) return null;
    return (await res.text()).trim();
  } catch {
    // Not on GCP — local dev
    return null;
  }
}

/**
 * Send a request to the jobs service with the service-to-service auth headers.
 * Returns the raw response, whatever its status; throws a tRPC error only when
 * the service cannot be reached.
 */
async function jobsRequest(
  baseUrl: string,
  path: string,
  init?: RequestInit,
): Promise<{ url: string; res: Response }> {
  const apiKey = process.env.JOBS_API_KEY ?? null;
  const url = `${baseUrl}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(init?.headers as Record<string, string>),
  };
  if (apiKey) {
    // Send the API key in a dedicated header so it doesn't collide with
    // Google OIDC tokens that Cloud Run expects in the Authorization header.
    headers["X-Jobs-API-Key"] = apiKey;
  }

  // On Cloud Run, acquire an OIDC identity token for the jobs service
  // audience so Cloud Run IAM lets the request through.
  const idToken = await fetchIdToken(baseUrl);
  if (idToken) {
    headers["Authorization"] = `Bearer ${idToken}`;
  }
  let res: Response;
  try {
    res = await fetch(url, { ...init, headers });
  } catch (err) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: `Jobs service unreachable: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
  return { url, res };
}

/**
 * The tRPC error for a non-2xx jobs response. `notFound` maps 404 to
 * NOT_FOUND; without it a 404 is PRECONDITION_FAILED like every other 4xx.
 */
function jobsResponseError(
  url: string,
  status: number,
  body: string,
  options?: { notFound?: boolean },
): TRPCError {
  // Keep non-500 responses visible in app/server logs without escalating them
  // into Discord noise via the tRPC INTERNAL_SERVER_ERROR path.
  if (status < 500) {
    console.warn("[platformJobsRouter] jobsProxy non-500 response", {
      url,
      status,
      body: body.slice(0, 500),
    });
  }

  const code =
    status === 401
      ? "UNAUTHORIZED"
      : status === 403
        ? "FORBIDDEN"
        : status === 404 && options?.notFound
          ? "NOT_FOUND"
          : status === 429
            ? "TOO_MANY_REQUESTS"
            : status >= 500
              ? "INTERNAL_SERVER_ERROR"
              : "PRECONDITION_FAILED";

  return new TRPCError({
    code,
    message: `Jobs API ${status}: ${body}`,
  });
}

/** Proxy a request to the jobs service, returning typed JSON or throwing a tRPC error. */
async function jobsProxy<T>(
  baseUrl: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const { url, res } = await jobsRequest(baseUrl, path, init);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw jobsResponseError(url, res.status, body);
  }
  return res.json() as Promise<T>;
}

function parseJsonOrUndefined(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Not JSON: the caller's schema check rejects `undefined`.
    return undefined;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Schemas (mirror jobs service responses)
// ─────────────────────────────────────────────────────────────────────────────

const runEntrySchema = z.object({
  id: z.string(),
  jobName: z.string(),
  startedAt: z.string(),
  finishedAt: z.string(),
  durationMs: z.number(),
  status: z.enum(["success", "error"]),
  resultSummary: z.string().optional(),
  errorMessage: z.string().optional(),
  errorCode: z.string().optional(),
});

const jobScheduleSchema = z.object({
  cron: z.string(),
  timezone: z.string(),
  enabled: z.boolean(),
  cronDescription: z.string(),
  nextRun: z.string().nullable(),
});

const jobStatusSchema = z.object({
  name: z.string(),
  description: z.string().nullable(),
  scheduled: z.boolean(),
  schedule: jobScheduleSchema.nullable(),
  enabled: z.boolean(),
  lastRun: runEntrySchema.nullable(),
});

/**
 * Mirrors `GET /moderation/config` in apps/jobs. Three fields, and three only:
 * which adapter the jobs process actually selected, and the thresholds it
 * decides with. The Azure endpoint URL and API key are NOT in the jobs
 * response and must never be added to it.
 */
const moderationConfigSchema = z
  .object({
    provider: z.enum(["azure", "stub", "fail-closed"]),
    reviewThreshold: z.number(),
    categoryThresholds: z.object({
      SEXUAL: z.number(),
      VIOLENCE: z.number(),
      HATE: z.number(),
      SELF_HARM: z.number(),
    }),
  })
  .strict();

const dlqItemSchema = z.object({
  ref: z.object({ queue: z.string(), id: z.string() }),
  failedAt: z.string(),
  payload: z.unknown(),
  attempt: z.number(),
  error: z.object({ message: z.string(), code: z.string().optional() }),
  // Set by a failed rerun: `firstFailedAt` (the original failure time) and
  // `lastRunId` (the rerun). Same shape as the port's entry; without this
  // line the output schema strips it before the console sees it.
  metadata: z.record(z.string(), z.string()).optional(),
});

/**
 * Mirror `POST /dlq/:queue/:jobId/rerun` in apps/jobs: 200 when the run was
 * confirmed (`entryDeleted` says whether the entry is gone), 409 when it did
 * not run or failed (the entry is kept). On the wire a failed run's error is `runError`, because
 * `error` there is the string code `"rerun_failed"`.
 */
const rerunRanResponseSchema = z.object({
  outcome: z.literal("ran"),
  runId: z.string().nullable(),
  entryDeleted: z.boolean(),
});

const rerunKeptResponseSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("not_run"),
    reason: rerunNotRunReasonSchema,
  }),
  z.object({
    outcome: z.literal("failed"),
    runId: z.string().nullable(),
    status: z.number().int(),
    runError: z.object({
      message: z.string().min(1),
      code: z.string().optional(),
    }),
  }),
]);

// ─────────────────────────────────────────────────────────────────────────────
// Router
// ─────────────────────────────────────────────────────────────────────────────

export const platformJobsRouter = {
  /**
   * List all registered jobs with their current status, schedule, and last run.
   */
  listStatus: authedProcedure
    .output(z.object({ jobs: z.array(jobStatusSchema) }))
    .query(async ({ ctx }) => {
      const baseUrl = await requireStaffAndJobsUrl(ctx);
      return jobsProxy<{ jobs: z.infer<typeof jobStatusSchema>[] }>(
        baseUrl,
        "/jobs/status",
      );
    }),

  /**
   * Which image-moderation provider is LIVE, and the thresholds it enforces.
   *
   * Proxied from the jobs service rather than read from this process's env,
   * because apps/api wires no Azure adapter and holds no
   * AZURE_CONTENT_SAFETY_* / IMAGE_MODERATION_* variables at all — answering
   * here would be a confident lie. The jobs container is the process that
   * actually chose an adapter.
   *
   * `requireStaffAndJobsUrl` throws PRECONDITION_FAILED when `jobsServiceUrl`
   * is unset. That is correct and deliberate: the page renders "unknown". Do
   * NOT soften it into a fabricated default — "stub" and "azure" are exactly
   * the two answers an operator must never be guessed at.
   */
  getModerationConfig: authedProcedure
    .output(moderationConfigSchema)
    .query(async ({ ctx }) => {
      const baseUrl = await requireStaffAndJobsUrl(ctx);
      return jobsProxy<z.infer<typeof moderationConfigSchema>>(
        baseUrl,
        "/moderation/config",
      );
    }),

  /**
   * Get recent run history for a specific job.
   */
  getRuns: authedProcedure
    .input(
      z.object({
        name: z.string(),
        limit: z.number().int().positive().max(100).default(25),
      }),
    )
    .output(z.object({ runs: z.array(runEntrySchema) }))
    .query(async ({ ctx, input }) => {
      const baseUrl = await requireStaffAndJobsUrl(ctx);
      return jobsProxy<{ runs: z.infer<typeof runEntrySchema>[] }>(
        baseUrl,
        `/jobs/${encodeURIComponent(input.name)}/runs?limit=${input.limit}`,
      );
    }),

  /**
   * Trigger a job to run immediately.
   */
  runJob: authedProcedure
    .input(z.object({ name: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const baseUrl = await requireStaffAndJobsUrl(ctx);
      return jobsProxy<unknown>(
        baseUrl,
        `/jobs/${encodeURIComponent(input.name)}?force=true`,
        {
          method: "POST",
          body: "{}",
        },
      );
    }),

  /**
   * Enable or disable a job's schedule.
   */
  toggleEnabled: authedProcedure
    .input(z.object({ name: z.string(), enabled: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const baseUrl = await requireStaffAndJobsUrl(ctx);
      return jobsProxy<unknown>(
        baseUrl,
        `/jobs/${encodeURIComponent(input.name)}/enabled`,
        { method: "PUT", body: JSON.stringify({ enabled: input.enabled }) },
      );
    }),

  /**
   * Peek at items in a DLQ.
   */
  peekDlq: authedProcedure
    .input(
      z.object({
        queue: z.string(),
        max: z.number().int().positive().max(200).default(50),
      }),
    )
    .output(z.object({ items: z.array(dlqItemSchema) }))
    .query(async ({ ctx, input }) => {
      const baseUrl = await requireStaffAndJobsUrl(ctx);
      return jobsProxy<{ items: z.infer<typeof dlqItemSchema>[] }>(
        baseUrl,
        `/dlq/${encodeURIComponent(input.queue)}?max=${input.max}`,
      );
    }),

  /**
   * Rerun a single DLQ item.
   *
   * Resolves with what the rerun did, so the console branches on `outcome`
   * instead of parsing an error string:
   *  - `ran`: the run was confirmed. `entryDeleted` is false when the job ran
   *    but its entry could not be removed: the work is done, and rerunning
   *    that entry would run the job again;
   *  - `not_run`: nothing ran and the entry is kept (`disabled` = the job is
   *    paused, `coalesced` = a run was already in flight, `unconfirmed` = the
   *    jobs service did not confirm a run, `claimed` = someone else's rerun
   *    of this entry is in progress);
   *  - `failed`: the rerun failed and the entry is kept.
   * Throws NOT_FOUND when the entry no longer exists, and as every other
   * procedure here does for any other non-2xx answer.
   */
  rerunDlqItem: authedProcedure
    .input(z.object({ queue: z.string(), jobId: z.string() }))
    .output(rerunJobFromDlqResultSchema)
    .mutation(async ({ ctx, input }): Promise<RerunJobFromDlqResult> => {
      const baseUrl = await requireStaffAndJobsUrl(ctx);
      const { url, res } = await jobsRequest(
        baseUrl,
        `/dlq/${encodeURIComponent(input.queue)}/${encodeURIComponent(input.jobId)}/rerun`,
        { method: "POST", body: "{}" },
      );
      const body = await res.text().catch(() => "");

      if (res.ok) {
        const ran = rerunRanResponseSchema.safeParse(parseJsonOrUndefined(body));
        if (ran.success) {
          return {
            outcome: "ran",
            runId: ran.data.runId,
            entryDeleted: ran.data.entryDeleted,
          };
        }
        // A 200 that does not say `ran` is not evidence that anything ran or
        // that the entry was kept (a jobs service from before this contract
        // answers `{ jobId }`), so it is an error, not a guessed outcome.
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Jobs API ${res.status}: unrecognised rerun response`,
        });
      }

      if (res.status === 409) {
        const kept = rerunKeptResponseSchema.safeParse(
          parseJsonOrUndefined(body),
        );
        if (kept.success) {
          return kept.data.outcome === "not_run"
            ? { outcome: "not_run", reason: kept.data.reason }
            : {
                outcome: "failed",
                runId: kept.data.runId,
                status: kept.data.status,
                error: kept.data.runError,
              };
        }
      }

      throw jobsResponseError(url, res.status, body, { notFound: true });
    }),

  /**
   * Delete a single DLQ item.
   */
  deleteDlqItem: authedProcedure
    .input(z.object({ queue: z.string(), jobId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const baseUrl = await requireStaffAndJobsUrl(ctx);
      return jobsProxy<unknown>(
        baseUrl,
        `/dlq/${encodeURIComponent(input.queue)}/${encodeURIComponent(input.jobId)}`,
        { method: "DELETE" },
      );
    }),

  /**
   * Purge all items from a DLQ.
   */
  purgeDlq: authedProcedure
    .input(z.object({ queue: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const baseUrl = await requireStaffAndJobsUrl(ctx);
      return jobsProxy<unknown>(
        baseUrl,
        `/dlq/${encodeURIComponent(input.queue)}`,
        { method: "DELETE" },
      );
    }),
};

export type PlatformJobsRouter = typeof platformJobsRouter;
