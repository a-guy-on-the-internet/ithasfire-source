import { z } from "zod";

import type { Repos } from "@th/ports/repos";
import type { PlaceRecord } from "@th/ports/repos/places";
import type { SavedSnippetOwner } from "@th/types/repos/saved-snippets";
import { fail } from "@th/errors";

import { ORG_EDIT_ROLES, requireOrgMembership } from "../../../lib/rbac";
import { findPlaceBookerGrant } from "../../booking-requests/_shared/place-access";

// ─────────────────────────────────────────────────────────────────────────────
// Whose saved reasons? (booking-the-night FR-013.)
//
// The client names the list by what it is looking at — its own, an
// organisation it sends for, or a place it works — and the server resolves
// the (ownerType, ownerId) pair. A client-supplied owner pair is never
// accepted, so no input can point at another owner's list.
//
//   { kind: "self" }            → HUMAN, the actor. Only they read or edit it.
//   { kind: "org", orgId }      → ORGANIZATION, orgId. An ORG_EDIT_ROLES member
//                                 reads and edits (the sender's org side: the
//                                 people who decline terms and pass for it).
//   { kind: "place", placeId }  → the party the actor works the place as, in
//                                 this order:
//     1. a DIRECT HUMAN OWNER of the place → their own HUMAN list (on a place
//        an org co-owns, the person never reads or edits the org's list —
//        they may hold no role in it);
//     2. an ORG_EDIT_ROLES member of an owning org → that ORGANIZATION. When
//        the actor edits in SEVERAL owning orgs, the smallest orgId wins, so
//        the same actor always lands on the same list whatever order the
//        membership read returns (sorted HERE, not in the shared
//        `place-access` gate, which the accept mint also uses);
//     3. READ ONLY: an actor covered by an ACTIVE whole-place booking grant
//        (the booker gate, `findPlaceBookerGrant`: the grantee person or an
//        edit-role delegate of theirs, or an edit-role member of the grantee
//        org) at an ORG-owned place → the owning org's list (smallest
//        orgId) — a grantee may USE the place's reasons in a decline, never
//        edit them. A grantee's FIRST read may copy the starters into that
//        org's list: a write made under the grantee's name, accepted as part
//        of "first use" (audited with the grantee as actor).
//     A grantee at a place owned only by PEOPLE is refused
//     (NOT_RESOURCE_OWNER): that person's list is also their own `self`
//     list, and a grant to work a place's bookings is not a window onto a
//     person's own reasons (orchestrator ruling, P2d-1 review W2).
//
// Tiers: direct owner → org member with an edit role → (read only) the
// booker gate. An owning-org member below edit level whom no grant covers is
// INSUFFICIENT_ROLE; anyone else is NOT_RESOURCE_OWNER; a missing place is
// PLACE_NOT_FOUND. Writes never consult grants (a grantee is not staff,
// holds-without-a-request FR-002).
// ─────────────────────────────────────────────────────────────────────────────

export const savedSnippetOwnerInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("self") }).strict(),
  z.object({ kind: z.literal("org"), orgId: z.uuid() }).strict(),
  z.object({ kind: z.literal("place"), placeId: z.uuid() }).strict(),
]);

export type SavedSnippetOwnerInput = z.infer<typeof savedSnippetOwnerInputSchema>;

export type SavedSnippetOwnerRepos = Pick<
  Repos,
  "authz" | "places" | "placeBookingGrants" | "humanDelegates" | "calendars"
>;

const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function notOwner(placeId: string, reason?: string): never {
  throw fail("NOT_RESOURCE_OWNER", {
    meta: { entity: "place", placeId, ...(reason ? { reason } : {}) },
  });
}

async function resolvePlaceOwner(
  repos: SavedSnippetOwnerRepos,
  place: Pick<PlaceRecord, "id" | "humanIdsWithAccess" | "orgIdsWithAccess">,
  actorHumanId: string,
  access: "read" | "write",
  now: Date,
): Promise<SavedSnippetOwner> {
  // 1. Direct human owner — never role-gated.
  if (place.humanIdsWithAccess.includes(actorHumanId)) {
    return { ownerType: "HUMAN", ownerId: actorHumanId };
  }

  // 2. Owning-org member with an edit role; smallest orgId when several.
  let memberOfAnOwningOrg = false;
  if (place.orgIdsWithAccess.length > 0) {
    const memberships = await repos.authz.getOrgMemberships({
      orgIds: place.orgIdsWithAccess,
      humanId: actorHumanId,
    });
    memberOfAnOwningOrg = memberships.length > 0;
    const editable = memberships
      .filter(
        (m) =>
          place.orgIdsWithAccess.includes(m.orgId) &&
          ORG_EDIT_ROLES.includes(m.role),
      )
      .map((m) => m.orgId)
      .sort(byId);
    if (editable[0]) {
      return { ownerType: "ORGANIZATION", ownerId: editable[0] };
    }
  }

  // 3. Read only: an active whole-place grant, at an org-owned place.
  if (access === "read") {
    const granted = await findPlaceBookerGrant(repos, place, actorHumanId, {
      calendarId: null,
      now,
    });
    if (granted) {
      const orgId = [...place.orgIdsWithAccess].sort(byId)[0];
      if (orgId) return { ownerType: "ORGANIZATION", ownerId: orgId };
      // A person-owned place: their list is their own (W2).
      notOwner(place.id, "grantee_cannot_read_person_list");
    }
  }

  if (memberOfAnOwningOrg) throw fail("INSUFFICIENT_ROLE");
  return notOwner(place.id);
}

/** Resolve (and authorize) the list owner for `access`. */
export async function resolveSavedSnippetOwner(
  repos: SavedSnippetOwnerRepos,
  args: {
    actorHumanId: string;
    owner: SavedSnippetOwnerInput;
    access: "read" | "write";
    now: Date;
  },
): Promise<SavedSnippetOwner> {
  const { actorHumanId, owner, access, now } = args;

  if (owner.kind === "self") {
    return { ownerType: "HUMAN", ownerId: actorHumanId };
  }

  if (owner.kind === "org") {
    await requireOrgMembership({
      repos,
      orgId: owner.orgId,
      actorHumanId,
      roles: ORG_EDIT_ROLES,
    });
    return { ownerType: "ORGANIZATION", ownerId: owner.orgId };
  }

  const place = await repos.places.getById(owner.placeId);
  if (!place) throw fail("PLACE_NOT_FOUND");
  return resolvePlaceOwner(repos, place, actorHumanId, access, now);
}
