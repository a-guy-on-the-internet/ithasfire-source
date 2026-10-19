import { describe, expect, it, vi } from "vitest";

import {
  getPlaceBookingAvailability,
  type GetPlaceBookingAvailabilityDeps,
} from "../get-place-booking-availability";

const PLACE_ID = "00000000-0000-4000-8000-00000000d030";
const OTHER_PLACE_ID = "00000000-0000-4000-8000-00000000d031";

const MAIN_CALENDAR_ID = "11111111-1111-4111-8111-111111111111";
const CLUB_CALENDAR_ID = "22222222-2222-4222-8222-222222222222";
const FOREIGN_CALENDAR_ID = "33333333-3333-4333-8333-333333333333";

const STAGE_SPACE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BACK_BAR_SPACE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const TZ = "America/Chicago";
const NOW = new Date("2026-08-10T18:00:00.000Z"); // 1pm in Austin
const OWNER_ORG_ID = "22222222-2222-4222-8222-222222222222";
const OWNER_HUMAN_ID = "11111111-1111-4111-8111-111111111111";

type Row = {
  id: string;
  placeId: string;
  /** null = PLACE-WIDE row, applies to every calendar. */
  calendarId: string | null;
  dayOfWeek: number | null;
  date: Date | null;
  startTime: string | null;
  endTime: string | null;
  note: string | null;
  isOpen: boolean;
};

/** A recurring weekly opening window. Place-wide unless a calendar is named. */
const window = (
  dayOfWeek: number,
  startTime: string,
  endTime: string,
  calendarId: string | null = null,
): Row => ({
  id: `w-${calendarId ?? "all"}-${dayOfWeek}-${startTime}`,
  placeId: PLACE_ID,
  calendarId,
  dayOfWeek,
  date: null,
  startTime,
  endTime,
  note: null,
  isOpen: true,
});

const blackout = (isoDate: string, calendarId: string | null = null): Row => ({
  id: `b-${calendarId ?? "all"}-${isoDate}`,
  placeId: PLACE_ID,
  calendarId,
  dayOfWeek: null,
  // Stored as an instant; the use case buckets it into the venue's local date.
  date: new Date(`${isoDate}T05:00:00.000Z`),
  startTime: null,
  endTime: null,
  note: "private hire",
  isOpen: false,
});

/** A DATED row with isOpen:true — a per-date override the picker ignores. */
const datedOpen = (
  isoDate: string,
  startTime: string,
  endTime: string,
  calendarId: string | null = null,
): Row => ({
  id: `o-${isoDate}`,
  placeId: PLACE_ID,
  calendarId,
  dayOfWeek: null,
  date: new Date(`${isoDate}T05:00:00.000Z`),
  startTime,
  endTime,
  note: null,
  isOpen: true,
});

/**
 * One occupancy of a space. The use case reads OCCURRENCES, so a recurring
 * listing is expressed here the way the adapter emits it — several entries
 * sharing an `eventId`, one per night — rather than as a single event row.
 */
type Occurrence = {
  title: string;
  startsAt: string;
  endsAt?: string | null;
  /** Defaults to a per-entry id; set explicitly to model a recurring listing. */
  eventId?: string;
  /** Defaults to null = UNKNOWN placement, which blocks every space. */
  spaceId?: string | null;
};

type Calendar = {
  id: string;
  isDefault?: boolean;
  spaceIds?: string[];
};

const buildCalendarRow = (c: Calendar) => ({
  id: c.id,
  placeId: PLACE_ID,
  name: c.id,
  slug: c.id,
  description: null,
  isDefault: c.isDefault ?? false,
  defaultStartTime: null,
  defaultCategoryId: null,
  eventTemplate: null,
  createdAt: NOW,
  updatedAt: NOW,
  spaces: (c.spaceIds ?? []).map((id) => ({
    id,
    placeId: PLACE_ID,
    name: id,
    capacity: null,
    sortOrder: 0,
    status: "ACTIVE" as const,
    createdAt: NOW,
    updatedAt: NOW,
  })),
});

/**
 * The occurrence lister the adapter provides, faked faithfully — INCLUDING the
 * `spaceIds` filter semantics, because the null-space rule is enforced there
 * and a fake that ignored the filter would make the interesting tests vacuous.
 *
 * PAIRED GUARD: this HAND-COPIES the adapter's rule (keep `spaceId IN (…)`,
 * always keep `spaceId IS NULL`). If the adapter's WHERE clause regressed,
 * every test in this file would stay green against the stale copy. The rule's
 * real guards live in
 *   · packages/adapters/src/db/prisma/__tests__/events-published-occurrences-by-place.test.ts
 *     (the `where` shape), and
 *   · packages/adapters/test/integration/venue-hierarchy.test.ts
 *     ("narrows to the named spaces AND always keeps null-space events" — rows
 *     from real Postgres).
 * Change the rule in one place and you must change it in all three.
 */
