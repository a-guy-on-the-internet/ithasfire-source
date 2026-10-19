import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

import {
  BOOKING_HOLD_SELECT,
  dbDateToIso,
  isoDateToDb,
  makeBookingHoldsRepo,
  mapBookingHoldRecord,
} from "../booking-holds";
import type { PrismaClientOrTx } from "../types";
import type { UpdateBookingHoldStatusInput } from "@th/ports/repos/booking-holds";

/**
 * Query-shape + mapping coverage for the BookingHold adapter (booking-holds
 * spec 2026-08-25, Step 1). The DB-backed behaviour (unique, CAS, renumber,
 * concurrency) lives in test/integration/booking-holds.test.ts; this file
 * pins the pieces that are pure: the DATE ↔ ISO round trip, the record
 * shape, and the WHERE clauses core relies on (live-only scoping, the
 * place-range join, the CAS status guard).
 */

const HOLD_ID = "11111111-1111-4111-8111-111111111111";
const CAL_ID = "22222222-2222-4222-8222-222222222222";
const REQ_ID = "33333333-3333-4333-8333-333333333333";

const ROW = {
  id: HOLD_ID,
  ownerKind: "REQUEST",
  bookingRequestId: REQ_ID,
  calendarId: CAL_ID,
  spaceId: null,
  date: new Date("2026-10-13T00:00:00.000Z"),
  position: 2,
  status: "CHALLENGED",
  placedByHumanId: "human-1",
  challengedAt: new Date("2026-09-01T10:00:00.000Z"),
  respondBy: new Date("2026-09-02T10:00:00.000Z"),
  releasedAt: null,
  releasedReason: null,
  confirmedAt: null,
  grantId: null as string | null,
  holderOrgId: null as string | null,
  holderHumanId: null as string | null,
  eventId: null as string | null,
  note: null as string | null,
  noteUpdatedByHumanId: null as string | null,
  noteUpdatedAt: null as Date | null,
  createdAt: new Date("2026-08-30T10:00:00.000Z"),
  updatedAt: new Date("2026-09-01T10:00:00.000Z"),
  // The joined grant (BOOKING_HOLD_SELECT.grant): set on a BOOKER row only.
  grant: null as { revokedAt: Date | null; expiresAt: Date | null } | null,
};

/** A BOOKER row's joined grant, revoked and with an expiry (GRANT_ENDED's inputs). */
const GRANT_JOIN = {
  revokedAt: new Date("2026-09-01T10:00:00.000Z"),
  expiresAt: new Date("2026-12-31T00:00:00.000Z"),
};

function holdPrisma() {
  const findMany = vi.fn(async () => [ROW]);
  const updateMany = vi.fn(async () => ({ count: 1 }));
  const findUniqueOrThrow = vi.fn(async () => ROW);
  const create = vi.fn(async () => ROW);
  const $executeRaw = vi.fn(async () => 1);
  const $queryRaw = vi.fn(async () => []);
  const prisma = {
    bookingHold: { findMany, updateMany, findUniqueOrThrow, create },
    $executeRaw,
    $queryRaw,
  } as unknown as PrismaClientOrTx;
  return { prisma, findMany, updateMany, findUniqueOrThrow, create, $executeRaw, $queryRaw };
}

const knownError = (code: string) =>
  new Prisma.PrismaClientKnownRequestError("boom", {
    code,
    clientVersion: "test",
  });

describe("booking-holds date helpers", () => {
  it("round-trips an ISO calendar day through UTC midnight (never local time)", () => {
    const db = isoDateToDb("2026-10-13");
    expect(db.toISOString()).toBe("2026-10-13T00:00:00.000Z");
    expect(dbDateToIso(db)).toBe("2026-10-13");
  });

  it("rejects anything that is not YYYY-MM-DD, and impossible calendar days", () => {
    expect(() => isoDateToDb("2026-10-13T00:00:00Z")).toThrow(
      /booking_hold_date_invalid/,
    );
    expect(() => isoDateToDb("13/10/2026")).toThrow(/booking_hold_date_invalid/);
    // Would silently parse as Mar 2 / NaN without the round-trip check.
    expect(() => isoDateToDb("2026-02-30")).toThrow(/booking_hold_date_invalid/);
    expect(() => isoDateToDb("2026-13-01")).toThrow(/booking_hold_date_invalid/);
    expect(isoDateToDb("2028-02-29").toISOString()).toBe("2028-02-29T00:00:00.000Z");
  });
});

