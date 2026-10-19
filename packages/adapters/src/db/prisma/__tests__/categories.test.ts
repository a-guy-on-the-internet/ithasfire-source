import { describe, expect, it, vi } from "vitest";

import { makeCategoriesRepo } from "../categories";
import type { PrismaClientOrTx } from "../types";

const NOW = new Date("2026-10-11T12:00:00.000Z");

function createPrisma() {
  const create = vi.fn(async (args: { data: Record<string, unknown> }) => ({
    id: "category-1",
    createdAt: NOW,
    updatedAt: NOW,
    ...args.data,
  }));

  const prisma = { category: { create } } as unknown as PrismaClientOrTx;

  return { prisma, create };
}

describe("makeCategoriesRepo.create", () => {
  it("writes the given seoType", async () => {
    const { prisma, create } = createPrisma();
    const repo = makeCategoriesRepo(prisma);

    const result = await repo.create({
      slug: "live-music",
      name: "Live Music",
      active: true,
      sortOrder: 7,
      seoType: "MusicEvent",
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          slug: "live-music",
          name: "Live Music",
          active: true,
          sortOrder: 7,
          seoType: "MusicEvent",
          nameTranslations: {},
          slugs: {
            create: { locale: "en", slug: "live-music", isCurrent: true },
          },
        },
      }),
    );
    expect(result).toMatchObject({
      id: "category-1",
      slug: "live-music",
      seoType: "MusicEvent",
      sortOrder: 7,
    });
  });

  it('defaults seoType to "Event" for a caller that does not pass one', async () => {
    const { prisma, create } = createPrisma();
    const repo = makeCategoriesRepo(prisma);

    const result = await repo.create({ slug: "comedy", name: "Comedy" });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          slug: "comedy",
          name: "Comedy",
          active: true,
          sortOrder: 0,
          seoType: "Event",
          nameTranslations: {},
          slugs: { create: { locale: "en", slug: "comedy", isCurrent: true } },
        },
      }),
    );
    expect(result.seoType).toBe("Event");
  });

  it("lets a unique violation propagate for the use case to translate", async () => {
    const { prisma, create } = createPrisma();
    const repo = makeCategoriesRepo(prisma);
    const p2002 = Object.assign(new Error("Unique constraint failed"), {
      code: "P2002",
    });
    create.mockRejectedValueOnce(p2002);

    await expect(
      repo.create({ slug: "comedy", name: "Comedy" }),
    ).rejects.toBe(p2002);
  });
});

function categoryDbRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "category-1",
    slug: "jazz",
    name: "Jazz",
    active: true,
    sortOrder: 2,
    seoType: "Event",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function createLifecyclePrisma() {
  const update = vi.fn(
    async (args: { where: { id: string }; data: Record<string, unknown> }) =>
      categoryDbRow({ id: args.where.id, ...args.data }),
  );
  const updateMany = vi.fn(
    async (_args: { where: { id: string }; data: { sortOrder: number } }) => ({
      count: 1,
    }),
  );
  const $executeRaw = vi.fn(async (..._args: unknown[]) => 1);

  const prisma = {
    category: { update, updateMany },
    $executeRaw,
  } as unknown as PrismaClientOrTx;

  return { prisma, update, updateMany, $executeRaw };
}

const prismaError = (code: string) =>
  Object.assign(new Error(code), { code });

describe("makeCategoriesRepo.setNameTranslations", () => {
  it("writes the translations only and reads them back", async () => {
    const { prisma, update } = createLifecyclePrisma();

    const result = await makeCategoriesRepo(prisma).setNameTranslations(
      "category-1",
      { es: "Jazz latino" },
    );

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "category-1" },
        data: { nameTranslations: { es: "Jazz latino" } },
      }),
    );
    expect(result).toMatchObject({
      name: "Jazz",
      slug: "jazz",
      nameTranslations: { es: "Jazz latino" },
    });
  });

  it("answers null when no row matched (P2025)", async () => {
    const { prisma, update } = createLifecyclePrisma();
    update.mockRejectedValueOnce(prismaError("P2025"));

    await expect(
      makeCategoriesRepo(prisma).setNameTranslations("gone", {}),
    ).resolves.toBeNull();
  });

  it("drops unsupported or blank keys when reading the column", async () => {
    const { prisma, update } = createLifecyclePrisma();
    update.mockResolvedValueOnce(
      categoryDbRow({ nameTranslations: { es: " ", fr: "Jazz" } }),
    );

    const result = await makeCategoriesRepo(prisma).setNameTranslations(
      "category-1",
      {},
    );

    expect(result?.nameTranslations).toEqual({});
  });
});

