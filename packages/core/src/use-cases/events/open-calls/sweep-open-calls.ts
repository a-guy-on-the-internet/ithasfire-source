import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type {
  OpenCallReconcileKind,
  OpenCallReconcileRow,
  OpenCallSweepDueRecord,
} from "@th/ports/repos/events";

import { describeError, parseInput } from "../../../lib/io";
import {
  OPEN_CALL_NOTICE_DEAD_AFTER_FAILURES,
  isOpenCallNoticeDead,
  readOpenCallNoticeFailures,
  recordOpenCallNoticeFailure,
} from "./_shared/open-call-notice-failures";
import {
  openCallNoticeWasSent,
  type OpenCallNoticeKind,
  type OpenCallNotices,
} from "./notify-open-call-notices";

// ─────────────────────────────────────────────────────────────────────────────
// sweep-open-calls (open calls v1 step 8; spec FR-021, FR-022, and the
// close-sweep notice durability launch gate). Runs hourly from apps/jobs
// (`events.sweep-open-calls`). Three passes, each idempotent:
//
// 1. SETTLE. `listOpenCallSweepDue` names every PENDING application that is
//    due (rule on the port): FR-021 backstop → REJECTED ("not this time"),
//    FR-022 pulled call → EXPIRED ("call pulled"). One transaction flips them
//    with `settlePendingOpenCallSubmissions`, whose `status = 'PENDING'` guard
//    is re-checked under each row lock, so a reviewer's concurrent pick or a
//    concurrent close that commits first wins and that row gets no notice
//    from here. Notices go only to the ids THIS run flipped, after commit.
//    Per application, not per call: a series call never "ends".
//
// 2. RECONCILE. Close sends at most CLOSE_NOTICES_IN_REQUEST_MAX notices in
//    its request; a decline or a step-1 notice can fail. So every REJECTED
//    application without a settled "not-this-time" ledger key, every EXPIRED
//    one without "pulled", and every PENDING / WAITLISTED one without
//    "received" (a guest's only way into their application) is re-sent
//    through the SAME idempotent notifier. The ledger is the notifier's own
//    (`openCallNoticeWasSent`): no second record. The scan is bounded by
//    OPEN_CALL_RECONCILE_WINDOW_DAYS and the per-run caps below. Each kind
//    keeps a keyset cursor IN THE LEDGER STORE (`openCallReconcileCursorKey`):
//    a run resumes after where the last one stopped and wraps to the oldest
//    row at the end, so when the window holds more rows than one run can
//    scan, every row is still reached within a few runs (an all-sent prefix
//    cannot starve the newest unsent rows).
//
//    DEAD NOTICES (owner ruling 2026-10-07). Every failed send in either
//    pass adds one to the row's failure counter (`_shared/open-call-notice-
//    failures.ts`, same ledger store). A row at OPEN_CALL_NOTICE_DEAD_AFTER_
//    FAILURES is reported ONCE as it crosses, then skipped by the reconcile
//    (`skippedDead`): it no longer uses the send cap and no longer counts
//    toward the verdict. deleteEvent stops waiting on it too.
//
// 3. VERDICT. Each notice runs in its own try/catch: a failure is logged at
//    error and reported (ReporterPort, guarded) and the run continues. The
//    run THROWS on systemic failure (a query or the flip transaction fails,
//    or at least OPEN_CALL_SWEEP_SYSTEMIC_MIN_ATTEMPTS notices were
//    attempted and none settled), because apps/jobs answers 200 unless the
//    handler throws. Dead rows are never attempted, so any number of dead
//    addresses cannot fail the run; one or two fresh failures are reported
//    per item, not as a failed run.
//
// TIME BUDGET. No new send or scan page starts once OPEN_CALL_SWEEP_TIME_
// BUDGET_MS has passed on `deps.clock` (reported once), so a worst-case run
// ends inside the job's 300 s deadline; what is left waits for the next run.
//
// Two overlapping runs: flips are conditional (each row flips once), and the
// notifier claims per-recipient ledger keys, so nothing is sent twice.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Most PENDING applications one run settles. Each settled one costs a notice
 * (a few reads plus a send per recipient) inside the same run; 100 keeps a
 * run well inside the job's 300 s deadline, and the next hourly run takes
 * the rest (oldest first, so nothing starves).
 */
