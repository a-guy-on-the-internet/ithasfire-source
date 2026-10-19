import { describe, expect, it, vi } from "vitest";

import type { CreateCommunityListingInput as RepoCreateInput } from "@th/ports/repos/events";
import type { PlaceRecord } from "@th/ports/repos/places";

import {
  createCommunityListing,
  createCommunityListingInputSchema,
  type CreateCommunityListingDeps,
} from "../create-community-listing";
import {
  ADMIN_ID,
  MODERATOR_ID,
  NOW,
  makeClock,
  makeContentFilter,
  makeStaffAuthz,
} from "./helpers";

/**
 * A community listing can be created AT a place (`placeId`). The place is the
 * source of truth for the address and pin; the listing is linked, never
 * confirmed.
 */

const PLACE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CREATED_EVENT_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

const BASE_INPUT = {
  actorHumanId: MODERATOR_ID,
  title: "Weekly Open Mic",
  startsAt: new Date("2026-08-01T20:00:00.000Z"),
  endsAt: new Date("2026-08-01T23:00:00.000Z"),
  timezone: "America/Chicago",
};

const FREEFORM_ADDRESS = {
  addressText: "123 Main St, Austin, TX",
  countryCode: "us",
  region: "TX",
  locality: "Austin",
  postalCode: "78701",
  lat: 30.27,
  lng: -97.74,
};

function makePlace(overrides: Partial<PlaceRecord> = {}): PlaceRecord {
  return {
    id: PLACE_ID,
    name: "The Mohawk",
    formattedAddress: "912 Red River St, Austin, TX 78701, USA",
    addressLine1: "912 Red River St",
    addressLine2: null,
    city: "Austin",
    region: "TX",
    postalCode: "78701",
    countryCode: "US",
    lat: 30.2697,
    lng: -97.7363,
    status: "ACTIVE",
    locationMode: "EXACT",
    locationRadiusMeters: null,
    locationLabel: null,
    ...overrides,
  } as PlaceRecord;
}

function buildDeps(place: PlaceRecord | null = makePlace()) {
  const createCommunityListingMock = vi.fn(async (input: RepoCreateInput) => ({
    id: CREATED_EVENT_ID,
    orgId: null,
    humanId: null,
    title: input.title,
    status: input.status,
    attendanceMode: input.attendanceMode,
    stewardship: input.stewardship,
    visibility: "PUBLIC",
    gateType: "NONE",
    timezone: input.timezone,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    slug: input.slug,
    shortId: input.shortId,
    publishedAt: input.publishedAt,
  }));
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
  createCommunityListingMock.mockImplementation(async (input: RepoCreateInput) => {
    calls.push("events.createCommunityListing");
    return {
      id: CREATED_EVENT_ID,
      orgId: null,
      humanId: null,
      title: input.title,
      status: input.status,
      attendanceMode: input.attendanceMode,
      stewardship: input.stewardship,
      visibility: "PUBLIC",
      gateType: "NONE",
      timezone: input.timezone,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      slug: input.slug,
      shortId: input.shortId,
      publishedAt: input.publishedAt,
    };
  });
  const audit = { log: vi.fn() };
  const txRepos = {
    events: {
      createCommunityListing: createCommunityListingMock,
      lockLocationsAtPlace,
    },
    categories: { getById: vi.fn(async () => null) },
    places: { getById: placesGetById },
    audit,
  };
  const deps: CreateCommunityListingDeps = {
    repos: {
      tx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(txRepos)),
    } as unknown as CreateCommunityListingDeps["repos"],
    authz: makeStaffAuthz({
      [MODERATOR_ID]: ["COMMUNITY_MODERATOR"],
      [ADMIN_ID]: ["ADMIN"],
    }),
    clock: makeClock(),
    contentFilter: makeContentFilter(),
  };
  return {
    deps,
    createCommunityListingMock,
    placesGetById,
    lockLocationsAtPlace,
    calls,
    audit,
  };
}

/** DRAFT keeps the tests off the PUBLISHED-only follower fan-out. */
const draft = { status: "DRAFT" as const };