describe("makeCategoriesRepo.listPublishedEventIds", () => {
  it("lists the ids of the category's PUBLISHED events", async () => {
    const findMany = vi.fn(async () => [{ id: "ev-1" }, { id: "ev-2" }]);
    const prisma = { event: { findMany } } as unknown as PrismaClientOrTx;

    const ids = await makeCategoriesRepo(prisma).listPublishedEventIds(
      "category-1",
    );

    expect(ids).toEqual(["ev-1", "ev-2"]);
    expect(findMany).toHaveBeenCalledWith({
      where: { categoryId: "category-1", status: "PUBLISHED" },
      select: { id: true },
    });
  });
});

describe("makeCategoriesRepo.rename", () => {
  it("writes the name only, so the slug is left alone", async () => {
    const { prisma, update } = createLifecyclePrisma();

    const result = await makeCategoriesRepo(prisma).rename(
      "category-1",
      "Jazz & Blues",
    );

    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "category-1" },
        data: { name: "Jazz & Blues" },
      }),
    );
    expect(result).toMatchObject({
      id: "category-1",
      slug: "jazz",
      name: "Jazz & Blues",
    });
  });

  it("returns null when no row matched (P2025)", async () => {
    const { prisma, update } = createLifecyclePrisma();
    update.mockRejectedValueOnce(prismaError("P2025"));

    await expect(
      makeCategoriesRepo(prisma).rename("category-1", "Folk"),
    ).resolves.toBeNull();
  });

  it("lets a unique violation propagate for the use case to translate", async () => {
    const { prisma, update } = createLifecyclePrisma();
    const p2002 = prismaError("P2002");
    update.mockRejectedValueOnce(p2002);

    await expect(
      makeCategoriesRepo(prisma).rename("category-1", "Music"),
    ).rejects.toBe(p2002);
  });
});

describe("makeCategoriesRepo.setActive", () => {
  it.each([true, false])("writes active=%s and nothing else", async (active) => {
    const { prisma, update } = createLifecyclePrisma();

    const result = await makeCategoriesRepo(prisma).setActive(
      "category-1",
      active,
    );

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "category-1" },
        data: { active },
      }),
    );
    expect(result).toMatchObject({ id: "category-1", active });
  });

  it("returns null when no row matched (P2025)", async () => {
    const { prisma, update } = createLifecyclePrisma();
    update.mockRejectedValueOnce(prismaError("P2025"));

    await expect(
      makeCategoriesRepo(prisma).setActive("category-1", false),
    ).resolves.toBeNull();
  });

  it("rethrows any other failure", async () => {
    const { prisma, update } = createLifecyclePrisma();
    const boom = prismaError("P1001");
    update.mockRejectedValueOnce(boom);

    await expect(
      makeCategoriesRepo(prisma).setActive("category-1", false),
    ).rejects.toBe(boom);
  });
});

describe("makeCategoriesRepo.setSortOrders", () => {
  it("writes one row per entry, in order, on the client it was given", async () => {
    const { prisma, updateMany } = createLifecyclePrisma();

    const updated = await makeCategoriesRepo(prisma).setSortOrders([
      { id: "category-b", sortOrder: 1 },
      { id: "category-a", sortOrder: 2 },
    ]);

    expect(updated).toBe(2);
    expect(updateMany.mock.calls.map(([args]) => args)).toEqual([
      { where: { id: "category-b" }, data: { sortOrder: 1 } },
      { where: { id: "category-a" }, data: { sortOrder: 2 } },
    ]);
  });

  it("counts a missing row as 0 instead of throwing", async () => {
    const { prisma, updateMany } = createLifecyclePrisma();
    updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(
      makeCategoriesRepo(prisma).setSortOrders([
        { id: "category-gone", sortOrder: 1 },
        { id: "category-a", sortOrder: 2 },
      ]),
    ).resolves.toBe(1);
  });

  it("writes nothing for an empty list", async () => {
    const { prisma, updateMany } = createLifecyclePrisma();

    await expect(makeCategoriesRepo(prisma).setSortOrders([])).resolves.toBe(0);
    expect(updateMany).not.toHaveBeenCalled();
  });
});

describe("makeCategoriesRepo.lockSortOrder", () => {
  it("takes a transaction-scoped advisory lock on one fixed key, with no bound values", async () => {
    const { prisma, $executeRaw } = createLifecyclePrisma();

    await makeCategoriesRepo(prisma).lockSortOrder();

    expect($executeRaw).toHaveBeenCalledTimes(1);
    const [strings, ...values] = $executeRaw.mock.calls[0]!;
    expect((strings as readonly string[]).join("")).toBe(
      "SELECT pg_advisory_xact_lock(hashtext('category_sort_order'))",
    );
    expect(values).toEqual([]);
  });
});

