import { describe, expect, it, vi } from "vitest";

import { placesRouter } from "../places";
import { createCaller } from "./test-helpers";
import type { Ctx } from "../../context";

// Transport coverage for `places.getBookingAvailability` — the public booking
// date picker's read.
//
// The load-bearing assertion is the LAST one in the first case: every
// availability row carries a `note` that is the venue's private reason for a
// closure ("private hire" tells a competitor the room is earning that night;
// "floor refinishing" tells them it isn't). This is a PUBLIC, unauthenticated
// procedure whose output schema is `.strict()` and has no such key, so a future
// edit that lets a raw repo row reach the wire fails here rather than in
// production. The use-case tests can't catch a transport that declares the
// wrong output schema.
//
// The second load-bearing case is `calendarId`: it is CLIENT-SUPPLIED on a
// public procedure, so a calendar belonging to another place must come back as
// NOT_FOUND — never as a confirmation that the id exists somewhere.

const PLACE_ID = "00000000-0000-4000-8000-00000000d030";
const ROW_ID = "22222222-2222-4222-8222-222222222222";
const CALENDAR_ID = "ca1e0da1-1111-4111-8111-111111111111";
const FOREIGN_CALENDAR_ID = "ca1e0da1-9999-4999-8999-999999999999";
const SPACE_ID = "5face000-1111-4111-8111-111111111111";

const row = {
  id: ROW_ID,
  placeId: PLACE_ID,
  // Place-wide row: applies to every calendar of the place.
  calendarId: null,
  dayOfWeek: 5,
  date: null,
  startTime: "18:00",
  endTime: "02:00",
  note: "private hire — do not surface",
  isOpen: true,
  createdAt: new Date("2026-08-01T00:00:00.000Z"),
  updatedAt: new Date("2026-08-01T00:00:00.000Z"),
};

const calendarRow = {
  id: CALENDAR_ID,
  placeId: PLACE_ID,
  name: "Main Stage",
  slug: "main-stage",
  description: null,
  isDefault: true,
  defaultStartTime: null,
  defaultCategoryId: null,
  eventTemplate: null,
  createdAt: new Date("2026-08-01T00:00:00.000Z"),
  updatedAt: new Date("2026-08-01T00:00:00.000Z"),
  spaces: [
    {
      id: SPACE_ID,
      placeId: PLACE_ID,
      name: "Main Stage",
      capacity: 300,
      sortOrder: 0,
      status: "ACTIVE",
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
      updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    },
  ],
};

describe("places.getBookingAvailability", () => {
  const buildAvailabilityRepos = () =>
    ({
      calendars: {
        listByPlace: vi.fn(async () => [calendarRow]),
        listAvailabilityForPlace: vi.fn(async () => [
          { ...row, note: "private hire — do not surface" },
          {
            id: "33333333-3333-4333-8333-333333333333",
            placeId: PLACE_ID,
            calendarId: null,
            dayOfWeek: null,
            date: new Date("2026-08-22T05:00:00.000Z"),
            startTime: null,
            endTime: null,
            note: "floor refinishing",
            isOpen: false,
          },
        ]),
      },
      events: {
        listPublishedOccurrencesByPlace: vi.fn(async () => []),
      },
      // Availability now loads the place to derive venue confirmation
      // (third-party events block nothing until confirmed) — the row only
      // needs the owner access lists here.
      places: {
        getById: vi.fn(async () => ({
          id: PLACE_ID,
          orgIdsWithAccess: [],
          humanIdsWithAccess: [],
        })),
      },
    }) as unknown as Ctx["repos"];

  it("serves an anonymous caller and never carries a private note", async () => {
    const { caller } = createCaller(
      { places: placesRouter },
      { repos: buildAvailabilityRepos(), actorHumanId: null },
    );

    const out = await caller.places.getBookingAvailability({
      placeId: PLACE_ID,
      from: "2026-08-21",
      days: 3,
      timezone: "America/Chicago",
    });

    expect(out.timezone).toBe("America/Chicago");
    expect(out.days).toHaveLength(3);
    // Friday's window came from the weekday row…
    expect(out.days[0]!.status).toBe("free");
    expect(out.days[0]!.slots.length).toBeGreaterThan(0);
    // …Saturday is blacked out, with no bookable time at all…
    expect(out.days[1]!.status).toBe("blackout");
    expect(out.days[1]!.slots).toEqual([]);
    // …and neither note reaches the wire.
    const wire = JSON.stringify(out);
    expect(wire).not.toContain("private hire");
    expect(wire).not.toContain("floor refinishing");
  });

  it("echoes the resolved default calendarId through the output schema", async () => {
    // The key has to survive the `.output()` schema, not just the use case —
    // a client that omitted `calendarId` needs to know which stream it got.
    const { caller } = createCaller(
      { places: placesRouter },
      { repos: buildAvailabilityRepos(), actorHumanId: null },
    );

    const out = await caller.places.getBookingAvailability({
      placeId: PLACE_ID,
      from: "2026-08-21",
      days: 1,
      timezone: "America/Chicago",
    });

    expect(out.calendarId).toBe(CALENDAR_ID);
  });

  it("accepts an explicit same-place calendarId", async () => {
    const { caller } = createCaller(
      { places: placesRouter },
      { repos: buildAvailabilityRepos(), actorHumanId: null },
    );

    const out = await caller.places.getBookingAvailability({
      placeId: PLACE_ID,
      from: "2026-08-21",
      days: 1,
      timezone: "America/Chicago",
      calendarId: CALENDAR_ID,
    });

    expect(out.calendarId).toBe(CALENDAR_ID);
  });

  it("404s a calendarId that belongs to another place — no existence leak", async () => {
    const { caller } = createCaller(
      { places: placesRouter },
      { repos: buildAvailabilityRepos(), actorHumanId: null },
    );

    await expect(
      caller.places.getBookingAvailability({
        placeId: PLACE_ID,
        from: "2026-08-21",
        days: 1,
        calendarId: FOREIGN_CALENDAR_ID,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses a window longer than the cap", async () => {
    const { caller } = createCaller(
      { places: placesRouter },
      { repos: buildAvailabilityRepos(), actorHumanId: null },
    );

    await expect(
      caller.places.getBookingAvailability({
        placeId: PLACE_ID,
        from: "2026-08-21",
        days: 365,
      }),
    ).rejects.toThrow();
  });
});

describe("retired Place-level availability editor procedures", () => {
  // A router-shape assertion, not a behaviour one: the venue hierarchy moved
  // availability to Calendar, and a re-added Place-level writer would be a
  // second, drifting source of truth for the same venue hours (the exact
  // failure mode FR-007 calls out). Cheap to keep, loud if it comes back.
  it("are gone from the places router", () => {
    const procedures = Object.keys(placesRouter);

    expect(procedures).not.toContain("listAvailability");
    expect(procedures).not.toContain("listAvailabilityForOwner");
    expect(procedures).not.toContain("createAvailability");
    expect(procedures).not.toContain("updateAvailability");
    expect(procedures).not.toContain("deleteAvailability");

    // …while the calendar-scoped replacements and the live picker read remain.
    expect(procedures).toContain("getBookingAvailability");
    expect(procedures).toContain("listCalendarAvailability");
    expect(procedures).toContain("upsertCalendarAvailability");
    expect(procedures).toContain("deleteCalendarAvailability");
  });
});
