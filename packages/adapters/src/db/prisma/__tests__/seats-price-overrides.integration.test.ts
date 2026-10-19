import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { makeSeatsRepo } from "../seats";

// ---------------------------------------------------------------------------
// The seat price reads checkout depends on, against REAL Postgres
// (seat-price-overrides spec FR-003 + the auto-assign ruling):
//
//   - `findByIdsForUpdate` returns each locked row's `price_override`;
//   - `findPriceOverridesByIds` reads it unlocked, scoped to the event;
//   - `reserveForHold` never auto-assigns an overridden seat, and treats a
//     JSON `null` the same as SQL NULL (no override), as `parsePriceOverride`
//     does.
//
// What only a database proves: the jsonb `= 'null'::jsonb` comparison, the
// SeatSection join that scopes by event, and the `ORDER BY createdAt` pick
// still working once the filter is in. FK triggers on the two tables are
// disabled so fixtures need no Org→Event graph.
// ---------------------------------------------------------------------------

const EVENT_ID = "61000000-0000-4000-8000-000000000001";
const OTHER_EVENT_ID = "61000000-0000-4000-8000-000000000002";
const SECTION_ID = "61000000-0000-4000-8000-000000000003";
const OTHER_SECTION_ID = "61000000-0000-4000-8000-000000000004";
const HELD_AT = new Date("2026-09-15T12:00:00.000Z");

const TABLES = ["SeatSection", "Seat"];

