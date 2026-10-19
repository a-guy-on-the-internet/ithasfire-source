import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

import { challengeLineHeadInTx } from "@th/core/use-cases/booking-holds/challenge-booking-hold";
import { resolveKeepPlan } from "@th/core/use-cases/booking-holds/_shared/keep-will";
import { findReadyBehindOnLine } from "@th/core/use-cases/booking-holds/_shared/night-readiness";
import { releaseHoldCas, renumberLine } from "@th/core/use-cases/booking-holds/_shared/hold-line";
import { takeNightForTermsInTx } from "@th/core/use-cases/booking-holds/_shared/take-night-for-terms";
import { isKeptAwaitingTerms } from "@th/core/use-cases/booking-holds/_shared/keep-will";
import { appendBookingSystemEntry } from "@th/core/use-cases/booking-requests/messages/_shared/system-entries";
import type { Repos } from "@th/ports/repos";
import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { createPrismaRepos } from "../index";
import { makeAgreementsRepo } from "../agreements";

// ---------------------------------------------------------------------------
// booking-the-night P2d-2 on REAL Postgres — the races the readiness rule
// (N20 / FR-015) and Keep = commit (N19 / FR-014) must survive, decided by the
// real line lock (`pg_advisory_xact_lock` on the line key) and the request's
// booking lock, not by a fake's ordering:
//
//   1. challenge vs the READY hold being released: whichever transaction
//      takes the line lock first decides; the loser waits (Postgres reports
//      it waiting) and then reads committed state — released first →
//      NO_ACT_READY; challenged first → the release lands after, on a line
//      whose challenge stands;
//   2. the readiness rule over the REAL BookingHold → BookingRequest →
//      Agreement join, with the place-local day rule;
//   3. Keep's agree vs a competing agree on the same night: the act behind
//      (terms sent before the 1st hold existed) agreeing at the same moment
//      as the 1st hold's Keep — one booking, and it is the 1st hold's, in
//      either lock order;
//   4. Keep's agree vs the card's "Agree & book" of the SAME terms: the
//      second waits on the booking lock, then is refused (its terms are no
//      longer PROPOSED) — and the night is that request's, which is what
//      lets Keep report success.
//
// The full use cases are not run here (their gates and the post-commit mint
// need the whole place / org / event graph); the transaction BODIES are —
// `challengeLineHeadInTx`, `takeNightForTermsInTx` (the agree Keep runs),
// `releaseHoldCas` + `renumberLine` (a release) — through the production
// `repos.tx` on the production adapters. FK triggers on BookingRequest and
// BookingHold are disabled so fixtures need no Place / Calendar graph.
// ---------------------------------------------------------------------------

const STAFF = "d2d2d2d2-0000-4000-8000-000000000001";
const ACT_A = "d2d2d2d2-0000-4000-8000-00000000000a";
const ACT_B = "d2d2d2d2-0000-4000-8000-00000000000b";
const VENUE_ORG = "d2d2d2d2-0000-4000-8000-0000000000aa";
const PLACE = "d2d2d2d2-0000-4000-8000-0000000000f1";
const CALENDAR = "d2d2d2d2-0000-4000-8000-0000000000ca";
const TZ = "America/Chicago";
const NIGHT = "2026-11-20";
/** 20:00 CST on NIGHT. */
const NIGHT_AT = new Date("2026-11-21T02:00:00.000Z");
/** 23:30 CST on NIGHT — already the 21st in UTC, still NIGHT at the place. */
const LATE_ON_NIGHT = new Date("2026-11-21T05:30:00.000Z");
/** 00:30 CST on the 21st — the next night. */
const AFTER_MIDNIGHT = new Date("2026-11-21T06:30:00.000Z");
const NOW = new Date("2026-11-01T12:00:00.000Z");
const KEY = { calendarId: CALENDAR, date: NIGHT };

