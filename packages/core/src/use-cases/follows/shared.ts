import type { AuthZPort } from "@th/ports/authz";
import type { Repos } from "@th/ports/repos";
import type { EntityPageRecord } from "@th/ports/repos/entity-pages";

import { ORG_EDIT_ROLES } from "../../lib/rbac";
import { fail } from "@th/errors";

const PLATFORM_STAFF_ROLES = [
  "ADMIN",
  "REVIEWER",
  "SUPPORT",
  "DEVELOPER",
] as const;

export async function getEntityPageOrThrow(
  repos: Pick<Repos, "entityPages">,
  entityPageId: string,
): Promise<EntityPageRecord> {
  const page = await repos.entityPages.getById(entityPageId);
  if (!page) {
    throw fail("PAGE_NOT_FOUND");
  }
  return page;
}

export async function getPublicEntityPageOrThrow(
  repos: Pick<Repos, "entityPages">,
  entityPageId: string,
): Promise<EntityPageRecord> {
  const page = await getEntityPageOrThrow(repos, entityPageId);
  if (page.visibility !== "PUBLIC") {
    throw fail("PAGE_NOT_FOUND");
  }
  return page;
}

export async function ensureCanManageEntityPage(
  authz: Pick<AuthZPort, "requireOrgRole" | "canManagePlace">,
  actorHumanId: string,
  page: EntityPageRecord,
): Promise<void> {
  switch (page.ownerType) {
    case "HUMAN": {
      if (page.ownerId !== actorHumanId) {
        throw fail("NOT_RESOURCE_OWNER", { meta: { entity: "page" } });
      }
      return;
    }
    case "ORGANIZATION": {
      await authz.requireOrgRole({
        actorHumanId,
        orgId: page.ownerId,
        requiredRoles: [...ORG_EDIT_ROLES],
      });
      return;
    }
    case "PLACE": {
      const result = await authz.canManagePlace({
        actorHumanId,
        placeId: page.ownerId,
      });
      if (!result.allowed) {
        throw fail("NOT_RESOURCE_OWNER", { meta: { entity: "place" } });
      }
      return;
    }
    default:
      throw fail("UNKNOWN_OWNER_TYPE");
  }
}

export async function ensureCanViewFollowerStats(
  authz: Pick<AuthZPort, "requireOrgRole" | "canManagePlace" | "hasStaffRole">,
  actorHumanId: string,
  page: EntityPageRecord,
): Promise<void> {
  const staff = await authz.hasStaffRole({
    actorHumanId,
    requiredRoles: [...PLATFORM_STAFF_ROLES],
  });

  if (staff.allowed) {
    return;
  }

  await ensureCanManageEntityPage(authz, actorHumanId, page);
}
