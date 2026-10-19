import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { makeBookingHoldsRepo } from "../../src/db/prisma/booking-holds";
import { makeBookingTagsRepo } from "../../src/db/prisma/booking-tags";
import { makeBookingRequestsRepo } from "../../src/db/prisma/booking-requests";

// ---------------------------------------------------------------------------
// Booking-holds adapter integration (Step 1 of
// docs/specs/2026-08-25/completed/booking-holds.spec.yaml).
//
// Runs against REAL Postgres via `prisma migrate deploy` (which also proves
// the three booking-holds migrations — 20260825120000_add_booking_holds,
// 20260825130000_booking_holds_constraints, 20260825140000_booking_holds_
// challenge_check — replay on a fresh database, including the SQL-only
// partial uniques and the biconditional CHECK). Client construction copies event-saves.test.ts
// EXACTLY: the repo's Prisma client runs in driver-adapter mode, so a bare
// `new PrismaClient()` throws and the whole suite would silently skip.
//
// Headline pins (NFR-002): (a) two concurrent CAS confirms on ONE hold row
// yield one winner — the loser's updateMany matches zero rows; (b) two
// concurrent confirms on DIFFERENT holds in one line yield one winner — the
// loser trips the partial unique "BookingHold_confirmed_line_key".
// ---------------------------------------------------------------------------

const DATE = "2026-10-13";
const OTHER_DATE = "2026-10-14";

