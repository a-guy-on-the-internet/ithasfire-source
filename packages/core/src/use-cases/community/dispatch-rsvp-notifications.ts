import { z } from "zod";
import { eventEmailImageUrl, eventPublicUrl } from "../../lib/public-urls";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { EventDateRecord } from "@th/ports/repos/event-dates";
import type { RsvpNoticeRecord } from "@th/ports/repos/rsvp-notices";
import type { ReporterPort } from "@th/ports/reporter";

import {
  drainLoopInputShape,
  drainLoopOutputShape,
  runDrainPasses,
} from "../../lib/drain-loop";
import { describeError, parseInput } from "../../lib/io";
import { resolveHolderAddress } from "../../lib/location/resolve-holder-address";
import { venueConfirmationArm } from "../../lib/venue-confirmation";
import type { NotifyInput } from "../comms/notify";
import { rsvpLocationFields } from "./_shared/rsvp-location-fields";

// ─────────────────────────────────────────────────────────────────────────────
// Dependencies
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `notify` is intentionally typed against `NotifyInput` only (return value
 * ignored) so this drain stays decoupled from the comms wiring — same shape
 * as dispatch-event-change-notifications: the jobs layer closes over the real
 * `notify` use case with the mailer bound, and tests pass a plain spy.
 */
