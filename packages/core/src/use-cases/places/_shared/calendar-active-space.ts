import type { CalendarWithSpacesRow } from "@th/ports/repos/calendars";
import type { SpaceRow } from "@th/ports/repos/spaces";

// ─────────────────────────────────────────────────────────────────────────────
// THE ≥1-ACTIVE-SPACE-PER-CALENDAR INVARIANT (owner rulings 2026-09-23, and
// 2026-09-24 which moved it into the database).
//
// A calendar must always have at least one ACTIVE space — a roomless calendar
// is invalid data, not a configuration.
//
// WHERE THE INVARIANT ACTUALLY LIVES, since 2026-09-24: in Postgres.
// `Calendar.primarySpaceId` is NOT NULL and carries a composite FK onto
// `Space(id, status)` whose status leg is CHECK-pinned to ACTIVE (migration
// 20260924120000_calendar_primary_space), so a Calendar without an ACTIVE space
// is UNREPRESENTABLE and a Space that is some calendar's primary cannot be
// retired. The place-scoped advisory lock this file used to rely on
// (`SpacesRepo.lockCalendarSpaceGuard`) was DELETED the same day: the FK's row
// locks serialize the writers, and two mechanisms for one invariant means the
// bypassable one is the real contract.
//
// THE GUARDS BELOW STAY, and are not redundant. The FK produces "update or
// delete on table Space violates foreign key constraint ..." — unfit for a
// venue admin, and silent about WHICH calendar blocks the retire. The guards
// own the friendly, specific refusal; the constraint owns the guarantee that
// no write path can get around it. That layering is the point.
//
// Two writes can break the invariant, and both are guarded from here so the
// rule reads in ONE file:
//
//   1. Assigning a space set that is entirely RETIRED (createCalendar /
//      assignCalendarSpaces). `min(1)` at the schema boundary guarantees one
//      JOIN, not one ACTIVE space — the admin space checklist lists retired
//      rooms as checkable, so this is reachable from the real UI.
//      → {@link hasActiveSpace}
//
//   2. Retiring a space that is some calendar's last active one
//      (setSpaceStatus). The place-level `countActiveForPlace` guard does NOT
//      cover this: a place with three rooms where calendar A is joined only to
//      room 1 can retire room 1 and still have two active rooms.
//      → {@link calendarsStrandedByRetiring}
//
// Both are check-then-act and MUST run inside the mutation's own `repos.tx()`
// — the same posture as every countActive-style invariant in this codebase.
//
// ── JOINED-NESS IS A SECOND CONSTRAINT, AND THE ORDERING STILL MATTERS ──────
//
// The first FK guarantees the primary is ACTIVE. It does NOT guarantee the
// primary is among the calendar's own `CalendarSpace` joins. Until 2026-09-24
// that gap was held shut by write ordering alone, which RELOCATED the 2026-09-23
// race rather than closing it: calendar C joined to {A, B} with A primary; T1
// narrows C to {A}; T2 retires A and promotes C to B off its stale read; both
// commit; C's primary is the ACTIVE B while its only JOIN is the retired A, with
// every constraint satisfied.
//
// The owner's instruction was that this be a DATABASE invariant, so it is:
// "Calendar_primary_space_joined_fkey", a second composite FK Calendar(id,
// primarySpaceId) → CalendarSpace(calendarId, spaceId), DEFERRABLE INITIALLY
// DEFERRED because the two tables reference each other (migration
// 20260924160000_calendar_primary_space_joined). That interleaving now fails at
// COMMIT even with the guard below neutralised — MEASURED, in
// packages/adapters/test/integration/calendar-primary-space-race.test.ts.
//
// THE WRITE ORDERING STAYS, and is not made redundant by it. The ordering is
// what produces the FRIENDLY TYPED refusals; the constraint is a backstop that
// raises a bare `DriverAdapterError` at commit (no typed code, unmappable —
// it fires after every repo method has returned) and rolls the whole transaction
// back. A venue admin must get `CANNOT_RETIRE_LAST_ACTIVE_SPACE_ON_CALENDAR`
// naming the blocking calendar, not a 500. So both halves are still asserted:
//
//   * `CalendarsRepo.setSpaces` writes `primarySpaceId` UNCONDITIONALLY, even
//     when unchanged, so it always takes the Calendar row's lock.
//   * `setSpaceStatus` re-reads the place's calendars AFTER its own writes and
//     refuses then. By that point it has blocked on — and therefore seen the
//     commit of — any transaction that moved the same calendar's row. Its
//     PRE-write check runs on a possibly-stale read and exists for the error
//     MESSAGE; the POST-write re-read is the one that is sound.
//
// Remove either half and the integration tests go red on the ERROR (a commit-time
// FK violation instead of the typed refusal), not on the data.
//
// READ-SIDE TOLERANCE IS UNCHANGED AND DELIBERATE: availability computation
// and `accept-mint`'s spaceless fallback still cope with a join-less or
// all-retired calendar, because rows written before this ruling may exist.
// Only the WRITES refuse.
// ─────────────────────────────────────────────────────────────────────────────

/** Whether a resolved space set leaves the calendar with a room to schedule into. */
export function hasActiveSpace(spaces: readonly SpaceRow[]): boolean {
  return spaces.some((space) => space.status === "ACTIVE");
}

