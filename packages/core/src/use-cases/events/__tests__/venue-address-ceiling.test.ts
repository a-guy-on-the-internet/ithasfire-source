import { describe, expect, it, vi } from "vitest";

import type { EventRecord } from "@th/ports/repos/events";
import type { PlaceRecord } from "@th/ports/repos/places";
import {
  DEFAULT_ACTOR_ID,
  DEFAULT_ORG_ID,
  DEFAULT_PLACE_ID,
  makeCreateEventTestContext,
} from "@th/test-utils";

import { redactPlaceLocation } from "../../../lib/location/redact-place-location";
import { buildEventSeo } from "../_shared/build-event-seo";
import { resolveAddressReveal } from "../_shared/save-event-shared";
import { saveEventForOrg } from "../save-event-for-org";

/**
 * THE HARD CEILING (place-address-withholding).
 *
 * An event whose location resolves from a Place inherits that Place's
 * obscurity as a FLOOR. An event at an OBSCURED venue is OBSCURED, whatever it
 * requested — by mistake, by direct API call, or by being created before the
 * venue was ever withheld.
 *
 * The organiser-facing UI lock is a courtesy. These tests pin the guarantee:
 * the SERVER rule, enforced on write (`save-event-shared`) and re-applied on
 * read (`buildEventSeo`) against the venue's CURRENT state.
 */

const WITHHELD_HOUSE_ID = DEFAULT_PLACE_ID;

function makePlace(overrides: Partial<PlaceRecord> = {}): PlaceRecord {
  return {
    id: WITHHELD_HOUSE_ID,
    name: "The Shelby House",
    slug: null,
    createdAt: new Date("2024-01-01T00:00:00.000Z"),
    updatedAt: new Date("2024-01-01T00:00:00.000Z"),
    formattedAddress: "1417 Shelby Ave, Nashville, TN 37206",
    addressLine1: "1417 Shelby Ave",
    addressLine2: null,
    city: "Nashville",
    region: "TN",
    postalCode: "37206",
    countryCode: "US",
    capacity: 60,
    lat: 36.1775,
    lng: -86.7412,
    phone: null,
    website: null,
    websiteSource: "UNKNOWN",
    addressHash: null,
    admissionTaxRateBps: null,
    taxRateSource: null,
    taxRateFetchedAt: null,
    timezone: "America/Chicago",
    status: "ACTIVE",
    verificationStatus: "VERIFIED",
    listedInDirectory: true,
    acceptsBookingRequests: false,
    acceptsCommunityListings: false,
    attendeeReviewsPublic: false,
    // WITHHELD, fully hidden: no public map at all.
    locationMode: "OBSCURED",
    locationRadiusMeters: null,
    locationLabel: "East Nashville",
    orgIdsWithAccess: [DEFAULT_ORG_ID],
    humanIdsWithAccess: [DEFAULT_ACTOR_ID],
    defaultPrimaryPayoutTermsId: null,
    defaultResalePayoutTermsId: null,
    ...overrides,
  } as unknown as PlaceRecord;
}

function persistedDraft(upsertDraft: unknown): {
  locationMode?: string;
  locationRadiusMeters?: number | null;
  addressRevealAt?: Date | null;
  addressRevealPreset?: string | null;
} {
  const calls = vi.mocked(upsertDraft as never).mock.calls as unknown as Array<
    [Record<string, unknown>]
  >;
  expect(calls.length).toBeGreaterThan(0);
  return calls[0]![0] as never;
}

function makeOrgInput(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    actorHumanId: DEFAULT_ACTOR_ID,
    orgId: DEFAULT_ORG_ID,
    title: "Basement Show",
    startsAt: "2026-02-01T18:00:00.000Z",
    endsAt: "2026-02-01T23:00:00.000Z",
    location: { placeId: WITHHELD_HOUSE_ID },
    clientKey: "idem-key-ceiling-1",
    ...overrides,
  };
}

