import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";
import type { UpsertPlaceStatsInput } from "@th/types/repos/place-reviews";

import {
  STALE_WINDOW_DAYS,
  makePlaceStatsRepo,
  stalePlaceIdsSql,
} from "../../src/db/prisma/place-reviews";

/**
 * `PlaceStatsRepo.listStalePlaceIds` — stale-on-anything (venue-track-record
 * spec 2026-09-24, FR-008 / NFR-005 / R10 / R12). Each arm is exercised ALONE
 * against a 500-place baseline whose every activity predates its
 * `lastCalculatedAt`, so a false positive from any arm would surface as an
 * extra id.
 *
 * The baseline is also the sizing fixture: 200k tickets with 200k admit
 * rows in the `TicketScan` log, a month of recent activity, and the plan of
 * the exact statement the adapter runs is asserted (no walk of `TicketScan`;
 * every table has an index path).
 *
 * Arm (c) reads the scan LOG, not `Ticket.scannedAt` (R11 re-ruled
 * 2026-09-25, FU-005): an ACCEPTED row after the calc makes a place stale
 * even when a refund has since cleared the ticket's stamp, and a REPLAY or
 * REJECTED row does not (it cannot move the count).
 */
describe("Prisma adapters integration – listStalePlaceIds", () => {
  let pg: PostgresTestContainer | undefined;
  let pool: Pool | undefined;
  let prisma: PrismaClient | undefined;
  let runtimeError: Error | null = null;

  const BASELINE_PLACES = 500;
  const EVENTS_PER_PLACE = 20;
  const TICKETS_PER_EVENT = 20;
  const ORDERS_PER_EVENT = 3;
  const DAY_MS = 24 * 60 * 60 * 1000;
  // The fixtures below assume a window of at least three days.
  if (STALE_WINDOW_DAYS < 3) {
    throw new Error("fixtures assume STALE_WINDOW_DAYS >= 3");
  }
  // Wall clock, deliberately: arms (c)/(d)/(f) are relative to the DB's
  // now(), so the per-case activity must sit inside the window and the
  // per-case stamps inside or outside it on purpose. Pinned instants would
  // silently age out.
  const NOW = new Date();
  // All baseline activity sits here — months before any calculation.
  const LONG_AGO = new Date(NOW.getTime() - 200 * DAY_MS);
  // Per-case stats rows are computed here (inside the window, not swept) …
  const CALC_AT = new Date(NOW.getTime() - 2 * DAY_MS);
  // … and the per-case activity lands here: after the calc, before now.
  const AFTER_CALC = new Date(NOW.getTime() - 1 * DAY_MS);
  // A recompute that happened after AFTER_CALC.
  const RECOMPUTED_AT = new Date(NOW.getTime() - 1 * DAY_MS + 60_000);
  // Older than the window: the sweep arm's territory.
  const SWEPT_AT = new Date(NOW.getTime() - (STALE_WINDOW_DAYS + 1) * DAY_MS);
  const FAR_FUTURE = new Date(NOW.getTime() + 100 * DAY_MS);

  let humanId: string;
  const ids: Record<string, string> = {};

  const REVIEW_ENUMS = {
    paymentMethod: "GUARANTEE",
    venuePromoted: "ACTIVELY_PROMOTED",
    soundQuality: "GREAT",
    stageEquipment: "FULL",
    audienceFit: "PERFECT_FIT",
    parkingLoadIn: "DEDICATED_LOT",
    bookerRating: "EXCELLENT",
    wouldPlayAgain: "YES",
  } as const;

  /** A full `upsert` input with nothing in it but the stamp. */
  function zeroStatsInput(
    placeId: string,
    lastCalculatedAt: Date,
  ): UpsertPlaceStatsInput {
    return {
      placeId,
      reviewCount: 0,
      reviewCountPublic: 0,
      payoutMeanCents: null,
      payoutMedianCents: null,
      payoutMinCents: null,
      payoutMaxCents: null,
      payoutStdDevCents: null,
      payoutSampleSize: 0,
      payoutGuaranteePct: null,
      payoutDoorSplitPct: null,
      payoutTicketSalesPct: null,
      payoutTipsPct: null,
      payoutPayToPlayPct: null,
      payoutUnpaidPct: null,
      promotionScore: null,
      soundScore: null,
      audienceFitScore: null,
      wouldPlayAgainPct: null,
      bookerScore: null,
      parkingScore: null,
      stageEquipmentScore: null,
      drawMean: null,
      drawMedian: null,
      drawMin: null,
      drawMax: null,
      drawSampleSize: 0,
      payToPlayFlagged: false,
      equipmentLiedFlagged: false,
      noPromotionFlagged: false,
      genreCloud: [],
      merchAllowedPct: null,
      avgMerchCutPct: null,
      dayOfWeekDistribution: [],
      staffSupportScore: null,
      independentVenuePct: null,
      totalEventCount: 0,
      totalTicketsSold: 0,
      avgTicketPriceCents: null,
      avgAttendance: null,
      showsHosted: 0,
      firstShowAt: null,
      lastShowAt: null,
      scannedEventCount: 0,
      checkedInTotal: 0,
      checkedInAvg: null,
      lastCalculatedAt,
    };
  }

  async function makePlace(name: string): Promise<string> {
    const p = await prisma!.place.create({
      data: { name, address: `1 ${name} St`, status: "ACTIVE" },
    });
    return p.id;
  }

  async function makeEvent(opts: {
    placeId: string;
    endsAt: Date;
    status?: "DRAFT" | "PUBLISHED" | "COMPLETED" | "CANCELLED";
    title?: string;
  }): Promise<string> {
    const ev = await prisma!.event.create({
      data: {
        title: opts.title ?? "Show",
        startsAt: new Date(opts.endsAt.getTime() - 3 * 60 * 60 * 1000),
        endsAt: opts.endsAt,
        status: opts.status ?? "PUBLISHED",
        visibility: "PUBLIC",
        placeId: opts.placeId,
      },
    });
    return ev.id;
  }

  async function makeStats(placeId: string, lastCalculatedAt: Date) {
    await prisma!.placeStats.create({ data: { placeId, lastCalculatedAt } });
  }

  async function makeReview(placeId: string, at: Date) {
    await prisma!.placeReview.create({
      data: { placeId, ...REVIEW_ENUMS, createdAt: at, updatedAt: at },
    });
  }

  /**
   * A ticket and, when `scannedAt` is set, its scan-log row. Default: a
   * plain admit (SCANNED + stamp + ACCEPTED). `refunded`: admitted, then a
   * refund path cleared the stamp — the ACCEPTED row stays. `outcome`
   * other than ACCEPTED: a scan that let nobody in; the ticket is untouched.
   */
  async function makeTicket(
    eventId: string,
    scannedAt: Date | null,
    opts: {
      outcome?: "ACCEPTED" | "REJECTED" | "REPLAY";
      refunded?: boolean;
    } = {},
  ) {
    const outcome = opts.outcome ?? "ACCEPTED";
    const admitted = scannedAt !== null && outcome === "ACCEPTED";
    const t = await prisma!.ticket.create({
      data: {
        eventId,
        ownerHumanId: humanId,
        code: `${eventId}-${Math.random().toString(36).slice(2)}`,
        status: opts.refunded ? "REFUNDED" : admitted ? "SCANNED" : "VALID",
        scannedAt: admitted && !opts.refunded ? scannedAt : null,
      },
    });
    if (scannedAt) {
      await prisma!.ticketScan.create({
        data: {
          ticketId: t.id,
          eventId,
          actorHumanId: humanId,
          scannedAt,
          outcome,
        },
      });
    }
  }

  // Raw on purpose: `updatedAt` is @updatedAt, and the arm under test keys
  // on it, so the fixture must pin it rather than take the wall clock.
  async function makeOrder(
    eventId: string,
    status: "PENDING" | "SUCCEEDED" | "PART_REFUNDED",
    updatedAt: Date,
  ) {
    await prisma!.$executeRawUnsafe(
      `INSERT INTO "Order" (id, "eventId", "buyerHumanId", "amountGrossCents",
         "feesPlatformCents", currency, status, source, "feePolicySnapshot",
         "occurredAt", "paymentChannel", "createdAt", "updatedAt")
       VALUES (gen_random_uuid()::text, $1, $2, 1000, 0, 'usd',
         $3::"OrderStatus", 'PRIMARY', '{}'::jsonb, $4::timestamp, 'WEB',
         $4::timestamp, $4::timestamp)`,
      eventId,
      humanId,
      status,
      // ISO + explicit cast: the column is tz-naive and Prisma writes UTC.
      updatedAt.toISOString(),
    );
  }

  async function timed(sql: ReturnType<typeof stalePlaceIdsSql>) {
    const started = performance.now();
    const rows = await prisma!.$queryRaw<{ placeId: string }[]>(sql);
    return { rows, ms: performance.now() - started };
  }

  beforeAll(async () => {
    try {
      pg = await startPostgresContainer();
      await runPrismaMigrateDeploy(pg.databaseUrl);

      process.env.DATABASE_URL = pg.databaseUrl;
      pool = new Pool({ connectionString: pg.databaseUrl });
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

      const human = await prisma.human.create({
        data: { name: "Buyer", status: "ACTIVE" },
      });
      humanId = human.id;

      // ── Baseline: 500 places, each with 20 ended shows, 20 admitted tickets
      // per show (200k tickets + 200k ACCEPTED scan rows), 3 SUCCEEDED
      // orders per show (30k) and one
      // review — ALL long before the calc — and a stats row computed after
      // all of it. None of them may come back. Sized so the planner faces a
      // real choice between walking Ticket/Event and probing them; at a few
      // hundred rows it would (rightly) seq-scan and prove nothing.
      const basePlaceIds = Array.from(
        { length: BASELINE_PLACES },
        (_, i) => `base-place-${String(i).padStart(3, "0")}`,
      );
      await prisma.place.createMany({
        data: basePlaceIds.map((id) => ({
          id,
          name: `Baseline ${id}`,
          address: "1 Baseline St",
          status: "ACTIVE",
        })),
      });
      await pool.query(
        `INSERT INTO "Event" (id, title, "startsAt", "endsAt", status, visibility,
           "placeId", "createdAt", "updatedAt")
         SELECT 'base-event-' || p.id || '-' || g, 'Baseline show',
           $1::timestamp - make_interval(days => g) - interval '3 hours',
           $1::timestamp - make_interval(days => g),
           'PUBLISHED', 'PUBLIC', p.id, $1::timestamp, $1::timestamp
         FROM "Place" p CROSS JOIN generate_series(0, ${EVENTS_PER_PLACE - 1}) g
         WHERE p.id LIKE 'base-place-%'`,
        [LONG_AGO.toISOString()],
      );
      await pool.query(
        `INSERT INTO "Ticket" (id, "eventId", "ownerHumanId", code, status,
           "scannedAt", "createdAt", "updatedAt")
         SELECT gen_random_uuid()::text, e.id, $1, e.id || '-' || g, 'SCANNED',
           e."endsAt", e."endsAt", e."endsAt"
         FROM "Event" e CROSS JOIN generate_series(0, ${TICKETS_PER_EVENT - 1}) g
         WHERE e.id LIKE 'base-event-%'`,
        [humanId],
      );
      await pool.query(
        `INSERT INTO "TicketScan" (id, "ticketId", "eventId", "actorHumanId",
           "scannedAt", outcome, "createdAt")
         SELECT gen_random_uuid()::text, t.id, t."eventId", $1, t."scannedAt",
           'ACCEPTED', t."scannedAt"
         FROM "Ticket" t
         WHERE t."eventId" LIKE 'base-event-%'`,
        [humanId],
      );
      await pool.query(
        `INSERT INTO "Order" (id, "eventId", "buyerHumanId", "amountGrossCents",
           "feesPlatformCents", currency, status, source, "feePolicySnapshot",
           "occurredAt", "paymentChannel", "createdAt", "updatedAt")
         SELECT gen_random_uuid()::text, e.id, $1, 1000, 0, 'usd',
           'SUCCEEDED', 'PRIMARY', '{}'::jsonb, e."endsAt", 'WEB',
           e."endsAt", e."endsAt"
         FROM "Event" e CROSS JOIN generate_series(0, ${ORDERS_PER_EVENT - 1}) g
         WHERE e.id LIKE 'base-event-%'`,
        [humanId],
      );
      await prisma.placeReview.createMany({
        data: basePlaceIds.map((placeId) => ({
          placeId,
          ...REVIEW_ENUMS,
          createdAt: LONG_AGO,
          updatedAt: LONG_AGO,
        })),
      });
      await prisma.placeStats.createMany({
        data: basePlaceIds.map((placeId) => ({
          placeId,
          lastCalculatedAt: CALC_AT,
        })),
      });
      // ── A month of recent load, spread across the last 30 days: every
      // admit of the first 50 places (20k scan rows) and every order of the
      // first 200 places (12k changes) — and those places RECOMPUTED after
      // all of it (30 minutes ago). Inside the window, but not stale: this
      // is what pins the correlated `> lastCalculatedAt` bound — a
      // window-only arm would return all two hundred — and what the 7-day
      // vs 30-day measurement below runs over.
      await pool.query(
        `UPDATE "TicketScan" s SET "scannedAt" =
           (now() AT TIME ZONE 'UTC') - make_interval(days => (abs(hashtext(s.id)) % 30)) - interval '1 hour'
         FROM "Event" e
         WHERE e.id = s."eventId" AND e."placeId" < 'base-place-050'`,
      );
      await pool.query(
        `UPDATE "Order" o SET "updatedAt" =
           (now() AT TIME ZONE 'UTC') - make_interval(days => (abs(hashtext(o.id)) % 30)) - interval '1 hour'
         FROM "Event" e
         WHERE e.id = o."eventId" AND e."placeId" < 'base-place-200'`,
      );
      await pool.query(
        `UPDATE "PlaceStats" SET "lastCalculatedAt" = (now() AT TIME ZONE 'UTC') - interval '30 minutes'
         WHERE "placeId" < 'base-place-200'`,
      );
      // Fresh statistics: the whole point is what the planner does with
      // real row counts, and autovacuum will not have run on a bulk load.
      await pool.query("ANALYZE");
      // Warm the connection once so the timed runs are not the first.
      await makePlaceStatsRepo(prisma).listStalePlaceIds(100);
    } catch (error) {
      runtimeError = error as Error;
      // eslint-disable-next-line no-console
      console.error("listStalePlaceIds setup failed:", error);
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

  test("a baseline computed after ALL its activity is NOT stale; the plan walks neither TicketScan nor (with seq scans off) anything else; 7-day vs 30-day measured", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const counts = await pool!.query(
      `SELECT (SELECT count(*) FROM "Place")::int AS places,
              (SELECT count(*) FROM "Event")::int AS events,
              (SELECT count(*) FROM "Ticket")::int AS tickets,
              (SELECT count(*) FROM "TicketScan")::int AS "scanRows",
              (SELECT count(*) FROM "Order")::int AS orders,
              (SELECT count(*) FROM "TicketScan"
                WHERE "scannedAt" > now() - interval '7 days')::int AS "scans7d",
              (SELECT count(*) FROM "TicketScan"
                WHERE "scannedAt" > now() - interval '30 days')::int AS "scans30d",
              (SELECT count(*) FROM "Order"
                WHERE "updatedAt" > now() - interval '7 days')::int AS "orders7d",
              (SELECT count(*) FROM "Order"
                WHERE "updatedAt" > now() - interval '30 days')::int AS "orders30d"`,
    );

    // R12: the window is chosen by measurement — both candidates, same
    // fixture, same statement, back to back (twice each; the second run is
    // the number).
    const measurements: Record<string, number> = {};
    for (const windowDays of [7, 30, 7, 30]) {
      const { rows, ms } = await timed(stalePlaceIdsSql(100, windowDays));
      expect(rows).toStrictEqual([]);
      measurements[`${windowDays}d`] = ms;
    }
    const chosen = await timed(stalePlaceIdsSql(100));
    // eslint-disable-next-line no-console
    console.log(
      `listStalePlaceIds over ${JSON.stringify(counts.rows[0])}: ` +
        `7-day ${measurements["7d"]!.toFixed(1)} ms, 30-day ${measurements["30d"]!.toFixed(1)} ms, ` +
        `STALE_WINDOW_DAYS=${STALE_WINDOW_DAYS} ${chosen.ms.toFixed(1)} ms`,
    );

    // NFR-005: the plan of the EXACT statement the adapter runs. Printed
    // BEFORE any assertion so a failure still shows what the planner did.
    const q = stalePlaceIdsSql(100);
    const plan = await pool!.query(
      `EXPLAIN (ANALYZE, BUFFERS) ${q.text}`,
      q.values as unknown[],
    );
    const planText = plan.rows.map((r) => r["QUERY PLAN"]).join("\n");
    // eslint-disable-next-line no-console
    console.log(planText);

    // And the same statement with sequential scans disabled: a table that
    // STILL seq-scans here has no usable index path at all. This is the
    // "index-backed" gate proper — the default plan may hash a small table
    // (Event at 10k rows is one 350-cost hash build) because it is cheaper
    // than probing, and that is the planner being right, not an index
    // being missing.
    const client = await pool!.connect();
    let noSeqPlanText: string;
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL enable_seqscan = off");
      const noSeqPlan = await client.query(
        `EXPLAIN (ANALYZE) ${q.text}`,
        q.values as unknown[],
      );
      await client.query("ROLLBACK");
      noSeqPlanText = noSeqPlan.rows.map((r) => r["QUERY PLAN"]).join("\n");
    } finally {
      client.release();
    }
    // eslint-disable-next-line no-console
    console.log("--- enable_seqscan = off ---\n" + noSeqPlanText);

    expect(chosen.rows).toStrictEqual([]);
    // Generous on purpose: this is a CI-flake guard, not the measurement —
    // the measurement is the log line above.
    expect(chosen.ms).toBeLessThan(500);
    // The scan log is the big table now (one row per door scan, R11); it
    // must never be walked, planner's choice or not — and it must be the
    // new bare `scannedAt` index doing the range, not the event-led one.
    expect(planText).not.toMatch(/Seq Scan on "TicketScan"/);
    expect(planText).toMatch(/TicketScan_scannedAt_idx/);
    for (const table of ["TicketScan", "Event", "Order", "PlaceReview"]) {
      expect(noSeqPlanText).not.toMatch(new RegExp(`Seq Scan on "${table}"`));
    }
  }, 120_000);

  test("upsert stamps the row with the CALLER's lastCalculatedAt, not the wall clock", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    // Core reads at `now` and writes later; a wall-clock stamp (T2 > now)
    // would claim the row knows about everything up to T2, so a show ending
    // or a scan landing in (now, T2] is excluded by the compute AND never
    // stale again. Here: stamp an old `now`, then land a scan after it.
    const repo = makePlaceStatsRepo(prisma);
    const placeId = await makePlace("Upsert stamp");
    const eventId = await makeEvent({ placeId, endsAt: LONG_AGO });

    const written = await repo.upsert(zeroStatsInput(placeId, CALC_AT));
    expect(written.lastCalculatedAt).toStrictEqual(CALC_AT);
    expect((await repo.getByPlaceId(placeId))?.lastCalculatedAt).toStrictEqual(
      CALC_AT,
    );
    expect(await repo.listStalePlaceIds(100)).not.toContain(placeId);

    await makeTicket(eventId, AFTER_CALC);
    expect(await repo.listStalePlaceIds(100)).toContain(placeId);

    // Recompute "at" AFTER_CALC + 1 min through the same upsert → gone again.
    await repo.upsert(zeroStatsInput(placeId, RECOMPUTED_AT));
    expect(await repo.listStalePlaceIds(100)).not.toContain(placeId);
    // Leave nothing behind for the arm suite's exact-set assertion.
    await prisma.placeStats.delete({ where: { placeId } });
    await prisma.event.delete({ where: { id: eventId } });
  }, 60_000);

  test("a row minted by setPublicSnapshot (never computed) is stale on the next run", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repo = makePlaceStatsRepo(prisma);
    const placeId = await makePlace("Snapshot minted");
    await repo.setPublicSnapshot({
      placeId,
      snapshot: { version: 1 },
      computedAt: NOW,
    });
    expect((await repo.getByPlaceId(placeId))?.lastCalculatedAt).toStrictEqual(
      new Date(0),
    );
    // Oldest stamp of all → at the head of the swept rows (arm f).
    const stale = await repo.listStalePlaceIds(100);
    expect(stale).toContain(placeId);
    // The update branch leaves the stamp alone once it has been computed.
    await repo.upsert(zeroStatsInput(placeId, RECOMPUTED_AT));
    await repo.setPublicSnapshot({
      placeId,
      snapshot: { version: 2 },
      computedAt: NOW,
    });
    expect((await repo.getByPlaceId(placeId))?.lastCalculatedAt).toStrictEqual(
      RECOMPUTED_AT,
    );
    expect(await repo.listStalePlaceIds(100)).not.toContain(placeId);
    await prisma.placeStats.delete({ where: { placeId } });
  }, 60_000);

  describe("each arm fires alone", () => {
    // Every case gets its own place so the arms cannot mask each other; the
    // baseline stays untouched, so it also proves no arm has a false positive.
    beforeAll(async () => {
      if (runtimeError || !prisma) return;
      try {
        // (a) a review changed after the calc.
        ids.review = await makePlace("Arm A review");
        await makeStats(ids.review, CALC_AT);
        await makeEvent({ placeId: ids.review, endsAt: LONG_AGO });
        await makeReview(ids.review, AFTER_CALC);

        // (b) a PUBLISHED event ENDED after the calc.
        ids.ended = await makePlace("Arm B ended");
        await makeStats(ids.ended, CALC_AT);
        await makeEvent({ placeId: ids.ended, endsAt: AFTER_CALC });

        // (b) a COMPLETED show that ended after the calc counts too (R10).
        ids.endedCompleted = await makePlace("Arm B completed");
        await makeStats(ids.endedCompleted, CALC_AT);
        await makeEvent({
          placeId: ids.endedCompleted,
          endsAt: AFTER_CALC,
          status: "COMPLETED",
        });

        // (b, negative) the only post-calc show is a DRAFT …
        ids.endedDraft = await makePlace("Arm B draft");
        await makeStats(ids.endedDraft, CALC_AT);
        await makeEvent({
          placeId: ids.endedDraft,
          endsAt: AFTER_CALC,
          status: "DRAFT",
        });
        // … or CANCELLED …
        ids.endedCancelled = await makePlace("Arm B cancelled");
        await makeStats(ids.endedCancelled, CALC_AT);
        await makeEvent({
          placeId: ids.endedCancelled,
          endsAt: AFTER_CALC,
          status: "CANCELLED",
        });
        // … or has not ended yet.
        ids.notEnded = await makePlace("Arm B future");
        await makeStats(ids.notEnded, CALC_AT);
        await makeEvent({ placeId: ids.notEnded, endsAt: FAR_FUTURE });

        // (c) a ticket at an OLD show was admitted after the calc.
        ids.scanned = await makePlace("Arm C scanned");
        await makeStats(ids.scanned, CALC_AT);
        ids.scannedEvent = await makeEvent({
          placeId: ids.scanned,
          endsAt: LONG_AGO,
        });
        await makeTicket(ids.scannedEvent, AFTER_CALC);

        // (c) admitted after the calc, then REFUNDED: the ticket's stamp is
        // gone but the ACCEPTED row is not — still stale (R11). The old
        // `Ticket.scannedAt` arm would have missed this one.
        ids.scannedRefunded = await makePlace("Arm C admitted then refunded");
        await makeStats(ids.scannedRefunded, CALC_AT);
        const refundedEvent = await makeEvent({
          placeId: ids.scannedRefunded,
          endsAt: LONG_AGO,
        });
        await makeTicket(refundedEvent, AFTER_CALC, { refunded: true });

        // (c, negative) only a REPLAY and a REJECTED after the calc — nobody
        // new came in, the count cannot have moved.
        ids.scannedNonAdmit = await makePlace("Arm C non-admit");
        await makeStats(ids.scannedNonAdmit, CALC_AT);
        const nonAdmitEvent = await makeEvent({
          placeId: ids.scannedNonAdmit,
          endsAt: LONG_AGO,
        });
        await makeTicket(nonAdmitEvent, AFTER_CALC, { outcome: "REPLAY" });
        await makeTicket(nonAdmitEvent, AFTER_CALC, { outcome: "REJECTED" });

        // (c, negative) a ticket minted but never scanned.
        ids.unscanned = await makePlace("Arm C unscanned");
        await makeStats(ids.unscanned, CALC_AT);
        const unscannedEvent = await makeEvent({
          placeId: ids.unscanned,
          endsAt: LONG_AGO,
        });
        await makeTicket(unscannedEvent, null);

        // (d) an ELIGIBLE order changed after the calc.
        ids.order = await makePlace("Arm D order");
        await makeStats(ids.order, CALC_AT);
        const orderEvent = await makeEvent({
          placeId: ids.order,
          endsAt: LONG_AGO,
        });
        await makeOrder(orderEvent, "PART_REFUNDED", AFTER_CALC);

        // (d, negative) only a PENDING order changed — not in the stats' read set.
        ids.pendingOrder = await makePlace("Arm D pending");
        await makeStats(ids.pendingOrder, CALC_AT);
        const pendingEvent = await makeEvent({
          placeId: ids.pendingOrder,
          endsAt: LONG_AGO,
        });
        await makeOrder(pendingEvent, "PENDING", AFTER_CALC);

        // (e1) NO stats row, ZERO reviews, ONE past published show — FR-008's
        // whole point.
        ids.noRow = await makePlace("Arm E no row");
        await makeEvent({ placeId: ids.noRow, endsAt: LONG_AGO });

        // (e1) no stats row and only a COMPLETED show (R10).
        ids.noRowCompleted = await makePlace("Arm E completed only");
        await makeEvent({
          placeId: ids.noRowCompleted,
          endsAt: LONG_AGO,
          status: "COMPLETED",
        });

        // (e2) no stats row, a review and nothing else.
        ids.noRowReview = await makePlace("Arm E review only");
        await makeReview(ids.noRowReview, LONG_AGO);

        // (e, negative) a bare place with nothing at all …
        ids.bare = await makePlace("Bare");
        // … or only a DRAFT.
        ids.draftOnly = await makePlace("Draft only");
        await makeEvent({
          placeId: ids.draftOnly,
          endsAt: LONG_AGO,
          status: "DRAFT",
        });

        // (f) the sweep: a row older than the window with NO activity at all
        // since — every pre-existing row after the 150000 backfill looks
        // like this.
        ids.swept = await makePlace("Arm F swept");
        await makeStats(ids.swept, SWEPT_AT);
        await makeEvent({ placeId: ids.swept, endsAt: LONG_AGO });
      } catch (error) {
        runtimeError = error as Error;
        // eslint-disable-next-line no-console
        console.error("arm fixtures failed:", error);
      }
    }, 120_000);

    test("exactly the stale places come back: never-computed first, then oldest stamp", async ({
      skip,
    }) => {
      if (runtimeError || !prisma) {
        skip();
        return;
      }
      const repo = makePlaceStatsRepo(prisma);
      const stale = await repo.listStalePlaceIds(100);

      // NULLS FIRST (no row), then by stamp: the swept row (window+1 days)
      // before the four stamped two days ago; placeId breaks ties.
      const expected = [
        ...[ids.noRow!, ids.noRowCompleted!, ids.noRowReview!].sort(),
        ids.swept!,
        ...[
          ids.review!,
          ids.ended!,
          ids.endedCompleted!,
          ids.scanned!,
          ids.scannedRefunded!,
          ids.order!,
        ].sort(),
      ];
      expect(stale).toStrictEqual(expected);

      for (const notStale of [
        ids.endedDraft,
        ids.endedCancelled,
        ids.notEnded,
        ids.unscanned,
        ids.scannedNonAdmit,
        ids.pendingOrder,
        ids.bare,
        ids.draftOnly,
      ]) {
        expect(stale).not.toContain(notStale);
      }
    }, 60_000);

    test("limit is respected, and the sweep arm is bounded by it on its own", async ({
      skip,
    }) => {
      if (runtimeError || !prisma) {
        skip();
        return;
      }
      const repo = makePlaceStatsRepo(prisma);
      const two = await repo.listStalePlaceIds(2);
      expect(two).toHaveLength(2);
      expect(two).toStrictEqual(
        [ids.noRow!, ids.noRowCompleted!, ids.noRowReview!].sort().slice(0, 2),
      );
      // The sweep arm carries its own LIMIT: the rendered statement has two.
      expect(stalePlaceIdsSql(2).text.match(/LIMIT \$\d+/g)).toHaveLength(2);
    }, 60_000);

    test("a place recomputed after its activity drops out again", async ({
      skip,
    }) => {
      if (runtimeError || !prisma) {
        skip();
        return;
      }
      const repo = makePlaceStatsRepo(prisma);
      for (const placeId of [
        ids.scanned!,
        ids.scannedRefunded!,
        ids.order!,
        ids.ended!,
        ids.endedCompleted!,
        ids.review!,
        ids.swept!,
      ]) {
        await prisma.placeStats.update({
          where: { placeId },
          data: { lastCalculatedAt: RECOMPUTED_AT },
        });
      }
      const stale = await repo.listStalePlaceIds(100);
      expect(stale).toStrictEqual(
        [ids.noRow!, ids.noRowCompleted!, ids.noRowReview!].sort(),
      );
    }, 60_000);
  });
});
