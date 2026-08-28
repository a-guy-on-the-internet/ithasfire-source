import type { PrismaClient } from "@prisma/client";
import { SEED_CATEGORIES, SEED_TAG_GENRES } from "./fixtures.js";

/**
 * Upsert the curated genre tag list. Idempotent on slug.
 *
 * Tags replace what used to be per-category sub-categories ("event types"):
 * an event can carry multiple tags (rock + indie + folk for a single show)
 * without needing per-category enums or an admin approval pipeline.
 *
 * Pass `{ platformOnly: true }` to install only the tags whose owning
 * category ships to prod — mirroring the `ensureCategories` withholding.
 * Categories flagged `platformDefault: false` in `SEED_CATEGORIES` (currently
 * `support-recovery`) stay out of fresh prod deploys, so their tags do too.
 * Deriving the withheld set from `SEED_CATEGORIES` keeps it automatic if more
 * categories get withheld later.
 */
export const ensureGenreTags = async (
  prisma: PrismaClient,
  options: { platformOnly?: boolean } = {},
): Promise<Record<string, string>> => {
  const withheld = new Set(
    SEED_CATEGORIES.filter((cat) => cat.platformDefault === false).map(
      (cat) => cat.slug,
    ),
  );
  // The withheld filter operates per-row on `categorySlug`: it drops only the
  // genre rows whose *owning* category is withheld. A generic slug like
  // "other" belongs to several platform-default categories too, so it survives
  // even when the support-recovery group is filtered out. That overlap is
  // intentional (the same tag is shared across categories), not a leak.
  const filtered = options.platformOnly
    ? SEED_TAG_GENRES.filter((genre) => !withheld.has(genre.categorySlug))
    : SEED_TAG_GENRES;
  // SEED_TAG_GENRES intentionally repeats slugs across categories (e.g. "other",
  // "music") — Tag.slug is unique, so collapse to one upsert per slug to avoid
  // concurrent upserts racing on the same row (P2002 / deadlock on first insert
  // against an empty prod Tag table). Preserve order, first-occurrence wins;
  // names for a given slug are identical, so this is deterministic and lossless.
  const bySlug = new Map<string, (typeof SEED_TAG_GENRES)[number]>();
  for (const genre of filtered) {
    if (!bySlug.has(genre.slug)) bySlug.set(genre.slug, genre);
  }
  const source = [...bySlug.values()];
  const rows = await Promise.all(
    source.map((genre) =>
      prisma.tag.upsert({
        where: { slug: genre.slug },
        update: { name: genre.name },
        create: { slug: genre.slug, name: genre.name },
        select: { id: true, slug: true },
      }),
    ),
  );
  return Object.fromEntries(
    rows.map((r: { slug: string; id: string }) => [r.slug, r.id]),
  );
};
