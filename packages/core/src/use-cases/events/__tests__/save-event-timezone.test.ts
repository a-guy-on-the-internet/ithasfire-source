import { describe, expect, it, vi } from "vitest";

import { saveEventForOrg } from "../save-event-for-org";
import { saveEventForHuman } from "../save-event-for-human";
import {
  DEFAULT_ACTOR_ID,
  DEFAULT_EVENT_ID,
  DEFAULT_ORG_ID,
  DEFAULT_PLACE_ID,
  makeCreateEventTestContext,
} from "@th/test-utils";
import type { PlaceRecord } from "@th/ports/repos/places";
import type { EventRecord } from "@th/ports/repos/events";

/**
 * Event timezone derivation (venue-hierarchy FR-004).
 *
 * Resolution chain in `finalizeSaveEvent`:
 *   explicit param
 *     > existing event
 *     > linked Place.timezone
 *     > SavedLocation.timezone (stored, or derived for this save)
 *     > platform default.
 *
 * The order is load-bearing: an event that already has a zone must NEVER have
 * it changed by a save, because the zone is the display truth for every time
 * on the event (door times, address reveal, scheduled price flips, sales
 * windows). Only brand-new events adopt the venue's zone.
 */

const makeDeps = makeCreateEventTestContext;

const OTHER_PLACE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DEFAULT_TIMEZONE = "America/Chicago";

function makeOrgInput(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    actorHumanId: DEFAULT_ACTOR_ID,
    orgId: DEFAULT_ORG_ID,
    title: "Opening Night",
    startsAt: "2024-02-01T18:00:00.000Z",
    endsAt: "2024-02-01T19:00:00.000Z",
    location: {},
    clientKey: "idem-key-1234",
    ...overrides,
  };
}

function makePlace(overrides: Partial<PlaceRecord> = {}): PlaceRecord {
  const base = {
    id: DEFAULT_PLACE_ID,
    name: "Test Venue",
    slug: null,
    createdAt: new Date("2024-01-01T00:00:00.000Z"),
    updatedAt: new Date("2024-01-01T00:00:00.000Z"),
    formattedAddress: "85 Delancey St",
    addressLine1: "85 Delancey St",
    addressLine2: null,
    city: "New York",
    region: "NY",
    postalCode: "10002",
    countryCode: "US",
    capacity: null,
    lat: 40.7182,
    lng: -73.9884,
    phone: null,
    website: null,
    websiteSource: "UNKNOWN",
    addressHash: null,
    admissionTaxRateBps: null,
    taxRateSource: null,
    taxRateFetchedAt: null,
    timezone: null,
    status: "ACTIVE",
    verificationStatus: "VERIFIED",
    listedInDirectory: false,
    acceptsBookingRequests: false,
    orgIdsWithAccess: [DEFAULT_ORG_ID],
    humanIdsWithAccess: [DEFAULT_ACTOR_ID],
    defaultPrimaryPayoutTermsId: null,
    defaultResalePayoutTermsId: null,
  } as unknown as PlaceRecord;
  return Object.assign(base, overrides);
}

function makeExistingOrgEvent(
  overrides: Partial<EventRecord> = {},
): EventRecord {
  const base = {
    id: DEFAULT_EVENT_ID,
    orgId: DEFAULT_ORG_ID,
    humanId: null,
    title: "Existing",
    status: "PUBLISHED",
    attendanceMode: "TICKETED",
    stewardship: "OWNED",
    visibility: "PUBLIC",
    gateType: "NONE",
    locationMode: "EXACT",
    locationRadiusMeters: null,
    locationLabel: null,
    addressRevealAt: null,
    addressRevealPreset: null,
    timezone: "America/New_York",
    startsAt: new Date("2024-01-01T18:00:00.000Z"),
    endsAt: new Date("2024-01-01T20:00:00.000Z"),
    placeId: DEFAULT_PLACE_ID,
    savedLocationId: null,
    categoryId: null,
    addressText: null,
    countryCode: null,
    region: null,
    locality: null,
    postalCode: null,
    lat: null,
    lng: null,
    slug: null,
    shortId: null,
    regionCode: null,
    publishedAt: null,
    agreementPrimaryId: null,
    agreementResaleId: null,
    defaultLocale: "en-US",
    listingPriority: null,
    passwordHash: null,
    passwordUpdatedAt: null,
    waitlistStatus: "DISABLED",
    waitlistPublishAt: null,
    waitlistDescription: null,
    waitlistCap: null,
    payoutTermsId: null,
    resalePayoutTermsId: null,
    placeLayoutId: null,
    currency: null,
    admissionTaxRateBps: 875,
    taxRateSource: "fake",
    createdAt: new Date("2024-01-01T00:00:00.000Z"),
    updatedAt: new Date("2024-01-01T00:00:00.000Z"),
  } as unknown as EventRecord;
  return Object.assign(base, overrides);
}