describe("createCommunityListing at a place", () => {
  it("persists placeId and copies the address and pin from the place", async () => {
    const { deps, createCommunityListingMock, placesGetById } = buildDeps();

    await createCommunityListing(deps, {
      ...BASE_INPUT,
      ...draft,
      placeId: PLACE_ID,
    });

    expect(placesGetById).toHaveBeenCalledWith(PLACE_ID);
    const repoInput = createCommunityListingMock.mock.calls[0]![0];
    expect(repoInput).toMatchObject({
      placeId: PLACE_ID,
      addressText: "912 Red River St, Austin, TX 78701, USA",
      countryCode: "US",
      region: "TX",
      locality: "Austin",
      postalCode: "78701",
      lat: 30.2697,
      lng: -97.7363,
    });
    expect(repoInput.geohash6).toHaveLength(6);
    // The slug's geo segments come from the place, not the client.
    expect(repoInput.slug.startsWith("event/us/")).toBe(true);
  });

  it("ignores client-sent address values when a placeId is given", async () => {
    const { deps, createCommunityListingMock } = buildDeps();

    await createCommunityListing(deps, {
      ...BASE_INPUT,
      ...draft,
      placeId: PLACE_ID,
      addressText: "1 Somewhere Else, Paris",
      countryCode: "fr",
      region: "IDF",
      locality: "Paris",
      postalCode: "75001",
      lat: 48.86,
      lng: 2.35,
    });

    const repoInput = createCommunityListingMock.mock.calls[0]![0];
    expect(repoInput.addressText).toBe(
      "912 Red River St, Austin, TX 78701, USA",
    );
    expect(repoInput.countryCode).toBe("US");
    expect(repoInput.locality).toBe("Austin");
    expect(repoInput.postalCode).toBe("78701");
    expect(repoInput.lat).toBe(30.2697);
    expect(repoInput.lng).toBe(-97.7363);
    expect(repoInput.slug.startsWith("event/us/")).toBe(true);
  });

  it("writes placeId into the create audit row", async () => {
    const { deps, audit } = buildDeps();

    await createCommunityListing(deps, {
      ...BASE_INPUT,
      ...draft,
      placeId: PLACE_ID,
    });

    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "community_listing.created",
        data: expect.objectContaining({ placeId: PLACE_ID, countryCode: "US" }),
      }),
    );
  });

  it("sets no venue-confirmation field on the repo input", async () => {
    const { deps, createCommunityListingMock } = buildDeps();

    await createCommunityListing(deps, {
      ...BASE_INPUT,
      ...draft,
      placeId: PLACE_ID,
    });

    const repoInput = createCommunityListingMock.mock.calls[0]![0] as unknown as Record<
      string,
      unknown
    >;
    const confirmationKeys = Object.keys(repoInput).filter((key) =>
      /confirm/i.test(key),
    );
    expect(confirmationKeys).toEqual([]);
  });

  it.each([
    ["a missing place", null, "PLACE_NOT_FOUND"],
    ["a SUSPENDED place", makePlace({ status: "SUSPENDED" }), "PLACE_NOT_ACTIVE"],
    ["an ARCHIVED place", makePlace({ status: "ARCHIVED" }), "PLACE_ARCHIVED"],
    [
      "a place that withholds its address",
      makePlace({ locationMode: "OBSCURED", locationRadiusMeters: 500 }),
      "INVALID_INPUT",
    ],
    [
      "a place with no coordinates",
      makePlace({ lat: null, lng: null }),
      "INVALID_INPUT",
    ],
    [
      "a place with no formatted address",
      makePlace({ formattedAddress: null }),
      "INVALID_INPUT",
    ],
    [
      "a place with no country",
      makePlace({ countryCode: null }),
      "INVALID_INPUT",
    ],
  ] as const)("refuses %s and creates nothing", async (_label, place, code) => {
    const { deps, createCommunityListingMock, audit } = buildDeps(
      place as PlaceRecord | null,
    );

    await expect(
      createCommunityListing(deps, {
        ...BASE_INPUT,
        ...draft,
        placeId: PLACE_ID,
      }),
    ).rejects.toMatchObject({ code });

    expect(createCommunityListingMock).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it("names the reason when the place withholds its address", async () => {
    const { deps } = buildDeps(makePlace({ locationMode: "OBSCURED" }));

    await expect(
      createCommunityListing(deps, { ...BASE_INPUT, ...draft, placeId: PLACE_ID }),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      meta: { placeId: PLACE_ID, reason: "PLACE_WITHHOLDS_ADDRESS" },
    });
  });
});

