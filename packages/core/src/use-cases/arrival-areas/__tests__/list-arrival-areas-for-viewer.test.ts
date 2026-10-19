import { describe, expect, it, vi } from "vitest";

import type { EventRecord } from "@th/ports/repos/events";
import type { PlaceRecord } from "@th/ports/repos/places";
import type { ArrivalAreaRow } from "@th/types/repos/arrival-areas";

import {
  listArrivalAreasForViewer,
  type ListArrivalAreasForViewerDeps,
} from "../list-arrival-areas-for-viewer";

/**
 * Arrival areas never leak a withheld address (arrival-areas FR-008, FR-009,
 * risk 1), in the place-address-withholding style: every "nothing" case also
 * serializes the whole output and searches it for any coordinate of a drawn
 * area and of the place.
 */

const NOW = new Date("2026-10-16T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const PLACE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EVENT_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const OWNER_ORG = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a";
const THIRD_ORG = "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b";
const VIEWER = "11111111-1111-4111-8111-111111111111";

// Distinctive digits so a serialized search cannot false-positive.
const AREA_LAT = 36.187111;
const AREA_LNG = -86.729777;
const SIDE = 0.000444;

function ring(dLat = 0, dLng = 0): Array<[number, number]> {
  const lat = AREA_LAT + dLat;
  const lng = AREA_LNG + dLng;
  return [
    [lng, lat],
    [lng + SIDE, lat],
    [lng + SIDE, lat + SIDE],
    [lng, lat + SIDE],
    [lng, lat],
  ];
}

function area(overrides: Partial<ArrivalAreaRow> & Pick<ArrivalAreaRow, "id" | "kind">): ArrivalAreaRow {
  return {
    placeId: PLACE_ID,
    eventId: null,
    geometry: { type: "Polygon", coordinates: [ring()] },
    label: `Area ${overrides.id}`,
    cost: "FREE",
    priceText: null,
    note: null,
    accessibleSpots: false,
    sortOrder: 0,
    disabledAt: null,
    createdByHumanId: null,
    createdAt: new Date("2026-10-01T00:00:00.000Z"),
    updatedAt: new Date("2026-10-01T00:00:00.000Z"),
    ...overrides,
  };
}

const PLACE_AREAS: ArrivalAreaRow[] = [
  area({ id: "p-parking", kind: "PARKING" }),
  area({ id: "p-drop", kind: "ACCESSIBLE_DROP_OFF", geometry: { type: "Polygon", coordinates: [ring(0.001)] } }),
  area({ id: "p-load", kind: "LOAD_IN", geometry: { type: "Polygon", coordinates: [ring(0.002)] } }),
];

function makePlace(overrides: Partial<PlaceRecord> = {}): PlaceRecord {
  return {
    id: PLACE_ID,
    name: "The Porter House",
    status: "ACTIVE",
    formattedAddress: "901 Porter Rd",
    addressLine1: "901 Porter Rd",
    addressLine2: null,
    city: "Nashville",
    region: "TN",
    postalCode: "37206",
    countryCode: "US",
    lat: 36.1862,
    lng: -86.7291,
    locationMode: "OBSCURED",
    locationRadiusMeters: 800,
    locationLabel: "East Nashville",
    orgIdsWithAccess: [OWNER_ORG],
    humanIdsWithAccess: [],
    acceptsCommunityListings: false,
    listedInDirectory: true,
    ...overrides,
  } as unknown as PlaceRecord;
}

/** The place's own show, its reveal a week away, starting in eight days. */
function makeEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    id: EVENT_ID,
    status: "PUBLISHED",
    publishedAt: new Date("2026-10-01T00:00:00.000Z"),
    ownerBanned: false,
    orgId: OWNER_ORG,
    humanId: null,
    stewardship: "ORGANIZATION",
    placeId: PLACE_ID,
    gateType: "NONE",
    locationMode: "OBSCURED",
    locationRadiusMeters: 800,
    addressRevealPreset: "DAY_BEFORE",
    addressRevealAt: new Date(NOW.getTime() + 7 * DAY),
    addressText: "East Nashville",
    locality: "Nashville",
    region: "TN",
    postalCode: null,
    locationLabel: "East Nashville",
    lat: 36.18,
    lng: -86.75,
    startsAt: new Date(NOW.getTime() + 8 * DAY),
    endsAt: new Date(NOW.getTime() + 8 * DAY + 3 * HOUR),
    venueConfirmedAt: null,
    venueConfirmationWithdrawnAt: null,
    venueConfirmedPlaceId: null,
    venueConfirmedStartsAt: null,
    ...overrides,
  } as unknown as EventRecord;
}

interface World {
  place?: PlaceRecord | null;
  event?: EventRecord | null;
  placeAreas?: ArrivalAreaRow[];
  eventAreas?: ArrivalAreaRow[];
  hides?: string[];
  lineup?: Array<{ humanId: string | null; orgId: string | null; role: string; externalName?: string | null }>;
  holder?: boolean;
  /** The viewer's own event-level RSVP row exists (cancelling deletes it). */
  rsvp?: boolean;
  /** The status of the one night the viewer RSVP'd to (recurring listing). */
  dateRsvp?: "SCHEDULED" | "CANCELLED";
  placeStaff?: boolean;
  eventStaff?: boolean;
  now?: Date;
  reportError?: ListArrivalAreasForViewerDeps["reportError"];
  failPlaceRead?: boolean;
  /** B2: the viewer's account has not proved its inbox. */
  viewerUnverified?: boolean;
}

