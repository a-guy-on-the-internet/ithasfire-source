import { describe, expect, it } from "vitest";

import {
  deriveDefaultPlacement,
  intentDomId,
  intentIsOffered,
  nextIntentForKey,
  placementForCalendar,
  placementForIntent,
  placementIsComplete,
  resolveBuilderPlacement,
  type BookingOptionCalendar,
  type BuilderPlacement,
} from "../builder-placement.helpers";

/**
 * The third-party venue cascade's rules, pinned without a renderer — the
 * same posture as `quick-create-helpers.test.ts`'s placement suite, which
 * `resolveBuilderPlacement` mirrors: a placement is only ever sent for the
 * venue it was minted for, and never in address mode.
 */

const PLACE = "00000000-0000-4000-8000-00000000000p".replace("p", "1");
const OTHER_PLACE = "00000000-0000-4000-8000-000000000002";
const MAIN = "00000000-0000-4000-8000-0000000000c1";
const SIDE = "00000000-0000-4000-8000-0000000000c2";
const ROOM_A = "00000000-0000-4000-8000-0000000000a1";
const ROOM_B = "00000000-0000-4000-8000-0000000000a2";
const ROOM_S = "00000000-0000-4000-8000-0000000000a3";

const calendar = (
  overrides: Partial<BookingOptionCalendar> & { id: string },
): BookingOptionCalendar => ({
  name: "Calendar",
  isDefault: false,
  acceptsPerform: true,
  acceptsRent: false,
  acceptsUse: false,
  rentalRateCents: null,
  rentalRateCurrency: null,
  rentalRateVisible: false,
  spaces: [],
  ...overrides,
});

/** Main (default): PERFORM + RENT, two rooms. Side: USE only, one room. */
const CALENDARS: BookingOptionCalendar[] = [
  calendar({
    id: MAIN,
    name: "Main",
    isDefault: true,
    acceptsRent: true,
    spaces: [
      { id: ROOM_A, name: "Room A" },
      { id: ROOM_B, name: "Room B" },
    ],
  }),
  calendar({
    id: SIDE,
    name: "Side",
    acceptsPerform: false,
    acceptsUse: true,
    spaces: [{ id: ROOM_S, name: "Side room" }],
  }),
];

describe("deriveDefaultPlacement", () => {
  it("opens on PERFORM against the default calendar — and names no room", () => {
    expect(
      deriveDefaultPlacement({
        placeId: PLACE,
        calendars: CALENDARS,
        acceptsBookingRequests: true,
      }),
    ).toEqual<BuilderPlacement>({
      placeId: PLACE,
      bookingIntent: "PERFORM",
      calendarId: MAIN,
    });
  });

  it("falls to the first ROOM intent when nothing accepts PERFORM — still no room", () => {
    const useOnly = [CALENDARS[1]!];
    expect(
      deriveDefaultPlacement({
        placeId: PLACE,
        calendars: useOnly,
        acceptsBookingRequests: true,
      }),
    ).toEqual<BuilderPlacement>({
      placeId: PLACE,
      bookingIntent: "USE",
      calendarId: SIDE,
    });
  });

  it("is null when the venue opted out, has no calendars, or no calendar accepts anything", () => {
    expect(
      deriveDefaultPlacement({
        placeId: PLACE,
        calendars: CALENDARS,
        acceptsBookingRequests: false,
      }),
    ).toBeNull();
    // No calendars: the server cannot create a request without one, even
    // though `offeredIntents` still says PERFORM for the place page.
    expect(
      deriveDefaultPlacement({
        placeId: PLACE,
        calendars: [],
        acceptsBookingRequests: true,
      }),
    ).toBeNull();
    expect(
      deriveDefaultPlacement({
        placeId: PLACE,
        calendars: [calendar({ id: MAIN, acceptsPerform: false })],
        acceptsBookingRequests: true,
      }),
    ).toBeNull();
  });

  it("a RENT-only calendar with NO active room mints NOTHING (room gate restored 2026-09-23)", () => {
    // Reverses the 09-22 drop. A calendar with no active space is invalid
    // data, so the builder refuses to open a placement on it rather than
    // minting a request that could only ever land spaceless.
    expect(
      deriveDefaultPlacement({
        placeId: PLACE,
        calendars: [
          calendar({ id: MAIN, acceptsPerform: false, acceptsRent: true }),
        ],
        acceptsBookingRequests: true,
      }),
    ).toBeNull();
  });

  it("…and the same calendar WITH an active room mints the RENT placement", () => {
    expect(
      deriveDefaultPlacement({
        placeId: PLACE,
        calendars: [
          calendar({
            id: MAIN,
            acceptsPerform: false,
            acceptsRent: true,
            spaces: [{ id: ROOM_A, name: "Room A" }],
          }),
        ],
        acceptsBookingRequests: true,
      }),
    ).toEqual<BuilderPlacement>({
      placeId: PLACE,
      bookingIntent: "RENT",
      calendarId: MAIN,
    });
  });
});