export type DispatchRsvpNotificationsDeps = {
  repos: Pick<
    Repos,
    | "rsvpNotices"
    | "eventRsvps"
    | "events"
    | "eventDates"
    | "eventDateRsvps"
    // The confirmation's address goes through the holder gate, which reads
    // the venue (its privacy floors the event's; its row holds the truth).
    | "places"
  >;
  notify: (input: NotifyInput) => Promise<unknown>;
  clock: ClockPort;
  /** Public web origin used to build absolute email URLs (event page, /my-rsvps). */
  appBaseUrl: string;
  logger?: LoggerPort;
  /** Guarded Sentry reporting for the unhandled-notice swallow below. */
  reportError?: ReporterPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Input / Output
// ─────────────────────────────────────────────────────────────────────────────

export const dispatchRsvpNotificationsInputSchema = z
  .object({
    /** Max outbox rows to drain per run (keeps the job bounded). */
    batchLimit: z.number().int().positive().default(50),
    /** Attempts after which a notice is dead-lettered instead of retried. */
    maxAttempts: z.number().int().positive().default(5),
    /**
     * Take only never-attempted notices. Set by the write-triggered run
     * (`DRAIN_TRIGGERS` in @th/ports/job-trigger) so a failing notice is
     * retried on the scheduled run's cadence, not on every new RSVP.
     */
    freshOnly: z.boolean().default(false),
    ...drainLoopInputShape,
  })
  .strict();

export type DispatchRsvpNotificationsInput = z.infer<
  typeof dispatchRsvpNotificationsInputSchema
>;

export const dispatchRsvpNotificationsOutputSchema = z
  .object({
    /** Notices examined this run. */
    processed: z.number().int().nonnegative(),
    /** Notices flipped to dispatched after a successful send. */
    dispatched: z.number().int().nonnegative(),
    /**
     * Notices dispatched away WITHOUT a send: the event vanished / is no
     * longer PUBLISHED (a DATE_CANCELLED notice on a CANCELLED, ARCHIVED or
     * COMPLETED listing is the exception: it sends), the notice's date
     * vanished, a
     * CONFIRMATION whose date was called off (never confirm a night that is off — the DATE_CANCELLED
     * notice is what that person gets), or the RSVP was cancelled before
     * dispatch (never confirm, or condole over, an RSVP that no longer exists).
     */
    skipped: z.number().int().nonnegative(),
    /** Notices that exhausted maxAttempts and were dead-lettered. */
    deadLettered: z.number().int().nonnegative(),
    /** Confirmation `notify` calls that succeeded. */
    recipientsNotified: z.number().int().nonnegative(),
    ...drainLoopOutputShape,
  })
  .strict();

export type DispatchRsvpNotificationsOutput = z.infer<
  typeof dispatchRsvpNotificationsOutputSchema
>;

const RSVP_CONFIRMED_VARIANT = "rsvp.confirmed" as const;
const RSVP_DATE_CANCELLED_VARIANT = "rsvp.date_cancelled" as const;

// ─────────────────────────────────────────────────────────────────────────────
// Use Case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Drains the RSVP outbox: one in-app + email message per notice (single
 * recipient — no fan-out, unlike the event-change drain).
 *
 * TWO KINDS RIDE THE SAME QUEUE (`RsvpNoticeKind`): the "you're going"
 * CONFIRMATION, and the "that night is off" DATE_CANCELLED a moderator
 * call-off enqueues. Same claim, same retry/dead-letter bookkeeping, same
 * retention purge — only the variant and the date-status guard differ.
 *
 * THE DATE-STATUS GUARD USED TO GUARANTEE SILENCE. This drain skipped ANY
 * per-date notice whose occurrence was no longer SCHEDULED, which meant the
 * one moment you most want to reach someone — the night they planned around
 * being called off — was the one moment nothing could be sent. The guard now
 * reads per kind, which is what turns that branch into the message:
 *   - a CONFIRMATION on a called-off date is still dispatched away unsent.
 *     Confirming a night that is off would be wrong, and that person is
 *     already getting the DATE_CANCELLED notice the call-off enqueued for
 *     their live RSVP.
 *   - a DATE_CANCELLED notice REQUIRES the date to be CANCELLED. It is the
 *     whole point of the message. A date restored between enqueue and dispatch
 *     is dispatched away unsent as a belt-and-braces second line — the restore
 *     already deletes undelivered notices in its own transaction, so reaching
 *     this branch means something raced.
 *
 * Best-effort throughout: one bad notice must NEVER abort the run.
 * Per-notice handling —
 *   - event missing / not PUBLISHED → dispatch away without sending (the
 *     event-change flow owns cancel/unlist messaging), EXCEPT a
 *     DATE_CANCELLED notice on a CANCELLED, ARCHIVED or COMPLETED listing:
 *     those are the take-down's (or completion's) own per-night notices, sent
 *     with the whole-listing copy;
 *   - per-date notice whose date vanished → dispatch away without sending;
 *   - date status disagrees with the notice's kind → dispatch away without
 *     sending (see above);
 *   - RSVP row gone (cancelled before dispatch) → dispatch away without
 *     sending. Never confirm an RSVP that no longer exists — and equally,
 *     never condole with someone who already withdrew. Per-date notices check
 *     the per-date RSVP row (eventDateRsvps), event-level ones the event row;
 *   - send succeeded → markDispatched;
 *   - send failed → incrementAttempts, dead-letter (markDispatched) once
 *     `maxAttempts` is exhausted so a permanently bad notice can't clog the
 *     queue. The notify idempotency key (`rsvp-confirmed:{noticeId}` /
 *     `rsvp-date-cancelled:{noticeId}`) makes a retried send a no-op if the
 *     first attempt actually landed.
 */
