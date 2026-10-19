import type { PlaceRecord } from "@th/ports/repos/places";
import { fail } from "@th/errors";

import type { OwnerContext } from "../../events/_shared/save-event-shared";
import type { BookingAgreementCounterparty } from "./accept-agreement";
import type { PlaceBookingAuthorityResult } from "./place-access";

// ─────────────────────────────────────────────────────────────────────────────
// FR-006 (docs/specs/2026-09-05/completed/booking-accept-is-the-mint-point.spec.md):
// "Counterparty derives from the place, and never from a fallback."
//
// ONE party, two uses. When a venue accepts a booking, the SAME party is both
// the Agreement's venue-side counterparty and the owner the Event is minted
// under. Deriving them separately is how they drift — an agreement whose venue
// side is the org and an event owned by a person is a booking nobody can
// administer as a unit. So this module answers the question once and
// {@link prepareBookingAcceptMint} (accept-mint.ts) and FR-001's agreement mint
// both read the same answer.
//
// TWO DERIVATIONS EXIST SIDE BY SIDE UNTIL FR-001 LANDS. `deriveCounterparty`
// (`accept-in-tx.ts`) is the one `respondToBookingRequest` and
// `confirmBookingHold` call today and is NOT touched by this change: retiring
// it belongs to FR-001, which is the change that removes its callers. This one
// is stricter in exactly one way — see "WHAT THIS ADDS" below — and the two
// agree on every well-formed input, which
// `venue-booking-party.test.ts` pins case by case so they cannot drift apart
// while both exist.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The venue side of a booking: the party whose name the Agreement is in and
 * whose Event the accept mints.
 *
 * THE RULE, in order. `ownership` is the result the caller already got from
 * `requirePlaceBookingAuthority` / `requirePlaceOwnership` for THIS place —
 * taken as an input rather than re-derived, so the gate that let the actor in
 * and the party we mint under cannot disagree about how they got in.
 *
 *  1. The actor came in through an ORG MEMBERSHIP → that org. (FR-006 rule 1
 *     for the "member" half.)
 *  2. The actor is a DIRECT HUMAN OWNER of the place → the actor. Not the
 *     smallest owner id: on a co-owned place co-owner B must get B, or B's
 *     accept mints under A and B's own later edit fails `NOT_RESOURCE_OWNER`
 *     (spec, "Verified facts this spec is built on").
 *  3. (Retired, holds-without-a-request FR-002: the GRANTEE rules. A grantee
 *     no longer passes the staff gate, so it never reaches a venue-side
 *     accept or mint.)
 *  4. Anything else → `NOT_RESOURCE_OWNER`.
 *
 * WHY 1 AND 2 ARE IN THAT ORDER, and not FR-006's literal "the place is
 * org-owned → the org, regardless". A place can be owned by an org AND by
 * people. For such a place `resolvePlaceOwnership` (`place-access.ts`) checks
 * `humanIdsWithAccess` FIRST and returns `via: "human"` without ever looking
 * up an org membership — so for a direct human owner we do not know the actor
 * holds any role in the owning org. Minting that event under the org would
 * hand a person's booking to an organisation they may not be a member of, and
 * they would then fail `NOT_RESOURCE_OWNER` editing the event they just
 * created: the co-owner failure mode of rule 2, one level up. FR-006's own
 * parenthetical scopes rule 1 to "(member or grantee)", and a direct owner is
 * neither, so rule 1 IS FR-006 rule 1 — read that way there is no
 * divergence. It also matches `deriveCounterparty`, whose docblock relies on
 * the same ordering for the same reason.
 *
 * WHAT THIS ADDS over `deriveCounterparty`: every branch is CHECKED against the
 * place record, never inferred from `via` alone. FR-006's complaint about the
 * old derivation is that it "is a fallback, not a check" — it returns the actor
 * on `via !== "org"` without re-verifying they own anything, and returns
 * `ownership.orgId` without re-verifying that org owns the place. Here rule 1
 * requires `orgId ∈ place.orgIdsWithAccess` and rule 2 requires
 * `actorHumanId ∈ place.humanIdsWithAccess`. An `ownership` the place record
 * does not corroborate falls to rule 4 rather than minting under an
 * unverified party.
 *
 * THE INVARIANT THAT BUYS: the party returned is ALWAYS on one of the place's
 * access lists. The accept mint's attach gate therefore reduces to the place's
 * liveness, and the save can never take the THIRD-PARTY arm — which would
 * create a `BookingRequest` inside the caller's transaction (see
 * `FinalizeSaveEventInCallerTxParams`, lock-order note 4).
 *
 * Ownership here means `PlaceOwnership` rows that are `verified` and not
 * revoked — that is what the places adapter puts in these arrays. A
 * `PlaceBookingGrant` contributes to NEITHER list, which is what makes "the
 * actor is a grantee" and "the actor is an owner" decidable apart.
 *
 * @throws `{ code: "NOT_RESOURCE_OWNER" }` when no party can be derived.
 */
export function deriveVenueBookingParty(
  ownership: Pick<PlaceBookingAuthorityResult, "via" | "orgId">,
  place: Pick<PlaceRecord, "id" | "orgIdsWithAccess" | "humanIdsWithAccess">,
  actorHumanId: string,
): BookingAgreementCounterparty {
  if (
    ownership.via === "org" &&
    ownership.orgId &&
    place.orgIdsWithAccess.includes(ownership.orgId)
  ) {
    return { type: "organization", id: ownership.orgId };
  }

  if (place.humanIdsWithAccess.includes(actorHumanId)) {
    return { type: "human", id: actorHumanId };
  }

  throw fail("NOT_RESOURCE_OWNER", {
    meta: {
      entity: "place",
      reason: "no_venue_booking_party",
      placeId: place.id,
      via: ownership.via,
    },
  });
}

/**
 * The same party, in the shape the event save takes its owner in. Two
 * vocabularies for one fact (`{type: "organization"}` on the agreement,
 * `{kind: "org"}` on the save), converted in one place so a caller cannot
 * hand the agreement one party and the save another.
 */
export function ownerContextForVenueBookingParty(
  party: BookingAgreementCounterparty,
): OwnerContext {
  return party.type === "organization"
    ? { kind: "org", orgId: party.id }
    : { kind: "human", humanId: party.id };
}
