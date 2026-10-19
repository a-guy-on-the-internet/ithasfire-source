import { z } from "zod";

import { parseInput } from "../../lib/io";
import { reportSafely } from "./_shared/lineup-notice-support";
import {
  LINEUP_SWEEP_CONTINUE_BUDGET_MS,
  LINEUP_SWEEP_MAX_CONTINUATIONS,
  LINEUP_SWEEP_OWED_SAMPLE_MAX,
} from "./_shared/lineup-sweep-continuation";
import {
  runLineupNoticeSweep,
  type LineupSweepResult,
  type NotifyLineupNoticesDeps,
} from "./notify-lineup-notices";

/**
 * Body of `lineup-notices.continue-sweep` (Cloud Tasks → jobs). Written by
 * `scheduleLineupSweepContinuation`; nothing user-facing produces it.
 */
export const continueLineupNoticeSweepInputSchema = z
  .object({
    eventId: z.uuid(),
    attempt: z.number().int().min(1).max(LINEUP_SWEEP_MAX_CONTINUATIONS),
    /**
     * Did the sweep that queued this run reach a row with an OWED record?
     * OPTIONAL because this schema is `.strict()` and Cloud Tasks may still
     * hold payloads written before the field existed — absent = unknown, and
     * the drift detector below stays quiet.
     */
    owedSeen: z.boolean().optional(),
    /**
     * Up to {@link LINEUP_SWEEP_OWED_SAMPLE_MAX} event_human row ids the
     * queuing sweep read as OWED (`LineupSweepContinuePayload.owedSample`).
     * OPTIONAL for the same reason as `owedSeen`; absent = quiet.
     */
    owedSample: z.array(z.uuid()).max(LINEUP_SWEEP_OWED_SAMPLE_MAX).optional(),
  })
  .strict();

export type ContinueLineupNoticeSweepInput = z.infer<
  typeof continueLineupNoticeSweepInputSchema
>;

/**
 * Continuation run `attempt` of a publish sweep that ran out of budget (see
 * `_shared/lineup-sweep-continuation.ts`). Sweeps the event again with the
 * larger {@link LINEUP_SWEEP_CONTINUE_BUDGET_MS}; if rows are still left it
 * queues `attempt + 1` through `deps.sweepContinuation`, and on the last
 * allowed attempt it reports and stops. An event that is no longer
 * published is skipped. Rows already told are skipped by their SENT claim,
 * so a duplicate or retried run sends nothing twice.
 *
 * `deps.idempotency` MUST be the store the API writes the lineup-notice
 * ledger to (namespace "api") — another namespace reads every row as not
 * owed and tells nobody. That drift is reported (`sweep_no_owed_records`),
 * and it is the ONLY detector for it, so it has to stay quiet on healthy
 * events or it will be muted. Three conditions, all of them needed:
 *
 *   · a row the sweep that QUEUED this run read as owed (`input.owedSample`)
 *     is STILL linked to the event, and this run read it as NOT owed.
 *     Without that, "no OWED record anywhere" is indistinguishable from a
 *     perfectly healthy event whose whole lineup is volunteer-signup or
 *     booking-minted rows — they carry no OWED record, and merely PROBING
 *     each one costs a ledger read, so a 200-row lineup of them can spend
 *     the publish budget and queue a continuation with nothing wrong. A bare
 *     "the asking sweep saw some" (`owedSeen`) was not enough either: when
 *     every owed row is removed from the lineup between the two runs, only
 *     those never-owed rows are left and a healthy event alarmed. A sampled
 *     row cannot flip from owed to not-owed against the same INTACT ledger:
 *     the app never deletes OWED (leaving clears only the 7-day cooldown), a
 *     removed row is hard-deleted so it simply is not listed, and a re-add
 *     mints a NEW row id. So a flip means this run reads a different store
 *     (namespace/backend drift) OR the ledger lost records — e.g. Redis
 *     eviction, since every OWED key carries an EX and is evictable under a
 *     `volatile-*` policy. Both are real: notices go untold. The report's
 *     `likelyCauses` names both for triage. Absent sample (a task queued
 *     before the field existed) = unknown = quiet;
 *   · this run EXAMINED EVERY LINKED ROW (`rowsNotReached === 0`): one that
 *     ran out of budget has simply not looked yet;
 *   · not one row it reached carried an OWED record. OWED records outlive
 *     SENT, so against the right store that cannot happen after a sampled
 *     row was read as owed. Defence in depth: the sampled row is already
 *     the evidence; this keeps the alarm to the whole-store shape it names.
 */
export async function continueLineupNoticeSweep(
  deps: NotifyLineupNoticesDeps,
  rawInput: unknown,
): Promise<LineupSweepResult> {
  const input = parseInput(continueLineupNoticeSweepInputSchema, rawInput);
  const sampled = new Set(input.owedSample ?? []);
  // Sampled rows this run REACHED (so still linked) and read as not owed.
  let sampledRowsNotOwed = 0;
  const result = await runLineupNoticeSweep(deps, {
    eventId: input.eventId,
    budgetMs: LINEUP_SWEEP_CONTINUE_BUDGET_MS,
    attempt: input.attempt,
    ...(sampled.size > 0
      ? {
          onOwedRead: (eventHumanId: string, owed: boolean) => {
            if (!owed && sampled.has(eventHumanId)) sampledRowsNotOwed += 1;
          },
        }
      : {}),
  });
  const reached = result.rowsTotal - result.rowsNotReached;
  if (
    result.outcome !== "skipped" &&
    // A row the asking sweep read as owed is still on the lineup and reads
    // as not owed here: not a lineup without owed rows, nor one whose owed
    // rows were removed meanwhile — a different store, or a ledger that
    // lost records (see above).
    sampledRowsNotOwed > 0 &&
    // Only a run that got to the END of the lineup can say "no row here is
    // owed"; one that ran out of budget has simply not looked yet.
    result.rowsNotReached === 0 &&
    reached > 0 &&
    result.rowsOwed === 0
  ) {
    const extra = {
      eventId: input.eventId,
      attempt: input.attempt,
      sampledRowsNotOwed,
      // Triage hint: what flips a still-linked owed row to not-owed.
      likelyCauses: ["idempotency_store_drift", "ledger_records_lost"],
      ...result,
    };
    try {
      deps.logger?.error("event_humans.lineup_notice.failed", {
        reason: "sweep_no_owed_records",
        ...extra,
      });
    } catch {
      // Best-effort.
    }
    reportSafely(deps.reportError, new Error("lineup_sweep_no_owed_records"), {
      tags: { useCase: "notifyLineupNotices", reason: "sweep_no_owed_records" },
      extra,
    });
  }
  return result;
}
