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
export const createWaiverTemplateInputBaseSchema = z.object({
  actorHumanId: z.string().uuid(),
  /** Provide orgId for org-owned templates. Mutually exclusive with humanId. */
  orgId: z.string().uuid().optional(),
  /** Provide humanId for solo-human-owned templates. Mutually exclusive with orgId. */
  humanId: z.string().uuid().optional(),
  name: plainTextRequired(200),
  body: plainTextMultilineRequired(50_000),
  isDefault: z.boolean().optional(),
});

/** Full input schema with strict + cross-field refinement (used by the use case). */
export const createWaiverTemplateInputSchema =
  createWaiverTemplateInputBaseSchema
    .strict()
    .refine((v) => (v.orgId != null) !== (v.humanId != null), {
      message: "Exactly one of orgId or humanId must be provided",
    });

export const createWaiverTemplateOutputSchema = z.object({
  waiverTemplate: z.object({
    id: z.string().uuid(),
    name: z.string(),
    version: z.number().int(),
    createdAt: z.date(),
  }),
});

export type CreateWaiverTemplateInput = z.infer<
  typeof createWaiverTemplateInputSchema
>;
export type CreateWaiverTemplateOutput = z.infer<
  typeof createWaiverTemplateOutputSchema
>;

export type CreateWaiverTemplateDeps = {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
};

// ── Use case ──────────────────────────────────────────────────────────────

export async function createWaiverTemplate(
  deps: CreateWaiverTemplateDeps,
  rawInput: unknown,
): Promise<CreateWaiverTemplateOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "createWaiverTemplate" });

  const execute = async (): Promise<CreateWaiverTemplateOutput> => {
    const input = parseInput(createWaiverTemplateInputSchema, rawInput);

    const result = await deps.repos.tx(async (tx) => {
      // 1. Auth — org path vs human path
      if (input.orgId) {
        await requireOrgMembership({
          repos: tx,
          orgId: input.orgId,
          actorHumanId: input.actorHumanId,
          roles: ORG_ADMIN_ROLES,
        });

        if (input.isDefault) {
          await tx.waiverTemplates.clearOrgDefault(input.orgId);
        }
      } else if (input.humanId) {
        // The human, or an OWNER/ADMIN delegate — the org arm's role set
        // (owner ruling 2026-09-28).
        if (
          !(await actorHoldsEventEditRole(
            tx.authz,
            { orgId: null, humanId: input.humanId },
            input.actorHumanId,
            ORG_ADMIN_ROLES,
          ))
        ) {
          throw fail("NOT_RESOURCE_OWNER", { meta: { entity: "human" } });
        }

        if (input.isDefault) {
          await tx.waiverTemplates.clearHumanDefault(input.humanId);
        }
      }

      // 2. Resolve organizer name for the platform disclaimer footer
      let organizerName = "the event organizer";
      if (input.orgId) {
        const org = await tx.organizations.getById(input.orgId);
        if (org?.name) organizerName = org.name;
      } else if (input.humanId) {
        const human = await tx.humans.getById(input.humanId);
        if (human?.name) organizerName = human.name;
      }

      // Append platform disclaimer footer to every organizer-created waiver
      const PLATFORM_FOOTER = `\n\nThis document was assembled by ${organizerName} using the Ithas Fire platform. Ithas Fire is a technology provider and did not draft, review, or approve this document. Ithas Fire makes no representation regarding its enforceability.`;
      const bodyWithFooter = input.body.includes(
        "Ithas Fire is a technology provider",
      )
        ? input.body // Already has footer (e.g. platform templates)
        : input.body + PLATFORM_FOOTER;

      // 3. Create template with version 1
      const template = await tx.waiverTemplates.create({
        orgId: input.orgId ?? null,
        humanId: input.humanId ?? null,
        name: input.name,
        body: bodyWithFooter,
        isDefault: input.isDefault ?? false,
      });

      // 3. Audit
      const now = deps.clock.now();
      const auditData: Record<string, unknown> = {
        actorHumanId: input.actorHumanId,
        name: input.name,
        isDefault: input.isDefault ?? false,
      };
      if (input.orgId) auditData.orgId = input.orgId;
      if (input.humanId) auditData.humanId = input.humanId;

      await tx.audit.log({
        entity: "WaiverTemplate",
        entityId: template.id,
        action: "created",
        data: auditData,
        at: now,
      });

      return template;
    });

    return createWaiverTemplateOutputSchema.parse({
      waiverTemplate: {
        id: result.id,
        name: result.name,
        version: result.version,
        createdAt: result.createdAt,
      },
    });
  };

  if (scopedLogger) {
    return scopedLogger.withTime("createWaiverTemplate", execute);
  }

  return execute();
}