export async function dispatchRsvpNotifications(
  deps: DispatchRsvpNotificationsDeps,
  rawInput: unknown,
): Promise<DispatchRsvpNotificationsOutput> {
  const { repos } = deps;
  const input = parseInput(dispatchRsvpNotificationsInputSchema, rawInput);
  const logger = deps.logger?.child({
    useCase: "community.dispatchRsvpNotifications",
  });

  const result: DispatchRsvpNotificationsOutput = {
    processed: 0,
    dispatched: 0,
    skipped: 0,
    deadLettered: 0,
    recipientsNotified: 0,
    passes: 0,
    hasMore: false,
  };

  // Loop until the outbox is empty (see lib/drain-loop.ts). A pass wants
  // another only when it was FULL and every notice in it left the queue
  // without a failed send — `troubled` counts retries, dead-letters and
  // unhandled rows.
  const loop = await runDrainPasses({
    clock: deps.clock,
    maxPasses: input.maxPasses,
    timeBudgetMs: input.timeBudgetMs,
    pass: async ({ pastDeadline }) => {
      const notices = await repos.rsvpNotices.listUndispatched({
        limit: input.batchLimit,
        ...(input.freshOnly ? { freshOnly: true } : {}),
      });
      const tally = { troubled: 0 };
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
          await processNotice({ notice, deps, input, result, logger, tally });
        } catch (error) {
          tally.troubled += 1;
          logger?.error("community.dispatchRsvpNotifications.notice_unhandled", {
            noticeId: notice.id,
            eventId: notice.eventId,
            humanId: notice.humanId,
            error: describeError(error),
          });
          // A throw outside the send (a repo read, bad data) must still be
          // CHARGED an attempt. Otherwise the row stays `attempts = 0` —
          // "fresh" — forever: every write-triggered run picks it up first,
          // throws, and stops its loop on it, and it never dead-letters.
          await chargeUnhandled({
            notice,
            input,
            result,
            repos,
            clock: deps.clock,
            logger,
            error,
            reportError: deps.reportError,
          });
        }
      }

      return {
        wantsAnother:
          (notices.length >= input.batchLimit || outOfTime) &&
          tally.troubled === 0,
      };
    },
  });
  result.passes = loop.passes;
  result.hasMore = loop.hasMore;

  logger?.info("community.dispatchRsvpNotifications.completed", result);

  return dispatchRsvpNotificationsOutputSchema.parse(result);
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-notice processing
// ─────────────────────────────────────────────────────────────────────────────

