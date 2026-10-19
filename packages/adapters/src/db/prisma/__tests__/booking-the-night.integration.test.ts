import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

import { runSavedSnippetsContract } from "@th/test-utils/contracts/saved-snippets";
import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { makeAgreementsRepo } from "../agreements";
import { makeBookingHoldsRepo } from "../booking-holds";
import { makeSavedSnippetsRepo } from "../saved-snippets";

// ---------------------------------------------------------------------------
// Real-Postgres coverage for migrations 20261001140000_booking_the_night and
// 20261001150000_saved_snippet_list (booking-the-night spec,
// docs/specs/2026-09-25: FR-002, FR-009, FR-013).
//
// The FULL migration set is applied to a throwaway container, so this also
// proves the new migration applies on top of everything before it, and the
// enum / column / FK names are the real ones.
//
//   1. SavedSnippet — the shared repo contract (the same suite the fake runs),
//      plus the SQL-only facts: VarChar bounds, the non-empty CHECK, a
//      reorder inside an interactive transaction, and the list lock
//      (two transactions on one list serialise).
//   2. Agreement.sentForReviewByHumanId — stamped by the guarded status
//      write only when the CAS wins; FK to Human (a missing human maps to a
//      conflict), ON DELETE SET NULL.
//   3. BookingHoldReleaseReason.BOOKING_CANCELLED — a CONFIRMED hold can be
//      released with it, and it maps back through the adapter.
//   4. BookingHoldsRepo.listLineWithTerms — the line plus each request's
//      terms.
//
// FK triggers on BookingRequest and BookingHold are disabled so fixtures need
// no Place / Calendar graph — nothing under test joins through those FKs.
// Agreement's FKs stay ON (the SetNull under test lives on Human's side).
// Seed timestamps are ISO strings in raw SQL (node-pg serialises a Date as
// LOCAL wall-clock).
// ---------------------------------------------------------------------------

const HUMAN = "b0b0b0b0-0000-4000-8000-000000000001";
const OTHER_HUMAN = "b0b0b0b0-0000-4000-8000-000000000002";
const CALENDAR = "b0b0b0b0-0000-4000-8000-0000000000ca";
const PLACE = "b0b0b0b0-0000-4000-8000-0000000000f1";
const VENUE_ORG = "b0b0b0b0-0000-4000-8000-0000000000aa";
const SENDER = "b0b0b0b0-0000-4000-8000-0000000000bb";