export const OPEN_CALL_SWEEP_BATCH_MAX = 100;

/**
 * How far back the reconcile looks (by reviewedAt, or createdAt for
 * "received"). 14 days = 336 hourly retries: long enough to ride out a
 * multi-day mail outage or an unset status-token secret (guest emails wait
 * for it) over a weekend, short enough that the scan stays small. A notice
 * still unsent after that has been reported every hour for two weeks; it is
 * a fault to fix by hand, not one to keep retrying forever.
 */
export const OPEN_CALL_RECONCILE_WINDOW_DAYS = 14;

/**
 * Rows younger than this are not reconciled: their in-request send (close,
 * decline, submit) may still be running. The notifier's per-recipient claim
 * already prevents a double send; this just avoids racing it for nothing.
 */
export const OPEN_CALL_RECONCILE_MIN_AGE_MS = 10 * 60 * 1000;

/** Most notices one run re-sends per reconcile kind. */
export const OPEN_CALL_RECONCILE_SEND_MAX = 50;

/**
 * Most rows one run ledger-checks per reconcile kind (one idempotency read
 * each). Hitting it is reported, so a window too large for one run is seen.
 */
export const OPEN_CALL_RECONCILE_SCAN_MAX = 2000;

/**
 * Notices attempted with NONE settled before the run counts as a systemic
 * failure and throws. Below it, the per-item reports carry the signal: one
 * permanently dead address must not fail the job every hour for 14 days.
 */
export const OPEN_CALL_SWEEP_SYSTEMIC_MIN_ATTEMPTS = 3;

/**
 * Wall-clock budget for one run (the job's deadline is 300 s). Checked
 * before each send and each reconcile page; whatever is left waits for the
 * next hourly run (flips are committed; notices stay owed in the ledger).
 */
export const OPEN_CALL_SWEEP_TIME_BUDGET_MS = 240 * 1000;

/** Where each reconcile kind's resume cursor lives in the ledger store. */
export function openCallReconcileCursorKey(kind: OpenCallReconcileKind): string {
  return `open-call-sweep:reconcile-cursor:${kind}`;
}
/** Twice the window: a cursor older than that points before every row anyway. */
const RECONCILE_CURSOR_KEEP_SEC = 2 * OPEN_CALL_RECONCILE_WINDOW_DAYS * 24 * 60 * 60;

const RECONCILE_PAGE_SIZE = 200;
const DAY_MS = 24 * 60 * 60 * 1000;
const USE_CASE = "sweepOpenCalls";

export const sweepOpenCallsInputSchema = z
  .object({
    /** One-off override of OPEN_CALL_SWEEP_BATCH_MAX (a catch-up run). */
    batchMax: z.coerce.number().int().min(1).max(1000).optional(),
  })
  .strict();

const kindCountsSchema = z
  .object({
    scanned: z.number().int().nonnegative(),
    alreadySent: z.number().int().nonnegative(),
    attempted: z.number().int().nonnegative(),
    sent: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    /** Unsent rows at the dead threshold: not re-sent (reported once, when they crossed). */
    skippedDead: z.number().int().nonnegative(),
    scanCapped: z.boolean(),
    /** The scan reached the end of the window (or wrapped back to where it began). */
    passCompleted: z.boolean(),
  })
  .strict();

export const sweepOpenCallsOutputSchema = z
  .object({
    due: z.number().int().nonnegative(),
    /** FR-021: set to REJECTED by this run. */
    backstopRejected: z.number().int().nonnegative(),
    /** FR-022: set to EXPIRED by this run. */
    pulledExpired: z.number().int().nonnegative(),
    /** Due rows a concurrent decision settled first (no notice from here). */
    lostRace: z.number().int().nonnegative(),
    /** Notices for this run's flips that settled / did not. */
    noticesSent: z.number().int().nonnegative(),
    noticesFailed: z.number().int().nonnegative(),
    /** This run's flips whose notice was not started (time budget); reconciled later. */
    noticesDeferred: z.number().int().nonnegative(),
    /** The run stopped early on OPEN_CALL_SWEEP_TIME_BUDGET_MS. */
    timeBudgetExhausted: z.boolean(),
    reconcile: z
      .object({
        "not-this-time": kindCountsSchema,
        pulled: kindCountsSchema,
        received: kindCountsSchema,
      })
      .strict(),
  })
  .strict();

