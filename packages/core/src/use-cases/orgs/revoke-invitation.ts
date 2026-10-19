import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { OrgRole } from "@th/ports/repos/authz";
import type { OrgInvitationRecord } from "@th/ports/repos/organizations";
import { parseInput } from "../../lib/io";
import {
  ORG_ADMIN_ROLES,
  ORG_OWNER_ONLY,
  requireOrgMembership,
  type OrgMembershipLookup,
} from "../../lib/rbac";
import { fail } from "@th/errors";

const REQUIRED_ACTOR_ROLES = ORG_ADMIN_ROLES;

export const revokeInvitationInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    orgId: z.uuid(),
    invitationId: z.uuid(),
  })
  .strict();

export const revokeInvitationOutputSchema = z
  .object({
    ok: z.literal(true),
  })
  .strict();

export type RevokeInvitationInput = z.infer<typeof revokeInvitationInputSchema>;
export type RevokeInvitationOutput = z.infer<
  typeof revokeInvitationOutputSchema
>;

export type RevokeInvitationDeps = {
  repos: Repos;
  authz: AuthZPort;
  clock: ClockPort;
  logger?: LoggerPort;
};

export async function revokeInvitation(
  deps: RevokeInvitationDeps,
  rawInput: unknown,
): Promise<RevokeInvitationOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "revokeInvitation" });

  const execute = async () => {
    const input = parseInput(revokeInvitationInputSchema, rawInput);

    await deps.authz.requireOrgRole({
      actorHumanId: input.actorHumanId,
      orgId: input.orgId,
      requiredRoles: [...REQUIRED_ACTOR_ROLES],
    });

    const now = deps.clock.now();

    await deps.repos.tx(async (tx) => {
      // Serializes with invites, role changes and accepts in this org: the
      // invitation row, the actor's role and the sender's role below are
      // what the previous holder committed. Without it an OWNER re-inviting
      // this email at OWNER (an upsert onto the same row) could commit after
      // the read below, and the update would revoke the new live invitation.
      await tx.organizations.lockOwnerRoster(input.orgId);

      // The actor's role as this transaction sees it; the check above is
      // only an early refusal.
      const actor = await requireOrgMembership({
        repos: tx,
        orgId: input.orgId,
        actorHumanId: input.actorHumanId,
        roles: REQUIRED_ACTOR_ROLES,
      });

      // Validate the invitation belongs to this org
      const existing = await tx.organizations.listInvitations({
        orgId: input.orgId,
        limit: 1000,
        offset: 0,
      });

      const invitation2 = existing.items.find(
        (i) => i.id === input.invitationId,
      );
      if (!invitation2) {
        throw fail("INVITATION_NOT_FOUND");
      }

      if (invitation2.status !== "PENDING") {
        throw fail("INVITATION_NOT_PENDING");
      }

      // Revoking an OWNER invitation that could still be accepted takes an
      // OWNER. A lapsed one, or one whose sender is no longer an OWNER, is
      // anyone's with the admin role to clear.
      if (
        !ORG_OWNER_ONLY.includes(actor.role) &&
        (await isLiveOwnerInvitation(tx, invitation2, now))
      ) {
        throw fail("INSUFFICIENT_ROLE");
      }

      await tx.organizations.updateInvitationStatus({
        id: input.invitationId,
        status: "REVOKED",
      });

      await tx.audit.log({
        entity: "organization",
        entityId: input.orgId,
        action: "org.invitation_revoked",
        data: {
          actorHumanId: input.actorHumanId,
          invitationId: input.invitationId,
          email: invitation2.email,
        },
        at: now,
      });
    });

    scopedLogger?.info("revokeInvitation.success", {
      orgId: input.orgId,
      invitationId: input.invitationId,
    });

    return revokeInvitationOutputSchema.parse({ ok: true });
  };

  if (scopedLogger) {
    return scopedLogger.withTime("revokeInvitation", execute);
  }

  return execute();
}

/**
 * Whether a stored invitation is an OWNER invitation `acceptInvitation` would
 * still honour: PENDING, not past its expiry, and sent by a member who holds
 * OWNER in the org today. Only such an invitation is reserved to OWNERs
 * (`inviteMember` overwriting it, `revokeInvitation` revoking it).
 *
 * Expiry is read from `expiresAt`, never from the status: a lapsed
 * invitation keeps `status: "PENDING"` in the database.
 */
export async function isLiveOwnerInvitation(
  repos: OrgMembershipLookup,
  invitation: Pick<
    OrgInvitationRecord,
    "orgId" | "role" | "status" | "expiresAt" | "invitedByHumanId"
  >,
  now: Date,
): Promise<boolean> {
  if (invitation.role !== "OWNER" || invitation.status !== "PENDING") {
    return false;
  }
  if (invitation.expiresAt < now) {
    return false;
  }
  const inviter = await repos.authz.getOrgMembership({
    orgId: invitation.orgId,
    humanId: invitation.invitedByHumanId,
  });
  return inviter?.role === "OWNER";
}

/**
 * Revokes the PENDING OWNER invitations a member sent, for the transaction
 * that takes OWNER away from that member (`updateMemberRole`,
 * `removeOrgMember`). Writes one `org.invitation_revoked` audit row per
 * invitation, shaped like a manual revoke plus the inviter and the reason.
 * Returns how many were revoked.
 */
export async function revokeOwnerInvitationsSentBy(
  tx: Pick<TxRepos, "organizations" | "audit">,
  input: {
    orgId: string;
    inviterHumanId: string;
    actorHumanId: string;
    at: Date;
  },
): Promise<number> {
  const revoked = await tx.organizations.revokePendingOwnerInvitationsByInviter(
    { orgId: input.orgId, invitedByHumanId: input.inviterHumanId },
  );

  for (const invitation of revoked) {
    await tx.audit.log({
      entity: "organization",
      entityId: input.orgId,
      action: "org.invitation_revoked",
      data: {
        actorHumanId: input.actorHumanId,
        invitationId: invitation.id,
        email: invitation.email,
        invitedByHumanId: input.inviterHumanId,
        reason: "INVITER_NO_LONGER_OWNER",
      },
      at: input.at,
    });
  }

  return revoked.length;
}
