import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { WaiverTemplateRecord } from "@th/ports/repos/waivers";

import { parseInput } from "../../lib/io";
import { requireOrgMembership, ORG_EDIT_ROLES } from "../../lib/rbac";
import { fail } from "@th/errors";
import { actorHoldsEventEditRole } from "../../lib/event-edit-rights";

// ── Schema ────────────────────────────────────────────────────────────────

/**
 * Base object schema (no refinement, no .strict()) — safe to .omit() in
 * transport layers. Zod v4 treats .strict() as a refinement, so we keep
 * the base free of it.
 */
export const listWaiverTemplatesInputBaseSchema = z.object({
  actorHumanId: z.string().uuid(),
  orgId: z.string().uuid().optional(),
  humanId: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(100).optional().default(50),
  offset: z.number().int().min(0).optional().default(0),
});

/** Full input schema with strict + cross-field refinement (used by the use case). */
export const listWaiverTemplatesInputSchema = listWaiverTemplatesInputBaseSchema
  .strict()
  .refine((v) => (v.orgId != null) !== (v.humanId != null), {
    message: "Exactly one of orgId or humanId must be provided",
  });

export const listWaiverTemplatesOutputSchema = z.object({
  templates: z.array(
    z.object({
      id: z.string().uuid(),
      orgId: z.string().uuid().nullable(),
      humanId: z.string().uuid().nullable(),
      name: z.string(),
      body: z.string(),
      version: z.number().int(),
      isDefault: z.boolean(),
      /**
       * Audience discriminator — lets pickers resolve "the platform standard
       * volunteer waiver" (kind VOLUNTEER + isDefault) instead of hardcoding
       * its id. Defaults ATTENDEE for records that predate the column.
       */
      kind: z.enum(["ATTENDEE", "VOLUNTEER"]).default("ATTENDEE"),
      createdAt: z.date(),
      updatedAt: z.date(),
    }),
  ),
});

export type ListWaiverTemplatesInput = z.infer<
  typeof listWaiverTemplatesInputSchema
>;
export type ListWaiverTemplatesOutput = z.infer<
  typeof listWaiverTemplatesOutputSchema
>;

export type ListWaiverTemplatesDeps = {
  repos: Pick<Repos, "waiverTemplates" | "authz">;
  logger?: LoggerPort;
};

// ── Use case ──────────────────────────────────────────────────────────────

export async function listWaiverTemplates(
  deps: ListWaiverTemplatesDeps,
  rawInput: unknown,
): Promise<ListWaiverTemplatesOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "listWaiverTemplates" });

  const execute = async (): Promise<ListWaiverTemplatesOutput> => {
    const input = parseInput(listWaiverTemplatesInputSchema, rawInput);

    // Auth — org path (OWNER/ADMIN/EDITOR) vs solo-human path (self only),
    // mirroring createWaiverTemplate. The schema refinement guarantees
    // exactly one of orgId / humanId is set.
    if (input.orgId) {
      await requireOrgMembership({
        repos: deps.repos,
        orgId: input.orgId,
        actorHumanId: input.actorHumanId,
        roles: ORG_EDIT_ROLES,
      });
    } else if (
      // The human, or an edit-role delegate of theirs (owner ruling
      // 2026-09-28) — the waiver picker in the principal's event builder.
      !(await actorHoldsEventEditRole(
        deps.repos.authz,
        { orgId: null, humanId: input.humanId ?? null },
        input.actorHumanId,
      ))
    ) {
      throw fail("NOT_RESOURCE_OWNER", { meta: { entity: "human" } });
    }

    // Fetch owner templates + platform defaults
    const templates: WaiverTemplateRecord[] =
      await deps.repos.waiverTemplates.list({
        orgId: input.orgId ?? null,
        humanId: input.humanId ?? null,
        includePlatform: true,
        limit: input.limit,
        offset: input.offset,
      });

    return listWaiverTemplatesOutputSchema.parse({ templates });
  };

  if (scopedLogger) {
    return scopedLogger.withTime("listWaiverTemplates", execute);
  }

  return execute();
}
