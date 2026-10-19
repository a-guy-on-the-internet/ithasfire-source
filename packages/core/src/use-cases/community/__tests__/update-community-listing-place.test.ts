import { describe, expect, it, vi } from "vitest";

import type { EventRecord } from "@th/ports/repos/events";
import type { PlaceRecord } from "@th/ports/repos/places";

import {
  updateCommunityListing,
  type UpdateCommunityListingDeps,
} from "../update-community-listing";
import {
  isMaterialField,
  parseSuggestionFields,
  SUGGESTION_EDITABLE_FIELDS,
} from "../../events/_shared/suggestion-fields";
import {
  EVENT_ID,
  MODERATOR_ID,
  makeClock,
  makeCommunityEvent,
  makeContentFilter,
  makeStaffAuthz,
} from "./helpers";

/**
 * The place link on the moderator direct edit (`fields.placeId`): set, unlink,
 * untouched, and the refusal that keeps a linked listing's address on its
 * place. Moderator-only — a public suggestion carrying it is rejected.
 */

const PLACE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER_PLACE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const PLACE_ADDRESS = {
  addressText: "912 Red River St, Austin, TX 78701, USA",
  countryCode: "US",
  region: "TX",
  locality: "Austin",
  postalCode: "78701",
  lat: 30.2697,
  lng: -97.7363,
};

function makePlace(overrides: Partial<PlaceRecord> = {}): PlaceRecord {
  return {
    id: PLACE_ID,
    name: "The Mohawk",
    formattedAddress: PLACE_ADDRESS.addressText,
    addressLine1: "912 Red River St",
    addressLine2: null,
    city: PLACE_ADDRESS.locality,
    region: PLACE_ADDRESS.region,
    postalCode: PLACE_ADDRESS.postalCode,
    countryCode: PLACE_ADDRESS.countryCode,
    lat: PLACE_ADDRESS.lat,
    lng: PLACE_ADDRESS.lng,
    status: "ACTIVE",
    locationMode: "EXACT",
    locationRadiusMeters: null,
    locationLabel: null,
    ...overrides,
  } as PlaceRecord;
}

function buildDeps(
  event: EventRecord,
  place: PlaceRecord | null = makePlace(),
) {
  const applyCommunityEdit = vi.fn(
    async ({
      eventId,
      fields,
      placeId,
    }: {
      eventId: string;
      fields: Record<string, unknown>;
      placeId?: string | null;
    }) =>
      ({
        ...event,
        id: eventId,
        ...fields,
        ...(placeId !== undefined ? { placeId } : {}),
      }) as EventRecord,
  );
  // One ordered log of the lock + read calls, to pin the lock order.
  const calls: string[] = [];
  const placesGetById = vi.fn(async (id: string) => {
    calls.push(`places.getById:${id}`);
    return place;
  });
  const lockLocationsAtPlace = vi.fn(
    async (args: { placeId: string; mode: string }) => {
      calls.push(`lockLocationsAtPlace:${args.placeId}:${args.mode}`);
    },
  );
  const lockRows = vi.fn(async (args: { ids: string[]; mode: string }) => {
    calls.push(`lockRows:${args.ids.join(",")}:${args.mode}`);
  });
  const audit = { log: vi.fn() };
  const eventChangeNoticesCreate = vi.fn(async () => ({ id: "notice-1" }));
  const txRepos = {
    events: {
      getById: vi.fn(async (id: string) => {
        calls.push(`events.getById:${id}`);
        return event;
      }),
      getContent: vi.fn(async () => null),
      applyCommunityEdit,
      lockLocationsAtPlace,
      lockRows,
    },
    images: {
      getById: vi.fn(async () => null),
      listByEventId: vi.fn(async () => []),
      attach: vi.fn(async () => undefined),
    },
    places: { getById: placesGetById },
    audit,
    eventChangeNotices: { create: eventChangeNoticesCreate },
    calendars: { findById: vi.fn(async () => null) },
  };
  const deps: UpdateCommunityListingDeps = {
    repos: {
      tx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(txRepos)),
    } as unknown as UpdateCommunityListingDeps["repos"],
    authz: makeStaffAuthz({ [MODERATOR_ID]: ["COMMUNITY_MODERATOR"] }),
    clock: makeClock(),
    contentFilter: makeContentFilter(),
  };
  return {
    deps,
    applyCommunityEdit,
    placesGetById,
    lockLocationsAtPlace,
    lockRows,
    calls,
    audit,
    eventChangeNoticesCreate,
  };
}

