import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import {
  categoryNames,
  EVENT_SCHEMA_TYPES,
  isValidEventSchemaType,
} from "@th/types";

import { parseInput } from "../../lib/io";
import { requirePlatformStaff } from "../../lib/rbac";
import { fail } from "@th/errors";
import { categoryNamesSchema } from "./_shared/category-output";

export const setCategorySeoTypeInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    categoryId: z.uuid(),
    // Bounded + allowlisted at the boundary: only curated schema.org Event
    // subtypes are accepted, so a bad value can never reach the DB / JSON-LD.
    seoType: z.enum(EVENT_SCHEMA_TYPES),
  })
  .strict();

export const setCategorySeoTypeOutputSchema = z
  .object({
    category: z.object({
      id: z.string(),
      slug: z.string(),
      name: z.string(),
      names: categoryNamesSchema,
      seoType: z.string(),
    }),
  })
  .strict();

export type SetCategorySeoTypeInput = z.infer<
  typeof setCategorySeoTypeInputSchema
>;
export type SetCategorySeoTypeOutput = z.infer<
  typeof setCategorySeoTypeOutputSchema
>;

export type SetCategorySeoTypeDeps = {
  repos: Repos;
  authz: AuthZPort;
  clock: ClockPort;
  logger?: LoggerPort;
};

/**
 * Set the schema.org Event `@type` a category emits in event JSON-LD (e.g.
 * "MusicEvent"). Platform ADMIN / DEVELOPER only — this is taxonomy config
 * that shapes crawler-visible structured data, so it sits at the same
 * privilege level as category deletion (REVIEWERs can't touch it).
 *
 * `seoType` is validated against the shared allowlist (EVENT_SCHEMA_TYPES) at
 * the Zod boundary; the SEO builder independently falls back to "Event" for
 * anything it doesn't recognise, so a stale/hand-edited DB value can never
 * leak an unrecognised @type.
 */
export async function setCategorySeoType(
  deps: SetCategorySeoTypeDeps,
  rawInput: unknown,
): Promise<SetCategorySeoTypeOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "setCategorySeoType" });

  const execute = async (): Promise<SetCategorySeoTypeOutput> => {
    const input = parseInput(setCategorySeoTypeInputSchema, rawInput);

    // Defensive: the Zod enum already guarantees this, but keep the allowlist
    // gate explicit so the invariant survives a future schema refactor.
    if (!isValidEventSchemaType(input.seoType)) {
      throw fail("INVALID_INPUT", { meta: { field: "seoType" } });
    }

    await requirePlatformStaff({
      authz: deps.authz,
      actorHumanId: input.actorHumanId,
      roles: ["ADMIN", "DEVELOPER"],
    });

    const result = await deps.repos.tx(async (tx) => {
      const existing = await tx.categories.getById(input.categoryId);
      if (!existing) {
        throw fail("CATEGORY_NOT_FOUND");
      }

      const updated = await tx.categories.setSeoType(
        input.categoryId,
        input.seoType,
      );
      if (!updated) {
        // Lost a race with a deleter — treat as not_found.
        throw fail("CATEGORY_NOT_FOUND");
      }

      await tx.audit.log({
        entity: "category",
        entityId: updated.id,
        action: "category.seo_type_set",
        data: {
          actorHumanId: input.actorHumanId,
          slug: updated.slug,
          previousSeoType: existing.seoType,
          seoType: updated.seoType,
        },
        at: deps.clock.now(),
      });

      return {
        category: {
          id: updated.id,
          slug: updated.slug,
          name: updated.name,
          names: categoryNames(updated),
          seoType: updated.seoType,
        },
      };
    });

    return setCategorySeoTypeOutputSchema.parse(result);
  };

  if (scopedLogger) {
    return scopedLogger.withTime("setCategorySeoType", execute);
  }

  return execute();
}
