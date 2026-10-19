import { z } from "zod";

// This port is intentionally *not* a worker loop / queue implementation.
// It's a narrow "ops/diagnostics" surface over a dead-letter queue: list,
// read, delete, purge and rerun. Its one implementation is the Redis adapter
// (packages/adapters/src/job-diagnostics/redis-dlq-adapter.ts).

const queueNameSchema = z.string().min(1, "queue is required");
const isoDateSchema = z.string().datetime({ offset: true });

export type JobDiagnosticsErrorCode =
  | "invalid_input"
  | "not_found"
  | "conflict"
  | "transient"
  | "internal";

export class JobDiagnosticsError extends Error {
  constructor(
    public readonly code: JobDiagnosticsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "JobDiagnosticsError";
  }
}

export function createJobDiagnosticsError(
  code: JobDiagnosticsErrorCode,
  message: string,
): JobDiagnosticsError {
  return new JobDiagnosticsError(code, message);
}

export function isJobDiagnosticsError(
  error: unknown,
): error is JobDiagnosticsError {
  return error instanceof JobDiagnosticsError;
}

export const jobDiagnosticsRefSchema = z.object({
  queue: queueNameSchema,
  id: z.string().min(1),
});
export type JobDiagnosticsRef = z.infer<typeof jobDiagnosticsRefSchema>;

export const jobDiagnosticsDlqItemSchema = z.object({
  ref: jobDiagnosticsRefSchema,
  taskName: z.string().min(1).optional(),
  failedAt: isoDateSchema,
  // Raw invocation payload that created the task.
  // For our system, this should generally be { key, payload }.
  payload: z.unknown(),
  // The failure that put the entry here, as a normalized message and code.
  error: z
    .object({
      message: z.string().min(1),
      code: z.string().optional(),
    })
    .optional(),
  attempt: z.number().int().min(1).optional(),
  metadata: z.record(z.string(), z.string()).optional(),
});
export type JobDiagnosticsDlqItem = z.infer<typeof jobDiagnosticsDlqItemSchema>;

export const peekJobDlqInputSchema = z.object({
  queue: queueNameSchema,
  max: z.number().int().min(1).max(500).default(25),
});
export type PeekJobDlqInput = z.input<typeof peekJobDlqInputSchema>;

export const getJobDlqItemInputSchema = z.object({
  queue: queueNameSchema,
  jobId: z.string().min(1),
});
export type GetJobDlqItemInput = z.input<typeof getJobDlqItemInputSchema>;

export const deleteJobDlqItemInputSchema = z.object({
  queue: queueNameSchema,
  jobId: z.string().min(1),
});
export type DeleteJobDlqItemInput = z.input<typeof deleteJobDlqItemInputSchema>;

export const purgeJobDlqInputSchema = z.object({
  queue: queueNameSchema,
});
export type PurgeJobDlqInput = z.input<typeof purgeJobDlqInputSchema>;

export const rerunJobFromDlqInputSchema = z.object({
  queue: queueNameSchema,
  jobId: z.string().min(1),
  // If present, override the original payload when creating the rerun task.
  payloadOverride: z.unknown().optional(),
});
export type RerunJobFromDlqInput = z.input<typeof rerunJobFromDlqInputSchema>;

/**
 * Why a rerun did not run (see `rerunJobFromDlqResultSchema`). One list for
 * the port, the jobs service's answer and the transport that mirrors it.
 */
export const rerunNotRunReasonSchema = z.enum([
  "disabled",
  "coalesced",
  "unconfirmed",
  "claimed",
]);
export type RerunNotRunReason = z.infer<typeof rerunNotRunReasonSchema>;

/**
 * What a rerun did. The DLQ entry is deleted on `ran` and on nothing else.
 *
 * - `ran`: the run was positively confirmed. `runId` is the new run's id when
 *   the runner reported one. `entryDeleted` is false when the job ran but the
 *   entry could not be removed afterwards: the work is done, the entry is
 *   stale, and rerunning it would run the job a second time.
 * - `not_run`: nothing confirmed a run, so the entry is untouched.
 *   `disabled` = the job is paused; `coalesced` = the request was folded into
 *   a run already in flight; `unconfirmed` = the runner accepted the request
 *   without saying the work ran (a job that reports it skipped its work
 *   answers this); `claimed` = another rerun of the same entry is in
 *   progress, or one broke off without an answer in the last few minutes, so
 *   this one was not started.
 * - `failed`: the runner refused the request or the run failed. The entry is
 *   kept. `status` is the runner's HTTP status; it is 200 when the job
 *   returned its own failure instead of throwing. When the run threw, the
 *   same entry now carries the new error (see the Redis adapter's
 *   `recordRerunFailure`); otherwise the entry is unchanged. `runId` is null
 *   when the run never started.
 */
export const rerunJobFromDlqResultSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("ran"),
    runId: z.string().nullable(),
    entryDeleted: z.boolean(),
  }),
  z.object({
    outcome: z.literal("not_run"),
    reason: rerunNotRunReasonSchema,
  }),
  z.object({
    outcome: z.literal("failed"),
    runId: z.string().nullable(),
    status: z.number().int(),
    error: z.object({
      message: z.string().min(1),
      code: z.string().optional(),
    }),
  }),
]);
export type RerunJobFromDlqResult = z.infer<typeof rerunJobFromDlqResultSchema>;

/**
 * What the runner said about one rerun request, before the entry is touched.
 * The same union as the result, except that `ran` does not yet say what
 * happened to the entry.
 */
export type RerunJobRunOutcome =
  | { outcome: "ran"; runId: string | null }
  | Exclude<RerunJobFromDlqResult, { outcome: "ran" }>;

export interface JobDiagnosticsPort {
  /** List DLQ entries for a queue. */
  peekDLQ(input: PeekJobDlqInput): Promise<JobDiagnosticsDlqItem[]>;

  /** Fetch a DLQ entry by id. */
  getFromDLQ(input: GetJobDlqItemInput): Promise<JobDiagnosticsDlqItem | null>;

  /** Delete a DLQ entry by id. */
  deleteFromDLQ(input: DeleteJobDlqItemInput): Promise<boolean>;

  /** Purge all DLQ entries for a queue. */
  purgeDLQ(input: PurgeJobDlqInput): Promise<{ purged: number }>;

  /**
   * Re-run a DLQ entry with the same payload (or an override) and report what
   * happened. The entry is deleted only on `outcome: "ran"`; every other
   * outcome leaves it in the queue. Throws `not_found` when the entry does not
   * exist. Rethrows when the runner could not be reached or the request broke
   * off: the entry is untouched, and the run may still be in progress.
   */
  rerunFromDLQ(input: RerunJobFromDlqInput): Promise<RerunJobFromDlqResult>;
}