function persistedTimezone(upsertDraft: unknown): string | null | undefined {
  const calls = vi.mocked(upsertDraft as never).mock.calls as unknown as Array<
    [{ timezone?: string | null }]
  >;
  expect(calls.length).toBeGreaterThan(0);
  return calls[0]![0].timezone;
}

describe("save event — timezone derivation", () => {
  it("stamps the linked place's derived timezone on a NEW event", async () => {
    const { deps, mocks } = makeDeps({
      place: makePlace({ timezone: "America/New_York" }),
    });

    await saveEventForOrg(
      deps,
      makeOrgInput({ location: { placeId: DEFAULT_PLACE_ID } }),
    );

    expect(persistedTimezone(mocks.events.upsertDraft)).toBe(
      "America/New_York",
    );
  });

  it("stamps the place's timezone on a NEW event owned by a human too", async () => {
    const { deps, mocks } = makeDeps({
      place: makePlace({ timezone: "America/Los_Angeles" }),
    });

    await saveEventForHuman(deps, {
      actorHumanId: DEFAULT_ACTOR_ID,
      title: "House Show",
      startsAt: "2024-02-01T18:00:00.000Z",
      endsAt: "2024-02-01T19:00:00.000Z",
      location: { placeId: DEFAULT_PLACE_ID },
      clientKey: "idem-key-human-1",
    });

    expect(persistedTimezone(mocks.events.upsertDraft)).toBe(
      "America/Los_Angeles",
    );
  });

  it("falls back to the platform default when the place has NO derived timezone", async () => {
    const { deps, mocks } = makeDeps({
      // No coordinates / failed lookup → Place.timezone is null.
      place: makePlace({ timezone: null }),
    });

    await saveEventForOrg(
      deps,
      makeOrgInput({ location: { placeId: DEFAULT_PLACE_ID } }),
    );

    expect(persistedTimezone(mocks.events.upsertDraft)).toBe(DEFAULT_TIMEZONE);
  });

  it("falls back to the platform default for an online / no-venue event, and never reads a place", async () => {
    const { deps, mocks } = makeDeps();

    await saveEventForOrg(deps, makeOrgInput({ location: {} }));

    expect(persistedTimezone(mocks.events.upsertDraft)).toBe(DEFAULT_TIMEZONE);
    expect(mocks.places.getById).not.toHaveBeenCalled();
  });

  it("falls back to the platform default for a freeform address whose lookup yields no answer", async () => {
    // Default fixture lookup returns null ("unknown"). No place is consulted —
    // a freeform event has none.
    const { deps, mocks } = makeDeps();

    await saveEventForOrg(
      deps,
      makeOrgInput({
        location: { addressText: "123 Main St", lat: 40.71, lng: -73.98 },
      }),
    );

    expect(persistedTimezone(mocks.events.upsertDraft)).toBe(DEFAULT_TIMEZONE);
    expect(mocks.places.getById).not.toHaveBeenCalled();
  });

  it("NEVER changes an existing event's timezone — even when the venue is swapped to a place in another zone", async () => {
    const existingEvent = makeExistingOrgEvent({
      timezone: "America/New_York",
      placeId: DEFAULT_PLACE_ID,
    });
    const { deps, mocks } = makeDeps({
      existingEvent,
      // The NEW venue sits in Pacific time; the published show times must not move.
      place: makePlace({
        id: OTHER_PLACE_ID,
        timezone: "America/Los_Angeles",
      }),
    });

    await saveEventForOrg(
      deps,
      makeOrgInput({
        eventId: DEFAULT_EVENT_ID,
        location: { placeId: OTHER_PLACE_ID },
      }),
    );

    expect(persistedTimezone(mocks.events.upsertDraft)).toBe(
      "America/New_York",
    );
  });

  it("keeps an existing event's timezone even when it equals the platform default", async () => {
    // Guard against a "looks unset, re-derive it" regression: an event whose
    // stored zone happens to BE the default is still an explicit stored value.
    const existingEvent = makeExistingOrgEvent({
      timezone: DEFAULT_TIMEZONE,
      placeId: DEFAULT_PLACE_ID,
    });
    const { deps, mocks } = makeDeps({
      existingEvent,
      place: makePlace({ timezone: "America/New_York" }),
    });

    await saveEventForOrg(
      deps,
      makeOrgInput({
        eventId: DEFAULT_EVENT_ID,
        location: { placeId: DEFAULT_PLACE_ID },
      }),
    );

    expect(persistedTimezone(mocks.events.upsertDraft)).toBe(DEFAULT_TIMEZONE);
  });

  it("an explicit timezone param wins over the place AND the existing event", async () => {
    const existingEvent = makeExistingOrgEvent({
      timezone: "America/New_York",
      placeId: DEFAULT_PLACE_ID,
    });
    const { deps, mocks } = makeDeps({
      existingEvent,
      place: makePlace({ timezone: "America/Los_Angeles" }),
    });

    await saveEventForOrg(
      deps,
      makeOrgInput({
        eventId: DEFAULT_EVENT_ID,
        location: { placeId: DEFAULT_PLACE_ID },
        timezone: "Europe/Berlin",
      }),
    );

    expect(persistedTimezone(mocks.events.upsertDraft)).toBe("Europe/Berlin");
  });

  it("an explicit timezone param wins over the place on a NEW event", async () => {
    const { deps, mocks } = makeDeps({
      place: makePlace({ timezone: "America/Los_Angeles" }),
    });

    await saveEventForOrg(
      deps,
      makeOrgInput({
        location: { placeId: DEFAULT_PLACE_ID },
        timezone: "Europe/Berlin",
      }),
    );

    expect(persistedTimezone(mocks.events.upsertDraft)).toBe("Europe/Berlin");
  });
});

