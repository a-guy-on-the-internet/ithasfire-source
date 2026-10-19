import { describe, expect, it } from "vitest";

import {
  askOffersTextReminders,
  signupReminderAnchor,
  type ReminderAskFields,
} from "./signup-reminder-anchor";

const START = new Date("2026-11-01T18:00:00.000Z");
const SHIFT_ID = "00000000-0000-4000-8000-000000000010";
const EVENT_ID = "00000000-0000-4000-8000-000000000011";

const ask = (over: Partial<ReminderAskFields> = {}): ReminderAskFields => ({
  subjectType: "PLACE",
  cadence: "ONE_TIME",
  startsAt: START,
  ...over,
});

describe("signupReminderAnchor (volunteer-ask-reminders FR-001)", () => {
  it.each([
    [
      "a shift signup: its shift",
      { shiftId: SHIFT_ID, eventId: EVENT_ID, roleHasShifts: true, ask: null },
      "SHIFT",
    ],
    // The shift wins even when the event ask is one-time with a start.
    [
      "a shift signup on an EVENT ask: still its shift",
      {
        shiftId: SHIFT_ID,
        eventId: EVENT_ID,
        roleHasShifts: true,
        ask: ask({ subjectType: "EVENT" }),
      },
      "SHIFT",
    ],
    [
      "an event signup on a role with no shifts: the event's start",
      { shiftId: null, eventId: EVENT_ID, roleHasShifts: false, ask: null },
      "EVENT_START",
    ],
    [
      "a shiftless signup on a role WITH shifts (role-level, or its shift deleted): none",
      { shiftId: null, eventId: EVENT_ID, roleHasShifts: true, ask: null },
      null,
    ],
    [
      "an event signup carrying its EVENT ask: the event's start",
      {
        shiftId: null,
        eventId: EVENT_ID,
        roleHasShifts: false,
        ask: ask({ subjectType: "EVENT", cadence: "ONGOING", startsAt: null }),
      },
      "EVENT_START",
    ],
    [
      "a ONE_TIME PLACE ask with a start",
      { shiftId: null, eventId: null, roleHasShifts: false, ask: ask() },
      "ASK_START",
    ],
    [
      "a ONE_TIME ORG ask with a start",
      { shiftId: null, eventId: null, roleHasShifts: false, ask: ask({ subjectType: "ORG" }) },
      "ASK_START",
    ],
    [
      "a ONE_TIME HUMAN ask with a start",
      { shiftId: null, eventId: null, roleHasShifts: false, ask: ask({ subjectType: "HUMAN" }) },
      "ASK_START",
    ],
    [
      "an ONGOING ask (R1)",
      { shiftId: null, eventId: null, roleHasShifts: false, ask: ask({ cadence: "ONGOING" }) },
      null,
    ],
    [
      "a RECURRING ask (R1)",
      { shiftId: null, eventId: null, roleHasShifts: false, ask: ask({ cadence: "RECURRING" }) },
      null,
    ],
    [
      "a ONE_TIME ask without a start (R2)",
      { shiftId: null, eventId: null, roleHasShifts: false, ask: ask({ startsAt: null }) },
      null,
    ],
    [
      "an EVENT ask's own role, no event (not an ask anchor)",
      { shiftId: null, eventId: null, roleHasShifts: false, ask: ask({ subjectType: "EVENT" }) },
      null,
    ],
    [
      "no event, no shift, no ask",
      { shiftId: null, eventId: null, roleHasShifts: false, ask: null },
      null,
    ],
  ] as const)("%s", (_name, signup, expected) => {
    expect(signupReminderAnchor(signup)).toBe(expected);
  });
});

describe("askOffersTextReminders", () => {
  it("is true exactly for a non-EVENT ONE_TIME ask with a start", () => {
    expect(askOffersTextReminders(ask())).toBe(true);
    expect(askOffersTextReminders(ask({ subjectType: "ORG" }))).toBe(true);
    expect(askOffersTextReminders(ask({ cadence: "ONGOING" }))).toBe(false);
    expect(askOffersTextReminders(ask({ cadence: "RECURRING" }))).toBe(false);
    expect(askOffersTextReminders(ask({ startsAt: null }))).toBe(false);
    expect(askOffersTextReminders(ask({ subjectType: "EVENT" }))).toBe(false);
  });
});
