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

/** Far above any real taxonomy; bounds the payload at the boundary. */
const MAX_REORDER_IDS = 1000;

export const reorderCategoriesInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    /** Every category id (active and inactive), each once, in the new order. */
    orderedCategoryIds: z.array(z.uuid()).max(MAX_REORDER_IDS),
  })
  .strict();

export const reorderCategoriesOutputSchema = z
  .object({ categories: z.array(categoryOutputSchema) })
  .strict();

export type ReorderCategoriesInput = z.infer<
  typeof reorderCategoriesInputSchema
>;
export type ReorderCategoriesOutput = z.infer<
  typeof reorderCategoriesOutputSchema
>;

export type ReorderCategoriesDeps = {
  repos: Repos;
  authz: AuthZPort;
  clock: ClockPort;
  logger?: LoggerPort;
};

/**
 * Put the categories in a new order. Platform ADMIN / DEVELOPER only.
 *
 * `orderedCategoryIds` must name exactly the categories that exist now,
 * inactive ones included, each once. Anything else is refused with
 * `INVALID_INPUT` and nothing is written; `meta.reason` says which rule broke
 * (`duplicate_id`, `unknown_id`, `missing_id`) and `meta.ids` which ids. So a
 * client holding a list from before a category was created cannot bury the
 * new one or leave a gap: it has to read the list again.
 *
 * `sortOrder` becomes 1..n in the given order. Only rows whose value changes
 * are written. When nothing changes there is no write and no audit row.
 *
 * Reorders are serialised: the transaction takes `categories.lockSortOrder`
 * before it reads the list, so of two admins reordering at once the second
 * waits, then validates against and renumbers the first one's result. Without
 * it both would read the same starting order and, each writing only the rows
 * it thinks changed, leave a mix of the two orders.
 *
 * One audit row for the whole change: `entity: "category"` with a null
 * `entityId` (the change belongs to the list, not to one row; same shape as
 * `saved_snippets.reordered`), carrying the id order before and after.
 */
export async function reorderCategories(
  deps: ReorderCategoriesDeps,
  rawInput: unknown,
): Promise<ReorderCategoriesOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "reorderCategories" });

  const execute = async (): Promise<ReorderCategoriesOutput> => {
    const input = parseInput(reorderCategoriesInputSchema, rawInput);

    await requirePlatformStaff({
      authz: deps.authz,
      actorHumanId: input.actorHumanId,
      roles: ["ADMIN", "DEVELOPER"],
    });

    const orderedIds = input.orderedCategoryIds;
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const id of orderedIds) {
      if (seen.has(id)) duplicates.add(id);
      seen.add(id);
    }
    if (duplicates.size > 0) {
      throw refuse("duplicate_id", [...duplicates]);
    }

    const result = await deps.repos.tx(async (tx) => {
      await tx.categories.lockSortOrder();

      const existing = await tx.categories.listAll();
      const byId = new Map(existing.map((category) => [category.id, category]));

      const unknown = orderedIds.filter((id) => !byId.has(id));
      if (unknown.length > 0) {
        throw refuse("unknown_id", unknown);
      }
      const missing = existing
        .filter((category) => !seen.has(category.id))
        .map((category) => category.id);
      if (missing.length > 0) {
        throw refuse("missing_id", missing);
      }

      const reordered = orderedIds.map((id, index) => ({
        record: byId.get(id)!,
        sortOrder: index + 1,
      }));
      const changes = reordered
        .filter(({ record, sortOrder }) => record.sortOrder !== sortOrder)
        .map(({ record, sortOrder }) => ({ id: record.id, sortOrder }));

      const categories = reordered.map(({ record, sortOrder }) =>
        toCategoryOutput({ ...record, sortOrder }),
      );

      if (changes.length === 0) {
        return { categories };
      }

      const updatedCount = await tx.categories.setSortOrders(changes);
      if (updatedCount !== changes.length) {
        // A category was deleted between the read above and the write (a
        // delete does not take the order lock). Throwing rolls the partial
        // renumbering back; the client reads the list again.
        throw fail("CATEGORY_NOT_FOUND");
      }

      await tx.audit.log({
        entity: "category",
        entityId: null,
        action: "category.reordered",
        data: {
          actorHumanId: input.actorHumanId,
          previousOrderedCategoryIds: existing.map((category) => category.id),
          orderedCategoryIds: orderedIds,
          changedCount: changes.length,
        },
        at: deps.clock.now(),
      });

      return { categories };
    });

    return reorderCategoriesOutputSchema.parse(result);
  };

  if (scopedLogger) {
    return scopedLogger.withTime("reorderCategories", execute);
  }

  return execute();
}

/** How many offending ids a refusal carries; `idCount` has the full number. */
const MAX_REFUSAL_IDS = 20;

function refuse(
  reason: "duplicate_id" | "unknown_id" | "missing_id",
  ids: string[],
) {
  return fail("INVALID_INPUT", {
    meta: {
      field: "orderedCategoryIds",
      reason,
      ids: ids.slice(0, MAX_REFUSAL_IDS),
      idCount: ids.length,
    },
  });
}