const input = (fields: Record<string, unknown>) => ({
  actorHumanId: MODERATOR_ID,
  eventId: EVENT_ID,
  fields,
});

const draftListing = (overrides: Partial<EventRecord> = {}) =>
  makeCommunityEvent({ status: "DRAFT", publishedAt: null, ...overrides });
const publishedListing = (overrides: Partial<EventRecord> = {}) =>
  makeCommunityEvent({ status: "PUBLISHED", ...overrides });

function appliedAuditRow(audit: { log: { mock: { calls: unknown[][] } } }) {
  return audit.log.mock.calls
    .map((call) => call[0] as { action: string; data: Record<string, unknown> })
    .find((entry) => entry.action === "event_edit.applied");
}

describe("updateCommunityListing — setting a place", () => {
  it("links the place and copies the address columns that differ, ignoring client address values", async () => {
    const { deps, applyCommunityEdit, placesGetById } = buildDeps(
      draftListing(),
    );

    const result = await updateCommunityListing(
      deps,
      input({
        placeId: PLACE_ID,
        addressText: "1 Somewhere Else, Paris",
        lat: 48.86,
        lng: 2.35,
      }),
    );

    expect(placesGetById).toHaveBeenCalledWith(PLACE_ID);
    // The listing was already in Austin, TX 78701: only the street and the
    // pin differ from the place, so only those are written.
    expect(applyCommunityEdit).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      fields: {
        addressText: PLACE_ADDRESS.addressText,
        lat: PLACE_ADDRESS.lat,
        lng: PLACE_ADDRESS.lng,
      },
      placeId: PLACE_ID,
    });
    expect(result.updatedFields).toEqual([
      "addressText",
      "lat",
      "lng",
      "placeId",
    ]);
  });

  it("accepts placeId as the only field", async () => {
    const { deps, applyCommunityEdit } = buildDeps(draftListing());

    await updateCommunityListing(deps, input({ placeId: PLACE_ID }));

    expect(applyCommunityEdit).toHaveBeenCalledTimes(1);
  });

  it("keeps other fields in the same diff", async () => {
    const { deps, applyCommunityEdit } = buildDeps(draftListing());

    await updateCommunityListing(
      deps,
      input({ placeId: PLACE_ID, title: "Open Mic at the Mohawk" }),
    );

    expect(applyCommunityEdit.mock.calls[0]![0].fields).toEqual({
      title: "Open Mic at the Mohawk",
      addressText: PLACE_ADDRESS.addressText,
      lat: PLACE_ADDRESS.lat,
      lng: PLACE_ADDRESS.lng,
    });
  });

  it.each([
    ["a missing place", null, { code: "PLACE_NOT_FOUND" }],
    [
      "a SUSPENDED place",
      makePlace({ status: "SUSPENDED" }),
      { code: "PLACE_NOT_ACTIVE" },
    ],
    [
      "an ARCHIVED place",
      makePlace({ status: "ARCHIVED" }),
      { code: "PLACE_ARCHIVED" },
    ],
    [
      "a place that withholds its address",
      makePlace({ locationMode: "OBSCURED" }),
      { code: "INVALID_INPUT", meta: { reason: "PLACE_WITHHOLDS_ADDRESS" } },
    ],
    [
      "a place with no pin",
      makePlace({ lat: null, lng: null }),
      { code: "INVALID_INPUT", meta: { reason: "PLACE_LOCATION_INCOMPLETE" } },
    ],
  ] as const)(
    "refuses %s with the create-path rules and writes nothing",
    async (_label, place, expected) => {
      const { deps, applyCommunityEdit, audit } = buildDeps(
        draftListing(),
        place as PlaceRecord | null,
      );

      await expect(
        updateCommunityListing(deps, input({ placeId: PLACE_ID })),
      ).rejects.toMatchObject(expected);
      expect(applyCommunityEdit).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
    },
  );

  it("re-sending the linked place re-syncs only drifted columns and is not a link change", async () => {
    const { deps, applyCommunityEdit } = buildDeps(
      draftListing({ placeId: PLACE_ID, ...PLACE_ADDRESS, postalCode: "78702" }),
    );

    const result = await updateCommunityListing(
      deps,
      input({ placeId: PLACE_ID }),
    );

    expect(applyCommunityEdit).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      fields: { postalCode: "78701" },
    });
    expect(result.updatedFields).toEqual(["postalCode"]);
  });

  it("re-sending the linked place when nothing drifted writes nothing", async () => {
    const { deps, applyCommunityEdit, audit } = buildDeps(
      draftListing({ placeId: PLACE_ID, ...PLACE_ADDRESS }),
    );

    const result = await updateCommunityListing(
      deps,
      input({ placeId: PLACE_ID }),
    );

    expect(applyCommunityEdit).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
    expect(result.updatedFields).toEqual([]);
  });
});

