import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { makeAnalyticsRepo } from "../../src/db/prisma/analytics";

/**
 * `getTicketSalesRollup` against a REAL Postgres with the real migrations.
 *
 * This exists because the query it covers is the sole basis for event revenue
 * in `compute-event-daily-stats`, and every correctness claim in its comment
 * block is a decision about which rows count:
 *
 *   * resale must not double-count a seat (the seller's line goes
 *     `transferred` while the buyer gets a NEW `ticket` line at ask price),
 *   * a partially-refunded order must keep its still-valid tickets,
 *   * order-level `discount` lines must not be summed as ticket revenue,
 *   * a deleted tier's sales must survive as a null-keyed row (ON DELETE SET
 *     NULL), not vanish,
 *   * and none of it may leak across events.
 *
 * The core unit tests mock this repo, so they assert only that the use case
 * adds up numbers someone handed it. Every one of the above is invisible to
 * them by construction. Drop `AND o.source <> 'RESALE'` and the whole unit
 * suite still passes while event revenue inflates by the entire secondary
 * market.
 */

const EVENT_STARTS_AT = new Date("2027-06-01T20:00:00.000Z");
const EVENT_ENDS_AT = new Date("2027-06-02T02:00:00.000Z");

/** Orders require a snapshot blob; its contents are irrelevant here. */
const FEE_SNAPSHOT = { feeMode: "ABSORB", computedAt: "2027-01-01T00:00:00Z" };

