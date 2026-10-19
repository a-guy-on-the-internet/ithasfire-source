/**
 * Durable send-ledger + due-set query for the 24h-before community RSVP
 * reminder (`community.rsvp-reminders-24h`).
 *
 * Shape follows the `VolunteerShiftNotification` claim-then-send ledger rather
 * than RsvpNotice's outbox: there is no enqueue site for a reminder — the due
 * set is DERIVED from the RSVP rows every tick — so the ledger records only
 * what has been claimed, and the unique indexes behind
 * {@link RsvpRemindersRepo.claim} are the idempotency guarantee.
 *
 * PER CHANNEL, exactly like that precedent's `@@unique([signupId, kind,
 * channel])`. `notify` fans one reminder out to in-app / push / email / sms
 * and reports each channel SEPARATELY — a mailer outage returns
 * `email: { status: "failed" }` (it does NOT throw) while the in-app row is
 * already persisted. A subject-level ledger could only record "the reminder
 * happened", so the failed email was indistinguishable from a delivered one
 * and was excluded from the due set forever. Per channel, the delivered
 * in-app stays settled (no duplicate nudge) while the email retries next tick.
 */

/** The comms channels a reminder can be delivered on. */
export type RsvpReminderChannel = "in_app" | "push" | "email" | "sms";

export const rsvpReminderChannels: readonly RsvpReminderChannel[] = [
  "in_app",
  "push",
  "email",
  "sms",
];

/** One (RSVP subject × human) that is due a 24h reminder. */
export interface RsvpReminderCandidate {
  /**
   * The occurrence id for a per-date RSVP on a recurring listing
   * (`EventDateRsvp`); NULL for an event-level RSVP on a single-date listing
   * (`EventRsvp`). Also the ledger's subject discriminator.
   */
  eventDateId: string | null;
  /**
   * Always the parent event — resolved through the date for per-date rows.
   * Carried so the use case can re-read the event at send time (title, slug,
   * timezone, status) exactly like the RSVP-confirmation drain does.
   */
  eventId: string;
  humanId: string;
  /**
   * When the RSVP row was created. Also filtered IN THE QUERY against
   * {@link FindDueRsvpRemindersInput.leadMinutes} — see that field.
   */
  rsvpCreatedAt: Date;
  /** The occurrence's start (per-date) or the event's (event-level). */
  startsAt: Date;
  /** The occurrence's end, or the event's. NULL when the occurrence has none. */
  endsAt: Date | null;
  /**
   * Channels already SETTLED for this (subject × human): delivered, or
   * declined by the channel itself (no push device, no email identity). The
   * use case subtracts these from the channels it would otherwise send, so a
   * retry driven by one failed channel never re-fires a delivered one.
   */
  settledChannels: RsvpReminderChannel[];
}

export interface FindDueRsvpRemindersInput {
  /** Inclusive lower bound on the subject's `startsAt`. */
  windowStart: Date;
  /** Exclusive upper bound on the subject's `startsAt`. */
  windowEnd: Date;
  /**
   * The reminder's lead time. Applied IN THE QUERY as
   * `rsvpCreatedAt <= startsAt - leadMinutes`: someone who RSVP'd after the
   * lead mark had already passed is never a candidate, because the
   * confirmation they just received IS their reminder. It is a filter rather
   * than a use-case skip because a skip writes no ledger row, so that class
   * would sit at the head of the `startsAt ASC` ordering and consume the
   * `limit` on every tick for the whole window — starving every other listing
   * in it.
   */
  leadMinutes: number;
  /**
   * A claim (`sentAt` NULL) older than this is OUTSTANDING — the send failed
   * and released it, or the worker was evicted between the claim and the send
   * — so its candidate is returned again and the claim can be retaken. Without
   * it a Cloud Run eviction mid-batch loses those reminders permanently.
   */
  staleClaimBefore: Date;
  /** Hard cap on rows returned (keeps one tick bounded). */
  limit: number;
}

/**
 * Identity of one reminder's ledger rows. `eventDateId` decides which subject
 * column the adapter writes: a per-date claim stores `eventDateId` with a NULL
 * `eventId`, an event-level claim the reverse (the one-of-two invariant the
 * `RsvpReminder_exactly_one_subject` CHECK enforces). `eventId` is supplied in
 * both cases because the use case always knows it and the logs want it.
 */
export interface RsvpReminderKeyInput {
  eventDateId: string | null;
  eventId: string;
  humanId: string;
}