describe("updateCommunityListing — unlinking", () => {
  it("placeId: null unlinks and keeps the current address", async () => {
    const { deps, applyCommunityEdit, placesGetById } = buildDeps(
      draftListing({ placeId: PLACE_ID, ...PLACE_ADDRESS }),
    );

    const result = await updateCommunityListing(deps, input({ placeId: null }));

    expect(placesGetById).not.toHaveBeenCalled();
    expect(applyCommunityEdit).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      fields: {},
      placeId: null,
    });
    expect(result.updatedFields).toEqual(["placeId"]);
  });

  it("placeId: null with a typed address writes it as free text", async () => {
    const { deps, applyCommunityEdit } = buildDeps(
      draftListing({ placeId: PLACE_ID, ...PLACE_ADDRESS }),
    );

    await updateCommunityListing(
      deps,
      input({
        placeId: null,
        addressText: "88 Elsewhere Ave, Austin, TX",
        lat: 30.3,
        lng: -97.7,
      }),
    );

    expect(applyCommunityEdit).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      fields: {
        addressText: "88 Elsewhere Ave, Austin, TX",
        lat: 30.3,
        lng: -97.7,
      },
      placeId: null,
    });
  });
});

describe("updateCommunityListing — placeId omitted", () => {
  it("refuses address fields alone on a LINKED listing and writes nothing", async () => {
    const { deps, applyCommunityEdit } = buildDeps(
      publishedListing({ placeId: PLACE_ID, ...PLACE_ADDRESS }),
    );

    await expect(
      updateCommunityListing(
        deps,
        input({ addressText: "88 Elsewhere Ave, Austin, TX" }),
      ),
    ).rejects.toMatchObject({
      code: "EDIT_SUGGESTION_INVALID_FIELDS",
      meta: { reason: "unsupported_fields", fields: ["addressText"] },
    });
    expect(applyCommunityEdit).not.toHaveBeenCalled();
  });

  it("lets a linked listing change non-address fields", async () => {
    const { deps, applyCommunityEdit } = buildDeps(
      draftListing({ placeId: PLACE_ID, ...PLACE_ADDRESS }),
    );

    await updateCommunityListing(deps, input({ title: "New title" }));

    expect(applyCommunityEdit).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      fields: { title: "New title" },
    });
  });

  it("leaves an unlinked listing's address edits as they were", async () => {
    const { deps, applyCommunityEdit, placesGetById } = buildDeps(
      draftListing({ placeId: null }),
    );

    await updateCommunityListing(
      deps,
      input({ addressText: "88 Elsewhere Ave, Austin, TX" }),
    );

    expect(placesGetById).not.toHaveBeenCalled();
    expect(applyCommunityEdit).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      fields: { addressText: "88 Elsewhere Ave, Austin, TX" },
    });
  });
});

