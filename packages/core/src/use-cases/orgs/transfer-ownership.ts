import { z } from "zod";

import { authZRoleSchema, type AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

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

export const transferOrgOwnershipInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    orgId: z.string().uuid(),
    targetHumanId: z.string().uuid(),
  })
  .strict();

export const transferOrgOwnershipOutputSchema = z
  .object({
    ok: z.literal(true),
    /** The role the new owner held before the transfer. */
    previousTargetRole: authZRoleSchema,
  })
  .strict();

export type TransferOrgOwnershipInput = z.infer<
  typeof transferOrgOwnershipInputSchema
>;
export type TransferOrgOwnershipOutput = z.infer<
  typeof transferOrgOwnershipOutputSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Deps
// ─────────────────────────────────────────────────────────────────────────────

export type TransferOrgOwnershipDeps = {
  repos: Repos;
  authz: AuthZPort;
  clock: ClockPort;
  logger?: LoggerPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Hands the org to another member: the target becomes OWNER and the actor
 * becomes ADMIN, in one transaction, so the org never sits between the two
 * role changes. Only an OWNER may transfer.
 *
 * Writes what two `updateMemberRole` calls would: one `org.member_role_updated`
 * audit row per role that changed, each also carrying
 * `reason: "OWNERSHIP_TRANSFER"` and both parties' ids, and the actor's
 * pending OWNER invitations are revoked because the actor stops being OWNER.
 * A target who is already OWNER keeps the role; the actor is still demoted.
 */
export async function transferOrgOwnership(
  deps: TransferOrgOwnershipDeps,
  rawInput: unknown,
): Promise<TransferOrgOwnershipOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "transferOrgOwnership" });

  const input = parseInput(transferOrgOwnershipInputSchema, rawInput);

  if (input.targetHumanId === input.actorHumanId) {
    throw fail("INVALID_INPUT", {
      message: "Ownership cannot be transferred to yourself.",
    });
  }

  // Early refusal for anyone outside the org's admins, before the lock. The
  // OWNER check that decides is the one inside the transaction.
  await deps.authz.requireOrgRole({
    actorHumanId: input.actorHumanId,
    orgId: input.orgId,
    requiredRoles: [...ORG_ADMIN_ROLES],
  });

  const result = await deps.repos.tx(async (tx) => {
    // Serializes owner changes in this org: taken before any row is read, so
    // the roles below are what the previous one committed.
    await tx.organizations.lockOwnerRoster(input.orgId);

    await requireOrgMembership({
      repos: tx,
      orgId: input.orgId,
      actorHumanId: input.actorHumanId,
      roles: ORG_OWNER_ONLY,
    });

    const target = await tx.authz.getOrgMembership({
      orgId: input.orgId,
      humanId: input.targetHumanId,
    });

    if (!target) {
      throw fail("MEMBER_NOT_FOUND");
    }

    const now = deps.clock.now();
    const transfer = {
      reason: "OWNERSHIP_TRANSFER",
      transferFromHumanId: input.actorHumanId,
      transferToHumanId: input.targetHumanId,
    };

    // The target first, so the org has an OWNER at every step.
    if (target.role !== "OWNER") {
      await tx.organizations.addMember({
        orgId: input.orgId,
        humanId: input.targetHumanId,
        role: "OWNER",
        addedAt: now,
      });

      await tx.audit.log({
        entity: "organization",
        entityId: input.orgId,
        action: "org.member_role_updated",
        data: {
          actorHumanId: input.actorHumanId,
          targetHumanId: input.targetHumanId,
          previousRole: target.role,
          newRole: "OWNER",
          ...transfer,
        },
        at: now,
      });
    }

    await tx.organizations.addMember({
      orgId: input.orgId,
      humanId: input.actorHumanId,
      role: "ADMIN",
      addedAt: now,
    });

    // The actor stops being OWNER and takes their pending OWNER invitations
    // with them.
    await revokeOwnerInvitationsSentBy(tx, {
      orgId: input.orgId,
      inviterHumanId: input.actorHumanId,
      actorHumanId: input.actorHumanId,
      at: now,
    });

    await tx.audit.log({
      entity: "organization",
      entityId: input.orgId,
      action: "org.member_role_updated",
      data: {
        actorHumanId: input.actorHumanId,
        targetHumanId: input.actorHumanId,
        previousRole: "OWNER",
        newRole: "ADMIN",
        ...transfer,
      },
      at: now,
    });

    return { previousTargetRole: target.role };
  });

  scopedLogger?.info("transferOrgOwnership.completed", {
    orgId: input.orgId,
    actorHumanId: input.actorHumanId,
    targetHumanId: input.targetHumanId,
    previousTargetRole: result.previousTargetRole,
  });

  return transferOrgOwnershipOutputSchema.parse({
    ok: true,
    previousTargetRole: result.previousTargetRole,
  });
}
