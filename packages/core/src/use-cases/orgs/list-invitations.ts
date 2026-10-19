import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { OrgRole } from "@th/ports/repos/authz";
import { parseInput } from "../../lib/io";
import { ORG_ADMIN_ROLES } from "../../lib/rbac";

const REQUIRED_ACTOR_ROLES = ORG_ADMIN_ROLES;

export const listInvitationsInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    orgId: z.uuid(),
    status: z.enum(["PENDING", "ACCEPTED", "EXPIRED", "REVOKED"]).optional(),
    limit: z.number().int().min(1).max(200).default(50),
    offset: z.number().int().min(0).default(0),
  })
  .strict();

export const listInvitationsOutputSchema = z
  .object({
    items: z.array(
      z.object({
        id: z.string(),
        email: z.string(),
        role: z.string(),
        status: z.string(),
        expiresAt: z.coerce.date(),
        createdAt: z.coerce.date(),
        invitedByHumanId: z.string(),
      }),
    ),
    total: z.number(),
  })
  .strict();

export type ListInvitationsInput = z.infer<typeof listInvitationsInputSchema>;
export type ListInvitationsOutput = z.infer<typeof listInvitationsOutputSchema>;

export type ListInvitationsDeps = {
  repos: Repos;
  authz: AuthZPort;
  logger?: LoggerPort;
};

export async function listInvitations(
  deps: ListInvitationsDeps,
  rawInput: unknown,
): Promise<ListInvitationsOutput> {
  const input = parseInput(listInvitationsInputSchema, rawInput);

  await deps.authz.requireOrgRole({
    actorHumanId: input.actorHumanId,
    orgId: input.orgId,
    requiredRoles: [...REQUIRED_ACTOR_ROLES],
  });

  const result = await deps.repos.organizations.listInvitations({
    orgId: input.orgId,
    status: input.status,
    limit: input.limit,
    offset: input.offset,
  });

  return listInvitationsOutputSchema.parse({
    items: result.items.map((i) => ({
      id: i.id,
      email: i.email,
      role: i.role,
      status: i.status,
      expiresAt: i.expiresAt,
      createdAt: i.createdAt,
      invitedByHumanId: i.invitedByHumanId,
    })),
    total: result.total,
  });
}
