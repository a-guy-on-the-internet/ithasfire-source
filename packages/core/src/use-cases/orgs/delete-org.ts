import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { OrgRole } from "@th/ports/repos/authz";

import { parseInput } from "../../lib/io";
import { ORG_OWNER_ONLY, requireOrgMembership } from "../../lib/rbac";
import { incrementResourceUsage } from "../quotas/enforce-quota";
import { fail } from "@th/errors";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const deleteOrgInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    orgId: z.string().uuid(),
  })
  .strict();

export const deleteOrgOutputSchema = z
  .object({
    ok: z.literal(true),
    archivedMemberCount: z.number().int().nonnegative(),
  })
  .strict();

export type DeleteOrgInput = z.infer<typeof deleteOrgInputSchema>;
export type DeleteOrgOutput = z.infer<typeof deleteOrgOutputSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Deps
// ─────────────────────────────────────────────────────────────────────────────

export type DeleteOrgDeps = {
  repos: Repos;
  authz: AuthZPort;
  clock: ClockPort;
  logger?: LoggerPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

const REQUIRED_ACTOR_ROLE: OrgRole = "OWNER";

export async function deleteOrg(
  deps: DeleteOrgDeps,
  rawInput: unknown,
): Promise<DeleteOrgOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "deleteOrg" });

  const execute = async () => {
    const input = parseInput(deleteOrgInputSchema, rawInput);

    await deps.authz.requireOrgRole({
      actorHumanId: input.actorHumanId,
      orgId: input.orgId,
      requiredRoles: [REQUIRED_ACTOR_ROLE],
    });

    // Guard: org must exist and not already be archived.
    const org = await deps.repos.organizations.getById(input.orgId);
    if (!org) {
      throw fail("ORG_NOT_FOUND");
    }
    if (org.status === "ARCHIVED") {
      throw fail("ORG_ALREADY_ARCHIVED");
    }

    // Guard: no non-cancelled events may exist. Cancelling events is a
    // separate action so the organizer can review refund outcomes first.
    const activeEvents = await deps.repos.events.listByOwner({
      ownerType: "ORGANIZATION",
      ownerId: input.orgId,
      status: ["DRAFT", "PUBLISHED", "COMPLETED"],
      limit: 1,
      offset: 0,
    });
    if (activeEvents.items.length > 0) {
      throw fail("ORG_HAS_ACTIVE_EVENTS");
    }

    const now = deps.clock.now();

    const archivedMemberCount = await deps.repos.tx(async (tx) => {
      // Serializes with role changes, removals and accepts in this org.
      await tx.organizations.lockOwnerRoster(input.orgId);

      // The actor's role as this transaction sees it. The check above is only
      // an early refusal: the actor may have been demoted or removed since.
      await requireOrgMembership({
        repos: tx,
        orgId: input.orgId,
        actorHumanId: input.actorHumanId,
        roles: ORG_OWNER_ONLY,
      });

      // Collect all current members so we can decrement their ORGS_JOINED.
      // Read under the lock, so a member whose accept has just committed is
      // on the list.
      const allMembers = await collectAllMembers(tx, input.orgId);

      // Archive the organization.
      await tx.organizations.update({
        id: input.orgId,
        slug: `${org.slug}__archived_${now.getTime()}`,
      });

      // Remove every member, decrementing ORGS_JOINED per human.
      let removedCount = 0;
      for (const member of allMembers) {
        const removed = await tx.organizations.removeMember({
          orgId: input.orgId,
          humanId: member.humanId,
        });
        if (removed) {
          removedCount++;
          await incrementResourceUsage(tx, {
            subjectType: "HUMAN",
            subjectId: member.humanId,
            kind: "ORGS_JOINED",
            delta: -1n,
          });
        }
      }

      // The org row keeps its ACTIVE status, which is all `acceptInvitation`
      // checks, so every invitation still pending would otherwise let its
      // invitee join the dissolved org.
      const revokedInvitationCount =
        await tx.organizations.revokeAllPendingInvitations(input.orgId);

      // Decrement ORGS_OWNED for the actor who is dissolving the org.
      // The quota tracks how many orgs a human has *created* (i.e. owns).
      await incrementResourceUsage(tx, {
        subjectType: "HUMAN",
        subjectId: input.actorHumanId,
        kind: "ORGS_OWNED",
        delta: -1n,
      });

      await tx.audit.log({
        entity: "organization",
        entityId: input.orgId,
        action: "organization.deleted",
        data: {
          actorHumanId: input.actorHumanId,
          previousName: org.name,
          previousSlug: org.slug,
          removedMemberCount: removedCount,
          revokedInvitationCount,
        },
        at: now,
      });

      return removedCount;
    });

    scopedLogger?.info("deleteOrg.completed", {
      orgId: input.orgId,
      archivedMemberCount,
    });

    return deleteOrgOutputSchema.parse({ ok: true, archivedMemberCount });
  };

  if (scopedLogger) {
    return scopedLogger.withTime("deleteOrg", execute);
  }

  return execute();
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Paginate through all members of an org. */
async function collectAllMembers(
  repos: Pick<TxRepos, "organizations">,
  orgId: string,
): Promise<Array<{ humanId: string; role: OrgRole }>> {
  const members: Array<{ humanId: string; role: OrgRole }> = [];
  let offset = 0;
  const limit = 200;

  while (true) {
    const page = await repos.organizations.listMembers({
      orgId,
      limit,
      offset,
    });
    for (const m of page.items) {
      members.push({ humanId: m.humanId, role: m.role });
    }
    if (page.items.length < limit || offset + limit >= page.total) {
      break;
    }
    offset += limit;
  }

  return members;
}
