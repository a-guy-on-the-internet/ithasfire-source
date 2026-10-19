import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "@prisma/client";

import { ensureCategories } from "../src/scripts/seed/categories";
import { SEED_CATEGORIES } from "../src/scripts/seed/fixtures";

/**
 * `ensureCategories` runs on EVERY deploy (the platform-categories bootstrap
 * in deploy-dev / deploy-prod). Platform staff rename, deactivate and reorder
 * categories on /platform, so the seed is create-only: a re-seed that wrote
 * the fixture's name, `active` or `sortOrder` back would undo their work with
 * no audit row, and one that tried to insert a fixture whose name a staff-made
 * category now carries would fail the deploy on the unique name index.
 *
 * The fake below behaves like Postgres where it matters: `upsert` applies the
 * `update` branch to an existing slug, and a create whose name is taken throws
 * what Prisma throws (P2002).
 */

type Row = {
  id: string;
  slug: string;
  name: string;
  active: boolean;
  sortOrder: number;
  seoType: string;
  nameTranslations?: Record<string, string>;
};

type SlugRow = {
  categoryId: string;
  locale: string;
  slug: string;
  isCurrent: boolean;
};

type CreateArgs = Omit<Row, "id"> & {
  slugs?: { create: Omit<SlugRow, "categoryId"> };
};

/**
 * `slugRows` defaults to one current en row per initial category, which is
 * what the CategorySlug backfill wrote.
 */
function makePrisma(initial: Row[], initialSlugRows?: SlugRow[]) {
  const rows = initial.map((row) => ({ ...row }));
  const slugRows: SlugRow[] = (
    initialSlugRows ??
    initial.map((row) => ({
      categoryId: row.id,
      locale: "en",
      slug: row.slug,
      isCurrent: true,
    }))
  ).map((row) => ({ ...row }));
  let nextId = 1;

  const upsert = vi.fn(
    async (args: {
      where: { slug: string };
      update: Partial<Row>;
      create: CreateArgs;
    }) => {
      const existing = rows.find((row) => row.slug === args.where.slug);
      if (existing) {
        Object.assign(existing, args.update);
        return { id: existing.id, slug: existing.slug };
      }
      if (rows.some((row) => row.name === args.create.name)) {
        throw Object.assign(new Error("Unique constraint failed: name"), {
          code: "P2002",
        });
      }
      const { slugs, ...category } = args.create;
      const nested = slugs?.create;
      if (
        nested &&
        slugRows.some(
          (row) => row.locale === nested.locale && row.slug === nested.slug,
        )
      ) {
        throw Object.assign(
          new Error("Unique constraint failed: CategorySlug_locale_slug_key"),
          { code: "P2002" },
        );
      }
      const created = { id: `new-${nextId++}`, ...category };
      rows.push(created);
      if (nested) slugRows.push({ categoryId: created.id, ...nested });
      return { id: created.id, slug: created.slug };
    },
  );
  const findMany = vi.fn(async () =>
    rows.map((row) => ({ slug: row.slug, name: row.name })),
  );
  const slugFindMany = vi.fn(async (args: { where: { locale: string } }) =>
    slugRows
      .filter((row) => row.locale === args.where.locale)
      .map((row) => ({ slug: row.slug, categoryId: row.categoryId })),
  );

  return {
    prisma: {
      category: { upsert, findMany },
      categorySlug: { findMany: slugFindMany },
    } as unknown as PrismaClient,
    rows,
    slugRows,
    upsert,
  };
}

const fixture = (slug: string) => {
  const found = SEED_CATEGORIES.find((cat) => cat.slug === slug);
  if (!found) throw new Error(`fixture ${slug} is gone: update this test`);
  return found;
};

/** Every fixture as a fresh seed would have written it. */
const seededRows = (): Row[] =>
  SEED_CATEGORIES.map((cat) => ({
    id: `id-${cat.slug}`,
    slug: cat.slug,
    name: cat.name,
    active: true,
    sortOrder: cat.sortOrder,
    seoType: cat.seoType ?? "Event",
    nameTranslations: {},
  }));

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  warn.mockRestore();
});

