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

import { makeResaleListingsRepo } from "../../src/db/prisma/resale-listings";

/**
 * A ticket can be listed for resale again once its previous listing is over.
 *
 * "Listing"."ticketId" used to be UNIQUE, so a ticket with a CANCELLED,
 * EXPIRED or SOLD listing could never be listed again: the insert violated
 * the index and the seller got a 500. Migration
 * 20261011120000_listing_live_unique_per_ticket replaces it with a PARTIAL
 * unique index over the live statuses (ACTIVE, HELD).
 *
 * This file proves the INDEX and the adapter. Who may relist is the use
 * case's rule: a seller after a CANCELLED or EXPIRED listing may, and so may
 * the buyer of a SOLD one (owner ruling 2026-10-11: a ticket can be resold
 * any number of times). The last block covers what that asks of the adapter:
 * a sale cannot be unwound back to ACTIVE beside the buyer's own live
 * listing, each hop of a chain keeps its own sale, and no listing-keyed
 * clear touches the pointer of an item bought on resale.
 *
 * A partial index is SQL-only: no stub can prove it, so this runs against
 * real Postgres with every migration applied. Each test takes its own ticket.
 */

const LIVE_INDEX = "Listing_ticketId_live_key";

interface Fixtures {
  eventId: string;
  sellerId: string;
  buyerId: string;
  orderId: string;
}

