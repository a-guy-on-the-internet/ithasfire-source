import { describe, expect, it, vi } from "vitest";

import {
  findUnavailableBookingDates,
  type ValidateBookingDatesDeps,
} from "./validate-booking-dates";

const PLACE_ID = "00000000-0000-4000-8000-00000000d030";
const OWNER_ORG_ID = "22222222-2222-4222-8222-222222222222";
const TZ = "America/Chicago";
const NOW = new Date("2026-08-10T18:00:00.000Z"); // 1pm Monday in Austin

type Row = {
  id: string;
  placeId: string;
  /** null = PLACE-WIDE row (applies to every calendar) — what these use. */
  calendarId: string | null;
  dayOfWeek: number | null;
  date: Date | null;
  startTime: string | null;
  endTime: string | null;
  note: string | null;
  isOpen: boolean;
};

const window = (dayOfWeek: number, startTime: string, endTime: string): Row => ({
  id: `w${dayOfWeek}${startTime}`,
  placeId: PLACE_ID,
  calendarId: null,
  dayOfWeek,
  date: null,
  startTime,
  endTime,
  note: null,
  isOpen: true,
});

const blackout = (isoDate: string): Row => ({
  id: `b${isoDate}`,
  placeId: PLACE_ID,
  calendarId: null,
  dayOfWeek: null,
  date: new Date(`${isoDate}T05:00:00.000Z`),
  startTime: null,
  endTime: null,
  note: "private",
  isOpen: false,
});

/** A calendar with no joined spaces — enough for rules-scope assertions. */
const calendarRow = (id: string, isDefault: boolean) => ({
  id,
  placeId: PLACE_ID,
  name: id,
  slug: id,
  description: null,
  isDefault,
  defaultStartTime: null,
  defaultCategoryId: null,
  eventTemplate: null,
  createdAt: NOW,
  updatedAt: NOW,
  spaces: [],
});

const deps = (
  rows: Row[],
  events: Array<{ title: string; startsAt: string; endsAt: string | null }> = [],
  calendars: Array<{ id: string; isDefault: boolean }> = [],
): ValidateBookingDatesDeps => ({
  repos: {
    // Availability is calendar-scoped now (venue-hierarchy FR-007). Most
    // fixtures here use a place with NO calendars and place-wide rows, which
    // is exactly the pre-hierarchy behaviour those cases were written against;
    // the routing suite at the bottom supplies real calendars.
    calendars: {
      listByPlace: vi.fn(async () =>
        calendars.map((c) => calendarRow(c.id, c.isDefault)),
      ),
      listAvailabilityForPlace: vi.fn(async () => rows),
    },
    events: {
      listPublishedOccurrencesByPlace: vi.fn(async () =>
        events.map((e, i) => ({
          eventId: `e${i}`,
          eventDateId: null,
          title: e.title,
          startsAt: new Date(e.startsAt),
          endsAt: e.endsAt ? new Date(e.endsAt) : null,
          spaceId: null,
        })),
      ),
    },
    // Venue-confirmation spec: the availability read narrows occupancy to
    // confirmed events via the place's owner ids.
    places: {
      getById: vi.fn(async () => ({
        id: PLACE_ID,
        orgIdsWithAccess: [OWNER_ORG_ID],
        humanIdsWithAccess: [],
      })),
    },
  } as unknown as ValidateBookingDatesDeps["repos"],
  now: () => NOW,
});

// Tue/Thu evenings, Fri matinee + overnight. Monday is dark.
const HOURS = [
  window(2, "18:00", "23:00"),
  window(4, "18:00", "23:00"),
  window(5, "14:00", "17:00"),
  window(5, "18:00", "02:00"),
];

const check = (rows: Row[], dates: string[], events?: Parameters<typeof deps>[1]) =>
  findUnavailableBookingDates(deps(rows, events), {
    placeId: PLACE_ID,
    dates,
    timezone: TZ,
  });