async function processNotice(args: {
  notice: RsvpNoticeRecord;
  deps: DispatchRsvpNotificationsDeps;
  input: DispatchRsvpNotificationsInput;
  result: DispatchRsvpNotificationsOutput;
  logger: LoggerPort | undefined;
  /** Per-pass trouble counter read by the drain loop. */
  tally: { troubled: number };
}): Promise<void> {
  const { notice, deps, input, result, logger, tally } = args;
  const { repos, clock } = deps;

  // Resolve event details AT DISPATCH TIME (the notice carries no payload).
  // A vanished or no-longer-PUBLISHED event is dispatched away silently:
  // cancel/unpublish messaging is the event-change outbox's job, and a
  // confirmation for a dead event would only confuse the recipient.
  //
  // ONE EXCEPTION: a DATE_CANCELLED notice on a CANCELLED, ARCHIVED or
  // COMPLETED listing. Cancelling, archiving or completing (owner ruling
  // 2026-10-16, Q5) a community listing calls off its remaining
  // nights and writes these notices in the SAME transaction that flips the
  // listing (`callOffRemainingDates`), because its per-night RSVPers are not
  // in the event-change outbox's audience. Skipping them here would drop
  // every one of those messages while the audit row counts them as told.
  const event = await repos.events.getById(notice.eventId);
  const listingOff =
    event?.status === "CANCELLED" ||
    event?.status === "ARCHIVED" ||
    event?.status === "COMPLETED";
  const sendable =
    event?.status === "PUBLISHED" ||
    (notice.kind === "DATE_CANCELLED" && listingOff);
  if (!event || !sendable) {
    await repos.rsvpNotices.markDispatched([notice.id], clock.now());
    result.skipped += 1;
    logger?.info("community.dispatchRsvpNotifications.event_gone", {
      noticeId: notice.id,
      eventId: notice.eventId,
      status: event?.status ?? null,
    });
    return;
  }

  // Per-date notice (recurring listing): resolve the DATE at dispatch time
  // too. Event-level notices (eventDateId null) skip this entirely and behave
  // exactly as before.
  //
  // The status the notice NEEDS depends on what it says. A confirmation needs
  // a night that is on; a cancellation needs one that is off. This used to be
  // an unconditional `!== "SCHEDULED"` skip, which is precisely what kept the
  // drain silent at the one moment it had something worth saying.
  const requiredDateStatus =
    notice.kind === "DATE_CANCELLED" ? "CANCELLED" : "SCHEDULED";
  let eventDate: EventDateRecord | null = null;
  if (notice.eventDateId !== null) {
    eventDate = await repos.eventDates.getById(notice.eventDateId);
    if (!eventDate || eventDate.status !== requiredDateStatus) {
      await repos.rsvpNotices.markDispatched([notice.id], clock.now());
      result.skipped += 1;
      logger?.info("community.dispatchRsvpNotifications.date_gone", {
        noticeId: notice.id,
        eventId: notice.eventId,
        eventDateId: notice.eventDateId,
        kind: notice.kind,
        status: eventDate?.status ?? null,
        requiredDateStatus,
      });
      return;
    }
  }

  // A DATE_CANCELLED notice without a date id cannot be rendered (the variant
  // is per-occurrence by construction) and would otherwise fall through to the
  // confirmation payload below — an "you're going" email for a cancellation.
  // Data-integrity guard: `cancelEventDate` always sets the id.
  if (notice.kind === "DATE_CANCELLED" && !eventDate) {
    await repos.rsvpNotices.markDispatched([notice.id], clock.now());
    result.skipped += 1;
    logger?.error("community.dispatchRsvpNotifications.cancellation_without_date", {
      noticeId: notice.id,
      eventId: notice.eventId,
      humanId: notice.humanId,
    });
    return;
  }

  // RSVP withdrawn between enqueue and dispatch → say nothing. Never confirm
  // an RSVP that no longer exists, and equally never tell someone their night
  // is off when they had already decided not to go. A per-date notice checks
  // the per-date RSVP row; an event-level one the event-level row.
  //
  // The whole-listing take-down notice is the exception: ONE notice stands for
  // every night the person held, anchored on their earliest. Withdrawing that
  // night alone must not silence it, so it asks whether they still hold ANY
  // called-off night of the listing FROM THE ANCHOR ON. The take-down called
  // off the anchor and the nights after it; a night STARTING BEFORE the
  // anchor is not one this notice speaks for, so holding it must not keep the
  // take-down message alive. Residual, accepted (narrow window): a night a
  // moderator called off earlier that starts AFTER the anchor still counts;
  // nothing records which call-off flipped a night.
  // (`eventDate` is non-null for a DATE_CANCELLED notice, guarded above.)
  const stillRsvpd = notice.kind === "DATE_CANCELLED" && listingOff && eventDate
    ? await repos.eventDateRsvps.existsForUserOnEvent({
        eventId: notice.eventId,
        humanId: notice.humanId,
        dateStatus: "CANCELLED",
        startsAtFrom: eventDate.startsAt,
      })
    : notice.eventDateId !== null
    ? await repos.eventDateRsvps.existsForUser({
        eventDateId: notice.eventDateId,
        humanId: notice.humanId,
      })
    : await repos.eventRsvps.existsForUser({
        eventId: notice.eventId,
        humanId: notice.humanId,
      });
  if (!stillRsvpd) {
    await repos.rsvpNotices.markDispatched([notice.id], clock.now());
    result.skipped += 1;
    logger?.info("community.dispatchRsvpNotifications.rsvp_cancelled", {
      noticeId: notice.id,
      eventId: notice.eventId,
      eventDateId: notice.eventDateId,
      kind: notice.kind,
      humanId: notice.humanId,
    });
    return;
  }

  const base = deps.appBaseUrl.replace(/\/+$/, "");

  // The event page link MUST be slug-based: `/events/<uuid>` 404s (the public
  // route resolves by slug / slug history only), so the "View the event" link
  // in every RSVP confirmation email pointed at a dead page. `status` is
  // PUBLISHED by the guard above (or CANCELLED/ARCHIVED/COMPLETED for a
  // whole-listing DATE_CANCELLED, which keeps the link only when CANCELLED,
  // see below), and publish-event assigns a
  // slug in the publishing transaction, so this is null only for genuinely
  // broken data — in which case the notice still sends, just without the link.
  const eventUrl = eventPublicUrl({
    baseUrl: deps.appBaseUrl,
    slug: event.slug,
  });

  // A per-date notice carries the OCCURRENCE's start/end (the whole point of
  // RSVPing to one date); everything else (title, tz, venue, urls) stays
  // event-level. NOTE: a date's endsAt is intentionally NOT backfilled from
  // the event's — occurrences carry their own duration (or none).
  const startsAt = eventDate ? eventDate.startsAt : event.startsAt;
  const endsAt = eventDate ? eventDate.endsAt : event.endsAt;

  // An event with no poster gets the generated Date Stub rather than an empty
  // image slot — see `eventEmailImageUrl`. The stub carries the EVENT's date,
  // not the occurrence's: it is the event's share artifact and is cached per
  // event, so a per-date notice reuses it rather than minting a second,
  // near-identical image.
  const heroImageUrl = eventEmailImageUrl({
    baseUrl: deps.appBaseUrl,
    event: {
      id: event.id,
      slug: event.slug,
      title: event.title,
      startsAt: event.startsAt,
      timezone: event.timezone,
      updatedAt: event.updatedAt ?? null,
      heroImageUrl: event.heroImageUrl ?? null,
      venueName: event.locationLabel ?? null,
    },
  });

  // "That night is off." `eventDate` is non-null here (guarded above), and the
  // payload is deliberately leaner than the confirmation's: no endsAt and no
  // address, because the would-have-been end time and location of a night that
  // is not happening are noise. The link points at the event page because the
  // recipient's actual next question is what the REST of the schedule looks
  // like.
  //
  // WHOLE LISTING OFF. When the listing itself is CANCELLED, ARCHIVED or
  // COMPLETED there is no rest of the schedule: `listingCancelled` switches
  // the renderer to the whole-listing copy ("Cancelled: <title>. None of its
  // remaining nights will happen.", true for all three: every night the
  // recipient had ahead is off).
  //
  // THE LINK MATCHES THE PAGE IT OPENS. A cancellation links to the event
  // page only when that page will say the event is cancelled: the status
  // banner reads "Event cancelled" for CANCELLED, but "No longer available"
  // for ARCHIVED and "Event ended" for COMPLETED. So a CANCELLED listing
  // keeps its link and an ARCHIVED or COMPLETED one sends none. A per-night
  // notice on a PUBLISHED listing keeps it (the rest of the schedule).
  //
  // All of this is derived from the
  // event's status here, at dispatch, never stored on the notice: the
  // take-down writes one notice per person (on their earliest night), and
  // this is what makes that one notice speak for every night they held.
  if (notice.kind === "DATE_CANCELLED" && eventDate) {
    try {
      await deps.notify({
        humanId: notice.humanId,
        variant: RSVP_DATE_CANCELLED_VARIANT,
        payload: {
          eventId: event.id,
          eventDateId: eventDate.id,
          eventTitle: event.title,
          startsAtIso: eventDate.startsAt.toISOString(),
          timezone: event.timezone,
          venueName: event.locationLabel ?? null,
          heroImageUrl,
          eventUrl:
            listingOff && event.status !== "CANCELLED" ? null : eventUrl,
          ...(listingOff ? { listingCancelled: true } : {}),
        },
        idempotencyKey: `rsvp-date-cancelled:${notice.id}`,
      });
    } catch (error) {
      tally.troubled += 1;
      await handleFailure({
        notice,
        input,
        result,
        repos,
        clock,
        logger,
        error,
      });
      return;
    }

    await repos.rsvpNotices.markDispatched([notice.id], clock.now());
    result.dispatched += 1;
    result.recipientsNotified += 1;
    return;
  }

  // Where the confirmation may say the attendee is going: the same gate a
  // ticket holder's surfaces use. Before the reveal (or ever, for NEVER) it
  // carries no street; after it, the Place's street for a venue that
  // withholds its address, and only when that venue vouched for the event
  // (its own show or one it confirmed; a community listing never). A failed
  // venue read throws into the caller's per-notice guard: nothing is sent,
  // the notice is retried.
  const placeId = event.placeId;
  const place = placeId ? await repos.places.getById(placeId) : null;
  const { venueName, addressText } = rsvpLocationFields(
    event,
    resolveHolderAddress({
      event,
      place,
      venueConfirmationArm: venueConfirmationArm(event, place),
      // `stillRsvpd` above: the RSVP exists, and an RSVP has no other state.
      activeHolder: true,
      actOnBill: false,
      now: clock.now(),
    }),
  );

  try {
    await deps.notify({
      humanId: notice.humanId,
      variant: RSVP_CONFIRMED_VARIANT,
      payload: {
        eventId: event.id,
        eventTitle: event.title,
        startsAtIso: startsAt.toISOString(),
        endsAtIso: endsAt ? endsAt.toISOString() : null,
        timezone: event.timezone,
        venueName,
        addressText,
        heroImageUrl,
        // The event page hosts the RSVP toggle — it's also how you cancel.
        eventUrl,
        // /my-rsvps lists EVENT-level RSVPs only (list-my-rsvps reads
        // eventRsvps); a per-date RSVP would never appear there, so per-date
        // confirmations point "manage" at the event page's date list — the
        // real cancel surface — instead of a dead end.
        manageRsvpsUrl: eventDate && eventUrl ? eventUrl : `${base}/my-rsvps`,
      },
      idempotencyKey: `rsvp-confirmed:${notice.id}`,
    });
  } catch (error) {
    tally.troubled += 1;
    await handleFailure({ notice, input, result, repos, clock, logger, error });
    return;
  }

  await repos.rsvpNotices.markDispatched([notice.id], clock.now());
  result.dispatched += 1;
  result.recipientsNotified += 1;
}

