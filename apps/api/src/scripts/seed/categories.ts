import type { PrismaClient } from "@prisma/client";
import { SEED_CATEGORIES } from "./fixtures.js";

/** Names compare without case, as the category use cases compare them. */
const nameKey = (name: string): string => name.normalize("NFKC").toLowerCase();

/**
 * Install the category fixtures that are MISSING and return a slug->id map.
 *
 * Create-only. Once a category exists it belongs to platform staff, who
 * rename, deactivate, reorder and retune it on /platform, and this runs on
 * every deploy: a re-seed that wrote the fixture's name, `active` or
 * `sortOrder` back would undo their work with no audit row.
 *
 * A fixture whose slug is missing but whose name already belongs to another
 * category (staff renamed one, or created one, under that name) is skipped
 * with a warning: `Category.name` is unique, so inserting it would fail the
 * deploy. Its slug is then absent from the returned map.
 *
 * A fixture whose slug is an English slug row of some category, current or
 * old, is that category: staff changed its URL on /platform, and the old
 * slug stays reserved for it (it 308s). It is not upserted (inserting its
 * en row would hit the unique (locale, slug) and fail the deploy) and maps
 * to that category's id, so dev-seed events filed under the fixture's slug
 * land in the category its URL leads to.
 *
 * Pass `{ translations: true }` (the dev seed only) to write each fixture's
 * Spanish name into `nameTranslations` on CREATE. Never from the deploy-time
 * bootstrap: prod staff enter translations on /platform, through the use case
 * that audits and reindexes them. Existing rows are never touched.
 *
 * Pass `{ platformOnly: true }` to install only the entries flagged
 * `platformDefault !== false` in `SEED_CATEGORIES` — that's what the
 * production platform-categories bootstrap runs, leaving sensitive /
 * moderation-heavy slugs out of fresh prod deploys.
 */
export const ensureCategories = async (
  prisma: PrismaClient,
  options: { platformOnly?: boolean; translations?: boolean } = {},
): Promise<Record<string, string>> => {
  const source = options.platformOnly
    ? SEED_CATEGORIES.filter((cat) => cat.platformDefault !== false)
    : SEED_CATEGORIES;

  const [existing, enSlugRows] = await Promise.all([
    prisma.category.findMany({ select: { slug: true, name: true } }),
    prisma.categorySlug.findMany({
      where: { locale: "en" },
      select: { slug: true, categoryId: true },
    }),
  ]);
  const categoryIdByEnSlug = new Map(
    enSlugRows.map((row) => [row.slug, row.categoryId]),
  );
  // Fixtures already present under an en slug row (current or old).
  const present: Record<string, string> = {};
  const existingSlugs = new Set(existing.map((row) => row.slug));
  const slugByNameKey = new Map(
    existing.map((row) => [nameKey(row.name), row.slug]),
  );

  const installable = source.filter((cat) => {
    const owner = categoryIdByEnSlug.get(cat.slug);
    if (owner !== undefined) {
      present[cat.slug] = owner;
      return false;
    }
    // A row with no en slug row yet (written before CategorySlug existed):
    // the empty-update upsert below returns its id and changes nothing.
    if (existingSlugs.has(cat.slug)) return true;
    const holder = slugByNameKey.get(nameKey(cat.name));
    if (holder === undefined) return true;
    console.warn(
      `[categories-seed] Skipped fixture "${cat.slug}": its name "${cat.name}" already belongs to category "${holder}". Rename that category or create "${cat.slug}" by hand if both are wanted.`,
    );
    return false;
  });

  const rows = await Promise.all(
    installable.map((cat) =>
      prisma.category.upsert({
        where: { slug: cat.slug },
        // Empty on purpose: an existing row is staff-managed (name, active,
        // sortOrder, seoType, nameTranslations), so a re-seed changes nothing
        // on it. The upsert is kept, instead of a plain create, so a row that
        // appears between the read above and this statement is left alone too.
        update: {},
        create: {
          slug: cat.slug,
          name: cat.name,
          ...(options.translations
            ? { nameTranslations: { es: cat.es } }
            : {}),
          active: true,
          sortOrder: cat.sortOrder,
          seoType: cat.seoType ?? "Event",
          // Every category has its current English slug row.
          slugs: { create: { locale: "en", slug: cat.slug, isCurrent: true } },
        },
        select: { id: true, slug: true },
      }),
    ),
  );
  return {
    ...present,
    ...Object.fromEntries(
      rows.map((r: { slug: string; id: string }) => [r.slug, r.id]),
    ),
  };
};
