import type { ClockPort } from "@th/ports/clock";
import {
  isScheduleNotSentError,
  type DelayedJobSchedulerPort,
} from "@th/ports/delayed-jobs";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";

import { describeError } from "../../../lib/io";
import { reportSafely } from "./lineup-notice-support";

// ─────────────────────────────────────────────────────────────────────────────
// Continuing the post-publish lineup sweep (notify-lineup-notices.ts).
//
// The publish request sweeps for LINEUP_SWEEP_BUDGET_MS (10s). Rows it never
// reached stay OWED, and used to wait for a FUTURE publish of the event —
// which usually never comes. Now the sweep that runs out of budget asks the
// delayed scheduler (Cloud Tasks, the same adapter as the search reindex
// drain but its OWN queue — infra/terraform/lineup-notice-sweep.tf) for ONE
// run of the jobs handler
// `lineup-notices.continue-sweep` about 30s later. That run sweeps the same
// event with a 60s budget and, if it runs out again, asks for the next
// attempt — at most LINEUP_SWEEP_MAX_CONTINUATIONS runs, then it reports
// and stops (the rest then wait for a future publish, as before).
//
// Exactly-once still comes from each row's SENT claim, so a duplicate,
// overlapping or retried continuation run sends nothing twice. Nothing polls:
// no overflow, no task.
// ─────────────────────────────────────────────────────────────────────────────

/** Jobs-service job that continues a sweep. Must match apps/jobs. */
export const LINEUP_SWEEP_CONTINUE_JOB = "lineup-notices.continue-sweep";
/** Continuation runs per overflowing publish, after which it gives up (reported). */
export const LINEUP_SWEEP_MAX_CONTINUATIONS = 5;
/** Wall-clock budget for STARTING sends in one continuation run. */
export const LINEUP_SWEEP_CONTINUE_BUDGET_MS = 60_000;
/**
 * At most this many owed row ids travel in a continuation payload
 * ({@link LineupSweepContinuePayload.owedSample}). Real drift goes unseen
 * only if EVERY sampled row is removed in the ~30s-6min between two runs;
 * twenty uuids keep the task body under 1KB. The receiving schema enforces it, so the
 * writer MUST cap to it — an over-long sample would fail every hop.
 */
export const LINEUP_SWEEP_OWED_SAMPLE_MAX = 20;
/** Earliest a continuation runs after the sweep that asked for it. */
export const LINEUP_SWEEP_CONTINUE_DELAY_MS = 30_000;
/**
 * Runs are quantized to slots of this width per (event, attempt): two
 * overflowing publishes of one event inside a slot share one run, which
 * reads every owed row anyway.
 */
const CONTINUE_SLOT_MS = 30_000;
/**
 * Upper bound on the scheduler call. On the publish path it sits after
 * commit, before the response; a miss is reported and the rows stay owed.
 *
 * DELIBERATELY LONGER than the Cloud Tasks adapter's WHOLE budget
 * (`CloudTasksScheduler`: access token, default 1.5s, then the create
 * request, default 3s — 4.5s together): at 3s here the two raced, and a
 * create that landed server-side at ~2.9s could lose the race and be read as
 * "failed" — a sweep that IS continuing reported as abandoned, and on the
 * jobs path a 500 + DLQ entry + a second chain from the Cloud Tasks retry.
 * The token is part of that budget on purpose: unbounded, a stalled
 * metadata-server token fetch let THIS timer win although nothing had been
 * sent, so a hop that certainly did not exist was read as "timeout" and
 * never retried, stranding the rows.
 *
 * So the adapter's own answer is what we observe: a throw before the request
 * left is a `ScheduleNotSentError` ("failed", retryable), and any other throw
 * is "failed" too. This timer only fires when a scheduler hangs past its own
 * budget, where the task's fate is genuinely unknown ("timeout").
 */
export const LINEUP_SWEEP_SCHEDULE_TIMEOUT_MS = 5_000;

