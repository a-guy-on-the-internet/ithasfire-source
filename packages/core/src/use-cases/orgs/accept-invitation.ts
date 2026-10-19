import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import { parseInput } from "../../lib/io";
import { enforceQuota, incrementResourceUsage } from "../quotas/enforce-quota";
import { requireInvitedIdentity } from "../../lib/invitee-identity";
import { fail } from "@th/errors";

export const acceptInvitationInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    token: z.string().min(1),
  })
  .strict();

export const acceptInvitationOutputSchema = z
  .object({
    orgId: z.string(),
    orgName: z.string(),
    role: z.string(),
  })
  .strict();

export type AcceptInvitationInput = z.infer<typeof acceptInvitationInputSchema>;
export type AcceptInvitationOutput = z.infer<
  typeof acceptInvitationOutputSchema
>;

export type AcceptInvitationDeps = {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
};

export async function acceptInvitation(
  deps: AcceptInvitationDeps,
  rawInput: unknown,
): Promise<AcceptInvitationOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "acceptInvitation" });

  const execute = async () => {
    const input = parseInput(acceptInvitationInputSchema, rawInput);

    const now = deps.clock.now();

    const result = await deps.repos.tx(async (tx) => {
      let invitation = await tx.organizations.getInvitationByToken(
        input.token,
      );
      if (!invitation) {
        throw fail("INVITATION_NOT_FOUND");
      }

      // Consent gate: the signed-in account must own (and have verified) the
      // invited address. Checked BEFORE status/expiry so a non-matching
      // account learns nothing about the invitation. Without it, anyone who
      // got a token — e.g. an attacker who invited their OWN address and
      // lured a signed-in victim to the link — enrolled whoever opened it.
      await requireInvitedIdentity(tx.humans, input.actorHumanId, invitation.email);

      if (invitation.status !== "PENDING") {
        throw fail("INVITATION_NOT_PENDING", { meta: { status: invitation.status } });
      }

      if (invitation.expiresAt < now) {
        await tx.organizations.updateInvitationStatus({
          id: invitation.id,
          status: "EXPIRED",
        });
        throw fail("INVITATION_EXPIRED");
      }

      const org = await tx.organizations.getById(invitation.orgId);
      if (!org || org.status !== "ACTIVE") {
        throw fail("ORGANIZATION_INACTIVE");
      }

      // Every accept runs under the org's roster lock, so whatever revokes
      // invitations (the sender losing OWNER, the org being dissolved) has
      // either committed or has not started. The invitation was read before
      // the lock: read it again after.
      await tx.organizations.lockOwnerRoster(invitation.orgId);
      invitation = await tx.organizations.getInvitationByToken(input.token);
      if (!invitation) {
        throw fail("INVITATION_NOT_FOUND");
      }
      if (invitation.status !== "PENDING") {
        throw fail("INVITATION_NOT_PENDING", {
          meta: { status: invitation.status },
        });
      }

      // An OWNER invitation is honoured only while its sender holds OWNER in
      // the org; one sent by anyone else, or by an owner since demoted or
      // removed, is refused whoever accepts it. The row stays PENDING, and
      // `status: "REVOKED"` is what the accept page reads to pick its copy.
      if (invitation.role === "OWNER") {
        const inviter = await tx.authz.getOrgMembership({
          orgId: invitation.orgId,
          humanId: invitation.invitedByHumanId,
        });
        if (inviter?.role !== "OWNER") {
          throw fail("INVITATION_NOT_PENDING", { meta: { status: "REVOKED" } });
        }
      }

      // Check not already a member
      const existing = await tx.authz.getOrgMembership({
        orgId: invitation.orgId,
        humanId: input.actorHumanId,
      });

      if (existing) {
        // Already a member — mark invitation accepted and return
        await tx.organizations.updateInvitationStatus({
          id: invitation.id,
          status: "ACCEPTED",
          acceptedAt: now,
          acceptedByHumanId: input.actorHumanId,
        });

        return { orgId: org.id, orgName: org.name, role: existing.role };
      }

      // Enforce ORGS_JOINED quota before adding membership
      await enforceQuota(tx, {
        subjectType: "HUMAN",
        subjectId: input.actorHumanId,
        kind: "ORGS_JOINED",
      });

      // Also enforce MEMBERS_PER_ORG for the target org
      await enforceQuota(tx, {
        subjectType: "ORG",
        subjectId: invitation.orgId,
        kind: "MEMBERS_PER_ORG",
      });

      // Add as member
      await tx.organizations.addMember({
        orgId: invitation.orgId,
        humanId: input.actorHumanId,
        role: invitation.role,
        addedAt: now,
      });

      // Mark invitation accepted
      await tx.organizations.updateInvitationStatus({
        id: invitation.id,
        status: "ACCEPTED",
        acceptedAt: now,
        acceptedByHumanId: input.actorHumanId,
      });

      await tx.audit.log({
        entity: "organization",
        entityId: invitation.orgId,
        action: "org.invitation_accepted",
        data: {
          invitationId: invitation.id,
          humanId: input.actorHumanId,
          role: invitation.role,
          email: invitation.email,
        },
        at: now,
      });

      // Track membership usage
      await incrementResourceUsage(tx, {
        subjectType: "HUMAN",
        subjectId: input.actorHumanId,
        kind: "ORGS_JOINED",
      });
      await incrementResourceUsage(tx, {
        subjectType: "ORG",
        subjectId: invitation.orgId,
        kind: "MEMBERS_PER_ORG",
      });

      return { orgId: org.id, orgName: org.name, role: invitation.role };
    });

    scopedLogger?.info("acceptInvitation.success", {
      orgId: result.orgId,
      humanId: input.actorHumanId,
    });

    return acceptInvitationOutputSchema.parse(result);
  };

  if (scopedLogger) {
    return scopedLogger.withTime("acceptInvitation", execute);
  }

  return execute();
}
