import { z } from "zod";

import { authZRoleSchema, type AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { OrgRole } from "@th/ports/repos/authz";

import { parseInput } from "../../lib/io";
import {
  ORG_ADMIN_ROLES,
  ORG_OWNER_ONLY,
  requireOrgMembership,
} from "../../lib/rbac";
import { revokeOwnerInvitationsSentBy } from "./revoke-invitation";
import { fail } from "@th/errors";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const updateMemberRoleInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    orgId: z.string().uuid(),
    targetHumanId: z.string().uuid(),
    newRole: authZRoleSchema,
  })
  .strict();

export const updateMemberRoleOutputSchema = z
  .object({
    ok: z.literal(true),
    previousRole: authZRoleSchema,
  })
  .strict();

export type UpdateMemberRoleInput = z.infer<typeof updateMemberRoleInputSchema>;
export type UpdateMemberRoleOutput = z.infer<
  typeof updateMemberRoleOutputSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Deps
// ─────────────────────────────────────────────────────────────────────────────

export type UpdateMemberRoleDeps = {
  repos: Repos;
  authz: AuthZPort;
  clock: ClockPort;
  logger?: LoggerPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

const REQUIRED_ACTOR_ROLES = ORG_ADMIN_ROLES;

export async function updateMemberRole(
  deps: UpdateMemberRoleDeps,
  rawInput: unknown,
): Promise<UpdateMemberRoleOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "updateMemberRole" });

  const input = parseInput(updateMemberRoleInputSchema, rawInput);

  await deps.authz.requireOrgRole({
    actorHumanId: input.actorHumanId,
    orgId: input.orgId,
    requiredRoles: [...REQUIRED_ACTOR_ROLES],
  });

  const result = await deps.repos.tx(async (tx) => {
    // Serializes owner changes in this org: taken before any row is read, so
    // the roles and the owner count below are what the previous one committed.
    await tx.organizations.lockOwnerRoster(input.orgId);

    // The actor's role as this transaction sees it. The check above is only
    // an early refusal: the actor may have been demoted or removed since.
    const actor = await requireOrgMembership({
      repos: tx,
      orgId: input.orgId,
      actorHumanId: input.actorHumanId,
      roles: REQUIRED_ACTOR_ROLES,
    });

    const existing = await tx.authz.getOrgMembership({
      orgId: input.orgId,
      humanId: input.targetHumanId,
    });

    if (!existing) {
      throw fail("MEMBER_NOT_FOUND");
    }

    // Granting OWNER, or changing the role of a member who holds it, takes an
    // OWNER.
    if (
      (existing.role === "OWNER" || input.newRole === "OWNER") &&
      !ORG_OWNER_ONLY.includes(actor.role)
    ) {
      throw fail("INSUFFICIENT_ROLE");
    }

    if (existing.role === input.newRole) {
      return { previousRole: existing.role };
    }

    // Prevent demoting the last owner
    if (existing.role === "OWNER" && input.newRole !== "OWNER") {
      const ownerCount = await tx.organizations.countMembersByRole({
        orgId: input.orgId,
        role: "OWNER",
      });
      if (ownerCount <= 1) {
        throw fail("CANNOT_DEMOTE_LAST_OWNER");
      }
    }

    const now = deps.clock.now();

    await tx.organizations.addMember({
      orgId: input.orgId,
      humanId: input.targetHumanId,
      role: input.newRole,
      addedAt: now,
    });

    // A member who stops being OWNER takes their pending OWNER invitations
    // with them.
    if (existing.role === "OWNER") {
      await revokeOwnerInvitationsSentBy(tx, {
        orgId: input.orgId,
        inviterHumanId: input.targetHumanId,
        actorHumanId: input.actorHumanId,
        at: now,
      });
    }

    await tx.audit.log({
      entity: "organization",
      entityId: input.orgId,
      action: "org.member_role_updated",
      data: {
        actorHumanId: input.actorHumanId,
        targetHumanId: input.targetHumanId,
        previousRole: existing.role,
        newRole: input.newRole,
      },
      at: now,
    });

    return { previousRole: existing.role };
  });

  scopedLogger?.info("updateMemberRole.completed", {
    orgId: input.orgId,
    targetHumanId: input.targetHumanId,
    previousRole: result.previousRole,
    newRole: input.newRole,
  });

  return updateMemberRoleOutputSchema.parse({
    ok: true,
    previousRole: result.previousRole,
  });
}
