import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

import { encodeGeohash } from "@th/core/lib/geo/geohash";
import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { makeEventsRepo } from "../../src/db/prisma/events";
import { DbGeoAdapter } from "../../src/geo/db-geo-adapter";

/**
 * H3 + M5 against real Postgres: anonymous event surfaces return ONLY
 * published + PUBLIC (+ ungated where the location is shown) events.
 *
 *   · "surprise me" (`pickRandomEvent`, with and without `near`) — drafts,
 *     private and gated events used to be reachable with `publishedOnly:
 *     false`, exact address included;
 *   · the public map (`DbGeoAdapter.nearbyEvents` / `boxSearch`);
 *   · anonymous title search (`searchPublished`);
 *   · public listings (`filterByCategory`, `listPublishedByRegion`,
 *     `listPublishedByCountry`) — PRIVATE is link-only, never listed.
 *
 * Every event sits at the SAME exact point, in the same window, category,
 * region and country, with the same title stem — the ONLY difference is
 * status / visibility / gate.
 */

const POINT = { lat: 36.1775, lng: -86.7412 };
const STARTS = new Date("2031-06-01T20:00:00.000Z");
const WINDOW = {
  from: new Date("2031-05-01T00:00:00.000Z"),
  to: new Date("2031-07-01T00:00:00.000Z"),
};
const TITLE = "Visibility Probe";