export interface ClaimRsvpReminderInput extends RsvpReminderKeyInput {
  /** Channels this tick intends to send on. */
  channels: RsvpReminderChannel[];
  /** Claim timestamp (the use case's clock, never the DB's). */
  now: Date;
  /** Same meaning as {@link FindDueRsvpRemindersInput.staleClaimBefore}. */
  staleClaimBefore: Date;
}

export interface SettleRsvpReminderInput extends RsvpReminderKeyInput {
  channels: RsvpReminderChannel[];
  /** When the send settled (the use case's clock). */
  sentAt: Date;
}

export interface ReleaseRsvpReminderInput extends RsvpReminderKeyInput {
  channels: RsvpReminderChannel[];
}

export interface RsvpRemindersRepo {
  /**
   * Every per-date and event-level community RSVP whose subject starts inside
   * the window and still has reminder work outstanding, soonest first.
   *
   * Filters applied IN THE QUERY (so a settled or ineligible backlog can never
   * starve the `limit`):
   *  - the occurrence is SCHEDULED (a called-off date is never reminded);
   *  - the parent event is PUBLISHED;
   *  - `attendanceMode = RSVP` — the same gate `rsvpToEvent` /
   *    `rsvpToEventDate` use, so this never reaches a ticketed event;
   *  - the RSVP predates the lead mark (see {@link
   *    FindDueRsvpRemindersInput.leadMinutes});
   *  - the (subject × human) has either NO ledger rows at all, or at least one
   *    OUTSTANDING row (`sentAt` NULL and `claimedAt` older than
   *    `staleClaimBefore`). A subject whose every claimed channel has settled
   *    is excluded; one currently in flight is excluded for the length of the
   *    staleness window, which is what keeps two overlapping ticks apart;
   *  - event-level rows only for listings with NO `EventDate` rows at all
   *    (i.e. genuinely single-date). On a recurring listing the per-date RSVP
   *    is the attendance signal; reminding about `Event.startsAt` — which the
   *    recurrence job re-pins to whichever occurrence is next — would fire
   *    once, for an arbitrary date the person never picked.
   *
   * A withdrawn RSVP needs no filter: the row is DELETED on cancel, so it
   * simply is not in the result. (The use case still re-checks the RSVP and
   * the occurrence at send time — the read-to-send gap is minutes wide on a
   * full batch.)
   */
  findDue(input: FindDueRsvpRemindersInput): Promise<RsvpReminderCandidate[]>;

  /**
   * Claim channels BEFORE sending on them. Returns the subset actually won:
   *  - a channel with no row is inserted and won;
   *  - a channel whose row is OUTSTANDING (`sentAt` NULL, `claimedAt` <
   *    `staleClaimBefore`) has its `claimedAt` refreshed and is won — this is
   *    the retry of a released or crashed claim;
   *  - a channel that is settled, or in flight for another tick, is NOT
   *    returned.
   * Never throws on the insert conflict: losing the race is the mechanism, not
   * an error.
   *
   * NEVER CALL THIS INSIDE `repos.tx()`. The implementation is a
   * catch-P2002-then-`updateMany` retake, and both halves are only correct on
   * their own connection: in Postgres a unique violation ABORTS the enclosing
   * transaction, so the `updateMany` that follows it fails with
   * `current transaction is aborted` and takes the caller's whole unit of work
   * down with it. The repo is mounted on `TxRepos` for uniformity, which makes
   * this reachable — the claim is deliberately a standalone step before the
   * send, not part of one.
   */
  claim(input: ClaimRsvpReminderInput): Promise<RsvpReminderChannel[]>;

  /**
   * Settle channels after the send: stamps `sentAt`, which takes them out of
   * the due set permanently. Called for channels that DELIVERED and for
   * channels the transport declined for a reason about the RECIPIENT (no push
   * device, no email identity, opted out) — retrying those cannot change the
   * outcome. NOT for a decline about infrastructure (`port_unavailable`,
   * `consent_unavailable`): those release instead.
   */
  markSent(input: SettleRsvpReminderInput): Promise<void>;

  /**
   * Release claims whose send failed, so the next tick retries them. Keeps the
   * row (it is the record that this channel still owes a send) and pushes
   * `claimedAt` back to the UNIX epoch so it is immediately outstanding rather
   * than waiting out the staleness window. Idempotent, and never touches an
   * already-settled row.
   *
   * The epoch stamp is why the leak metric must read
   * `sentAt IS NULL AND claimedAt > to_timestamp(0) AND claimedAt < now() - 1h`
   * — a released row is older than an hour the instant it is written, so the
   * naive form counts healthy retries and never returns to zero.
   */
  release(input: ReleaseRsvpReminderInput): Promise<void>;
}
