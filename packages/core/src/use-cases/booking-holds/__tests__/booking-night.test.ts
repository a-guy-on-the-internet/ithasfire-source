import { describe, expect, it, vi } from "vitest";

import type {
  BookingHoldRecord,
  RequestBookingHoldRecord,
} from "@th/ports/repos/booking-holds";

import { todayInZone } from "../_shared/booking-hold-lapse";

import type { EventRecord } from "@th/ports/repos/events";

import {
  anchorBookingNight,
  assertBookingEventOnNight,
  assessNight,
  bookingNightOf,
  defaultTermsNight,
  isAskedForNight,
  isBookingCancelled,
  isLineHeadChallengeable,
  otherBookedNight,
  resolveBookingEvent,
  resolveNightCalendarId,
} from "../_shared/booking-night";

// ─────────────────────────────────────────────────────────────────────────────
// The night (booking-the-night N1 / N3 / N6): which night terms book, whether
// it is free for a request, and which nights a pitch asked for.
// ─────────────────────────────────────────────────────────────────────────────

const TZ = "America/Chicago";
const ME = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const THEM = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CAL = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const NOW = new Date("2026-10-01T15:00:00.000Z");

let n = 0;
function hold(over: Partial<RequestBookingHoldRecord>): RequestBookingHoldRecord {
  n += 1;
  return {
    id: `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`,
    ownerKind: "REQUEST",
    bookingRequestId: ME,
    eventId: null,
    note: null,
    noteUpdatedByHumanId: null,
    noteUpdatedAt: null,
    calendarId: CAL,
    spaceId: null,
    date: "2026-10-17",
    position: 1,
    status: "ACTIVE",
    placedByHumanId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    challengedAt: null,
    respondBy: null,
    releasedAt: null,
    releasedReason: null,
    confirmedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

describe("bookingNightOf", () => {
  it("is the place-local day of an evening show", () => {
    // 20:00 CDT on Fri 17 Oct = 01:00Z Sat 18 Oct: a UTC day would say the 18th.
    expect(bookingNightOf(new Date("2026-10-18T01:00:00.000Z"), TZ)).toBe("2026-10-17");
  });

  it("is the CALENDAR day the show starts on — a 00:30 start is its own day, like publish settling sees it", () => {
    // 00:30 CDT Sat 18 Oct books Saturday's line, not Friday's: the same day
    // `todayInZone` (placement, lapse, publish settling) gives it.
    const halfPastMidnight = new Date("2026-10-18T05:30:00.000Z");
    expect(bookingNightOf(halfPastMidnight, TZ)).toBe("2026-10-18");
    expect(bookingNightOf(halfPastMidnight, TZ)).toBe(todayInZone(halfPastMidnight, TZ));
    // 23:59 CDT Friday is still Friday.
    expect(bookingNightOf(new Date("2026-10-18T04:59:00.000Z"), TZ)).toBe("2026-10-17");
  });

  it("follows the zone across a DST change (Luxon zone conversion, not hour arithmetic)", () => {
    // US DST ends Sun 1 Nov 2026 at 02:00 CDT → 01:00 CST.
    expect(bookingNightOf(new Date("2026-11-01T05:30:00.000Z"), TZ)).toBe("2026-11-01"); // 00:30 CDT
    expect(bookingNightOf(new Date("2026-11-02T05:30:00.000Z"), TZ)).toBe("2026-11-01"); // 23:30 CST
  });
});

describe("anchorBookingNight", () => {
  it("anchors a night at the given clock, the calendar default, or 19:00", () => {
    expect(anchorBookingNight("2026-10-17", TZ, { hour: 21, minute: 30 }, "20:00")).toEqual(
      new Date("2026-10-18T02:30:00.000Z"),
    );
    expect(anchorBookingNight("2026-10-17", TZ, null, "20:00")).toEqual(
      new Date("2026-10-18T01:00:00.000Z"),
    );
    expect(anchorBookingNight("2026-10-17", TZ, null, null)).toEqual(
      new Date("2026-10-18T00:00:00.000Z"),
    );
  });

  it("puts a 00:30 time on that same calendar day, and round-trips", () => {
    const start = anchorBookingNight("2026-10-17", TZ, { hour: 0, minute: 30 }, null)!;
    // 00:30 CDT on Fri 17 Oct — the night is the day named, never the next.
    expect(start).toEqual(new Date("2026-10-17T05:30:00.000Z"));
    expect(bookingNightOf(start, TZ)).toBe("2026-10-17");
  });

  it("is null for an impossible day", () => {
    expect(anchorBookingNight("2026-02-30", TZ, null, null)).toBeNull();
  });
});

describe("assessNight (N6)", () => {
  it("an empty line is free, with no hold of ours", () => {
    expect(assessNight({ line: [], confirmed: [], bookingRequestId: ME })).toEqual({
      kind: "free",
      ownHold: null,
    });
  });

  it("our hold first in line → free, and it is the hold to confirm", () => {
    const mine = hold({ position: 1 });
    const theirs = hold({ bookingRequestId: THEM, position: 2 });
    expect(assessNight({ line: [mine, theirs], confirmed: [], bookingRequestId: ME })).toEqual({
      kind: "free",
      ownHold: mine,
    });
  });

  it("another party ahead of our hold → taken, pointing at the position-1 hold", () => {
    const theirs = hold({ bookingRequestId: THEM, position: 1 });
    const mine = hold({ position: 2 });
    expect(assessNight({ line: [theirs, mine], confirmed: [], bookingRequestId: ME })).toEqual({
      kind: "taken",
      reason: "ahead",
      head: theirs,
      challengeable: true,
    });
  });

  it("no hold of ours but someone else in line → taken (they would be ahead of any new hold)", () => {
    const theirs = hold({ bookingRequestId: THEM, position: 1 });
    expect(assessNight({ line: [theirs], confirmed: [], bookingRequestId: ME })).toMatchObject({
      kind: "taken",
      reason: "ahead",
      head: theirs,
    });
  });

  it("an open challenge on the hold ahead → taken and NOT challengeable again", () => {
    const theirs = hold({ bookingRequestId: THEM, position: 1, status: "CHALLENGED" });
    const mine = hold({ position: 2 });
    expect(assessNight({ line: [theirs, mine], confirmed: [], bookingRequestId: ME })).toMatchObject({
      kind: "taken",
      challengeable: false,
    });
  });

  it("our OWN hold under challenge at position 1 is still ours to book (N19: keeping it is agreeing)", () => {
    const mine = hold({ position: 1, status: "CHALLENGED" });
    const theirs = hold({ bookingRequestId: THEM, position: 2 });
    expect(assessNight({ line: [mine, theirs], confirmed: [], bookingRequestId: ME })).toEqual({
      kind: "free",
      ownHold: mine,
    });
  });

  it("another party's CONFIRMED hold → taken (booked), whatever the live line says", () => {
    const booked = hold({ bookingRequestId: THEM, status: "CONFIRMED", position: 1 });
    const mine = hold({ position: 1 });
    expect(assessNight({ line: [mine], confirmed: [booked], bookingRequestId: ME })).toEqual({
      kind: "taken",
      reason: "booked",
      head: booked,
      challengeable: false,
    });
  });

  it("our own CONFIRMED hold → free (already booked by us)", () => {
    const mine = hold({ status: "CONFIRMED" });
    expect(assessNight({ line: [], confirmed: [mine], bookingRequestId: ME })).toEqual({
      kind: "free",
      ownHold: mine,
    });
  });

  it("a hold with NO request (an outside booker's or the place's own) is never ours", () => {
    const { bookingRequestId: _request, ...base } = hold({ position: 1 });
    const booker: BookingHoldRecord = {
      ...base,
      ownerKind: "BOOKER",
      grantId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      holder: { kind: "org", orgId: "ffffffff-ffff-4fff-8fff-ffffffffffff" },
    };
    const placeHold: BookingHoldRecord = { ...base, ownerKind: "PLACE", holder: null };
    for (const requestless of [booker, placeHold]) {
      expect(
        assessNight({ line: [requestless], confirmed: [], bookingRequestId: ME }),
      ).toMatchObject({ kind: "taken", reason: "ahead", head: requestless });
      // Nor is a CONFIRMED one: it books the night against us.
      const booked = { ...requestless, status: "CONFIRMED" } as BookingHoldRecord;
      expect(
        assessNight({ line: [], confirmed: [booked], bookingRequestId: ME }),
      ).toMatchObject({ kind: "taken", reason: "booked", head: booked });
    }
  });
});

describe("isLineHeadChallengeable", () => {
  it("needs an ACTIVE head and no open challenge", () => {
    expect(isLineHeadChallengeable([])).toBe(false);
    expect(isLineHeadChallengeable([hold({})])).toBe(true);
    expect(isLineHeadChallengeable([hold({ status: "CHALLENGED" })])).toBe(false);
  });
});

describe("isAskedForNight (N3)", () => {
  const base = { preferredDates: [] as string[], requestedStartsAt: null, requestedEndsAt: null };

  it("matches the day of a preferred date, timed or not", () => {
    expect(isAskedForNight({ ...base, preferredDates: ["2026-10-17"] }, "2026-10-17", TZ)).toBe(true);
    expect(isAskedForNight({ ...base, preferredDates: ["2026-10-17T21:00"] }, "2026-10-17", TZ)).toBe(true);
    expect(isAskedForNight({ ...base, preferredDates: ["2026-10-18"] }, "2026-10-17", TZ)).toBe(false);
  });

  it("RENT / USE: every calendar day the requested window touches", () => {
    const request = {
      ...base,
      // Fri 17 Oct 18:00 CDT → Sun 19 Oct 01:00 CDT.
      requestedStartsAt: new Date("2026-10-17T23:00:00.000Z"),
      requestedEndsAt: new Date("2026-10-19T06:00:00.000Z"),
    };
    expect(isAskedForNight(request, "2026-10-16", TZ)).toBe(false);
    expect(isAskedForNight(request, "2026-10-17", TZ)).toBe(true);
    expect(isAskedForNight(request, "2026-10-18", TZ)).toBe(true);
    // The window runs into Sunday 01:00, so Sunday is a day it touches.
    expect(isAskedForNight(request, "2026-10-19", TZ)).toBe(true);
    expect(isAskedForNight(request, "2026-10-20", TZ)).toBe(false);
  });
});

describe("defaultTermsNight (FR-003)", () => {
  it("a night this request already BOOKED wins over everything (one booked night per request)", () => {
    const request = { preferredDates: ["2026-10-10", "2026-10-17"], requestedStartsAt: null };
    const holds = [
      hold({ date: "2026-10-10", position: 1, status: "RELEASED" }),
      hold({ date: "2026-10-17", position: 1, status: "CONFIRMED" }),
      hold({ date: "2026-10-03", position: 1 }),
    ];
    expect(defaultTermsNight(request, holds, NOW, TZ)).toBe("2026-10-17");
  });

  it("prefers the earliest night this request holds at position 1", () => {
    const request = { preferredDates: ["2026-10-24"], requestedStartsAt: null };
    const holds = [
      hold({ date: "2026-10-31", position: 1 }),
      hold({ date: "2026-10-17", position: 2 }),
      hold({ date: "2026-10-24", position: 1 }),
    ];
    expect(defaultTermsNight(request, holds, NOW, TZ)).toBe("2026-10-24");
  });

  it("ignores released and lapsed holds, then falls back to the first requested night", () => {
    const request = { preferredDates: ["2026-11-07T21:00", "2026-11-14"], requestedStartsAt: null };
    const holds = [
      hold({ date: "2026-10-17", position: 1, status: "RELEASED" }),
      hold({ date: "2026-09-01", position: 1 }), // past → lapsed
    ];
    expect(defaultTermsNight(request, holds, NOW, TZ)).toBe("2026-11-07");
  });

  it("RENT / USE with no preferred dates: the window's first night; nothing at all → null", () => {
    expect(
      defaultTermsNight(
        { preferredDates: [], requestedStartsAt: new Date("2026-10-18T05:00:00.000Z") },
        [],
        NOW,
        TZ,
      ),
    ).toBe("2026-10-18");
    expect(defaultTermsNight({ preferredDates: [], requestedStartsAt: null }, [], NOW, TZ)).toBeNull();
  });
});

describe("resolveNightCalendarId", () => {
  const OTHER = "cdcdcdcd-cdcd-4cdc-8cdc-cdcdcdcdcdcd";
  function repos(holds: BookingHoldRecord[], defaultId: string | null = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee") {
    return {
      bookingHolds: { listForRequest: vi.fn(async () => holds) },
      calendars: {
        listByPlace: vi.fn(async () =>
          defaultId
            ? [{ id: CAL, isDefault: false }, { id: defaultId, isDefault: true }]
            : [],
        ),
      },
    } as never;
  }

  it("this request's hold on the night wins (a CONFIRMED one first)", async () => {
    const r = repos([
      hold({ calendarId: CAL, date: "2026-10-17", position: 1 }),
      hold({ calendarId: OTHER, date: "2026-10-17", status: "CONFIRMED" }),
    ]);
    await expect(
      resolveNightCalendarId(r, { request: { id: ME, calendarId: CAL }, placeId: "p", night: "2026-10-17" }),
    ).resolves.toBe(OTHER);
  });

  it("no hold on the night → the request's routed calendar → the place default", async () => {
    const released = hold({ calendarId: OTHER, date: "2026-10-17", status: "RELEASED" });
    await expect(
      resolveNightCalendarId(repos([released]), {
        request: { id: ME, calendarId: CAL },
        placeId: "p",
        night: "2026-10-17",
      }),
    ).resolves.toBe(CAL);
    await expect(
      resolveNightCalendarId(repos([]), { request: { id: ME, calendarId: null }, placeId: "p", night: "2026-10-17" }),
    ).resolves.toBe("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee");
    await expect(
      resolveNightCalendarId(repos([], null), {
        request: { id: ME, calendarId: null },
        placeId: "p",
        night: "2026-10-17",
      }),
    ).resolves.toBeNull();
  });
});

describe("resolveNightCalendarId — the mint's own routing (review nit 3)", () => {
  it("a routed calendar that is NOT one of this place's falls back to the place default, as the mint does", async () => {
    const repos = {
      bookingHolds: { listForRequest: vi.fn(async () => []) },
      calendars: {
        listByPlace: vi.fn(async () => [{ id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", isDefault: true }]),
      },
    } as never;
    await expect(
      resolveNightCalendarId(repos, { request: { id: ME, calendarId: CAL }, placeId: "p", night: "2026-10-17" }),
    ).resolves.toBe("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee");
  });
});

describe("otherBookedNight (one booked night per request)", () => {
  const KEY = { calendarId: CAL, date: "2026-10-17" };

  it("finds this request's CONFIRMED hold on a different line, ignoring live and released ones", () => {
    const other = hold({ date: "2026-10-10", status: "CONFIRMED" });
    expect(otherBookedNight([hold({}), hold({ date: "2026-10-24" }), other], KEY)).toBe(other);
    expect(
      otherBookedNight([hold({ date: "2026-10-10", status: "RELEASED", releasedReason: "SIBLING_CONFIRMED" })], KEY),
    ).toBeNull();
  });

  it("a CONFIRMED hold on THIS line is not another night", () => {
    expect(otherBookedNight([hold({ status: "CONFIRMED" })], KEY)).toBeNull();
  });

  it("the same day on another calendar IS another line", () => {
    const patio = hold({ calendarId: "cdcdcdcd-cdcd-4cdc-8cdc-cdcdcdcdcdcd", status: "CONFIRMED" });
    expect(otherBookedNight([patio], KEY)).toBe(patio);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The request's event (spec N11; owner rulings 2026-10-01): which event a
// booking hands back, and when there is none it may book a night for.
// ─────────────────────────────────────────────────────────────────────────────
describe("resolveBookingEvent", () => {
  const ORIGIN = "0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e";
  const FINAL = "f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1";
  const DRAFT = "d1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1";
  const AT = new Date("2026-10-18T01:00:00.000Z");
  const repos = (rows: Record<string, string | null>) => ({
    events: {
      getById: vi.fn(async (id: string) =>
        rows[id] ? { id, status: rows[id], startsAt: AT } : null,
      ),
    },
  }) as never;

  it.each([["CANCELLED"], ["ARCHIVED"], [null]])(
    "a dead event-first origin (%s) is origin_gone — even with a LIVE draft and a LIVE finalized link",
    async (status) => {
      const resolved = await resolveBookingEvent(
        repos({ [ORIGIN]: status, [FINAL]: "PUBLISHED", [DRAFT]: "DRAFT" }),
        { agreement: { eventId: FINAL, draftEventId: DRAFT }, request: { originEventId: ORIGIN } },
      );
      expect(resolved).toEqual({ kind: "origin_gone", originEventId: ORIGIN });
    },
  );

  it.each([["CANCELLED"], ["ARCHIVED"], [null]])(
    "a finalized link to a dead event (%s) is linked_gone — never a fallback to the draft",
    async (status) => {
      const resolved = await resolveBookingEvent(
        repos({ [FINAL]: status, [DRAFT]: "DRAFT" }),
        { agreement: { eventId: FINAL, draftEventId: DRAFT }, request: { originEventId: null } },
      );
      expect(resolved).toEqual({ kind: "linked_gone", eventId: FINAL });
    },
  );

  it("live events resolve finalized → live draft → live origin; a dead draft is passed over", async () => {
    expect(
      await resolveBookingEvent(repos({ [FINAL]: "PUBLISHED", [ORIGIN]: "DRAFT" }), {
        agreement: { eventId: FINAL, draftEventId: null },
        request: { originEventId: ORIGIN },
      }),
    ).toMatchObject({ kind: "event", event: { id: FINAL } });
    expect(
      await resolveBookingEvent(repos({ [DRAFT]: "DRAFT", [ORIGIN]: "DRAFT" }), {
        agreement: { eventId: null, draftEventId: DRAFT },
        request: { originEventId: ORIGIN },
      }),
    ).toMatchObject({ kind: "event", event: { id: DRAFT } });
    expect(
      await resolveBookingEvent(repos({ [DRAFT]: "CANCELLED", [ORIGIN]: "DRAFT" }), {
        agreement: { eventId: null, draftEventId: DRAFT },
        request: { originEventId: ORIGIN },
      }),
    ).toMatchObject({ kind: "event", event: { id: ORIGIN } });
    expect(
      await resolveBookingEvent(repos({ [DRAFT]: "CANCELLED" }), {
        agreement: { eventId: null, draftEventId: DRAFT },
        request: { originEventId: null },
      }),
    ).toEqual({ kind: "none" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P2c — the event must sit on the night's LINE: its day AND its calendar
// (P2b review carry d), and the cancelled-booking marker (FR-009).
// ─────────────────────────────────────────────────────────────────────────────

describe("assertBookingEventOnNight — the line's calendar (review carry d)", () => {
  const OTHER_CAL = "c0c0c0c0-c0c0-4c0c-8c0c-c0c0c0c0c0c0";
  const EVENT_ID = "e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1";
  /** 20:00 CDT on 2026-10-17. */
  const ON_NIGHT = new Date("2026-10-18T01:00:00.000Z");
  const resolvedOn = (calendarId: string | null | undefined) => ({
    kind: "event" as const,
    event: {
      id: EVENT_ID,
      status: "DRAFT",
      startsAt: ON_NIGHT,
      ...(calendarId !== undefined ? { calendarId } : {}),
    } as unknown as EventRecord,
  });
  const base = { night: "2026-10-17", placeTz: TZ, agreementId: null };

  it("venue side: the right day on ANOTHER calendar → EVENT_ON_ANOTHER_CALENDAR with the event and both calendars", () => {
    expect(() =>
      assertBookingEventOnNight(resolvedOn(OTHER_CAL), {
        ...base,
        side: "venue",
        calendarId: CAL,
      }),
    ).toThrow(
      expect.objectContaining({
        code: "EVENT_ON_ANOTHER_CALENDAR",
        meta: {
          agreementId: null,
          eventId: EVENT_ID,
          eventCalendarId: OTHER_CAL,
          lineCalendarId: CAL,
          date: "2026-10-17",
        },
      }),
    );
  });

  it("sender side: the same mismatch → EVENT_ON_ANOTHER_NIGHT with NO meta (an act never learns the venue's calendars)", () => {
    try {
      assertBookingEventOnNight(resolvedOn(OTHER_CAL), {
        ...base,
        side: "sender",
        calendarId: CAL,
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: "EVENT_ON_ANOTHER_NIGHT" });
      expect((error as { meta?: unknown }).meta).toBeUndefined();
    }
  });

  it("the same calendar on the same day passes", () => {
    expect(() =>
      assertBookingEventOnNight(resolvedOn(CAL), { ...base, side: "venue", calendarId: CAL }),
    ).not.toThrow();
  });

  it("is skipped when the event has no calendar (a pre-hierarchy row) or the caller names no line", () => {
    expect(() =>
      assertBookingEventOnNight(resolvedOn(null), { ...base, side: "venue", calendarId: CAL }),
    ).not.toThrow();
    expect(() =>
      assertBookingEventOnNight(resolvedOn(undefined), { ...base, side: "venue", calendarId: CAL }),
    ).not.toThrow();
    expect(() =>
      assertBookingEventOnNight(resolvedOn(OTHER_CAL), { ...base, side: "venue" }),
    ).not.toThrow();
  });

  it("the DAY is still checked first: another day is HOLD_DATE_MISMATCHES_EVENT whatever the calendar", () => {
    expect(() =>
      assertBookingEventOnNight(resolvedOn(OTHER_CAL), {
        ...base,
        night: "2026-10-18",
        side: "venue",
        calendarId: CAL,
      }),
    ).toThrow(expect.objectContaining({ code: "HOLD_DATE_MISMATCHES_EVENT" }));
  });
});

describe("isBookingCancelled (FR-009: the derived marker)", () => {
  it("is true only for a hold released BOOKING_CANCELLED", () => {
    expect(isBookingCancelled([hold({ status: "RELEASED", releasedReason: "BOOKING_CANCELLED" })])).toBe(true);
    expect(isBookingCancelled([hold({ status: "RELEASED", releasedReason: "REQUEST_CLOSED" })])).toBe(false);
    expect(isBookingCancelled([hold({ status: "CONFIRMED" })])).toBe(false);
    expect(isBookingCancelled([])).toBe(false);
  });
});

