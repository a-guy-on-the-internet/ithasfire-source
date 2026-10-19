import type { LoggerPort } from "@th/ports/logger";
import type { OrgRole } from "@th/ports/repos/authz";
import type { TxRepos } from "@th/ports/repos";
import type { EventSeriesOwnerScope } from "@th/types";
import { actorHoldsEventEditRole } from "../../lib/event-edit-rights";
import { ORG_EDIT_ROLES, ORG_ANY_ROLE } from "../../lib/rbac";
import { fail } from "@th/errors";

const EDIT_ROLES: ReadonlySet<OrgRole> = new Set(ORG_EDIT_ROLES);
const VIEW_ROLES: ReadonlySet<OrgRole> = new Set(
  ORG_ANY_ROLE.filter((r) => r !== "SCANNER"),
);

export type SeriesOwnerContext =
  | { kind: "human"; humanId: string }
  | { kind: "org"; orgId: string; role: OrgRole };

export type EnsureSeriesAccessOptions = {
  purpose?: "edit" | "view";
  allowedOrgRoles?: ReadonlySet<OrgRole>;
};

export async function ensureSeriesOwnerAccess(
  repos: TxRepos,
  ownerScope: EventSeriesOwnerScope,
  ownerId: string,
  actorHumanId: string,
  { purpose = "edit", allowedOrgRoles }: EnsureSeriesAccessOptions = {},
  logger?: LoggerPort,
): Promise<SeriesOwnerContext> {
  if (ownerScope === "HUMAN") {
    const human = await repos.humans.getById(ownerId);
    if (!human) {
      throw fail("HUMAN_NOT_FOUND", { meta: { role: "series_owner" } });
    }
    // The owner, or a delegate of the owner holding the role an org member
    // would need for the same purpose (owner ruling 2026-09-28): builder
    // series save / convertEventToSeries / runScopedDraftSync work for an
    // edit-role delegate exactly as they do for the principal.
    const humanAllowed =
      ownerId === actorHumanId ||
      (await actorHoldsEventEditRole(
        repos.authz,
        { orgId: null, humanId: ownerId },
        actorHumanId,
        [...(allowedOrgRoles ?? (purpose === "view" ? VIEW_ROLES : EDIT_ROLES))],
      ));
    if (!humanAllowed) {
      logger?.warn("series_access_denied", {
        reason: "human_scope_mismatch",
        ownerId,
        actorHumanId,
        purpose,
      });
      throw fail("NOT_RESOURCE_OWNER", { meta: { entity: "series" } });
    }
    return { kind: "human", humanId: ownerId };
  }

  if (ownerScope === "ORGANIZATION") {
    const organization = await repos.organizations.getById(ownerId);
    if (!organization) {
      throw fail("ORGANIZATION_NOT_FOUND");
    }

    const membership = await repos.authz.getOrgMembership({
      orgId: ownerId,
      humanId: actorHumanId,
    });
    if (!membership) {
      logger?.warn("series_access_denied", {
        reason: "missing_membership",
        ownerId,
        actorHumanId,
        purpose,
      });
      throw fail("INSUFFICIENT_ROLE");
    }

    const allowedRoles =
      allowedOrgRoles ?? (purpose === "view" ? VIEW_ROLES : EDIT_ROLES);
    if (!allowedRoles.has(membership.role)) {
      logger?.warn("series_access_denied", {
        reason: "insufficient_role",
        ownerId,
        actorHumanId,
        membershipRole: membership.role,
        purpose,
      });
      throw fail("INSUFFICIENT_ROLE");
    }

    return { kind: "org", orgId: ownerId, role: membership.role };
  }

  logger?.error("series_access_denied", {
    reason: "unknown_owner_scope",
    ownerScope,
    ownerId,
    actorHumanId,
    purpose,
  });
  throw fail("UNKNOWN_OWNER_SCOPE");
}