export type SweepOpenCallsInput = z.infer<typeof sweepOpenCallsInputSchema>;
export type SweepOpenCallsOutput = z.infer<typeof sweepOpenCallsOutputSchema>;
type KindCounts = z.infer<typeof kindCountsSchema>;

export type SweepOpenCallsDeps = {
  repos: Repos;
  clock: ClockPort;
  /**
   * The open-call notice LEDGER: the same idempotency store and namespace
   * the API's notifier writes (jobs: `ctx.lineupNoticeLedger`, namespace
   * "api"), or "was it sent?" reads the wrong store and every notice is
   * re-sent.
   */
  idempotency: IdempotencyPort;
  /** Built by `makeOpenCallNotices` over the same ledger. */
  notices: Pick<
    OpenCallNotices,
    | "notifyOpenCallNotThisTime"
    | "notifyOpenCallPulled"
    | "notifyOpenCallApplicationReceived"
  >;
  logger?: LoggerPort;
  reportError?: ReporterPort;
};

type NoticeOutcome = "sent" | "failed";

function reportSafely(
  deps: Pick<SweepOpenCallsDeps, "logger" | "reportError">,
  error: unknown,
  tags: Record<string, string>,
  extra: Record<string, unknown>,
): void {
  deps.logger?.error("open_call.sweep_failed", { ...tags, ...extra, err: error, error: describeError(error) });
  try {
    deps.reportError?.(error, { tags: { useCase: USE_CASE, ...tags }, extra });
  } catch {
    // Best-effort: a throwing reporter must never change the outcome.
  }
}

function anchorOf(row: { eventId: string | null; seriesId: string | null }) {
  if (row.eventId) return { kind: "event" as const, eventId: row.eventId };
  if (row.seriesId) return { kind: "series" as const, seriesId: row.seriesId };
  throw new Error("open-call sweep: a call with neither an event nor a series");
}

/**
 * One more failed attempt on the row's counter. Crossing the dead threshold
 * is reported once (the reconcile skips the row from then on). A counter
 * that cannot be written is reported; the row just stays retryable.
 */
async function noteFailure(
  deps: SweepOpenCallsDeps,
  kind: OpenCallReconcileKind,
  row: Pick<OpenCallReconcileRow, "submissionId" | "formId">,
  pass: "settle" | "reconcile",
): Promise<void> {
  let failures: number;
  try {
    failures = await recordOpenCallNoticeFailure(deps.idempotency, kind, row.submissionId);
  } catch (error) {
    reportSafely(
      deps,
      error,
      { reason: "notice_failure_count_failed", kind, pass },
      { submissionId: row.submissionId, formId: row.formId },
    );
    return;
  }
  if (failures === OPEN_CALL_NOTICE_DEAD_AFTER_FAILURES) {
    reportSafely(
      deps,
      new Error(`open-call notice (${kind}) failed ${failures} times; the reconcile stops retrying it`),
      { reason: "notice_undeliverable", kind, pass },
      { submissionId: row.submissionId, formId: row.formId, failures },
    );
  }
}

/** The row's failure count; a failed read is reported and counts as 0 (keep trying). */
async function failuresOf(
  deps: SweepOpenCallsDeps,
  kind: OpenCallReconcileKind,
  row: Pick<OpenCallReconcileRow, "submissionId" | "formId">,
): Promise<number> {
  try {
    return await readOpenCallNoticeFailures(deps.idempotency, kind, row.submissionId);
  } catch (error) {
    reportSafely(
      deps,
      error,
      { reason: "notice_failure_count_read_failed", kind },
      { submissionId: row.submissionId, formId: row.formId },
    );
    return 0;
  }
}

/**
 * One notice through the notifier, then the ledger read that says whether
 * it settled (the notifier reports per-recipient failures itself and
 * returns; only a throw reaches the catch here). A failure is counted
 * toward the row's dead threshold.
 */
