import type { TxRepos } from "@th/ports/repos";
import type { EventRecord } from "@th/ports/repos/events";
import type { PlaceRecord } from "@th/ports/repos/places";
import type { VolunteerSubjectType } from "@th/ports/repos/volunteering";
import { fail } from "@th/errors";

import { ORG_EDIT_ROLES, requireOrgMembership } from "../../../lib/rbac";
import {
  requirePlaceOwnership,
  type PlaceOwnershipResult,
} from "../../booking-requests/_shared/place-access";

/**
 * The polymorphic subject of a `VolunteerAsk` — either straight off a loaded
 * ask row or from create input. `orgId` is the ask's denormalized owning org;
 * it is carried for call-site ergonomics (spread the ask) but the gate below
 * deliberately NEVER trusts it: ownership is always re-derived from the live
 * subject row / membership tables, so a stale or tampered denormalized column
 * can never grant access.
 */
export type AskSubjectRef = {
  subjectType: VolunteerSubjectType;
  subjectId: string;
  orgId: string | null;
};

/**
 * Subject rows the gate had to load anyway, returned so callers (e.g.
 * create-volunteer-ask's status validation + orgId denormalization) can
 * reuse them without a second read inside the same transaction.
 * `placeAccess` is HOW the actor got PLACE access (direct human owner vs.
 * which owning org granted it) — create-volunteer-ask stamps the granting
 * org as the ask's denormalized orgId.
 */
export type AskOwnershipContext = {
  place: PlaceRecord | null;
  placeAccess: PlaceOwnershipResult | null;
  event: EventRecord | null;
};

/**
 * THE trust gate for volunteer-ask ownership (generic-volunteering-asks
 * spec, `authz.ownership_by_subject`). Every ask-management use case calls
 * this inside the same `repos.tx()` as its mutation. Throws unless the
 * actor owns the ask's subject:
 *
 * - PLACE: direct human owner, or member (EDITOR+) of an owning org —
 *   exactly `requirePlaceOwnership` (the booking-request inbox gate).
 * - ORG: OrgMember EDITOR+ of the subject org.
 * - HUMAN: the actor IS the subject human, or holds an edit-capable
 *   `HumanDelegate` grant (ADMIN | EDITOR) from them.
 * - EVENT: the same gate the event volunteer use cases use
 *   (`resolveEventOrg` in manage-event-volunteer-roles): the event must be
 *   org-owned and the actor an OrgMember EDITOR+ of that org.
 *
 * Coordinator scope is deliberately NOT honored here — coordinators manage
 * signups within their group (A4), never the ask/roles/groups themselves.
 *
 * @throws `PLACE_NOT_FOUND` / `EVENT_NOT_FOUND` when the subject row is gone.
 * @throws `EVENT_NOT_ORG_OWNED` for human-owned events (mirrors the event
 *   volunteering gate).
 * @throws `INSUFFICIENT_ROLE` / `NOT_RESOURCE_OWNER` when the actor has no
 *   ownership path.
 */
export async function resolveAskOwnership(
  tx: TxRepos,
  subject: AskSubjectRef,
  actorHumanId: string,
): Promise<AskOwnershipContext> {
  switch (subject.subjectType) {
    case "PLACE": {
      const place = await tx.places.getById(subject.subjectId);
      if (!place) {
        throw fail("PLACE_NOT_FOUND");
      }
      const placeAccess = await requirePlaceOwnership(tx, place, actorHumanId, {
        requiredOrgRoles: ORG_EDIT_ROLES,
      });
      return { place, placeAccess, event: null };
    }

    case "ORG": {
      await requireOrgMembership({
        repos: tx,
        orgId: subject.subjectId,
        actorHumanId,
        roles: ORG_EDIT_ROLES,
      });
      return { place: null, placeAccess: null, event: null };
    }

    case "HUMAN": {
      if (actorHumanId === subject.subjectId) {
        return { place: null, placeAccess: null, event: null };
      }
      // Delegates carry OrgRole-shaped grants (OWNER excluded at creation);
      // managing someone's volunteering asks is an edit action, so require
      // an edit-capable role — same bar as ORG subjects.
      const delegation = await tx.humanDelegates.getDelegation({
        principalId: subject.subjectId,
        delegateId: actorHumanId,
      });
      if (!delegation || !ORG_EDIT_ROLES.includes(delegation.role)) {
        throw fail("INSUFFICIENT_ROLE");
      }
      return { place: null, placeAccess: null, event: null };
    }

    case "EVENT": {
      const event = await tx.events.getById(subject.subjectId);
      if (!event) {
        throw fail("EVENT_NOT_FOUND");
      }
      if (!event.orgId) {
        throw fail("EVENT_NOT_ORG_OWNED");
      }
      await requireOrgMembership({
        repos: tx,
        orgId: event.orgId,
        actorHumanId,
        roles: ORG_EDIT_ROLES,
      });
      return { place: null, placeAccess: null, event };
    }
  }
}
