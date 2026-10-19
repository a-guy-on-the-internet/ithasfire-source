import { createHash, randomUUID } from "node:crypto";

import type { ClockPort } from "@th/ports/clock";
import type { MailerPort } from "@th/ports/comms/mailer";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { RateLimitPort } from "@th/ports/rate-limit";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { EventHumanRecord } from "@th/ports/repos/event-humans";
import type { EventRecord } from "@th/ports/repos/events";

import { PUBLIC_LINEUP_ROLES } from "../../lib/event-human-roles";
import { describeError } from "../../lib/io";
import {
  channelsForRecipient,
  loadVerifiedRecipientIds,
} from "../../lib/verified-recipients";
import { isEverPaidTicketType } from "../../lib/orders/door-pricing";
import type { NotifyInput, NotifyOutput } from "../comms/notify";
import {
  formatLineupFullWhen,
  LINEUP_ADDED_VARIANT,
} from "../comms/lineup-renderers";
import {
  displayNameForCopy,
  lineupRoleLabel,
  normalizeBaseUrl,
  leaveNoticeReachesSomeoneElse,
  listLineupEditorHumanIds,
  reportSafely,
  resolveHumanAdminSlug,
  resolveOrganiserName,
} from "./_shared/lineup-notice-support";
import {
  LINEUP_SWEEP_MAX_CONTINUATIONS,
  LINEUP_SWEEP_OWED_SAMPLE_MAX,
  scheduleLineupSweepContinuation,
  type LineupSweepContinuation,
} from "./_shared/lineup-sweep-continuation";

// ─────────────────────────────────────────────────────────────────────────────
// "You're on the lineup" (owner ruling "option A", 2026-09-30).
//
// An editor may put a real person on a lineup without asking; the person is
// TOLD, and can take themselves off (`leaveEventLineup`). Timing:
//
//   · attached to a PUBLISHED event → told right after the attach commits;
//   · attached to anything else (a DRAFT) → told when the event is published;
//   · exactly once per EventHuman ROW — across unpublish → republish, and for
//     rows added while the event was un-published again. A row removed and
//     re-added is a new row, so it is told again;
//   · never the actor about attaching themselves.
//
// ── Exactly-once, durably ────────────────────────────────────────────────────
// notify()'s own idempotency window is ~60s and the mail adapter's ~120s, so
// neither can carry "once, ever". This uses the IdempotencyPort as a durable
// ledger (no schema change). It is a 10-YEAR ledger — see the note on
// `IdempotencyPort` (packages/ports) and at its construction in
// apps/api/src/lib/dep.ts: changing the backend or namespace drops it.
//
//   OWED    `lineup-notice:owed:{eventHumanId}` — who added the person and
//           how. Written BEFORE the row's transaction begins, OUTSIDE it
//           (no non-tx I/O inside an interactive tx): attach pre-generates the
//           row id it inserts with; invite already knows it. So a crash between commit and any
//           post-commit step can no longer lose the fact that the row is
//           owed. A rolled-back tx leaves an orphan OWED for a row id that
//           never existed (attach) or stayed unlinked (invite) — inert: the
//           sweep only visits existing rows with a linked human.
//           Its presence is what makes a row eligible; its absence is why the
//           publish sweep never notifies rows this feature did not create:
//           volunteer-signup and booking-minted rows (written straight through
//           `tx.eventHumans.attach`, never via these hooks), self-attached
//           rows (never recorded), and every row that predates this feature.
//   SENT    `lineup-notice:sent:{eventHumanId}` — atomic claim (`begin`,
//           owner token) before the send, committed after it. A lost `begin`
//           = "already sent, or being sent right now" → skip. A failed send
//           releases the claim, so the next publish (or continuation run)
//           retries. A failure AFTER the notice went out never releases it:
//           see `sendLineupAdded`'s `delivered`.
//   INVITE  `lineup-notice:invite:{eventHumanId}` — the same claim shape for
//           the payout invite email: at most one per row, ever.
//   RECENT  `lineup-notice:recent:{eventId}:{humanId}` — 7-DAY record written
//           when a notice is actually sent (owner ruling: once per 7 days per
//           person per event). While it lives, a re-added row is suppressed
//           (SENT committed as `suppressed`, nothing sent). A SELF-leave
//           clears it (owner ruling): a re-add after the person removed
//           themselves is always told; editor add/remove loops are not.
//
// Why not the in-tx "attached" audit row as the OWED source: rows that
// predate this feature carry exactly the same audit shape, so every legacy
// lineup would be mailed on its next republish; and AuditLog has no index on
// entityId, so the sweep would scan every event_human audit row per publish.
//
// ── The one duplicate window, accepted ───────────────────────────────────────
// The SENT claim lapses on its TTL (SEND_CLAIM_TTL_SEC, 300s), so a sender
// that is KILLED between "the notice is out" and `commit(sentKey)` — a Cloud
// Run instance shut down mid-sweep, before even the best-effort re-settle and
// the RECENT write — leaves the row with no claim and no record. A
// continuation run lands at ≥330s by design, its `begin` succeeds, and the
// person is told a SECOND time. notify()'s own ~60s key does not span that
// gap, and cannot: the API writes it in namespace "api" and the jobs process
// in "jobs", so on the continuation path the SENT claim is the only guard.
// The window predates the continuation (a future republish reached it); what
// is new is that it is now reached automatically, within ~6 minutes. ACCEPTED:
// the cost is one repeated "you're on the lineup" notice, no money and no
// state change, and the alternative (not retrying a lapsed claim) silently
// drops the notice for every instance that dies mid-send.
// ─────────────────────────────────────────────────────────────────────────────

const NOTICE_LEDGER_KEEP_SEC = 10 * 365 * 24 * 60 * 60;
const SEND_CLAIM_TTL_SEC = 300;
/** Past SEND_CLAIM_TTL_SEC before a continuation retries a held claim. */
const HELD_CLAIM_MARGIN_MS = 30_000;
/** Publish-sweep fan-out width: bounded so a big lineup never floods SMTP. */
const SWEEP_CONCURRENCY = 4;
export const INVITE_RECIPIENT_MAX = 3;
export const LINEUP_RECIPIENT_MAX = 10;
const RECIPIENT_WINDOW_SEC = 24 * 60 * 60;

