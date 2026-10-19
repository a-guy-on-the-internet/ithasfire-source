import { z } from "zod";

import { authZRoleSchema, type AuthZPort } from "@th/ports/authz";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { OrgRole } from "@th/ports/repos/authz";

import { parseInput } from "../../lib/io";
import { ORG_ANY_ROLE } from "../../lib/rbac";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const listOrgMembersInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    orgId: z.string().uuid(),
    limit: z.number().int().min(1).max(200).default(50),
    offset: z.number().int().min(0).default(0),
  })
  .strict();

const orgMemberItemSchema = z.object({
  humanId: z.string().uuid(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  role: authZRoleSchema,
  joinedAt: z.coerce.date(),
});

export const listOrgMembersOutputSchema = z
  .object({
    items: z.array(orgMemberItemSchema),
    total: z.number().int(),
  })
  .strict();

export type ListOrgMembersInput = z.infer<typeof listOrgMembersInputSchema>;
export type ListOrgMembersOutput = z.infer<typeof listOrgMembersOutputSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Deps
// ─────────────────────────────────────────────────────────────────────────────

export type ListOrgMembersDeps = {
  repos: Pick<Repos, "organizations">;
  authz: AuthZPort;
  logger?: LoggerPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Any org member can view the team roster.
 *
 * `email` is safe to return because every membership now exists only by the
 * member's own action: creating the org, or accepting an invitation
 * (`acceptInvitation`). `addMember` and `inviteMember`'s direct-add path,
 * which created memberships without consent and so leaked emails here, were
 * removed (security review F3). Pending invitees are NOT in this list — they
 * are in `listInvitations` (admin-only), under the email the admin typed.
 */
const REQUIRED_ROLES = ORG_ANY_ROLE;

export async function listOrgMembers(
  deps: ListOrgMembersDeps,
  rawInput: unknown,
): Promise<ListOrgMembersOutput> {
  const input = parseInput(listOrgMembersInputSchema, rawInput);

  await deps.authz.requireOrgRole({
    actorHumanId: input.actorHumanId,
    orgId: input.orgId,
    requiredRoles: [...REQUIRED_ROLES],
  });

  const result = await deps.repos.organizations.listMembers({
    orgId: input.orgId,
    limit: input.limit,
    offset: input.offset,
  });

  return listOrgMembersOutputSchema.parse(result);
}
