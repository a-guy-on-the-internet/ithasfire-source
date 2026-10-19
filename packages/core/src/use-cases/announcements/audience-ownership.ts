import type { Repos } from "@th/ports/repos";

import { fail } from "@th/errors";

/**
 * Upper bound on `audienceFilter.eventIds` / `tierIds`. Each id costs a lookup
 * in {@link assertAudienceOwnedBy}, and the request body limit alone would
 * admit hundreds of thousands.
 */
export const MAX_AUDIENCE_FILTER_IDS = 500;

/**
 * The owner an announcement is sent AS. `requireOwnerAccess` proves the actor
 * may act for this owner; {@link assertAudienceOwnedBy} then proves every
 * object the audience points at belongs to the SAME owner.
 */
export type AnnouncementOwner = {
  ownerType: "HUMAN" | "ORGANIZATION";
  ownerId: string;
};

export type AudienceReference = {
  audienceType:
    | "ALL_TICKET_HOLDERS"
    | "EVENT_TICKET_HOLDERS"
    | "MULTIPLE_EVENTS"
    | "EVENT_TICKET_TIER"
    | "CONTACT_LIST"
    | "WAITLIST_SUBSCRIBERS";
  audienceRef?: string | null;
  audienceFilter?:
    | { eventIds: string[] }
    | { eventId: string; tierIds: string[] }
    | null;
  excludedContactListId?: string | null;
  /** The event an announcement is attached to (send only). */
  eventId?: string | null;
};

type OwnershipRepos = {
  events: Pick<Repos["events"], "getById" | "listTicketTypes">;
  inviteLists: Pick<Repos["inviteLists"], "getListById">;
};

/**
 * An event with an `orgId` is org-owned, full stop. A HUMAN owner owns only
 * events with no org whose `humanId` is them — an org event that happens to
 * carry a `humanId` is NOT reachable through the personal owner.
 *
 * Deliberately STRICTER than `ensureSameOwner` (orders/migrate-event-orders.ts),
 * which is not an owner check: it compares two events, and would treat an org
 * event and a personal event sharing a `humanId` as the same owner. Here they
 * are different owners.
 */
function eventBelongsTo(
  event: { orgId: string | null; humanId: string | null },
  owner: AnnouncementOwner,
): boolean {
  if (owner.ownerType === "ORGANIZATION") {
    return event.orgId === owner.ownerId;
  }
  return !event.orgId && event.humanId === owner.ownerId;
}

async function assertEventOwned(
  repos: OwnershipRepos,
  owner: AnnouncementOwner,
  eventId: string,
): Promise<void> {
  const event = await repos.events.getById(eventId);
  // Missing and foreign are indistinguishable on purpose: the response must
  // not tell a caller whether someone else's event id exists.
  if (!event || !eventBelongsTo(event, owner)) {
    throw fail("EVENT_NOT_FOUND");
  }
}

async function assertListOwned(
  repos: OwnershipRepos,
  owner: AnnouncementOwner,
  listId: string,
): Promise<void> {
  const list = await repos.inviteLists.getListById(listId);
  if (
    !list ||
    list.ownerType !== owner.ownerType ||
    list.ownerId !== owner.ownerId
  ) {
    throw fail("TARGET_LIST_NOT_FOUND");
  }
}

/**
 * Assert every object an announcement audience references belongs to
 * `owner`. MUST run after `requireOwnerAccess` and before any audience read.
 *
 * Security review F4 (2026-09-29): the owner was authorized but the audience
 * was trusted as given, so a user could send as themselves to a competitor's
 * ticket holders, waitlist or contact list (and read its size through the
 * preview count).
 *
 * @throws `EVENT_NOT_FOUND` for a missing or foreign event.
 * @throws `TICKET_TYPE_NOT_FOUND` for a tier that is not on the filter's event.
 * @throws `TARGET_LIST_NOT_FOUND` for a missing or foreign contact list.
 */
export async function assertAudienceOwnedBy(
  repos: OwnershipRepos,
  owner: AnnouncementOwner,
  audience: AudienceReference,
): Promise<void> {
  const eventIds = new Set<string>();
  const listIds = new Set<string>();

  switch (audience.audienceType) {
    case "ALL_TICKET_HOLDERS":
      // Scoped by owner in SQL; no reference to check.
      break;
    case "EVENT_TICKET_HOLDERS":
    case "WAITLIST_SUBSCRIBERS":
      if (audience.audienceRef) eventIds.add(audience.audienceRef);
      break;
    case "CONTACT_LIST":
      if (audience.audienceRef) listIds.add(audience.audienceRef);
      break;
    case "MULTIPLE_EVENTS":
    case "EVENT_TICKET_TIER":
      // Handled from the filter below.
      break;
  }

  const filter = audience.audienceFilter;
  let tierCheck: { eventId: string; tierIds: string[] } | null = null;
  if (filter && "eventIds" in filter) {
    for (const id of filter.eventIds) eventIds.add(id);
  }
  if (filter && "tierIds" in filter) {
    eventIds.add(filter.eventId);
    tierCheck = { eventId: filter.eventId, tierIds: filter.tierIds };
  }
  // A ref the audience type ignores is still refused if it is foreign: the
  // SQL never reads it, but it is persisted on the announcement record.
  if (
    audience.audienceRef &&
    (audience.audienceType === "MULTIPLE_EVENTS" ||
      audience.audienceType === "EVENT_TICKET_TIER" ||
      audience.audienceType === "ALL_TICKET_HOLDERS")
  ) {
    eventIds.add(audience.audienceRef);
  }
  if (audience.eventId) eventIds.add(audience.eventId);
  if (audience.excludedContactListId) {
    listIds.add(audience.excludedContactListId);
  }

  // Fan-out is bounded by the input schemas (`MAX_AUDIENCE_FILTER_IDS`).
  await Promise.all([
    ...[...eventIds].map((id) => assertEventOwned(repos, owner, id)),
    ...[...listIds].map((id) => assertListOwned(repos, owner, id)),
  ]);

  if (tierCheck) {
    const tiers = await repos.events.listTicketTypes(tierCheck.eventId);
    const onEvent = new Set(tiers.map((t) => t.id));
    for (const tierId of tierCheck.tierIds) {
      if (!onEvent.has(tierId)) {
        throw fail("TICKET_TYPE_NOT_FOUND");
      }
    }
  }
}
