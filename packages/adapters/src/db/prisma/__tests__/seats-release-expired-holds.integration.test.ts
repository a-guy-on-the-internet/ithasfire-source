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
// `releaseExpiredHolds` against REAL Postgres.
//
// Money audit 2026-09-08 #16: the seat-hold reaper was order-state-blind. It
// flipped every HELD seat older than the TTL back to AVAILABLE without asking
// whether a cart still owned it, so a kept cart — PENDING order, PaymentIntent
// already succeeded, `payment_intent.succeeded` webhook lagging past 15 min —
// lost its seats, and finalize later minted tickets against `meta.seatIds`
// that another buyer had since been sold. The fix restricts the reaper to
// ORPHANED holds: HELD, past the TTL, no Ticket, and not referenced by any
// open (PENDING / PROCESSING) order's `OrderItem.meta.seatIds`. Open carts
// belong to the PI-aware cart reaper (`releaseExpiredCarts`).
//
// What only a real database proves: the jsonb `?` existence operator inside
// a Prisma tagged template (the `$n` placeholder rewrite must leave the
// literal `?` alone), the enum `::text` compare, the `timestamp(3)` bound
// from a JS Date, and that `LIMIT` still fences the candidate set.
//
// The full migration set is applied to a throwaway container so the column
// and table names are the real ones. FK triggers on the four tables touched
// are disabled so fixtures need no Org→Event→SeatSection→Human graph — the
// query under test never joins through those FKs.
//
// SEEDS PASS TIMESTAMPS AS ISO STRINGS, NOT `Date`s: node-pg serialises a
// Date as LOCAL wall-clock, and `TIMESTAMP(3)` discards the offset. Prisma
// binds Dates as UTC, so the adapter's own `before` / `releasedAt` are fine.
// ---------------------------------------------------------------------------

const SECTION_ID = "60000000-0000-4000-8000-000000000001";
const EVENT_ID = "60000000-0000-4000-8000-000000000002";
const HUMAN_ID = "60000000-0000-4000-8000-000000000003";

const NOW = new Date("2026-09-15T12:00:00.000Z");
/** The use case's cutoff: NOW − 900s. */
const BEFORE = new Date("2026-09-15T11:45:00.000Z");
const STALE = "2026-09-15T11:30:00.000Z";
const FRESH = "2026-09-15T11:59:00.000Z";

const TABLES = ["Seat", "Ticket", "Order", "OrderItem"];

type OrderStatus = "PENDING" | "PROCESSING" | "SUCCEEDED" | "CANCELLED";

