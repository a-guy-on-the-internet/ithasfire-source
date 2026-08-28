import type { PrismaClient } from "@prisma/client";
import { SEED_CATEGORIES } from "./fixtures.js";

/**
 * Upsert the category taxonomy and return a slug->id map.
 *
 * Pass `{ platformOnly: true }` to install only the entries flagged
 * `platformDefault !== false` in `SEED_CATEGORIES` — that's what the
 * production platform-categories bootstrap runs, leaving sensitive /
 * moderation-heavy slugs out of fresh prod deploys.
 */
export const ensureCategories = async (
  prisma: PrismaClient,
  options: { platformOnly?: boolean } = {},
): Promise<Record<string, string>> => {
  const source = options.platformOnly
    ? SEED_CATEGORIES.filter((cat) => cat.platformDefault !== false)
    : SEED_CATEGORIES;
  const rows = await Promise.all(
    source.map((cat) =>
      prisma.category.upsert({
        where: { slug: cat.slug },
        // Deliberately omit `seoType` from the update branch: admins can retune
        // a category's schema.org @type in the platform editor and re-seeding
        // must never clobber that. Only new rows inherit the fixture's seoType.
        update: { name: cat.name, active: true, sortOrder: cat.sortOrder },
        create: {
          slug: cat.slug,
          name: cat.name,
          active: true,
          sortOrder: cat.sortOrder,
          seoType: cat.seoType ?? "Event",
        },
        select: { id: true, slug: true },
      }),
    ),
  );
  return Object.fromEntries(
    rows.map((r: { slug: string; id: string }) => [r.slug, r.id]),
  );
};
