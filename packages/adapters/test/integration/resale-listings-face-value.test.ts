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
 * FR-001 (docs/specs/2026-08-10/completed/time-based-ticket-pricing.spec.yaml) at the
 * ADAPTER boundary.
 *
 * `listByEventEnriched` maps `facePriceCents` in raw Prisma-land, so no core
 * unit test can reach it — `list-event-resale-listings.test.ts` mocks the whole
 * repo method and therefore only asserts pass-through. This is the one place
 * that pins the mapping itself.
 *
 * It exists specifically so that re-adding `priceCents` to the `ticketType`
 * select and restoring `row.ticket.ticketType.priceCents` FAILS. The live
 * ticket type below is deliberately priced differently from every ticket's
 * purchase snapshot, so a regression cannot hide behind matching numbers.
 */

const LIVE_TYPE_PRICE_CENTS = 9_900; // what the organizer raised it to
const SNAPSHOT_FACE_CENTS = 1_200; // frozen on the listing at list time
const PURCHASED_UNIT_CENTS = 3_400; // OrderItem.unitPriceCents

interface SeedData {
  eventId: string;
  listingWithSnapshotId: string;
  listingFromOrderItemId: string;
  listingWithNoSourceId: string;
}

describe("Prisma adapters integration – resale listing face value (FR-001)", () => {
  let pg: PostgresTestContainer | undefined;
  let pool: Pool | undefined;
  let prisma: PrismaClient | undefined;
  let seed: SeedData | undefined;
  let runtimeError: Error | null = null;

  beforeAll(async () => {
    try {
      pg = await startPostgresContainer();
      await runPrismaMigrateDeploy(pg.databaseUrl);

      process.env.DATABASE_URL = pg.databaseUrl;
      // The repo's Prisma client runs in driver-adapter ("client" engine)
      // mode, so a bare `new PrismaClient()` throws — construct it the way
      // packages/db/src/index.ts does, with a pg Pool adapter.
      pool = new Pool({ connectionString: pg.databaseUrl });
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

      seed = await seedResaleFaceValueFixtures(prisma);
    } catch (error) {
      runtimeError = error as Error;
      // eslint-disable-next-line no-console
      console.error("resale face-value integration setup failed:", error);
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

  test("proves the suite actually ran (setup did not silently skip)", () => {
    // Adapter integration tests in this repo `skip()` themselves when their
    // container/adapter setup throws, which has previously turned a broken
    // suite into a green line. This assertion has no skip guard: if the
    // container or migration failed, THIS test fails loudly and names why.
    expect(runtimeError).toBeNull();
    expect(prisma).toBeDefined();
    expect(seed).toBeDefined();
  }, 60_000);

  test("prefers the listing's own frozen faceValueCents snapshot", async ({
    skip,
  }) => {
    if (runtimeError || !prisma || !seed) {
      skip();
      return;
    }

    const repo = makeResaleListingsRepo(prisma);
    const page = await repo.listByEventEnriched({
      eventId: seed.eventId,
      limit: 50,
      offset: 0,
    });

    const row = page.items.find((i) => i.id === seed!.listingWithSnapshotId);
    expect(row).toBeDefined();
    expect(row!.facePriceCents).toBe(SNAPSHOT_FACE_CENTS);
    // The live type is 9900 — reading it would be the FR-001 bug.
    expect(row!.facePriceCents).not.toBe(LIVE_TYPE_PRICE_CENTS);
    // The type is still the source for the display name.
    expect(row!.ticketTypeName).toBe("General Admission");
  }, 60_000);

  test("falls back to the seller's OrderItem, never the live ticket type", async ({
    skip,
  }) => {
    if (runtimeError || !prisma || !seed) {
      skip();
      return;
    }

    const repo = makeResaleListingsRepo(prisma);
    const page = await repo.listByEventEnriched({
      eventId: seed.eventId,
      limit: 50,
      offset: 0,
    });

    const row = page.items.find((i) => i.id === seed!.listingFromOrderItemId);
    expect(row).toBeDefined();
    // No listing snapshot → the purchase snapshot on OrderItem wins.
    expect(row!.facePriceCents).toBe(PURCHASED_UNIT_CENTS);
    // This is the assertion that fails if the live-price read is restored.
    expect(row!.facePriceCents).not.toBe(LIVE_TYPE_PRICE_CENTS);
  }, 60_000);

  test("returns null when neither snapshot nor OrderItem is reachable", async ({
    skip,
  }) => {
    if (runtimeError || !prisma || !seed) {
      skip();
      return;
    }

    const repo = makeResaleListingsRepo(prisma);
    const page = await repo.listByEventEnriched({
      eventId: seed.eventId,
      limit: 50,
      offset: 0,
    });

    const row = page.items.find((i) => i.id === seed!.listingWithNoSourceId);
    expect(row).toBeDefined();
    // Degraded to null — the live 9900 must NOT leak in as a consolation.
    expect(row!.facePriceCents).toBeNull();
    expect(row!.ticketTypeName).toBe("General Admission");
  }, 60_000);

  // organiser-resale-share FR-014/FR-015: the public browse never shows a
  // listing priced under the removed markup split. Runs last: it gives one
  // fixture listing a share.
  test("onlyWithShare drops listings without an event share, from the page and the total", async ({
    skip,
  }) => {
    if (runtimeError || !prisma || !seed) {
      skip();
      return;
    }

    await prisma.resaleListing.update({
      where: { id: seed.listingWithSnapshotId },
      data: { eventShareCents: 500, sharePayer: "SELLER" },
    });
    const repo = makeResaleListingsRepo(prisma);

    const all = await repo.listByEventEnriched({ eventId: seed.eventId });
    expect(all.items.length).toBeGreaterThan(1);

    const shared = await repo.listByEventEnriched({
      eventId: seed.eventId,
      onlyWithShare: true,
    });
    expect(shared.items.map((i) => i.id)).toEqual([seed.listingWithSnapshotId]);
    expect(shared.pageInfo.total).toBe(1);
  }, 60_000);

  // organiser-resale-share B6: both seller and browse reads join the
  // ticket's recorded original price and the type's stored pricing.
  test("listBySeller and listByEventEnriched carry the original price and type pricing", async ({
    skip,
  }) => {
    if (runtimeError || !prisma || !seed) {
      skip();
      return;
    }

    const listing = await prisma.resaleListing.findUniqueOrThrow({
      where: { id: seed.listingFromOrderItemId },
      include: { ticket: true },
    });
    await prisma.orderItem.update({
      where: { id: listing.ticket!.orderItemId! },
      data: { originalUnitPriceCents: 1_234 },
    });
    const repo = makeResaleListingsRepo(prisma);

    const mine = await repo.listBySeller({
      sellerHumanId: listing.sellerHumanId,
      limit: 50,
    });
    const mineRow = mine.items.find((i) => i.id === seed!.listingFromOrderItemId);
    expect(mineRow?.originalPriceCents).toBe(1_234);
    expect(mineRow?.ticketTypePricing).toMatchObject({
      priceCents: LIVE_TYPE_PRICE_CENTS,
      scheduledPriceCents: null,
      pricingMode: "FIXED",
    });
    // A purchase item with no record answers null, not the unit price.
    expect(
      mine.items.find((i) => i.id === seed!.listingWithSnapshotId)
        ?.originalPriceCents,
    ).toBeNull();

    const browse = await repo.listByEventEnriched({ eventId: seed.eventId });
    const browseRow = browse.items.find(
      (i) => i.id === seed!.listingFromOrderItemId,
    );
    expect(browseRow?.originalPriceCents).toBe(1_234);
    expect(browseRow?.ticketTypePricing?.priceCents).toBe(LIVE_TYPE_PRICE_CENTS);
  }, 60_000);
});

// ── Fixtures ───────────────────────────────────────────────────────────────

async function seedResaleFaceValueFixtures(
  prisma: PrismaClient,
): Promise<SeedData> {
  const seller = await prisma.human.create({
    data: { name: "Face Value Seller", status: "ACTIVE" },
  });

  const event = await prisma.event.create({
    data: {
      title: "Face Value Showcase",
      startsAt: new Date("2026-09-01T20:00:00.000Z"),
      endsAt: new Date("2026-09-01T23:00:00.000Z"),
      status: "PUBLISHED",
      humanId: seller.id,
      defaultLocale: "en",
    },
  });

  // The organizer has since raised the price. Every listing below was bought
  // BEFORE this number existed.
  const ticketType = await prisma.ticketType.create({
    data: {
      eventId: event.id,
      name: "General Admission",
      priceCents: LIVE_TYPE_PRICE_CENTS,
      capacity: 100,
      status: "ACTIVE",
    },
  });

  const order = await prisma.order.create({
    data: {
      eventId: event.id,
      buyerHumanId: seller.id,
      amountGrossCents: PURCHASED_UNIT_CENTS * 2,
      feePolicySnapshot: {},
      status: "SUCCEEDED",
    },
  });

  /** One ticket + its purchase snapshot, optionally unlinked from the item. */
  async function makeTicketWithPurchase(opts: {
    code: string;
    linkOrderItem: boolean;
  }) {
    const orderItem = await prisma.orderItem.create({
      data: {
        orderId: order.id,
        kind: "ticket",
        ticketTypeId: ticketType.id,
        qty: 1,
        unitPriceCents: PURCHASED_UNIT_CENTS,
        amountCents: PURCHASED_UNIT_CENTS,
      },
    });

    return prisma.ticket.create({
      data: {
        eventId: event.id,
        orderId: order.id,
        orderItemId: opts.linkOrderItem ? orderItem.id : null,
        ticketTypeId: ticketType.id,
        ownerHumanId: seller.id,
        code: opts.code,
        status: "LISTED",
      },
    });
  }

  // (a) Listing carries its own frozen snapshot.
  const ticketA = await makeTicketWithPurchase({
    code: "FV-SNAPSHOT-0001",
    linkOrderItem: true,
  });
  const listingWithSnapshot = await prisma.resaleListing.create({
    data: {
      ticketId: ticketA.id,
      eventId: event.id,
      sellerHumanId: seller.id,
      askPriceCents: 5_000,
      faceValueCents: SNAPSHOT_FACE_CENTS,
      status: "ACTIVE",
    },
  });

  // (b) No listing snapshot; the OrderItem must supply the face value.
  const ticketB = await makeTicketWithPurchase({
    code: "FV-ORDERITEM-0002",
    linkOrderItem: true,
  });
  const listingFromOrderItem = await prisma.resaleListing.create({
    data: {
      ticketId: ticketB.id,
      eventId: event.id,
      sellerHumanId: seller.id,
      askPriceCents: 5_000,
      faceValueCents: null,
      status: "ACTIVE",
    },
  });

  // (c) No listing snapshot AND no orderItemId — face value is unknowable.
  const ticketC = await makeTicketWithPurchase({
    code: "FV-NOSOURCE-0003",
    linkOrderItem: false,
  });
  const listingWithNoSource = await prisma.resaleListing.create({
    data: {
      ticketId: ticketC.id,
      eventId: event.id,
      sellerHumanId: seller.id,
      askPriceCents: 5_000,
      faceValueCents: null,
      status: "ACTIVE",
    },
  });

  return {
    eventId: event.id,
    listingWithSnapshotId: listingWithSnapshot.id,
    listingFromOrderItemId: listingFromOrderItem.id,
    listingWithNoSourceId: listingWithNoSource.id,
  };
}
