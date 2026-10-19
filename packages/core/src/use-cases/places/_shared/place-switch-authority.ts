import type { OrgMembership } from "@th/ports/repos/authz";
import type { Repos } from "@th/ports/repos";
import { fail } from "@th/errors";

import { ORG_ADMIN_ROLES } from "../../../lib/rbac";

/**
 * The slice of a place record the switch bar reads. Structural on purpose so
 * a `PlaceRecord`, a projection, or a test fixture all satisfy it.
 */
export type PlaceSwitchSubject = {
  humanIdsWithAccess: readonly string[];
  orgIdsWithAccess: readonly string[];
};

export type PlaceSwitchAuthorityDeps = {
  repos: Pick<Repos, "authz">;
};

/**
 * THE write bar for the four place switches — `acceptsBookingRequests`,
 * `acceptsCommunityListings`, `attendeeReviewsPublic`,
 * `communityReviewsEnabled`. It lives here, once, because those use cases are
 * deliberate twins and one more hand-written copy (the read that renders
 * them) is how twins drift apart.
 *
 * The rule: a direct human owner of the place, or OWNER/ADMIN in ANY owning
 * org. EDITOR, VIEWER, FINANCE and SCANNER are all deliberately excluded —
 * each switch is a statement about what the business takes on or publishes,
 * not content work, so it sits at the same bar as org settings.
 *
 * `requireOrgMembership` is not usable for this: it takes ONE orgId, while a
 * place can be owned by several orgs and an admin of ANY of them qualifies.
 * Hence a plural lookup plus a role filter on the result — `getOrgMemberships`
 * applies no role filter of its own.
 *
 * Callers:
 *  - `setPlaceBookingAcceptance`, `setPlaceCommunityListingAcceptance`,
 *    `setPlaceAttendeeReviewsPublic`, `setPlaceCommunityReviewsEnabled` — via
 *    {@link requirePlaceSwitchAuthority}.
 *  - `getPlaceForEdit` — via {@link resolvePlaceSwitchAuthority}, to publish
 *    the derived `viewerCanManageSwitches` capability. That read's OWN gate is
 *    still BROADER than this bar, but no longer "any membership": it is
 *    `canManagePlace` (OWNER/ADMIN/EDITOR), because the payload carries the
 *    venue's street address and exact coordinates and a SCANNER has no
 *    business with those. So an EDITOR loads the page and cannot flip
 *    anything; a VIEWER/SCANNER/FINANCE no longer loads it at all.
 */

/**
 * Pure form. Decides the bar from memberships the caller ALREADY has.
 *
 * `orgMemberships` MUST be the actor's memberships scoped to
 * `place.orgIdsWithAccess` (i.e. the result of
 * `getOrgMemberships({ orgIds: place.orgIdsWithAccess, humanId })`). Passing a
 * wider set would grant the bar off an org that does not own this place.
 * Ignored entirely when the actor is a direct human owner, so passing `[]`
 * alongside a direct owner is correct.
 */
export function placeSwitchAuthorityFromMemberships(
  place: PlaceSwitchSubject,
  actorHumanId: string,
  orgMemberships: readonly OrgMembership[],
): boolean {
  if (place.humanIdsWithAccess.includes(actorHumanId)) {
    return true;
  }
  return orgMemberships.some((m) => ORG_ADMIN_ROLES.includes(m.role));
}

/**
 * Async form for callers that hold no memberships yet. Short-circuits before
 * the lookup for a direct human owner, and before it again when the place has
 * no owning orgs — so the common owner path costs ZERO extra round-trips,
 * exactly as the three writes did when each carried its own copy.
 */
export async function resolvePlaceSwitchAuthority(
  deps: PlaceSwitchAuthorityDeps,
  place: PlaceSwitchSubject,
  actorHumanId: string,
): Promise<boolean> {
  if (place.humanIdsWithAccess.includes(actorHumanId)) {
    return true;
  }
  if (place.orgIdsWithAccess.length === 0) {
    return false;
  }

  const memberships = await deps.repos.authz.getOrgMemberships({
    orgIds: [...place.orgIdsWithAccess],
    humanId: actorHumanId,
  });

  return placeSwitchAuthorityFromMemberships(place, actorHumanId, memberships);
}

/**
 * Throwing form the four writes use. Fails with `NOT_RESOURCE_OWNER` carrying
 * `{ entity: "place" }` — the exact error the switches raised before this was
 * extracted, because the web toast dictionary keys off it.
 */
export async function requirePlaceSwitchAuthority(
  deps: PlaceSwitchAuthorityDeps,
  place: PlaceSwitchSubject,
  actorHumanId: string,
): Promise<void> {
  const allowed = await resolvePlaceSwitchAuthority(deps, place, actorHumanId);
  if (!allowed) {
    throw fail("NOT_RESOURCE_OWNER", { meta: { entity: "place" } });
  }
}
