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

import { expireResaleListings } from "@th/core/use-cases/resale";
import { releaseRetiredCartHolds } from "@th/core/use-cases/orders/_shared/retire-carried-over-cart";

import { createPrismaRepos } from "../index";
import { makeEventsRepo } from "../events";
import { makeOrdersRepo } from "../orders";
import { makeResaleListingsRepo } from "../resale-listings";

// ---------------------------------------------------------------------------
// createResaleCheckout commits its PENDING order and listing hold first, then
// creates the PaymentIntent with no transaction open, then links it in a
// second transaction:
//
//   linkPaymentIntentIfPending(order, pi)          order row lock
//   resaleListings.lockHold(listing, hold)         ticket row, then listing row
//   ticket still LISTED, seller's item unrefunded  read under the ticket lock
//
// A false from `lockHold` (or a failed re-check) throws inside that
// transaction, so the link
// rolls back. Correctness against `cancelEvent`'s `cancelOpenForEvent`
// (tickets → listings → hold rows) rests on READ COMMITTED re-evaluating a
// blocked UPDATE's WHERE against the committed row — a property of Postgres,
// not of a mocked client. Also pinned here: the fenced `releaseHold` the
// unwind uses never frees a newer hold, and `heldUntil` round-trips through
// TIMESTAMP(3) with millisecond fidelity (the fence compares it exactly).
//
// G1: every canceller of a resale order releases its listing hold in the
// cancel transaction (order row, then listing row), and the hourly stale-hold
// sweep in `expireResaleListings` releases a hold only after `lockHold` has
// taken the ticket and listing row locks AND `listOrdersForHold` shows every
// order of that buyer that took this hold CANCELLED. The sweep tests below replay that
// transaction against finalize, the link and a canceller.
//
// Release target (fix round 1): `releaseHold` locks the TICKET row first
// (FOR NO KEY UPDATE), then the listing, and closes the listing instead of
// putting it back on sale when the pass is no longer LISTED, the seller's
// item was refunded, the event is CANCELLED (→ CANCELLED) or `expiresAt` has
// passed (→ EXPIRED). Cases below drive the real `expireResaleListings` and
// `releaseRetiredCartHolds` over `createPrismaRepos`, not hand-copied logic.
//
// Full migration set; FK triggers disabled on the touched tables so fixtures
// need no Org → Event graph. NOTE: `DISABLE TRIGGER ALL` also turns off
// foreign-key enforcement, and with it the `FOR KEY SHARE` locks an FK check
// takes on the referenced row, so most cases here do NOT exercise FK lock
// interactions. The one case marked "triggers ON" re-enables them (with the
// Human rows the FKs need) for a sweep-vs-finalize race.
// ---------------------------------------------------------------------------

const EVENT_ID = "51000000-0000-4000-8000-000000000001";
const SELLER_ID = "51000000-0000-4000-8000-000000000010";
const BUYER_ID = "51000000-0000-4000-8000-000000000011";
const OTHER_BUYER_ID = "51000000-0000-4000-8000-000000000012";
const LISTING_ID = "51000000-0000-4000-8000-000000000020";
const TICKET_ID = "51000000-0000-4000-8000-000000000030";
const PRIMARY_ORDER_ID = "51000000-0000-4000-8000-000000000061";
const RESALE_ORDER_ID = "51000000-0000-4000-8000-000000000062";
const RESALE_ITEM_ID = "51000000-0000-4000-8000-000000000063";
const SELLER_ITEM_ID = "51000000-0000-4000-8000-000000000064";

/** Sub-second on purpose: the fence must survive the TIMESTAMP(3) column. */
const HELD_UNTIL = new Date("2030-03-10T12:15:00.123Z");

const TABLES = [
  "Event",
  "Listing",
  "ListingHold",
  "Ticket",
  "TicketTransfer",
  "OrderItem",
  "Order",
];

type Deferred = { promise: Promise<void>; resolve: () => void };
const deferred = (): Deferred => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

