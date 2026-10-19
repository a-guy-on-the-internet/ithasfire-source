import { describe, expect, it } from "vitest";

import {
  bookingCtas,
  buildSpaceRequestPayload,
  calendarsForIntent,
  defaultCalendarId,
  isOvernightWindow,
  mapCreateBookingRequestError,
  offeredIntents,
  pickDefaultIntent,
  wallClockToInstant,
  type BookingOptionCalendar,
  type SpaceRequestFormValues,
} from "../request-to-play-form.helpers";

/**
 * Pure intent/config logic for the booking dialog (venue-confirmation-and-
 * booking-intents spec): what the calendars offer, which intent the dialog
 * opens on, which CTAs the page shows, and the RENT/USE wire payload.
 */

function calendar(
  overrides: Partial<BookingOptionCalendar> = {},
): BookingOptionCalendar {
  return {
    id: "cal-main",
    name: "Main",
    isDefault: true,
    acceptsPerform: true,
    acceptsRent: false,
    acceptsUse: false,
    rentalRateCents: null,
    rentalRateCurrency: null,
    rentalRateVisible: false,
    spaces: [{ id: "space-a", name: "Room A" }],
    ...overrides,
  };
}

describe("offeredIntents / calendarsForIntent", () => {
  it("lists intents in display order, only where some calendar accepts them", () => {
    const calendars = [
      calendar(),
      calendar({ id: "cal-rent", isDefault: false, acceptsPerform: false, acceptsRent: true }),
    ];
    expect(offeredIntents(calendars)).toEqual(["PERFORM", "RENT"]);
    expect(calendarsForIntent(calendars, "RENT").map((c) => c.id)).toEqual([
      "cal-rent",
    ]);
    expect(calendarsForIntent(calendars, "USE")).toEqual([]);
  });

  it("WITHHOLDS RENT/USE from a calendar with no active room — that is invalid data, not a configuration", () => {
    // Room gate RESTORED 2026-09-23, reversing the 09-22 drop. The owner
    // ruling makes a roomless calendar illegal to write anywhere, so the
    // booking surfaces fail closed on the ones already in the wild rather
    // than taking a request that could only mint spaceless.
    const roomless = calendar({ acceptsRent: true, acceptsUse: true, spaces: [] });
    expect(offeredIntents([roomless])).toEqual(["PERFORM"]);
    expect(calendarsForIntent([roomless], "RENT")).toEqual([]);
    expect(calendarsForIntent([roomless], "USE")).toEqual([]);
  });

  it("still takes a PERFORM pitch on a roomless calendar — a night on the bill needs no room", () => {
    const roomless = calendar({ acceptsRent: true, acceptsUse: true, spaces: [] });
    expect(calendarsForIntent([roomless], "PERFORM")).toHaveLength(1);
  });

  it("a place with no calendars still takes a pitch, and only a pitch", () => {
    expect(offeredIntents([])).toEqual(["PERFORM"]);
  });

  it("offers nothing when every calendar turned every intent off", () => {
    expect(offeredIntents([calendar({ acceptsPerform: false })])).toEqual([]);
  });
});

describe("pickDefaultIntent", () => {
  it("honours the trigger's request when offered", () => {
    expect(
      pickDefaultIntent({
        offered: ["PERFORM", "RENT"],
        requested: "RENT",
        performerModeOn: true,
      }),
    ).toBe("RENT");
  });

  it("falls back to performer mode → PERFORM, else the first room intent, else PERFORM", () => {
    expect(
      pickDefaultIntent({ offered: ["PERFORM", "USE"], performerModeOn: true }),
    ).toBe("PERFORM");
    // A non-performer at a venue that also lends rooms is not sent to the
    // performer-mode gate first.
    expect(
      pickDefaultIntent({ offered: ["PERFORM", "USE"], performerModeOn: false }),
    ).toBe("USE");
    expect(
      pickDefaultIntent({ offered: ["PERFORM"], performerModeOn: false }),
    ).toBe("PERFORM");
    expect(
      pickDefaultIntent({
        offered: ["RENT", "USE"],
        requested: "PERFORM",
        performerModeOn: true,
      }),
    ).toBe("RENT");
    expect(pickDefaultIntent({ offered: [], performerModeOn: true })).toBeNull();
  });
});

