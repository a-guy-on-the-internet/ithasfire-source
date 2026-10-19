import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pgPkg, { Pool } from "pg";

import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { makeRsvpRemindersRepo } from "../../src/db/prisma/rsvp-reminders";

/**
 * Integration coverage for `community.rsvp-reminders-24h`'s durable ledger.
 *
 * Three things here are provable ONLY against a real Postgres:
 *
 *  1. The due-set read is RAW SQL — it has to be, because "does this person
 *     still owe a send" is a correlated subquery and `settledChannels` is a
 *     correlated aggregate, neither expressible in Prisma's query builder. Raw
 *     SQL is invisible to `tsc`, so every column name, the `attendance_mode`
 *     @map, the enum literals, the `NULL::text` arm of the UNION, the interval
 *     arithmetic behind `leadMinutes` and the window's half-open bounds are
 *     checked here or nowhere.
 *
 *  2. THE IDEMPOTENCY GUARANTEE IS THE UNIQUE INDEXES, not the code. A fake
 *     repo that returns an empty array on a second `claim()` proves nothing:
 *     Postgres has to arbitrate two workers racing for the same channel, and
 *     Postgres' NULLS-DISTINCT rule is the reason the migration ships TWO
 *     single-subject indexes instead of one composite.
 *
 *  3. The claim RETAKE is a READ COMMITTED re-qualification. `claim` falls back
 *     to an `updateMany` guarded on `claimedAt < staleClaimBefore`; that two
 *     ticks racing one outstanding row produce exactly one winner is a property
 *     of Postgres' update semantics, not of the TypeScript.
 *
 * WHY THE LEDGER IS PER CHANNEL. `sendEmail` CATCHES a mailer failure and
 * returns `{ status: "failed" }` rather than throwing, so a subject-level
 * claim-before-send treated "notify resolved" as "reminded" and burned the
 * claim forever — a ten-minute mailer outage would silently destroy every
 * reminder inside it while the job logged success. "All enabled channels
 * failed" would not have caught it either: in the common case in-app succeeds
 * while email fails, so the rule never fires and the email is still lost. Hence
 * one row per channel, and `sentAt` (settled) split from `claimedAt` (owned).
 *
 * All instants are fixed relative to a frozen NOW so the assertions are
 * timezone-independent; the wall-clock half of the feature lives in the
 * renderer and is covered by the core tests.
 */

// ── The window under test ───────────────────────────────────────────────────
// Mirrors the use case's arithmetic for the shipped defaults (lead 24h,
// catch-up 2h): windowStart = now + lead - catchUp, windowEnd = now + lead.
const NOW = new Date("2026-08-17T20:00:00.000Z");
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

const LEAD_MINUTES = 24 * 60;
const WINDOW_START = new Date(NOW.getTime() + 22 * HOUR_MS); // 2026-08-18T18:00Z
const WINDOW_END = new Date(NOW.getTime() + 24 * HOUR_MS); //   2026-08-18T20:00Z

/** Exactly on the lower bound. `>=` — must be INCLUDED. */
const AT_WINDOW_START = new Date(WINDOW_START.getTime());
/** An hour inside. Included. */
const MID_WINDOW = new Date(WINDOW_START.getTime() + HOUR_MS);
/** Exactly on the upper bound. `<` — must be EXCLUDED (it gets its own tick). */
const AT_WINDOW_END = new Date(WINDOW_END.getTime());
/** 26h out — not due yet. */
const TOO_FAR = new Date(WINDOW_END.getTime() + 2 * HOUR_MS);
/** 2h out — the window has already swept past it. */
const TOO_SOON = new Date(NOW.getTime() + 2 * HOUR_MS);

// ── RSVP timestamps, relative to the lead mark ──────────────────────────────
// The query filters `rsvpCreatedAt <= startsAt - leadMinutes`, so these are not
// cosmetic: an RSVP stamped `now()` (the column default) is AFTER every startsAt
// in this fixture and would make the whole due set empty.
/** Weeks before any lead mark. The ordinary case. */
const RSVP_EARLY = new Date("2026-08-01T00:00:00.000Z");
/** Exactly ON dateAtStart's lead mark — `<=`, so INCLUDED. */
const AT_LEAD_MARK = new Date(AT_WINDOW_START.getTime() - LEAD_MINUTES * MINUTE_MS);
/** One millisecond past it. Their confirmation IS their reminder — EXCLUDED. */
const PAST_LEAD_MARK = new Date(AT_LEAD_MARK.getTime() + 1);

// ── Claim timestamps ────────────────────────────────────────────────────────
/** A claim taken "now" by the tick under test. In flight, never stolen. */
const CLAIM_NOW = new Date(NOW.getTime());
/** Claims older than this are OUTSTANDING and may be retaken. */
const STALE_BEFORE = new Date(NOW.getTime() - 30 * MINUTE_MS);
/** A claim from a worker that died two hours ago. Retakeable. */
const STALE_CLAIM = new Date(NOW.getTime() - 2 * HOUR_MS);
/** What `release` writes: the UNIX epoch, outstanding on the very next tick. */
const EPOCH = new Date(0);

const PER_DATE_INDEX = "RsvpReminder_eventDateId_humanId_channel_key";
const EVENT_INDEX = "RsvpReminder_eventId_humanId_channel_key";

const FIND = {
  windowStart: WINDOW_START,
  windowEnd: WINDOW_END,
  leadMinutes: LEAD_MINUTES,
  staleClaimBefore: STALE_BEFORE,
  limit: 100,
};

/** Composite key used in assertions: the ledger subject × the human. */
const keyOf = (c: { eventDateId: string | null; eventId: string; humanId: string }) =>
  `${c.eventDateId ?? `event:${c.eventId}`}|${c.humanId}`;

