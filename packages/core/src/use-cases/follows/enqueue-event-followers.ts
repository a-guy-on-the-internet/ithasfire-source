import type { TxRepos } from "@th/ports/repos";
import type { EventRecord } from "@th/ports/repos/events";
import type { EntityPageRecord } from "@th/ports/repos/entity-pages";
import { eventIsGated } from "../../lib/location/project-public-event-location";
import { venueConfirmationArm } from "../../lib/venue-confirmation";

export type FollowAudienceRepos = Pick<TxRepos, "entityEventNotices" | "entityPages" | "places">;

/**
 * An event may be announced to followers only when anyone could read it:
 * published, PUBLIC, not yet started and NOT gated. Gating fails closed
 * (`eventIsGated`: anything but the literal "NONE" is gated), because a gated
 * event's preview carries only its title and hero, while a notice would mail
 * the title, date and URL.
 */
export function isAnnounceableEvent(event: EventRecord, now: Date): boolean {
  return event.status === "PUBLISHED" && event.visibility === "PUBLIC"
    && event.startsAt > now && !eventIsGated(event);
}

/**
 * The pages whose followers hear about this event. Shared by the producer and
 * the drain, so a relationship revoked after publication cannot send.
 *
 * Only parties who put their OWN name on the event are included: the owning
 * org, the event's own human owner, and the venue when the venue itself
 * vouched (the `owner` or `stamp` arm). Deliberately excluded:
 *  · lineup acts — attaching a human to a lineup needs no consent from them,
 *    so any org editor could otherwise make the platform mail a stranger's
 *    followers. Revisit when acts can consent (lineup v3);
 *  · the `community` venue arm — blanket consent to ownerless listings,
 *    which anyone can write, so it vouches for nothing.
 */
export async function eventFollowPages(repos: FollowAudienceRepos, event: EventRecord): Promise<EntityPageRecord[]> {
  const owners: Array<["HUMAN" | "ORGANIZATION" | "PLACE", string]> = [];
  if (event.orgId) owners.push(["ORGANIZATION", event.orgId]);
  if (event.humanId) owners.push(["HUMAN", event.humanId]);
  if (event.placeId && event.locationMode === "EXACT") {
    const place = await repos.places.getById(event.placeId);
    const arm = place ? venueConfirmationArm(event, place) : null;
    if (place?.locationMode === "EXACT" && (arm === "owner" || arm === "stamp")) owners.push(["PLACE", place.id]);
  }
  const pages = await Promise.all(owners.map(([type,id]) => repos.entityPages.getByOwner(type,id)));
  return [...new Map(pages.filter((p): p is EntityPageRecord => !!p && p.visibility === "PUBLIC" && p.allowFollows).map(p => [p.id,p])).values()];
}

/**
 * Call inside the event mutation's transaction. Unique keys survive
 * republication. `onlyPlace` limits the enqueue to the venue's page (used when
 * the venue confirms an already-published event).
 */
export async function enqueueEventFollowers(repos: FollowAudienceRepos, event: EventRecord, now: Date, options: {onlyPlace?: boolean} = {}): Promise<void> {
  if (!isAnnounceableEvent(event, now)) return;
  for (const page of await eventFollowPages(repos, event)) {
    if (options.onlyPlace && page.ownerType !== "PLACE") continue;
    await repos.entityEventNotices.enqueue({entityPageId: page.id, eventId: event.id, at: now});
  }
}
