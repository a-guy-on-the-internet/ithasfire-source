import type {
  EventDateRecord,
  EventDateRsvpRecord,
  EventDateStatus,
} from "@th/types";

export interface BulkReplaceEventDatesInput {
  eventId: string;
  /**
   * Reference "now" used to decide which existing rows are FUTURE (and thus
   * replaceable). Rows starting before this instant are treated as history and
   * never touched. Passed explicitly so the operation is deterministic/testable.
   */
  now: Date;
  /**
   * The desired future SCHEDULED occurrences (ascending by startsAt). The
   * adapter reconciles the stored set against this one — see
   * {@link EventDatesRepo.bulkReplaceForEvent}. Ordinals are assigned by the
   * adapter (insertion-order identity); the caller supplies only the instants.
   */
  dates: Array<{ startsAt: Date; endsAt?: Date | null }>;
}

/**
 * What a reconciliation DID, not just what it left behind.
 *
 * `cancelledDateIds` exists because the drop path is a call-off: a future
 * SCHEDULED occurrence that people have RSVP'd to and that the new expansion
 * no longer contains is flipped to CANCELLED, and the promise on the
 * moderator's confirm dialog is that everyone who RSVP'd is emailed. The
 * adapter is the only layer that knows which rows those were, so it says so —
 * and stops there. It does NOT read recipients and does NOT write notices;
 * `applyRecurrenceForEvent` (core) owns the fan-out, inside the same
 * transaction, so the outbox write lives with the domain rule rather than in
 * a persistence adapter.
 *
 * EXACTLY-ONCE. The flip is a GUARDED update (`WHERE status = 'SCHEDULED'`)
 * that returns the rows it actually changed, so two transactions racing the
 * same drop — two moderators, or a moderator call-off crossing a rule change —
 * cannot both observe the transition. The loser's `cancelledDateIds` omits the
 * row and it therefore sends nothing. Same property `markStatusIf` gives
 * `cancelEventDate`; here it just comes back as a set instead of a boolean.
 *
 * Hard-DELETED drops are deliberately absent: they had no RSVPs, so there is
 * nobody to tell.
 */
export interface BulkReplaceEventDatesResult {
  /** The resulting SCHEDULED rows, ascending by `startsAt`. */
  scheduled: EventDateRecord[];
  /**
   * Ids of the future SCHEDULED rows THIS call flipped to CANCELLED. Empty on
   * a re-run (they are already CANCELLED, and the guard excludes them).
   */
  cancelledDateIds: string[];
}

export interface ListEventDatesInput {
  eventId: string;
  /** Only occurrences at/after this instant. */
  from?: Date;
  /** Restrict to these statuses (default: all). */
  statuses?: EventDateStatus[];
  limit?: number;
}

/**
 * Batch read for the calendar reads' EventDate expansion (event-calendar-
 * redesign FR-003): every occurrence of MANY events in one query, so a
 * calendar page never issues one round trip per listing. `statuses`
 * defaults to all; the calendar projector passes `["SCHEDULED"]` (a
 * called-off date is not a chip).
 */
export interface ListEventDatesByEventIdsInput {
  eventIds: readonly string[];
  statuses?: EventDateStatus[];
}

export interface ListUpcomingEventDatesInput {
  eventId: string;
  now: Date;
  limit?: number;
}

export interface MarkEventDateStatusInput {
  id: string;
  status: EventDateStatus;
}

/**
 * Guarded compare-and-set on one occurrence's status.
 *
 * The expectation rides in the UPDATE's WHERE clause, so two moderators
 * pressing "Call off" at the same instant cannot both observe a transition:
 * exactly one row matches `expectStatus` and the loser gets `updated: false`.
 * That is what makes the notification fan-out enqueued in the winning
 * transaction exactly-once, without a unique index to lean on.
 *
 * Mirrors {@link EventSeriesOccurrencesRepo.markStatusIf} deliberately — the
 * ticketed-series skip/restore pair solved the same problem first.
 */
export interface MarkEventDateStatusIfInput {
  id: string;
  /** Only transition when the stored status is still this. */
  expectStatus: EventDateStatus;
  status: EventDateStatus;
}

/**
 * Expanded occurrences (EventDate) of a recurring event. Written from the
 * community recurrence write-path; read by discovery/next-date lookups and
 * (later slice) the rolling re-expansion job.
 */
