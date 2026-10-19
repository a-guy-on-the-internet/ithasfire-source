/**
 * The ≥1-ACTIVE-SPACE-PER-CALENDAR INVARIANT, now a DATABASE CONSTRAINT
 * (owner ruling 2026-09-24), against REAL Postgres.
 *
 * WHAT CHANGED. Until 2026-09-24 the invariant lived only in application code
 * and was serialized by a place-scoped `pg_advisory_xact_lock`
 * (`SpacesRepo.lockCalendarSpaceGuard`). This file used to prove that lock
 * closed the race. The lock is gone. What closes it now:
 *
 *   `Calendar.primarySpaceId` NOT NULL
 *   + CHECK ("primarySpaceStatus" = 'ACTIVE')
 *   + FK (primarySpaceId, primarySpaceStatus) → Space(id, status)
 *
 * so a Calendar without an ACTIVE space is UNREPRESENTABLE, and — because FK
 * checks take real row locks — a retire cannot race a repoint, it queues behind
 * it. Migration 20260924120000_calendar_primary_space.
 *
 * WHY THIS FILE AND NOT A UNIT TEST. Three of the four claims are claims about
 * Postgres: that the constraint refuses, that it refuses from BOTH directions,
 * and that it BLOCKS rather than racing. In-memory fakes have no constraints and
 * no concurrency; they can only assert the shape of the calls.
 *
 * JOINED-NESS IS ALSO A CONSTRAINT NOW (same ruling, second half; migration
 * 20260924160000_calendar_primary_space_joined):
 *
 *   FK (id, primarySpaceId) → CalendarSpace(calendarId, spaceId)
 *   DEFERRABLE INITIALLY DEFERRED
 *
 * The first FK pins the primary to an ACTIVE space; this one pins it to one of
 * the calendar's OWN joined rooms. Until it existed, the residual — primary B
 * ACTIVE while the calendar's only JOINED room is the retired A — was held shut
 * only by WRITE ORDERING (`setSpaceStatus` promote-retire-RE-READ-refuse, plus
 * `setSpaces` writing `primarySpaceId` unconditionally so it always takes the
 * Calendar row's lock).
 *
 * BOTH LAYERS ARE ASSERTED HERE, and deliberately so. The ordering STAYS: it is
 * what produces the friendly typed refusals. The constraint is the backstop no
 * path can bypass. The two tests that neutralise the re-read prove the second
 * half is real — the interleaving that used to COMMIT a roomless calendar is now
 * REFUSED — and the raw-SQL tests prove it from outside every use case.
 *
 * DEFERRED, not immediate, because Calendar and CalendarSpace reference each
 * other: a newborn calendar's join row needs the calendar's id and the calendar
 * row needs the join. "Deferred" means "checked at the end of the ENCLOSING
 * transaction", which in autocommit is the end of one statement — a trap with
 * its own test below.
 *
 * Client construction copies event-saves.test.ts / admin-role-guard-race.ts
 * EXACTLY — the repo's Prisma client runs in driver-adapter mode, so a bare
 * `new PrismaClient()` throws and the whole suite would silently skip.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { assignCalendarSpaces } from "@th/core/use-cases/places/manage-calendars";
import type { ManageCalendarsDeps } from "@th/core/use-cases/places/manage-calendars";
import { setSpaceStatus } from "@th/core/use-cases/places/manage-spaces";
import type { ManageSpacesDeps } from "@th/core/use-cases/places/manage-spaces";
import type { ClockPort } from "@th/ports/clock";
import type { Repos, TxRepos } from "@th/ports/repos";

import { createPrismaRepos } from "../../src/db/prisma";

const NOW = new Date("2026-09-24T12:00:00.000Z");
const CLOCK: ClockPort = { now: () => NOW };

/** The constraint the whole file is about: the primary is an ACTIVE space. */
const PRIMARY_SPACE_FK = "Calendar_primarySpaceId_primarySpaceStatus_fkey";

/** Its other half: the primary is one of the calendar's OWN joined spaces. */
const PRIMARY_JOIN_FK = "Calendar_primary_space_joined_fkey";

/**
 * A commit-time violation of {@link PRIMARY_JOIN_FK}, in whatever shape it
 * reaches JavaScript.
 *
 * MEASURED, not assumed: because the constraint is DEFERRED, Postgres raises it
 * at COMMIT, after every Prisma operation has already returned. Prisma does NOT
 * wrap it as a `PrismaClientKnownRequestError`/P2003 the way it wraps a
 * statement-time FK error — it arrives as a bare `DriverAdapterError` whose
 * `message` is just "ForeignKeyConstraintViolation" and whose `code` and `meta`
 * are undefined/null. The constraint NAME survives only inside
 * `cause.originalMessage` (`cause.constraint` is `{}`). That is exactly why the
 * adapter cannot map this one — see `rethrowPrimarySpaceViolation`'s docblock.
 *
 * Accepts the statement-time P2003 shape too, so the same helper can assert the
 * `SET CONSTRAINTS ... IMMEDIATE` case.
 */
