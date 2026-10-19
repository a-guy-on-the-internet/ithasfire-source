import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import { CATEGORY_NAME_LOCALES, categorySlugIssue } from "@th/types";

import { parseInput } from "../../lib/io";
import { requirePlatformStaff } from "../../lib/rbac";
import { fail } from "@th/errors";
import { isUniqueViolation } from "../places/_shared/claim";
import { markForSearchReindex } from "../search/search-reindex-marks";
import {
  ensureCategorySlugs,
  reportEnSlugConflict,
} from "./ensure-category-slugs";

export const changeCategorySlugInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    categoryId: z.uuid(),
    locale: z.enum(CATEGORY_NAME_LOCALES),
    // Bounded at the boundary; trimmed and lowercased, then held to the slug
    // rules (`categorySlugIssue`) in the use case.
    newSlug: z.string().max(200),
  })
  .strict();

export const changeCategorySlugOutputSchema = z
  .object({
    categoryId: z.string(),
    locale: z.enum(CATEGORY_NAME_LOCALES),
    currentSlug: z.string(),
    /** The category's other slugs in this locale, newest first; they 308. */
    oldSlugs: z.array(z.string()),
  })
  .strict();

export type ChangeCategorySlugInput = z.infer<
  typeof changeCategorySlugInputSchema
>;
export type ChangeCategorySlugOutput = z.infer<
  typeof changeCategorySlugOutputSchema
>;

export type ChangeCategorySlugDeps = {
  repos: Repos;
  authz: AuthZPort;
  clock: ClockPort;
  logger?: LoggerPort;
  /** Told when the category's en slug could not be recorded (a conflict). */
  reportError?: ReporterPort;
};

/**
 * Deliberately change a category's URL in one language (spanish-seo FR-009,
 * R14). Platform ADMIN / DEVELOPER only, the same level as renaming it.
 *
 * The new slug is trimmed, lowercased and held to the slug rules
 * (`categorySlugIssue`), refused with `INVALID_CATEGORY_SLUG`. Inside the
 * transaction, after `categories.lockNaming()` (which keeps one current row
 * per category and locale):
 *
 *  1. `ensureCategorySlugs` runs first, so a category with no en row yet
 *     records its old `Category.slug` and that URL keeps redirecting;
 *  2. `setCurrentSlug` makes the new slug current and keeps the old row,
 *     which now 308s. Changing back to one of the category's own old slugs
 *     is allowed. A slug ANOTHER category holds in any language, current
 *     or old, is refused with `CATEGORY_SLUG_TAKEN`: a slug string names one
 *     category, and an old URL is never taken over (R14). The category's own
 *     slug in the other language is allowed. For en, `Category.slug` moves
 *     with it.
 *
 * When the category's en slug cannot be recorded (`ensureCategorySlugs`
 * reports a conflict) the change still goes ahead and the conflict goes to
 * `reportError`.
 *
 * A real change writes one `category.slug_changed` audit row (locale, from,
 * to). An English change also marks every published event in the category
 * for search reindex (the documents tag the category by its English slug);
 * a Spanish one does not. Asking for the slug that is already current
 * writes nothing and returns the slugs as they are.
 *
 * The unique (locale, slug) index is the backstop; its violation maps to
 * `CATEGORY_SLUG_TAKEN` outside the transaction.
 */
export async function changeCategorySlug(
  deps: ChangeCategorySlugDeps,
  rawInput: unknown,
): Promise<ChangeCategorySlugOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "changeCategorySlug" });

  const execute = async (): Promise<ChangeCategorySlugOutput> => {
    const input = parseInput(changeCategorySlugInputSchema, rawInput);

    await requirePlatformStaff({
      authz: deps.authz,
      actorHumanId: input.actorHumanId,
      roles: ["ADMIN", "DEVELOPER"],
    });

    const newSlug = input.newSlug.trim().toLowerCase();
    const issue = categorySlugIssue(newSlug);
    if (issue !== null) {
      throw fail("INVALID_CATEGORY_SLUG", { meta: { issue } });
    }
    const locale = input.locale;

    const runTx = () =>
      deps.repos.tx(async (tx) => {
        // First statement, before any read (see the docstring).
        await tx.categories.lockNaming();

        const category = await tx.categories.getById(input.categoryId);
        if (!category) {
          throw fail("CATEGORY_NOT_FOUND");
        }

        const ensured = await ensureCategorySlugs(tx, category);
        if (ensured.enConflict) {
          reportEnSlugConflict(
            deps.reportError,
            "changeCategorySlug",
            category,
          );
        }
        const ensuredSlugs = ensured.written.map((row) => ({
          locale: row.locale,
          slug: row.slug,
        }));

        const before = await tx.categories.listSlugs(category.id);
        const previous =
          before.find((row) => row.locale === locale && row.isCurrent)?.slug ??
          null;

        if (previous !== newSlug) {
          const result = await tx.categories.setCurrentSlug({
            categoryId: category.id,
            locale,
            slug: newSlug,
          });
          if (!result.ok) {
            throw fail("CATEGORY_SLUG_TAKEN", { meta: { locale } });
          }

          const now = deps.clock.now();
          await tx.audit.log({
            entity: "category",
            entityId: category.id,
            action: "category.slug_changed",
            data: {
              actorHumanId: input.actorHumanId,
              locale,
              previousSlug: previous,
              slug: newSlug,
              // Rows `ensureCategorySlugs` recorded first (a repair).
              ...(ensuredSlugs.length > 0 ? { ensuredSlugs } : {}),
            },
            at: now,
          });

          if (locale === "en") {
            // Search documents tag the category by its English slug.
            const eventIds = await tx.categories.listPublishedEventIds(
              category.id,
            );
            await markForSearchReindex(
              tx,
              eventIds.map((id) => ({ kind: "event" as const, id })),
              now,
            );
          }
        } else if (ensuredSlugs.length > 0) {
          // No change asked for, but the repair wrote rows: record them.
          await tx.audit.log({
            entity: "category",
            entityId: category.id,
            action: "category.slugs_ensured",
            data: { actorHumanId: input.actorHumanId, slugs: ensuredSlugs },
            at: deps.clock.now(),
          });
        }

        const after = await tx.categories.listSlugs(category.id);
        const inLocale = after.filter((row) => row.locale === locale);
        return {
          categoryId: category.id,
          locale,
          currentSlug: inLocale.find((row) => row.isCurrent)?.slug ?? newSlug,
          oldSlugs: inLocale
            .filter((row) => !row.isCurrent)
            .map((row) => row.slug),
        };
      });

    let result: Awaited<ReturnType<typeof runTx>>;
    try {
      result = await runTx();
    } catch (err) {
      // Lost a race the lock did not cover (a writer outside the use cases):
      // the unique (locale, slug) or Category.slug index refused the write.
      // Translated here, outside the transaction the violation aborted; this
      // rethrows, it does not fall back. The audit row and the reindex marks
      // use fresh ids.
      if (isUniqueViolation(err)) {
        throw fail("CATEGORY_SLUG_TAKEN", { cause: err, meta: { locale } });
      }
      throw err;
    }

    return changeCategorySlugOutputSchema.parse(result);
  };

  if (scopedLogger) {
    return scopedLogger.withTime("changeCategorySlug", execute);
  }

  return execute();
}