/**
 * Freeform-address + saved-location timezone derivation.
 *
 * The gap this closes: a freeform address normalizes into a `SavedLocation`,
 * which carried lat/lng but no zone — so the event fell through to the
 * organiser's browser zone or the platform default. A New York show created by
 * a Nashville organiser rendered every time on the Central clock.
 *
 * The rule: derive ONCE from the coordinates, persist it on the SavedLocation,
 * and let every later event at that address read the stored answer.
 */

// 85 Delancey St, New York — the running example.
const NYC = { lat: 40.7182, lng: -73.9884 };
const NYC_ADDRESS = "85 Delancey St, New York, NY 10002";

function makeFreeformInput(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return makeOrgInput({
    location: {
      addressText: NYC_ADDRESS,
      lat: NYC.lat,
      lng: NYC.lng,
      locality: "New York",
      region: "NY",
      countryCode: "US",
      postalCode: "10002",
    },
    ...overrides,
  });
}

/** The `timezone` a `savedLocations.create` call was asked to persist. */
function createdSavedLocationTimezone(
  create: unknown,
): string | null | undefined {
  const calls = vi.mocked(create as never).mock.calls as unknown as Array<
    [{ timezone?: string | null }]
  >;
  expect(calls.length).toBe(1);
  return calls[0]![0].timezone;
}