describe("getTicketSalesRollup (integration)", () => {
  let pg: PostgresTestContainer;
  let pool: Pool;
  let prisma: PrismaClient;
  // Set when the integration environment fails to come up, so the canary
  // below reports THAT instead of a bare ReferenceError. Mirrors the 36
  // sibling suites; this file and storage-gc-queries were the two that
  // got the canary without the variable it asserts on.
  let runtimeError: Error | null = null;

  let eventId: string;
  let otherEventId: string;
  let gaId: string;
  let vipId: string;
  let buyerHumanId: string;

  const makeOrder = async (data: {
    eventId: string;
    status: string;
    source?: string;
    kind?: string;
    amountGrossCents: number;
  }) =>
    prisma.order.create({
      data: {
        eventId: data.eventId,
        buyerHumanId,
        amountGrossCents: data.amountGrossCents,
        status: data.status as never,
        source: (data.source ?? "PRIMARY") as never,
        kind: (data.kind ?? "TICKETING") as never,
        feePolicySnapshot: FEE_SNAPSHOT,
      },
    });

  const makeItem = async (data: {
    orderId: string;
    ticketTypeId?: string | null;
    kind?: string;
    status?: string;
    unitPriceCents: number;
    qty?: number;
  }) =>
    prisma.orderItem.create({
      data: {
        orderId: data.orderId,
        ticketTypeId: data.ticketTypeId ?? null,
        kind: data.kind ?? "ticket",
        status: data.status ?? "active",
        qty: data.qty ?? 1,
        unitPriceCents: data.unitPriceCents,
        amountCents: data.unitPriceCents * (data.qty ?? 1),
      },
    });

  beforeAll(async () => {
    try {
      pg = await startPostgresContainer();
      await runPrismaMigrateDeploy(pg.databaseUrl);

      process.env.DATABASE_URL = pg.databaseUrl;
      // Driver-adapter ("client" engine) mode — a bare `new PrismaClient()`
      // throws. Constructed the way packages/db/src/index.ts does.
      pool = new Pool({ connectionString: pg.databaseUrl });
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

      const buyer = await prisma.human.create({
        data: { name: "Rollup Buyer", status: "ACTIVE" },
      });
      buyerHumanId = buyer.id;

      const event = await prisma.event.create({
        data: {
          title: "Rollup Test Show",
          startsAt: EVENT_STARTS_AT,
          endsAt: EVENT_ENDS_AT,
          status: "PUBLISHED",
          visibility: "PUBLIC",
          countryCode: "US",
          slug: "event/us/austin/rollup-test-show-2027-06-01-2000--rol001",
          shortId: "rol001",
          publishedAt: new Date(),
        },
      });
      eventId = event.id;

      const other = await prisma.event.create({
        data: {
          title: "Unrelated Show",
          startsAt: EVENT_STARTS_AT,
          endsAt: EVENT_ENDS_AT,
          status: "PUBLISHED",
          visibility: "PUBLIC",
          countryCode: "US",
          slug: "event/us/austin/unrelated-show-2027-06-01-2000--rol002",
          shortId: "rol002",
          publishedAt: new Date(),
        },
      });
      otherEventId = other.id;

      const ga = await prisma.ticketType.create({
        data: { eventId, name: "GA", priceCents: 3000, capacity: 100 },
      });
      gaId = ga.id;

      const vip = await prisma.ticketType.create({
        data: { eventId, name: "VIP", priceCents: 10000, capacity: 10 },
      });
      vipId = vip.id;

      // ── 1. Plain paid order: 2 × GA at the price charged (2500, deliberately
      //       NOT the tier's live 3000 — this is what "snapshot" means).
      const paid = await makeOrder({
        eventId,
        status: "SUCCEEDED",
        amountGrossCents: 5000,
      });
      await makeItem({ orderId: paid.id, ticketTypeId: gaId, unitPriceCents: 2500 });
      await makeItem({ orderId: paid.id, ticketTypeId: gaId, unitPriceCents: 2500 });

      // ── 2. Partially-refunded order: 1 VIP refunded, 1 VIP still valid.
      //       The still-valid one must survive; an order-status filter of
      //       SUCCEEDED-only would drop both.
      const partial = await makeOrder({
        eventId,
        status: "PART_REFUNDED",
        amountGrossCents: 20000,
      });
      await makeItem({
        orderId: partial.id,
        ticketTypeId: vipId,
        unitPriceCents: 10000,
      });
      await makeItem({
        orderId: partial.id,
        ticketTypeId: vipId,
        unitPriceCents: 10000,
        status: "refunded",
      });

      // ── 3. A resold seat. The seller's original GA line becomes
      //       `transferred` on a PRIMARY order; the buyer's line lives on a
      //       RESALE order at a marked-up ask. Counting both would report the
      //       one seat twice and add secondary-market money to the event.
      const sellerOrder = await makeOrder({
        eventId,
        status: "SUCCEEDED",
        amountGrossCents: 2500,
      });
      await makeItem({
        orderId: sellerOrder.id,
        ticketTypeId: gaId,
        unitPriceCents: 2500,
        status: "transferred",
      });
      const resaleOrder = await makeOrder({
        eventId,
        status: "SUCCEEDED",
        source: "RESALE",
        amountGrossCents: 9000,
      });
      await makeItem({
        orderId: resaleOrder.id,
        ticketTypeId: gaId,
        unitPriceCents: 9000,
      });

      // ── 4. Promo order: a ticket plus a NEGATIVE order-level discount line.
      //       The discount must not be summed as tier revenue.
      const promo = await makeOrder({
        eventId,
        status: "SUCCEEDED",
        amountGrossCents: 1500,
      });
      await makeItem({ orderId: promo.id, ticketTypeId: gaId, unitPriceCents: 3000 });
      await makeItem({
        orderId: promo.id,
        ticketTypeId: null,
        kind: "discount",
        unitPriceCents: -1500,
      });

      // ── 5. A PENDING order — never paid, must not count at all.
      const pending = await makeOrder({
        eventId,
        status: "PENDING",
        amountGrossCents: 3000,
      });
      await makeItem({
        orderId: pending.id,
        ticketTypeId: gaId,
        unitPriceCents: 3000,
      });

      // ── 6. Sales against a tier that is then DELETED. The FK is ON DELETE SET
      //       NULL, so these survive with a null ticketTypeId.
      const doomed = await prisma.ticketType.create({
        data: { eventId, name: "Doomed Tier", priceCents: 4000, capacity: 5 },
      });
      const doomedOrder = await makeOrder({
        eventId,
        status: "SUCCEEDED",
        amountGrossCents: 4000,
      });
      await makeItem({
        orderId: doomedOrder.id,
        ticketTypeId: doomed.id,
        unitPriceCents: 4000,
      });
      await prisma.ticketType.delete({ where: { id: doomed.id } });

      // ── 7. A different event's sales, to prove partitioning.
      const otherTier = await prisma.ticketType.create({
        data: {
          eventId: otherEventId,
          name: "Other GA",
          priceCents: 7777,
          capacity: 50,
        },
      });
      const otherOrder = await makeOrder({
        eventId: otherEventId,
        status: "SUCCEEDED",
        amountGrossCents: 7777,
      });
      await makeItem({
        orderId: otherOrder.id,
        ticketTypeId: otherTier.id,
        unitPriceCents: 7777,
      });
      // Container start + `prisma migrate deploy` against the full migration
      // history. 300s matches community-blast-radius.test.ts; 180s was not
      // enough on a loaded machine.
    } catch (error) {
      runtimeError = error as Error;
    }
  }, 300_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
    await pg?.stop();
  });

  test("integration environment is up (canary — do not skip)", () => {
    expect(runtimeError).toBeNull();
    expect(prisma).toBeDefined();
  });

  test("sums the PRICE CHARGED, not the tier's live price", async () => {
    const repo = makeAnalyticsRepo(prisma);
    const rows = await repo.getTicketSalesRollup([eventId]);
    const ga = rows.find((r) => r.ticketTypeId === gaId);

    // GA lines that count: 2 × 2500 (paid) + 1 × 2500 (transferred/resold)
    // + 1 × 3000 (promo, at list). NOT the PENDING 3000, NOT the RESALE 9000.
    expect(ga).toBeDefined();
    expect(ga!.soldCount).toBe(4);
    expect(ga!.revenueCents).toBe(10_500);
    // The live tier price is 3000; 4 × 3000 = 12_000 is the wrong answer the
    // old `perTypeSold * priceCents` would have produced.
    expect(ga!.revenueCents).not.toBe(12_000);
  });

  test("does not double-count a resold seat, and ignores the resale ask", async () => {
    const repo = makeAnalyticsRepo(prisma);
    const rows = await repo.getTicketSalesRollup([eventId]);
    const ga = rows.find((r) => r.ticketTypeId === gaId)!;

    // The resold seat contributes its ORIGINAL 2500 once (as `transferred`),
    // and the 9000 resale ask contributes nothing. If `source <> 'RESALE'`
    // were dropped this would be 5 / 19_500.
    expect(ga.soldCount).toBe(4);
    expect(ga.revenueCents).toBe(10_500);
  });

  test("keeps still-valid tickets on a partially-refunded order", async () => {
    const repo = makeAnalyticsRepo(prisma);
    const rows = await repo.getTicketSalesRollup([eventId]);
    const vip = rows.find((r) => r.ticketTypeId === vipId)!;

    // Filtering orders to SUCCEEDED (as getPopularityStats does) would report
    // 0 / 0 here — both tickets on this order would disappear.
    expect(vip.soldCount).toBe(1);
    expect(vip.revenueCents).toBe(10_000);
    expect(vip.refundedCount).toBe(1);
    expect(vip.refundedCents).toBe(10_000);
  });

  test("sold and refunded are disjoint, so revenue is already net", async () => {
    const repo = makeAnalyticsRepo(prisma);
    const rows = await repo.getTicketSalesRollup([eventId]);
    const vip = rows.find((r) => r.ticketTypeId === vipId)!;

    // Pins the property `compute-event-daily-stats` relies on to build gross:
    // the refunded line is NOT also in revenueCents.
    expect(vip.revenueCents).toBe(10_000);
    expect(vip.revenueCents + vip.refundedCents).toBe(20_000);
  });

  test("excludes non-ticket lines, so a discount never becomes revenue", async () => {
    const repo = makeAnalyticsRepo(prisma);
    const rows = await repo.getTicketSalesRollup([eventId]);

    // A -1500 discount line summed in would show up as a negative-bearing
    // row or drag GA's total down to 9_000.
    expect(rows.every((r) => r.revenueCents >= 0)).toBe(true);
    expect(rows.find((r) => r.ticketTypeId === gaId)!.revenueCents).toBe(10_500);
  });

  test("keeps a deleted tier's sales as a null-keyed row", async () => {
    const repo = makeAnalyticsRepo(prisma);
    const rows = await repo.getTicketSalesRollup([eventId]);
    const orphan = rows.find((r) => r.ticketTypeId === null);

    // ON DELETE SET NULL: the money was taken and must not vanish because the
    // organizer tidied up a tier.
    expect(orphan).toBeDefined();
    expect(orphan!.soldCount).toBe(1);
    expect(orphan!.revenueCents).toBe(4_000);
  });

  test("never leaks rows across events", async () => {
    const repo = makeAnalyticsRepo(prisma);
    const rows = await repo.getTicketSalesRollup([eventId]);

    expect(rows.every((r) => r.eventId === eventId)).toBe(true);
    expect(rows.some((r) => r.revenueCents === 7_777)).toBe(false);

    const both = await repo.getTicketSalesRollup([eventId, otherEventId]);
    const other = both.filter((r) => r.eventId === otherEventId);
    expect(other).toHaveLength(1);
    expect(other[0]!.revenueCents).toBe(7_777);
  });

  test("returns [] for an empty id list without touching the database", async () => {
    const repo = makeAnalyticsRepo(prisma);
    await expect(repo.getTicketSalesRollup([])).resolves.toEqual([]);
  });
});