/** Default wall-clock budget for starting publish-sweep sends. */
export const LINEUP_SWEEP_BUDGET_MS = 10_000;
/** Owner ruling: at most one lineup-added notice per (event, person) per 7 days. */
export const LINEUP_NOTICE_COOLDOWN_SEC = 7 * 24 * 60 * 60;

export function lineupNoticeOwedKey(eventHumanId: string): string {
  return `lineup-notice:owed:${eventHumanId}`;
}

export function lineupNoticeSentKey(eventHumanId: string): string {
  return `lineup-notice:sent:${eventHumanId}`;
}

export function lineupNoticeInviteKey(eventHumanId: string): string {
  return `lineup-notice:invite:${eventHumanId}`;
}

/** Per (event, person), not per row: survives a remove → re-add. */
export function lineupNoticeRecentKey(eventId: string, humanId: string): string {
  return `lineup-notice:recent:${eventId}:${humanId}`;
}

/** What the OWED record holds. */
export type LineupNoticeOwedRecord = {
  /**
   * The PERSON who put them on. Null only for a booking LATE JOIN (lineup
   * v3 FR-010) whose sender is a GROUP — see `addedByOrgId`. A null adder
   * never matches the row's person, so the self-skip below cannot fire.
   */
  addedByHumanId: string | null;
  /**
   * The GROUP that put them on: a booking late join from an org sender
   * (lineup v3 FR-010). Absent on every other path.
   */
  addedByOrgId?: string | null;
  /**
   * The adder's display name when the caller knows it better than a
   * `humans` lookup of `addedByHumanId` can (a booking's sender, which may
   * be a group). Absent on every other path.
   */
  addedByName?: string;
  /**
   * `invite` = the row was linked by `inviteLineupHumanToRegister`, which
   * EMAILS the person its own invite. Their lineup notice then goes in-app
   * and push only, so one event never mails them twice.
   */
  via: "attach" | "invite";
};

export type LineupNoticeTrigger =
  | {
      /**
       * `attachEventHuman` created a NEW linked row (not a re-attach) — or a
       * booking late join put a joined act on the lineup (lineup v3 FR-010).
       */
      kind: "attached";
      eventId: string;
      eventHumanId: string;
      /** See {@link LineupNoticeOwedRecord.addedByHumanId}. */
      addedByHumanId: string | null;
      /** See {@link LineupNoticeOwedRecord.addedByOrgId}. */
      addedByOrgId?: string | null;
      /** See {@link LineupNoticeOwedRecord.addedByName}. */
      addedByName?: string;
    }
  | {
      /** `inviteLineupHumanToRegister` linked a free-text row to a person. */
      kind: "invited";
      eventId: string;
      eventHumanId: string;
      addedByHumanId: string;
      /** The person this invite linked. A row now linked to anyone else lost a race. */
      humanId: string;
      /** The address the editor typed — where the payout invite goes. */
      email: string;
    }
  | {
      /**
       * `publishEvent` or `publishCommunityListing` moved the event to
       * PUBLISHED (first or re-publish).
       */
      kind: "published";
      eventId: string;
      /**
       * Wall-clock budget for STARTING sends (default
       * {@link LINEUP_SWEEP_BUDGET_MS}). Sends already in flight always run
       * to completion or release their claim; rows not reached stay OWED and
       * are handed to a continuation run (`sweepContinuation`), or reported.
       */
      budgetMs?: number;
      /**
       * 0 (default) = the publish request's own sweep; n = the nth
       * continuation run (`lineup-notices.continue-sweep`). At
       * {@link LINEUP_SWEEP_MAX_CONTINUATIONS} an overflow gives up.
       */
      attempt?: number;
    };

export type NotifyLineupNoticesFn = (
  trigger: LineupNoticeTrigger,
) => Promise<void>;

export type RecordLineupNoticeOwedArgs = {
  eventHumanId: string;
  /** See {@link LineupNoticeOwedRecord.addedByHumanId}. */
  addedByHumanId: string | null;
  /** See {@link LineupNoticeOwedRecord.addedByOrgId}. */
  addedByOrgId?: string | null;
  /** See {@link LineupNoticeOwedRecord.addedByName}. */
  addedByName?: string;
  via: LineupNoticeOwedRecord["via"];
};

/**
 * The two hooks the lineup-writing use cases take. `recordOwed` runs BEFORE
 * the row's transaction commits (see the ledger note above); `dispatch` runs
 * after it. Both swallow and report — neither can fail the mutation.
 */
export type LineupNoticeHooks = {
  recordOwed: (args: RecordLineupNoticeOwedArgs) => Promise<void>;
  dispatch: NotifyLineupNoticesFn;
  /**
   * Owner ruling: a self-LEAVE clears the 7-day re-add cooldown for that
   * (event, person), so a re-add after the person removed themselves is
   * always told. Never throws; reports.
   */
  clearCooldown: (args: { eventId: string; humanId: string }) => Promise<void>;
};

type NotifyFn = (input: NotifyInput) => Promise<NotifyOutput>;

export type NotifyLineupNoticesDeps = {
  repos: Pick<
    Repos,
    "events" | "eventHumans" | "humans" | "organizations" | "entityPages"
  >;
  idempotency: IdempotencyPort;
  /** Bind `notifyWithEmail` where available — the notice has an email leg. */
  notify: NotifyFn;
  /**
   * Sends the payout INVITE directly (template `event.lineup_payout_invite`).
   * Not through notify(): the invitee is usually a shadow profile, and
   * notify()'s email leg skips every unverified address by construction
   * (`channels/send-email.ts`, the same reason `notify-booking-inquirer.ts`
   * and `booking-requests/_shared/invite-email.ts` mail directly). Absent →
   * the invite is not sent, and that is reported.
   */
  mailer?: MailerPort | null;
  /** Web origin for `/my-lineups` and the invite links. */
  publicAppUrl: string | null;
  /** "Has the event ended?" for the copy. Defaults to the system clock. */
  clock?: ClockPort;
  /**
   * Per-RECIPIENT caps (fail open, reported): at most
   * {@link INVITE_RECIPIENT_MAX} payout invites per address per day — the
   * invite carries editor-controlled text to any typed address — and at most
   * {@link LINEUP_RECIPIENT_MAX} lineup-added emails/pushes per person per
   * day across all events (past it they are still told, in-app only).
   * Absent = no caps.
   */
  rateLimit?: RateLimitPort | null;
  logger?: LoggerPort;
  /**
   * Reports every swallowed failure (a notice that did not go out). The
   * mutation that triggered it has already committed and is never failed.
   */
  reportError?: ReporterPort;
  /**
   * Continues a publish sweep that ran out of budget: one delayed
   * `lineup-notices.continue-sweep` run per overflow (Cloud Tasks), up to
   * {@link LINEUP_SWEEP_MAX_CONTINUATIONS}. Absent/null = leftover rows are
   * reported and wait for a future publish.
   */
  sweepContinuation?: LineupSweepContinuation | null;
};

