import { describe, expect, it, vi } from "vitest";

import type { TxRepos } from "@th/ports/repos";
import { createFakeBookingRequestMessagesRepo } from "@th/test-utils/fakes/venue-hierarchy";

import { isHoldLapsed, todayInZone } from "../_shared/booking-hold-lapse";
import { renumberLine } from "../_shared/hold-line";
import { settleLapsedHolds, settleLine } from "../_shared/settle-lapsed-holds";
import { createFakeBookingHoldsRepo } from "./fakes";

// ─────────────────────────────────────────────────────────────────────────────
// NFR-004: ONE pure predicate for lazy expiry, shared by every surface. The
// matrix below is the whole contract; the settle helper's tests pin the
// write-on-read behaviour (CAS-idempotent, renumbers, notifies EXPIRED only).
// ─────────────────────────────────────────────────────────────────────────────

const CHICAGO = "America/Chicago";
const REQUEST_A = "44444444-4444-4444-8444-444444444444";
const REQUEST_B = "45454545-4545-4545-8545-454545454545";
const REQUEST_C = "46464646-4646-4646-8646-464646464646";
const CALENDAR_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

// 2026-06-10 23:30 in Chicago (CDT, UTC-5) = 2026-06-11T04:30Z — a moment
// where the UTC day and the place day DISAGREE, which is the whole reason
// the predicate takes a zone.
const NOW = new Date("2026-06-11T04:30:00.000Z");

describe("todayInZone", () => {
  it("is the PLACE's calendar day, not UTC's", () => {
    expect(todayInZone(NOW, CHICAGO)).toBe("2026-06-10");
    expect(todayInZone(NOW, "UTC")).toBe("2026-06-11");
  });
});

describe("isHoldLapsed", () => {
  const base = { status: "ACTIVE" as const, respondBy: null, date: "2026-06-10" };

  it.each([
    // [label, hold, expected]
    ["ACTIVE, today (place zone)", { ...base }, null],
    ["ACTIVE, tomorrow", { ...base, date: "2026-06-11" }, null],
    ["ACTIVE, yesterday", { ...base, date: "2026-06-09" }, "PAST_DATE"],
    // Same instant read in UTC would call 06-10 "yesterday" — it is not.
    ["ACTIVE, today by place zone but yesterday by UTC", { ...base, date: "2026-06-10" }, null],
    [
      "CHALLENGED, deadline ahead",
      { status: "CHALLENGED" as const, respondBy: new Date("2026-06-11T05:00:00.000Z"), date: "2026-06-12" },
      null,
    ],
    [
      "CHALLENGED, deadline passed",
      { status: "CHALLENGED" as const, respondBy: new Date("2026-06-11T04:29:59.000Z"), date: "2026-06-12" },
      "EXPIRED",
    ],
    [
      "CHALLENGED, deadline exactly now (not yet past)",
      { status: "CHALLENGED" as const, respondBy: NOW, date: "2026-06-12" },
      null,
    ],
    [
      "CHALLENGED, deadline passed AND date past → PAST_DATE wins (silent)",
      { status: "CHALLENGED" as const, respondBy: new Date("2026-06-01T00:00:00.000Z"), date: "2026-06-09" },
      "PAST_DATE",
    ],
    ["RELEASED never lapses", { status: "RELEASED" as const, respondBy: null, date: "2020-01-01" }, null],
    ["CONFIRMED never lapses", { status: "CONFIRMED" as const, respondBy: null, date: "2020-01-01" }, null],
  ])("%s", (_label, hold, expected) => {
    expect(isHoldLapsed(hold, NOW, CHICAGO)).toBe(expected);
  });

  // DST boundaries — the place day is what counts, and luxon must get the
  // offset right on BOTH sides of a transition. Chicago springs forward
  // 2026-03-08 02:00 (CST→CDT, UTC-6→UTC-5) and falls back 2026-11-01 02:00.
  it.each([
    // 2026-03-08 01:30 CST (UTC-6) = 07:30Z — still 03-08 in Chicago, ONE
    // hour before the skipped hour. 03-07 is yesterday; 03-08 is today.
    ["spring-forward morning: yesterday's date is PAST_DATE", new Date("2026-03-08T07:30:00.000Z"), "2026-03-07", "PAST_DATE"],
    ["spring-forward morning: today's date is live", new Date("2026-03-08T07:30:00.000Z"), "2026-03-08", null],
    // 2026-03-08 23:30 CDT (UTC-5) = 03-09 04:30Z: UTC already says 03-09,
    // Chicago still says 03-08 — a UTC-day comparison would kill 03-08 early.
    ["spring-forward evening: UTC has rolled over, the place has not", new Date("2026-03-09T04:30:00.000Z"), "2026-03-08", null],
    // Fall back: 2026-11-01 01:30 CDT (first pass, UTC-5) = 06:30Z, and
    // 01:30 CST (second pass, UTC-6) = 07:30Z. Both are 11-01 in Chicago.
    ["fall-back, first 01:30 (CDT): 10-31 is past, 11-01 is live", new Date("2026-11-01T06:30:00.000Z"), "2026-10-31", "PAST_DATE"],
    ["fall-back, second 01:30 (CST): 11-01 still live", new Date("2026-11-01T07:30:00.000Z"), "2026-11-01", null],
    // 2026-11-01 23:30 CST (UTC-6) = 11-02 05:30Z.
    ["fall-back evening: UTC rolled over, the place has not", new Date("2026-11-02T05:30:00.000Z"), "2026-11-01", null],
  ])("%s", (_label, now, date, expected) => {
    expect(isHoldLapsed({ status: "ACTIVE", respondBy: null, date }, now, CHICAGO)).toBe(expected);
  });
});