async function sendOne(
  deps: SweepOpenCallsDeps,
  kind: OpenCallReconcileKind,
  row: Pick<OpenCallReconcileRow, "submissionId" | "formId" | "eventId" | "seriesId" | "title">,
  pass: "settle" | "reconcile",
): Promise<NoticeOutcome> {
  try {
    const anchor = anchorOf(row);
    if (kind === "not-this-time") {
      await deps.notices.notifyOpenCallNotThisTime({
        kind: "open_call_not_this_time",
        submissionId: row.submissionId,
        formId: row.formId,
        anchor,
        title: row.title,
        decisionReason: null,
      });
    } else if (kind === "pulled") {
      await deps.notices.notifyOpenCallPulled({
        kind: "open_call_pulled",
        submissionId: row.submissionId,
        formId: row.formId,
        anchor,
        title: row.title,
      });
    } else {
      await deps.notices.notifyOpenCallApplicationReceived({
        kind: "application_received",
        submissionId: row.submissionId,
        formId: row.formId,
      });
    }
  } catch (error) {
    reportSafely(
      deps,
      error,
      { reason: "notice_failed", kind, pass },
      { submissionId: row.submissionId, formId: row.formId },
    );
    await noteFailure(deps, kind, row, pass);
    return "failed";
  }
  const settled = await openCallNoticeWasSent(
    deps.idempotency,
    kind satisfies OpenCallNoticeKind,
    row.submissionId,
  );
  if (settled) return "sent";
  // Unsettled = a recipient failed; the notifier already reported which.
  await noteFailure(deps, kind, row, pass);
  return "failed";
}

async function settleDue(
  deps: SweepOpenCallsDeps,
  due: OpenCallSweepDueRecord[],
  now: Date,
): Promise<{ rejected: Set<string>; expired: Set<string> }> {
  const backstopIds = due.filter((d) => d.verdict === "backstop").map((d) => d.submissionId);
  const pulledIds = due.filter((d) => d.verdict === "pulled").map((d) => d.submissionId);
  return deps.repos.tx(async (tx) => {
    const rejected = await tx.eventApplications.settlePendingOpenCallSubmissions({
      submissionIds: backstopIds,
      status: "REJECTED",
      reviewedAt: now,
    });
    const expired = await tx.eventApplications.settlePendingOpenCallSubmissions({
      submissionIds: pulledIds,
      status: "EXPIRED",
      reviewedAt: now,
    });
    const rejectedSet = new Set(rejected.ids);
    const expiredSet = new Set(expired.ids);
    // One audit row per call and verdict, on the call's anchor (as close).
    const groups = new Map<string, { row: OpenCallSweepDueRecord; ids: string[] }>();
    for (const d of due) {
      const flipped = d.verdict === "backstop" ? rejectedSet : expiredSet;
      if (!flipped.has(d.submissionId)) continue;
      const key = `${d.formId}:${d.verdict}`;
      const g = groups.get(key) ?? { row: d, ids: [] };
      g.ids.push(d.submissionId);
      groups.set(key, g);
    }
    for (const { row, ids } of groups.values()) {
      const anchor = anchorOf(row);
      await tx.audit.log({
        entity: anchor.kind === "event" ? "event" : "event_series",
        entityId: anchor.kind === "event" ? anchor.eventId : anchor.seriesId,
        action: row.verdict === "backstop" ? "open_call_backstop_swept" : "open_call_pulled_swept",
        data: { formId: row.formId, submissionIds: ids, actor: "system" },
        at: now,
      });
    }
    return { rejected: rejectedSet, expired: expiredSet };
  });
}

/** Wall-clock budget for one run, on the injected clock. Reports once. */
class RunBudget {
  private readonly deadline: number;
  exhausted = false;
  constructor(
    private readonly deps: SweepOpenCallsDeps,
    startedAt: Date,
  ) {
    this.deadline = startedAt.getTime() + OPEN_CALL_SWEEP_TIME_BUDGET_MS;
  }
  /** True once the budget is spent; the first time, it is reported. */
  spent(): boolean {
    if (this.exhausted) return true;
    if (this.deps.clock.now().getTime() < this.deadline) return false;
    this.exhausted = true;
    reportSafely(
      this.deps,
      new Error(`sweep-open-calls: time budget ${OPEN_CALL_SWEEP_TIME_BUDGET_MS} ms spent; the rest waits for the next run`),
      { reason: "time_budget_exhausted" },
      { budgetMs: OPEN_CALL_SWEEP_TIME_BUDGET_MS },
    );
    return true;
  }
}

