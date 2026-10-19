import type {
  CategoriesRepo,
  CategoryListItem,
  CategoryRecord,
  CategorySlugRecord,
} from "@th/ports/repos/categories";
import { isCategoryNameLocale, parseCategoryNameTranslations } from "@th/types";

import {
  indexableListedEventWhere,
  publicListedEventWhere,
} from "./public-listed-event-where";
import type { PrismaClientOrTx } from "./types";

const CATEGORY_SELECT = {
  id: true,
  slug: true,
  name: true,
  active: true,
  sortOrder: true,
  seoType: true,
  nameTranslations: true,
  createdAt: true,
  updatedAt: true,
} as const;

const mapRecord = (row: any): CategoryRecord => ({
  id: row.id,
  slug: row.slug,
  name: row.name,
  active: row.active,
  sortOrder: row.sortOrder,
  seoType: row.seoType ?? "Event",
  nameTranslations: parseCategoryNameTranslations(row.nameTranslations),
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const mapListItem = (row: any): CategoryListItem => ({
  id: row.id,
  slug: row.slug,
  name: row.name,
  active: row.active,
  sortOrder: row.sortOrder,
  seoType: row.seoType ?? "Event",
  nameTranslations: parseCategoryNameTranslations(row.nameTranslations),
});

/**
 * `null` for a row whose locale is not a supported one (a hand edit, or a
 * locale later removed). Readers filter it out, the way
 * `parseCategoryNameTranslations` drops unknown locales: such a row stays in
 * the table (it still reserves its slug) but never reaches a reader.
 */
const mapSlugRecord = (row: any): CategorySlugRecord | null => {
  if (typeof row.locale !== "string" || !isCategoryNameLocale(row.locale)) {
    return null;
  }
  return {
    categoryId: row.categoryId,
    locale: row.locale,
    slug: row.slug,
    isCurrent: row.isCurrent,
    createdAt: row.createdAt,
  };
};

const mapSlugRecords = (rows: any[]): CategorySlugRecord[] =>
  rows
    .map(mapSlugRecord)
    .filter((row): row is CategorySlugRecord => row !== null);

export function makeCategoriesRepo(p: PrismaClientOrTx): CategoriesRepo {
  return {
    async listActive() {
      const rows = await p.category.findMany({
        where: { active: true },
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
        select: CATEGORY_SELECT,
      });

      return rows.map(mapListItem);
    },

    async listActiveWithUpcomingEvents({ now }) {
      // The category page's own indexability rule (`countIndexableByCategory`
      // builds its `where` from the same helper), so a category in the
      // sitemap is exactly a category whose page is indexable: one with an
      // upcoming listed event that is not gated.
      const rows = await p.category.findMany({
        where: {
          active: true,
          events: {
            some: await indexableListedEventWhere(p, { startsAfter: now }),
          },
        },
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
        select: CATEGORY_SELECT,
      });

      return rows.map(mapListItem);
    },

    async listActiveWithListedEvents({ now }) {
      // The browse rule: what the category page lists (gated events
      // included), not the sitemap's indexable subset above. One category
      // query, independent of the number of categories.
      const rows = await p.category.findMany({
        where: {
          active: true,
          events: {
            some: await publicListedEventWhere(p, { startsAfter: now }),
          },
        },
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
        select: CATEGORY_SELECT,
      });

      return rows.map(mapListItem);
    },

    async listAll() {
      const rows = await p.category.findMany({
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
        select: CATEGORY_SELECT,
      });

      return rows.map(mapRecord);
    },

    async getBySlug(slug) {
      const row = await p.category.findUnique({
        where: { slug },
        select: CATEGORY_SELECT,
      });
      return row ? mapRecord(row) : null;
    },

    async getById(id) {
      const row = await p.category.findUnique({
        where: { id },
        select: CATEGORY_SELECT,
      });
      return row ? mapRecord(row) : null;
    },

    async findSlug(locale, slug) {
      const row = await p.categorySlug.findUnique({
        where: { locale_slug: { locale, slug } },
      });
      return row ? mapSlugRecord(row) : null;
    },

    async findSlugsBySlug(slug) {
      const rows = await p.categorySlug.findMany({ where: { slug } });
      return mapSlugRecords(rows);
    },

    async listSlugs(categoryId) {
      const rows = await p.categorySlug.findMany({
        where: { categoryId },
        // Rows written in one transaction share `createdAt` (Postgres now()
        // is the transaction's start), so ties break on (locale, slug): it
        // is unique, which makes the order total and stable.
        orderBy: [
          { isCurrent: "desc" },
          { createdAt: "desc" },
          { locale: "asc" },
          { slug: "asc" },
        ],
      });
      return mapSlugRecords(rows);
    },

    async listAllSlugs() {
      const rows = await p.categorySlug.findMany({
        orderBy: [
          { isCurrent: "desc" },
          { createdAt: "desc" },
          { locale: "asc" },
          { slug: "asc" },
        ],
      });
      return mapSlugRecords(rows);
    },

    async listCurrentSlugs(locale) {
      const rows = await p.categorySlug.findMany({
        where: { locale, isCurrent: true },
      });
      return mapSlugRecords(rows);
    },

    async setCurrentSlug({ categoryId, locale, slug }) {
      // Sequential awaits, no nested `$transaction`: `p` may be an
      // interactive-tx client. The caller holds `lockNaming()`.
      // A slug string names ONE category across locales (orchestrator
      // ruling 2026-10-17): a row with this slug in ANY locale, current or
      // old, that belongs to another category makes it taken. A category's
      // own en and es slug may be equal.
      const sameSlug = await p.categorySlug.findMany({
        where: { slug },
        select: { id: true, categoryId: true, locale: true },
      });
      if (sameSlug.some((row) => row.categoryId !== categoryId)) {
        return { ok: false as const, reason: "taken" as const };
      }
      const existing = sameSlug.find((row) => row.locale === locale) ?? null;
      // `Category.slug` is unique too, and a category written without an en
      // row (by an API version older than CategorySlug, during
      // migrate-before-rollout) holds its slug only there. Checked for every
      // locale under the same one-category rule; for en it also keeps the
      // write below from throwing P2002 instead of returning "taken".
      const holder = await p.category.findUnique({
        where: { slug },
        select: { id: true },
      });
      if (holder && holder.id !== categoryId) {
        return { ok: false as const, reason: "taken" as const };
      }

      await p.categorySlug.updateMany({
        where: { categoryId, locale, isCurrent: true, NOT: { slug } },
        data: { isCurrent: false },
      });

      const row = existing
        ? await p.categorySlug.update({
            where: { id: existing.id },
            data: { isCurrent: true },
          })
        : await p.categorySlug.create({
            data: { categoryId, locale, slug, isCurrent: true },
          });

      if (locale === "en") {
        // The read copy of the current English slug.
        await p.category.update({ where: { id: categoryId }, data: { slug } });
      }

      // `locale` is the typed input, so the row maps without the filter.
      return {
        ok: true as const,
        record: {
          categoryId: row.categoryId,
          locale,
          slug: row.slug,
          isCurrent: row.isCurrent,
          createdAt: row.createdAt,
        },
      };
    },

    async deleteById(id) {
      try {
        await p.category.delete({ where: { id } });
        return true;
      } catch (err) {
        // Prisma throws P2025 when the row doesn't exist. Treat as soft
        // "not found" so the use case can return its own not_found error.
        if (
          err &&
          typeof err === "object" &&
          "code" in err &&
          (err as { code?: string }).code === "P2025"
        ) {
          return false;
        }
        throw err;
      }
    },

    async setSeoType(id, seoType) {
      try {
        const row = await p.category.update({
          where: { id },
          data: { seoType },
          select: CATEGORY_SELECT,
        });
        return mapRecord(row);
      } catch (err) {
        // Prisma throws P2025 when the row doesn't exist. Surface as null so
        // the use case returns its own not_found error.
        if (
          err &&
          typeof err === "object" &&
          "code" in err &&
          (err as { code?: string }).code === "P2025"
        ) {
          return null;
        }
        throw err;
      }
    },

    async rename(id, name) {
      try {
        const row = await p.category.update({
          where: { id },
          data: { name },
          select: CATEGORY_SELECT,
        });
        return mapRecord(row);
      } catch (err) {
        // P2025 = no such row: null, so the use case answers not_found. A
        // P2002 on the name index is NOT caught: the use case translates it.
        if (
          err &&
          typeof err === "object" &&
          "code" in err &&
          (err as { code?: string }).code === "P2025"
        ) {
          return null;
        }
        throw err;
      }
    },

    async setNameTranslations(id, nameTranslations) {
      try {
        const row = await p.category.update({
          where: { id },
          data: { nameTranslations },
          select: CATEGORY_SELECT,
        });
        return mapRecord(row);
      } catch (err) {
        // P2025 = no such row: null, so the use case answers not_found.
        if (
          err &&
          typeof err === "object" &&
          "code" in err &&
          (err as { code?: string }).code === "P2025"
        ) {
          return null;
        }
        throw err;
      }
    },

    async listPublishedEventIds(categoryId) {
      const rows = await p.event.findMany({
        where: { categoryId, status: "PUBLISHED" },
        select: { id: true },
      });
      return rows.map((row) => row.id);
    },

    async setActive(id, active) {
      try {
        const row = await p.category.update({
          where: { id },
          data: { active },
          select: CATEGORY_SELECT,
        });
        return mapRecord(row);
      } catch (err) {
        // P2025 = no such row: null, so the use case answers not_found.
        if (
          err &&
          typeof err === "object" &&
          "code" in err &&
          (err as { code?: string }).code === "P2025"
        ) {
          return null;
        }
        throw err;
      }
    },

    async lockSortOrder() {
      // One fixed key: the order is a property of the whole table. A constant
      // inside a tagged template, so nothing is interpolated into the SQL.
      // `$executeRaw`, not `$queryRaw`: `pg_advisory_xact_lock` returns
      // Postgres `void`, which `$queryRaw` cannot decode under the pg driver
      // adapter (same reasoning as `feePolicies.lockScopeGuard`).
      await p.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('category_sort_order'))`;
    },

    async lockNaming() {
      // One fixed key for every name writer; a different key from the order
      // lock, so a reorder never waits on a rename. `$executeRaw` for the
      // reason given in `lockSortOrder`.
      await p.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('category_naming'))`;
    },

    async setSortOrders(entries) {
      // Sequential (not Promise.all): `p` may be an interactive-tx client.
      // `updateMany` so a row deleted since the caller read it counts as 0
      // instead of throwing; the caller compares the total.
      let updated = 0;
      for (const entry of entries) {
        const result = await p.category.updateMany({
          where: { id: entry.id },
          data: { sortOrder: entry.sortOrder },
        });
        updated += result.count;
      }
      return updated;
    },

    async create(input) {
      const row = await p.category.create({
        data: {
          slug: input.slug,
          name: input.name,
          active: input.active ?? true,
          sortOrder: input.sortOrder ?? 0,
          seoType: input.seoType ?? "Event",
          nameTranslations: input.nameTranslations ?? {},
          // Every category has its current English slug row.
          slugs: {
            create: { locale: "en", slug: input.slug, isCurrent: true },
          },
        },
        select: CATEGORY_SELECT,
      });

      return mapRecord(row);
    },

    async upsertSeed(categories) {
      if (!categories.length) return;

      for (const [index, category] of categories.entries()) {
        const { slug, name, seoType } = category;
        const sortOrder = index + 1;

        // A seed slug that is an English slug row of some category, current
        // or old, is that category (staff changed its URL; the old slug
        // stays reserved and 308s). Creating it would hit the unique
        // (locale, slug) on CategorySlug and fail the deploy.
        const enRow = await p.categorySlug.findUnique({
          where: { locale_slug: { locale: "en", slug } },
          select: { id: true },
        });
        if (enRow) continue;

        await p.category.upsert({
          where: { slug },
          create: {
            slug,
            name,
            active: true,
            sortOrder,
            seoType: seoType ?? "Event",
            slugs: { create: { locale: "en", slug, isCurrent: true } },
          },
          // Empty on purpose: an existing category is staff-managed (name,
          // active, sortOrder, seoType), so re-seeding changes nothing on it.
          // Only a missing slug is created.
          update: {},
        });
      }
    },
  } satisfies CategoriesRepo;
}