/**
 * Outer-guard bookkeeping for a notice that threw OUTSIDE the send path.
 * Reports the swallowed error (CLAUDE.md), then charges the attempt through
 * {@link handleFailure} so it retries on the scheduled cadence and
 * dead-letters at `maxAttempts`. Best-effort: if the bookkeeping itself throws
 * (the database is the likely cause of both), that is reported too and the
 * batch carries on.
 */
async function chargeUnhandled(args: {
  notice: RsvpNoticeRecord;
  input: DispatchRsvpNotificationsInput;
  result: DispatchRsvpNotificationsOutput;
  repos: DispatchRsvpNotificationsDeps["repos"];
  clock: ClockPort;
  logger: LoggerPort | undefined;
  error: unknown;
  reportError?: ReporterPort;
}): Promise<void> {
  const report = (err: unknown, reason: string) => {
    try {
      args.reportError?.(err, {
        tags: { area: "rsvp-notices", reason },
        extra: { noticeId: args.notice.id, eventId: args.notice.eventId },
      });
    } catch {
      // best-effort only
    }
  };
  report(args.error, "notice-unhandled");
  try {
    await handleFailure(args);
  } catch (bookkeepingError) {
    args.logger?.error(
      "community.dispatchRsvpNotifications.unhandled_bookkeeping_failed",
      { noticeId: args.notice.id, error: describeError(bookkeepingError) },
    );
    report(bookkeepingError, "unhandled-bookkeeping-failed");
  }
}

