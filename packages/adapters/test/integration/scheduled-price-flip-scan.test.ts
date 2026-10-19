/**
 * Integration test for the FR-008 scan query,
 * `EventsRepo.listEventIdsWithScheduledPriceFlipBetween`, against REAL Postgres.
 *
 * WHY THIS NEEDS A REAL DATABASE. The behaviour being pinned is not business
 * logic, it is query semantics that a mock cannot express:
 *
 *   - the window is HALF-OPEN on the left and CLOSED on the right, matching the
 *     resolver's inclusive-at-T flip, so a tier flipping at exactly `windowEnd`
 *     belongs to THIS run and one flipping at exactly `windowStart` does not;
 *   - the `> afterEventId` cursor genuinely advances, so a window larger than a
 *     page is fully covered. The bug this replaced was a stable
 *     `ORDER BY eventId LIMIT n` with no cursor, which returns the SAME first n
 *     rows on every tick — the tail is never scanned at all, so a coordinated
 *     on-sale would leave hundreds of events serving a stale price until the
 *     nightly full reindex;
 *   - `take` bounds ROWS. `distinct` was deliberately removed from the query
 *     because `distinct` + `take` is Prisma-version-dependent (DISTINCT ON
 *     push-down vs in-memory dedup), and in the in-memory case `take` would
 *     bound ticket-type rows rather than events, silently shrinking the page by
 *     a factor of tiers-per-event. THIS TEST PINS THAT: an event with 3 tiers
 *     returns 3 rows, proving rows-not-events and proving the caller's dedup is
 *     load-bearing rather than decorative.
 *
 * A mocked repo would have happily agreed with the broken version of all three.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { makeEventsRepo } from "../../src/db/prisma/events";

/** The flip instant under test. */
const T = new Date("2026-10-01T20:00:00.000Z");
const BEFORE_T = new Date(T.getTime() - 60_000);
const AFTER_T = new Date(T.getTime() + 60_000);

const WINDOW_START = new Date(T.getTime() - 60 * 60 * 1000);
const WINDOW_END = new Date(T.getTime() + 60 * 60 * 1000);

