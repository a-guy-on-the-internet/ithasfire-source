import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { requirePlatformStaff } from "../../lib/rbac";
import { fail } from "@th/errors";
import { markForSearchReindex } from "../search/search-reindex-marks";
import {
  applyCategoryTranslationChanges,
  assertCategoryTranslationsFree,
  categoryTranslationsInputSchema,
  normalizeCategoryTranslationChanges,
  sameCategoryTranslations,
} from "./_shared/category-naming";
import {
  categoryOutputSchema,
  toCategoryOutput,
} from "./_shared/category-output";
import {
  ensureCategorySlugs,
  reportEnSlugConflict,
} from "./ensure-category-slugs";

export const setCategoryTranslationsInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    categoryId: z.uuid(),
    // Per locale: a name sets it, `null` or blank clears it, an absent key
    // leaves it as it is.
    translations: categoryTranslationsInputSchema,
  })
  .strict();

export const setCategoryTranslationsOutputSchema = z
  .object({ category: categoryOutputSchema })
  .strict();

export type SetCategoryTranslationsInput = z.infer<
  typeof setCategoryTranslationsInputSchema
>;
export type SetCategoryTranslationsOutput = z.infer<
  typeof setCategoryTranslationsOutputSchema
>;

export type SetCategoryTranslationsDeps = {
  repos: Repos;
  authz: AuthZPort;
  clock: ClockPort;
  logger?: LoggerPort;
  /** Told when the category's en slug could not be recorded (a conflict). */
  reportError?: ReporterPort;
};

/**
 * Set, change or clear a category's non-English names
 * (category-translations FR-004). Platform ADMIN / DEVELOPER only, the same
 * level as renaming it.
 *
 * English (`name`) and the English slug are untouched. The first Spanish
 * name a category gets also makes its current es slug (spanish-seo FR-008,
 * via `ensureCategorySlugs`); changing or clearing it never moves or frees
 * that slug (R14, R20). Each translated name obeys the
 * same word rules as an English one (`normalizeAndValidateCategoryName`) and
 * is unique within its language, without case, across every other category
 * (`assertCategoryTranslationsFree`), refused with `CATEGORY_ALREADY_EXISTS`.
 * No index backs that rule, so the transaction takes `categories.lockNaming()`
 * before it reads, like every other name writer.
 *
 * A change writes one `category.translations_set` audit row and marks every
 * published event in the category for search reindex (the documents carry its
 * names). A request that changes nothing writes nothing and returns the
 * category as it is.
 */
export async function setCategoryTranslations(
  deps: SetCategoryTranslationsDeps,
  rawInput: unknown,
): Promise<SetCategoryTranslationsOutput> {
  const scopedLogger = deps.logger?.child({
    useCase: "setCategoryTranslations",
  });

  const execute = async (): Promise<SetCategoryTranslationsOutput> => {
    const input = parseInput(setCategoryTranslationsInputSchema, rawInput);

    await requirePlatformStaff({
      authz: deps.authz,
      actorHumanId: input.actorHumanId,
      roles: ["ADMIN", "DEVELOPER"],
    });

    // Throws INVALID_CATEGORY_REQUEST_NAME for a name that breaks the rules.
    const changes = normalizeCategoryTranslationChanges(input.translations);

    const result = await deps.repos.tx(async (tx) => {
      // First statement, before any read: serialises this write with every
      // other writer of a category name (create, rename, approve).
      await tx.categories.lockNaming();

      const existing = await tx.categories.getById(input.categoryId);
      if (!existing) {
        throw fail("CATEGORY_NOT_FOUND");
      }

      const previous = existing.nameTranslations ?? {};
      const next = applyCategoryTranslationChanges(previous, changes);
      if (sameCategoryTranslations(previous, next)) {
        return { category: toCategoryOutput(existing) };
      }

      assertCategoryTranslationsFree(
        await tx.categories.listAll(),
        next,
        existing.id,
      );

      const updated = await tx.categories.setNameTranslations(existing.id, next);
      if (!updated) {
        // Lost a race with a deleter: treat as not_found.
        throw fail("CATEGORY_NOT_FOUND");
      }

      // A first Spanish name makes the category's es slug (FR-008). A later
      // rename never moves it, and clearing the name keeps it (R20): the
      // helper only writes when the category has no es row at all.
      const ensured = await ensureCategorySlugs(tx, updated);
      if (ensured.enConflict) {
        reportEnSlugConflict(
          deps.reportError,
          "setCategoryTranslations",
          updated,
        );
      }
      const ensuredSlugs = ensured.written.map((row) => ({
        locale: row.locale,
        slug: row.slug,
      }));

      const now = deps.clock.now();
      await tx.audit.log({
        entity: "category",
        entityId: updated.id,
        action: "category.translations_set",
        data: {
          actorHumanId: input.actorHumanId,
          slug: updated.slug,
          previousNameTranslations: previous,
          nameTranslations: updated.nameTranslations,
          ...(ensuredSlugs.length > 0 ? { ensuredSlugs } : {}),
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

    return setCategoryTranslationsOutputSchema.parse(result);
  };

  if (scopedLogger) {
    return scopedLogger.withTime("setCategoryTranslations", execute);
  }

  return execute();
}