describe("resale listing hold vs link vs cancelOpenForEvent (integration, real Postgres)", () => {
  let pgContainer: PostgresTestContainer | undefined;
  let pool: pg.Pool | undefined;
  let prisma: PrismaClient | undefined;

  beforeAll(async () => {
    pgContainer = await startPostgresContainer();
    await runPrismaMigrateDeploy(pgContainer.databaseUrl);
    pool = new pg.Pool({ connectionString: pgContainer.databaseUrl, max: 8 });
    for (const table of TABLES) {
      await pool.query(`ALTER TABLE "${table}" DISABLE TRIGGER ALL`);
    }
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  }, 300_000);

  beforeEach(async () => {
    await pool!.query(
      `TRUNCATE ${TABLES.map((t) => `"${t}"`).join(", ")} CASCADE`,
    );
    // The stale-hold sweep's cursor and audit rows (real use-case cases).
    await pool!.query(`DELETE FROM "JobState"`);
    await pool!.query(`DELETE FROM "AuditLog"`);
    await seedFixtures(pool!);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
    await pgContainer?.stop();
  }, 120_000);

  /**
   * `cancelEvent`'s transaction, in its lock order: the Event row FOR UPDATE
   * first (`events.lockRows`), the event's status write, then
   * `cancelOpenForEvent` (tickets → listings → hold rows). `hold` lets a test
   * keep it open after the cancel.
   */
  const cancelEventTx = (hold?: { applied: () => void; release: Promise<void> }) =>
    prisma!.$transaction(
      async (tx) => {
        await makeEventsRepo(tx).lockRows({ ids: [EVENT_ID], mode: "update" });
        await tx.event.update({
          where: { id: EVENT_ID },
          data: { status: "CANCELLED" },
        });
        const r = await makeResaleListingsRepo(tx).cancelOpenForEvent(EVENT_ID);
        if (hold) {
          hold.applied();
          await hold.release;
        }
        return r;
      },
      { maxWait: 10_000, timeout: 20_000 },
    );

  const holdListing = (buyerHumanId = BUYER_ID, heldUntil = HELD_UNTIL) =>
    makeResaleListingsRepo(prisma!).hold(LISTING_ID, buyerHumanId, heldUntil);

  /**
   * createResaleCheckout's link transaction, verbatim in shape. A lost link
   * throws (the real one throws so the link rolls back); this returns the
   * `lostTo` it would carry, read from the error. `afterLock` holds the
   * ticket and listing locks open.
   */
  const linkTx = (
    pi: string,
    hold = { buyerHumanId: BUYER_ID, heldUntil: HELD_UNTIL },
    afterLock?: { applied: () => void; release: Promise<void> },
  ) =>
    prisma!
      .$transaction(
        async (tx) => {
          const linked = await makeOrdersRepo(tx).linkPaymentIntentIfPending(
            RESALE_ORDER_ID,
            pi,
          );
          if (!linked) return "order_not_pending" as const;
          const held = await makeResaleListingsRepo(tx).lockHold(
            LISTING_ID,
            hold,
          );
          if (!held) throw new Error("resale_listing_hold_lost");
          if (afterLock) {
            afterLock.applied();
            await afterLock.release;
          }
          const ticket = await tx.ticket.findUnique({
            where: { id: TICKET_ID },
            select: { status: true, orderItemId: true },
          });
          if (ticket?.status !== "LISTED") throw new Error("ticket_not_listed");
          const item = ticket.orderItemId
            ? await tx.orderItem.findUnique({
                where: { id: ticket.orderItemId },
                select: { status: true, refundedAt: true },
              })
            : null;
          if (item && (item.status === "refunded" || item.refundedAt)) {
            throw new Error("original_item_refunded");
          }
          return "linked" as const;
        },
        { maxWait: 10_000, timeout: 20_000 },
      )
      .catch((err: unknown) => {
        const m = err instanceof Error ? err.message : "";
        if (
          m === "ticket_not_listed" ||
          m === "original_item_refunded"
        ) {
          return m;
        }
        throw err;
      });

  /**
   * The external-partial arm of `reconcileStripeFullRefund` for the seller's
   * listed item, in its lock order: void the ticket, then flip the item.
   * `itemFirst` replays the order it had before (item, then ticket).
   * `afterFirst` holds the first row lock open.
   */
  const refundTx = (
    opts: {
      itemFirst?: boolean;
      afterFirst?: { applied: () => void; release: Promise<void> };
    } = {},
  ) =>
    prisma!.$transaction(
      async (tx) => {
        const voidTicket = () =>
          tx.ticket.update({
            where: { id: TICKET_ID },
            data: { status: "REFUNDED" },
          });
        const flipItem = () =>
          tx.orderItem.update({
            where: { id: SELLER_ITEM_ID },
            data: { status: "refunded", refundedAt: new Date() },
          });
        await (opts.itemFirst ? flipItem() : voidTicket());
        if (opts.afterFirst) {
          opts.afterFirst.applied();
          await opts.afterFirst.release;
        }
        await (opts.itemFirst ? voidTicket() : flipItem());
      },
      { maxWait: 10_000, timeout: 20_000 },
    );

  /**
   * The stale-hold sweep's per-listing transaction, in the shape
   * `expireResaleListings` runs it (lock + fence, live-order read, release).
   * `afterLock` lets a test hold the listing lock open.
   */
  const sweepTx = (
    fence = { buyerHumanId: BUYER_ID, heldUntil: HELD_UNTIL },
    afterLock?: { applied: () => void; release: Promise<void> },
  ) =>
    prisma!.$transaction(
      async (tx) => {
        const repo = makeResaleListingsRepo(tx);
        if (!(await repo.lockHold(LISTING_ID, fence))) return "gone" as const;
        if (afterLock) {
          afterLock.applied();
          await afterLock.release;
        }
        const orders = await repo.listOrdersForHold(LISTING_ID, fence.buyerHumanId);
        if (orders.some((o) => o.status !== "CANCELLED")) {
          return "kept_live" as const;
        }
        return (await repo.releaseHold(LISTING_ID, fence)).released
          ? ("released" as const)
          : ("gone" as const);
      },
      { maxWait: 10_000, timeout: 20_000 },
    );

  /**
   * finalize's resale transaction, in its lock order: the order CAS
   * (`markSucceededIfOpen`, order row), then `resaleListings.commit` (ticket
   * row, then listing row). `afterOrder` holds it open after the order CAS.
   */
  const finalizeTx = (afterOrder?: { applied: () => void; release: Promise<void> }) =>
    prisma!.$transaction(
      async (tx) => {
        const open = await makeOrdersRepo(tx).markSucceededIfOpen(RESALE_ORDER_ID);
        if (!open) return { ok: false as const, reason: "order_not_open" };
        if (afterOrder) {
          afterOrder.applied();
          await afterOrder.release;
        }
        const committed = await makeResaleListingsRepo(tx).commit(
          LISTING_ID,
          BUYER_ID,
          RESALE_ORDER_ID,
        );
        if (!committed.ok) throw new Error("resale_listing_commit_refused");
        return { ok: true as const };
      },
      { maxWait: 10_000, timeout: 20_000 },
    );

  /**
   * A canceller's transaction (`releaseRetiredCartHolds` +
   * `releaseResaleListingHoldsForOrder`): the PENDING CAS on the order, then
   * the fenced release with the fence read off the order item's meta.
   */
  const cancellerTx = () =>
    prisma!.$transaction(
      async (tx) => {
        const cancelled = await makeOrdersRepo(tx).cancelPendingOrder(
          RESALE_ORDER_ID,
          { expectedPaymentIntentId: null },
        );
        if (!cancelled) return { cancelled, released: false };
        const item = await tx.orderItem.findFirstOrThrow({
          where: { orderId: RESALE_ORDER_ID },
        });
        const meta = item.meta as { holdExpiresAt: string; resaleListingId: string };
        const released = (
          await makeResaleListingsRepo(tx).releaseHold(meta.resaleListingId, {
            buyerHumanId: BUYER_ID,
            heldUntil: new Date(meta.holdExpiresAt),
          })
        ).released;
        return { cancelled, released };
      },
      { maxWait: 10_000, timeout: 20_000 },
    );

  test("heldUntil round-trips with millisecond fidelity: the exact Date matches, 1 ms off does not", async () => {
    expect(await holdListing()).toEqual({ ok: true });

    const stored = await pool!.query<{ heldUntil: Date }>(
      `SELECT "heldUntil" FROM "ListingHold" WHERE "listingId" = $1`,
      [LISTING_ID],
    );
    // TIMESTAMP(3) without zone; Prisma writes/reads UTC.
    const viaPrisma = await prisma!.resaleListingHold.findUnique({
      where: { listingId: LISTING_ID },
    });
    expect(viaPrisma!.heldUntil.getTime()).toBe(HELD_UNTIL.getTime());
    expect(stored.rows).toHaveLength(1);

    const repo = makeResaleListingsRepo(prisma!);
    expect(
      await repo.assertHeldBy(LISTING_ID, {
        buyerHumanId: BUYER_ID,
        heldUntil: new Date(HELD_UNTIL.getTime()),
      }),
    ).toBe(true);
    expect(
      await repo.assertHeldBy(LISTING_ID, {
        buyerHumanId: BUYER_ID,
        heldUntil: new Date(HELD_UNTIL.getTime() + 1),
      }),
    ).toBe(false);
    expect(
      await repo.assertHeldBy(LISTING_ID, {
        buyerHumanId: OTHER_BUYER_ID,
        heldUntil: HELD_UNTIL,
      }),
    ).toBe(false);
  });

  test("the fenced releaseHold never frees a newer hold; the matching one goes back to ACTIVE", async () => {
    // The live hold is a LATER attempt (same buyer, later heldUntil).
    const newer = new Date(HELD_UNTIL.getTime() + 60_000);
    expect(await holdListing(BUYER_ID, newer)).toEqual({ ok: true });
    const repo = makeResaleListingsRepo(prisma!);

    // A stale unwind of the earlier attempt, and another buyer's: no-ops.
    expect(
      await repo.releaseHold(LISTING_ID, {
        buyerHumanId: BUYER_ID,
        heldUntil: HELD_UNTIL,
      }),
    ).toEqual({ released: false });
    expect(
      await repo.releaseHold(LISTING_ID, {
        buyerHumanId: OTHER_BUYER_ID,
        heldUntil: newer,
      }),
    ).toEqual({ released: false });
    expect(await listingStatus(pool!)).toBe("HELD");
    expect(await holdRows(pool!)).toEqual([
      { buyerHumanId: BUYER_ID, heldUntil: newer.toISOString() },
    ]);

    // The matching release frees it, once.
    expect(
      await repo.releaseHold(LISTING_ID, {
        buyerHumanId: BUYER_ID,
        heldUntil: newer,
      }),
    ).toEqual({ released: true, listingStatus: "ACTIVE" });
    expect(await listingStatus(pool!)).toBe("ACTIVE");
    expect(await holdRows(pool!)).toEqual([]);
    expect(
      await repo.releaseHold(LISTING_ID, {
        buyerHumanId: BUYER_ID,
        heldUntil: newer,
      }),
    ).toEqual({ released: false });
  });

  test("releaseHold on a listing cancelled with its event matches nothing and does not revive it", async () => {
    expect(await holdListing()).toEqual({ ok: true });
    await cancelEventTx();

    expect(
      await makeResaleListingsRepo(prisma!).releaseHold(LISTING_ID, {
        buyerHumanId: BUYER_ID,
        heldUntil: HELD_UNTIL,
      }),
    ).toEqual({ released: false });
    expect(await listingStatus(pool!)).toBe("CANCELLED");
  });

  test("cancelOpenForEvent commits first → the link transaction blocks, then lockHold is false and the link rolls back", async () => {
    expect(await holdListing()).toEqual({ ok: true });

    const cancelApplied = deferred();
    const releaseCancel = deferred();
    const cancelTx = cancelEventTx({
      applied: cancelApplied.resolve,
      release: releaseCancel.promise,
    });
    await cancelApplied.promise;

    const link = linkTx("pi_g3").then(
      (v) => ({ ok: true as const, v }),
      (e: Error) => ({ ok: false as const, message: e.message }),
    );
    // The order CAS took the order row; lockHold must now WAIT on the
    // ticket row the cancel holds (tickets first, then listings). Observed in
    // pg_locks, not inferred from a sleep (a slow first query on a fresh
    // connection reads as "blocked").
    expect(await waitForBlockedQuery(pool!, `FROM "Ticket"`)).toBe(true);

    releaseCancel.resolve();
    expect((await cancelTx).cancelledListingIds).toEqual([LISTING_ID]);
    expect(await link).toEqual({
      ok: false,
      message: "resale_listing_hold_lost",
    });

    // The link rolled back: no PI on the order, listing stays CANCELLED.
    expect(await orderRow(pool!)).toEqual({
      status: "PENDING",
      stripePaymentIntentId: null,
    });
    expect(await listingStatus(pool!)).toBe("CANCELLED");
  });

  test("the link commits first → cancelOpenForEvent blocks on the listing row, then cancels it (the stranded-order phase settles the linked order)", async () => {
    expect(await holdListing()).toEqual({ ok: true });

    const linkApplied = deferred();
    const releaseLink = deferred();
    const link = prisma!.$transaction(
      async (tx) => {
        const linked = await makeOrdersRepo(tx).linkPaymentIntentIfPending(
          RESALE_ORDER_ID,
          "pi_first",
        );
        const held = await makeResaleListingsRepo(tx).lockHold(LISTING_ID, {
          buyerHumanId: BUYER_ID,
          heldUntil: HELD_UNTIL,
        });
        linkApplied.resolve();
        await releaseLink.promise;
        return { linked, held };
      },
      { maxWait: 10_000, timeout: 20_000 },
    );
    await linkApplied.promise;

    const cancel = cancelEventTx();
    // The cancel waits on the ticket row lockHold locked (its first lock).
    expect(await waitForBlockedUpdate(pool!, "Ticket")).toBe(true);

    releaseLink.resolve();
    expect(await link).toEqual({ linked: true, held: true });
    expect((await cancel).cancelledListingIds).toEqual([LISTING_ID]);
    expect(await orderRow(pool!)).toEqual({
      status: "PENDING",
      stripePaymentIntentId: "pi_first",
    });
    expect(await listingStatus(pool!)).toBe("CANCELLED");
  });

  test("a hold racing an event cancel waits on the listing row, then refuses — never HELD over CANCELLED", async () => {
    const cancelApplied = deferred();
    const releaseCancel = deferred();
    const cancelTx = cancelEventTx({
      applied: cancelApplied.resolve,
      release: releaseCancel.promise,
    });
    await cancelApplied.promise;

    // The checkout's hold, in its own transaction as in createResaleCheckout.
    const held = prisma!.$transaction(
      (tx) =>
        makeResaleListingsRepo(tx).hold(LISTING_ID, BUYER_ID, HELD_UNTIL),
      { maxWait: 10_000, timeout: 20_000 },
    );
    expect(await waitForBlockedUpdate(pool!, "Listing")).toBe(true);

    releaseCancel.resolve();
    expect((await cancelTx).cancelledListingIds).toEqual([LISTING_ID]);
    expect(await held).toEqual({ ok: false });
    expect(await listingStatus(pool!)).toBe("CANCELLED");
    expect(await holdRows(pool!)).toEqual([]);
  });

  // ── G1: cancellers release; the stale-hold sweep is the backstop ─────────

  test("a canceller's fenced release, read off the order item's meta, puts the listing back on sale with the cancel", async () => {
    expect(await holdListing()).toEqual({ ok: true });
    await seedResaleItem(pool!);

    expect(await cancellerTx()).toEqual({ cancelled: true, released: true });
    expect(await orderRow(pool!)).toMatchObject({ status: "CANCELLED" });
    expect(await listingStatus(pool!)).toBe("ACTIVE");
    expect(await holdRows(pool!)).toEqual([]);
    // Back on sale: the next buyer can hold it.
    expect(await holdListing(OTHER_BUYER_ID)).toEqual({ ok: true });
  });

  test("a canceller whose CAS loses (the order finalized) releases nothing", async () => {
    expect(await holdListing()).toEqual({ ok: true });
    await seedResaleItem(pool!);
    expect(await finalizeTx()).toEqual({ ok: true });

    expect(await cancellerTx()).toEqual({ cancelled: false, released: false });
    expect(await listingStatus(pool!)).toBe("SOLD");
  });

  test("sweep: an expired hold whose order is CANCELLED is released; with a PENDING order it is kept", async () => {
    expect(await holdListing()).toEqual({ ok: true });
    await seedResaleItem(pool!);

    expect(await sweepTx()).toBe("kept_live");
    expect(await listingStatus(pool!)).toBe("HELD");

    await pool!.query(`UPDATE "Order" SET status = 'CANCELLED' WHERE id = $1`, [
      RESALE_ORDER_ID,
    ]);
    expect(await sweepTx()).toBe("released");
    expect(await listingStatus(pool!)).toBe("ACTIVE");
    expect(await holdRows(pool!)).toEqual([]);
  });

  test("sweep: the live-order read finds the order by meta when the item column was cleared", async () => {
    expect(await holdListing()).toEqual({ ok: true });
    await seedResaleItem(pool!, { column: false });

    expect(await sweepTx()).toBe("kept_live");
    expect(await listingStatus(pool!)).toBe("HELD");
  });

  test("sweep holds the ticket + listing locks → a finalize blocks on the ticket; the sweep saw PENDING and kept the hold; finalize then sells", async () => {
    expect(await holdListing()).toEqual({ ok: true });
    await seedResaleItem(pool!);

    const locked = deferred();
    const releaseSweep = deferred();
    const sweep = sweepTx(undefined, {
      applied: locked.resolve,
      release: releaseSweep.promise,
    });
    await locked.promise;

    const finalize = finalizeTx();
    // finalize's commit waits on the ticket row the sweep locked first.
    expect(await waitForBlockedUpdate(pool!, "Ticket")).toBe(true);

    releaseSweep.resolve();
    // The order was still PENDING (finalize uncommitted) when the sweep read
    // it under the lock: live, so nothing was released.
    expect(await sweep).toBe("kept_live");
    expect(await finalize).toEqual({ ok: true });
    expect(await listingStatus(pool!)).toBe("SOLD");
    expect(await orderRow(pool!)).toMatchObject({ status: "SUCCEEDED" });
  });

  test("finalize holds the ticket + listing → the sweep's lockHold blocks, then finds the listing SOLD and does nothing", async () => {
    expect(await holdListing()).toEqual({ ok: true });
    await seedResaleItem(pool!);

    const applied = deferred();
    const releaseFinalize = deferred();
    const finalize = prisma!.$transaction(
      async (tx) => {
        await makeOrdersRepo(tx).markSucceededIfOpen(RESALE_ORDER_ID);
        const r = await makeResaleListingsRepo(tx).commit(
          LISTING_ID,
          BUYER_ID,
          RESALE_ORDER_ID,
        );
        applied.resolve();
        await releaseFinalize.promise;
        return r.ok;
      },
      { maxWait: 10_000, timeout: 20_000 },
    );
    await applied.promise;

    const sweep = sweepTx();
    // lockHold's ticket lock waits on the ticket row finalize's commit wrote.
    expect(await waitForBlockedQuery(pool!, `FROM "Ticket"`)).toBe(true);

    releaseFinalize.resolve();
    expect(await finalize).toBe(true);
    expect(await sweep).toBe("gone");
    expect(await listingStatus(pool!)).toBe("SOLD");
  });

  test("sweep holds the ticket + listing locks → a link blocks in lockHold, then links; the sweep kept the hold", async () => {
    expect(await holdListing()).toEqual({ ok: true });
    await seedResaleItem(pool!);

    const locked = deferred();
    const releaseSweep = deferred();
    const sweep = sweepTx(undefined, {
      applied: locked.resolve,
      release: releaseSweep.promise,
    });
    await locked.promise;

    const link = linkTx("pi_vs_sweep");
    expect(await waitForBlockedQuery(pool!, `FROM "Ticket"`)).toBe(true);

    releaseSweep.resolve();
    expect(await sweep).toBe("kept_live");
    expect(await link).toBe("linked");
    expect(await listingStatus(pool!)).toBe("HELD");
  });

  test("free-running race, sweep vs finalize: never a deadlock, never released under a paid order", async () => {
    for (let i = 0; i < 25; i++) {
      await pool!.query(
        `TRUNCATE ${TABLES.map((t) => `"${t}"`).join(", ")} CASCADE`,
      );
      await seedFixtures(pool!);
      expect(await holdListing()).toEqual({ ok: true });
      await seedResaleItem(pool!);

      const [sweep, finalize] = await Promise.allSettled([sweepTx(), finalizeTx()]);

      expect(finalize.status).toBe("fulfilled");
      expect(sweep.status).toBe("fulfilled");
      expect((finalize as PromiseFulfilledResult<unknown>).value).toEqual({ ok: true });
      expect(["kept_live", "gone"]).toContain(
        (sweep as PromiseFulfilledResult<string>).value,
      );
      expect(await listingStatus(pool!)).toBe("SOLD");
    }
  }, 120_000);

  test("free-running race, sweep vs canceller: never a deadlock; the listing ends ACTIVE, released exactly once", async () => {
    for (let i = 0; i < 25; i++) {
      await pool!.query(
        `TRUNCATE ${TABLES.map((t) => `"${t}"`).join(", ")} CASCADE`,
      );
      await seedFixtures(pool!);
      expect(await holdListing()).toEqual({ ok: true });
      await seedResaleItem(pool!);

      const [sweep, canceller] = await Promise.allSettled([
        sweepTx(),
        cancellerTx(),
      ]);

      expect(sweep.status).toBe("fulfilled");
      expect(canceller.status).toBe("fulfilled");
      const sweepOutcome = (sweep as PromiseFulfilledResult<string>).value;
      const cancel = (
        canceller as PromiseFulfilledResult<{ cancelled: boolean; released: boolean }>
      ).value;
      expect(cancel.cancelled).toBe(true);
      // Exactly one of them released it.
      expect(
        Number(sweepOutcome === "released") + Number(cancel.released),
      ).toBe(1);
      expect(await listingStatus(pool!)).toBe("ACTIVE");
      expect(await holdRows(pool!)).toEqual([]);
    }
  }, 120_000);

  // ── Fix round 1: where a released listing goes ─────────────────────────

  test("release target: a REFUNDED ticket → listing CANCELLED, ticket left REFUNDED, pointers cleared", async () => {
    expect(await holdListing()).toEqual({ ok: true });
    await seedResaleItem(pool!);
    await pool!.query(`UPDATE "Ticket" SET status = 'REFUNDED' WHERE id = $1`, [TICKET_ID]);

    expect(await cancellerTx()).toEqual({ cancelled: true, released: true });
    expect(await listingStatus(pool!)).toBe("CANCELLED");
    expect(await ticketStatus(pool!)).toBe("REFUNDED");
    expect(await holdRows(pool!)).toEqual([]);
    expect(await itemPointer(pool!, RESALE_ITEM_ID)).toBeNull();
    // Never back on sale: the next buyer cannot hold it.
    expect(await holdListing(OTHER_BUYER_ID)).toEqual({ ok: false });
  });

  test("release target: the seller's original item refunded → CANCELLED, ticket untouched", async () => {
    expect(await holdListing()).toEqual({ ok: true });
    await seedResaleItem(pool!);
    await seedSellerItem(pool!, { refunded: true });

    const r = await makeResaleListingsRepo(prisma!).releaseHold(LISTING_ID, {
      buyerHumanId: BUYER_ID,
      heldUntil: HELD_UNTIL,
    });
    expect(r).toEqual({
      released: true,
      listingStatus: "CANCELLED",
      reason: "original_item_refunded",
    });
    expect(await ticketStatus(pool!)).toBe("LISTED");
  });

  test("release target: a CANCELLED event → listing CANCELLED with the ticket back to VALID", async () => {
    expect(await holdListing()).toEqual({ ok: true });
    await seedResaleItem(pool!);
    // An event cancelled before `cancelOpenForEvent` closed its listings.
    await pool!.query(`UPDATE "Event" SET status = 'CANCELLED' WHERE id = $1`, [EVENT_ID]);

    const r = await makeResaleListingsRepo(prisma!).releaseHold(LISTING_ID, {
      buyerHumanId: BUYER_ID,
      heldUntil: HELD_UNTIL,
    });
    expect(r).toEqual({
      released: true,
      listingStatus: "CANCELLED",
      reason: "event_cancelled",
    });
    expect(await listingStatus(pool!)).toBe("CANCELLED");
    expect(await ticketStatus(pool!)).toBe("VALID");
    expect(await itemPointer(pool!, RESALE_ITEM_ID)).toBeNull();
  });

  test("release target: past expiresAt → EXPIRED in the release transaction, ticket VALID, seller item unlinked", async () => {
    expect(await holdListing()).toEqual({ ok: true });
    await seedSellerItem(pool!, { refunded: false, linked: true });
    const expiresAt = new Date("2030-03-01T00:00:00.000Z");
    await pool!.query(`UPDATE "Listing" SET "expiresAt" = $2 WHERE id = $1`, [
      LISTING_ID,
      expiresAt,
    ]);

    const r = await makeResaleListingsRepo(prisma!).releaseHold(
      LISTING_ID,
      { buyerHumanId: BUYER_ID, heldUntil: HELD_UNTIL },
      { now: new Date("2030-03-02T00:00:00.000Z") },
    );
    expect(r).toEqual({
      released: true,
      listingStatus: "EXPIRED",
      reason: "listing_expired",
    });
    expect(await listingStatus(pool!)).toBe("EXPIRED");
    expect(await ticketStatus(pool!)).toBe("VALID");
    expect(await itemPointer(pool!, SELLER_ITEM_ID)).toBeNull();
    // Atomically closed: there is no ACTIVE window a buyer could hold it in.
    expect(await holdListing(OTHER_BUYER_ID)).toEqual({ ok: false });
  });

  // ── Fix round 1: the REAL use-case code over the real repos ────────────

  test("real expireResaleListings: a stale hold whose order is CANCELLED is released and audited; a PENDING one is kept", async () => {
    const repos = createPrismaRepos(prisma!);
    const clock = { now: () => new Date(HELD_UNTIL.getTime() + 2 * 3600_000) };
    expect(await holdListing()).toEqual({ ok: true });
    await seedResaleItem(pool!);

    const kept = await expireResaleListings({ repos, clock });
    expect(kept).toMatchObject({ releasedHoldCount: 0, keptLiveHoldCount: 1 });
    expect(await listingStatus(pool!)).toBe("HELD");

    await pool!.query(`UPDATE "Order" SET status = 'CANCELLED' WHERE id = $1`, [
      RESALE_ORDER_ID,
    ]);
    const swept = await expireResaleListings({ repos, clock });
    expect(swept).toMatchObject({ releasedHoldCount: 1, closedOnReleaseCount: 0 });
    expect(await listingStatus(pool!)).toBe("ACTIVE");
    const audit = await pool!.query<{ action: string }>(
      `SELECT action FROM "AuditLog" WHERE "entityId" = $1`,
      [LISTING_ID],
    );
    expect(audit.rows.map((r) => r.action)).toEqual([
      "resale_listing_stale_hold_released",
    ]);
  });

  test("real expireResaleListings: a stale hold on an expired listing goes straight to EXPIRED (never ACTIVE in between)", async () => {
    const repos = createPrismaRepos(prisma!);
    const clock = { now: () => new Date(HELD_UNTIL.getTime() + 2 * 3600_000) };
    expect(await holdListing()).toEqual({ ok: true });
    await seedResaleItem(pool!);
    await pool!.query(`UPDATE "Order" SET status = 'CANCELLED' WHERE id = $1`, [
      RESALE_ORDER_ID,
    ]);
    await pool!.query(`UPDATE "Listing" SET "expiresAt" = $2 WHERE id = $1`, [
      LISTING_ID,
      new Date(HELD_UNTIL.getTime() + 3600_000),
    ]);

    const r = await expireResaleListings({ repos, clock });
    expect(r).toMatchObject({ releasedHoldCount: 1, closedOnReleaseCount: 1, expiredCount: 0 });
    expect(await listingStatus(pool!)).toBe("EXPIRED");
    expect(await ticketStatus(pool!)).toBe("VALID");
  });

  test("real releaseRetiredCartHolds in repos.tx: cancels the resale order and releases its listing; a refunded ticket closes it", async () => {
    const repos = createPrismaRepos(prisma!);
    expect(await holdListing()).toEqual({ ok: true });
    await seedResaleItem(pool!);
    await pool!.query(`UPDATE "Order" SET source = 'RESALE' WHERE id = $1`, [
      RESALE_ORDER_ID,
    ]);

    const cancelled = await repos.tx((tx) =>
      releaseRetiredCartHolds(tx, RESALE_ORDER_ID, {
        expectedPaymentIntentId: null,
        now: new Date("2030-03-10T12:00:00.000Z"),
      }),
    );
    expect(cancelled).toBe(true);
    expect(await orderRow(pool!)).toMatchObject({ status: "CANCELLED" });
    expect(await listingStatus(pool!)).toBe("ACTIVE");
    expect(await holdRows(pool!)).toEqual([]);

    // Second round: the next buyer's attempt, then a refund voids the pass.
    await pool!.query(`UPDATE "Order" SET status = 'PENDING' WHERE id = $1`, [
      RESALE_ORDER_ID,
    ]);
    expect(await holdListing()).toEqual({ ok: true });
    await pool!.query(`UPDATE "Ticket" SET status = 'REFUNDED' WHERE id = $1`, [TICKET_ID]);
    expect(
      await repos.tx((tx) =>
        releaseRetiredCartHolds(tx, RESALE_ORDER_ID, { expectedPaymentIntentId: null }),
      ),
    ).toBe(true);
    expect(await listingStatus(pool!)).toBe("CANCELLED");
    expect(await ticketStatus(pool!)).toBe("REFUNDED");
  });

  test("real expireResaleListings vs a finalize holding the ticket + listing: the sweep waits on the ticket, then finds SOLD", async () => {
    const repos = createPrismaRepos(prisma!);
    const clock = { now: () => new Date(HELD_UNTIL.getTime() + 2 * 3600_000) };
    expect(await holdListing()).toEqual({ ok: true });
    await seedResaleItem(pool!);

    const applied = deferred();
    const releaseFinalize = deferred();
    const finalize = prisma!.$transaction(
      async (tx) => {
        await makeOrdersRepo(tx).markSucceededIfOpen(RESALE_ORDER_ID);
        const r = await makeResaleListingsRepo(tx).commit(
          LISTING_ID,
          BUYER_ID,
          RESALE_ORDER_ID,
        );
        applied.resolve();
        await releaseFinalize.promise;
        return r.ok;
      },
      { maxWait: 10_000, timeout: 20_000 },
    );
    await applied.promise;

    const sweep = expireResaleListings({ repos, clock });
    expect(await waitForBlockedQuery(pool!, `FROM "Ticket"`)).toBe(true);

    releaseFinalize.resolve();
    expect(await finalize).toBe(true);
    expect(await sweep).toMatchObject({
      releasedHoldCount: 0,
      keptLiveHoldCount: 0,
      failedHoldCount: 0,
    });
    expect(await listingStatus(pool!)).toBe("SOLD");
  });

  test("triggers ON (FK enforcement and key-share locks): sweep vs finalize, free-running, never a deadlock, never released under a paid order", async () => {
    await pool!.query(
      `INSERT INTO "Human" (id, "updatedAt") VALUES ($1, now()), ($2, now()), ($3, now())
       ON CONFLICT DO NOTHING`,
      [SELLER_ID, BUYER_ID, OTHER_BUYER_ID],
    );
    try {
      for (let i = 0; i < 10; i++) {
        for (const table of TABLES) {
          await pool!.query(`ALTER TABLE "${table}" DISABLE TRIGGER ALL`);
        }
        await pool!.query(
          `TRUNCATE ${TABLES.map((t) => `"${t}"`).join(", ")} CASCADE`,
        );
        await seedFixtures(pool!);
        await seedResaleItem(pool!);
        // Fixtures in place (they skip the Org/Order graph); from here every
        // write the race makes is FK-checked, with its key-share locks.
        for (const table of TABLES) {
          await pool!.query(`ALTER TABLE "${table}" ENABLE TRIGGER ALL`);
        }
        expect(await holdListing()).toEqual({ ok: true });

        const [sweep, finalize] = await Promise.allSettled([sweepTx(), finalizeTx()]);
        expect(finalize.status).toBe("fulfilled");
        expect(sweep.status).toBe("fulfilled");
        expect(["kept_live", "gone"]).toContain(
          (sweep as PromiseFulfilledResult<string>).value,
        );
        expect(await listingStatus(pool!)).toBe("SOLD");
      }
    } finally {
      for (const table of TABLES) {
        await pool!.query(`ALTER TABLE "${table}" DISABLE TRIGGER ALL`);
      }
    }
  }, 120_000);

  test("free-running race: never a deadlock, and a PI stays linked only if the link saw the hold", async () => {
    for (let i = 0; i < 25; i++) {
      await pool!.query(
        `TRUNCATE ${TABLES.map((t) => `"${t}"`).join(", ")} CASCADE`,
      );
      await seedFixtures(pool!);
      expect(await holdListing()).toEqual({ ok: true });

      const [link, cancel] = await Promise.allSettled([
        linkTx(`pi_race_${i}`),
        cancelEventTx(),
      ]);

      // The cancel always lands (no deadlock victim).
      expect(cancel.status).toBe("fulfilled");
      expect(await listingStatus(pool!)).toBe("CANCELLED");
      const order = await orderRow(pool!);
      if (link.status === "fulfilled") {
        expect(link.value).toBe("linked");
        expect(order!.stripePaymentIntentId).toBe(`pi_race_${i}`);
      } else {
        expect((link.reason as Error).message).toBe("resale_listing_hold_lost");
        expect(order!.stripePaymentIntentId).toBeNull();
      }
    }
  }, 120_000);

  // ── Fix round 2: the link re-checks the pass under the ticket lock ───────

  test.each([
    { name: "pass voided", ticketFirst: true },
    { name: "item refunded only", ticketFirst: false },
  ])(
    "a refund that committed between the checkout read and the link ($name): the link rolls back, and the unwind's release closes the listing",
    async ({ ticketFirst }) => {
      expect(await holdListing()).toEqual({ ok: true });
      await seedResaleItem(pool!);
      await seedSellerItem(pool!, { refunded: !ticketFirst, linked: true });
      if (ticketFirst) await refundTx();

      const lost = await linkTx("pi_after_refund");
      expect(lost).toBe(ticketFirst ? "ticket_not_listed" : "original_item_refunded");
      // Rolled back: no PI on the order, so no client secret was issued.
      expect(await orderRow(pool!)).toMatchObject({
        status: "PENDING",
        stripePaymentIntentId: null,
      });

      // The unwind: cancel the order, then the fenced release.
      await pool!.query(`UPDATE "Order" SET status = 'CANCELLED' WHERE id = $1`, [
        RESALE_ORDER_ID,
      ]);
      const released = await prisma!.$transaction((tx) =>
        makeResaleListingsRepo(tx).releaseHold(LISTING_ID, {
          buyerHumanId: BUYER_ID,
          heldUntil: HELD_UNTIL,
        }),
      );
      expect(released).toEqual({
        released: true,
        listingStatus: "CANCELLED",
        reason: ticketFirst ? "ticket_not_listed" : "original_item_refunded",
      });
      expect(await listingStatus(pool!)).toBe("CANCELLED");
      expect(await ticketStatus(pool!)).toBe(ticketFirst ? "REFUNDED" : "LISTED");
    },
  );

  test("the link holds the ticket lock → a refund (ticket first) waits, so the link's re-check cannot be overtaken", async () => {
    expect(await holdListing()).toEqual({ ok: true });
    await seedResaleItem(pool!);
    await seedSellerItem(pool!, { refunded: false, linked: true });

    const locked = deferred();
    const releaseLink = deferred();
    const link = linkTx("pi_before_refund", undefined, {
      applied: locked.resolve,
      release: releaseLink.promise,
    });
    await locked.promise;

    const refund = refundTx();
    expect(await waitForBlockedUpdate(pool!, "Ticket")).toBe(true);

    releaseLink.resolve();
    expect(await link).toBe("linked");
    await refund;
    // The secret is out; finalize's RESALE_ORIGINAL_ITEM_REFUNDED guard is
    // the backstop for this window (decision record, "Not covered").
    expect(await ticketStatus(pool!)).toBe("REFUNDED");
  });

  // ── Fix round 2: reconcile lock order vs releaseHold's closing branches ──

  const expiredRelease = () =>
    prisma!.$transaction(
      (tx) =>
        makeResaleListingsRepo(tx).releaseHold(
          LISTING_ID,
          { buyerHumanId: BUYER_ID, heldUntil: HELD_UNTIL },
          { now: new Date() },
        ),
      { maxWait: 10_000, timeout: 20_000 },
    );

  test("refund in reconcile's order (ticket, then item) vs releaseHold's EXPIRED branch (ticket, listing, item): the release waits, never a deadlock", async () => {
    expect(await holdListing()).toEqual({ ok: true });
    await seedSellerItem(pool!, { refunded: false, linked: true });
    await pool!.query(`UPDATE "Listing" SET "expiresAt" = $2 WHERE id = $1`, [
      LISTING_ID,
      new Date(Date.now() - 60_000),
    ]);

    const first = deferred();
    const releaseRefund = deferred();
    const refund = refundTx({
      afterFirst: { applied: first.resolve, release: releaseRefund.promise },
    });
    await first.promise;

    const release = expiredRelease();
    expect(await waitForBlockedQuery(pool!, `FROM "Ticket"`)).toBe(true);

    releaseRefund.resolve();
    await refund;
    // Saw the voided pass under the lock: closed, ticket left REFUNDED.
    expect(await release).toEqual({
      released: true,
      listingStatus: "CANCELLED",
      reason: "ticket_not_listed",
    });
    expect(await ticketStatus(pool!)).toBe("REFUNDED");
  });

  test("the order reconcile had before (item, then ticket) deadlocks against the same release: why it moved", async () => {
    expect(await holdListing()).toEqual({ ok: true });
    await seedSellerItem(pool!, { refunded: false, linked: true });
    await pool!.query(`UPDATE "Listing" SET "expiresAt" = $2 WHERE id = $1`, [
      LISTING_ID,
      new Date(Date.now() - 60_000),
    ]);

    const first = deferred();
    const releaseRefund = deferred();
    const refund = refundTx({
      itemFirst: true,
      afterFirst: { applied: first.resolve, release: releaseRefund.promise },
    });
    await first.promise;

    const release = expiredRelease();
    // Ticket and listing taken; the EXPIRED branch's pointer write waits on
    // the item row the refund holds.
    expect(await waitForBlockedUpdate(pool!, "OrderItem")).toBe(true);

    releaseRefund.resolve();
    const results = await Promise.allSettled([refund, release]);
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(String((rejected[0] as PromiseRejectedResult).reason)).toMatch(
      /deadlock|40P01/i,
    );
  });
});