describe("booking-the-night P2d-2 — challenge readiness and Keep = commit on the real locks (integration)", () => {
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
  }, 120_000);

  beforeEach(async () => {
    await pool!.query(`TRUNCATE "BookingHold", "BookingRequestMessage" CASCADE`);
    await pool!.query(`DELETE FROM "BookingRequest"`);
  });

  /** An ACCEPTED request for `act`, with terms in `status` dated `at` (or none). */
  async function request(
    act: string,
    terms: { status: "DRAFT" | "PROPOSED" | "CANCELLED"; at?: Date } | null,
  ) {
    let agreementId: string | null = null;
    if (terms) {
      const agreements = makeAgreementsRepo(prisma!);
      const created = await agreements.create({
        type: "PERFORMANCE",
        proposerType: "human",
        proposerId: act,
        counterpartyType: "organization",
        counterpartyId: VENUE_ORG,
        title: "Friday at the venue",
        proposedDate: terms.at ?? NIGHT_AT,
      });
      agreementId = created.id;
      if (terms.status !== "DRAFT") {
        await agreements.updateStatus({
          id: created.id,
          status: terms.status,
          expectedFrom: ["DRAFT"],
          ...(terms.status === "PROPOSED" ? { proposedAt: NOW, sentForReviewByHumanId: STAFF } : {}),
        });
      }
    }
    const requestId = crypto.randomUUID();
    await pool!.query(
      `INSERT INTO "BookingRequest"
         ("id", "placeId", "calendarId", "performerOwnerType", "performerOwnerId",
          "message", "agreementId", "status", "updatedAt")
       VALUES ($1, $2, $3, 'human', $4, 'pitch', $5, 'ACCEPTED', '2026-11-01T00:00:00.000Z')`,
      [requestId, PLACE, CALENDAR, act, agreementId],
    );
    return { requestId, agreementId };
  }

  async function insertHold(
    bookingRequestId: string,
    position: number,
    status: "ACTIVE" | "CHALLENGED" = "ACTIVE",
  ) {
    const id = crypto.randomUUID();
    await pool!.query(
      `INSERT INTO "BookingHold"
         ("id", "bookingRequestId", "calendarId", "date", "position", "status",
          "placedByHumanId", "challengedAt", "respondBy", "updatedAt")
       VALUES ($1, $2, $3, $4::date, $5, $6::"BookingHoldStatus", $7, $8, $9,
               '2026-11-01T00:00:00.000Z')`,
      [
        id,
        bookingRequestId,
        CALENDAR,
        NIGHT,
        position,
        status,
        STAFF,
        status === "CHALLENGED" ? "2026-11-01T11:00:00.000Z" : null,
        status === "CHALLENGED" ? "2026-11-02T12:00:00.000Z" : null,
      ],
    );
    return id;
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
    throw new Error("timed out waiting for a transaction to block on the lock");
  }

  async function holdRow(id: string) {
    const { rows } = await pool!.query<{ status: string; position: number; releasedReason: string | null }>(
      `SELECT "status"::text AS status, "position", "releasedReason"::text AS "releasedReason"
         FROM "BookingHold" WHERE "id" = $1`,
      [id],
    );
    return rows[0]!;
  }

  async function confirmedOnNight() {
    const { rows } = await pool!.query<{ bookingRequestId: string }>(
      `SELECT "bookingRequestId" FROM "BookingHold"
        WHERE "calendarId" = $1 AND "date" = $2::date AND "status" = 'CONFIRMED'`,
      [CALENDAR, NIGHT],
    );
    return rows.map((r) => r.bookingRequestId);
  }

  const challengeArgs = (holdId: string) => ({
    holdId,
    key: KEY,
    now: NOW,
    placeTz: TZ,
    respondBy: new Date(NOW.getTime() + 24 * 60 * 60 * 1000),
    actorHumanId: STAFF,
    assigneeHumanId: null,
  });

  /** A release of `holdId` (MANUAL) + renumber — the staff release's line writes. */
  async function releaseInTx(tx: Parameters<Parameters<Repos["tx"]>[0]>[0], holdId: string) {
    const hold = (await tx.bookingHolds.getById(holdId))!;
    const released = await releaseHoldCas(tx, hold, { reason: "MANUAL", now: NOW });
    await renumberLine(tx, KEY);
    return released;
  }

  // ── 1. challenge vs the ready hold being released ────────────────────────

  test("the ready hold is released while the challenge waits on the line lock → the challenge then reads it gone: NO_ACT_READY, nothing challenged", async () => {
    const a = await request(ACT_A, null);
    const b = await request(ACT_B, { status: "DRAFT" });
    const first = await insertHold(a.requestId, 1);
    const ready = await insertHold(b.requestId, 2);

    const locked = gate();
    const release = gate();
    const releasing = repos.tx(
      async (tx) => {
        await tx.bookingHolds.lockLine(KEY);
        locked.open();
        await release.opened;
        return releaseInTx(tx, ready);
      },
      { timeout: 30_000 },
    );
    await locked.opened;

    let challengeSettled = false;
    const challenge = repos
      .tx((tx) => challengeLineHeadInTx(tx, challengeArgs(first)), { timeout: 30_000 })
      .finally(() => {
        challengeSettled = true;
      });
    await waitUntil(someoneWaitsOnAnAdvisoryLock);
    expect(challengeSettled).toBe(false);

    release.open();
    await releasing;
    await expect(challenge).rejects.toMatchObject({ code: "NO_ACT_READY" });
    expect(await holdRow(first)).toMatchObject({ status: "ACTIVE", position: 1 });
    expect(await holdRow(ready)).toMatchObject({ status: "RELEASED" });
  }, 60_000);

  test("the challenge takes the line lock first → the release waits, the challenge stands; the release lands after", async () => {
    const a = await request(ACT_A, null);
    const b = await request(ACT_B, { status: "DRAFT" });
    const first = await insertHold(a.requestId, 1);
    const ready = await insertHold(b.requestId, 2);

    const locked = gate();
    const go = gate();
    const challenge = repos.tx(
      async (tx) => {
        await tx.bookingHolds.lockLine(KEY);
        locked.open();
        await go.opened;
        // Re-entrant: the body takes the same lock again for free.
        return challengeLineHeadInTx(tx, challengeArgs(first));
      },
      { timeout: 30_000 },
    );
    await locked.opened;

    let releaseSettled = false;
    const releasing = repos
      .tx((tx) => releaseInTx(tx, ready), { timeout: 30_000 })
      .finally(() => {
        releaseSettled = true;
      });
    await waitUntil(someoneWaitsOnAnAdvisoryLock);
    expect(releaseSettled).toBe(false);

    go.open();
    const challenged = await challenge;
    await releasing;
    expect(challenged.hold.status).toBe("CHALLENGED");
    expect(await holdRow(first)).toMatchObject({ status: "CHALLENGED" });
    expect(await holdRow(ready)).toMatchObject({ status: "RELEASED" });
  }, 60_000);

  // ── 2. the readiness rule over the real join ─────────────────────────────

  test("readiness through the real BookingHold → BookingRequest → Agreement join, read the way the place reads its calendar", async () => {
    const a = await request(ACT_A, null);
    const first = await insertHold(a.requestId, 1);
    const target = { id: first, position: 1 };
    const readyBehind = () => repos.tx((tx) => findReadyBehindOnLine(tx, { key: KEY, target, now: NOW, placeTz: TZ }));

    // Nobody behind.
    expect(await readyBehind()).toBeNull();
    // Cancelled terms, and terms for the NEXT night (00:30 local on the 21st), are not ready.
    const cancelled = await request(ACT_B, { status: "CANCELLED" });
    await insertHold(cancelled.requestId, 2);
    const nextNight = await request(ACT_B, { status: "DRAFT", at: AFTER_MIDNIGHT });
    await insertHold(nextNight.requestId, 3);
    expect(await readyBehind()).toBeNull();
    // Draft terms at 23:30 local on the night — the 21st in UTC — are.
    const late = await request(ACT_B, { status: "DRAFT", at: LATE_ON_NIGHT });
    const lateHold = await insertHold(late.requestId, 4);
    expect((await readyBehind())?.id).toBe(lateHold);
  }, 60_000);

  // ── 3. Keep's agree vs a competing agree on the same night ───────────────

  for (const order of ["keep first", "competitor first"] as const) {
    test(`Keep's agree vs the act behind agreeing at the same moment (${order}) → one booking, the 1st hold's`, async () => {
      // B's terms were sent before A held the night (N6 stops a send while
      // someone is ahead, not one that came first); then A was put first and
      // challenged. A's terms are sent too: Keep is "book now".
      const a = await request(ACT_A, { status: "PROPOSED" });
      const b = await request(ACT_B, { status: "PROPOSED" });
      const aHold = await insertHold(a.requestId, 1, "CHALLENGED");
      const bHold = await insertHold(b.requestId, 2);

      const plan = await resolveKeepPlan(repos, {
        hold: { calendarId: CALENDAR, date: NIGHT },
        request: { id: a.requestId, calendarId: CALENDAR, agreementId: a.agreementId },
        placeId: PLACE,
        placeTz: TZ,
      });
      expect(plan.keepWill).toBe("book_now");

      const agreeArgs = (terms: { agreementId: string | null; requestId: string }, actor: string) => ({
        agreementId: terms.agreementId!,
        bookingRequestId: terms.requestId,
        expectedProposedDate: NIGHT_AT,
        key: KEY,
        placeTz: TZ,
        now: NOW,
        actorHumanId: actor,
        actorSide: "PERFORMER" as const,
        placedByHumanId: STAFF,
      });
      const [leader, follower] =
        order === "keep first"
          ? [agreeArgs(a, ACT_A), agreeArgs(b, ACT_B)]
          : [agreeArgs(b, ACT_B), agreeArgs(a, ACT_A)];

      const locked = gate();
      const go = gate();
      const leading = repos
        .tx(
          async (tx) => {
            await tx.bookingHolds.lockLine(KEY);
            locked.open();
            await go.opened;
            return takeNightForTermsInTx(tx, leader);
          },
          { timeout: 30_000 },
        )
        .then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
      await locked.opened;
      let followerSettled = false;
      const following = repos
        .tx((tx) => takeNightForTermsInTx(tx, follower), { timeout: 30_000 })
        .then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        )
        .finally(() => {
          followerSettled = true;
        });
      await waitUntil(someoneWaitsOnAnAdvisoryLock);
      expect(followerSettled).toBe(false);
      go.open();

      const outcomes = { leader: await leading, follower: await following };
      const keepOutcome = order === "keep first" ? outcomes.leader : outcomes.follower;
      const rivalOutcome = order === "keep first" ? outcomes.follower : outcomes.leader;
      expect(keepOutcome.ok).toBe(true);
      expect(rivalOutcome).toMatchObject({ ok: false, error: { code: "NIGHT_NO_LONGER_AVAILABLE" } });

      expect(await confirmedOnNight()).toEqual([a.requestId]);
      expect(await holdRow(aHold)).toMatchObject({ status: "CONFIRMED" });
      expect(await holdRow(bHold)).toMatchObject({ status: "RELEASED", releasedReason: "CONFIRMED_OTHER" });
      expect((await makeAgreementsRepo(prisma!).getById(b.agreementId!))!.status).toBe("PROPOSED");
    }, 60_000);
  }

  // ── 2b. "already kept THIS challenge?" over the real JSON filter ─────────

  test("the kept-awaiting-terms check matches the hold AND the challenge it answered (hasSystemEntry dataMatch on real JSON)", async () => {
    const a = await request(ACT_A, null);
    const holdId = await insertHold(a.requestId, 1, "CHALLENGED");
    const challengedAt = new Date("2026-11-01T11:00:00.000Z");
    const hold = { id: holdId, bookingRequestId: a.requestId, status: "CHALLENGED" as const, challengedAt };

    expect(await repos.tx((tx) => isKeptAwaitingTerms(tx, hold))).toBe(false);
    await repos.tx((tx) =>
      appendBookingSystemEntry(tx, {
        bookingRequestId: a.requestId,
        kind: "booking_hold.kept",
        data: { holdId, challengedAt: challengedAt.toISOString(), respondBy: "2026-11-03T12:00:00.000Z" },
        actorHumanId: ACT_A,
      }),
    );
    expect(await repos.tx((tx) => isKeptAwaitingTerms(tx, hold))).toBe(true);
    // A LATER challenge of the same hold is not kept yet.
    expect(
      await repos.tx((tx) => isKeptAwaitingTerms(tx, { ...hold, challengedAt: new Date("2026-11-02T09:00:00.000Z") })),
    ).toBe(false);
    // Another hold of the same request is not kept either.
    expect(await repos.tx((tx) => isKeptAwaitingTerms(tx, { ...hold, id: crypto.randomUUID() }))).toBe(false);
  }, 60_000);

  // ── 4. Keep's agree vs the card's agree of the SAME terms ────────────────

  test("Keep's agree and the card's 'Agree & book' of the same terms: the second waits on the booking lock, is refused, and the night is that request's (Keep's success condition)", async () => {
    const a = await request(ACT_A, { status: "PROPOSED" });
    const b = await request(ACT_B, { status: "DRAFT" });
    const aHold = await insertHold(a.requestId, 1, "CHALLENGED");
    await insertHold(b.requestId, 2);
    const args = {
      agreementId: a.agreementId!,
      bookingRequestId: a.requestId,
      expectedProposedDate: NIGHT_AT,
      key: KEY,
      placeTz: TZ,
      now: NOW,
      actorHumanId: ACT_A,
      actorSide: "PERFORMER" as const,
      placedByHumanId: STAFF,
    };

    const locked = gate();
    const go = gate();
    const card = repos.tx(
      async (tx) => {
        await tx.bookingHolds.lockRequestBooking(a.requestId);
        locked.open();
        await go.opened;
        return takeNightForTermsInTx(tx, args);
      },
      { timeout: 30_000 },
    );
    await locked.opened;
    let keepSettled = false;
    const keep = repos
      .tx((tx) => takeNightForTermsInTx(tx, args), { timeout: 30_000 })
      .finally(() => {
        keepSettled = true;
      });
    await waitUntil(someoneWaitsOnAnAdvisoryLock);
    expect(keepSettled).toBe(false);
    go.open();

    await card;
    await expect(keep).rejects.toMatchObject({ code: "AGREEMENT_NOT_PROPOSED" });
    // What Keep's fallback reads: this request's CONFIRMED hold on the line.
    const booked = (await repos.bookingHolds.listForRequest(a.requestId)).filter((h) => h.status === "CONFIRMED");
    expect(booked.map((h) => h.id)).toEqual([aHold]);
    const { rows } = await pool!.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM "BookingRequestMessage"
        WHERE "bookingRequestId" = $1 AND "systemKind" = 'booking_agreement.accepted'`,
      [a.requestId],
    );
    expect(rows[0]!.n).toBe(1);
  }, 60_000);
});