function deps(world: World = {}) {
  const place = world.place === undefined ? makePlace() : world.place;
  const event = world.event === undefined ? makeEvent() : world.event;
  const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
  const reportError = world.reportError ?? vi.fn();
  const built = {
    repos: {
      places: {
        getById: vi.fn(async (id: string) => {
          if (world.failPlaceRead) throw new Error("db down");
          return place && place.id === id ? place : null;
        }),
      },
      events: {
        getById: vi.fn(async (id: string) => (event && event.id === id ? event : null)),
      },
      arrivalAreas: {
        listForPlace: vi.fn(async (id: string) =>
          (world.placeAreas ?? PLACE_AREAS).filter((a) => a.placeId === id),
        ),
        listForEvent: vi.fn(async (id: string) =>
          (world.eventAreas ?? []).filter((a) => a.eventId === id),
        ),
        listHidesForEvent: vi.fn(async () => world.hides ?? []),
      },
      eventHumans: {
        listByEvent: vi.fn(async () => world.lineup ?? []),
      },
      humans: {
        getByIdWithIdentity: vi.fn(async (id: string) => ({
          human: { id },
          identity: { emailVerified: world.viewerUnverified !== true },
        })),
      },
      tickets: {
        viewerHoldsActiveTicketForEvent: vi.fn(async () => world.holder === true),
      },
      // Keyed on the expected ids: a lookup for the wrong event or human
      // finds no RSVP.
      eventRsvps: {
        existsForUser: vi.fn(
          async (input: { eventId: string; humanId: string }) =>
            input.eventId === EVENT_ID && input.humanId === VIEWER && world.rsvp === true,
        ),
      },
      eventDateRsvps: {
        existsForUserOnEvent: vi.fn(
          async (input: {
            eventId: string;
            humanId: string;
            dateStatus?: "SCHEDULED" | "CANCELLED";
          }) =>
            input.eventId === EVENT_ID &&
            input.humanId === VIEWER &&
            world.dateRsvp !== undefined &&
            (input.dateStatus === undefined || input.dateStatus === world.dateRsvp),
        ),
      },
      authz: {
        getOrgMembership: vi.fn(async () => null),
        getHumanDelegation: vi.fn(async () => null),
      },
    },
    authz: {
      canManagePlace: vi.fn(async () => ({ allowed: world.placeStaff === true })),
      canEditEvent: vi.fn(async () => ({ allowed: world.eventStaff === true })),
      hasStaffRole: vi.fn(async () => ({ allowed: false })),
    },
    clock: { now: () => world.now ?? NOW },
    logger,
    reportError,
  };
  return built as unknown as ListArrivalAreasForViewerDeps & {
    logger: typeof logger;
    reportError: ReturnType<typeof vi.fn>;
  };
}

/** No coordinate of any drawn area, of the place, or of a Directions point. */
function expectNoLocation(output: unknown): void {
  const json = JSON.stringify(output);
  for (const needle of ["36.18", "-86.72", "86.72", "Porter", "37206", "geometry", "directions"]) {
    expect(json).not.toContain(needle);
  }
}

const ids = (output: { areas: Array<{ id: string }> }) => output.areas.map((a) => a.id);

const ACT_ROW = { humanId: VIEWER, orgId: null, role: "PERFORMER" };

const EVENT_ONLY_LOAD_IN = [
  area({ id: "e-load", kind: "LOAD_IN", placeId: null, eventId: EVENT_ID }),
];

describe("expectNoLocation (control)", () => {
  it("does throw on a non-empty staff output, so the empty cases mean something", async () => {
    const out = await listArrivalAreasForViewer(deps({ placeStaff: true }), {
      placeId: PLACE_ID,
      viewerHumanId: VIEWER,
    });
    expect(out.areas.length).toBeGreaterThan(0);
    expect(() => expectNoLocation(out)).toThrow();
  });
});

// ── Place page ──────────────────────────────────────────────────────────────

describe("listArrivalAreasForViewer — place page", () => {
  it("an OBSCURED place shows the public NO areas, not even clipped", async () => {
    const out = await listArrivalAreasForViewer(deps(), { placeId: PLACE_ID });
    expect(out.areas).toEqual([]);
    expectNoLocation(out);
  });

  it("a fully hidden place (null radius) shows the public no areas", async () => {
    const out = await listArrivalAreasForViewer(
      deps({ place: makePlace({ locationRadiusMeters: null }) }),
      { placeId: PLACE_ID },
    );
    expect(out.areas).toEqual([]);
    expectNoLocation(out);
  });

  it("a signed-in viewer who does not manage the place gets nothing either", async () => {
    const out = await listArrivalAreasForViewer(deps(), {
      placeId: PLACE_ID,
      viewerHumanId: VIEWER,
    });
    expect(out.areas).toEqual([]);
    expectNoLocation(out);
  });

  it("an unknown location mode fails closed", async () => {
    const out = await listArrivalAreasForViewer(
      deps({ place: makePlace({ locationMode: "exact" as never }) }),
      { placeId: PLACE_ID },
    );
    expect(out.areas).toEqual([]);
  });

  it("an EXACT place shows parking and drop-off to everyone, never load-in, cacheable", async () => {
    const out = await listArrivalAreasForViewer(
      deps({ place: makePlace({ locationMode: "EXACT", locationRadiusMeters: null }) }),
      { placeId: PLACE_ID },
    );
    expect(ids(out)).toEqual(["p-parking", "p-drop"]);
    expect(out.cacheablePublic).toBe(true);
    expect(out.areas[0]!.directions).not.toBeNull();
    expect(out.areas[0]!.source).toBe("PLACE");
  });

  it("a suspended place shows the public nothing", async () => {
    const out = await listArrivalAreasForViewer(
      deps({ place: makePlace({ locationMode: "EXACT", status: "SUSPENDED" as never }) }),
      { placeId: PLACE_ID },
    );
    expect(out.areas).toEqual([]);
  });

  it("the place's managers see everything, load-in included, at an OBSCURED place; not cacheable", async () => {
    const out = await listArrivalAreasForViewer(deps({ placeStaff: true }), {
      placeId: PLACE_ID,
      viewerHumanId: VIEWER,
    });
    expect(ids(out)).toEqual(["p-parking", "p-drop", "p-load"]);
    expect(out.cacheablePublic).toBe(false);
  });

  it("a switched-off area is never shown, managers included", async () => {
    const out = await listArrivalAreasForViewer(
      deps({
        placeStaff: true,
        placeAreas: [...PLACE_AREAS, area({ id: "p-off", kind: "PARKING", disabledAt: NOW })],
      }),
      { placeId: PLACE_ID, viewerHumanId: VIEWER },
    );
    expect(ids(out)).not.toContain("p-off");
  });

  it("a malformed stored shape is still listed, without a shape or Directions", async () => {
    const out = await listArrivalAreasForViewer(
      deps({
        place: makePlace({ locationMode: "EXACT" }),
        placeAreas: [
          area({
            id: "p-broken",
            kind: "PARKING",
            geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 1]]] } as never,
          }),
        ],
      }),
      { placeId: PLACE_ID },
    );
    expect(out.areas).toEqual([
      expect.objectContaining({ id: "p-broken", geometry: null, directions: null }),
    ]);
  });

  it("a missing place gives nothing", async () => {
    const out = await listArrivalAreasForViewer(deps({ place: null }), { placeId: PLACE_ID });
    expect(out).toEqual({ areas: [], cacheablePublic: false });
  });
});

