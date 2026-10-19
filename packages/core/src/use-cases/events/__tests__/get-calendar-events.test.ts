import { describe, expect, it, vi } from "vitest";

import type { EventRecord } from "@th/ports/repos/events";
import type { PlaceRecord } from "@th/ports/repos/places";
import { createFakeCalendarsRepo, createFakeSpacesRepo } from "@th/test-utils/fakes/venue-hierarchy";
import { makeImageModerationGateFake } from "@th/test-utils/fakes/image-moderation";
import { createFakeBookingHoldsRepo } from "../../booking-holds/__tests__/fakes";

import {
  getCalendarEvents,
  type GetCalendarEventsAdminOutput,
  type GetCalendarEventsDeps,
  type GetCalendarEventsPublicOutput,
} from "../get-calendar-events";
import { detectConflicts, getVenueCalendar } from "../get-venue-calendar";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures — one place, ONE shared space, TWO calendars ("Social Club" and
// "Live Music"), one PUBLISHED event on each. This is the spec's space-bleed
// fixture: rendering must key on Event.calendarId; conflicts on spaceId.
// ─────────────────────────────────────────────────────────────────────────────

const PLACE_ID = "aaaaaaaa-1111-4111-a111-aaaaaaaaaaaa";
const OWNER_ID = "cccccccc-1111-4111-a111-cccccccccccc";
const OUTSIDER_ID = "cccccccc-2222-4222-a222-cccccccccccc";
const EVENT_SOCIAL = "bbbbbbbb-1111-4111-a111-bbbbbbbbbbbb";
const EVENT_MUSIC = "bbbbbbbb-2222-4222-a222-bbbbbbbbbbbb";

const FROM = new Date("2026-09-01T00:00:00Z");
const TO = new Date("2026-09-30T00:00:00Z");

function makePlace(overrides: Partial<PlaceRecord> = {}): PlaceRecord {
  return {
    id: PLACE_ID,
    name: "Drkmttr",
    slug: "drkmttr",
    formattedAddress: "123 Main St",
    addressLine1: "123 Main St",
    addressLine2: null,
    city: "Nashville",
    region: "TN",
    postalCode: "37201",
    countryCode: "US",
    capacity: null,
    lat: null,
    lng: null,
    status: "ACTIVE",
    verificationStatus: "VERIFIED",
    orgIdsWithAccess: [],
    humanIdsWithAccess: [OWNER_ID],
    defaultPrimaryPayoutTermsId: null,
    defaultResalePayoutTermsId: null,
    ...overrides,
  } as PlaceRecord;
}

function makeEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    id: EVENT_SOCIAL,
    orgId: null,
    // VENUE-OWNED by default (the place's direct human owner) so fixtures are
    // venue-confirmed by construction (docs/specs/2026-08-27) and the
    // pre-existing conflict expectations hold; the venue-confirmation suite
    // below opts individual events out.
    humanId: OWNER_ID,
    title: "Social Night",
    status: "PUBLISHED",
    visibility: "PUBLIC",
    gateType: "NONE",
    locationMode: "EXACT",
    locationRadiusMeters: null,
    locationLabel: null,
    addressRevealAt: null,
    addressRevealPreset: null,
    timezone: "America/Chicago",
    startsAt: new Date("2026-09-10T20:00:00Z"),
    endsAt: new Date("2026-09-10T23:00:00Z"),
    placeId: PLACE_ID,
    savedLocationId: null,
    categoryId: null,
    addressText: null,
    lat: null,
    lng: null,
    slug: "social-night",
    shortId: null,
    regionCode: "us-tn",
    publishedAt: new Date("2026-08-01T10:00:00Z"),
    payoutTermsId: null,
    resalePayoutTermsId: null,
    agreementPrimaryId: null,
    agreementResaleId: null,
    placeLayoutId: null,
    waitlistStatus: "DISABLED",
    heroImageUrl: null,
    locality: "Nashville",
    region: "TN",
    ...overrides,
  } as EventRecord;
}

// The booking-hold overlay projects `lapsed` with
// `isHoldLapsed(hold, now, placeTz)` against the REAL clock unless deps carry
// one, and this world is `America/Chicago`. With a wall clock, every FR-014
// case below that seeds a hold on a fixed date passes until that date falls
// behind Chicago's today, then fails forever. It did: the suite went red on
// 2026-09-11 with `lapsed` true for a hold dated 2026-09-10, having been green
// hours earlier while UTC was past midnight but Chicago was not.
// Pinning `now` inside the FROM..TO window makes the projection deterministic.
// Override it per-test to exercise a hold that really has lapsed.
const FIXED_NOW = new Date("2026-09-10T12:00:00Z");

