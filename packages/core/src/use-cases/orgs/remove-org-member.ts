import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
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
import { incrementResourceUsage } from "../quotas/enforce-quota";
import { revokeOwnerInvitationsSentBy } from "./revoke-invitation";
import { fail } from "@th/errors";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const removeOrgMemberInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    orgId: z.string().uuid(),
    targetHumanId: z.string().uuid(),
  })
  .strict();

export const removeOrgMemberOutputSchema = z
  .object({
    ok: z.literal(true),
  })
  .strict();

export type RemoveOrgMemberInput = z.infer<typeof removeOrgMemberInputSchema>;
export type RemoveOrgMemberOutput = z.infer<typeof removeOrgMemberOutputSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Deps
// ─────────────────────────────────────────────────────────────────────────────

export type RemoveOrgMemberDeps = {
  repos: Repos;
  authz: AuthZPort;
  clock: ClockPort;
  logger?: LoggerPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

const REQUIRED_ACTOR_ROLES = ORG_ADMIN_ROLES;

export async function removeOrgMember(
  deps: RemoveOrgMemberDeps,
  rawInput: unknown,
): Promise<RemoveOrgMemberOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "removeOrgMember" });

  const input = parseInput(removeOrgMemberInputSchema, rawInput);

  await deps.authz.requireOrgRole({
    actorHumanId: input.actorHumanId,
    orgId: input.orgId,
    requiredRoles: [...REQUIRED_ACTOR_ROLES],
  });

  // One transaction: check who may remove the target, keep the last OWNER,
  // delete the membership, revoke an OWNER's pending OWNER invitations, write
  // the audit rows and give back the quota slots.
  await deps.repos.tx(async (tx) => {
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

    const membership = await tx.authz.getOrgMembership({
      orgId: input.orgId,
      humanId: input.targetHumanId,
    });

    if (!membership) {
      throw fail("MEMBER_NOT_FOUND");
    }

    if (membership.role === "OWNER") {
      // Removing an OWNER takes an OWNER.
      if (!ORG_OWNER_ONLY.includes(actor.role)) {
        throw fail("INSUFFICIENT_ROLE");
      }

      const ownerCount = await tx.organizations.countMembersByRole({
        orgId: input.orgId,
        role: "OWNER",
      });
      if (ownerCount <= 1) {
        throw fail("CANNOT_REMOVE_LAST_OWNER");
      }
    }

    const removed = await tx.organizations.removeMember({
      orgId: input.orgId,
      humanId: input.targetHumanId,
    });

    if (!removed) {
      throw fail("MEMBER_NOT_FOUND");
    }

    const now = deps.clock.now();

    // A removed OWNER takes their pending OWNER invitations with them.
    if (membership.role === "OWNER") {
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
      action: "org.member_removed",
      data: {
        actorHumanId: input.actorHumanId,
        targetHumanId: input.targetHumanId,
        role: membership.role,
      },
      at: now,
    });

    // Reclaim quota slots for the removed membership.
    await incrementResourceUsage(tx, {
      subjectType: "ORG",
      subjectId: input.orgId,
      kind: "MEMBERS_PER_ORG",
      delta: -1n,
    });
    await incrementResourceUsage(tx, {
      subjectType: "HUMAN",
      subjectId: input.targetHumanId,
      kind: "ORGS_JOINED",
      delta: -1n,
    });
  });

  scopedLogger?.info("removeOrgMember.completed", {
    orgId: input.orgId,
    targetHumanId: input.targetHumanId,
  });

  return removeOrgMemberOutputSchema.parse({ ok: true });
}