/**
 * Records a failed send for a notice: always bumps `attempts`, and
 * dead-letters (marks dispatched) once the notice would reach `maxAttempts`
 * so a permanently bad notice can't retry forever.
 */
async function handleFailure(args: {
  notice: RsvpNoticeRecord;
  input: DispatchRsvpNotificationsInput;
  result: DispatchRsvpNotificationsOutput;
  repos: DispatchRsvpNotificationsDeps["repos"];
  clock: ClockPort;
  logger: LoggerPort | undefined;
  error: unknown;
}): Promise<void> {
  const { notice, input, result, repos, clock, logger, error } = args;

  await repos.rsvpNotices.incrementAttempts([notice.id]);
  const attempts = notice.attempts + 1;

  if (attempts >= input.maxAttempts) {
    await repos.rsvpNotices.markDispatched([notice.id], clock.now());
    result.deadLettered += 1;
    // Dead-letter drops the confirmation on the floor — log at ERROR so ops
    // can reconcile who never received one.
    logger?.error("community.dispatchRsvpNotifications.dead_letter", {
      noticeId: notice.id,
      eventId: notice.eventId,
      eventDateId: notice.eventDateId,
      humanId: notice.humanId,
      attempts,
      error: describeError(error),
    });
    return;
  }

  logger?.warn("community.dispatchRsvpNotifications.retry", {
    noticeId: notice.id,
    eventId: notice.eventId,
    eventDateId: notice.eventDateId,
    humanId: notice.humanId,
    attempts,
    error: describeError(error),
  });
}
