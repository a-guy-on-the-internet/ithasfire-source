import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

import { makeBookingStandardsRepo } from "../booking-standards";

// ---------------------------------------------------------------------------
// Real-Postgres coverage for BookingStandardsRepo (venue-booking-standards
// spec, docs/specs/2026-09-25, FR-001 / FR-002).
//
// The load-bearing semantics are SQL-level: enum DECLARATION order in the read
// ordering, the replace-all transaction (a failed insert must leave the old
// rows), the advisory lock that serializes racing saves, and the hand-written
// D2a CHECK (CUSTOM ⇒ SUGGESTED).
//
// THE DDL IS THE SHIPPED MIGRATION, RUN WHOLE (house precedent: the
// booking-request-acts suite). One prerequisite: the BookingIntent enum,
// lifted from the migration that created it. The owner pair has no FK, so no
// Place / Calendar stubs are needed.
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../db/prisma/migrations",
);

const INTENTS_SQL = readFileSync(
  resolve(
    MIGRATIONS_DIR,
    "20260902120000_venue_confirmation_and_booking_intents/migration.sql",
  ),
  "utf8",
);

const STANDARDS_MIGRATION_SQL = readFileSync(
  resolve(MIGRATIONS_DIR, "20260925170000_booking_standards/migration.sql"),
  "utf8",
);

function statementFrom(sql: string, startsWith: string): string {
  const start = sql.indexOf(startsWith);
  if (start === -1) {
    throw new Error(
      `Migration DDL not found: ${startsWith}. The schema moved — re-point this test at the migration that owns it. Do NOT retype the DDL here.`,
    );
  }
  const end = sql.indexOf(";", start);
  if (end === -1) {
    throw new Error(`Unterminated statement in migration: ${startsWith}`);
  }
  return sql.slice(start, end + 1);
}

const SETUP_SQL = [
  statementFrom(INTENTS_SQL, `CREATE TYPE "BookingIntent"`),
  STANDARDS_MIGRATION_SQL,
].join("\n\n");

const PLACE_A = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const PLACE_B = "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2";
const CAL_1 = "11111111-1111-4111-8111-111111111111";
const CAL_2 = "22222222-2222-4222-8222-222222222222";

const place = (ownerId: string) => ({ ownerType: "PLACE", ownerId }) as const;
const calendar = (ownerId: string) =>
  ({ ownerType: "CALENDAR", ownerId }) as const;