function buildTx() {
  const bookingHolds = createFakeBookingHoldsRepo();
  const bookingRequestMessages = createFakeBookingRequestMessagesRepo();
  const requests = new Map<string, { id: string; assigneeHumanId: string | null; status?: string }>([
    [REQUEST_A, { id: REQUEST_A, assigneeHumanId: "12121212-1212-4121-8121-121212121212", status: "PENDING" }],
    [REQUEST_B, { id: REQUEST_B, assigneeHumanId: null, status: "PENDING" }],
    [REQUEST_C, { id: REQUEST_C, assigneeHumanId: null, status: "PENDING" }],
  ]);
  const bookingRequests = {
    getById: vi.fn(async (id: string) => requests.get(id) ?? null),
    touchLastMessageAt: vi.fn(async () => {}),
  };
  const tx = { bookingHolds, bookingRequestMessages, bookingRequests } as unknown as TxRepos;
  const entries = (requestId: string) =>
    [...bookingRequestMessages.rows.values()]
      .filter((r) => r.bookingRequestId === requestId && r.systemKind)
      .map((r) => ({ kind: r.systemKind, data: r.systemData }));
  return { tx, bookingHolds, entries, requests };
}

describe("settleLapsedHolds", () => {
  it("releases an expired challenge, renumbers the line, notifies act + staff, moves the rest up", async () => {
    const { tx, bookingHolds, entries } = buildTx();
    const expired = bookingHolds.seed({
      bookingRequestId: REQUEST_A,
      calendarId: CALENDAR_ID,
      date: "2026-06-20",
      status: "CHALLENGED",
      respondBy: new Date("2026-06-11T00:00:00.000Z"),
    });
    const second = bookingHolds.seed({ bookingRequestId: REQUEST_B, calendarId: CALENDAR_ID, date: "2026-06-20" });
    const third = bookingHolds.seed({ bookingRequestId: REQUEST_C, calendarId: CALENDAR_ID, date: "2026-06-20" });

    const result = await settleLapsedHolds(tx, {
      holds: await bookingHolds.listLine({ calendarId: CALENDAR_ID, date: "2026-06-20" }),
      now: NOW,
      placeTz: CHICAGO,
      actorHumanId: null,
    });

    expect(result.settled.map((h) => h.id)).toEqual([expired.id]);
    expect(bookingHolds.rows.get(expired.id)).toMatchObject({
      status: "RELEASED",
      releasedReason: "EXPIRED",
      respondBy: null,
    });
    // The line closed its gap from ONE ordered read.
    expect(bookingHolds.rows.get(second.id)?.position).toBe(1);
    expect(bookingHolds.rows.get(third.id)?.position).toBe(2);

    // Ledger: released on A (machine-caused), reordered on B and C.
    expect(entries(REQUEST_A)).toEqual([
      { kind: "booking_hold.released", data: { holdId: expired.id, reason: "EXPIRED" } },
    ]);
    expect(entries(REQUEST_B)).toEqual([
      { kind: "booking_hold.reordered", data: { holdId: second.id, from: 2, to: 1 } },
    ]);
    expect(entries(REQUEST_C)).toEqual([
      { kind: "booking_hold.reordered", data: { holdId: third.id, from: 3, to: 2 } },
    ]);

    // Intents: expired → act + staff (with routing hint), movers → act.
    expect(result.intents).toEqual([
      { kind: "hold.expired", bookingRequestId: REQUEST_A, holdId: expired.id, audience: "act", date: "2026-06-20" },
      {
        kind: "hold.expired",
        bookingRequestId: REQUEST_A,
        holdId: expired.id,
        audience: "staff",
        date: "2026-06-20",
        staff: { assigneeHumanId: "12121212-1212-4121-8121-121212121212", placedByHumanId: expired.placedByHumanId },
      },
      { kind: "hold.position_changed", bookingRequestId: REQUEST_B, holdId: second.id, audience: "act", date: "2026-06-20", position: 1 },
      { kind: "hold.position_changed", bookingRequestId: REQUEST_C, holdId: third.id, audience: "act", date: "2026-06-20", position: 2 },
    ]);
  });

  it("releases a past-date hold SILENTLY (FR-010: no notifications for the dead date)", async () => {
    const { tx, bookingHolds, entries } = buildTx();
    const past = bookingHolds.seed({ bookingRequestId: REQUEST_A, calendarId: CALENDAR_ID, date: "2026-06-01" });

    const result = await settleLapsedHolds(tx, {
      holds: [past],
      now: NOW,
      placeTz: CHICAGO,
      actorHumanId: null,
    });

    expect(bookingHolds.rows.get(past.id)).toMatchObject({ status: "RELEASED", releasedReason: "PAST_DATE" });
    expect(entries(REQUEST_A)).toEqual([
      { kind: "booking_hold.released", data: { holdId: past.id, reason: "PAST_DATE" } },
    ]);
    expect(result.intents).toEqual([]);
  });

  it("is idempotent: a second pass over the same rows writes nothing", async () => {
    const { tx, bookingHolds, entries } = buildTx();
    bookingHolds.seed({
      bookingRequestId: REQUEST_A,
      calendarId: CALENDAR_ID,
      date: "2026-06-20",
      status: "CHALLENGED",
      respondBy: new Date("2026-06-11T00:00:00.000Z"),
    });
    const args = { now: NOW, placeTz: CHICAGO, actorHumanId: null as const };

    await settleLapsedHolds(tx, { holds: [...bookingHolds.rows.values()], ...args });
    const again = await settleLapsedHolds(tx, { holds: [...bookingHolds.rows.values()], ...args });

    expect(again.settled).toEqual([]);
    expect(again.intents).toEqual([]);
    expect(entries(REQUEST_A)).toHaveLength(1);
  });

  it("treats a lost CAS as 'someone else settled it' — skips, no throw, no duplicate notification", async () => {
    const { tx, bookingHolds, entries } = buildTx();
    const stale = bookingHolds.seed({
      bookingRequestId: REQUEST_A,
      calendarId: CALENDAR_ID,
      date: "2026-06-20",
      status: "CHALLENGED",
      respondBy: new Date("2026-06-11T00:00:00.000Z"),
    });
    bookingHolds.failNextUpdateStatus();

    const result = await settleLapsedHolds(tx, {
      holds: [stale],
      now: NOW,
      placeTz: CHICAGO,
      actorHumanId: null,
    });

    expect(result.settled).toEqual([]);
    expect(result.intents).toEqual([]);
    expect(entries(REQUEST_A)).toEqual([]);
  });

  it("FR-009 backstop: a live hold whose request is terminal is released (REQUEST_CLOSED), silently, and the line moves up", async () => {
    const { tx, bookingHolds, entries, requests } = buildTx();
    requests.set(REQUEST_A, { id: REQUEST_A, assigneeHumanId: null, status: "WITHDRAWN" });
    const orphan = bookingHolds.seed({ bookingRequestId: REQUEST_A, calendarId: CALENDAR_ID, date: "2026-06-20" });
    const second = bookingHolds.seed({ bookingRequestId: REQUEST_B, calendarId: CALENDAR_ID, date: "2026-06-20" });

    const result = await settleLapsedHolds(tx, {
      holds: await bookingHolds.listLine({ calendarId: CALENDAR_ID, date: "2026-06-20" }),
      now: NOW,
      placeTz: CHICAGO,
      actorHumanId: null,
    });

    expect(result.settled.map((h) => h.id)).toEqual([orphan.id]);
    expect(bookingHolds.rows.get(orphan.id)).toMatchObject({ status: "RELEASED", releasedReason: "REQUEST_CLOSED" });
    expect(bookingHolds.rows.get(second.id)?.position).toBe(1);
    expect(entries(REQUEST_A)).toEqual([
      { kind: "booking_hold.released", data: { holdId: orphan.id, reason: "REQUEST_CLOSED" } },
    ]);
    // The closed act hears nothing; the mover does.
    expect(result.intents).toEqual([
      { kind: "hold.position_changed", bookingRequestId: REQUEST_B, holdId: second.id, audience: "act", date: "2026-06-20", position: 1 },
    ]);
  });

  it("an OPEN request's on-time hold is left alone by the backstop", async () => {
    const { tx, bookingHolds, requests } = buildTx();
    requests.set(REQUEST_A, { id: REQUEST_A, assigneeHumanId: null, status: "VIEWED" });
    const live = bookingHolds.seed({ bookingRequestId: REQUEST_A, calendarId: CALENDAR_ID, date: "2026-06-20" });

    const result = await settleLapsedHolds(tx, { holds: [live], now: NOW, placeTz: CHICAGO, actorHumanId: null });

    expect(result.settled).toEqual([]);
    expect(bookingHolds.rows.get(live.id)?.status).toBe("ACTIVE");
  });

  it("settleLine takes the line's advisory lock BEFORE reading it", async () => {
    const { tx, bookingHolds } = buildTx();
    await settleLine(tx, { calendarId: CALENDAR_ID, date: "2026-06-20", now: NOW, placeTz: CHICAGO });

    expect(bookingHolds.lockLine).toHaveBeenCalledWith({ calendarId: CALENDAR_ID, date: "2026-06-20" });
    expect(bookingHolds.lockLine.mock.invocationCallOrder[0]).toBeLessThan(
      bookingHolds.listLine.mock.invocationCallOrder[0]!,
    );
  });

  it("renumberLine on a bare tx takes the line's advisory lock BEFORE reading it", async () => {
    const { tx, bookingHolds } = buildTx();
    bookingHolds.seed({ bookingRequestId: REQUEST_A, calendarId: CALENDAR_ID, date: "2026-06-20" });
    await renumberLine(tx, { calendarId: CALENDAR_ID, date: "2026-06-20" });

    expect(bookingHolds.lockLine).toHaveBeenCalledWith({ calendarId: CALENDAR_ID, date: "2026-06-20" });
    expect(bookingHolds.lockLine.mock.invocationCallOrder[0]).toBeLessThan(
      bookingHolds.listLine.mock.invocationCallOrder[0]!,
    );
  });

  it("settleLine returns the FRESH line after settlement", async () => {
    const { tx, bookingHolds } = buildTx();
    bookingHolds.seed({
      bookingRequestId: REQUEST_A,
      calendarId: CALENDAR_ID,
      date: "2026-06-20",
      status: "CHALLENGED",
      respondBy: new Date("2026-06-11T00:00:00.000Z"),
    });
    const survivor = bookingHolds.seed({ bookingRequestId: REQUEST_B, calendarId: CALENDAR_ID, date: "2026-06-20" });

    const { line } = await settleLine(tx, { calendarId: CALENDAR_ID, date: "2026-06-20", now: NOW, placeTz: CHICAGO });

    expect(line.map((h) => [h.id, h.position])).toEqual([[survivor.id, 1]]);
  });
});
