import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { EventRecord } from "@th/ports/repos/events";
import type { EventDateRecord } from "@th/ports/repos/event-dates";
import type { PlaceRecord } from "@th/ports/repos/places";
import type {
  NotificationPreferenceScope,
  NotificationPreferenceSnapshot,
} from "@th/ports/repos/notification-preferences";
import {
  rsvpReminderChannels,
  type RsvpReminderCandidate,
  type RsvpReminderChannel,
} from "@th/ports/repos/rsvp-reminders";

import { describeError, parseInput } from "../../lib/io";
import { rsvpMayReceiveAddress } from "../../lib/location/holder-eligibility";
import {
  resolveHolderAddress,
  type HolderAddress,
} from "../../lib/location/resolve-holder-address";
import { eventEmailImageUrl, eventPublicUrl } from "../../lib/public-urls";
import { venueConfirmationArm } from "../../lib/venue-confirmation";
import {
  getNotificationCategoryConfig,
  isSmsAllowedForCategory,
  type NotificationCategory,
} from "../comms/categories";
import { isChannelEnabled } from "../comms/shared";
import type { NotifyInput, NotifyOutput } from "../comms/notify";
import { rsvpLocationFields } from "./_shared/rsvp-location-fields";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const RSVP_REMINDER_VARIANT = "rsvp.reminder" as const;

/**
 * Reminders are their OWN preference category, not `transactional`: a person
 * who wants their RSVP confirmation but not a day-before nudge has to be able
 * to say so. Defaults ON for in-app/email/push, OFF for SMS.
 */
const RSVP_REMINDER_CATEGORY = "reminders" as const satisfies NotificationCategory;

const MINUTE_MS = 60_000;

/**
 * `skipped` reasons that mean "this deployment could not even try", not "this
 * recipient cannot receive on this channel".
 *
 * `port_unavailable` is returned by `sendEmail` / `sendPush` / `sendSms` when
 * the corresponding port is absent from `notify`'s deps — i.e. the mailer /
 * SMS adapter is unconfigured in THIS process. `consent_unavailable` is the
 * SMS consent ledger's fail-closed branch: the lookup ERRORED, so the send was
 * refused. Both are transient facts about infrastructure, so settling the
 * ledger on them would burn the reminder for good over an env var. They are
 * classified as FAILED (claim released, reported) — see {@link channelStatus}.
 */
const TRANSIENT_SKIP_REASONS: ReadonlySet<string> = new Set([
  "port_unavailable",
  "consent_unavailable",
]);

// ─────────────────────────────────────────────────────────────────────────────
// Dependencies
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `notify` is typed against the REAL `NotifyOutput`, not `Promise<unknown>`.
 * That is load bearing, not tidiness: `notify` reports a failed email by
 * RETURNING `{ status: "failed", reason: "port_error" }` — `sendEmail` catches
 * both a mailer `success: false` and a thrown `CommsPortError` and only logs a
 * `warn` (which Sentry does not capture). A caller that reacts to rejections
 * only would count a total mailer outage as 200 delivered reminders. The jobs
 * closure already returns exactly this type.
 */