describe("makeCategoriesRepo.lockNaming", () => {
  it("takes a transaction-scoped advisory lock on its own fixed key, with no bound values", async () => {
    const { prisma, $executeRaw } = createLifecyclePrisma();

    await makeCategoriesRepo(prisma).lockNaming();

    expect($executeRaw).toHaveBeenCalledTimes(1);
    const [strings, ...values] = $executeRaw.mock.calls[0]!;
    // A different key from the order lock: a reorder must not wait on a rename.
    expect((strings as readonly string[]).join("")).toBe(
      "SELECT pg_advisory_xact_lock(hashtext('category_naming'))",
    );
    expect(values).toEqual([]);
  });
});

// Existing categories are staff-managed (rename, deactivate, reorder, seoType
// on /platform). A re-seed that wrote name / active / sortOrder back would
// undo that work with no audit row, so the seed only creates what is missing.
describe("makeCategoriesRepo.upsertSeed", () => {
  type SeedRow = {
    slug: string;
    name: string;
    active: boolean;
    sortOrder: number;
    seoType: string;
  };

  function createSeedPrisma(initial: SeedRow[], enSlugRows: string[] = []) {
    const rows = initial.map((row) => ({ ...row }));
    const createdSlugs: Array<{ slug: string; slugs: unknown }> = [];
    const upsert = vi.fn(
      async (args: {
        where: { slug: string };
        create: SeedRow & { slugs?: unknown };
        update: Partial<SeedRow>;
      }) => {
        const existing = rows.find((row) => row.slug === args.where.slug);
        if (existing) {
          Object.assign(existing, args.update);
          return existing;
        }
        // The nested en slug row is asserted via `createdSlugs`, not stored.
        const { slugs, ...row } = args.create;
        createdSlugs.push({ slug: row.slug, slugs });
        rows.push(row);
        return args.create;
      },
    );
    // English CategorySlug rows (current or old) by slug.
    const findUnique = vi.fn(
      async (args: {
        where: { locale_slug: { locale: string; slug: string } };
      }) =>
        args.where.locale_slug.locale === "en" &&
        enSlugRows.includes(args.where.locale_slug.slug)
          ? { id: `slug-${args.where.locale_slug.slug}` }
          : null,
    );
    const prisma = {
      category: { upsert },
      categorySlug: { findUnique },
    } as unknown as PrismaClientOrTx;
    return { prisma, rows, upsert, createdSlugs };
  }

  it("leaves an existing row's name, active, sortOrder and seoType alone", async () => {
    const staffEdited: SeedRow = {
      slug: "music",
      name: "Concerts",
      active: false,
      sortOrder: 42,
      seoType: "Festival",
    };
    const { prisma, rows, upsert } = createSeedPrisma([staffEdited]);

    await makeCategoriesRepo(prisma).upsertSeed([
      { slug: "music", name: "Music", seoType: "MusicEvent" },
    ]);

    expect(rows).toEqual([staffEdited]);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { slug: "music" }, update: {} }),
    );
  });

  it("creates a missing slug at its 1-based position, with the given or default seoType", async () => {
    const { prisma, rows, createdSlugs } = createSeedPrisma([
      { slug: "music", name: "Concerts", active: false, sortOrder: 42, seoType: "MusicEvent" },
    ]);

    await makeCategoriesRepo(prisma).upsertSeed([
      { slug: "music", name: "Music" },
      { slug: "comedy", name: "Comedy" },
      { slug: "festivals", name: "Festivals", seoType: "Festival" },
    ]);

    expect(rows.find((row) => row.slug === "comedy")).toEqual({
      slug: "comedy",
      name: "Comedy",
      active: true,
      sortOrder: 2,
      seoType: "Event",
    });
    expect(createdSlugs.find((c) => c.slug === "comedy")?.slugs).toEqual({
      create: { locale: "en", slug: "comedy", isCurrent: true },
    });
    expect(rows.find((row) => row.slug === "festivals")).toMatchObject({
      sortOrder: 3,
      seoType: "Festival",
    });
    expect(rows.find((row) => row.slug === "music")).toMatchObject({
      name: "Concerts",
      active: false,
      sortOrder: 42,
    });
  });

  it("skips a seed slug that is an English slug row of some category (an old URL)", async () => {
    // `comedy` was moved to `stand-up`; its old row still reserves `comedy`.
    const { prisma, rows, upsert } = createSeedPrisma([], ["comedy"]);

    await makeCategoriesRepo(prisma).upsertSeed([
      { slug: "comedy", name: "Comedy" },
      { slug: "music", name: "Music" },
    ]);

    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { slug: "music" } }),
    );
    expect(rows.map((row) => row.slug)).toEqual(["music"]);
  });

  it("writes nothing for an empty list", async () => {
    const { prisma, upsert } = createSeedPrisma([]);

    await makeCategoriesRepo(prisma).upsertSeed([]);

    expect(upsert).not.toHaveBeenCalled();
  });
});

