import type { SeatsRepo } from "@th/ports/repos/seats";

import { fail } from "@th/errors";

/**
 * Refuses a ticket type write that points at a seat section which is not one
 * of `eventId`'s. The store only needs the section to EXIST (a foreign key),
 * so without this a tier of one event can be saved onto a section of another
 * event, of any organisation, by a caller who knows its id.
 *
 * `null` / `undefined` (a tier with no section, or an unassign) is always
 * allowed, and a call that names no section reads nothing.
 *
 * One event-scoped read (`listSectionsByEvent`) answers for every id of the
 * call. It is deliberately NOT the id-only `getSectionById`: that read finds a
 * section of any event and its summary carries no `eventId`, so it cannot
 * tell "ours" from "theirs".
 *
 * A section of another event and an id no section has are refused alike:
 * `SEAT_SECTION_NOT_FOUND`, no meta, after the same single read. The answer
 * must not tell a caller whether an id exists somewhere else, so do not add
 * the id, or a second code, to the refusal.
 */
export async function ensureSeatSectionsBelongToEvent(
  seats: Pick<SeatsRepo, "listSectionsByEvent">,
  eventId: string,
  seatSectionIds: readonly (string | null | undefined)[],
): Promise<void> {
  const named = seatSectionIds.filter(
    (id): id is string => id !== null && id !== undefined,
  );
  if (named.length === 0) {
    return;
  }

  const sections = await seats.listSectionsByEvent(eventId);
  const ownSectionIds = new Set(sections.map((section) => section.id));
  if (named.some((id) => !ownSectionIds.has(id))) {
    throw fail("SEAT_SECTION_NOT_FOUND");
  }
}