describe("defaultCalendarId", () => {
  it("prefers the place default, else the first, else null", () => {
    expect(
      defaultCalendarId([
        calendar({ id: "b", isDefault: false }),
        calendar({ id: "a", isDefault: true }),
      ]),
    ).toBe("a");
    expect(defaultCalendarId([calendar({ id: "b", isDefault: false })])).toBe("b");
    expect(defaultCalendarId([])).toBeNull();
  });
});

describe("bookingCtas", () => {
  it("shows Play here and Rent-or-use only where a calendar accepts them", () => {
    expect(
      bookingCtas({
        offered: ["PERFORM", "RENT"],
        acceptsBookingRequests: true,
        settled: true,
        failed: false,
      }),
    ).toEqual([
      { intent: "PERFORM", kind: "play" },
      { intent: "RENT", kind: "space" },
    ]);
    // USE alone still gets the space button, opening on USE.
    expect(
      bookingCtas({
        offered: ["USE"],
        acceptsBookingRequests: true,
        settled: true,
        failed: false,
      }),
    ).toEqual([{ intent: "USE", kind: "space" }]);
  });

  it("hides both when a claimed venue opted out", () => {
    expect(
      bookingCtas({
        offered: ["PERFORM", "RENT"],
        acceptsBookingRequests: false,
        settled: true,
        failed: false,
      }),
    ).toEqual([]);
  });

  it("keeps today's single Play here before the read settles and if it fails", () => {
    const play = [{ intent: "PERFORM", kind: "play" }];
    expect(
      bookingCtas({
        offered: [],
        acceptsBookingRequests: true,
        settled: false,
        failed: false,
      }),
    ).toEqual(play);
    expect(
      bookingCtas({
        offered: [],
        acceptsBookingRequests: true,
        settled: false,
        failed: true,
      }),
    ).toEqual(play);
  });
});

describe("wallClockToInstant", () => {
  it("reads the wall clock in the venue's zone, not the host's", () => {
    // 7pm Chicago, standard time (-06:00) → 01:00Z next day.
    expect(
      wallClockToInstant("2027-01-15", "19:00", "America/Chicago")?.toISOString(),
    ).toBe("2027-01-16T01:00:00.000Z");
    // Daylight time (-05:00).
    expect(
      wallClockToInstant("2027-07-15", "19:00", "America/Chicago")?.toISOString(),
    ).toBe("2027-07-16T00:00:00.000Z");
    // East of Greenwich.
    expect(
      wallClockToInstant("2027-07-15", "09:30", "Europe/Berlin")?.toISOString(),
    ).toBe("2027-07-15T07:30:00.000Z");
  });

  it("settles a DST edge and rejects garbage", () => {
    // 2027-03-14 02:30 does not exist in Chicago (spring forward at 02:00);
    // resolves to the instant after the gap rather than throwing.
    const gap = wallClockToInstant("2027-03-14", "02:30", "America/Chicago");
    expect(gap).not.toBeNull();
    expect(gap!.toISOString()).toBe("2027-03-14T08:30:00.000Z");
    expect(wallClockToInstant("2027-13-01", "10:00", "America/Chicago")).toBeNull();
    expect(wallClockToInstant("2027-03-01", "25:00", "America/Chicago")).toBeNull();
    expect(wallClockToInstant("2027-03-01", "10:00", "Mars/Olympus")).toBeNull();
  });
});