/**
 * Pre-commit OWED write. Never throws: an idempotency outage must not fail
 * the lineup write. On failure it reports, and the post-commit `dispatch`
 * (attached / invited) writes the record again.
 */
export async function recordLineupNoticeOwed(
  deps: Pick<NotifyLineupNoticesDeps, "idempotency" | "logger" | "reportError">,
  args: RecordLineupNoticeOwedArgs,
): Promise<void> {
  try {
    await writeOwed(deps, args);
  } catch (error) {
    reportFailure(deps, deps.logger, error, "owed_write_failed", {
      eventHumanId: args.eventHumanId,
    });
  }
}

/**
 * Post-commit lineup notice dispatcher. The CALLER (attach / invite /
 * publish) wraps this in its own swallow as well; inside, each recipient is
 * isolated so one failed send never blocks the next.
 */
export async function notifyLineupNotices(
  deps: NotifyLineupNoticesDeps,
  trigger: LineupNoticeTrigger,
): Promise<void> {
  const logger = deps.logger?.child({ useCase: "notifyLineupNotices" });

  if (trigger.kind === "published") {
    await sweepPublished(
      deps,
      logger,
      trigger.eventId,
      trigger.budgetMs ?? LINEUP_SWEEP_BUDGET_MS,
      trigger.attempt ?? 0,
    );
    return;
  }

  const owed: LineupNoticeOwedRecord = {
    addedByHumanId: trigger.addedByHumanId,
    ...(trigger.kind === "attached" && trigger.addedByOrgId
      ? { addedByOrgId: trigger.addedByOrgId }
      : {}),
    ...(trigger.kind === "attached" && trigger.addedByName
      ? { addedByName: trigger.addedByName }
      : {}),
    via: trigger.kind === "invited" ? "invite" : "attach",
  };
  // Normally already written pre-commit; re-written here (same value) so a
  // failed pre-commit write heals.
  await writeOwed(deps, { eventHumanId: trigger.eventHumanId, ...owed });

  const baseUrl = requireBaseUrl(deps, logger, trigger.eventId);
  if (!baseUrl) return;

  const [event, row] = await Promise.all([
    deps.repos.events.getById(trigger.eventId),
    deps.repos.eventHumans.getById(trigger.eventHumanId),
  ]);
  // Gone already (deleted, or detached in between): nothing to tell.
  if (!event || !row || !row.humanId || row.eventId !== event.id) return;
  // Never the actor about their own name.
  if (row.humanId === owed.addedByHumanId) return;

  if (trigger.kind === "invited") {
    if (row.humanId !== trigger.humanId) {
      // Two invites raced on one free-text row and this one's link was
      // overwritten. The winner's own dispatch tells the winner.
      reportFailure(
        deps,
        logger,
        new Error("lineup_invite_link_lost_race"),
        "invite_link_lost_race",
        { eventId: event.id, eventHumanId: row.id, humanId: trigger.humanId },
      );
      return;
    }
    await sendPayoutInvite(deps, logger, baseUrl, event, row, owed, trigger.email);
  }

  if (event.status === "PUBLISHED") {
    await sendLineupAdded(deps, logger, baseUrl, event, row, owed);
  }
}

/** Factory for the injected hooks. */
export function makeLineupNoticeHooks(
  deps: NotifyLineupNoticesDeps,
): LineupNoticeHooks {
  return {
    recordOwed: (args) => recordLineupNoticeOwed(deps, args),
    dispatch: (trigger) => notifyLineupNotices(deps, trigger),
    clearCooldown: (args) => clearLineupNoticeCooldown(deps, args),
  };
}

// ── Publish sweep ────────────────────────────────────────────────────────────

/**
 * What one sweep pass did.
 *  - `skipped`: nothing to sweep (event gone / not published / no linked
 *    rows / no web origin — the last one reported).
 *  - `complete`: every linked row was reached and none is left to retry.
 *  - `continued`: rows were left (not reached, a failed send, or a SENT
 *    claim held by another sender) and a continuation run is queued.
 *  - `unfinished`: rows were left and nothing will continue them (no
 *    scheduler, or the scheduler REFUSED) — reported.
 *  - `unconfirmed`: rows were left and the scheduler never answered, so
 *    whether a continuation is queued is unknown — reported, but NOT as
 *    abandoned rows, and the caller must not retry (a retry would queue a
 *    second chain for the same attempt). See
 *    `LINEUP_SWEEP_SCHEDULE_TIMEOUT_MS`.
 *  - `gave_up`: rows were left on the last allowed continuation — reported.
 */
export type LineupSweepResult = {
  outcome:
    | "skipped"
    | "complete"
    | "continued"
    | "unfinished"
    | "unconfirmed"
    | "gave_up";
  /** Linked rows on the event. */
  rowsTotal: number;
  /** Rows never started (the time budget ran out). */
  rowsNotReached: number;
  /** Rows whose send failed (claim released for a retry). */
  rowsFailed: number;
  /** Rows whose SENT claim another sender holds (retried after it lapses). */
  rowsHeld: number;
  /** Rows reached that had an OWED record. */
  rowsOwed: number;
};

/**
 * One sweep pass over a PUBLISHED event's owed lineup rows — the publish
 * trigger's body, exported for the continuation job
 * (`continue-lineup-notice-sweep.ts`). Never throws for a row; reports.
 */