describe("mapBookingHoldRecord", () => {
  const SHARED = {
    id: HOLD_ID,
    calendarId: CAL_ID,
    spaceId: null,
    date: "2026-10-13",
    position: 2,
    status: "CHALLENGED",
    placedByHumanId: "human-1",
    challengedAt: ROW.challengedAt,
    respondBy: ROW.respondBy,
    releasedAt: null,
    releasedReason: null,
    confirmedAt: null,
    eventId: null,
    note: null,
    noteUpdatedByHumanId: null,
    noteUpdatedAt: null,
    createdAt: ROW.createdAt,
    updatedAt: ROW.updatedAt,
  };

  it("maps a REQUEST row: every shared column plus its request, date as ISO day", () => {
    const record = mapBookingHoldRecord(ROW);
    expect(record).toEqual({
      ...SHARED,
      ownerKind: "REQUEST",
      bookingRequestId: REQ_ID,
    });
    // The select and the mapper must cover the same columns — a column added
    // to one without the other is a silent undefined on the record. The
    // per-kind columns (request id / grant / holder pair / the joined grant)
    // fold into the kind's own fields, so they are listed here explicitly.
    const perKindColumns = ["bookingRequestId", "grantId", "holderOrgId", "holderHumanId", "grant"];
    expect(
      [...new Set([...Object.keys(record), ...perKindColumns])].sort(),
    ).toEqual(Object.keys(BOOKING_HOLD_SELECT).sort());
  });

  it("maps a BOOKER row with an org holder and its grant", () => {
    expect(
      mapBookingHoldRecord({
        ...ROW,
        ownerKind: "BOOKER",
        bookingRequestId: null,
        grantId: "grant-1",
        holderOrgId: "org-1",
        grant: GRANT_JOIN,
        status: "RELEASED",
        respondBy: null,
        releasedAt: ROW.updatedAt,
        // Only a BOOKER hold carries it; the port now knows it.
        releasedReason: "GRANT_ENDED",
      }),
    ).toEqual({
      ...SHARED,
      status: "RELEASED",
      respondBy: null,
      releasedAt: ROW.updatedAt,
      releasedReason: "GRANT_ENDED",
      ownerKind: "BOOKER",
      grantId: "grant-1",
      holder: { kind: "org", orgId: "org-1" },
      grantRevokedAt: GRANT_JOIN.revokedAt,
      grantExpiresAt: GRANT_JOIN.expiresAt,
    });
  });

  it("maps a BOOKER row with a person holder", () => {
    const record = mapBookingHoldRecord({
      ...ROW,
      ownerKind: "BOOKER",
      bookingRequestId: null,
      grantId: "grant-1",
      holderHumanId: "human-9",
      grant: { revokedAt: null, expiresAt: null },
    });
    expect(record).toMatchObject({
      ownerKind: "BOOKER",
      holder: { kind: "person", humanId: "human-9" },
      grantRevokedAt: null,
      grantExpiresAt: null,
    });
    expect(record).not.toHaveProperty("bookingRequestId");
  });

  it("maps a PLACE row: unassigned (holder null) or naming one party, plus note and event", () => {
    const noteAt = new Date("2026-09-03T10:00:00.000Z");
    expect(
      mapBookingHoldRecord({
        ...ROW,
        ownerKind: "PLACE",
        bookingRequestId: null,
        eventId: "event-1",
        note: "load-in 6pm",
        noteUpdatedByHumanId: "human-1",
        noteUpdatedAt: noteAt,
      }),
    ).toEqual({
      ...SHARED,
      eventId: "event-1",
      note: "load-in 6pm",
      noteUpdatedByHumanId: "human-1",
      noteUpdatedAt: noteAt,
      ownerKind: "PLACE",
      holder: null,
    });
    expect(
      mapBookingHoldRecord({
        ...ROW,
        ownerKind: "PLACE",
        bookingRequestId: null,
        holderHumanId: "human-9",
      }),
    ).toMatchObject({ ownerKind: "PLACE", holder: { kind: "person", humanId: "human-9" } });
  });

  // The CHECK "BookingHold_owner_kind_shape" forbids these; a row that breaks
  // it anyway must throw, never reach core as a hold of the wrong kind.
  it.each([
    ["REQUEST with no request", { bookingRequestId: null }],
    ["REQUEST with a grant", { grantId: "grant-1" }],
    ["REQUEST with a holder", { holderOrgId: "org-1" }],
    ["BOOKER with no grant", { ownerKind: "BOOKER", bookingRequestId: null, holderOrgId: "org-1" }],
    ["BOOKER with no holder", { ownerKind: "BOOKER", bookingRequestId: null, grantId: "grant-1", grant: GRANT_JOIN }],
    ["BOOKER with a request", { ownerKind: "BOOKER", grantId: "grant-1", holderOrgId: "org-1", grant: GRANT_JOIN }],
    [
      "BOOKER with both holders",
      {
        ownerKind: "BOOKER",
        bookingRequestId: null,
        grantId: "grant-1",
        holderOrgId: "org-1",
        holderHumanId: "human-9",
        grant: GRANT_JOIN,
      },
    ],
    // The grant id without its joined row (a select that dropped the join).
    ["BOOKER with no joined grant", { ownerKind: "BOOKER", bookingRequestId: null, grantId: "grant-1", holderOrgId: "org-1" }],
    ["PLACE with a request", { ownerKind: "PLACE" }],
    ["PLACE with a grant", { ownerKind: "PLACE", bookingRequestId: null, grantId: "grant-1" }],
  ] as const)("throws on %s (shape CHECK breach)", (_label, over) => {
    expect(() => mapBookingHoldRecord({ ...ROW, ...over })).toThrow(
      /booking_hold_owner_kind_shape/,
    );
  });

  it("throws on an owner kind the port does not know", () => {
    expect(() => mapBookingHoldRecord({ ...ROW, ownerKind: "AGENT" })).toThrow(
      /booking_hold_owner_kind_unsupported/,
    );
  });
});

