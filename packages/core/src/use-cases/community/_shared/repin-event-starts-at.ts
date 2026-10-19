import type { TxRepos } from "@th/ports/repos";
import type { EventRecord } from "@th/ports/repos/events";

/**
 * Re-pin `Event.startsAt`/`endsAt` to the listing's first upcoming SCHEDULED
 * occurrence.
 *
 * WHY THIS EXISTS. `Event.startsAt` is not decoration — it is the sort and
 * filter key every discovery read and every geo×category SEO query uses
 * (`startsAt >= now`), which is why both the recurrence write-path
 * (`applyRecurrenceForEvent`) and the rolling top-up job re-pin it. Calling
 * ONE night off changes the answer to "when is this listing next on" without
 * going anywhere near the recurrence rule, so it has to re-pin too. Skip it
 * and discovery keeps advertising a night that is off — with the page
 * simultaneously showing it struck through, which is worse than either alone.
 *
 * WHAT IT PINS TO.
 *  - The first occurrence at/after `now` whose status is SCHEDULED. A
 *    CANCELLED row is never a candidate however close it is.
 *  - `endsAt` comes from that occurrence when it carries one, else from the
 *    listing's own current duration. Occurrences may legitimately carry no
 *    `endsAt`, and a null there would erase a duration the listing does have.
 *  - NOTHING when the pin already sits on that instant. The write is skipped
 *    entirely, so cancelling a date three weeks out (which does not move the
 *    next date) touches no Event row and writes no audit churn.
 *
 * WHEN NOTHING IS LEFT. With no upcoming SCHEDULED occurrence there is no
 * honest future instant to point at, and leaving the pin where it is would
 * leave discovery advertising the very night that was just called off. It is
 * pinned to `now` instead: never `>= now` for any later query, so the listing
 * falls out of `startsAt >= now` discovery, and the DURATION is preserved so
 * the top-up job (which reads `startsAt`/`endsAt` only as a duration template)
 * re-pins it forward the moment it materialises a date. Self-healing, not
 * terminal.
 *
 * That collapse is deliberately the SAME for both zero-dates states — the
 * drained-but-live listing whose top-up stalled and the genuinely-ended one
 * whose rule ran out. Those two are told apart by `listEventDates`'
 * `truncated`, on the read side, where a page can say "next dates are being
 * scheduled" versus "this series has ended". Encoding the distinction in
 * `startsAt` would mean parking a live listing on a future instant it has no
 * occurrence for, which is the bug this function exists to prevent.
 *
 * Runs inside the caller's transaction: the pin and the status flip that moved
 * it commit or roll back together.
 */
export async function repinEventStartsAt(
  tx: TxRepos,
  params: { event: EventRecord; now: Date },
): Promise<{
  moved: boolean;
  startsAt: Date;
  endsAt: Date | null;
  /** True when no upcoming SCHEDULED occurrence remains (the collapse above). */
  drained: boolean;
}> {
  const { event, now } = params;

  const durationMs = Math.max(
    0,
    (event.endsAt?.getTime() ?? event.startsAt.getTime()) -
      event.startsAt.getTime(),
  );

  const [next] = await tx.eventDates.listByEvent({
    eventId: event.id,
    from: now,
    statuses: ["SCHEDULED"],
    limit: 1,
  });

  const drained = !next;
  const startsAt = next ? next.startsAt : now;
  const endsAt = next
    ? (next.endsAt ?? new Date(next.startsAt.getTime() + durationMs))
    : new Date(now.getTime() + durationMs);

  // Compare INSTANTS, and treat a currently-null `endsAt` as "different" from
  // the computed one — that listing is gaining a duration it did not have, so
  // the write is real. Both sides nullable would be a silent no-op otherwise.
  const startsMoved = startsAt.getTime() !== event.startsAt.getTime();
  const endsMoved = (event.endsAt?.getTime() ?? null) !== endsAt.getTime();
  const moved = startsMoved || endsMoved;

  if (!moved) {
    return { moved: false, startsAt, endsAt, drained };
  }

  await tx.events.applyCommunityEdit({
    eventId: event.id,
    fields: { startsAt, endsAt },
  });

  return { moved: true, startsAt, endsAt, drained };
}
