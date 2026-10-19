import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { requireOrgMembership, ORG_EDIT_ROLES } from "../../lib/rbac";
import { requirePlaceOwnership } from "../booking-requests/_shared/place-access";
import { requireCalendarSubjectAccess } from "./_shared/require-calendar-subject-access";
import { requireHumanSubjectAccess } from "./_shared/require-human-subject-access";
import { requireMembershipsSubjectAccess } from "./_shared/require-memberships-subject-access";
import { ALLOWED_SUBJECT_TYPES } from "./upsert-embed";
import { fail } from "@th/errors";
import { ensureActorHoldsHumanEventRole } from "../../lib/event-edit-rights";

export const listEmbedsInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    subjectType: z.enum(ALLOWED_SUBJECT_TYPES),
    subjectId: z.uuid(),
  })
  .strict();

const embedItemSchema = z.object({
  id: z.string(),
  subjectType: z.string(),
  subjectId: z.string(),
  domain: z.string(),
  status: z.string(),
  requireAuth: z.boolean(),
  linkOut: z.boolean(),
  /**
   * View config the admin page renders current state from. `defaultView` is a
   * bare string (not `z.enum(EMBED_VIEWS)`) for the same reason `subjectType`
   * is: the read path surfaces whatever is STORED. Always "list"/false for
   * rows that predate the columns.
   */
  defaultView: z.string(),
  viewToggle: z.boolean(),
  createdAt: z.date(),
});

export const listEmbedsOutputSchema = z
  .object({
    embeds: z.array(embedItemSchema),
  })
  .strict();

export type ListEmbedsInput = z.infer<typeof listEmbedsInputSchema>;
export type ListEmbedsOutput = z.infer<typeof listEmbedsOutputSchema>;

export type ListEmbedsDeps = {
  repos: Repos;
  logger?: LoggerPort;
};

export async function listEmbeds(
  deps: ListEmbedsDeps,
  rawInput: unknown,
): Promise<ListEmbedsOutput> {
  const logger = deps.logger?.child({ useCase: "listEmbeds" });

  const execute = async () => {
    const input = parseInput(listEmbedsInputSchema, rawInput);

    // ── Authorization ────────────────────────────────────────────────
    if (input.subjectType === "organization") {
      const org = await deps.repos.organizations.getById(input.subjectId);
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
    } else if (input.subjectType === "human") {
      // Personal (non-org) admin context — actor may only list their OWN.
      await requireHumanSubjectAccess(
        deps.repos,
        input.subjectId,
        input.actorHumanId,
      );
    } else if (input.subjectType === "memberships") {
      // Same owner gate as upsertEmbed (org-first resolution; see helper).
      await requireMembershipsSubjectAccess(
        deps.repos,
        input.subjectId,
        input.actorHumanId,
      );
    } else if (input.subjectType === "calendar") {
      // Same place-edit gate as upsertEmbed's calendar branch (helper doc).
      await requireCalendarSubjectAccess(
        deps.repos,
        input.subjectId,
        input.actorHumanId,
      );
    } else if (input.subjectType === "place") {
      // Same venue-owner gate as upsertEmbed (see the RBAC note there —
      // verification status is deliberately not required to manage domains).
      const place = await deps.repos.places.getById(input.subjectId);
      if (!place) {
        throw fail("PLACE_NOT_FOUND");
      }
      await requirePlaceOwnership(deps.repos, place, input.actorHumanId, {
        requiredOrgRoles: ORG_EDIT_ROLES,
      });
    } else {
      const event = await deps.repos.events.getById(input.subjectId);
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
    }

    const embeds = await deps.repos.embeds.listBySubject({
      subjectType: input.subjectType,
      subjectId: input.subjectId,
    });

    return {
      embeds: embeds.map((e) => ({
        id: e.id,
        subjectType: e.subjectType,
        subjectId: e.subjectId,
        domain: e.domain,
        status: e.status,
        requireAuth: e.requireAuth,
        linkOut: e.linkOut,
        defaultView: e.defaultView,
        viewToggle: e.viewToggle,
        createdAt: e.createdAt,
      })),
    };
  };

  if (logger) {
    return logger.withTime("listEmbeds", execute);
  }
  return execute();
}