type ReconcileCursor = { at: Date; submissionId: string };

/** Keyset order: (at, submissionId) ascending. */
function compareCursor(a: ReconcileCursor, b: ReconcileCursor): number {
  const d = a.at.getTime() - b.at.getTime();
  if (d !== 0) return d;
  return a.submissionId < b.submissionId ? -1 : a.submissionId > b.submissionId ? 1 : 0;
}

/** The stored resume point, or null (start at the oldest). A failed read is reported and starts over. */
async function readReconcileCursor(
  deps: SweepOpenCallsDeps,
  kind: OpenCallReconcileKind,
): Promise<ReconcileCursor | null> {
  try {
    const raw = await deps.idempotency.get<{ at?: unknown; submissionId?: unknown }>(
      openCallReconcileCursorKey(kind),
    );
    if (!raw || typeof raw.at !== "string" || typeof raw.submissionId !== "string") return null;
    const at = new Date(raw.at);
    return Number.isNaN(at.getTime()) ? null : { at, submissionId: raw.submissionId };
  } catch (error) {
    reportSafely(deps, error, { reason: "reconcile_cursor_read_failed", kind }, {});
    return null;
  }
}

/**
 * Store the resume point (null = start at the oldest). A failed write is
 * reported; the next run resumes from the previously stored cursor (so it
 * re-scans this run's rows; the ledger keeps that from re-sending).
 */
async function writeReconcileCursor(
  deps: SweepOpenCallsDeps,
  kind: OpenCallReconcileKind,
  cursor: ReconcileCursor | null,
): Promise<void> {
  try {
    await deps.idempotency.commit(
      openCallReconcileCursorKey(kind),
      cursor
        ? { at: cursor.at.toISOString(), submissionId: cursor.submissionId }
        : { at: null, submissionId: null },
      RECONCILE_CURSOR_KEEP_SEC,
    );
  } catch (error) {
    reportSafely(deps, error, { reason: "reconcile_cursor_write_failed", kind }, {});
  }
}

async function reconcileKind(
  deps: SweepOpenCallsDeps,
  kind: OpenCallReconcileKind,
  now: Date,
  budget: RunBudget,
): Promise<KindCounts> {
  const counts: KindCounts = {
    scanned: 0,
    alreadySent: 0,
    attempted: 0,
    sent: 0,
    failed: 0,
    skippedDead: 0,
    scanCapped: false,
    passCompleted: false,
  };
  const since = new Date(now.getTime() - OPEN_CALL_RECONCILE_WINDOW_DAYS * DAY_MS);
  const until = new Date(now.getTime() - OPEN_CALL_RECONCILE_MIN_AGE_MS);
  // Resume after the last run's stop; wrap once to the oldest row and stop
  // on reaching the start again. A pass from the oldest needs no wrap.
  const start = await readReconcileCursor(deps, kind);
  let after: ReconcileCursor | null = start;
  let wrapped = start === null;
  scan: for (;;) {
    if (counts.attempted >= OPEN_CALL_RECONCILE_SEND_MAX) break;
    if (budget.spent()) break;
    if (counts.scanned >= OPEN_CALL_RECONCILE_SCAN_MAX) {
      counts.scanCapped = true;
      reportSafely(
        deps,
        new Error(`open-call reconcile (${kind}): scan cap ${OPEN_CALL_RECONCILE_SCAN_MAX} reached`),
        { reason: "reconcile_scan_capped", kind },
        { scanned: counts.scanned },
      );
      break;
    }
    // A query failure is systemic: it propagates and fails the run.
    const page = await deps.repos.eventApplications.listOpenCallNoticeReconcileRows({
      kind,
      since,
      until,
      after,
      limit: Math.min(RECONCILE_PAGE_SIZE, OPEN_CALL_RECONCILE_SCAN_MAX - counts.scanned),
    });
    if (page.length === 0) {
      if (wrapped) {
        counts.passCompleted = true;
        break;
      }
      wrapped = true;
      after = null;
      continue;
    }
    for (const row of page) {
      const here = { at: row.at, submissionId: row.submissionId };
      if (wrapped && start && compareCursor(here, start) > 0) {
        // Back where this run began: every row in the window was reached.
        counts.passCompleted = true;
        break scan;
      }
      if (budget.spent()) break scan;
      const sent = await openCallNoticeWasSent(deps.idempotency, kind, row.submissionId);
      // Dead rows are skipped, so they never take a slot of the send cap.
      const dead = !sent && isOpenCallNoticeDead(await failuresOf(deps, kind, row));
      if (!sent && !dead && counts.attempted >= OPEN_CALL_RECONCILE_SEND_MAX) break scan;
      counts.scanned += 1;
      after = here;
      if (sent) {
        counts.alreadySent += 1;
        continue;
      }
      if (dead) {
        counts.skippedDead += 1;
        continue;
      }
      counts.attempted += 1;
      const outcome = await sendOne(deps, kind, row, "reconcile");
      if (outcome === "sent") counts.sent += 1;
      else counts.failed += 1;
    }
  }
  await writeReconcileCursor(deps, kind, counts.passCompleted ? null : after);
  return counts;
}