// ── WRITE: save-event-shared ────────────────────────────────────────────────

describe("the ceiling on WRITE — save-event-shared", () => {
  it("stores OBSCURED for an event that asked for EXACT at an obscured place", async () => {
    const { deps, mocks } = makeCreateEventTestContext({ place: makePlace() });

    await saveEventForOrg(
      deps,
      makeOrgInput({ locationMode: "EXACT", locationRadiusMeters: 500 }),
    );

    const draft = persistedDraft(mocks.events.upsertDraft);
    expect(draft.locationMode).toBe("OBSCURED");
    // The venue publishes NO map, so neither does the event.
    expect(draft.locationRadiusMeters).toBeNull();
  });

  it("widens a tighter requested circle up to the venue's", async () => {
    const { deps, mocks } = makeCreateEventTestContext({
      place: makePlace({ locationRadiusMeters: 2000 }),
    });

    await saveEventForOrg(
      deps,
      makeOrgInput({ locationMode: "EXACT", locationRadiusMeters: 100 }),
    );

    const draft = persistedDraft(mocks.events.upsertDraft);
    expect(draft.locationMode).toBe("OBSCURED");
    expect(draft.locationRadiusMeters).toBe(2000);
  });

  it("assigns a reveal schedule to the clamped event so ticket holders are not stranded", async () => {
    const { deps, mocks } = makeCreateEventTestContext({
      place: makePlace({ locationRadiusMeters: 2000 }),
    });

    await saveEventForOrg(deps, makeOrgInput({ locationMode: "EXACT" }));

    const draft = persistedDraft(mocks.events.upsertDraft);
    // Clamping to OBSCURED runs `resolveAddressReveal` with the EFFECTIVE mode,
    // so the event gets the spec default rather than the EXACT-mode null that
    // would have locked it forever.
    expect(draft.addressRevealPreset).toBe("DAY_BEFORE");
    expect(draft.addressRevealAt).toBeInstanceOf(Date);
  });

  it("leaves an EXACT request alone at a venue that publishes its address", async () => {
    const { deps, mocks } = makeCreateEventTestContext({
      place: makePlace({
        locationMode: "EXACT",
        locationRadiusMeters: null,
        locationLabel: null,
      }),
    });

    await saveEventForOrg(deps, makeOrgInput({ locationMode: "EXACT" }));

    const draft = persistedDraft(mocks.events.upsertDraft);
    expect(draft.locationMode).toBe("EXACT");
  });

  it("leaves an EXACT freeform event alone — the ceiling is a VENUE rule", async () => {
    const { deps, mocks } = makeCreateEventTestContext({ place: makePlace() });

    await saveEventForOrg(
      deps,
      makeOrgInput({
        locationMode: "EXACT",
        location: { addressText: "123 Main St", lat: 40.71, lng: -73.98 },
      }),
    );

    expect(persistedDraft(mocks.events.upsertDraft).locationMode).toBe("EXACT");
  });
});

// ── READ: build-event-seo ───────────────────────────────────────────────────

const EVENT_AT_HOUSE = {
  id: "event-1",
  slug: "basement-show",
  title: "Basement Show",
  status: "PUBLISHED",
  visibility: "PUBLIC",
  attendanceMode: "TICKETED",
  startsAt: new Date("2026-02-01T18:00:00.000Z"),
  endsAt: new Date("2026-02-01T23:00:00.000Z"),
  placeId: WITHHELD_HOUSE_ID,
  addressText: "1417 Shelby Ave, Nashville, TN 37206",
  locality: "Nashville",
  region: "TN",
  postalCode: "37206",
  countryCode: "US",
  lat: 36.1775,
  lng: -86.7412,
  // The row still says EXACT: this event was published BEFORE the house was
  // withheld. That is the case the read-time ceiling exists for.
  locationMode: "EXACT",
  locationRadiusMeters: null,
  locationLabel: null,
  addressRevealAt: null,
  addressRevealPreset: null,
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
} as unknown as EventRecord;

