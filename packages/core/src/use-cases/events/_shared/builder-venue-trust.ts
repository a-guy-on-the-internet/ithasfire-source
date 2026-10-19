import type { Repos } from "@th/ports/repos";

import {
  isVenueOwnedEvent,
  type VenueConfirmationEventFields,
  type VenueConfirmationPlaceFields,
} from "../../../lib/venue-confirmation";
import type { PlaceAccessOwner } from "./place-access";

/**
 * The three venue-trust shapes a place-linked BUILDER save falls into
 * (venue-confirmation-and-booking-intents spec, docs/specs/2026-08-27):
 *
 *   · `venue_owned` — the event's owner (the org, or the human) is one of the
 *     place's owners. Confirmed by construction; nothing to do.
 *   · `grant`       — the event's owner (the org, or the person) IS the
 *     grantee of an active `PlaceBookingGrant` at the place (calendar scope
 *     honoured): the grantee's OWN event. Confirmed by construction too
 *     (holds-without-a-request FR-002 / FR-008), but stamped, because a
 *     grantee is not an owner.
 *   · `third_party` — anyone else. The save creates the booking request the
 *     venue confirms (when a calendar is named), and the builder shows the
 *     intent / calendar / space controls.
 *
 * ONE LAYER ON TOP, in both callers (place-address-withholding W1): a
 * `third_party` (or `grant`) save whose ACTOR can manage the place
 * (`authz.canManagePlace`) is the venue speaking — the save stamps the
 * confirmation and asks nobody (`venue-manager-stamp.ts`), and the read
 * reports `owner`. This classification stays about the event's OWNER; the
 * manager question is about the ACTOR, so it lives beside it, not in it.
 */
export type BuilderVenueTrust = "venue_owned" | "grant" | "third_party";

/**
 * The classification, with the grant a `grant` answer rests on: the save
 * records it on the stamp's audit row (`event.place_confirmed_by_grant`
 * `data.grantId`), so revoking that grant (FR-003) can find what it
 * confirmed.
 */
export type BuilderVenueTrustResult =
  | { trust: "grant"; grantId: string }
  | { trust: "venue_owned" | "third_party" };

export type ClassifyBuilderVenueTrustArgs = {
  /** The place the event is (or would be) at — already loaded by the caller. */
  place: VenueConfirmationPlaceFields & { id: string };
  /** The owner the event is (or would be) saved under. */
  owner: PlaceAccessOwner;
  /**
   * The persisted row's OWN owner columns, when the event already exists.
   * The save passes them (an update never rewrites `orgId` / `humanId`, so
   * the row — not `owner` — is what `isVenueOwnedEvent` must read, exactly
   * as before this helper existed). A read that runs before any row exists
   * omits it and the pair `owner` implies is used.
   */
  eventOwner?: Pick<VenueConfirmationEventFields, "orgId" | "humanId">;
  /**
   * The calendar the event is (or would be) placed on. Null = a place-level
   * question, which only a whole-place grant answers.
   */
  calendarId: string | null;
  now: Date;
};

/**
 * ONE classification for "is this owner a venue owner, a grant-holder, or a
 * third party at this place" — the rule `finalizeSaveEvent`
 * (`save-event-shared.ts`, `resolveBuilderVenueTrust`) applies at save time,
 * lifted onto an already-loaded place so a READ can answer the same question
 * BEFORE the save (the builder decides whether to show the third-party
 * controls from it: `getPlaceBookingOptions.viewer.authority`).
 *
 * Same inputs, same order, same primitives as the save: `isVenueOwnedEvent`
 * on the owner pair first; then the grant, matched on the OWNER as grantee —
 * the org for an org event, the person for a person's event (a delegate
 * saving the person's event acts under the person's grant, H2). Never on
 * the actor: an edit-role member of a grantee org saving an event owned by
 * someone else does not get it confirmed. The "an org has no grant" rule
 * ended with FR-002 (grants go to orgs or people, H2).
 *
 * ORG MEMBERSHIP IS NOT CHECKED HERE. The save's org wrapper
 * (`saveEventForOrg`) has already required an `ORG_EDIT_ROLES` membership
 * before this rule runs, which is also the edit-role bar an org grant needs
 * (H2); a read that offers an org as the owner must apply the same
 * membership gate itself before trusting a `venue_owned` or `grant` answer.
 *
 * `resolveBuilderVenueTrust` (save-event-shared) calls this after its own
 * `places.getById`; `getPlaceBookingOptions` calls it on the place it has
 * already loaded. There is no second copy of the rule.
 *
 * CALENDAR SCOPE: the two callers pass different `calendarId`s on purpose.
 * The save passes the event's calendar (a whole-place OR that-calendar grant
 * matches); the read passes null (whole-place grants only — it runs before
 * a calendar is picked). So a grantee scoped to one calendar reads as a
 * third party in the builder yet the save honours the grant. Safe direction
 * (the read never claims `grant` where the save says third party);
 * calendar-aware scoping of the read belongs to holds-without-a-request
 * FR-002 (docs/specs/2026-09-30/holds-without-a-request.spec.yaml).
 */
export async function classifyBuilderVenueTrust(
  repos: Pick<Repos, "placeBookingGrants">,
  args: ClassifyBuilderVenueTrustArgs,
): Promise<BuilderVenueTrustResult> {
  const ownerPair =
    args.eventOwner ??
    (args.owner.kind === "org"
      ? { orgId: args.owner.orgId, humanId: null }
      : { orgId: null, humanId: args.owner.humanId });
  if (isVenueOwnedEvent(ownerPair, args.place)) return { trust: "venue_owned" };
  // The owner as grantee: exactly one of the pair (an org event's org, else
  // a person's event's person). An ownerless row (COMMUNITY) has no grant.
  const grantee = ownerPair.orgId
    ? { humanIds: [], orgIds: [ownerPair.orgId] }
    : ownerPair.humanId
      ? { humanIds: [ownerPair.humanId], orgIds: [] }
      : null;
  if (grantee) {
    const grant = await repos.placeBookingGrants.findActiveForActor({
      placeId: args.place.id,
      calendarId: args.calendarId,
      ...grantee,
      now: args.now,
    });
    if (grant && grant.placeId === args.place.id) {
      return { trust: "grant", grantId: grant.id };
    }
  }
  return { trust: "third_party" };
}