describe("updateCommunityListing — the place link on a PUBLISHED listing", () => {
  it("a link that moves the address is material: VENUE_CHANGED and placeId in the version history", async () => {
    const { deps, audit, eventChangeNoticesCreate } = buildDeps(
      publishedListing({ placeId: OTHER_PLACE_ID }),
    );

    await updateCommunityListing(deps, input({ placeId: PLACE_ID }));

    expect(eventChangeNoticesCreate).toHaveBeenCalledTimes(1);
    expect(eventChangeNoticesCreate).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: EVENT_ID, changeType: "VENUE_CHANGED" }),
    );
    const applied = appliedAuditRow(audit)!;
    expect(applied.data).toMatchObject({
      suggestionId: null,
      material: true,
      changes: {
        placeId: { before: OTHER_PLACE_ID, after: PLACE_ID },
        addressText: {
          before: "123 Main St, Austin, TX",
          after: PLACE_ADDRESS.addressText,
        },
      },
    });
  });

  it("a link at the UNCHANGED address sends no notice but records placeId before/after", async () => {
    const { deps, applyCommunityEdit, audit, eventChangeNoticesCreate } =
      buildDeps(publishedListing({ placeId: null, ...PLACE_ADDRESS }));

    const result = await updateCommunityListing(
      deps,
      input({ placeId: PLACE_ID }),
    );

    // Only the link is written: no address column moved.
    expect(applyCommunityEdit).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      fields: {},
      placeId: PLACE_ID,
    });
    expect(result.updatedFields).toEqual(["placeId"]);
    expect(eventChangeNoticesCreate).not.toHaveBeenCalled();
    expect(appliedAuditRow(audit)!.data).toMatchObject({
      material: false,
      changes: { placeId: { before: null, after: PLACE_ID } },
    });
  });

  it("a postalCode-only correction is written and audited but sends no notice", async () => {
    const { deps, applyCommunityEdit, audit, eventChangeNoticesCreate } =
      buildDeps(
        publishedListing({ placeId: null, ...PLACE_ADDRESS, postalCode: "78702" }),
      );

    await updateCommunityListing(deps, input({ placeId: PLACE_ID }));

    expect(applyCommunityEdit).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      fields: { postalCode: "78701" },
      placeId: PLACE_ID,
    });
    expect(eventChangeNoticesCreate).not.toHaveBeenCalled();
    expect(appliedAuditRow(audit)!.data).toMatchObject({
      material: false,
      changes: {
        postalCode: { before: "78702", after: "78701" },
        placeId: { before: null, after: PLACE_ID },
      },
    });
  });

  it("text-only differences with the pin moved under 50 m: written and audited, no notice", async () => {
    // ~20 m north of the place's pin, street spelled differently.
    const nearbyLat = PLACE_ADDRESS.lat + 20 / 111_195;
    const { deps, applyCommunityEdit, audit, eventChangeNoticesCreate } =
      buildDeps(
        publishedListing({
          placeId: null,
          ...PLACE_ADDRESS,
          addressText: "912 Red River Street, Austin TX",
          lat: nearbyLat,
        }),
      );

    await updateCommunityListing(deps, input({ placeId: PLACE_ID }));

    expect(applyCommunityEdit).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      fields: {
        addressText: PLACE_ADDRESS.addressText,
        lat: PLACE_ADDRESS.lat,
        lng: PLACE_ADDRESS.lng,
      },
      placeId: PLACE_ID,
    });
    expect(eventChangeNoticesCreate).not.toHaveBeenCalled();
    expect(appliedAuditRow(audit)!.data).toMatchObject({
      material: false,
      changes: {
        addressText: {
          before: "912 Red River Street, Austin TX",
          after: PLACE_ADDRESS.addressText,
        },
        lat: { before: nearbyLat, after: PLACE_ADDRESS.lat },
        placeId: { before: null, after: PLACE_ID },
      },
    });
  });

  it("relinking to a DIFFERENT place next door (pin within 50 m, another street address) sends VENUE_CHANGED", async () => {
    // Two places 20 m apart are two venues: the street line says so.
    const { deps, audit, eventChangeNoticesCreate } = buildDeps(
      publishedListing({
        placeId: OTHER_PLACE_ID,
        ...PLACE_ADDRESS,
        addressText: "908 Red River St, Austin, TX 78701, USA",
        lat: PLACE_ADDRESS.lat + 20 / 111_195,
      }),
    );

    await updateCommunityListing(deps, input({ placeId: PLACE_ID }));

    expect(eventChangeNoticesCreate).toHaveBeenCalledTimes(1);
    expect(eventChangeNoticesCreate).toHaveBeenCalledWith(
      expect.objectContaining({ changeType: "VENUE_CHANGED" }),
    );
    expect(appliedAuditRow(audit)!.data).toMatchObject({
      material: true,
      changes: { placeId: { before: OTHER_PLACE_ID, after: PLACE_ID } },
    });
  });

  it("moving to a DIFFERENT place at the SAME street address (pin 5 m off) sends VENUE_CHANGED", async () => {
    // Three rooms share 1 Cannery Row in Nashville: a move from one to
    // another keeps the street line and the pin, and RSVPers must still be
    // told which room.
    const { deps, audit, eventChangeNoticesCreate } = buildDeps(
      publishedListing({
        placeId: OTHER_PLACE_ID,
        ...PLACE_ADDRESS,
        lat: PLACE_ADDRESS.lat + 5 / 111_195,
      }),
    );

    await updateCommunityListing(deps, input({ placeId: PLACE_ID }));

    expect(eventChangeNoticesCreate).toHaveBeenCalledTimes(1);
    expect(eventChangeNoticesCreate).toHaveBeenCalledWith(
      expect.objectContaining({ changeType: "VENUE_CHANGED" }),
    );
    expect(appliedAuditRow(audit)!.data).toMatchObject({
      material: true,
      changes: { placeId: { before: OTHER_PLACE_ID, after: PLACE_ID } },
    });
  });

  it("moving to a DIFFERENT place with the identical address and pin still sends VENUE_CHANGED", async () => {
    // No address column is written at all: the place change alone is the
    // venue change.
    const { deps, applyCommunityEdit, audit, eventChangeNoticesCreate } =
      buildDeps(publishedListing({ placeId: OTHER_PLACE_ID, ...PLACE_ADDRESS }));

    await updateCommunityListing(deps, input({ placeId: PLACE_ID }));

    expect(applyCommunityEdit).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      fields: {},
      placeId: PLACE_ID,
    });
    expect(eventChangeNoticesCreate).toHaveBeenCalledTimes(1);
    expect(eventChangeNoticesCreate).toHaveBeenCalledWith(
      expect.objectContaining({ changeType: "VENUE_CHANGED" }),
    );
    expect(appliedAuditRow(audit)!.data).toMatchObject({ material: true });
  });

  it("a FIRST link (from a typed address) at the same street, pin 5 m off, sends no notice", async () => {
    const { deps, audit, eventChangeNoticesCreate } = buildDeps(
      publishedListing({
        placeId: null,
        ...PLACE_ADDRESS,
        addressText: "912 Red River Street, Austin, TX",
        lat: PLACE_ADDRESS.lat + 5 / 111_195,
      }),
    );

    await updateCommunityListing(deps, input({ placeId: PLACE_ID }));

    expect(eventChangeNoticesCreate).not.toHaveBeenCalled();
    expect(appliedAuditRow(audit)!.data).toMatchObject({
      material: false,
      changes: { placeId: { before: null, after: PLACE_ID } },
    });
  });

  it("a re-sync to the SAME place whose text was corrected, pin within 50 m, sends no notice", async () => {
    // Re-sync is the pin alone: the place's own address being corrected is
    // no move for the people who RSVP'd.
    const { deps, audit, eventChangeNoticesCreate } = buildDeps(
      publishedListing({
        placeId: PLACE_ID,
        ...PLACE_ADDRESS,
        addressText: "910 Red River St, Austin, TX 78701, USA",
        lat: PLACE_ADDRESS.lat + 20 / 111_195,
      }),
    );

    await updateCommunityListing(deps, input({ placeId: PLACE_ID }));

    expect(eventChangeNoticesCreate).not.toHaveBeenCalled();
    expect(appliedAuditRow(audit)!.data).toMatchObject({ material: false });
  });

  it("a re-sync to the SAME place that moves the pin over 50 m sends VENUE_CHANGED", async () => {
    // The place's pin was corrected by ~300 m since the listing was linked.
    const { deps, audit, eventChangeNoticesCreate } = buildDeps(
      publishedListing({
        placeId: PLACE_ID,
        ...PLACE_ADDRESS,
        lat: PLACE_ADDRESS.lat + 300 / 111_195,
      }),
    );

    await updateCommunityListing(deps, input({ placeId: PLACE_ID }));

    expect(eventChangeNoticesCreate).toHaveBeenCalledWith(
      expect.objectContaining({ changeType: "VENUE_CHANGED" }),
    );
    expect(appliedAuditRow(audit)!.data).toMatchObject({ material: true });
  });

  it("linking a listing with NO pin is material: a pin appears", async () => {
    const { deps, eventChangeNoticesCreate } = buildDeps(
      publishedListing({ placeId: null, ...PLACE_ADDRESS, lat: null, lng: null }),
    );

    await updateCommunityListing(deps, input({ placeId: PLACE_ID }));

    expect(eventChangeNoticesCreate).toHaveBeenCalledWith(
      expect.objectContaining({ changeType: "VENUE_CHANGED" }),
    );
  });

  it("a text-only link that also moves the schedule still sends RESCHEDULED, and only that", async () => {
    const { deps, eventChangeNoticesCreate } = buildDeps(
      publishedListing({ placeId: null, ...PLACE_ADDRESS, postalCode: "78702" }),
    );

    await updateCommunityListing(
      deps,
      input({
        placeId: PLACE_ID,
        startsAt: new Date("2026-08-01T19:00:00.000Z"),
      }),
    );

    expect(eventChangeNoticesCreate).toHaveBeenCalledTimes(1);
    expect(eventChangeNoticesCreate).toHaveBeenCalledWith(
      expect.objectContaining({ changeType: "RESCHEDULED" }),
    );
  });

  it("an unlink at the unchanged address sends no notice but records placeId before/after", async () => {
    const { deps, audit, eventChangeNoticesCreate } = buildDeps(
      publishedListing({ placeId: PLACE_ID, ...PLACE_ADDRESS }),
    );

    await updateCommunityListing(deps, input({ placeId: null }));

    expect(eventChangeNoticesCreate).not.toHaveBeenCalled();
    expect(appliedAuditRow(audit)!.data).toMatchObject({
      material: false,
      changes: { placeId: { before: PLACE_ID, after: null } },
    });
  });

  it("a DRAFT place change sends no notice and writes no version-history row", async () => {
    const { deps, audit, eventChangeNoticesCreate } = buildDeps(
      draftListing({ placeId: OTHER_PLACE_ID }),
    );

    await updateCommunityListing(deps, input({ placeId: PLACE_ID }));

    expect(eventChangeNoticesCreate).not.toHaveBeenCalled();
    expect(appliedAuditRow(audit)).toBeUndefined();
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "community_listing.updated",
        data: expect.objectContaining({
          updatedFields: expect.arrayContaining(["placeId"]),
          fields: expect.objectContaining({ placeId: PLACE_ID }),
        }),
      }),
    );
  });
});

