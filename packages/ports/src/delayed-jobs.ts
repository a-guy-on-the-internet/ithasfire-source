/**
 * Run a jobs-service job LATER, at most once per dedupe key — without anyone
 * polling. The intended adapter is Cloud Tasks (an HTTP task with
 * `scheduleTime`, named after the dedupe key so a second create is rejected
 * as ALREADY_EXISTS); a queue that has to be polled for due work does NOT
 * satisfy this port.
 */
export interface ScheduleJobOnceInput {
  /** Jobs-service job name, e.g. `search.drain-reindex-pending`. */
  jobName: string;
  /** JSON body the job receives. */
  payload: unknown;
  /** Earliest delivery time. A past instant means "as soon as possible". */
  runAt: Date;
  /**
   * At most one delivery per key. Keys must be unique per intended run (for
   * example, per time bucket): an adapter may refuse a key for a while after
   * its run completed (Cloud Tasks keeps executed task names ~1h).
   */
  dedupeKey: string;
}

export interface ScheduleJobOnceResult {
  /** `duplicate` = a run under this key already exists (or recently ran). */
  status: "scheduled" | "duplicate";
}

export interface DelayedJobSchedulerPort {
  scheduleOnce(input: ScheduleJobOnceInput): Promise<ScheduleJobOnceResult>;
}

/**
 * `scheduleOnce` failed BEFORE its request left the process (no credentials,
 * a credential fetch that failed or overran its budget, ...): the task was
 * certainly NOT created, so the caller may treat it as a plain refusal and
 * retry. Any other throw may come from a request that was sent and never
 * answered, where the task's fate is unknown.
 */
export class ScheduleNotSentError extends Error {
  readonly code = "schedule_not_sent" as const;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ScheduleNotSentError";
  }
}

/**
 * Structural on purpose: core and an adapter can hold two copies of this
 * module (bundling, test isolation), and `instanceof` would then say no.
 */
export function isScheduleNotSentError(
  error: unknown,
): error is ScheduleNotSentError {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "schedule_not_sent"
  );
}
