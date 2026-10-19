import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { makeEventsRepo } from "../events";
import { makeSearchDocumentsWriter } from "../search-documents";

// ---------------------------------------------------------------------------
// The locks the search index write fence (`buildSearchIndex` →
// `withIndexWriteFence`) is built from, against REAL Postgres. The fence's
// correctness argument is lock compatibility, so this pins exactly that:
//
//   · `lockRows` "share"  → FOR SHARE: another FOR SHARE gets in, an UPDATE
//                           (every event-level tightening) waits;
//   · `lockRows` "update" → FOR UPDATE: even FOR SHARE (a fence) waits;
//   · `lockLocationsAtPlace` "shared" → two fences coexist, the place
//                           cascade's EXCLUSIVE lock waits.
//
// "Waits" is probed with NOWAIT / lock_timeout / pg_try_* from a second
// connection, so no test blocks.
// ---------------------------------------------------------------------------

const PLACE = "71000000-0000-4000-8000-000000000001";
const EVENT_A = "71000000-0000-4000-8000-0000000000a1";
const EVENT_B = "71000000-0000-4000-8000-0000000000b2";
const MISSING = "71000000-0000-4000-8000-0000000000ff";

describe("events adapter — index write fence locks (integration)", () => {
  let pgContainer: PostgresTestContainer | undefined;
  let pool: pg.Pool | undefined;
  let prisma: PrismaClient | undefined;

  beforeAll(async () => {
    pgContainer = await startPostgresContainer();
    await runPrismaMigrateDeploy(pgContainer.databaseUrl);
    pool = new pg.Pool({ connectionString: pgContainer.databaseUrl });
    // No Org/Human graph needed: nothing under test joins through the FKs.
    await pool.query(`ALTER TABLE "Event" DISABLE TRIGGER ALL`);
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
    // A child table with a real FK to "Event", the way order items / tickets
    // reference it. Its RI check runs as SELECT … FOR KEY SHARE.
    await pool.query(
      `CREATE TABLE fence_fk_probe (event_id text NOT NULL REFERENCES "Event"(id))`,
    );
  }, 300_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
    await pgContainer?.stop();
  }, 120_000);

  beforeEach(async () => {
    await pool!.query(`TRUNCATE "Event" CASCADE`);
    await pool!.query(`DELETE FROM "SearchDocument"`);
    for (const id of [EVENT_A, EVENT_B]) {
      await pool!.query(
        `INSERT INTO "Event" (id, title, "startsAt", "endsAt", status, "placeId", "updatedAt")
         VALUES ($1, 'e', '2026-10-10T20:00:00Z', '2026-10-10T23:00:00Z',
                 'PUBLISHED'::"EventStatus", $2, '2026-01-01T00:00:00Z')`,
        [id, PLACE],
      );
    }
  });

  /** Run `sql` on a SECOND connection; true if it got through, false if it would wait. */
  async function probe(sql: string, params: unknown[] = []): Promise<boolean> {
    const client = await pool!.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout = '200ms'");
      try {
        const { rows } = await client.query(sql, params);
        const first = rows[0] as Record<string, unknown> | undefined;
        // pg_try_* returns a boolean instead of waiting.
        return first && "got" in first ? Boolean(first.got) : true;
      } catch (err) {
        const code = (err as { code?: string }).code;
        // 55P03 = lock_not_available (NOWAIT / lock_timeout).
        if (code === "55P03") return false;
        throw err;
      }
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  }

  const updateA = () =>
    probe(`UPDATE "Event" SET title = 'x' WHERE id = $1`, [EVENT_A]);
  const shareA = () =>
    probe(`SELECT id FROM "Event" WHERE id = $1 FOR SHARE NOWAIT`, [EVENT_A]);

  test("share: another fence gets in, an UPDATE (a tightening) waits until commit", async () => {
    let otherShare: boolean | undefined;
    let update: boolean | undefined;
    await prisma!.$transaction(async (tx) => {
      await makeEventsRepo(tx as never).lockRows({
        ids: [EVENT_B, EVENT_A],
        mode: "share",
      });
      otherShare = await shareA();
      update = await updateA();
    });
    expect(otherShare).toBe(true);
    expect(update).toBe(false);
    // Released at commit.
    expect(await updateA()).toBe(true);
  });

  test("update: even a fence's FOR SHARE waits (the save's locked before-read)", async () => {
    let share: boolean | undefined;
    await prisma!.$transaction(async (tx) => {
      await makeEventsRepo(tx as never).lockRows({
        ids: [EVENT_A],
        mode: "update",
      });
      share = await shareA();
    });
    expect(share).toBe(false);
    expect(await shareA()).toBe(true);
  });

  test("missing ids are skipped and an empty list is a no-op", async () => {
    await prisma!.$transaction(async (tx) => {
      const repo = makeEventsRepo(tx as never);
      await repo.lockRows({ ids: [], mode: "share" });
      await repo.lockRows({ ids: [MISSING, EVENT_A], mode: "share" });
    });
  });

  test("shared place lock: two fences coexist, the cascade's EXCLUSIVE lock waits", async () => {
    const key = `place_location:${PLACE}`;
    let otherShared: boolean | undefined;
    let exclusive: boolean | undefined;
    await prisma!.$transaction(async (tx) => {
      await makeEventsRepo(tx as never).lockLocationsAtPlace({
        placeId: PLACE,
        mode: "shared",
      });
      otherShared = await probe(
        `SELECT pg_try_advisory_xact_lock_shared(hashtext($1)) AS got`,
        [key],
      );
      exclusive = await probe(
        `SELECT pg_try_advisory_xact_lock(hashtext($1)) AS got`,
        [key],
      );
    });
    expect(otherShared).toBe(true);
    expect(exclusive).toBe(false);
    expect(
      await probe(`SELECT pg_try_advisory_xact_lock(hashtext($1)) AS got`, [key]),
    ).toBe(true);
  });

  test("checkout is not blocked: an FK insert referencing a FOR SHARE-locked Event goes through", async () => {
    let inserted: boolean | undefined;
    await prisma!.$transaction(async (tx) => {
      await makeEventsRepo(tx as never).lockRows({
        ids: [EVENT_A],
        mode: "share",
      });
      inserted = await probe(
        `INSERT INTO fence_fk_probe (event_id) VALUES ($1)`,
        [EVENT_A],
      );
    });
    expect(inserted).toBe(true);
  });

  const placeDoc = (id: string) => ({
    type: "place" as const,
    id: `place_${id}`,
    placeId: id,
    name: "Venue",
    pageSlug: null,
    formattedAddress: null,
    city: "Nashville",
    region: "TN",
    countryCode: "US",
    lat: null,
    lng: null,
    geohash6: null,
    locationIsExact: false,
    locationHidden: true,
    locationRadiusMeters: null,
    areaLabel: null,
    capacity: null,
    eventCount: 0,
    bio: null,
    status: "ACTIVE" as const,
    verificationStatus: "VERIFIED" as const,
    listedInDirectory: true,
  });

  async function docExists(id: string): Promise<boolean> {
    const { rows } = await pool!.query(
      `SELECT 1 FROM "SearchDocument" WHERE id = $1`,
      [`place_${id}`],
    );
    return rows.length > 0;
  }

  test("Repos.searchDocuments inside a transaction: the write rolls back WITH it", async () => {
    await expect(
      prisma!.$transaction(async (tx) => {
        const writer = makeSearchDocumentsWriter(tx as never);
        const res = await writer.upsertDocuments({
          documents: [placeDoc(PLACE)],
        });
        expect(res.ok).toBe(true);
        throw new Error("fence rolled back");
      }),
    ).rejects.toThrow("fence rolled back");
    expect(await docExists(PLACE)).toBe(false);

    await prisma!.$transaction(async (tx) => {
      await makeSearchDocumentsWriter(tx as never).upsertDocuments({
        documents: [placeDoc(PLACE)],
      });
    });
    expect(await docExists(PLACE)).toBe(true);

    // And a DELETE (the scrub) is atomic the same way.
    await expect(
      prisma!.$transaction(async (tx) => {
        await makeSearchDocumentsWriter(tx as never).deleteDocuments({
          ids: [`place_${PLACE}`],
        });
        throw new Error("save rolled back");
      }),
    ).rejects.toThrow("save rolled back");
    expect(await docExists(PLACE)).toBe(true);
  });
});