export async function runLineupNoticeSweep(
  deps: NotifyLineupNoticesDeps,
  args: {
    eventId: string;
    budgetMs: number;
    attempt: number;
    /**
     * Called once per row whose OWED record was READ (`owed` = it had one).
     * The continuation's drift detector uses it to check the rows the
     * asking sweep read as owed. Must not throw.
     */
    onOwedRead?: (eventHumanId: string, owed: boolean) => void;
  },
): Promise<LineupSweepResult> {
  return sweepPublished(
    deps,
    deps.logger?.child({ useCase: "notifyLineupNotices" }),
    args.eventId,
    args.budgetMs,
    args.attempt,
    args.onOwedRead,
  );
}

async function sweepPublished(
  deps: NotifyLineupNoticesDeps,
  logger: LoggerPort | undefined,
  eventId: string,
  budgetMs: number,
  attempt: number,
  onOwedRead?: (eventHumanId: string, owed: boolean) => void,
): Promise<LineupSweepResult> {
  const skipped: LineupSweepResult = {
    outcome: "skipped",
    rowsTotal: 0,
    rowsNotReached: 0,
    rowsFailed: 0,
    rowsHeld: 0,
    rowsOwed: 0,
  };
  const deadline = Date.now() + budgetMs;
  const event = await deps.repos.events.getById(eventId);
  if (!event || event.status !== "PUBLISHED") return skipped;

  const rows = (await deps.repos.eventHumans.listByEvent(eventId)).filter(
    (row): row is EventHumanRecord & { humanId: string } =>
      row.humanId !== null,
  );
  if (rows.length === 0) return skipped;

  const baseUrl = requireBaseUrl(deps, logger, eventId);
  if (!baseUrl) return { ...skipped, rowsTotal: rows.length };

  let rowsFailed = 0;
  let rowsHeld = 0;
  let rowsOwed = 0;
  // Ids of rows read as owed, for the continuation's drift detector
  // (LineupSweepContinuePayload.owedSample). Bounded.
  const owedSample: string[] = [];
  const notStarted = await forEachWithConcurrency(
    rows,
    SWEEP_CONCURRENCY,
    () => Date.now() < deadline,
    async (row) => {
      try {
        const owed = await deps.idempotency.get<LineupNoticeOwedRecord>(
          lineupNoticeOwedKey(row.id),
        );
        onOwedRead?.(row.id, owed !== null);
        if (!owed) return;
        rowsOwed += 1;
        if (owedSample.length < LINEUP_SWEEP_OWED_SAMPLE_MAX) {
          owedSample.push(row.id);
        }
        if (row.humanId === owed.addedByHumanId) return;
        const outcome = await sendLineupAdded(
          deps,
          logger,
          baseUrl,
          event,
          row,
          owed,
        );
        if (outcome === "failed") rowsFailed += 1;
        if (outcome === "held") rowsHeld += 1;
      } catch (error) {
        rowsFailed += 1;
        reportFailure(deps, logger, error, "sweep_row_failed", {
          eventId,
          eventHumanId: row.id,
        });
      }
    },
  );
  const counts = {
    rowsTotal: rows.length,
    rowsNotReached: notStarted,
    rowsFailed,
    rowsHeld,
    rowsOwed,
  };
  const left = notStarted + rowsFailed + rowsHeld;
  if (left === 0) return { outcome: "complete", ...counts };

  const extra = { eventId, ...counts, budgetMs, attempt };
  const nextAttempt = attempt + 1;
  if (nextAttempt > LINEUP_SWEEP_MAX_CONTINUATIONS) {
    // The last allowed continuation also ran out. The rest stay OWED and wait
    // for a future publish of this event. Loud, so a pile-up is visible.
    reportFailure(
      deps,
      logger,
      new Error("lineup_sweep_gave_up"),
      "sweep_continuation_gave_up",
      extra,
    );
    return { outcome: "gave_up", ...counts };
  }
  if (deps.sweepContinuation) {
    const status = await scheduleLineupSweepContinuation(
      {
        continuation: deps.sweepContinuation,
        ...(deps.clock ? { clock: deps.clock } : {}),
        ...(logger ? { logger } : {}),
        ...(deps.reportError ? { reportError: deps.reportError } : {}),
      },
      {
        eventId,
        attempt: nextAttempt,
        // Only THIS sweep can tell "no OWED record anywhere" (healthy: a
        // lineup of volunteer/booking-minted rows) from "the ledger this
        // process reads is the wrong one". The continuation cannot re-derive
        // it, so it travels in the payload.
        owedSeen: rowsOwed > 0,
        // WHICH rows: lets the continuation tell drift from "every owed row
        // was removed from the lineup in between" (see owedSample).
        owedSample,
        // A held claim may be a dead instance's: run after it has lapsed.
        ...(rowsHeld > 0
          ? { minDelayMs: SEND_CLAIM_TTL_SEC * 1000 + HELD_CLAIM_MARGIN_MS }
          : {}),
      },
    );
    if (status === "scheduled" || status === "duplicate") {
      // Handed off, not lost: info, not a report.
      logger?.info("event_humans.lineup_notice.sweep_continued", {
        ...extra,
        nextAttempt,
        status,
      });
      return { outcome: "continued", ...counts };
    }
    if (status === "timeout") {
      // The scheduler never answered, so the task may well exist (the
      // adapter's own answers — its request abort, and a ScheduleNotSentError
      // when its token fetch fails or overruns — produce a `failed`;
      // see LINEUP_SWEEP_SCHEDULE_TIMEOUT_MS). Reported —
      // these rows need a human eye — but NOT as "nothing will continue
      // this sweep": a caller that retried on that reading would queue a
      // SECOND chain for the same attempt.
      reportFailure(
        deps,
        logger,
        new Error("lineup_sweep_continuation_unconfirmed"),
        "sweep_continuation_unconfirmed",
        { ...extra, nextAttempt },
      );
      return { outcome: "unconfirmed", ...counts };
    }
    // The scheduling REFUSAL is already reported; the shortfall is below.
  }
  // Nothing will continue this sweep: the rest stay OWED and wait for a
  // future publish of this event. Loud, so a pile-up is visible.
  reportFailure(
    deps,
    logger,
    new Error("lineup_sweep_budget_exhausted"),
    "sweep_budget_exhausted",
    extra,
  );
  return { outcome: "unfinished", ...counts };
}

