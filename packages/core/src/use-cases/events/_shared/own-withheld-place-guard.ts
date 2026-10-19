import type { AuthZPort } from "@th/ports/authz";
import type { Repos } from "@th/ports/repos";
import { fail } from "@th/errors";

import { haversineDistance } from "../../../lib/geo/haversine";
import { ORG_EDIT_ROLES } from "../../../lib/rbac";
import { actorManagesPlace } from "./venue-manager-stamp";

/**
 * A FREEFORM ADDRESS THAT IS YOUR OWN WITHHELD PLACE (place-address-
 * withholding N2, 2026-09-25).
 *
 * A house that withholds its address draws ONE public circle: the place's.
 * An event typed as a freeform address draws its OWN circle, keyed by its
 * owner and true point (`eventCircleSubject`). So a house owner who types
 * their home address into an event instead of picking their venue publishes a
 * second, independently-drawn circle around the same house, and two circles
 * intersect to a much smaller area than either.
 *
 * The builder makes the location kind an explicit choice (an "Address" /
 * "My Places" toggle), so silently re-linking the event to the place would
 * change what the organizer chose — and with it the event's venue-page
 * listing, calendar and booking cascade. The save REFUSES instead, with
 * `EVENT_ADDRESS_IS_OWN_WITHHELD_PLACE` naming the place, and the builder
 * offers the place.
 *
 * WHO IS REFUSED: only an actor who can MANAGE a withheld place within
 * {@link OWN_WITHHELD_PLACE_RADIUS_M} of the point (`canManagePlace`, the
 * final word). The candidate lookup is OWNER-SCOPED in SQL
 * (`listWithheldOwnedNearPoint`): only places the actor owns directly or
 * through an org where they hold an edit role are ever read, so for anyone
 * else the answer — and the time it takes — carries nothing about a stranger's
 * house. Someone else typing the same address is the accepted cross-owner
 * residual, as is a pin that drifts more than the radius.
 */
export const OWN_WITHHELD_PLACE_RADIUS_M = 50;

export type OwnWithheldPlaceGuardDeps = {
  repos: Pick<Repos, "authz" | "places">;
  authz: Pick<AuthZPort, "canManagePlace">;
};

/**
 * Throws `EVENT_ADDRESS_IS_OWN_WITHHELD_PLACE` when `point` lies within
 * {@link OWN_WITHHELD_PLACE_RADIUS_M} of a withheld place `actorHumanId`
 * manages. A point without finite coordinates is not checked (there is no
 * circle to draw).
 */
export async function ensureAddressIsNotOwnWithheldPlace(
  deps: OwnWithheldPlaceGuardDeps,
  args: {
    actorHumanId: string;
    point: { lat: number | null | undefined; lng: number | null | undefined };
  },
): Promise<void> {
  const { lat, lng } = args.point;
  if (
    typeof lat !== "number" ||
    typeof lng !== "number" ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lng)
  ) {
    return;
  }

  // The orgs whose places the actor could manage: edit-level memberships
  // only (the pre-filter can only DROP a place; `canManagePlace` decides).
  const memberships = await deps.repos.authz.listOrgMembershipsByHumanId({
    humanId: args.actorHumanId,
    roles: [...ORG_EDIT_ROLES],
  });
  const orgIds = memberships
    .filter((membership) => ORG_EDIT_ROLES.includes(membership.role))
    .map((membership) => membership.orgId);

  const candidates = await deps.repos.places.listWithheldOwnedNearPoint({
    humanId: args.actorHumanId,
    orgIds,
    lat,
    lng,
    withinMeters: OWN_WITHHELD_PLACE_RADIUS_M,
  });

  for (const place of candidates) {
    if (
      typeof place.lat !== "number" ||
      typeof place.lng !== "number" ||
      haversineDistance(lat, lng, place.lat, place.lng) >
        OWN_WITHHELD_PLACE_RADIUS_M
    ) {
      continue;
    }
    if (
      !(await actorManagesPlace(deps.authz, {
        actorHumanId: args.actorHumanId,
        placeId: place.id,
      }))
    ) {
      continue;
    }
    throw fail("EVENT_ADDRESS_IS_OWN_WITHHELD_PLACE", {
      // Only ever a place this actor manages, so naming it discloses
      // nothing they cannot already see.
      meta: { placeId: place.id, placeName: place.name },
    });
  }
}