/**
 * Polls pg_locks until some backend is waiting on a lock while running an
 * UPDATE of `table`. False after `timeoutMs` with nobody waiting.
 */
async function waitForBlockedUpdate(
  pool: pg.Pool,
  table: string,
  timeoutMs = 5_000,
): Promise<boolean> {
  return waitForBlockedQuery(pool, `UPDATE "public"."${table}"`, timeoutMs);
}

/** As `waitForBlockedUpdate`, for any query text containing `needle`. */
async function waitForBlockedQuery(
  pool: pg.Pool,
  needle: string,
  timeoutMs = 5_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await pool.query<{ query: string }>(
      `SELECT a.query
         FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE NOT l.granted`,
    );
    if (rows.rows.some((r) => r.query.includes(needle))) {
      return true;
    }
    await sleep(25);
  }
  return false;
}

// ── Fixtures ────────────────────────────────────────────────────────────────

async function seedFixtures(pool: pg.Pool): Promise<void> {
  const now = new Date();
  await pool.query(
    `INSERT INTO "Event" (id, title, status, "startsAt", "endsAt", "updatedAt")
     VALUES ($1, 'Show', 'PUBLISHED', $2, $3, $4)`,
    [EVENT_ID, new Date("2030-04-01T19:00:00Z"), new Date("2030-04-01T23:00:00Z"), now],
  );
  await pool.query(
    `INSERT INTO "Ticket" (id, "eventId", "orderId", "orderItemId", "ownerHumanId", code, status, "updatedAt")
     VALUES ($1, $2, $3, NULL, $4, $5, 'LISTED', $6)`,
    [TICKET_ID, EVENT_ID, PRIMARY_ORDER_ID, SELLER_ID, `code-${TICKET_ID}`, now],
  );
  await pool.query(
    `INSERT INTO "Listing" (id, "ticketId", "eventId", "sellerHumanId", "askPriceCents", status, "updatedAt")
     VALUES ($1, $2, $3, $4, 5000, 'ACTIVE', $5)`,
    [LISTING_ID, TICKET_ID, EVENT_ID, SELLER_ID, now],
  );
  await pool.query(
    `INSERT INTO "Order" (id, status, "buyerHumanId", "amountGrossCents", "feePolicySnapshot", "updatedAt")
     VALUES ($1, 'PENDING', $2, 5000, '{}'::jsonb, $3)`,
    [RESALE_ORDER_ID, BUYER_ID, now],
  );
}