describe("booking the night — schema + adapters (integration)", () => {
  let pgContainer: PostgresTestContainer | undefined;
  let pool: pg.Pool | undefined;
  let prisma: PrismaClient | undefined;

  beforeAll(async () => {
    pgContainer = await startPostgresContainer();
    await runPrismaMigrateDeploy(pgContainer.databaseUrl);
    pool = new pg.Pool({ connectionString: pgContainer.connectionUri });
    await pool.query(`ALTER TABLE "BookingRequest" DISABLE TRIGGER ALL`);
    await pool.query(`ALTER TABLE "BookingHold" DISABLE TRIGGER ALL`);
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  }, 600_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
    await pgContainer?.stop();
  });

  async function insertHuman(id: string) {
    await pool!.query(
      `INSERT INTO "Human" ("id", "updatedAt") VALUES ($1, '2026-10-01T00:00:00.000Z')
       ON CONFLICT ("id") DO NOTHING`,
      [id],
    );
  }

  async function createAgreement(proposedDate: Date | null = null) {
    return makeAgreementsRepo(prisma!).create({
      type: "PERFORMANCE",
      proposerType: "human",
      proposerId: SENDER,
      counterpartyType: "organization",
      counterpartyId: VENUE_ORG,
      title: "Booking",
      proposedDate,
    });
  }

  async function insertRequest(agreementId: string | null) {
    const id = crypto.randomUUID();
    await pool!.query(
      `INSERT INTO "BookingRequest"
         ("id", "placeId", "calendarId", "performerOwnerType", "performerOwnerId",
          "message", "agreementId", "updatedAt")
       VALUES ($1, $2, $3, 'human', $4, 'pitch', $5, '2026-10-01T00:00:00.000Z')`,
      [id, PLACE, CALENDAR, crypto.randomUUID(), agreementId],
    );
    return id;
  }

  async function insertHold(
    bookingRequestId: string,
    date: string,
    position: number,
    status: "ACTIVE" | "CONFIRMED" = "ACTIVE",
  ) {
    const id = crypto.randomUUID();
    await pool!.query(
      `INSERT INTO "BookingHold"
         ("id", "bookingRequestId", "calendarId", "date", "position", "status",
          "placedByHumanId", "confirmedAt", "updatedAt")
       VALUES ($1, $2, $3, $4::date, $5, $6::"BookingHoldStatus", $7, $8,
               '2026-10-01T00:00:00.000Z')`,
      [
        id,
        bookingRequestId,
        CALENDAR,
        date,
        position,
        status,
        HUMAN,
        status === "CONFIRMED" ? "2026-10-01T00:00:00.000Z" : null,
      ],
    );
    return id;
  }

  // ── 1. SavedSnippet ────────────────────────────────────────────────────────

  runSavedSnippetsContract("Prisma adapter on Postgres", async () => {
    await pool!.query(`TRUNCATE "SavedSnippet", "SavedSnippetList"`);
    return makeSavedSnippetsRepo(prisma!);
  });

  describe("SavedSnippet — SQL-only facts", () => {
    const OWNER = { ownerType: "HUMAN", ownerId: HUMAN } as const;

    test("the VarChar bounds hold at 60 / 500 and refuse one more", async () => {
      await pool!.query(`TRUNCATE "SavedSnippet"`);
      const repo = makeSavedSnippetsRepo(prisma!);
      await expect(
        repo.create({
          ...OWNER,
          kind: "DECLINE_REASON",
          label: "l".repeat(60),
          body: "b".repeat(500),
        }),
      ).resolves.toMatchObject({ label: "l".repeat(60) });
      await expect(
        repo.create({
          ...OWNER,
          kind: "DECLINE_REASON",
          label: "l".repeat(61),
          body: "b",
        }),
      ).rejects.toThrow();
      await expect(
        repo.create({
          ...OWNER,
          kind: "DECLINE_REASON",
          label: "l",
          body: "b".repeat(501),
        }),
      ).rejects.toThrow();
    });

    test("the non-empty CHECK is the one refusing an empty label", async () => {
      await expect(
        pool!.query(
          `INSERT INTO "SavedSnippet" ("id", "ownerType", "ownerId", "kind", "label", "body", "updatedAt")
           VALUES ($1, 'HUMAN', $2, 'DECLINE_REASON', '', 'b', now())`,
          [crypto.randomUUID(), HUMAN],
        ),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "SavedSnippet_nonempty_check",
      });
    });

    test("reorder runs inside an interactive transaction (its intended home)", async () => {
      await pool!.query(`TRUNCATE "SavedSnippet"`);
      const repo = makeSavedSnippetsRepo(prisma!);
      const a = await repo.create({
        ...OWNER,
        kind: "DECLINE_REASON",
        label: "a",
        body: "a",
        sortOrder: 0,
      });
      const b = await repo.create({
        ...OWNER,
        kind: "DECLINE_REASON",
        label: "b",
        body: "b",
        sortOrder: 1,
      });
      const out = await prisma!.$transaction((tx) =>
        makeSavedSnippetsRepo(tx).reorder({
          ...OWNER,
          kind: "DECLINE_REASON",
          orderedIds: [b.id, a.id],
        }),
      );
      expect(out.map((r) => r.label)).toEqual(["b", "a"]);
    });
  });

  describe("SavedSnippetList — the list lock", () => {
    const LIST = {
      ownerType: "ORGANIZATION",
      ownerId: VENUE_ORG,
      kind: "DECLINE_REASON",
    } as const;

    /** A promise plus its resolver, to hold a transaction open on purpose. */
    function gate() {
      let open!: () => void;
      const opened = new Promise<void>((resolve) => {
        open = resolve;
      });
      return { open, opened };
    }

    /** Is any backend in this database waiting on a row/tuple lock right now? */
    async function someoneWaitsOnALock(): Promise<boolean> {
      const { rows } = await pool!.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'`,
      );
      return rows[0]!.n > 0;
    }

    async function waitUntil(check: () => Promise<boolean>, ms = 5_000) {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        if (await check()) return;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error("timed out waiting for the second transaction to block");
    }

    /**
     * Tx A locks the list and stays open; tx B calls lockList on the same
     * list. B must be seen WAITING on a lock while A is open, must not
     * finish before A commits, and must then read A's committed write.
     */
    async function assertSerialises() {
      const order: string[] = [];
      const releaseA = gate();
      const aLocked = gate();
      const at = new Date("2026-10-01T09:00:00.000Z");

      const txA = prisma!.$transaction(
        async (tx) => {
          const repo = makeSavedSnippetsRepo(tx);
          await repo.lockList(LIST);
          order.push("A locked");
          aLocked.open();
          await releaseA.opened;
          await repo.markStartersCopied(LIST, at);
          order.push("A commits");
        },
        { timeout: 20_000 },
      );

      await aLocked.opened;
      let bState: { startersCopiedAt: Date | null } | undefined;
      const txB = prisma!.$transaction(
        async (tx) => {
          bState = await makeSavedSnippetsRepo(tx).lockList(LIST);
          order.push("B locked");
        },
        { timeout: 20_000 },
      );

      // B is parked on A's lock — not done, and Postgres says it is waiting.
      await waitUntil(someoneWaitsOnALock);
      expect(order).toEqual(["A locked"]);

      releaseA.open();
      await Promise.all([txA, txB]);
      expect(order).toEqual(["A locked", "A commits", "B locked"]);
      // B read the state A committed (READ COMMITTED re-reads the locked row).
      expect(bState!.startersCopiedAt!.toISOString()).toBe(at.toISOString());
    }

    test("two transactions on an EXISTING list serialise on its row", async () => {
      await pool!.query(`TRUNCATE "SavedSnippet", "SavedSnippetList"`);
      // Create the row up front, committed.
      await prisma!.$transaction((tx) => makeSavedSnippetsRepo(tx).lockList(LIST));
      await assertSerialises();
    }, 30_000);

    test("two transactions on a list with NO row yet still serialise (the insert waits)", async () => {
      await pool!.query(`TRUNCATE "SavedSnippet", "SavedSnippetList"`);
      await assertSerialises();
      const { rows } = await pool!.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM "SavedSnippetList"`,
      );
      expect(rows[0]!.n).toBe(1);
    }, 30_000);

    test("another list is NOT blocked by an open lock", async () => {
      await pool!.query(`TRUNCATE "SavedSnippet", "SavedSnippetList"`);
      const releaseA = gate();
      const aLocked = gate();
      const txA = prisma!.$transaction(
        async (tx) => {
          await makeSavedSnippetsRepo(tx).lockList(LIST);
          aLocked.open();
          await releaseA.opened;
        },
        { timeout: 20_000 },
      );
      await aLocked.opened;
      // Same owner, other kind; and the same list key under another owner.
      await prisma!.$transaction(async (tx) => {
        const repo = makeSavedSnippetsRepo(tx);
        await repo.lockList({ ...LIST, kind: "ASK" });
        await repo.lockList({ ...LIST, ownerId: SENDER });
      });
      releaseA.open();
      await txA;
    }, 30_000);

    test("startersCopiedAt keeps its instant through the Prisma DateTime mapping", async () => {
      await pool!.query(`TRUNCATE "SavedSnippet", "SavedSnippetList"`);
      const at = new Date("2026-10-01T23:59:59.123Z");
      const state = await prisma!.$transaction(async (tx) => {
        const repo = makeSavedSnippetsRepo(tx);
        await repo.lockList(LIST);
        await repo.markStartersCopied(LIST, at);
        return repo.lockList(LIST);
      });
      expect(state.startersCopiedAt!.toISOString()).toBe(at.toISOString());
      const { rows } = await pool!.query<{ v: string }>(
        `SELECT to_char("startersCopiedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS v FROM "SavedSnippetList"`,
      );
      // Stored as the UTC wall clock, like every other Prisma timestamp.
      expect(rows[0]!.v).toBe("2026-10-01T23:59:59.123");
    });
  });

  // ── 2. Agreement.sentForReviewByHumanId ──────────────────────────────────

  describe("Agreement.sentForReviewByHumanId", () => {
    test("is null on create, stamped by the send's guarded write", async () => {
      await insertHuman(HUMAN);
      const repo = makeAgreementsRepo(prisma!);
      const created = await createAgreement();
      expect(created.sentForReviewByHumanId).toBeNull();

      const sent = await repo.updateStatus({
        id: created.id,
        status: "PROPOSED",
        expectedFrom: ["DRAFT"],
        sentForReviewByHumanId: HUMAN,
      });
      expect(sent.sentForReviewByHumanId).toBe(HUMAN);

      // Another transition that omits it leaves it alone (return to draft).
      const back = await repo.updateStatus({
        id: created.id,
        status: "DRAFT",
        expectedFrom: ["PROPOSED"],
      });
      expect(back.status).toBe("DRAFT");
      expect(back.sentForReviewByHumanId).toBe(HUMAN);
    });

    test("a send that loses its CAS stamps nothing", async () => {
      await insertHuman(HUMAN);
      await insertHuman(OTHER_HUMAN);
      const repo = makeAgreementsRepo(prisma!);
      const created = await createAgreement();
      await repo.updateStatus({
        id: created.id,
        status: "PROPOSED",
        expectedFrom: ["DRAFT"],
        sentForReviewByHumanId: HUMAN,
      });
      await expect(
        repo.updateStatus({
          id: created.id,
          status: "PROPOSED",
          expectedFrom: ["DRAFT"],
          sentForReviewByHumanId: OTHER_HUMAN,
        }),
      ).rejects.toMatchObject({
        code: "conflict",
        message: "agreement_status_changed",
      });
      expect((await repo.getById(created.id))!.sentForReviewByHumanId).toBe(
        HUMAN,
      );
    });

    test("references Human: unknown ids are refused, deletion sets it NULL", async () => {
      const doomed = crypto.randomUUID();
      await insertHuman(doomed);
      const repo = makeAgreementsRepo(prisma!);
      const created = await createAgreement();

      // A human deleted mid-send: the FK refuses, and the adapter maps it to
      // a conflict (not a raw Prisma error → 500). Nothing is written.
      await expect(
        repo.updateStatus({
          id: created.id,
          status: "PROPOSED",
          expectedFrom: ["DRAFT"],
          sentForReviewByHumanId: crypto.randomUUID(),
        }),
      ).rejects.toMatchObject({
        code: "conflict",
        message: "agreement_sender_missing",
      });
      expect((await repo.getById(created.id))!.status).toBe("DRAFT");

      await repo.updateStatus({
        id: created.id,
        status: "PROPOSED",
        expectedFrom: ["DRAFT"],
        sentForReviewByHumanId: doomed,
      });
      await pool!.query(`DELETE FROM "Human" WHERE "id" = $1`, [doomed]);
      const after = await repo.getById(created.id);
      expect(after).not.toBeNull();
      expect(after!.status).toBe("PROPOSED");
      expect(after!.sentForReviewByHumanId).toBeNull();
    });
  });

  // ── 3. BOOKING_CANCELLED ──────────────────────────────────────────────────

  test("a CONFIRMED hold can be released with BOOKING_CANCELLED", async () => {
    await insertHuman(HUMAN);
    const requestId = await insertRequest(null);
    const holdId = await insertHold(requestId, "2026-11-20", 1, "CONFIRMED");
    const released = await makeBookingHoldsRepo(prisma!).updateStatus({
      id: holdId,
      status: "RELEASED",
      expectedFrom: ["CONFIRMED"],
      releasedAt: new Date("2026-11-01T00:00:00.000Z"),
      releasedReason: "BOOKING_CANCELLED",
    });
    expect(released).toMatchObject({
      status: "RELEASED",
      releasedReason: "BOOKING_CANCELLED",
      confirmedAt: null,
    });
    const { rows } = await pool!.query<{ releasedReason: string }>(
      `SELECT "releasedReason"::text AS "releasedReason" FROM "BookingHold" WHERE "id" = $1`,
      [holdId],
    );
    expect(rows[0]!.releasedReason).toBe("BOOKING_CANCELLED");
  });

  // ── 4. listLineWithTerms ──────────────────────────────────────────────────

  test("listLineWithTerms returns the line with each request's terms", async () => {
    await insertHuman(HUMAN);
    const date = "2026-12-04";
    const night = new Date("2026-12-05T02:00:00.000Z");
    const ready = await createAgreement(night);
    const withTerms = await insertRequest(ready.id);
    const withoutTerms = await insertRequest(null);
    const winner = await insertRequest(null);

    const second = await insertHold(withTerms, date, 2);
    const first = await insertHold(withoutTerms, date, 1);
    const booked = await insertHold(winner, date, 3, "CONFIRMED");
    // Another night on the same calendar stays out of the read.
    await insertHold(withTerms, "2026-12-05", 1);

    const repo = makeBookingHoldsRepo(prisma!);
    const live = await repo.listLineWithTerms({ calendarId: CALENDAR, date });
    expect(live.map((h) => [h.id, h.position, h.terms])).toEqual([
      [first, 1, null],
      [
        second,
        2,
        { agreementId: ready.id, status: "DRAFT", proposedDate: night },
      ],
    ]);
    // Same rows, same order as listLine.
    expect(live.map(({ terms: _t, ...h }) => h)).toEqual(
      await repo.listLine({ calendarId: CALENDAR, date }),
    );

    const widened = await repo.listLineWithTerms({
      calendarId: CALENDAR,
      date,
      statuses: ["ACTIVE", "CHALLENGED", "CONFIRMED"],
    });
    expect(widened.map((h) => [h.id, h.status])).toEqual([
      [first, "ACTIVE"],
      [second, "ACTIVE"],
      [booked, "CONFIRMED"],
    ]);
  });
});
