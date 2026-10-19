import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { makeHumansRepo } from "../../src/db/prisma/humans";

/**
 * `HumansRepo.holdsEmailAttachedRows` (B2, owner ruling 2026-10-16) against
 * real Postgres: the force-verify refusal rests on it, and a stubbed repo
 * cannot prove the column names. The four-table shape is unit-tested in
 * `apps/api/test/unproven-email-move.test.ts` through the shared query.
 */
describe("Prisma adapters integration – humans.holdsEmailAttachedRows", () => {
  let pg: PostgresTestContainer | undefined;
  let pool: Pool | undefined;
  let prisma: PrismaClient | undefined;
  let runtimeError: Error | null = null;
  let eventId = "";

  beforeAll(async () => {
    try {
      pg = await startPostgresContainer();
      await runPrismaMigrateDeploy(pg.databaseUrl);
      pool = new Pool({ connectionString: pg.databaseUrl });
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
      const startsAt = new Date("2026-11-01T01:00:00.000Z");
      eventId = (
        await prisma.event.create({
          data: {
            title: "Attached rows",
            startsAt,
            endsAt: new Date(startsAt.getTime() + 3 * 3_600_000),
            status: "PUBLISHED",
            visibility: "PUBLIC",
            timezone: "America/Chicago",
          },
        })
      ).id;
    } catch (error) {
      runtimeError = error as Error;
      // eslint-disable-next-line no-console
      console.error("humans-email-attached-rows setup failed:", error);
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

  const makeHuman = (name: string) =>
    prisma!.human
      .create({ data: { name, status: "ACTIVE" } })
      .then((h) => h.id);

  test("false for a human that holds nothing", async ({ skip }) => {
    if (runtimeError || !prisma) return skip();
    const repo = makeHumansRepo(prisma);
    const humanId = await makeHuman("Holds Nothing");

    expect(await repo.holdsEmailAttachedRows(humanId)).toBe(false);
  });

  test("true for a human that bought an order", async ({ skip }) => {
    if (runtimeError || !prisma) return skip();
    const repo = makeHumansRepo(prisma);
    const humanId = await makeHuman("Guest Buyer");
    await prisma.order.create({
      data: {
        eventId,
        buyerHumanId: humanId,
        amountGrossCents: 2_500,
        currency: "usd",
        status: "SUCCEEDED",
        feePolicySnapshot: {},
      },
    });

    expect(await repo.holdsEmailAttachedRows(humanId)).toBe(true);
  });

  test("true for a human linked to a lineup row", async ({ skip }) => {
    if (runtimeError || !prisma) return skip();
    const repo = makeHumansRepo(prisma);
    const humanId = await makeHuman("Invited Act");
    await prisma.eventHuman.create({
      data: { eventId, humanId, role: "PERFORMER" },
    });

    expect(await repo.holdsEmailAttachedRows(humanId)).toBe(true);
  });

  test("true for a human that owns only a ticket on someone else's order", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const repo = makeHumansRepo(prisma);
    const buyer = await makeHuman("Original Buyer");
    const recipient = await makeHuman("Transfer Recipient");
    const order = await prisma.order.create({
      data: {
        eventId,
        buyerHumanId: buyer,
        amountGrossCents: 2_500,
        currency: "usd",
        status: "SUCCEEDED",
        feePolicySnapshot: {},
      },
    });
    await prisma.ticket.create({
      data: {
        eventId,
        orderId: order.id,
        ownerHumanId: recipient,
        code: `attached-rows-ticket-${order.id}`,
      },
    });

    expect(await repo.holdsEmailAttachedRows(recipient)).toBe(true);
  });

  test("true for a human that holds only a volunteer coordinator seat", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const repo = makeHumansRepo(prisma);
    const coordinator = await makeHuman("Group Coordinator");
    const ask = await prisma.volunteerAsk.create({
      data: {
        subjectType: "EVENT",
        subjectId: eventId,
        title: "Door crew",
        status: "OPEN",
      },
    });
    await prisma.volunteerGroup.create({
      data: {
        askId: ask.id,
        name: "Front door",
        coordinatorHumanId: coordinator,
      },
    });

    expect(await repo.holdsEmailAttachedRows(coordinator)).toBe(true);
  });

  test("another human's rows do not count", async ({ skip }) => {
    if (runtimeError || !prisma) return skip();
    const repo = makeHumansRepo(prisma);
    const owner = await makeHuman("Row Owner");
    const bystander = await makeHuman("Bystander");
    await prisma.eventHuman.create({
      data: { eventId, humanId: owner, role: "PERFORMER" },
    });

    expect(await repo.holdsEmailAttachedRows(bystander)).toBe(false);
  });

  test("batch: empty input answers [] ", async ({ skip }) => {
    if (runtimeError || !prisma) return skip();
    const repo = makeHumansRepo(prisma);
    expect(await repo.listHumanIdsHoldingEmailAttachedRows([])).toEqual([]);
  });

  test("batch: returns exactly the ids holding each of the four row types", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const repo = makeHumansRepo(prisma);
    const buyer = await makeHuman("Batch Buyer");
    const ticketOwner = await makeHuman("Batch Ticket Owner");
    const coordinator = await makeHuman("Batch Coordinator");
    const lineup = await makeHuman("Batch Lineup");
    const nothing = await makeHuman("Batch Nothing");
    const twice = await makeHuman("Batch Two Kinds");

    const order = await prisma.order.create({
      data: {
        eventId,
        buyerHumanId: buyer,
        amountGrossCents: 2_500,
        currency: "usd",
        status: "SUCCEEDED",
        feePolicySnapshot: {},
      },
    });
    await prisma.order.create({
      data: {
        eventId,
        buyerHumanId: buyer,
        amountGrossCents: 2_500,
        currency: "usd",
        status: "SUCCEEDED",
        feePolicySnapshot: {},
      },
    });
    await prisma.ticket.create({
      data: {
        eventId,
        orderId: order.id,
        ownerHumanId: ticketOwner,
        code: `batch-ticket-${order.id}`,
      },
    });
    const startsAt = new Date("2026-11-02T01:00:00.000Z");
    const batchEvent = await prisma.event.create({
      data: {
        title: "Batch attached rows",
        startsAt,
        endsAt: new Date(startsAt.getTime() + 3 * 3_600_000),
        status: "PUBLISHED",
        visibility: "PUBLIC",
        timezone: "America/Chicago",
      },
    });
    const ask = await prisma.volunteerAsk.create({
      data: {
        subjectType: "EVENT",
        subjectId: batchEvent.id,
        title: "Batch door crew",
        status: "OPEN",
      },
    });
    await prisma.volunteerGroup.create({
      data: { askId: ask.id, name: "Batch door", coordinatorHumanId: coordinator },
    });
    await prisma.eventHuman.create({
      data: { eventId, humanId: lineup, role: "PERFORMER" },
    });
    await prisma.eventHuman.create({
      data: { eventId, humanId: twice, role: "PERFORMER" },
    });
    await prisma.volunteerGroup.create({
      data: { askId: ask.id, name: "Batch door 2", coordinatorHumanId: twice },
    });

    const got = await repo.listHumanIdsHoldingEmailAttachedRows([
      buyer,
      ticketOwner,
      coordinator,
      lineup,
      nothing,
      twice,
      buyer,
    ]);
    expect([...got].sort()).toEqual(
      [buyer, ticketOwner, coordinator, lineup, twice].sort(),
    );
    expect(got).not.toContain(nothing);
    expect(
      await repo.listHumanIdsHoldingEmailAttachedRows([nothing]),
    ).toEqual([]);
  });
});
