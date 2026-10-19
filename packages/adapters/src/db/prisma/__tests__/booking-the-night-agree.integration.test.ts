import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

import {
  assertTermsNightFreeInTx,
  assessNight,
} from "@th/core/use-cases/booking-holds/_shared/booking-night";
import { settleLine } from "@th/core/use-cases/booking-holds/_shared/settle-lapsed-holds";
import { takeLine } from "@th/core/use-cases/booking-holds/_shared/take-line";
import { takeNightForTermsInTx } from "@th/core/use-cases/booking-holds/_shared/take-night-for-terms";
import { takeManualMintNightInTx } from "@th/core/use-cases/booking-agreements/create-event-from-agreement";
import type { Repos } from "@th/ports/repos";
import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { createPrismaRepos } from "../index";
import { makeAgreementsRepo } from "../agreements";

// ---------------------------------------------------------------------------
// booking-the-night FR-001 / NFR-001 on REAL Postgres: the agree's line lock
// is the transaction advisory lock every hold mutation takes
// (`pg_advisory_xact_lock(hashtext('booking_hold_line:' || cal || '|' ||
// date))`). The core suite stages these races on fakes; here the lock itself
// does the serialising:
//
//   1. two senders agree terms for the SAME night: the second waits on the
//      first's lock (Postgres reports it waiting), then reads the first's
//      CONFIRMED hold and is refused — one CONFIRMED hold, one ACCEPTED set
//      of terms;
//   2. the venue's line take for ANOTHER request (settleLine + takeLine, the
//      book-without-terms transaction body) holds the lock while the agree
//      waits — the agree is refused, nothing of its own written;
//   3. send vs agree: the agree holds the lock, the send's N6 check waits on
//      it, then sees the night booked and refuses NIGHT_TAKEN;
//   4. a pull-back commits while the agree waits — the agree's locked
//      re-read sees DRAFT and refuses; nothing booked;
//   5. two manual "Create event" bookings of ONE request with agreed terms
//      and no hold yet (review round 3 W1): both lock the same line, the
//      second waits, then finds the night already its own — one CONFIRMED
//      hold, one `booking_hold.confirmed` entry.
//
// The full use case is not run here (its mint needs the whole event graph);
// `takeNightForTermsInTx` IS the agree's transaction body, run through the
// production `repos.tx` on the production adapters.
//
// FK triggers on BookingRequest and BookingHold are disabled so fixtures need
// no Place / Calendar graph. Seed timestamps are ISO strings in raw SQL.
// ---------------------------------------------------------------------------

const STAFF = "c0c0c0c0-0000-4000-8000-000000000001";
const ACT_A = "c0c0c0c0-0000-4000-8000-00000000000a";
const ACT_B = "c0c0c0c0-0000-4000-8000-00000000000b";
const VENUE_ORG = "c0c0c0c0-0000-4000-8000-0000000000aa";
const PLACE = "c0c0c0c0-0000-4000-8000-0000000000f1";
const CALENDAR = "c0c0c0c0-0000-4000-8000-0000000000ca";
const TZ = "America/Chicago";
const NIGHT = "2026-11-20";
/** 20:00 CST on NIGHT. */
const NIGHT_AT = new Date("2026-11-21T02:00:00.000Z");
const NOW = new Date("2026-11-01T12:00:00.000Z");
const KEY = { calendarId: CALENDAR, date: NIGHT };

