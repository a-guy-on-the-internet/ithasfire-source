import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { CATEGORY_NAME_LOCALES } from "@th/types";

import { parseInput } from "../../lib/io";
import { requirePlatformStaff } from "../../lib/rbac";
import {
  categoryOutputSchema,
  toCategoryOutput,
} from "./_shared/category-output";

export const listAllCategoriesInputSchema = z
  .object({ actorHumanId: z.uuid() })
  .strict();

/** One URL slug of a category in one language (the staff list). */
export const categoryUrlSchema = z
  .object({
    locale: z.enum(CATEGORY_NAME_LOCALES),
    slug: z.string(),
    /** The page's own slug; a non-current one redirects (308) to it. */
    isCurrent: z.boolean(),
  })
  .strict();

export const listAllCategoriesOutputSchema = z
  .object({
    categories: z.array(
      categoryOutputSchema.extend({
        /**
         * Every slug row: current first, then locale, then slug. Empty for a category written before CategorySlug and not
         * yet backfilled.
         */
        urls: z.array(categoryUrlSchema),
      }),
    ),
  })
  .strict();

export type ListAllCategoriesInput = z.infer<
  typeof listAllCategoriesInputSchema
>;
export type ListAllCategoriesOutput = z.infer<
  typeof listAllCategoriesOutputSchema
>;

export type ListAllCategoriesDeps = {
  repos: Pick<Repos, "categories">;
  authz: AuthZPort;
  logger?: LoggerPort;
};

/**
 * Every category, inactive ones included, ordered by `sortOrder` then name.
 * Platform staff only: ADMIN and DEVELOPER manage the list, and REVIEWERs
 * read it on the same platform page where they review category requests.
 *
 * The public `listCategories` (active only) is the list for everyone else.
 */
export async function listAllCategories(
  deps: ListAllCategoriesDeps,
  rawInput: unknown,
): Promise<ListAllCategoriesOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "listAllCategories" });

  const execute = async (): Promise<ListAllCategoriesOutput> => {
    const input = parseInput(listAllCategoriesInputSchema, rawInput);

    await requirePlatformStaff({
      authz: deps.authz,
      actorHumanId: input.actorHumanId,
      roles: ["ADMIN", "REVIEWER", "DEVELOPER"],
    });

    // Two reads, not one per category: the slug rows come back together and
    // are grouped here.
    const [categories, slugRows] = await Promise.all([
      deps.repos.categories.listAll(),
      deps.repos.categories.listAllSlugs(),
    ]);
    const urlsByCategory = new Map<
      string,
      z.infer<typeof categoryUrlSchema>[]
    >();
    for (const row of slugRows) {
      const urls = urlsByCategory.get(row.categoryId) ?? [];
      urls.push({
        locale: row.locale,
        slug: row.slug,
        isCurrent: row.isCurrent,
      });
      urlsByCategory.set(row.categoryId, urls);
    }
    // The adapter already orders this way; sorted again here so the contract
    // does not depend on which adapter is behind the port. Code-point compare
    // on the name: a stable tiebreak, not a locale-aware one.
    const sorted = [...categories].sort(
      (a, b) =>
        a.sortOrder - b.sortOrder ||
        (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    );

    // Current first, then locale, then slug: not the adapter's order.
    for (const urls of urlsByCategory.values()) {
      urls.sort(
        (a, b) =>
          Number(b.isCurrent) - Number(a.isCurrent) ||
          (a.locale < b.locale ? -1 : a.locale > b.locale ? 1 : 0) ||
          (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0),
      );
    }

    return listAllCategoriesOutputSchema.parse({
      categories: sorted.map((record) => ({
        ...toCategoryOutput(record),
        urls: urlsByCategory.get(record.id) ?? [],
      })),
    });
  };

  if (scopedLogger) {
    return scopedLogger.withTime("listAllCategories", execute);
  }

  return execute();
}
