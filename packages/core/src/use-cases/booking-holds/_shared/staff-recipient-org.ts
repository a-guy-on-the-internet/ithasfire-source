import type { AuthZRepo } from "@th/ports/repos/authz";
import type { PlaceRecord } from "@th/ports/repos/places";

/**
 * FR-016 routing: the org a staff intent is addressed to when the caller
 * has no `PlaceOwnershipResult` in hand (the event paths, the transport's
 * hint fallback). Same resolution order as `staffRecipientHintFor`: the org
 * the ACTOR's access came through (their membership among the owning orgs),
 * else the first owning org, else null (a directly human-owned venue). One
 * membership read, and only when there is more than one owning org to pick
 * between.
 */
export async function resolveStaffRecipientOrgId(
  authz: Pick<AuthZRepo, "getOrgMemberships">,
  place: Pick<PlaceRecord, "orgIdsWithAccess">,
  actorHumanId: string,
): Promise<string | null> {
  const owningOrgIds = place.orgIdsWithAccess;
  if (owningOrgIds.length <= 1) return owningOrgIds[0] ?? null;
  const memberships = await authz.getOrgMemberships({
    orgIds: [...owningOrgIds],
    humanId: actorHumanId,
  });
  return (
    owningOrgIds.find((id) => memberships.some((m) => m.orgId === id)) ??
    owningOrgIds[0] ??
    null
  );
}