/** The resale order's ticket line, as `createResaleCheckout` writes it. */
async function seedResaleItem(
  pool: pg.Pool,
  opts: { column?: boolean } = {},
): Promise<void> {
  await pool.query(
    `INSERT INTO "OrderItem" (id, "orderId", kind, "unitPriceCents", "amountCents", "resaleListingId", meta)
     VALUES ($1, $2, 'ticket', 5000, 5000, $3, $4::jsonb)`,
    [
      RESALE_ITEM_ID,
      RESALE_ORDER_ID,
      opts.column === false ? null : LISTING_ID,
      JSON.stringify({
        holdExpiresAt: HELD_UNTIL.toISOString(),
        resaleListingId: LISTING_ID,
      }),
    ],
  );
}

/** The seller's original line, as `ticket.orderItemId` points at it. */
async function seedSellerItem(
  pool: pg.Pool,
  opts: { refunded: boolean; linked?: boolean },
): Promise<void> {
  await pool.query(
    `INSERT INTO "OrderItem" (id, "orderId", kind, "unitPriceCents", "amountCents", status, "refundedAt", "resaleListingId")
     VALUES ($1, $2, 'ticket', 5000, 5000, $3, $4, $5)`,
    [
      SELLER_ITEM_ID,
      PRIMARY_ORDER_ID,
      opts.refunded ? "refunded" : "active",
      opts.refunded ? new Date() : null,
      opts.linked ? LISTING_ID : null,
    ],
  );
  await pool.query(`UPDATE "Ticket" SET "orderItemId" = $2 WHERE id = $1`, [
    TICKET_ID,
    SELLER_ITEM_ID,
  ]);
}

