import type { TxRepos } from "@th/ports/repos";

/**
 * Call off every REMAINING night of a recurring community listing, inside the
 * caller's transaction, when the whole listing goes away (cancel, archive, or
 * complete before its last night).
 *
 * THE GAP THIS FILLS. A recurring community listing takes RSVPs PER NIGHT
 * (`EventDateRsvp`). Those people are not event-level RSVPers, so the
 * whole-listing change notice (`eventChangeNotices`, fanned out to savers and
 * `eventRsvps`) never reaches them, and their nights stayed SCHEDULED on a
 * listing that no longer exists. They heard nothing.
 *
 * SAME FLIP AS ONE NIGHT. Each remaining night goes through the guarded
 * compare-and-set `cancelEventDate` uses (`markStatusIf(expectStatus:
 * "SCHEDULED")`). Only the winner of a night's CAS reads that night's live
 * per-date RSVPs, so a night a moderator called off a moment earlier is never
 * announced twice. Rows and RSVPs are never deleted.
 *
 * ONE NOTICE PER PERSON, NOT PER NIGHT. Someone holding RSVPs on four
 * remaining nights would otherwise get four "cancelled" emails for one
 * decision. Each person gets ONE `DATE_CANCELLED` notice, attached to their
 * EARLIEST called-off night (nights are read in start order, so the first
 * night a person is seen on is their earliest). The drain sees the listing is
 * CANCELLED, ARCHIVED or COMPLETED and renders the whole-listing copy from
 * that status (derived at dispatch, no stored flag), so the night the notice
 * hangs on is only its anchor: the per-date RSVP guard and the date-status
 * guard read it.
 *
 * NOT TWICE (`skipHumansInEventAudience`). Whenever the caller also writes
 * the event-level CANCELLED change notice, whose drain sends
 * `event.cancelled` to savers ∪ event-level RSVPers, a person in that
 * audience who also holds nights would get two messages saying the same
 * thing, so the caller asks this helper to write no notice for them:
 * `event.cancelled` already tells them the whole thing is off. The audience
 * is read at write time, inside the caller's transaction, and only once some
 * night has RSVPers. Two callers pass it:
 *  - cancel, always;
 *  - archive of a PUBLISHED listing (owner ruling 2026-10-16: "they should be
 *    notified that everything is cancelled if archived"), which writes the
 *    CANCELLED notice instead of `event.unlisted`.
 * Archive of a CANCELLED or COMPLETED listing writes no event-level notice,
 * so it does not pass it: the per-night notice is the only one those people
 * get. Complete (owner ruling 2026-10-16, Q5) writes no event-level notice
 * either and does not pass it, for the same reason.
 *
 * WHAT IS LEFT ALONE.
 *  - Past nights (`startsAt < now`): history, nobody left to tell.
 *  - Nights already CANCELLED: their people were told when they were.
 *  - `Event.startsAt`: not re-pinned. The listing itself is leaving
 *    discovery (cancelled, archived or completed), and its date stays what
 *    it was.
 *
 * ALL OF THEM, NOT A PAGE. `listByEvent` is capped by the adapter, so this
 * re-reads until a read returns no night it has not already handled. Each
 * pass flips what it read out of SCHEDULED, so the next read returns the next
 * batch; the `seen` set ends the loop even if a lost CAS left a row readable.
 *
 * NO SWALLOWS. Every failure throws and rolls the caller's transaction back,
 * flip and notices included.
 *
 * `notifiedCount` is DISTINCT people told, a going-count (FR-004): audit row,
 * logs and tests only, never the wire.
 */
export async function callOffRemainingDates(
  tx: TxRepos,
  params: {
    eventId: string;
    now: Date;
    /**
     * Write no notice for a person already in the event-change audience
     * (savers ∪ event-level RSVPers). Set by cancel and by archive of a
     * PUBLISHED listing, whose `event.cancelled` reaches them; see "NOT
     * TWICE" above.
     */
    skipHumansInEventAudience?: boolean;
  },
): Promise<{ datesCalledOff: number; notifiedCount: number }> {
  const { eventId, now } = params;
  const seen = new Set<string>();
  // People already given their one notice by an earlier night in this call,
  // or (with the skip) already reached by the event-level cancellation.
  let told: Set<string> | null = params.skipHumansInEventAudience
    ? null
    : new Set<string>();
  let datesCalledOff = 0;
  let notifiedCount = 0;

  for (;;) {
    const batch = await tx.eventDates.listByEvent({
      eventId,
      from: now,
      statuses: ["SCHEDULED"],
      limit: PAGE_SIZE,
    });
    const fresh = batch.filter((date) => !seen.has(date.id));
    if (fresh.length === 0) {
      break;
    }

    for (const date of fresh) {
      seen.add(date.id);
      // `from` is inclusive at the adapter; keep the past-is-history rule
      // here too so a fake or a future adapter cannot widen it.
      if (date.startsAt.getTime() < now.getTime()) {
        continue;
      }
      const { updated } = await tx.eventDates.markStatusIf({
        id: date.id,
        expectStatus: "SCHEDULED",
        status: "CANCELLED",
      });
      if (!updated) {
        // Another transaction moved this night first; it owns the fan-out.
        continue;
      }
      datesCalledOff += 1;
      const rsvpers = await tx.eventDateRsvps.listHumanIdsForDate(date.id);
      if (rsvpers.length === 0) {
        continue;
      }
      // Read the event-change audience lazily: a listing whose nights carry
      // no per-night RSVPs never pays for it.
      told ??= await readEventChangeAudience(tx, eventId);
      const alreadyTold = told;
      const humanIds = rsvpers.filter((humanId) => !alreadyTold.has(humanId));
      if (humanIds.length === 0) {
        continue;
      }
      for (const humanId of humanIds) alreadyTold.add(humanId);
      notifiedCount += await tx.rsvpNotices.createDateCancelled({
        eventId,
        eventDateId: date.id,
        humanIds,
      });
    }
  }

  return { datesCalledOff, notifiedCount };
}

/** The adapter's `listByEvent` ceiling (`MAX_LIMIT`); larger asks are clamped. */
const PAGE_SIZE = 500;

type AudiencePage = Awaited<
  ReturnType<TxRepos["eventSaves"]["listHumanIdsForEvent"]>
>;

/** Page size for the saver / event-level RSVPer reads. */
const AUDIENCE_PAGE_SIZE = 500;

/**
 * Savers ∪ event-level RSVPers: the audience the event-change drain sends
 * `event.cancelled` to (`collectAudience` in
 * dispatch-event-change-notifications.ts reads the same two lists). Paged to
 * completion; ids only, never on the wire.
 */
async function readEventChangeAudience(
  tx: TxRepos,
  eventId: string,
): Promise<Set<string>> {
  const humanIds = new Set<string>();
  for (const repo of [tx.eventSaves, tx.eventRsvps]) {
    let cursor: string | null = null;
    do {
      const page: AudiencePage = await repo.listHumanIdsForEvent({
        eventId,
        cursor,
        limit: AUDIENCE_PAGE_SIZE,
      });
      for (const humanId of page.items) humanIds.add(humanId);
      cursor = page.nextCursor;
    } while (cursor);
  }
  return humanIds;
}