describe("Prisma adapters integration – rsvp-reminders", () => {
  let pg: PostgresTestContainer | undefined;
  let pool: Pool | undefined;
  let prisma: PrismaClient | undefined;
  let runtimeError: Error | null = null;

  /** Recurring RSVP listing: six occurrences. */
  let recurringEventId: string;
  let dateAtStart: string;
  let dateMid: string;
  let dateAtEnd: string;
  let dateCancelled: string;
  let dateTooFar: string;
  let dateTooSoon: string;
  /** Single-date RSVP listing (no EventDate rows) — the event-level branch. */
  let singleEventId: string;
  /** Single-date RSVP listing that is DRAFT, not PUBLISHED. */
  let draftEventId: string;
  /** Single-date TICKETED listing — money path, must never be reminded. */
  let ticketedEventId: string;

  /** RSVP'd weeks ahead. The ordinary case. */
  let humanA: string;
  let humanB: string;
  /** RSVP'd exactly ON the lead mark. */
  let humanC: string;
  /** RSVP'd one millisecond past it. */
  let humanD: string;

  beforeAll(async () => {
    try {
      pg = await startPostgresContainer();
      // Applies the SHIPPED migration set, this feature's
      // 20260912130000_rsvp_reminder_ledger included. The suite therefore
      // asserts against the exact DDL that will run on prod, and needs no
      // migration applied to the shared dev database.
      await runPrismaMigrateDeploy(pg.databaseUrl);

      process.env.DATABASE_URL = pg.databaseUrl;
      // Driver-adapter ("client" engine) mode — a bare `new PrismaClient()`
      // throws PrismaClientInitializationError and the whole suite would
      // silently skip. Constructed the way packages/db/src/index.ts does.
      pool = new Pool({ connectionString: pg.databaseUrl, max: 16 });
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

      const mkHuman = async (name: string) =>
        (await prisma!.human.create({ data: { name, status: "ACTIVE" } })).id;

      const hostId = await mkHuman("Reminder Host");
      humanA = await mkHuman("Reminder RSVPer A");
      humanB = await mkHuman("Reminder RSVPer B");
      humanC = await mkHuman("Reminder RSVPer C");
      humanD = await mkHuman("Reminder RSVPer D");

      const recurring = await prisma.event.create({
        data: {
          title: "Weekly Open Mic",
          // Deliberately INSIDE the window. A recurring listing's own startsAt
          // is a re-pinned next-occurrence cursor; the event-level arm of the
          // UNION must exclude it purely because EventDate rows exist.
          startsAt: MID_WINDOW,
          endsAt: new Date(MID_WINDOW.getTime() + 3 * HOUR_MS),
          status: "PUBLISHED",
          attendanceMode: "RSVP",
          timezone: "America/Chicago",
          humanId: hostId,
        },
      });
      recurringEventId = recurring.id;

      const mkDate = async (
        ordinal: number,
        startsAt: Date,
        status: "SCHEDULED" | "CANCELLED" = "SCHEDULED",
      ) => {
        const row = await prisma!.eventDate.create({
          data: {
            eventId: recurring.id,
            ordinal,
            startsAt,
            endsAt: new Date(startsAt.getTime() + 2 * HOUR_MS),
            status,
          },
        });
        return row.id;
      };

      dateAtStart = await mkDate(1, AT_WINDOW_START);
      dateMid = await mkDate(2, MID_WINDOW);
      dateAtEnd = await mkDate(3, AT_WINDOW_END);
      dateCancelled = await mkDate(4, MID_WINDOW, "CANCELLED");
      dateTooFar = await mkDate(5, TOO_FAR);
      dateTooSoon = await mkDate(6, TOO_SOON);

      const mkSingle = async (
        title: string,
        status: "PUBLISHED" | "DRAFT",
        attendanceMode: "RSVP" | "TICKETED",
      ) => {
        const row = await prisma!.event.create({
          data: {
            title,
            startsAt: MID_WINDOW,
            endsAt: new Date(MID_WINDOW.getTime() + 2 * HOUR_MS),
            status,
            attendanceMode,
            timezone: "America/Chicago",
            humanId: hostId,
          },
        });
        return row.id;
      };

      singleEventId = await mkSingle("One-Off Potluck", "PUBLISHED", "RSVP");
      draftEventId = await mkSingle("Unpublished Potluck", "DRAFT", "RSVP");
      ticketedEventId = await mkSingle("Ticketed Show", "PUBLISHED", "TICKETED");

      await prisma.eventDateRsvp.createMany({
        data: [
          // Eligible.
          { eventDateId: dateAtStart, humanId: humanA, createdAt: RSVP_EARLY },
          { eventDateId: dateAtStart, humanId: humanB, createdAt: RSVP_EARLY },
          { eventDateId: dateMid, humanId: humanA, createdAt: RSVP_EARLY },
          // The lead-time boundary, as a matched pair on ONE date so the only
          // variable between them is `createdAt`.
          { eventDateId: dateAtStart, humanId: humanC, createdAt: AT_LEAD_MARK },
          { eventDateId: dateAtStart, humanId: humanD, createdAt: PAST_LEAD_MARK },
          // Each of these is filtered out by the query, for its own reason.
          { eventDateId: dateAtEnd, humanId: humanA, createdAt: RSVP_EARLY }, // bound exclusive
          { eventDateId: dateCancelled, humanId: humanA, createdAt: RSVP_EARLY }, // called off
          { eventDateId: dateTooFar, humanId: humanA, createdAt: RSVP_EARLY }, // not due
          { eventDateId: dateTooSoon, humanId: humanA, createdAt: RSVP_EARLY }, // swept past
        ],
      });

      await prisma.eventRsvp.createMany({
        data: [
          // Eligible: the genuinely single-date listing.
          { eventId: singleEventId, humanId: humanA, createdAt: RSVP_EARLY },
          { eventId: singleEventId, humanId: humanB, createdAt: RSVP_EARLY },
          // Excluded: not PUBLISHED / not RSVP.
          { eventId: draftEventId, humanId: humanA, createdAt: RSVP_EARLY },
          { eventId: ticketedEventId, humanId: humanA, createdAt: RSVP_EARLY },
          // Excluded: the listing HAS EventDate rows, so its per-date RSVPs are
          // the attendance signal and Event.startsAt is not a date anyone picked.
          { eventId: recurringEventId, humanId: humanB, createdAt: RSVP_EARLY },
        ],
      });
    } catch (error) {
      runtimeError = error as Error;
      // eslint-disable-next-line no-console
      console.error("rsvp-reminders integration setup failed:", error);
    }
  }, 600_000);

  beforeEach(async () => {
    // The ledger is the only mutable state between cases; wiping it keeps every
    // test independent of the order the file happens to run in.
    if (pool && !runtimeError) await pool.query(`TRUNCATE "RsvpReminder"`);
  });

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
    if (pool) await pool.end();
    if (pg) await pg.stop();
  }, 120_000);

  const ready = (skip: () => void): boolean => {
    if (runtimeError || !prisma || !pool || !pg) {
      skip();
      return false;
    }
    return true;
  };

  /**
   * Raw ledger insert, so the indexes and the CHECK are exercised without the
   * adapter's help. Timestamps are left to the column default ON PURPOSE —
   * see `seedClaim` for why a Date must never be written down this path.
   */
  const rawInsert = (
    eventDateId: string | null,
    eventId: string | null,
    humanId: string,
    channel: string,
  ) =>
    pool!.query(
      `INSERT INTO "RsvpReminder"
         ("id","eventDateId","eventId","humanId","channel")
       VALUES ($1,$2,$3,$4,$5)`,
      [randomUUID(), eventDateId, eventId, humanId, channel],
    );

  /**
   * Seed a ledger row THROUGH PRISMA, never through the raw pool.
   *
   * `claimedAt` / `sentAt` are `timestamp without time zone`, and the two
   * clients disagree about what that means: the plain `pg` driver writes and
   * reads a Date in the process's LOCAL zone (20:00Z lands as `15:00` under
   * CDT), while Prisma writes and reads it as UTC (`20:00`). Production is
   * Prisma on both sides — the adapter writes `claimedAt` via `create` /
   * `updateMany` and compares it via a `Prisma.sql` bound parameter — so it is
   * self-consistent; a test that seeds with raw `pg` and asserts through
   * Prisma is not, and silently shifts every fixture by the UTC offset. (An
   * earlier draft of this file did exactly that and "proved" the adapter stole
   * a fresh claim, when the fixture had simply written it five hours early.)
   */
  const seedClaim = (
    eventDateId: string | null,
    eventId: string | null,
    humanId: string,
    channel: string,
    claimedAt: Date = CLAIM_NOW,
    sentAt: Date | null = null,
  ) =>
    prisma!.rsvpReminder.create({
      data: { eventDateId, eventId, humanId, channel, claimedAt, sentAt },
    });

  /** Ledger read through the same decoder production uses. */
  const ledgerRows = (where: Record<string, unknown> = {}) =>
    prisma!.rsvpReminder.findMany({
      where,
      orderBy: { channel: "asc" },
      select: {
        eventDateId: true,
        eventId: true,
        humanId: true,
        channel: true,
        claimedAt: true,
        sentAt: true,
      },
    });

  // Every other test skips when setup failed; this one does NOT. A suite that
  // skipped wholesale is indistinguishable from a passing one without it.
  test("integration environment is up (canary — never skips)", () => {
    expect(runtimeError).toBeNull();
    expect(prisma).toBeDefined();
    expect(pool).toBeDefined();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // The shipped DDL
  // ─────────────────────────────────────────────────────────────────────────

  test("the migration ships TWO single-subject unique indexes keyed BY CHANNEL, not one composite", async ({
    skip,
  }) => {
    if (!ready(skip)) return;

    const { rows } = await pool!.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'RsvpReminder' ORDER BY indexname`,
    );
    const byName = new Map(rows.map((r) => [r.indexname, r.indexdef]));

    expect(byName.get(PER_DATE_INDEX)).toMatch(
      /UNIQUE INDEX .* \("eventDateId", "humanId", channel\)/,
    );
    expect(byName.get(EVENT_INDEX)).toMatch(
      /UNIQUE INDEX .* \("eventId", "humanId", channel\)/,
    );
    // Serves the stale-claim scan the due-set query runs every tick, and the
    // `sentAt IS NULL AND claimedAt < now() - 1h` leak metric.
    expect(byName.get("RsvpReminder_sentAt_claimedAt_idx")).toMatch(
      /\("sentAt", "claimedAt"\)/,
    );

    // The shape the migration argues AGAINST must not exist: no unique index
    // spans both subject columns at once.
    const composite = rows.filter(
      (r) =>
        r.indexdef.includes("UNIQUE") &&
        r.indexdef.includes(`"eventDateId"`) &&
        r.indexdef.includes(`"eventId"`),
    );
    expect(composite).toEqual([]);

    // And the CHECK that keeps the other column NULL, so neither index can be
    // bypassed by writing both subjects at once.
    const { rows: checks } = await pool!.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
       WHERE conrelid = '"RsvpReminder"'::regclass AND contype = 'c'`,
    );
    expect(checks.map((c) => c.conname)).toContain(
      "RsvpReminder_exactly_one_subject",
    );
  }, 60_000);

  test("claimedAt and sentAt are SEPARATE columns, and sentAt is nullable", async ({
    skip,
  }) => {
    if (!ready(skip)) return;

    // The split the whole redesign rests on. A single `sentAt DEFAULT now()`
    // stamped at CLAIM time made a claimed-never-sent row byte-identical to a
    // delivered one: unqueryable, unalertable, permanently excluded from the
    // due set. If `sentAt` ever goes NOT NULL DEFAULT, that regression is back.
    const { rows } = await pool!.query<{
      column_name: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `SELECT column_name, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_name = 'RsvpReminder'
         AND column_name IN ('channel','claimedAt','sentAt')
       ORDER BY column_name`,
    );
    const by = new Map(rows.map((r) => [r.column_name, r]));

    expect(by.get("channel")!.is_nullable).toBe("NO");
    expect(by.get("claimedAt")!.is_nullable).toBe("NO");
    expect(by.get("claimedAt")!.column_default).toBeTruthy();
    expect(by.get("sentAt")!.is_nullable).toBe("YES");
    expect(by.get("sentAt")!.column_default).toBeNull();
  }, 60_000);

  test("NULLS DISTINCT: a composite (eventId, eventDateId, humanId, channel) index would enforce NOTHING", async ({
    skip,
  }) => {
    if (!ready(skip)) return;

    // The migration's central claim, demonstrated on a scratch table so the
    // shipped one is never reshaped mid-suite. Every ledger row has exactly one
    // NULL subject column by construction, and Postgres treats NULLs in a
    // unique index as distinct — so a composite index cannot collide ANY two
    // ledger rows, per-date or event-level.
    await pool!.query(`
      CREATE TABLE "RsvpReminderNullProbe" (
        "id" TEXT PRIMARY KEY,
        "eventDateId" TEXT,
        "eventId" TEXT,
        "humanId" TEXT NOT NULL,
        "channel" TEXT NOT NULL
      );
      CREATE UNIQUE INDEX "probe_composite_key"
        ON "RsvpReminderNullProbe" ("eventId", "eventDateId", "humanId", "channel");
    `);

    try {
      const probe = (eventDateId: string | null, eventId: string | null) =>
        pool!.query(
          `INSERT INTO "RsvpReminderNullProbe"
             ("id","eventDateId","eventId","humanId","channel")
           VALUES ($1,$2,$3,$4,'email')`,
          [randomUUID(), eventDateId, eventId, "human-1"],
        );

      // Per-date shape, written twice: eventId IS NULL both times.
      await probe("date-1", null);
      await probe("date-1", null);
      // Event-level shape, written twice: eventDateId IS NULL both times.
      await probe(null, "event-1");
      await probe(null, "event-1");

      const { rows } = await pool!.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM "RsvpReminderNullProbe"`,
      );
      // Four rows, two exact duplicate pairs, index fully asleep. THIS is the
      // double-send the shipped two-index split prevents.
      expect(rows[0]!.n).toBe("4");
    } finally {
      await pool!.query(`DROP TABLE "RsvpReminderNullProbe"`);
    }
  }, 60_000);

  test("each shipped index rejects a duplicate of ITS OWN subject shape, per channel", async ({
    skip,
  }) => {
    if (!ready(skip)) return;

    // Per-date shape: eventDateId set, eventId NULL.
    await rawInsert(dateAtStart, null, humanA, "email");
    await expect(rawInsert(dateAtStart, null, humanA, "email")).rejects.toMatchObject(
      { code: "23505", constraint: PER_DATE_INDEX },
    );

    // Event-level shape: eventId set, eventDateId NULL. A DIFFERENT index, and
    // the one a composite could not have covered.
    await rawInsert(null, singleEventId, humanA, "email");
    await expect(
      rawInsert(null, singleEventId, humanA, "email"),
    ).rejects.toMatchObject({ code: "23505", constraint: EVENT_INDEX });

    // The split is not over-tight. The same human still holds: a row per
    // CHANNEL on one date, one per DATE of the same listing ("RSVP'd to three
    // Wednesdays"), and an independent event-level row.
    await rawInsert(dateAtStart, null, humanA, "in_app");
    await rawInsert(dateAtStart, null, humanA, "push");
    await rawInsert(dateMid, null, humanA, "email");
    await rawInsert(dateAtEnd, null, humanA, "email");
    const { rows } = await pool!.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM "RsvpReminder" WHERE "humanId" = $1`,
      [humanA],
    );
    expect(rows[0]!.n).toBe("6");
  }, 60_000);

  test("the CHECK refuses a row that sets BOTH subjects or NEITHER", async ({
    skip,
  }) => {
    if (!ready(skip)) return;

    // Without this a future caller could write a row that satisfies neither
    // index's intent and slips past both.
    await expect(
      rawInsert(dateMid, recurringEventId, humanB, "email"),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "RsvpReminder_exactly_one_subject",
    });

    await expect(rawInsert(null, null, humanB, "email")).rejects.toMatchObject({
      code: "23514",
      constraint: "RsvpReminder_exactly_one_subject",
    });

    const { rows } = await pool!.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM "RsvpReminder"`,
    );
    expect(rows[0]!.n).toBe("0");
  }, 60_000);

  // ─────────────────────────────────────────────────────────────────────────
  // Concurrency — the guarantee the whole design rests on
  // ─────────────────────────────────────────────────────────────────────────

  test("two CONCURRENT claims for the same (subject, human, CHANNEL): the index arbitrates, one wins", async ({
    skip,
  }) => {
    if (!ready(skip)) return;

    // Deterministic proof of genuine overlap, not a hopeful Promise.all: two
    // separate connections, each in its OWN open transaction. The second
    // INSERT cannot fail until the first COMMITs, because Postgres makes it
    // WAIT on the uncommitted tuple — so observing it still pending proves the
    // two writes really were in flight at the same moment.
    const { Client } = pgPkg;
    const c1 = new Client({ connectionString: pg!.connectionUri });
    const c2 = new Client({ connectionString: pg!.connectionUri });
    await c1.connect();
    await c2.connect();

    const insertSql = `INSERT INTO "RsvpReminder"
        ("id","eventDateId","eventId","humanId","channel","claimedAt")
      VALUES ($1,$2,NULL,$3,'email',$4)`;

    try {
      await c1.query("BEGIN");
      await c2.query("BEGIN");

      await c1.query(insertSql, [randomUUID(), dateMid, humanB, CLAIM_NOW]);

      let settled = false;
      const second = c2
        .query(insertSql, [randomUUID(), dateMid, humanB, CLAIM_NOW])
        .then(() => {
          settled = true;
          return null as { code?: string; constraint?: string } | null;
        })
        .catch((err: { code?: string; constraint?: string }) => {
          settled = true;
          return err;
        });

      // Long enough that a non-blocking insert would have finished many times
      // over; the only reason it hasn't is the unique index's lock.
      await sleep(500);
      expect(settled).toBe(false);

      await c1.query("COMMIT");

      const outcome = await second;
      expect(outcome).toMatchObject({
        code: "23505",
        constraint: PER_DATE_INDEX,
      });
      await c2.query("ROLLBACK");

      const rows = await ledgerRows({
        eventDateId: dateMid,
        humanId: humanB,
        channel: "email",
      });
      expect(rows).toHaveLength(1);
    } finally {
      await c1.end();
      await c2.end();
    }
  }, 60_000);

  test("eight concurrent claim() calls for ONE channel yield exactly one winner", async ({
    skip,
  }) => {
    if (!ready(skip)) return;

    const repo = makeRsvpRemindersRepo(prisma!);
    const input = {
      eventDateId: dateAtStart,
      eventId: recurringEventId,
      humanId: humanA,
      channels: ["email" as const],
      now: CLAIM_NOW,
      staleClaimBefore: STALE_BEFORE,
    };

    // The shipped path, raced: the losers must come back as an EMPTY array,
    // never a thrown P2002. A throw here would abort the candidate loop and the
    // job would report a failure for a reminder that was correctly deduped.
    const results = await Promise.all(
      Array.from({ length: 8 }, () => repo.claim(input)),
    );

    expect(results.filter((won) => won.length === 1)).toHaveLength(1);
    expect(results.filter((won) => won.length === 0)).toHaveLength(7);
    expect(results.flat()).toEqual(["email"]);

    const rows = await ledgerRows({ eventDateId: dateAtStart, humanId: humanA });
    expect(rows).toHaveLength(1);
    // A per-date claim nulls out eventId, which is what keeps it in the
    // per-date index's jurisdiction and out of the event-level one's.
    expect(rows[0]!.eventId).toBeNull();
    expect(rows[0]!.sentAt).toBeNull();
  }, 60_000);

  test("the same race on the EVENT-LEVEL shape is arbitrated too (eventDateId NULL)", async ({
    skip,
  }) => {
    if (!ready(skip)) return;

    const repo = makeRsvpRemindersRepo(prisma!);
    const input = {
      eventDateId: null,
      eventId: singleEventId,
      humanId: humanA,
      channels: ["in_app" as const],
      now: CLAIM_NOW,
      staleClaimBefore: STALE_BEFORE,
    };

    const results = await Promise.all(
      Array.from({ length: 8 }, () => repo.claim(input)),
    );
    expect(results.filter((won) => won.length === 1)).toHaveLength(1);

    const rows = await ledgerRows({ eventId: singleEventId, humanId: humanA });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.eventDateId).toBeNull();
  }, 60_000);

  test("eight concurrent RETAKES of ONE outstanding claim yield exactly one winner", async ({
    skip,
  }) => {
    if (!ready(skip)) return;

    // The retake is an `updateMany` guarded on `claimedAt < staleClaimBefore`,
    // not an insert, so the unique index is NOT what arbitrates it — READ
    // COMMITTED re-qualification is. Postgres re-checks the WHERE against the
    // row version the waiter saw after the winner committed, and `claimedAt` is
    // no longer stale, so every loser matches 0 rows.
    await seedClaim(dateAtStart, null, humanA, "email", STALE_CLAIM);

    const repo = makeRsvpRemindersRepo(prisma!);
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        repo.claim({
          eventDateId: dateAtStart,
          eventId: recurringEventId,
          humanId: humanA,
          channels: ["email"],
          now: CLAIM_NOW,
          staleClaimBefore: STALE_BEFORE,
        }),
      ),
    );

    expect(results.filter((won) => won.length === 1)).toHaveLength(1);
    expect(results.filter((won) => won.length === 0)).toHaveLength(7);

    const rows = await ledgerRows({ eventDateId: dateAtStart, humanId: humanA });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.claimedAt.toISOString()).toBe(CLAIM_NOW.toISOString());
  }, 60_000);

  test("a claim on email does NOT block a claim on in_app for the same (subject, human)", async ({
    skip,
  }) => {
    if (!ready(skip)) return;

    // The entire point of going per-channel. Before this, one mailer failure
    // settled the whole reminder and the in-app nudge was collateral.
    const repo = makeRsvpRemindersRepo(prisma!);
    const base = {
      eventDateId: dateAtStart,
      eventId: recurringEventId,
      humanId: humanA,
      now: CLAIM_NOW,
      staleClaimBefore: STALE_BEFORE,
    };

    expect(await repo.claim({ ...base, channels: ["email"] })).toEqual(["email"]);
    // Sequential: a different channel is untouched by the first claim.
    expect(await repo.claim({ ...base, channels: ["in_app"] })).toEqual(["in_app"]);
    // And re-claiming email is still refused.
    expect(await repo.claim({ ...base, channels: ["email"] })).toEqual([]);

    // Concurrent, on four distinct channels: all four win, none blocks another.
    await pool!.query(`TRUNCATE "RsvpReminder"`);
    const concurrent = await Promise.all(
      (["in_app", "push", "email", "sms"] as const).map((channel) =>
        repo.claim({ ...base, channels: [channel] }),
      ),
    );
    expect(concurrent.flat().sort()).toEqual(
      ["email", "in_app", "push", "sms"].sort(),
    );

    const rows = await ledgerRows({ eventDateId: dateAtStart, humanId: humanA });
    expect(rows.map((r) => r.channel)).toEqual([
      "email",
      "in_app",
      "push",
      "sms",
    ]);
  }, 60_000);

  test("claim() returns the SUBSET it won when some channels are already taken", async ({
    skip,
  }) => {
    if (!ready(skip)) return;

    const repo = makeRsvpRemindersRepo(prisma!);
    // in_app settled, email in flight for another tick, push outstanding.
    await seedClaim(dateAtStart, null, humanA, "in_app", STALE_CLAIM, NOW);
    await seedClaim(dateAtStart, null, humanA, "email", CLAIM_NOW);
    await seedClaim(dateAtStart, null, humanA, "push", STALE_CLAIM);

    const won = await repo.claim({
      eventDateId: dateAtStart,
      eventId: recurringEventId,
      humanId: humanA,
      channels: ["in_app", "email", "push", "sms"],
      now: CLAIM_NOW,
      staleClaimBefore: STALE_BEFORE,
    });

    // push retaken (outstanding), sms inserted (absent). in_app is settled and
    // email belongs to a live tick — neither is stolen.
    expect(won.sort()).toEqual(["push", "sms"]);

    const rows = await ledgerRows({ eventDateId: dateAtStart, humanId: humanA });
    const by = new Map(rows.map((r) => [r.channel, r]));
    expect(by.get("in_app")!.sentAt).not.toBeNull();
    expect(by.get("email")!.claimedAt.toISOString()).toBe(
      CLAIM_NOW.toISOString(),
    );
    expect(by.get("push")!.claimedAt.toISOString()).toBe(
      CLAIM_NOW.toISOString(),
    );
  }, 60_000);

  // ─────────────────────────────────────────────────────────────────────────
  // release() and markSent() — the failed-send retry path
  // ─────────────────────────────────────────────────────────────────────────

  test("release KEEPS the row and pushes claimedAt to the epoch, so the next tick retries", async ({
    skip,
  }) => {
    if (!ready(skip)) return;

    // Deleting instead would make a partially-delivered reminder look complete
    // to the due-set query — the row IS the record of an unpaid debt.
    const repo = makeRsvpRemindersRepo(prisma!);
    const base = {
      eventDateId: dateAtStart,
      eventId: recurringEventId,
      humanId: humanA,
    };

    expect(
      await repo.claim({
        ...base,
        channels: ["email", "in_app"],
        now: CLAIM_NOW,
        staleClaimBefore: STALE_BEFORE,
      }),
    ).toEqual(["email", "in_app"]);

    await repo.markSent({ ...base, channels: ["in_app"], sentAt: NOW });
    await repo.release({ ...base, channels: ["email"] });

    const rows = await ledgerRows({ eventDateId: dateAtStart, humanId: humanA });
    expect(rows).toHaveLength(2);
    const by = new Map(rows.map((r) => [r.channel, r]));
    expect(by.get("email")!.claimedAt.toISOString()).toBe(EPOCH.toISOString());
    expect(by.get("email")!.sentAt).toBeNull();
    // The delivered in-app row is untouched by the release.
    expect(by.get("in_app")!.sentAt!.toISOString()).toBe(NOW.toISOString());

    // Epoch beats every staleness threshold, so the retry is immediate.
    expect(
      await repo.claim({
        ...base,
        channels: ["email", "in_app"],
        now: CLAIM_NOW,
        staleClaimBefore: STALE_BEFORE,
      }),
    ).toEqual(["email"]);
  }, 60_000);

  test("release never resurrects a SETTLED channel, and an empty channel list is a no-op", async ({
    skip,
  }) => {
    if (!ready(skip)) return;

    const repo = makeRsvpRemindersRepo(prisma!);
    const base = {
      eventDateId: dateAtStart,
      eventId: recurringEventId,
      humanId: humanA,
    };
    await seedClaim(dateAtStart, null, humanA, "email", CLAIM_NOW, NOW);

    await repo.release({ ...base, channels: ["email"] });
    const rows = await ledgerRows({ humanId: humanA });
    expect(rows[0]!.sentAt!.toISOString()).toBe(NOW.toISOString());
    expect(rows[0]!.claimedAt.toISOString()).toBe(CLAIM_NOW.toISOString());

    // Releasing a claim that was never taken is a no-op, not a P2025: the
    // rollback path must never throw over the send failure that triggered it.
    await expect(
      repo.release({ ...base, humanId: humanB, channels: ["sms"] }),
    ).resolves.toBeUndefined();
    await expect(
      repo.release({ ...base, channels: [] }),
    ).resolves.toBeUndefined();
    await expect(
      repo.markSent({ ...base, channels: [], sentAt: NOW }),
    ).resolves.toBeUndefined();
  }, 60_000);

  test("markSent is guarded on sentAt IS NULL, so a late settle cannot overwrite an earlier one", async ({
    skip,
  }) => {
    if (!ready(skip)) return;

    const repo = makeRsvpRemindersRepo(prisma!);
    const base = {
      eventDateId: dateAtStart,
      eventId: recurringEventId,
      humanId: humanA,
    };
    const FIRST = new Date(NOW.getTime());
    const LATER = new Date(NOW.getTime() + 10 * MINUTE_MS);

    await seedClaim(dateAtStart, null, humanA, "email", CLAIM_NOW);
    await repo.markSent({ ...base, channels: ["email"], sentAt: FIRST });
    await repo.markSent({ ...base, channels: ["email"], sentAt: LATER });

    const rows = await ledgerRows({ humanId: humanA });
    expect(rows[0]!.sentAt!.toISOString()).toBe(FIRST.toISOString());
  }, 60_000);

  // ─────────────────────────────────────────────────────────────────────────
  // findDue — the raw SQL
  // ─────────────────────────────────────────────────────────────────────────

  test("findDue returns exactly the live, in-window, community RSVPs", async ({
    skip,
  }) => {
    if (!ready(skip)) return;

    const repo = makeRsvpRemindersRepo(prisma!);
    const due = await repo.findDue(FIND);

    expect(due.map(keyOf).sort()).toEqual(
      [
        `${dateAtStart}|${humanA}`,
        `${dateAtStart}|${humanB}`,
        `${dateAtStart}|${humanC}`,
        `${dateMid}|${humanA}`,
        `event:${singleEventId}|${humanA}`,
        `event:${singleEventId}|${humanB}`,
      ].sort(),
    );

    const keys = due.map(keyOf);
    // Each exclusion, named, so a regression says WHICH filter broke.
    expect(keys.some((k) => k.endsWith(humanD))).toBe(false); // RSVP'd inside the lead
    expect(keys.some((k) => k.startsWith(dateAtEnd))).toBe(false); // bound exclusive
    expect(keys.some((k) => k.startsWith(dateCancelled))).toBe(false); // called off
    expect(keys.some((k) => k.startsWith(dateTooFar))).toBe(false); // not due yet
    expect(keys.some((k) => k.startsWith(dateTooSoon))).toBe(false); // already swept
    expect(keys.some((k) => k.includes(draftEventId))).toBe(false); // not PUBLISHED
    expect(keys.some((k) => k.includes(ticketedEventId))).toBe(false); // TICKETED
    // The recurring listing's own event-level RSVP: excluded because the
    // listing HAS EventDate rows, even though its Event.startsAt is in-window.
    expect(keys).not.toContain(`event:${recurringEventId}|${humanB}`);

    // Nothing claimed yet, so nothing is settled.
    expect(due.every((c) => c.settledChannels.length === 0)).toBe(true);
  }, 60_000);

  test("the leadMinutes filter is a matched pair: ON the mark is in, one millisecond past is out", async ({
    skip,
  }) => {
    if (!ready(skip)) return;

    // humanC and humanD RSVP'd to the SAME date; their `createdAt` values differ
    // by 1 ms across the lead mark and nothing else does. Filtered in the QUERY
    // rather than skipped in the use case: a skip writes no ledger row, so this
    // class would sit at the head of the startsAt-ASC ordering and eat the LIMIT
    // on every tick, starving every other listing in the window.
    const repo = makeRsvpRemindersRepo(prisma!);
    const keys = (await repo.findDue(FIND)).map(keyOf);
    expect(keys).toContain(`${dateAtStart}|${humanC}`);
    expect(keys).not.toContain(`${dateAtStart}|${humanD}`);

    // Shorten the lead and humanD becomes eligible — the filter tracks the
    // parameter rather than some fixed 24h baked into the SQL.
    const shorter = await repo.findDue({ ...FIND, leadMinutes: LEAD_MINUTES - 1 });
    expect(shorter.map(keyOf)).toContain(`${dateAtStart}|${humanD}`);
  }, 60_000);

  test("an in-flight claim hides the subject; a released one brings it straight back", async ({
    skip,
  }) => {
    if (!ready(skip)) return;

    const repo = makeRsvpRemindersRepo(prisma!);
    const base = {
      eventDateId: dateAtStart,
      eventId: recurringEventId,
      humanId: humanA,
    };

    await repo.claim({
      ...base,
      channels: ["email"],
      now: CLAIM_NOW,
      staleClaimBefore: STALE_BEFORE,
    });

    // Claimed and fresh → another overlapping tick must not see it at all.
    // This is what keeps two ticks off each other for the staleness window.
    let keys = (await repo.findDue(FIND)).map(keyOf);
    expect(keys).not.toContain(`${dateAtStart}|${humanA}`);
    // ...and ONLY it: the same human's other date and the other humans' same
    // date both survive.
    expect(keys).toContain(`${dateMid}|${humanA}`);
    expect(keys).toContain(`${dateAtStart}|${humanB}`);

    await repo.release({ ...base, channels: ["email"] });

    keys = (await repo.findDue(FIND)).map(keyOf);
    expect(keys).toContain(`${dateAtStart}|${humanA}`);
  }, 60_000);

  test("a stale claim is outstanding again; settling every claimed channel retires the subject", async ({
    skip,
  }) => {
    if (!ready(skip)) return;

    const repo = makeRsvpRemindersRepo(prisma!);

    // A worker evicted between claim and send, two hours ago.
    await seedClaim(dateAtStart, null, humanA, "email", STALE_CLAIM);
    expect((await repo.findDue(FIND)).map(keyOf)).toContain(
      `${dateAtStart}|${humanA}`,
    );

    // Once it settles, the subject is gone for good.
    await repo.markSent({
      eventDateId: dateAtStart,
      eventId: recurringEventId,
      humanId: humanA,
      channels: ["email"],
      sentAt: NOW,
    });
    expect((await repo.findDue(FIND)).map(keyOf)).not.toContain(
      `${dateAtStart}|${humanA}`,
    );
  }, 60_000);

  test("settledChannels reports the delivered channels of a partially-settled subject", async ({
    skip,
  }) => {
    if (!ready(skip)) return;

    // The failure the redesign exists for: in-app delivered, email failed. The
    // subject must come back so the email retries, carrying the fact that
    // in-app is already done so the retry does not re-nudge.
    await seedClaim(dateAtStart, null, humanA, "in_app", CLAIM_NOW, NOW);
    await seedClaim(dateAtStart, null, humanA, "push", CLAIM_NOW, NOW);
    await seedClaim(dateAtStart, null, humanA, "email", EPOCH);
    // A channel written by a future build that this one cannot name must not
    // widen the port's union by lying; it is dropped.
    await seedClaim(dateAtStart, null, humanA, "carrier_pigeon", CLAIM_NOW, NOW);

    const repo = makeRsvpRemindersRepo(prisma!);
    const candidate = (await repo.findDue(FIND)).find(
      (c) => c.eventDateId === dateAtStart && c.humanId === humanA,
    );
    expect(candidate).toBeDefined();
    expect([...candidate!.settledChannels].sort()).toEqual(["in_app", "push"]);

    // Never NULL — the COALESCE in the query, observed.
    const untouched = (await repo.findDue(FIND)).find(
      (c) => c.eventDateId === dateMid,
    );
    expect(untouched!.settledChannels).toEqual([]);
  }, 60_000);

  test("a CALLED-OFF occurrence is dropped while its twin at the SAME instant is kept", async ({
    skip,
  }) => {
    if (!ready(skip)) return;

    // `dateCancelled` and `dateMid` start at the identical instant and belong
    // to the same event; humanA has RSVP'd to both at the same createdAt. STATUS
    // is therefore the only variable, so this cannot pass for the wrong reason
    // the way a cancelled date parked outside the window would.
    const { rows: starts } = await pool!.query<{ same: boolean; a: string; b: string }>(
      `SELECT (a."startsAt" = b."startsAt") AS same,
              a."status"::text AS a, b."status"::text AS b
       FROM "EventDate" a, "EventDate" b WHERE a."id" = $1 AND b."id" = $2`,
      [dateMid, dateCancelled],
    );
    expect(starts[0]!.same).toBe(true);
    expect(starts[0]!.a).toBe("SCHEDULED");
    expect(starts[0]!.b).toBe("CANCELLED");

    const repo = makeRsvpRemindersRepo(prisma!);
    let keys = (await repo.findDue(FIND)).map(keyOf);
    expect(keys).toContain(`${dateMid}|${humanA}`);
    expect(keys).not.toContain(`${dateCancelled}|${humanA}`);

    // And the filter is not a blanket one: flipping the status back makes the
    // very same row a candidate.
    await pool!.query(
      `UPDATE "EventDate" SET "status" = 'SCHEDULED' WHERE "id" = $1`,
      [dateCancelled],
    );
    try {
      keys = (await repo.findDue(FIND)).map(keyOf);
      expect(keys).toContain(`${dateCancelled}|${humanA}`);
    } finally {
      await pool!.query(
        `UPDATE "EventDate" SET "status" = 'CANCELLED' WHERE "id" = $1`,
        [dateCancelled],
      );
    }
  }, 60_000);

  test("the window is inclusive at the start and exclusive at the end", async ({
    skip,
  }) => {
    if (!ready(skip)) return;

    const repo = makeRsvpRemindersRepo(prisma!);

    // Boundary instants survive the round-trip through bound parameters into
    // `timestamp(3)` comparisons — the half-open interval is what stops a
    // date being reminded twice by two adjacent ticks, or skipped by both.
    const atStart = await repo.findDue(FIND);
    expect(atStart.some((c) => c.eventDateId === dateAtStart)).toBe(true);
    expect(atStart.some((c) => c.eventDateId === dateAtEnd)).toBe(false);

    // Shift the window up by an hour: the old upper bound is now interior.
    const shifted = await repo.findDue({
      ...FIND,
      windowStart: new Date(WINDOW_START.getTime() + HOUR_MS),
      windowEnd: new Date(WINDOW_END.getTime() + HOUR_MS),
    });
    expect(shifted.some((c) => c.eventDateId === dateAtEnd)).toBe(true);
    expect(shifted.some((c) => c.eventDateId === dateAtStart)).toBe(false);
  }, 60_000);

  test("findDue carries the OCCURRENCE's own start/end, its parent event, and the RSVP's createdAt", async ({
    skip,
  }) => {
    if (!ready(skip)) return;

    const repo = makeRsvpRemindersRepo(prisma!);
    const due = await repo.findDue(FIND);

    const perDate = due.find(
      (c) => c.eventDateId === dateMid && c.humanId === humanA,
    );
    expect(perDate).toBeDefined();
    // Resolved THROUGH the date — the ledger row won't carry it, but the
    // reminder's copy and links need it.
    expect(perDate!.eventId).toBe(recurringEventId);
    expect(perDate!.startsAt.toISOString()).toBe(MID_WINDOW.toISOString());
    expect(perDate!.endsAt?.toISOString()).toBe(
      new Date(MID_WINDOW.getTime() + 2 * HOUR_MS).toISOString(),
    );
    expect(perDate!.rsvpCreatedAt.toISOString()).toBe(RSVP_EARLY.toISOString());

    const eventLevel = due.find(
      (c) => c.eventDateId === null && c.humanId === humanA,
    );
    expect(eventLevel!.eventId).toBe(singleEventId);
    expect(eventLevel!.startsAt.toISOString()).toBe(MID_WINDOW.toISOString());
    expect(eventLevel!.endsAt?.toISOString()).toBe(
      new Date(MID_WINDOW.getTime() + 2 * HOUR_MS).toISOString(),
    );
  }, 60_000);

  test("a NULL occurrence endsAt survives the UNION as null, not as the event's", async ({
    skip,
  }) => {
    if (!ready(skip)) return;

    // Occurrences carry their own duration or none; backfilling the parent's
    // would make the reminder claim an end time nobody set.
    await pool!.query(`UPDATE "EventDate" SET "endsAt" = NULL WHERE "id" = $1`, [
      dateMid,
    ]);
    try {
      const repo = makeRsvpRemindersRepo(prisma!);
      const perDate = (await repo.findDue(FIND)).find(
        (c) => c.eventDateId === dateMid,
      );
      expect(perDate).toBeDefined();
      expect(perDate!.endsAt).toBeNull();
    } finally {
      await pool!.query(`UPDATE "EventDate" SET "endsAt" = $2 WHERE "id" = $1`, [
        dateMid,
        new Date(MID_WINDOW.getTime() + 2 * HOUR_MS),
      ]);
    }
  }, 60_000);

  test("results are soonest-first, with a deterministic (eventId, humanId) tie-break", async ({
    skip,
  }) => {
    if (!ready(skip)) return;

    const repo = makeRsvpRemindersRepo(prisma!);
    const due = await repo.findDue(FIND);
    expect(due.length).toBeGreaterThan(1);

    for (let i = 1; i < due.length; i += 1) {
      const prev = due[i - 1]!;
      const cur = due[i]!;
      expect(prev.startsAt.getTime()).toBeLessThanOrEqual(cur.startsAt.getTime());
      if (prev.startsAt.getTime() === cur.startsAt.getTime()) {
        // ids are fixed-width uuids, so concatenation orders like the tuple.
        expect(
          `${prev.eventId}|${prev.humanId}` <= `${cur.eventId}|${cur.humanId}`,
        ).toBe(true);
      }
    }
  }, 60_000);

  test("the batch limit caps the result set and keeps the soonest rows", async ({
    skip,
  }) => {
    if (!ready(skip)) return;

    const repo = makeRsvpRemindersRepo(prisma!);

    const one = await repo.findDue({ ...FIND, limit: 1 });
    expect(one).toHaveLength(1);
    expect(one[0]!.startsAt.toISOString()).toBe(AT_WINDOW_START.toISOString());

    // The three soonest are all on the boundary date; the limit must not slice
    // arbitrarily across the ORDER BY.
    const three = await repo.findDue({ ...FIND, limit: 3 });
    expect(three).toHaveLength(3);
    expect(three.map((c) => c.eventDateId)).toEqual([
      dateAtStart,
      dateAtStart,
      dateAtStart,
    ]);

    expect(await repo.findDue(FIND)).toHaveLength(6);
  }, 60_000);

  test("a settled backlog cannot starve the limit", async ({ skip }) => {
    if (!ready(skip)) return;

    // The reason the settled/outstanding test is IN the query rather than a
    // client-side subtraction: with the three boundary-date reminders already
    // settled, a limit of 3 must still return three OUTSTANDING candidates, not
    // three filtered-away rows.
    const repo = makeRsvpRemindersRepo(prisma!);
    for (const humanId of [humanA, humanB, humanC]) {
      await seedClaim(dateAtStart, null, humanId, "email", CLAIM_NOW, NOW);
    }

    const due = await repo.findDue({ ...FIND, limit: 3 });
    expect(due).toHaveLength(3);
    expect(due.map(keyOf).sort()).toEqual(
      [
        `${dateMid}|${humanA}`,
        `event:${singleEventId}|${humanA}`,
        `event:${singleEventId}|${humanB}`,
      ].sort(),
    );
  }, 60_000);

  test("withdrawing the RSVP removes the candidate (no filter needed)", async ({
    skip,
  }) => {
    if (!ready(skip)) return;

    const repo = makeRsvpRemindersRepo(prisma!);

    // Cancelling an RSVP DELETES the row, which is why the query needs no
    // "still going?" predicate.
    await prisma!.eventDateRsvp.delete({
      where: {
        eventDateId_humanId: { eventDateId: dateMid, humanId: humanA },
      },
    });
    try {
      const due = await repo.findDue(FIND);
      expect(due.map(keyOf)).not.toContain(`${dateMid}|${humanA}`);
      expect(due).toHaveLength(5);
    } finally {
      await prisma!.eventDateRsvp.create({
        data: {
          eventDateId: dateMid,
          humanId: humanA,
          createdAt: RSVP_EARLY,
        },
      });
    }
  }, 60_000);

  test("unpublishing the listing drops its candidates mid-window", async ({
    skip,
  }) => {
    if (!ready(skip)) return;

    const repo = makeRsvpRemindersRepo(prisma!);

    await pool!.query(`UPDATE "Event" SET "status" = 'CANCELLED' WHERE "id" = $1`, [
      recurringEventId,
    ]);
    try {
      const due = await repo.findDue(FIND);
      // Only the single-date listing's two event-level RSVPs remain.
      expect(due.map(keyOf).sort()).toEqual(
        [
          `event:${singleEventId}|${humanA}`,
          `event:${singleEventId}|${humanB}`,
        ].sort(),
      );
    } finally {
      await pool!.query(
        `UPDATE "Event" SET "status" = 'PUBLISHED' WHERE "id" = $1`,
        [recurringEventId],
      );
    }
  }, 60_000);

  test("deleting the date cascades its ledger rows away", async ({ skip }) => {
    if (!ready(skip)) return;

    // No retention job exists for this table; the FK cascade is the only
    // cleanup, so it has to actually be there.
    const repo = makeRsvpRemindersRepo(prisma!);
    const scratch = await prisma!.eventDate.create({
      data: {
        eventId: recurringEventId,
        ordinal: 99,
        startsAt: MID_WINDOW,
        endsAt: new Date(MID_WINDOW.getTime() + HOUR_MS),
        status: "SCHEDULED",
      },
    });

    expect(
      await repo.claim({
        eventDateId: scratch.id,
        eventId: recurringEventId,
        humanId: humanA,
        channels: ["email", "in_app"],
        now: CLAIM_NOW,
        staleClaimBefore: STALE_BEFORE,
      }),
    ).toEqual(["email", "in_app"]);

    await prisma!.eventDate.delete({ where: { id: scratch.id } });

    const { rows } = await pool!.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM "RsvpReminder" WHERE "eventDateId" = $1`,
      [scratch.id],
    );
    expect(rows[0]!.n).toBe("0");
  }, 60_000);
});
