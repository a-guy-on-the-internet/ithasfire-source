import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { OrgMembership } from "@th/ports/repos/authz";
import { orgRoleSchema } from "@th/schema";

import { parseInput } from "./_shared/save-event-shared";
import { fail } from "@th/errors";

export const listEventOwnerEntitiesInputSchema = z
  .object({
    actorHumanId: z.uuid(),
  })
  .strict();

// All org membership roles surface here so the admin shell can list every
// org the human can administer in any capacity (FINANCE for refunds,
// VIEWER for reports, SCANNER for check-in, etc.). The new-event flow
// filters down to ORG_EDIT_ROLES on its own when picking a target.
const ownerOrgRoleSchema = orgRoleSchema;

export const listEventOwnerEntitiesOutputSchema = z
  .object({
    owners: z.array(
      z.discriminatedUnion("kind", [
        z
          .object({
            kind: z.literal("human"),
            humanId: z.uuid(),
            humanName: z.string().min(1),
            humanUsername: z.string().min(1).nullable(),
            humanProfileSlug: z.string().min(1).nullable(),
            // Resolved avatar URL from the human's EntityPage (null when none set).
            avatarUrl: z.string().min(1).nullable(),
          })
          .strict(),
        z
          .object({
            kind: z.literal("org"),
            orgId: z.uuid(),
            orgName: z.string().min(1),
            orgSlug: z.string().min(1).nullable().optional(),
            role: ownerOrgRoleSchema,
            // Resolved logo/avatar URL from the org's EntityPage (null when none set).
            avatarUrl: z.string().min(1).nullable(),
          })
          .strict(),
      ]),
    ),
  })
  .strict();

export type ListEventOwnerEntitiesInput = z.infer<
  typeof listEventOwnerEntitiesInputSchema
>;
export type ListEventOwnerEntitiesOutput = z.infer<
  typeof listEventOwnerEntitiesOutputSchema
>;

export type ListEventOwnerEntitiesDeps = {
  repos: Repos;
  logger?: LoggerPort;
};

export async function listEventOwnerEntities(
  deps: ListEventOwnerEntitiesDeps,
  rawInput: unknown,
): Promise<ListEventOwnerEntitiesOutput> {
  const scopedLogger = deps.logger?.child({
    useCase: "listEventOwnerEntities",
  });

  const execute = async () => {
    const input = parseInput(listEventOwnerEntitiesInputSchema, rawInput);

    const humanWithIdentity = await deps.repos.humans.getByIdWithIdentity(
      input.actorHumanId,
    );
    if (!humanWithIdentity) {
      throw fail("HUMAN_NOT_FOUND");
    }
    const { human, identity } = humanWithIdentity;

    // Fetch entity page to get the profile slug for routing
    const page = await deps.repos.entityPages.getByOwner(
      "HUMAN",
      input.actorHumanId,
    );

    const memberships: OrgMembership[] =
      await deps.repos.authz.listOrgMembershipsByHumanId({
        humanId: input.actorHumanId,
        // No role filter — admin shell needs every membership.
      });

    const orgIds = Array.from(
      new Set(memberships.map((membership) => membership.orgId)),
    );

    const [orgRecords, orgPages] = await Promise.all([
      Promise.all(orgIds.map((id) => deps.repos.organizations.getById(id))),
      // Batched avatar/logo lookup: one query for every org the human can
      // administer (mirrors the human EntityPage fetch above).
      deps.repos.entityPages.getByOwners("ORGANIZATION", orgIds),
    ]);

    const orgAvatarByOwnerId = new Map(
      orgPages.map((page) => [page.ownerId, page.avatarUrl ?? null]),
    );

    const orgItems = orgRecords
      .filter((org): org is NonNullable<typeof org> => Boolean(org))
      .map((org) => {
        const membership = memberships.find((m) => m.orgId === org.id);
        if (!membership) return null;

        return {
          kind: "org" as const,
          orgId: org.id,
          orgName: org.name,
          orgSlug: org.slug,
          role: membership.role,
          avatarUrl: orgAvatarByOwnerId.get(org.id) ?? null,
        };
      })
      .filter((value): value is NonNullable<typeof value> => Boolean(value));

    const owners: ListEventOwnerEntitiesOutput["owners"] = [
      {
        kind: "human",
        humanId: input.actorHumanId,
        humanName: human.name ?? identity.email ?? "Me",
        humanUsername: identity.username ?? null,
        humanProfileSlug: page?.slug ?? null,
        avatarUrl: page?.avatarUrl ?? null,
      },
      ...orgItems,
    ];

    return { owners };
  };

  if (scopedLogger) {
    return scopedLogger.withTime("listEventOwnerEntities", execute);
  }

  return execute();
}