describe("ensureCategories", () => {
  it("installs every fixture on an empty table, from the fixture's values", async () => {
    const { prisma, rows } = makePrisma([]);

    const map = await ensureCategories(prisma);

    expect(Object.keys(map).sort()).toEqual(
      SEED_CATEGORIES.map((cat) => cat.slug).sort(),
    );
    const film = rows.find((row) => row.slug === "film");
    expect(film).toMatchObject({
      name: fixture("film").name,
      active: true,
      sortOrder: fixture("film").sortOrder,
      seoType: "Event",
    });
    expect(rows.find((row) => row.slug === "music")?.seoType).toBe(
      "MusicEvent",
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it("a fresh seed writes each category's current en slug row in the same create", async () => {
    const { prisma, rows, slugRows, upsert } = makePrisma([]);

    await ensureCategories(prisma);

    for (const [args] of upsert.mock.calls) {
      expect(args.create.slugs).toEqual({
        create: { locale: "en", slug: args.where.slug, isCurrent: true },
      });
    }
    expect(slugRows).toHaveLength(rows.length);
    for (const row of rows) {
      expect(slugRows).toContainEqual({
        categoryId: row.id,
        locale: "en",
        slug: row.slug,
        isCurrent: true,
      });
    }
  });

  it("a fixture slug that is a category's old URL maps to that category and is not inserted", async () => {
    // Staff changed music's URL to `live-music` on /platform. `music` is now
    // an old en row of the same category (it 308s). Inserting the fixture
    // would hit the unique (locale, slug) and fail the deploy.
    const before = seededRows().map((row) =>
      row.slug === "music" ? { ...row, slug: "live-music" } : row,
    );
    const slugRows: SlugRow[] = [
      ...before.map((row) => ({
        categoryId: row.id,
        locale: "en",
        slug: row.slug,
        isCurrent: true,
      })),
      { categoryId: "id-music", locale: "en", slug: "music", isCurrent: false },
    ];
    const { prisma, rows, upsert } = makePrisma(before, slugRows);

    const map = await ensureCategories(prisma);

    expect(map.music).toBe("id-music");
    expect(upsert.mock.calls.map(([args]) => args.where.slug)).not.toContain(
      "music",
    );
    expect(rows).toHaveLength(before.length);
    expect(rows.find((row) => row.id === "id-music")?.slug).toBe("live-music");
    expect(warn).not.toHaveBeenCalled();
  });

  it("a category from before CategorySlug (no en row) is still matched by slug and left alone", async () => {
    const { prisma, rows, upsert } = makePrisma(seededRows(), []);

    const map = await ensureCategories(prisma);

    expect(map.music).toBe("id-music");
    expect(rows).toHaveLength(SEED_CATEGORIES.length);
    for (const [args] of upsert.mock.calls) expect(args.update).toEqual({});
    expect(warn).not.toHaveBeenCalled();
  });

  it("every fixture carries a Spanish name; the dev seed writes it on create only", async () => {
    for (const cat of SEED_CATEGORIES) expect(cat.es.trim()).not.toBe("");
    const { prisma, rows, upsert } = makePrisma([]);
    await ensureCategories(prisma, { translations: true });
    for (const cat of SEED_CATEGORIES) {
      expect(rows.find((r) => r.slug === cat.slug)?.nameTranslations).toEqual({
        es: cat.es,
      });
    }
    // Re-seed over existing rows (default {}): nothing is written.
    upsert.mockClear();
    await ensureCategories(prisma, { translations: true });
    for (const [args] of upsert.mock.calls) expect(args.update).toEqual({});
    const blank = makePrisma(seededRows());
    await ensureCategories(blank.prisma, { translations: true });
    for (const row of blank.rows) expect(row.nameTranslations).toEqual({});
  });

  it("without the translations option (platform bootstrap) nothing translated is written", async () => {
    for (const options of [undefined, { platformOnly: true }]) {
      const fresh = makePrisma([]);
      await ensureCategories(fresh.prisma, options);
      for (const [args] of fresh.upsert.mock.calls) {
        expect(args.create).not.toHaveProperty("nameTranslations");
        expect(args.update).toEqual({});
      }
      const existing = makePrisma(seededRows());
      await ensureCategories(existing.prisma, options);
      for (const row of existing.rows) expect(row.nameTranslations).toEqual({});
    }
  });

  it("a re-seed leaves an existing row's name, active, sortOrder and seoType alone", async () => {
    const staffEdited: Row = {
      id: "id-music",
      slug: "music",
      name: "Concerts",
      active: false,
      sortOrder: 42,
      seoType: "Festival",
    };
    const { prisma, rows, upsert } = makePrisma([
      staffEdited,
      ...seededRows().filter((row) => row.slug !== "music"),
    ]);

    const map = await ensureCategories(prisma);

    expect(rows.find((row) => row.slug === "music")).toEqual(staffEdited);
    // The id is still returned for the row the seed did not touch.
    expect(map.music).toBe("id-music");
    // Stronger than "the row came out the same": no upsert carries anything
    // in its update branch, for any fixture.
    for (const [args] of upsert.mock.calls) {
      expect(args.update).toEqual({});
    }
  });

  it("creates a fixture that is missing and leaves the others as they are", async () => {
    const before = seededRows()
      .filter((row) => row.slug !== "arts")
      .map((row) =>
        row.slug === "nightlife" ? { ...row, active: false, sortOrder: 99 } : row,
      );
    const { prisma, rows } = makePrisma(before);

    const map = await ensureCategories(prisma);

    expect(rows.find((row) => row.slug === "arts")).toMatchObject({
      name: fixture("arts").name,
      active: true,
      sortOrder: fixture("arts").sortOrder,
    });
    expect(map.arts).toBeDefined();
    expect(rows.find((row) => row.slug === "nightlife")).toMatchObject({
      active: false,
      sortOrder: 99,
    });
  });

  it("skips a missing fixture whose name another category carries, with a warning, without throwing", async () => {
    // Staff renamed `film` to "Cinema", deleted nothing, and created
    // "Film & Media" by hand: it got the slug its name derives, not `film`.
    // Then `film` itself was deleted, so the fixture is missing by slug while
    // its name belongs to the hand-made row.
    const { prisma, rows, upsert } = makePrisma([
      ...seededRows().filter((row) => row.slug !== "film"),
      {
        id: "id-hand-made",
        slug: "film-media",
        // Another case on purpose: the category use cases compare names
        // without case, so the seed must not create a case-only twin either.
        name: "FILM & MEDIA",
        active: true,
        sortOrder: 50,
        seoType: "Event",
      },
    ]);

    const map = await ensureCategories(prisma);

    expect(rows.some((row) => row.slug === "film")).toBe(false);
    expect(map.film).toBeUndefined();
    expect(upsert.mock.calls.map(([args]) => args.where.slug)).not.toContain(
      "film",
    );
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]![0]);
    expect(message).toContain('"film"');
    expect(message).toContain(`"${fixture("film").name}"`);
    expect(message).toContain('"film-media"');
    // The other fixtures are still returned.
    expect(map.music).toBe("id-music");
  });

  it("does not fail when staff renamed a seeded category and created another under its old name", async () => {
    // The reviewer's scenario B: `film` renamed to "Cinema", then "Film &
    // Media" created. The old seed's update branch wrote "Film & Media" back
    // onto `film` and hit the unique name index.
    const { prisma, rows } = makePrisma([
      ...seededRows().map((row) =>
        row.slug === "film" ? { ...row, name: "Cinema" } : row,
      ),
      {
        id: "id-hand-made",
        slug: "film-media",
        name: fixture("film").name,
        active: true,
        sortOrder: 50,
        seoType: "Event",
      },
    ]);

    await expect(ensureCategories(prisma)).resolves.toMatchObject({
      film: "id-film",
    });
    expect(rows.find((row) => row.slug === "film")?.name).toBe("Cinema");
    expect(warn).not.toHaveBeenCalled();
  });

  it("platformOnly installs only the platform-default fixtures", async () => {
    const { prisma, rows } = makePrisma([]);

    const map = await ensureCategories(prisma, { platformOnly: true });

    const withheld = SEED_CATEGORIES.filter(
      (cat) => cat.platformDefault === false,
    ).map((cat) => cat.slug);
    expect(withheld.length).toBeGreaterThan(0);
    for (const slug of withheld) {
      expect(map[slug]).toBeUndefined();
      expect(rows.some((row) => row.slug === slug)).toBe(false);
    }
    expect(Object.keys(map)).toHaveLength(
      SEED_CATEGORIES.length - withheld.length,
    );
  });
});
