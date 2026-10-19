import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { EventChangeNoticeRecord } from "@th/ports/repos/event-change-notices";
import type { EventStatus } from "@th/ports/repos/events";
import type { ReporterPort } from "@th/ports/reporter";

import {
  drainLoopInputShape,
  drainLoopOutputShape,
  runDrainPasses,
} from "../../lib/drain-loop";
import {
  channelsForRecipient,
  loadVerifiedRecipientIds,
} from "../../lib/verified-recipients";
import { describeError, parseInput } from "../../lib/io";
import { eventPublicUrl } from "../../lib/public-urls";
import type { NotifyInput } from "../comms/notify";

// ─────────────────────────────────────────────────────────────────────────────
// Dependencies
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `notify` is intentionally typed against `NotifyInput` only (return value
 * ignored) so this drain stays decoupled from the comms wiring: the jobs layer
 * closes over the real `notify` use case with mailer/SMS ports bound, and tests
 * pass a plain spy.
 */
export type DispatchEventChangeNotificationsDeps = {
  // `events` is read-only: the notice links the event's public page, and the
  // URL has to be built from the event's SLUG (an id route 404s).
  repos: Pick<
    Repos,
    "eventChangeNotices" | "eventSaves" | "eventRsvps" | "events" | "humans"
  >;
  notify: (input: NotifyInput) => Promise<unknown>;
  clock: ClockPort;
  logger?: LoggerPort;
  /** Public web origin used to build the absolute event link. */
  appBaseUrl?: string | null;
  /** Guarded Sentry reporting for the event-lookup swallow below. */
  reportError?: ReporterPort;
};

/**
 * The recipients whose account email is verified (B2). A failure returns an
 * empty set (email only for everyone), ERROR-logged and reported.
 */
function loadVerifiedRecipients(args: {
  humanIds: string[];
  deps: DispatchEventChangeNotificationsDeps;
  logger: LoggerPort | undefined;
  noticeId: string;
  eventId: string;
}): Promise<ReadonlySet<string>> {
  const { humanIds, deps, logger, noticeId, eventId } = args;
  return loadVerifiedRecipientIds({
    humans: deps.repos.humans,
    humanIds,
    onLookupFailed: (error) => {
      logger?.error(
        "events.dispatchEventChangeNotifications.verified_lookup_failed",
        { noticeId, eventId, error: describeError(error) },
      );
      deps.reportError?.(error, {
        tags: { area: "event-change-notices", reason: "verified-lookup-failed" },
        extra: { noticeId, eventId },
      });
    },
  });
}

/**
 * The notice's event as the notices need it: its absolute public URL and its
 * IANA timezone (so a new start reads in the event's local time, not UTC).
 * Either is null when it can't be resolved.
 *
 * BEST-EFFORT: this is a link and a display zone, not the message. A lookup
 * failure degrades to a notice with no action and a UTC time rather than
 * failing the fan-out — but the swallow is Sentry-visible (CLAUDE.md:
 * `logger.warn` is NOT captured), so a systematic breakage surfaces instead of
 * silently un-linking every notice.
 *
 * Called ONCE per notice, not once per recipient — a cancelled event can fan
 * out to thousands of savers.
 */
