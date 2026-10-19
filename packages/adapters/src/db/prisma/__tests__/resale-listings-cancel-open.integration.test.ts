import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { makeResaleListingsRepo } from "../resale-listings";

// ---------------------------------------------------------------------------
// `cancelOpenForEvent` + the hardened `commit` against REAL Postgres.
//
// Money audit 2026-09-08 #22: cancelling an event refunded a LISTED ticket's
// buyer but left the listing purchasable. The fix cancels every open listing
// inside the cancel tx and relies on two things a mocked Prisma cannot prove:
//
//   1. `commit`'s listing flip is a status-conditional UPDATE, so a resale
//      finalize that blocks on the row lock held by the cancelling tx
//      re-evaluates its WHERE against the committed (CANCELLED) row, flips 0
//      rows and aborts — never SOLD over CANCELLED.
//   2. Both take the ticket row lock BEFORE the listing row lock, so the two
//      block rather than deadlock.
//
// The full migration set is applied to a throwaway container. FK triggers on
// the five tables touched are disabled so fixtures need no Org→Event→Order
// graph — the queries under test never join through those FKs.
// ---------------------------------------------------------------------------

const EVENT_ID = "50000000-0000-4000-8000-000000000001";
const OTHER_EVENT_ID = "50000000-0000-4000-8000-000000000002";
const SELLER_ID = "50000000-0000-4000-8000-000000000010";
const BUYER_ID = "50000000-0000-4000-8000-000000000011";
const ACTIVE_LISTING = "50000000-0000-4000-8000-000000000020";
const HELD_LISTING = "50000000-0000-4000-8000-000000000021";
const OTHER_LISTING = "50000000-0000-4000-8000-000000000022";
const ACTIVE_TICKET = "50000000-0000-4000-8000-000000000030";
const HELD_TICKET = "50000000-0000-4000-8000-000000000031";
const OTHER_TICKET = "50000000-0000-4000-8000-000000000032";
const ACTIVE_ITEM = "50000000-0000-4000-8000-000000000040";
const OTHER_ITEM = "50000000-0000-4000-8000-000000000042";
const HOLD_ID = "50000000-0000-4000-8000-000000000050";
const RESALE_ORDER_ID = "50000000-0000-4000-8000-000000000060";
const PRIMARY_ORDER_ID = "50000000-0000-4000-8000-000000000061";

const TABLES = ["Listing", "ListingHold", "Ticket", "TicketTransfer", "OrderItem"];

describe("resaleListings.cancelOpenForEvent / commit (integration)", () => {
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
    await seedFixtures(pool!);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
    await pgContainer?.stop();
  }, 120_000);

  test("cancels ACTIVE + HELD listings of the event only; releases the hold, resets LISTED tickets, clears item pointers; replay is a no-op", async () => {
    const repo = makeResaleListingsRepo(prisma!);

    const first = await repo.cancelOpenForEvent(EVENT_ID);
    expect([...first.cancelledListingIds].sort()).toEqual(
      [ACTIVE_LISTING, HELD_LISTING].sort(),
    );

    expect(await listingStatuses(pool!)).toEqual({
      [ACTIVE_LISTING]: "CANCELLED",
      [HELD_LISTING]: "CANCELLED",
      [OTHER_LISTING]: "ACTIVE",
    });
    expect(await holdCount(pool!)).toBe(0);
    expect(await ticketStatuses(pool!)).toEqual({
      [ACTIVE_TICKET]: "VALID",
      [HELD_TICKET]: "VALID",
      [OTHER_TICKET]: "LISTED",
    });
    expect(await itemPointers(pool!)).toEqual({
      [ACTIVE_ITEM]: null,
      [OTHER_ITEM]: OTHER_LISTING,
    });

    const replay = await repo.cancelOpenForEvent(EVENT_ID);
    expect(replay).toEqual({ cancelledListingIds: [] });
    expect(await listingStatuses(pool!)).toMatchObject({
      [OTHER_LISTING]: "ACTIVE",
    });
  });

  test("a resale commit racing the cancel blocks on the row lock, then flips 0 rows and aborts — never SOLD over CANCELLED", async () => {
    // Tx A: the cancelling tx. Runs the bulk cancel, then HOLDS its locks
    // until released.
    let releaseA!: () => void;
    const aHeld = new Promise<void>((resolve) => (releaseA = resolve));
    let aReachedCancel!: () => void;
    const aCancelled = new Promise<void>((resolve) => (aReachedCancel = resolve));

    const txA = prisma!.$transaction(
      async (tx) => {
        const result = await makeResaleListingsRepo(tx).cancelOpenForEvent(
          EVENT_ID,
        );
        aReachedCancel();
        await aHeld;
        return result;
      },
      { maxWait: 10_000, timeout: 30_000 },
    );
    await aCancelled;

    // Tx B: the resale finalize's commit for the HELD listing. Its
    // findUnique sees HELD + hold (A is uncommitted), then its ticket
    // update must block on the ticket row A already locked.
    const txB = prisma!.$transaction(
      (tx) =>
        makeResaleListingsRepo(tx).commit(HELD_LISTING, BUYER_ID, RESALE_ORDER_ID),
      { maxWait: 10_000, timeout: 30_000 },
    );

    const raced = await Promise.race([
      txB.then(
        () => "settled",
        () => "settled",
      ),
      sleep(750).then(() => "still-blocked"),
    ]);
    expect(raced).toBe("still-blocked");

    releaseA();
    const aResult = await txA;
    expect([...aResult.cancelledListingIds].sort()).toEqual(
      [ACTIVE_LISTING, HELD_LISTING].sort(),
    );

    await expect(txB).rejects.toMatchObject({
      code: "conflict",
      message: "resale_listing_commit_mismatch",
      listingId: HELD_LISTING,
      buyerOrderId: RESALE_ORDER_ID,
    });

    // B rolled back entirely: no ownership change, no transfer row, and the
    // listing is CANCELLED with no buyer order attached.
    expect(await listingStatuses(pool!)).toMatchObject({
      [HELD_LISTING]: "CANCELLED",
    });
    const listing = await pool!.query<{ buyerOrderId: string | null }>(
      `SELECT "buyerOrderId" FROM "Listing" WHERE id = $1`,
      [HELD_LISTING],
    );
    expect(listing.rows[0]!.buyerOrderId).toBeNull();
    const ticket = await pool!.query<{ ownerHumanId: string; status: string }>(
      `SELECT "ownerHumanId", status FROM "Ticket" WHERE id = $1`,
      [HELD_TICKET],
    );
    expect(ticket.rows[0]).toEqual({ ownerHumanId: SELLER_ID, status: "VALID" });
    const transfers = await pool!.query(`SELECT count(*)::int AS n FROM "TicketTransfer"`);
    expect(transfers.rows[0]!.n).toBe(0);
  });

  test("a commit that arrives after the cancel committed throws (not the silent ok:false the finalizer reads as a replay)", async () => {
    const repo = makeResaleListingsRepo(prisma!);
    await repo.cancelOpenForEvent(EVENT_ID);

    await expect(
      repo.commit(HELD_LISTING, BUYER_ID, RESALE_ORDER_ID),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "resale_listing_not_sellable",
      listingStatus: "CANCELLED",
    });
  });

  test("a commit that wins the race leaves the listing SOLD and the cancel reports only what it flipped", async () => {
    const repo = makeResaleListingsRepo(prisma!);

    const committed = await repo.commit(HELD_LISTING, BUYER_ID, RESALE_ORDER_ID);
    expect(committed).toEqual({ ok: true, ticketId: HELD_TICKET });

    const result = await repo.cancelOpenForEvent(EVENT_ID);
    expect(result.cancelledListingIds).toEqual([ACTIVE_LISTING]);
    expect(await listingStatuses(pool!)).toEqual({
      [ACTIVE_LISTING]: "CANCELLED",
      [HELD_LISTING]: "SOLD",
      [OTHER_LISTING]: "ACTIVE",
    });
  });
});

