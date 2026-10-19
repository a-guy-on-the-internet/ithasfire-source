import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { makeEventHumansRepo } from "../../src/db/prisma/event-humans";
import { makeEventRsvpsRepo } from "../../src/db/prisma/event-rsvps";
import { makeOrdersRepo } from "../../src/db/prisma/orders";
import { makeTicketsRepo } from "../../src/db/prisma/tickets";

// The three narrow source reads behind `humans.getMyNextNight` (the navbar
// account-menu block), against real Postgres. Each must agree with the page
// it summarises, so each is pinned against the EXISTING read path:
//   · tickets.listUpcomingHeldEvents ≡ the /my-tickets composition
//     (orders.listByBuyer + listOrderIdsOwnedByHuman, then
//     listEventIdsWithActiveTicket), narrowed to published, not-ended events;
//   · eventRsvps.listUpcomingEventsForUser ⊆ eventRsvps.listForUser;
//   · listLineupsByHuman({ eventStatuses }) = the unfiltered self-view,
//     filtered by status (and the unfiltered call is unchanged).

const NOW = new Date("2026-07-01T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const at = (h: number) => new Date(NOW.getTime() + h * HOUR);
/** Mirrors core's NEXT_NIGHT_ORDER_STATUSES (pinned there by a unit test). */
const ORDER_STATUSES = ["SUCCEEDED", "PART_REFUNDED"] as const;
const FEE_SNAPSHOT = { feeMode: "ABSORB", computedAt: "2026-01-01T00:00:00Z" };

describe("Prisma adapters integration – next-night sources", () => {
  let pg: PostgresTestContainer | undefined;
  let pool: Pool | undefined;
  let prisma: PrismaClient | undefined;
  let runtimeError: Error | null = null;

  let me: string;
  let other: string;
  const ev: Record<string, string> = {};
  const ord: Record<string, string> = {};
  let codeSeq = 0;

  const makeEvent = (data: {
    title: string;
    startsAt: Date;
    endsAt?: Date;
    status?: string;
  }) =>
    prisma!.event
      .create({
        data: {
          title: data.title,
          startsAt: data.startsAt,
          endsAt: data.endsAt ?? new Date(data.startsAt.getTime() + 3 * HOUR),
          status: (data.status ?? "PUBLISHED") as any,
          visibility: "PUBLIC" as any,
          timezone: "America/Chicago",
        },
      })
      .then((e) => e.id);

  const makeOrder = (data: {
    eventId: string;
    buyer: string;
    status: string;
    occurredAt?: Date;
  }) =>
    prisma!.order
      .create({
        data: {
          eventId: data.eventId,
          buyerHumanId: data.buyer,
          amountGrossCents: 1000,
          status: data.status as any,
          feePolicySnapshot: FEE_SNAPSHOT,
          ...(data.occurredAt ? { occurredAt: data.occurredAt } : {}),
        },
      })
      .then((o) => o.id);

  const makeTicket = (data: {
    eventId: string;
    orderId: string | null;
    owner: string;
    status?: string;
  }) =>
    prisma!.ticket.create({
      data: {
        eventId: data.eventId,
        orderId: data.orderId,
        ownerHumanId: data.owner,
        code: `nn-${(codeSeq += 1)}-${Math.random().toString(36).slice(2)}`,
        status: (data.status ?? "VALID") as any,
      },
    });

  beforeAll(async () => {
    try {
      pg = await startPostgresContainer();
      await runPrismaMigrateDeploy(pg.databaseUrl);
      process.env.DATABASE_URL = pg.databaseUrl;
      pool = new Pool({ connectionString: pg.databaseUrl });
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

      me = (await prisma.human.create({ data: { name: "Me", status: "ACTIVE" } })).id;
      other = (await prisma.human.create({ data: { name: "Other", status: "ACTIVE" } })).id;

      // ── Tickets ──────────────────────────────────────────────────────────
      // A: two own orders; the newer holds a LISTED (still mine) + a REFUNDED.
      ev.A = await makeEvent({ title: "A", startsAt: at(24) });
      ord.A1 = await makeOrder({ eventId: ev.A, buyer: me, status: "SUCCEEDED", occurredAt: at(-48) });
      ord.A2 = await makeOrder({ eventId: ev.A, buyer: me, status: "SUCCEEDED", occurredAt: at(-24) });
      await makeTicket({ eventId: ev.A, orderId: ord.A1, owner: me });
      await makeTicket({ eventId: ev.A, orderId: ord.A1, owner: me, status: "SCANNED" });
      await makeTicket({ eventId: ev.A, orderId: ord.A2, owner: me, status: "LISTED" });
      await makeTicket({ eventId: ev.A, orderId: ord.A2, owner: me, status: "REFUNDED" });
      // B: same start as A; ticket received by transfer on someone else's order.
      ev.B = await makeEvent({ title: "B", startsAt: at(24) });
      ord.B = await makeOrder({ eventId: ev.B, buyer: other, status: "SUCCEEDED" });
      await makeTicket({ eventId: ev.B, orderId: ord.B, owner: me });
      // C: I bought it, then transferred it away.
      ev.C = await makeEvent({ title: "C", startsAt: at(10) });
      ord.C = await makeOrder({ eventId: ev.C, buyer: me, status: "SUCCEEDED" });
      await makeTicket({ eventId: ev.C, orderId: ord.C, owner: other });
      // D: fully refunded order (even a VALID-looking ticket on it is out).
      ev.D = await makeEvent({ title: "D", startsAt: at(11) });
      ord.D = await makeOrder({ eventId: ev.D, buyer: me, status: "REFUNDED" });
      await makeTicket({ eventId: ev.D, orderId: ord.D, owner: me });
      await makeTicket({ eventId: ev.D, orderId: ord.D, owner: me, status: "REFUNDED" });
      // E: cancelled event.
      ev.E = await makeEvent({ title: "E", startsAt: at(12), status: "CANCELLED" });
      ord.E = await makeOrder({ eventId: ev.E, buyer: me, status: "SUCCEEDED" });
      await makeTicket({ eventId: ev.E, orderId: ord.E, owner: me });
      // F: already over.
      ev.F = await makeEvent({ title: "F", startsAt: at(-5), endsAt: at(-2) });
      ord.F = await makeOrder({ eventId: ev.F, buyer: me, status: "SUCCEEDED" });
      await makeTicket({ eventId: ev.F, orderId: ord.F, owner: me });
      // G: in progress — still tonight's night, and the soonest.
      ev.G = await makeEvent({ title: "G", startsAt: at(-1), endsAt: at(2) });
      ord.G = await makeOrder({ eventId: ev.G, buyer: me, status: "SUCCEEDED" });
      await makeTicket({ eventId: ev.G, orderId: ord.G, owner: me });
      // H: unpaid checkout.
      ev.H = await makeEvent({ title: "H", startsAt: at(13) });
      ord.H = await makeOrder({ eventId: ev.H, buyer: me, status: "PENDING" });
      await makeTicket({ eventId: ev.H, orderId: ord.H, owner: me });
      // I: partly refunded — one ticket still mine.
      ev.I = await makeEvent({ title: "I", startsAt: at(48) });
      ord.I = await makeOrder({ eventId: ev.I, buyer: me, status: "PART_REFUNDED" });
      await makeTicket({ eventId: ev.I, orderId: ord.I, owner: me });
      await makeTicket({ eventId: ev.I, orderId: ord.I, owner: me, status: "REFUNDED" });
      // Someone else's ticket on A must not count toward mine.
      ord.Aother = await makeOrder({ eventId: ev.A, buyer: other, status: "SUCCEEDED" });
      await makeTicket({ eventId: ev.A, orderId: ord.Aother, owner: other });

      // ── RSVPs ────────────────────────────────────────────────────────────
      ev.J = await makeEvent({ title: "J draft", startsAt: at(72), status: "DRAFT" });
      ev.K = await makeEvent({ title: "K", startsAt: at(96) });
      for (const key of ["A", "E", "F", "J", "K"]) {
        await prisma.eventRsvp.create({ data: { eventId: ev[key]!, humanId: me } });
      }
      await prisma.eventRsvp.create({ data: { eventId: ev.B!, humanId: other } });

      // ── Lineups ──────────────────────────────────────────────────────────
      for (const key of ["A", "E", "J", "F"]) {
        await prisma.eventHuman.create({ data: { eventId: ev[key]!, humanId: me, role: "PERFORMER" } });
      }
      await prisma.eventHuman.create({ data: { eventId: ev.K!, humanId: other, role: "PERFORMER" } });
    } catch (error) {
      runtimeError = error as Error;
      // eslint-disable-next-line no-console
      console.error("next-night sources setup failed:", error);
    }
  }, 600_000);

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
    if (pool) await pool.end();
    if (pg) await pg.stop();
  });

  test("integration environment is up (canary — do not skip)", () => {
    expect(runtimeError).toBeNull();
    expect(prisma).toBeDefined();
  });

  test("tickets: held, valid, paid, published, not ended — soonest first, id tiebreak, counts and own order", async ({ skip }) => {
    if (runtimeError || !prisma) return skip();
    const repo = makeTicketsRepo(prisma);
    const out = await repo.listUpcomingHeldEvents({
      humanId: me,
      now: NOW,
      eventStatuses: ["PUBLISHED"],
      orderStatuses: ORDER_STATUSES,
      limit: 10,
    });
    const [first, second] = [ev.A!, ev.B!].sort();
    expect(out.map((r) => r.eventId)).toEqual([ev.G, first, second, ev.I]);
    const byId = new Map(out.map((r) => [r.eventId, r]));
    // VALID + SCANNED on A1, LISTED on A2; the REFUNDED one and the
    // stranger's ticket do not count. Newest own order = A2.
    expect(byId.get(ev.A!)).toMatchObject({ ticketCount: 3, latestOwnOrderId: ord.A2 });
    // Received by transfer: counted, but the order is not mine to open.
    expect(byId.get(ev.B!)).toMatchObject({ ticketCount: 1, latestOwnOrderId: null });
    expect(byId.get(ev.I!)).toMatchObject({ ticketCount: 1, latestOwnOrderId: ord.I });
    expect(byId.get(ev.G!)).toMatchObject({ ticketCount: 1, latestOwnOrderId: ord.G });

    const limited = await repo.listUpcomingHeldEvents({
      humanId: me,
      now: NOW,
      eventStatuses: ["PUBLISHED"],
      orderStatuses: ORDER_STATUSES,
      limit: 2,
    });
    expect(limited.map((r) => r.eventId)).toEqual([ev.G, first]);
  }, 60_000);

  test("tickets PARITY: same events as the /my-tickets composition, narrowed to published + not ended", async ({ skip }) => {
    if (runtimeError || !prisma) return skip();
    const tickets = makeTicketsRepo(prisma);
    const orders = makeOrdersRepo(prisma);

    // The /my-tickets path (list-my-orders.ts): bought + transferred-in
    // orders, then "does the viewer still hold a live ticket for it".
    const transferredIn = await tickets.listOrderIdsOwnedByHuman(me);
    const page = await orders.listByBuyer({
      buyerHumanId: me,
      extraOrderIds: transferredIn,
      statuses: [...ORDER_STATUSES],
      sort: "occurredAt_desc",
      limit: 100,
      offset: 0,
    });
    const orderEventIds = [...new Set(page.items.map((i) => i.eventId))];
    const held = new Set(await tickets.listEventIdsWithActiveTicket(me, orderEventIds));
    const live = await prisma.event.findMany({
      where: { id: { in: [...held] }, status: "PUBLISHED", endsAt: { gt: NOW } },
      select: { id: true },
    });
    const expected = live.map((e) => e.id).sort();

    const actual = (
      await tickets.listUpcomingHeldEvents({
        humanId: me,
        now: NOW,
        eventStatuses: ["PUBLISHED"],
        orderStatuses: ORDER_STATUSES,
        limit: 50,
      })
    )
      .map((r) => r.eventId)
      .sort();
    expect(actual).toEqual(expected);
  }, 60_000);

  test("RSVPs: my published, not-ended RSVPs soonest first, a subset of listForUser", async ({ skip }) => {
    if (runtimeError || !prisma) return skip();
    const repo = makeEventRsvpsRepo(prisma);
    const out = await repo.listUpcomingEventsForUser({
      humanId: me,
      now: NOW,
      eventStatuses: ["PUBLISHED"],
      limit: 10,
    });
    expect(out.map((r) => r.eventId)).toEqual([ev.A, ev.K]);
    expect(out[0]!.startsAt).toEqual(at(24));

    const all = await repo.listForUser({ humanId: me, limit: 100 });
    const mine = new Set(all.items.map((r) => r.eventId));
    for (const row of out) expect(mine.has(row.eventId)).toBe(true);

    const limited = await repo.listUpcomingEventsForUser({
      humanId: me,
      now: NOW,
      eventStatuses: ["PUBLISHED"],
      limit: 1,
    });
    expect(limited.map((r) => r.eventId)).toEqual([ev.A]);
  }, 60_000);

  test("lineups: eventStatuses narrows the self-view in SQL; omitted = unchanged", async ({ skip }) => {
    if (runtimeError || !prisma) return skip();
    const repo = makeEventHumansRepo(prisma);
    const base = { humanId: me, when: "upcoming" as const, now: NOW, after: null, limit: 20 };
    const all = await repo.listLineupsByHuman(base);
    expect(all.map((r) => r.eventId).sort()).toEqual([ev.A, ev.E, ev.J].sort());

    const published = await repo.listLineupsByHuman({ ...base, eventStatuses: ["PUBLISHED"] });
    expect(published.map((r) => r.eventId)).toEqual(
      all.filter((r) => r.status === "PUBLISHED").map((r) => r.eventId),
    );
    expect(published.map((r) => r.eventId)).toEqual([ev.A]);

    // The filter applies BEFORE the limit: drafts/cancelled cannot crowd out.
    const one = await repo.listLineupsByHuman({ ...base, limit: 1, eventStatuses: ["PUBLISHED"] });
    expect(one.map((r) => r.eventId)).toEqual([ev.A]);
  }, 60_000);
});