describe("Prisma adapters integration – scheduled price flip scan (FR-008)", () => {
  let pg: PostgresTestContainer | undefined;
  let pool: Pool | undefined;
  let prisma: PrismaClient | undefined;
  let runtimeError: Error | null = null;

  let humanId: string;
  /** Event with ONE ACTIVE tier flipping at T. */
  let inWindowEventId: string;
  /** Event with THREE ACTIVE tiers all flipping at T — the rows-not-events probe. */
  let threeTierEventId: string;
  /** Flip is at exactly windowStart (excluded) . */
  let atWindowStartEventId: string;
  /** Flip is at exactly windowEnd (included). */
  let atWindowEndEventId: string;
  /** Tier is INACTIVE (core: DRAFT) — must never appear. */
  let draftTierEventId: string;
  /** Event is DRAFT — must never appear. */
  let draftEventId: string;
  /** Half-configured schedule (date set, price null) — can never flip. */
  let halfConfiguredEventId: string;

  const makeEvent = async (
    client: PrismaClient,
    title: string,
    status: "PUBLISHED" | "DRAFT",
  ) => {
    const event = await client.event.create({
      data: {
        title,
        startsAt: new Date("2026-12-01T20:00:00.000Z"),
        endsAt: new Date("2026-12-01T23:00:00.000Z"),
        status,
        humanId,
      },
    });
    return event.id;
  };

  const makeTier = async (
    client: PrismaClient,
    eventId: string,
    name: string,
    opts: {
      /**
       * The DATABASE enum, which is `ACTIVE | INACTIVE | ARCHIVED` — there is no
       * `DRAFT` column value. Core's `DRAFT` is a MAPPING: the adapter's
       * `mapTicketTypeStatus` folds both INACTIVE and ARCHIVED to "DRAFT". The
       * scan filters on the raw column (`status: "ACTIVE"`), so the fixture has
       * to use the storage vocabulary, not the domain one.
       */
      status?: "ACTIVE" | "INACTIVE" | "ARCHIVED";
      scheduledPriceCents?: number | null;
      scheduledPriceAt?: Date | null;
    } = {},
  ) => {
    await client.ticketType.create({
      data: {
        eventId,
        name,
        priceCents: 1200,
        capacity: 100,
        status: opts.status ?? "ACTIVE",
        scheduledPriceCents:
          opts.scheduledPriceCents === undefined
            ? 2000
            : opts.scheduledPriceCents,
        scheduledPriceAt:
          opts.scheduledPriceAt === undefined ? T : opts.scheduledPriceAt,
      },
    });
  };

  beforeAll(async () => {
    try {
      pg = await startPostgresContainer();
      await runPrismaMigrateDeploy(pg.databaseUrl);

      process.env.DATABASE_URL = pg.databaseUrl;
      // Driver-adapter ("client" engine) mode — a bare `new PrismaClient()`
      // throws. Same construction as packages/db/src/index.ts.
      pool = new Pool({ connectionString: pg.databaseUrl });
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

      const human = await prisma.human.create({
        data: { name: "Flip Scan Tester", status: "ACTIVE" },
      });
      humanId = human.id;

      inWindowEventId = await makeEvent(prisma, "In Window", "PUBLISHED");
      await makeTier(prisma, inWindowEventId, "Early Bird");

      threeTierEventId = await makeEvent(prisma, "Three Tiers", "PUBLISHED");
      await makeTier(prisma, threeTierEventId, "Tier A");
      await makeTier(prisma, threeTierEventId, "Tier B");
      await makeTier(prisma, threeTierEventId, "Tier C");

      atWindowStartEventId = await makeEvent(prisma, "At Start", "PUBLISHED");
      await makeTier(prisma, atWindowStartEventId, "Boundary Low", {
        scheduledPriceAt: WINDOW_START,
      });

      atWindowEndEventId = await makeEvent(prisma, "At End", "PUBLISHED");
      await makeTier(prisma, atWindowEndEventId, "Boundary High", {
        scheduledPriceAt: WINDOW_END,
      });

      draftTierEventId = await makeEvent(prisma, "Draft Tier", "PUBLISHED");
      await makeTier(prisma, draftTierEventId, "Not Live", {
        status: "INACTIVE",
      });

      draftEventId = await makeEvent(prisma, "Draft Event", "DRAFT");
      await makeTier(prisma, draftEventId, "Live Tier On Draft Event");

      halfConfiguredEventId = await makeEvent(prisma, "Half", "PUBLISHED");
      await makeTier(prisma, halfConfiguredEventId, "Half Configured", {
        scheduledPriceCents: null,
      });

      // Events well OUTSIDE the window in both directions.
      const longPast = await makeEvent(prisma, "Long Past", "PUBLISHED");
      await makeTier(prisma, longPast, "Past Flip", {
        scheduledPriceAt: new Date(T.getTime() - 30 * 24 * 60 * 60 * 1000),
      });
      const farFuture = await makeEvent(prisma, "Far Future", "PUBLISHED");
      await makeTier(prisma, farFuture, "Future Flip", {
        scheduledPriceAt: new Date(T.getTime() + 30 * 24 * 60 * 60 * 1000),
      });
    } catch (error) {
      runtimeError = error as Error;
      // eslint-disable-next-line no-console
      console.error(
        "scheduled-price-flip-scan integration setup failed:",
        error,
      );
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

  test("THE HARNESS ACTUALLY RAN (this file is not silently skipping)", async ({
    skip,
  }) => {
    // Adapter integration tests in this repo silently skip when the container
    // fails to start, which has previously produced a green suite that tested
    // nothing. If the setup broke, FAIL rather than skip so the signal is real.
    if (runtimeError) {
      throw new Error(
        `Integration setup failed, so the assertions below never ran: ${runtimeError.message}`,
      );
    }
    expect(prisma).toBeDefined();
    void skip;
  }, 60_000);

  test("window is half-open left, closed right — matching the resolver's inclusive flip", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    const repo = makeEventsRepo(prisma);
    const rows = await repo.listEventIdsWithScheduledPriceFlipBetween({
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      limit: 500,
    });
    const ids = new Set(rows);

    // Inside.
    expect(ids.has(inWindowEventId)).toBe(true);
    expect(ids.has(threeTierEventId)).toBe(true);
    // `lte` windowEnd → a flip at exactly the end belongs to THIS run.
    expect(ids.has(atWindowEndEventId)).toBe(true);

    // `gt` windowStart → a flip at exactly the start belonged to the PREVIOUS
    // run; including it would double-count on every tick.
    expect(ids.has(atWindowStartEventId)).toBe(false);
  }, 60_000);

  test("excludes non-ACTIVE tiers, DRAFT events and half-configured schedules", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    const repo = makeEventsRepo(prisma);
    const ids = new Set(
      await repo.listEventIdsWithScheduledPriceFlipBetween({
        windowStart: WINDOW_START,
        windowEnd: WINDOW_END,
        limit: 500,
      }),
    );

    expect(ids.has(draftTierEventId)).toBe(false);
    expect(ids.has(draftEventId)).toBe(false);
    // A row with a date but no price can never flip (the resolver treats it as
    // unscheduled), so it must not force a reindex either.
    expect(ids.has(halfConfiguredEventId)).toBe(false);
  }, 60_000);

  test("returns ROWS, not DISTINCT events — `take` bounds rows, so the caller MUST dedup", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    // This is the semantic that `distinct` + `take` made version-dependent.
    // Pinning it here means the use case's dedup + short-page termination is
    // provably matched to what the database actually returns.
    const repo = makeEventsRepo(prisma);
    const rows = await repo.listEventIdsWithScheduledPriceFlipBetween({
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      limit: 500,
    });

    const threeTierRows = rows.filter((id) => id === threeTierEventId);
    expect(threeTierRows).toHaveLength(3);

    // And the rows are ordered, which is what makes the cursor sound.
    expect([...rows]).toEqual([...rows].sort());
  }, 60_000);

  test("`limit` caps ROWS and the cursor advances past them — a big window is fully covered", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    const repo = makeEventsRepo(prisma);
    const args = {
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
    };

    const all = await repo.listEventIdsWithScheduledPriceFlipBetween({
      ...args,
      limit: 500,
    });
    expect(all.length).toBeGreaterThan(2);

    // Page with limit 1 and drive the cursor exactly as the use case does.
    const paged: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 50; i += 1) {
      const page = await repo.listEventIdsWithScheduledPriceFlipBetween({
        ...args,
        limit: 1,
        afterEventId: cursor,
      });
      if (page.length === 0) break;
      paged.push(...page);
      cursor = page[page.length - 1]!;
    }

    // THE REGRESSION GUARD: without a cursor this loop would return the same
    // first row forever. With one, the deduped set matches a single full read.
    expect(new Set(paged)).toEqual(new Set(all));

    // Each cursor step strictly advanced (rows for one event collapse, since
    // `> afterEventId` skips that event's remaining tiers — which is safe
    // because the event id was already collected).
    for (let i = 1; i < paged.length; i += 1) {
      expect(paged[i]! > paged[i - 1]!).toBe(true);
    }
  }, 60_000);

  test("an empty window returns nothing rather than everything", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    const repo = makeEventsRepo(prisma);
    const rows = await repo.listEventIdsWithScheduledPriceFlipBetween({
      windowStart: BEFORE_T,
      windowEnd: BEFORE_T,
      limit: 500,
    });
    expect(rows).toEqual([]);

    // Sanity: a window that contains only T picks up the T-flippers.
    const tight = await repo.listEventIdsWithScheduledPriceFlipBetween({
      windowStart: BEFORE_T,
      windowEnd: AFTER_T,
      limit: 500,
    });
    expect(new Set(tight).has(inWindowEventId)).toBe(true);
    expect(new Set(tight).has(atWindowEndEventId)).toBe(false);
  }, 60_000);
});
