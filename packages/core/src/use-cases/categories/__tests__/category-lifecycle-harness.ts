import { expect, vi } from "vitest";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { Repos } from "@th/ports/repos";
import type { CategorySlugRecord } from "@th/ports/repos/categories";
import type { CategoryNameLocale, CategoryNameTranslations } from "@th/types";

/**
 * In-memory repos for the category lifecycle tests (rename, set active,
 * reorder, list all). Stateful where the use cases depend on it: writes land
 * in `rows`, so a test can assert both the calls and the resulting table.
 */

export const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
export const MUSIC_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
export const JAZZ_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
export const COMEDY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";
export const UNKNOWN_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";

export const FIXED_NOW = new Date("2026-10-11T12:00:00Z");
const EARLIER = new Date("2026-10-01T00:00:00Z");

export type StaffRole = "ADMIN" | "DEVELOPER" | "REVIEWER" | "SUPPORT";

export type CategoryRow = {
  id: string;
  slug: string;
  name: string;
  active: boolean;
  sortOrder: number;
  seoType: string;
  nameTranslations: CategoryNameTranslations;
  createdAt: Date;
  updatedAt: Date;
};

export function categoryRow(overrides: Partial<CategoryRow> = {}): CategoryRow {
  return {
    id: MUSIC_ID,
    slug: "music",
    name: "Music",
    active: true,
    sortOrder: 1,
    seoType: "Event",
    nameTranslations: {},
    createdAt: EARLIER,
    updatedAt: EARLIER,
    ...overrides,
  };
}

/** Music (1), Jazz (2), Comedy (3, inactive). */
export function threeCategories(): CategoryRow[] {
  return [
    categoryRow(),
    categoryRow({ id: JAZZ_ID, slug: "jazz", name: "Jazz", sortOrder: 2 }),
    categoryRow({
      id: COMEDY_ID,
      slug: "comedy",
      name: "Comedy",
      sortOrder: 3,
      active: false,
    }),
  ];
}

/**
 * A stateful CategorySlug table with the Prisma adapter's exact rules
 * (`packages/adapters/src/db/prisma/categories.ts`): `setCurrentSlug` writes
 * nothing on "taken" (another category holds the slug string in any locale,
 * or as `Category.slug`), keeps the old row, flips an own old row back, and
 * for en also writes the category row's `slug`. `categories` is the live row array the other
 * fakes mutate. Each write gets a later `createdAt`, so "newest first"
 * orders by write.
 */
export function createSlugTable(
  categories: Array<{ id: string; slug: string }>,
  seed: CategorySlugRecord[] = [],
) {
  const slugs: CategorySlugRecord[] = seed.map((row) => ({ ...row }));
  let tick = 0;
  const nextAt = () => new Date(FIXED_NOW.getTime() + ++tick * 1000);
  const copy = (row: CategorySlugRecord) => ({ ...row });

  const methods = {
    findSlug: vi.fn(async (locale: CategoryNameLocale, slug: string) => {
      const row = slugs.find((r) => r.locale === locale && r.slug === slug);
      return row ? copy(row) : null;
    }),
    findSlugsBySlug: vi.fn(async (slug: string) =>
      slugs.filter((r) => r.slug === slug).map(copy),
    ),
    listSlugs: vi.fn(async (categoryId: string) =>
      slugs
        .filter((r) => r.categoryId === categoryId)
        .sort(
          (a, b) =>
            Number(b.isCurrent) - Number(a.isCurrent) ||
            b.createdAt.getTime() - a.createdAt.getTime() ||
            a.locale.localeCompare(b.locale) ||
            a.slug.localeCompare(b.slug),
        )
        .map(copy),
    ),
    listAllSlugs: vi.fn(async () =>
      [...slugs]
        .sort(
          (a, b) =>
            Number(b.isCurrent) - Number(a.isCurrent) ||
            b.createdAt.getTime() - a.createdAt.getTime() ||
            a.locale.localeCompare(b.locale) ||
            a.slug.localeCompare(b.slug),
        )
        .map(copy),
    ),
    listCurrentSlugs: vi.fn(async (locale: CategoryNameLocale) =>
      slugs.filter((r) => r.locale === locale && r.isCurrent).map(copy),
    ),
    setCurrentSlug: vi.fn(
      async (input: {
        categoryId: string;
        locale: CategoryNameLocale;
        slug: string;
      }) => {
        const { categoryId, locale, slug } = input;
        const category = categories.find((c) => c.id === categoryId);
        if (!category) throw new Error("category_not_found");
        // One category per slug string across locales (adapter rule).
        if (
          slugs.some((r) => r.slug === slug && r.categoryId !== categoryId) ||
          categories.some((c) => c.slug === slug && c.id !== categoryId)
        ) {
          return { ok: false as const, reason: "taken" as const };
        }
        const existing = slugs.find(
          (r) => r.locale === locale && r.slug === slug,
        );
        for (const r of slugs) {
          if (r.categoryId === categoryId && r.locale === locale) {
            r.isCurrent = r.slug === slug;
          }
        }
        let row = existing;
        if (!row) {
          row = {
            categoryId,
            locale,
            slug,
            isCurrent: true,
            createdAt: nextAt(),
          };
          slugs.push(row);
        }
        row.isCurrent = true;
        if (locale === "en") category.slug = slug;
        return { ok: true as const, record: copy(row) };
      },
    ),
  };

  /** What the adapter's `create` writes beside the category row. */
  const addCurrentEn = (categoryId: string, slug: string) => {
    slugs.push({
      categoryId,
      locale: "en",
      slug,
      isCurrent: true,
      createdAt: nextAt(),
    });
  };

  return { slugs, methods, addCurrentEn };
}

