import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

import {
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { AppError } from "@th/errors";

import { makeSeatsRepo, SEAT_BATCH_SIZE } from "../seats";

// ---------------------------------------------------------------------------
// Real-Postgres coverage for the batched `materializeSections`. The stub test
// proves the statement SHAPE (no per-seat calls); this proves the SQL is
// valid and the semantics match the old per-seat upsert: idempotent on
// re-run, status untouched, row/number drift corrected via the raw
// UPDATE ... FROM (VALUES ...), section drift corrected, name collisions
// still surface as an error — all inside an interactive transaction, which
// is how the save-event path calls it.
//
// Standalone DDL: just the two tables + two enums, no FKs to Event /
// PlaceLayout. Column names mirror the migration exactly.
//
// KNOWN DRIFT RISK: TABLE_SQL is hand-copied from the migration. A schema
// change to Seat / SeatSection that this file does not mirror will pass here
// and fail in production. The eventual replacement is `runPrismaMigrateDeploy`
// (packages/test-utils/src/testcontainers/postgres.ts:332), which applies the
// real migrations to the ephemeral database.
// ---------------------------------------------------------------------------

const TABLE_SQL = `
CREATE TYPE "SeatStatus" AS ENUM ('AVAILABLE', 'HELD', 'SOLD', 'BLOCKED');
CREATE TYPE "SeatSectionType" AS ENUM ('GA', 'RESERVED');

CREATE TABLE "SeatSection" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "SeatSectionType" NOT NULL DEFAULT 'GA',
    "capacity" INTEGER,
    "geometry" JSONB,
    "stage_anchor" JSONB,
    "layout_section_id" TEXT,
    "place_layout_id" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SeatSection_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SeatSection_eventId_name_key" ON "SeatSection"("eventId", "name");
CREATE UNIQUE INDEX "SeatSection_eventId_place_layout_id_layout_section_id_key" ON "SeatSection"("eventId", "place_layout_id", "layout_section_id");

CREATE TABLE "Seat" (
    "id" TEXT NOT NULL,
    "seatSectionId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "row" TEXT,
    "number" INTEGER,
    "status" "SeatStatus" NOT NULL,
    "geometry" JSONB,
    "price_override" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Seat_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Seat_seatSectionId_fkey" FOREIGN KEY ("seatSectionId") REFERENCES "SeatSection"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "Seat_seatSectionId_label_key" ON "Seat"("seatSectionId", "label");
`;

const TEST_TIMEOUT_MS = 60_000;
const EVENT_ID = "evt-aaaaaaaa";
const LAYOUT_ID = "layout-aaaa";

const ORCH = {
  sectionId: "orch",
  label: "Orchestra",
  capacity: 2000,
  kind: "seat" as const,
};
const BALC = {
  sectionId: "balc",
  label: "Balcony",
  capacity: 500,
  kind: "seat" as const,
};

function seatIdsFor(sectionId: string, rows: string[], perRow: number) {
  const out: string[] = [];
  for (const row of rows) {
    for (let n = 1; n <= perRow; n++) out.push(`${sectionId}-${row}-${n}`);
  }
  return out;
}

// 4 × 500 + 500 = 2500 → strictly more than two batches of SEAT_BATCH_SIZE.
const SEAT_IDS = [
  ...seatIdsFor("orch", ["A", "B", "C", "D"], 500),
  ...seatIdsFor("balc", ["AA"], 500),
];

describe("seats.materializeSections (integration)", () => {
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
    await pool?.query(`TRUNCATE "SeatSection", "Seat"`);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
    await pgContainer?.stop();
  });

  async function materialize(
    input: Partial<
      Parameters<ReturnType<typeof makeSeatsRepo>["materializeSections"]>[0]
    > = {},
  ) {
    // Interactive transaction: the production caller (save-event) runs this
    // inside repos.tx, so the createMany + raw UPDATE must work on a tx client.
    return prisma!.$transaction(
      async (tx) =>
        makeSeatsRepo(tx).materializeSections({
          eventId: EVENT_ID,
          placeLayoutId: LAYOUT_ID,
          sections: [ORCH, BALC],
          seatIds: SEAT_IDS,
          ...input,
        }),
      // Prisma's default interactive-tx timeout is 5s; a loaded CI box can
      // exceed that on 2500 rows. Production's repos.tx budget is 30s.
      { timeout: 30_000, maxWait: 10_000 },
    );
  }

  test(
    "fresh event: 2500 seats across 2 sections land in Postgres, all AVAILABLE",
    async () => {
      expect(SEAT_IDS.length).toBeGreaterThan(2 * SEAT_BATCH_SIZE);

      const startedAt = performance.now();
      const result = await materialize();
      // Surfaced for the P-2 report; not asserted (wall time is machine-bound).
      console.info(
        `materializeSections: ${SEAT_IDS.length} seats in ${Math.round(performance.now() - startedAt)}ms`,
      );

      expect(result.sectionsCreated).toBe(2);
      expect(result.seatsCreated).toBe(2500);
      expect(Object.keys(result.sectionIdMap).sort()).toEqual(["balc", "orch"]);

      const sections = await pool!.query(
        `SELECT id, name, type, capacity, layout_section_id FROM "SeatSection" WHERE "eventId" = $1 ORDER BY name`,
        [EVENT_ID],
      );
      expect(sections.rows).toEqual([
        {
          id: result.sectionIdMap.balc,
          name: "Balcony",
          type: "RESERVED",
          capacity: 500,
          layout_section_id: "balc",
        },
        {
          id: result.sectionIdMap.orch,
          name: "Orchestra",
          type: "RESERVED",
          capacity: 2000,
          layout_section_id: "orch",
        },
      ]);

      const seats = await pool!.query(
        `SELECT "seatSectionId", count(*)::int AS n, bool_and(status = 'AVAILABLE') AS all_available
       FROM "Seat" GROUP BY "seatSectionId"`,
      );
      const bySection = Object.fromEntries(
        seats.rows.map((r) => [r.seatSectionId, r]),
      );
      expect(bySection[result.sectionIdMap.orch!]).toMatchObject({
        n: 2000,
        all_available: true,
      });
      expect(bySection[result.sectionIdMap.balc!]).toMatchObject({
        n: 500,
        all_available: true,
      });

      const sample = await pool!.query(
        `SELECT label, row, number FROM "Seat" WHERE "seatSectionId" = $1 AND label = 'C37'`,
        [result.sectionIdMap.orch],
      );
      expect(sample.rows).toEqual([{ label: "C37", row: "C", number: 37 }]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "re-run is idempotent: 0 created, ids stable, SOLD status preserved, row/number drift corrected",
    async () => {
      const first = await materialize();
      const orchId = first.sectionIdMap.orch!;

      // Sell one seat and corrupt another's row/number by hand.
      await pool!.query(
        `UPDATE "Seat" SET status = 'SOLD' WHERE "seatSectionId" = $1 AND label = 'A1'`,
        [orchId],
      );
      await pool!.query(
        `UPDATE "Seat" SET row = 'Z', number = 999, "updatedAt" = '2000-01-01' WHERE "seatSectionId" = $1 AND label = 'B2'`,
        [orchId],
      );
      const before = await pool!.query(
        `SELECT id, "updatedAt" FROM "Seat" WHERE "seatSectionId" = $1 AND label IN ('A1', 'B2') ORDER BY label`,
        [orchId],
      );
      // Clock-independent: snapshot every seat's updatedAt and count how many
      // changed (Prisma stamps updatedAt client-side; the UPDATE uses NOW()).
      const snapshot = await pool!.query(`SELECT id, "updatedAt" FROM "Seat"`);

      const second = await materialize();

      expect(second.sectionsCreated).toBe(0);
      expect(second.seatsCreated).toBe(0);
      expect(second.sectionIdMap).toEqual(first.sectionIdMap);

      const total = await pool!.query(`SELECT count(*)::int AS n FROM "Seat"`);
      expect(total.rows[0].n).toBe(2500);

      const after = await pool!.query(
        `SELECT id, label, row, number, status, "updatedAt" FROM "Seat" WHERE "seatSectionId" = $1 AND label IN ('A1', 'B2') ORDER BY label`,
        [orchId],
      );
      // A1: same id, still SOLD, untouched.
      expect(after.rows[0]).toMatchObject({
        id: before.rows[0].id,
        label: "A1",
        row: "A",
        number: 1,
        status: "SOLD",
      });
      // B2: same id, row/number restored from the layout, updatedAt bumped.
      expect(after.rows[1]).toMatchObject({
        id: before.rows[1].id,
        label: "B2",
        row: "B",
        number: 2,
        status: "AVAILABLE",
      });
      expect(after.rows[1].updatedAt.getTime()).toBeGreaterThan(
        before.rows[1].updatedAt.getTime(),
      );

      // Only the drifted seat was rewritten.
      const afterAll = await pool!.query(`SELECT id, "updatedAt" FROM "Seat"`);
      const wasAt = new Map<string, number>(
        snapshot.rows.map((r) => [r.id, r.updatedAt.getTime()]),
      );
      const changed = afterAll.rows.filter(
        (r) => r.updatedAt.getTime() !== wasAt.get(r.id),
      );
      expect(changed.map((r) => r.id)).toEqual([before.rows[1].id]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "layout grew: only the new seats are inserted; a renamed section is updated in place",
    async () => {
      const first = await materialize();

      const second = await materialize({
        sections: [ORCH, { ...BALC, label: "Upper Balcony", capacity: 501 }],
        seatIds: [...SEAT_IDS, "balc-AA-501"],
      });

      expect(second.sectionsCreated).toBe(0);
      expect(second.seatsCreated).toBe(1);
      expect(second.sectionIdMap).toEqual(first.sectionIdMap);

      const section = await pool!.query(
        `SELECT name, capacity FROM "SeatSection" WHERE id = $1`,
        [first.sectionIdMap.balc],
      );
      expect(section.rows[0]).toEqual({ name: "Upper Balcony", capacity: 501 });

      const added = await pool!.query(
        `SELECT row, number, status FROM "Seat" WHERE "seatSectionId" = $1 AND label = 'AA501'`,
        [first.sectionIdMap.balc],
      );
      expect(added.rows).toEqual([
        { row: "AA", number: 501, status: "AVAILABLE" },
      ]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "rename + new section taking the old name: renames run before creates, so the save succeeds",
    async () => {
      const first = await materialize();

      // X: Balcony → Mezzanine; Y (new): Balcony. Y collides on (eventId, name)
      // with X's still-current name unless X is renamed first.
      const second = await materialize({
        sections: [
          ORCH,
          { ...BALC, label: "Mezzanine" },
          { sectionId: "balc2", label: "Balcony", capacity: 100, kind: "seat" },
        ],
        seatIds: [...SEAT_IDS, "balc2-A-1"],
      });

      expect(second.sectionsCreated).toBe(1);
      expect(second.sectionIdMap.balc).toBe(first.sectionIdMap.balc);
      expect(second.sectionIdMap.balc2).toBeTruthy();

      const rows = await pool!.query(
        `SELECT id, name, layout_section_id FROM "SeatSection" WHERE "eventId" = $1 ORDER BY layout_section_id`,
        [EVENT_ID],
      );
      expect(rows.rows).toEqual([
        {
          id: first.sectionIdMap.balc,
          name: "Mezzanine",
          layout_section_id: "balc",
        },
        {
          id: second.sectionIdMap.balc2,
          name: "Balcony",
          layout_section_id: "balc2",
        },
        {
          id: first.sectionIdMap.orch,
          name: "Orchestra",
          layout_section_id: "orch",
        },
      ]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "raw UPDATE binds NULL row/number and quoted values (bound, not spliced)",
    async () => {
      // The section label and a seat row carry quote characters to document
      // that every value travels as a bind parameter, never spliced into SQL.
      const QUOTED = {
        sectionId: "vip",
        label: `O'Reilly "$1"`,
        capacity: 10,
        kind: "seat" as const,
      };
      const first = await materialize({
        sections: [QUOTED],
        seatIds: [`vip-O'R-1`, "vip-A-1"],
      });
      const vipId = first.sectionIdMap.vip!;

      const created = await pool!.query(
        `SELECT label, row, number FROM "Seat" WHERE "seatSectionId" = $1 ORDER BY label`,
        [vipId],
      );
      expect(created.rows).toEqual([
        { label: "A1", row: "A", number: 1 },
        { label: "O'R1", row: "O'R", number: 1 },
      ]);
      const section = await pool!.query(
        `SELECT name FROM "SeatSection" WHERE id = $1`,
        [vipId],
      );
      expect(section.rows[0].name).toBe(`O'Reilly "$1"`);

      // Seed two seats under the labels the fallback path will derive, with
      // non-null row/number, then re-materialise with ids that parse to NULLs:
      //   "vip-Z-x"      → row "Z",  number NULL (non-integer suffix)
      //   "vip-standing" → row NULL, number NULL (no dash after the prefix)
      // Both must be rewritten through the raw UPDATE's ::text / ::int NULL binds.
      await pool!.query(
        `INSERT INTO "Seat" (id, "seatSectionId", label, row, number, status, "updatedAt")
         VALUES ('seat-null-number', $1, 'vip-Z-x', 'Z', 99, 'AVAILABLE', NOW()),
                ('seat-null-both', $1, 'vip-standing', 'S', 1, 'AVAILABLE', NOW())`,
        [vipId],
      );

      const second = await materialize({
        sections: [QUOTED],
        seatIds: [`vip-O'R-1`, "vip-A-1", "vip-Z-x", "vip-standing"],
      });
      expect(second.seatsCreated).toBe(0);

      const rewritten = await pool!.query(
        `SELECT id, row, number FROM "Seat" WHERE id IN ('seat-null-number', 'seat-null-both') ORDER BY id`,
      );
      expect(rewritten.rows).toEqual([
        { id: "seat-null-both", row: null, number: null },
        { id: "seat-null-number", row: "Z", number: null },
      ]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a section whose name collides with another section on the event fails and rolls the tx back",
    async () => {
      await materialize({ sections: [ORCH], seatIds: [] });

      const err = await materialize({
        sections: [ORCH, { ...BALC, sectionId: "balc2", label: "Orchestra" }],
        seatIds: ["balc2-A-1"],
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AppError);
      expect(err).toMatchObject({
        code: "SLUG_TAKEN",
        message: "seat_section_name_taken",
        meta: { eventId: EVENT_ID, layoutSectionIds: ["balc2"] },
      });

      const sections = await pool!.query(
        `SELECT count(*)::int AS n FROM "SeatSection"`,
      );
      expect(sections.rows[0].n).toBe(1);
      const seats = await pool!.query(`SELECT count(*)::int AS n FROM "Seat"`);
      expect(seats.rows[0].n).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );
});