const WITHHELD_PLACE_ARG = {
  pageSlug: "shelby-house-a1b2c3d4",
  name: "The Shelby House",
  listedInDirectory: true,
  venueConfirmed: true,
  // Confirmed as the venue's own show. The C1 block below overrides it.
  venueConfirmationArm: "owner" as "owner" | "stamp" | "community" | null,
  locationMode: "OBSCURED" as const,
  locationRadiusMeters: null,
};

function seo(overrides: {
  event?: Partial<EventRecord>;
  place?: Partial<typeof WITHHELD_PLACE_ARG> | null;
  callerIsTicketHolder?: boolean;
  now?: Date;
}) {
  return buildEventSeo({
    event: { ...EVENT_AT_HOUSE, ...overrides.event } as EventRecord,
    ticketTypes: [],
    eventHumans: [],
    now: overrides.now ?? new Date("2026-01-15T00:00:00.000Z"),
    callerIsTicketHolder: overrides.callerIsTicketHolder ?? false,
    place:
      overrides.place === null
        ? null
        : { ...WITHHELD_PLACE_ARG, ...overrides.place },
  });
}

describe("the ceiling on READ — buildEventSeo", () => {
  it("renders an ALREADY-PUBLISHED exact event as fully hidden once its venue is withheld", () => {
    const location = seo({}).location;

    expect(location?.isExact).toBe(false);
    expect(location).toMatchObject({ hidden: true });
    expect(location?.addressLine1).toBeNull();
    expect(location?.postalCode).toBeNull();
    expect(location?.latitude).toBeNull();
    expect(location?.longitude).toBeNull();
    // And the venue is not NAMED either — a recognizable name plus a directory
    // is a de-facto address.
    expect(location?.name).toBeNull();
    expect(location?.placeSlug).toBeUndefined();
  });

  it("does not leak the street address on the coordinate-less branch either", () => {
    const location = seo({
      event: { lat: null, lng: null } as Partial<EventRecord>,
    }).location;

    expect(location?.isExact).toBe(false);
    expect(location?.addressLine1).toBeNull();
    expect(location?.city).toBeNull();
    expect(location?.postalCode).toBeNull();
  });

  it("downgrades a sharp event pin to the VENUE's keyed circle, never the true point", () => {
    const venueRow = {
      id: WITHHELD_HOUSE_ID,
      locationMode: "OBSCURED" as const,
      locationRadiusMeters: 2000,
      lat: 36.1775,
      lng: -86.7412,
      city: "Nashville",
      region: "TN",
    };
    const location = seo({
      place: {
        locationRadiusMeters: 2000,
        location: venueRow,
      } as Partial<typeof WITHHELD_PLACE_ARG>,
    }).location;

    expect(location?.isExact).toBe(false);
    expect(location).toMatchObject({ radiusMeters: 2000 });
    expect(location?.latitude).not.toBe(36.1775);
    expect(location?.longitude).not.toBe(-86.7412);
    expect(location?.addressLine1).toBeNull();
    // The stale row is not trusted for position: the centre IS the venue's
    // own public circle, the one every other surface draws.
    const venueCircle = redactPlaceLocation(venueRow);
    expect(location?.latitude).toBe(venueCircle.lat);
    expect(location?.longitude).toBe(venueCircle.lng);
  });

  it("a ticket holder past the reveal gets the VENUE's address — the event row holds only its projection", () => {
    const venueRow = {
      id: WITHHELD_HOUSE_ID,
      locationMode: "OBSCURED" as const,
      locationRadiusMeters: 2000,
      formattedAddress: "1417 Shelby Ave, Nashville, TN 37206",
      city: "Nashville",
      region: "TN",
      postalCode: "37206",
      countryCode: "US",
      lat: 36.1775,
      lng: -86.7412,
    };
    const publicCentre = redactPlaceLocation(venueRow);
    const location = seo({
      // What the write path stores at a withheld venue: the public projection.
      event: {
        locationMode: "OBSCURED",
        locationRadiusMeters: 2000,
        addressText: "East Nashville",
        postalCode: null,
        lat: publicCentre.lat,
        lng: publicCentre.lng,
        addressRevealPreset: "DAY_BEFORE",
        addressRevealAt: new Date("2020-01-01T00:00:00.000Z"),
      } as Partial<EventRecord>,
      place: {
        locationRadiusMeters: 2000,
        location: venueRow,
      } as Partial<typeof WITHHELD_PLACE_ARG>,
      callerIsTicketHolder: true,
    }).location;

    expect(location).toMatchObject({
      isExact: true,
      addressLine1: "1417 Shelby Ave, Nashville, TN 37206",
      postalCode: "37206",
      latitude: 36.1775,
      longitude: -86.7412,
    });
  });

  it("without the venue's row (flat privacy fields only) a withheld venue fails closed to hidden", () => {
    const location = seo({
      place: { locationRadiusMeters: 2000 },
    }).location;

    expect(location?.isExact).toBe(false);
    expect(location).toMatchObject({ hidden: true, latitude: null });
    expect(location?.addressLine1).toBeNull();
  });

  it("publishes the exact address when the venue does NOT withhold it", () => {
    const location = seo({
      place: { locationMode: "EXACT" },
    }).location;

    expect(location?.isExact).toBe(true);
    expect(location?.addressLine1).toBe("1417 Shelby Ave, Nashville, TN 37206");
  });

  it("FAILS CLOSED on a place argument with no locationMode at all", () => {
    const location = seo({
      place: { locationMode: undefined as never },
    }).location;

    expect(location?.isExact).toBe(false);
    expect(location?.addressLine1).toBeNull();
  });
});

