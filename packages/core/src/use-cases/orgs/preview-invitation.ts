import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import { fail } from "@th/errors";

import { parseInput } from "../../lib/io";
import { requireInvitedIdentity } from "../../lib/invitee-identity";

export const previewInvitationInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    token: z.string().min(1).max(512),
  })
  .strict();

export const previewInvitationOutputSchema = z
  .object({
    orgName: z.string(),
    role: z.string(),
  })
  .strict();

export type PreviewInvitationInput = z.infer<typeof previewInvitationInputSchema>;
export type PreviewInvitationOutput = z.infer<
  typeof previewInvitationOutputSchema
>;

export type PreviewInvitationDeps = {
  repos: Pick<Repos, "organizations" | "humans" | "authz">;
  clock: { now(): Date };
  logger?: LoggerPort;
};

/**
 * Read-only look at an org invitation so the accept page can name the org and
 * role BEFORE the invitee presses Accept. Runs the SAME checks as
 * `acceptInvitation` (token exists → signed-in email matches and is verified →
 * pending → not expired → org active → an OWNER invitation's sender still
 * holds OWNER) and writes nothing. The org name is only returned to the
 * account the invitation was sent to.
 */
export async function previewInvitation(
  deps: PreviewInvitationDeps,
  rawInput: unknown,
): Promise<PreviewInvitationOutput> {
  const input = parseInput(previewInvitationInputSchema, rawInput);

  const invitation = await deps.repos.organizations.getInvitationByToken(
    input.token,
  );
  if (!invitation) {
    throw fail("INVITATION_NOT_FOUND");
  }

  await requireInvitedIdentity(
    deps.repos.humans,
    input.actorHumanId,
    invitation.email,
  );

  if (invitation.status !== "PENDING") {
    throw fail("INVITATION_NOT_PENDING", {
      meta: { status: invitation.status },
    });
  }
  if (invitation.expiresAt < deps.clock.now()) {
    throw fail("INVITATION_EXPIRED");
  }

  const org = await deps.repos.organizations.getById(invitation.orgId);
  if (!org || org.status !== "ACTIVE") {
    throw fail("ORGANIZATION_INACTIVE");
  }

  // Same refusal, code and meta as `acceptInvitation`, so the accept screen
  // never offers an OWNER invitation that accepting would turn down.
  if (invitation.role === "OWNER") {
    const inviter = await deps.repos.authz.getOrgMembership({
      orgId: invitation.orgId,
      humanId: invitation.invitedByHumanId,
    });
    if (inviter?.role !== "OWNER") {
      throw fail("INVITATION_NOT_PENDING", { meta: { status: "REVOKED" } });
    }
  }

  return previewInvitationOutputSchema.parse({
    orgName: org.name,
    role: invitation.role,
  });
}
