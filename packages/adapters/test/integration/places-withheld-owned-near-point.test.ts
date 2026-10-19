import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { makePlacesRepo } from "../../src/db/prisma/places";

/**
 * `listWithheldOwnedNearPoint` — the candidate read behind the save path's
 * "this freeform address is your own withheld place" refusal
 * (place-address-withholding N2).
 *
 * What it must be, against real Postgres:
 *   · OWNER-SCOPED: only places the given human owns directly, or the given
 *     orgs own (verified, unrevoked). A stranger's withheld house at the
 *     same point is never a candidate — the lookup is not an oracle;
 *   · WITHHELD only (`location_mode <> 'EXACT'`), ACTIVE only;
 *   · a bounding box around the point (the caller measures true distance).
 *
 * Fixture, all near 36.1862, -86.7291 (Nashville) unless stated:
 *   Sarah's House   OBSCURED  owned by SARAH directly            ~0 m
 *   Org Loft        OBSCURED  owned by ORG                       ~30 m
 *   Open Hall       EXACT     owned by SARAH                     ~0 m
 *   Far House       OBSCURED  owned by SARAH                     ~5 km
 *   Stranger House  OBSCURED  owned by a STRANGER                ~0 m
 *   Revoked House   OBSCURED  SARAH's ownership REVOKED          ~0 m
 *   Closed House    OBSCURED  owned by SARAH, SUSPENDED          ~0 m
 */