// ── NEVER: a legitimate "never reveal" state ────────────────────────────────

describe("NEVER — never-reveal is a choice, and it is permanent", () => {
  it("resolves a NULL reveal date, stored alongside the NEVER preset", () => {
    expect(
      resolveAddressReveal({
        locationMode: "OBSCURED",
        startsAt: new Date("2026-02-01T18:00:00.000Z"),
        preset: "NEVER",
        addressRevealAt: null,
        existingEvent: null,
        now: new Date("2026-01-01T00:00:00.000Z"),
      }),
    ).toEqual({ preset: "NEVER", at: null });
  });

  it("ignores a caller-supplied date — NEVER means never", () => {
    expect(
      resolveAddressReveal({
        locationMode: "OBSCURED",
        startsAt: new Date("2026-02-01T18:00:00.000Z"),
        preset: "NEVER",
        addressRevealAt: new Date("2026-01-02T00:00:00.000Z"),
        existingEvent: null,
        now: new Date("2026-01-01T00:00:00.000Z"),
      }).at,
    ).toBeNull();
  });

  const NEVER_EVENT = {
    ...EVENT_AT_HOUSE,
    locationMode: "OBSCURED",
    locationRadiusMeters: null,
    addressRevealPreset: "NEVER",
    addressRevealAt: null,
  } as unknown as EventRecord;

  it("stays LOCKED for a TICKET HOLDER, past any date", () => {
    const originalNow = Date.now;
    try {
      // A decade after the show. `buildEventSeo` reads `new Date()` for the
      // reveal comparison, so move the wall clock rather than the `now` param.
      Date.now = () => new Date("2036-02-01T18:00:00.000Z").getTime();

      const location = buildEventSeo({
        event: NEVER_EVENT,
        ticketTypes: [],
        eventHumans: [],
        now: new Date("2036-02-01T18:00:00.000Z"),
        callerIsTicketHolder: true,
        place: { ...WITHHELD_PLACE_ARG, locationMode: "EXACT" },
      }).location;

      expect(location?.isExact).toBe(false);
      expect(location).toMatchObject({ hidden: true });
      expect(location?.addressLine1).toBeNull();
      expect(location?.latitude).toBeNull();
    } finally {
      Date.now = originalNow;
    }
  });

  it("stays LOCKED for a ticket holder on the coordinate-less branch too", () => {
    const location = buildEventSeo({
      event: { ...NEVER_EVENT, lat: null, lng: null } as EventRecord,
      ticketTypes: [],
      eventHumans: [],
      now: new Date("2036-02-01T18:00:00.000Z"),
      callerIsTicketHolder: true,
      place: { ...WITHHELD_PLACE_ARG, locationMode: "EXACT" },
    }).location;

    expect(location?.isExact).toBe(false);
    expect(location?.addressLine1).toBeNull();
  });
});

