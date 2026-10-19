import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

import { cancelBookingInTx } from "@th/core/use-cases/booking-requests/cancel-booking";
import { withdrawBookingRequest } from "@th/core/use-cases/booking-requests/withdraw-booking-request";
import { takeNightForTermsInTx } from "@th/core/use-cases/booking-holds/_shared/take-night-for-terms";
import { settleHeldDatesForPublishedEvent } from "@th/core/use-cases/booking-holds/settle-held-dates-for-published-event";
import { cancelEventForBooking, type CancelEventDeps } from "@th/core/use-cases/events/cancel-event";
import type { Repos } from "@th/ports/repos";
import type { ToVenueBookingRequestRecord } from "@th/ports/repos/booking-requests";
import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { PrismaIdempotencyAdapter } from "../../../idempotency/prisma-adapter";
import { createPrismaRepos } from "../index";
import { makeAgreementsRepo } from "../agreements";

// ---------------------------------------------------------------------------
// booking-the-night P2c on REAL Postgres: the request's BOOKING lock
// (`bookingHolds.lockRequestBooking`, a transaction advisory lock keyed
// `booking_request_booking:<id>`) is what every path that books, un-books or
// closes a request's night takes FIRST. The core suites stage these races on
// fakes; here the lock itself does the serialising:
//
//   1. Cancel booking holds the lock; the sender's agree (terms re-sent for
//      the booked night) waits on it, then reads the cancelled terms and is
//      refused — nothing re-booked; the hold stays RELEASED BOOKING_CANCELLED
//      with its confirmedAt, the payout terms ARCHIVED.
//   2. Cancel twice at once: the second waits, then finds the hold RELEASED
//      → BOOKING_NOT_CANCELLABLE. One ledger entry.
//   3. The agree books the night while a withdraw waits → the withdraw reads
//      the CONFIRMED hold → BOOKING_NIGHT_BOOKED; the request stays ACCEPTED.
//   4. The withdraw goes first while the agree waits → the agree finds the
//      request closed; nothing booked.
//   5. The adapter contracts the cancel relies on: `payoutTerms.archive` is a
//      CAS (a second archive, or activating an archived row, is a no-op), a
//      CONFIRMED hold can go RELEASED keeping `confirmedAt`, and the booking
//      lock is its own key (a held line lock does not block it).
//
//   6. (review W1) Publish / Confirm's settle books the provenance
//      request's night under the request's booking lock: a withdraw that
//      arrives meanwhile waits, then reads the CONFIRMED hold →
//      BOOKING_NIGHT_BOOKED; a withdraw that went first leaves the settle
//      nothing to book.
//   7. (review W3 i) Cancel booking's event leg — `cancelEventForBooking`
//      with a stub payment port and the real idempotency adapter — racing a
//      Publish/Confirm-shaped transaction (the event row FOR UPDATE, then the
//      settle) on the same event: both take the event row first, so they
//      serialise in either order; no deadlock.
//   8. (review W3 ii / W2) A throw inside the booking's writes rolls the
//      whole cancel back — the event stays PUBLISHED, the hold CONFIRMED —
//      and releases the idempotency claim, so an immediate retry runs.
//
// The full cancelBooking use case is not run here (its event leg is the
// cancelEvent body with Stripe behind it); `cancelBookingInTx` IS the
// booking's transaction body, run through the production `repos.tx` on the
// production adapters, as the no-event path runs it.
//
// FK triggers on BookingRequest, BookingHold and Event are disabled so fixtures need
// no Place / Calendar graph. Seed timestamps are ISO strings in raw SQL.
// ---------------------------------------------------------------------------

const STAFF = "c1c1c1c1-0000-4000-8000-000000000001";
const ACT_A = "c1c1c1c1-0000-4000-8000-00000000000a";
const VENUE_ORG = "c1c1c1c1-0000-4000-8000-0000000000aa";
const PLACE = "c1c1c1c1-0000-4000-8000-0000000000f1";
const CALENDAR = "c1c1c1c1-0000-4000-8000-0000000000ca";
const TZ = "America/Chicago";
const NIGHT = "2026-11-20";
/** 20:00 CST on NIGHT. */
const NIGHT_AT = new Date("2026-11-21T02:00:00.000Z");
const NOW = new Date("2026-11-01T12:00:00.000Z");
const KEY = { calendarId: CALENDAR, date: NIGHT };
const BOOKED_AT = "2026-11-01T09:30:00.000Z";