describe("save event — freeform address timezone", () => {
  it("derives the zone from the freeform coordinates on a NEW event", async () => {
    const { deps, mocks } = makeDeps({
      timezoneLookup: () => "America/New_York",
    });

    await saveEventForOrg(deps, makeFreeformInput());

    expect(mocks.timezoneLookup).toHaveBeenCalledWith(NYC.lat, NYC.lng);
    expect(persistedTimezone(mocks.events.upsertDraft)).toBe(
      "America/New_York",
    );
  });

  it("derives the zone for a human-owned freeform event too", async () => {
    const { deps, mocks } = makeDeps({
      timezoneLookup: () => "America/New_York",
    });

    await saveEventForHuman(deps, {
      actorHumanId: DEFAULT_ACTOR_ID,
      title: "House Show",
      startsAt: "2024-02-01T18:00:00.000Z",
      endsAt: "2024-02-01T19:00:00.000Z",
      location: {
        addressText: NYC_ADDRESS,
        lat: NYC.lat,
        lng: NYC.lng,
        locality: "New York",
      },
      clientKey: "idem-key-human-freeform",
    });

    expect(persistedTimezone(mocks.events.upsertDraft)).toBe(
      "America/New_York",
    );
  });

  it("PERSISTS the derived zone on the SavedLocation it creates", async () => {
    const { deps, mocks } = makeDeps({
      timezoneLookup: () => "America/New_York",
    });

    await saveEventForOrg(deps, makeFreeformInput());

    expect(createdSavedLocationTimezone(mocks.savedLocations.create)).toBe(
      "America/New_York",
    );
  });

  it("derives exactly ONCE per save — the event and the SavedLocation get the same answer", async () => {
    const { deps, mocks } = makeDeps({
      timezoneLookup: () => "America/New_York",
    });

    await saveEventForOrg(deps, makeFreeformInput());

    expect(mocks.timezoneLookup).toHaveBeenCalledTimes(1);
    expect(persistedTimezone(mocks.events.upsertDraft)).toBe(
      createdSavedLocationTimezone(mocks.savedLocations.create),
    );
  });

  it("REUSES the stored zone for a second event at the same address instead of re-deriving", async () => {
    const { deps, mocks } = makeDeps({
      timezoneLookup: () => "America/New_York",
    });
    // The address is already saved, and already carries the derived answer.
    vi.mocked(mocks.savedLocations.findByOwnerAndAddress).mockResolvedValue({
      id: "99999999-9999-4999-8999-999999999999",
      name: "85 Delancey St, New York",
      address: NYC_ADDRESS,
      countryCode: "US",
      region: "NY",
      locality: "New York",
      postalCode: "10002",
      lat: NYC.lat,
      lng: NYC.lng,
      timezone: "America/New_York",
      ownerType: "ORGANIZATION",
      ownerId: DEFAULT_ORG_ID,
      usageCount: 3,
      admissionTaxRateBps: 875,
      taxRateFetchedAt: new Date("2024-01-01T00:00:00.000Z"),
      taxRateSource: "fake",
    });

    await saveEventForOrg(deps, makeFreeformInput());

    expect(persistedTimezone(mocks.events.upsertDraft)).toBe(
      "America/New_York",
    );
    expect(mocks.timezoneLookup).not.toHaveBeenCalled();
    // Reuse path — nothing new is created, so nothing new is stored.
    expect(mocks.savedLocations.create).not.toHaveBeenCalled();
  });

  it("falls back to the platform default when the coordinates are unresolvable, without throwing", async () => {
    // `tz-lookup` yields no answer for an ocean point; the adapter maps that
    // to null. The save must still succeed.
    const { deps, mocks } = makeDeps({ timezoneLookup: () => null });

    const result = await saveEventForOrg(
      deps,
      makeFreeformInput({
        location: { addressText: "Middle of the Pacific", lat: 0, lng: -160 },
      }),
    );

    expect(result.eventId).toBeTruthy();
    expect(persistedTimezone(mocks.events.upsertDraft)).toBe(DEFAULT_TIMEZONE);
    expect(
      createdSavedLocationTimezone(mocks.savedLocations.create),
    ).toBeNull();
  });

  it("falls back to the platform default when the lookup THROWS on out-of-range coordinates, and reports it", async () => {
    // `tz-lookup` throws rather than returning a fallback. A degraded lookup
    // must never fail an event save — and a swallow must be reported.
    const boom = new Error("invalid latitude: 991");
    const { deps, mocks } = makeDeps({
      timezoneLookup: () => {
        throw boom;
      },
    });

    const result = await saveEventForOrg(deps, makeFreeformInput());

    expect(result.eventId).toBeTruthy();
    expect(persistedTimezone(mocks.events.upsertDraft)).toBe(DEFAULT_TIMEZONE);
    expect(
      createdSavedLocationTimezone(mocks.savedLocations.create),
    ).toBeNull();
    expect(mocks.reportError).toHaveBeenCalledWith(
      boom,
      expect.objectContaining({
        tags: { useCase: "saveEvent", stage: "timezone_lookup" },
      }),
    );
  });

  it("survives a THROWING reporter on the swallow path", async () => {
    const { deps, mocks } = makeDeps({
      timezoneLookup: () => {
        throw new Error("invalid latitude");
      },
    });
    vi.mocked(deps.reportError).mockImplementation(() => {
      throw new Error("sentry is down");
    });

    const result = await saveEventForOrg(deps, makeFreeformInput());

    expect(result.eventId).toBeTruthy();
    expect(persistedTimezone(mocks.events.upsertDraft)).toBe(DEFAULT_TIMEZONE);
  });

  it("an address typed with NO coordinates is rejected at the boundary — it never reaches the derivation", async () => {
    // Pinned because it is the honest answer to "what happens to a freeform
    // address with no lat/lng": nothing derives, nothing saves, and no
    // SavedLocation is minted, because `baseSaveEventInputSchema` refuses the
    // input up front ("lat and lng are required together"). That guarantee is
    // what lets the freeform branch assume a coordinate pair.
    const { deps, mocks } = makeDeps({
      timezoneLookup: () => "America/New_York",
    });

    await expect(
      saveEventForOrg(
        deps,
        makeOrgInput({ location: { addressText: "123 Main St" } }),
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });

    expect(mocks.timezoneLookup).not.toHaveBeenCalled();
    expect(mocks.savedLocations.create).not.toHaveBeenCalled();
    expect(mocks.events.upsertDraft).not.toHaveBeenCalled();
  });

  it("falls through to the platform default for an event with no location at all", async () => {
    const { deps, mocks } = makeDeps({
      timezoneLookup: () => "America/New_York",
    });

    await saveEventForOrg(deps, makeOrgInput({ location: {} }));

    expect(persistedTimezone(mocks.events.upsertDraft)).toBe(DEFAULT_TIMEZONE);
    expect(mocks.timezoneLookup).not.toHaveBeenCalled();
    expect(mocks.savedLocations.create).not.toHaveBeenCalled();
  });

  it("NEVER changes an existing event's timezone — even when the freeform address is in another zone", async () => {
    // The regression that would move published door times, address reveals and
    // scheduled price flips on a live show.
    const existingEvent = makeExistingOrgEvent({
      timezone: "America/Chicago",
      placeId: null,
      savedLocationId: null,
    });
    const { deps, mocks } = makeDeps({
      existingEvent,
      timezoneLookup: () => "America/New_York",
    });

    await saveEventForOrg(
      deps,
      makeFreeformInput({ eventId: DEFAULT_EVENT_ID }),
    );

    expect(persistedTimezone(mocks.events.upsertDraft)).toBe("America/Chicago");
    // The ADDRESS's own zone is still derived and stored — it describes the
    // address, not this event's display choice.
    expect(createdSavedLocationTimezone(mocks.savedLocations.create)).toBe(
      "America/New_York",
    );
  });

  it("an explicit timezone param still wins over the derived freeform zone", async () => {
    const { deps, mocks } = makeDeps({
      timezoneLookup: () => "America/New_York",
    });

    await saveEventForOrg(
      deps,
      makeFreeformInput({ timezone: "Europe/Berlin" }),
    );

    expect(persistedTimezone(mocks.events.upsertDraft)).toBe("Europe/Berlin");
    // ...and does NOT poison the shared SavedLocation row.
    expect(createdSavedLocationTimezone(mocks.savedLocations.create)).toBe(
      "America/New_York",
    );
  });

  it("falls back to the platform default when no timezoneLookup port is wired", async () => {
    const { deps, mocks } = makeDeps();
    // Older composition roots / seed scripts pass no port at all.
    const depsWithoutPort = { ...deps, timezoneLookup: null };

    await saveEventForOrg(depsWithoutPort, makeFreeformInput());

    expect(persistedTimezone(mocks.events.upsertDraft)).toBe(DEFAULT_TIMEZONE);
    expect(
      createdSavedLocationTimezone(mocks.savedLocations.create),
    ).toBeNull();
  });
});