describe("Prisma adapters integration – relisting a ticket for resale", () => {
  let pg: PostgresTestContainer | undefined;
  let pool: Pool | undefined;
  let prisma: PrismaClient | undefined;
  let fx: Fixtures | undefined;
  let runtimeError: Error | null = null;

  beforeAll(async () => {
    try {
      pg = await startPostgresContainer();
      await runPrismaMigrateDeploy(pg.databaseUrl);

      process.env.DATABASE_URL = pg.databaseUrl;
      // Driver-adapter ("client" engine) mode: a bare `new PrismaClient()`
      // throws, so construct it as packages/db/src/index.ts does.
      pool = new Pool({ connectionString: pg.databaseUrl });
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

      fx = await seedFixtures(prisma);
    } catch (error) {
      runtimeError = error as Error;
      // eslint-disable-next-line no-console
      console.error("resale relist integration setup failed:", error);
    }
  }, 300_000);

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
    if (pool) await pool.end();
    if (pg) await pg.stop();
  });

  /**
   * No skip guards anywhere in this file: a failed container or migration
   * makes every test FAIL through this, naming the setup error. A suite that
   * skips itself has turned a broken run into a green line here before.
   */
  function ready() {
    if (runtimeError) throw runtimeError;
    if (!prisma || !pool || !fx) throw new Error("integration setup did not run");
    return { prisma, pool, fx, repo: makeResaleListingsRepo(prisma) };
  }

  async function makeTicket(code: string) {
    const { prisma, fx } = ready();
    return prisma.ticket.create({
      data: {
        eventId: fx.eventId,
        orderId: fx.orderId,
        ownerHumanId: fx.sellerId,
        code: `${code}-${randomUUID().slice(0, 8)}`,
        status: "VALID",
      },
    });
  }

  function listingInput(ticketId: string, askPriceCents = 5_000) {
    const { fx } = ready();
    return {
      ticketId,
      eventId: fx.eventId,
      sellerHumanId: fx.sellerId,
      askPriceCents,
    };
  }

  async function rowsFor(ticketId: string) {
    const { pool } = ready();
    const { rows } = await pool.query<{ id: string; status: string }>(
      `SELECT id, status::text AS status FROM "Listing" WHERE "ticketId" = $1 ORDER BY "createdAt", id`,
      [ticketId],
    );
    return rows;
  }

  async function setStatus(listingId: string, status: string) {
    const { pool } = ready();
    await pool.query(
      `UPDATE "Listing" SET status = $2::"ListingStatus" WHERE id = $1`,
      [listingId, status],
    );
  }

  test("integration environment is up (canary — do not skip)", () => {
    expect(runtimeError).toBeNull();
    expect(prisma).toBeDefined();
    expect(fx).toBeDefined();
  });

  test("the migration left the partial live index and dropped the one-row-per-ticket index", async () => {
    const { pool } = ready();
    const { rows } = await pool.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'Listing' AND indexdef LIKE '%"ticketId"%'`,
    );
    const byName = new Map(rows.map((r) => [r.indexname, r.indexdef]));

    expect(byName.has("Listing_ticketId_key")).toBe(false);
    const live = byName.get(LIVE_INDEX);
    expect(live).toBeDefined();
    expect(live).toMatch(/CREATE UNIQUE INDEX/);
    expect(live).toMatch(/WHERE/);
    expect(live).toMatch(/ACTIVE/);
    expect(live).toMatch(/HELD/);
    const plain = byName.get("Listing_ticketId_idx");
    expect(plain).toBeDefined();
    expect(plain).not.toMatch(/UNIQUE/);
    expect(plain).not.toMatch(/WHERE/);
  }, 60_000);

  // (a)
  test("create → cancel → create again succeeds and keeps both rows", async () => {
    const { repo, fx } = ready();
    const ticket = await makeTicket("RELIST-CANCEL");

    const first = await repo.create(listingInput(ticket.id, 5_000));
    expect(await repo.cancel(first.id, fx.sellerId)).toBe(true);

    const second = await repo.create(listingInput(ticket.id, 6_000));

    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe("ACTIVE");
    expect(second.askPriceCents).toBe(6_000);
    expect(await rowsFor(ticket.id)).toEqual([
      { id: first.id, status: "CANCELLED" },
      { id: second.id, status: "ACTIVE" },
    ]);
    // The cancelled listing is untouched: same price, still its own record.
    expect(await repo.getById(first.id)).toMatchObject({
      status: "CANCELLED",
      askPriceCents: 5_000,
    });
  }, 60_000);

  // (b) SOLD is not a live status, so a SOLD row leaves the ticket's live
  // slot free. That is what lets the buyer list the ticket again
  // (create-resale-listing, owner ruling 2026-10-11).
  test("a SOLD listing does not occupy the ticket's live slot (index property)", async () => {
    const { repo, prisma, fx } = ready();
    const ticket = await makeTicket("RELIST-SOLD");

    const first = await repo.create(listingInput(ticket.id));
    expect((await repo.hold(first.id, fx.buyerId, new Date(Date.now() + 600_000))).ok).toBe(true);
    const buyerOrder = await prisma.order.create({
      data: {
        eventId: fx.eventId,
        buyerHumanId: fx.buyerId,
        amountGrossCents: 5_000,
        feePolicySnapshot: {},
        status: "SUCCEEDED",
        source: "RESALE",
      },
    });
    expect(await repo.commit(first.id, fx.buyerId, buyerOrder.id)).toEqual({
      ok: true,
      ticketId: ticket.id,
    });

    // The buyer's own listing: a second row for the ticket.
    const resold = await repo.create({
      ...listingInput(ticket.id, 7_000),
      sellerHumanId: fx.buyerId,
    });

    expect(resold.sellerHumanId).toBe(fx.buyerId);
    expect(await rowsFor(ticket.id)).toEqual([
      { id: first.id, status: "SOLD" },
      { id: resold.id, status: "ACTIVE" },
    ]);
    // The first sale keeps who sold it, to which order, for how much.
    expect(await repo.getById(first.id)).toMatchObject({
      status: "SOLD",
      sellerHumanId: fx.sellerId,
      buyerOrderId: buyerOrder.id,
      askPriceCents: 5_000,
    });
  }, 60_000);

  // (c)
  test("an EXPIRED listing does not block a new listing for the same ticket", async () => {
    const { repo, prisma } = ready();
    const ticket = await makeTicket("RELIST-EXPIRED");

    const first = await repo.create({
      ...listingInput(ticket.id),
      expiresAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    await prisma.ticket.update({ where: { id: ticket.id }, data: { status: "LISTED" } });
    // The real sweep, not a hand-set status.
    await repo.expireStale(new Date("2026-06-01T00:00:00.000Z"));
    expect((await repo.getById(first.id))?.status).toBe("EXPIRED");

    const second = await repo.create(listingInput(ticket.id));

    expect(await rowsFor(ticket.id)).toEqual([
      { id: first.id, status: "EXPIRED" },
      { id: second.id, status: "ACTIVE" },
    ]);
  }, 60_000);

  // (d)
  test.each(["ACTIVE", "HELD"] as const)(
    "a second create while one is %s is refused as resale_listing_live_exists",
    async (liveStatus) => {
      const { repo, fx } = ready();
      const ticket = await makeTicket(`RELIST-LIVE-${liveStatus}`);

      const first = await repo.create(listingInput(ticket.id));
      if (liveStatus === "HELD") {
        expect((await repo.hold(first.id, fx.buyerId, new Date(Date.now() + 600_000))).ok).toBe(true);
      }
      expect((await repo.getById(first.id))?.status).toBe(liveStatus);

      await expect(repo.create(listingInput(ticket.id))).rejects.toMatchObject({
        code: "conflict",
        message: "resale_listing_live_exists",
        ticketId: ticket.id,
      });
      await expect(
        repo.createExternal({ ...listingInput(ticket.id), externalRef: { platform: "x" } }),
      ).rejects.toMatchObject({ message: "resale_listing_live_exists" });

      expect(await rowsFor(ticket.id)).toEqual([{ id: first.id, status: liveStatus }]);
    },
    60_000,
  );

  test("the refusal comes from the partial index, by name", async () => {
    const { pool, fx } = ready();
    const ticket = await makeTicket("RELIST-INDEX-NAME");
    const insert = (status: string) =>
      pool.query(
        `INSERT INTO "Listing" (id, "ticketId", "eventId", "sellerHumanId", "askPriceCents", status, "updatedAt")
         VALUES ($1, $2, $3, $4, 5000, $5::"ListingStatus", now())`,
        [randomUUID(), ticket.id, fx.eventId, fx.sellerId, status],
      );

    // Any number of past rows.
    await insert("CANCELLED");
    await insert("CANCELLED");
    await insert("EXPIRED");
    await insert("SOLD");
    await insert("HELD");
    // ACTIVE and HELD share the one live slot.
    await expect(insert("ACTIVE")).rejects.toMatchObject({
      code: "23505",
      constraint: LIVE_INDEX,
    });
    expect((await rowsFor(ticket.id)).map((r) => r.status).sort()).toEqual([
      "CANCELLED",
      "CANCELLED",
      "EXPIRED",
      "HELD",
      "SOLD",
    ]);
  }, 60_000);

  // The adapter tells the live index from any other unique constraint by
  // what Prisma's pg driver adapter reports. This pins that shape: if a
  // Prisma upgrade changes it, `isLiveListingUniqueViolation` in
  // resale-listings.ts has to be re-read.
  test("a Prisma create names the live index in its P2002 (what the adapter narrows on)", async () => {
    const { prisma, fx } = ready();
    const ticket = await makeTicket("RELIST-PRISMA-META");
    const data = {
      ticketId: ticket.id,
      eventId: fx.eventId,
      sellerHumanId: fx.sellerId,
      askPriceCents: 5_000,
    };
    await prisma.resaleListing.create({ data });

    const error = await prisma.resaleListing.create({ data }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(error).toMatchObject({
      code: "P2002",
      meta: {
        modelName: "ResaleListing",
        driverAdapterError: {
          cause: {
            originalCode: "23505",
            originalMessage: expect.stringContaining(`"${LIVE_INDEX}"`),
            kind: "UniqueConstraintViolation",
            constraint: { fields: ['"ticketId"'] },
          },
        },
      },
    });
  }, 60_000);

  // `buyerOrderId` is the model's other unique column. A violation there is
  // not a second live listing and must not be reported as one.
  test("a unique violation on another column is NOT relabelled as resale_listing_live_exists", async () => {
    const { repo, prisma, pool, fx } = ready();
    const sold = await makeTicket("RELIST-OTHER-UNIQUE-A");
    const other = await makeTicket("RELIST-OTHER-UNIQUE-B");
    const buyerOrder = await prisma.order.create({
      data: {
        eventId: fx.eventId,
        buyerHumanId: fx.buyerId,
        amountGrossCents: 5_000,
        feePolicySnapshot: {},
        status: "SUCCEEDED",
        source: "RESALE",
      },
    });
    const first = await repo.create(listingInput(sold.id));
    await pool.query(
      `UPDATE "Listing" SET status = 'SOLD', "buyerOrderId" = $2 WHERE id = $1`,
      [first.id, buyerOrder.id],
    );

    // A raw create that collides on buyerOrderId, sent through the same
    // mapping the repo's `create` uses.
    const collidingClient = {
      resaleListing: {
        create: (args: { data: Record<string, unknown> }) =>
          prisma.resaleListing.create({
            data: { ...args.data, buyerOrderId: buyerOrder.id } as never,
          }),
      },
    } as never;

    const error = await makeResaleListingsRepo(collidingClient)
      .create(listingInput(other.id))
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(error).toMatchObject({ code: "P2002" });
    expect(error).not.toMatchObject({ message: "resale_listing_live_exists" });
    expect(await rowsFor(other.id)).toEqual([]);
  }, 60_000);

  // (e)
  test("two concurrent creates leave exactly one live listing; the loser is a conflict", async () => {
    const { repo } = ready();
    const ticket = await makeTicket("RELIST-RACE");
    // A past listing first, so this is the relist race.
    const past = await repo.create(listingInput(ticket.id));
    await setStatus(past.id, "CANCELLED");

    const settled = await Promise.allSettled([
      repo.create(listingInput(ticket.id, 6_100)),
      repo.create(listingInput(ticket.id, 6_200)),
    ]);

    const won = settled.filter((s) => s.status === "fulfilled");
    const lost = settled.filter((s) => s.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0] as PromiseRejectedResult).reason).toMatchObject({
      code: "conflict",
      message: "resale_listing_live_exists",
    });

    const rows = await rowsFor(ticket.id);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.status === "ACTIVE" || r.status === "HELD")).toHaveLength(1);
    expect(rows.find((r) => r.status === "ACTIVE")?.id).toBe(
      (won[0] as PromiseFulfilledResult<{ id: string }>).value.id,
    );
  }, 60_000);

  test("the same race inside two transactions: the loser's whole transaction rolls back", async () => {
    const { prisma } = ready();
    const ticket = await makeTicket("RELIST-RACE-TX");

    const attempt = (askPriceCents: number) =>
      prisma.$transaction(async (tx) => {
        const created = await makeResaleListingsRepo(tx).create(
          listingInput(ticket.id, askPriceCents),
        );
        // What create-resale-listing does next, in the same transaction.
        await tx.ticket.updateMany({
          where: { id: ticket.id, status: "VALID" },
          data: { status: "LISTED" },
        });
        return created;
      });

    const settled = await Promise.allSettled([attempt(6_100), attempt(6_200)]);

    expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1);
    const lost = settled.find((s) => s.status === "rejected") as PromiseRejectedResult;
    expect(lost.reason).toMatchObject({ message: "resale_listing_live_exists" });
    expect(await rowsFor(ticket.id)).toHaveLength(1);
  }, 60_000);

  // (f)
  test("getByTicketId returns the live listing when a past one exists, and the latest when none is live", async () => {
    const { repo, fx, pool } = ready();
    const ticket = await makeTicket("RELIST-CURRENT");

    expect(await repo.getByTicketId(ticket.id)).toBeNull();

    const first = await repo.create(listingInput(ticket.id, 5_000));
    await repo.cancel(first.id, fx.sellerId);
    const second = await repo.create(listingInput(ticket.id, 6_000));
    await repo.cancel(second.id, fx.sellerId);
    // Pin creation order, so "latest" is not left to two rows sharing a clock tick.
    await pool.query(`UPDATE "Listing" SET "createdAt" = $2 WHERE id = $1`, [
      first.id,
      new Date("2026-05-01T00:00:00.000Z"),
    ]);
    await pool.query(`UPDATE "Listing" SET "createdAt" = $2 WHERE id = $1`, [
      second.id,
      new Date("2026-05-02T00:00:00.000Z"),
    ]);

    // None live: the most recently created past listing.
    expect(await repo.getByTicketId(ticket.id)).toMatchObject({
      id: second.id,
      status: "CANCELLED",
    });

    // A live one, deliberately made the OLDEST row: live still wins over recency.
    const third = await repo.create(listingInput(ticket.id, 7_000));
    await pool.query(`UPDATE "Listing" SET "createdAt" = $2 WHERE id = $1`, [
      third.id,
      new Date("2026-04-01T00:00:00.000Z"),
    ]);
    expect(await repo.getByTicketId(ticket.id)).toMatchObject({
      id: third.id,
      status: "ACTIVE",
    });

    expect((await repo.hold(third.id, fx.buyerId, new Date(Date.now() + 600_000))).ok).toBe(true);
    expect(await repo.getByTicketId(ticket.id)).toMatchObject({
      id: third.id,
      status: "HELD",
    });

    // Back to none live: the latest by creation, which is `second` again.
    await setStatus(third.id, "EXPIRED");
    expect(await repo.getByTicketId(ticket.id)).toMatchObject({ id: second.id });
  }, 60_000);

  test("event cancel and the expiry sweep close only live rows on a ticket with history", async () => {
    const { repo, fx, prisma } = ready();
    const ticket = await makeTicket("RELIST-SWEEPS");
    const past = await repo.create({
      ...listingInput(ticket.id),
      expiresAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    await repo.cancel(past.id, fx.sellerId);
    const live = await repo.create({
      ...listingInput(ticket.id),
      expiresAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    await prisma.ticket.update({ where: { id: ticket.id }, data: { status: "LISTED" } });

    // The sweep expires the live row; the CANCELLED one (also past its
    // expiresAt) is not rewritten to EXPIRED.
    await repo.expireStale(new Date("2026-06-01T00:00:00.000Z"));

    expect(await rowsFor(ticket.id)).toEqual([
      { id: past.id, status: "CANCELLED" },
      { id: live.id, status: "EXPIRED" },
    ]);
    expect(
      (await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).status,
    ).toBe("VALID");
  }, 60_000);

  // ── A ticket bought on resale is listed again (owner ruling 2026-10-11) ──
  //
  // `unwindResaleOrderAfterRefund` is what keeps these states apart in
  // production: it closes the refunded buyer's own live listing BEFORE it
  // puts the sale back to ACTIVE. These tests pin why it has to, on the real
  // index, and that a chain keeps one sale per hop.

  /** A RESALE order of `buyerHumanId`, as a resale checkout leaves it. */
  async function makeResaleOrder(buyerHumanId: string) {
    const { prisma, fx } = ready();
    return prisma.order.create({
      data: {
        eventId: fx.eventId,
        buyerHumanId,
        amountGrossCents: 5_000,
        feePolicySnapshot: {},
        status: "SUCCEEDED",
        source: "RESALE",
      },
    });
  }

  /** The seller lists `ticketId` and `fx.buyerId` buys it: listing SOLD. */
  async function sellToBuyer(ticketId: string) {
    const { repo, fx } = ready();
    const sold = await repo.create(listingInput(ticketId, 5_000));
    expect(
      (await repo.hold(sold.id, fx.buyerId, new Date(Date.now() + 600_000))).ok,
    ).toBe(true);
    const buyerOrder = await makeResaleOrder(fx.buyerId);
    expect(await repo.commit(sold.id, fx.buyerId, buyerOrder.id)).toEqual({
      ok: true,
      ticketId,
    });
    return { sold, buyerOrder };
  }

  async function listingRow(listingId: string) {
    const { pool } = ready();
    const { rows } = await pool.query<{
      status: string;
      buyerOrderId: string | null;
    }>(
      `SELECT status::text AS status, "buyerOrderId" FROM "Listing" WHERE id = $1`,
      [listingId],
    );
    return rows[0];
  }

  test.each(["ACTIVE", "HELD"] as const)(
    "unwindSale(…, ACTIVE) beside the buyer's own %s listing fails on the live index, and succeeds once that listing is cancelled",
    async (relistStatus) => {
      const { repo, fx } = ready();
      const ticket = await makeTicket(`UNWIND-BESIDE-${relistStatus}`);
      const { sold, buyerOrder } = await sellToBuyer(ticket.id);

      // The buyer lists the ticket again.
      const relisted = await repo.create({
        ...listingInput(ticket.id, 7_000),
        sellerHumanId: fx.buyerId,
      });
      if (relistStatus === "HELD") {
        expect(
          (await repo.hold(relisted.id, fx.sellerId, new Date(Date.now() + 600_000))).ok,
        ).toBe(true);
      }

      // Putting the first sale back on sale would be a second live row.
      const error = await repo
        .unwindSale(sold.id, buyerOrder.id, "ACTIVE")
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(error).toMatchObject({
        code: "P2002",
        meta: {
          driverAdapterError: {
            cause: {
              originalCode: "23505",
              originalMessage: expect.stringContaining(`"${LIVE_INDEX}"`),
            },
          },
        },
      });
      // Nothing was written: the sale still stands.
      expect(await listingRow(sold.id)).toEqual({
        status: "SOLD",
        buyerOrderId: buyerOrder.id,
      });

      // Close the buyer's listing first, the way the unwind does: `cancel`
      // for an ACTIVE one, `closeHeld` for a HELD one. (After `closeHeld` the
      // unwind only ever passes CANCELLED; ACTIVE here shows the slot is free.)
      if (relistStatus === "HELD") {
        expect((await repo.closeHeld(relisted.id)).closed).toBe(true);
      } else {
        expect(await repo.cancel(relisted.id, fx.buyerId)).toBe(true);
      }

      await repo.unwindSale(sold.id, buyerOrder.id, "ACTIVE");

      expect(await listingRow(sold.id)).toEqual({
        status: "ACTIVE",
        buyerOrderId: null,
      });
      expect(await rowsFor(ticket.id)).toEqual([
        { id: sold.id, status: "ACTIVE" },
        { id: relisted.id, status: "CANCELLED" },
      ]);
      // And the live slot is taken again.
      await expect(
        repo.create({ ...listingInput(ticket.id), sellerHumanId: fx.buyerId }),
      ).rejects.toMatchObject({ message: "resale_listing_live_exists" });
    },
    60_000,
  );

  test("unwindSale(…, CANCELLED) does not need the live slot: it works beside the buyer's live listing", async () => {
    const { repo, fx } = ready();
    const ticket = await makeTicket("UNWIND-CANCELLED-BESIDE-LIVE");
    const { sold, buyerOrder } = await sellToBuyer(ticket.id);
    const relisted = await repo.create({
      ...listingInput(ticket.id, 7_000),
      sellerHumanId: fx.buyerId,
    });

    await repo.unwindSale(sold.id, buyerOrder.id, "CANCELLED");

    expect(await rowsFor(ticket.id)).toEqual([
      { id: sold.id, status: "CANCELLED" },
      { id: relisted.id, status: "ACTIVE" },
    ]);
  }, 60_000);

  test("a two-hop chain keeps each listing's own sale: A → B → C, then C's sale is unwound", async () => {
    const { repo, prisma, fx } = ready();
    const third = await prisma.human.create({
      data: { name: "Relist Third", status: "ACTIVE" },
    });
    const ticket = await makeTicket("CHAIN-TWO-HOP");

    // Hop 1: seller → buyer.
    const { sold: first, buyerOrder: orderB } = await sellToBuyer(ticket.id);

    // Hop 2: buyer → third.
    const second = await repo.create({
      ...listingInput(ticket.id, 7_000),
      sellerHumanId: fx.buyerId,
    });
    expect(
      (await repo.hold(second.id, third.id, new Date(Date.now() + 600_000))).ok,
    ).toBe(true);
    const orderC = await makeResaleOrder(third.id);
    expect(await repo.commit(second.id, third.id, orderC.id)).toEqual({
      ok: true,
      ticketId: ticket.id,
    });

    // Each hop is its own SOLD row with its own buyer order and seller.
    expect(await repo.getById(first.id)).toMatchObject({
      status: "SOLD",
      sellerHumanId: fx.sellerId,
      buyerOrderId: orderB.id,
    });
    expect(await repo.getById(second.id)).toMatchObject({
      status: "SOLD",
      sellerHumanId: fx.buyerId,
      buyerOrderId: orderC.id,
    });
    expect(
      (await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } }))
        .ownerHumanId,
    ).toBe(third.id);
    const transfers = await prisma.ticketTransfer.findMany({
      where: { ticketId: ticket.id },
      orderBy: { at: "asc" },
      select: { fromHumanId: true, toHumanId: true, reason: true },
    });
    expect(transfers).toEqual([
      { fromHumanId: fx.sellerId, toHumanId: fx.buyerId, reason: "resale" },
      { fromHumanId: fx.buyerId, toHumanId: third.id, reason: "resale" },
    ]);

    // The first sale cannot be unwound by the wrong order, or by C's.
    await expect(
      repo.unwindSale(first.id, orderC.id, "ACTIVE"),
    ).rejects.toMatchObject({ message: "resale_sale_unwind_mismatch" });
    await expect(
      repo.unwindSale(second.id, orderB.id, "ACTIVE"),
    ).rejects.toMatchObject({ message: "resale_sale_unwind_mismatch" });

    // Refund of C's order: the LAST hop goes back on sale, the first stands.
    await repo.unwindSale(second.id, orderC.id, "ACTIVE");

    expect(await listingRow(second.id)).toEqual({
      status: "ACTIVE",
      buyerOrderId: null,
    });
    expect(await listingRow(first.id)).toEqual({
      status: "SOLD",
      buyerOrderId: orderB.id,
    });
  }, 60_000);

  // `closeHeld`: what the refund unwind does to the refunded buyer's own
  // listing when a third person's checkout holds it.
  test("closeHeld cancels a HELD listing and drops its hold; a later commit throws and moves nothing", async () => {
    const { repo, prisma, fx } = ready();
    const ticket = await makeTicket("CLOSE-HELD");
    const { sold, buyerOrder } = await sellToBuyer(ticket.id);
    const relisted = await repo.create({
      ...listingInput(ticket.id, 7_000),
      sellerHumanId: fx.buyerId,
    });
    const heldUntil = new Date(Date.now() + 600_000);
    expect((await repo.hold(relisted.id, fx.sellerId, heldUntil)).ok).toBe(true);

    const result = await repo.closeHeld(relisted.id);

    expect(result.closed).toBe(true);
    expect(result.hold?.buyerHumanId).toBe(fx.sellerId);
    expect(result.hold?.heldUntil.getTime()).toBe(heldUntil.getTime());
    expect(await listingRow(relisted.id)).toEqual({
      status: "CANCELLED",
      buyerOrderId: null,
    });
    expect(
      await prisma.resaleListingHold.count({ where: { listingId: relisted.id } }),
    ).toBe(0);

    // The in-flight checkout's finalize: `commit` refuses a CANCELLED
    // listing by throwing, before it writes the ticket.
    const inFlightOrder = await makeResaleOrder(fx.sellerId);
    await expect(
      repo.commit(relisted.id, fx.sellerId, inFlightOrder.id),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "resale_listing_not_sellable",
    });
    expect(
      (await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } }))
        .ownerHumanId,
    ).toBe(fx.buyerId);

    // A second close, and a close of a listing that is not HELD, write nothing.
    expect(await repo.closeHeld(relisted.id)).toEqual({ closed: false, hold: null });
    expect(await repo.closeHeld(sold.id)).toEqual({ closed: false, hold: null });
    expect(await listingRow(sold.id)).toEqual({
      status: "SOLD",
      buyerOrderId: buyerOrder.id,
    });
    const active = await repo.create({
      ...listingInput(ticket.id, 7_500),
      sellerHumanId: fx.buyerId,
    });
    expect(await repo.closeHeld(active.id)).toEqual({ closed: false, hold: null });
    expect((await repo.getById(active.id))?.status).toBe("ACTIVE");
    await repo.cancel(active.id, fx.buyerId);
  }, 60_000);

  // The listing-keyed pointer clears (`expireStale`, `cancelOpenForEvent`,
  // `releaseHold`) match an order item by the listing being CLOSED. An item
  // bought on resale carries the listing it was bought THROUGH (a SOLD one),
  // never the buyer's own listing, so none of them may touch it.
  test("closing the buyer's own listing leaves the bought-through pointer of their item alone", async () => {
    const { repo, prisma, fx } = ready();
    const ticket = await makeTicket("POINTER-BOUGHT-THROUGH");
    const { sold, buyerOrder } = await sellToBuyer(ticket.id);
    const buyerItem = await prisma.orderItem.create({
      data: {
        orderId: buyerOrder.id,
        kind: "ticket",
        unitPriceCents: 5_000,
        amountCents: 5_000,
        resaleListingId: sold.id,
        meta: { resaleListingId: sold.id },
      },
    });
    // What finalize does: the ticket now hangs off the buyer's item.
    await prisma.ticket.update({
      where: { id: ticket.id },
      data: { orderId: buyerOrder.id, orderItemId: buyerItem.id, status: "VALID" },
    });
    const pointer = async () =>
      (await prisma.orderItem.findUniqueOrThrow({ where: { id: buyerItem.id } }))
        .resaleListingId;
    const relist = async (expiresAt?: Date) => {
      const row = await repo.create({
        ...listingInput(ticket.id, 7_000),
        sellerHumanId: fx.buyerId,
        ...(expiresAt ? { expiresAt } : {}),
      });
      await prisma.ticket.update({
        where: { id: ticket.id },
        data: { status: "LISTED" },
      });
      return row;
    };
    const ticketStatus = async () =>
      (await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).status;

    // 1. The expiry sweep.
    const expired = await relist(new Date("2026-01-01T00:00:00.000Z"));
    await repo.expireStale(new Date("2026-06-01T00:00:00.000Z"));
    expect((await repo.getById(expired.id))?.status).toBe("EXPIRED");
    expect(await ticketStatus()).toBe("VALID");
    expect(await pointer()).toBe(sold.id);

    // 2. A hold released after the listing's own expiry.
    const heldUntil = new Date(Date.now() + 600_000);
    const heldThenExpired = await relist(new Date(Date.now() + 3_600_000));
    expect((await repo.hold(heldThenExpired.id, fx.sellerId, heldUntil)).ok).toBe(true);
    expect(
      await repo.releaseHold(
        heldThenExpired.id,
        { buyerHumanId: fx.sellerId, heldUntil },
        { now: new Date(Date.now() + 7_200_000) },
      ),
    ).toMatchObject({ released: true, listingStatus: "EXPIRED" });
    expect(await ticketStatus()).toBe("VALID");
    expect(await pointer()).toBe(sold.id);

    // 3. The seller's own cancel (the use case skips its item-keyed clear
    //    for a RESALE item; the adapter's `cancel` writes no item at all).
    const cancelled = await relist();
    expect(await repo.cancel(cancelled.id, fx.buyerId)).toBe(true);
    expect(await pointer()).toBe(sold.id);

    // The sale it was bought through is still there to be unwound.
    expect(await listingRow(sold.id)).toEqual({
      status: "SOLD",
      buyerOrderId: buyerOrder.id,
    });
    // Leave no live listing behind for the event-wide test data.
    await prisma.ticket.update({ where: { id: ticket.id }, data: { status: "VALID" } });
  }, 60_000);
});

// ── Fixtures ───────────────────────────────────────────────

async function seedFixtures(prisma: PrismaClient): Promise<Fixtures> {
  const seller = await prisma.human.create({
    data: { name: "Relist Seller", status: "ACTIVE" },
  });
  const buyer = await prisma.human.create({
    data: { name: "Relist Buyer", status: "ACTIVE" },
  });

  const event = await prisma.event.create({
    data: {
      title: "Relist Showcase",
      startsAt: new Date("2027-09-01T20:00:00.000Z"),
      endsAt: new Date("2027-09-01T23:00:00.000Z"),
      status: "PUBLISHED",
      humanId: seller.id,
      defaultLocale: "en",
    },
  });

  const order = await prisma.order.create({
    data: {
      eventId: event.id,
      buyerHumanId: seller.id,
      amountGrossCents: 5_000,
      feePolicySnapshot: {},
      status: "SUCCEEDED",
    },
  });

  return {
    eventId: event.id,
    sellerId: seller.id,
    buyerId: buyer.id,
    orderId: order.id,
  };
}