// ── C1: the holder reveal needs the VENUE's word, and the page promises
// only the date the gate will keep ──────────────────────────────────────────

describe("buildEventSeo — who a withheld venue releases its address to (C1)", () => {
  const venueRow = {
    id: WITHHELD_HOUSE_ID,
    locationMode: "OBSCURED" as const,
    locationRadiusMeters: 2000,
    formattedAddress: "1417 Shelby Ave, Nashville, TN 37206",
    city: "Nashville",
    region: "TN",
    postalCode: "37206",
    countryCode: "US",
    lat: 36.1775,
    lng: -86.7412,
  };
  /** Revealed IMMEDIATELY long ago; starts 2026-02-01T18:00Z. */
  const revealedProjection = {
    locationMode: "OBSCURED",
    locationRadiusMeters: 2000,
    addressText: "East Nashville",
    postalCode: null,
    addressRevealPreset: "IMMEDIATELY",
    addressRevealAt: new Date("2020-01-01T00:00:00.000Z"),
  } as Partial<EventRecord>;

  function holderView(
    venueConfirmationArm: "owner" | "stamp" | "community" | null,
    now?: Date,
  ) {
    return seo({
      event: revealedProjection,
      place: { locationRadiusMeters: 2000, location: venueRow, venueConfirmationArm } as never,
      callerIsTicketHolder: true,
      ...(now ? { now } : {}),
    });
  }

  it.each([null, "community"] as const)(
    "arm %j: a ticket holder gets no street, no postcode, no true point",
    (arm) => {
      const out = holderView(arm);
      expect(out.location?.isExact).toBe(false);
      expect(out.location?.addressLine1).toBeNull();
      const text = JSON.stringify(out);
      expect(text).not.toContain("Shelby Ave");
      expect(text).not.toContain("37206");
      expect(text).not.toContain("36.1775");
      // And the page promises no date: none is coming.
      expect(out.addressRevealAt).toBeNull();
    },
  );

  it("owner arm: the holder gets the venue's address, and the page shows the event's own date", () => {
    const out = holderView("owner");
    expect(out.location).toMatchObject({
      isExact: true,
      addressLine1: "1417 Shelby Ave, Nashville, TN 37206",
    });
    expect(out.addressRevealAt).toBe("2020-01-01T00:00:00.000Z");
  });

  it("stamp arm: locked until startsAt − 24h (the date the page promises), then the venue's address", () => {
    // The reveal edge is the INJECTED clock (`now`), not the wall clock. The
    // event's own date (2020) passed long ago; the venue's floor is
    // 2026-01-31T18:00Z.
    const before = holderView("stamp", new Date("2026-01-31T17:59:59.999Z"));
    expect(before.addressRevealAt).toBe("2026-01-31T18:00:00.000Z");
    expect(before.location?.isExact).toBe(false);
    expect(JSON.stringify(before)).not.toContain("Shelby Ave");

    const at = holderView("stamp", new Date("2026-01-31T18:00:00.000Z"));
    expect(at.location).toMatchObject({
      isExact: true,
      addressLine1: "1417 Shelby Ave, Nashville, TN 37206",
    });
  });
});
