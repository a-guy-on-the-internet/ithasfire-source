import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { makeCategoriesRepo } from "../categories";

// CategorySlug repo methods against REAL Postgres (spanish-seo FR-007).
// Runs on a throwaway `test_*` database (Testcontainer / shared th-test-pg).

describe("categories slug methods on real Postgres", () => {
  let pgContainer: PostgresTestContainer | undefined;
  let pool: pg.Pool | undefined;
  let prisma: PrismaClient;
  let repo: ReturnType<typeof makeCategoriesRepo>;

  beforeAll(async () => {
    pgContainer = await startPostgresContainer();
    await runPrismaMigrateDeploy(pgContainer.databaseUrl);
    pool = new pg.Pool({ connectionString: pgContainer.databaseUrl });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
    repo = makeCategoriesRepo(prisma);
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
    await pgContainer?.stop();
  });

  it("create writes the current en slug row", async () => {
    const c = await repo.create({ slug: "jazz", name: "Jazz" });
    expect(await repo.listSlugs(c.id)).toEqual([
      expect.objectContaining({
        categoryId: c.id,
        locale: "en",
        slug: "jazz",
        isCurrent: true,
      }),
    ]);
  });

  it("findSlug and findSlugsBySlug look rows up", async () => {
    const c = await repo.create({ slug: "folk", name: "Folk" });
    expect(await repo.findSlug("en", "folk")).toMatchObject({
      categoryId: c.id,
    });
    expect(await repo.findSlug("es", "folk")).toBeNull();
    await repo.setCurrentSlug({ categoryId: c.id, locale: "es", slug: "folk" });
    const all = await repo.findSlugsBySlug("folk");
    expect(all.map((r) => r.locale).sort()).toEqual(["en", "es"]);
  });

  it("setCurrentSlug adds a new slug, keeps the old row, updates Category.slug for en only", async () => {
    const c = await repo.create({ slug: "blues", name: "Blues" });
    const en = await repo.setCurrentSlug({
      categoryId: c.id,
      locale: "en",
      slug: "blues-night",
    });
    expect(en).toMatchObject({
      ok: true,
      record: { slug: "blues-night", isCurrent: true },
    });
    expect((await repo.getById(c.id))?.slug).toBe("blues-night");

    const es = await repo.setCurrentSlug({
      categoryId: c.id,
      locale: "es",
      slug: "musica-blues",
    });
    expect(es.ok).toBe(true);
    expect((await repo.getById(c.id))?.slug).toBe("blues-night");

    const rows = await repo.listSlugs(c.id);
    expect(rows).toHaveLength(3);
    expect(
      rows.find((r) => r.locale === "en" && r.slug === "blues"),
    ).toMatchObject({ isCurrent: false });
    expect(await repo.listCurrentSlugs("es")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ categoryId: c.id, slug: "musica-blues" }),
      ]),
    );
  });

  it("switching back to an old slug reactivates it without a new row", async () => {
    const c = await repo.create({ slug: "rock", name: "Rock" });
    await repo.setCurrentSlug({ categoryId: c.id, locale: "en", slug: "rock-2" });
    const back = await repo.setCurrentSlug({
      categoryId: c.id,
      locale: "en",
      slug: "rock",
    });
    expect(back.ok).toBe(true);
    const rows = await repo.listSlugs(c.id);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.isCurrent)).toEqual([
      expect.objectContaining({ slug: "rock" }),
    ]);
    expect((await repo.getById(c.id))?.slug).toBe("rock");
  });

  it("a slug held by another category is taken and nothing is written", async () => {
    const a = await repo.create({ slug: "poetry", name: "Poetry" });
    const b = await repo.create({ slug: "prose", name: "Prose" });
    const res = await repo.setCurrentSlug({
      categoryId: b.id,
      locale: "en",
      slug: "poetry",
    });
    expect(res).toEqual({ ok: false, reason: "taken" });
    expect(await repo.listSlugs(b.id)).toEqual([
      expect.objectContaining({ slug: "prose", isCurrent: true }),
    ]);
    expect((await repo.getById(b.id))?.slug).toBe("prose");
    expect((await repo.findSlug("en", "poetry"))?.categoryId).toBe(a.id);
  });

  it("a slug string names one category across locales, both directions", async () => {
    const tango = await repo.create({ slug: "tango", name: "Tango" });
    const argentine = await repo.create({
      slug: "argentine-tango",
      name: "Argentine Tango",
    });

    // es slug equal to ANOTHER category's en slug: taken, nothing written.
    expect(
      await repo.setCurrentSlug({
        categoryId: argentine.id,
        locale: "es",
        slug: "tango",
      }),
    ).toEqual({ ok: false, reason: "taken" });
    expect(await repo.findSlug("es", "tango")).toBeNull();

    // en slug equal to another category's es slug (current or old): taken.
    await repo.setCurrentSlug({
      categoryId: argentine.id,
      locale: "es",
      slug: "tango-argentino",
    });
    expect(
      await repo.setCurrentSlug({
        categoryId: tango.id,
        locale: "en",
        slug: "tango-argentino",
      }),
    ).toEqual({ ok: false, reason: "taken" });
    expect((await repo.getById(tango.id))!.slug).toBe("tango");

    // A category's own en and es slug may be equal.
    expect(
      await repo.setCurrentSlug({
        categoryId: tango.id,
        locale: "es",
        slug: "tango",
      }),
    ).toMatchObject({ ok: true, record: { locale: "es", slug: "tango" } });
  });

  it("listSlugs orders current first, then newest first, ties by locale then slug", async () => {
    const c = await repo.create({ slug: "o1", name: "Order One" });
    // Explicit timestamps, so the order does not depend on clock resolution.
    const at = (ms: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, 0, ms));
    await prisma.categorySlug.updateMany({
      where: { categoryId: c.id },
      data: { isCurrent: false, createdAt: at(0) },
    });
    await prisma.categorySlug.createMany({
      data: [
        { categoryId: c.id, locale: "en", slug: "o2", isCurrent: false, createdAt: at(10) },
        { categoryId: c.id, locale: "en", slug: "o3", isCurrent: true, createdAt: at(5) },
        // Same instant as o2 (one transaction): es after en, then by slug.
        { categoryId: c.id, locale: "es", slug: "o2-b", isCurrent: false, createdAt: at(10) },
        { categoryId: c.id, locale: "es", slug: "o2-a", isCurrent: true, createdAt: at(10) },
      ],
    });
    expect((await repo.listSlugs(c.id)).map((r) => r.slug)).toEqual([
      "o2-a",
      "o3",
      "o2",
      "o2-b",
      "o1",
    ]);
  });

  it("setting the slug that is already current stays one current row", async () => {
    const c = await repo.create({ slug: "same", name: "Same" });
    const res = await repo.setCurrentSlug({
      categoryId: c.id,
      locale: "en",
      slug: "same",
    });
    expect(res).toMatchObject({ ok: true, record: { slug: "same", isCurrent: true } });
    expect(await repo.listSlugs(c.id)).toEqual([
      expect.objectContaining({ locale: "en", slug: "same", isCurrent: true }),
    ]);
    expect((await repo.getById(c.id))?.slug).toBe("same");
  });

  it("en: a Category.slug held by another category without an en row is taken, not a P2002", async () => {
    // As written by an API version older than CategorySlug.
    const legacy = await prisma.category.create({
      data: { slug: "legacy-x", name: "Legacy X", active: true },
    });
    const b = await repo.create({ slug: "other-y", name: "Other Y" });
    const res = await repo.setCurrentSlug({
      categoryId: b.id,
      locale: "en",
      slug: "legacy-x",
    });
    expect(res).toEqual({ ok: false, reason: "taken" });
    expect(await repo.listSlugs(b.id)).toEqual([
      expect.objectContaining({ slug: "other-y", isCurrent: true }),
    ]);
    expect(await repo.findSlug("en", "legacy-x")).toBeNull();
    expect((await repo.getById(legacy.id))?.slug).toBe("legacy-x");
  });

  it("works inside an interactive transaction after lockNaming", async () => {
    const c = await repo.create({ slug: "tx-a", name: "Tx A" });
    const res = await prisma.$transaction(async (tx) => {
      const txRepo = makeCategoriesRepo(tx);
      await txRepo.lockNaming();
      const en = await txRepo.setCurrentSlug({
        categoryId: c.id,
        locale: "en",
        slug: "tx-b",
      });
      const es = await txRepo.setCurrentSlug({
        categoryId: c.id,
        locale: "es",
        slug: "tx-es",
      });
      return { en, es };
    });
    expect(res.en.ok && res.es.ok).toBe(true);
    expect((await repo.getById(c.id))?.slug).toBe("tx-b");
    const current = (await repo.listSlugs(c.id)).filter((r) => r.isCurrent);
    expect(current.map((r) => `${r.locale}:${r.slug}`).sort()).toEqual([
      "en:tx-b",
      "es:tx-es",
    ]);
  });

  it("a failure later in the transaction rolls the change back; the old slug stays current", async () => {
    const c = await repo.create({ slug: "rb-old", name: "Rollback" });
    await expect(
      prisma.$transaction(async (tx) => {
        const txRepo = makeCategoriesRepo(tx);
        await txRepo.lockNaming();
        const res = await txRepo.setCurrentSlug({
          categoryId: c.id,
          locale: "en",
          slug: "rb-new",
        });
        expect(res.ok).toBe(true);
        throw new Error("boom after the clear");
      }),
    ).rejects.toThrow("boom after the clear");
    expect(await repo.listSlugs(c.id)).toEqual([
      expect.objectContaining({ locale: "en", slug: "rb-old", isCurrent: true }),
    ]);
    expect(await repo.findSlug("en", "rb-new")).toBeNull();
    expect((await repo.getById(c.id))?.slug).toBe("rb-old");
  });

  it("readers drop a row whose locale is not supported", async () => {
    const c = await repo.create({ slug: "odd", name: "Odd" });
    await prisma.categorySlug.create({
      data: { categoryId: c.id, locale: "xx", slug: "odd", isCurrent: true },
    });
    expect((await repo.listSlugs(c.id)).map((r) => r.locale)).toEqual(["en"]);
    expect((await repo.findSlugsBySlug("odd")).map((r) => r.locale)).toEqual([
      "en",
    ]);
  });

  it("deleting the category cascades its slug rows", async () => {
    const c = await repo.create({ slug: "gone", name: "Gone" });
    await repo.setCurrentSlug({ categoryId: c.id, locale: "es", slug: "ido" });
    expect(await repo.deleteById(c.id)).toBe(true);
    expect(await repo.listSlugs(c.id)).toEqual([]);
    expect(await repo.findSlug("es", "ido")).toBeNull();
  });

  it("upsertSeed leaves an existing category without an en row as it is", async () => {
    // Pinned on purpose: the seed never repairs. ensureCategorySlugs is the
    // repair for a category written before CategorySlug.
    const legacy = await prisma.category.create({
      data: { slug: "seed-legacy", name: "Seed Legacy", active: true },
    });
    await repo.upsertSeed([{ slug: "seed-legacy", name: "Seed Legacy" }]);
    expect(await repo.listSlugs(legacy.id)).toEqual([]);
  });

  it("upsertSeed treats a seed slug held as another category's OLD en slug as present", async () => {
    const moved = await repo.create({ slug: "seed-old", name: "Seed Moved" });
    await repo.setCurrentSlug({
      categoryId: moved.id,
      locale: "en",
      slug: "seed-new",
    });

    // Would be a CategorySlug_locale_slug_key violation if it tried to create.
    await repo.upsertSeed([{ slug: "seed-old", name: "Seed Old" }]);

    expect(await repo.getBySlug("seed-old")).toBeNull();
    expect(await repo.findSlug("en", "seed-old")).toMatchObject({
      categoryId: moved.id,
      isCurrent: false,
    });
    expect(await prisma.category.count({ where: { name: "Seed Old" } })).toBe(
      0,
    );
  });

  it("upsertSeed writes the en row and is idempotent", async () => {
    await repo.upsertSeed([{ slug: "seeded", name: "Seeded" }]);
    await repo.upsertSeed([{ slug: "seeded", name: "Seeded" }]);
    const cat = await repo.getBySlug("seeded");
    expect(cat).not.toBeNull();
    expect(await repo.listSlugs(cat!.id)).toEqual([
      expect.objectContaining({ locale: "en", slug: "seeded", isCurrent: true }),
    ]);
  });
});