/**
 * The composition root's handle on continuation scheduling. Absent/null =
 * no scheduler configured: an overflowing sweep reports and its leftover
 * rows wait for a future publish.
 */
export type LineupSweepContinuation = {
  scheduler: DelayedJobSchedulerPort;
  /** Default {@link LINEUP_SWEEP_CONTINUE_DELAY_MS}. */
  delayMs?: number;
};

/** The body the continuation job receives. */
export type LineupSweepContinuePayload = {
  eventId: string;
  attempt: number;
  /**
   * Did the sweep that asked for this run see an OWED record on any row it
   * reached? Carried, not re-derived: a continuation run that finds no OWED
   * record anywhere is the ONLY signal that the jobs process reads a
   * different idempotency store from the API's ledger (the feature then
   * tells nobody while looking healthy) — but it is also the normal shape of
   * an event whose whole lineup is volunteer-signup or booking-minted rows,
   * which carry no OWED record and still cost a ledger read each. Only the
   * asking sweep can tell those apart.
   *
   * OPTIONAL on purpose: tasks queued before this field existed are already
   * in Cloud Tasks (the payload schema is `.strict()`, so a required field
   * would start failing their validation). Absent = unknown, and the drift
   * detector stays quiet — the next run in the chain carries it.
   *
   * Kept for the logs and for payloads already queued; the detector itself
   * now keys on {@link owedSample} (non-empty implies `owedSeen: true`).
   */
  owedSeen?: boolean;
  /**
   * Ids (event_human row ids — the OWED ledger key is
   * `lineup-notice:owed:{eventHumanId}`) of up to
   * {@link LINEUP_SWEEP_OWED_SAMPLE_MAX} rows the asking sweep READ AS OWED.
   *
   * `owedSeen` alone could not tell "this run reads another store" from
   * "every owed row was removed from the lineup between the two runs" —
   * after which only volunteer/booking-minted rows (never OWED) remain, and
   * a healthy event alarmed. With the ids, the detector needs a row that is
   * STILL linked, that the asking sweep read as owed, and that this run
   * reads as not owed: the same row id against the same ledger cannot flip,
   * because nothing ever deletes an OWED record (the port has no delete,
   * it is kept 10 years, and leaving/removal clears only the 7-day RECENT
   * cooldown). A removed row is hard-deleted, and a re-add mints a NEW row
   * id, so a re-attached person is never misread through a sampled id.
   *
   * OPTIONAL for the same reason as `owedSeen`: absent (queued before this
   * field existed) = unknown = the detector stays quiet.
   */
  owedSample?: string[];
};

/** When the run lands and its dedupe key. Pure. */
export function lineupSweepContinuationSlot(
  now: Date,
  eventId: string,
  attempt: number,
  delayMs: number,
): { runAt: Date; dedupeKey: string } {
  const earliest = now.getTime() + Math.max(0, delayMs);
  const slot = Math.ceil(earliest / CONTINUE_SLOT_MS) * CONTINUE_SLOT_MS;
  return {
    runAt: new Date(slot),
    dedupeKey: `lineup-sweep-${eventId}-${attempt}-${slot}`,
  };
}

/**
 * `scheduled` / `duplicate` = a run is queued (`duplicate` = one for this
 * event, attempt and slot already was). `failed` = the scheduler REFUSED or
 * threw — including `ScheduleNotSentError`, a failure before anything was
 * sent; the caller treats nothing as queued and retries. `timeout` = it
 * never answered inside {@link LINEUP_SWEEP_SCHEDULE_TIMEOUT_MS}, so whether the task
 * exists is UNKNOWN — the caller must not report those rows as abandoned,
 * and must not retry in a way that would queue a second chain.
 */
export type ScheduleLineupSweepOutcome =
  | "scheduled"
  | "duplicate"
  | "failed"
  | "timeout";

/**
 * Ask for continuation run `attempt` of the sweep for `eventId`. Never
 * throws: a failure (or a scheduler that does not answer in time) is logged
 * at error AND reported, and the caller reports the leftover rows.
 */
