import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { requirePlatformStaff } from "../../lib/rbac";
import { fail } from "@th/errors";
import { isUniqueViolation } from "../places/_shared/claim";
import { markForSearchReindex } from "../search/search-reindex-marks";
import {
  assertCategoryNamingFree,
  categoryNameInputSchema,
  normalizeAndValidateCategoryName,
  slugifyCategoryName,
} from "./_shared/category-naming";
import {
  categoryOutputSchema,
  toCategoryOutput,
} from "./_shared/category-output";

export const renameCategoryInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    categoryId: z.uuid(),
    // Sanitised and bounded at the boundary, then normalised with the same
    // functions the create and request paths use.
    name: categoryNameInputSchema,
  })
  .strict();

export const renameCategoryOutputSchema = z
  .object({ category: categoryOutputSchema })
  .strict();

export type RenameCategoryInput = z.infer<typeof renameCategoryInputSchema>;
export type RenameCategoryOutput = z.infer<typeof renameCategoryOutputSchema>;

export type RenameCategoryDeps = {
  repos: Repos;
  authz: AuthZPort;
  clock: ClockPort;
  logger?: LoggerPort;
};

/**
 * Change a category's display name. Platform ADMIN / DEVELOPER only, the same
 * level as creating or deleting one.
 *
 * THE SLUG DOES NOT CHANGE. Category URLs, sitemap entries and the category
 * tag on event search documents key on the slug, so a rename never moves a
 * page. The new name must still be one the shared rules can slug (so the
 * same names are acceptable on every path), but the slug it would derive is
 * only compared, never stored.
 *
 * Event search documents carry the category's NAMES as a searchable field
 * (category-translations FR-008), so a real rename marks every published
 * event in the category for reindex, in the rename's transaction.
 *
 * Refused with `CATEGORY_ALREADY_EXISTS` by the one rule every naming path
 * shares (`assertCategoryNamingFree`): when ANOTHER category carries the name
 * (case-insensitively), when another category's slug is the one the new name
 * would derive (otherwise "Jazz" could be renamed to "Music" beside a category
 * whose slug is `music`, and two categories would answer to the same word), or
 * when another category's current name derives that slug. A change to the case
 * of its own name is allowed.
 *
 * The transaction takes `categories.lockNaming()` before it reads, so a
 * concurrent rename, create or approval waits and then sees this one's result
 * (the unique index on `Category.name` is case-sensitive and cannot refuse
 * "Live Music" beside "live music" by itself). That index remains as the
 * backstop, and its violation is mapped to the same code outside the
 * transaction. This is the only lock a rename takes.
 *
 * Renaming to the name the category already has succeeds without a write or
 * an audit row.
 */
export async function renameCategory(
  deps: RenameCategoryDeps,
  rawInput: unknown,
): Promise<RenameCategoryOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "renameCategory" });

  const execute = async (): Promise<RenameCategoryOutput> => {
    const input = parseInput(renameCategoryInputSchema, rawInput);

    await requirePlatformStaff({
      authz: deps.authz,
      actorHumanId: input.actorHumanId,
      roles: ["ADMIN", "DEVELOPER"],
    });

    const name = normalizeAndValidateCategoryName(input.name);
    // Throws INVALID_CATEGORY_REQUEST_NAME for a name that cannot be slugged.
    const derivedSlug = slugifyCategoryName(name);

    const runTx = () =>
      deps.repos.tx(async (tx) => {
        // First statement, before any read: serialises this rename with every
        // other writer of a category name (create, approve, another rename).
        await tx.categories.lockNaming();

        const existing = await tx.categories.getById(input.categoryId);
        if (!existing) {
          throw fail("CATEGORY_NOT_FOUND");
        }

        if (existing.name === name) {
          return { category: toCategoryOutput(existing) };
        }

        assertCategoryNamingFree(
          await tx.categories.listAll(),
          { name, slug: derivedSlug },
          existing.id,
        );

        const updated = await tx.categories.rename(existing.id, name);
        if (!updated) {
          // Lost a race with a deleter: treat as not_found.
          throw fail("CATEGORY_NOT_FOUND");
        }

        const now = deps.clock.now();
        await tx.audit.log({
          entity: "category",
          entityId: updated.id,
          action: "category.renamed",
          data: {
            actorHumanId: input.actorHumanId,
            slug: updated.slug,
            previousName: existing.name,
            name: updated.name,
          },
          at: now,
        });

        // The documents carry the category's names; refresh them.
        const eventIds = await tx.categories.listPublishedEventIds(updated.id);
        await markForSearchReindex(
          tx,
          eventIds.map((id) => ({ kind: "event" as const, id })),
          now,
        );

        return { category: toCategoryOutput(updated) };
      });

    let result: Awaited<ReturnType<typeof runTx>>;
    try {
      result = await runTx();
    } catch (err) {
      // Lost a race with another rename or a creation: the unique index on
      // the name refused the update. Translated here, outside the transaction
      // the violation aborted; this rethrows, it does not fall back. The
      // audit row uses a fresh id, so the rename is the only statement in the
      // transaction that can raise it.
      if (isUniqueViolation(err)) {
        throw fail("CATEGORY_ALREADY_EXISTS", { cause: err });
      }
      throw err;
    }

    return renameCategoryOutputSchema.parse(result);
  };

  if (scopedLogger) {
    return scopedLogger.withTime("renameCategory", execute);
  }

  return execute();
}