const applySpaceFilter = (
  occurrences: Occurrence[],
  spaceIds: string[] | undefined,
) =>
  spaceIds === undefined
    ? occurrences
    : occurrences.filter(
        (o) =>
          (o.spaceId ?? null) === null || spaceIds.includes(o.spaceId as string),
      );

type BuildOptions = {
  calendars?: Calendar[];
  events?: Occurrence[];
  /** `Place.acceptsCommunityListings` on the place row this read loads. */
  acceptsCommunityListings?: boolean;
};

const buildDeps = (
  rows: Row[],
  options: BuildOptions = {},
): GetPlaceBookingAvailabilityDeps & {
  listOccurrences: ReturnType<typeof vi.fn>;
} => {
  const events = options.events ?? [];
  const listOccurrences = vi.fn(
    async (input: { spaceIds?: string[] }) =>
      applySpaceFilter(events, input.spaceIds).map((e, i) => ({
        eventId: e.eventId ?? `e${i}`,
        eventDateId: e.eventId ? `d${i}` : null,
        title: e.title,
        startsAt: new Date(e.startsAt),
        endsAt:
          e.endsAt === undefined ? null : e.endsAt ? new Date(e.endsAt) : null,
        spaceId: e.spaceId ?? null,
      })),
  );

  return {
    repos: {
      calendars: {
        listByPlace: vi.fn(async (placeId: string) =>
          placeId === PLACE_ID
            ? (options.calendars ?? []).map(buildCalendarRow)
            : [],
        ),
        listAvailabilityForPlace: vi.fn(async () => rows),
      },
      events: { listPublishedOccurrencesByPlace: listOccurrences },
      // Venue-confirmation spec: the occupancy read is narrowed to confirmed
      // events via the place's owner ids (see the "venue confirmation" suite).
      places: {
        getById: vi.fn(async (id: string) =>
          id === PLACE_ID
            ? {
                id,
                orgIdsWithAccess: [OWNER_ORG_ID],
                humanIdsWithAccess: [OWNER_HUMAN_ID],
                acceptsCommunityListings:
                  options.acceptsCommunityListings ?? false,
              }
            : null,
        ),
      },
    } as unknown as GetPlaceBookingAvailabilityDeps["repos"],
    now: () => NOW,
    listOccurrences,
  };
};

/** The common shape: one default calendar owning the main stage. */
const DEFAULT_CALENDARS: Calendar[] = [
  { id: MAIN_CALENDAR_ID, isDefault: true, spaceIds: [STAGE_SPACE_ID] },
];

const dayFor = (out: { days: Array<{ date: string }> }, date: string) =>
  out.days.find((d) => d.date === date)!;