function buildWorld(
  overrides: {
    bookingRequestById?: (id: string) => unknown;
    humansByIds?: (ids: string[]) => unknown[];
    now?: Date;
  } = {},
) {
  const spaces = createFakeSpacesRepo();
  const calendars = createFakeCalendarsRepo({ spaces });

  const sharedSpace = spaces.seed({ placeId: PLACE_ID, name: "The Space" });
  const socialClub = calendars.seedCalendar({
    placeId: PLACE_ID,
    name: "Social Club",
    slug: "social-club",
    isDefault: true,
  });
  const liveMusic = calendars.seedCalendar({
    placeId: PLACE_ID,
    name: "Live Music",
    slug: "live-music",
  });
  calendars.joins.set(socialClub.id, [sharedSpace.id]);
  calendars.joins.set(liveMusic.id, [sharedSpace.id]);

  // One event per calendar, SAME space, overlapping in time.
  const socialEvent = makeEvent({
    id: EVENT_SOCIAL,
    title: "Social Night",
    calendarId: socialClub.id,
    spaceId: sharedSpace.id,
  });
  const musicEvent = makeEvent({
    id: EVENT_MUSIC,
    title: "Loud Band",
    calendarId: liveMusic.id,
    spaceId: sharedSpace.id,
    slug: "loud-band",
    startsAt: new Date("2026-09-10T21:00:00Z"),
    endsAt: new Date("2026-09-11T00:00:00Z"),
  });
  const allEvents = [socialEvent, musicEvent];

  const place = makePlace();
  const gate = makeImageModerationGateFake({});
  const bookingHolds = createFakeBookingHoldsRepo();

  const events = {
    listByCalendar: vi.fn(
      async ({ calendarId, publishedOnly }: { calendarId: string; publishedOnly?: boolean }) =>
        allEvents.filter(
          (e) =>
            e.calendarId === calendarId &&
            (!publishedOnly ||
              (e.status === "PUBLISHED" && e.visibility === "PUBLIC")),
        ),
    ),
    listAllByPlace: vi.fn(async () => allEvents),
    listPublishedByPlace: vi.fn(async () => ({
      items: allEvents,
      pageInfo: { total: 2, limit: 20, offset: 0, count: 2, hasMore: false },
    })),
  };
  // get-venue-calendar's FR-003 expansion read; no multi-date listings here.
  const eventDates = { listByEventIds: vi.fn(async () => []) };

  const authz = {
    getPlaceAccessContext: vi.fn(async (placeId: string) =>
      placeId === PLACE_ID
        ? { owningOrgIds: [], verifiedHumanOwnerIds: [OWNER_ID] }
        : null,
    ),
    getOrgMembership: vi.fn(async () => null),
    getOrgMemberships: vi.fn(async () => []),
  };

  const deps = {
    repos: {
      calendars,
      events,
      eventDates,
      places: {
        getById: vi.fn(async (id: string) => (id === PLACE_ID ? place : null)),
        getBySlug: vi.fn(async () => place),
      },
      authz,
      seriesOccurrences: { getCalendarInfoForEventIds: vi.fn(async () => []) },
      bookingHolds,
      bookingRequests: {
        getById: vi.fn(async (id: string) => overrides.bookingRequestById?.(id) ?? null),
      },
      humans: { getByIds: vi.fn(async (ids: string[]) => overrides.humansByIds?.(ids) ?? []) },
      organizations: { getByIds: vi.fn(async () => []) },
      imageModerationRecords: gate.imageModerationRecords,
    } as unknown as GetCalendarEventsDeps["repos"],
    clock: { now: () => overrides.now ?? FIXED_NOW },
    reportError: vi.fn(),
  } satisfies Partial<GetCalendarEventsDeps> as GetCalendarEventsDeps & { reportError: ReturnType<typeof vi.fn> };

  return {
    deps,
    calendars,
    spaces,
    events,
    bookingHolds,
    place,
    socialClub,
    liveMusic,
    sharedSpace,
    socialEvent,
    musicEvent,
    allEvents,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE SPACE-BLEED REGRESSION (step checkpoint): two calendars share one space;
// each calendar's read returns ONLY its own event; conflicts still see both.
// ─────────────────────────────────────────────────────────────────────────────

describe("getCalendarEvents — space-bleed regression", () => {
  it("each calendar's PUBLIC read returns ONLY its own event despite the shared space", async () => {
    const w = buildWorld();

    const social = (await getCalendarEvents(w.deps, {
      mode: "public",
      calendarId: w.socialClub.id,
      from: FROM,
      to: TO,
    })) as GetCalendarEventsPublicOutput;
    const music = (await getCalendarEvents(w.deps, {
      mode: "public",
      calendarId: w.liveMusic.id,
      from: FROM,
      to: TO,
    })) as GetCalendarEventsPublicOutput;

    expect(social.events.map((e) => e.eventId)).toEqual([EVENT_SOCIAL]);
    expect(music.events.map((e) => e.eventId)).toEqual([EVENT_MUSIC]);
    // Each row carries its OWN Event.calendarId (phase-2 filter chips key
    // on it) — public leg included.
    expect(social.events.map((e) => e.calendarId)).toEqual([w.socialClub.id]);
    expect(music.events.map((e) => e.calendarId)).toEqual([w.liveMusic.id]);
  });

  it("get-venue-calendar (admin, space-keyed conflicts) still sees BOTH events as a conflict", async () => {
    const w = buildWorld();

    const result = await getVenueCalendar(
      {
        repos: w.deps.repos,
      },
      {
        mode: "admin",
        placeId: PLACE_ID,
        actorHumanId: OWNER_ID,
        from: FROM,
        to: TO,
      },
    );

    expect(result.conflicts).toEqual([
      {
        eventAId: EVENT_SOCIAL,
        eventBId: EVENT_MUSIC,
        overlapMinutes: 120,
      },
    ]);
  });

  it("pure detectConflicts on the same fixture: shared space conflicts, split spaces don't", () => {
    const w = buildWorld();
    expect(detectConflicts(w.allEvents)).toHaveLength(1);
    expect(
      detectConflicts([
        w.socialEvent,
        { ...w.musicEvent, spaceId: "some-other-space" },
      ]),
    ).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Public variant — leakage pins (NFR-002)
// ─────────────────────────────────────────────────────────────────────────────

describe("getCalendarEvents — public", () => {
  it("returns only PUBLISHED events (draft/unlisted filtered by the repo flag) and passes publishedOnly", async () => {
    const w = buildWorld();
    await getCalendarEvents(w.deps, {
      mode: "public",
      calendarId: w.socialClub.id,
      from: FROM,
      to: TO,
    });
    expect(w.events.listByCalendar).toHaveBeenCalledWith(
      expect.objectContaining({
        calendarId: w.socialClub.id,
        publishedOnly: true,
      }),
    );
  });

  it("NEVER returns availability internals or conflict data — the keys do not exist on the public shape", async () => {
    const w = buildWorld();
    // Seed availability rows that would leak if the public path ever read them.
    w.calendars.seedAvailability({
      placeId: PLACE_ID,
      calendarId: w.socialClub.id,
      dayOfWeek: 5,
      isOpen: false,
      note: "internal blackout note",
    });

    const result = (await getCalendarEvents(w.deps, {
      mode: "public",
      calendarId: w.socialClub.id,
      from: FROM,
      to: TO,
    })) as GetCalendarEventsPublicOutput;

    expect(Object.keys(result).sort()).toEqual(["calendar", "events"]);
    expect(result).not.toHaveProperty("availability");
    expect(result).not.toHaveProperty("conflicts");
    expect(JSON.stringify(result)).not.toContain("internal blackout note");
  });

  it("rejects an explicit window larger than 90 days (parity with the admin bound)", async () => {
    const w = buildWorld();
    await expect(
      getCalendarEvents(w.deps, {
        mode: "public",
        calendarId: w.socialClub.id,
        from: FROM,
        to: new Date("2027-01-01T00:00:00Z"),
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(w.events.listByCalendar).not.toHaveBeenCalled();
  });

  it("clamps a to-only window (from defaults to now) to 90 days server-side", async () => {
    const w = buildWorld();
    const farOut = new Date(Date.now() + 400 * 24 * 60 * 60 * 1000);

    await getCalendarEvents(w.deps, {
      mode: "public",
      calendarId: w.socialClub.id,
      to: farOut,
    });

    const call = w.events.listByCalendar.mock.calls[0]![0] as {
      from: Date;
      to: Date;
    };
    expect(call.to.getTime() - call.from.getTime()).toBeLessThanOrEqual(
      90 * 24 * 60 * 60 * 1000,
    );
  });

  it("pushes `limit` into the repo read as a SQL take (defaulted when omitted)", async () => {
    const w = buildWorld();

    await getCalendarEvents(w.deps, {
      mode: "public",
      calendarId: w.socialClub.id,
      from: FROM,
      to: TO,
      limit: 5,
    });
    expect(w.events.listByCalendar).toHaveBeenLastCalledWith(
      expect.objectContaining({ limit: 5 }),
    );

    await getCalendarEvents(w.deps, {
      mode: "public",
      calendarId: w.socialClub.id,
      from: FROM,
      to: TO,
    });
    expect(w.events.listByCalendar).toHaveBeenLastCalledWith(
      expect.objectContaining({ limit: 100 }),
    );

    // Schema max mirrors the adapter clamp (100) — over-asking is rejected.
    await expect(
      getCalendarEvents(w.deps, {
        mode: "public",
        calendarId: w.socialClub.id,
        from: FROM,
        to: TO,
        limit: 101,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  // FR-003 (event-calendar-redesign): opt-in only — this read does not
  // expand, so a caller that admits stale-pinned listings must be the one
  // that expands them (the calendar-subject embed). Everyone else's repo
  // argument must not change by so much as a key.
  it("threads includeDateOccurrences to listByCalendar ONLY when set; omitted leaves the repo argument key-free", async () => {
    const w = buildWorld();

    await getCalendarEvents(w.deps, {
      mode: "public",
      calendarId: w.socialClub.id,
      from: FROM,
      to: TO,
    });
    expect(w.events.listByCalendar.mock.calls[0]![0]).not.toHaveProperty(
      "includeDateOccurrences",
    );

    await getCalendarEvents(w.deps, {
      mode: "public",
      calendarId: w.socialClub.id,
      from: FROM,
      to: TO,
      includeDateOccurrences: true,
    });
    expect(w.events.listByCalendar).toHaveBeenLastCalledWith(
      expect.objectContaining({ includeDateOccurrences: true }),
    );
  });

  it("throws CALENDAR_NOT_FOUND for an unknown calendar", async () => {
    const w = buildWorld();
    await expect(
      getCalendarEvents(w.deps, {
        mode: "public",
        calendarId: "99999999-9999-4999-8999-999999999999",
        from: FROM,
        to: TO,
      }),
    ).rejects.toMatchObject({ code: "CALENDAR_NOT_FOUND" });
  });

  it.each([
    // The CODE collapses to CALENDAR_NOT_FOUND on the public path (Step-6
    // review): distinct PLACE_NOT_VERIFIED / PLACE_NOT_ACTIVE codes reach
    // unauthenticated clients and would be an existence-and-state oracle for
    // places that never went public.
    ["UNVERIFIED place", { verificationStatus: "UNVERIFIED" }],
    ["SUSPENDED place", { status: "SUSPENDED" }],
  ] as const)(
    "gates the %s as plain CALENDAR_NOT_FOUND (no existence oracle)",
    async (_label, placeOverride) => {
      const w = buildWorld();
      const gatedPlace = makePlace(placeOverride as Partial<PlaceRecord>);
      (
        w.deps.repos.places.getById as ReturnType<typeof vi.fn>
      ).mockResolvedValue(gatedPlace);

      await expect(
        getCalendarEvents(w.deps, {
          mode: "public",
          calendarId: w.socialClub.id,
          from: FROM,
          to: TO,
        }),
      ).rejects.toMatchObject({ code: "CALENDAR_NOT_FOUND" });
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Admin variant — authz + overlays
// ─────────────────────────────────────────────────────────────────────────────

describe("getCalendarEvents — admin", () => {
  const adminInput = (calendarId: string, actorHumanId = OWNER_ID) => ({
    mode: "admin" as const,
    calendarId,
    actorHumanId,
    from: FROM,
    to: TO,
  });

  it("returns own events, space conflicts INVOLVING them (cross-calendar), and merged availability", async () => {
    const w = buildWorld();
    // Calendar-scoped row + a PLACE-WIDE row (calendarId null) + a row for
    // the OTHER calendar which must not appear.
    const own = w.calendars.seedAvailability({
      placeId: PLACE_ID,
      calendarId: w.socialClub.id,
      dayOfWeek: 5,
      startTime: "19:00",
      endTime: "23:00",
    });
    const placeWide = w.calendars.seedAvailability({
      placeId: PLACE_ID,
      calendarId: null,
      date: new Date("2026-09-15T00:00:00Z"),
      isOpen: false,
      note: "venue closed",
    });
    w.calendars.seedAvailability({
      placeId: PLACE_ID,
      calendarId: w.liveMusic.id,
      dayOfWeek: 2,
    });

    const result = (await getCalendarEvents(
      w.deps,
      adminInput(w.socialClub.id),
    )) as GetCalendarEventsAdminOutput;

    // Own events only (space-bleed guard holds on admin too).
    expect(result.events.map((e) => e.eventId)).toEqual([EVENT_SOCIAL]);
    expect(result.events.map((e) => e.calendarId)).toEqual([w.socialClub.id]);

    // The conflict pair involves the OTHER calendar's event on the shared
    // space — still flagged, per FR-006 (conflicts are physical, not
    // per-stream).
    expect(result.conflicts).toEqual([
      { eventAId: EVENT_SOCIAL, eventBId: EVENT_MUSIC, overlapMinutes: 120 },
    ]);

    // Availability = own rows + place-wide rows; never another calendar's.
    expect(result.availability.map((r) => r.id).sort()).toEqual(
      [own.id, placeWide.id].sort(),
    );
  });

  it("an UNVERIFIED place hides the calendar from the PUBLIC path but the owner's admin read still works", async () => {
    const w = buildWorld();
    const unverified = makePlace({ verificationStatus: "UNVERIFIED" });
    (
      w.deps.repos.places.getById as ReturnType<typeof vi.fn>
    ).mockResolvedValue(unverified);

    // Public: collapsed CALENDAR_NOT_FOUND (Step-6 review — no existence
    // oracle for a place that never went public).
    await expect(
      getCalendarEvents(w.deps, {
        mode: "public",
        calendarId: w.socialClub.id,
        from: FROM,
        to: TO,
      }),
    ).rejects.toMatchObject({ code: "CALENDAR_NOT_FOUND" });

    // Admin: the owner path never gated on verification (a pre-verification
    // venue must be able to configure its calendars) — the owner still gets
    // the full overlay view of their own place.
    const result = (await getCalendarEvents(
      w.deps,
      adminInput(w.socialClub.id),
    )) as GetCalendarEventsAdminOutput;
    expect(result.calendar).toMatchObject({ slug: "social-club" });
  });

  it("throws NOT_RESOURCE_OWNER for a non-owner actor (no overlay leak)", async () => {
    const w = buildWorld();
    await expect(
      getCalendarEvents(w.deps, adminInput(w.socialClub.id, OUTSIDER_ID)),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });

  it("throws CALENDAR_NOT_FOUND before any authz for an unknown calendar", async () => {
    const w = buildWorld();
    await expect(
      getCalendarEvents(
        w.deps,
        adminInput("99999999-9999-4999-8999-999999999999"),
      ),
    ).rejects.toMatchObject({ code: "CALENDAR_NOT_FOUND" });
  });

  it("rejects a window larger than 90 days", async () => {
    const w = buildWorld();
    await expect(
      getCalendarEvents(w.deps, {
        mode: "admin",
        calendarId: w.socialClub.id,
        actorHumanId: OWNER_ID,
        from: FROM,
        to: new Date("2027-01-01T00:00:00Z"),
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Booking-holds FR-014: admin overlays carry live holds; public shapes never
// read the hold table and are byte-identical with and without holds present.
// ─────────────────────────────────────────────────────────────────────────────

describe("booking-hold overlay (FR-014)", () => {
  const REQUEST_ID = "44444444-4444-4444-8444-444444444444";

  it("admin calendar read overlays this calendar's live holds; conflicts never include them", async () => {
    const w = buildWorld();
    const hold = w.bookingHolds.seed({ bookingRequestId: REQUEST_ID, calendarId: w.socialClub.id, date: "2026-09-10" });
    // Another calendar's hold must not appear on this calendar's overlay.
    w.bookingHolds.seed({ bookingRequestId: REQUEST_ID, calendarId: w.liveMusic.id, date: "2026-09-10" });

    const result = (await getCalendarEvents(w.deps, {
      mode: "admin" as const,
      calendarId: w.socialClub.id,
      actorHumanId: OWNER_ID,
      from: FROM,
      to: TO,
    })) as GetCalendarEventsAdminOutput;

    expect(result.holds).toEqual([
      {
        id: hold.id,
        ownerKind: "REQUEST",
        bookingRequestId: REQUEST_ID,
        calendarId: w.socialClub.id,
        spaceId: null,
        date: "2026-09-10",
        position: 1,
        status: "ACTIVE",
        respondBy: null,
        lapsed: false,
        actName: null,
        performerDisplayName: null,
      },
    ]);
    expect(result.conflicts.every((c) => c.eventAId !== hold.id && c.eventBId !== hold.id)).toBe(true);
  });

  it("a request-less hold rides the overlay with its owner kind, no request and no names", async () => {
    const w = buildWorld();
    const hold = w.bookingHolds.seed({ ownerKind: "PLACE", holder: null, calendarId: w.socialClub.id, date: "2026-09-11" });

    const result = (await getCalendarEvents(w.deps, {
      mode: "admin" as const,
      calendarId: w.socialClub.id,
      actorHumanId: OWNER_ID,
      from: FROM,
      to: TO,
    })) as GetCalendarEventsAdminOutput;

    expect(result.holds).toEqual([
      expect.objectContaining({
        id: hold.id,
        ownerKind: "PLACE",
        bookingRequestId: null,
        actName: null,
        performerDisplayName: null,
      }),
    ]);
  });

  const HUMAN_ID = "55555555-5555-4555-8555-555555555555";
  const ownedRequest = (id: string) =>
    id === REQUEST_ID
      ? { id, actName: null, performerOwnerType: "human", performerOwnerId: HUMAN_ID, contactName: null, contactEmail: null }
      : null;

  it("admin overlay resolves the sender's platform name off the owner pair, via ONE batched humans read", async () => {
    const w = buildWorld({
      bookingRequestById: ownedRequest,
      humansByIds: (ids) => (ids.includes(HUMAN_ID) ? [{ id: HUMAN_ID, name: "Willa" }] : []),
    });
    const hold = w.bookingHolds.seed({ bookingRequestId: REQUEST_ID, calendarId: w.socialClub.id, date: "2026-09-10" });

    const result = (await getCalendarEvents(w.deps, {
      mode: "admin" as const,
      calendarId: w.socialClub.id,
      actorHumanId: OWNER_ID,
      from: FROM,
      to: TO,
    })) as GetCalendarEventsAdminOutput;

    expect(result.holds.map((h) => [h.id, h.actName, h.performerDisplayName])).toEqual([[hold.id, null, "Willa"]]);
    expect(w.deps.repos.humans.getByIds).toHaveBeenCalledTimes(1);
    expect(w.deps.reportError).not.toHaveBeenCalled();
  });

  it("admin overlay DEGRADES to a null name and reports exactly once when the name lookup throws", async () => {
    const w = buildWorld({
      bookingRequestById: ownedRequest,
      humansByIds: () => {
        throw new Error("humans down");
      },
    });
    const hold = w.bookingHolds.seed({ bookingRequestId: REQUEST_ID, calendarId: w.socialClub.id, date: "2026-09-10" });

    const result = (await getCalendarEvents(w.deps, {
      mode: "admin" as const,
      calendarId: w.socialClub.id,
      actorHumanId: OWNER_ID,
      from: FROM,
      to: TO,
    })) as GetCalendarEventsAdminOutput;

    expect(result.holds.map((h) => [h.id, h.performerDisplayName])).toEqual([[hold.id, null]]);
    expect(w.deps.reportError).toHaveBeenCalledTimes(1);
    expect(w.deps.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "humans down" }),
      expect.objectContaining({ tags: expect.objectContaining({ useCase: "booking-hold-overlay" }) }),
    );
  });

  it("the PUBLIC calendar read is byte-identical with and without holds, and never touches the hold repo", async () => {
    const w = buildWorld();
    const input = { mode: "public" as const, calendarId: w.socialClub.id, from: FROM, to: TO };
    const before = await getCalendarEvents(w.deps, input);
    w.bookingHolds.seed({ bookingRequestId: REQUEST_ID, calendarId: w.socialClub.id, date: "2026-09-10" });
    const after = await getCalendarEvents(w.deps, input);

    expect(after).toEqual(before);
    // Byte-identical, not just deep-equal: key order and shape included.
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    expect(after).not.toHaveProperty("holds");
    expect(w.bookingHolds.listLiveForCalendarRange).not.toHaveBeenCalled();
    expect(w.bookingHolds.listLiveForPlaceRange).not.toHaveBeenCalled();
    expect(w.bookingHolds.listLine).not.toHaveBeenCalled();
  });

  it("a CONFIRMED hold is visible to ADMIN and structurally invisible to PUBLIC", async () => {
    const w = buildWorld();
    // Widening the overlay to CONFIRMED must not widen the public surface:
    // the public output shape is `.strict()` with no `holds` key, so a leak
    // would be a parse failure, not a silent addition.
    const confirmed = w.bookingHolds.seed({
      bookingRequestId: REQUEST_ID,
      calendarId: w.socialClub.id,
      date: "2026-09-10",
      status: "CONFIRMED",
      confirmedAt: new Date("2026-09-01T00:00:00.000Z"),
    });

    const admin = await getCalendarEvents(w.deps, {
      mode: "admin",
      calendarId: w.socialClub.id,
      actorHumanId: OWNER_ID,
      from: FROM,
      to: TO,
    });
    expect("holds" in admin && admin.holds.map((h) => [h.id, h.status])).toEqual([
      [confirmed.id, "CONFIRMED"],
    ]);

    const pub = await getCalendarEvents(w.deps, {
      mode: "public",
      calendarId: w.socialClub.id,
      from: FROM,
      to: TO,
    });
    expect(pub).not.toHaveProperty("holds");
    expect(JSON.stringify(pub)).not.toContain(confirmed.id);
  });

  it("get-venue-calendar: admin carries the place-wide overlay; public is unchanged", async () => {
    const w = buildWorld();
    const placeHold = w.bookingHolds.seed({ bookingRequestId: REQUEST_ID, calendarId: w.liveMusic.id, date: "2026-09-10" });
    w.bookingHolds.listLiveForPlaceRange = vi.fn(async () => [placeHold]);

    const admin = await getVenueCalendar({ repos: w.deps.repos }, {
      mode: "admin",
      placeId: PLACE_ID,
      actorHumanId: OWNER_ID,
      from: FROM,
      to: TO,
    });
    expect("holds" in admin && admin.holds.map((h) => h.id)).toEqual([placeHold.id]);

    const pub = await getVenueCalendar({ repos: w.deps.repos }, { mode: "public", placeId: PLACE_ID });
    expect(pub).not.toHaveProperty("holds");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Venue confirmation (docs/specs/2026-08-27): third-party events count ONLY
// when venue-confirmed. ADMIN returns them all, flagged, and excludes the
// unconfirmed from conflicts; PUBLIC pushes the same rule into SQL.
// ─────────────────────────────────────────────────────────────────────────────

describe("getCalendarEvents — venue confirmation", () => {
  const THIRD_PARTY_ID = "cccccccc-3333-4333-a333-cccccccccccc";
  const STAMPED_AT = new Date("2026-08-20T12:00:00Z");

  /** The fixture world with the Loud Band event re-owned by a third party. */
  function thirdPartyWorld(overrides: Partial<EventRecord> = {}) {
    const world = buildWorld();
    const thirdParty = { ...world.musicEvent, humanId: THIRD_PARTY_ID, ...overrides };
    world.allEvents.splice(0, world.allEvents.length, world.socialEvent, thirdParty);
    return world;
  }

  it("ADMIN: an UNCONFIRMED third-party event on the shared space is returned flagged false and blocks nothing", async () => {
    const world = thirdPartyWorld();
    const result = (await getCalendarEvents(world.deps, {
      mode: "admin",
      calendarId: world.liveMusic.id,
      actorHumanId: OWNER_ID,
      from: FROM,
      to: TO,
    })) as GetCalendarEventsAdminOutput;
    expect(result.events.map((e) => [e.eventId, e.venueConfirmed])).toEqual([[EVENT_MUSIC, false]]);
    // The Social Club read sees no conflict from it either.
    const social = (await getCalendarEvents(world.deps, {
      mode: "admin",
      calendarId: world.socialClub.id,
      actorHumanId: OWNER_ID,
      from: FROM,
      to: TO,
    })) as GetCalendarEventsAdminOutput;
    expect(result.conflicts).toEqual([]);
    expect(social.conflicts).toEqual([]);
    expect(social.events[0]?.venueConfirmed).toBe(true);
  });

  it("ADMIN: a STAMPED third-party event is confirmed and the cross-calendar conflict is back", async () => {
    const world = thirdPartyWorld({ venueConfirmedPlaceId: PLACE_ID, venueConfirmedAt: STAMPED_AT, venueConfirmationWithdrawnAt: null });
    const result = (await getCalendarEvents(world.deps, {
      mode: "admin",
      calendarId: world.liveMusic.id,
      actorHumanId: OWNER_ID,
      from: FROM,
      to: TO,
    })) as GetCalendarEventsAdminOutput;
    expect(result.events[0]?.venueConfirmed).toBe(true);
    expect(result.conflicts).toEqual([
      { eventAId: EVENT_SOCIAL, eventBId: EVENT_MUSIC, overlapMinutes: 120 },
    ]);
  });

  it("ADMIN: a WITHDRAWN stamp reads as unconfirmed", async () => {
    const world = thirdPartyWorld({
      venueConfirmedPlaceId: PLACE_ID, venueConfirmedAt: STAMPED_AT,
      venueConfirmationWithdrawnAt: new Date("2026-08-21T12:00:00Z"),
      venueConfirmationWithdrawnReason: "not ours",
    });
    const result = (await getCalendarEvents(world.deps, {
      mode: "admin",
      calendarId: world.liveMusic.id,
      actorHumanId: OWNER_ID,
      from: FROM,
      to: TO,
    })) as GetCalendarEventsAdminOutput;
    expect(result.events[0]?.venueConfirmed).toBe(false);
    expect(result.conflicts).toEqual([]);
  });

  it("venueOwned rides every row: venue-owned → true/true, stamped third-party → false/true, unconfirmed third-party → false/false", async () => {
    const world = buildWorld();
    const stamped = {
      ...world.musicEvent,
      humanId: THIRD_PARTY_ID,
      venueConfirmedAt: STAMPED_AT,
      venueConfirmedPlaceId: PLACE_ID,
      venueConfirmationWithdrawnAt: null,
    };
    const unconfirmed = {
      ...world.musicEvent,
      id: "bbbbbbbb-3333-4333-a333-bbbbbbbbbbbb",
      humanId: THIRD_PARTY_ID,
      calendarId: world.liveMusic.id,
      startsAt: new Date("2026-09-12T20:00:00Z"),
      endsAt: new Date("2026-09-12T23:00:00Z"),
    };
    world.allEvents.splice(0, world.allEvents.length, world.socialEvent, stamped, unconfirmed);

    const music = (await getCalendarEvents(world.deps, {
      mode: "admin",
      calendarId: world.liveMusic.id,
      actorHumanId: OWNER_ID,
      from: FROM,
      to: TO,
    })) as GetCalendarEventsAdminOutput;
    expect(music.events.map((e) => [e.eventId, e.venueOwned, e.venueConfirmed])).toEqual([
      [EVENT_MUSIC, false, true],
      [unconfirmed.id, false, false],
    ]);
    const social = (await getCalendarEvents(world.deps, {
      mode: "admin",
      calendarId: world.socialClub.id,
      actorHumanId: OWNER_ID,
      from: FROM,
      to: TO,
    })) as GetCalendarEventsAdminOutput;
    expect(social.events.map((e) => [e.venueOwned, e.venueConfirmed])).toEqual([[true, true]]);

    // PUBLIC (repo-filtered to confirmed): venueOwned still derived per row.
    const pub = (await getCalendarEvents(world.deps, {
      mode: "public",
      calendarId: world.liveMusic.id,
    })) as GetCalendarEventsPublicOutput;
    expect(pub.events.map((e) => [e.venueOwned, e.venueConfirmed])).toEqual([
      [false, true],
      [false, true],
    ]);
  });

  it("PUBLIC: passes venueConfirmedFor (the place's owner ids) to listByCalendar and flags rows true", async () => {
    const world = buildWorld();
    const result = (await getCalendarEvents(world.deps, {
      mode: "public",
      calendarId: world.liveMusic.id,
    })) as GetCalendarEventsPublicOutput;
    expect(world.events.listByCalendar).toHaveBeenCalledWith(
      expect.objectContaining({
        publishedOnly: true,
        venueConfirmedFor: {
          orgIds: [],
          humanIds: [OWNER_ID],
          acceptsCommunityListings: false,
        },
      }),
    );
    expect(result.events.map((e) => e.venueConfirmed)).toEqual([true]);
  });
});