describe("placementForIntent", () => {
  const start: BuilderPlacement = {
    placeId: PLACE,
    bookingIntent: "PERFORM",
    calendarId: MAIN,
  };

  it("RENT keeps a calendar that accepts it, and still names no room", () => {
    expect(placementForIntent(CALENDARS, start, "RENT")).toEqual({
      ...start,
      bookingIntent: "RENT",
    });
  });

  it("USE moves to the calendar that accepts it (Main does not)", () => {
    expect(placementForIntent(CALENDARS, start, "USE")).toEqual({
      ...start,
      bookingIntent: "USE",
      calendarId: SIDE,
    });
  });

  it("is a NO-OP for an intent NO calendar accepts", () => {
    const performOnly = [calendar({ id: MAIN, isDefault: true })];
    expect(placementForIntent(performOnly, start, "RENT")).toBe(start);
    // A RENT switch with ZERO active rooms is not an offer either — room gate
    // restored 2026-09-23, reversing the 09-22 drop.
    const rentNoRooms = [calendar({ id: MAIN, isDefault: true, acceptsRent: true })];
    expect(placementForIntent(rentNoRooms, start, "RENT")).toBe(start);
    // With a room, it routes.
    const rentWithRoom = [
      calendar({
        id: MAIN,
        isDefault: true,
        acceptsRent: true,
        spaces: [{ id: ROOM_A, name: "Room A" }],
      }),
    ];
    expect(placementForIntent(rentWithRoom, start, "RENT")).toEqual({
      ...start,
      bookingIntent: "RENT",
    });
  });

  it("back to PERFORM is just the intent — nothing else travels with it", () => {
    const rent: BuilderPlacement = { ...start, bookingIntent: "RENT" };
    expect(placementForIntent(CALENDARS, rent, "PERFORM")).toEqual(start);
  });
});

describe("placementForCalendar", () => {
  it("changes the calendar and nothing else — the placement carries no room", () => {
    const rentOnMain: BuilderPlacement = {
      placeId: PLACE,
      bookingIntent: "RENT",
      calendarId: MAIN,
    };
    expect(placementForCalendar(rentOnMain, SIDE)).toEqual({
      ...rentOnMain,
      calendarId: SIDE,
    });
  });
});

describe("placementIsComplete / intentIsOffered", () => {
  it("a calendar is all any intent needs — RENT and USE no longer name a room", () => {
    const base = { placeId: PLACE, calendarId: MAIN };
    expect(placementIsComplete({ ...base, bookingIntent: "PERFORM" })).toBe(
      true,
    );
    expect(placementIsComplete({ ...base, bookingIntent: "RENT" })).toBe(true);
    expect(placementIsComplete({ ...base, bookingIntent: "USE" })).toBe(true);
  });

  it("without a calendar there is nothing to route the request to", () => {
    expect(
      placementIsComplete({
        placeId: PLACE,
        bookingIntent: "RENT",
        calendarId: "",
      }),
    ).toBe(false);
  });

  it("an intent is offered when SOME calendar accepts it", () => {
    expect(intentIsOffered(CALENDARS, "PERFORM")).toBe(true);
    expect(intentIsOffered(CALENDARS, "RENT")).toBe(true);
    expect(intentIsOffered(CALENDARS, "USE")).toBe(true);
    expect(intentIsOffered([CALENDARS[0]!], "USE")).toBe(false);
  });

  it("the two ROOM intents also need an active room — a roomless calendar offers neither", () => {
    // Room gate restored 2026-09-23 (reverses the 09-22 drop): roomless
    // calendars are illegal to write, so the cascade fails closed on the
    // ones already in the wild.
    const noRooms = [
      calendar({ id: MAIN, acceptsRent: true, acceptsUse: true, spaces: [] }),
    ];
    expect(intentIsOffered(noRooms, "RENT")).toBe(false);
    expect(intentIsOffered(noRooms, "USE")).toBe(false);
    // PERFORM is ungated — a night on the bill needs no room.
    expect(intentIsOffered(noRooms, "PERFORM")).toBe(true);
    // A switch that is OFF still hides the intent even with rooms.
    expect(
      intentIsOffered([calendar({ id: MAIN, acceptsRent: false })], "RENT"),
    ).toBe(false);
  });
});