/**
 * The awaited post-publish step both publish use cases run after commit.
 * Awaited on purpose: Cloud Run (`cpu_idle`) starves work left running after
 * the response. Bounded by the sweep's time budget and concurrency; rows it
 * does not reach go to a delayed continuation run (`sweepContinuation`).
 * NEVER throws — a notice failure must not turn a committed publish into an
 * error — and a throwing reporter is guarded.
 */
export async function sweepLineupNoticesAfterPublish(
  deps: {
    lineupNotices?: Pick<LineupNoticeHooks, "dispatch">;
    reportError?: ReporterPort;
    logger?: LoggerPort;
  },
  eventId: string,
  useCase: string,
): Promise<void> {
  if (!deps.lineupNotices) return;
  try {
    await deps.lineupNotices.dispatch({ kind: "published", eventId });
  } catch (error) {
    deps.logger?.error(`${useCase}.lineup_notice_failed`, {
      eventId,
      error: describeError(error),
    });
    reportSafely(deps.reportError, error, {
      tags: { useCase, stage: "lineup_notice" },
      extra: { eventId },
    });
  }
}

/** See {@link LineupNoticeHooks.clearCooldown}. */
export async function clearLineupNoticeCooldown(
  deps: Pick<NotifyLineupNoticesDeps, "idempotency" | "logger" | "reportError">,
  args: { eventId: string; humanId: string },
): Promise<void> {
  try {
    // The port has no delete: overwrite with an explicit "cleared" value
    // (honoured by `recentlyNotified` at once) that also lapses in a second.
    await deps.idempotency.commit(
      lineupNoticeRecentKey(args.eventId, args.humanId),
      { clearedByLeave: true },
      1,
    );
  } catch (error) {
    reportFailure(deps, deps.logger, error, "cooldown_clear_failed", args);
  }
}

// ── Senders ──────────────────────────────────────────────────────────────────

/**
 * Owner ruling (2026-09-30): the same person on the same event is told at
 * most ONCE PER 7 DAYS. A remove → re-add inside that window is a new row,
 * but it sends nothing (the row still shows in their `/my-lineups`).
 *
 * THE one place a send-time policy check lives: every "you're on the lineup"
 * send — attach-now and the publish sweep alike — passes through here after
 * taking the row's SENT claim. `true` = skip the send; the caller then
 * commits SENT as suppressed so the sweep never retries the row.
 */
async function recentlyNotified(
  deps: NotifyLineupNoticesDeps,
  event: EventRecord,
  humanId: string,
): Promise<boolean> {
  const recent = await deps.idempotency.get<{ clearedByLeave?: boolean }>(
    lineupNoticeRecentKey(event.id, humanId),
  );
  return recent !== null && recent.clearedByLeave !== true;
}

/**
 * What one `sendLineupAdded` call did. `failed` = the claim was released for
 * a retry; `held` = another sender holds the row's SENT claim (in flight, or
 * a dead instance's claim until it lapses) — the sweep retries both later.
 * `skipped` = nothing more to do for this row, including the case where the
 * notice WENT OUT but its ledger write failed: that row keeps its claim and
 * is deliberately not retried (see `delivered` below).
 */
type LineupSendOutcome = "sent" | "skipped" | "failed" | "held";