describe("save event — saved-location timezone", () => {
  const SAVED_LOCATION_ID = "44444444-4444-4444-8444-444444444444";

  it("inherits the SavedLocation's stored zone on a NEW event", async () => {
    const { deps, mocks } = makeDeps({
      savedLocation: {
        id: SAVED_LOCATION_ID,
        name: "85 Delancey St, New York",
        address: NYC_ADDRESS,
        countryCode: "US",
        region: "NY",
        locality: "New York",
        postalCode: "10002",
        lat: NYC.lat,
        lng: NYC.lng,
        timezone: "America/New_York",
        ownerType: "ORGANIZATION",
        ownerId: DEFAULT_ORG_ID,
        usageCount: 2,
        admissionTaxRateBps: null,
        taxRateFetchedAt: null,
        taxRateSource: null,
      },
      timezoneLookup: () => "America/Los_Angeles",
    });

    await saveEventForOrg(
      deps,
      makeOrgInput({ location: { savedLocationId: SAVED_LOCATION_ID } }),
    );

    expect(persistedTimezone(mocks.events.upsertDraft)).toBe(
      "America/New_York",
    );
    // Stored value wins outright — nothing is re-derived.
    expect(mocks.timezoneLookup).not.toHaveBeenCalled();
  });

  it("derives from the row's own coordinates when it predates the column", async () => {
    const { deps, mocks } = makeDeps({
      savedLocation: {
        id: SAVED_LOCATION_ID,
        name: "85 Delancey St, New York",
        address: NYC_ADDRESS,
        countryCode: "US",
        region: "NY",
        locality: "New York",
        postalCode: "10002",
        lat: NYC.lat,
        lng: NYC.lng,
        // Every pre-migration row looks like this.
        timezone: null,
        ownerType: "ORGANIZATION",
        ownerId: DEFAULT_ORG_ID,
        usageCount: 2,
        admissionTaxRateBps: null,
        taxRateFetchedAt: null,
        taxRateSource: null,
      },
      timezoneLookup: () => "America/New_York",
    });

    await saveEventForOrg(
      deps,
      makeOrgInput({ location: { savedLocationId: SAVED_LOCATION_ID } }),
    );

    expect(mocks.timezoneLookup).toHaveBeenCalledWith(NYC.lat, NYC.lng);
    expect(persistedTimezone(mocks.events.upsertDraft)).toBe(
      "America/New_York",
    );
  });

  it("falls back to the platform default when the row has neither a zone nor coordinates", async () => {
    const { deps, mocks } = makeDeps({
      savedLocation: {
        id: SAVED_LOCATION_ID,
        name: "Somewhere",
        address: "Somewhere",
        countryCode: null,
        region: null,
        locality: null,
        postalCode: null,
        lat: null,
        lng: null,
        timezone: null,
        ownerType: "ORGANIZATION",
        ownerId: DEFAULT_ORG_ID,
        usageCount: 1,
        admissionTaxRateBps: null,
        taxRateFetchedAt: null,
        taxRateSource: null,
      },
      timezoneLookup: () => "America/New_York",
    });

    await saveEventForOrg(
      deps,
      makeOrgInput({ location: { savedLocationId: SAVED_LOCATION_ID } }),
    );

    expect(mocks.timezoneLookup).not.toHaveBeenCalled();
    expect(persistedTimezone(mocks.events.upsertDraft)).toBe(DEFAULT_TIMEZONE);
  });
});
