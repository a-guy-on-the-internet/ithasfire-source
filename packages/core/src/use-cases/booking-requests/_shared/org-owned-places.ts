import type { AuthZRepo } from "@th/ports/repos/authz";

import { ORG_EDIT_ROLES } from "../../../lib/rbac";
import type { PlacesRepo, PlaceRecord } from "@th/ports/repos/places";
import type { PlaceOwnerType } from "@th/ports/repos/place-verification-requests";

// ─────────────────────────────────────────────────────────────────────────────
// "Which venues does this owner own?" — ONE answer, shared by every owner-level
// booking surface (booking-inbox-placement FR-006 + the cross-venue inbox),
// for BOTH owner subjects: an org (the org admin's Bookings page) and a human
// who holds PlaceOwnership directly (the personal admin's Bookings page).
//
// This module exists because the question was about to have two implementations:
// `countOpenBookingRequests` (the badges) and `listBookingRequests({ scope:
// "org-venues" | "human-venues" })` (the inbox those badges link into). Two
// enumerations drift, and the drift is invisible in the worst direction — a
// venue present in one surface and silently absent from the other reads as
// "that venue is quiet", not as "we never looked". Same defect class the
// truncation flag exists to kill, so the fix is the same: one function, one
// ceiling, one truncation signal.
//
// `listOwnedBySubject` is the authoritative predicate: VERIFIED, non-revoked
// ownership on an ACTIVE place — exactly the relation `requirePlaceOwnership`
// reads (direct human ownership, or `orgIdsWithAccess` for an org), so nothing
// enumerated here can be a venue the caller could not already open the inbox
// for.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Upper bound on owned places folded into one response. `places
 * .listOwnedBySubject` clamps its own `limit` to 100, so this is the honest
 * ceiling rather than a second, quieter cap.
 *
 * The cut itself is silent and ALPHABETICAL at the repo (name asc, id asc),
 * which is precisely the defect class these surfaces set out to kill — so
 * truncation is REPORTED (`truncated`) rather than hidden: consumers can say
 * "showing the first 100 venues" instead of letting the tail read as quiet.
 */
export const MAX_OWNED_PLACES = 100;

export type OwnedPlaces = {
  /** Owned ACTIVE places, in the repo's listing order (name asc, id asc). */
  places: PlaceRecord[];
  /**
   * True when the owner holds MORE places than {@link MAX_OWNED_PLACES} and
   * the alphabetical tail was cut. Never silently swallowed — every caller
   * must forward it to its own output.
   */
  truncated: boolean;
};

/**
 * The owning subject: the SAME vocabulary as `PlaceOwnership.ownerType`
 * (`@th/ports/repos/place-verification-requests`), so a caller cannot invent a third
 * kind of owner here that the ownership table does not know.
 */
export type OwnerSubject = {
  ownerType: PlaceOwnerType;
  ownerId: string;
};

/**
 * Enumerate the places a subject (org OR human) owns, with the ceiling made
 * explicit.
 *
 * NOT authz — callers gate BEFORE calling (`requireOrgMembership(ORG_ANY_ROLE)`
 * for an org; for a human the subject must BE the actor). This is the scoping
 * read that follows the gate.
 */
export async function listSubjectOwnedPlaces(
  places: Pick<PlacesRepo, "listOwnedBySubject">,
  subject: OwnerSubject,
): Promise<OwnedPlaces> {
  const owned = await places.listOwnedBySubject({
    ownerType: subject.ownerType,
    ownerId: subject.ownerId,
    limit: MAX_OWNED_PLACES,
  });

  return {
    places: owned,
    // Coming back AT the cap means the owner may hold more. `>=` (not `===`)
    // because the repo clamps `limit` itself — if that clamp ever drops below
    // MAX_OWNED_PLACES, this still reports truncation rather than lying.
    truncated: owned.length >= MAX_OWNED_PLACES,
  };
}

/**
 * Upper bound on the orgs folded into a HUMAN scope's venue set. Each org is
 * one more `listOwnedBySubject` round trip, so this is the fan-out ceiling as
 * well as a result ceiling — and, like {@link MAX_OWNED_PLACES}, it is
 * REPORTED rather than hidden: a person in more orgs than this gets
 * `truncated: true` instead of a quietly short venue list.
 */
export const MAX_SCOPE_ORGS = 25;

/**
 * The owner whose venues an admin surface is showing — the SAME two contexts
 * the admin shell has, and the same discriminant `countOpenBookingRequests`
 * takes on the wire.
 */
export type OwnerScope =
  | { kind: "org"; orgId: string }
  | { kind: "human"; humanId: string };

/**
 * "Which venues does this ADMIN CONTEXT cover?" — the one answer behind the
 * personal and org Bookings inboxes, their badges and the venue filter.
 *
 * The two contexts are deliberately NOT symmetric, because the products
 * aren't:
 *
 *   - `org`    — venues THAT ORG owns, and nothing else. An org admin standing
 *                in one tenant must never be shown, let alone able to answer,
 *                another tenant's booking requests. This is the strict
 *                single-subject enumeration, unchanged.
 *   - `human`  — the personal admin is a HUB, not a tenant: venues the person
 *                owns directly, PLUS the venues of orgs they can ACT for, so
 *                "everything waiting on me" is one list. The venue control
 *                then narrows it.
 *
 *                The org leg is gated on {@link ORG_EDIT_ROLES}, NOT on
 *                membership-any: this hub answers "what is waiting on ME", and
 *                a request you cannot respond to is not waiting on you. A
 *                VIEWER/FINANCE/SCANNER member would otherwise have another
 *                org's requests sitting in their personal inbox with every
 *                action refused — the definition of noise. `ORG_EDIT_ROLES` is
 *                exactly the bar `respondToBookingRequest` enforces, so
 *                everything enumerated here is answerable by the person
 *                looking at it.
 *
 *                Direct human ownership is never role-gated (there is no role
 *                to hold — you own the venue), so those venues are always in.
 *
 *                Nothing is HIDDEN by this: the ORG context's own Bookings
 *                page still lists that org's requests to every member,
 *                membership-any, exactly as before — a VIEWER can still watch
 *                their org's pipeline there. This only decides what lands in a
 *                PERSONAL inbox. And `respond` resolves the owning org from
 *                the PLACE, never from the context the actor is standing in,
 *                so folding org venues into a personal view cannot
 *                mis-attribute an agreement.
 *
 * NOT authz. The caller gates first (org membership for an org scope; for a
 * human scope the subject IS the actor, which is why it carries no id). This
 * is the scoping read that follows the gate.
 */
export async function listOwnerScopePlaces(
  repos: {
    places: Pick<PlacesRepo, "listOwnedBySubject">;
    authz: Pick<AuthZRepo, "listOrgMembershipsByHumanId">;
  },
  scope: OwnerScope,
): Promise<OwnedPlaces> {
  if (scope.kind === "org") {
    return listSubjectOwnedPlaces(repos.places, {
      ownerType: "ORGANIZATION",
      ownerId: scope.orgId,
    });
  }

  const memberships = await repos.authz.listOrgMembershipsByHumanId({
    humanId: scope.humanId,
    // "Can I answer this?" is the membership question a personal inbox asks.
    roles: [...ORG_EDIT_ROLES],
  });
  // Stable across calls (and across the badge/list pair) BEFORE the cut, or
  // the two surfaces could fold in different orgs on the same request.
  const orgIds = Array.from(
    new Set(memberships.map((membership) => membership.orgId)),
  ).sort();
  const includedOrgIds = orgIds.slice(0, MAX_SCOPE_ORGS);

  const subjects: OwnerSubject[] = [
    { ownerType: "HUMAN", ownerId: scope.humanId },
    ...includedOrgIds.map((orgId) => ({
      ownerType: "ORGANIZATION" as const,
      ownerId: orgId,
    })),
  ];

  const results = await Promise.all(
    subjects.map((subject) => listSubjectOwnedPlaces(repos.places, subject)),
  );

  // A place is reachable through more than one subject (a venue co-owned by
  // the person AND one of their orgs is the common case) — union by id, first
  // record wins. Every record for a given id is the same row from the same
  // finder, so which one wins is immaterial.
  const byId = new Map<string, PlaceRecord>();
  for (const result of results) {
    for (const place of result.places) {
      if (!byId.has(place.id)) byId.set(place.id, place);
    }
  }

  // Re-impose the repo's ordering across the union: each subject came back
  // sorted, but concatenating sorted lists does not.
  const places = [...byId.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );

  // Truncated if ANY of the three cuts bit: a subject hit its own ceiling, the
  // org fan-out was capped, or the union itself overflows one response.
  const truncated =
    results.some((result) => result.truncated) ||
    orgIds.length > includedOrgIds.length ||
    places.length > MAX_OWNED_PLACES;

  return { places: places.slice(0, MAX_OWNED_PLACES), truncated };
}