/** One current en row per category, as the migration backfilled. */
export function currentEnRows(
  categories: Array<{ id: string; slug: string }>,
): CategorySlugRecord[] {
  return categories.map((c) => ({
    categoryId: c.id,
    locale: "en",
    slug: c.slug,
    isCurrent: true,
    createdAt: new Date("2026-10-01T00:00:00Z"),
  }));
}

export function buildCategoryDeps(
  overrides: {
    /** Staff roles the actor holds; [] is a signed-in non-staff human. */
    actorRoles?: StaffRole[];
    categories?: CategoryRow[];
    /** Thrown by `rename` (what Prisma throws on a unique violation). */
    renameError?: unknown;
    /** Rows that vanish between the read and the write (a racing delete). */
    deletedBeforeWrite?: string[];
    /** Published event ids per category id (for the reindex marks). */
    publishedEventIds?: Record<string, string[]>;
    /** CategorySlug rows; default one current en row per category. */
    slugs?: CategorySlugRecord[];
  } = {},
) {
  const actorRoles = overrides.actorRoles ?? ["ADMIN"];
  const rows = (overrides.categories ?? threeCategories()).map((row) => ({
    ...row,
  }));
  const gone = new Set(overrides.deletedBeforeWrite ?? []);
  const slugTable = createSlugTable(
    rows,
    overrides.slugs ?? currentEnRows(rows),
  );

  const find = (id: string) =>
    gone.has(id) ? undefined : rows.find((row) => row.id === id);

  const categories = {
    listAll: vi.fn(async () =>
      [...rows]
        .sort((a, b) => a.sortOrder - b.sortOrder || (a.name < b.name ? -1 : 1))
        .map((row) => ({ ...row })),
    ),
    getById: vi.fn(async (id: string) => {
      const row = rows.find((candidate) => candidate.id === id);
      return row ? { ...row } : null;
    }),
    getBySlug: vi.fn(async (slug: string) => {
      const row = rows.find((candidate) => candidate.slug === slug);
      return row ? { ...row } : null;
    }),
    rename: vi.fn(async (id: string, name: string) => {
      if (overrides.renameError) throw overrides.renameError;
      const row = find(id);
      if (!row) return null;
      row.name = name;
      return { ...row };
    }),
    setNameTranslations: vi.fn(
      async (id: string, nameTranslations: CategoryNameTranslations) => {
        const row = find(id);
        if (!row) return null;
        row.nameTranslations = { ...nameTranslations };
        return { ...row, nameTranslations: { ...row.nameTranslations } };
      },
    ),
    listPublishedEventIds: vi.fn(
      async (categoryId: string) =>
        overrides.publishedEventIds?.[categoryId] ?? [],
    ),
    setActive: vi.fn(async (id: string, active: boolean) => {
      const row = find(id);
      if (!row) return null;
      row.active = active;
      return { ...row };
    }),
    lockSortOrder: vi.fn(async () => undefined),
    lockNaming: vi.fn(async () => undefined),
    setSortOrders: vi.fn(
      async (entries: ReadonlyArray<{ id: string; sortOrder: number }>) => {
        let updated = 0;
        for (const entry of entries) {
          const row = find(entry.id);
          if (!row) continue;
          row.sortOrder = entry.sortOrder;
          updated += 1;
        }
        return updated;
      },
    ),
    ...slugTable.methods,
  };

  const audit = { log: vi.fn() };
  const searchReindexPending = { mark: vi.fn(async () => undefined) };

  const tx = vi.fn(async (fn: (txRepos: unknown) => Promise<unknown>) =>
    fn({ categories, audit, searchReindexPending }),
  );

  const hasStaffRole = vi.fn(
    async (input: { actorHumanId: string; requiredRoles: string[] }) => ({
      allowed: actorRoles.some((role) => input.requiredRoles.includes(role)),
    }),
  );

  const deps = {
    repos: { categories, audit, tx } as unknown as Repos,
    authz: { hasStaffRole } as unknown as AuthZPort,
    clock: { now: () => FIXED_NOW } as unknown as ClockPort,
  };

  return {
    deps,
    categories,
    audit,
    searchReindexPending,
    tx,
    hasStaffRole,
    rows,
    slugs: slugTable.slugs,
  };
}

export type BuiltCategoryDeps = ReturnType<typeof buildCategoryDeps>;

/** No read, no write, no audit: the refusal came before the repos. */
export function expectReposUntouched(built: BuiltCategoryDeps) {
  expect(built.tx).not.toHaveBeenCalled();
  for (const fn of Object.values(built.categories)) {
    expect(fn).not.toHaveBeenCalled();
  }
  expect(built.audit.log).not.toHaveBeenCalled();
}

export function expectNothingWritten(built: BuiltCategoryDeps) {
  expect(built.categories.rename).not.toHaveBeenCalled();
  expect(built.categories.setActive).not.toHaveBeenCalled();
  expect(built.categories.setSortOrders).not.toHaveBeenCalled();
  expect(built.categories.setNameTranslations).not.toHaveBeenCalled();
  expect(built.categories.setCurrentSlug).not.toHaveBeenCalled();
  expect(built.audit.log).not.toHaveBeenCalled();
  expect(built.searchReindexPending.mark).not.toHaveBeenCalled();
}
