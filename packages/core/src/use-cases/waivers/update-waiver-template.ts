import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { requireOrgMembership, ORG_ADMIN_ROLES } from "../../lib/rbac";
import { fail } from "@th/errors";
import {
  plainTextMultilineRequired,
  plainTextRequired,
} from "../../lib/sanitize-plain-text";
import { actorHoldsEventEditRole } from "../../lib/event-edit-rights";

// ── Schema ────────────────────────────────────────────────────────────────

/**
 * Base object schema (no refinement, no .strict()) — safe to .omit() in
 * transport layers. Zod v4 treats .strict() as a refinement, so we keep
 * the base free of it.
 */
export const updateWaiverTemplateInputBaseSchema = z.object({
  actorHumanId: z.string().uuid(),
  waiverTemplateId: z.string().uuid(),
  name: plainTextRequired(200).optional(),
  body: plainTextMultilineRequired(50_000).optional(),
});

/** Full input schema with strict + cross-field refinement (used by the use case). */
export const updateWaiverTemplateInputSchema =
  updateWaiverTemplateInputBaseSchema
    .strict()
    .refine((v) => v.name !== undefined || v.body !== undefined, {
      message: "At least one of name or body must be provided",
    });

export const updateWaiverTemplateOutputSchema = z.object({
  waiverTemplate: z.object({
    id: z.string().uuid(),
    name: z.string(),
    version: z.number().int(),
    updatedAt: z.date(),
  }),
});

export type UpdateWaiverTemplateInput = z.infer<
  typeof updateWaiverTemplateInputSchema
>;
export type UpdateWaiverTemplateOutput = z.infer<
  typeof updateWaiverTemplateOutputSchema
>;

export type UpdateWaiverTemplateDeps = {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
};

// ── Use case ──────────────────────────────────────────────────────────────

export async function updateWaiverTemplate(
  deps: UpdateWaiverTemplateDeps,
  rawInput: unknown,
): Promise<UpdateWaiverTemplateOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "updateWaiverTemplate" });

  const execute = async (): Promise<UpdateWaiverTemplateOutput> => {
    const input = parseInput(updateWaiverTemplateInputSchema, rawInput);

    const result = await deps.repos.tx(async (tx) => {
      // 1. Load existing template to determine ownership
      const existing = await tx.waiverTemplates.getById(input.waiverTemplateId);
      if (!existing) {
        throw fail("WAIVER_TEMPLATE_NOT_FOUND");
      }

      // 2. Enforce ownership-based auth
      if (existing.orgId !== null) {
        // Org-owned: require admin on that org
        await requireOrgMembership({
          repos: tx,
          orgId: existing.orgId,
          actorHumanId: input.actorHumanId,
          roles: ORG_ADMIN_ROLES,
        });
      } else if (existing.humanId !== null) {
        // Human-owned: the owner, or an OWNER/ADMIN delegate — the org
        // arm's role set (owner ruling 2026-09-28).
        if (
          !(await actorHoldsEventEditRole(
            tx.authz,
            { orgId: null, humanId: existing.humanId },
            input.actorHumanId,
            ORG_ADMIN_ROLES,
          ))
        ) {
          throw fail("WAIVER_TEMPLATE_NOT_OWNED");
        }
      } else {
        // Platform templates (no owner) cannot be edited
        throw fail("PLATFORM_TEMPLATE_READONLY");
      }

      // 5. Build update payload — increment version if body changes
      const previousVersion = existing.version;
      const updatePayload: { id: string; name?: string; body?: string } = {
        id: input.waiverTemplateId,
      };
      let newVersion = previousVersion;

      if (input.name !== undefined) {
        updatePayload.name = input.name;
      }
      if (input.body !== undefined) {
        // Append platform disclaimer footer if not already present
        let bodyWithFooter = input.body;
        if (!input.body.includes("Ithas Fire is a technology provider")) {
          let organizerName = "the event organizer";
          if (existing.orgId) {
            const org = await tx.organizations.getById(existing.orgId);
            if (org?.name) organizerName = org.name;
          } else if (existing.humanId) {
            const human = await tx.humans.getById(existing.humanId);
            if (human?.name) organizerName = human.name;
          }
          bodyWithFooter =
            input.body +
            `\n\nThis document was assembled by ${organizerName} using the Ithas Fire platform. Ithas Fire is a technology provider and did not draft, review, or approve this document. Ithas Fire makes no representation regarding its enforceability.`;
        }
        updatePayload.body = bodyWithFooter;
        newVersion = previousVersion + 1;
      }

      const updated = await tx.waiverTemplates.update(updatePayload);

      // 6. Audit
      const now = deps.clock.now();
      await tx.audit.log({
        entity: "WaiverTemplate",
        entityId: updated.id,
        action: "updated",
        data: {
          actorHumanId: input.actorHumanId,
          orgId: existing.orgId ?? undefined,
          humanId: existing.humanId ?? undefined,
          previousVersion,
          newVersion,
          bodyChanged: input.body !== undefined,
        },
        at: now,
      });

      return updated;
    });

    return updateWaiverTemplateOutputSchema.parse({
      waiverTemplate: {
        id: result.id,
        name: result.name,
        version: result.version,
        updatedAt: result.updatedAt,
      },
    });
  };

  if (scopedLogger) {
    return scopedLogger.withTime("updateWaiverTemplate", execute);
  }

  return execute();
}