/** FR-021 backstop + FR-022 pulled calls + the notice reconcile. */
export async function sweepOpenCalls(
  deps: SweepOpenCallsDeps,
  rawInput: unknown = {},
): Promise<SweepOpenCallsOutput> {
  const input = parseInput(sweepOpenCallsInputSchema, rawInput ?? {});
  const now = deps.clock.now();
  const limit = input.batchMax ?? OPEN_CALL_SWEEP_BATCH_MAX;
  const budget = new RunBudget(deps, now);

  // 1. Settle. A failing read or flip is systemic: it throws.
  const due = await deps.repos.eventApplications.listOpenCallSweepDue({ now, limit });
  const { rejected, expired } =
    due.length > 0 ? await settleDue(deps, due, now) : { rejected: new Set<string>(), expired: new Set<string>() };

  let noticesSent = 0;
  let noticesFailed = 0;
  let noticesDeferred = 0;
  for (const d of due) {
    const flipped = d.verdict === "backstop" ? rejected.has(d.submissionId) : expired.has(d.submissionId);
    if (!flipped) continue;
    // Out of time: the flip is committed and its notice is owed in the
    // ledger, so the reconcile sends it on a later run.
    if (budget.spent()) {
      noticesDeferred += 1;
      continue;
    }
    const kind: OpenCallReconcileKind = d.verdict === "backstop" ? "not-this-time" : "pulled";
    const outcome = await sendOne(deps, kind, d, "settle");
    if (outcome === "sent") noticesSent += 1;
    else noticesFailed += 1;
  }

  // 2. Reconcile. This run's own flips are younger than the min age, so
  // they are not attempted twice here; a miss is picked up next run.
  const reconcile = {
    "not-this-time": await reconcileKind(deps, "not-this-time", now, budget),
    pulled: await reconcileKind(deps, "pulled", now, budget),
    received: await reconcileKind(deps, "received", now, budget),
  };

  const result: SweepOpenCallsOutput = {
    due: due.length,
    backstopRejected: rejected.size,
    pulledExpired: expired.size,
    lostRace: due.length - rejected.size - expired.size,
    noticesSent,
    noticesFailed,
    noticesDeferred,
    timeBudgetExhausted: budget.exhausted,
    reconcile,
  };
  deps.logger?.info("open_call.sweep_completed", { category: "open_call", ...result });

  // 3. Verdict: enough notices were due and NONE settled → something
  // systemic (no mailer, a dead store, a missing secret). Throw so the run
  // fails loudly; flips are committed and the ledger is open, so the next
  // run retries. Fewer attempts than the threshold: the per-item reports
  // already went out (one dead address is not an outage). Dead rows are not
  // attempted at all (skippedDead), so they never reach this count.
  const attempted =
    noticesSent +
    noticesFailed +
    reconcile["not-this-time"].attempted +
    reconcile.pulled.attempted +
    reconcile.received.attempted;
  const settled =
    noticesSent +
    reconcile["not-this-time"].sent +
    reconcile.pulled.sent +
    reconcile.received.sent;
  if (attempted >= OPEN_CALL_SWEEP_SYSTEMIC_MIN_ATTEMPTS && settled === 0) {
    throw new Error(
      `sweep-open-calls: ${attempted} notice(s) attempted and none settled (systemic failure)`,
    );
  }

  return sweepOpenCallsOutputSchema.parse(result);
}