describe("findUnavailableBookingDates", () => {
  it("accepts a time the venue actually offers", async () => {
    // Tuesday 18 Aug, 7:00pm — inside the 6–11pm window.
    expect(await check(HOURS, ["2026-08-18T19:00"])).toEqual([]);
  });

  it("accepts a bare date on an open night", async () => {
    expect(await check(HOURS, ["2026-08-18"])).toEqual([]);
  });

  it("rejects a night the venue is dark", async () => {
    // Monday 17 Aug — no weekday row at all.
    expect(await check(HOURS, ["2026-08-17T19:00"])).toEqual([
      { value: "2026-08-17T19:00", reason: "closed" },
    ]);
  });

  it("rejects a time outside the open window — the 4am Monday case", async () => {
    expect(await check(HOURS, ["2026-08-18T04:00"])).toEqual([
      { value: "2026-08-18T04:00", reason: "time_not_offered" },
    ]);
  });

  it("rejects a date already in the past", async () => {
    expect(await check(HOURS, ["2026-08-04T19:00"])).toEqual([
      { value: "2026-08-04T19:00", reason: "past" },
    ]);
  });

  it("rejects a blacked-out date", async () => {
    expect(
      await check([...HOURS, blackout("2026-08-18")], ["2026-08-18T19:00"]),
    ).toEqual([{ value: "2026-08-18T19:00", reason: "blackout" }]);
  });

  it("rejects a night with no room left", async () => {
    const packed = [
      {
        title: "Sold out",
        startsAt: "2026-08-18T23:00:00.000Z", // 6pm CDT
        endsAt: "2026-08-19T04:00:00.000Z", // 11pm CDT
      },
    ];
    expect(await check(HOURS, ["2026-08-18T19:00"], packed)).toEqual([
      { value: "2026-08-18T19:00", reason: "full" },
    ]);
  });

  it("accepts a late slot that runs past midnight", async () => {
    // Friday's window is 6pm–2am, so 12:30am is a genuine offered start the
    // engine expresses as minutes beyond 1440.
    expect(await check(HOURS, ["2026-08-21T00:30"])).toEqual([]);
  });

  it("reports every offending entry, not just the first", async () => {
    const problems = await check(HOURS, [
      "2026-08-18T19:00", // fine
      "2026-08-17T19:00", // dark Monday
      "2026-08-04", // past
    ]);
    expect(problems.map((p) => p.reason).sort()).toEqual(["closed", "past"]);
  });

  // ── the escape hatch ─────────────────────────────────────────────────────

  it("lets EVERYTHING through for a venue that has never set hours", async () => {
    // Most venues today. Enforcing against an empty ruleset would break
    // booking requests platform-wide.
    expect(
      await check([], ["2026-08-17T04:00", "2026-08-18", "2026-09-30T23:30"]),
    ).toEqual([]);
  });

  it("still rejects a past date for a venue with no hours", async () => {
    expect(await check([], ["2026-08-04"])).toEqual([
      { value: "2026-08-04", reason: "past" },
    ]);
  });

  it("still honours a blackout for a venue with no weekly hours", async () => {
    expect(
      await check([blackout("2026-08-18")], ["2026-08-18T19:00"]),
    ).toEqual([{ value: "2026-08-18T19:00", reason: "blackout" }]);
  });

  it("probes a whole week so one requested Tuesday can't look like 'no hours'", async () => {
    // Only Friday is open. Asking about a Tuesday must still be told the venue
    // HAS hours — otherwise the escape hatch would swallow the rejection.
    expect(await check([window(5, "18:00", "23:00")], ["2026-08-18T19:00"])).toEqual([
      { value: "2026-08-18T19:00", reason: "closed" },
    ]);
  });

  it("returns nothing for an empty request", async () => {
    expect(await check(HOURS, [])).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Calendar routing (venue-hierarchy FR-007/FR-008)
//
// The gate must answer against the calendar the REQUEST ROUTES TO. If it
// always used the default, a performer who picked a Wednesday the "Social
// Club" genuinely offers would be judged against the main stage's hours and
// rejected on a night that is, in fact, available — the picker and the gate
// disagreeing about the same venue.
//
// Deleting the `calendarId` thread-through in validate-booking-dates.ts turns
// these red; nothing else in this file does.
// ─────────────────────────────────────────────────────────────────────────────

const MAIN_CAL = "11111111-1111-4111-8111-111111111111";
const CLUB_CAL = "22222222-2222-4222-8222-222222222222";

describe("findUnavailableBookingDates — calendar routing", () => {
  // Main stage: Friday only. Social Club: Wednesday only. No place-wide rows,
  // so the two calendars genuinely disagree about a Wednesday.
  const ROWS: Row[] = [
    { ...window(5, "18:00", "23:00"), id: "main-fri", calendarId: MAIN_CAL },
    { ...window(3, "19:00", "23:00"), id: "club-wed", calendarId: CLUB_CAL },
  ];
  const CALENDARS = [
    { id: MAIN_CAL, isDefault: true },
    { id: CLUB_CAL, isDefault: false },
  ];
  // 2026-08-19 is a Wednesday.
  const WEDNESDAY = "2026-08-19T19:00";

  const checkFor = (calendarId?: string) =>
    findUnavailableBookingDates(deps(ROWS, [], CALENDARS), {
      placeId: PLACE_ID,
      dates: [WEDNESDAY],
      timezone: TZ,
      ...(calendarId ? { calendarId } : {}),
    });

  it("ACCEPTS a Wednesday when the request routes to the calendar that opens it", async () => {
    expect(await checkFor(CLUB_CAL)).toEqual([]);
  });

  it("REJECTS the same Wednesday when the request routes to a calendar that is dark", async () => {
    expect(await checkFor(MAIN_CAL)).toEqual([
      { value: WEDNESDAY, reason: "closed" },
    ]);
  });

  it("falls back to the DEFAULT calendar when the request names none", async () => {
    // Same answer as the main stage — the default here — and pointedly NOT
    // the union of both calendars' hours.
    expect(await checkFor()).toEqual([
      { value: WEDNESDAY, reason: "closed" },
    ]);
  });

  it("surfaces a cross-place calendarId as CALENDAR_NOT_FOUND, before any write", async () => {
    await expect(
      findUnavailableBookingDates(deps(ROWS, [], CALENDARS), {
        placeId: PLACE_ID,
        dates: [WEDNESDAY],
        timezone: TZ,
        calendarId: "33333333-3333-4333-8333-333333333333",
      }),
    ).rejects.toMatchObject({ code: "CALENDAR_NOT_FOUND" });
  });

  it("still applies PLACE-WIDE blackouts whichever calendar is named", async () => {
    const rows = [...ROWS, blackout("2026-08-19")];
    for (const calendarId of [MAIN_CAL, CLUB_CAL]) {
      const out = await findUnavailableBookingDates(
        deps(rows, [], CALENDARS),
        {
          placeId: PLACE_ID,
          dates: [WEDNESDAY],
          timezone: TZ,
          calendarId,
        },
      );
      expect(out).toEqual([{ value: WEDNESDAY, reason: "blackout" }]);
    }
  });
});

describe("findUnavailableBookingDates — venue confirmation", () => {
  it("the confirmed-only occupancy filter reaches the repo through the availability read", async () => {
    const d = deps(HOURS, [{ title: "Booked", startsAt: "2026-08-18T19:00:00-05:00", endsAt: null }]);
    await findUnavailableBookingDates(d, { placeId: PLACE_ID, dates: ["2026-08-18"], timezone: TZ });
    expect(d.repos.events.listPublishedOccurrencesByPlace).toHaveBeenCalledWith(
      expect.objectContaining({
        placeId: PLACE_ID,
        venueConfirmedFor: {
          orgIds: [OWNER_ORG_ID],
          humanIds: [],
          acceptsCommunityListings: false,
        },
      }),
    );
  });
});