describe("createCommunityListing — location privacy", () => {
  it("a listing created at a place takes the place's privacy: EXACT, no radius, no reveal", async () => {
    const { deps, createCommunityListingMock } = buildDeps();

    await createCommunityListing(deps, {
      ...BASE_INPUT,
      ...draft,
      placeId: PLACE_ID,
    });

    expect(createCommunityListingMock.mock.calls[0]![0].locationPrivacy).toEqual({
      locationMode: "EXACT",
      locationRadiusMeters: null,
      addressRevealAt: null,
      addressRevealPreset: null,
      addressRevealNotifiedAt: null,
    });
  });

  it("a freeform listing leaves the privacy columns to their defaults", async () => {
    const { deps, createCommunityListingMock } = buildDeps();

    await createCommunityListing(deps, {
      ...BASE_INPUT,
      ...draft,
      ...FREEFORM_ADDRESS,
    });

    expect(createCommunityListingMock.mock.calls[0]![0]).not.toHaveProperty(
      "locationPrivacy",
    );
  });
});

describe("createCommunityListing — lock order", () => {
  it("takes the venue's SHARED location lock before reading the place, then inserts", async () => {
    const { deps, calls } = buildDeps();

    await createCommunityListing(deps, {
      ...BASE_INPUT,
      ...draft,
      placeId: PLACE_ID,
    });

    expect(calls).toEqual([
      `lockLocationsAtPlace:${PLACE_ID}:shared`,
      `places.getById:${PLACE_ID}`,
      "events.createCommunityListing",
    ]);
  });

  it("takes no venue lock without a placeId", async () => {
    const { deps, lockLocationsAtPlace } = buildDeps();

    await createCommunityListing(deps, {
      ...BASE_INPUT,
      ...draft,
      ...FREEFORM_ADDRESS,
    });

    expect(lockLocationsAtPlace).not.toHaveBeenCalled();
  });
});

describe("createCommunityListing without a place (unchanged)", () => {
  it("writes the client address with placeId null and never reads a place", async () => {
    const { deps, createCommunityListingMock, placesGetById } = buildDeps();

    await createCommunityListing(deps, {
      ...BASE_INPUT,
      ...draft,
      ...FREEFORM_ADDRESS,
    });

    expect(placesGetById).not.toHaveBeenCalled();
    expect(createCommunityListingMock.mock.calls[0]![0]).toMatchObject({
      placeId: null,
      addressText: "123 Main St, Austin, TX",
      countryCode: "US",
      lat: 30.27,
      lng: -97.74,
    });
  });

  it.each(["addressText", "countryCode", "lat", "lng"] as const)(
    "still requires %s when no placeId is given",
    async (field) => {
      const { deps, createCommunityListingMock } = buildDeps();
      const { [field]: _omitted, ...address } = FREEFORM_ADDRESS;

      await expect(
        createCommunityListing(deps, { ...BASE_INPUT, ...draft, ...address }),
      ).rejects.toThrow();
      expect(createCommunityListingMock).not.toHaveBeenCalled();
    },
  );

  it("treats placeId: null as no place (address still required)", () => {
    const result = createCommunityListingInputSchema.safeParse({
      ...BASE_INPUT,
      placeId: null,
    });
    expect(result.success).toBe(false);
    const paths = result.error!.issues.map((issue) => issue.path.join("."));
    expect(paths).toEqual(
      expect.arrayContaining(["addressText", "countryCode", "lat", "lng"]),
    );
  });
});

describe("createCommunityListingInputSchema", () => {
  it("accepts a placeId with no address fields", () => {
    expect(
      createCommunityListingInputSchema.safeParse({
        ...BASE_INPUT,
        placeId: PLACE_ID,
      }).success,
    ).toBe(true);
  });

  it("rejects unknown keys", () => {
    const result = createCommunityListingInputSchema.safeParse({
      ...BASE_INPUT,
      placeId: PLACE_ID,
      venueConfirmedAt: NOW,
    });
    expect(result.success).toBe(false);
    expect(result.error!.issues[0]!.code).toBe("unrecognized_keys");
  });

  it("rejects a placeId that is not a uuid", () => {
    expect(
      createCommunityListingInputSchema.safeParse({
        ...BASE_INPUT,
        placeId: "not-a-uuid",
      }).success,
    ).toBe(false);
  });
});
