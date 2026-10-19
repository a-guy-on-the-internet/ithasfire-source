import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { requirePlatformStaff } from "../../lib/rbac";
import { fail } from "@th/errors";
import {
  categoryOutputSchema,
  toCategoryOutput,
} from "./_shared/category-output";

export const setCategoryActiveInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    categoryId: z.uuid(),
    active: z.boolean(),
  })
  .strict();

export const setCategoryActiveOutputSchema = z
  .object({ category: categoryOutputSchema })
  .strict();

export type SetCategoryActiveInput = z.infer<
  typeof setCategoryActiveInputSchema
>;
export type SetCategoryActiveOutput = z.infer<
  typeof setCategoryActiveOutputSchema
>;

export type SetCategoryActiveDeps = {
  repos: Repos;
  authz: AuthZPort;
  clock: ClockPort;
  logger?: LoggerPort;
};

/**
 * Deactivate or reactivate a category. Platform ADMIN / DEVELOPER only.
 *
 * Only `Category.active` is written. Events keep the category they have,
 * calendars keep their default category, and pending category requests are
 * left alone. What an inactive category means is decided by the readers of
 * `active`: the public list (`listActive`), the category pages
 * (`listEventsByCategory`, the geo-category queries), category browse in
 * search (`discoverEventsByCategory`), the sitemap and the pickers.
 *
 * No search reindex is queued, and none is needed in either direction. An
 * event's search document carries its category's slug as a tag whatever
 * `active` is (the full rebuild and the incremental path agree on that), and
 * `discoverEventsByCategory` reads `active` from the database on every
 * request, so a switch shows on the next one.
 *
 * Setting the state the category is already in succeeds without a write or an
 * audit row.
 */
export async function setCategoryActive(
  deps: SetCategoryActiveDeps,
  rawInput: unknown,
): Promise<SetCategoryActiveOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "setCategoryActive" });

  const execute = async (): Promise<SetCategoryActiveOutput> => {
    const input = parseInput(setCategoryActiveInputSchema, rawInput);

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

      if (existing.active === input.active) {
        return { category: toCategoryOutput(existing) };
      }

      const updated = await tx.categories.setActive(existing.id, input.active);
      if (!updated) {
        // Lost a race with a deleter: treat as not_found.
        throw fail("CATEGORY_NOT_FOUND");
      }

      await tx.audit.log({
        entity: "category",
        entityId: updated.id,
        action: updated.active
          ? "category.reactivated"
          : "category.deactivated",
        data: {
          actorHumanId: input.actorHumanId,
          slug: updated.slug,
          name: updated.name,
          previousActive: existing.active,
          active: updated.active,
        },
        at: deps.clock.now(),
      });

      return { category: toCategoryOutput(updated) };
    });

    return setCategoryActiveOutputSchema.parse(result);
  };

  if (scopedLogger) {
    return scopedLogger.withTime("setCategoryActive", execute);
  }

  return execute();
}
