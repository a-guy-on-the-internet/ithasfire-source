import type { AuthZPort } from "@th/ports/authz";
import type { Repos } from "@th/ports/repos";
import type { PlaceRecord } from "@th/ports/repos/places";

import { placeWithholdsAddress } from "../../../lib/location/redact-place-location";
import { ORG_EDIT_ROLES } from "../../../lib/rbac";

/**
 * WHO MAY SEE A WITHHELD VENUE'S REAL ADDRESS ON A MANAGEMENT SURFACE
 * (place-address-withholding D5).
 *
 * THE BAR IS `authz.canManagePlace` — a verified direct owner, or
 * OWNER/ADMIN/EDITOR in an owning org — and never "any membership". Commit
 * 493751b4 set that bar on `getPlaceForEdit` because a door SCANNER, a VIEWER
 * or a FINANCE member of the org could otherwise pull the street address and
 * coordinates of every venue the org owns, and for many of these venues that
 * address is somebody's home. The list/search/builder surfaces reopened the
 * same class by unlocking on membership alone; they now ask this instead.
 *
 * Only WITHHELD places are asked about: an EXACT place's address is public,
 * so there is nothing to unlock. The final word is always `canManagePlace` —
 * the rule lives in the authz adapter and is not re-implemented here. What
 * this adds is the batching a list needs: ONE membership read over the page
 * picks the candidates, so a SCANNER looking at fifty withheld venues costs
 * one query and zero probes. The pre-filter can only DROP a place (it is a
 * superset of the rule: verified direct owner, or an edit-level membership in
 * an owning org), so its worst failure mode is over-redaction, never a leak.
 *
 * Probes run in small parallel chunks — each is a place lookup plus a
 * membership read per owning org, on the request path. A probe that throws
 * fails the read; nothing here swallows (so there is no fallback to report).
 */

type UnlockCandidate = Pick<
  PlaceRecord,
  "id" | "orgIdsWithAccess" | "humanIdsWithAccess"
> & {
  locationMode?: PlaceRecord["locationMode"] | string | null;
};

const PROBE_CONCURRENCY = 5;

export type PlaceAddressUnlockDeps = {
  repos: Pick<Repos, "authz">;
  authz: Pick<AuthZPort, "canManagePlace">;
};

/**
 * The ids of `places` whose real address `actorHumanId` may see. Never
 * contains an EXACT place (callers render those exact regardless).
 */
export async function resolvePlaceAddressUnlocks(
  deps: PlaceAddressUnlockDeps,
  actorHumanId: string,
  places: readonly UnlockCandidate[],
): Promise<Set<string>> {
  const withheld = places.filter((place) => placeWithholdsAddress(place));
  if (withheld.length === 0) return new Set();

  const orgIds = [
    ...new Set(withheld.flatMap((place) => place.orgIdsWithAccess ?? [])),
  ];
  const editOrgIds = new Set(
    orgIds.length > 0
      ? (
          await deps.repos.authz.getOrgMemberships({
            orgIds,
            humanId: actorHumanId,
          })
        )
          .filter((membership) => ORG_EDIT_ROLES.includes(membership.role))
          .map((membership) => membership.orgId)
      : [],
  );

  const candidates = [
    ...new Map(
      withheld
        .filter(
          (place) =>
            (place.humanIdsWithAccess ?? []).includes(actorHumanId) ||
            (place.orgIdsWithAccess ?? []).some((orgId) => editOrgIds.has(orgId)),
        )
        .map((place) => [place.id, place] as const),
    ).values(),
  ];

  const unlocked = new Set<string>();
  for (let i = 0; i < candidates.length; i += PROBE_CONCURRENCY) {
    const chunk = candidates.slice(i, i + PROBE_CONCURRENCY);
    const results = await Promise.all(
      chunk.map((place) =>
        deps.authz.canManagePlace({ actorHumanId, placeId: place.id }),
      ),
    );
    results.forEach((result, index) => {
      if (result.allowed) unlocked.add(chunk[index]!.id);
    });
  }
  return unlocked;
}
