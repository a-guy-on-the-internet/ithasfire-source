import { describe, expect, it } from "vitest";

import {
  QUICK_CREATE_FALLBACK_START_TIME,
  buildQuickCreatePrefillQuery,
  dayWithDefaultStartTime,
  isEmptyQuickCreatePrefill,
  readQuickCreatePrefill,
  sanitizeQuickCreatePrefill,
  toPrefillDateTimeLocal,
} from "../quick-create-prefill";

const PLACE = "11111111-1111-4111-8111-111111111111";
const CALENDAR = "22222222-2222-4222-8222-222222222222";
const SPACE = "33333333-3333-4333-8333-333333333333";

describe("sanitizeQuickCreatePrefill", () => {
  it("keeps well-formed values for every known key", () => {
    expect(
      sanitizeQuickCreatePrefill({
        startsAt: "2026-08-18T19:00",
        placeId: PLACE,
        calendarId: CALENDAR,
        spaceId: SPACE,
      }),
    ).toEqual({
      startsAt: "2026-08-18T19:00",
      placeId: PLACE,
      calendarId: CALENDAR,
      spaceId: SPACE,
    });
  });

  it("drops unknown keys", () => {
    expect(
      sanitizeQuickCreatePrefill({ placeId: PLACE, evil: "yes", spaceId: SPACE }),
    ).toEqual({ placeId: PLACE, spaceId: SPACE });
  });

  it.each([
    ["seconds", "2026-08-18T19:00:00"],
    ["offset", "2026-08-18T19:00Z"],
    ["hour 24", "2026-08-18T24:00"],
    ["minute 60", "2026-08-18T19:60"],
    ["date only", "2026-08-18"],
    ["garbage", "tomorrow"],
    ["empty", "   "],
  ])("rejects a %s startsAt", (_label, value) => {
    expect(sanitizeQuickCreatePrefill({ startsAt: value })).toEqual({});
  });

  it.each([
    ["not a uuid", "abc"],
    ["sql-ish", "1' OR '1"],
    ["truncated uuid", PLACE.slice(0, 20)],
  ])("rejects a %s placeId", (_label, value) => {
    expect(sanitizeQuickCreatePrefill({ placeId: value })).toEqual({});
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "startsAt=2026-08-18T19:00"],
    ["a number", 7],
  ])("returns an empty prefill for %s", (_label, value) => {
    expect(sanitizeQuickCreatePrefill(value)).toEqual({});
  });

  /**
   * The reason `createDraft` and `createDraftAt` are separate functions — a
   * handler bound to `onPress` receives a gesture event, and it must sanitize
   * to "no prefill" rather than smuggling junk into the URL.
   */
  it("sanitizes a React Native gesture-event-shaped object to nothing", () => {
    const gestureEvent = {
      nativeEvent: { locationX: 12, locationY: 4, timestamp: 1 },
      type: "click",
      target: {},
      currentTarget: {},
      preventDefault: () => undefined,
    };
    expect(sanitizeQuickCreatePrefill(gestureEvent)).toEqual({});
    expect(buildQuickCreatePrefillQuery(gestureEvent)).toBe("");
  });
});

describe("buildQuickCreatePrefillQuery", () => {
  it("writes the keys in a stable order", () => {
    expect(
      buildQuickCreatePrefillQuery({
        spaceId: SPACE,
        placeId: PLACE,
        startsAt: "2026-08-18T19:00",
      }),
    ).toBe(
      `?startsAt=2026-08-18T19%3A00&placeId=${PLACE}&spaceId=${SPACE}`,
    );
  });

  it("returns an empty string when nothing survives validation", () => {
    expect(buildQuickCreatePrefillQuery({})).toBe("");
    expect(buildQuickCreatePrefillQuery(undefined)).toBe("");
    expect(buildQuickCreatePrefillQuery({ startsAt: "nope" })).toBe("");
  });

  it("round-trips through readQuickCreatePrefill", () => {
    const prefill = {
      startsAt: "2026-08-18T19:30",
      placeId: PLACE,
      calendarId: CALENDAR,
      spaceId: SPACE,
    };
    const query = buildQuickCreatePrefillQuery(prefill);
    expect(
      readQuickCreatePrefill(new URLSearchParams(query.slice(1))),
    ).toEqual(prefill);
  });
});

describe("readQuickCreatePrefill", () => {
  it("ignores a hand-edited hostile query string", () => {
    const params = new URLSearchParams(
      "startsAt=2026-13-99T99:99&placeId=../../etc/passwd&spaceId=",
    );
    expect(readQuickCreatePrefill(params)).toEqual({});
  });

  it("keeps the valid half of a partly-broken query string", () => {
    const params = new URLSearchParams(
      `startsAt=2026-08-18T19:00&placeId=nope&calendarId=${CALENDAR}`,
    );
    expect(readQuickCreatePrefill(params)).toEqual({
      startsAt: "2026-08-18T19:00",
      calendarId: CALENDAR,
    });
  });

  it("tolerates a missing params object", () => {
    expect(readQuickCreatePrefill(null)).toEqual({});
    expect(isEmptyQuickCreatePrefill(readQuickCreatePrefill(undefined))).toBe(
      true,
    );
  });
});

describe("toPrefillDateTimeLocal", () => {
  it("reads the LOCAL wall clock of the date, zero-padded", () => {
    // Local-time constructor, local-time getters — no zone conversion happens
    // in either direction, which is exactly the property the calendars rely on.
    expect(toPrefillDateTimeLocal(new Date(2026, 7, 5, 9, 5))).toBe(
      "2026-08-05T09:05",
    );
    expect(toPrefillDateTimeLocal(new Date(2026, 11, 31, 23, 59))).toBe(
      "2026-12-31T23:59",
    );
  });

  it("returns an empty string for an invalid date", () => {
    expect(toPrefillDateTimeLocal(new Date("nope"))).toBe("");
  });

  it("produces a value the sanitizer accepts", () => {
    const value = toPrefillDateTimeLocal(new Date(2026, 0, 1, 0, 0));
    expect(sanitizeQuickCreatePrefill({ startsAt: value })).toEqual({
      startsAt: value,
    });
  });
});

describe("dayWithDefaultStartTime", () => {
  const day = new Date(2026, 7, 18, 0, 0);

  it("stamps the calendar's stored default start time", () => {
    const at = dayWithDefaultStartTime(day, "20:30");
    expect(toPrefillDateTimeLocal(at)).toBe("2026-08-18T20:30");
  });

  it("falls back to the evening default when no calendar is known", () => {
    expect(toPrefillDateTimeLocal(dayWithDefaultStartTime(day))).toBe(
      `2026-08-18T${QUICK_CREATE_FALLBACK_START_TIME}`,
    );
    expect(toPrefillDateTimeLocal(dayWithDefaultStartTime(day, null))).toBe(
      `2026-08-18T${QUICK_CREATE_FALLBACK_START_TIME}`,
    );
  });

  it.each(["7pm", "25:00", "19:75", "19", ""])(
    "falls back rather than trusting a malformed stored time (%s)",
    (stored) => {
      expect(toPrefillDateTimeLocal(dayWithDefaultStartTime(day, stored))).toBe(
        `2026-08-18T${QUICK_CREATE_FALLBACK_START_TIME}`,
      );
    },
  );

  it("keeps the calendar day it was given (no rollover)", () => {
    const at = dayWithDefaultStartTime(new Date(2026, 1, 28, 0, 0), "23:59");
    expect(toPrefillDateTimeLocal(at)).toBe("2026-02-28T23:59");
  });
});
