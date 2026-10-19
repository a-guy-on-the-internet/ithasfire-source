import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Repos } from "@th/ports/repos";
import type { OrgRole } from "@th/ports/repos/authz";
import type { EventRecord } from "@th/ports/repos/events";
import type { PlaceListItemRecord, PlaceRecord } from "@th/ports/repos/places";
import { buildOffsetPaginatedResult } from "@th/ports/pagination";

import {
  configureLocationObfuscation,
  resetLocationObfuscationForTests,
} from "../../../lib/location/obfuscation-key";
import { getEventForEdit } from "../../events/get-event-for-edit";
import { searchOrgAdmin } from "../../search/search-org-admin";
import { listHumanPlaces } from "../list-human-places";

/**
 * D5 — THE MANAGE BAR (B7, B3, W1).
 *
 * A withheld venue's real address unlocks on a management surface only for a
 * viewer who passes `canManagePlace`: a verified direct owner, or
 * OWNER/ADMIN/EDITOR in an owning org. Commit 493751b4 set that bar on
 * `getPlaceForEdit`; `listHumanPlaces`, `getEventForEdit` and
 * `searchOrgAdmin` unlocked on ANY membership, so a door SCANNER — or a
 * VIEWER, or a FINANCE member — could read the street of a house through a
 * table, the event builder, or the spotlight search.
 *
 * Every test here is the same shape: the actor belongs to the org that owns a
 * WITHHELD house, with one role. The street, the postcode and the true
 * coordinates appear in the payload iff the role clears the bar.
 */

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const HOUSE_ID = "33333333-3333-4333-8333-333333333333";
/** The performer's org that OWNS the event (the actor is its EDITOR). */
const PERFORMER_ORG_ID = "44444444-4444-4444-8444-444444444444";
const EVENT_ID = "55555555-5555-4555-8555-555555555555";

const STREET = "1417 Shelby Ave";
const POSTCODE = "37206";
const TRUE_LAT = 36.1775;
const TRUE_LNG = -86.7412;

const MANAGERS: OrgRole[] = ["OWNER", "ADMIN", "EDITOR"];
const NON_MANAGERS: OrgRole[] = ["SCANNER", "VIEWER", "FINANCE"];

function house(overrides: Partial<PlaceRecord> = {}): PlaceRecord {
  return {
    id: HOUSE_ID,
    name: "The Shelby House",
    slug: null,
    formattedAddress: `${STREET}, Nashville, TN ${POSTCODE}`,
    addressLine1: STREET,
    addressLine2: null,
    city: "Nashville",
    region: "TN",
    postalCode: POSTCODE,
    countryCode: "US",
    addressHash: null,
    admissionTaxRateBps: null,
    taxRateSource: null,
    taxRateFetchedAt: null,
    timezone: "America/Chicago",
    capacity: 60,
    lat: TRUE_LAT,
    lng: TRUE_LNG,
    phone: null,
    website: null,
    status: "ACTIVE",
    verificationStatus: "VERIFIED",
    listedInDirectory: false,
    acceptsBookingRequests: false,
    acceptsCommunityListings: false,
    // WITHHELD, with a public circle.
    locationMode: "OBSCURED",
    locationRadiusMeters: 800,
    locationLabel: "East Nashville",
    orgIdsWithAccess: [ORG_ID],
    humanIdsWithAccess: [],
    defaultPrimaryPayoutTermsId: null,
    defaultResalePayoutTermsId: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  } as unknown as PlaceRecord;
}

/**
 * The org membership repo and the `canManagePlace` probe for an actor with
 * `role` in the owning org. The probe mirrors the authz adapter's rule
 * (`db-authz-adapter.ts`): a verified direct owner, or an edit-level role in
 * an owning org. Core cannot import the adapter, so this is its mirror.
 */
