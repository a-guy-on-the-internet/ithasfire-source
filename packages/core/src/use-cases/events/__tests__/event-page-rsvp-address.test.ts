import { describe, expect, it, vi } from "vitest";

import type { EventRecord } from "@th/ports/repos/events";

import { buildEventSeo } from "../_shared/build-event-seo";
import { getEventSeo, type GetEventSeoDeps } from "../get-event-seo";

/**
 * RSVP-ers on their own view of the event page (arrival-areas owner ruling
 * Q16, 2026-10-17: "Yes, like holders"). A live RSVP counts as
 * `resolveHolderAddress`'s `activeHolder`, so the street arrives on the
 * holder's schedule and behind the same place gates, through the ONE
 * predicate `viewerHoldsLiveRsvp` (lib/location/holder-eligibility.ts).
 * Not behind the `arrivalAreas` gate.
 */

const HOUSE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const VIEWER = "11111111-1111-4111-8111-111111111111";
const OWNER_ORG = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a";
const EVENT_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const BEFORE_REVEAL = new Date("2026-01-15T00:00:00.000Z");
const AFTER_REVEAL = new Date("2026-01-31T19:00:00.000Z");

/** An RSVP listing at a withheld house, its own reveal on 2026-01-31. */
const EVENT = {
  id: EVENT_ID,
  slug: "basement-show",
  title: "Basement Show",
  status: "PUBLISHED",
  visibility: "PUBLIC",
  attendanceMode: "RSVP",
  gateType: "NONE",
  orgId: OWNER_ORG,
  humanId: null,
  stewardship: "OWNED",
  timezone: "America/Chicago",
  publishedAt: new Date("2026-01-01T00:00:00.000Z"),
  ownerBanned: false,
  heroImageKey: null,
  admissionTaxRateBps: null,
  startsAt: new Date("2026-02-01T18:00:00.000Z"),
  endsAt: new Date("2026-02-01T23:00:00.000Z"),
  placeId: HOUSE_ID,
  addressText: "East Nashville",
  locality: "Nashville",
  region: "TN",
  postalCode: null,
  countryCode: "US",
  lat: 36.18,
  lng: -86.75,
  locationMode: "OBSCURED",
  locationRadiusMeters: 2000,
  locationLabel: "East Nashville",
  addressRevealPreset: "DAY_BEFORE",
  addressRevealAt: new Date("2026-01-31T18:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
} as unknown as EventRecord;

const HOUSE_ROW = {
  id: HOUSE_ID,
  locationMode: "OBSCURED" as const,
  locationRadiusMeters: 2000,
  formattedAddress: "1417 Shelby Ave",
  city: "Nashville",
  region: "TN",
  postalCode: "37206",
  countryCode: "US",
  lat: 36.1775,
  lng: -86.7412,
};

function expectNoHouse(output: unknown) {
  const json = JSON.stringify(output);
  expect(json).not.toContain("Shelby Ave");
  expect(json).not.toContain("37206");
  expect(json).not.toContain("36.1775");
  expect(json).not.toContain("-86.7412");
}

type World = {
  now: Date;
  /** The viewer's event-level RSVP row exists (cancelling deletes it). */
  rsvp?: boolean;
  /** The status of the one night the viewer RSVP'd to (recurring listing). */
  dateRsvp?: "SCHEDULED" | "CANCELLED";
  ticket?: boolean;
  arm?: "owner" | "community";
  event?: Partial<EventRecord>;
};

function deps(world: World) {
  const event = { ...EVENT, ...world.event } as EventRecord;
  const place = {
    ...HOUSE_ROW,
    name: "The Shelby House",
    status: "ACTIVE",
    listedInDirectory: false,
    orgIdsWithAccess: world.arm === "community" ? [] : [OWNER_ORG],
    humanIdsWithAccess: [],
    acceptsCommunityListings: world.arm === "community",
  };
  const existsForUser = vi.fn(
    async (input: { eventId: string; humanId: string }) =>
      input.eventId === EVENT_ID && input.humanId === VIEWER && world.rsvp === true,
  );
  const existsForUserOnEvent = vi.fn(
    async (input: { eventId: string; humanId: string; dateStatus?: string }) =>
      input.eventId === EVENT_ID &&
      input.humanId === VIEWER &&
      world.dateRsvp !== undefined &&
      (input.dateStatus === undefined || input.dateStatus === world.dateRsvp),
  );
  const viewerHoldsActiveTicketForEvent = vi.fn(async () => world.ticket === true);
  const d = {
    repos: {
      events: {
        resolveBySlug: vi.fn(async () => ({ eventId: EVENT_ID, redirect: false })),
        getById: vi.fn(async () => event),
        listTicketTypes: vi.fn(async () => []),
      },
      eventHumans: { listByEvent: vi.fn(async () => []) },
      places: { getById: vi.fn(async () => place) },
      organizations: { getById: vi.fn(async () => null) },
      entityPages: { getByOwner: vi.fn(async () => null) },
      tickets: { viewerHoldsActiveTicketForEvent },
      eventRsvps: { existsForUser },
      eventDateRsvps: { existsForUserOnEvent },
      authz: {
        getOrgMembership: vi.fn(async () => null),
        getHumanDelegation: vi.fn(async () => null),
      },
    },
    authz: { hasStaffRole: vi.fn(async () => ({ allowed: false })) },
    clock: { now: () => world.now },
    // The arrivalAreas gate stays OFF: Q16 does not ride it.
  } as unknown as GetEventSeoDeps;
  return { deps: d, existsForUser, existsForUserOnEvent, viewerHoldsActiveTicketForEvent };
}

/** `viewer: null` reads anonymously. */
const read = (d: GetEventSeoDeps, viewer: string | null = VIEWER) =>
  getEventSeo(d, { slug: "basement-show", ...(viewer ? { viewerHumanId: viewer } : {}) });

describe("getEventSeo — an RSVP-er gets the street like a holder (owner Q16)", () => {
  it("before the reveal: an RSVP-er gets no street", async () => {
    const output = await read(deps({ now: BEFORE_REVEAL, rsvp: true }).deps);
    expect(output.location?.isExact).toBe(false);
    expect(output.viewerAddressReleased).toBe(false);
    expectNoHouse(output);
  });

  it("after the reveal: an RSVP-er gets the street and the release flag, never the ticket flag", async () => {
    const output = await read(deps({ now: AFTER_REVEAL, rsvp: true }).deps);
    expect(output.location).toMatchObject({
      isExact: true,
      addressLine1: "1417 Shelby Ave",
      postalCode: "37206",
      latitude: 36.1775,
      longitude: -86.7412,
    });
    expect(output.viewerAddressReleased).toBe(true);
    expect(output.viewerHasTicket).toBe(false);
    expect(output.viewerRsvped).toBe(true);
  });

  it("a cancelled RSVP (the row is deleted) gets no street after the reveal", async () => {
    const output = await read(deps({ now: AFTER_REVEAL, rsvp: false }).deps);
    expect(output.location?.isExact).toBe(false);
    expect(output.viewerAddressReleased).toBe(false);
    expectNoHouse(output);
  });

  it("a CANCELLED event releases nothing to an RSVP-er (its RSVP rows survive the cancel), and reads no RSVP night", async () => {
    for (const who of [{ rsvp: true }, { dateRsvp: "SCHEDULED" as const }]) {
      const world = deps({
        now: AFTER_REVEAL,
        event: { status: "CANCELLED" } as Partial<EventRecord>,
        ...who,
      });
      const output = await read(world.deps);
      expect(output.location?.isExact).toBe(false);
      expect(output.viewerAddressReleased).toBe(false);
      expectNoHouse(output);
      expect(world.existsForUserOnEvent).not.toHaveBeenCalled();
    }
  });

  it("reads the viewer's event RSVP once: the I'm-going state and the address check share it", async () => {
    const world = deps({ now: AFTER_REVEAL, rsvp: true });
    const output = await read(world.deps);
    expect(output.viewerRsvped).toBe(true);
    expect(output.location?.isExact).toBe(true);
    expect(world.existsForUser).toHaveBeenCalledTimes(1);

    const none = deps({ now: AFTER_REVEAL, dateRsvp: "SCHEDULED" });
    await read(none.deps);
    expect(none.existsForUser).toHaveBeenCalledTimes(1);
    expect(none.existsForUserOnEvent).toHaveBeenCalledTimes(1);
  });

  it("an anonymous viewer gets no street after the reveal, and no RSVP lookup runs", async () => {
    const world = deps({ now: AFTER_REVEAL, rsvp: true });
    const output = await read(world.deps, null);
    expectNoHouse(output);
    expect(output.viewerAddressReleased).toBe(false);
    expect(world.existsForUser).not.toHaveBeenCalled();
    expect(world.existsForUserOnEvent).not.toHaveBeenCalled();
  });

  it("a per-night RSVP on a SCHEDULED night counts; one on a called-off night does not", async () => {
    const scheduled = await read(deps({ now: AFTER_REVEAL, dateRsvp: "SCHEDULED" }).deps);
    expect(scheduled.location).toMatchObject({ isExact: true, addressLine1: "1417 Shelby Ave" });

    const calledOff = deps({ now: AFTER_REVEAL, dateRsvp: "CANCELLED" });
    const output = await read(calledOff.deps);
    expectNoHouse(output);
    expect(calledOff.existsForUserOnEvent).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      humanId: VIEWER,
      dateStatus: "SCHEDULED",
    });
  });

  it("the place's gates hold: at a show the house never vouched for, an RSVP-er gets nothing, as a holder does", async () => {
    for (const who of [{ rsvp: true }, { ticket: true }]) {
      const output = await read(
        deps({
          now: AFTER_REVEAL,
          arm: "community",
          event: { orgId: null, stewardship: "COMMUNITY" } as Partial<EventRecord>,
          ...who,
        }).deps,
      );
      expectNoHouse(output);
    }
  });

  it("a ticket holder skips the RSVP lookup (it adds nothing)", async () => {
    const world = deps({ now: AFTER_REVEAL, ticket: true });
    const output = await read(world.deps);
    expect(output.viewerHasTicket).toBe(true);
    expect(output.location?.isExact).toBe(true);
    expect(world.existsForUserOnEvent).not.toHaveBeenCalled();
  });

  it("an EXACT event runs no holder or RSVP lookup at all", async () => {
    const world = deps({
      now: BEFORE_REVEAL,
      rsvp: true,
      event: { placeId: null, locationMode: "EXACT" } as Partial<EventRecord>,
    });
    await read(world.deps);
    expect(world.viewerHoldsActiveTicketForEvent).not.toHaveBeenCalled();
    expect(world.existsForUserOnEvent).not.toHaveBeenCalled();
  });
});

describe("buildEventSeo — callerHoldsLiveRsvp", () => {
  const place = {
    pageSlug: null,
    name: "The Shelby House",
    listedInDirectory: true,
    venueConfirmed: true,
    venueConfirmationArm: "owner" as const,
    locationMode: "OBSCURED" as const,
    locationRadiusMeters: 2000,
    location: HOUSE_ROW,
  };
  it("unlocks on the holder schedule and never claims a ticket", () => {
    const before = buildEventSeo({
      event: EVENT,
      ticketTypes: [],
      eventHumans: [],
      now: BEFORE_REVEAL,
      callerHoldsLiveRsvp: true,
      place,
    });
    expectNoHouse(before);
    const after = buildEventSeo({
      event: EVENT,
      ticketTypes: [],
      eventHumans: [],
      now: AFTER_REVEAL,
      callerHoldsLiveRsvp: true,
      place,
    });
    expect(after.location).toMatchObject({ isExact: true, addressLine1: "1417 Shelby Ave" });
    expect(after.viewerAddressReleased).toBe(true);
    expect(after.viewerHasTicket).toBe(false);
  });
});