describe("getPlaceBookingAvailability", () => {
  it("marks a weekday with no rows as closed", async () => {
    // Tue/Thu open, Monday has no rows at all.
    const out = await getPlaceBookingAvailability(
      buildDeps([window(2, "18:00", "23:00")]),
      { placeId: PLACE_ID, from: "2026-08-17", days: 3, timezone: TZ },
    );

    expect(dayFor(out, "2026-08-17").status).toBe("closed"); // Monday
    expect(dayFor(out, "2026-08-18").status).toBe("free"); // Tuesday
    expect(dayFor(out, "2026-08-17").slots).toEqual([]);
  });

  it("keeps both windows on a day that opens twice", async () => {
    const out = await getPlaceBookingAvailability(
      buildDeps([window(0, "14:00", "17:00"), window(0, "19:00", "22:00")]),
      { placeId: PLACE_ID, from: "2026-08-16", days: 1, timezone: TZ },
    );

    const sunday = dayFor(out, "2026-08-16");
    expect(sunday.windows).toHaveLength(2);
    // Two separate runs of start times, not one contiguous block.
    expect(sunday.slots).toContain(14 * 60);
    expect(sunday.slots).toContain(19 * 60);
    expect(sunday.slots).not.toContain(17 * 60);
  });

  it("leaves the evening bookable when only the matinee is taken", async () => {
    const out = await getPlaceBookingAvailability(
      buildDeps([window(5, "14:00", "17:00"), window(5, "18:00", "02:00")], {
        // 2:00pm–4:30pm CDT on Friday 14 Aug.
        events: [
          {
            title: "Sunset Boulevard",
            startsAt: "2026-08-14T19:00:00.000Z",
            endsAt: "2026-08-14T21:30:00.000Z",
          },
        ],
      }),
      { placeId: PLACE_ID, from: "2026-08-14", days: 1, timezone: TZ },
    );

    const friday = dayFor(out, "2026-08-14");
    expect(friday.status).toBe("partial");
    expect(friday.free).toEqual([{ start: 18 * 60, end: 26 * 60 }]);
    expect(friday.bookings[0]).toMatchObject({
      title: "Sunset Boulevard",
      start: 14 * 60,
      end: 16 * 60 + 30,
      assumedEnd: false,
    });
  });

  it("puts a show that starts at 9pm on the right LOCAL night", async () => {
    // 02:00Z on the 23rd is 9pm on the 22nd in Austin. Bucketing by the UTC
    // date would block the wrong night.
    const out = await getPlaceBookingAvailability(
      buildDeps([window(6, "18:00", "02:00"), window(0, "18:00", "23:00")], {
        events: [
          {
            title: "Late set",
            startsAt: "2026-08-23T02:00:00.000Z",
            endsAt: "2026-08-23T04:00:00.000Z",
          },
        ],
      }),
      { placeId: PLACE_ID, from: "2026-08-22", days: 2, timezone: TZ },
    );

    expect(dayFor(out, "2026-08-22").bookings).toHaveLength(1);
    expect(dayFor(out, "2026-08-23").bookings).toHaveLength(0);
  });

  it("blocks an unknown end time through to close and flags the assumption", async () => {
    const out = await getPlaceBookingAvailability(
      buildDeps([window(5, "18:00", "23:00")], {
        events: [
          {
            title: "Open-ended",
            startsAt: "2026-08-15T02:00:00.000Z",
            endsAt: null,
          },
        ],
      }),
      { placeId: PLACE_ID, from: "2026-08-14", days: 1, timezone: TZ },
    );

    const friday = dayFor(out, "2026-08-14");
    expect(friday.bookings[0]).toMatchObject({ assumedEnd: true, end: null });
    // 9pm start, buffered back an hour, so only 6–8pm survives.
    expect(friday.free).toEqual([{ start: 18 * 60, end: 20 * 60 }]);
  });

  it("treats a dated isOpen:false row as a blackout for that local date", async () => {
    const out = await getPlaceBookingAvailability(
      buildDeps([window(2, "18:00", "23:00"), blackout("2026-08-18")]),
      { placeId: PLACE_ID, from: "2026-08-18", days: 8, timezone: TZ },
    );

    expect(dayFor(out, "2026-08-18").status).toBe("blackout");
    // A blackout must also empty the bookable fields, not just set a status:
    // a client rendering `slots` without re-reading `status` would otherwise
    // offer times on a night the venue has shut.
    expect(dayFor(out, "2026-08-18").slots).toEqual([]);
    expect(dayFor(out, "2026-08-18").windows).toEqual([]);
    expect(dayFor(out, "2026-08-18").free).toEqual([]);
    // The following Tuesday is untouched.
    expect(dayFor(out, "2026-08-25").status).toBe("free");
  });

  it("still IGNORES a dated isOpen:true row", async () => {
    // Preserved behaviour, deliberately: a dated OPEN row is a per-date
    // override the picker does not model. Honouring it would silently WIDEN
    // availability past the venue's weekly hours on the strength of a shape
    // the editor never promised to mean that. Monday is dark, and a dated open
    // row on a Monday must not open it.
    const out = await getPlaceBookingAvailability(
      buildDeps([
        window(2, "18:00", "23:00"),
        datedOpen("2026-08-17", "18:00", "23:00"),
      ]),
      { placeId: PLACE_ID, from: "2026-08-17", days: 2, timezone: TZ },
    );

    expect(dayFor(out, "2026-08-17").status).toBe("closed");
    expect(dayFor(out, "2026-08-17").windows).toEqual([]);
    expect(dayFor(out, "2026-08-17").slots).toEqual([]);
  });

  it("never leaks the blackout note", async () => {
    const out = await getPlaceBookingAvailability(
      buildDeps([window(2, "18:00", "23:00"), blackout("2026-08-18")]),
      { placeId: PLACE_ID, from: "2026-08-18", days: 1, timezone: TZ },
    );

    expect(JSON.stringify(out)).not.toContain("private hire");
  });

  it("marks dates before today as past", async () => {
    const out = await getPlaceBookingAvailability(
      buildDeps([window(1, "18:00", "23:00"), window(2, "18:00", "23:00")]),
      { placeId: PLACE_ID, from: "2026-08-03", days: 10, timezone: TZ },
    );

    expect(dayFor(out, "2026-08-03").status).toBe("past");
    expect(dayFor(out, "2026-08-03").slots).toEqual([]);
    expect(dayFor(out, "2026-08-04").status).toBe("past");
    // "Today" itself is not past — and Monday 10 Aug has a window here.
    expect(dayFor(out, "2026-08-10").status).toBe("free");
    expect(dayFor(out, "2026-08-11").status).toBe("free");
  });

  it("falls back to the platform timezone when none is given", async () => {
    const out = await getPlaceBookingAvailability(
      buildDeps([window(2, "18:00", "23:00")]),
      { placeId: PLACE_ID, from: "2026-08-18", days: 1 },
    );
    expect(out.timezone).toBe("America/Chicago");
  });

  it("takes the space on EVERY night of a recurring residency", async () => {
    // The bug this pins: availability used to read events, and a recurring
    // listing is ONE event row pinned to its first upcoming date. Three
    // Tuesdays of the same residency arrive as three occurrences sharing an
    // eventId; all three nights must be taken, not just the pinned one.
    // 6pm–11pm CDT on each local Tuesday (the window closes at 23:00, so the
    // night is fully consumed). The UTC end lands on the following date.
    const residency = (night: string, nextDay: string) => ({
      eventId: "residency-1",
      title: "Tuesday Night Residency",
      startsAt: `${night}T23:00:00.000Z`,
      endsAt: `${nextDay}T04:00:00.000Z`,
    });

    const out = await getPlaceBookingAvailability(
      buildDeps([window(2, "18:00", "23:00")], {
        events: [
          residency("2026-08-18", "2026-08-19"),
          residency("2026-08-25", "2026-08-26"),
          residency("2026-09-01", "2026-09-02"),
        ],
      }),
      { placeId: PLACE_ID, from: "2026-08-18", days: 22, timezone: TZ },
    );

    for (const date of ["2026-08-18", "2026-08-25", "2026-09-01"]) {
      const day = dayFor(out, date);
      expect(day.status).toBe("full");
      expect(day.slots).toEqual([]);
      expect(day.bookings.map((b) => b.title)).toEqual([
        "Tuesday Night Residency",
      ]);
    }
  });

  it("reports a residency night ONCE, not twice", async () => {
    // The pinned `Event.startsAt` mirrors one of the expanded rows. If the
    // adapter emitted both, the performer would see the same show listed
    // twice on that night — the reason the fallback is conditional on the
    // event having no rows in range.
    const out = await getPlaceBookingAvailability(
      buildDeps([window(2, "18:00", "23:00")], {
        events: [
          {
            eventId: "residency-1",
            title: "Tuesday Night Residency",
            startsAt: "2026-08-18T23:00:00.000Z",
            endsAt: "2026-08-19T04:00:00.000Z",
          },
        ],
      }),
      { placeId: PLACE_ID, from: "2026-08-18", days: 1, timezone: TZ },
    );

    expect(dayFor(out, "2026-08-18").bookings).toHaveLength(1);
  });

  it("leaves a CANCELLED night free (the adapter never emits it)", async () => {
    // Called-off nights are excluded in the occurrence query, so they arrive
    // as an absence. Pinned from this side because the day must come back
    // fully bookable, not merely un-booked.
    const out = await getPlaceBookingAvailability(
      buildDeps([window(2, "18:00", "23:00")], { events: [] }),
      { placeId: PLACE_ID, from: "2026-08-18", days: 1, timezone: TZ },
    );

    expect(dayFor(out, "2026-08-18").status).toBe("free");
    expect(dayFor(out, "2026-08-18").bookings).toEqual([]);
    expect(dayFor(out, "2026-08-18").slots.length).toBeGreaterThan(0);
  });

  it("caps the window so a caller cannot ask for a year", async () => {
    await expect(
      getPlaceBookingAvailability(buildDeps([]), {
        placeId: PLACE_ID,
        from: "2026-08-18",
        days: 400,
      }),
    ).rejects.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Calendar scope (venue-hierarchy FR-005/FR-007)
// ─────────────────────────────────────────────────────────────────────────────

describe("getPlaceBookingAvailability — calendar rules scope", () => {
  const TWO_CALENDARS: Calendar[] = [
    { id: MAIN_CALENDAR_ID, isDefault: true, spaceIds: [STAGE_SPACE_ID] },
    { id: CLUB_CALENDAR_ID, spaceIds: [BACK_BAR_SPACE_ID] },
  ];

  it("honours PLACE-WIDE rows and the selected calendar's own rows", async () => {
    // Tuesday is place-wide (the building is open); Wednesday belongs to the
    // Social Club only. Asking as the Social Club must get BOTH.
    const out = await getPlaceBookingAvailability(
      buildDeps(
        [
          window(2, "18:00", "23:00"), // place-wide
          window(3, "19:00", "23:00", CLUB_CALENDAR_ID),
        ],
        { calendars: TWO_CALENDARS },
      ),
      {
        placeId: PLACE_ID,
        from: "2026-08-18",
        days: 2,
        timezone: TZ,
        calendarId: CLUB_CALENDAR_ID,
      },
    );

    expect(dayFor(out, "2026-08-18").status).toBe("free"); // place-wide Tuesday
    expect(dayFor(out, "2026-08-19").windows).toEqual([
      { start: 19 * 60, end: 23 * 60 },
    ]);
  });

  it("IGNORES another calendar's rows", async () => {
    // The main stage opens Wednesday; the Social Club does not. Asking as the
    // Social Club must not inherit the main stage's hours.
    const out = await getPlaceBookingAvailability(
      buildDeps([window(3, "19:00", "23:00", MAIN_CALENDAR_ID)], {
        calendars: TWO_CALENDARS,
      }),
      {
        placeId: PLACE_ID,
        from: "2026-08-19",
        days: 1,
        timezone: TZ,
        calendarId: CLUB_CALENDAR_ID,
      },
    );

    expect(dayFor(out, "2026-08-19").status).toBe("closed");
    expect(dayFor(out, "2026-08-19").windows).toEqual([]);
  });

  it("applies a PLACE-WIDE blackout to every calendar", async () => {
    // The whole venue is shut for a private hire — one row, not N copies.
    const out = await getPlaceBookingAvailability(
      buildDeps([window(2, "18:00", "23:00"), blackout("2026-08-18")], {
        calendars: TWO_CALENDARS,
      }),
      {
        placeId: PLACE_ID,
        from: "2026-08-18",
        days: 1,
        timezone: TZ,
        calendarId: CLUB_CALENDAR_ID,
      },
    );

    expect(dayFor(out, "2026-08-18").status).toBe("blackout");
  });

  it("keeps ANOTHER calendar's blackout off this calendar's dates", async () => {
    const out = await getPlaceBookingAvailability(
      buildDeps(
        [
          window(2, "18:00", "23:00"),
          blackout("2026-08-18", MAIN_CALENDAR_ID),
        ],
        { calendars: TWO_CALENDARS },
      ),
      {
        placeId: PLACE_ID,
        from: "2026-08-18",
        days: 1,
        timezone: TZ,
        calendarId: CLUB_CALENDAR_ID,
      },
    );

    expect(dayFor(out, "2026-08-18").status).toBe("free");
  });

  it("resolves the DEFAULT calendar when calendarId is omitted", async () => {
    // The main stage's own Wednesday window must apply without being named,
    // and the Social Club's must not.
    const out = await getPlaceBookingAvailability(
      buildDeps(
        [
          window(3, "19:00", "23:00", MAIN_CALENDAR_ID),
          window(4, "19:00", "23:00", CLUB_CALENDAR_ID),
        ],
        { calendars: TWO_CALENDARS },
      ),
      { placeId: PLACE_ID, from: "2026-08-19", days: 2, timezone: TZ },
    );

    expect(out.calendarId).toBe(MAIN_CALENDAR_ID);
    expect(dayFor(out, "2026-08-19").status).toBe("free"); // main stage's Wed
    expect(dayFor(out, "2026-08-20").status).toBe("closed"); // club's Thu
  });

  it("echoes the resolved calendarId back to the client", async () => {
    const out = await getPlaceBookingAvailability(
      buildDeps([], { calendars: TWO_CALENDARS }),
      {
        placeId: PLACE_ID,
        from: "2026-08-18",
        days: 1,
        timezone: TZ,
        calendarId: CLUB_CALENDAR_ID,
      },
    );

    expect(out.calendarId).toBe(CLUB_CALENDAR_ID);
  });

  it("falls back to PLACE-WIDE rules only when the place has no calendars", async () => {
    // Public read — a place whose hierarchy was never set up must still answer,
    // not throw. Place-wide rows apply; per-calendar rows have no calendar to
    // belong to and are dropped.
    const deps = buildDeps(
      [
        window(2, "18:00", "23:00"),
        window(3, "19:00", "23:00", MAIN_CALENDAR_ID),
      ],
      { calendars: [] },
    );

    const out = await getPlaceBookingAvailability(deps, {
      placeId: PLACE_ID,
      from: "2026-08-18",
      days: 2,
      timezone: TZ,
    });

    expect(out.calendarId).toBeNull();
    expect(dayFor(out, "2026-08-18").status).toBe("free");
    expect(dayFor(out, "2026-08-19").status).toBe("closed");
  });

  it("falls back to place-wide rules when the place has calendars but no default", async () => {
    const out = await getPlaceBookingAvailability(
      buildDeps([window(2, "18:00", "23:00")], {
        calendars: [{ id: CLUB_CALENDAR_ID, spaceIds: [BACK_BAR_SPACE_ID] }],
      }),
      { placeId: PLACE_ID, from: "2026-08-18", days: 1, timezone: TZ },
    );

    expect(out.calendarId).toBeNull();
    expect(dayFor(out, "2026-08-18").status).toBe("free");
  });
});

describe("getPlaceBookingAvailability — cross-place isolation", () => {
  it("treats a calendarId from ANOTHER place as not-found", async () => {
    // SECURITY: this is a publicProcedure and `calendarId` is client-supplied.
    // Resolution goes through the PLACE'S OWN calendar list, so a foreign id
    // cannot be confirmed to exist — a probe learns nothing about another
    // venue's calendars.
    const deps = buildDeps([window(2, "18:00", "23:00")], {
      calendars: DEFAULT_CALENDARS,
    });

    await expect(
      getPlaceBookingAvailability(deps, {
        placeId: PLACE_ID,
        from: "2026-08-18",
        days: 1,
        timezone: TZ,
        calendarId: FOREIGN_CALENDAR_ID,
      }),
    ).rejects.toMatchObject({ code: "CALENDAR_NOT_FOUND" });

    // And nothing about the other place's diary was read on the way out.
    expect(deps.listOccurrences).not.toHaveBeenCalled();
  });

  it("gives an unknown calendarId the SAME error as a cross-place one", async () => {
    const deps = buildDeps([], { calendars: DEFAULT_CALENDARS });

    await expect(
      getPlaceBookingAvailability(deps, {
        placeId: PLACE_ID,
        from: "2026-08-18",
        days: 1,
        timezone: TZ,
        calendarId: "44444444-4444-4444-8444-444444444444",
      }),
    ).rejects.toMatchObject({ code: "CALENDAR_NOT_FOUND" });
  });

  it("never reads another place's calendars", async () => {
    const deps = buildDeps([], { calendars: DEFAULT_CALENDARS });

    await getPlaceBookingAvailability(deps, {
      placeId: PLACE_ID,
      from: "2026-08-18",
      days: 1,
      timezone: TZ,
    });

    expect(deps.repos.calendars.listByPlace).toHaveBeenCalledWith(PLACE_ID);
    expect(deps.repos.calendars.listByPlace).not.toHaveBeenCalledWith(
      OTHER_PLACE_ID,
    );
  });
});

describe("getPlaceBookingAvailability — multi-space occupancy", () => {
  const TWO_CALENDARS: Calendar[] = [
    { id: MAIN_CALENDAR_ID, isDefault: true, spaceIds: [STAGE_SPACE_ID] },
    { id: CLUB_CALENDAR_ID, spaceIds: [BACK_BAR_SPACE_ID] },
  ];

  it("REGRESSION: a show in the back bar does not block the main stage", async () => {
    // THE HEADLINE BUG. Occupancy used to be computed place-wide, so a single
    // 40-cap back-bar gig marked an entire multi-space venue busy and the main
    // stage could not be requested for that night at all.
    const deps = buildDeps([window(2, "18:00", "23:00")], {
      calendars: TWO_CALENDARS,
      events: [
        {
          title: "Back Bar DJ",
          startsAt: "2026-08-18T23:00:00.000Z",
          endsAt: "2026-08-19T04:00:00.000Z",
          spaceId: BACK_BAR_SPACE_ID,
        },
      ],
    });

    const out = await getPlaceBookingAvailability(deps, {
      placeId: PLACE_ID,
      from: "2026-08-18",
      days: 1,
      timezone: TZ,
      calendarId: MAIN_CALENDAR_ID,
    });

    const tuesday = dayFor(out, "2026-08-18");
    expect(tuesday.status).toBe("free");
    expect(tuesday.bookings).toEqual([]);
    expect(tuesday.slots.length).toBeGreaterThan(0);
    // The narrowing happened in the QUERY, not by post-filtering — the repo
    // must never hand back another space's diary to a public caller.
    expect(deps.listOccurrences).toHaveBeenCalledWith(
      expect.objectContaining({ spaceIds: [STAGE_SPACE_ID] }),
    );
  });

  it("still blocks the calendar that OWNS the busy space", async () => {
    // The mirror of the regression above: narrowing must not free the night
    // for everyone.
    const out = await getPlaceBookingAvailability(
      buildDeps([window(2, "18:00", "23:00")], {
        calendars: TWO_CALENDARS,
        events: [
          {
            title: "Back Bar DJ",
            startsAt: "2026-08-18T23:00:00.000Z",
            endsAt: "2026-08-19T04:00:00.000Z",
            spaceId: BACK_BAR_SPACE_ID,
          },
        ],
      }),
      {
        placeId: PLACE_ID,
        from: "2026-08-18",
        days: 1,
        timezone: TZ,
        calendarId: CLUB_CALENDAR_ID,
      },
    );

    const tuesday = dayFor(out, "2026-08-18");
    expect(tuesday.status).toBe("full");
    expect(tuesday.bookings.map((b) => b.title)).toEqual(["Back Bar DJ"]);
  });

  it("NULL-SPACE RULE: an event with no space blocks EVERY calendar", async () => {
    // Unknown placement, not absent placement — pre-hierarchy events carry no
    // spaceId at all. Under-blocking would oversell a room that is in fact
    // taken; over-blocking only hides a slot a human can still grant by hand.
    for (const calendarId of [MAIN_CALENDAR_ID, CLUB_CALENDAR_ID]) {
      const out = await getPlaceBookingAvailability(
        buildDeps([window(2, "18:00", "23:00")], {
          calendars: TWO_CALENDARS,
          events: [
            {
              title: "Legacy show",
              startsAt: "2026-08-18T23:00:00.000Z",
              endsAt: "2026-08-19T04:00:00.000Z",
              spaceId: null,
            },
          ],
        }),
        {
          placeId: PLACE_ID,
          from: "2026-08-18",
          days: 1,
          timezone: TZ,
          calendarId,
        },
      );

      expect(dayFor(out, "2026-08-18").status).toBe("full");
      expect(dayFor(out, "2026-08-18").bookings.map((b) => b.title)).toEqual([
        "Legacy show",
      ]);
    }
  });

  it("blocks a calendar joined to the busy space when spaces are SHARED", async () => {
    // A space can serve many calendars. Both must see the night as taken.
    const shared: Calendar[] = [
      { id: MAIN_CALENDAR_ID, isDefault: true, spaceIds: [STAGE_SPACE_ID] },
      { id: CLUB_CALENDAR_ID, spaceIds: [STAGE_SPACE_ID, BACK_BAR_SPACE_ID] },
    ];

    const out = await getPlaceBookingAvailability(
      buildDeps([window(2, "18:00", "23:00")], {
        calendars: shared,
        events: [
          {
            title: "Main Stage Headliner",
            startsAt: "2026-08-18T23:00:00.000Z",
            endsAt: "2026-08-19T04:00:00.000Z",
            spaceId: STAGE_SPACE_ID,
          },
        ],
      }),
      {
        placeId: PLACE_ID,
        from: "2026-08-18",
        days: 1,
        timezone: TZ,
        calendarId: CLUB_CALENDAR_ID,
      },
    );

    expect(dayFor(out, "2026-08-18").status).toBe("full");
  });

  it("does NOT narrow when the place has no calendars — the whole diary blocks", async () => {
    // Placement is unknowable, so the conservative direction is to block. The
    // filter key must be OMITTED, never `[]`: an empty array would mean "only
    // null-space events count" and would free rooms that are actually taken.
    const deps = buildDeps([window(2, "18:00", "23:00")], {
      calendars: [],
      events: [
        {
          title: "Back Bar DJ",
          startsAt: "2026-08-18T23:00:00.000Z",
          endsAt: "2026-08-19T04:00:00.000Z",
          spaceId: BACK_BAR_SPACE_ID,
        },
      ],
    });

    const out = await getPlaceBookingAvailability(deps, {
      placeId: PLACE_ID,
      from: "2026-08-18",
      days: 1,
      timezone: TZ,
    });

    expect(dayFor(out, "2026-08-18").status).toBe("full");
    expect(deps.listOccurrences.mock.calls[0]![0]).not.toHaveProperty(
      "spaceIds",
    );
  });

  it("does NOT narrow for a calendar with NO spaces joined", async () => {
    // Same reasoning one level down: a calendar with no physical resource has
    // unknowable placement, so it inherits the whole place's occupancy rather
    // than declaring itself wide open.
    const deps = buildDeps([window(2, "18:00", "23:00")], {
      calendars: [{ id: MAIN_CALENDAR_ID, isDefault: true, spaceIds: [] }],
      events: [
        {
          title: "Back Bar DJ",
          startsAt: "2026-08-18T23:00:00.000Z",
          endsAt: "2026-08-19T04:00:00.000Z",
          spaceId: BACK_BAR_SPACE_ID,
        },
      ],
    });

    const out = await getPlaceBookingAvailability(deps, {
      placeId: PLACE_ID,
      from: "2026-08-18",
      days: 1,
      timezone: TZ,
    });

    expect(out.calendarId).toBe(MAIN_CALENDAR_ID);
    expect(dayFor(out, "2026-08-18").status).toBe("full");
    expect(deps.listOccurrences.mock.calls[0]![0]).not.toHaveProperty(
      "spaceIds",
    );
  });

  // ── KNOWN-BLOCKING: two spaces on ONE calendar ────────────────────────────

  it("KNOWN-BLOCKING: two spaces on ONE calendar still block each other", async () => {
    // NOT a bug, and NOT what the regression above fixes — documented here so
    // the next reader does not mistake "occupancy is space-aware" for "the
    // picker answers per space".
    //
    // The unit of the answer is the CALENDAR. A calendar's spaces are ORed
    // flat: the day is busy if ANY of them is taken, because `windows` /
    // `free` / `slots` / `takenRatio` are one set per day, not one per space.
    // A per-space answer needs a per-space dimension in that model.
    //
    // This matters because it is the DEFAULT shape: `upsert-place` mints one
    // Main Calendar joined to one Main Space, and an owner who later adds a
    // "Back Bar" and ticks it onto the same calendar lands exactly here. The
    // product's answer is "make a calendar per space" — which is the case the
    // regression test above covers.
    const out = await getPlaceBookingAvailability(
      buildDeps([window(2, "18:00", "23:00")], {
        calendars: [
          {
            id: MAIN_CALENDAR_ID,
            isDefault: true,
            spaceIds: [STAGE_SPACE_ID, BACK_BAR_SPACE_ID],
          },
        ],
        events: [
          {
            title: "Back Bar DJ",
            startsAt: "2026-08-18T23:00:00.000Z",
            endsAt: "2026-08-19T04:00:00.000Z",
            spaceId: BACK_BAR_SPACE_ID,
          },
        ],
      }),
      { placeId: PLACE_ID, from: "2026-08-18", days: 1, timezone: TZ },
    );

    // The main stage is empty that night, and the picker still says full.
    // Change this expectation only alongside a real per-space model.
    expect(dayFor(out, "2026-08-18").status).toBe("full");
    expect(dayFor(out, "2026-08-18").bookings.map((b) => b.title)).toEqual([
      "Back Bar DJ",
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Venue confirmation (docs/specs/2026-08-27): only venue-confirmed events
// occupy. The rule lives in SQL (`venueConfirmedFor`) so it is pinned here as
// the argument that reaches the repo, built from the place's owner ids.
// ─────────────────────────────────────────────────────────────────────────────

describe("venue confirmation — occupancy is confirmed-only", () => {
  it("passes venueConfirmedFor (the place's owner ids) to listPublishedOccurrencesByPlace", async () => {
    const deps = buildDeps([window(1, "18:00", "23:00")], { calendars: DEFAULT_CALENDARS });
    await getPlaceBookingAvailability(deps, { placeId: PLACE_ID, from: "2026-08-10", days: 7, timezone: TZ });
    expect(deps.listOccurrences).toHaveBeenCalledTimes(1);
    expect(deps.listOccurrences).toHaveBeenCalledWith(
      expect.objectContaining({
        placeId: PLACE_ID,
        venueConfirmedFor: {
          orgIds: [OWNER_ORG_ID],
          humanIds: [OWNER_HUMAN_ID],
          acceptsCommunityListings: false,
        },
      }),
    );
  });

  // ── ACCEPTED COMMUNITY LISTINGS BLOCK THEIR SLOT ────────────────────────
  // community-listings-at-claimed-venues, ruling `blocking_is_intended`, and
  // the user's own words: "if it blocks that time it will block that time."
  //
  // This is asserted POSITIVELY and on purpose. Confirmation drives display,
  // availability and conflict detection through ONE predicate; the new arm was
  // deliberately NOT scoped to display-only, so accepting a weekly open mic
  // makes that night unavailable for booking requests. If a future change
  // makes this test fail, the change is wrong unless the ruling changed.

  it("carries the place's community consent into the occupancy read", async () => {
    const deps = buildDeps([window(1, "18:00", "23:00")], {
      calendars: DEFAULT_CALENDARS,
      acceptsCommunityListings: true,
    });
    await getPlaceBookingAvailability(deps, {
      placeId: PLACE_ID,
      from: "2026-08-10",
      days: 7,
      timezone: TZ,
    });
    expect(deps.listOccurrences).toHaveBeenCalledWith(
      expect.objectContaining({
        venueConfirmedFor: {
          orgIds: [OWNER_ORG_ID],
          humanIds: [OWNER_HUMAN_ID],
          // The arm that lets an OWNERLESS community listing occupy the room.
          acceptsCommunityListings: true,
        },
      }),
    );
  });

  it("an accepted community listing OCCUPIES its slot — the night reads full", async () => {
    // 2026-08-17 is a Monday; the venue is open 18:00–23:00 that night.
    const out = await getPlaceBookingAvailability(
      buildDeps([window(1, "18:00", "23:00")], {
        calendars: DEFAULT_CALENDARS,
        acceptsCommunityListings: true,
        // The repo returns it BECAUSE the filter above admitted it: an
        // ownerless COMMUNITY open mic, no stamp, no owner arm.
        events: [
          {
            title: "Monday Open Mic",
            startsAt: "2026-08-17T23:00:00.000Z",
            endsAt: "2026-08-18T04:00:00.000Z",
            eventId: "open-mic",
          },
        ],
      }),
      { placeId: PLACE_ID, from: "2026-08-17", days: 1, timezone: TZ },
    );

    expect(dayFor(out, "2026-08-17").status).toBe("full");
    expect(dayFor(out, "2026-08-17").bookings.map((b) => b.title)).toEqual([
      "Monday Open Mic",
    ]);
  });

  it("with consent OFF the same night is bookable — the repo is never asked for it", async () => {
    // The mirror image, so the test above cannot pass for the wrong reason:
    // the flag off means the SQL filter drops the listing, so the fake returns
    // nothing and the night is open. (The filter itself is pinned in the
    // adapter parity test; here we pin the CONSEQUENCE.)
    const out = await getPlaceBookingAvailability(
      buildDeps([window(1, "18:00", "23:00")], {
        calendars: DEFAULT_CALENDARS,
        acceptsCommunityListings: false,
        events: [],
      }),
      { placeId: PLACE_ID, from: "2026-08-17", days: 1, timezone: TZ },
    );
    expect(dayFor(out, "2026-08-17").status).not.toBe("full");
    expect(dayFor(out, "2026-08-17").bookings).toEqual([]);
  });

  it("PLACE_NOT_FOUND when the place row is gone — the occupancy read never runs unfiltered", async () => {
    const deps = buildDeps([], { calendars: [] });
    await expect(
      getPlaceBookingAvailability(deps, { placeId: OTHER_PLACE_ID, from: "2026-08-10", days: 7, timezone: TZ }),
    ).rejects.toMatchObject({ code: "PLACE_NOT_FOUND" });
    expect(deps.listOccurrences).not.toHaveBeenCalled();
  });
});
