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
 * Integration coverage for `lockAndCountCapacityForTicketType`.
 *
 * Every unit test upstream MOCKS this method, so nothing else in the suite can
 * tell "the capacity gate works" apart from "`held` is always 0". If the
 * status compare, the `kind = 'ticket'` filter, the order-age window or the
 * exclusion is wrong, capacity silently reverts to issued-only and the
 * charge-without-ticket bug returns with the whole suite green. That is a
 * different risk class from a loud failure, which is why this exists.
 */
const NOW = new Date("2026-08-25T20:00:00.000Z");
const WINDOW_MINUTES = 30;
const heldSince = new Date(NOW.getTime() - WINDOW_MINUTES * 60_000);

describe("Prisma adapters integration – ticket type capacity", () => {
  let pg: PostgresTestContainer | undefined;
  let pool: Pool | undefined;
  let prisma: PrismaClient | undefined;
  let runtimeError: Error | null = null;

  let ticketTypeId: string;
  let otherTicketTypeId: string;
  let eventId: string;
  let humanId: string;
  let freshOrderId: string;

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

      const tt = await prisma.ticketType.create({
        data: { eventId, name: "GA", priceCents: 2500, capacity: 100 },
      });
      ticketTypeId = tt.id;

      const other = await prisma.ticketType.create({
        data: { eventId, name: "VIP", priceCents: 5000, capacity: 50 },
      });
      otherTicketTypeId = other.id;

      const mkOrder = async (
        status: "PENDING" | "SUCCEEDED" | "CANCELLED",
        occurredAt: Date,
        items: Array<{ kind: string; qty: number; ticketTypeId?: string }>,
      ) => {
        const created = await prisma!.order.create({
          data: {
            eventId,
            buyerHumanId: humanId,
            amountGrossCents: 0,
            feesPlatformCents: 0,
            currency: "usd",
            status: status as never,
            source: "PRIMARY" as never,
            kind: "TICKETING" as never,
            feePolicySnapshot: {},
            occurredAt,
            paymentChannel: "POS" as never,
            items: {
              create: items.map((i) => ({
                kind: i.kind,
                qty: i.qty,
                unitPriceCents: 0,
                amountCents: 0,
                ...(i.ticketTypeId ? { ticketTypeId: i.ticketTypeId } : {}),
              })),
            },
          },
        });
        return created.id;
      };

      // Counts: PENDING, inside the window, ticket line, our type.
      freshOrderId = await mkOrder("PENDING", new Date(NOW.getTime() - 60_000), [
        { kind: "ticket", qty: 2, ticketTypeId },
      ]);

      // Does NOT count — older than the window (reaper will take it).
      await mkOrder("PENDING", new Date(NOW.getTime() - 90 * 60_000), [
        { kind: "ticket", qty: 5, ticketTypeId },
      ]);

      // Does NOT count — no longer PENDING.
      await mkOrder("CANCELLED", new Date(NOW.getTime() - 60_000), [
        { kind: "ticket", qty: 7, ticketTypeId },
      ]);

      // Does NOT count — not a ticket line.
      await mkOrder("PENDING", new Date(NOW.getTime() - 60_000), [
        { kind: "fee", qty: 3, ticketTypeId },
      ]);

      // Does NOT count — different ticket type.
      await mkOrder("PENDING", new Date(NOW.getTime() - 60_000), [
        { kind: "ticket", qty: 9, ticketTypeId: otherTicketTypeId },
      ]);
    } catch (error) {
      runtimeError = error as Error;
      // eslint-disable-next-line no-console
      console.error("ticket-type-capacity integration setup failed:", error);
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

  test("held counts only young PENDING ticket lines of this type", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repo = makeTicketsRepo(prisma);

    const { issued, held } = await repo.lockAndCountCapacityForTicketType({
      ticketTypeId,
      heldSince,
    });

    // If any filter is wrong this is 5, 7, 3, 9 or a sum — never 2.
    expect(held).toBe(2);
    expect(issued).toBe(0);
  });

  test("excludeOrderId removes that order's own reservation", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repo = makeTicketsRepo(prisma);

    const { held } = await repo.lockAndCountCapacityForTicketType({
      ticketTypeId,
      heldSince,
      excludeOrderId: freshOrderId,
    });

    expect(held).toBe(0);
  });

  test("a null exclusion excludes nothing rather than everything", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repo = makeTicketsRepo(prisma);

    // IS DISTINCT FROM keeps the predicate total; a plain `<>` against NULL
    // would collapse the whole WHERE to NULL and silently return 0.
    const { held } = await repo.lockAndCountCapacityForTicketType({
      ticketTypeId,
      heldSince,
      excludeOrderId: null,
    });

    expect(held).toBe(2);
  });

  test("issued counts minted tickets", async ({ skip }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    await prisma!.ticket.create({
      data: {
        eventId,
        ticketTypeId,
        ownerHumanId: humanId,
        code: `CAP-${Date.now()}`,
        status: "VALID",
      },
    });

    const repo = makeTicketsRepo(prisma!);
    const { issued } = await repo.lockAndCountCapacityForTicketType({
      ticketTypeId,
      heldSince,
    });

    expect(issued).toBe(1);
  });

  test("two transactions serialise on the advisory lock", async ({ skip }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    // Both transactions take the lock for the SAME ticket type. If the lock
    // were a no-op they would interleave and both observe the pre-insert
    // count; serialised, the second sees the first's committed line.
    const order: string[] = [];

    const first = prisma!.$transaction(async (tx) => {
      const repo = makeTicketsRepo(tx as unknown as PrismaClient);
      await repo.lockAndCountCapacityForTicketType({ ticketTypeId, heldSince });
      order.push("first:locked");
      await new Promise((r) => setTimeout(r, 300));
      order.push("first:done");
    });

    await new Promise((r) => setTimeout(r, 50));

    const second = prisma!.$transaction(async (tx) => {
      const repo = makeTicketsRepo(tx as unknown as PrismaClient);
      await repo.lockAndCountCapacityForTicketType({ ticketTypeId, heldSince });
      order.push("second:locked");
    });

    await Promise.all([first, second]);

    expect(order).toEqual(["first:locked", "first:done", "second:locked"]);
  }, 30_000);
});