describe("bookingHolds query shapes", () => {
  it("listLine scopes to LIVE statuses on the exact calendar+date, position asc", async () => {
    const { prisma, findMany } = holdPrisma();
    const line = await makeBookingHoldsRepo(prisma).listLine({
      calendarId: CAL_ID,
      date: "2026-10-13",
    });
    expect(line).toHaveLength(1);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          calendarId: CAL_ID,
          date: new Date("2026-10-13T00:00:00.000Z"),
          status: { in: ["ACTIVE", "CHALLENGED"] },
        },
        orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      }),
    );
  });

  it("listLiveForPlaceRange joins through calendar.placeId with an inclusive DATE range", async () => {
    const { prisma, findMany } = holdPrisma();
    await makeBookingHoldsRepo(prisma).listLiveForPlaceRange({
      placeId: "place-1",
      from: "2026-10-01",
      to: "2026-10-31",
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          calendar: { placeId: "place-1" },
          date: {
            gte: new Date("2026-10-01T00:00:00.000Z"),
            lte: new Date("2026-10-31T00:00:00.000Z"),
          },
          status: { in: ["ACTIVE", "CHALLENGED"] },
        },
      }),
    );
  });

  it("both range reads widen past LIVE when `statuses` is passed (the admin overlay's CONFIRMED)", async () => {
    const overlay = ["ACTIVE", "CHALLENGED", "CONFIRMED"] as const;

    const place = holdPrisma();
    await makeBookingHoldsRepo(place.prisma).listLiveForPlaceRange({
      placeId: "place-1",
      from: "2026-10-01",
      to: "2026-10-31",
      statuses: overlay,
    });
    expect(place.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: ["ACTIVE", "CHALLENGED", "CONFIRMED"] },
        }),
      }),
    );

    const calendar = holdPrisma();
    await makeBookingHoldsRepo(calendar.prisma).listLiveForCalendarRange({
      calendarId: "cal-1",
      from: "2026-10-01",
      to: "2026-10-31",
      statuses: overlay,
    });
    expect(calendar.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          calendarId: "cal-1",
          status: { in: ["ACTIVE", "CHALLENGED", "CONFIRMED"] },
        }),
      }),
    );
  });

  it("listForRequester scopes on the request's owner pair + TO_VENUE in the WHERE and joins the venue context (FR-004)", async () => {
    // The requester-side read's tenant boundary is the query itself — the
    // owner pair must be in the WHERE (via the BookingRequest relation), never
    // applied to the result afterwards.
    const findMany = vi.fn(async () => [
      {
        ...ROW,
        bookingRequest: { actName: "The Band" },
        calendar: {
          placeId: "place-1",
          place: { name: "Drkmttr", timezone: "America/Chicago" },
        },
      },
    ]);
    const prisma = { bookingHold: { findMany } } as unknown as PrismaClientOrTx;

    const rows = await makeBookingHoldsRepo(prisma).listForRequester({
      ownerType: "organization",
      ownerId: "org-band",
      statuses: ["ACTIVE", "CHALLENGED", "CONFIRMED"],
    });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          ownerKind: "REQUEST",
          status: { in: ["ACTIVE", "CHALLENGED", "CONFIRMED"] },
          bookingRequest: {
            direction: "TO_VENUE",
            performerOwnerType: "organization",
            performerOwnerId: "org-band",
          },
        },
        orderBy: [
          { date: "asc" },
          { calendarId: "asc" },
          { position: "asc" },
          { createdAt: "asc" },
          { id: "asc" },
        ],
      }),
    );
    expect(rows).toEqual([
      {
        ...mapBookingHoldRecord(ROW),
        placeId: "place-1",
        placeName: "Drkmttr",
        placeTimezone: "America/Chicago",
        requestActName: "The Band",
      },
    ]);
  });

  it("listForRequester defaults to LIVE statuses like every other range read", async () => {
    const findMany = vi.fn(async () => []);
    const prisma = { bookingHold: { findMany } } as unknown as PrismaClientOrTx;
    await makeBookingHoldsRepo(prisma).listForRequester({
      ownerType: "human",
      ownerId: "human-1",
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: ["ACTIVE", "CHALLENGED"] },
          bookingRequest: expect.objectContaining({ performerOwnerType: "human", performerOwnerId: "human-1" }),
        }),
      }),
    );
  });

  it("listLiveForRequests short-circuits on an empty set without touching the DB", async () => {
    const { prisma, findMany } = holdPrisma();
    expect(await makeBookingHoldsRepo(prisma).listLiveForRequests([])).toEqual(
      [],
    );
    expect(findMany).not.toHaveBeenCalled();
  });

  it("listRequestIdsWithConfirmedHold short-circuits on an empty set without touching the DB", async () => {
    const { prisma, findMany } = holdPrisma();
    expect(await makeBookingHoldsRepo(prisma).listRequestIdsWithConfirmedHold([])).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("listRequestIdsWithConfirmedHold reads CONFIRMED rows for the set, one id per request", async () => {
    const { prisma, findMany } = holdPrisma();
    findMany.mockResolvedValueOnce([{ bookingRequestId: "req-a" }] as never);
    expect(
      await makeBookingHoldsRepo(prisma).listRequestIdsWithConfirmedHold(["req-a", "req-b"]),
    ).toEqual(["req-a"]);
    expect(findMany).toHaveBeenCalledWith({
      where: {
        ownerKind: "REQUEST",
        bookingRequestId: { in: ["req-a", "req-b"] },
        status: "CONFIRMED",
      },
      distinct: ["bookingRequestId"],
      select: { bookingRequestId: true },
    });
  });

  it("updateStatus carries the expectedFrom guard in the WHERE and only writes provided fields", async () => {
    const { prisma, updateMany } = holdPrisma();
    const respondBy = new Date("2026-09-02T10:00:00.000Z");
    await makeBookingHoldsRepo(prisma).updateStatus({
      id: HOLD_ID,
      status: "CHALLENGED",
      expectedFrom: ["ACTIVE"],
      challengedAt: ROW.challengedAt,
      respondBy,
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: HOLD_ID, status: { in: ["ACTIVE"] } },
      data: {
        status: "CHALLENGED",
        challengedAt: ROW.challengedAt,
        respondBy,
        // Not CONFIRMED / RELEASED → those stamps are normalised to NULL.
        confirmedAt: null,
        releasedAt: null,
        releasedReason: null,
      },
    });
  });

  it("updateStatus nulls respondBy on any non-CHALLENGED target unless the caller set it", async () => {
    const { prisma, updateMany } = holdPrisma();
    const confirmedAt = new Date("2026-10-02T10:00:00.000Z");
    await makeBookingHoldsRepo(prisma).updateStatus({
      id: HOLD_ID,
      status: "CONFIRMED",
      expectedFrom: ["ACTIVE", "CHALLENGED"],
      confirmedAt,
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: HOLD_ID, status: { in: ["ACTIVE", "CHALLENGED"] } },
      data: {
        status: "CONFIRMED",
        respondBy: null,
        confirmedAt,
        releasedAt: null,
        releasedReason: null,
      },
    });
  });

  it("updateStatus: CHALLENGED requires respondBy at the type level; extend is setRespondBy, not updateStatus", () => {
    // A CHALLENGED transition without respondBy is not a valid input.
    expectTypeOf<{
      id: string;
      status: "CHALLENGED";
      expectedFrom: readonly ["ACTIVE"];
    }>().not.toMatchTypeOf<UpdateBookingHoldStatusInput>();
    // ...and a non-CHALLENGED target may not carry one.
    expectTypeOf<{
      id: string;
      status: "ACTIVE";
      expectedFrom: readonly ["CHALLENGED"];
      respondBy: Date;
    }>().not.toMatchTypeOf<UpdateBookingHoldStatusInput>();
    expectTypeOf<{
      id: string;
      status: "CHALLENGED";
      expectedFrom: readonly ["ACTIVE"];
      respondBy: Date;
    }>().toMatchTypeOf<UpdateBookingHoldStatusInput>();
  });

  it("create takes the line advisory lock (namespaced calendarId|date) before inserting", async () => {
    const { prisma, $executeRaw, create } = holdPrisma();
    await makeBookingHoldsRepo(prisma).create({
      bookingRequestId: REQ_ID,
      calendarId: CAL_ID,
      date: "2026-10-13",
      position: 1,
      placedByHumanId: "human-1",
    });
    expect($executeRaw).toHaveBeenCalledTimes(1);
    const [strings, key] = $executeRaw.mock.calls[0] as unknown as [TemplateStringsArray, string];
    expect(strings.join("?")).toContain("pg_advisory_xact_lock(hashtext(?))");
    expect(key).toBe(`booking_hold_line:${CAL_ID}|2026-10-13`);
    expect($executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      create.mock.invocationCallOrder[0]!,
    );
  });

  it("renumberLine takes the advisory lock, then FOR UPDATE bound to the ISO string (not a Date)", async () => {
    const { prisma, $executeRaw, $queryRaw, findMany } = holdPrisma();
    findMany.mockResolvedValue([ROW]);
    await makeBookingHoldsRepo(prisma).renumberLine({
      calendarId: CAL_ID,
      date: "2026-10-13",
      orderedIds: [HOLD_ID],
    });
    expect($executeRaw).toHaveBeenCalledTimes(1);
    const [, lockKey] = $executeRaw.mock.calls[0] as unknown as [unknown, string];
    expect(lockKey).toBe(`booking_hold_line:${CAL_ID}|2026-10-13`);
    const [strings, ...params] = $queryRaw.mock.calls[0] as unknown as [TemplateStringsArray, ...unknown[]];
    expect(strings.join("?").replace(/\s+/g, " ")).toContain('AND "date" = ?::date');
    expect(params).toEqual([CAL_ID, "2026-10-13"]);
    expect($executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      $queryRaw.mock.invocationCallOrder[0]!,
    );
  });

  it("lockLine takes the SAME advisory lock key as create/renumberLine, and rejects a bad date before locking", async () => {
    const { prisma, $executeRaw } = holdPrisma();
    await makeBookingHoldsRepo(prisma).lockLine({ calendarId: CAL_ID, date: "2026-10-13" });
    expect($executeRaw).toHaveBeenCalledTimes(1);
    const [strings, key] = $executeRaw.mock.calls[0] as unknown as [TemplateStringsArray, string];
    expect(strings.join("?")).toContain("pg_advisory_xact_lock(hashtext(?))");
    expect(key).toBe(`booking_hold_line:${CAL_ID}|2026-10-13`);

    await expect(
      makeBookingHoldsRepo(prisma).lockLine({ calendarId: CAL_ID, date: "13/10/2026" }),
    ).rejects.toThrow(/booking_hold_date_invalid/);
    expect($executeRaw).toHaveBeenCalledTimes(1);
  });

  it("lockRequestBooking takes its OWN key namespace (never a line or bill key), as a bound parameter (booking-the-night P2c)", async () => {
    const { prisma, $executeRaw } = holdPrisma();
    const REQUEST = "44444444-4444-4444-8444-444444444444";
    await makeBookingHoldsRepo(prisma).lockRequestBooking(REQUEST);
    expect($executeRaw).toHaveBeenCalledTimes(1);
    const [strings, key] = $executeRaw.mock.calls[0] as unknown as [TemplateStringsArray, string];
    expect(strings.join("?")).toContain("pg_advisory_xact_lock(hashtext(?))");
    expect(key).toBe(`booking_request_booking:${REQUEST}`);
  });

  it("listLine is LIVE-only by default and widens to the given statuses", async () => {
    const { prisma, findMany } = holdPrisma();
    const repo = makeBookingHoldsRepo(prisma);
    await repo.listLine({ calendarId: CAL_ID, date: "2026-10-13" });
    expect(findMany.mock.calls[0]![0]).toMatchObject({
      where: { status: { in: ["ACTIVE", "CHALLENGED"] } },
    });
    await repo.listLine({ calendarId: CAL_ID, date: "2026-10-13", statuses: ["CONFIRMED"] });
    expect(findMany.mock.calls[1]![0]).toMatchObject({
      where: { status: { in: ["CONFIRMED"] } },
    });
  });

  it("maps a deadlock / serialization failure to booking_hold_line_changed on create, updateStatus and renumberLine", async () => {
    const { prisma, create, updateMany, $queryRaw } = holdPrisma();
    const repo = makeBookingHoldsRepo(prisma);
    const input = { bookingRequestId: REQ_ID, calendarId: CAL_ID, date: "2026-10-13", position: 1, placedByHumanId: "human-1" };

    create.mockRejectedValueOnce(knownError("P2034"));
    await expect(repo.create(input)).rejects.toMatchObject({ code: "conflict", message: "booking_hold_line_changed" });

    updateMany.mockRejectedValueOnce(knownError("P2034"));
    await expect(
      repo.updateStatus({ id: HOLD_ID, status: "RELEASED", expectedFrom: ["ACTIVE"] }),
    ).rejects.toMatchObject({ code: "conflict", message: "booking_hold_line_changed" });

    // The FOR UPDATE raw query surfaces a 40P01 as an UNKNOWN request error.
    $queryRaw.mockRejectedValueOnce(
      new Prisma.PrismaClientUnknownRequestError("Error occurred during query execution: ... Code: `40P01`, message: \"deadlock detected\"", { clientVersion: "test" }),
    );
    await expect(
      repo.renumberLine({ calendarId: CAL_ID, date: "2026-10-13", orderedIds: [HOLD_ID] }),
    ).rejects.toMatchObject({ code: "conflict", message: "booking_hold_line_changed" });

    // Anything else still passes through untouched.
    create.mockRejectedValueOnce(new Error("boom"));
    await expect(repo.create(input)).rejects.toThrow("boom");
  });

  it("updateStatus maps the confirmed-line partial unique (P2002) to booking_hold_line_confirmed", async () => {
    const { prisma, updateMany } = holdPrisma();
    updateMany.mockRejectedValueOnce(knownError("P2002"));
    await expect(
      makeBookingHoldsRepo(prisma).updateStatus({
        id: HOLD_ID,
        status: "CONFIRMED",
        expectedFrom: ["ACTIVE"],
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "booking_hold_line_confirmed",
    });
  });

  it("create maps P2002 → booking_hold_exists and P2003 → booking_hold_target_missing", async () => {
    const { prisma, create } = holdPrisma();
    const input = {
      bookingRequestId: REQ_ID,
      calendarId: CAL_ID,
      date: "2026-10-13",
      position: 1,
      placedByHumanId: "human-1",
    };
    create.mockRejectedValueOnce(knownError("P2002"));
    await expect(makeBookingHoldsRepo(prisma).create(input)).rejects.toMatchObject(
      { code: "conflict", message: "booking_hold_exists" },
    );
    create.mockRejectedValueOnce(knownError("P2003"));
    await expect(makeBookingHoldsRepo(prisma).create(input)).rejects.toMatchObject(
      { code: "conflict", message: "booking_hold_target_missing" },
    );
  });

  it("updateStatus maps a zero-row CAS miss to the shared conflict shape", async () => {
    const { prisma, updateMany, findUniqueOrThrow } = holdPrisma();
    updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      makeBookingHoldsRepo(prisma).updateStatus({
        id: HOLD_ID,
        status: "CONFIRMED",
        expectedFrom: ["ACTIVE", "CHALLENGED"],
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "booking_hold_status_changed",
    });
    expect(findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it("setRespondBy is guarded on the literal CHALLENGED status", async () => {
    const { prisma, updateMany } = holdPrisma();
    const respondBy = new Date("2026-09-03T10:00:00.000Z");
    await makeBookingHoldsRepo(prisma).setRespondBy({
      id: HOLD_ID,
      respondBy,
      expectedStatus: "CHALLENGED",
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: HOLD_ID, status: "CHALLENGED" },
      data: { respondBy },
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// holds-without-a-request step 2: request-less create, line reads of every
// kind, and the shared note. DB-backed behaviour (the holder partial uniques,
// the shape CHECK, NoAction on org delete) lives in
// test/integration/holds-without-a-request.test.ts.
// ─────────────────────────────────────────────────────────────────────────────

describe("bookingHolds request-less holds (holds-without-a-request)", () => {
  const BOOKER_ROW = {
    ...ROW,
    ownerKind: "BOOKER",
    bookingRequestId: null,
    grantId: "grant-1",
    holderOrgId: "org-1",
    grant: GRANT_JOIN,
    status: "ACTIVE",
    challengedAt: null,
    respondBy: null,
  };
  const NOTE_AT = new Date("2026-10-01T09:30:00.000Z");
  const BASE_INPUT = {
    calendarId: CAL_ID,
    date: "2026-10-13",
    position: 3,
    placedByHumanId: "human-1",
    now: NOTE_AT,
  };

  it("createRequestless writes a BOOKER hold's grant and holder, under the line lock first", async () => {
    const { prisma, create, $executeRaw } = holdPrisma();
    create.mockResolvedValueOnce(BOOKER_ROW);
    const record = await makeBookingHoldsRepo(prisma).createRequestless({
      ...BASE_INPUT,
      ownerKind: "BOOKER",
      grantId: "grant-1",
      holder: { kind: "org", orgId: "org-1" },
    });
    expect(create).toHaveBeenCalledWith({
      data: {
        ownerKind: "BOOKER",
        grantId: "grant-1",
        holderOrgId: "org-1",
        holderHumanId: null,
        calendarId: CAL_ID,
        spaceId: null,
        date: new Date("2026-10-13T00:00:00.000Z"),
        position: 3,
        placedByHumanId: "human-1",
      },
      select: BOOKING_HOLD_SELECT,
    });
    expect($executeRaw.mock.invocationCallOrder[0]!).toBeLessThan(
      create.mock.invocationCallOrder[0]!,
    );
    expect(record).toMatchObject({
      ownerKind: "BOOKER",
      grantId: "grant-1",
      holder: { kind: "org", orgId: "org-1" },
    });
  });

  it("createRequestless writes a PLACE hold naming a person, with its opening note stamped by the placer", async () => {
    const { prisma, create } = holdPrisma();
    create.mockResolvedValueOnce({
      ...BOOKER_ROW,
      ownerKind: "PLACE",
      grantId: null,
      holderOrgId: null,
      holderHumanId: "human-9",
      note: "their second night",
    });
    const record = await makeBookingHoldsRepo(prisma).createRequestless({
      ...BASE_INPUT,
      ownerKind: "PLACE",
      holder: { kind: "person", humanId: "human-9" },
      note: "their second night",
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          ownerKind: "PLACE",
          grantId: null,
          holderOrgId: null,
          holderHumanId: "human-9",
          note: "their second night",
          noteUpdatedByHumanId: "human-1",
          // The use case's clock, not the adapter's.
          noteUpdatedAt: NOTE_AT,
        }),
      }),
    );
    expect(record).toMatchObject({
      ownerKind: "PLACE",
      holder: { kind: "person", humanId: "human-9" },
    });
  });

  it("createRequestless writes an unassigned PLACE hold with both holder columns null and no note", async () => {
    const { prisma, create } = holdPrisma();
    create.mockResolvedValueOnce({ ...BOOKER_ROW, ownerKind: "PLACE", grantId: null, holderOrgId: null });
    const record = await makeBookingHoldsRepo(prisma).createRequestless({
      ...BASE_INPUT,
      ownerKind: "PLACE",
      holder: null,
    });
    const data = (create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
    expect(data).toMatchObject({ ownerKind: "PLACE", grantId: null, holderOrgId: null, holderHumanId: null });
    expect(data).not.toHaveProperty("note");
    expect(record).toMatchObject({ ownerKind: "PLACE", holder: null });
  });

  it("createRequestless maps P2002 (holder partial uniques) → booking_hold_holder_exists and P2003 → booking_hold_target_missing", async () => {
    const { prisma, create } = holdPrisma();
    const repo = makeBookingHoldsRepo(prisma);
    const input = {
      ...BASE_INPUT,
      ownerKind: "BOOKER" as const,
      grantId: "grant-1",
      holder: { kind: "org" as const, orgId: "org-1" },
    };
    create.mockRejectedValueOnce(knownError("P2002"));
    await expect(repo.createRequestless(input)).rejects.toMatchObject({
      code: "conflict",
      message: "booking_hold_holder_exists",
    });
    create.mockRejectedValueOnce(knownError("P2003"));
    await expect(repo.createRequestless(input)).rejects.toMatchObject({
      code: "conflict",
      message: "booking_hold_target_missing",
    });
    create.mockRejectedValueOnce(knownError("P2034"));
    await expect(repo.createRequestless(input)).rejects.toMatchObject({
      code: "conflict",
      message: "booking_hold_line_changed",
    });
  });

  it("line and range reads never filter on owner kind (a line holds every kind)", async () => {
    const { prisma, findMany } = holdPrisma();
    findMany.mockResolvedValue([ROW, BOOKER_ROW]);
    const repo = makeBookingHoldsRepo(prisma);
    const line = await repo.listLine({ calendarId: CAL_ID, date: "2026-10-13" });
    expect(line.map((h) => h.ownerKind)).toEqual(["REQUEST", "BOOKER"]);
    await repo.listLiveForCalendarRange({ calendarId: CAL_ID, from: "2026-10-01", to: "2026-10-31" });
    await repo.listLiveForPlaceRange({ placeId: "place-1", from: "2026-10-01", to: "2026-10-31" });
    for (const call of findMany.mock.calls as unknown as [{ where: Record<string, unknown> }][]) {
      expect(call[0].where).not.toHaveProperty("ownerKind");
    }
  });

  it("listLiveForGrant reads LIVE BOOKER holds on the grant, by date then calendar then position", async () => {
    const { prisma, findMany } = holdPrisma();
    findMany.mockResolvedValueOnce([BOOKER_ROW]);
    const rows = await makeBookingHoldsRepo(prisma).listLiveForGrant("grant-1");
    expect(findMany).toHaveBeenCalledWith({
      where: { ownerKind: "BOOKER", grantId: "grant-1", status: { in: ["ACTIVE", "CHALLENGED"] } },
      orderBy: [{ date: "asc" }, { calendarId: "asc" }, { position: "asc" }],
      select: BOOKING_HOLD_SELECT,
    });
    expect(rows).toEqual([
      expect.objectContaining({ ownerKind: "BOOKER", grantId: "grant-1", holder: { kind: "org", orgId: "org-1" } }),
    ]);
  });

  it("convertBookerHoldToPlace CASes on a live BOOKER hold of the grant, clears the grant, keeps the holder", async () => {
    const { prisma, updateMany, findUniqueOrThrow } = holdPrisma();
    findUniqueOrThrow.mockResolvedValueOnce({ ...BOOKER_ROW, ownerKind: "PLACE", grantId: null, grant: null });
    const record = await makeBookingHoldsRepo(prisma).convertBookerHoldToPlace({
      id: HOLD_ID,
      grantId: "grant-1",
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: HOLD_ID,
        ownerKind: "BOOKER",
        grantId: "grant-1",
        status: { in: ["ACTIVE", "CHALLENGED"] },
      },
      data: { ownerKind: "PLACE", grantId: null },
    });
    expect(record).toMatchObject({ ownerKind: "PLACE", holder: { kind: "org", orgId: "org-1" } });
    expect(record).not.toHaveProperty("grantId");
  });

  it("clearPlaceHolder CASes on a live PLACE hold naming that holder and clears both holder columns", async () => {
    const { prisma, updateMany, findUniqueOrThrow } = holdPrisma();
    findUniqueOrThrow.mockResolvedValueOnce({
      ...ROW,
      ownerKind: "PLACE",
      bookingRequestId: null,
      status: "ACTIVE",
      respondBy: null,
    });
    const record = await makeBookingHoldsRepo(prisma).clearPlaceHolder({
      id: HOLD_ID,
      holder: { kind: "person", humanId: "human-9" },
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: HOLD_ID,
        ownerKind: "PLACE",
        status: { in: ["ACTIVE", "CHALLENGED"] },
        holderHumanId: "human-9",
      },
      data: { holderOrgId: null, holderHumanId: null },
    });
    expect(record).toMatchObject({ ownerKind: "PLACE", holder: null, position: 2 });

    updateMany.mockClear();
    updateMany.mockResolvedValueOnce({ count: 0 });
    expect(
      await makeBookingHoldsRepo(prisma).clearPlaceHolder({
        id: HOLD_ID,
        holder: { kind: "org", orgId: "org-1" },
      }),
    ).toBeNull();
    expect(updateMany.mock.calls[0]![0]).toMatchObject({ where: { holderOrgId: "org-1" } });
  });

  it("convertBookerHoldToPlace returns null when the CAS lost, without a read", async () => {
    const { prisma, updateMany, findUniqueOrThrow } = holdPrisma();
    updateMany.mockResolvedValueOnce({ count: 0 });
    expect(
      await makeBookingHoldsRepo(prisma).convertBookerHoldToPlace({ id: HOLD_ID, grantId: "grant-1" }),
    ).toBeNull();
    expect(findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it("request-scoped reads keep REQUEST rows only, in the WHERE", async () => {
    const { prisma, findMany } = holdPrisma();
    const repo = makeBookingHoldsRepo(prisma);
    await repo.listForRequest(REQ_ID);
    await repo.listLiveForRequests([REQ_ID]);
    for (const call of findMany.mock.calls as unknown as [{ where: Record<string, unknown> }][]) {
      expect(call[0].where).toMatchObject({ ownerKind: "REQUEST" });
    }
  });
});

describe("bookingHolds.setNote (FR-012)", () => {
  const NOW = new Date("2026-10-15T12:00:00.000Z");
  const OPENED_AT = new Date("2026-10-14T09:00:00.000Z");

  function notePrisma(count: number, current: unknown) {
    const updateMany = vi.fn(async () => ({ count }));
    const findUnique = vi.fn(async () => current);
    const prisma = {
      bookingHold: { updateMany, findUnique },
    } as unknown as PrismaClientOrTx;
    return { prisma, updateMany, findUnique };
  }

  it("writes the note with who and when; no stamp check when expectedUpdatedAt is omitted", async () => {
    const { prisma, updateMany, findUnique } = notePrisma(1, null);
    const result = await makeBookingHoldsRepo(prisma).setNote({
      id: HOLD_ID,
      note: "bring the backline",
      updatedByHumanId: "human-1",
      now: NOW,
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: HOLD_ID },
      data: { note: "bring the backline", noteUpdatedByHumanId: "human-1", noteUpdatedAt: NOW },
    });
    expect(findUnique).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: "saved",
      note: { note: "bring the backline", noteUpdatedByHumanId: "human-1", noteUpdatedAt: NOW },
    });
  });

  it("carries the edited-at check in the WHERE (a stamp, or IS NULL for a never-saved note) and stores '' as null", async () => {
    const { prisma, updateMany } = notePrisma(1, null);
    const repo = makeBookingHoldsRepo(prisma);
    await repo.setNote({ id: HOLD_ID, note: "", updatedByHumanId: "human-1", now: NOW, expectedUpdatedAt: OPENED_AT });
    await repo.setNote({ id: HOLD_ID, note: "x", updatedByHumanId: "human-1", now: NOW, expectedUpdatedAt: null });
    expect(updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: HOLD_ID, noteUpdatedAt: OPENED_AT },
      data: { note: null, noteUpdatedByHumanId: "human-1", noteUpdatedAt: NOW },
    });
    expect(updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: HOLD_ID, noteUpdatedAt: null },
      data: { note: "x", noteUpdatedByHumanId: "human-1", noteUpdatedAt: NOW },
    });
  });

  it("zero rows → conflict with what is stored now, or not_found when the row is gone", async () => {
    const stored = { note: "theirs", noteUpdatedByHumanId: "human-2", noteUpdatedAt: NOW };
    const conflict = notePrisma(0, stored);
    await expect(
      makeBookingHoldsRepo(conflict.prisma).setNote({
        id: HOLD_ID,
        note: "mine",
        updatedByHumanId: "human-1",
        now: NOW,
        expectedUpdatedAt: OPENED_AT,
      }),
    ).resolves.toEqual({ status: "conflict", current: stored });
    const missing = notePrisma(0, null);
    await expect(
      makeBookingHoldsRepo(missing.prisma).setNote({
        id: HOLD_ID,
        note: "mine",
        updatedByHumanId: "human-1",
        now: NOW,
      }),
    ).resolves.toEqual({ status: "not_found" });
  });
});