async function resolveEventLinkAndZone(args: {
  eventId: string;
  deps: DispatchEventChangeNotificationsDeps;
  logger: LoggerPort | undefined;
  /**
   * Link only when the event's CURRENT status is this one; otherwise
   * `eventUrl` is null. A message links to the page only when that page says
   * what the message says (see the CANCELLED branch of `resolveRecipients`).
   */
  linkOnlyIfStatus?: EventStatus;
}): Promise<{ eventUrl: string | null; timezone: string | null }> {
  const { eventId, deps, logger, linkOnlyIfStatus } = args;
  try {
    const event = await deps.repos.events.getById(eventId);
    if (!event) return { eventUrl: null, timezone: null };
    const linkable =
      linkOnlyIfStatus === undefined || event.status === linkOnlyIfStatus;
    return {
      eventUrl: linkable
        ? eventPublicUrl({ baseUrl: deps.appBaseUrl, slug: event.slug })
        : null,
      timezone: event.timezone || null,
    };
  } catch (error) {
    logger?.error("events.dispatchEventChangeNotifications.event_url_failed", {
      eventId,
      error: describeError(error),
    });
    try {
      deps.reportError?.(error, {
        tags: { area: "event-change-notices", reason: "event-url-failed" },
        extra: { eventId },
      });
    } catch {
      // best-effort only
    }
    return { eventUrl: null, timezone: null };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Input / Output
// ─────────────────────────────────────────────────────────────────────────────

export const dispatchEventChangeNotificationsInputSchema = z
  .object({
    /** Max outbox rows to drain per run (keeps the job bounded). */
    batchLimit: z.number().int().positive().default(50),
    /** Attempts after which a notice is dead-lettered instead of retried. */
    maxAttempts: z.number().int().positive().default(5),
    /**
     * Take only never-attempted notices. Set by the write-triggered run
     * (`DRAIN_TRIGGERS` in @th/ports/job-trigger) so a failing notice is
     * retried on the scheduled run's cadence, not on every new change. A
     * budget-capped notice is never charged an attempt, so a large fan-out
     * still resumes in triggered runs.
     */
    freshOnly: z.boolean().default(false),
    ...drainLoopInputShape,
  })
  .strict();

export type DispatchEventChangeNotificationsInput = z.infer<
  typeof dispatchEventChangeNotificationsInputSchema
>;

export const dispatchEventChangeNotificationsOutputSchema = z
  .object({
    /** Notices examined this run. */
    processed: z.number().int().nonnegative(),
    /** Notices flipped to dispatched (full fan-out succeeded). */
    dispatched: z.number().int().nonnegative(),
    /** Notices that exhausted maxAttempts and were dead-lettered. */
    deadLettered: z.number().int().nonnegative(),
    /** Individual recipient `notify` calls that succeeded. */
    recipientsNotified: z.number().int().nonnegative(),
    ...drainLoopOutputShape,
  })
  .strict();

export type DispatchEventChangeNotificationsOutput = z.infer<
  typeof dispatchEventChangeNotificationsOutputSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Notice payload contract (written by the outbox producer; parsed defensively)
// ─────────────────────────────────────────────────────────────────────────────

// All three stored-payload schemas are `.strict()`: a producer that writes an
// unexpected field is a contract drift we want to catch (dead-letter) rather
// than silently ignore. The exact field sets below are pinned against every
// producer by dispatch-event-change-notifications.test.ts, so a future producer
// change that drifts from a schema fails a test, not production.
const cancelledPayloadSchema = z
  .object({
    eventTitle: z.string(),
    startsAt: z.string().nullable(),
    buyers: z.array(
      z
        .object({
          humanId: z.string(),
          refundedCents: z.number().int().nonnegative(),
          currency: z.string(),
        })
        .strict(),
    ),
    // Paid buyers whose refund FAILED during cancel (money still stuck) and who
    // aren't also refunded buyers. They get a distinct "refund in progress" copy
    // (refund: { status: "pending" }) so they know their money is being worked
    // on — not the plain refund:null copy a free RSVPer gets. Optional/defaulted
    // for back-compat with notices written before this field existed.
    pendingRefundBuyerHumanIds: z.array(z.string()).optional().default([]),
  })
  .strict();

const changedPayloadSchema = z
  .object({
    eventTitle: z.string(),
    newStartsAt: z.string().nullable(),
    newEndsAt: z.string().nullable(),
  })
  .strict();

const unlistedPayloadSchema = z
  .object({
    eventTitle: z.string(),
  })
  .strict();

const CANCELLED_VARIANT = "event.cancelled" as const;
const CHANGED_VARIANT = "event.changed" as const;
const UNLISTED_VARIANT = "event.unlisted" as const;

/** The `event.changed` renderer's cap on the stored zone. */
const TIMEZONE_MAX_LENGTH = 100;

/**
 * Page size for the watcher fan-out keyset queries. Matches the adapters'
 * `getSafeLimit` clamp (MAX_LIMIT = 100) — a larger value is silently capped,
 * so this reflects the real per-page ceiling. Pagination is still correct via
 * `nextCursor` regardless of the value.
 */
const AUDIENCE_PAGE_SIZE = 100;

/**
 * Per-run recipient budget for a SINGLE notice. A hugely popular cancelled
 * event can resolve to a massive audience; without a cap the drain would try
 * to notify everyone in one sequential pass. If that run is killed mid-loop,
 * un-persisted progress is lost and the next tick re-notifies everyone already
 * emailed (the notify idempotency TTL is shorter than the cron interval) → a
 * duplicate-email storm. Capping the per-run fan-out — combined with
 * incremental {@link MARK_NOTIFIED_CHUNK} persistence — bounds the blast radius
 * of a killed run and lets the next tick resume on the true remainder.
 */
export const MAX_RECIPIENTS_PER_NOTICE_PER_RUN = 500;

/**
 * Flush `markNotified` every this-many successful sends (rather than once at
 * the end), so partial progress survives a run killed mid-fan-out. The next
 * tick then skips everyone already flushed.
 *
 * This is also the most recipients a killed run can re-send to once the
 * notify idempotency key's TTL has lapsed. Was 100; 25 since 2026-09-30,
 * when runs became longer-lived (write-triggered, looping until empty) and
 * so more exposed to a request timeout. The cost is one small array-append
 * UPDATE per 25 sends instead of per 100.
 */
export const MARK_NOTIFIED_CHUNK = 25;

// ─────────────────────────────────────────────────────────────────────────────
// Use Case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Drains the event-change notification outbox and fans each notice out to its
 * audience (in-app + email via {@link NotifyInput}).
 *
 * Best-effort throughout: a single bad notice or a single failed recipient
 * must NEVER abort the run. Failure handling is per-notice —
 *   - a payload that won't parse is retried (`incrementAttempts`) and
 *     dead-lettered (`markDispatched`) once it exhausts `maxAttempts`;
 *   - a notice is only `markDispatched` on the success path once EVERY
 *     recipient `notify` resolved, so a partial fan-out re-runs on the next
 *     tick (recipient idempotency keys make the replay a no-op);
 *   - a notice whose fan-out keeps failing is likewise dead-lettered after
 *     `maxAttempts` so it can't clog the queue forever.
 *
 * ARCHIVED / UNPUBLISHED notices fan out `event.unlisted` to savers ∪ RSVPers
 * (no buyers — those transitions never involve refunds).
 */
export async function dispatchEventChangeNotifications(
  deps: DispatchEventChangeNotificationsDeps,
  rawInput: unknown,
): Promise<DispatchEventChangeNotificationsOutput> {
  const { repos } = deps;
  const input = parseInput(dispatchEventChangeNotificationsInputSchema, rawInput);
  const logger = deps.logger?.child({
    useCase: "events.dispatchEventChangeNotifications",
  });

  const result: DispatchEventChangeNotificationsOutput = {
    processed: 0,
    dispatched: 0,
    deadLettered: 0,
    recipientsNotified: 0,
    passes: 0,
    hasMore: false,
  };

  // Loop until the outbox is empty (see lib/drain-loop.ts). A pass wants
  // another when it was FULL, or when a notice stopped only on the per-run
  // recipient budget (its fan-out continues next pass from the persisted
  // `notifiedHumanIds`) — and in both cases only if nothing in the pass
  // failed. Stopping on failure keeps a mail outage from re-sending the same
  // failing recipients back to back.
  const loop = await runDrainPasses({
    clock: deps.clock,
    maxPasses: input.maxPasses,
    timeBudgetMs: input.timeBudgetMs,
    pass: async ({ pastDeadline }) => {
      const notices = await repos.eventChangeNotices.listUndispatched({
        limit: input.batchLimit,
        ...(input.freshOnly ? { freshOnly: true } : {}),
      });
      let troubled = 0;
      let capped = 0;
      let outOfTime = false;

      for (const notice of notices) {
        // Budget spent: leave the rest untouched and hand off (`hasMore`).
        if (pastDeadline()) {
          outOfTime = true;
          break;
        }
        result.processed += 1;
        // Outer guard: one notice must NEVER abort the batch, not even if a
        // repo bookkeeping call throws unexpectedly. Any escape is contained
        // here.
        try {
          const outcome = await processNotice({
            notice,
            deps,
            input,
            result,
            logger,
            pastDeadline,
          });
          if (outcome === "capped") capped += 1;
          else if (outcome === "troubled") troubled += 1;
        } catch (error) {
          troubled += 1;
          logger?.error(
            "events.dispatchEventChangeNotifications.notice_unhandled",
            {
              noticeId: notice.id,
              eventId: notice.eventId,
              changeType: notice.changeType,
              error: describeError(error),
            },
          );
          // A throw outside the per-recipient guard (audience read, bad data)
          // must still be CHARGED an attempt, or the row stays
          // `attempts = 0` — "fresh" — forever: every write-triggered run
          // picks it up first, throws, stops its loop on it, and it never
          // dead-letters.
          await chargeUnhandled({ notice, deps, input, result, logger, error });
        }
      }

      return {
        wantsAnother:
          (notices.length >= input.batchLimit || capped > 0 || outOfTime) &&
          troubled === 0,
      };
    },
  });
  result.passes = loop.passes;
  result.hasMore = loop.hasMore;

  logger?.info("events.dispatchEventChangeNotifications.completed", result);

  return dispatchEventChangeNotificationsOutputSchema.parse(result);
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-notice processing
// ─────────────────────────────────────────────────────────────────────────────

type Recipient = {
  humanId: string;
  variant:
    | typeof CANCELLED_VARIANT
    | typeof CHANGED_VARIANT
    | typeof UNLISTED_VARIANT;
  payload: Record<string, unknown>;
};

/**
 * How one notice left a pass: fully resolved (dispatched or dead-lettered),
 * `capped` (clean fan-out stopped only on the per-run budget, resume next
 * pass), or `troubled` (a failure was recorded).
 */
type NoticeOutcome = "resolved" | "capped" | "troubled";

async function processNotice(args: {
  notice: EventChangeNoticeRecord;
  deps: DispatchEventChangeNotificationsDeps;
  input: DispatchEventChangeNotificationsInput;
  result: DispatchEventChangeNotificationsOutput;
  logger: LoggerPort | undefined;
  /**
   * The run's time budget. Checked before every recipient: a fan-out that
   * runs out of time stops exactly like one that hits the per-run recipient
   * budget (progress persisted, no attempt charged, resumes next run).
   */
  pastDeadline?: () => boolean;
}): Promise<NoticeOutcome> {
  const { notice, deps, input, result, logger } = args;
  const { repos, clock } = deps;

  const recipients = await resolveRecipients({ notice, deps, logger });
  if (recipients === null) {
    // Payload didn't parse → retry, dead-lettering once attempts are exhausted.
    await handleFailure({
      notice,
      input,
      result,
      repos,
      clock,
      logger,
      reason: "payload_parse_failed",
      unNotifiedHumanIds: [],
    });
    return "troubled";
  }

  // Durable per-recipient dedup: SUBTRACT the humanIds already notified for
  // this notice on prior runs, so a retry only targets the un-notified
  // remainder. No recipient is ever notified twice — even after the notify
  // idempotency key's TTL lapses (TTL < cron interval).
  const alreadyNotified = new Set(notice.notifiedHumanIds);
  const remainder = recipients.filter((r) => !alreadyNotified.has(r.humanId));

  // B2 (account squatting through guest checkout): an unverified account may
  // be one someone opened under another person's address, with that person's
  // tickets attached by email. The notice still goes to the address's inbox,
  // but in-app, push and SMS (which reach whoever is signed in, or whose
  // phone is on the account) go only to accounts that proved their inbox.
  // Only the slice this run can attempt is looked up.
  //
  // A failed lookup leaves the set empty: everyone gets email only (the safe
  // side), and the swallow is reported. Throwing would charge the notice an
  // attempt and re-run sends that already went out.
  const verifiedRecipients = await loadVerifiedRecipients({
    humanIds: remainder
      .slice(0, MAX_RECIPIENTS_PER_NOTICE_PER_RUN)
      .map((r) => r.humanId),
    deps,
    logger,
    noticeId: notice.id,
    eventId: notice.eventId,
  });

  // All successes this run (drives the coverage/dispatch decision below).
  const notifiedThisRun: string[] = [];
  // Successes not yet persisted via markNotified. Flushed every
  // MARK_NOTIFIED_CHUNK so a run killed mid-fan-out still saves progress.
  let pendingMark: string[] = [];
  let failureCount = 0;
  // notify calls actually made this run (successes + failures). Bounds the
  // per-run fan-out via MAX_RECIPIENTS_PER_NOTICE_PER_RUN.
  let attempted = 0;
  // True when we stopped early ONLY because we hit the per-run budget (as
  // opposed to processing the whole remainder). A budget-capped run is a
  // "resume next tick" — NOT a failure — so it must not bump attempts.
  let budgetCapped = false;

  for (const recipient of remainder) {
    if (
      attempted >= MAX_RECIPIENTS_PER_NOTICE_PER_RUN ||
      args.pastDeadline?.() === true
    ) {
      // Budget reached with recipients still un-attempted → resume next tick.
      budgetCapped = true;
      break;
    }
    attempted += 1;
    try {
      await deps.notify({
        humanId: recipient.humanId,
        variant: recipient.variant,
        payload: recipient.payload,
        idempotencyKey: `event-change:${notice.id}:${recipient.humanId}`,
        ...channelsForRecipient(verifiedRecipients, recipient.humanId),
      });
      notifiedThisRun.push(recipient.humanId);
      pendingMark.push(recipient.humanId);
      result.recipientsNotified += 1;
      // Persist progress incrementally so a killed run doesn't re-notify this
      // chunk on the next tick.
      if (pendingMark.length >= MARK_NOTIFIED_CHUNK) {
        await repos.eventChangeNotices.markNotified(notice.id, pendingMark);
        pendingMark = [];
      }
    } catch (error) {
      failureCount += 1;
      logger?.warn("events.dispatchEventChangeNotifications.notify_error", {
        noticeId: notice.id,
        eventId: notice.eventId,
        humanId: recipient.humanId,
        variant: recipient.variant,
        error: describeError(error),
      });
    }
  }

  // Flush any trailing successes BEFORE the dispatch/retry decision, so a retry
  // (or a concurrent run) skips them next time.
  if (pendingMark.length > 0) {
    await repos.eventChangeNotices.markNotified(notice.id, pendingMark);
    pendingMark = [];
  }

  // Mark dispatched only once the union (prior notifiedHumanIds ∪ this run's
  // successes) covers the FULL resolved audience. Any gap → retry (which now
  // targets only the still-un-notified remainder).
  const covered = new Set([...alreadyNotified, ...notifiedThisRun]);
  const unNotifiedHumanIds = recipients
    .map((r) => r.humanId)
    .filter((humanId) => !covered.has(humanId));

  if (unNotifiedHumanIds.length === 0) {
    await repos.eventChangeNotices.markDispatched([notice.id], clock.now());
    result.dispatched += 1;
    return failureCount > 0 ? "troubled" : "resolved";
  }

  // Non-coverage caused ONLY by the per-run budget is not a failure: leave the
  // notice undispatched with NO attempt bump. Incremental markNotified means
  // the next tick resumes on the true remainder (no recipient re-notified).
  if (budgetCapped) {
    logger?.info("events.dispatchEventChangeNotifications.budget_capped", {
      noticeId: notice.id,
      eventId: notice.eventId,
      changeType: notice.changeType,
      attempted,
      remaining: unNotifiedHumanIds.length,
    });
    // A capped pass that also had failed sends is NOT clean: continuing would
    // re-try those recipients immediately (the capped path never charges an
    // attempt, so nothing else spaces them out).
    return failureCount > 0 ? "troubled" : "capped";
  }

  await handleFailure({
    notice,
    input,
    result,
    repos,
    clock,
    logger,
    reason: "recipient_send_failed",
    failureCount,
    unNotifiedHumanIds,
  });
  return "troubled";
}

/**
 * Outer-guard bookkeeping for a notice that threw outside the per-recipient
 * guard. Reports the swallowed error (CLAUDE.md), then charges the attempt
 * through {@link handleFailure} so it retries on the scheduled cadence and
 * dead-letters at `maxAttempts`. Best-effort: a bookkeeping failure is
 * reported too and never aborts the batch. Progress already persisted via
 * `markNotified` survives, so a retry only targets the remainder.
 */
async function chargeUnhandled(args: {
  notice: EventChangeNoticeRecord;
  deps: DispatchEventChangeNotificationsDeps;
  input: DispatchEventChangeNotificationsInput;
  result: DispatchEventChangeNotificationsOutput;
  logger: LoggerPort | undefined;
  error: unknown;
}): Promise<void> {
  const { notice, deps, input, result, logger, error } = args;
  const report = (err: unknown, reason: string) => {
    try {
      deps.reportError?.(err, {
        tags: { area: "event-change-notices", reason },
        extra: { noticeId: notice.id, eventId: notice.eventId },
      });
    } catch {
      // best-effort only
    }
  };
  report(error, "notice-unhandled");
  try {
    await handleFailure({
      notice,
      input,
      result,
      repos: deps.repos,
      clock: deps.clock,
      logger,
      reason: "unhandled_error",
      unNotifiedHumanIds: [],
    });
  } catch (bookkeepingError) {
    logger?.error(
      "events.dispatchEventChangeNotifications.unhandled_bookkeeping_failed",
      { noticeId: notice.id, error: describeError(bookkeepingError) },
    );
    report(bookkeepingError, "unhandled-bookkeeping-failed");
  }
}

/**
 * Records a failed drain attempt for a notice: always bumps `attempts`, and
 * dead-letters (marks dispatched) once the notice would reach `maxAttempts` so
 * a permanently bad notice can't retry forever.
 */
async function handleFailure(args: {
  notice: EventChangeNoticeRecord;
  input: DispatchEventChangeNotificationsInput;
  result: DispatchEventChangeNotificationsOutput;
  repos: DispatchEventChangeNotificationsDeps["repos"];
  clock: ClockPort;
  logger: LoggerPort | undefined;
  reason: string;
  failureCount?: number;
  /**
   * Audience members not yet notified at this failure. On dead-letter these
   * are permanently dropped (the notice stops retrying), so they're logged at
   * ERROR for ops reconciliation. Empty for a payload-parse failure (audience
   * never resolved).
   */
  unNotifiedHumanIds: string[];
}): Promise<void> {
  const {
    notice,
    input,
    result,
    repos,
    clock,
    logger,
    reason,
    failureCount,
    unNotifiedHumanIds,
  } = args;

  await repos.eventChangeNotices.incrementAttempts([notice.id]);
  const attempts = notice.attempts + 1;

  if (attempts >= input.maxAttempts) {
    await repos.eventChangeNotices.markDispatched([notice.id], clock.now());
    result.deadLettered += 1;
    // Dead-letter drops the un-notified remainder on the floor (the notice
    // stops retrying). Log the gap explicitly at ERROR — `notifiedHumanIds` on
    // the row also makes it durably queryable — so ops can reconcile who never
    // received the change notice.
    logger?.error("events.dispatchEventChangeNotifications.dead_letter", {
      noticeId: notice.id,
      eventId: notice.eventId,
      changeType: notice.changeType,
      attempts,
      reason,
      failureCount: failureCount ?? null,
      unNotifiedHumanIds,
      unNotifiedCount: unNotifiedHumanIds.length,
    });
    return;
  }

  logger?.warn("events.dispatchEventChangeNotifications.retry", {
    noticeId: notice.id,
    eventId: notice.eventId,
    changeType: notice.changeType,
    attempts,
    reason,
    failureCount: failureCount ?? null,
  });
}

/**
 * Builds the full recipient list for a notice, or `null` if the payload is
 * malformed (the caller treats that as a retryable failure / dead-letter).
 */
async function resolveRecipients(args: {
  notice: EventChangeNoticeRecord;
  deps: DispatchEventChangeNotificationsDeps;
  logger: LoggerPort | undefined;
}): Promise<Recipient[] | null> {
  const { notice, deps, logger } = args;

  if (notice.changeType === "CANCELLED") {
    const parsed = cancelledPayloadSchema.safeParse(notice.payload);
    if (!parsed.success) {
      logger?.warn("events.dispatchEventChangeNotifications.bad_payload", {
        noticeId: notice.id,
        changeType: notice.changeType,
        issues: parsed.error.issues,
      });
      return null;
    }

    const { eventTitle, startsAt, buyers, pendingRefundBuyerHumanIds } =
      parsed.data;
    // ONE lookup for the whole fan-out (a cancellation can reach thousands).
    //
    // THE LINK MATCHES THE PAGE IT OPENS. "Cancelled" links to the event page
    // only while that page says "Event cancelled", i.e. the event is still
    // CANCELLED at dispatch. Archive of a PUBLISHED community listing writes
    // this CANCELLED notice while flipping the listing to ARCHIVED (owner
    // ruling 2026-10-16), and a cancelled event can be archived before the
    // drain runs; either way its page says "No longer available", so no link.
    const { eventUrl } = await resolveEventLinkAndZone({
      eventId: notice.eventId,
      deps,
      logger,
      linkOnlyIfStatus: "CANCELLED",
    });
    const recipients: Recipient[] = [];
    const buyerIds = new Set<string>();

    // Refunded buyers get a money-aware cancellation (refund on the way).
    //
    // A buyer whose refunds total $0 gets the plain cancellation instead: the
    // only tickets this cancellation returned for them cost $0 (owner ruling
    // 2026-10-11, `cancel-event.ts` no-charge plan), so no money is on its
    // way and "You've been refunded $0.00" would be false. They stay in
    // `buyerIds`, so the saver / RSVP cohort below never notifies them twice.
    //
    // Unless their refund on another order FAILED: then money is still held,
    // and the pending notice below ("refund in progress") must win over the
    // plain one. Skipped here, so the pending loop picks them up.
    const pendingRefundIds = new Set(pendingRefundBuyerHumanIds);
    for (const buyer of buyers) {
      if (buyerIds.has(buyer.humanId)) continue;
      if (buyer.refundedCents <= 0 && pendingRefundIds.has(buyer.humanId)) {
        continue;
      }
      buyerIds.add(buyer.humanId);
      recipients.push({
        humanId: buyer.humanId,
        variant: CANCELLED_VARIANT,
        payload: {
          eventId: notice.eventId,
          eventTitle,
          startsAt,
          eventUrl,
          refund:
            buyer.refundedCents > 0
              ? {
                  status: "refunded",
                  amountCents: buyer.refundedCents,
                  currency: buyer.currency,
                }
              : null,
        },
      });
    }

    // Paid buyers whose refund FAILED (money still stuck) get a distinct
    // "refund in progress" cancellation — NOT the plain refund:null copy a
    // free RSVPer gets. Dedupe against refunded buyers (refunded wins) so a
    // buyer is never double-notified, and track them so the refund:null cohort
    // below excludes them too.
    for (const humanId of pendingRefundBuyerHumanIds) {
      if (buyerIds.has(humanId)) continue;
      buyerIds.add(humanId);
      recipients.push({
        humanId,
        variant: CANCELLED_VARIANT,
        payload: {
          eventId: notice.eventId,
          eventTitle,
          startsAt,
          eventUrl,
          refund: { status: "pending" },
        },
      });
    }

    // Savers ∪ RSVPers, MINUS all buyers (refunded + pending-refund), get a
    // plain cancellation (no refund). The Set unions + dedupes against
    // savers/RSVPers automatically; `buyerIds` excludes both money cohorts so
    // buyers take precedence over saver/RSVP membership.
    const audience = await collectAudience(notice.eventId, deps);
    for (const humanId of audience) {
      if (buyerIds.has(humanId)) continue;
      recipients.push({
        humanId,
        variant: CANCELLED_VARIANT,
        payload: {
          eventId: notice.eventId,
          eventTitle,
          startsAt,
          eventUrl,
          refund: null,
        },
      });
    }

    return recipients;
  }

  // ARCHIVED / UNPUBLISHED → savers ∪ RSVPers get `event.unlisted`. No buyers:
  // archive/unpublish never involve refunds (unpublish refuses when orders
  // exist; a cancelled event was already notified by cancel-event).
  if (notice.changeType === "ARCHIVED" || notice.changeType === "UNPUBLISHED") {
    const parsedUnlisted = unlistedPayloadSchema.safeParse(notice.payload);
    if (!parsedUnlisted.success) {
      logger?.warn("events.dispatchEventChangeNotifications.bad_payload", {
        noticeId: notice.id,
        changeType: notice.changeType,
        issues: parsedUnlisted.error.issues,
      });
      return null;
    }

    const { eventTitle } = parsedUnlisted.data;
    const audience = await collectAudience(notice.eventId, deps);
    const recipients: Recipient[] = [];
    for (const humanId of audience) {
      recipients.push({
        humanId,
        variant: UNLISTED_VARIANT,
        payload: {
          eventId: notice.eventId,
          eventTitle,
        },
      });
    }

    return recipients;
  }

  // RESCHEDULED / VENUE_CHANGED → savers ∪ RSVPers get `event.changed`.
  const parsed = changedPayloadSchema.safeParse(notice.payload);
  if (!parsed.success) {
    logger?.warn("events.dispatchEventChangeNotifications.bad_payload", {
      noticeId: notice.id,
      changeType: notice.changeType,
      issues: parsed.error.issues,
    });
    return null;
  }

  const { eventTitle, newStartsAt, newEndsAt } = parsed.data;
  const { eventUrl, timezone } = await resolveEventLinkAndZone({
    eventId: notice.eventId,
    deps,
    logger,
  });
  const audience = await collectAudience(notice.eventId, deps);
  const recipients: Recipient[] = [];
  for (const humanId of audience) {
    recipients.push({
      humanId,
      variant: CHANGED_VARIANT,
      payload: {
        eventId: notice.eventId,
        eventTitle,
        changeType: notice.changeType,
        newStartsAt,
        newEndsAt,
        eventUrl,
        // The event's zone, so the new start reads in local time. Omitted
        // when the lookup failed, or when it is longer than the renderer's
        // max(100) (the strict schema would fail every send): the renderer
        // then falls back to UTC.
        ...(timezone && timezone.length <= TIMEZONE_MAX_LENGTH
          ? { timezone }
          : {}),
      },
    });
  }

  return recipients;
}

/**
 * Pages BOTH watcher fan-out queries (savers + RSVPers) to completion and
 * unions them into one deduped set of humanIds.
 */
async function collectAudience(
  eventId: string,
  deps: DispatchEventChangeNotificationsDeps,
): Promise<Set<string>> {
  const humanIds = new Set<string>();

  let cursor: string | null = null;
  do {
    const page = await deps.repos.eventSaves.listHumanIdsForEvent({
      eventId,
      cursor,
      limit: AUDIENCE_PAGE_SIZE,
    });
    for (const humanId of page.items) humanIds.add(humanId);
    cursor = page.nextCursor;
  } while (cursor);

  cursor = null;
  do {
    const page = await deps.repos.eventRsvps.listHumanIdsForEvent({
      eventId,
      cursor,
      limit: AUDIENCE_PAGE_SIZE,
    });
    for (const humanId of page.items) humanIds.add(humanId);
    cursor = page.nextCursor;
  } while (cursor);

  return humanIds;
}