function access(role: OrgRole, place: PlaceRecord = house()) {
  const membership = { orgId: ORG_ID, humanId: ACTOR_ID, role };
  const canManagePlace = vi.fn(
    async ({ placeId }: { placeId: string; actorHumanId: string }) => ({
      allowed:
        placeId === place.id &&
        (place.humanIdsWithAccess.includes(ACTOR_ID) ||
          (place.orgIdsWithAccess.includes(ORG_ID) &&
            MANAGERS.includes(role))),
    }),
  );
  return {
    authzRepo: {
      getOrgMembership: vi.fn(async () => membership),
      getOrgMemberships: vi.fn(async ({ orgIds }: { orgIds: string[] }) =>
        orgIds.includes(ORG_ID) ? [membership] : [],
      ),
    },
    authz: { canManagePlace, hasStaffRole: vi.fn(async () => ({ allowed: false })) },
  };
}

/**
 * No street, postcode or true coordinate anywhere in the payload. Tokens are
 * matched WHOLE (not followed/preceded by another digit): an obfuscated
 * longitude such as -86.74372065… legitimately contains the digits "37206".
 */
function expectNoTruth(payload: unknown) {
  const json = JSON.stringify(payload);
  const token = (value: string) =>
    new RegExp(`(^|[^0-9.])${value.replace(/[.]/g, "\\.")}($|[^0-9])`);
  expect(json).not.toContain(STREET);
  expect(json).not.toMatch(token(POSTCODE));
  expect(json).not.toMatch(token(String(TRUE_LAT)));
  expect(json).not.toMatch(token(String(TRUE_LNG)));
}

beforeEach(() => {
  configureLocationObfuscation({ secret: "manage-bar-test" });
});

afterEach(() => {
  resetLocationObfuscationForTests();
});

// ── listHumanPlaces (B7) ────────────────────────────────────────────────────

function listDeps(role: OrgRole, place: PlaceRecord = house()) {
  const a = access(role, place);
  const repos = {
    humans: { getById: vi.fn(async () => ({ id: ACTOR_ID })) },
    places: {
      listAccessibleByHuman: vi.fn(async () =>
        buildOffsetPaginatedResult({
          items: [{ ...place, eventsCount: 3 } as PlaceListItemRecord],
          limit: 20,
          offset: 0,
          total: 1,
        }),
      ),
    },
    authz: a.authzRepo,
    placeVerificationRequests: {
      getActiveStatusByPlaceIds: vi.fn(async () => new Map()),
    },
  } as unknown as Repos;
  return { deps: { repos, authz: a.authz }, authz: a.authz };
}

describe("listHumanPlaces — withheld venue, actor in the owning org", () => {
  it.each(NON_MANAGERS)("%s sees NO street, postcode or coordinates", async (role) => {
    const { deps } = listDeps(role);

    const result = await listHumanPlaces(deps, {
      actorHumanId: ACTOR_ID,
      ownedOnly: true,
    });

    const row = result.places[0]!;
    expect(row.locationIsExact).toBe(false);
    expect(row.formattedAddress).toBeNull();
    expect(row.addressLine1).toBeNull();
    expect(row.postalCode).toBeNull();
    expect(row.areaLabel).toBe("East Nashville");
    expectNoTruth(result);
  });

  it.each(MANAGERS)("%s sees the real address", async (role) => {
    const { deps } = listDeps(role);

    const result = await listHumanPlaces(deps, {
      actorHumanId: ACTOR_ID,
      ownedOnly: true,
    });

    const row = result.places[0]!;
    expect(row.locationIsExact).toBe(true);
    expect(row.addressLine1).toBe(STREET);
    expect(row.lat).toBe(TRUE_LAT);
  });

  it("the membership read only nominates — `canManagePlace` has the final word", async () => {
    // An EDITOR whose org's ownership was revoked since the page was read:
    // the batched membership says "maybe", the probe says no.
    const { deps, authz } = listDeps("EDITOR");
    authz.canManagePlace.mockResolvedValueOnce({ allowed: false });

    const result = await listHumanPlaces(deps, {
      actorHumanId: ACTOR_ID,
      ownedOnly: true,
    });

    expect(authz.canManagePlace).toHaveBeenCalledWith({
      actorHumanId: ACTOR_ID,
      placeId: HOUSE_ID,
    });
    expect(result.places[0]!.locationIsExact).toBe(false);
    expectNoTruth(result);
  });

  it("a SCANNER costs no probe at all (the batched pre-filter drops them)", async () => {
    const { deps, authz } = listDeps("SCANNER");

    await listHumanPlaces(deps, { actorHumanId: ACTOR_ID, ownedOnly: true });

    expect(authz.canManagePlace).not.toHaveBeenCalled();
  });

  it("an EXACT venue is untouched and never probed", async () => {
    const { deps, authz } = listDeps(
      "SCANNER",
      house({ locationMode: "EXACT", locationRadiusMeters: null }),
    );

    const result = await listHumanPlaces(deps, {
      actorHumanId: ACTOR_ID,
      ownedOnly: true,
    });

    expect(result.places[0]!.addressLine1).toBe(STREET);
    expect(authz.canManagePlace).not.toHaveBeenCalled();
  });
});

