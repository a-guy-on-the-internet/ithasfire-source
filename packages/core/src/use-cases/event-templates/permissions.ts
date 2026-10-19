import type { LoggerPort } from "@th/ports/logger";
import type { OrgRole } from "@th/ports/repos/authz";
import type { TxRepos } from "@th/ports/repos";
import type { TemplateOwnerScope } from "@th/types";
import { ORG_EDIT_ROLES, ORG_ANY_ROLE } from "../../lib/rbac";
import { fail } from "@th/errors";
import { actorHoldsEventEditRole } from "../../lib/event-edit-rights";

const DEFAULT_EDIT_ROLES: ReadonlySet<OrgRole> = new Set(ORG_EDIT_ROLES);
const DEFAULT_VIEW_ROLES: ReadonlySet<OrgRole> = new Set(
  ORG_ANY_ROLE.filter((r) => r !== "SCANNER"),
);

export type TemplateOwnerContext =
  | { kind: "human"; humanId: string }
  | { kind: "org"; orgId: string; role: OrgRole };

export type EnsureTemplateAccessOptions = {
  allowedOrgRoles?: ReadonlySet<OrgRole>;
  purpose?: "edit" | "view";
};

export async function ensureTemplateOwnerAccess(
  repos: TxRepos,
  ownerScope: TemplateOwnerScope,
  ownerId: string,
  actorHumanId: string,
  { allowedOrgRoles, purpose }: EnsureTemplateAccessOptions = {},
  logger?: LoggerPort,
): Promise<TemplateOwnerContext> {
  if (ownerScope === "HUMAN") {
    const human = await repos.humans.getById(ownerId);
    if (!human) {
      throw fail("HUMAN_NOT_FOUND", { meta: { role: "template_owner" } });
    }
    // The owner, or a delegate of the owner holding the role an org member
    // would need for the same purpose (owner ruling 2026-09-28) — the
    // template library behind the principal's event builder.
    const humanAllowed =
      ownerId === actorHumanId ||
      (await actorHoldsEventEditRole(
        repos.authz,
        { orgId: null, humanId: ownerId },
        actorHumanId,
        [
          ...(allowedOrgRoles ??
            (purpose === "view" ? DEFAULT_VIEW_ROLES : DEFAULT_EDIT_ROLES)),
        ],
      ));
    if (!humanAllowed) {
      logger?.warn("template_access_denied", {
        reason: "human_scope_mismatch",
        ownerId,
        actorHumanId,
        purpose: purpose ?? "edit",
      });
      throw fail("NOT_RESOURCE_OWNER", { meta: { entity: "template" } });
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
      logger?.warn("template_access_denied", {
        reason: "missing_membership",
        ownerId,
        actorHumanId,
        purpose: purpose ?? "edit",
      });
      throw fail("INSUFFICIENT_ROLE");
    }

    const allowedRoles =
      allowedOrgRoles ??
      (purpose === "view" ? DEFAULT_VIEW_ROLES : DEFAULT_EDIT_ROLES);
    if (!allowedRoles.has(membership.role)) {
      logger?.warn("template_access_denied", {
        reason: "insufficient_role",
        membershipRole: membership.role,
        ownerId,
        actorHumanId,
        purpose: purpose ?? "edit",
      });
      throw fail("INSUFFICIENT_ROLE");
    }

    return { kind: "org", orgId: ownerId, role: membership.role };
  }

  throw fail("UNKNOWN_OWNER_SCOPE");
}
