import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { requireOrgMembership, ORG_EDIT_ROLES } from "../../lib/rbac";
import { requirePlaceOwnership } from "../booking-requests/_shared/place-access";
import { requireCalendarSubjectAccess } from "./_shared/require-calendar-subject-access";
import { requireHumanSubjectAccess } from "./_shared/require-human-subject-access";
import { requireMembershipsSubjectAccess } from "./_shared/require-memberships-subject-access";
import { fail } from "@th/errors";
import { ensureActorHoldsHumanEventRole } from "../../lib/event-edit-rights";

export const revokeEmbedInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    embedId: z.uuid(),
  })
  .strict();

export const revokeEmbedOutputSchema = z
  .object({
    embed: z.object({
      id: z.string(),
      status: z.string(),
    }),
  })
  .strict();

export type RevokeEmbedInput = z.infer<typeof revokeEmbedInputSchema>;
export type RevokeEmbedOutput = z.infer<typeof revokeEmbedOutputSchema>;

export type RevokeEmbedDeps = {
  repos: Repos;
  logger?: LoggerPort;
};

export async function revokeEmbed(
  deps: RevokeEmbedDeps,
  rawInput: unknown,
): Promise<RevokeEmbedOutput> {
  const logger = deps.logger?.child({ useCase: "revokeEmbed" });

  const execute = async () => {
    const input = parseInput(revokeEmbedInputSchema, rawInput);

    const embed = await deps.repos.embeds.getById(input.embedId);
    if (!embed) {
      throw fail("EMBED_NOT_FOUND");
    }
    if (embed.status === "REVOKED") {
      return { embed: { id: embed.id, status: embed.status } };
    }

    // Verify ownership — supports event, organization, place, human,
    // memberships, and calendar embeds. Forks on the STORED subjectType (the
    // embed row is the authority; the caller only supplies an embedId).
    if (embed.subjectType === "organization") {
      const org = await deps.repos.organizations.getById(embed.subjectId);
      if (!org) {
        throw fail("ORGANIZATION_NOT_FOUND");
      }
      await requireOrgMembership({
        repos: deps.repos,
        orgId: org.id,
        actorHumanId: input.actorHumanId,
        roles: ORG_EDIT_ROLES,
        errorCode: "INSUFFICIENT_ROLE",
      });
    } else if (embed.subjectType === "event") {
      const event = await deps.repos.events.getById(embed.subjectId);
      if (!event) {
        throw fail("EVENT_NOT_FOUND");
      }
      if (event.orgId) {
        await requireOrgMembership({
          repos: deps.repos,
          orgId: event.orgId,
          actorHumanId: input.actorHumanId,
          roles: ORG_EDIT_ROLES,
          errorCode: "INSUFFICIENT_ROLE",
        });
      } else {
        await ensureActorHoldsHumanEventRole(
          deps.repos.authz,
          event.humanId,
          input.actorHumanId,
        );
      }
    } else if (embed.subjectType === "place") {
      // Same venue-owner gate as upsertEmbed (direct human owner, or
      // owning-org member with an edit-level role).
      const place = await deps.repos.places.getById(embed.subjectId);
      if (!place) {
        throw fail("PLACE_NOT_FOUND");
      }
      await requirePlaceOwnership(deps.repos, place, input.actorHumanId, {
        requiredOrgRoles: ORG_EDIT_ROLES,
      });
    } else if (embed.subjectType === "human") {
      // Personal (non-org) admin context — actor may only revoke their OWN.
      await requireHumanSubjectAccess(
        deps.repos,
        embed.subjectId,
        input.actorHumanId,
      );
    } else if (embed.subjectType === "memberships") {
      // Same owner gate as upsertEmbed (org-first resolution; see helper).
      await requireMembershipsSubjectAccess(
        deps.repos,
        embed.subjectId,
        input.actorHumanId,
      );
    } else if (embed.subjectType === "calendar") {
      // Same place-edit gate as upsertEmbed's calendar branch (helper doc).
      await requireCalendarSubjectAccess(
        deps.repos,
        embed.subjectId,
        input.actorHumanId,
      );
    } else {
      throw fail("UNSUPPORTED_SUBJECT_TYPE", { category: "INVALID_INPUT" });
    }

    const updated = await deps.repos.tx(async (tx) => {
      const record = await tx.embeds.revoke(input.embedId);

      await tx.audit.log({
        entity: "embed",
        entityId: record.id,
        action: "revoke_embed",
        data: { actorHumanId: input.actorHumanId },
      });

      return record;
    });

    return { embed: { id: updated.id, status: updated.status } };
  };

  if (logger) {
    return logger.withTime("revokeEmbed", execute);
  }
  return execute();
}
