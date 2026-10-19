import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { makeTicketsRepo } from "../../src/db/prisma/tickets";

/**
 * The `held` half of capacity accounting is raw SQL, so it is only honestly
 * testable against a real Postgres. Two properties here are load-bearing and
 * were both real defects:
 *
 *   1. A PENDING RESALE order must NOT consume primary inventory. Its ticket
 *      line carries the ORIGINAL primary `ticketTypeId`, but it mints nothing
 *      and the ticket it resells is already inside `issued`. Counting it
 *      refused real buyers for stock that existed. This regressed once already
 *      — 68e0ec1c dropped the `source = 'PRIMARY'` filter from the LOCKING
 *      read while leaving it on the batch read — so both reads are asserted
 *      here, together.
 *   2. A PENDING POS order MUST still consume inventory — POS orders are
 *      `source = PRIMARY` (distinguished by `paymentChannel`), and that is
 *      what makes the door and the web protect each other. A `source` filter
 *      written as "not POS" would silently reopen the oversell it was added
 *      to close.
 *
 * Rows are inserted with raw SQL rather than the Prisma model API on purpose:
 * it names only the columns under test, so schema drift in unrelated columns
 * cannot turn this into a red herring.
 */
describe("Prisma adapters integration – ticket capacity counting", () => {
  let pg: PostgresTestContainer | undefined;
  let pool: Pool | undefined;
  let prisma: PrismaClient | undefined;
  let runtimeError: Error | null = null;

  const NOW = new Date("2026-08-12T20:00:00.000Z");
  // `held` is keyed on the ORDER'S OWN AGE now, not a per-line expiry stamp:
  // a ticket line reserves stock while its PENDING order was placed at or
  // after `heldSince`. The caller derives that cutoff from the expired-cart
  // reaper's TTL (`heldSinceFor`); here it is pinned so the fixtures can sit
  // deliberately on either side of it.
  const HELD_SINCE = new Date("2026-08-12T19:45:00.000Z");
  // Inside the window — still reapable, so it still reserves.
  const RECENT = new Date("2026-08-12T19:50:00.000Z").toISOString();
  // Before the window — already reaped or imminently reapable, reserves nothing.
  const STALE = new Date("2026-08-12T19:30:00.000Z").toISOString();

  let eventId: string;
  let ticketTypeId: string;
  let humanId: string;

  const orderId = (suffix: string) => `order-cap-${suffix}`;

  async function insertOrder(
    id: string,
    source: "PRIMARY" | "RESALE" | "COMP",
    status: "PENDING" | "SUCCEEDED",
    paymentChannel: "WEB" | "POS" = "WEB",
    // Explicit, never NOW(): the whole point of these fixtures is to sit on a
    // chosen side of `heldSince`, and a wall-clock default would put every
    // order inside the window no matter what the test meant.
    occurredAt: string = RECENT,
  ) {
    await prisma!.$executeRawUnsafe(
      `INSERT INTO "Order" (id, "eventId", "buyerHumanId", "amountGrossCents",
         "feesPlatformCents", currency, status, source, "feePolicySnapshot",
         "occurredAt", "paymentChannel", "updatedAt")
       VALUES ($1, $2, $3, 1000, 0, 'usd', $4::"OrderStatus", $5::"OrderSource",
         '{}'::jsonb, $7::timestamptz, $6::"PaymentChannel", NOW())`,
      id,
      eventId,
      humanId,
      status,
      source,
      paymentChannel,
      occurredAt,
    );
  }

  // No `holdExpiresAt` parameter any more: nothing reads that stamp. Both
  // capacity reads key on `Order.occurredAt`, so order age is the only lever
  // a fixture has.
  async function insertTicketLine(id: string, ordId: string, qty: number) {
    await prisma!.$executeRawUnsafe(
      `INSERT INTO "OrderItem" (id, "orderId", kind, "ticketTypeId", qty,
         "unitPriceCents", "amountCents", meta)
       VALUES ($1, $2, 'ticket', $3, $4, 1000, 1000, '{}'::jsonb)`,
      id,
      ordId,
      ticketTypeId,
      qty,
    );
  }

  beforeAll(async () => {
    try {
      pg = await startPostgresContainer();
      await runPrismaMigrateDeploy(pg.databaseUrl);

      process.env.DATABASE_URL = pg.databaseUrl;
      pool = new Pool({ connectionString: pg.databaseUrl });
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

      const human = await prisma.human.create({
        data: { name: "Capacity Tester", status: "ACTIVE" },
      });
      humanId = human.id;

      const event = await prisma.event.create({
        data: {
          title: "Capacity Event",
          startsAt: new Date("2026-09-01T20:00:00.000Z"),
          endsAt: new Date("2026-09-01T23:00:00.000Z"),
          status: "PUBLISHED",
          humanId: human.id,
        },
      });
      eventId = event.id;

      ticketTypeId = "tt-capacity-0000-0000-000000000001";
      await prisma.$executeRawUnsafe(
        `INSERT INTO "TicketType" (id, "eventId", name, "priceCents", capacity, status, "updatedAt")
         VALUES ($1, $2, 'GA', 1000, 100, 'ACTIVE'::"TicketTypeStatus", NOW())`,
        ticketTypeId,
        eventId,
      );

      // 1 web cart holding 2 — the ordinary PRIMARY hold.
      await insertOrder(orderId("web"), "PRIMARY", "PENDING");
      await insertTicketLine("item-web", orderId("web"), 2);

      // 1 POS sale holding 3 — also PRIMARY, distinguished by paymentChannel.
      await insertOrder(orderId("pos"), "PRIMARY", "PENDING", "POS");
      await insertTicketLine("item-pos", orderId("pos"), 3);

      // 1 in-flight RESALE holding 5 against the SAME primary tier.
      await insertOrder(orderId("resale"), "RESALE", "PENDING");
      await insertTicketLine("item-resale", orderId("resale"), 5);

      // An expired PRIMARY hold — must not count.
      await insertOrder(orderId("stale"), "PRIMARY", "PENDING", "WEB", STALE);
      await insertTicketLine("item-stale", orderId("stale"), 7);

      // A PRIMARY line with no hold stamp at all — the pre-hold legacy shape.
    } catch (error) {
      runtimeError = error as Error;
      // eslint-disable-next-line no-console
      console.error("ticket-capacity integration setup failed:", error);
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

  // Distinguishes "no Docker on this machine" (a legitimate skip) from "the
  // container came up and setup then failed" (a broken test masquerading as a
  // pass). Without this the whole file reports green while asserting nothing —
  // the silent-skip trap these adapter integration suites are prone to.
  test("harness started, or the skip is honest", () => {
    if (!pg) {
      expect(runtimeError).not.toBeNull();
      return;
    }
    expect(runtimeError).toBeNull();
    expect(prisma).toBeDefined();
  });

  test("counts PRIMARY holds (web + POS) and EXCLUDES resale", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    const repo = makeTicketsRepo(prisma);
    const { issued, held } = await repo.lockAndCountCapacityForTicketType({
      ticketTypeId,
      heldSince: HELD_SINCE,
    });

    expect(issued).toBe(0);
    // 2 (web) + 3 (POS) = 5. NOT 10 — the 5-unit resale hold must not count
    // (source = RESALE), and the 7-unit order placed before `heldSince` has
    // aged out of the window.
    expect(held).toBe(5);
  }, 60_000);

  test("a resale hold never reduces remaining primary capacity", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    const repo = makeTicketsRepo(prisma);

    const before = await repo.lockAndCountCapacityForTicketType({
      ticketTypeId,
      heldSince: HELD_SINCE,
    });

    // Add a second in-flight resale for 20 more units of the same tier.
    await insertOrder(orderId("resale2"), "RESALE", "PENDING");
    await insertTicketLine("item-resale2", orderId("resale2"), 20);

    const after = await repo.lockAndCountCapacityForTicketType({
      ticketTypeId,
      heldSince: HELD_SINCE,
    });

    // Resale volume is invisible to primary inventory, however large.
    expect(after.held).toBe(before.held);
  }, 60_000);

  // ── The LOCK-FREE batch read used by the public listing surfaces ──────────
  //
  // Its whole reason to exist is that the public "sold out?" badge must agree
  // with the pre-charge gate. That is only true if it counts EXACTLY what the
  // locking method counts, so the load-bearing assertion is agreement between
  // the two — not a hand-copied expected number, which would go green on the
  // day someone changed one query and not the other.

  test("batch counts agree with the locking counter, tier for tier", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    const repo = makeTicketsRepo(prisma);

    const locked = await repo.lockAndCountCapacityForTicketType({
      ticketTypeId,
      heldSince: HELD_SINCE,
    });
    const [batched] = await repo.countCapacityUsageForTicketTypes({
      ticketTypeIds: [ticketTypeId],
      heldSince: HELD_SINCE,
    });

    expect(batched).toEqual({
      ticketTypeId,
      issued: locked.issued,
      held: locked.held,
    });
    // And it is a real count, not a zero fill masquerading as agreement:
    // the seeded web (2) + POS (3) holds are present, resale/expired/unstamped
    // are not.
    expect(batched!.held).toBe(5);
  }, 60_000);

  test("returns zero-filled entries for tiers with no rows at all", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    const repo = makeTicketsRepo(prisma);
    const emptyTicketTypeId = "tt-capacity-0000-0000-000000000002";
    await prisma.$executeRawUnsafe(
      `INSERT INTO "TicketType" (id, "eventId", name, "priceCents", capacity, status, "updatedAt")
       VALUES ($1, $2, 'Balcony', 2000, 50, 'ACTIVE'::"TicketTypeStatus", NOW())`,
      emptyTicketTypeId,
      eventId,
    );

    const rows = await repo.countCapacityUsageForTicketTypes({
      ticketTypeIds: [emptyTicketTypeId, ticketTypeId],
      heldSince: HELD_SINCE,
    });

    // An OMITTED row would read as "unknown" upstream; the contract is one
    // entry per requested id, zero-filled. A tier with nothing sold is fully
    // available, and dropping it here would hide it on the page.
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.ticketTypeId === emptyTicketTypeId)).toEqual({
      ticketTypeId: emptyTicketTypeId,
      issued: 0,
      held: 0,
    });
  }, 60_000);

  test("zero-fills an id that does not exist, and dedupes repeats", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    const repo = makeTicketsRepo(prisma);
    const rows = await repo.countCapacityUsageForTicketTypes({
      ticketTypeIds: [ticketTypeId, "tt-does-not-exist", ticketTypeId],
      heldSince: HELD_SINCE,
    });

    expect(rows.map((r) => r.ticketTypeId)).toEqual([
      ticketTypeId,
      "tt-does-not-exist",
    ]);
    expect(rows[1]).toEqual({
      ticketTypeId: "tt-does-not-exist",
      issued: 0,
      held: 0,
    });
  }, 60_000);

  test("an empty id list returns [] without touching the database", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    const repo = makeTicketsRepo(prisma);
    await expect(
      repo.countCapacityUsageForTicketTypes({ ticketTypeIds: [], heldSince: HELD_SINCE }),
    ).resolves.toEqual([]);
  }, 60_000);

  test("aged-out holds drop out of the batch count as they do the locked one", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    const repo = makeTicketsRepo(prisma);

    // `heldSince` walked past every seeded order's `occurredAt`: the same rows
    // that counted above must now count for nothing. This is what makes the
    // badge recover on its own after an abandoned cart, which is the cost side
    // of counting holds at all.
    const [afterExpiry] = await repo.countCapacityUsageForTicketTypes({
      ticketTypeIds: [ticketTypeId],
      heldSince: new Date("2026-08-12T21:00:00.000Z"),
    });

    expect(afterExpiry!.held).toBe(0);
  }, 60_000);

  test("excludeOrderId drops only that order's hold", async ({ skip }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    const repo = makeTicketsRepo(prisma);

    const all = await repo.lockAndCountCapacityForTicketType({
      ticketTypeId,
      heldSince: HELD_SINCE,
    });
    const withoutWeb = await repo.lockAndCountCapacityForTicketType({
      ticketTypeId,
      heldSince: HELD_SINCE,
      excludeOrderId: orderId("web"),
    });

    // The web cart held 2.
    expect(all.held - withoutWeb.held).toBe(2);

    // And an explicit null behaves exactly like omitting it.
    const explicitNull = await repo.lockAndCountCapacityForTicketType({
      ticketTypeId,
      heldSince: HELD_SINCE,
      excludeOrderId: null,
    });
    expect(explicitNull.held).toBe(all.held);
  }, 60_000);

  // ── `issued`: only tickets that still hold a place ────────────────────────
  //
  // Refunds restock (spec 2026-10-09, FR-001/002/004, NFR-002). A REFUNDED or
  // INVALID ticket gives its place back; VALID, SCANNED and LISTED keep it
  // (CAPACITY_CONSUMING_TICKET_STATUSES). The all-rows count behind the
  // delete guard must keep counting every row. Seeded on a tier of its own so
  // the `issued === 0` assertions above stay true.
  describe("issued counts only VALID, SCANNED and LISTED tickets", () => {
    const statusTicketTypeId = "tt-capacity-0000-0000-000000000003";
    let firstValidTicketId: string | undefined;
    const statusOrderId = orderId("statuses");

    // 2 VALID + 1 SCANNED + 1 LISTED hold places (4); 2 REFUNDED + 1 INVALID
    // do not. Uneven on purpose, so a filter that kept one terminal status
    // or dropped one live status lands on a different number.
    const SEEDED: Array<"VALID" | "SCANNED" | "LISTED" | "REFUNDED" | "INVALID"> =
      ["VALID", "VALID", "SCANNED", "LISTED", "REFUNDED", "REFUNDED", "INVALID"];
    const PLACES_HELD = 4;

    beforeAll(async () => {
      if (runtimeError || !prisma) return;
      await prisma.$executeRawUnsafe(
        `INSERT INTO "TicketType" (id, "eventId", name, "priceCents", capacity, status, "updatedAt")
         VALUES ($1, $2, 'Statuses', 1000, 100, 'ACTIVE'::"TicketTypeStatus", NOW())`,
        statusTicketTypeId,
        eventId,
      );
      // One paid order owns them all, so the per-order count (mint
      // idempotency) is exercised too. SUCCEEDED, so it holds nothing.
      await insertOrder(statusOrderId, "PRIMARY", "SUCCEEDED");
      for (const [i, status] of SEEDED.entries()) {
        const ticket = await prisma.ticket.create({
          data: {
            eventId,
            ticketTypeId: statusTicketTypeId,
            orderId: statusOrderId,
            ownerHumanId: humanId,
            code: `CAP-STATUS-${i}`,
            status,
          },
        });
        if (status === "VALID" && !firstValidTicketId) {
          firstValidTicketId = ticket.id;
        }
      }
    }, 60_000);

    async function readAll() {
      const repo = makeTicketsRepo(prisma!);
      const locked = await repo.lockAndCountCapacityForTicketType({
        ticketTypeId: statusTicketTypeId,
        heldSince: HELD_SINCE,
      });
      const [batched] = await repo.countCapacityUsageForTicketTypes({
        ticketTypeIds: [statusTicketTypeId],
        heldSince: HELD_SINCE,
      });
      const consuming =
        await repo.countCapacityConsumingForTicketType(statusTicketTypeId);
      const allRows = await repo.countIssuedForTicketType(statusTicketTypeId);
      const orderRows = await repo.countForOrderTicketType(
        statusOrderId,
        statusTicketTypeId,
      );
      // The only Ticket rows in this event are the ones seeded here.
      const eventRows = await repo.countIssuedForEvent(eventId);
      return { locked, batched: batched!, consuming, allRows, orderRows, eventRows };
    }

    test("the gate, the badge and the mint backstop agree, and skip REFUNDED and INVALID", async ({
      skip,
    }) => {
      if (runtimeError || !prisma) {
        skip();
        return;
      }

      const { locked, batched, consuming, allRows, orderRows, eventRows } =
        await readAll();

      // (a) the two capacity methods agree, and count only places held.
      expect(batched.issued).toBe(locked.issued);
      expect(locked.issued).toBe(PLACES_HELD);
      // (b) the single count mint and comp read is the same number.
      expect(consuming).toBe(PLACES_HELD);
      // (c) the history counts still see every row: the delete guard, the
      // publish guard, and mint idempotency (FR-004: a replayed mint after a
      // refund finds the refunded tickets and mints nothing).
      expect(allRows).toBe(SEEDED.length);
      expect(orderRows).toBe(SEEDED.length);
      expect(eventRows).toBe(SEEDED.length);
      // No order lines on this tier, so nothing is held.
      expect(locked.held).toBe(0);
      expect(batched.held).toBe(0);
    }, 60_000);

    test("refunding a VALID ticket frees one place in every capacity count", async ({
      skip,
    }) => {
      if (runtimeError || !prisma) {
        skip();
        return;
      }

      const before = await readAll();
      await prisma.ticket.update({
        where: { id: firstValidTicketId! },
        data: { status: "REFUNDED" },
      });
      const after = await readAll();

      // (d) both capacity methods, and the backstop count, drop by one.
      expect(after.locked.issued).toBe(before.locked.issued - 1);
      expect(after.batched.issued).toBe(before.batched.issued - 1);
      expect(after.consuming).toBe(before.consuming - 1);
      expect(after.batched.issued).toBe(after.locked.issued);
      // The refunded row is still history: every all-rows count is unchanged.
      expect(after.allRows).toBe(before.allRows);
      expect(after.orderRows).toBe(before.orderRows);
      expect(after.eventRows).toBe(before.eventRows);
    }, 60_000);
  });
});