describe("agree & book — the real line lock (integration)", () => {
  let pgContainer: PostgresTestContainer | undefined;
  let pool: pg.Pool | undefined;
  let prisma: PrismaClient | undefined;
  let repos: Repos;

  beforeAll(async () => {
    pgContainer = await startPostgresContainer();
    await runPrismaMigrateDeploy(pgContainer.databaseUrl);
    pool = new pg.Pool({ connectionString: pgContainer.connectionUri });
    await pool.query(`ALTER TABLE "BookingRequest" DISABLE TRIGGER ALL`);
    await pool.query(`ALTER TABLE "BookingHold" DISABLE TRIGGER ALL`);
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
    repos = createPrismaRepos(prisma);
    for (const id of [STAFF, ACT_A, ACT_B]) {
      await pool.query(
        `INSERT INTO "Human" ("id", "updatedAt") VALUES ($1, '2026-11-01T00:00:00.000Z')
         ON CONFLICT ("id") DO NOTHING`,
        [id],
      );
    }
  }, 600_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
    await pgContainer?.stop();
  });

  beforeEach(async () => {
    await pool!.query(`TRUNCATE "BookingHold", "BookingRequestMessage" CASCADE`);
    await pool!.query(`DELETE FROM "BookingRequest"`);
  });

  /** DRAFT terms for NIGHT (not yet sent) and the ACCEPTED request they hang off. */
  async function draftTerms(act: string) {
    const created = await makeAgreementsRepo(prisma!).create({
      type: "PERFORMANCE",
      proposerType: "human",
      proposerId: act,
      counterpartyType: "organization",
      counterpartyId: VENUE_ORG,
      title: "Friday at the venue",
      proposedDate: NIGHT_AT,
    });
    const requestId = crypto.randomUUID();
    await pool!.query(
      `INSERT INTO "BookingRequest"
         ("id", "placeId", "calendarId", "performerOwnerType", "performerOwnerId",
          "message", "agreementId", "status", "updatedAt")
       VALUES ($1, $2, $3, 'human', $4, 'pitch', $5, 'ACCEPTED', '2026-11-01T00:00:00.000Z')`,
      [requestId, PLACE, CALENDAR, act, created.id],
    );
    return { agreementId: created.id, requestId };
  }

  /** PROPOSED terms for NIGHT, sent by STAFF, and the ACCEPTED request they hang off. */
  async function proposedTerms(act: string) {
    const agreements = makeAgreementsRepo(prisma!);
    const created = await agreements.create({
      type: "PERFORMANCE",
      proposerType: "human",
      proposerId: act,
      counterpartyType: "organization",
      counterpartyId: VENUE_ORG,
      title: "Friday at the venue",
      proposedDate: NIGHT_AT,
    });
    await agreements.updateStatus({
      id: created.id,
      status: "PROPOSED",
      expectedFrom: ["DRAFT"],
      proposedAt: NOW,
      sentForReviewByHumanId: STAFF,
    });
    const requestId = crypto.randomUUID();
    await pool!.query(
      `INSERT INTO "BookingRequest"
         ("id", "placeId", "calendarId", "performerOwnerType", "performerOwnerId",
          "message", "agreementId", "status", "updatedAt")
       VALUES ($1, $2, $3, 'human', $4, 'pitch', $5, 'ACCEPTED', '2026-11-01T00:00:00.000Z')`,
      [requestId, PLACE, CALENDAR, act, created.id],
    );
    return { agreementId: created.id, requestId };
  }

  async function insertHold(
    bookingRequestId: string,
    position: number,
    status: "ACTIVE" | "CONFIRMED" = "ACTIVE",
  ) {
    const id = crypto.randomUUID();
    await pool!.query(
      `INSERT INTO "BookingHold"
         ("id", "bookingRequestId", "calendarId", "date", "position", "status",
          "placedByHumanId", "confirmedAt", "updatedAt")
       VALUES ($1, $2, $3, $4::date, $5, $6::"BookingHoldStatus", $7, $8,
               '2026-11-01T00:00:00.000Z')`,
      [
        id,
        bookingRequestId,
        CALENDAR,
        NIGHT,
        position,
        status,
        STAFF,
        status === "CONFIRMED" ? "2026-11-01T00:00:00.000Z" : null,
      ],
    );
    return id;
  }

  function agreeArgs(terms: { agreementId: string; requestId: string }, actor: string) {
    return {
      agreementId: terms.agreementId,
      bookingRequestId: terms.requestId,
      expectedProposedDate: NIGHT_AT,
      key: KEY,
      placeTz: TZ,
      now: NOW,
      actorHumanId: actor,
      actorSide: "PERFORMER" as const,
      placedByHumanId: STAFF,
    };
  }

  function gate() {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { open, opened };
  }

  /** Is any backend in this database waiting on an advisory lock right now? */
  async function someoneWaitsOnTheLineLock(): Promise<boolean> {
    const { rows } = await pool!.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database()
          AND wait_event_type = 'Lock' AND wait_event = 'advisory'`,
    );
    return rows[0]!.n > 0;
  }

  async function waitUntil(check: () => Promise<boolean>, ms = 10_000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("timed out waiting for the agree to block on the line lock");
  }

  /** Hold the night's line lock in a transaction until `release` opens. */
  function holdLineLock(during: () => Promise<void> = async () => {}) {
    const locked = gate();
    const release = gate();
    const done = repos.tx(
      async (tx) => {
        await tx.bookingHolds.lockLine(KEY);
        locked.open();
        await release.opened;
        await during();
      },
      { timeout: 30_000 },
    );
    return { locked: locked.opened, release: release.open, done };
  }

  async function nightRows() {
    const { rows } = await pool!.query<{ bookingRequestId: string; status: string }>(
      `SELECT "bookingRequestId", "status"::text AS status FROM "BookingHold"
        WHERE "calendarId" = $1 AND "date" = $2::date ORDER BY "position"`,
      [CALENDAR, NIGHT],
    );
    return rows;
  }

  async function statusOf(agreementId: string) {
    return (await makeAgreementsRepo(prisma!).getById(agreementId))!.status;
  }

  test("two senders agree the SAME night: the second waits on the first's lock, then is refused — one CONFIRMED hold", async () => {
    const a = await proposedTerms(ACT_A);
    const b = await proposedTerms(ACT_B);

    // A takes the line lock first and holds it open inside its transaction.
    const aLocked = gate();
    const aRelease = gate();
    const first = repos.tx(
      async (tx) => {
        await tx.bookingHolds.lockLine(KEY);
        aLocked.open();
        await aRelease.opened;
        // Re-entrant: the agree body takes the same lock again for free.
        return takeNightForTermsInTx(tx, agreeArgs(a, ACT_A));
      },
      { timeout: 30_000 },
    );
    await aLocked.opened;

    let secondSettled = false;
    const second = repos
      .tx((tx) => takeNightForTermsInTx(tx, agreeArgs(b, ACT_B)), { timeout: 30_000 })
      .finally(() => {
        secondSettled = true;
      });

    // B is parked on A's advisory lock — Postgres says so, and B has not finished.
    await waitUntil(someoneWaitsOnTheLineLock);
    expect(secondSettled).toBe(false);

    aRelease.open();
    const booked = await first;
    await expect(second).rejects.toMatchObject({ code: "NIGHT_NO_LONGER_AVAILABLE" });

    expect(booked.holdCreated).toBe(true);
    expect(await nightRows()).toEqual([{ bookingRequestId: a.requestId, status: "CONFIRMED" }]);
    expect(await statusOf(a.agreementId)).toBe("ACCEPTED");
    expect(await statusOf(b.agreementId)).toBe("PROPOSED");
  }, 60_000);

  test("the venue books ANOTHER request's hold on the night in a real transaction while the agree waits → the agree is refused, nothing of its own written", async () => {
    const a = await proposedTerms(ACT_A);
    const other = await proposedTerms(ACT_B);
    // A is FIRST in line: alone, the agree would book the night.
    const mine = await insertHold(a.requestId, 1);
    const otherHold = await insertHold(other.requestId, 2);

    // The competitor is a real transaction on the real adapters that takes
    // the lock first: the venue moves the other act up (renumberLine) and
    // books it the way book-without-terms does — settle → N6 → takeLine.
    // Only the lock decides who goes first.
    const venueLocked = gate();
    const venueRelease = gate();
    const venue = repos.tx(
      async (tx) => {
        await tx.bookingHolds.lockLine(KEY);
        venueLocked.open();
        await venueRelease.opened;
        await tx.bookingHolds.renumberLine({ ...KEY, orderedIds: [otherHold, mine] });
        const { line } = await settleLine(tx, { ...KEY, now: NOW, placeTz: TZ });
        const night = assessNight({
          line,
          confirmed: await tx.bookingHolds.listLine({ ...KEY, statuses: ["CONFIRMED"] }),
          bookingRequestId: other.requestId,
        });
        expect(night.kind).toBe("free");
        const winner = line.find((h) => h.id === otherHold)!;
        return takeLine(tx, {
          key: KEY,
          line,
          winner: { hold: winner, requestHolds: await tx.bookingHolds.listForRequest(other.requestId) },
          now: NOW,
          actorHumanId: STAFF,
        });
      },
      { timeout: 30_000 },
    );
    await venueLocked.opened;

    let agreeSettled = false;
    const agree = repos
      .tx((tx) => takeNightForTermsInTx(tx, agreeArgs(a, ACT_A)), { timeout: 30_000 })
      .finally(() => {
        agreeSettled = true;
      });
    // The agree is parked on the venue's advisory lock.
    await waitUntil(someoneWaitsOnTheLineLock);
    expect(agreeSettled).toBe(false);

    venueRelease.open();
    const taken = await venue;
    expect(taken.confirmed?.id).toBe(otherHold);

    await expect(agree).rejects.toMatchObject({ code: "NIGHT_NO_LONGER_AVAILABLE" });
    expect(await nightRows()).toEqual([
      { bookingRequestId: other.requestId, status: "CONFIRMED" },
      { bookingRequestId: a.requestId, status: "RELEASED" },
    ]);
    expect(await statusOf(a.agreementId)).toBe("PROPOSED");
    // Nothing on the agreeing request's thread but the venue's lost_date.
    const { rows } = await pool!.query<{ systemKind: string }>(
      `SELECT "systemKind" FROM "BookingRequestMessage" WHERE "bookingRequestId" = $1`,
      [a.requestId],
    );
    expect(rows.map((r) => r.systemKind)).toEqual(["booking_hold.released"]);
  }, 60_000);

  test("send vs agree on the same night: the agree holds the lock, the send waits, then sees the night booked → NIGHT_TAKEN; the other terms stay DRAFT", async () => {
    const a = await proposedTerms(ACT_A);
    const b = await draftTerms(ACT_B);

    const agreeLocked = gate();
    const agreeRelease = gate();
    const agree = repos.tx(
      async (tx) => {
        await tx.bookingHolds.lockLine(KEY);
        agreeLocked.open();
        await agreeRelease.opened;
        return takeNightForTermsInTx(tx, agreeArgs(a, ACT_A));
      },
      { timeout: 30_000 },
    );
    await agreeLocked.opened;

    // The send's own transaction body: the N6 check under the line lock, then
    // the guarded DRAFT → PROPOSED write that records the sender.
    let sendSettled = false;
    const send = repos
      .tx(
        async (tx) => {
          await assertTermsNightFreeInTx(
            tx,
            {
              key: KEY,
              bookingRequestId: b.requestId,
              placeTz: TZ,
              agreementId: b.agreementId,
              expectedProposedDate: NIGHT_AT,
            },
            NOW,
          );
          return tx.agreements.updateStatus({
            id: b.agreementId,
            status: "PROPOSED",
            expectedFrom: ["DRAFT"],
            proposedAt: NOW,
            sentForReviewByHumanId: STAFF,
          });
        },
        { timeout: 30_000 },
      )
      .finally(() => {
        sendSettled = true;
      });
    await waitUntil(someoneWaitsOnTheLineLock);
    expect(sendSettled).toBe(false);

    agreeRelease.open();
    await agree;
    await expect(send).rejects.toMatchObject({
      code: "NIGHT_TAKEN",
      meta: { date: NIGHT, booked: true, aheadHoldId: null },
    });
    expect(await nightRows()).toEqual([{ bookingRequestId: a.requestId, status: "CONFIRMED" }]);
    expect(await statusOf(b.agreementId)).toBe("DRAFT");
  }, 60_000);

  test("a pull-back commits while the agree waits on the lock → the locked re-read refuses; nothing booked", async () => {
    const a = await proposedTerms(ACT_A);
    const mine = await insertHold(a.requestId, 1);

    const venue = holdLineLock();
    await venue.locked;
    const agree = repos.tx((tx) => takeNightForTermsInTx(tx, agreeArgs(a, ACT_A)), {
      timeout: 30_000,
    });
    await waitUntil(someoneWaitsOnTheLineLock);
    // The venue pulls the terms back (its own autocommit write — pull-back
    // never takes the line lock; the agree's re-read under the lock is what
    // sees it).
    await makeAgreementsRepo(prisma!).updateStatus({
      id: a.agreementId,
      status: "DRAFT",
      expectedFrom: ["PROPOSED"],
    });
    venue.release();
    await venue.done;

    await expect(agree).rejects.toMatchObject({ code: "AGREEMENT_NOT_PROPOSED" });
    expect(await statusOf(a.agreementId)).toBe("DRAFT");
    const { rows } = await pool!.query<{ status: string }>(
      `SELECT "status"::text AS status FROM "BookingHold" WHERE "id" = $1`,
      [mine],
    );
    expect(rows[0]!.status).toBe("ACTIVE");
  }, 60_000);

  test("the happy path on real rows: own hold confirmed, the act behind loses the date, ledger written in the same transaction", async () => {
    const a = await proposedTerms(ACT_A);
    const b = await proposedTerms(ACT_B);
    const mine = await insertHold(a.requestId, 1);
    const behind = await insertHold(b.requestId, 2);

    const result = await repos.tx((tx) => takeNightForTermsInTx(tx, agreeArgs(a, ACT_A)));

    expect(result.hold.id).toBe(mine);
    expect(result.released.map((h) => h.id)).toEqual([behind]);
    expect(await nightRows()).toEqual([
      { bookingRequestId: a.requestId, status: "CONFIRMED" },
      { bookingRequestId: b.requestId, status: "RELEASED" },
    ]);
    expect(await statusOf(a.agreementId)).toBe("ACCEPTED");
    const { rows } = await pool!.query<{ systemKind: string; authorHumanId: string | null; bookingRequestId: string }>(
      `SELECT "systemKind", "authorHumanId", "bookingRequestId" FROM "BookingRequestMessage"
        ORDER BY "systemKind"`,
    );
    expect(rows).toEqual(
      expect.arrayContaining([
        { systemKind: "booking_agreement.accepted", authorHumanId: ACT_A, bookingRequestId: a.requestId },
        { systemKind: "booking_hold.confirmed", authorHumanId: ACT_A, bookingRequestId: a.requestId },
        // The act behind hears it from the venue side, never from ACT_A.
        { systemKind: "booking_hold.released", authorHumanId: STAFF, bookingRequestId: b.requestId },
      ]),
    );
  }, 60_000);
  test("two manual Create event bookings of ONE request with no hold yet: both lock the same line, the second waits, then finds the night its own — one CONFIRMED hold, one ledger entry", async () => {
    const a = await proposedTerms(ACT_A);
    await makeAgreementsRepo(prisma!).updateStatus({
      id: a.agreementId,
      status: "ACCEPTED",
      expectedFrom: ["PROPOSED"],
    });

    // The manual mint's REAL transaction body (`takeManualMintNightInTx`, the
    // one `bookManualMintNight` runs): the shared take on the venue side
    // with the mint's own in-lock status gate, then the ledger entry and
    // audit row when this call booked.
    const manualArgs = {
      bookingRequestId: a.requestId,
      agreementId: a.agreementId,
      key: KEY,
      placeTz: TZ,
      now: NOW,
      actorHumanId: STAFF,
    };
    const manualBooking = () =>
      repos.tx((tx) => takeManualMintNightInTx(tx, manualArgs), { timeout: 30_000 });

    // The first call holds the request's locks open inside its transaction —
    // in the production order, the booking lock (P2c) before the line lock —
    // then runs the same body (both locks are re-entrant). Taking the line
    // lock FIRST here would invert that order against the second call and
    // deadlock, which is exactly what the global order forbids.
    const firstLocked = gate();
    const firstRelease = gate();
    const first = repos.tx(
      async (tx) => {
        await tx.bookingHolds.lockRequestBooking(a.requestId);
        await tx.bookingHolds.lockLine(KEY);
        firstLocked.open();
        await firstRelease.opened;
        return takeManualMintNightInTx(tx, manualArgs);
      },
      { timeout: 30_000 },
    );
    await firstLocked.opened;

    let secondSettled = false;
    const second = manualBooking().finally(() => {
      secondSettled = true;
    });
    await waitUntil(someoneWaitsOnTheLineLock);
    expect(secondSettled).toBe(false);

    firstRelease.open();
    const booked = await first;
    const again = await second;

    expect(booked).toMatchObject({ holdCreated: true, alreadyBooked: false });
    expect(again).toMatchObject({ holdCreated: false, alreadyBooked: true });
    expect(again.hold.id).toBe(booked.hold.id);
    expect(again.intents).toEqual([]);
    expect(await nightRows()).toEqual([{ bookingRequestId: a.requestId, status: "CONFIRMED" }]);
    const { rows } = await pool!.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM "BookingRequestMessage"
        WHERE "bookingRequestId" = $1 AND "systemKind" = 'booking_hold.confirmed'`,
      [a.requestId],
    );
    expect(rows[0]!.n).toBe(1);
  }, 60_000);
});