describe("Prisma adapters integration – listWithheldOwnedNearPoint (N2)", () => {
  let pg: PostgresTestContainer | undefined;
  let pool: Pool | undefined;
  let prisma: PrismaClient | undefined;
  let runtimeError: Error | null = null;

  const SARAH = randomUUID();
  const STRANGER = randomUUID();
  const ORG = randomUUID();
  const LAT = 36.1862;
  const LNG = -86.7291;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    try {
      pg = await startPostgresContainer();
      await runPrismaMigrateDeploy(pg.databaseUrl);

      process.env.DATABASE_URL = pg.databaseUrl;
      // Driver-adapter mode: a bare `new PrismaClient()` throws — construct
      // it the way packages/db/src/index.ts does, with a pg Pool adapter.
      pool = new Pool({ connectionString: pg.databaseUrl });
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

      const fixtures: Array<{
        key: string;
        lat: number;
        lng: number;
        locationMode: "EXACT" | "OBSCURED";
        status?: "ACTIVE" | "SUSPENDED";
        ownerType: "HUMAN" | "ORGANIZATION";
        ownerId: string;
        revoked?: boolean;
      }> = [
        { key: "sarahs", lat: LAT, lng: LNG, locationMode: "OBSCURED", ownerType: "HUMAN", ownerId: SARAH },
        { key: "orgLoft", lat: LAT + 30 / 111_320, lng: LNG, locationMode: "OBSCURED", ownerType: "ORGANIZATION", ownerId: ORG },
        { key: "openHall", lat: LAT, lng: LNG, locationMode: "EXACT", ownerType: "HUMAN", ownerId: SARAH },
        { key: "far", lat: LAT + 5_000 / 111_320, lng: LNG, locationMode: "OBSCURED", ownerType: "HUMAN", ownerId: SARAH },
        { key: "stranger", lat: LAT, lng: LNG, locationMode: "OBSCURED", ownerType: "HUMAN", ownerId: STRANGER },
        { key: "revoked", lat: LAT, lng: LNG, locationMode: "OBSCURED", ownerType: "HUMAN", ownerId: SARAH, revoked: true },
        { key: "closed", lat: LAT, lng: LNG, locationMode: "OBSCURED", status: "SUSPENDED", ownerType: "HUMAN", ownerId: SARAH },
      ];
      for (const fixture of fixtures) {
        const place = await prisma.place.create({
          data: {
            name: fixture.key,
            address: "901 Porter Rd",
            city: "Nashville",
            lat: fixture.lat,
            lng: fixture.lng,
            status: fixture.status ?? "ACTIVE",
            verification: "VERIFIED",
            locationMode: fixture.locationMode,
            locationRadiusMeters: fixture.locationMode === "EXACT" ? null : 500,
          },
        });
        ids[fixture.key] = place.id;
        await prisma.placeOwnership.create({
          data: {
            placeId: place.id,
            ownerType: fixture.ownerType,
            ownerId: fixture.ownerId,
            verified: true,
            ...(fixture.revoked ? { revokedAt: new Date() } : {}),
          },
        });
      }
    } catch (error) {
      runtimeError = error as Error;
      // eslint-disable-next-line no-console
      console.error("places-withheld-owned-near-point setup failed:", error);
    }
  }, 300_000);

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
    if (pool) await pool.end();
    if (pg) await pg.stop();
  });

  const ready = (skip: () => void): boolean => {
    if (runtimeError || !prisma) {
      skip();
      return false;
    }
    return true;
  };

  // Every other test skips when setup failed; this one does NOT — a broken
  // container / migrate deploy / client construction fails the suite loudly.
  test("setup succeeded (container + migrate deploy + driver-adapter client)", () => {
    expect(runtimeError).toBeNull();
    expect(prisma).toBeDefined();
  });

  test("only the caller's OWN withheld, active places near the point come back", async ({ skip }) => {
    if (!ready(skip)) return;
    const places = makePlacesRepo(prisma!);

    const found = await places.listWithheldOwnedNearPoint({
      humanId: SARAH,
      orgIds: [ORG],
      lat: LAT,
      lng: LNG,
      withinMeters: 50,
    });

    expect(found.map((p) => p.id).sort()).toEqual(
      [ids.sarahs!, ids.orgLoft!].sort(),
    );
    // Real rows, with the truth the caller measures against.
    const sarahs = found.find((p) => p.id === ids.sarahs);
    expect(sarahs).toMatchObject({ lat: LAT, lng: LNG, locationMode: "OBSCURED" });
    expect(sarahs?.humanIdsWithAccess).toContain(SARAH);
  }, 60_000);

  test("without the org, the org's place is not a candidate", async ({ skip }) => {
    if (!ready(skip)) return;
    const places = makePlacesRepo(prisma!);

    const found = await places.listWithheldOwnedNearPoint({
      humanId: SARAH,
      orgIds: [],
      lat: LAT,
      lng: LNG,
      withinMeters: 50,
    });

    expect(found.map((p) => p.id)).toEqual([ids.sarahs]);
  }, 60_000);

  test("NOT AN ORACLE: a stranger at the very same point gets only their own house", async ({ skip }) => {
    if (!ready(skip)) return;
    const places = makePlacesRepo(prisma!);

    const stranger = await places.listWithheldOwnedNearPoint({
      humanId: STRANGER,
      orgIds: [],
      lat: LAT,
      lng: LNG,
      withinMeters: 50,
    });
    expect(stranger.map((p) => p.id)).toEqual([ids.stranger]);

    const nobody = await places.listWithheldOwnedNearPoint({
      humanId: randomUUID(),
      orgIds: [randomUUID()],
      lat: LAT,
      lng: LNG,
      withinMeters: 50,
    });
    expect(nobody).toEqual([]);
  }, 60_000);

  test("bounded: limit is honoured and a far-away point matches nothing", async ({ skip }) => {
    if (!ready(skip)) return;
    const places = makePlacesRepo(prisma!);

    const one = await places.listWithheldOwnedNearPoint({
      humanId: SARAH,
      orgIds: [ORG],
      lat: LAT,
      lng: LNG,
      withinMeters: 50,
      limit: 1,
    });
    expect(one).toHaveLength(1);

    const elsewhere = await places.listWithheldOwnedNearPoint({
      humanId: SARAH,
      orgIds: [ORG],
      lat: 40.7128,
      lng: -74.006,
      withinMeters: 50,
    });
    expect(elsewhere).toEqual([]);
  }, 60_000);

  test("the lookup is driven by the owner index (PlaceOwnership ownerType, ownerId)", async ({ skip }) => {
    if (!ready(skip)) return;
    // Planner choice on a tiny table is weak evidence, so take the table-scan
    // path off the table (SET LOCAL, one transaction = one connection) and
    // assert the owner index CAN serve the owner filter.
    const plan = await prisma!.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
      return tx.$queryRaw<Array<{ "QUERY PLAN": string }>>`
        EXPLAIN SELECT 1 FROM "PlaceOwnership"
        WHERE "ownerType" = 'HUMAN' AND "ownerId" = ${SARAH}
          AND verified = true AND revoked_at IS NULL
      `;
    });
    expect(plan.map((row) => row["QUERY PLAN"]).join("\n")).toMatch(
      /PlaceOwnership_ownerType_ownerId_idx/,
    );
  }, 60_000);
});