/** The shape `CANNOT_RETIRE_LAST_ACTIVE_SPACE_ON_CALENDAR` names in its `meta`. */
export type StrandedCalendar = { id: string; name: string };

/**
 * The place's calendars that retiring `spaceId` would leave with zero ACTIVE
 * spaces — id + name, so the refusal can tell the venue WHICH calendar blocks
 * it rather than just saying no.
 *
 * `calendars` must be the place's full list WITH its joined spaces including
 * RETIRED ones (`CalendarsRepo.listByPlace`'s documented posture) — an
 * ACTIVE-only read would make every already-stranded calendar look blocking.
 *
 * A calendar the space is not joined to is never stranded by retiring it, so
 * a calendar that is ALREADY roomless (pre-ruling data) does not block an
 * unrelated retirement. Repairing that data is the owner's call, not a side
 * effect of someone retiring a different room.
 *
 * PRECONDITION: `spaceId` names a space that is ACTIVE, or that the CALLER'S
 * OWN transaction has just retired. The question is "what does retiring it
 * cost", and the answer is identical either way because the space is excluded
 * from `survivors` regardless. What must NOT happen is asking about a space
 * some EARLIER transaction retired: every calendar joined to it would be
 * reported as freshly stranded when it was stranded before the call.
 * `setSpaceStatus` satisfies this on both of its calls — the PRE-write one by
 * short-circuiting the no-op (`existing.status === input.status`) first, the
 * POST-write one because the retire it reads is its own.
 */
export function calendarsStrandedByRetiring(
  calendars: readonly CalendarWithSpacesRow[],
  spaceId: string,
): StrandedCalendar[] {
  return calendars
    .filter((calendar) => {
      const joined = calendar.spaces.some((space) => space.id === spaceId);
      if (!joined) return false;
      const survivors = calendar.spaces.filter((space) => space.id !== spaceId);
      return !hasActiveSpace(survivors);
    })
    .map((calendar) => ({ id: calendar.id, name: calendar.name }));
}

/**
 * The calendars whose PRIMARY space is `spaceId` and that have another ACTIVE
 * joined space to fall back on, paired with the space to promote — the
 * AUTO-PROMOTION `setSpaceStatus` performs instead of refusing.
 *
 * This is the UX half of the 2026-09-24 ruling. `primarySpaceId` is an
 * implementation detail of the constraint, not something a venue chose, so
 * "you cannot retire the Patio because some calendar happens to point at it"
 * would be a refusal the system could have resolved itself. Only a calendar
 * with no other active room is genuinely blocked, which keeps
 * `CANNOT_RETIRE_LAST_ACTIVE_SPACE_ON_CALENDAR` meaningful.
 *
 * The promoted space is the FIRST ACTIVE survivor in `calendar.spaces`, which
 * `CalendarsRepo.listByPlace` orders (sortOrder asc, createdAt asc) — the same
 * pick `accept-mint`'s spaceless fallback and `get-place-booking-options` make,
 * and the same rule migration 20260924120000's backfill used. A promotion
 * therefore lands on the room every OTHER reader already treats as the
 * calendar's main one, instead of inventing a fourth answer.
 *
 * Calendars this would strand are absent: they have no survivor to promote and
 * `calendarsStrandedByRetiring` refuses them.
 *
 * SAME PRECONDITION as {@link calendarsStrandedByRetiring} on `spaceId`.
 */
export function primaryPromotionsForRetiring(
  calendars: readonly CalendarWithSpacesRow[],
  spaceId: string,
): { calendarId: string; spaceId: string }[] {
  return calendars.flatMap((calendar) => {
    if (calendar.primarySpaceId !== spaceId) return [];
    const promoted = calendar.spaces.find(
      (space) => space.id !== spaceId && space.status === "ACTIVE",
    );
    return promoted ? [{ calendarId: calendar.id, spaceId: promoted.id }] : [];
  });
}

/**
 * The FIRST ACTIVE space of a resolved set, by the ordering every other reader
 * uses — the primary a create/assign should name. `undefined` when the set has
 * none, which its caller must have refused with
 * `CALENDAR_REQUIRES_ACTIVE_SPACE` already ({@link hasActiveSpace}).
 *
 * DELIBERATELY the caller's own order, NOT sortOrder. Both callers resolve
 * `spaceIds` through `SpacesRepo.findByIds` preserving INPUT order, which is
 * the order the admin's checklist submitted — and that checklist is rendered
 * from `listSpaces` (sortOrder asc), so the two normally agree.
 *
 * Where they can diverge — a caller that submits `[patio, main]` — the primary
 * becomes the patio while `listByPlace`-ordered readers still show main first.
 * That is harmless and intended: `primarySpaceId` is the peg the FK holds the
 * calendar by, not a venue's declaration of its main room. Nothing renders it.
 * The one place the distinction would matter is {@link
 * primaryPromotionsForRetiring}, which does sort, because it has no caller
 * order to honour.
 */
export function pickPrimarySpace(
  spaces: readonly SpaceRow[],
): SpaceRow | undefined {
  return spaces.find((space) => space.status === "ACTIVE");
}
