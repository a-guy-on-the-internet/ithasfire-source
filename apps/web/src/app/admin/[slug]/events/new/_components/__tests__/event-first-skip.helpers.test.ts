/**
 * The "request wasn't sent" notice's pure rules:
 *   1. Only `outcome: "skipped"` is a skip — created, existing and null all
 *      route to the band (or to nothing), never to the notice.
 *   2. Wire code → copy variant, including the one sub-message that matters
 *      (`booking_requests_unconfigured`) and the AppError convention that a
 *      bare code arrives with `message === code`.
 *   3. A fresh attempt clears it: any change to venue, intent, calendar or
 *      start date makes the snapshot stale; a space change does not.
 */
import { describe, expect, it } from "vitest";

import type { BuilderPlacement } from "../builder-placement.helpers";
import {
  eventFirstSkipFromSave,
  eventFirstSkipIsCurrent,
  eventFirstSkipSnapshot,
  eventFirstSkipVariant,
  type SaveEventBookingSkip,
} from "../event-first-skip.helpers";

const PLACE = "00000000-0000-4000-8000-0000000000c1";
const MAIN = "00000000-0000-4000-8000-0000000000a1";

const skipped = (
  overrides: Partial<SaveEventBookingSkip> = {},
): SaveEventBookingSkip => ({
  outcome: "skipped",
  reason: "venue_not_accepting",
  code: "PLACE_NOT_ACCEPTING_REQUESTS",
  message: "booking_requests_unconfigured",
  placeId: PLACE,
  placeName: "Stubb's BBQ",
  intent: "PERFORM",
  ...overrides,
});

describe("eventFirstSkipFromSave", () => {
  it("returns the skip for a skipped outcome and null for every other outcome", () => {
    const skip = skipped();
    expect(eventFirstSkipFromSave(skip)).toBe(skip);
    expect(
      eventFirstSkipFromSave({
        outcome: "created",
        id: "00000000-0000-4000-8000-0000000000b1",
        placeId: PLACE,
        placeName: "Stubb's BBQ",
        intent: "PERFORM",
        parked: false,
      }),
    ).toBeNull();
    expect(
      eventFirstSkipFromSave({
        outcome: "existing",
        id: "00000000-0000-4000-8000-0000000000b1",
        placeId: PLACE,
        placeName: null,
        intent: "PERFORM",
        parked: true,
      }),
    ).toBeNull();
    expect(eventFirstSkipFromSave(null)).toBeNull();
    expect(eventFirstSkipFromSave(undefined)).toBeNull();
  });
});

describe("eventFirstSkipVariant", () => {
  it("routes the no-hours sub-message to noHours", () => {
    expect(eventFirstSkipVariant(skipped())).toBe("noHours");
  });

  it("routes a paused venue (bare code — AppError sets message === code) to notTaking", () => {
    expect(
      eventFirstSkipVariant(
        skipped({ message: "PLACE_NOT_ACCEPTING_REQUESTS" }),
      ),
    ).toBe("notTaking");
    expect(eventFirstSkipVariant(skipped({ message: null }))).toBe("notTaking");
  });

  it("routes a closed or past date to date", () => {
    expect(
      eventFirstSkipVariant(
        skipped({ code: "BOOKING_DATE_UNAVAILABLE", message: "BOOKING_DATE_UNAVAILABLE" }),
      ),
    ).toBe("date");
  });

  it.each([
    ["PLACE_NOT_VERIFIED", "PLACE_NOT_VERIFIED"],
    ["INVALID_INPUT", "calendar_rejects_intent"],
  ])("routes %s / %s to notTaking", (code, message) => {
    expect(eventFirstSkipVariant(skipped({ code, message }))).toBe("notTaking");
  });

  it("routes sender_not_eligible to performer regardless of code", () => {
    expect(
      eventFirstSkipVariant(
        skipped({
          reason: "sender_not_eligible",
          code: "PERFORMER_MODE_REQUIRED",
          message: "PERFORMER_MODE_REQUIRED",
        }),
      ),
    ).toBe("performer");
  });
});

describe("snapshot — a fresh attempt clears the notice", () => {
  const placement: BuilderPlacement = {
    placeId: PLACE,
    bookingIntent: "PERFORM",
    calendarId: MAIN,
  };
  const startsAt = "2026-11-06T20:00";
  const snapshot = eventFirstSkipSnapshot({
    placement,
    startsAt,
    skip: skipped(),
  });

  it("is current while venue, intent, calendar and start date are unchanged", () => {
    expect(eventFirstSkipIsCurrent(snapshot, { placement, startsAt })).toBe(true);
  });

  it.each([
    ["venue", { placement: { ...placement, placeId: "00000000-0000-4000-8000-0000000000c2" }, startsAt }],
    ["intent", { placement: { ...placement, bookingIntent: "RENT" as const }, startsAt }],
    ["calendar", { placement: { ...placement, calendarId: "00000000-0000-4000-8000-0000000000a9" }, startsAt }],
    ["start date", { placement, startsAt: "2026-11-07T20:00" }],
    ["venue cleared", { placement: null, startsAt }],
  ])("goes stale when the %s changes", (_what, current) => {
    expect(eventFirstSkipIsCurrent(snapshot, current)).toBe(false);
  });

  it("snapshots the intent the SERVER answered, not the local placement's", () => {
    // A re-save asking RENT can be refused for the PERFORM it actually
    // walked; the wire's intent is what the refusal is about.
    const fromWire = eventFirstSkipSnapshot({
      placement: { ...placement, bookingIntent: "RENT" },
      startsAt,
      skip: skipped({ intent: "PERFORM" }),
    });
    expect(fromWire.bookingIntent).toBe("PERFORM");
    expect(fromWire.calendarId).toBe(MAIN);
    expect(fromWire.startsAt).toBe(startsAt);
  });
});