describe("Prisma adapters integration – public event visibility (H3 / M5)", () => {
  let pg: PostgresTestContainer | undefined;
  let pool: Pool | undefined;
  let prisma: PrismaClient | undefined;
  let runtimeError: Error | null = null;
  const ids: Record<string, string> = {};
  let categorySlug = "";
  let ownerHumanId = "";

  beforeAll(async () => {
    try {
      pg = await startPostgresContainer();
      await runPrismaMigrateDeploy(pg.databaseUrl);
      process.env.DATABASE_URL = pg.databaseUrl;
      pool = new Pool({ connectionString: pg.databaseUrl });
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

      const human = await prisma.human.create({
        data: { name: "Visibility Owner", status: "ACTIVE" },
      });
      ownerHumanId = human.id;
      const category = await prisma.category.create({
        data: { slug: "visibility-probe", name: "Visibility Probe" },
      });
      categorySlug = category.slug;

      const variants = {
        public: { status: "PUBLISHED", visibility: "PUBLIC", gateType: "NONE" },
        draft: { status: "DRAFT", visibility: "PUBLIC", gateType: "NONE" },
        private: { status: "PUBLISHED", visibility: "PRIVATE", gateType: "NONE" },
        password: { status: "PUBLISHED", visibility: "PUBLIC", gateType: "PASSWORD" },
        application: {
          status: "PUBLISHED",
          visibility: "PUBLIC",
          gateType: "APPLICATION",
        },
      } as const;
      for (const [name, v] of Object.entries(variants)) {
        const event = await prisma.event.create({
          data: {
            title: `${TITLE} ${name}`,
            startsAt: STARTS,
            endsAt: new Date(STARTS.getTime() + 3 * 3_600_000),
            humanId: human.id,
            status: v.status,
            visibility: v.visibility,
            gateType: v.gateType,
            locationMode: "EXACT",
            addressText: "1417 Shelby Ave, Nashville, TN 37206",
            lat: POINT.lat,
            lng: POINT.lng,
            geohash6: encodeGeohash(POINT.lat, POINT.lng, 6),
            locality: "Nashville",
            region: "TN",
            regionCode: "us-tn",
            countryCode: "US",
            categoryId: category.id,
          },
        });
        ids[name] = event.id;
      }

      // A freeform OBSCURED event: its row is the only record of the street,
      // so it holds the TRUE address (W6) — searchable by nobody.
      const house = await prisma.event.create({
        data: {
          title: "Backyard Set",
          startsAt: STARTS,
          endsAt: new Date(STARTS.getTime() + 3 * 3_600_000),
          humanId: human.id,
          status: "PUBLISHED",
          locationMode: "OBSCURED",
          locationRadiusMeters: 500,
          addressText: "88 Hidden Hollow Rd, Nashville, TN 37206",
          // Far from POINT, so it never enters the map/pick assertions above.
          lat: 40.5,
          lng: -100.5,
          locality: "Nashville",
          region: "TN",
        },
      });
      ids.obscuredFreeform = house.id;
    } catch (error) {
      runtimeError = error as Error;
      // eslint-disable-next-line no-console
      console.error("public-event-visibility integration setup failed:", error);
    }
  }, 300_000);

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
    if (pool) await pool.end();
    if (pg) await pg.stop();
  });

  test("integration environment is up (canary — do not skip)", () => {
    expect(runtimeError).toBeNull();
    expect(prisma).toBeDefined();
  });

  test("H3: surprise-me (no near) only ever picks the published, PUBLIC, ungated event", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const repo = makeEventsRepo(prisma);
    const base = {
      window: WINDOW,
      near: null,
      q: TITLE,
      orgId: null,
      placeId: null,
    };
    const seen = new Set<string>();
    for (let i = 0; i < 25; i += 1) {
      const picked = await repo.pickRandomEvent({ ...base, excludeEventIds: [] });
      if (picked) seen.add(picked.id);
    }
    expect([...seen]).toEqual([ids.public]);
    // With the one legitimate event excluded there is NOTHING else to pick.
    await expect(
      repo.pickRandomEvent({ ...base, excludeEventIds: [ids.public!] }),
    ).resolves.toBeNull();
    // A stray client flag cannot widen it (the port has none).
    await expect(
      repo.pickRandomEvent({
        ...base,
        excludeEventIds: [ids.public!],
        publishedOnly: false,
      } as never),
    ).resolves.toBeNull();
  }, 60_000);

  test("H3: surprise-me WITH near only ever picks the published, PUBLIC, ungated event", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const repo = makeEventsRepo(prisma);
    const base = {
      window: WINDOW,
      near: { ...POINT, radiusKm: 1 },
      q: TITLE,
      orgId: null,
      placeId: null,
    };
    const seen = new Set<string>();
    for (let i = 0; i < 25; i += 1) {
      const picked = await repo.pickRandomEvent({ ...base, excludeEventIds: [] });
      if (picked) seen.add(picked.id);
    }
    expect([...seen]).toEqual([ids.public]);
    await expect(
      repo.pickRandomEvent({ ...base, excludeEventIds: [ids.public!] }),
    ).resolves.toBeNull();
  }, 60_000);

  test("M5: the public map (nearbyEvents + boxSearch) shows only the published, PUBLIC, ungated event", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const geo = new DbGeoAdapter(prisma);
    const near = await geo.nearbyEvents({ ...POINT, radiusM: 1_000 });
    expect(near.items.map((e) => e.id)).toEqual([ids.public]);
    expect(near.pageInfo.total).toBe(1);
    const box = await geo.boxSearch({
      entity: "event",
      sw: { lat: POINT.lat - 0.05, lng: POINT.lng - 0.05 },
      ne: { lat: POINT.lat + 0.05, lng: POINT.lng + 0.05 },
    });
    expect(box.map((e) => e.id)).toEqual([ids.public]);
  }, 60_000);

  test("M5: anonymous title search returns only the published, PUBLIC, ungated event", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const found = await makeEventsRepo(prisma).searchPublished({ query: TITLE });
    expect(found.map((e) => e.id)).toEqual([ids.public]);
  }, 60_000);

  test("M5: public listings never list a PRIVATE (or draft) event", async ({ skip }) => {
    if (runtimeError || !prisma) return skip();
    const repo = makeEventsRepo(prisma);
    const listed = [
      (await repo.filterByCategory({ categorySlug })).items,
      (await repo.listPublishedByRegion({ regionCode: "us-tn" })).items,
      (await repo.listPublishedByCountry({ countryCode: "US" })).items,
      // The global discover feed's read.
      (await repo.listPublished({ visibility: ["PUBLIC"], limit: 500 })).items,
    ];
    for (const items of listed) {
      const got = new Set(items.map((e) => e.id));
      expect(got.has(ids.public!)).toBe(true);
      expect(got.has(ids.private!)).toBe(false);
      expect(got.has(ids.draft!)).toBe(false);
    }
  }, 60_000);

  test("listByOwner search never matches a street that is not public (no inclusion oracle for any org role)", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const repo = makeEventsRepo(prisma);
    const search = async (query: string) =>
      (
        await repo.listByOwner({
          ownerType: "HUMAN",
          ownerId: ownerHumanId,
          query,
        })
      ).items.map((e) => e.id);

    // The OBSCURED freeform street matches NOTHING — not even partially.
    expect(await search("Hidden Hollow")).toEqual([]);
    expect(await search("88 Hidden")).toEqual([]);
    // Its title still finds it.
    expect(await search("Backyard")).toEqual([ids.obscuredFreeform]);
    // An EXACT event's (public) street still matches.
    expect((await search("1417 Shelby")).length).toBeGreaterThan(0);
  }, 60_000);
});