describe("bookingStandards repo (integration)", () => {
  let pgContainer: PostgresTestContainer | undefined;
  let pool: pg.Pool | undefined;
  let prisma: PrismaClient | undefined;

  beforeAll(async () => {
    pgContainer = await startPostgresContainer();
    pool = new pg.Pool({ connectionString: pgContainer.databaseUrl });
    await pool.query(SETUP_SQL);
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  }, 300_000);

  beforeEach(async () => {
    await pool?.query(
      `TRUNCATE "BookingStandardItem", "BookingPitchExample"`,
    );
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
    await pgContainer?.stop();
  });

  const repo = () => makeBookingStandardsRepo(prisma!);

  /** Raw insert that bypasses the adapter, for CHECK / tiebreak assertions. */
  async function rawInsertItem(cols: Record<string, unknown>) {
    const all = {
      id: crypto.randomUUID(),
      ownerType: "PLACE",
      ownerId: PLACE_A,
      intent: "PERFORM",
      field: "LINK_MUSIC",
      label: "A music link",
      requirement: "SUGGESTED",
      sortOrder: 0,
      updatedAt: new Date(),
      ...cols,
    };
    const keys = Object.keys(all);
    await pool!.query(
      `INSERT INTO "BookingStandardItem" (${keys.map((k) => `"${k}"`).join(", ")})
       VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")})`,
      Object.values(all),
    );
  }

  test("replaceItems writes in array order with sortOrder 0..n-1 and returns the rows in order", async () => {
    const rows = await repo().replaceItems({
      ...place(PLACE_A),
      intent: "PERFORM",
      items: [
        { field: "LINK_MUSIC", label: "A music link", requirement: "REQUIRED" },
        {
          field: "EXPECTED_DRAW",
          label: "How many people you bring",
          hint: "A rough number is fine",
          requirement: "SUGGESTED",
        },
        { field: "CUSTOM", label: "No covers nights", requirement: "SUGGESTED" },
      ],
    });

    expect(
      rows.map((r) => [r.sortOrder, r.field, r.requirement, r.hint]),
    ).toEqual([
      [0, "LINK_MUSIC", "REQUIRED", null],
      [1, "EXPECTED_DRAW", "SUGGESTED", "A rough number is fine"],
      [2, "CUSTOM", "SUGGESTED", null],
    ]);
    expect(rows[0]).toMatchObject({
      ownerType: "PLACE",
      ownerId: PLACE_A,
      intent: "PERFORM",
      label: "A music link",
    });
    expect(rows[0]!.createdAt).toBeInstanceOf(Date);
    expect(rows[0]!.updatedAt).toBeInstanceOf(Date);
  });

  test("replaceItems replaces the whole list; [] clears it", async () => {
    await repo().replaceItems({
      ...place(PLACE_A),
      intent: "PERFORM",
      items: [
        { field: "LINK_MUSIC", label: "Old 1", requirement: "SUGGESTED" },
        { field: "GENRE", label: "Old 2", requirement: "SUGGESTED" },
      ],
    });
    const next = await repo().replaceItems({
      ...place(PLACE_A),
      intent: "PERFORM",
      items: [{ field: "FEE", label: "New", requirement: "REQUIRED" }],
    });
    expect(next.map((r) => [r.label, r.sortOrder])).toEqual([["New", 0]]);

    const read = await repo().listForOwners({ owners: [place(PLACE_A)] });
    expect(read.items.map((r) => r.label)).toEqual(["New"]);

    await expect(
      repo().replaceItems({ ...place(PLACE_A), intent: "PERFORM", items: [] }),
    ).resolves.toEqual([]);
    const cleared = await repo().listForOwners({ owners: [place(PLACE_A)] });
    expect(cleared.items).toEqual([]);
  });

  test("replace is scoped to ONE (ownerType, ownerId, intent)", async () => {
    // Same id under both owner types, on purpose: the PAIR is the key.
    await repo().replaceItems({
      ...place(CAL_1),
      intent: "PERFORM",
      items: [{ field: "GENRE", label: "place-typed", requirement: "SUGGESTED" }],
    });
    await repo().replaceItems({
      ...calendar(CAL_1),
      intent: "RENT",
      items: [{ field: "PURPOSE", label: "cal rent", requirement: "REQUIRED" }],
    });
    await repo().replaceItems({
      ...calendar(CAL_2),
      intent: "PERFORM",
      items: [{ field: "BILL", label: "other cal", requirement: "SUGGESTED" }],
    });

    // Replace CAL_1's PERFORM list — touches none of the three above.
    await repo().replaceItems({
      ...calendar(CAL_1),
      intent: "PERFORM",
      items: [{ field: "LINK_VIDEO", label: "cal perform", requirement: "SUGGESTED" }],
    });

    const all = await repo().listForOwners({
      owners: [place(CAL_1), calendar(CAL_1), calendar(CAL_2)],
    });
    expect(all.items.map((r) => r.label).sort()).toEqual(
      ["cal perform", "cal rent", "other cal", "place-typed"].sort(),
    );
  });

  test("listForOwners: one call, both tables, ordered by (ownerType, ownerId, intent, sortOrder, id)", async () => {
    // Written out of the read order on purpose.
    await repo().replaceItems({
      ...calendar(CAL_1),
      intent: "USE",
      items: [{ field: "PURPOSE", label: "c1-use-0", requirement: "SUGGESTED" }],
    });
    await repo().replaceItems({
      ...calendar(CAL_1),
      intent: "PERFORM",
      items: [
        { field: "LINK_MUSIC", label: "c1-perf-0", requirement: "SUGGESTED" },
        { field: "GENRE", label: "c1-perf-1", requirement: "SUGGESTED" },
      ],
    });
    await repo().replaceItems({
      ...place(PLACE_B),
      intent: "PERFORM",
      items: [{ field: "FEE", label: "pB-perf-0", requirement: "SUGGESTED" }],
    });
    await repo().replaceItems({
      ...place(PLACE_A),
      intent: "RENT",
      items: [{ field: "PURPOSE", label: "pA-rent-0", requirement: "SUGGESTED" }],
    });
    // Not asked for.
    await repo().replaceItems({
      ...calendar(CAL_2),
      intent: "PERFORM",
      items: [{ field: "GENRE", label: "unasked", requirement: "SUGGESTED" }],
    });
    await repo().replaceExamples({
      ...calendar(CAL_1),
      intent: "PERFORM",
      examples: [
        { title: "ex-0", body: "First example body." },
        { title: "ex-1", body: "Second example body.\nWith a second line." },
      ],
    });
    await repo().replaceExamples({
      ...place(PLACE_A),
      intent: "PERFORM",
      examples: [{ title: "pA-ex", body: "Place example." }],
    });

    const read = await repo().listForOwners({
      owners: [calendar(CAL_1), place(PLACE_B), place(PLACE_A)],
    });
    // PLACE sorts before CALENDAR (enum declaration order, not alphabetical);
    // PERFORM < RENT < USE likewise.
    expect(read.items.map((r) => r.label)).toEqual([
      "pA-rent-0",
      "pB-perf-0",
      "c1-perf-0",
      "c1-perf-1",
      "c1-use-0",
    ]);
    expect(read.examples.map((r) => [r.title, r.sortOrder])).toEqual([
      ["pA-ex", 0],
      ["ex-0", 0],
      ["ex-1", 1],
    ]);
    expect(read.examples[2]!.body).toBe(
      "Second example body.\nWith a second line.",
    );

    await expect(repo().listForOwners({ owners: [] })).resolves.toEqual({
      items: [],
      examples: [],
    });
  });

  test("listForOwners narrows BOTH lists by intent when given", async () => {
    await repo().replaceItems({
      ...calendar(CAL_1),
      intent: "PERFORM",
      items: [{ field: "LINK_MUSIC", label: "perform", requirement: "SUGGESTED" }],
    });
    await repo().replaceItems({
      ...calendar(CAL_1),
      intent: "RENT",
      items: [{ field: "PURPOSE", label: "rent", requirement: "SUGGESTED" }],
    });
    await repo().replaceExamples({
      ...calendar(CAL_1),
      intent: "PERFORM",
      examples: [{ title: "perform ex", body: "Body." }],
    });
    await repo().replaceExamples({
      ...calendar(CAL_1),
      intent: "RENT",
      examples: [{ title: "rent ex", body: "Body." }],
    });

    const rent = await repo().listForOwners({
      owners: [calendar(CAL_1)],
      intent: "RENT",
    });
    expect(rent.items.map((r) => r.label)).toEqual(["rent"]);
    expect(rent.examples.map((r) => r.title)).toEqual(["rent ex"]);
  });

  test("a sortOrder tie reads in one stable order (id)", async () => {
    await rawInsertItem({ id: "zz", label: "Z", sortOrder: 0 });
    await rawInsertItem({ id: "aa", label: "A", sortOrder: 0 });
    const read = await repo().listForOwners({ owners: [place(PLACE_A)] });
    expect(read.items.map((r) => r.id)).toEqual(["aa", "zz"]);
  });

  describe("replace-all is atomic (a failed insert leaves the old rows)", () => {
    const seedItems = () =>
      repo().replaceItems({
        ...place(PLACE_A),
        intent: "PERFORM",
        items: [
          { field: "LINK_MUSIC", label: "Keep 1", requirement: "REQUIRED" },
          { field: "GENRE", label: "Keep 2", requirement: "SUGGESTED" },
        ],
      });

    test("root client: the adapter's own transaction rolls the delete back (D2a CHECK)", async () => {
      await seedItems();
      await expect(
        repo().replaceItems({
          ...place(PLACE_A),
          intent: "PERFORM",
          items: [
            { field: "LINK_MUSIC", label: "New", requirement: "SUGGESTED" },
            // Core refuses this first; the CHECK is the backstop.
            { field: "CUSTOM", label: "Send a stage plot", requirement: "REQUIRED" },
          ],
        }),
      ).rejects.toThrow(/BookingStandardItem_custom_is_suggested_check/);

      const read = await repo().listForOwners({ owners: [place(PLACE_A)] });
      expect(read.items.map((r) => [r.label, r.sortOrder])).toEqual([
        ["Keep 1", 0],
        ["Keep 2", 1],
      ]);
    });

    test("root client: an over-long example title rolls back too", async () => {
      await repo().replaceExamples({
        ...place(PLACE_A),
        intent: "PERFORM",
        examples: [{ title: "Keep", body: "Old body." }],
      });
      await expect(
        repo().replaceExamples({
          ...place(PLACE_A),
          intent: "PERFORM",
          examples: [
            { title: "Fine", body: "Fine." },
            { title: "x".repeat(81), body: "Too long a title for VarChar(80)." },
          ],
        }),
      ).rejects.toThrow();
      const read = await repo().listForOwners({ owners: [place(PLACE_A)] });
      expect(read.examples.map((r) => r.title)).toEqual(["Keep"]);
    });

    test("inside a caller's transaction: the caller's rollback keeps the old rows", async () => {
      await seedItems();
      await expect(
        prisma!.$transaction(async (tx) => {
          await makeBookingStandardsRepo(tx).replaceItems({
            ...place(PLACE_A),
            intent: "PERFORM",
            items: [{ field: "FEE", label: "Replaced", requirement: "SUGGESTED" }],
          });
          throw new Error("caller aborts after the replace");
        }),
      ).rejects.toThrow("caller aborts after the replace");
      const read = await repo().listForOwners({ owners: [place(PLACE_A)] });
      expect(read.items.map((r) => r.label)).toEqual(["Keep 1", "Keep 2"]);
    });
  });

  test("replaceItems holds a transaction-scoped advisory lock on (table, owner, intent)", async () => {
    const tryLock = async (key: string) => {
      const { rows } = await pool!.query<{ got: boolean }>(
        `SELECT pg_try_advisory_xact_lock(hashtext($1)) AS got`,
        [key],
      );
      return rows[0]!.got;
    };
    const key = `booking_standards:items:CALENDAR:${CAL_1}:PERFORM`;

    await prisma!.$transaction(async (tx) => {
      await makeBookingStandardsRepo(tx).replaceItems({
        ...calendar(CAL_1),
        intent: "PERFORM",
        items: [{ field: "GENRE", label: "Locked", requirement: "SUGGESTED" }],
      });
      // A racing save of the same list must wait…
      expect(await tryLock(key)).toBe(false);
      // …but another intent, owner or table is independent.
      expect(
        await tryLock(`booking_standards:items:CALENDAR:${CAL_1}:RENT`),
      ).toBe(true);
      expect(
        await tryLock(`booking_standards:examples:CALENDAR:${CAL_1}:PERFORM`),
      ).toBe(true);
    });
    // Released at COMMIT.
    expect(await tryLock(key)).toBe(true);
  });

  test("two racing replaces of the same list leave exactly one list, never an interleave", async () => {
    const a = repo().replaceItems({
      ...calendar(CAL_2),
      intent: "PERFORM",
      items: [
        { field: "LINK_MUSIC", label: "A0", requirement: "SUGGESTED" },
        { field: "GENRE", label: "A1", requirement: "SUGGESTED" },
      ],
    });
    const b = repo().replaceItems({
      ...calendar(CAL_2),
      intent: "PERFORM",
      items: [
        { field: "FEE", label: "B0", requirement: "SUGGESTED" },
        { field: "BILL", label: "B1", requirement: "SUGGESTED" },
      ],
    });
    await Promise.all([a, b]);
    const read = await repo().listForOwners({ owners: [calendar(CAL_2)] });
    const labels = read.items.map((r) => r.label);
    expect([["A0", "A1"], ["B0", "B1"]]).toContainEqual(labels);
  });

  describe("SQL CHECK (raw inserts that bypass the adapter)", () => {
    const check = /BookingStandardItem_custom_is_suggested_check/;

    test("CUSTOM may not be REQUIRED (D2a)", async () => {
      await expect(
        rawInsertItem({ field: "CUSTOM", requirement: "REQUIRED" }),
      ).rejects.toThrow(check);
    });

    test("CUSTOM + SUGGESTED and a known field + REQUIRED are both fine", async () => {
      await expect(
        rawInsertItem({ field: "CUSTOM", requirement: "SUGGESTED" }),
      ).resolves.toBeUndefined();
      await expect(
        rawInsertItem({ field: "LINK_MUSIC", requirement: "REQUIRED", sortOrder: 1 }),
      ).resolves.toBeUndefined();
    });
  });
});