// ── getEventForEdit (B7 + B3) ───────────────────────────────────────────────

function eventAtHouse(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    id: EVENT_ID,
    title: "Basement Show",
    stewardship: "OWNED",
    status: "PUBLISHED",
    visibility: "PUBLIC",
    gateType: "NONE",
    locationMode: "OBSCURED",
    locationRadiusMeters: 800,
    locationLabel: null,
    addressRevealAt: new Date("2026-10-09T20:00:00.000Z"),
    addressRevealPreset: "DAY_BEFORE",
    timezone: "America/Chicago",
    startsAt: new Date("2026-10-10T20:00:00.000Z"),
    endsAt: new Date("2026-10-10T23:00:00.000Z"),
    orgId: PERFORMER_ORG_ID,
    humanId: null,
    placeId: HOUSE_ID,
    savedLocationId: null,
    categoryId: null,
    categorySeoType: null,
    placeName: "The Shelby House",
    // A LEGACY row: written before D1, it still carries the house. The read
    // must not trust it.
    addressText: `${STREET}, Nashville, TN ${POSTCODE}`,
    locality: "Nashville",
    region: "TN",
    countryCode: "US",
    postalCode: POSTCODE,
    lat: TRUE_LAT,
    lng: TRUE_LNG,
    slug: null,
    shortId: null,
    regionCode: null,
    publishedAt: null,
    payoutTermsId: null,
    resalePayoutTermsId: null,
    heroImageUrl: null,
    ...overrides,
  } as unknown as EventRecord;
}

/**
 * The actor is EDITOR of the performer org that owns the EVENT (so the
 * builder opens) and holds `venueRole` in the org that owns the VENUE — the
 * old gate unlocked the house for ANY such membership.
 */
function editDeps(venueRole: OrgRole, event: EventRecord = eventAtHouse()) {
  const a = access(venueRole);
  a.authzRepo.getOrgMembership.mockImplementation(async ({ orgId }: { orgId: string }) =>
    orgId === PERFORMER_ORG_ID
      ? { orgId, humanId: ACTOR_ID, role: "EDITOR" as OrgRole }
      : { orgId, humanId: ACTOR_ID, role: venueRole },
  );
  const repos = {
    events: {
      getById: vi.fn(async () => event),
      getContent: vi.fn(async () => null),
      getPopularityStats: vi.fn(async () => []),
    },
    places: { getById: vi.fn(async () => house()) },
    categories: { getById: vi.fn(async () => null) },
    seriesOccurrences: {
      getCalendarInfoForEventIds: vi.fn(async () => []),
    },
    authz: a.authzRepo,
  } as unknown as Repos;
  return { repos, authz: a.authz };
}

