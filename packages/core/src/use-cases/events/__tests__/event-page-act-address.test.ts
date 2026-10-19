import { describe, expect, it, vi } from "vitest";

import type { EventRecord } from "@th/ports/repos/events";

import { buildEventSeo } from "../_shared/build-event-seo";
import { getEventSeo, type GetEventSeoDeps } from "../get-event-seo";

/**
 * Acts on the bill on their own view of the event page (arrival-areas
 * FR-009): `buildEventSeo`'s `callerIsActOnBill` goes through
 * `resolveHolderAddress`'s act path, so an act sees the exact address from
 * the moment they are listed, behind the same place gates a holder is.
 */

const HOUSE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NOW = new Date("2026-01-15T00:00:00.000Z");

/** At a withheld house, its own reveal on 2026-01-31, starting 2026-02-01. */
const EVENT = {
  id: "event-1",
  slug: "basement-show",
  title: "Basement Show",
  status: "PUBLISHED",
  visibility: "PUBLIC",
  attendanceMode: "TICKETED",
  gateType: "NONE",
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

function seo(args: {
  arm: "owner" | "stamp" | "community" | null;
  callerIsActOnBill?: boolean;
  callerIsTicketHolder?: boolean;
  now?: Date;
}) {
  return buildEventSeo({
    event: EVENT,
    ticketTypes: [],
    eventHumans: [],
    now: args.now ?? NOW,
    callerIsTicketHolder: args.callerIsTicketHolder ?? false,
    callerIsActOnBill: args.callerIsActOnBill ?? false,
    place: {
      pageSlug: null,
      name: "The Shelby House",
      listedInDirectory: true,
      venueConfirmed: args.arm === "owner" || args.arm === "stamp",
      venueConfirmationArm: args.arm,
      locationMode: "OBSCURED",
      locationRadiusMeters: 2000,
      location: HOUSE_ROW,
    },
  });
}

function expectNoHouse(output: unknown) {
  const json = JSON.stringify(output);
  expect(json).not.toContain("Shelby Ave");
  expect(json).not.toContain("37206");
  expect(json).not.toContain("36.1775");
  expect(json).not.toContain("-86.7412");
}

describe("buildEventSeo — acts on the bill", () => {
  it("the place's own show: an act sees the exact address before the reveal date", () => {
    const location = seo({ arm: "owner", callerIsActOnBill: true }).location;
    expect(location).toMatchObject({
      isExact: true,
      addressLine1: "1417 Shelby Ave",
      postalCode: "37206",
      latitude: 36.1775,
      longitude: -86.7412,
    });
  });

  it("a holder at the same moment is still waiting (control)", () => {
    const output = seo({ arm: "owner", callerIsTicketHolder: true });
    expect(output.location?.isExact).toBe(false);
    expectNoHouse(output);
  });

  it("an anonymous viewer gets no address", () => {
    const output = seo({ arm: "owner" });
    expect(output.location?.isExact).toBe(false);
    expectNoHouse(output);
  });

  it("C1: a show the place never vouched for gives the act nothing", () => {
    for (const arm of ["community", null] as const) {
      const output = seo({ arm, callerIsActOnBill: true });
      expect(output.location?.isExact).toBe(false);
      expectNoHouse(output);
    }
  });

  it("stamp arm: an act a fortnight out is held to the 24h floor", () => {
    const output = seo({ arm: "stamp", callerIsActOnBill: true });
    expect(output.location?.isExact).toBe(false);
    expectNoHouse(output);
  });

  it("viewerAddressReleased: true only when a per-viewer rule released the address", () => {
    // The web viewer half keys on this to reveal the street to an act.
    expect(seo({ arm: "owner", callerIsActOnBill: true }).viewerAddressReleased).toBe(true);
    expect(seo({ arm: "owner", callerIsTicketHolder: true }).viewerAddressReleased).toBe(false);
    expect(seo({ arm: "owner" }).viewerAddressReleased).toBe(false);
    expect(seo({ arm: "community", callerIsActOnBill: true }).viewerAddressReleased).toBe(false);
  });

  it("viewerAddressReleased: a ticket holder past the reveal gets the street and the flag", () => {
    const output = seo({
      arm: "owner",
      callerIsTicketHolder: true,
      now: new Date("2026-01-31T19:00:00.000Z"),
    });
    expect(output.viewerAddressReleased).toBe(true);
    expect(JSON.stringify(output)).toContain("Shelby Ave");
  });

  it("viewerAddressReleased: false for an address that is public anyway", () => {
    const output = buildEventSeo({
      event: { ...EVENT, placeId: null, locationMode: "EXACT" } as unknown as EventRecord,
      ticketTypes: [],
      eventHumans: [],
      now: NOW,
      callerIsTicketHolder: true,
      callerIsActOnBill: true,
    });
    expect(output.location?.isExact).toBe(true);
    expect(output.viewerAddressReleased).toBe(false);
  });
});

// ── getEventSeo: the act path is behind the `arrivalAreas` gate (FR-017) ────

describe("getEventSeo — the act path ships behind the gate", () => {
  const VIEWER = "11111111-1111-4111-8111-111111111111";
  const OWNER_ORG = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a";
  const EVENT_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

  function seoDeps(
    actAddressEnabled?: boolean,
    opts: { viewerVerified?: boolean } = {},
  ): GetEventSeoDeps {
    const event = {
      ...EVENT,
      id: EVENT_ID,
      orgId: OWNER_ORG,
      humanId: null,
      stewardship: "OWNED",
      timezone: "America/Chicago",
      publishedAt: new Date("2026-01-01T00:00:00.000Z"),
      ownerBanned: false,
      heroImageKey: null,
      admissionTaxRateBps: null,
    } as unknown as EventRecord;
    const place = {
      ...HOUSE_ROW,
      name: "The Shelby House",
      status: "ACTIVE",
      listedInDirectory: false,
      orgIdsWithAccess: [OWNER_ORG],
      humanIdsWithAccess: [],
      acceptsCommunityListings: false,
    };
    return {
      repos: {
        events: {
          resolveBySlug: vi.fn(async () => ({ eventId: EVENT_ID, redirect: false })),
          getById: vi.fn(async () => event),
          listTicketTypes: vi.fn(async () => []),
        },
        eventHumans: {
          listByEvent: vi.fn(async () => [
            {
              id: "eh-1",
              eventId: EVENT_ID,
              humanId: VIEWER,
              orgId: null,
              externalName: null,
              externalUrl: null,
              role: "PERFORMER",
              customRoleLabel: null,
              sortOrder: 0,
              profileSlug: null,
              humanDisplayName: "The Act",
            },
          ]),
        },
        places: { getById: vi.fn(async () => place) },
        humans: {
          getByIdWithIdentity: vi.fn(async (id: string) => ({
            human: { id },
            identity: { emailVerified: opts.viewerVerified ?? true },
          })),
        },
        organizations: { getById: vi.fn(async () => null) },
        entityPages: { getByOwner: vi.fn(async () => null) },
        tickets: { viewerHoldsActiveTicketForEvent: vi.fn(async () => false) },
        eventRsvps: { existsForUser: vi.fn(async () => false) },
        eventDateRsvps: { existsForUserOnEvent: vi.fn(async () => false) },
        authz: {
          getOrgMembership: vi.fn(async () => null),
          getHumanDelegation: vi.fn(async () => null),
        },
      },
      authz: { hasStaffRole: vi.fn(async () => ({ allowed: false })) },
      clock: { now: () => NOW },
      ...(actAddressEnabled === undefined ? {} : { actAddressEnabled }),
    } as unknown as GetEventSeoDeps;
  }

  it("default (gate off): an act on the bill sees no address", async () => {
    const output = await getEventSeo(seoDeps(), { slug: "basement-show", viewerHumanId: VIEWER });
    expect(output.location?.isExact).toBe(false);
    expectNoHouse(output);
  });

  it("explicitly off: the same", async () => {
    const output = await getEventSeo(seoDeps(false), {
      slug: "basement-show",
      viewerHumanId: VIEWER,
    });
    expectNoHouse(output);
  });

  it("gate on: the act sees the place's address", async () => {
    const output = await getEventSeo(seoDeps(true), {
      slug: "basement-show",
      viewerHumanId: VIEWER,
    });
    expect(output.location).toMatchObject({
      isExact: true,
      addressLine1: "1417 Shelby Ave",
      postalCode: "37206",
    });
    expect(output.viewerAddressReleased).toBe(true);
  });

  it("B2: gate on, the act's account has not verified its email: no address", async () => {
    const deps = seoDeps(true, { viewerVerified: false });
    const output = await getEventSeo(deps, {
      slug: "basement-show",
      viewerHumanId: VIEWER,
    });
    expect(output.location?.isExact).toBe(false);
    expectNoHouse(output);
    expect(deps.repos.humans.getByIdWithIdentity).toHaveBeenCalledWith(VIEWER);
  });

  it("gate on, anonymous: no address", async () => {
    const output = await getEventSeo(seoDeps(true), { slug: "basement-show" });
    expectNoHouse(output);
  });
});