// ── Event page ──────────────────────────────────────────────────────────────

describe("listArrivalAreasForViewer — event page", () => {
  it("an event at an OBSCURED place shows the public NO areas", async () => {
    const out = await listArrivalAreasForViewer(deps(), { eventId: EVENT_ID });
    expect(out.areas).toEqual([]);
    expectNoLocation(out);
  });

  describe("ticket holders", () => {
    it("after the reveal: parking and drop-off, never load-in", async () => {
      const out = await listArrivalAreasForViewer(
        deps({ holder: true, now: new Date(NOW.getTime() + 7 * DAY + HOUR) }),
        { eventId: EVENT_ID, viewerHumanId: VIEWER },
      );
      expect(ids(out)).toEqual(["p-parking", "p-drop"]);
      expect(out.cacheablePublic).toBe(false);
    });

    it("before the reveal: nothing", async () => {
      const out = await listArrivalAreasForViewer(deps({ holder: true }), {
        eventId: EVENT_ID,
        viewerHumanId: VIEWER,
      });
      expect(out.areas).toEqual([]);
      expectNoLocation(out);
    });
  });

  describe("RSVP-ers (owner ruling Q4)", () => {
    const AFTER_REVEAL = new Date(NOW.getTime() + 7 * DAY + HOUR);
    const rsvpEvent = (overrides: Partial<EventRecord> = {}) =>
      makeEvent({ attendanceMode: "RSVP" as never, ...overrides });

    it("after the reveal: parking and drop-off, never load-in of either kind", async () => {
      const out = await listArrivalAreasForViewer(
        deps({
          rsvp: true,
          event: rsvpEvent(),
          eventAreas: EVENT_ONLY_LOAD_IN,
          now: AFTER_REVEAL,
        }),
        { eventId: EVENT_ID, viewerHumanId: VIEWER },
      );
      expect(ids(out)).toEqual(["p-parking", "p-drop"]);
      expect(out.cacheablePublic).toBe(false);
      expect(JSON.stringify(out)).not.toContain("e-load");
    });

    it("before the reveal at a withheld place: nothing", async () => {
      const out = await listArrivalAreasForViewer(
        deps({ rsvp: true, event: rsvpEvent(), eventAreas: EVENT_ONLY_LOAD_IN }),
        { eventId: EVENT_ID, viewerHumanId: VIEWER },
      );
      expect(out.areas).toEqual([]);
      expectNoLocation(out);
    });

    it("a cancelled RSVP (the row is deleted) gets nothing restricted after the reveal", async () => {
      const out = await listArrivalAreasForViewer(
        deps({ rsvp: false, event: rsvpEvent(), now: AFTER_REVEAL }),
        { eventId: EVENT_ID, viewerHumanId: VIEWER },
      );
      expect(out.areas).toEqual([]);
      expectNoLocation(out);
    });

    it("a CANCELLED event releases nothing restricted to an RSVP-er (its RSVP rows survive the cancel)", async () => {
      for (const who of [{ rsvp: true }, { dateRsvp: "SCHEDULED" as const }]) {
        const out = await listArrivalAreasForViewer(
          deps({
            ...who,
            event: rsvpEvent({ status: "CANCELLED" as never }),
            eventAreas: EVENT_ONLY_LOAD_IN,
            now: AFTER_REVEAL,
          }),
          { eventId: EVENT_ID, viewerHumanId: VIEWER },
        );
        expect(out.areas).toEqual([]);
        expectNoLocation(out);
      }
    });

    it("a per-night RSVP on a SCHEDULED night counts; one on a called-off night does not", async () => {
      const live = await listArrivalAreasForViewer(
        deps({ dateRsvp: "SCHEDULED", event: rsvpEvent(), now: AFTER_REVEAL }),
        { eventId: EVENT_ID, viewerHumanId: VIEWER },
      );
      expect(ids(live)).toEqual(["p-parking", "p-drop"]);
      const calledOff = await listArrivalAreasForViewer(
        deps({ dateRsvp: "CANCELLED", event: rsvpEvent(), now: AFTER_REVEAL }),
        { eventId: EVENT_ID, viewerHumanId: VIEWER },
      );
      expect(calledOff.areas).toEqual([]);
      expectNoLocation(calledOff);
    });

    it("a gated event without the gate pass: nothing; with it, the public kinds", async () => {
      const gated = {
        rsvp: true,
        event: rsvpEvent({ gateType: "PASSWORD" as never }),
        now: AFTER_REVEAL,
      };
      const locked = await listArrivalAreasForViewer(deps(gated), {
        eventId: EVENT_ID,
        viewerHumanId: VIEWER,
      });
      expect(locked.areas).toEqual([]);
      expectNoLocation(locked);
      const passed = await listArrivalAreasForViewer(deps(gated), {
        eventId: EVENT_ID,
        viewerHumanId: VIEWER,
        gateAccessGranted: true,
      });
      expect(ids(passed)).toEqual(["p-parking", "p-drop"]);
    });

    it("a withheld place that never vouched (community listing): nothing, even after the reveal", async () => {
      const out = await listArrivalAreasForViewer(
        deps({
          rsvp: true,
          place: makePlace({ acceptsCommunityListings: true }),
          event: rsvpEvent({ orgId: null, stewardship: "COMMUNITY" as never }),
          now: AFTER_REVEAL,
        }),
        { eventId: EVENT_ID, viewerHumanId: VIEWER },
      );
      expect(out.areas).toEqual([]);
      expectNoLocation(out);
    });

    it("stamp arm: the event's own reveal has passed but not the place's 24h floor: nothing", async () => {
      const out = await listArrivalAreasForViewer(
        deps({
          rsvp: true,
          event: rsvpEvent({
            orgId: THIRD_ORG,
            addressRevealAt: new Date(NOW.getTime() + DAY),
            venueConfirmedAt: new Date("2026-10-02T00:00:00.000Z"),
            venueConfirmedPlaceId: PLACE_ID,
          }),
          now: new Date(NOW.getTime() + 2 * DAY),
        }),
        { eventId: EVENT_ID, viewerHumanId: VIEWER },
      );
      expect(out.areas).toEqual([]);
      expectNoLocation(out);
    });

    it("the RSVP lookups are skipped when they cannot change the answer", async () => {
      const notAsked = (d: ReturnType<typeof deps>) => {
        const repos = d.repos as unknown as {
          eventRsvps: { existsForUser: ReturnType<typeof vi.fn> };
          eventDateRsvps: { existsForUserOnEvent: ReturnType<typeof vi.fn> };
        };
        expect(repos.eventRsvps.existsForUser).not.toHaveBeenCalled();
        expect(repos.eventDateRsvps.existsForUserOnEvent).not.toHaveBeenCalled();
      };
      // (a) no viewer
      const anon = deps({ rsvp: true, event: rsvpEvent(), now: AFTER_REVEAL });
      await listArrivalAreasForViewer(anon, { eventId: EVENT_ID });
      notAsked(anon);
      // (b) a gated event without the pass
      const gated = deps({
        rsvp: true,
        event: rsvpEvent({ gateType: "PASSWORD" as never }),
        now: AFTER_REVEAL,
      });
      await listArrivalAreasForViewer(gated, { eventId: EVENT_ID, viewerHumanId: VIEWER });
      notAsked(gated);
      // (c) a live ticket holder
      const holder = deps({ holder: true, rsvp: true, event: rsvpEvent(), now: AFTER_REVEAL });
      const held = await listArrivalAreasForViewer(holder, {
        eventId: EVENT_ID,
        viewerHumanId: VIEWER,
      });
      expect(ids(held)).toEqual(["p-parking", "p-drop"]);
      notAsked(holder);
      // (d) the address is public anyway
      const open = deps({
        rsvp: true,
        place: makePlace({ locationMode: "EXACT", locationRadiusMeters: null }),
        event: rsvpEvent({ locationMode: "EXACT" as never }),
      });
      const shown = await listArrivalAreasForViewer(open, {
        eventId: EVENT_ID,
        viewerHumanId: VIEWER,
      });
      expect(ids(shown)).toEqual(["p-parking", "p-drop"]);
      notAsked(open);
    });

    it("NEVER: nothing", async () => {
      const out = await listArrivalAreasForViewer(
        deps({
          rsvp: true,
          event: rsvpEvent({ addressRevealPreset: "NEVER" as never, addressRevealAt: null }),
          now: AFTER_REVEAL,
        }),
        { eventId: EVENT_ID, viewerHumanId: VIEWER },
      );
      expect(out.areas).toEqual([]);
      expectNoLocation(out);
    });
  });

  describe("acts on the bill", () => {
    it("owner arm, before the reveal: the address's areas and load-in", async () => {
      const out = await listArrivalAreasForViewer(deps({ lineup: [ACT_ROW] }), {
        eventId: EVENT_ID,
        viewerHumanId: VIEWER,
      });
      expect(ids(out)).toEqual(["p-parking", "p-drop", "p-load"]);
      expect(out.cacheablePublic).toBe(false);
    });

    it("B2: an act whose account has not verified its email gets only what anyone gets", async () => {
      const built = deps({ lineup: [ACT_ROW], viewerUnverified: true });
      const out = await listArrivalAreasForViewer(built, {
        eventId: EVENT_ID,
        viewerHumanId: VIEWER,
      });
      expect(out.areas).toEqual([]);
      expectNoLocation(out);
      expect(built.repos.humans.getByIdWithIdentity).toHaveBeenCalledWith(VIEWER);
      // Not a swallowed failure: the projection ran and answered "no grant".
      expect(built.reportError).not.toHaveBeenCalled();
    });

    it("B2: a viewer who is not on the bill costs no verification read", async () => {
      const built = deps({ lineup: [] });
      await listArrivalAreasForViewer(built, { eventId: EVENT_ID, viewerHumanId: VIEWER });
      expect(built.repos.humans.getByIdWithIdentity).not.toHaveBeenCalled();
    });

    it("after the event has ended: no load-in", async () => {
      const out = await listArrivalAreasForViewer(
        deps({ lineup: [ACT_ROW], now: new Date(NOW.getTime() + 9 * DAY) }),
        { eventId: EVENT_ID, viewerHumanId: VIEWER },
      );
      expect(ids(out)).toEqual(["p-parking", "p-drop"]);
    });

    it("HOST, DJ, INSTRUCTOR and SPEAKER count", async () => {
      for (const role of ["HOST", "DJ", "INSTRUCTOR", "SPEAKER"]) {
        const out = await listArrivalAreasForViewer(
          deps({ lineup: [{ humanId: VIEWER, orgId: null, role }] }),
          { eventId: EVENT_ID, viewerHumanId: VIEWER },
        );
        expect(ids(out)).toContain("p-load");
      }
    });

    it("VENDOR, VOLUNTEER, OTHER, group rows and free-text rows are not acts", async () => {
      const notActs = [
        { humanId: VIEWER, orgId: null, role: "VENDOR" },
        { humanId: VIEWER, orgId: null, role: "VOLUNTEER" },
        { humanId: VIEWER, orgId: null, role: "OTHER" },
        { humanId: null, orgId: VIEWER, role: "PERFORMER" },
        { humanId: null, orgId: null, role: "PERFORMER", externalName: VIEWER },
      ];
      for (const row of notActs) {
        const out = await listArrivalAreasForViewer(deps({ lineup: [row] }), {
          eventId: EVENT_ID,
          viewerHumanId: VIEWER,
        });
        expect(out.areas).toEqual([]);
        expectNoLocation(out);
      }
    });

    it("C1: a third party's event the place never vouched for gives the act nothing", async () => {
      const out = await listArrivalAreasForViewer(
        deps({ lineup: [ACT_ROW], event: makeEvent({ orgId: THIRD_ORG }) }),
        { eventId: EVENT_ID, viewerHumanId: VIEWER },
      );
      expect(out.areas).toEqual([]);
      expectNoLocation(out);
    });

    it("C1: an accepted community listing is not a vouch either", async () => {
      const out = await listArrivalAreasForViewer(
        deps({
          lineup: [ACT_ROW],
          place: makePlace({ acceptsCommunityListings: true }),
          event: makeEvent({ orgId: null, stewardship: "COMMUNITY" as never }),
        }),
        { eventId: EVENT_ID, viewerHumanId: VIEWER },
      );
      expect(out.areas).toEqual([]);
      expectNoLocation(out);
    });

    it("stamp arm, earlier than a day before the show: nothing", async () => {
      const out = await listArrivalAreasForViewer(
        deps({
          lineup: [ACT_ROW],
          event: makeEvent({
            orgId: THIRD_ORG,
            venueConfirmedAt: new Date("2026-10-02T00:00:00.000Z"),
            venueConfirmedPlaceId: PLACE_ID,
          }),
        }),
        { eventId: EVENT_ID, viewerHumanId: VIEWER },
      );
      expect(out.areas).toEqual([]);
      expectNoLocation(out);
    });

    it("stamp arm, inside the last day: the act gets load-in", async () => {
      const out = await listArrivalAreasForViewer(
        deps({
          lineup: [ACT_ROW],
          now: new Date(NOW.getTime() + 7 * DAY + HOUR),
          event: makeEvent({
            orgId: THIRD_ORG,
            venueConfirmedAt: new Date("2026-10-02T00:00:00.000Z"),
            venueConfirmedPlaceId: PLACE_ID,
          }),
        }),
        { eventId: EVENT_ID, viewerHumanId: VIEWER },
      );
      expect(ids(out)).toContain("p-load");
    });

    it("NEVER: nothing", async () => {
      const out = await listArrivalAreasForViewer(
        deps({
          lineup: [ACT_ROW],
          event: makeEvent({ addressRevealPreset: "NEVER" as never, addressRevealAt: null }),
        }),
        { eventId: EVENT_ID, viewerHumanId: VIEWER },
      );
      expect(out.areas).toEqual([]);
      expectNoLocation(out);
    });
  });

  describe("staff", () => {
    it("the place's managers see everything, load-in included, at an OBSCURED place", async () => {
      const out = await listArrivalAreasForViewer(deps({ placeStaff: true }), {
        eventId: EVENT_ID,
        viewerHumanId: VIEWER,
      });
      expect(ids(out)).toEqual(["p-parking", "p-drop", "p-load"]);
    });

    it("the event's editors at a withheld place they do not manage get nothing (C1)", async () => {
      const out = await listArrivalAreasForViewer(
        deps({ eventStaff: true, event: makeEvent({ orgId: THIRD_ORG }) }),
        { eventId: EVENT_ID, viewerHumanId: VIEWER },
      );
      expect(out.areas).toEqual([]);
      expectNoLocation(out);
    });

    it("the event's editors at an EXACT place, a show it never vouched for: the parking, not the place's load-in, but their own load-in rows", async () => {
      const out = await listArrivalAreasForViewer(
        deps({
          eventStaff: true,
          place: makePlace({ locationMode: "EXACT", locationRadiusMeters: null }),
          event: makeEvent({ orgId: THIRD_ORG, locationMode: "EXACT" as never }),
          eventAreas: EVENT_ONLY_LOAD_IN,
        }),
        { eventId: EVENT_ID, viewerHumanId: VIEWER },
      );
      expect(ids(out)).toEqual(["p-parking", "p-drop", "e-load"]);
    });

    it("Q3: the event's editors at a show the place OWNS get the place's load-in", async () => {
      const out = await listArrivalAreasForViewer(
        deps({
          eventStaff: true,
          place: makePlace({ locationMode: "EXACT", locationRadiusMeters: null }),
          event: makeEvent({ locationMode: "EXACT" as never }),
        }),
        { eventId: EVENT_ID, viewerHumanId: VIEWER },
      );
      expect(ids(out)).toEqual(["p-parking", "p-drop", "p-load"]);
      expect(out.cacheablePublic).toBe(false);
    });

    it("Q3: the event's editors at a show the EXACT place stamped get the place's load-in", async () => {
      const out = await listArrivalAreasForViewer(
        deps({
          eventStaff: true,
          place: makePlace({ locationMode: "EXACT", locationRadiusMeters: null }),
          event: makeEvent({
            orgId: THIRD_ORG,
            locationMode: "EXACT" as never,
            venueConfirmedAt: new Date("2026-10-02T00:00:00.000Z"),
            venueConfirmedPlaceId: PLACE_ID,
          }),
        }),
        { eventId: EVENT_ID, viewerHumanId: VIEWER },
      );
      expect(ids(out)).toEqual(["p-parking", "p-drop", "p-load"]);
    });

    it("Q3: an accepted community listing is no vouch: its editors get no place load-in", async () => {
      const out = await listArrivalAreasForViewer(
        deps({
          eventStaff: true,
          place: makePlace({
            locationMode: "EXACT",
            locationRadiusMeters: null,
            acceptsCommunityListings: true,
          }),
          event: makeEvent({
            orgId: null,
            stewardship: "COMMUNITY" as never,
            locationMode: "EXACT" as never,
          }),
        }),
        { eventId: EVENT_ID, viewerHumanId: VIEWER },
      );
      expect(ids(out)).toEqual(["p-parking", "p-drop"]);
    });

    it("Q3 keeps option A: an editor of the place's OWN show at a withheld place who cannot see its address gets nothing", async () => {
      const out = await listArrivalAreasForViewer(
        deps({ eventStaff: true, eventAreas: EVENT_ONLY_LOAD_IN }),
        { eventId: EVENT_ID, viewerHumanId: VIEWER },
      );
      expect(out.areas).toEqual([]);
      expectNoLocation(out);
    });

    it("Q3: editor AND holder at a stamped withheld place after the reveal: the place's load-in too", async () => {
      const out = await listArrivalAreasForViewer(
        deps({
          eventStaff: true,
          holder: true,
          now: new Date(NOW.getTime() + 7 * DAY + HOUR),
          event: makeEvent({
            orgId: THIRD_ORG,
            venueConfirmedAt: new Date("2026-10-02T00:00:00.000Z"),
            venueConfirmedPlaceId: PLACE_ID,
          }),
          eventAreas: EVENT_ONLY_LOAD_IN,
        }),
        { eventId: EVENT_ID, viewerHumanId: VIEWER },
      );
      expect(ids(out)).toEqual(["p-parking", "p-drop", "p-load", "e-load"]);
    });

    it("Q3: editor AND holder after the event has ended: no place load-in (it ends with the show, as an act's does)", async () => {
      const out = await listArrivalAreasForViewer(
        deps({
          eventStaff: true,
          holder: true,
          now: new Date(NOW.getTime() + 9 * DAY),
          event: makeEvent({
            orgId: THIRD_ORG,
            venueConfirmedAt: new Date("2026-10-02T00:00:00.000Z"),
            venueConfirmedPlaceId: PLACE_ID,
          }),
        }),
        { eventId: EVENT_ID, viewerHumanId: VIEWER },
      );
      expect(ids(out)).toEqual(["p-parking", "p-drop"]);
    });
  });

  describe("an editor who lists themselves as the act (Q3: the guard passes)", () => {
    it("owner-arm show: the place's load-in and their own load-in rows", async () => {
      const out = await listArrivalAreasForViewer(
        deps({ eventStaff: true, lineup: [ACT_ROW], eventAreas: EVENT_ONLY_LOAD_IN }),
        { eventId: EVENT_ID, viewerHumanId: VIEWER },
      );
      expect(ids(out)).toEqual(["p-parking", "p-drop", "p-load", "e-load"]);
    });

    it("an EXACT place's show it never vouched for: still no place load-in", async () => {
      const out = await listArrivalAreasForViewer(
        deps({
          eventStaff: true,
          lineup: [ACT_ROW],
          place: makePlace({ locationMode: "EXACT", locationRadiusMeters: null }),
          event: makeEvent({ orgId: THIRD_ORG, locationMode: "EXACT" as never }),
        }),
        { eventId: EVENT_ID, viewerHumanId: VIEWER },
      );
      expect(ids(out)).toEqual(["p-parking", "p-drop"]);
    });

    it("stamped show inside the last day: the place's load-in", async () => {
      const out = await listArrivalAreasForViewer(
        deps({
          eventStaff: true,
          lineup: [ACT_ROW],
          now: new Date(NOW.getTime() + 7 * DAY + HOUR),
          event: makeEvent({
            orgId: THIRD_ORG,
            venueConfirmedAt: new Date("2026-10-02T00:00:00.000Z"),
            venueConfirmedPlaceId: PLACE_ID,
          }),
        }),
        { eventId: EVENT_ID, viewerHumanId: VIEWER },
      );
      expect(ids(out)).toEqual(["p-parking", "p-drop", "p-load"]);
    });

    it("stamped show earlier than a day before: nothing (the address is not theirs yet)", async () => {
      const out = await listArrivalAreasForViewer(
        deps({
          eventStaff: true,
          lineup: [ACT_ROW],
          event: makeEvent({
            orgId: THIRD_ORG,
            venueConfirmedAt: new Date("2026-10-02T00:00:00.000Z"),
            venueConfirmedPlaceId: PLACE_ID,
          }),
        }),
        { eventId: EVENT_ID, viewerHumanId: VIEWER },
      );
      expect(out.areas).toEqual([]);
      expectNoLocation(out);
    });

    it("control: the same act who is NOT an editor gets the place's load-in", async () => {
      const out = await listArrivalAreasForViewer(deps({ lineup: [ACT_ROW] }), {
        eventId: EVENT_ID,
        viewerHumanId: VIEWER,
      });
      expect(ids(out)).toContain("p-load");
    });
  });

  describe("place load-in needs the place's vouch", () => {
    const exactPlace = makePlace({ locationMode: "EXACT", locationRadiusMeters: null });

    it("an act on a published show the EXACT place never vouched for: parking, no place load-in", async () => {
      const out = await listArrivalAreasForViewer(
        deps({
          lineup: [ACT_ROW],
          place: exactPlace,
          event: makeEvent({ orgId: THIRD_ORG, locationMode: "EXACT" as never }),
          eventAreas: EVENT_ONLY_LOAD_IN,
        }),
        { eventId: EVENT_ID, viewerHumanId: VIEWER },
      );
      expect(ids(out)).toEqual(["p-parking", "p-drop", "e-load"]);
    });

    it("a user's own DRAFT at an EXACT place, listing themselves as the act: no place load-in", async () => {
      const out = await listArrivalAreasForViewer(
        deps({
          lineup: [ACT_ROW],
          place: exactPlace,
          event: makeEvent({
            orgId: null,
            humanId: VIEWER,
            status: "DRAFT" as never,
            publishedAt: null,
            locationMode: "EXACT" as never,
          }),
        }),
        { eventId: EVENT_ID, viewerHumanId: VIEWER },
      );
      expect(ids(out)).toEqual(["p-parking", "p-drop"]);
      // A draft is never served from the public cache.
      expect(out.cacheablePublic).toBe(false);
    });

    it("an act on the place's own show after it has ended: no load-in of either kind", async () => {
      const out = await listArrivalAreasForViewer(
        deps({
          lineup: [ACT_ROW],
          now: new Date(NOW.getTime() + 9 * DAY),
          eventAreas: EVENT_ONLY_LOAD_IN,
        }),
        { eventId: EVENT_ID, viewerHumanId: VIEWER },
      );
      expect(ids(out)).toEqual(["p-parking", "p-drop"]);
    });
  });

  describe("FR-004 resolution", () => {
    const exactPlace = makePlace({ locationMode: "EXACT", locationRadiusMeters: null });
    const exactEvent = makeEvent({ locationMode: "EXACT" as never });

    it("an event's hide removes a place area for that event only", async () => {
      const world = { place: exactPlace, event: exactEvent, hides: ["p-parking"] };
      const onEvent = await listArrivalAreasForViewer(deps(world), { eventId: EVENT_ID });
      expect(ids(onEvent)).toEqual(["p-drop"]);
      expect(onEvent.cacheablePublic).toBe(true);
      const onPlace = await listArrivalAreasForViewer(deps(world), { placeId: PLACE_ID });
      expect(ids(onPlace)).toEqual(["p-parking", "p-drop"]);
    });

    it("event-only areas follow the place areas; switched-off ones never show", async () => {
      const out = await listArrivalAreasForViewer(
        deps({
          place: exactPlace,
          event: exactEvent,
          eventAreas: [
            area({ id: "e-on", kind: "PARKING", placeId: null, eventId: EVENT_ID }),
            area({ id: "e-off", kind: "PARKING", placeId: null, eventId: EVENT_ID, disabledAt: NOW }),
          ],
        }),
        { eventId: EVENT_ID },
      );
      expect(ids(out)).toEqual(["p-parking", "p-drop", "e-on"]);
      expect(out.areas[2]!.source).toBe("EVENT");
    });

    it("a hide id that is not one of the place's areas changes nothing", async () => {
      const out = await listArrivalAreasForViewer(
        deps({ place: exactPlace, event: exactEvent, hides: ["someone-elses"] }),
        { eventId: EVENT_ID },
      );
      expect(ids(out)).toEqual(["p-parking", "p-drop"]);
    });
  });

  describe("freeform-address events", () => {
    const eventOnly = [area({ id: "e-park", kind: "PARKING", placeId: null, eventId: EVENT_ID }),
      area({ id: "e-load", kind: "LOAD_IN", placeId: null, eventId: EVENT_ID })];

    it("an EXACT freeform event shows its parking to everyone", async () => {
      const out = await listArrivalAreasForViewer(
        deps({
          place: null,
          event: makeEvent({ placeId: null, locationMode: "EXACT" as never }),
          eventAreas: eventOnly,
        }),
        { eventId: EVENT_ID },
      );
      expect(ids(out)).toEqual(["e-park"]);
      expect(out.cacheablePublic).toBe(true);
    });

    it("an OBSCURED freeform event shows the public nothing, and its editors everything", async () => {
      const world = {
        place: null,
        event: makeEvent({ placeId: null }),
        eventAreas: eventOnly,
      };
      const pub = await listArrivalAreasForViewer(deps(world), { eventId: EVENT_ID });
      expect(pub.areas).toEqual([]);
      expectNoLocation(pub);
      const editor = await listArrivalAreasForViewer(deps({ ...world, eventStaff: true }), {
        eventId: EVENT_ID,
        viewerHumanId: VIEWER,
      });
      expect(ids(editor)).toEqual(["e-park", "e-load"]);
    });
  });

  describe("readability and gates", () => {
    const exact = {
      place: makePlace({ locationMode: "EXACT", locationRadiusMeters: null }),
      event: makeEvent({ locationMode: "EXACT" as never }),
    };

    it("a draft read by its editor is never cacheable", async () => {
      const out = await listArrivalAreasForViewer(
        deps({
          ...exact,
          event: makeEvent({
            locationMode: "EXACT" as never,
            status: "DRAFT" as never,
            publishedAt: null,
            orgId: null,
            humanId: VIEWER,
          }),
        }),
        { eventId: EVENT_ID, viewerHumanId: VIEWER },
      );
      expect(ids(out)).toEqual(["p-parking", "p-drop"]);
      expect(out.cacheablePublic).toBe(false);
    });

    it("a banned owner's event read by a holder is never cacheable", async () => {
      const out = await listArrivalAreasForViewer(
        deps({
          ...exact,
          holder: true,
          event: makeEvent({ locationMode: "EXACT" as never, ownerBanned: true } as never),
        }),
        { eventId: EVENT_ID, viewerHumanId: VIEWER },
      );
      expect(ids(out)).toEqual(["p-parking", "p-drop"]);
      expect(out.cacheablePublic).toBe(false);
    });

    it("a draft event shows a non-editor nothing", async () => {
      const out = await listArrivalAreasForViewer(
        deps({ ...exact, event: makeEvent({ locationMode: "EXACT" as never, status: "DRAFT" as never, publishedAt: null }) }),
        { eventId: EVENT_ID, viewerHumanId: VIEWER },
      );
      expect(out.areas).toEqual([]);
    });

    it("a gated event not passed shows the public nothing; passed shows it, not cacheable", async () => {
      const gated = { ...exact, event: makeEvent({ locationMode: "EXACT" as never, gateType: "PASSWORD" as never }) };
      const locked = await listArrivalAreasForViewer(deps(gated), { eventId: EVENT_ID });
      expect(locked.areas).toEqual([]);
      expect(locked.cacheablePublic).toBe(false);
      const passed = await listArrivalAreasForViewer(deps(gated), {
        eventId: EVENT_ID,
        gateAccessGranted: true,
      });
      expect(ids(passed)).toEqual(["p-parking", "p-drop"]);
      expect(passed.cacheablePublic).toBe(false);
    });

    it("a missing event gives nothing", async () => {
      const out = await listArrivalAreasForViewer(deps({ event: null }), { eventId: EVENT_ID });
      expect(out).toEqual({ areas: [], cacheablePublic: false });
    });

    it("an unreadable place row (gone) fails closed even for an act", async () => {
      const out = await listArrivalAreasForViewer(deps({ place: null, lineup: [ACT_ROW] }), {
        eventId: EVENT_ID,
        viewerHumanId: VIEWER,
      });
      expect(out.areas).toEqual([]);
    });
  });
});