async function ticketStatus(pool: pg.Pool): Promise<string> {
  const rows = await pool.query<{ status: string }>(
    `SELECT status FROM "Ticket" WHERE id = $1`,
    [TICKET_ID],
  );
  return rows.rows[0]!.status;
}

async function itemPointer(pool: pg.Pool, itemId: string): Promise<string | null> {
  const rows = await pool.query<{ resaleListingId: string | null }>(
    `SELECT "resaleListingId" FROM "OrderItem" WHERE id = $1`,
    [itemId],
  );
  return rows.rows[0]!.resaleListingId;
}

async function listingStatus(pool: pg.Pool): Promise<string> {
  const rows = await pool.query<{ status: string }>(
    `SELECT status FROM "Listing" WHERE id = $1`,
    [LISTING_ID],
  );
  return rows.rows[0]!.status;
}

async function holdRows(
  pool: pg.Pool,
): Promise<Array<{ buyerHumanId: string; heldUntil: string }>> {
  // Rendered in SQL so the assertion does not depend on node-pg's parsing
  // of a zone-less timestamp.
  const rows = await pool.query<{ buyerHumanId: string; heldUntil: string }>(
    `SELECT "buyerHumanId",
            to_char("heldUntil", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "heldUntil"
       FROM "ListingHold" WHERE "listingId" = $1`,
    [LISTING_ID],
  );
  return rows.rows;
}

async function orderRow(
  pool: pg.Pool,
): Promise<{ status: string; stripePaymentIntentId: string | null } | undefined> {
  const rows = await pool.query<{
    status: string;
    stripePaymentIntentId: string | null;
  }>(`SELECT status, "stripePaymentIntentId" FROM "Order" WHERE id = $1`, [
    RESALE_ORDER_ID,
  ]);
  return rows.rows[0];
}
