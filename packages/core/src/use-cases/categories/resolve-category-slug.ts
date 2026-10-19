import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import { CATEGORY_NAME_LOCALES, categorySlugIssue } from "@th/types";
import type { CategoryNameLocale } from "@th/types";

import { parseInput } from "../../lib/io";

export const resolveCategorySlugInputSchema = z
  .object({
    locale: z.enum(CATEGORY_NAME_LOCALES),
    // Generous bound: anything longer than a slug is a miss, decided below
    // without a query. Bounded so a crafted URL cannot be arbitrarily big.
    slug: z.string().max(200),
  })
  .strict();

export const resolveCategorySlugOutputSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("render"),
      categoryId: z.string(),
      locale: z.enum(CATEGORY_NAME_LOCALES),
      slug: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("redirect"),
      locale: z.enum(CATEGORY_NAME_LOCALES),
      slug: z.string(),
    })
    .strict(),
  z.object({ kind: z.literal("notFound") }).strict(),
]);

export type ResolveCategorySlugInput = z.infer<
  typeof resolveCategorySlugInputSchema
>;
export type ResolveCategorySlugOutput = z.infer<
  typeof resolveCategorySlugOutputSchema
>;

export type ResolveCategorySlugDeps = {
  repos: Pick<Repos, "categories">;
  logger?: LoggerPort;
};

const NOT_FOUND = { kind: "notFound" } as const;

/**
 * Which category page a URL slug names, in the URL's language
 * (spanish-seo FR-010, R16). Public, read-only, no auth.
 *
 * The slug is trimmed and lowercased first; one that breaks the slug rules
 * (`categorySlugIssue`) is not found without a query. Then:
 *
 *  1. (locale, slug) is a current row: render it.
 *  2. It is an old row: redirect to that category's page slug in the same
 *     locale (an old URL 308s; R14).
 *  3. A miss in this locale. For en, a category whose `Category.slug` is
 *     the slug (written before CategorySlug, no en row yet) is an
 *     in-language hit. Otherwise the categories holding the slug in another
 *     locale (rows, or `Category.slug` as English). Exactly one: redirect to its page slug in the
 *     REQUESTED locale (or render, when that page slug is the one asked
 *     for, see below). None, or two or more: not found (R16: only an
 *     unambiguous match moves).
 *
 * A redirect's `locale` is always the requested one: the URL's path family
 * stays, and the web maps (locale, slug) to a path.
 *
 * The page slug of a category in a locale is its current slug there. A
 * category with NO current es slug (it never had a Spanish name) still has
 * an /es/ page (R9: it renders, noindex), and that page lives at its current
 * ENGLISH slug, so the URL is stable: /es/…/<current en slug> renders, and an
 * old English slug under /es/ redirects to it. Step 3 is what reaches it,
 * since there is no es row to hit. An English page whose category has no en
 * row yet (written by an API older than CategorySlug, before the backfill)
 * lives at `Category.slug`.
 *
 * `active` is not checked: this answers what the slug names, and the page
 * decides what an inactive category shows (today it 404s).
 */
export async function resolveCategorySlug(
  deps: ResolveCategorySlugDeps,
  rawInput: unknown,
): Promise<ResolveCategorySlugOutput> {
  const input = parseInput(resolveCategorySlugInputSchema, rawInput);
  const locale = input.locale;
  const slug = input.slug.trim().toLowerCase();
  if (categorySlugIssue(slug) !== null) {
    return NOT_FOUND;
  }

  const categories = deps.repos.categories;

  const row = await categories.findSlug(locale, slug);
  if (row) {
    if (row.isCurrent) {
      return { kind: "render", categoryId: row.categoryId, locale, slug };
    }
    return toPage(deps, row.categoryId, locale, slug);
  }

  const [rows, legacy] = await Promise.all([
    categories.findSlugsBySlug(slug),
    categories.getBySlug(slug),
  ]);
  // `Category.slug` IS the English slug: for en it is an in-language hit
  // (a category written before CategorySlug, with no en row yet). This
  // fallback, and the one in `pageSlugOf`, can go once the prod backfill
  // (ensureAllCategorySlugs) has run.
  if (legacy && locale === "en") {
    return toPage(deps, legacy.id, locale, slug);
  }
  const ids = new Set(rows.map((r) => r.categoryId));
  if (legacy) ids.add(legacy.id);
  if (ids.size !== 1) {
    return NOT_FOUND;
  }
  const [categoryId] = ids;
  return toPage(deps, categoryId!, locale, slug);
}

/** Render when `slug` is the category's page slug in `locale`, else 308. */
async function toPage(
  deps: ResolveCategorySlugDeps,
  categoryId: string,
  locale: CategoryNameLocale,
  slug: string,
): Promise<ResolveCategorySlugOutput> {
  const pageSlug = await pageSlugOf(deps, categoryId, locale);
  if (pageSlug === null) {
    return NOT_FOUND;
  }
  if (pageSlug === slug) {
    return { kind: "render", categoryId, locale, slug };
  }
  return { kind: "redirect", locale, slug: pageSlug };
}

/** See the docstring of {@link resolveCategorySlug}: "page slug". */
async function pageSlugOf(
  deps: ResolveCategorySlugDeps,
  categoryId: string,
  locale: CategoryNameLocale,
): Promise<string | null> {
  const rows = await deps.repos.categories.listSlugs(categoryId);
  const current = (l: CategoryNameLocale) =>
    rows.find((r) => r.locale === l && r.isCurrent)?.slug ?? null;

  const inLocale = current(locale);
  if (inLocale !== null) return inLocale;

  const en = current("en");
  if (en !== null) return en;

  // No en row yet: the category predates CategorySlug. Removable after the
  // prod backfill, like the getBySlug fallback above.
  const category = await deps.repos.categories.getById(categoryId);
  return category?.slug ?? null;
}