export type SendRsvpRemindersDeps = {
  repos: Pick<
    Repos,
    | "rsvpReminders"
    | "events"
    | "eventDates"
    | "eventDateRsvps"
    | "eventRsvps"
    | "notificationPrefs"
    // The address gate reads the venue: for one that withholds its address
    // the true street is on the Place, and its privacy floors the event's.
    | "places"
  >;
  notify: (input: NotifyInput) => Promise<NotifyOutput>;
  /**
   * Channels this PROCESS can actually deliver on, from the composition root
   * that owns the ports (`ctx.mailer`, `ctx.sms`, `ctx.push`).
   *
   * Not a preference and not a nicety: an unavailable port is the difference
   * between "do not claim" and "claim, get `skipped: port_unavailable` back,
   * and settle the ledger forever". A deploy with `RESEND_API_KEY` unset (or
   * shadowed to empty — the exact GitHub-environment-secret failure mode that
   * blacked out the backend Sentry DSN for four days) would otherwise destroy
   * every email reminder in the window while reporting `failed: 0`. Dropping
   * the channel here means NO ledger row is written, so wiring the port later
   * still reminds anyone whose date is inside the 2h tail — the posture
   * `sendVolunteerShiftReminders` already takes with its `availableChannels`
   * set.
   *
   * Required, not optional-with-a-default: a default would be "assume every
   * port exists", which is the bug.
   */
  availableChannels: ReadonlySet<RsvpReminderChannel>;
  clock: ClockPort;
  /** Public web origin used to build absolute email URLs. */
  appBaseUrl: string;
  logger?: LoggerPort;
  /**
   * Every failure in here is caught and turned into a counter so one bad
   * candidate can't abort the run — which is exactly the shape that goes
   * silent without a reporter. Wired to `Sentry.captureException` in the jobs
   * composition root; always called guarded.
   */
  reportError?: ReporterPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Input / Output
// ─────────────────────────────────────────────────────────────────────────────

export const sendRsvpRemindersInputSchema = z
  .object({
    /**
     * How far ahead of the date the reminder goes out. 24 hours, per the
     * product decision — one reminder, not two.
     */
    leadMinutes: z.number().int().positive().default(24 * 60),
    /**
     * How far PAST the lead mark a date may be and still get a reminder.
     *
     * The window is `[startsAt - lead, startsAt - lead + catchUp]`, so a date
     * enters it at its 24h mark and leaves 2h later. The every-30-minute tick
     * means a reminder normally lands within 30 min of the mark; the 2h tail is
     * what survives a job outage, a Cloud Run cold-start storm, or a
     * scheduler hiccup without silently dropping everyone in that stretch.
     * The ledger makes the overlap free — a date sitting in the window for
     * four consecutive ticks is still reminded exactly once per channel.
     */
    catchUpMinutes: z.number().int().positive().default(2 * 60),
    /**
     * How long a ledger claim may sit unsettled before another tick may take
     * it over. It bounds the crash window: a worker evicted between the claim
     * and the send leaves rows claimed-and-unsent, and without a staleness
     * rule nothing would ever pick them up again.
     *
     * THE INVARIANT IS PER CANDIDATE, NOT PER BATCH: `staleClaimMinutes` must
     * exceed the gap between ONE candidate's `claim()` and its `markSent()` —
     * a single `notify` fan-out — because each claim is stamped with a FRESH
     * clock read taken immediately before it. An earlier version stamped every
     * candidate in the batch with the run-start instant, which made the
     * quantity that mattered total ELAPSED RUN TIME: once a run outlived
     * `staleClaimMinutes`, its own later claims were born already stale and an
     * overlapping tick would retake and re-send them. Protection was then
     * zero, not merely reduced, and `notify`'s 60-second idempotency TTL does
     * not span a 30-minute tick gap.
     *
     * 10 minutes is far longer than one fan-out and far shorter than the 2h
     * tail, so a crash still self-heals inside the window.
     */
    staleClaimMinutes: z.number().int().positive().default(10),
    /** Max candidates examined per run (keeps the job bounded). */
    batchLimit: z.number().int().positive().max(2000).default(200),
  })
  .strict();

export type SendRsvpRemindersInput = z.infer<
  typeof sendRsvpRemindersInputSchema
>;

export const sendRsvpRemindersOutputSchema = z
  .object({
    /** Due-set rows examined this run. */
    candidates: z.number().int().nonnegative(),
    /**
     * Candidates for which at least ONE channel was newly delivered. A
     * candidate whose email failed while its in-app landed counts here AND in
     * `failed` — the two counters are per-channel facts about the same person,
     * not a partition.
     */
    reminded: z.number().int().nonnegative(),
    /**
     * Candidates with nothing left to claim: every channel has already settled
     * or is in flight for an overlapping tick. The idempotency guarantee,
     * observable.
     */
    alreadyReminded: z.number().int().nonnegative(),
    /**
     * Candidates dropped by a send-time guard: the date had already started or
     * stopped being SCHEDULED, the RSVP was withdrawn, the event vanished /
     * stopped being PUBLISHED, the preference read failed (fail-closed), or
     * every channel they would have been reminded on runs off a port this
     * process has not got. No ledger row is written for any of them.
     */
    skipped: z.number().int().nonnegative(),
    /** Candidates whose every channel is switched off by preference. */
    suppressed: z.number().int().nonnegative(),
    /**
     * Candidates every one of whose claimed channels came back `skipped` for a
     * reason a retry cannot change (no push device, no email identity, the
     * renderer omits that channel). The ledger is settled, nothing was
     * delivered, and nothing failed.
     *
     * It exists because without it such a candidate landed in NO counter at
     * all: a batch of 200 people with no contactable channel reported
     * `{ candidates: 200, reminded: 0, failed: 0 }` — all zeros, matching no
     * invariant, indistinguishable from a mailer outage.
     */
    declined: z.number().int().nonnegative(),
    /**
     * Candidates with at least one channel whose send FAILED. Those channels'
     * claims are released, so the next tick retries exactly them — the
     * channels that did land are not re-sent.
     */
    failed: z.number().int().nonnegative(),
  })
  .strict();

export type SendRsvpRemindersOutput = z.infer<
  typeof sendRsvpRemindersOutputSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Use Case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cron-driven 24h-before reminder for COMMUNITY RSVPs — per DATE on a recurring
 * listing (`EventDateRsvp`), per EVENT on a single-date one (`EventRsvp`).
 * Ticket buyers are NOT in scope; nothing here touches orders.
 *
 * WHY THIS EXISTS: a recurring community listing can carry 52 upcoming dates,
 * and someone can say "I'm going" to one five weeks out. A confirmation at
 * RSVP time followed by silence until the night itself is the wrong shape — the
 * reminder is the valuable message.
 *
 * IDEMPOTENCY (the thing most likely to go wrong): a durable `RsvpReminder`
 * ledger row is CLAIMED before the send — one row PER CHANNEL — and the claim
 * is a unique-index insert, so an overlapping tick, a re-run, or a Cloud
 * Scheduler retry loses the race and sends nothing. `notify`'s own idempotency
 * key has a 60-SECOND TTL and is therefore useless as the durable guard; it is
 * still passed, as the within-the-minute belt to the ledger's braces. Each
 * claim is stamped with a clock read taken IMMEDIATELY BEFORE it — never the
 * run-start instant — so a slow batch cannot mint claims that are already
 * stale (see `staleClaimMinutes`).
 *
 * NEVER CLAIM WHAT WE CANNOT SEND: `availableChannels` is intersected with the
 * enabled set before anything is claimed, so a process whose mailer is
 * unconfigured writes no email ledger row at all rather than claiming one and
 * settling it on `skipped: port_unavailable`.
 *
 * FAILURE, PER CHANNEL (mirrors `sendVolunteerShiftReminders`, whose ledger is
 * likewise `@@unique([…, channel])`): `notify` reports a dead mailer by
 * RETURNING `email: { status: "failed" }`, not by throwing, so this inspects
 * every channel of the result.
 *   - delivered → `sentAt` stamped; never sent again;
 *   - declined by the transport for good (`skipped` with a reason no retry can
 *     change: no push device, no email identity, renderer omitted, opted out)
 *     → also settled;
 *   - failed → the claim is RELEASED (row kept, `claimedAt` pushed back), so
 *     the next tick retries THAT channel only. The in-app row that already
 *     landed is not re-fired. `skipped` with a TRANSIENT reason
 *     (`port_unavailable`, `consent_unavailable`) counts as failed, because it
 *     is infrastructure, not the recipient.
 * A `notify` that throws releases every channel it claimed.
 *
 * CRASH RECOVERY: a claim is a two-phase thing (`claimedAt` then `sentAt`), so
 * a worker evicted mid-batch leaves rows claimed-and-unsent instead of rows
 * that look delivered. `findDue` returns a candidate again once its claim is
 * older than `staleClaimMinutes`, which self-heals inside the 2h tail.
 *
 * THE LEAK METRIC, STATED CORRECTLY:
 *   `count(*) FROM "RsvpReminder"
 *      WHERE "sentAt" IS NULL
 *        AND "claimedAt" > to_timestamp(0)
 *        AND "claimedAt" < now() - interval '1 hour'`
 * The `> to_timestamp(0)` term is load bearing. A RELEASED claim is parked AT
 * the UNIX epoch on purpose (so the very next tick retakes it), which makes it
 * trivially "older than an hour" — the naive form counts every healthy retry,
 * never returns to zero, and is useless as an alert. What this counts is the
 * real leak: a row a worker claimed and then died holding.
 * (A released row that is never retried — the window closed first — is also a
 * lost reminder, but it is indistinguishable from a pending one without the
 * subject's `startsAt`, so that check is a join, not a column scan.)
 *
 * NEVER REMINDING ABOUT A DEAD SUBJECT — the same four checks the
 * RSVP-confirmation drain (`dispatch-rsvp-notifications`) applies, in the same
 * order, and for the same reason: a 200-row batch takes minutes, and the
 * read-to-send gap is exactly where a cancellation lands.
 *   - event not PUBLISHED → excluded in the query AND re-read here;
 *   - occurrence not SCHEDULED → excluded in the query AND re-read here. A
 *     moderator calling off ONE night of a weekly listing does not touch
 *     `Event.status`, so the event re-read cannot catch it;
 *   - RSVP withdrawn → cancelling DELETES the row, so it leaves the due set,
 *     but it can leave it mid-batch, so existence is re-checked here too;
 *   - `startsAt` already past → excluded by the window, re-checked here
 *     against the freshly-read occurrence (which may have MOVED).
 *
 * TIMEZONE: "24 hours before" is an INSTANT comparison — `startsAt` minus a
 * fixed offset, no wall-clock arithmetic, so it is identical in every zone. The
 * message CONTENT renders in the listing's timezone (the `rsvp.reminder`
 * renderer resolves "Today"/"Tomorrow" from the local calendar date, which is
 * the one part of this that is genuinely wall-clock).
 */
export async function sendRsvpReminders(
  deps: SendRsvpRemindersDeps,
  rawInput: unknown,
): Promise<SendRsvpRemindersOutput> {
  const input = parseInput(sendRsvpRemindersInputSchema, rawInput);
  const logger = deps.logger?.child({
    useCase: "community.sendRsvpReminders",
  });

  // The run-start instant. Correct for `findDue` — a snapshot query wants ONE
  // consistent window — and for the send-time guards, which only get stricter
  // as the batch runs. It is deliberately NOT the claim stamp: see
  // `staleClaimMinutes` and `claimChannels`.
  const now = deps.clock.now();
  const leadMs = input.leadMinutes * MINUTE_MS;
  const catchUpMs = input.catchUpMinutes * MINUTE_MS;
  const staleClaimMs = input.staleClaimMinutes * MINUTE_MS;

  // A date becomes due when it is `lead` away, and stays due for `catchUp`
  // after that. Expressed as bounds on `startsAt`: the soonest due date starts
  // at `now + lead - catchUp`, the furthest at `now + lead`.
  const windowStart = new Date(now.getTime() + leadMs - catchUpMs);
  const windowEnd = new Date(now.getTime() + leadMs);
  const staleClaimBefore = new Date(now.getTime() - staleClaimMs);

  const result: SendRsvpRemindersOutput = {
    candidates: 0,
    reminded: 0,
    alreadyReminded: 0,
    skipped: 0,
    suppressed: 0,
    declined: 0,
    failed: 0,
  };

  // Channels someone WANTED that this process has no port for. Collected per
  // run and reported ONCE at the end rather than per candidate: an unset
  // `RESEND_API_KEY` affects every row in the batch, and the container
  // announces it with `logger.warn`, which Sentry does not capture.
  const unavailableWanted = new Set<RsvpReminderChannel>();

  let candidates: RsvpReminderCandidate[];
  try {
    candidates = await deps.repos.rsvpReminders.findDue({
      windowStart,
      windowEnd,
      leadMinutes: input.leadMinutes,
      staleClaimBefore,
      limit: input.batchLimit,
    });
  } catch (error) {
    // Returning an empty result rather than throwing keeps one bad tick from
    // turning into a job-level alert storm, but a due-set read that fails is
    // how EVERY reminder in the window goes missing — so it has to be loud.
    logger?.error("community.sendRsvpReminders.due_read_failed", {
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      error: describeError(error),
    });
    deps.reportError?.(error, {
      tags: { useCase: "community.sendRsvpReminders", stage: "find_due" },
      extra: {
        windowStart: windowStart.toISOString(),
        windowEnd: windowEnd.toISOString(),
      },
    });
    return sendRsvpRemindersOutputSchema.parse(result);
  }

  // Events and occurrences repeat heavily across a batch (one listing, many
  // RSVPers), so the send-time re-reads are memoized per run — 200 candidates
  // on 3 listings costs 3 event reads, not 200. Preferences are memoized the
  // same way and for the same reason: they are TWO reads per candidate, so an
  // unmemoized 200-row batch is 400 extra round trips.
  const caches: Caches = {
    events: new Map<string, EventRecord | null>(),
    eventDates: new Map<string, EventDateRecord | null>(),
    places: new Map<string, PlaceRecord | null>(),
    channels: new Map<string, ChannelToggles | null>(),
  };

  for (const candidate of candidates) {
    result.candidates += 1;
    // Outer guard: one candidate must NEVER abort the batch, not even if a
    // repo bookkeeping call throws unexpectedly. Any escape is contained here.
    try {
      await processCandidate({
        candidate,
        deps,
        now,
        leadMs,
        staleClaimMs,
        caches,
        result,
        unavailableWanted,
        logger,
      });
    } catch (error) {
      result.failed += 1;
      logger?.error("community.sendRsvpReminders.candidate_unhandled", {
        eventId: candidate.eventId,
        eventDateId: candidate.eventDateId,
        humanId: candidate.humanId,
        error: describeError(error),
      });
      deps.reportError?.(error, {
        tags: {
          useCase: "community.sendRsvpReminders",
          stage: "candidate_unhandled",
        },
        extra: {
          eventId: candidate.eventId,
          eventDateId: candidate.eventDateId,
          humanId: candidate.humanId,
        },
      });
    }
  }

  // A full batch means the LIMIT, not the window, decided who got reminded —
  // and there is no way to tell from in here whether the rows that didn't fit
  // were reminded by a later tick or simply starved. That is exactly the state
  // in which the run looks healthy and isn't, so it is reported rather than
  // logged at info alongside a reassuring `completed`.
  if (result.candidates >= input.batchLimit) {
    const error = new Error(
      `community.sendRsvpReminders filled its batch limit (${input.batchLimit}); some due reminders may not have been examined this tick`,
    );
    logger?.error("community.sendRsvpReminders.batch_limit_reached", {
      batchLimit: input.batchLimit,
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      ...result,
    });
    deps.reportError?.(error, {
      tags: {
        useCase: "community.sendRsvpReminders",
        stage: "batch_limit_reached",
      },
      extra: { batchLimit: input.batchLimit, ...result },
    });
  }

  // Someone in this batch had a channel switched ON that this deployment has
  // no port for. Nothing was claimed and nothing was lost — the reminder is
  // re-evaluated on the next tick — but a mailer that stays unconfigured for
  // the whole 2h tail IS a silent loss of every email reminder in the window,
  // and the only other signal is a boot-time `logger.warn` Sentry never sees.
  // Once per RUN, not per candidate, so a missing port is one alert, not 200.
  if (unavailableWanted.size > 0) {
    const missing = [...unavailableWanted].sort();
    const error = new Error(
      `community.sendRsvpReminders: no port configured for ${missing.join(", ")}; those reminders were not claimed and not sent`,
    );
    logger?.error("community.sendRsvpReminders.channel_port_unavailable", {
      unavailableChannels: missing,
      availableChannels: [...deps.availableChannels].sort(),
      ...result,
    });
    deps.reportError?.(error, {
      tags: {
        useCase: "community.sendRsvpReminders",
        stage: "port_unavailable",
      },
      extra: { unavailableChannels: missing, ...result },
    });
  }

  logger?.info("community.sendRsvpReminders.completed", {
    ...result,
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
  });

  return sendRsvpRemindersOutputSchema.parse(result);
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-candidate processing
// ─────────────────────────────────────────────────────────────────────────────

type Caches = {
  events: Map<string, EventRecord | null>;
  eventDates: Map<string, EventDateRecord | null>;
  places: Map<string, PlaceRecord | null>;
  channels: Map<string, ChannelToggles | null>;
};

async function processCandidate(args: {
  candidate: RsvpReminderCandidate;
  deps: SendRsvpRemindersDeps;
  now: Date;
  leadMs: number;
  /**
   * The staleness WIDTH, not a precomputed instant: the cutoff is derived from
   * a fresh clock read at the moment of the claim (see below).
   */
  staleClaimMs: number;
  caches: Caches;
  result: SendRsvpRemindersOutput;
  /** Run-level accumulator for channels wanted but not deliverable. */
  unavailableWanted: Set<RsvpReminderChannel>;
  logger: LoggerPort | undefined;
}): Promise<void> {
  const {
    candidate,
    deps,
    now,
    leadMs,
    staleClaimMs,
    caches,
    result,
    unavailableWanted,
    logger,
  } = args;

  // ── Guard: the date has already started ────────────────────────────────
  // The window makes this unreachable while `leadMinutes > catchUpMinutes`,
  // but "never remind about a date that already happened" is a rule, not an
  // emergent property of two numbers a caller can override.
  if (candidate.startsAt.getTime() <= now.getTime()) {
    result.skipped += 1;
    logger?.info("community.sendRsvpReminders.already_started", {
      eventId: candidate.eventId,
      eventDateId: candidate.eventDateId,
      startsAt: candidate.startsAt.toISOString(),
    });
    return;
  }

  // ── Guard: RSVP'd after the lead mark had already passed ────────────────
  // They said "I'm going" with less than 24h to go, so the confirmation they
  // just received IS the reminder. `findDue` applies this in SQL (so the class
  // cannot eat the batch limit); it is repeated here because it is a rule, and
  // a caller can pass a `leadMinutes` the query and the code must agree on.
  if (candidate.rsvpCreatedAt.getTime() > candidate.startsAt.getTime() - leadMs) {
    result.skipped += 1;
    logger?.info("community.sendRsvpReminders.rsvp_inside_lead", {
      eventId: candidate.eventId,
      eventDateId: candidate.eventDateId,
      humanId: candidate.humanId,
      rsvpCreatedAt: candidate.rsvpCreatedAt.toISOString(),
      startsAt: candidate.startsAt.toISOString(),
    });
    return;
  }

  // ── Re-read the event at send time ──────────────────────────────────────
  // The due-set query already filtered on PUBLISHED, but the read-to-send gap
  // is precisely where an unpublish/cancel lands, and we need the title, slug,
  // timezone and venue anyway. Same posture as the RSVP-confirmation drain.
  const event = await readCached(caches.events, candidate.eventId, () =>
    deps.repos.events.getById(candidate.eventId),
  );

  if (!event || event.status !== "PUBLISHED") {
    result.skipped += 1;
    logger?.info("community.sendRsvpReminders.event_gone", {
      eventId: candidate.eventId,
      eventDateId: candidate.eventDateId,
      status: event?.status ?? null,
    });
    return;
  }

  // ── Re-read the OCCURRENCE at send time ─────────────────────────────────
  // A moderator calling off one night of a weekly listing flips
  // `EventDate.status`, NOT `Event.status`, so the event re-read above cannot
  // see it. Without this, a cancellation landing 30 seconds after `findDue`
  // returned still sends "Tomorrow: Weekly Open Mic" for a night that is off.
  let eventDate: EventDateRecord | null = null;
  if (candidate.eventDateId !== null) {
    const dateId = candidate.eventDateId;
    eventDate = await readCached(caches.eventDates, dateId, () =>
      deps.repos.eventDates.getById(dateId),
    );
    if (!eventDate || eventDate.status !== "SCHEDULED") {
      result.skipped += 1;
      logger?.info("community.sendRsvpReminders.date_gone", {
        eventId: candidate.eventId,
        eventDateId: candidate.eventDateId,
        status: eventDate?.status ?? null,
      });
      return;
    }
  }

  // The occurrence may also have MOVED since the due-set read. Everything from
  // here on uses the freshly-read times, and the "already started" rule is
  // re-applied to them.
  const startsAt = eventDate ? eventDate.startsAt : event.startsAt;
  const endsAt = eventDate ? eventDate.endsAt : event.endsAt;
  if (startsAt.getTime() <= now.getTime()) {
    result.skipped += 1;
    logger?.info("community.sendRsvpReminders.already_started", {
      eventId: candidate.eventId,
      eventDateId: candidate.eventDateId,
      startsAt: startsAt.toISOString(),
    });
    return;
  }

  // ── What the reminder may say about WHERE ───────────────────────────────
  // The same gate as a ticket holder's surfaces: no street before the
  // reveal, none ever for NEVER, and the Place's street (not the Event row's
  // public projection) for a venue that withholds its address, only when
  // that venue vouched for the event (never for a community listing). Read
  // BEFORE any claim, so a failed venue read leaves nothing claimed and
  // retries.
  const placeId = event.placeId;
  const place = placeId
    ? await readCached(caches.places, placeId, () =>
        deps.repos.places.getById(placeId),
      )
    : null;
  // The run's `now`, not a fresh clock read: the claim below depends on the
  // ORDER of clock reads (its staleness cutoff), and a reveal edge does not
  // need sub-batch precision.
  const holderAddress = resolveHolderAddress({
    event,
    place,
    venueConfirmationArm: venueConfirmationArm(event, place),
    // The candidate is a live RSVP, and nothing is sent unless it still is
    // (`stillRsvpd` below). An RSVP has no other state. The guards above
    // already skip a cancelled event or night; asking the shared rule here
    // too keeps this surface on it if those guards ever change.
    activeHolder: rsvpMayReceiveAddress({
      eventStatus: event.status,
      ...(eventDate ? { dateStatus: eventDate.status } : {}),
    }),
    actOnBill: false,
    now,
  });

  // ── The RSVP itself may have been withdrawn mid-batch ────────────────────
  // Cancelling DELETES the row, so a withdrawal before `findDue` never reaches
  // us — but one during the batch does.
  const stillRsvpd =
    candidate.eventDateId !== null
      ? await deps.repos.eventDateRsvps.existsForUser({
          eventDateId: candidate.eventDateId,
          humanId: candidate.humanId,
        })
      : await deps.repos.eventRsvps.existsForUser({
          eventId: candidate.eventId,
          humanId: candidate.humanId,
        });
  if (!stillRsvpd) {
    result.skipped += 1;
    logger?.info("community.sendRsvpReminders.rsvp_cancelled", {
      eventId: candidate.eventId,
      eventDateId: candidate.eventDateId,
      humanId: candidate.humanId,
    });
    return;
  }

  // ── Preference gate ─────────────────────────────────────────────────────
  const channels = await readCached(
    caches.channels,
    `${candidate.humanId}|${candidate.eventId}`,
    () =>
      resolveChannels({
        deps,
        humanId: candidate.humanId,
        eventId: candidate.eventId,
        logger,
      }),
  );

  if (channels === null) {
    // Fail-closed on a preference-read failure — the codebase's uniform
    // posture (notify itself fails the send when readEffective throws,
    // broadcast-to-roster skips). Better a missed reminder than one sent to
    // someone who switched them off. No claim is written, so a later tick
    // retries once the read recovers.
    result.skipped += 1;
    return;
  }

  const enabled = rsvpReminderChannels.filter((channel) => channels[channel]);

  if (enabled.length === 0) {
    // Every channel off. NO ledger claim is written on purpose: a claim would
    // permanently consume this reminder's one shot, so someone who switches
    // reminders back on while the date is still inside the window would get
    // nothing. Re-evaluating costs one cached event read per tick.
    result.suppressed += 1;
    logger?.info("community.sendRsvpReminders.suppressed", {
      eventId: candidate.eventId,
      eventDateId: candidate.eventDateId,
      humanId: candidate.humanId,
    });
    return;
  }

  // ── Port gate: never claim a channel this process cannot send on ─────────
  // The primary fix for `skipped: port_unavailable`. Dropping the channel
  // BEFORE the claim means no ledger row exists to be settled, so an
  // unconfigured mailer costs this tick's email and nothing more — wire the
  // port back up and anyone still inside the 2h tail is reminded. Claiming it
  // and reacting to the result afterwards can only ever be the backstop
  // ({@link channelStatus}), because that path retries every tick for the
  // whole window in an environment where the port is permanently absent.
  //
  // KNOWN, ACCEPTED SHAPE (the volunteer precedent has it too): if some OTHER
  // channel settles, this candidate leaves the due set, so restoring the port
  // later in the window does not retro-send the dropped one. That costs a
  // redundant copy — the person was still reminded in-app. When the missing
  // port carries their ONLY channel, nothing settles and no row is written, so
  // they stay in the due set and go out the moment the port returns. That is
  // the case worth protecting, and it is the one protected.
  const deliverable = enabled.filter((channel) =>
    deps.availableChannels.has(channel),
  );
  for (const channel of enabled) {
    if (!deps.availableChannels.has(channel)) unavailableWanted.add(channel);
  }

  if (deliverable.length === 0) {
    // Every channel they'd get runs off a port we haven't got. Same posture as
    // "suppressed": no claim, re-evaluated next tick. Counted as `skipped`
    // (a send-time guard), and the run reports the missing ports once at the
    // end.
    result.skipped += 1;
    logger?.info("community.sendRsvpReminders.no_available_channel", {
      eventId: candidate.eventId,
      eventDateId: candidate.eventDateId,
      humanId: candidate.humanId,
      enabledChannels: enabled,
    });
    return;
  }

  // Channels this candidate has already settled (delivered, or declined by the
  // transport) never go out again — that is what makes a retry driven by one
  // failed channel safe.
  const outstanding = deliverable.filter(
    (channel) => !candidate.settledChannels.includes(channel),
  );
  if (outstanding.length === 0) {
    result.alreadyReminded += 1;
    logger?.info("community.sendRsvpReminders.already_settled", {
      eventId: candidate.eventId,
      eventDateId: candidate.eventDateId,
      humanId: candidate.humanId,
      settledChannels: candidate.settledChannels,
    });
    return;
  }

  // ── Claim, then send ────────────────────────────────────────────────────
  const key = {
    eventDateId: candidate.eventDateId,
    eventId: candidate.eventId,
    humanId: candidate.humanId,
  };
  // FRESH clock read, taken immediately before the claim, with this claim's
  // staleness cutoff derived from the SAME read. Never the run-start instant:
  // a stamp that does not advance makes the guard depend on total elapsed run
  // time, so candidate #170 of a slow batch would be claimed already-stale and
  // an overlapping tick would retake it and send a second reminder. (`markSent`
  // below has always taken a fresh read — that asymmetry was the tell.)
  const claimAt = deps.clock.now();
  const claimed = await deps.repos.rsvpReminders.claim({
    ...key,
    channels: outstanding,
    now: claimAt,
    staleClaimBefore: new Date(claimAt.getTime() - staleClaimMs),
  });
  if (claimed.length === 0) {
    result.alreadyReminded += 1;
    logger?.info("community.sendRsvpReminders.already_claimed", {
      eventId: candidate.eventId,
      eventDateId: candidate.eventDateId,
      humanId: candidate.humanId,
      channels: outstanding,
    });
    return;
  }

  let output: NotifyOutput;
  try {
    output = await deps.notify(
      buildNotifyInput({
        candidate,
        event,
        holderAddress,
        startsAt,
        endsAt,
        deps,
        claimed,
      }),
    );
  } catch (error) {
    // Roll every claim back so the next tick retries. Without this a transient
    // mailer 5xx would mark the reminder "sent" forever and the attendee
    // would silently never be reminded — the exact failure the volunteer
    // reminder job fixed the same way.
    await releaseClaims({
      deps,
      key,
      channels: claimed,
      logger,
    });

    result.failed += 1;
    logger?.error("community.sendRsvpReminders.send_failed", {
      eventId: candidate.eventId,
      eventDateId: candidate.eventDateId,
      humanId: candidate.humanId,
      channels: claimed,
      error: describeError(error),
    });
    deps.reportError?.(error, {
      tags: { useCase: "community.sendRsvpReminders", stage: "notify" },
      extra: {
        eventId: candidate.eventId,
        eventDateId: candidate.eventDateId,
        humanId: candidate.humanId,
        channels: claimed,
      },
    });
    return;
  }

  // ── The half of the failure surface that does NOT throw ─────────────────
  const verdict = classifyChannels(output, claimed);

  if (verdict.settled.length > 0) {
    try {
      await deps.repos.rsvpReminders.markSent({
        ...key,
        channels: verdict.settled,
        sentAt: deps.clock.now(),
      });
    } catch (error) {
      // The send HAPPENED; only the bookkeeping failed. The claim stays
      // unsettled, so a later tick re-sends — a duplicate nudge, which is the
      // survivable direction, but it should never be invisible.
      logger?.error("community.sendRsvpReminders.mark_sent_failed", {
        eventId: candidate.eventId,
        eventDateId: candidate.eventDateId,
        humanId: candidate.humanId,
        channels: verdict.settled,
        error: describeError(error),
      });
      deps.reportError?.(error, {
        tags: { useCase: "community.sendRsvpReminders", stage: "mark_sent" },
        extra: {
          eventId: candidate.eventId,
          eventDateId: candidate.eventDateId,
          humanId: candidate.humanId,
          channels: verdict.settled,
        },
      });
    }
  }

  if (verdict.failed.length > 0) {
    await releaseClaims({ deps, key, channels: verdict.failed, logger });

    result.failed += 1;
    // `notify` logs these at WARN, which Sentry does not capture, and returns
    // normally — so without this report a ten-minute mailer outage is a
    // completely silent loss of every reminder in it.
    const error = new Error(
      `community.sendRsvpReminders: ${verdict.failed.join(", ")} send failed (notify returned "failed", a transient "skipped" reason, or nothing at all for that channel)`,
    );
    logger?.error("community.sendRsvpReminders.channel_send_failed", {
      eventId: candidate.eventId,
      eventDateId: candidate.eventDateId,
      humanId: candidate.humanId,
      failedChannels: verdict.failed,
      deliveredChannels: verdict.delivered,
    });
    deps.reportError?.(error, {
      tags: { useCase: "community.sendRsvpReminders", stage: "notify" },
      extra: {
        eventId: candidate.eventId,
        eventDateId: candidate.eventDateId,
        humanId: candidate.humanId,
        failedChannels: verdict.failed,
        deliveredChannels: verdict.delivered,
      },
    });
  }

  if (verdict.delivered.length > 0) {
    result.reminded += 1;
  } else if (verdict.failed.length === 0 && verdict.settled.length > 0) {
    // Everything we claimed was declined for good. Without this the candidate
    // fell into NO bucket at all, so a whole batch of uncontactable people
    // reported `{ candidates: 200, reminded: 0, failed: 0 }` — all zeros, and
    // no invariant to catch it.
    result.declined += 1;
    logger?.info("community.sendRsvpReminders.all_channels_declined", {
      eventId: candidate.eventId,
      eventDateId: candidate.eventDateId,
      humanId: candidate.humanId,
      channels: verdict.settled,
    });
  }
}

/**
 * Best-effort claim rollback. A claim we cannot release is a reminder the due
 * set will not offer again until the staleness window elapses — and if that
 * outlasts the catch-up tail, one that is simply lost. Loud.
 */
async function releaseClaims(args: {
  deps: SendRsvpRemindersDeps;
  key: { eventDateId: string | null; eventId: string; humanId: string };
  channels: RsvpReminderChannel[];
  logger: LoggerPort | undefined;
}): Promise<void> {
  const { deps, key, channels, logger } = args;
  if (channels.length === 0) return;
  try {
    await deps.repos.rsvpReminders.release({ ...key, channels });
  } catch (error) {
    logger?.error("community.sendRsvpReminders.release_failed", {
      ...key,
      channels,
      error: describeError(error),
    });
    deps.reportError?.(error, {
      tags: { useCase: "community.sendRsvpReminders", stage: "release_claim" },
      extra: { ...key, channels },
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading notify's answer
// ─────────────────────────────────────────────────────────────────────────────

type ChannelVerdict = {
  /** Reached the recipient. */
  delivered: RsvpReminderChannel[];
  /** Settle the ledger: delivered, or declined by the transport for good. */
  settled: RsvpReminderChannel[];
  /** Release the claim: retryable failure. */
  failed: RsvpReminderChannel[];
};

/**
 * Split `notify`'s per-channel results into "settle" and "retry".
 *
 * `skipped` is NOT one meaning, and treating it as one is what made the first
 * fix here a narrowing rather than a close. It is settled only when the REASON
 * is about the recipient and cannot change on a retry — no push device, no
 * email identity, the renderer omits that channel, they opted out. Retrying
 * those would put the candidate back in the due set on every tick for the rest
 * of the window, which is the starvation shape this job already defends
 * against. `port_unavailable` and `consent_unavailable` are about
 * infrastructure, so they are FAILURES (see {@link TRANSIENT_SKIP_REASONS}).
 *
 * A channel we claimed but that is MISSING from the output is treated as a
 * failure: we have no evidence of delivery, and for a free reminder a possible
 * duplicate beats a possible silence.
 */
function classifyChannels(
  output: NotifyOutput,
  claimed: RsvpReminderChannel[],
): ChannelVerdict {
  const verdict: ChannelVerdict = { delivered: [], settled: [], failed: [] };

  for (const channel of claimed) {
    const status = channelStatus(output, channel);
    if (status === "delivered") {
      verdict.delivered.push(channel);
      verdict.settled.push(channel);
    } else if (status === "declined") {
      verdict.settled.push(channel);
    } else {
      verdict.failed.push(channel);
    }
  }

  return verdict;
}

function channelStatus(
  output: NotifyOutput,
  channel: RsvpReminderChannel,
): "delivered" | "declined" | "failed" {
  const result =
    channel === "in_app"
      ? output.inApp
      : channel === "push"
        ? output.push
        : channel === "email"
          ? output.email
          : output.sms;

  if (!result) return "failed";
  // In-app persists a row rather than handing off to a transport, so its
  // success status is `persisted`; the other three report `sent`.
  if (result.status === "persisted" || result.status === "sent") {
    return "delivered";
  }
  if (result.status === "skipped") {
    // The reason, not the status, decides. `port_unavailable` means the port
    // was missing from `notify`'s deps — settling on it would burn the
    // reminder over an env var.
    return TRANSIENT_SKIP_REASONS.has(result.reason) ? "failed" : "declined";
  }
  return "failed";
}

// ─────────────────────────────────────────────────────────────────────────────
// Caching
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Memoize a per-run read, INCLUDING its negative and null answers — an event
 * that vanished must cost one read per batch, not one per RSVPer.
 */
async function readCached<T>(
  cache: Map<string, T>,
  key: string,
  read: () => Promise<T>,
): Promise<T> {
  // `has`, not a truthiness test on `get`: a cached `null` (event vanished)
  // must count as a hit.
  if (cache.has(key)) return cache.get(key) as T;
  const value = await read();
  cache.set(key, value);
  return value;
}

// ─────────────────────────────────────────────────────────────────────────────
// Preference resolution
// ─────────────────────────────────────────────────────────────────────────────

type ChannelToggles = Record<RsvpReminderChannel, boolean>;

/**
 * Per-channel `reminders` switch for this human on this listing, or `null` when
 * a preference read failed (caller fails closed).
 *
 * Reads BOTH scopes and ANDs them. That is not belt-and-braces — it is load
 * bearing. `notificationPrefs.readEffective` resolves ONE scope's row and does
 * NOT cascade (see the adapter's own note), so handing `notify` an EVENT scope
 * would make a GLOBAL "reminders off" invisible, and handing it GLOBAL would
 * make the per-listing mute invisible. Resolving both here and passing the
 * answer to `notify` as explicit channel overrides is the only way both
 * controls work. A viewer can therefore mute one noisy weekly listing without
 * muting every reminder, and vice versa.
 */
async function resolveChannels(args: {
  deps: SendRsvpRemindersDeps;
  humanId: string;
  eventId: string;
  logger: LoggerPort | undefined;
}): Promise<ChannelToggles | null> {
  const { deps, humanId, eventId, logger } = args;

  const globalScope: NotificationPreferenceScope = { kind: "GLOBAL" };
  const eventScope: NotificationPreferenceScope = { kind: "EVENT", eventId };

  let globalPrefs: NotificationPreferenceSnapshot;
  let eventPrefs: NotificationPreferenceSnapshot;
  try {
    [globalPrefs, eventPrefs] = await Promise.all([
      deps.repos.notificationPrefs.readEffective({
        humanId,
        scope: globalScope,
      }),
      deps.repos.notificationPrefs.readEffective({
        humanId,
        scope: eventScope,
      }),
    ]);
  } catch (error) {
    logger?.error("community.sendRsvpReminders.preference_read_failed", {
      eventId,
      humanId,
      error: describeError(error),
    });
    deps.reportError?.(error, {
      tags: {
        useCase: "community.sendRsvpReminders",
        stage: "read_preferences",
      },
      extra: { eventId, humanId },
    });
    return null;
  }

  const config = getNotificationCategoryConfig(RSVP_REMINDER_CATEGORY);
  const both = (
    channel: "in_app" | "push" | "email" | "sms",
    defaultEnabled: boolean,
  ): boolean =>
    isChannelEnabled(
      globalPrefs,
      channel,
      RSVP_REMINDER_CATEGORY,
      defaultEnabled,
    ) &&
    isChannelEnabled(
      eventPrefs,
      channel,
      RSVP_REMINDER_CATEGORY,
      defaultEnabled,
    );

  return {
    in_app: both("in_app", config.inAppDefaultEnabled),
    push: both("push", config.pushDefaultEnabled),
    email: both("email", config.emailDefaultEnabled),
    // Same rule as notify's SMS channel: a category not registered for SMS
    // is never texted, whatever the stored preferences say.
    sms:
      isSmsAllowedForCategory(RSVP_REMINDER_CATEGORY) &&
      both("sms", config.smsDefaultEnabled),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Notify payload
// ─────────────────────────────────────────────────────────────────────────────

function buildNotifyInput(args: {
  candidate: RsvpReminderCandidate;
  event: EventRecord;
  holderAddress: HolderAddress;
  startsAt: Date;
  endsAt: Date | null;
  deps: SendRsvpRemindersDeps;
  claimed: RsvpReminderChannel[];
}): NotifyInput {
  const { candidate, event, holderAddress, startsAt, endsAt, deps, claimed } =
    args;
  const { venueName, addressText } = rsvpLocationFields(event, holderAddress);
  const base = deps.appBaseUrl.replace(/\/+$/, "");

  // MUST be slug-based: `/events/<uuid>` 404s (the public route resolves by
  // slug / slug history only). Null only for genuinely broken data — the
  // reminder still sends, just without the link.
  const eventUrl = eventPublicUrl({
    baseUrl: deps.appBaseUrl,
    slug: event.slug,
  });

  const isPerDate = candidate.eventDateId !== null;

  return {
    humanId: candidate.humanId,
    variant: RSVP_REMINDER_VARIANT,
    // EVENT scope so the in-app row and the notify-level key are attributed to
    // the listing. The preference decision is already made above and passed as
    // overrides, so notify's own (non-cascading) read is not relied on.
    scope: { kind: "EVENT", eventId: event.id },
    // ONLY the channels this tick actually claimed. On a retry driven by a
    // failed email that is `email` alone, which is what keeps the already
    // delivered in-app row from being written a second time.
    channels: {
      inApp: { enabled: claimed.includes("in_app") },
      push: { enabled: claimed.includes("push") },
      email: { enabled: claimed.includes("email") },
      sms: { enabled: claimed.includes("sms") },
    },
    payload: {
      eventId: event.id,
      eventDateId: candidate.eventDateId,
      eventTitle: event.title,
      // The OCCURRENCE's start/end for a per-date reminder — the whole point of
      // RSVPing to one date, and re-read at send time so a moved date is
      // announced at its new time. A date's endsAt is never backfilled from
      // the event's: occurrences carry their own duration, or none.
      startsAtIso: startsAt.toISOString(),
      endsAtIso: endsAt ? endsAt.toISOString() : null,
      timezone: event.timezone,
      venueName,
      addressText,
      // An event with no poster gets the generated Date Stub rather than an
      // empty image slot. The stub carries the EVENT's date, not the
      // occurrence's: it is the event's share artifact and is cached per
      // event, so a per-date reminder reuses it rather than minting a second,
      // near-identical image.
      heroImageUrl: eventEmailImageUrl({
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
      }),
      eventUrl,
      // /my-rsvps lists EVENT-level RSVPs only (list-my-rsvps reads
      // eventRsvps), so a per-date reminder points "manage" at the event
      // page's date list — the real cancel surface — instead of a dead end.
      manageRsvpsUrl: isPerDate && eventUrl ? eventUrl : `${base}/my-rsvps`,
    },
    // Subject-scoped, so the two reminders for two Wednesdays of one listing
    // never collide. Belt to the ledger's braces only: notify's idempotency
    // TTL is 60 seconds, which covers an overlapping tick but nothing like the
    // 2h catch-up window — the `RsvpReminder` unique index is the real guard.
    idempotencyKey: `rsvp-reminder:${candidate.eventDateId ?? candidate.eventId}`,
  };
}