describe("updateCommunityListing — linking resets location privacy to the place's", () => {
  const REVEAL_AT = new Date("2026-07-31T20:00:00.000Z");
  const obscured = {
    locationMode: "OBSCURED" as const,
    locationRadiusMeters: 500,
    addressRevealAt: REVEAL_AT,
    addressRevealPreset: "DAY_BEFORE" as const,
  };

  it("an OBSCURED listing with a reveal schedule, relinked to an EXACT place, becomes EXACT with radius and reveal cleared", async () => {
    const { deps, applyCommunityEdit, audit } = buildDeps(
      publishedListing({ placeId: OTHER_PLACE_ID, ...obscured }),
    );

    const result = await updateCommunityListing(
      deps,
      input({ placeId: PLACE_ID }),
    );

    expect(applyCommunityEdit.mock.calls[0]![0]).toMatchObject({
      placeId: PLACE_ID,
      locationPrivacy: {
        locationMode: "EXACT",
        locationRadiusMeters: null,
        addressRevealAt: null,
        addressRevealPreset: null,
        addressRevealNotifiedAt: null,
      },
    });
    expect(result.updatedFields).toEqual(
      expect.arrayContaining([
        "locationMode",
        "locationRadiusMeters",
        "addressRevealAt",
        "addressRevealPreset",
      ]),
    );
    expect(appliedAuditRow(audit)!.data).toMatchObject({
      changes: {
        locationMode: { before: "OBSCURED", after: "EXACT" },
        locationRadiusMeters: { before: 500, after: null },
        addressRevealAt: { before: REVEAL_AT.toISOString(), after: null },
        addressRevealPreset: { before: "DAY_BEFORE", after: null },
      },
    });
  });

  it("a same-place re-sync with nothing else to change still resets the privacy, without a notice", async () => {
    const { deps, applyCommunityEdit, audit, eventChangeNoticesCreate } =
      buildDeps(publishedListing({ placeId: PLACE_ID, ...PLACE_ADDRESS, ...obscured }));

    const result = await updateCommunityListing(
      deps,
      input({ placeId: PLACE_ID }),
    );

    expect(applyCommunityEdit).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      fields: {},
      locationPrivacy: expect.objectContaining({ locationMode: "EXACT" }),
    });
    expect(result.updatedFields).not.toContain("placeId");
    expect(eventChangeNoticesCreate).not.toHaveBeenCalled();
    expect(appliedAuditRow(audit)!.data).toMatchObject({
      material: false,
      changes: { locationMode: { before: "OBSCURED", after: "EXACT" } },
    });
  });

  it("audits only the privacy columns that changed", async () => {
    const { deps, audit } = buildDeps(
      publishedListing({
        placeId: OTHER_PLACE_ID,
        locationMode: "EXACT",
        locationRadiusMeters: null,
        addressRevealAt: REVEAL_AT,
        addressRevealPreset: null,
      }),
    );

    await updateCommunityListing(deps, input({ placeId: PLACE_ID }));

    const changes = appliedAuditRow(audit)!.data.changes as Record<string, unknown>;
    expect(changes.addressRevealAt).toEqual({
      before: REVEAL_AT.toISOString(),
      after: null,
    });
    expect(changes).not.toHaveProperty("locationMode");
    expect(changes).not.toHaveProperty("locationRadiusMeters");
    expect(changes).not.toHaveProperty("addressRevealPreset");
  });

  it("an EXACT listing with no reveal schedule gets no privacy write", async () => {
    const { deps, applyCommunityEdit } = buildDeps(
      draftListing({ placeId: null, locationMode: "EXACT", locationRadiusMeters: 500 }),
    );

    await updateCommunityListing(deps, input({ placeId: PLACE_ID }));

    expect(applyCommunityEdit.mock.calls[0]![0]).not.toHaveProperty("locationPrivacy");
  });

  it("a DRAFT relink records the privacy reset in its audit row", async () => {
    const { deps, audit } = buildDeps(
      draftListing({ placeId: OTHER_PLACE_ID, ...obscured }),
    );

    await updateCommunityListing(deps, input({ placeId: PLACE_ID }));

    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "community_listing.updated",
        data: expect.objectContaining({
          fields: expect.objectContaining({
            locationMode: "EXACT",
            addressRevealAt: null,
          }),
        }),
      }),
    );
  });

  it("unlinking leaves the privacy columns alone", async () => {
    const { deps, applyCommunityEdit } = buildDeps(
      draftListing({ placeId: PLACE_ID, ...obscured }),
    );

    await updateCommunityListing(deps, input({ placeId: null }));

    expect(applyCommunityEdit.mock.calls[0]![0]).not.toHaveProperty("locationPrivacy");
  });
});