describe("seats price-override reads (integration)", () => {
  let pgContainer: PostgresTestContainer | undefined;
  let pool: pg.Pool | undefined;
  let prisma: PrismaClient | undefined;

  beforeAll(async () => {
    pgContainer = await startPostgresContainer();
    await runPrismaMigrateDeploy(pgContainer.databaseUrl);
    pool = new pg.Pool({ connectionString: pgContainer.databaseUrl });
    for (const table of TABLES) {
      await pool.query(`ALTER TABLE "${table}" DISABLE TRIGGER ALL`);
    }
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  }, 400_000);

  beforeEach(async () => {
    await pool!.query(
      `TRUNCATE ${TABLES.map((t) => `"${t}"`).join(", ")} CASCADE`,
    );
    for (const [id, eventId] of [
      [SECTION_ID, EVENT_ID],
      [OTHER_SECTION_ID, OTHER_EVENT_ID],
    ]) {
      await pool!.query(
        `INSERT INTO "SeatSection" (id, "eventId", name, type, "updatedAt")
         VALUES ($1, $2, $3, 'RESERVED'::"SeatSectionType", NOW())`,
        [id, eventId, `section-${id.slice(-1)}`],
      );
    }
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
    await pgContainer?.stop();
  }, 120_000);

  let seq = 0;
  async function seedSeat(opts: {
    override?: unknown;
    jsonNull?: boolean;
    sectionId?: string;
    row?: string;
    status?: "AVAILABLE" | "HELD" | "SOLD" | "BLOCKED";
  }): Promise<string> {
    seq += 1;
    const id = `61000000-0000-4000-8001-${String(seq).padStart(12, "0")}`;
    const override = opts.jsonNull
      ? "null"
      : opts.override === undefined
        ? null
        : JSON.stringify(opts.override);
    await pool!.query(
      `INSERT INTO "Seat"
         (id, "seatSectionId", label, row, number, status, price_override, "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $7, $4, $8::"SeatStatus", $5::jsonb, $6, NOW())`,
      [
        id,
        opts.sectionId ?? SECTION_ID,
        `${opts.row ?? "A"}${seq}`,
        seq,
        override,
        // Strictly increasing, so ORDER BY createdAt is the seed order.
        new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
        opts.row ?? "A",
        opts.status ?? "AVAILABLE",
      ],
    );
    return id;
  }

  test("findByIdsForUpdate returns each locked row's override, 0 kept distinct from none", async () => {
    const a = await seedSeat({ override: { priceCents: 5000, reason: "piano" } });
    const b = await seedSeat({});
    const c = await seedSeat({ override: { priceCents: 0 } });

    const rows = await prisma!.$transaction((tx) =>
      makeSeatsRepo(tx).findByIdsForUpdate({
        seatIds: [a, b, c],
        eventId: EVENT_ID,
      }),
    );
    const byId = new Map(rows.map((r) => [r.id, r.priceOverride]));
    expect(byId.get(a)).toEqual({ priceCents: 5000, reason: "piano" });
    expect(byId.get(b)).toBeNull();
    expect(byId.get(c)).toEqual({ priceCents: 0, reason: null });
  });

  test("findPriceOverridesByIds reads the same column, and only this event's seats", async () => {
    const a = await seedSeat({ override: { priceCents: 5000 } });
    const foreign = await seedSeat({
      override: { priceCents: 100 },
      sectionId: OTHER_SECTION_ID,
    });

    const rows = await makeSeatsRepo(prisma!).findPriceOverridesByIds({
      seatIds: [a, foreign],
      eventId: EVENT_ID,
    });
    expect(rows).toEqual([
      {
        id: a,
        seatSectionId: SECTION_ID,
        priceOverride: { priceCents: 5000, reason: null },
      },
    ]);
  });

  // The publish gate's read. What only a database proves: DISTINCT over a
  // jsonb column, the `<> 'null'::jsonb` filter (which must also drop SQL
  // NULL), a scalar surviving as a row, and the event scope.
  test("listDistinctPriceOverridesByEvent returns one row per distinct stored override of the event", async () => {
    for (let i = 0; i < 3; i += 1) {
      await seedSeat({ override: { priceCents: 5000 } });
    }
    await seedSeat({ jsonNull: true });
    await seedSeat({});
    // A scalar, not `{ priceCents }`: corrupt, and it must not read as none.
    await seedSeat({ override: 5000 });
    await seedSeat({
      override: { priceCents: 9900 },
      sectionId: OTHER_SECTION_ID,
    });

    // In a transaction, as publishEvent calls it.
    const rows = await prisma!.$transaction((tx) =>
      makeSeatsRepo(tx).listDistinctPriceOverridesByEvent({
        eventId: EVENT_ID,
      }),
    );

    // Within one section the row order is not defined.
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        {
          seatSectionId: SECTION_ID,
          priceOverride: { priceCents: 5000, reason: null },
        },
        { seatSectionId: SECTION_ID, priceOverride: { invalid: true } },
      ]),
    );
  });

  test("reserveForHold skips overridden seats (SQL NULL and JSON null count as none)", async () => {
    const overridden = await seedSeat({ override: { priceCents: 5000 } });
    const plain = await seedSeat({});
    const freeOverride = await seedSeat({ override: { priceCents: 0 } });
    const jsonNull = await seedSeat({ jsonNull: true });

    const held = await prisma!.$transaction((tx) =>
      makeSeatsRepo(tx).reserveForHold({
        seatSectionId: SECTION_ID,
        eventId: EVENT_ID,
        qty: 2,
        heldAt: HELD_AT,
      }),
    );
    expect(held.map((s) => s.id)).toEqual([plain, jsonNull]);

    const status = await pool!.query<{ id: string; status: string }>(
      `SELECT id, status::text AS status FROM "Seat" WHERE id = ANY($1)`,
      [[overridden, freeOverride]],
    );
    expect(status.rows.every((r) => r.status === "AVAILABLE")).toBe(true);
  });

  test("reserveForHold comes back empty rather than handing out an overridden seat", async () => {
    await seedSeat({ override: { priceCents: 5000 } });
    await seedSeat({});

    const held = await prisma!.$transaction((tx) =>
      makeSeatsRepo(tx).reserveForHold({
        seatSectionId: SECTION_ID,
        eventId: EVENT_ID,
        qty: 2,
        heldAt: HELD_AT,
      }),
    );
    expect(held).toEqual([]);
  });

  test("the checkout reads treat JSON null as none and REPORT a corrupt override without throwing; auto-assign skips it", async () => {
    const jsonNull = await seedSeat({ jsonNull: true });
    const corrupt = await seedSeat({ override: { priceCents: "5000" } });
    const plain = await seedSeat({});

    const read = await makeSeatsRepo(prisma!).findPriceOverridesByIds({
      seatIds: [jsonNull, corrupt, plain],
      eventId: EVENT_ID,
    });
    expect(new Map(read.map((r) => [r.id, r.priceOverride]))).toEqual(
      new Map([
        [jsonNull, null],
        [corrupt, { invalid: true }],
        [plain, null],
      ]),
    );

    // The mint / ticket-email / resale path: the locked read still returns
    // the corrupt seat, whole, so finalize after a charge is unaffected.
    const locked = await prisma!.$transaction((tx) =>
      makeSeatsRepo(tx).findByIdsForUpdate({
        seatIds: [corrupt],
        eventId: EVENT_ID,
      }),
    );
    expect(locked).toHaveLength(1);
    expect(locked[0]).toMatchObject({
      id: corrupt,
      seatSectionId: SECTION_ID,
      eventId: EVENT_ID,
      status: "AVAILABLE",
      priceOverride: { invalid: true },
    });

    // Charge and auto-assign agree: the corrupt seat is never handed out.
    const held = await prisma!.$transaction((tx) =>
      makeSeatsRepo(tx).reserveForHold({
        seatSectionId: SECTION_ID,
        eventId: EVENT_ID,
        qty: 2,
        heldAt: HELD_AT,
      }),
    );
    expect(held.map((s) => s.id).sort()).toEqual([jsonNull, plain].sort());
  });

  test("pickContiguousAvailable (the door) skips overridden and corrupt seats", async () => {
    const a1 = await seedSeat({});
    await seedSeat({ override: { priceCents: 5000 } });
    const a3 = await seedSeat({});
    await seedSeat({ override: { priceCents: "x" } });
    const a5 = await seedSeat({});

    const picked = await prisma!.$transaction((tx) =>
      makeSeatsRepo(tx).pickContiguousAvailable({
        seatSectionId: SECTION_ID,
        eventId: EVENT_ID,
        qty: 3,
      }),
    );
    expect(picked.map((s) => s.id).sort()).toEqual([a1, a3, a5].sort());
  });

  test("pickContiguousAvailable comes back empty when only overridden seats would fill the pick", async () => {
    await seedSeat({});
    await seedSeat({ override: { priceCents: 5000 } });

    const picked = await prisma!.$transaction((tx) =>
      makeSeatsRepo(tx).pickContiguousAvailable({
        seatSectionId: SECTION_ID,
        eventId: EVENT_ID,
        qty: 2,
      }),
    );
    expect(picked).toEqual([]);
  });

  test("pickContiguousAvailable prefers a clean run past an overridden seat over a scattered pick", async () => {
    // A1, A2 (overridden), A3, A4 with qty 2: the pickable run is A3-A4.
    // Without the filter A1-A2 would be the first run; a scattered pick
    // would be A1 + A3. Pins run-before-fallback with the filter in.
    await seedSeat({});
    await seedSeat({ override: { priceCents: 5000 } });
    const a3 = await seedSeat({});
    const a4 = await seedSeat({});

    const picked = await prisma!.$transaction((tx) =>
      makeSeatsRepo(tx).pickContiguousAvailable({
        seatSectionId: SECTION_ID,
        eventId: EVENT_ID,
        qty: 2,
      }),
    );
    expect(picked.map((s) => s.id)).toEqual([a3, a4]);
  });
  test("updatePriceOverrides writes AVAILABLE and BLOCKED seats of the event only, for a set and a clear", async () => {
    const before = { priceCents: 3000, reason: "old" };
    const available = await seedSeat({ override: before });
    const blocked = await seedSeat({ override: before, status: "BLOCKED" });
    const held = await seedSeat({ override: before, status: "HELD" });
    const sold = await seedSeat({ override: before, status: "SOLD" });
    const otherEvent = await seedSeat({
      override: before,
      sectionId: OTHER_SECTION_ID,
    });
    const all = [available, blocked, held, sold, otherEvent];
    const read = async () =>
      new Map(
        (
          await pool!.query<{ id: string; price_override: unknown }>(
            `SELECT id, price_override FROM "Seat" WHERE id = ANY($1)`,
            [all],
          )
        ).rows.map((r) => [r.id, r.price_override]),
      );

    const set = await prisma!.$transaction((tx) =>
      makeSeatsRepo(tx).updatePriceOverrides({
        seatIds: all,
        eventId: EVENT_ID,
        priceOverride: { priceCents: 5000, reason: "piano" },
      }),
    );
    expect(set).toBe(2);
    let rows = await read();
    expect(rows.get(available)).toEqual({ priceCents: 5000, reason: "piano" });
    expect(rows.get(blocked)).toEqual({ priceCents: 5000, reason: "piano" });
    expect(rows.get(held)).toEqual(before);
    expect(rows.get(sold)).toEqual(before);
    expect(rows.get(otherEvent)).toEqual(before);

    const cleared = await prisma!.$transaction((tx) =>
      makeSeatsRepo(tx).updatePriceOverrides({
        seatIds: all,
        eventId: EVENT_ID,
        priceOverride: null,
      }),
    );
    expect(cleared).toBe(2);
    rows = await read();
    expect(rows.get(available)).toBeNull();
    expect(rows.get(blocked)).toBeNull();
    expect(rows.get(held)).toEqual(before);
    expect(rows.get(sold)).toEqual(before);
    expect(rows.get(otherEvent)).toEqual(before);
  });
  // A second connection plays checkout / the door / mint, holding a row lock
  // while the organizer's lock runs. `lock_timeout` turns a lock that WAITS
  // into an error instead of a hung test.
  async function withHeldLock<T>(
    sql: string,
    params: unknown[],
    body: () => Promise<T>,
  ): Promise<T> {
    const holder = await pool!.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(sql, params);
      return await body();
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
  }
  const lockForOverride = (seatIds: string[]) =>
    prisma!.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '2s'");
      return makeSeatsRepo(tx).lockSeatsForPriceOverrideWrite({
        seatIds,
        eventId: EVENT_ID,
      });
    });

  test("lockSeatsForPriceOverrideWrite never waits: a seat locked elsewhere is busy, not missing", async () => {
    const a = await seedSeat({});
    const b = await seedSeat({ status: "HELD" });
    const other = await seedSeat({ sectionId: OTHER_SECTION_ID });
    const unknown = "61000000-0000-4000-8001-999999999999";

    // Checkout's lock on seat b (findByIdsForUpdate: FOR UPDATE).
    const rows = await withHeldLock(
      `SELECT 1 FROM "Seat" WHERE id = $1 FOR UPDATE`,
      [b],
      () => lockForOverride([b, a, other, unknown]),
    );
    expect(rows).toEqual(
      expect.arrayContaining([
        { id: a, seatSectionId: SECTION_ID, status: "AVAILABLE", busy: false },
        { id: b, seatSectionId: SECTION_ID, status: "HELD", busy: true },
      ]),
    );
    // Another event's seat and an unknown id are absent (= notFound).
    expect(rows).toHaveLength(2);
  });

  test("lockSeatsForPriceOverrideWrite does not wait on the SeatSection row checkout locks", async () => {
    const a = await seedSeat({});
    // findByIdsForUpdate's bare FOR UPDATE over Seat ⋈ SeatSection also locks
    // the section row; the organizer's lock must not queue behind it.
    const rows = await withHeldLock(
      `SELECT 1 FROM "SeatSection" WHERE id = $1 FOR UPDATE`,
      [SECTION_ID],
      () => lockForOverride([a]),
    );
    expect(rows).toEqual([
      { id: a, seatSectionId: SECTION_ID, status: "AVAILABLE", busy: false },
    ]);
  });

  test("lockSeatsForPriceOverrideWrite takes a seat under a key-share lock (mint's Ticket insert FK check)", async () => {
    const a = await seedSeat({});
    const rows = await withHeldLock(
      `SELECT 1 FROM "Seat" WHERE id = $1 FOR KEY SHARE`,
      [a],
      () => lockForOverride([a]),
    );
    expect(rows).toEqual([
      { id: a, seatSectionId: SECTION_ID, status: "AVAILABLE", busy: false },
    ]);
  });

  test("the override write (lock, then UPDATE) proceeds while another transaction holds FOR KEY SHARE on the seat", async () => {
    // An order line's FK insert holds FOR KEY SHARE on Seat. FOR NO KEY
    // UPDATE (the lock and the UPDATE both) does not conflict with it, so the
    // write must neither wait nor deadlock: lock_timeout = 2s turns a wait
    // into an error, and the row must carry the new override afterwards.
    const a = await seedSeat({});
    const updated = await withHeldLock(
      `SELECT 1 FROM "Seat" WHERE id = $1 FOR KEY SHARE`,
      [a],
      () =>
        prisma!.$transaction(async (tx) => {
          await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '2s'");
          const repo = makeSeatsRepo(tx);
          const locked = await repo.lockSeatsForPriceOverrideWrite({
            seatIds: [a],
            eventId: EVENT_ID,
          });
          expect(locked).toEqual([
            {
              id: a,
              seatSectionId: SECTION_ID,
              status: "AVAILABLE",
              busy: false,
            },
          ]);
          return repo.updatePriceOverrides({
            seatIds: [a],
            eventId: EVENT_ID,
            priceOverride: { priceCents: 5000, reason: "piano" },
          });
        }),
    );
    expect(updated).toBe(1);
    const { rows } = await pool!.query<{ price_override: unknown }>(
      `SELECT price_override FROM "Seat" WHERE id = $1`,
      [a],
    );
    expect(rows[0]?.price_override).toEqual({
      priceCents: 5000,
      reason: "piano",
    });
  });

  test("lockSeatsForPriceOverrideWrite really holds what it returns", async () => {
    const a = await seedSeat({});
    await prisma!.$transaction(async (tx) => {
      const rows = await makeSeatsRepo(tx).lockSeatsForPriceOverrideWrite({
        seatIds: [a],
        eventId: EVENT_ID,
      });
      expect(rows[0]?.busy).toBe(false);
      // Checkout trying to lock the seat now cannot.
      await expect(
        pool!.query(`SELECT 1 FROM "Seat" WHERE id = $1 FOR UPDATE NOWAIT`, [a]),
      ).rejects.toMatchObject({ code: "55P03" });
    });
  });
});