describe("Prisma adapters integration – booking holds", () => {
  let pg: PostgresTestContainer | undefined;
  let pool: Pool | undefined;
  let prisma: PrismaClient | undefined;
  let runtimeError: Error | null = null;

  let staffId: string;
  let placeId: string;
  let calendarId: string;
  let otherCalendarId: string;
  let orgId: string;

  beforeAll(async () => {
    try {
      pg = await startPostgresContainer();
      await runPrismaMigrateDeploy(pg.databaseUrl);

      process.env.DATABASE_URL = pg.databaseUrl;
      // The repo's Prisma client runs in driver-adapter ("client" engine)
      // mode, so a bare `new PrismaClient()` throws — construct it the way
      // packages/db/src/index.ts does, with a pg Pool adapter.
      pool = new Pool({ connectionString: pg.databaseUrl });
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

      const staff = await prisma.human.create({
        data: { name: "Booker", status: "ACTIVE" },
      });
      staffId = staff.id;

      const place = await prisma.place.create({
        data: { name: "Drkmttr", address: "1111 Test Ave, Nashville, TN" },
      });
      placeId = place.id;

      // Every Calendar names a PRIMARY space, NOT NULL and FK-pinned to an
      // ACTIVE one (migration 20260924120000_calendar_primary_space). Holds are
      // what this file is about, so one shared room is enough.
      const room = await prisma.space.create({
        data: { placeId, name: "Main Room", sortOrder: 0 },
      });
      const calendar = await prisma.calendar.create({
        data: {
          placeId,
          name: "Live Music",
          slug: "live-music",
          isDefault: true,
          primarySpaceId: room.id,
          calendarSpaces: { create: [{ spaceId: room.id }] },
        },
      });
      calendarId = calendar.id;
      const other = await prisma.calendar.create({
        data: {
          placeId,
          name: "Social Club",
          slug: "social-club",
          primarySpaceId: room.id,
          calendarSpaces: { create: [{ spaceId: room.id }] },
        },
      });
      otherCalendarId = other.id;

      const org = await prisma.organization.create({
        data: { name: "Drkmttr Org", slug: `drkmttr-${Date.now()}` },
      });
      orgId = org.id;
    } catch (error) {
      runtimeError = error as Error;
      // eslint-disable-next-line no-console
      console.error("booking-holds integration setup failed:", error);
    }
  }, 300_000);

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
    if (pool) await pool.end();
    if (pg) await pg.stop();
  });

  const ready = (skip: () => void): boolean => {
    if (runtimeError || !prisma) {
      skip();
      return false;
    }
    return true;
  };

  // ── (0) SETUP HONESTY GATE ────────────────────────────────────────────────
  // Every other test skips when setup failed; this one does NOT, so a
  // container/migrate/client failure FAILS the suite instead of reporting a
  // fully-green wall of skips.
  test("setup succeeded (container + migrate deploy + driver-adapter client)", () => {
    expect(runtimeError).toBeNull();
    expect(prisma).toBeDefined();
  });

  /**
   * Fresh performer + TO_VENUE request per hold — the SQL-only partial unique
   * "BookingRequest_open_pair_key" allows one open request per (performer,
   * place), so each request needs its own act.
   */
  const mkRequest = async (name: string): Promise<string> => {
    const act = await prisma!.human.create({
      data: { name, status: "ACTIVE" },
    });
    const request = await prisma!.bookingRequest.create({
      data: {
        placeId,
        calendarId,
        performerOwnerType: "human",
        performerOwnerId: act.id,
        message: `${name} wants to play`,
        preferredDates: [DATE],
        expiresAt: new Date("2026-12-01T00:00:00.000Z"),
      },
    });
    return request.id;
  };

  test("create → positions 1,2,3 in one line; listLine orders by position; DATE round-trips as ISO day", async ({
    skip,
  }) => {
    if (!ready(skip)) return;
    const holds = makeBookingHoldsRepo(prisma!);
    const reqA = await mkRequest("Act A");
    const reqB = await mkRequest("Act B");
    const reqC = await mkRequest("Act C");

    // Insert out of order on purpose so ordering is by position, not insert.
    const c = await holds.create({
      bookingRequestId: reqC,
      calendarId,
      date: DATE,
      position: 3,
      placedByHumanId: staffId,
    });
    const a = await holds.create({
      bookingRequestId: reqA,
      calendarId,
      date: DATE,
      position: 1,
      placedByHumanId: staffId,
    });
    const b = await holds.create({
      bookingRequestId: reqB,
      calendarId,
      date: DATE,
      position: 2,
      placedByHumanId: staffId,
    });

    expect(a.status).toBe("ACTIVE");
    expect(a.date).toBe(DATE);
    expect(a.respondBy).toBeNull();
    expect(a.releasedReason).toBeNull();

    const line = await holds.listLine({ calendarId, date: DATE });
    expect(line.map((h) => h.id)).toEqual([a.id, b.id, c.id]);
    expect(line.map((h) => h.position)).toEqual([1, 2, 3]);

    // Range reads see the line; a different calendar / date does not.
    const placeRange = await holds.listLiveForPlaceRange({
      placeId,
      from: "2026-10-01",
      to: "2026-10-31",
    });
    expect(placeRange.map((h) => h.id)).toEqual([a.id, b.id, c.id]);
    expect(
      await holds.listLiveForCalendarRange({
        calendarId: otherCalendarId,
        from: "2026-10-01",
        to: "2026-10-31",
      }),
    ).toEqual([]);
    expect(await holds.listLine({ calendarId, date: OTHER_DATE })).toEqual([]);

    // Batched per-request read groups cleanly.
    const live = await holds.listLiveForRequests([reqA, reqC]);
    expect(live.map((h) => h.bookingRequestId).sort()).toEqual(
      [reqA, reqC].sort(),
    );
    expect(await holds.listLiveForRequests([])).toEqual([]);

    // getById round-trips the same record.
    expect(await holds.getById(a.id)).toEqual(a);
  }, 60_000);

  test("LIVE unique (request, calendar, date) → booking_hold_exists; released date can be re-held; other date/calendar fine", async ({
    skip,
  }) => {
    if (!ready(skip)) return;
    const holds = makeBookingHoldsRepo(prisma!);
    const req = await mkRequest("Act Dup");

    const first = await holds.create({
      bookingRequestId: req,
      calendarId,
      date: OTHER_DATE,
      position: 1,
      placedByHumanId: staffId,
    });
    await expect(
      holds.create({
        bookingRequestId: req,
        calendarId,
        date: OTHER_DATE,
        position: 2,
        placedByHumanId: staffId,
      }),
    ).rejects.toMatchObject({ code: "conflict", message: "booking_hold_exists" });

    // Release it → the partial unique no longer covers the row → the same
    // (request, calendar, date) can be held again (the BLOCKING finding).
    await holds.updateStatus({
      id: first.id,
      status: "RELEASED",
      expectedFrom: ["ACTIVE"],
      releasedAt: new Date(),
      releasedReason: "MANUAL",
    });
    const again = await holds.create({
      bookingRequestId: req,
      calendarId,
      date: OTHER_DATE,
      position: 1,
      placedByHumanId: staffId,
    });
    expect(again.id).not.toBe(first.id);
    expect(again.status).toBe("ACTIVE");
    // Both rows remain (history), only one is live.
    expect(await holds.listForRequest(req)).toHaveLength(2);
    expect((await holds.listLine({ calendarId, date: OTHER_DATE })).map((h) => h.id)).toEqual([again.id]);

    await expect(
      holds.create({
        bookingRequestId: req,
        calendarId: otherCalendarId,
        date: OTHER_DATE,
        position: 1,
        placedByHumanId: staffId,
      }),
    ).resolves.toMatchObject({ calendarId: otherCalendarId, position: 1 });
    await expect(
      holds.create({
        bookingRequestId: req,
        calendarId,
        date: "2026-10-15",
        position: 1,
        placedByHumanId: staffId,
      }),
    ).resolves.toMatchObject({ date: "2026-10-15" });

    // A vanished target (unknown calendar) is a domain error, not a raw P2003.
    await expect(
      holds.create({
        bookingRequestId: req,
        calendarId: "00000000-0000-4000-8000-000000000000",
        date: "2026-10-16",
        position: 1,
        placedByHumanId: staffId,
      }),
    ).rejects.toMatchObject({ code: "conflict", message: "booking_hold_target_missing" });
  }, 60_000);

  test("updateStatus CAS: zero-match throws booking_hold_status_changed; a real transition writes the stamped fields", async ({
    skip,
  }) => {
    if (!ready(skip)) return;
    const holds = makeBookingHoldsRepo(prisma!);
    const req = await mkRequest("Act CAS");
    const hold = await holds.create({
      bookingRequestId: req,
      calendarId,
      date: "2026-11-01",
      position: 1,
      placedByHumanId: staffId,
    });

    // Wrong expectedFrom → no write, conflict.
    await expect(
      holds.updateStatus({
        id: hold.id,
        status: "RELEASED",
        expectedFrom: ["CHALLENGED"],
        releasedAt: new Date(),
        releasedReason: "MANUAL",
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "booking_hold_status_changed",
    });
    expect((await holds.getById(hold.id))?.status).toBe("ACTIVE");

    // Challenge (ACTIVE → CHALLENGED) stamps the deadline.
    const respondBy = new Date("2026-10-20T12:00:00.000Z");
    const challenged = await holds.updateStatus({
      id: hold.id,
      status: "CHALLENGED",
      expectedFrom: ["ACTIVE"],
      challengedAt: new Date("2026-10-19T12:00:00.000Z"),
      respondBy,
    });
    expect(challenged.status).toBe("CHALLENGED");
    expect(challenged.respondBy).toEqual(respondBy);

    // Extend only while CHALLENGED.
    const later = new Date("2026-10-21T12:00:00.000Z");
    const extended = await holds.setRespondBy({
      id: hold.id,
      respondBy: later,
      expectedStatus: "CHALLENGED",
    });
    expect(extended.respondBy).toEqual(later);

    // Keep (CHALLENGED → ACTIVE) clears the deadline WITHOUT the caller
    // passing respondBy: null (adapter normalisation; the DB CHECK
    // "BookingHold_respondBy_challenged_check" would reject otherwise).
    const kept = await holds.updateStatus({
      id: hold.id,
      status: "ACTIVE",
      expectedFrom: ["CHALLENGED"],
    });
    expect(kept.status).toBe("ACTIVE");
    expect(kept.respondBy).toBeNull();
    await expect(
      holds.setRespondBy({ id: hold.id, respondBy: later, expectedStatus: "CHALLENGED" }),
    ).rejects.toMatchObject({ code: "conflict" });

    // The CHECK is real and biconditional: respondBy on an ACTIVE row fails,
    // and so does CHALLENGED with a NULL respondBy (a challenge that could
    // never lapse).
    await expect(
      prisma!.bookingHold.update({ where: { id: hold.id }, data: { respondBy: later } }),
    ).rejects.toThrow(/BookingHold_respondBy_challenged_check/);
    await expect(
      prisma!.bookingHold.update({
        where: { id: hold.id },
        data: { status: "CHALLENGED", respondBy: null },
      }),
    ).rejects.toThrow(/BookingHold_respondBy_challenged_check/);
  }, 60_000);

  test("renumberLine rewrites 1..n in the given order, rejects a stale/foreign id set, and ignores released rows", async ({
    skip,
  }) => {
    if (!ready(skip)) return;
    const holds = makeBookingHoldsRepo(prisma!);
    const date = "2026-11-05";
    const ids: string[] = [];
    for (const name of ["R1", "R2", "R3"]) {
      const req = await mkRequest(`Act ${name}`);
      const hold = await holds.create({
        bookingRequestId: req,
        calendarId,
        date,
        position: ids.length + 1,
        placedByHumanId: staffId,
      });
      ids.push(hold.id);
    }
    const [h1, h2, h3] = ids as [string, string, string];

    // renumberLine takes FOR UPDATE locks, so it runs on the tx client (port
    // contract); outside a tx the lock would evaporate at statement end.
    const renumber = (orderedIds: string[]) =>
      prisma!.$transaction((tx) =>
        makeBookingHoldsRepo(tx).renumberLine({ calendarId, date, orderedIds }),
      );

    // The raw FOR UPDATE select (ISO string bound + ::date) must actually
    // match the line — a TZ/encoding mismatch would return zero rows and
    // lock nothing.
    const locked = await prisma!.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "BookingHold"
      WHERE "calendarId" = ${calendarId}
        AND "date" = ${date}::date
        AND "status" IN ('ACTIVE', 'CHALLENGED')
      ORDER BY "id"
      FOR UPDATE
    `;
    expect(locked.map((r) => r.id).sort()).toEqual([...ids].sort());

    // Move h3 to the front.
    const reordered = await renumber([h3, h1, h2]);
    expect(reordered.map((h) => h.id)).toEqual([h3, h1, h2]);
    expect(reordered.map((h) => h.position)).toEqual([1, 2, 3]);

    // An id outside the line / a missing live id / a duplicate → conflict.
    await expect(renumber([h3, h1])).rejects.toMatchObject({
      code: "conflict",
      message: "booking_hold_line_changed",
    });
    await expect(renumber([h3, h1, h1])).rejects.toMatchObject({
      code: "conflict",
      message: "booking_hold_line_changed",
    });
    await expect(
      renumber([h3, h1, h2, "00000000-0000-4000-8000-000000000000"]),
    ).rejects.toMatchObject({ code: "conflict", message: "booking_hold_line_changed" });

    // Release the front hold; the line moves up and the released row keeps
    // its last position but no longer participates.
    await holds.updateStatus({
      id: h3,
      status: "RELEASED",
      expectedFrom: ["ACTIVE", "CHALLENGED"],
      releasedAt: new Date(),
      releasedReason: "MANUAL",
    });
    const moved = await renumber([h1, h2]);
    expect(moved.map((h) => [h.id, h.position])).toEqual([
      [h1, 1],
      [h2, 2],
    ]);
    expect(await holds.listLine({ calendarId, date })).toHaveLength(2);
    const all = await holds.listForRequest(
      (await holds.getById(h3))!.bookingRequestId,
    );
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ status: "RELEASED", releasedReason: "MANUAL" });
  }, 60_000);

  test("NFR-002 (same-row CAS): two concurrent confirms on ONE hold → exactly one CONFIRMED winner", async ({
    skip,
  }) => {
    if (!ready(skip)) return;
    const holds = makeBookingHoldsRepo(prisma!);
    const req = await mkRequest("Act Race");
    const hold = await holds.create({
      bookingRequestId: req,
      calendarId,
      date: "2026-11-10",
      position: 1,
      placedByHumanId: staffId,
    });

    const confirm = () =>
      holds.updateStatus({
        id: hold.id,
        status: "CONFIRMED",
        expectedFrom: ["ACTIVE", "CHALLENGED"],
        confirmedAt: new Date(),
      });

    // Both writes race on the pg Pool (separate connections). The second
    // UPDATE blocks on the row lock, re-evaluates its WHERE against the
    // committed CONFIRMED status, matches zero rows → conflict.
    const results = await Promise.allSettled([confirm(), confirm()]);
    const wins = results.filter((r) => r.status === "fulfilled");
    const losses = results.filter((r) => r.status === "rejected");
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(1);
    expect((losses[0] as PromiseRejectedResult).reason).toMatchObject({
      code: "conflict",
      message: "booking_hold_status_changed",
    });
    expect((await holds.getById(hold.id))?.status).toBe("CONFIRMED");
  }, 60_000);

  test("NFR-002 (line level): two DIFFERENT ACTIVE holds in one line, concurrent confirm → one CONFIRMED, the other booking_hold_line_confirmed", async ({
    skip,
  }) => {
    if (!ready(skip)) return;
    const holds = makeBookingHoldsRepo(prisma!);
    const date = "2026-11-12";
    const reqA = await mkRequest("Act Line A");
    const reqB = await mkRequest("Act Line B");
    const a = await holds.create({
      bookingRequestId: reqA,
      calendarId,
      date,
      position: 1,
      placedByHumanId: staffId,
    });
    const b = await holds.create({
      bookingRequestId: reqB,
      calendarId,
      date,
      position: 2,
      placedByHumanId: staffId,
    });

    const confirm = (id: string) =>
      holds.updateStatus({
        id,
        status: "CONFIRMED",
        expectedFrom: ["ACTIVE", "CHALLENGED"],
        confirmedAt: new Date(),
      });

    // Per-row CAS can't see the other row; the partial unique
    // "BookingHold_confirmed_line_key" is what makes the loser fail.
    const results = await Promise.allSettled([confirm(a.id), confirm(b.id)]);
    const wins = results.filter((r) => r.status === "fulfilled");
    const losses = results.filter((r) => r.status === "rejected");
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(1);
    expect((losses[0] as PromiseRejectedResult).reason).toMatchObject({
      code: "conflict",
      message: "booking_hold_line_confirmed",
    });
    const line = await prisma!.bookingHold.findMany({
      where: { calendarId, date: new Date(`${date}T00:00:00.000Z`) },
    });
    expect(line.filter((h) => h.status === "CONFIRMED")).toHaveLength(1);
    expect(line.filter((h) => h.status === "ACTIVE")).toHaveLength(1);
  }, 60_000);

  test("bookingRequests.setAssignee round-trips and rejects a missing id; bookingTags CRUD + replace-all attach are org-scoped", async ({
    skip,
  }) => {
    if (!ready(skip)) return;
    const requests = makeBookingRequestsRepo(prisma!);
    const tags = makeBookingTagsRepo(prisma!);
    const req = await mkRequest("Act Tagged");

    const assigned = await requests.setAssignee({ id: req, assigneeHumanId: staffId });
    expect(assigned.assigneeHumanId).toBe(staffId);
    const cleared = await requests.setAssignee({ id: req, assigneeHumanId: null });
    expect(cleared.assigneeHumanId).toBeNull();
    await expect(
      requests.setAssignee({
        id: "00000000-0000-4000-8000-000000000000",
        assigneeHumanId: staffId,
      }),
    ).rejects.toMatchObject({ code: "not_found", message: "booking_request_not_found" });

    const followUp = await tags.create({
      orgId,
      name: "Follow up",
      slug: "follow-up",
      color: "warning",
      sortOrder: 2,
    });
    const hot = await tags.create({ orgId, name: "Hot", slug: "hot", color: "danger" });
    await expect(
      tags.create({ orgId, name: "Follow Up!", slug: "follow-up", color: "info" }),
    ).rejects.toMatchObject({ code: "conflict", message: "booking_tag_slug_taken" });

    // sortOrder asc then name asc.
    expect((await tags.listForOrg(orgId)).map((t) => t.slug)).toEqual([
      "hot",
      "follow-up",
    ]);

    // Org-scoped update/delete: another org's id matches nothing.
    expect(
      await tags.update({ id: hot.id, orgId: "not-this-org", name: "Nope" }),
    ).toBeNull();
    expect(await tags.delete({ id: hot.id, orgId: "not-this-org" })).toBe(false);
    const recoloured = await tags.update({ id: hot.id, orgId, color: "accent" });
    expect(recoloured?.color).toBe("accent");

    // Replace-all attach, org-scoped: a tag from another org is rejected
    // before any write.
    const otherOrg = await prisma!.organization.create({
      data: { name: "Rival Org", slug: `rival-${Date.now()}` },
    });
    const foreign = await tags.create({
      orgId: otherOrg.id,
      name: "Foreign",
      slug: "foreign",
      color: "neutral",
    });
    await expect(
      tags.setForRequest({ bookingRequestId: req, orgId, tagIds: [followUp.id, foreign.id] }),
    ).rejects.toMatchObject({ code: "invalid_input", message: "booking_tag_foreign_org" });
    expect(await tags.listForRequests([req])).toEqual([]);

    expect(
      (
        await tags.setForRequest({
          bookingRequestId: req,
          orgId,
          tagIds: [followUp.id, hot.id],
        })
      ).map((t) => t.id),
    ).toEqual([hot.id, followUp.id]);
    expect(
      (await tags.setForRequest({ bookingRequestId: req, orgId, tagIds: [followUp.id] })).map(
        (t) => t.id,
      ),
    ).toEqual([followUp.id]);
    const batched = await tags.listForRequests([req]);
    expect(batched).toEqual([
      { bookingRequestId: req, tag: expect.objectContaining({ id: followUp.id }) },
    ]);

    // Delete detaches (join cascades) — the request survives.
    expect(await tags.delete({ id: followUp.id, orgId })).toBe(true);
    expect(await tags.listForRequests([req])).toEqual([]);
    expect(await requests.getById(req)).not.toBeNull();
  }, 60_000);
});
