import { fail, type AppErrorCode, type AppErrorOptions } from "@th/errors";
import type { Repos } from "@th/ports/repos";
import type { EventRecord } from "@th/ports/repos/events";

/**
 * The refusal a public WRITE path already gives an event it will not accept
 * (unpublished / not found). Each path keeps its own answer byte for byte, so
 * a banned owner's event is indistinguishable from one that is simply not
 * open.
 */
export type EventNotOpenRefusal = {
  code: AppErrorCode;
  opts?: AppErrorOptions;
};

const NOT_FOUND: EventNotOpenRefusal = { code: "EVENT_NOT_FOUND" };

/**
 * Load an event for a PUBLIC WRITE (an application, a volunteer signup, a
 * save) and refuse it while its owner is withheld because of a ban
 * (ban-that-sticks, 2026-09-29) — the owning human is BANNED, or every OWNER
 * of the owning org is. The event is read WITH the opt-in owner standing
 * (`getById(id, { withOwnerStanding: true })`), which is derived at read time,
 * so the path opens again the moment the owner is reactivated.
 *
 * Refuses a missing event with EVENT_NOT_FOUND and a banned owner's event
 * with `unpublished` — the error that path already gives an unpublished one.
 * Status and every other check stay with the caller.
 *
 * NOT for resale: the owner ruled that existing ticket holders keep their
 * tickets, and resale is holder-to-holder, so resale checkout stays open.
 * Checkout, RSVP and waitlist refuse inline (`ensureEventOnSale` et al.).
 */
export async function ensureEventOpenToPublic(
  repos: { events: Pick<Repos["events"], "getById"> },
  eventId: string,
  unpublished: EventNotOpenRefusal = NOT_FOUND,
): Promise<EventRecord> {
  const event = await repos.events.getById(eventId, {
    withOwnerStanding: true,
  });
  if (!event) {
    throw fail("EVENT_NOT_FOUND");
  }
  if (event.ownerBanned === true) {
    throw fail(unpublished.code, unpublished.opts);
  }
  return event;
}