describe("cancel booking / exits after accept — the real booking lock (integration)", () => {
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
    await pool.query(`ALTER TABLE "Event" DISABLE TRIGGER ALL`);
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
    repos = createPrismaRepos(prisma);
    for (const id of [STAFF, ACT_A]) {
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
  }, 120_000);

  beforeEach(async () => {
    await pool!.query(`TRUNCATE "BookingHold", "BookingRequestMessage" CASCADE`);
    await pool!.query(`DELETE FROM "BookingRequest"`);
  });

  /**
   * An ACCEPTED request with terms in `status` for NIGHT (their own ACTIVE
   * payout terms attached) and, when `hold` says so, a hold on NIGHT.
   */
  async function request(opts: {
    terms: "DRAFT" | "PROPOSED" | "ACCEPTED";
    hold: "ACTIVE" | "CONFIRMED" | null;
  }) {
    const agreements = makeAgreementsRepo(prisma!);
    const created = await agreements.create({
      type: "PERFORMANCE",
      proposerType: "human",
      proposerId: ACT_A,
      counterpartyType: "organization",
      counterpartyId: VENUE_ORG,
      title: "Friday at the venue",
      proposedDate: NIGHT_AT,
    });
    if (opts.terms !== "DRAFT") {
      await agreements.updateStatus({
        id: created.id,
        status: "PROPOSED",
        expectedFrom: ["DRAFT"],
        proposedAt: NOW,
        sentForReviewByHumanId: STAFF,
      });
    }
    if (opts.terms === "ACCEPTED") {
      await agreements.updateStatus({
        id: created.id,
        status: "ACCEPTED",
        expectedFrom: ["PROPOSED"],
        acceptedAt: NOW,
      });
    }
    const terms = await repos.payoutTerms.createDraft({
      kind: "PRIMARY",
      settlementCurrency: "usd",
    });
    await pool!.query(`UPDATE "PayoutTerms" SET "status" = 'ACTIVE' WHERE "id" = $1`, [terms.id]);
    await pool!.query(`UPDATE "Agreement" SET "payoutTermsId" = $2 WHERE "id" = $1`, [
      created.id,
      terms.id,
    ]);
    const requestId = crypto.randomUUID();
    await pool!.query(
      `INSERT INTO "BookingRequest"
         ("id", "placeId", "calendarId", "performerOwnerType", "performerOwnerId",
          "message", "agreementId", "status", "updatedAt")
       VALUES ($1, $2, $3, 'human', $4, 'pitch', $5, 'ACCEPTED', '2026-11-01T00:00:00.000Z')`,
      [requestId, PLACE, CALENDAR, ACT_A, created.id],
    );
    let holdId: string | null = null;
    if (opts.hold) {
      holdId = crypto.randomUUID();
      await pool!.query(
        `INSERT INTO "BookingHold"
           ("id", "bookingRequestId", "calendarId", "date", "position", "status",
            "placedByHumanId", "confirmedAt", "updatedAt")
         VALUES ($1, $2, $3, $4::date, 1, $5::"BookingHoldStatus", $6, $7,
                 '2026-11-01T00:00:00.000Z')`,
        [holdId, requestId, CALENDAR, NIGHT, opts.hold, STAFF, opts.hold === "CONFIRMED" ? BOOKED_AT : null],
      );
    }
    return { agreementId: created.id, requestId, holdId, payoutTermsId: terms.id };
  }

  async function loadRequest(id: string) {
    return (await repos.bookingRequests.getById(id)) as ToVenueBookingRequestRecord;
  }

  function cancelArgs(req: ToVenueBookingRequestRecord, holdId: string, actor = STAFF) {
    return {
      request: req,
      holdId,
      side: actor === STAFF ? ("venue" as const) : ("sender" as const),
      actorHumanId: actor,
      reason: "The room flooded.",
      now: NOW,
      placeTz: TZ,
      expectedEventId: null as string | null,
    };
  }

  function agreeArgs(t: { agreementId: string; requestId: string }) {
    return {
      agreementId: t.agreementId,
      bookingRequestId: t.requestId,
      expectedProposedDate: NIGHT_AT,
      key: KEY,
      placeTz: TZ,
      now: NOW,
      actorHumanId: ACT_A,
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

  async function someoneWaitsOnAnAdvisoryLock(): Promise<boolean> {
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
    throw new Error("timed out waiting for the second transaction to block");
  }

  /** Run `body` in a transaction and keep it open until `release` opens. */
  function holdOpen<T>(body: Parameters<Repos["tx"]>[0]) {
    const ran = gate();
    const release = gate();
    const done = repos.tx(
      async (tx) => {
        const out = (await body(tx)) as T;
        ran.open();
        await release.opened;
        return out;
      },
      { timeout: 30_000 },
    );
    return { ran: ran.opened, release: release.open, done };
  }

  /** Read through the adapter: Prisma reads the tz-naive column as UTC. */
  async function holdRow(id: string) {
    const row = (await repos.bookingHolds.getById(id))!;
    return {
      status: row.status,
      releasedReason: row.releasedReason,
      confirmedAt: row.confirmedAt,
    };
  }

  async function confirmedCount() {
    const { rows } = await pool!.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM "BookingHold" WHERE "status" = 'CONFIRMED'`,
    );
    return rows[0]!.n;
  }

  async function ledgerKinds(requestId: string) {
    const { rows } = await pool!.query<{ systemKind: string }>(
      `SELECT "systemKind" FROM "BookingRequestMessage" WHERE "bookingRequestId" = $1 ORDER BY "createdAt", "id"`,
      [requestId],
    );
    return rows.map((r) => r.systemKind);
  }

  async function termsStatus(payoutTermsId: string) {
    return (await repos.payoutTerms.getById(payoutTermsId))!.status;
  }

  test("cancel holds the booking lock; the agree (terms re-sent for the booked night) waits, then is refused — nothing re-booked", async () => {
    const t = await request({ terms: "PROPOSED", hold: "CONFIRMED" });
    const req = await loadRequest(t.requestId);

    const cancel = holdOpen(async (tx) => cancelBookingInTx(tx, cancelArgs(req, t.holdId!)));
    await cancel.ran;

    let agreeSettled = false;
    const agree = repos
      .tx((tx) => takeNightForTermsInTx(tx, agreeArgs(t)), { timeout: 30_000 })
      .finally(() => {
        agreeSettled = true;
      });
    await waitUntil(someoneWaitsOnAnAdvisoryLock);
    expect(agreeSettled).toBe(false);

    cancel.release();
    await cancel.done;
    await expect(agree).rejects.toMatchObject({ code: "AGREEMENT_NOT_PROPOSED" });

    expect(await holdRow(t.holdId!)).toEqual({
      status: "RELEASED",
      releasedReason: "BOOKING_CANCELLED",
      confirmedAt: new Date(BOOKED_AT),
    });
    expect(await confirmedCount()).toBe(0);
    expect((await makeAgreementsRepo(prisma!).getById(t.agreementId))!.status).toBe("CANCELLED");
    expect(await termsStatus(t.payoutTermsId)).toBe("ARCHIVED");
    expect((await loadRequest(t.requestId)).status).toBe("ACCEPTED");
    expect(await ledgerKinds(t.requestId)).toEqual(["booking_request.booking_cancelled"]);
  }, 60_000);

  test("cancel twice at once: the second waits on the booking lock, then finds the hold RELEASED → BOOKING_NOT_CANCELLABLE; one entry", async () => {
    const t = await request({ terms: "ACCEPTED", hold: "CONFIRMED" });
    const req = await loadRequest(t.requestId);

    const first = holdOpen(async (tx) => cancelBookingInTx(tx, cancelArgs(req, t.holdId!)));
    await first.ran;

    let secondSettled = false;
    const second = repos
      .tx((tx) => cancelBookingInTx(tx, cancelArgs(req, t.holdId!, ACT_A)), { timeout: 30_000 })
      .finally(() => {
        secondSettled = true;
      });
    await waitUntil(someoneWaitsOnAnAdvisoryLock);
    expect(secondSettled).toBe(false);

    first.release();
    await first.done;
    await expect(second).rejects.toMatchObject({ code: "BOOKING_NOT_CANCELLABLE" });
    expect(await ledgerKinds(t.requestId)).toEqual(["booking_request.booking_cancelled"]);
  }, 60_000);

  test("the agree books the night while a withdraw waits → the withdraw reads the CONFIRMED hold: BOOKING_NIGHT_BOOKED", async () => {
    const t = await request({ terms: "PROPOSED", hold: "ACTIVE" });

    const agree = holdOpen(async (tx) => takeNightForTermsInTx(tx, agreeArgs(t)));
    await agree.ran;

    let withdrawSettled = false;
    const withdraw = withdrawBookingRequest(
      { repos, clock: { now: () => NOW } },
      { actorHumanId: ACT_A, bookingRequestId: t.requestId },
    ).finally(() => {
      withdrawSettled = true;
    });
    await waitUntil(someoneWaitsOnAnAdvisoryLock);
    expect(withdrawSettled).toBe(false);

    agree.release();
    await agree.done;
    await expect(withdraw).rejects.toMatchObject({ code: "BOOKING_NIGHT_BOOKED" });
    expect((await loadRequest(t.requestId)).status).toBe("ACCEPTED");
    expect((await holdRow(t.holdId!)).status).toBe("CONFIRMED");
  }, 60_000);

  test("the withdraw goes first while the agree waits → the agree finds the request closed; nothing booked, the terms CANCELLED", async () => {
    const t = await request({ terms: "PROPOSED", hold: "ACTIVE" });

    // The withdraw's body, held open after its writes (its own lock first).
    const withdrawn = gate();
    const releaseWithdraw = gate();
    const withdrawRepos = {
      ...repos,
      tx: ((fn: Parameters<Repos["tx"]>[0]) =>
        repos.tx(
          async (tx) => {
            const out = await fn(tx);
            withdrawn.open();
            await releaseWithdraw.opened;
            return out;
          },
          { timeout: 30_000 },
        )) as Repos["tx"],
    } as Repos;
    const withdraw = withdrawBookingRequest(
      { repos: withdrawRepos, clock: { now: () => NOW } },
      { actorHumanId: ACT_A, bookingRequestId: t.requestId },
    );
    await withdrawn.opened;

    let agreeSettled = false;
    const agree = repos
      .tx((tx) => takeNightForTermsInTx(tx, agreeArgs(t)), { timeout: 30_000 })
      .finally(() => {
        agreeSettled = true;
      });
    await waitUntil(someoneWaitsOnAnAdvisoryLock);
    expect(agreeSettled).toBe(false);

    releaseWithdraw.open();
    await expect(withdraw).resolves.toMatchObject({ status: "WITHDRAWN" });
    await expect(agree).rejects.toMatchObject({ code: "INVALID_STATUS", message: "booking_request_closed" });
    expect(await confirmedCount()).toBe(0);
    expect((await holdRow(t.holdId!))).toMatchObject({ status: "RELEASED", releasedReason: "REQUEST_CLOSED" });
    expect((await makeAgreementsRepo(prisma!).getById(t.agreementId))!.status).toBe("CANCELLED");
  }, 60_000);

  test("adapter contracts: archive is a CAS; an ARCHIVED row is never re-activated; the booking lock is its own key", async () => {
    const t = await request({ terms: "ACCEPTED", hold: null });

    const archived = await repos.payoutTerms.archive({
      payoutTermsId: t.payoutTermsId,
      expectedFrom: ["PENDING", "ACTIVE"],
    });
    expect(archived?.status).toBe("ARCHIVED");
    expect(
      await repos.payoutTerms.archive({ payoutTermsId: t.payoutTermsId, expectedFrom: ["PENDING", "ACTIVE"] }),
    ).toBeNull();
    expect(
      await repos.payoutTerms.activate({ payoutTermsId: t.payoutTermsId, expectedFrom: ["PENDING"] }),
    ).toBeNull();
    expect(await termsStatus(t.payoutTermsId)).toBe("ARCHIVED");

    // A held LINE lock does not block the BOOKING lock of a request on it.
    const line = holdOpen(async (tx) => tx.bookingHolds.lockLine(KEY));
    await line.ran;
    await repos.tx(async (tx) => tx.bookingHolds.lockRequestBooking(t.requestId), { timeout: 5_000 });
    line.release();
    await line.done;
  }, 60_000);
  // ── Review W1 / W3: the event-row paths ──────────────────────────────────

  async function someoneWaitsOnARowLock(): Promise<boolean> {
    const { rows } = await pool!.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database()
          AND wait_event_type = 'Lock' AND wait_event IN ('transactionid', 'tuple')`,
    );
    return rows[0]!.n > 0;
  }

  /**
   * A PUBLISHED event on the booked line, linked to the request's terms
   * (`link`) — or, for the W1 races, not yet linked: the settle is handed the
   * provenance directly, and a linked (finalized) agreement would refuse the
   * withdraw before its lock (AGREEMENT_FINALIZED).
   */
  async function bookingEvent(agreementId: string, link = true) {
    const eventId = crypto.randomUUID();
    await pool!.query(
      `INSERT INTO "Event" (id, title, "startsAt", "endsAt", status, "placeId", calendar_id, "humanId", "updatedAt")
       VALUES ($1, 'Friday at the venue', $2, $2, 'PUBLISHED', $3, $4, $5, '2026-11-01T00:00:00.000Z')`,
      [eventId, NIGHT_AT.toISOString(), PLACE, CALENDAR, ACT_A],
    );
    if (link) {
      await pool!.query(`UPDATE "Agreement" SET "eventId" = $2 WHERE "id" = $1`, [agreementId, eventId]);
    }
    return eventId;
  }

  async function eventStatus(eventId: string) {
    return (await repos.events.getById(eventId))!.status;
  }

  function settleArgs(eventId: string, requestId: string) {
    return {
      eventId,
      calendarId: CALENDAR,
      occupiedDates: [NIGHT],
      provenanceRequestId: requestId,
      now: NOW,
      placeTz: TZ,
      actorHumanId: STAFF,
    };
  }

  /** Publish / Confirm's shape: the event row FOR UPDATE, then the settle. */
  async function publishLikeBody(tx: Parameters<Parameters<Repos["tx"]>[0]>[0], eventId: string, requestId: string) {
    await tx.events.lockRows({ ids: [eventId], mode: "update" });
    const status = (await tx.events.getById(eventId))!.status;
    const settled = await settleHeldDatesForPublishedEvent(tx, settleArgs(eventId, requestId));
    return { status, confirmed: settled.confirmed.map((h) => h.id) };
  }

  function cancelDeps(): CancelEventDeps {
    return {
      repos,
      authz: { hasStaffRole: async () => ({ allowed: false }) },
      // No orders on the event: a refund would be a bug.
      payments: new Proxy({}, {
        get: () => () => {
          throw new Error("no refund expected");
        },
      }) as CancelEventDeps["payments"],
      idempotency: new PrismaIdempotencyAdapter(prisma!),
      clock: { now: () => NOW },
    };
  }

  function bookingCancelArgs(
    req: ToVenueBookingRequestRecord,
    holdId: string,
    eventId: string,
    withinTx: (tx: Parameters<Parameters<Repos["tx"]>[0]>[0]) => Promise<void>,
  ) {
    return {
      actorHumanId: STAFF,
      eventId,
      idempotencyKey: `bookingRequest:cancelBooking:${req.id}:${holdId}`,
      withinTx,
    };
  }

  test("W1: the settle books the night under the booking lock; a withdraw waits, then reads the CONFIRMED hold → BOOKING_NIGHT_BOOKED", async () => {
    const t = await request({ terms: "PROPOSED", hold: "ACTIVE" });
    const eventId = await bookingEvent(t.agreementId, false);

    const publish = holdOpen(async (tx) => publishLikeBody(tx, eventId, t.requestId));
    await publish.ran;

    let withdrawSettled = false;
    const withdraw = withdrawBookingRequest(
      { repos, clock: { now: () => NOW } },
      { actorHumanId: ACT_A, bookingRequestId: t.requestId },
    ).finally(() => {
      withdrawSettled = true;
    });
    await waitUntil(someoneWaitsOnAnAdvisoryLock);
    expect(withdrawSettled).toBe(false);

    publish.release();
    await expect(publish.done).resolves.toEqual({ status: "PUBLISHED", confirmed: [t.holdId] });
    await expect(withdraw).rejects.toMatchObject({ code: "BOOKING_NIGHT_BOOKED" });
    expect((await loadRequest(t.requestId)).status).toBe("ACCEPTED");
    expect((await holdRow(t.holdId!)).status).toBe("CONFIRMED");
  }, 60_000);

  test("W1: the withdraw goes first; the settle waits on the booking lock, then has nothing of the request's to book", async () => {
    const t = await request({ terms: "PROPOSED", hold: "ACTIVE" });
    const eventId = await bookingEvent(t.agreementId, false);

    const withdrawn = gate();
    const releaseWithdraw = gate();
    const withdrawRepos = {
      ...repos,
      tx: ((fn: Parameters<Repos["tx"]>[0]) =>
        repos.tx(
          async (tx) => {
            const out = await fn(tx);
            withdrawn.open();
            await releaseWithdraw.opened;
            return out;
          },
          { timeout: 30_000 },
        )) as Repos["tx"],
    } as Repos;
    const withdraw = withdrawBookingRequest(
      { repos: withdrawRepos, clock: { now: () => NOW } },
      { actorHumanId: ACT_A, bookingRequestId: t.requestId },
    );
    // Fail fast (not a 60s hang) if the withdraw refuses before its body.
    await Promise.race([withdrawn.opened, withdraw.then(() => undefined)]);

    let publishSettled = false;
    const publish = repos
      .tx((tx) => publishLikeBody(tx, eventId, t.requestId), { timeout: 30_000 })
      .finally(() => {
        publishSettled = true;
      });
    await waitUntil(someoneWaitsOnAnAdvisoryLock);
    expect(publishSettled).toBe(false);

    releaseWithdraw.open();
    await expect(withdraw).resolves.toMatchObject({ status: "WITHDRAWN" });
    await expect(publish).resolves.toEqual({ status: "PUBLISHED", confirmed: [] });
    expect(await confirmedCount()).toBe(0);
    expect(await holdRow(t.holdId!)).toMatchObject({ status: "RELEASED", releasedReason: "REQUEST_CLOSED" });
  }, 60_000);

  test("W3 (i): Cancel booking's event leg holds the event row; a Publish/Confirm-shaped tx waits on it, then finds the event CANCELLED and nothing to book", async () => {
    const t = await request({ terms: "ACCEPTED", hold: "CONFIRMED" });
    const eventId = await bookingEvent(t.agreementId);
    const req = await loadRequest(t.requestId);

    const inside = gate();
    const releaseCancel = gate();
    const cancel = cancelEventForBooking(
      cancelDeps(),
      bookingCancelArgs(req, t.holdId!, eventId, async (tx) => {
        await cancelBookingInTx(tx, { ...cancelArgs(req, t.holdId!), expectedEventId: eventId });
        inside.open();
        await releaseCancel.opened;
      }),
    );
    await inside.opened;

    let publishSettled = false;
    const publish = repos
      .tx((tx) => publishLikeBody(tx, eventId, t.requestId), { timeout: 30_000 })
      .finally(() => {
        publishSettled = true;
      });
    await waitUntil(someoneWaitsOnARowLock);
    expect(publishSettled).toBe(false);

    releaseCancel.open();
    await expect(cancel).resolves.toMatchObject({ eventId });
    // A real publish/confirm refuses a CANCELLED event; the settle, run
    // anyway, finds the request's night already un-booked.
    await expect(publish).resolves.toEqual({ status: "CANCELLED", confirmed: [] });
    expect(await eventStatus(eventId)).toBe("CANCELLED");
    expect(await holdRow(t.holdId!)).toMatchObject({ status: "RELEASED", releasedReason: "BOOKING_CANCELLED" });
    expect(await confirmedCount()).toBe(0);
  }, 60_000);

  test("W3 (i): a Publish/Confirm-shaped tx goes first and books the night; Cancel booking's events.cancel waits on the row, then cancels the event and un-books that night", async () => {
    const t = await request({ terms: "ACCEPTED", hold: "ACTIVE" });
    const eventId = await bookingEvent(t.agreementId);
    const req = await loadRequest(t.requestId);

    const publish = holdOpen(async (tx) => publishLikeBody(tx, eventId, t.requestId));
    await publish.ran;

    let cancelSettled = false;
    const cancel = cancelEventForBooking(
      cancelDeps(),
      bookingCancelArgs(req, t.holdId!, eventId, async (tx) => {
        await cancelBookingInTx(tx, { ...cancelArgs(req, t.holdId!), expectedEventId: eventId });
      }),
    ).finally(() => {
      cancelSettled = true;
    });
    await waitUntil(someoneWaitsOnARowLock);
    expect(cancelSettled).toBe(false);

    publish.release();
    await expect(publish.done).resolves.toEqual({ status: "PUBLISHED", confirmed: [t.holdId] });
    await expect(cancel).resolves.toMatchObject({ eventId });
    expect(await eventStatus(eventId)).toBe("CANCELLED");
    const hold = await holdRow(t.holdId!);
    expect(hold).toMatchObject({ status: "RELEASED", releasedReason: "BOOKING_CANCELLED" });
    expect(hold.confirmedAt).not.toBeNull();
    expect((await makeAgreementsRepo(prisma!).getById(t.agreementId))!.status).toBe("CANCELLED");
  }, 60_000);

  test("W3 (ii) / W2: a throw inside the booking's writes rolls the cancel back — event PUBLISHED, hold CONFIRMED — and an immediate retry runs", async () => {
    const t = await request({ terms: "ACCEPTED", hold: "CONFIRMED" });
    const eventId = await bookingEvent(t.agreementId);
    const req = await loadRequest(t.requestId);
    const idempotency = new PrismaIdempotencyAdapter(prisma!);
    const deps = { ...cancelDeps(), idempotency };
    const args = (boom: boolean) =>
      bookingCancelArgs(req, t.holdId!, eventId, async (tx) => {
        await cancelBookingInTx(tx, { ...cancelArgs(req, t.holdId!), expectedEventId: eventId });
        if (boom) throw new Error("injected after the booking's writes");
      });

    await expect(cancelEventForBooking(deps, args(true))).rejects.toThrow(/injected/);

    expect(await eventStatus(eventId)).toBe("PUBLISHED");
    expect(await holdRow(t.holdId!)).toMatchObject({ status: "CONFIRMED", releasedReason: null });
    expect((await makeAgreementsRepo(prisma!).getById(t.agreementId))!.status).toBe("ACCEPTED");
    expect(await termsStatus(t.payoutTermsId)).toBe("ACTIVE");
    expect(await ledgerKinds(t.requestId)).toEqual([]);
    // The claim was RELEASED, not marked failed: nothing left under the key.
    const key = args(false).idempotencyKey;
    expect(await idempotency.status!(key)).toBeNull();

    // The immediate retry runs (not IDEMPOTENCY_LOCK_IN_PROGRESS) and lands.
    await expect(cancelEventForBooking(deps, args(false))).resolves.toMatchObject({ eventId });
    expect(await eventStatus(eventId)).toBe("CANCELLED");
    expect(await holdRow(t.holdId!)).toMatchObject({ status: "RELEASED", releasedReason: "BOOKING_CANCELLED" });
    expect(await idempotency.status!(key)).toBe("succeeded");
  }, 60_000);
});
