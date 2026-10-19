import type { Repos } from "@th/ports/repos";
import { fail } from "@th/errors";
import { ORG_EDIT_ROLES } from "../../../lib/rbac";

/**
 * Owner/staff gate for place-scoped management operations (spaces, calendars,
 * availability). Same access rule as the sibling `place-waivers` module: the
 * actor must either hold an edit role in an org that owns the place, or be a
 * verified direct human owner.
 *
 * Throws `PLACE_NOT_FOUND` when the place does not exist and
 * `NOT_RESOURCE_OWNER` when the actor has no edit access.
 */
export async function ensurePlaceOwnerAccess(
  repos: Repos,
  placeId: string,
  actorHumanId: string,
): Promise<void> {
  const ctx = await repos.authz.getPlaceAccessContext(placeId);
  if (!ctx) {
    throw fail("PLACE_NOT_FOUND");
  }

  // Check org membership for any owning org.
  for (const orgId of ctx.owningOrgIds) {
    const membership = await repos.authz.getOrgMembership({
      orgId,
      humanId: actorHumanId,
    });
    if (
      membership &&
      (ORG_EDIT_ROLES as readonly string[]).includes(membership.role)
    ) {
      return;
    }
  }

  // Check direct human ownership.
  if (ctx.verifiedHumanOwnerIds.includes(actorHumanId)) {
    return;
  }

  throw fail("NOT_RESOURCE_OWNER", { meta: { entity: "place" } });
}