function isPrimaryJoinViolation(error: unknown): boolean {
  const seen = new Set<unknown>();
  let node: unknown = error;
  while (node !== null && typeof node === "object" && !seen.has(node)) {
    seen.add(node);
    const record = node as {
      message?: unknown;
      originalMessage?: unknown;
      cause?: unknown;
      meta?: unknown;
    };
    for (const slot of [record.message, record.originalMessage]) {
      if (typeof slot === "string" && slot.includes(PRIMARY_JOIN_FK)) {
        return true;
      }
    }
    // P2003 hides the name under meta.driverAdapterError.cause; walk both.
    node = record.cause ?? record.meta ?? null;
  }
  return false;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function databaseUrlWithApplicationName(
  databaseUrl: string,
  applicationName: string,
): string {
  const url = new URL(databaseUrl);
  url.searchParams.set("application_name", applicationName);
  return url.toString();
}

type TxHooks = {
  /** Runs after `calendars.setSpaces` returns, still inside the transaction. */
  afterSetSpaces?: () => Promise<void>;
  /** Runs after `calendars.setPrimarySpace` returns, still inside the transaction. */
  afterSetPrimarySpace?: () => Promise<void>;
  /**
   * Drop `setSpaceStatus`'s POST-WRITE re-read to a no-op, by making the SECOND
   * and later `calendars.listByPlace` of a transaction return the FIRST one's
   * result. That is exactly "the use case only reads once", which is how the
   * last test reproduces the joined-ness hole WITHOUT reverting the source.
   */
  freezeSecondListByPlace?: boolean;
};

/**
 * Wrap a repos aggregate so a test can pause a transaction mid-flight (the only
 * way to hold uncommitted work open while the other transaction runs), or
 * neutralise the post-write re-read. Everything else passes straight through to
 * the real Prisma adapters.
 */
function withTxHooks(repos: Repos, hooks: TxHooks): Repos {
  return {
    ...repos,
    tx: ((fn, options) =>
      repos.tx(async (tx) => {
        const spaces = tx.spaces;
        const calendars = tx.calendars;
        if (!spaces || !calendars) {
          throw new Error("spaces/calendars missing from tx repos");
        }
        let firstList: Awaited<
          ReturnType<typeof calendars.listByPlace>
        > | null = null;
        const instrumented: TxRepos = {
          ...tx,
          spaces,
          calendars: {
            ...calendars,
            listByPlace: async (placeId) => {
              if (hooks.freezeSecondListByPlace && firstList) return firstList;
              const rows = await calendars.listByPlace(placeId);
              if (hooks.freezeSecondListByPlace) firstList = rows;
              return rows;
            },
            setSpaces: async (input) => {
              const result = await calendars.setSpaces(input);
              if (hooks.afterSetSpaces) await hooks.afterSetSpaces();
              return result;
            },
            setPrimarySpace: async (input) => {
              const result = await calendars.setPrimarySpace(input);
              if (hooks.afterSetPrimarySpace) {
                await hooks.afterSetPrimarySpace();
              }
              return result;
            },
          },
        };
        return fn(instrumented);
      }, options)) as Repos["tx"],
  };
}

describe("Prisma adapters integration – the calendar primary-space constraint", () => {
  let pgContainer: PostgresTestContainer | undefined;
  let pool: pg.Pool | undefined;
  let prisma: PrismaClient | undefined;
  let runtimeError: Error | null = null;

  let humanId: string;

  beforeAll(async () => {
    try {
      pgContainer = await startPostgresContainer();
      await runPrismaMigrateDeploy(pgContainer.databaseUrl);
      process.env.DATABASE_URL = pgContainer.databaseUrl;
      pool = new pg.Pool({ connectionString: pgContainer.databaseUrl });
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

      humanId = (
        await prisma.human.create({
          data: { name: "Venue Owner", status: "ACTIVE" },
        })
      ).id;
    } catch (err) {
      runtimeError = err as Error;
      // eslint-disable-next-line no-console
      console.error("[calendar-primary-space-race.test] setup failed:", err);
    }
  }, 300_000);

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
    if (pool) await pool.end();
    if (pgContainer) await pgContainer.stop();
  });

  test("integration environment is up (canary — do not skip)", () => {
    expect(runtimeError).toBeNull();
    expect(prisma).toBeDefined();
  });

  let fixtureCounter = 0;

  /**
   * A place the acting human verifiably owns, with TWO active spaces and one
   * calendar joined to both, whose PRIMARY is space A.
   *
   * Two active rooms is deliberate: it keeps the PLACE-level
   * `CANNOT_RETIRE_LAST_ACTIVE_SPACE` arm out of the way so the per-calendar
   * arm is what the assertions are actually about.
   */
  async function seedPlace(): Promise<{
    placeId: string;
    spaceAId: string;
    spaceBId: string;
    calendarId: string;
  }> {
    if (!prisma) throw new Error("prisma not ready");
    fixtureCounter += 1;

    const place = await prisma.place.create({
      data: {
        name: `Drkmttr ${fixtureCounter}`,
        address: `${fixtureCounter} Test Ave, Nashville, TN`,
      },
    });
    await prisma.placeOwnership.create({
      data: {
        placeId: place.id,
        ownerType: "HUMAN",
        ownerId: humanId,
        verified: true,
      },
    });

    const spaceA = await prisma.space.create({
      data: { placeId: place.id, name: "Main Room", sortOrder: 0 },
    });
    const spaceB = await prisma.space.create({
      data: { placeId: place.id, name: "Patio", sortOrder: 1 },
    });
    const calendar = await prisma.calendar.create({
      data: {
        placeId: place.id,
        name: "Live Music",
        slug: `live-music-${fixtureCounter}`,
        primarySpaceId: spaceA.id,
        calendarSpaces: {
          create: [{ spaceId: spaceA.id }, { spaceId: spaceB.id }],
        },
      },
    });

    return {
      placeId: place.id,
      spaceAId: spaceA.id,
      spaceBId: spaceB.id,
      calendarId: calendar.id,
    };
  }

  /** The calendar's joined spaces with their CURRENT status, straight from SQL. */
  async function readJoinedSpaces(
    calendarId: string,
  ): Promise<{ id: string; status: string }[]> {
    if (!prisma) throw new Error("prisma not ready");
    const joins = await prisma.calendarSpace.findMany({
      where: { calendarId },
      select: { space: { select: { id: true, status: true } } },
      orderBy: { spaceId: "asc" },
    });
    return joins.map((join) => ({
      id: join.space.id,
      status: join.space.status,
    }));
  }

  async function readPrimary(calendarId: string): Promise<string> {
    if (!prisma) throw new Error("prisma not ready");
    const row = await prisma.calendar.findUniqueOrThrow({
      where: { id: calendarId },
      select: { primarySpaceId: true },
    });
    return row.primarySpaceId;
  }

  /**
   * Polls `pg_stat_activity` until a connection tagged `applicationName` is
   * blocked on a lock, or `promises` all settle first. Mirrors the helper in
   * admin-role-guard-race.test.ts.
   *
   * This is the whole reason the file is trustworthy: "the second transaction
   * blocked" is asserted from the SERVER's own view of who is waiting on a lock,
   * not inferred from how long an await took.
   */
  async function waitForLockWaiter(
    applicationName: string,
    promises: Promise<unknown>[],
  ): Promise<"waiting" | "settled" | "timed_out"> {
    if (!prisma) throw new Error("prisma not ready");
    let settledCount = 0;
    for (const p of promises) {
      void p.then(
        () => {
          settledCount += 1;
        },
        () => {
          settledCount += 1;
        },
      );
    }

    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (settledCount === promises.length) return "settled";
      const rows = await prisma.$queryRaw<{ waiting: number }[]>`
        SELECT COUNT(*)::int AS waiting
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND application_name = ${applicationName}
          AND wait_event_type = 'Lock'
      `;
      if ((rows[0]?.waiting ?? 0) >= 1) return "waiting";
      await delay(10);
    }
    return settledCount === promises.length ? "settled" : "timed_out";
  }

  type Worker = {
    repos: ManageCalendarsDeps["repos"] & ManageSpacesDeps["repos"];
    close: () => Promise<void>;
  };

  /**
   * A worker on its OWN connection pool — two transactions on one connection
   * cannot race, so each side of the interleaving gets its own client, the way
   * two API processes would.
   */
  function makeWorker(hooks: TxHooks, applicationName?: string): Worker {
    if (!pgContainer) throw new Error("container not ready");
    const url = applicationName
      ? databaseUrlWithApplicationName(pgContainer.databaseUrl, applicationName)
      : pgContainer.databaseUrl;
    const workerPool = new pg.Pool({ connectionString: url });
    const workerPrisma = new PrismaClient({
      adapter: new PrismaPg(workerPool),
    });
    return {
      // `createPrismaRepos` types `spaces`/`calendars` as optional on the
      // aggregate; both use cases require them and the adapter always supplies
      // them, so the narrowing cast is safe here.
      repos: withTxHooks(
        createPrismaRepos(workerPrisma),
        hooks,
      ) as ManageCalendarsDeps["repos"] & ManageSpacesDeps["repos"],
      close: async () => {
        await workerPrisma.$disconnect();
        await workerPool.end();
      },
    };
  }

  // ── (1) THE CONSTRAINT ITSELF ─────────────────────────────────────────────
  // Asserted through RAW SQL, deliberately bypassing every use case and every
  // adapter. The claim is about the schema: no code path, present or future,
  // sanctioned or not, can produce a roomless calendar. Driving the use cases
  // here would only prove the use cases behave.

  test(
    "a Calendar CANNOT be created without an ACTIVE primary space — enforced by the engine, not by any code path",
    async ({ skip }) => {
      if (runtimeError || !prisma) {
        skip();
        return;
      }

      const { placeId, spaceAId } = await seedPlace();

      // (a) No primary at all → NOT NULL.
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "Calendar" ("id","placeId","name","slug","isDefault","createdAt","updatedAt")
           VALUES (gen_random_uuid(), $1, 'Roomless', 'roomless-a', false, now(), now())`,
          placeId,
        ),
      ).rejects.toThrow(/primarySpaceId/);

      // (b) A primary that names a RETIRED space → the FK, because its target
      // is (id, status) and the status leg can only ever be 'ACTIVE'.
      const retired = await prisma.space.create({
        data: {
          placeId,
          name: "Condemned Annex",
          sortOrder: 9,
          status: "RETIRED",
        },
      });
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "Calendar" ("id","placeId","name","slug","isDefault","primarySpaceId","createdAt","updatedAt")
           VALUES (gen_random_uuid(), $1, 'Retired Primary', 'roomless-b', false, $2, now(), now())`,
          placeId,
          retired.id,
        ),
      ).rejects.toThrow(new RegExp(PRIMARY_SPACE_FK));

      // (c) Forcing the status MIRROR to disagree with the FK → the CHECK. This
      // is the constraint that makes (b) fail: without it the FK would happily
      // accept a retired room.
      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE "Calendar" SET "primarySpaceStatus" = 'RETIRED' WHERE "primarySpaceId" = $1`,
          spaceAId,
        ),
      ).rejects.toThrow(/Calendar_primary_space_active_check/);
    },
    120_000,
  );

  test(
    "retiring a space that is some calendar's primary is REFUSED by the engine, even with the use cases bypassed",
    async ({ skip }) => {
      if (runtimeError || !prisma) {
        skip();
        return;
      }

      const { spaceAId, calendarId } = await seedPlace();

      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE "Space" SET "status" = 'RETIRED' WHERE "id" = $1`,
          spaceAId,
        ),
      ).rejects.toThrow(new RegExp(PRIMARY_SPACE_FK));

      // Untouched: the refusal is not a partial write.
      //
      // Order-INDEPENDENT on purpose. `readJoinedSpaces` sorts by `spaceId`,
      // and the ids are random uuids, so a positional `toEqual([spaceA, …])`
      // holds only when spaceA's uuid happens to sort first — a ~50% flake
      // that passed on the run it was written on. Assert membership instead.
      const joinedAfterRefusal = await readJoinedSpaces(calendarId);
      expect(joinedAfterRefusal).toHaveLength(2);
      expect(joinedAfterRefusal).toContainEqual({
        id: spaceAId,
        status: "ACTIVE",
      });
      expect(joinedAfterRefusal.map((join) => join.status)).toEqual([
        "ACTIVE",
        "ACTIVE",
      ]);
    },
    120_000,
  );

  test(
    "the primary MUST be one of the calendar's own joins — raw SQL, no use case, no adapter",
    async ({ skip }) => {
      if (runtimeError || !prisma) {
        skip();
        return;
      }

      const { placeId, spaceAId, spaceBId, calendarId } = await seedPlace();

      // (a) A Calendar naming a primary with NO join row at all. Written in
      // AUTOCOMMIT, which is the trap worth having a test for: a DEFERRED
      // constraint is checked at the end of the ENCLOSING transaction, and
      // outside an explicit BEGIN that is the end of this one statement. So the
      // refusal is immediate, not at some later commit.
      const orphanPrimary = await prisma.space.create({
        data: { placeId, name: "Unjoined Annex", sortOrder: 7 },
      });
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "Calendar" ("id","placeId","name","slug","isDefault","primarySpaceId","createdAt","updatedAt")
           VALUES (gen_random_uuid(), $1, 'Unjoined', 'unjoined-primary', false, $2, now(), now())`,
          placeId,
          orphanPrimary.id,
        ),
      ).rejects.toSatisfy(isPrimaryJoinViolation);

      // (b) Repointing an EXISTING calendar's primary at an ACTIVE space of the
      // same place that it is not joined to. This is the write that used to be
      // possible: the first FK is perfectly happy — the space is ACTIVE — and
      // only the joined-ness FK refuses it.
      const unjoined = await prisma.space.create({
        data: { placeId, name: "Second Annex", sortOrder: 8 },
      });
      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE "Calendar" SET "primarySpaceId" = $1 WHERE "id" = $2`,
          unjoined.id,
          calendarId,
        ),
      ).rejects.toSatisfy(isPrimaryJoinViolation);

      // (c) Un-joining the primary's room while leaving the Calendar row alone —
      // the same illegal state reached from the other table.
      await expect(
        prisma.calendarSpace.deleteMany({
          where: { calendarId, spaceId: spaceAId },
        }),
      ).rejects.toSatisfy(isPrimaryJoinViolation);

      // Nothing moved on any of the three refusals.
      expect(await readPrimary(calendarId)).toBe(spaceAId);
      const joined = await readJoinedSpaces(calendarId);
      expect(joined).toHaveLength(2);
      expect(joined).toContainEqual({ id: spaceAId, status: "ACTIVE" });
      expect(joined).toContainEqual({ id: spaceBId, status: "ACTIVE" });
    },
    120_000,
  );

  test(
    "DEFERRED is what lets a calendar be BORN, and what tolerates setSpaces' delete-then-insert",
    async ({ skip }) => {
      if (runtimeError || !prisma) {
        skip();
        return;
      }

      const { placeId } = await seedPlace();
      const room = await prisma.space.create({
        data: { placeId, name: "Newborn Room", sortOrder: 5 },
      });

      // (a) BIRTH. The calendar row and its join row are circular — the join
      // needs the calendar's id, the calendar needs the join — so there is no
      // statement order that satisfies the FK immediately. Inside ONE
      // transaction the deferred check runs at COMMIT, by which time both rows
      // exist. This is the shape `CalendarsRepo.create` relies on.
      const born = await prisma.$transaction(async (tx) => {
        const calendar = await tx.calendar.create({
          data: {
            placeId,
            name: "Newborn",
            slug: `newborn-${fixtureCounter}`,
            primarySpaceId: room.id,
          },
        });
        // Mid-transaction the constraint is VIOLATED and that is fine: assert it
        // from inside, so "deferred" is measured rather than assumed.
        const joinsMidFlight = await tx.calendarSpace.count({
          where: { calendarId: calendar.id },
        });
        expect(joinsMidFlight).toBe(0);
        await tx.calendarSpace.create({
          data: { calendarId: calendar.id, spaceId: room.id },
        });
        return calendar;
      });
      expect(await readPrimary(born.id)).toBe(room.id);

      // (b) DELETE-THEN-INSERT. `setSpaces` replaces a join set; a future
      // refactor that deleted first and re-inserted after would leave the
      // primary's join row ABSENT mid-transaction. Deferred tolerates it.
      await prisma.$transaction(async (tx) => {
        await tx.calendarSpace.deleteMany({ where: { calendarId: born.id } });
        expect(
          await tx.calendarSpace.count({ where: { calendarId: born.id } }),
        ).toBe(0);
        await tx.calendarSpace.create({
          data: { calendarId: born.id, spaceId: room.id },
        });
      });
      expect(await readJoinedSpaces(born.id)).toEqual([
        { id: room.id, status: "ACTIVE" },
      ]);

      // (c) And the CONTROL that makes (b) mean something: force the constraint
      // IMMEDIATE for one transaction and the identical delete fails on the
      // statement. So (b) passes because the constraint is DEFERRED, not because
      // Postgres happens not to notice.
      await expect(
        prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            `SET CONSTRAINTS "${PRIMARY_JOIN_FK}" IMMEDIATE`,
          );
          await tx.calendarSpace.deleteMany({ where: { calendarId: born.id } });
        }),
      ).rejects.toSatisfy(isPrimaryJoinViolation);

      // (d) The trap, stated as a test: the SAME two writes in AUTOCOMMIT fail,
      // because each statement is its own transaction and the deferred check
      // fires at the end of it. Every seed / fixture that creates a Calendar has
      // to write its primary's join in the same transaction for this reason.
      const room2 = await prisma.space.create({
        data: { placeId, name: "Autocommit Room", sortOrder: 6 },
      });
      await expect(
        prisma.calendar.create({
          data: {
            placeId,
            name: "Autocommit",
            slug: `autocommit-${fixtureCounter}`,
            primarySpaceId: room2.id,
          },
        }),
      ).rejects.toSatisfy(isPrimaryJoinViolation);
      expect(
        await prisma.calendar.count({
          where: { placeId, slug: `autocommit-${fixtureCounter}` },
        }),
      ).toBe(0);
    },
    120_000,
  );

  // ── (2) AUTO-PROMOTION ────────────────────────────────────────────────────

  test(
    "setSpaceStatus PROMOTES the calendar's next active room instead of refusing, and the retire lands",
    async ({ skip }) => {
      if (runtimeError || !prisma || !pgContainer) {
        skip();
        return;
      }

      const { placeId, spaceAId, spaceBId, calendarId } = await seedPlace();
      expect(await readPrimary(calendarId)).toBe(spaceAId);

      const worker = makeWorker({});
      try {
        const retired = await setSpaceStatus(
          { repos: worker.repos, clock: CLOCK },
          {
            actorHumanId: humanId,
            placeId,
            spaceId: spaceAId,
            status: "RETIRED",
          },
        );
        expect(retired).toMatchObject({ id: spaceAId, status: "RETIRED" });

        // The calendar kept its rooms AND gained a live primary — no human had
        // to go repoint anything.
        expect(await readPrimary(calendarId)).toBe(spaceBId);
        expect(await readJoinedSpaces(calendarId)).toHaveLength(2);
      } finally {
        await worker.close();
      }
    },
    120_000,
  );

  test(
    "setSpaceStatus still REFUSES when the room is a calendar's LAST active one, naming it",
    async ({ skip }) => {
      if (runtimeError || !prisma || !pgContainer) {
        skip();
        return;
      }

      const { placeId, spaceAId, spaceBId, calendarId } = await seedPlace();
      // Narrow the calendar to room B only, so retiring B strands it while the
      // PLACE still has room A active (isolating the per-calendar arm).
      //
      // REPOINT BEFORE UN-JOINING, and in that order. These are two
      // autocommitted statements, so "Calendar_primary_space_joined_fkey" is
      // checked at the end of EACH of them: dropping A's join while A is still
      // the primary is refused outright (it was, when this fixture was written
      // the other way round — P2003 naming the constraint). Repointing first
      // keeps both statements individually legal.
      await prisma.calendar.update({
        where: { id: calendarId },
        data: { primarySpaceId: spaceBId },
      });
      await prisma.calendarSpace.deleteMany({
        where: { calendarId, spaceId: spaceAId },
      });

      const worker = makeWorker({});
      try {
        await expect(
          setSpaceStatus(
            { repos: worker.repos, clock: CLOCK },
            {
              actorHumanId: humanId,
              placeId,
              spaceId: spaceBId,
              status: "RETIRED",
            },
          ),
        ).rejects.toMatchObject({
          code: "CANNOT_RETIRE_LAST_ACTIVE_SPACE_ON_CALENDAR",
          meta: {
            placeId,
            spaceId: spaceBId,
            calendars: [{ id: calendarId, name: "Live Music" }],
          },
        });

        // Nothing moved: not the status, not the primary.
        expect(await readPrimary(calendarId)).toBe(spaceBId);
        expect(await readJoinedSpaces(calendarId)).toEqual([
          { id: spaceBId, status: "ACTIVE" },
        ]);
      } finally {
        await worker.close();
      }
    },
    120_000,
  );

  // ── (3) BOTH ORDERS OF THE RACE, WITH THE ADVISORY LOCK GONE ──────────────

  test(
    "ORDER 1 — a retire racing an uncommitted narrowing assign BLOCKS, re-reads, and refuses",
    async ({ skip }) => {
      if (runtimeError || !prisma || !pgContainer) {
        skip();
        return;
      }

      const { placeId, spaceAId, calendarId } = await seedPlace();
      const applicationName = `calendar-primary-retire-${fixtureCounter}`;

      const t1Wrote = deferred();
      const releaseT1 = deferred();

      // T1: narrow the calendar from {A, B} to {A}. A is ACTIVE and already the
      // primary, so `setSpaces` writes `primarySpaceId` UNCHANGED — and that
      // write is what takes the Calendar row's lock. Were it skipped as a
      // no-op, T2 below would sail past and commit a roomless calendar.
      const assignWorker = makeWorker({
        afterSetSpaces: async () => {
          t1Wrote.resolve();
          await releaseT1.promise;
        },
      });
      const retireWorker = makeWorker({}, applicationName);

      let assignPromise: Promise<unknown> | undefined;
      let retirePromise: Promise<unknown> | undefined;
      try {
        assignPromise = assignCalendarSpaces(
          { repos: assignWorker.repos, clock: CLOCK },
          {
            actorHumanId: humanId,
            placeId,
            calendarId,
            spaceIds: [spaceAId],
          },
        );

        await t1Wrote.promise;

        // T2: retire A. Its guard reads see only COMMITTED rows — the calendar
        // still looks like {A, B} — so it decides to auto-promote to B and
        // issues `UPDATE "Calendar" SET "primarySpaceId" = B`, straight into
        // T1's row lock.
        retirePromise = setSpaceStatus(
          { repos: retireWorker.repos, clock: CLOCK },
          {
            actorHumanId: humanId,
            placeId,
            spaceId: spaceAId,
            status: "RETIRED",
          },
        );
        const retireSettled = retirePromise.then(
          (v) => ({ ok: true as const, v }),
          (e) => ({ ok: false as const, e }),
        );

        // PARKED, per the server — not merely slower than us.
        await expect(
          waitForLockWaiter(applicationName, [retireSettled]),
        ).resolves.toBe("waiting");

        releaseT1.resolve();
        await assignPromise;

        const outcome = await retireSettled;
        expect(outcome.ok).toBe(false);
        // The POST-WRITE re-read is what catches this: T2's promotion target B
        // was un-joined by T1, so on a fresh snapshot the calendar has no
        // ACTIVE joined room and the retire is refused. `raced: true`
        // distinguishes it from the pre-write refusal.
        expect(outcome.ok === false && outcome.e).toMatchObject({
          code: "CANNOT_RETIRE_LAST_ACTIVE_SPACE_ON_CALENDAR",
          meta: {
            placeId,
            spaceId: spaceAId,
            calendars: [{ id: calendarId }],
            raced: true,
          },
        });

        // THE INVARIANT, read straight from the database: one joined room, and
        // it is ACTIVE and it is the primary.
        expect(await readJoinedSpaces(calendarId)).toEqual([
          { id: spaceAId, status: "ACTIVE" },
        ]);
        expect(await readPrimary(calendarId)).toBe(spaceAId);
      } finally {
        releaseT1.resolve();
        await Promise.allSettled([assignPromise, retirePromise]);
        await assignWorker.close();
        await retireWorker.close();
      }
    },
    120_000,
  );

  test(
    "ORDER 2 — an assign racing an uncommitted retire BLOCKS on the FK's row lock and refuses with CALENDAR_REQUIRES_ACTIVE_SPACE",
    async ({ skip }) => {
      if (runtimeError || !prisma || !pgContainer) {
        skip();
        return;
      }

      const { placeId, spaceAId, spaceBId, calendarId } = await seedPlace();
      const applicationName = `calendar-primary-assign-${fixtureCounter}`;

      // Hold an in-flight retire of A open from a plain transaction. It repoints
      // the calendar off A first (what `setSpaceStatus` does) and then retires
      // A, so A is RETIRED and uncommitted — and the retire holds A's row for
      // UPDATE, which is what the assign below has to queue behind.
      const holderPool = new pg.Pool({
        connectionString: pgContainer.databaseUrl,
      });
      const holderPrisma = new PrismaClient({
        adapter: new PrismaPg(holderPool),
      });

      const holdAcquired = deferred();
      const releaseHold = deferred();

      const assignWorker = makeWorker({}, applicationName);

      let assignPromise: Promise<unknown> | undefined;
      const holdingTx = holderPrisma.$transaction(
        async (tx) => {
          await tx.calendar.update({
            where: { id: calendarId },
            data: { primarySpaceId: spaceBId },
          });
          await tx.space.update({
            where: { id: spaceAId },
            data: { status: "RETIRED" },
          });
          holdAcquired.resolve();
          await releaseHold.promise;
        },
        { timeout: 30_000 },
      );

      try {
        await holdAcquired.promise;

        // The assign's own guard read sees A as ACTIVE (the retire is
        // uncommitted), so it happily picks A as the primary. Writing it needs
        // FOR KEY SHARE on Space A — which the holder has FOR UPDATE.
        assignPromise = assignCalendarSpaces(
          { repos: assignWorker.repos, clock: CLOCK },
          {
            actorHumanId: humanId,
            placeId,
            calendarId,
            spaceIds: [spaceAId],
          },
        );
        const assignSettled = assignPromise.then(
          (v) => ({ ok: true as const, v }),
          (e) => ({ ok: false as const, e }),
        );

        await expect(
          waitForLockWaiter(applicationName, [assignSettled]),
        ).resolves.toBe("waiting");

        releaseHold.resolve();
        await holdingTx;

        const outcome = await assignSettled;
        expect(outcome.ok).toBe(false);
        // Once the retire commits, the FK's target row (A, 'ACTIVE') no longer
        // exists, so the assign's write fails — mapped out of Postgres wording
        // by the adapter.
        expect(outcome.ok === false && outcome.e).toMatchObject({
          code: "CALENDAR_REQUIRES_ACTIVE_SPACE",
          meta: { calendarId, primarySpaceId: spaceAId, raced: true },
        });

        // Nothing was narrowed: the calendar keeps its ACTIVE room B, and B is
        // the primary.
        const joined = await readJoinedSpaces(calendarId);
        expect(joined).toHaveLength(2);
        expect(joined).toContainEqual({ id: spaceBId, status: "ACTIVE" });
        expect(await readPrimary(calendarId)).toBe(spaceBId);
      } finally {
        releaseHold.resolve();
        await holdingTx.catch(() => undefined);
        await Promise.allSettled([assignPromise]);
        await assignWorker.close();
        await holderPrisma.$disconnect();
        await holderPool.end();
      }
    },
    120_000,
  );

  // ── (4) THE JOINED-NESS RESIDUAL, NOW REFUSED ─────────────────────────────
  //
  // This test used to DOCUMENT a hole by reproducing it: with the post-write
  // re-read neutralised, ORDER 1 committed a calendar whose primary was the
  // ACTIVE B while its only JOINED room was the retired A. Every constraint that
  // existed was satisfied; the calendar was still roomless to every reader that
  // filters `calendar.spaces` by status.
  //
  // Since migration 20260924160000_calendar_primary_space_joined that state is
  // unrepresentable, so the SAME interleaving must now be REFUSED — at COMMIT,
  // by the database, with the re-read deliberately out of the way. That is the
  // whole point of moving the rule out of the write ordering: the ordering is a
  // convention two files have to keep, and this is not.

  test(
    "WITH the post-write re-read neutralised, ORDER 1 is now REFUSED at commit by the joined-ness FK",
    async ({ skip }) => {
      if (runtimeError || !prisma || !pgContainer) {
        skip();
        return;
      }

      const { placeId, spaceAId, spaceBId, calendarId } = await seedPlace();

      const t1Wrote = deferred();
      const t2Done = deferred();

      const assignWorker = makeWorker({
        afterSetSpaces: async () => {
          t1Wrote.resolve();
          await t2Done.promise;
        },
      });
      // `freezeSecondListByPlace` makes the POST-write re-read return the
      // PRE-write rows — i.e. exactly "the use case checks once", the code this
      // change replaced. Nothing in the source is reverted.
      const retireWorker = makeWorker({ freezeSecondListByPlace: true });

      let assignPromise: Promise<unknown> | undefined;
      try {
        assignPromise = assignCalendarSpaces(
          { repos: assignWorker.repos, clock: CLOCK },
          {
            actorHumanId: humanId,
            placeId,
            calendarId,
            spaceIds: [spaceAId],
          },
        );
        await t1Wrote.promise;

        const retirePromise = setSpaceStatus(
          { repos: retireWorker.repos, clock: CLOCK },
          {
            actorHumanId: humanId,
            placeId,
            spaceId: spaceAId,
            status: "RETIRED",
          },
        );
        // Swallow here rather than at the await below: the rejection is what
        // this test is about, and an unhandled one would race the assertions.
        const retireSettled = retirePromise.then(
          (v) => ({ ok: true as const, v }),
          (e) => ({ ok: false as const, e }),
        );

        // T2 blocks on T1's Calendar row lock, so let T1 commit; T2 then
        // proceeds on the STALE decision its frozen read gave it — promote to B,
        // retire A — and, with the re-read gone, reaches COMMIT believing it
        // succeeded.
        await delay(150);
        t2Done.resolve();
        await assignPromise;

        const outcome = await retireSettled;
        // REFUSED. Not by the use case (its guard has been neutralised) and not
        // by the first FK (B is genuinely ACTIVE) — by the joined-ness FK, at
        // COMMIT, because T1 un-joined B.
        expect(outcome.ok).toBe(false);
        expect(
          outcome.ok === false && isPrimaryJoinViolation(outcome.e),
        ).toBe(true);

        // A commit-time refusal rolls the WHOLE transaction back, so the retire
        // is gone too: A is still ACTIVE, still joined, still the primary. The
        // state the old version of this test asserted (primary B, only join a
        // retired A) is now unreachable.
        expect(await readPrimary(calendarId)).toBe(spaceAId);
        expect(await readJoinedSpaces(calendarId)).toEqual([
          { id: spaceAId, status: "ACTIVE" },
        ]);
        expect(
          (
            await prisma.space.findUniqueOrThrow({
              where: { id: spaceAId },
              select: { status: true },
            })
          ).status,
        ).toBe("ACTIVE");
        // And B, which T1 un-joined, is untouched — it is simply no longer this
        // calendar's room.
        expect(
          (
            await prisma.space.findUniqueOrThrow({
              where: { id: spaceBId },
              select: { status: true },
            })
          ).status,
        ).toBe("ACTIVE");
      } finally {
        t2Done.resolve();
        await Promise.allSettled([assignPromise]);
        await assignWorker.close();
        await retireWorker.close();
      }
    },
    120_000,
  );

  test(
    "the residual state is unreachable by RAW SQL too — the point is that no path can produce it",
    async ({ skip }) => {
      if (runtimeError || !prisma) {
        skip();
        return;
      }

      const { spaceAId, spaceBId, calendarId } = await seedPlace();

      // The residual, constructed DELIBERATELY and by the shortest route: no use
      // case, no adapter, no interleaving, no lock contention. Just the three
      // writes that together produce "primary B is ACTIVE, and the calendar's
      // only JOINED room is the retired A" — each one individually legal, each
      // satisfying the first FK and the CHECK.
      //
      // This is the test the whole migration exists for. If a future change
      // drops, disables or de-deferrables the joined-ness FK, this transaction
      // commits and the calendar is roomless again.
      await expect(
        prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            `UPDATE "Calendar" SET "primarySpaceId" = $1 WHERE "id" = $2`,
            spaceBId,
            calendarId,
          );
          await tx.$executeRawUnsafe(
            `DELETE FROM "CalendarSpace" WHERE "calendarId" = $1 AND "spaceId" = $2`,
            calendarId,
            spaceBId,
          );
          await tx.$executeRawUnsafe(
            `UPDATE "Space" SET "status" = 'RETIRED' WHERE "id" = $1`,
            spaceAId,
          );
        }),
      ).rejects.toSatisfy(isPrimaryJoinViolation);

      // Whole transaction rolled back: both rooms joined, both ACTIVE, primary
      // still A.
      expect(await readPrimary(calendarId)).toBe(spaceAId);
      const joined = await readJoinedSpaces(calendarId);
      expect(joined).toHaveLength(2);
      expect(joined).toContainEqual({ id: spaceAId, status: "ACTIVE" });
      expect(joined).toContainEqual({ id: spaceBId, status: "ACTIVE" });
    },
    120_000,
  );
});
