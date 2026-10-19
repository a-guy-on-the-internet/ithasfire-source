import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { requirePlatformStaff } from "../../lib/rbac";
import { fail } from "@th/errors";

export const deleteCategoryInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    categoryId: z.uuid(),
  })
  .strict();

export const deleteCategoryOutputSchema = z
  .object({
    deleted: z.object({
      id: z.string(),
      slug: z.string(),
      name: z.string(),
    }),
  })
  .strict();

export type DeleteCategoryInput = z.infer<typeof deleteCategoryInputSchema>;
export type DeleteCategoryOutput = z.infer<typeof deleteCategoryOutputSchema>;

export type DeleteCategoryDeps = {
  repos: Repos;
  authz: AuthZPort;
  clock: ClockPort;
  logger?: LoggerPort;
};

/**
 * Hard-delete a platform category by id. Restricted to ADMIN / DEVELOPER —
 * REVIEWERs can only approve / reject requests, not destroy taxonomy.
 *
 * Events that reference the deleted category fall back to "uncategorised"
 * via the schema's `onDelete: SetNull` rule on `Event.category`. The
 * organiser can re-assign one later through the event editor.
 *
 * Outstanding `EventCategoryRequest` rows that referenced this category id
 * (via `categoryId` / `resolvedCategoryId`) are intentionally left intact
 * as a historical record of the decision; their fields are loose foreign
 * keys without an enforced relation, so deletion doesn't cascade.
 */
export async function deleteCategory(
  deps: DeleteCategoryDeps,
  rawInput: unknown,
): Promise<DeleteCategoryOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "deleteCategory" });

  const execute = async (): Promise<DeleteCategoryOutput> => {
    const input = parseInput(deleteCategoryInputSchema, rawInput);

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

      const ok = await tx.categories.deleteById(input.categoryId);
      if (!ok) {
        // Lost a race with another deleter — treat as not_found.
        throw fail("CATEGORY_NOT_FOUND");
      }

      await tx.audit.log({
        entity: "category",
        entityId: existing.id,
        action: "category.deleted",
        data: {
          actorHumanId: input.actorHumanId,
          slug: existing.slug,
          name: existing.name,
        },
        at: deps.clock.now(),
      });

      return {
        deleted: {
          id: existing.id,
          slug: existing.slug,
          name: existing.name,
        },
      };
    });

    return deleteCategoryOutputSchema.parse(result);
  };

  if (scopedLogger) {
    return scopedLogger.withTime("deleteCategory", execute);
  }

  return execute();
}