// ── Fixtures ────────────────────────────────────────────────────────────────

async function seedFixtures(pool: pg.Pool): Promise<void> {
  const now = new Date();
  const insertTicket = (id: string, eventId: string, itemId: string | null) =>
    pool.query(
      `INSERT INTO "Ticket" (id, "eventId", "orderId", "orderItemId", "ownerHumanId", code, status, "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, 'LISTED', $7)`,
      [id, eventId, PRIMARY_ORDER_ID, itemId, SELLER_ID, `code-${id}`, now],
    );
  const insertListing = (id: string, ticketId: string, eventId: string, status: string) =>
    pool.query(
      `INSERT INTO "Listing" (id, "ticketId", "eventId", "sellerHumanId", "askPriceCents", status, "updatedAt")
       VALUES ($1, $2, $3, $4, 5000, $5, $6)`,
      [id, ticketId, eventId, SELLER_ID, status, now],
    );
  const insertItem = (id: string, listingId: string) =>
    pool.query(
      `INSERT INTO "OrderItem" (id, "orderId", kind, "unitPriceCents", "amountCents", "resaleListingId")
       VALUES ($1, $2, 'ticket', 5000, 5000, $3)`,
      [id, PRIMARY_ORDER_ID, listingId],
    );

  await insertTicket(ACTIVE_TICKET, EVENT_ID, ACTIVE_ITEM);
  await insertTicket(HELD_TICKET, EVENT_ID, null);
  await insertTicket(OTHER_TICKET, OTHER_EVENT_ID, OTHER_ITEM);
  await insertListing(ACTIVE_LISTING, ACTIVE_TICKET, EVENT_ID, "ACTIVE");
  await insertListing(HELD_LISTING, HELD_TICKET, EVENT_ID, "HELD");
  await insertListing(OTHER_LISTING, OTHER_TICKET, OTHER_EVENT_ID, "ACTIVE");
  await pool.query(
    `INSERT INTO "ListingHold" (id, "listingId", "buyerHumanId", "heldUntil")
     VALUES ($1, $2, $3, $4)`,
    [HOLD_ID, HELD_LISTING, BUYER_ID, new Date(now.getTime() + 15 * 60_000)],
  );
  await insertItem(ACTIVE_ITEM, ACTIVE_LISTING);
  await insertItem(OTHER_ITEM, OTHER_LISTING);
}

async function listingStatuses(pool: pg.Pool): Promise<Record<string, string>> {
  const rows = await pool.query<{ id: string; status: string }>(
    `SELECT id, status FROM "Listing"`,
  );
  return Object.fromEntries(rows.rows.map((r) => [r.id, r.status]));
}

async function ticketStatuses(pool: pg.Pool): Promise<Record<string, string>> {
  const rows = await pool.query<{ id: string; status: string }>(
    `SELECT id, status FROM "Ticket"`,
  );
  return Object.fromEntries(rows.rows.map((r) => [r.id, r.status]));
}

async function itemPointers(pool: pg.Pool): Promise<Record<string, string | null>> {
  const rows = await pool.query<{ id: string; resaleListingId: string | null }>(
    `SELECT id, "resaleListingId" FROM "OrderItem"`,
  );
  return Object.fromEntries(rows.rows.map((r) => [r.id, r.resaleListingId]));
}

async function holdCount(pool: pg.Pool): Promise<number> {
  const rows = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM "ListingHold"`,
  );
  return rows.rows[0]!.n;
}