async function sendLineupAdded(
  deps: NotifyLineupNoticesDeps,
  logger: LoggerPort | undefined,
  baseUrl: string,
  event: EventRecord,
  row: EventHumanRecord,
  owed: LineupNoticeOwedRecord,
): Promise<LineupSendOutcome> {
  const humanId = row.humanId;
  if (!humanId) return "skipped";

  const sentKey = lineupNoticeSentKey(row.id);
  const token = randomUUID();
  const claimed = await deps.idempotency.begin(
    sentKey,
    SEND_CLAIM_TTL_SEC,
    token,
  );
  // Already sent (committed), or another request is sending it right now — or
  // a dead instance's claim that lapses after SEND_CLAIM_TTL_SEC ("held": the
  // sweep retries it later).
  if (!claimed) {
    try {
      // Keyed off SETTLED, not "in_progress": `status` is OPTIONAL on the
      // port, so where it is absent `get` stands in — it answers non-null
      // only for a COMMITTED record, so a live claim still reads as held on
      // every backend instead of collapsing to "skipped" and dropping the
      // row from the continuation. It also stops a `failed` record reading
      // as "already told".
      const settled = deps.idempotency.status
        ? (await deps.idempotency.status(sentKey)) === "succeeded"
        : (await deps.idempotency.get(sentKey)) !== null;
      return settled ? "skipped" : "held";
    } catch (error) {
      // The probe is not the send, so its failure must not drop the row:
      // "held" costs one more continuation run, "skipped" would lose the
      // notice — and the claim this row already carries makes that rerun
      // safe. Swallowed HERE because this sits outside the try below, and
      // the attach/invite caller has no per-row catch of its own.
      reportFailure(deps, logger, error, "claim_probe_failed", {
        eventId: event.id,
        eventHumanId: row.id,
        humanId,
      });
      return "held";
    }
  }

  // "The notice is OUT." Everything after this point is BOOKKEEPING, and no
  // bookkeeping failure may release the claim: a second notice (and a second
  // email) is worse for the person than a ledger row that never got written.
  let delivered = false;
  try {
    if (await recentlyNotified(deps, event, humanId)) {
      await deps.idempotency.commit(
        sentKey,
        { suppressed: "recent", humanId, at: new Date().toISOString() },
        NOTICE_LEDGER_KEEP_SEC,
      );
      logger?.info("event_humans.lineup_notice.suppressed_recent", {
        eventId: event.id,
        eventHumanId: row.id,
        humanId,
      });
      return "skipped";
    }
    const addedByName =
      owed.addedByName?.trim() ||
      (await resolveAdderName(deps, event, owed.addedByHumanId));
    // Across-events cap: past it the person is still TOLD (in-app), but no
    // more email or push today — adding someone to many lineups cannot be
    // turned into an inbox flood.
    const quiet = !(await withinRecipientCap(
      deps,
      logger,
      `lineup-notice:recipient:${humanId}`,
      LINEUP_RECIPIENT_MAX,
      { eventId: event.id, eventHumanId: row.id, humanId },
    ));
    if (quiet) {
      reportFailure(
        deps,
        logger,
        new Error("lineup_added_recipient_capped"),
        "lineup_recipient_capped",
        { eventId: event.id, eventHumanId: row.id, humanId },
      );
    }
    // B2 (owner ruling 2026-10-16): the row was linked BY EMAIL, so an
    // unverified account may be a squatter's. In-app and push go only to an
    // account that proved its inbox, and notify()'s email leg skips an
    // unverified address by itself (channels/send-email.ts), so an unverified
    // recipient would get NOTHING: settle the row without calling notify()
    // and WITHOUT opening the 7-day window (nobody was told, so a later
    // re-add must not be suppressed by it). Verifying later does not resend.
    const lookup = { failed: false };
    const verified = await loadVerifiedRecipientIds({
      humans: deps.repos.humans,
      humanIds: [humanId],
      onLookupFailed: (error) => {
        lookup.failed = true;
        reportFailure(deps, logger, error, "verified-lookup-failed", {
          eventId: event.id,
          eventHumanId: row.id,
          humanId,
        });
      },
    });
    const emailOff = owed.via === "invite" || quiet;
    if (!lookup.failed && !verified.has(humanId)) {
      await deps.idempotency.commit(
        sentKey,
        { suppressed: "unverified", humanId, at: new Date().toISOString() },
        NOTICE_LEDGER_KEEP_SEC,
      );
      logger?.info("event_humans.lineup_notice.suppressed_unverified", {
        eventId: event.id,
        eventHumanId: row.id,
        humanId,
      });
      return "skipped";
    }
    // A failed lookup sends email only (notify() still mails a verified
    // address). Whenever that email leg does not send (email off here, or
    // skipped/failed after notify below), the row is released as failed for
    // retry, never committed as told.
    if (lookup.failed && emailOff) {
      throw new Error("lineup_added_verified_lookup_failed");
    }
    const result = await deps.notify({
      humanId,
      variant: LINEUP_ADDED_VARIANT,
      idempotencyKey: `lineup-added:${row.id}`,
      scope: { kind: "EVENT", eventId: event.id },
      payload: {
        eventId: event.id,
        eventHumanId: row.id,
        eventTitle: event.title,
        startsAtIso: event.startsAt.toISOString(),
        timezone: event.timezone || null,
        roleLabel: lineupRoleLabel(row.role, row.customRoleLabel),
        addedByName,
        lineupsUrl: `${baseUrl}/my-lineups`,
        publiclyListed: isPubliclyListed(event, row),
        eventEnded: eventHasEnded(event, deps.clock?.now() ?? new Date()),
        organiserWillBeTold: await organiserWillBeTold(
          deps,
          logger,
          event,
          humanId,
        ),
      },
      channels: {
        sms: { enabled: false },
        // The payout invite already emailed this person about this event.
        ...(emailOff ? { email: { enabled: false } } : {}),
        ...(quiet ? { push: { enabled: false } } : {}),
        // Lookup failed: email only (a verified recipient's set is exact).
        ...channelsForRecipient(verified, humanId).channels,
      },
    });
    // Lookup failed and the email did not go out (an unverified address is
    // skipped by notify() itself, or the mailer failed): with in-app and push
    // off nobody was told, so release the row as failed (retryable) instead
    // of opening the 7-day window and committing it as told.
    if (lookup.failed && result.email?.status !== "sent") {
      throw new Error("lineup_added_verified_lookup_failed");
    }
    delivered = true;
    // BEFORE the SENT commit, on purpose: the 7-day window opens at DELIVERY,
    // not at the ledger write. If the commit below fails and the claim later
    // lapses on its TTL, this RECENT record is what still suppresses a second
    // notice (a future sweep commits the row as `suppressed: "recent"`).
    await startCooldown(deps, logger, event.id, row.id, humanId);
    // notify() does not throw when the mailer fails — the leg comes back
    // `failed` and is only logged at warn (invisible to Sentry). Reported
    // before the commit so a failing commit cannot hide it.
    if (result.email?.status === "failed") {
      reportFailure(
        deps,
        logger,
        new Error(`lineup_added_email_failed:${result.email.reason}`),
        "email_failed",
        { eventId: event.id, eventHumanId: row.id, humanId },
      );
    }
    // The in-app notice landed, so the row is TOLD: commit, never resend.
    await deps.idempotency.commit(
      sentKey,
      { sentAt: new Date().toISOString(), humanId },
      NOTICE_LEDGER_KEEP_SEC,
    );
    return "sent";
  } catch (error) {
    if (delivered) {
      // Told already — only the ledger write failed (a sub-second Redis blip
      // is enough: the client carries a commandTimeout). KEEP the claim and
      // do NOT report the row as left: releasing it would hand the row to a
      // continuation ~30s later, whose `begin` would succeed and send the
      // person a SECOND notice and a SECOND email (notify()'s own 60s dedupe
      // cannot stop that — it is shorter than the held-claim delay, and the
      // jobs process writes it in a different namespace from the API's).
      try {
        await deps.idempotency.commit(
          sentKey,
          {
            sentAt: new Date().toISOString(),
            humanId,
            ledgerWriteRetried: true,
          },
          NOTICE_LEDGER_KEEP_SEC,
        );
      } catch {
        // Best-effort. The claim then lapses on its own TTL
        // (SEND_CLAIM_TTL_SEC) and the RECENT record above carries the
        // suppression for the next 7 days.
      }
      reportFailure(deps, logger, error, "lineup_added_settle_failed", {
        eventId: event.id,
        eventHumanId: row.id,
        humanId,
      });
      return "skipped";
    }
    await releaseClaim(deps, logger, sentKey, token, row.id);
    reportFailure(deps, logger, error, "lineup_added_failed", {
      eventId: event.id,
      eventHumanId: row.id,
      humanId,
    });
    return "failed";
  }
}

/**
 * The invite `inviteLineupHumanToRegister` has always promised ("the
 * transport layer sends a transactional email") and never sent — the builder
 * toasted "Invite sent" over silence. Sent immediately, whatever the event's
 * status: the editor asked for it. It is the ONLY email this person gets
 * about this event from the pair; their lineup notice goes in-app and push
 * (see `LineupNoticeOwedRecord.via`). At most one per ROW, ever (INVITE
 * claim): two concurrent invites on one row can no longer both mail.
 */