export async function scheduleLineupSweepContinuation(
  deps: {
    continuation: LineupSweepContinuation;
    clock?: ClockPort;
    logger?: LoggerPort;
    reportError?: ReporterPort;
  },
  args: {
    eventId: string;
    attempt: number;
    /**
     * Did THIS sweep reach a row with an OWED record? Travels in the payload
     * — see {@link LineupSweepContinuePayload.owedSeen}.
     */
    owedSeen: boolean;
    /**
     * Ids of rows THIS sweep read as owed — see
     * {@link LineupSweepContinuePayload.owedSample}. Capped here to
     * {@link LINEUP_SWEEP_OWED_SAMPLE_MAX}.
     */
    owedSample: readonly string[];
    /**
     * Run no earlier than this (e.g. past a held SENT claim's TTL). The
     * larger of this and the configured delay wins.
     */
    minDelayMs?: number;
  },
): Promise<ScheduleLineupSweepOutcome> {
  const now = deps.clock?.now() ?? new Date();
  const { runAt, dedupeKey } = lineupSweepContinuationSlot(
    now,
    args.eventId,
    args.attempt,
    Math.max(
      deps.continuation.delayMs ?? LINEUP_SWEEP_CONTINUE_DELAY_MS,
      args.minDelayMs ?? 0,
    ),
  );
  const payload: LineupSweepContinuePayload = {
    eventId: args.eventId,
    attempt: args.attempt,
    owedSeen: args.owedSeen,
    owedSample: args.owedSample.slice(0, LINEUP_SWEEP_OWED_SAMPLE_MAX),
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  // Not in the dedupe key: two sweeps of one event in the same slot share
  // one run, and whichever payload lands first wins. Both read the same
  // ledger, so the only cost of losing that race is the drift detector
  // staying quiet for one run.
  let timedOut = false;
  try {
    const result = await Promise.race([
      deps.continuation.scheduler.scheduleOnce({
        jobName: LINEUP_SWEEP_CONTINUE_JOB,
        payload,
        runAt,
        dedupeKey,
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(
            new Error(
              `scheduleLineupSweepContinuation: scheduler did not answer within ${LINEUP_SWEEP_SCHEDULE_TIMEOUT_MS}ms; the task MAY have been created`,
            ),
          );
        }, LINEUP_SWEEP_SCHEDULE_TIMEOUT_MS);
      }),
    ]);
    return result.status;
  } catch (error) {
    // Told apart on purpose: a refusal means nothing is queued, a timeout
    // means nobody knows (see LINEUP_SWEEP_SCHEDULE_TIMEOUT_MS). Only OUR
    // timer makes a timeout: the scheduler's own throws — a
    // ScheduleNotSentError above all, where nothing was sent — are `failed`,
    // which both callers retry or report as abandoned. (A scheduler throw
    // resumes here in a microtask, before any timer callback can run, so
    // `timedOut` is only ever true for our own timer's error.)
    //
    // `notSent` reports only what is KNOWN: true = a ScheduleNotSentError,
    // the task certainly does not exist. false = not known to be unsent — it
    // covers a 403 (sent, refused), a connection error (maybe never left)
    // and our own timeout (fate unknown) alike.
    const notSent = isScheduleNotSentError(error);
    const unconfirmed = timedOut;
    const reason = unconfirmed
      ? "sweep_continuation_schedule_timeout"
      : "sweep_continuation_schedule_failed";
    try {
      deps.logger?.error(`event_humans.lineup_notice.${reason}`, {
        eventId: args.eventId,
        attempt: args.attempt,
        runAt: runAt.toISOString(),
        notSent,
        error: describeError(error),
      });
    } catch {
      // Best-effort.
    }
    reportSafely(deps.reportError, error, {
      tags: { useCase: "notifyLineupNotices", reason },
      extra: {
        eventId: args.eventId,
        attempt: args.attempt,
        dedupeKey,
        notSent,
      },
    });
    return unconfirmed ? "timeout" : "failed";
  } finally {
    if (timer) clearTimeout(timer);
  }
}
