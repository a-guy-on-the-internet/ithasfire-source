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
import { makeEventsRepo } from "../events";

// ---------------------------------------------------------------------------
// Gated events list, but do not make a page indexable (owner ruling
// 2026-10-13), against REAL Postgres. Pins what mocks cannot: the Prisma
// `gateType` where and the raw-SQL `e."gateType" = 'NONE'` clause both run,
// and the category page's indexability count, the category sitemap, the
// geo×category page's ungated count and the geo×category sitemap agree.
//
// Runs on a throwaway `test_*` database: a Testcontainer by default, or an
// existing server via TESTCONTAINERS_REUSE_DATABASE_URL (no container).
// ---------------------------------------------------------------------------

const CAT_MIXED = "40000000-0000-4000-8000-000000000001";
const CAT_GATED = "40000000-0000-4000-8000-000000000002";

describe("gated events and indexability on real Postgres", () => {
  let pgContainer: PostgresTestContainer | undefined;
  let pool: pg.Pool | undefined;
  let prisma: PrismaClient;
  const now = new Date();

  beforeAll(async () => {
    pgContainer = await startPostgresContainer();
    await runPrismaMigrateDeploy(pgContainer.databaseUrl);
    pool = new pg.Pool({ connectionString: pgContainer.databaseUrl });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

    await prisma.category.createMany({
      data: [
        {
          id: CAT_MIXED,
          slug: "open-mics",
          name: "Open Mics",
          nameTranslations: { es: "Micrófonos abiertos" },
        },
        { id: CAT_GATED, slug: "secret-shows", name: "Secret Shows" },
      ],
    });

    const later = new Date(now.getTime() + 7 * 24 * 3600 * 1000);
    const base = {
      status: "PUBLISHED" as const,
      visibility: "PUBLIC" as const,
      stewardship: "COMMUNITY" as const,
      attendanceMode: "RSVP" as const,
      countryCode: "US",
      startsAt: later,
      endsAt: new Date(later.getTime() + 3600 * 1000),
    };
    const event = (
      slug: string,
      categoryId: string,
      locality: string,
      regionCode: string,
      gateType: "NONE" | "PASSWORD" | "APPLICATION",
    ) => ({
      ...base,
      title: slug,
      slug,
      categoryId,
      locality,
      regionCode,
      gateType,
    });
    await prisma.event.createMany({
      data: [
        // Open mics, Nashville: 3 listed, 1 gated.
        event("nash-1", CAT_MIXED, "Nashville", "TN", "NONE"),
        event("nash-2", CAT_MIXED, "Nashville", "TN", "NONE"),
        event("nash-3", CAT_MIXED, "Nashville", "TN", "PASSWORD"),
        // Open mics, Memphis: 3 listed, none gated.
        event("mem-1", CAT_MIXED, "Memphis", "TN", "NONE"),
        event("mem-2", CAT_MIXED, "Memphis", "TN", "NONE"),
        event("mem-3", CAT_MIXED, "Memphis", "TN", "NONE"),
        // Secret shows, Austin: 3 listed, every one gated.
        event("sec-1", CAT_GATED, "Austin", "TX", "PASSWORD"),
        event("sec-2", CAT_GATED, "Austin", "TX", "APPLICATION"),
        event("sec-3", CAT_GATED, "Austin", "TX", "PASSWORD"),
      ],
    });
  }, 300_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
    await pgContainer?.stop();
  }, 120_000);

  it("lists a gated-only category but does not count it as indexable", async () => {
    const events = makeEventsRepo(prisma);

    const listed = await events.filterByCategory({
      categorySlug: "secret-shows",
      startsAfter: now,
    });
    expect(listed.pageInfo.total).toBe(3);

    await expect(
      events.countIndexableByCategory({
        categorySlug: "secret-shows",
        startsAfter: now,
      }),
    ).resolves.toBe(0);
    await expect(
      events.countIndexableByCategory({
        categorySlug: "open-mics",
        startsAfter: now,
      }),
    ).resolves.toBe(5);
  });

  it("leaves the gated-only category out of the category sitemap", async () => {
    const rows = await makeCategoriesRepo(prisma).listActiveWithUpcomingEvents({
      now,
    });

    expect(rows.map((c) => c.slug)).toEqual(["open-mics"]);
  });

  it("counts only ungated events toward a geo×category combo", async () => {
    const combos = await makeEventsRepo(prisma).enumerateGeoCategoryCombos({
      minCount: 3,
      startsAfter: now,
    });

    expect(
      combos.map((c) => `${c.categorySlug}/${c.locality}/${c.count}`),
    ).toEqual(["open-mics/Memphis/3"]);
  });

  it("carries the category's translated names on a combo and on its events", async () => {
    const events = makeEventsRepo(prisma);
    const combos = await events.enumerateGeoCategoryCombos({
      minCount: 3,
      startsAfter: now,
    });
    expect(combos[0]?.categoryNameTranslations).toEqual({
      es: "Micrófonos abiertos",
    });

    const listed = await events.filterByCategory({
      categorySlug: "open-mics",
      startsAfter: now,
    });
    expect(listed.items[0]?.categoryName).toBe("Open Mics");
    expect(listed.items[0]?.categoryNameTranslations).toEqual({
      es: "Micrófonos abiertos",
    });

    // A category with no translations reads as `{}`, never null.
    const plain = await events.filterByCategory({
      categorySlug: "secret-shows",
      startsAfter: now,
    });
    expect(plain.items[0]?.categoryNameTranslations).toEqual({});
  });

  it("lists every match on the geo×category page and reports the ungated count apart", async () => {
    const page = await makeEventsRepo(prisma).listPublishedByCategoryAndCity({
      categorySlug: "open-mics",
      citySlug: "nashville",
      region: "tn",
      limit: 48,
      offset: 0,
      startsAfter: now,
    });

    expect(page.items.map((e) => e.slug).sort()).toEqual([
      "nash-1",
      "nash-2",
      "nash-3",
    ]);
    expect(page.pageInfo.total).toBe(3);
    expect(page.indexableTotal).toBe(2);
  });

  it("leaves gated events out of the event sitemap", async () => {
    const entries = await makeEventsRepo(prisma).listPublishedForSitemap({
      now,
    });

    expect(entries.map((e) => e.slug).sort()).toEqual([
      "mem-1",
      "mem-2",
      "mem-3",
      "nash-1",
      "nash-2",
    ]);
  });
});