async function sendPayoutInvite(
  deps: NotifyLineupNoticesDeps,
  logger: LoggerPort | undefined,
  baseUrl: string,
  event: EventRecord,
  row: EventHumanRecord,
  owed: LineupNoticeOwedRecord,
  email: string,
): Promise<void> {
  const humanId = row.humanId;
  if (!humanId) return;
  const extra = { eventId: event.id, eventHumanId: row.id, humanId };
  if (!deps.mailer) {
    reportFailure(
      deps,
      logger,
      new Error("notifyLineupNotices: no mailer bound — payout invite not sent"),
      "invite_mailer_unavailable",
      extra,
    );
    return;
  }

  const inviteKey = lineupNoticeInviteKey(row.id);
  const token = randomUUID();
  if (!(await deps.idempotency.begin(inviteKey, SEND_CLAIM_TTL_SEC, token))) {
    return;
  }

  try {
    // Per-RECIPIENT cap: free-text rows cost nothing, so per-row claims and
    // the per-actor limit alone would let one account relay editor-written
    // subjects to one address without end. Over the cap the invite is
    // settled QUIETLY (no refusal the editor could read as a signal).
    if (
      !(await withinRecipientCap(
        deps,
        logger,
        `lineup-notice:invite-recipient:${hashAddress(email)}`,
        INVITE_RECIPIENT_MAX,
        extra,
      ))
    ) {
      await deps.idempotency.commit(
        inviteKey,
        { suppressed: "recipient_cap", humanId, at: new Date().toISOString() },
        NOTICE_LEDGER_KEEP_SEC,
      );
      reportFailure(
        deps,
        logger,
        new Error("lineup_payout_invite_recipient_capped"),
        "invite_recipient_capped",
        extra,
      );
      return;
    }

    const inviterName = await resolveAdderName(
      deps,
      event,
      owed.addedByHumanId,
    );
    const accountCompletionUrl = await resolveAccountCompletionUrl(
      deps,
      baseUrl,
      humanId,
      email,
    );
    const payoutsSlug = await resolveHumanAdminSlug(deps.repos, humanId);
    const ticketTypes = await deps.repos.events.listTicketTypes(event.id);
    const sent = await deps.mailer.send({
      to: { to: email },
      template: {
        key: "event.lineup_payout_invite",
        variables: {
          inviterName,
          eventTitle: event.title,
          whenLabel:
            formatLineupFullWhen(event.startsAt.toISOString(), event.timezone) ??
            "",
          payoutsUrl: `${baseUrl}/admin/${payoutsSlug}/payouts`,
          accountCompletionUrl,
          lineupsUrl: `${baseUrl}/my-lineups`,
          // "Your share of ticket sales" only where there are sales to share.
          paidEvent: ticketTypes.some((tt) => isEverPaidTicketType(tt)),
          organiserWillBeTold: await organiserWillBeTold(
            deps,
            logger,
            event,
            humanId,
          ),
        },
      },
      // Per ROW (not per address): the adapter-level dedupe for a retried
      // send; the INVITE claim above is the durable one.
      idempotencyKey: `lineup-payout-invite:${row.id}`,
      tags: ["event", "lineup", "payout-invite"],
      metadata: { eventId: event.id, eventHumanId: row.id },
    });
    if (!sent.result.success) {
      // A mailer can refuse without throwing. The editor was told "Invite
      // sent", so a refusal must be visible — and the claim is freed.
      await releaseClaim(deps, logger, inviteKey, token, row.id);
      reportFailure(
        deps,
        logger,
        new Error(
          `lineup_payout_invite_refused:${sent.result.errorCode ?? "unknown"}`,
        ),
        "payout_invite_refused",
        extra,
      );
      return;
    }
    await deps.idempotency.commit(
      inviteKey,
      { sentAt: new Date().toISOString(), humanId },
      NOTICE_LEDGER_KEEP_SEC,
    );
    logger?.info("event_humans.lineup_payout_invite.sent", extra);
  } catch (error) {
    await releaseClaim(deps, logger, inviteKey, token, row.id);
    reportFailure(deps, logger, error, "payout_invite_failed", extra);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Opens the 7-day window. A failure only weakens the cooldown — reported. */
async function startCooldown(
  deps: NotifyLineupNoticesDeps,
  logger: LoggerPort | undefined,
  eventId: string,
  eventHumanId: string,
  humanId: string,
): Promise<void> {
  try {
    await deps.idempotency.commit(
      lineupNoticeRecentKey(eventId, humanId),
      { sentAt: new Date().toISOString(), eventHumanId },
      LINEUP_NOTICE_COOLDOWN_SEC,
    );
  } catch (error) {
    reportFailure(deps, logger, error, "cooldown_write_failed", {
      eventId,
      eventHumanId,
      humanId,
    });
  }
}

/** Lowercased, trimmed, hashed: the limiter key never carries an address. */
function hashAddress(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}

/**
 * One token from a per-recipient daily bucket. True = within the cap (or no
 * limiter wired). Fails OPEN on a limiter error (reported).
 */
async function withinRecipientCap(
  deps: NotifyLineupNoticesDeps,
  logger: LoggerPort | undefined,
  key: string,
  max: number,
  extra: Record<string, unknown>,
): Promise<boolean> {
  if (!deps.rateLimit) return true;
  try {
    const result = await deps.rateLimit.consume(key, max, RECIPIENT_WINDOW_SEC);
    return result.allowed;
  } catch (error) {
    reportFailure(deps, logger, error, "recipient_cap_failed_open", extra);
    return true;
  }
}

async function writeOwed(
  deps: Pick<NotifyLineupNoticesDeps, "idempotency">,
  args: RecordLineupNoticeOwedArgs,
): Promise<void> {
  const record: LineupNoticeOwedRecord = {
    addedByHumanId: args.addedByHumanId,
    ...(args.addedByOrgId ? { addedByOrgId: args.addedByOrgId } : {}),
    ...(args.addedByName ? { addedByName: args.addedByName } : {}),
    via: args.via,
  };
  await deps.idempotency.commit<LineupNoticeOwedRecord>(
    lineupNoticeOwedKey(args.eventHumanId),
    record,
    NOTICE_LEDGER_KEEP_SEC,
  );
}

async function releaseClaim(
  deps: NotifyLineupNoticesDeps,
  logger: LoggerPort | undefined,
  key: string,
  token: string,
  eventHumanId: string,
): Promise<void> {
  try {
    await deps.idempotency.release(key, token);
  } catch (releaseError) {
    // The claim then lapses on its own TTL (SEND_CLAIM_TTL_SEC), so the row
    // is retried late rather than lost. Through `reportFailure` (same error
    // log, plus the report): the jobs process this is now reachable from has
    // no pino → Sentry integration, so a bare log there is dark.
    reportFailure(deps, logger, releaseError, "release_failed", {
      eventHumanId,
    });
  }
}

/**
 * The name appears on the public event page and the profile's upcoming
 * shows only for a PUBLIC event and a role the public lineup lists
 * (PUBLIC_LINEUP_ROLES — every role but VOLUNTEER).
 */
export function isPubliclyListed(
  event: Pick<EventRecord, "visibility" | "status">,
  row: Pick<EventHumanRecord, "role">,
): boolean {
  return (
    event.status === "PUBLISHED" &&
    event.visibility === "PUBLIC" &&
    (PUBLIC_LINEUP_ROLES as readonly string[]).includes(row.role)
  );
}

/**
 * No longer among the profile's "upcoming shows": that list filters on
 * `startsAt > now` (event-humans adapter `listPerformancesByHuman`), so the
 * wording keys off `startsAt`, not `endsAt`.
 */
function eventHasEnded(event: EventRecord, now: Date): boolean {
  return event.startsAt.getTime() <= now.getTime();
}

/**
 * The event org's editor list, memoised per EVENT OBJECT: the publish sweep
 * hands the same `event` to every row it sends, so one sweep reads the org's
 * members once, not once per row. Weakly keyed, so an entry lives exactly as
 * long as that object (one sweep or one dispatch — each fetches its own
 * event, so nothing goes stale across calls). A failed read is reported
 * ONCE per event and answers null.
 */
const orgEditorsByEvent = new WeakMap<
  EventRecord,
  Promise<readonly string[] | null>
>();

/**
 * "The organiser will be told": the leave notice has at least one recipient
 * other than the person (`leaveNoticeReachesSomeoneElse` — the leave
 * notice's own recipient set; same rule as `listMyLineups`'
 * `organiserWillBeTold`). An org whose ONLY editor is the person tells
 * nobody. A failed membership read answers false — dropping the promise
 * beats making a false one, and beats losing the notice — and is reported.
 */
async function organiserWillBeTold(
  deps: Pick<NotifyLineupNoticesDeps, "repos" | "reportError">,
  logger: LoggerPort | undefined,
  event: EventRecord,
  personHumanId: string,
): Promise<boolean> {
  const orgId = event.orgId;
  if (!orgId) return leaveNoticeReachesSomeoneElse(event, personHumanId, []);
  let editors = orgEditorsByEvent.get(event);
  if (!editors) {
    editors = listLineupEditorHumanIds(deps.repos, orgId).catch(
      (error: unknown) => {
        reportFailure(deps, logger, error, "organiser_told_probe_failed", {
          eventId: event.id,
          orgId,
        });
        return null;
      },
    );
    orgEditorsByEvent.set(event, editors);
  }
  const ids = await editors;
  return ids ? leaveNoticeReachesSomeoneElse(event, personHumanId, ids) : false;
}

/**
 * Runs `fn` over `items` with at most `limit` in flight, starting a new item
 * only while `mayStart()` holds. Items already started always finish.
 * Returns how many items were never started.
 */
async function forEachWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  mayStart: () => boolean,
  fn: (item: T) => Promise<void>,
): Promise<number> {
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length && mayStart()) {
        const item = items[next++]!;
        await fn(item);
      }
    },
  );
  await Promise.all(workers);
  return items.length - next;
}