describe("makeCategoriesRepo.listActiveWithUpcomingEvents", () => {
  function createListPrisma(withheld: Array<{ kind: "HUMAN" | "ORG"; id: string }>) {
    const findMany = vi.fn(async () => [
      {
        id: "category-music",
        slug: "music",
        name: "Music",
        active: true,
        sortOrder: 1,
        seoType: "MusicEvent",
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);
    const $queryRaw = vi.fn(async () => withheld);
    const prisma = {
      category: { findMany },
      $queryRaw,
    } as unknown as PrismaClientOrTx;
    return { prisma, findMany };
  }

  it("asks for active categories with a PUBLISHED, PUBLIC, ungated event starting at or after now", async () => {
    const { prisma, findMany } = createListPrisma([]);
    const repo = makeCategoriesRepo(prisma);

    const result = await repo.listActiveWithUpcomingEvents({ now: NOW });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          active: true,
          events: {
            some: {
              status: "PUBLISHED",
              visibility: "PUBLIC",
              startsAt: { gte: NOW },
              // A category whose only upcoming events are gated is noindex
              // and stays out of the sitemap (owner ruling 2026-10-13).
              gateType: "NONE",
            },
          },
        },
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      }),
    );
    expect(result).toEqual([
      {
        id: "category-music",
        slug: "music",
        name: "Music",
        active: true,
        sortOrder: 1,
        seoType: "MusicEvent",
        nameTranslations: {},
      },
    ]);
  });

  it("does not count an event whose owner is withheld", async () => {
    const { prisma, findMany } = createListPrisma([
      { kind: "HUMAN", id: "banned-human" },
    ]);
    const repo = makeCategoriesRepo(prisma);

    await repo.listActiveWithUpcomingEvents({ now: NOW });

    const call = findMany.mock.calls[0] as unknown as [
      { where: { events: { some: Record<string, unknown> } } },
    ];
    expect(call[0].where.events.some).toHaveProperty("AND");
  });
});

describe("makeCategoriesRepo.listActiveWithListedEvents", () => {
  function createListPrisma(
    withheld: Array<{ kind: "HUMAN" | "ORG"; id: string }>,
  ) {
    const findMany = vi.fn(async () => [
      {
        id: "category-open-mics",
        slug: "open-mics",
        name: "Standup Open Mic",
        active: true,
        sortOrder: 9,
        seoType: "ComedyEvent",
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);
    const $queryRaw = vi.fn(async () => withheld);
    const prisma = {
      category: { findMany },
      $queryRaw,
    } as unknown as PrismaClientOrTx;
    return { prisma, findMany };
  }

  it("asks for active categories with a PUBLISHED, PUBLIC event starting at or after now, gated or not", async () => {
    const { prisma, findMany } = createListPrisma([]);
    const repo = makeCategoriesRepo(prisma);

    const result = await repo.listActiveWithListedEvents({ now: NOW });

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          active: true,
          events: {
            some: {
              status: "PUBLISHED",
              visibility: "PUBLIC",
              startsAt: { gte: NOW },
              // No gateType: a gated event still lists on the category
              // page, so it counts for browse (unlike the sitemap).
            },
          },
        },
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      }),
    );
    expect(result).toEqual([
      {
        id: "category-open-mics",
        slug: "open-mics",
        name: "Standup Open Mic",
        active: true,
        sortOrder: 9,
        seoType: "ComedyEvent",
        nameTranslations: {},
      },
    ]);
  });

  it("does not count an event whose owner is withheld", async () => {
    const { prisma, findMany } = createListPrisma([
      { kind: "ORG", id: "banned-org" },
    ]);
    const repo = makeCategoriesRepo(prisma);

    await repo.listActiveWithListedEvents({ now: NOW });

    const call = findMany.mock.calls[0] as unknown as [
      { where: { events: { some: Record<string, unknown> } } },
    ];
    expect(call[0].where.events.some).toHaveProperty("AND");
  });
});
