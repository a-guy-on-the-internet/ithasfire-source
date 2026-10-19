import type { OrgRole } from "@th/ports/repos/authz";
import type { EventRecord, TxRepos } from "@th/ports/repos";
import { ORG_EDIT_ROLES } from "../../../lib/rbac";
import {
  actorHoldsEventEditRole,
  type EventEditRightsAuthz,
} from "../../../lib/event-edit-rights";
import { fail } from "@th/errors";

const EVENT_EDIT_ROLES: ReadonlySet<OrgRole> = new Set(ORG_EDIT_ROLES);

type AuthzRepo = EventEditRightsAuthz;

export async function ensureActorCanEditEvent(
  tx: TxRepos,
  eventId: string,
  actorHumanId: string,
): Promise<EventRecord> {
  const event = await tx.events.getById(eventId);
  if (!event) {
    throw fail("EVENT_NOT_FOUND");
  }

  // Community listings are ownerless by design — direct WRITES through this
  // guard are disabled; content changes flow through the moderated suggestion
  // queue (community-managed-event-listings FR-006/FR-008) or, while the
  // listing is still a DRAFT, through the whitelist-bound
  // `community.updateListing`.
  // canViewerBypassEventGate already returns false for ownerless rows; this
  // makes the rejection explicit and intention-revealing. Kept OUT of
  // canViewerBypassEventGate itself, which is also used for view-gate
  // bypasses.
  //
  // THIS STAYS SHUT EVEN FOR A COMMUNITY MODERATOR, deliberately, and the
  // asymmetry with `getEventForEdit` (which DID open a moderator branch so the
  // builder can hydrate a listing) is the whole design. That one is a read of
  // the listing's own fields. This one gates a dozen OWNED-event surfaces —
  // `updateEventSettings`, `updateEventAccessControls`, the application-form
  // CRUD, `setEventListingPriority`, `getEventProvenance`, submission
  // review — every one of which writes or exposes something an ownerless RSVP
  // listing has no business carrying (payout terms, ticket types, gate type,
  // visibility), none of it passing the FR-007 field whitelist. Opening this
  // to moderators would hand them that entire surface on a row with no owner
  // to answer for it.
  if (event.stewardship === "COMMUNITY") {
    throw fail("INSUFFICIENT_ROLE");
  }

  const canEdit = await canViewerBypassEventGate(tx.authz, event, actorHumanId);
  if (!canEdit) {
    throw fail("INSUFFICIENT_ROLE");
  }

  return event;
}

/**
 * The event-edit bar, and the password / application gate BYPASS
 * (`getEventGateState`, `validateEventPassword`, `submitEventApplication`).
 * Delegates to {@link actorHoldsEventEditRole}: an org ORG_EDIT_ROLES member,
 * or the human owner / an OWNER-ADMIN-EDITOR delegate of the owner (owner
 * ruling 2026-09-28 — delegates get the builder, so they also walk past the
 * principal's own gates, exactly as an org EDITOR does).
 */
export async function canViewerBypassEventGate(
  authz: AuthzRepo,
  event: EventRecord,
  viewerHumanId: string | null | undefined,
): Promise<boolean> {
  return actorHoldsEventEditRole(authz, event, viewerHumanId);
}

export function isEventManagedByOrg(event: EventRecord): boolean {
  return Boolean(event.orgId);
}

export { EVENT_EDIT_ROLES };