/** Adder's name, else the organiser's, else a neutral fallback. Never empty. */
async function resolveAdderName(
  deps: NotifyLineupNoticesDeps,
  event: EventRecord,
  addedByHumanId: string | null,
): Promise<string> {
  // No person (a booking late join from a group sender): the copy falls
  // through to the organiser, as for an adder with no name.
  const adder = addedByHumanId
    ? await deps.repos.humans.getById(addedByHumanId)
    : null;
  return (
    displayNameForCopy(adder?.name ?? null) ??
    (await resolveOrganiserName(deps.repos, event)) ??
    "The organiser"
  );
}

/**
 * Invite flavour from ACCOUNT STATE (mirrors assign-group-coordinator): no
 * verified email AND no linked auth account = a shadow profile that still has
 * to finish an account before it can set up payouts.
 */
async function resolveAccountCompletionUrl(
  deps: NotifyLineupNoticesDeps,
  baseUrl: string,
  humanId: string,
  email: string,
): Promise<string | null> {
  const withIdentity = await deps.repos.humans.getByIdWithIdentity(humanId);
  if (withIdentity?.identity.emailVerified) return null;
  const accounts = await deps.repos.humans.listAuthAccounts(humanId);
  if (accounts.length > 0) return null;
  return `${baseUrl}/auth/complete?email=${encodeURIComponent(email)}&src=lineup-invite`;
}

function requireBaseUrl(
  deps: NotifyLineupNoticesDeps,
  logger: LoggerPort | undefined,
  eventId: string,
): string | null {
  const baseUrl = normalizeBaseUrl(deps.publicAppUrl);
  if (!baseUrl) {
    reportFailure(
      deps,
      logger,
      new Error("notifyLineupNotices: publicAppUrl unset — lineup notice skipped"),
      "no_base_url",
      { eventId },
    );
  }
  return baseUrl;
}

function reportFailure(
  deps: Pick<NotifyLineupNoticesDeps, "reportError">,
  logger: LoggerPort | undefined,
  error: unknown,
  reason: string,
  extra: Record<string, unknown>,
): void {
  // ERROR (not warn): the lineup write IS committed but the person was not
  // told. Logged for Cloud Logging, reported for Sentry.
  logger?.error("event_humans.lineup_notice.failed", {
    reason,
    ...extra,
    error: describeError(error),
  });
  reportSafely(deps.reportError, error, {
    tags: { useCase: "notifyLineupNotices", reason },
    extra,
  });
}