describe("getEventForEdit — event at a withheld venue", () => {
  it.each(NON_MANAGERS)(
    "the event's EDITOR who is only %s at the venue sees neither the venue's nor the event's street (B7 + B3)",
    async (venueRole) => {
      const deps = editDeps(venueRole);

      const result = await getEventForEdit(deps, {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
      });

      expect(result.place).toMatchObject({
        id: HOUSE_ID,
        name: "The Shelby House",
        formattedAddress: null,
      });
      // The event's OWN columns: re-derived as the public projection even
      // though this legacy row still stores the house.
      expect(result.addressText).toBe("East Nashville");
      expect(result.postalCode).toBeNull();
      expect(result.lat).not.toBe(TRUE_LAT);
      expect(result.lng).not.toBe(TRUE_LNG);
      expectNoTruth(result);
    },
  );

  it.each(MANAGERS)("%s at the venue (a manager) sees the real venue address", async (venueRole) => {
    const result = await getEventForEdit(editDeps(venueRole), {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
    });
    expect(result.place?.formattedAddress).toContain(STREET);
    expect(result.place?.lat).toBe(TRUE_LAT);
  });

  it("the manage bar is `canManagePlace` itself, not the membership", async () => {
    const deps = editDeps("OWNER");
    deps.authz.canManagePlace.mockResolvedValue({ allowed: false });

    const result = await getEventForEdit(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
    });

    expect(deps.authz.canManagePlace).toHaveBeenCalledWith({
      actorHumanId: ACTOR_ID,
      placeId: HOUSE_ID,
    });
    expectNoTruth(result);
  });

  it("for a row written under D1 the redaction is a no-op: the stored projection IS what is served", async () => {
    // What the adapter stores at this venue (see place-event-location.test).
    const { projectEventLocationAtPlace } = await import(
      "../../../lib/location/place-event-location"
    );
    const stored = projectEventLocationAtPlace(house(), {
      locationMode: "OBSCURED",
      locationRadiusMeters: 800,
    }).columns;
    const deps = editDeps(
      "SCANNER",
      eventAtHouse({
        addressText: stored.addressText,
        lat: stored.lat,
        lng: stored.lng,
        postalCode: stored.postalCode,
      }),
    );

    const result = await getEventForEdit(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
    });

    expect({
      addressText: result.addressText,
      lat: result.lat,
      lng: result.lng,
      postalCode: result.postalCode,
    }).toEqual({
      addressText: stored.addressText,
      lat: stored.lat,
      lng: stored.lng,
      postalCode: stored.postalCode,
    });
  });

  it("an EXACT venue is never probed and the event's columns pass through", async () => {
    const deps = editDeps("SCANNER");
    (deps.repos.places.getById as ReturnType<typeof vi.fn>).mockResolvedValue(
      house({ locationMode: "EXACT", locationRadiusMeters: null }),
    );

    const result = await getEventForEdit(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
    });

    expect(deps.authz.canManagePlace).not.toHaveBeenCalled();
    expect(result.addressText).toContain(STREET);
  });
});

// ── searchOrgAdmin (W1) ─────────────────────────────────────────────────────

function searchDeps(role: OrgRole) {
  const a = access(role);
  const repos = {
    authz: a.authzRepo,
    places: {
      listAccessibleByHuman: vi.fn(async () => ({
        items: [house()],
        pageInfo: { total: 1, limit: 20, offset: 0 },
      })),
    },
  } as unknown as Repos;
  return { repos, authz: a.authz };
}

describe("searchOrgAdmin — venues group, withheld venue", () => {
  const input = {
    actorHumanId: ACTOR_ID,
    ownerType: "ORGANIZATION" as const,
    ownerId: ORG_ID,
    query: "shelby",
    types: ["venue" as const],
  };

  it.each(NON_MANAGERS)("%s gets the area label, never the street", async (role) => {
    const result = await searchOrgAdmin(searchDeps(role), input);

    expect(result.venues).toEqual([
      { id: HOUSE_ID, name: "The Shelby House", address: "East Nashville" },
    ]);
    expectNoTruth(result);
  });

  it.each(MANAGERS)("%s gets the real address", async (role) => {
    const result = await searchOrgAdmin(searchDeps(role), input);

    expect(result.venues[0]!.address).toBe(
      `${STREET}, Nashville, TN ${POSTCODE}`,
    );
  });
});
