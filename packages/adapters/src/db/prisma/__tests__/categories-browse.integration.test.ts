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
// The homepage offers a category only when its page lists something (owner
// ruling 2026-10-14), against REAL Postgres. `listActiveWithListedEvents` is
// the browse rule; it must agree with what the category page lists
// (`filterByCategory`), and it differs from the sitemap's
// `listActiveWithUpcomingEvents` on gated events only.
//
// Runs on a throwaway `test_*` database: a Testcontainer by default, or an
// existing server via TESTCONTAINERS_REUSE_DATABASE_URL (no container).
// ---------------------------------------------------------------------------

const CAT = {
  // sortOrder 1..: the shape on production, where the early categories are
  // empty and the one with content sorts late.
  pastOnly: { id: "41000000-0000-4000-8000-000000000001", slug: "past-only" },
  draftOnly: { id: "41000000-0000-4000-8000-000000000002", slug: "draft-only" },
  privateOnly: {
    id: "41000000-0000-4000-8000-000000000003",
    slug: "private-only",
  },
  empty: { id: "41000000-0000-4000-8000-000000000004", slug: "empty" },
  gatedOnly: { id: "41000000-0000-4000-8000-000000000005", slug: "gated-only" },
  inactive: { id: "41000000-0000-4000-8000-000000000006", slug: "inactive" },
  openMics: { id: "41000000-0000-4000-8000-000000000007", slug: "open-mics" },
  // Same sortOrder as open-mics: the tie breaks on name.
  aTie: { id: "41000000-0000-4000-8000-000000000008", slug: "a-tie" },
} as const;

describe("categories.listActiveWithListedEvents on real Postgres", () => {
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
        { ...CAT.pastOnly, name: "Past Only", sortOrder: 1 },
        { ...CAT.draftOnly, name: "Draft Only", sortOrder: 2 },
        { ...CAT.privateOnly, name: "Private Only", sortOrder: 3 },
        { ...CAT.empty, name: "Empty", sortOrder: 4 },
        { ...CAT.gatedOnly, name: "Gated Only", sortOrder: 5 },
        { ...CAT.inactive, name: "Inactive", sortOrder: 6, active: false },
        { ...CAT.openMics, name: "Standup Open Mic", sortOrder: 9 },
        { ...CAT.aTie, name: "A Tie", sortOrder: 9 },
      ],
    });

    const later = new Date(now.getTime() + 7 * 24 * 3600 * 1000);
    const earlier = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
    const event = (
      slug: string,
      categoryId: string,
      overrides: Partial<{
        status: "PUBLISHED" | "DRAFT";
        visibility: "PUBLIC" | "PRIVATE";
        gateType: "NONE" | "PASSWORD" | "APPLICATION";
        startsAt: Date;
      }> = {},
    ) => {
      const startsAt = overrides.startsAt ?? later;
      return {
        status: overrides.status ?? ("PUBLISHED" as const),
        visibility: overrides.visibility ?? ("PUBLIC" as const),
        gateType: overrides.gateType ?? ("NONE" as const),
        stewardship: "COMMUNITY" as const,
        attendanceMode: "RSVP" as const,
        countryCode: "US",
        locality: "Nashville",
        regionCode: "TN",
        title: slug,
        slug,
        categoryId,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 3600 * 1000),
      };
    };
    await prisma.event.createMany({
      data: [
        event("past-1", CAT.pastOnly.id, { startsAt: earlier }),
        event("draft-1", CAT.draftOnly.id, { status: "DRAFT" }),
        event("private-1", CAT.privateOnly.id, { visibility: "PRIVATE" }),
        event("gated-1", CAT.gatedOnly.id, { gateType: "PASSWORD" }),
        event("gated-2", CAT.gatedOnly.id, { gateType: "APPLICATION" }),
        event("inactive-1", CAT.inactive.id),
        event("mic-1", CAT.openMics.id),
        event("tie-1", CAT.aTie.id),
      ],
    });
  }, 300_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
    await pgContainer?.stop();
  }, 120_000);

  it("offers only active categories whose page lists an upcoming event, in sortOrder then name", async () => {
    const rows = await makeCategoriesRepo(prisma).listActiveWithListedEvents({
      now,
    });

    // past-only, draft-only, private-only and empty list nothing; inactive
    // has an event but is off. gated-only lists its gated events, so it is
    // offered.
    expect(rows.map((c) => c.slug)).toEqual(["gated-only", "a-tie", "open-mics"]);
    expect(rows.find((c) => c.slug === "open-mics")).toEqual({
      id: CAT.openMics.id,
      slug: "open-mics",
      name: "Standup Open Mic",
      nameTranslations: {},
      active: true,
      sortOrder: 9,
      seoType: "Event",
    });
  });

  it("includes a gated-only category, which the sitemap leaves out", async () => {
    const repo = makeCategoriesRepo(prisma);

    const browse = await repo.listActiveWithListedEvents({ now });
    const sitemap = await repo.listActiveWithUpcomingEvents({ now });

    expect(browse.map((c) => c.slug)).toContain("gated-only");
    expect(sitemap.map((c) => c.slug)).not.toContain("gated-only");
  });

  it("agrees with what each category page lists", async () => {
    const offered = new Set(
      (
        await makeCategoriesRepo(prisma).listActiveWithListedEvents({ now })
      ).map((c) => c.slug),
    );
    const events = makeEventsRepo(prisma);

    for (const { slug } of Object.values(CAT)) {
      const listed = await events.filterByCategory({
        categorySlug: slug,
        startsAfter: now,
      });
      expect({ slug, offered: offered.has(slug) }).toEqual({
        slug,
        offered: listed.pageInfo.total > 0,
      });
    }
  });

  it("offers nothing once every listed event has started", async () => {
    const afterEverything = new Date(now.getTime() + 30 * 24 * 3600 * 1000);

    await expect(
      makeCategoriesRepo(prisma).listActiveWithListedEvents({
        now: afterEverything,
      }),
    ).resolves.toEqual([]);
  });
});