describe("buildSpaceRequestPayload", () => {
  const base: SpaceRequestFormValues = {
    intent: "RENT",
    calendarId: "cal-rent",
    date: "2027-03-06",
    startTime: "19:00",
    endTime: "23:00",
    purpose: "  Album release party  ",
    expectedAttendance: "",
    contactPhone: "",
    timeZone: "America/Chicago",
  };

  it("builds the wire fields as place-local instants, trimming and dropping empties", () => {
    expect(buildSpaceRequestPayload(base)).toEqual({
      ok: true,
      payload: {
        intent: "RENT",
        calendarId: "cal-rent",
        requestedStartsAt: "2027-03-07T01:00:00.000Z",
        requestedEndsAt: "2027-03-07T05:00:00.000Z",
        purpose: "Album release party",
      },
    });
  });

  it("carries attendance and phone when given", () => {
    const result = buildSpaceRequestPayload({
      ...base,
      intent: "USE",
      expectedAttendance: " 40 ",
      contactPhone: "+1 555 123 4567",
    });
    expect(result.ok && result.payload).toMatchObject({
      intent: "USE",
      expectedAttendance: 40,
      contactPhone: "+1 555 123 4567",
    });
  });

  it("rolls an end clock earlier than the start to the next day", () => {
    const result = buildSpaceRequestPayload({
      ...base,
      startTime: "20:00",
      endTime: "01:00",
    });
    expect(result.ok && result.payload.requestedEndsAt).toBe(
      "2027-03-07T07:00:00.000Z",
    );
    expect(isOvernightWindow("20:00", "01:00")).toBe(true);
    expect(isOvernightWindow("20:00", "23:00")).toBe(false);
    expect(isOvernightWindow("", "23:00")).toBe(false);
  });

  it("names NO room — the venue picks it at accept, on the draft event", () => {
    const result = buildSpaceRequestPayload(base);
    expect(result.ok).toBe(true);
    expect(Object.keys(result.ok ? result.payload : {})).not.toContain(
      "spaceId",
    );
  });

  it("requires a full window and a one-line purpose — in that order", () => {
    expect(buildSpaceRequestPayload({ ...base, date: "" })).toEqual({
      ok: false,
      errorKey: "admin.bkErrWindow",
    });
    expect(buildSpaceRequestPayload({ ...base, endTime: "" })).toEqual({
      ok: false,
      errorKey: "admin.bkErrWindow",
    });
    expect(
      buildSpaceRequestPayload({ ...base, startTime: "19:00", endTime: "19:00" }),
    ).toEqual({ ok: false, errorKey: "admin.bkErrWindowOrder" });
    expect(buildSpaceRequestPayload({ ...base, purpose: "   " })).toEqual({
      ok: false,
      errorKey: "admin.bkErrPurpose",
    });
    expect(
      buildSpaceRequestPayload({ ...base, purpose: "x".repeat(201) }),
    ).toEqual({ ok: false, errorKey: "admin.bkErrPurpose" });
  });

  it("validates attendance and phone", () => {
    expect(
      buildSpaceRequestPayload({ ...base, expectedAttendance: "0" }),
    ).toEqual({ ok: false, errorKey: "admin.bkErrAttendance" });
    expect(
      buildSpaceRequestPayload({ ...base, expectedAttendance: "12.5" }),
    ).toEqual({ ok: false, errorKey: "admin.bkErrAttendance" });
    expect(buildSpaceRequestPayload({ ...base, contactPhone: "abc" })).toEqual({
      ok: false,
      errorKey: "admin.bkErrPhone",
    });
  });
});

describe("mapCreateBookingRequestError — intent refusals", () => {
  it("routes the two INVALID_INPUT machine keys to their own copy", () => {
    expect(
      mapCreateBookingRequestError({
        data: { appCode: "INVALID_INPUT" },
        message: "calendar_rejects_intent",
      }),
    ).toBe("admin.bkErrCalendarRejectsIntent");
    expect(
      mapCreateBookingRequestError({
        data: { appCode: "INVALID_INPUT" },
        message: "space_not_on_calendar",
      }),
    ).toBe("admin.bkErrSpaceNotOnCalendar");
    // Any other INVALID_INPUT stays generic.
    expect(
      mapCreateBookingRequestError({
        data: { appCode: "INVALID_INPUT" },
        message: "window_too_long",
      }),
    ).toBe("admin.bkErrGeneric");
  });
});