export interface EventDatesRepo {
  /**
   * Reconcile the stored occurrence set to the desired future set within a
   * transaction:
   *  1. Reconcile FUTURE (startsAt >= now) SCHEDULED rows whose startsAt is NOT
   *     in the desired set. PAST rows and CANCELLED rows are never touched
   *     (history + prior cancellations always survive). Each dropped future
   *     SCHEDULED date is then either:
   *       - CANCELLED (the row AND its per-date RSVPs preserved) when it has
   *         ≥1 RSVP — a moderator schedule edit must NOT silently destroy
   *         attendees' intent (the FK cascade would delete their RSVPs); or
   *       - hard-DELETED when it has NO RSVPs (nothing to preserve).
   *  2. Insert the desired dates that are not already present (matched by
   *     startsAt), assigning a fresh non-colliding `ordinal` (max existing + 1,
   *     ascending). Desired dates that coincide with an existing CANCELLED row
   *     are skipped (a moderator-called-off date stays off); ones matching a
   *     live SCHEDULED row have their `endsAt` refreshed.
   * Idempotent: re-running the same expansion inserts, cancels, and deletes
   * nothing (a re-run finds dropped rows already CANCELLED — now excluded by
   * the SCHEDULED filter — or already gone). Returns the resulting SCHEDULED
   * rows ascending by startsAt, PLUS the ids this call cancelled — see
   * {@link BulkReplaceEventDatesResult} for why the second half exists.
   */
  bulkReplaceForEvent(
    input: BulkReplaceEventDatesInput,
  ): Promise<BulkReplaceEventDatesResult>;
  listByEvent(input: ListEventDatesInput): Promise<EventDateRecord[]>;
  /**
   * Occurrences of many events at once — see
   * {@link ListEventDatesByEventIdsInput}. Ordered `eventId` asc then
   * `startsAt` asc so a consumer can group without re-sorting. An empty
   * `eventIds` short-circuits to `[]` without touching the DB. NOT
   * limit-capped: the caller already bounded the event set (a calendar
   * window holds ≤200 events) and the "Date N of M" projection needs every
   * scheduled row of each event, not a page of them.
   */
  listByEventIds(input: ListEventDatesByEventIdsInput): Promise<EventDateRecord[]>;
  /**
   * Occurrences at/after `now`, ascending, capped — **every status, CANCELLED
   * included**.
   *
   * It filtered to SCHEDULED until the call-off feature landed, and that was
   * the read that made a called-off night invisible: the page simply stopped
   * listing it, which reads as "that date was never on the schedule" rather
   * than "that date is off". The public schedule shows a cancelled night
   * struck through until it passes, so the read has to carry it.
   *
   * Consequences for callers, both of which the sole consumer
   * (`listEventDates`) handles explicitly:
   *  - the "next date" is NOT `rows[0]` — it is the first row whose status is
   *    SCHEDULED;
   *  - an empty result no longer means "no upcoming dates"; a result of only
   *    CANCELLED rows means that too.
   */
  listUpcoming(input: ListUpcomingEventDatesInput): Promise<EventDateRecord[]>;
  markStatus(input: MarkEventDateStatusInput): Promise<EventDateRecord>;
  /**
   * Guarded conditional transition (see {@link MarkEventDateStatusIfInput}).
   * `updated: false` means the row no longer held `expectStatus` — callers
   * treat that as "already in the target state" (idempotent no-op) or as a
   * lost race, whichever their domain says.
   */
  markStatusIf(
    input: MarkEventDateStatusIfInput,
  ): Promise<{ updated: boolean }>;
  getById(id: string): Promise<EventDateRecord | null>;
}

export interface EventDateRsvpKeyInput {
  eventDateId: string;
  humanId: string;
}

/**
 * Personal per-date "I'm going" markers for recurring community listings.
 * Idempotent per (eventDateId, humanId) via the DB unique constraint. Like
 * {@link EventRsvpsRepo}, there is deliberately NO PUBLIC count/list-by-date
 * read surface — the viewer-facing reads are the viewer's OWN state
 * (existsForUser / listDateIdsForHuman), and the delete-vs-cancel guard on a
 * moderator schedule edit does its own RSVP-PRESENCE detection inline inside
 * `bulkReplaceForEvent`'s transaction (a scoped `distinct` read) rather than
 * asking here (FR-004).
 *
 * TWO exceptions, each fenced by its own doc, and neither is a number:
 *  - {@link EventDateRsvpRepo.listHumanIdsForDate} — the call-off fan-out's
 *    recipient set (ids). EVERY call-off path uses it — the one-night
 *    `cancelEventDate`, the bulk rule-change drop in
 *    `applyRecurrenceForEvent`, and `callOffRemainingDates` (a community
 *    listing's cancel or archive calling off every remaining night, one
 *    notice per person) — because a rule change that calls off five nights
 *    owes the same five emails a moderator pressing "Call off" five times
 *    would. Nothing derived from it reaches the wire.
 *  - {@link EventDateRsvpRepo.listDateIdsWithAnyRsvp} — a PRESENCE set (which
 *    dates have at least one RSVP), for a moderator deciding whether to apply
 *    a rule change that would call nights off. Read its contract before
 *    calling it.
 * Do not add a sibling that returns a number.
 */