describe("seats.releaseExpiredHolds — only ORPHANED holds (integration)", () => {
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
  }, 300_000);

  beforeEach(async () => {
    await pool!.query(
      `TRUNCATE ${TABLES.map((t) => `"${t}"`).join(", ")} CASCADE`,
    );
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
    await pgContainer?.stop();
  }, 120_000);

  let seq = 0;
  const nextId = (tag: string) =>
    `6000000${tag}-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

  async function seedSeat(opts: {
    status?: "AVAILABLE" | "HELD" | "SOLD";
    updatedAt?: string;
  } = {}): Promise<string> {
    const id = nextId("1");
    await pool!.query(
      `INSERT INTO "Seat" (id, "seatSectionId", label, status, "updatedAt")
       VALUES ($1, $2, $3, $4::"SeatStatus", $5)`,
      [id, SECTION_ID, `seat-${seq}`, opts.status ?? "HELD", opts.updatedAt ?? STALE],
    );
    return id;
  }

  async function seedOrder(status: OrderStatus, seatIds: string[]): Promise<string> {
    const orderId = nextId("2");
    await pool!.query(
      `INSERT INTO "Order"
         (id, "eventId", "buyerHumanId", "amountGrossCents", status, "feePolicySnapshot", "updatedAt")
       VALUES ($1, $2, $3, 1000, $4::"OrderStatus", '{}'::jsonb, $5)`,
      [orderId, EVENT_ID, HUMAN_ID, status, NOW.toISOString()],
    );
    await pool!.query(
      `INSERT INTO "OrderItem" (id, "orderId", kind, "unitPriceCents", "amountCents", meta)
       VALUES ($1, $2, 'ticket', 1000, 1000, $3::jsonb)`,
      [nextId("3"), orderId, JSON.stringify({ seatIds })],
    );
    return orderId;
  }

  async function seedTicket(seatId: string): Promise<void> {
    await pool!.query(
      `INSERT INTO "Ticket" (id, "eventId", "ownerHumanId", code, "seatId", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [nextId("4"), EVENT_ID, HUMAN_ID, `code-${seq}`, seatId, NOW.toISOString()],
    );
  }

  async function seatStatus(seatId: string): Promise<string> {
    const res = await pool!.query<{ status: string }>(
      `SELECT status::text AS status FROM "Seat" WHERE id = $1`,
      [seatId],
    );
    return res.rows[0]!.status;
  }

  function release(limit?: number) {
    return makeSeatsRepo(prisma!).releaseExpiredHolds({
      before: BEFORE,
      releasedAt: NOW,
      limit,
    });
  }

  test("(a) a stale HELD seat referenced by a PENDING order's meta.seatIds is NOT released — that cart is the cart reaper's", async () => {
    const seat = await seedSeat();
    await seedOrder("PENDING", [seat]);

    expect(await release()).toBe(0);
    expect(await seatStatus(seat)).toBe("HELD");
  });

  test("a stale HELD seat referenced by a PROCESSING order (delayed-notification payment) is NOT released either", async () => {
    const seat = await seedSeat();
    await seedOrder("PROCESSING", [seat]);

    expect(await release()).toBe(0);
    expect(await seatStatus(seat)).toBe("HELD");
  });

  test("(b) a stale HELD seat referenced ONLY by a CANCELLED order is an orphan and IS released", async () => {
    const seat = await seedSeat();
    await seedOrder("CANCELLED", [seat]);

    expect(await release()).toBe(1);
    expect(await seatStatus(seat)).toBe("AVAILABLE");
  });

  test("a seat on both a CANCELLED and a PENDING order is kept — the live cart wins", async () => {
    const seat = await seedSeat();
    await seedOrder("CANCELLED", [seat]);
    await seedOrder("PENDING", [seat]);

    expect(await release()).toBe(0);
    expect(await seatStatus(seat)).toBe("HELD");
  });

  test("(c) a stale HELD seat referenced by nothing IS released, stamped with releasedAt", async () => {
    const seat = await seedSeat();

    expect(await release()).toBe(1);
    expect(await seatStatus(seat)).toBe("AVAILABLE");
    const stamped = await pool!.query<{ updatedAt: Date }>(
      `SELECT "updatedAt" AT TIME ZONE 'UTC' AS "updatedAt" FROM "Seat" WHERE id = $1`,
      [seat],
    );
    expect(stamped.rows[0]!.updatedAt.toISOString()).toBe(NOW.toISOString());
  });

  test("(d) a stale HELD seat with a Ticket is NOT released (existing behaviour)", async () => {
    const seat = await seedSeat();
    await seedTicket(seat);

    expect(await release()).toBe(0);
    expect(await seatStatus(seat)).toBe("HELD");
  });

  test("(e) a FRESH HELD seat (updatedAt after `before`) referenced by nothing is NOT released", async () => {
    const seat = await seedSeat({ updatedAt: FRESH });

    expect(await release()).toBe(0);
    expect(await seatStatus(seat)).toBe("HELD");
  });

  test("a PENDING order whose item has no seatIds does not shield an unrelated orphan", async () => {
    const orphan = await seedSeat();
    await seedOrder("PENDING", []);

    expect(await release()).toBe(1);
    expect(await seatStatus(orphan)).toBe("AVAILABLE");
  });

  test("only HELD seats are candidates — a stale SOLD seat without a Ticket row is left alone", async () => {
    const sold = await seedSeat({ status: "SOLD" });

    expect(await release()).toBe(0);
    expect(await seatStatus(sold)).toBe("SOLD");
  });

  test("(f) `limit` caps the number released per pass; the rest wait for the next one", async () => {
    const seats = await Promise.all([seedSeat(), seedSeat(), seedSeat()]);

    expect(await release(2)).toBe(2);
    const statuses = await Promise.all(seats.map(seatStatus));
    expect(statuses.filter((s) => s === "AVAILABLE")).toHaveLength(2);
    expect(statuses.filter((s) => s === "HELD")).toHaveLength(1);

    expect(await release(2)).toBe(1);
  });

  test("mixed page: kept-cart seats are skipped OUTSIDE the limit, so they never crowd orphans out of a pass", async () => {
    const kept = await Promise.all([seedSeat(), seedSeat()]);
    await seedOrder("PENDING", kept);
    const orphan = await seedSeat();

    // With the old shape (limit applied before the order check) two kept seats
    // would fill a limit of 2 and the orphan would leak until the next pass.
    expect(await release(2)).toBe(1);
    expect(await seatStatus(orphan)).toBe("AVAILABLE");
    expect(await Promise.all(kept.map(seatStatus))).toEqual(["HELD", "HELD"]);
  });
});
