import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

import {
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { makeEventsRepo } from "../events";

// ---------------------------------------------------------------------------
// Integration coverage for EventsRepo.discoverActiveCities — the risk is the
// Prisma query SHAPE (multi-field groupBy + COUNT + ordering + the visibility
// gate). A fully-mocked test can't catch it: the original implementation read
// from the search index, where event rows never populate `city`/`isPublic`, so
// it returned ZERO cities against real data. This test hits Postgres directly.
//
// Standalone DDL (mirrors the Event columns the query references) WITHOUT the
// FKs/unrelated columns so the table is self-contained — only the columns the
// query touches exist. `endsAt` is NOT NULL in the real schema; included so
// inserts are realistic even though the query ignores it.
// ---------------------------------------------------------------------------

const TABLE_SQL = `
CREATE TYPE "EventStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'CANCELLED', 'COMPLETED', 'ARCHIVED');
CREATE TYPE "EventVisibility" AS ENUM ('PUBLIC', 'PRIVATE');
CREATE TYPE "EventLocationMode" AS ENUM ('EXACT', 'OBSCURED');
CREATE TYPE "HumanStatus" AS ENUM ('INVITED', 'ACTIVE', 'SUSPENDED', 'BANNED');
CREATE TYPE "OrgRole" AS ENUM ('OWNER', 'ADMIN', 'EDITOR', 'FINANCE', 'SCANNER', 'VIEWER');

-- Only what the banned-owner filter reads (a ban sticks).
CREATE TABLE "Human" (
  "id" TEXT PRIMARY KEY,
  "status" "HumanStatus" NOT NULL DEFAULT 'ACTIVE'
);
CREATE TABLE "OrgMember" (
  "orgId" TEXT NOT NULL,
  "humanId" TEXT NOT NULL,
  "role" "OrgRole" NOT NULL
);

-- Only what the centroid filter reads (place-address-withholding D2).
CREATE TABLE "Place" (
  "id" TEXT NOT NULL,
  "location_mode" "EventLocationMode" NOT NULL DEFAULT 'EXACT',
  CONSTRAINT "Place_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Event" (
  "id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "status" "EventStatus" NOT NULL DEFAULT 'DRAFT',
  "visibility" "EventVisibility" NOT NULL DEFAULT 'PUBLIC',
  "startsAt" TIMESTAMP(3) NOT NULL,
  "endsAt" TIMESTAMP(3) NOT NULL,
  "locality" TEXT,
  "regionCode" TEXT,
  "countryCode" TEXT,
  "lat" DOUBLE PRECISION,
  "lng" DOUBLE PRECISION,
  "placeId" TEXT,
  "locationMode" "EventLocationMode" NOT NULL DEFAULT 'EXACT',
  "humanId" TEXT,
  "orgId" TEXT,

  CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);
`;

const NOW = new Date("2026-07-01T12:00:00.000Z");
const UPCOMING = new Date("2026-08-01T20:00:00.000Z");
const PAST = new Date("2026-06-01T20:00:00.000Z");

describe("discoverActiveCities (integration)", () => {
  let pgContainer: PostgresTestContainer | undefined;
  let pool: pg.Pool | undefined;
  let prisma: PrismaClient | undefined;

  beforeAll(async () => {
    pgContainer = await startPostgresContainer();
    pool = new pg.Pool({ connectionString: pgContainer.databaseUrl });
    await pool.query(TABLE_SQL);
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  }, 300_000);

  beforeEach(async () => {
    await pool?.query(`TRUNCATE "Event", "Place", "Human", "OrgMember"`);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
    await pgContainer?.stop();
  });

  let seq = 0;
  async function insertEvent(opts: {
    status?: string;
    visibility?: string;
    startsAt?: Date;
    locality?: string | null;
    regionCode?: string | null;
    countryCode?: string | null;
    lat?: number | null;
    lng?: number | null;
    placeId?: string | null;
    locationMode?: "EXACT" | "OBSCURED";
    humanId?: string | null;
    orgId?: string | null;
  }) {
    const id = `evt-${seq++}`;
    await pool!.query(
      `INSERT INTO "Event"
        ("id", "title", "status", "visibility", "startsAt", "endsAt", "locality", "regionCode", "countryCode", "lat", "lng",
         "placeId", "locationMode", "humanId", "orgId")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::"EventLocationMode", $14, $15)`,
      [
        id,
        `Event ${id}`,
        opts.status ?? "PUBLISHED",
        opts.visibility ?? "PUBLIC",
        opts.startsAt ?? UPCOMING,
        opts.startsAt ?? UPCOMING,
        opts.locality === undefined ? "Nashville" : opts.locality,
        opts.regionCode === undefined ? "TN" : opts.regionCode,
        opts.countryCode === undefined ? "US" : opts.countryCode,
        opts.lat === undefined ? null : opts.lat,
        opts.lng === undefined ? null : opts.lng,
        opts.placeId ?? null,
        opts.locationMode ?? "EXACT",
        opts.humanId ?? null,
        opts.orgId ?? null,
      ],
    );
  }

  async function insertPlace(id: string, locationMode: "EXACT" | "OBSCURED") {
    await pool!.query(
      `INSERT INTO "Place" ("id", "location_mode") VALUES ($1, $2::"EventLocationMode")`,
      [id, locationMode],
    );
  }

  async function insertHuman(id: string, status: "ACTIVE" | "BANNED") {
    await pool!.query(`INSERT INTO "Human" ("id", "status") VALUES ($1, $2::"HumanStatus")`, [id, status]);
  }

  async function insertOwner(orgId: string, humanId: string) {
    await pool!.query(
      `INSERT INTO "OrgMember" ("orgId", "humanId", "role") VALUES ($1, $2, 'OWNER'::"OrgRole")`,
      [orgId, humanId],
    );
  }

  test("groups PUBLISHED+PUBLIC upcoming events by city, ordered by count desc then city asc", async () => {
    // Nashville x3, Austin x2, Denver x1 — all published/public/upcoming.
    await insertEvent({ locality: "Nashville", regionCode: "TN" });
    await insertEvent({ locality: "Nashville", regionCode: "TN" });
    await insertEvent({ locality: "Nashville", regionCode: "TN" });
    await insertEvent({ locality: "Austin", regionCode: "TX" });
    await insertEvent({ locality: "Austin", regionCode: "TX" });
    await insertEvent({ locality: "Denver", regionCode: "CO" });

    const repo = makeEventsRepo(prisma!);
    const cities = await repo.discoverActiveCities({ startsAfter: NOW });

    expect(cities).toStrictEqual([
      { city: "Nashville", regionCode: "TN", countryCode: "US", eventCount: 3, lat: null, lng: null },
      { city: "Austin", regionCode: "TX", countryCode: "US", eventCount: 2, lat: null, lng: null },
      { city: "Denver", regionCode: "CO", countryCode: "US", eventCount: 1, lat: null, lng: null },
    ]);
  });

  test("excludes DRAFT, PRIVATE, past-dated, and null/empty-locality events", async () => {
    // The one row that SHOULD survive.
    await insertEvent({ locality: "Nashville", regionCode: "TN" });
    // Negative cases — none may appear.
    await insertEvent({ status: "DRAFT", locality: "Memphis" });
    await insertEvent({ visibility: "PRIVATE", locality: "Knoxville" });
    await insertEvent({ startsAt: PAST, locality: "Chattanooga" });
    await insertEvent({ locality: null });
    await insertEvent({ locality: "" });

    const repo = makeEventsRepo(prisma!);
    const cities = await repo.discoverActiveCities({ startsAfter: NOW });

    expect(cities).toStrictEqual([
      { city: "Nashville", regionCode: "TN", countryCode: "US", eventCount: 1, lat: null, lng: null },
    ]);
  });

  test("does NOT leak a PRIVATE event's city even when a PUBLIC event shares nothing", async () => {
    // A PRIVATE event in Knoxville must never surface — visibility is the gate.
    await insertEvent({ visibility: "PRIVATE", locality: "Knoxville" });

    const repo = makeEventsRepo(prisma!);
    const cities = await repo.discoverActiveCities({ startsAfter: NOW });

    expect(cities).toStrictEqual([]);
  });

  test("country filter is case-insensitive-normalized (trim + uppercase) exact match", async () => {
    await insertEvent({ locality: "Nashville", countryCode: "US" });
    await insertEvent({ locality: "Toronto", regionCode: "ON", countryCode: "CA" });

    const repo = makeEventsRepo(prisma!);
    const us = await repo.discoverActiveCities({
      startsAfter: NOW,
      countryCode: "  us  ",
    });

    expect(us).toStrictEqual([
      { city: "Nashville", regionCode: "TN", countryCode: "US", eventCount: 1, lat: null, lng: null },
    ]);
  });

  test("respects the limit cap on the number of distinct cities", async () => {
    await insertEvent({ locality: "Nashville" });
    await insertEvent({ locality: "Austin" });
    await insertEvent({ locality: "Denver" });

    const repo = makeEventsRepo(prisma!);
    const cities = await repo.discoverActiveCities({
      startsAfter: NOW,
      limit: 2,
    });

    expect(cities).toHaveLength(2);
  });

  test("preserves a null regionCode/countryCode in the output", async () => {
    await insertEvent({ locality: "Nowhere", regionCode: null, countryCode: null });

    const repo = makeEventsRepo(prisma!);
    const cities = await repo.discoverActiveCities({ startsAfter: NOW });

    expect(cities).toStrictEqual([
      { city: "Nowhere", regionCode: null, countryCode: null, eventCount: 1, lat: null, lng: null },
    ]);
  });

  test("returns the centroid (avg lat/lng) of a city's events, ignoring null-coord rows", async () => {
    // Two Nashville events with known coords → centroid is their average.
    // A third Nashville event with NULL coords must NOT skew the average
    // (Postgres AVG ignores nulls).
    await insertEvent({ locality: "Nashville", lat: 36.0, lng: -86.0 });
    await insertEvent({ locality: "Nashville", lat: 36.2, lng: -86.4 });
    await insertEvent({ locality: "Nashville", lat: null, lng: null });
    // A separate city whose events ALL lack coords → centroid is null.
    await insertEvent({ locality: "Austin", regionCode: "TX", lat: null, lng: null });

    const repo = makeEventsRepo(prisma!);
    const cities = await repo.discoverActiveCities({ startsAfter: NOW });

    const nashville = cities.find((c) => c.city === "Nashville")!;
    expect(nashville.eventCount).toBe(3);
    expect(nashville.lat).toBeCloseTo(36.1, 5); // avg(36.0, 36.2)
    expect(nashville.lng).toBeCloseTo(-86.2, 5); // avg(-86.0, -86.4)

    const austin = cities.find((c) => c.city === "Austin")!;
    expect(austin.eventCount).toBe(1);
    expect(austin.lat).toBeNull();
    expect(austin.lng).toBeNull();
  });

  // ── place-address-withholding D2: the centroid never averages a house ────
  //
  // Every public row still COUNTS; only rows whose PUBLIC location is exact
  // (EXACT event, placeless or at an EXACT place) are AVERAGED. Otherwise a
  // town whose only upcoming public event is at a withheld house publishes
  // the house as the city centre.

  test("averages only the EXACT event, never the withheld house — but counts both", async () => {
    await insertPlace("house", "OBSCURED");
    await insertPlace("club", "EXACT");
    // The EXACT event at an EXACT venue.
    await insertEvent({ locality: "Madison", lat: 36.25, lng: -86.7, placeId: "club" });
    // A (legacy, true-copy) event at the withheld house: EXACT on the row,
    // but its venue withholds — must not move the centroid.
    await insertEvent({ locality: "Madison", lat: 36.2618, lng: -86.7071, placeId: "house" });
    // An event-level OBSCURED placeless event: counted, not averaged.
    await insertEvent({ locality: "Madison", lat: 36.3, lng: -86.9, locationMode: "OBSCURED" });

    const repo = makeEventsRepo(prisma!);
    const cities = await repo.discoverActiveCities({ startsAfter: NOW });

    expect(cities).toStrictEqual([
      { city: "Madison", regionCode: "TN", countryCode: "US", eventCount: 3, lat: 36.25, lng: -86.7 },
    ]);
  });

  test("a city whose only public event is at a withheld house: counted, with NULL coordinates", async () => {
    await insertPlace("house", "OBSCURED");
    await insertEvent({ locality: "Goodlettsville", lat: 36.3231, lng: -86.7133, placeId: "house" });
    await insertEvent({ locality: "Nashville", lat: 36.16, lng: -86.78 });

    const repo = makeEventsRepo(prisma!);
    const cities = await repo.discoverActiveCities({ startsAfter: NOW });

    expect(cities).toStrictEqual([
      { city: "Goodlettsville", regionCode: "TN", countryCode: "US", eventCount: 1, lat: null, lng: null },
      { city: "Nashville", regionCode: "TN", countryCode: "US", eventCount: 1, lat: 36.16, lng: -86.78 },
    ]);
  });

  // ── a ban sticks: a banned owner's events leave the city counts ──────────

  test("an event owned by a BANNED human does not count toward its city", async () => {
    await insertHuman("banned", "BANNED");
    await insertHuman("fine", "ACTIVE");
    await insertEvent({ locality: "Nashville", humanId: "banned" });
    await insertEvent({ locality: "Nashville", humanId: "fine" });
    await insertEvent({ locality: "Austin", regionCode: "TX", humanId: "banned" });

    const repo = makeEventsRepo(prisma!);
    const cities = await repo.discoverActiveCities({ startsAfter: NOW });

    expect(cities).toStrictEqual([
      { city: "Nashville", regionCode: "TN", countryCode: "US", eventCount: 1, lat: null, lng: null },
    ]);
  });

  test("an event of an org whose only OWNER is BANNED is excluded", async () => {
    await insertHuman("banned", "BANNED");
    await insertOwner("org-dark", "banned");
    await insertEvent({ locality: "Memphis", orgId: "org-dark" });
    await insertEvent({ locality: "Nashville" });

    const repo = makeEventsRepo(prisma!);
    const cities = await repo.discoverActiveCities({ startsAfter: NOW });

    expect(cities).toStrictEqual([
      { city: "Nashville", regionCode: "TN", countryCode: "US", eventCount: 1, lat: null, lng: null },
    ]);
  });

  test("an org with a banned OWNER and an ACTIVE OWNER still counts", async () => {
    await insertHuman("banned", "BANNED");
    await insertHuman("fine", "ACTIVE");
    await insertOwner("org-shared", "banned");
    await insertOwner("org-shared", "fine");
    await insertEvent({ locality: "Nashville", orgId: "org-shared" });

    const repo = makeEventsRepo(prisma!);
    const cities = await repo.discoverActiveCities({ startsAfter: NOW });

    expect(cities).toStrictEqual([
      { city: "Nashville", regionCode: "TN", countryCode: "US", eventCount: 1, lat: null, lng: null },
    ]);
  });
});