// ── Fail closed and reported ────────────────────────────────────────────────

describe("listArrivalAreasForViewer — failures", () => {
  it("a repo failure returns no areas and is reported (deliberate swallow)", async () => {
    const d = deps({ failPlaceRead: true, place: makePlace({ locationMode: "EXACT" }) });
    const out = await listArrivalAreasForViewer(d, { placeId: PLACE_ID });
    expect(out).toEqual({ areas: [], cacheablePublic: false });
    expect(d.reportError).toHaveBeenCalledTimes(1);
    expect(d.reportError).toHaveBeenCalledWith(expect.any(Error), {
      tags: { useCase: "listArrivalAreasForViewer" },
      extra: { placeId: PLACE_ID },
    });
  });

  it("a throwing reporter does not change the (empty) result", async () => {
    const d = deps({
      failPlaceRead: true,
      reportError: () => {
        throw new Error("sentry down");
      },
    });
    await expect(
      listArrivalAreasForViewer(d, { eventId: EVENT_ID, viewerHumanId: VIEWER }),
    ).resolves.toEqual({ areas: [], cacheablePublic: false });
  });

  it("an authz failure fails closed too", async () => {
    const d = deps();
    (d.authz.canManagePlace as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("authz down"));
    const out = await listArrivalAreasForViewer(d, { placeId: PLACE_ID, viewerHumanId: VIEWER });
    expect(out).toEqual({ areas: [], cacheablePublic: false });
    expect(d.reportError).toHaveBeenCalledTimes(1);
  });

  it("never logs a shape or a Directions point (NFR-002)", async () => {
    const d = deps({ placeStaff: true });
    (d.repos.arrivalAreas.listForPlace as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      Object.assign(new Error("boom"), { rows: PLACE_AREAS.map((a) => a.id) }),
    );
    await listArrivalAreasForViewer(d, { placeId: PLACE_ID, viewerHumanId: VIEWER });
    const logged = JSON.stringify(d.logger.error.mock.calls.map((c) => [c[0], { ...(c[1] as object), err: undefined }]));
    expect(logged).toContain("arrival_areas.list_for_viewer_failed");
    expect(logged).not.toContain("36.18");
    expect(logged).not.toContain("coordinates");
  });

  it("refuses an input naming both or neither parent", async () => {
    await expect(listArrivalAreasForViewer(deps(), {})).rejects.toBeTruthy();
    await expect(
      listArrivalAreasForViewer(deps(), { placeId: PLACE_ID, eventId: EVENT_ID }),
    ).rejects.toBeTruthy();
  });
});

describe("listArrivalAreasForViewer — editor of an OBSCURED event at a public place (review round 1)", () => {
  it("sees the place's parking and drop-off and their own load-in, never the place's load-in", async () => {
    const out = await listArrivalAreasForViewer(
      deps({
        place: makePlace({ locationMode: "EXACT", locationRadiusMeters: null }),
        // A third party's event (the place has not vouched), OBSCURED itself.
        event: makeEvent({ orgId: THIRD_ORG, locationMode: "OBSCURED" }),
        eventAreas: EVENT_ONLY_LOAD_IN,
        eventStaff: true,
      }),
      { eventId: EVENT_ID, viewerHumanId: VIEWER },
    );
    expect(ids(out)).toEqual(["p-parking", "p-drop", "e-load"]);
    expect(out.cacheablePublic).toBe(false);
  });

  it("the anonymous public still gets nothing for that OBSCURED event", async () => {
    const out = await listArrivalAreasForViewer(
      deps({
        place: makePlace({ locationMode: "EXACT", locationRadiusMeters: null }),
        event: makeEvent({ orgId: THIRD_ORG, locationMode: "OBSCURED" }),
      }),
      { eventId: EVENT_ID },
    );
    expect(out.areas).toEqual([]);
  });
});