describe("resolveBuilderPlacement", () => {
  const placement: BuilderPlacement = {
    placeId: PLACE,
    bookingIntent: "RENT",
    calendarId: MAIN,
  };

  it("sends the calendar and the intent while the venue is the place the placement was minted for", () => {
    expect(
      resolveBuilderPlacement({
        locationMode: "place",
        location: { thPlaceId: PLACE },
        placement,
        dirty: true,
      }),
    ).toEqual({ calendarId: MAIN, bookingIntent: "RENT" });
  });

  it("never states a room — not a value, not null: the builder has no room control to state one from", () => {
    const payload = resolveBuilderPlacement({
      locationMode: "place",
      location: { thPlaceId: PLACE },
      placement: { ...placement, bookingIntent: "PERFORM" },
      dirty: true,
    });
    expect("spaceId" in payload).toBe(false);
  });

  it("DROPS the placement in address mode (switching modes must not carry a venue's rows)", () => {
    expect(
      resolveBuilderPlacement({
        locationMode: "address",
        location: { addressText: "123 Main St", lat: 36.16, lng: -86.78 },
        placement,
        dirty: true,
      }),
    ).toEqual({});
  });

  it("DROPS the placement when the venue was cleared", () => {
    expect(
      resolveBuilderPlacement({
        locationMode: "place",
        location: {},
        placement,
        dirty: true,
      }),
    ).toEqual({});
  });

  it("DROPS a placement minted for a DIFFERENT venue (cross-place isolation)", () => {
    expect(
      resolveBuilderPlacement({
        locationMode: "place",
        location: { thPlaceId: OTHER_PLACE },
        placement,
        dirty: true,
      }),
    ).toEqual({});
  });

  it("sends nothing for an owned or granted venue (no placement minted)", () => {
    expect(
      resolveBuilderPlacement({
        locationMode: "place",
        location: { thPlaceId: PLACE },
        placement: null,
        dirty: true,
      }),
    ).toEqual({});
  });

  it("sends NOTHING for a hydrated venue's seeded placement until it is dirty — the stored columns stay as they are", () => {
    expect(
      resolveBuilderPlacement({
        locationMode: "place",
        location: { thPlaceId: PLACE },
        placement,
        dirty: false,
      }),
    ).toEqual({});
  });
});

describe("nextIntentForKey — the radiogroup's key grammar", () => {
  const order = ["PERFORM", "RENT"] as const; // USE disabled → not in order

  it("arrows move through ENABLED intents only and wrap at both ends", () => {
    expect(nextIntentForKey("PERFORM", "ArrowRight", order)).toBe("RENT");
    expect(nextIntentForKey("RENT", "ArrowRight", order)).toBe("PERFORM");
    expect(nextIntentForKey("PERFORM", "ArrowLeft", order)).toBe("RENT");
    expect(nextIntentForKey("RENT", "ArrowDown", order)).toBe("PERFORM");
    expect(nextIntentForKey("PERFORM", "ArrowUp", order)).toBe("RENT");
  });

  it("Home / End jump to the ends", () => {
    expect(nextIntentForKey("RENT", "Home", order)).toBe("PERFORM");
    expect(nextIntentForKey("PERFORM", "End", order)).toBe("RENT");
  });

  it("returns null for keys it does not own — Tab must never be swallowed", () => {
    expect(nextIntentForKey("PERFORM", "Tab", order)).toBeNull();
    expect(nextIntentForKey("PERFORM", "Enter", order)).toBeNull();
    expect(nextIntentForKey("PERFORM", " ", order)).toBeNull();
  });

  it("with nothing selected (or a selection outside the enabled order) forward lands first, backward last", () => {
    expect(nextIntentForKey(undefined, "ArrowRight", order)).toBe("PERFORM");
    expect(nextIntentForKey(undefined, "ArrowLeft", order)).toBe("RENT");
    expect(nextIntentForKey("USE", "ArrowRight", order)).toBe("PERFORM");
    expect(nextIntentForKey("PERFORM", "ArrowRight", [])).toBeNull();
  });

  it("DOM ids are scoped by the group so two cascades on a page cannot collide", () => {
    expect(intentDomId("g1", "PERFORM")).toBe("g1-intent-perform");
    expect(intentDomId("g2", "PERFORM")).not.toBe(intentDomId("g1", "PERFORM"));
  });
});