describe("updateCommunityListing — lock order", () => {
  it("linking: venue SHARED, then the row FOR UPDATE, then the read, then the place", async () => {
    const { deps, calls } = buildDeps(draftListing());

    await updateCommunityListing(deps, input({ placeId: PLACE_ID }));

    expect(calls).toEqual([
      `lockLocationsAtPlace:${PLACE_ID}:shared`,
      `lockRows:${EVENT_ID}:update`,
      `events.getById:${EVENT_ID}`,
      // The helper re-takes the SAME venue's shared lock before its read.
      `lockLocationsAtPlace:${PLACE_ID}:shared`,
      `places.getById:${PLACE_ID}`,
    ]);
  });

  it("the same-place re-sync takes the venue lock before reading the place", async () => {
    const { deps, calls } = buildDeps(
      draftListing({ placeId: PLACE_ID, ...PLACE_ADDRESS, postalCode: "78702" }),
    );

    await updateCommunityListing(deps, input({ placeId: PLACE_ID }));

    expect(calls[0]).toBe(`lockLocationsAtPlace:${PLACE_ID}:shared`);
    expect(calls.indexOf(`lockLocationsAtPlace:${PLACE_ID}:shared`)).toBeLessThan(
      calls.indexOf(`lockRows:${EVENT_ID}:update`),
    );
    expect(calls.lastIndexOf(`lockLocationsAtPlace:${PLACE_ID}:shared`)).toBeLessThan(
      calls.indexOf(`places.getById:${PLACE_ID}`),
    );
  });

  it("unlink takes the row lock and NO venue lock, not even the linked one", async () => {
    const { deps, calls, lockLocationsAtPlace } = buildDeps(
      draftListing({ placeId: PLACE_ID, ...PLACE_ADDRESS }),
    );

    await updateCommunityListing(deps, input({ placeId: null }));

    expect(lockLocationsAtPlace).not.toHaveBeenCalled();
    expect(calls).toEqual([
      `lockRows:${EVENT_ID}:update`,
      `events.getById:${EVENT_ID}`,
    ]);
  });

  it("an edit without placeId takes the row lock before reading, and no venue lock", async () => {
    const { deps, calls, lockLocationsAtPlace } = buildDeps(
      draftListing({ placeId: PLACE_ID, ...PLACE_ADDRESS }),
    );

    await updateCommunityListing(deps, input({ title: "New title" }));

    expect(lockLocationsAtPlace).not.toHaveBeenCalled();
    expect(calls).toEqual([
      `lockRows:${EVENT_ID}:update`,
      `events.getById:${EVENT_ID}`,
    ]);
  });
});

describe("public edit suggestions never carry placeId", () => {
  it("parseSuggestionFields rejects placeId as an unsupported field", () => {
    expect(() =>
      parseSuggestionFields({ placeId: PLACE_ID, title: "x" }),
    ).toThrow(
      expect.objectContaining({
        code: "EDIT_SUGGESTION_INVALID_FIELDS",
        meta: expect.objectContaining({
          reason: "unsupported_fields",
          fields: ["placeId"],
        }),
      }),
    );
  });
});

describe("placeId field classification", () => {
  it("is NOT material by itself and is not a suggestion-editable field", () => {
    expect(isMaterialField("placeId")).toBe(false);
    expect(SUGGESTION_EDITABLE_FIELDS as readonly string[]).not.toContain(
      "placeId",
    );
  });
});