export interface EventDateRsvpRepo {
  /**
   * Idempotent AND race-safe: re-RSVPing a date returns the existing row with
   * `created: false`; `created` is true ONLY when this call's insert won —
   * that flag gates the per-date RSVP-confirmation enqueue upstream (mirrors
   * {@link EventRsvpsRepo.upsert}). MUST run on the base Prisma client, never
   * inside `repos.tx()` — see the adapter docstring.
   */
  upsert(
    input: EventDateRsvpKeyInput,
  ): Promise<{ record: EventDateRsvpRecord; created: boolean }>;
  /** Idempotent: deleting a non-existent RSVP is a no-op. */
  delete(input: EventDateRsvpKeyInput): Promise<void>;
  existsForUser(input: EventDateRsvpKeyInput): Promise<boolean>;
  /**
   * Does `humanId` hold a live RSVP on ANY night of `eventId` (optionally only
   * nights in `dateStatus`, and only nights starting at or after
   * `startsAtFrom`)? The viewer's own state, a boolean, never a count.
   *
   * For the RSVP drain's whole-listing take-down notice: that ONE notice per
   * person hangs on their earliest called-off night, but it speaks for every
   * night they held, so withdrawing the anchor night alone must not silence
   * it. The drain asks with `dateStatus: "CANCELLED"` (the called-off nights)
   * and `startsAtFrom` = the anchor night's start. The bound keeps out nights
   * STARTING BEFORE the anchor: the take-down called off the anchor and the
   * nights after it, so an earlier cancelled night the person still holds is
   * not a reason to tell them. Residual case, accepted (narrow window): a
   * night a moderator called off earlier that starts AFTER the anchor still
   * counts, since nothing records which call-off flipped a night.
   */
  existsForUserOnEvent(input: {
    eventId: string;
    humanId: string;
    dateStatus?: EventDateStatus;
    /** Inclusive lower bound on the night's `startsAt`. */
    startsAtFrom?: Date;
  }): Promise<boolean>;
  /**
   * Batch: which of `eventDateIds` the viewer has RSVP'd — seeds the
   * per-date `viewerRsvped` flags on the list-dates view without N queries.
   * Returns the matching subset (order not guaranteed).
   */
  listDateIdsForHuman(input: {
    humanId: string;
    eventDateIds: string[];
  }): Promise<string[]>;
  /**
   * Everyone holding a live RSVP on ONE occurrence.
   *
   * READ THIS BEFORE USING IT. FR-004 forbids a public going-count, and this
   * is the only read on this repo that is not scoped to the asking viewer. It
   * exists for exactly one job: a call-off (`cancelEventDate`,
   * `applyRecurrenceForEvent`, `callOffRemainingDates`) has to address the
   * people it is about to disappoint, and a fan-out cannot be built from "did
   * YOU RSVP".
   *
   * Rules that keep it from becoming the count FR-004 rules out:
   *  - call it ONLY from a server-side notification fan-out;
   *  - never put its length, or anything derived from it, on the wire — not
   *    even for a moderator (`cancelEventDate` returns `notifiedCount` from the
   *    use case for logs and tests, and the transport's wire schema strips it;
   *    `callOffRemainingDates` puts it on the cancel/archive audit row only);
   *  - never add a `count` sibling here. A count has no notification to send,
   *    so it would only ever be for display.
   *
   * Runs inside the caller's transaction so the recipient set and the
   * SCHEDULED -> CANCELLED flip are one atomic decision.
   */
  listHumanIdsForDate(eventDateId: string): Promise<string[]>;
  /**
   * The subset of `eventDateIds` that carry AT LEAST ONE live RSVP — a
   * presence set, one id per date, however many people are on it.
   *
   * READ THIS BEFORE USING IT. It exists for exactly one decision: a moderator
   * about to apply a rule change that drops nights is told, BEFORE the write,
   * which of those nights someone has said they are coming to — the same fact
   * `bulkReplaceForEvent` acts on a moment later (a dropped night with RSVPs
   * is CANCELLED and its people emailed; one without is deleted outright), so
   * a moderator could always infer it after the destruction. This moves that
   * knowledge in front of the decision, and adds no new class of information.
   *
   * Rules that keep it from becoming the count FR-004 rules out:
   *  - the USE CASE gates it behind the community-moderation roles, not only
   *    the transport — a caller that is not a moderator gets an error, never
   *    an empty set;
   *  - it never rides an edge-cached document (`assertNoViewerScopedFields`
   *    on the web refuses the key);
   *  - it is a boolean per date on the wire, never a number, and the count of
   *    DATES a page derives from it is a count of nights, not of people;
   *  - never add a `count` sibling here.
   */
  listDateIdsWithAnyRsvp(eventDateIds: string[]): Promise<string[]>;
}

export type { EventDateRecord, EventDateRsvpRecord, EventDateStatus };
