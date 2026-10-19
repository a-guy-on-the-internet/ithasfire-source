import { describe, expect, it, vi } from "vitest";

import { encodeGeohash } from "../../../lib/geo/geohash";
import { buildOffsetPaginatedResult } from "@th/ports/pagination";
import type { OffsetPaginatedResult } from "@th/ports/pagination";
import type { Repos } from "@th/ports/repos";
import type {
  PlaceListItemRecord,
  PlaceRecord,
} from "@th/ports/repos/places";
import { ok } from "@th/ports/search/types";
import { buildPlaceJsonLd, buildPlaceMetadata } from "@th/types";
import type { SeoPlace } from "@th/types";
import { createTestLogger } from "@th/test-utils/fakes/logger";

import { loadEntitySummary } from "../../entity-pages/entity-summary";
import { withSearchIndexFence } from "@th/test-utils/fakes/search-index-fence";
import { buildSearchIndex as buildSearchIndexFenced } from "../../search/build-search-index";

/** The fixtures below predate the index-write fence; give them its surface. */
const buildSearchIndex: typeof buildSearchIndexFenced = (deps, input) =>
  buildSearchIndexFenced(
    { ...deps, repos: withSearchIndexFence(deps.repos) },
    input,
  );
import { getPlacePublic } from "../get-place-public";
import { listHumanPlaces } from "../list-human-places";
import { listPlaceSitemapEntries } from "../list-place-sitemap-entries";

/**
 * PLACE ADDRESS WITHHOLDING — the leak suite.
 *
 * A DIY punk house lists as a venue and never publishes where it is. A LEAK is
 * the failure mode here, not a bug, so every public read path a Place has gets
 * pinned individually: the EntityPage read, the place API read, JSON-LD, the
 * OG/metadata payload, the search document, the sitemap, and the admin table.
 *
 * The bar for each: NO street address, and NO fine geohash.
 *
 * `THE_STREET` is the single string that must not appear anywhere in this
 * file's public outputs — several assertions serialize the whole payload and
 * search for it, which catches a leak through a field nobody thought to name.
 */

const HOUSE_ID = "00000000-0000-4000-8000-0000000000a1";
const CLUB_ID = "00000000-0000-4000-8000-0000000000a2";
const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG_ID = "22222222-2222-4222-8222-222222222222";

const THE_STREET = "1417 Shelby Ave";
const THE_POSTCODE = "37206";
const TRUE_LAT = 36.1775;
const TRUE_LNG = -86.7412;

function makePlace(overrides: Partial<PlaceRecord> = {}): PlaceRecord {
  return {
    id: HOUSE_ID,
    name: "The Shelby House",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    formattedAddress: `${THE_STREET}, Nashville, TN ${THE_POSTCODE}`,
    addressLine1: THE_STREET,
    addressLine2: "Basement",
    city: "Nashville",
    region: "TN",
    postalCode: THE_POSTCODE,
    countryCode: "US",
    capacity: 60,
    lat: TRUE_LAT,
    lng: TRUE_LNG,
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
    // WITHHELD, fully hidden.
    locationMode: "OBSCURED",
    locationRadiusMeters: null,
    locationLabel: "East Nashville",
    orgIdsWithAccess: [],
    humanIdsWithAccess: [ACTOR_ID],
    defaultPrimaryPayoutTermsId: null,
    defaultResalePayoutTermsId: null,
    ...overrides,
  } as unknown as PlaceRecord;
}

/** A public club, for the "nothing changed for existing venues" arm. */
const makeClub = (overrides: Partial<PlaceRecord> = {}) =>
  makePlace({
    id: CLUB_ID,
    name: "The Basement East",
    locationMode: "EXACT",
    locationRadiusMeters: null,
    locationLabel: null,
    ...overrides,
  });

/** Serializes any payload and asserts the street/postcode are nowhere in it. */
function expectNoStreetAnywhere(payload: unknown) {
  const serialized = JSON.stringify(payload);
  expect(serialized).not.toContain(THE_STREET);
  expect(serialized).not.toContain(THE_POSTCODE);
}

/** Geohash base32 (no a, i, l, o). */
const GEOHASH8 = /^[0123456789bcdefghjkmnpqrstuvwxyz]{8}$/;

/** The true point encoded at length 8 — the exact string a leak would emit. */
const TRUE_GEOHASH8 = encodeGeohash(TRUE_LAT, TRUE_LNG, 8);

/**
 * A geohash of length 8 pins to ~38 m x 19 m — that cell IS the house. Walks
 * VALUES only (a key like `"currency"` is 8 legal characters and is not a
 * geohash), and additionally pins the exact encoding of the true point so a
 * leak under any key name at all fails this.
 */
function expectNoFineGeohash(payload: unknown) {
  const suspects: string[] = [];
  const walk = (node: unknown) => {
    if (typeof node === "string") {
      if (GEOHASH8.test(node)) suspects.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node && typeof node === "object") {
      Object.values(node as Record<string, unknown>).forEach(walk);
    }
  };
  walk(payload);
  expect(suspects).toEqual([]);
  expect(JSON.stringify(payload)).not.toContain(TRUE_GEOHASH8);
}

// ─── 1. The place API read ──────────────────────────────────────────────────

describe("LEAK GATE: getPlacePublic (the place API read)", () => {
  const deps = (place: PlaceRecord) =>
    ({
      repos: { places: { getById: vi.fn(async () => place) } } as unknown as Repos,
      logger: createTestLogger(),
    });

  it("withholds the street address, postcode and coordinates", async () => {
    const { place } = await getPlacePublic(deps(makePlace()), {
      placeId: HOUSE_ID,
    });

    expect(place.formattedAddress).toBeNull();
    expect(place.lat).toBeNull();
    expect(place.lng).toBeNull();
    expect(place.locationIsExact).toBe(false);
    expect(place.locationHidden).toBe(true);
    expectNoStreetAnywhere(place);
    expectNoFineGeohash(place);
  });

  it("still publishes the coarse area so the venue stays findable", async () => {
    const { place } = await getPlacePublic(deps(makePlace()), {
      placeId: HOUSE_ID,
    });

    expect(place.city).toBe("Nashville");
    expect(place.region).toBe("TN");
    expect(place.areaLabel).toBe("East Nashville");
    expect(place.name).toBe("The Shelby House");
  });

  it("publishes an OFFSET circle centre, never the true pin, when a radius is set", async () => {
    const { place } = await getPlacePublic(
      deps(makePlace({ locationRadiusMeters: 2000 })),
      { placeId: HOUSE_ID },
    );

    expect(place.locationHidden).toBe(false);
    expect(place.locationRadiusMeters).toBe(2000);
    expect(place.lat).not.toBe(TRUE_LAT);
    expect(place.lng).not.toBe(TRUE_LNG);
    expect(place.formattedAddress).toBeNull();
  });

  it("changes NOTHING for an existing EXACT venue", async () => {
    const { place } = await getPlacePublic(deps(makeClub()), {
      placeId: CLUB_ID,
    });

    expect(place.formattedAddress).toBe(
      `${THE_STREET}, Nashville, TN ${THE_POSTCODE}`,
    );
    expect(place.lat).toBe(TRUE_LAT);
    expect(place.locationIsExact).toBe(true);
  });
});

// ─── 2. The EntityPage read ─────────────────────────────────────────────────

describe("LEAK GATE: loadEntitySummary (the EntityPage read)", () => {
  const deps = (place: PlaceRecord) =>
    ({
      repos: {
        places: {
          getById: vi.fn(async () => place),
          getVerifiedOwnershipForPlace: vi.fn(async () => null),
        },
        placeVerificationRequests: {
          getActiveClaimForPlace: vi.fn(async () => null),
        },
        calendars: { countAvailabilityForPlace: vi.fn(async () => 1) },
      },
    }) as never;

  it("withholds the address on the venue's own public page", async () => {
    const summary = await loadEntitySummary(deps(makePlace()), "PLACE", HOUSE_ID);

    expect(summary).toMatchObject({
      type: "PLACE",
      formattedAddress: null,
      lat: null,
      lng: null,
      locationIsExact: false,
      locationHidden: true,
      areaLabel: "East Nashville",
    });
    expectNoStreetAnywhere(summary);
    expectNoFineGeohash(summary);
  });

  it("redacts for the OWNER'S EDITOR PREVIEW too — it renders what a stranger sees", async () => {
    // This loader is shared by get-public-page AND get-my-page on purpose, so
    // the two surfaces cannot disagree. For someone hiding their house, seeing
    // the redacted view in their own preview is the only trustworthy
    // confirmation the setting worked.
    const summary = await loadEntitySummary(deps(makePlace()), "PLACE", HOUSE_ID);
    expect(summary).toMatchObject({ formattedAddress: null });
  });

  it("changes NOTHING for an existing EXACT venue", async () => {
    const summary = await loadEntitySummary(deps(makeClub()), "PLACE", CLUB_ID);
    expect(summary).toMatchObject({
      formattedAddress: `${THE_STREET}, Nashville, TN ${THE_POSTCODE}`,
      lat: TRUE_LAT,
      locationIsExact: true,
    });
  });
});

// ─── 3 + 4. JSON-LD and the OG / metadata payload ───────────────────────────

describe("LEAK GATE: JSON-LD and the OG/metadata payload", () => {
  /** Exactly what the web layer builds from `getPlacePublic`'s output. */
  const toSeoPlace = async (place: PlaceRecord): Promise<SeoPlace> => {
    const { place: pub } = await getPlacePublic(
      {
        repos: {
          places: { getById: vi.fn(async () => place) },
        } as unknown as Repos,
      },
      { placeId: place.id },
    );
    return {
      placeId: pub.placeId,
      url: "https://ithasfire.com/p/shelby-house-a1b2c3d4",
      name: pub.name,
      formattedAddress: pub.formattedAddress,
      city: pub.city,
      region: pub.region,
      countryCode: pub.countryCode,
      lat: pub.lat,
      lng: pub.lng,
      isExact: pub.locationIsExact,
      radiusMeters: pub.locationRadiusMeters,
      capacity: pub.capacity,
    };
  };

  it("emits no streetAddress and no GeoCoordinates for a fully-hidden venue", async () => {
    const jsonLd = buildPlaceJsonLd(await toSeoPlace(makePlace()));

    expect(jsonLd.address).toMatchObject({
      addressLocality: "Nashville",
      addressRegion: "TN",
    });
    expect(jsonLd.address).not.toHaveProperty("streetAddress");
    // Fully hidden = no coordinates reached the payload, so no `geo` at all.
    expect(jsonLd).not.toHaveProperty("geo");
    expectNoStreetAnywhere(jsonLd);
    expectNoFineGeohash(jsonLd);
  });

  it("emits a GeoCircle — never a sharp pin — for a circled venue", async () => {
    const jsonLd = buildPlaceJsonLd(
      await toSeoPlace(makePlace({ locationRadiusMeters: 2000 })),
    );

    expect(jsonLd.geo).toMatchObject({
      "@type": "GeoCircle",
      geoRadius: 2000,
    });
    expect(jsonLd.geo).not.toHaveProperty("latitude");
    expect(jsonLd.address).not.toHaveProperty("streetAddress");
    expectNoStreetAnywhere(jsonLd);
  });

  it("keeps sharp GeoCoordinates for an existing EXACT venue", async () => {
    const jsonLd = buildPlaceJsonLd(await toSeoPlace(makeClub()));

    expect(jsonLd.geo).toEqual({
      "@type": "GeoCoordinates",
      latitude: TRUE_LAT,
      longitude: TRUE_LNG,
    });
    expect(jsonLd.address).toMatchObject({ streetAddress: expect.any(String) });
  });

  it("keeps the street address out of the OG / share metadata", async () => {
    // There is no generated OG image for a place; `buildPlaceMetadata` IS the
    // whole share payload (title, description, og:*, twitter:*).
    const meta = buildPlaceMetadata({
      place: await toSeoPlace(makePlace()),
      siteName: "Ithas Fire",
    });

    expect(meta.description).toBe(
      "Events at The Shelby House — Nashville, TN, US",
    );
    expectNoStreetAnywhere(meta);
    expectNoFineGeohash(meta);
  });
});

// ─── 5. The search document ─────────────────────────────────────────────────

describe("LEAK GATE: the search document", () => {
  function buildIndexDeps(places: PlaceRecord[]) {
    const captured: Array<Record<string, unknown>> = [];
    const repos = {
      events: {
        listPublished: vi.fn(async () =>
          buildOffsetPaginatedResult({ items: [] }),
        ),
        getById: vi.fn(async () => null),
      },
      humans: {
        listForSearchIndex: vi.fn(async () =>
          buildOffsetPaginatedResult({ items: [] }),
        ),
      },
      places: {
        listForSearchIndex: vi.fn(async () =>
          buildOffsetPaginatedResult({ items: places }),
        ),
        getById: vi.fn(async (id: string) =>
          places.find((p) => p.id === id) ?? null,
        ),
      },
      organizations: {
        listActive: vi.fn(async () => buildOffsetPaginatedResult({ items: [] })),
      },
      categories: { listAll: vi.fn(async () => []) },
      entityPages: {
        getByOwner: vi.fn(async () => null),
        getByOwners: vi.fn(async () => []),
      },
    } as unknown as Repos;

    return {
      captured,
      deps: {
        clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
        repos,
        search: {
          ensureIndexes: vi.fn(async () => ok(undefined)),
          // Non-destructive full rebuild: marker, then per-type sweep.
          beginSweep: vi.fn(async () => ok({ marker: "sweep-1" })),
          deleteUnswept: vi.fn(async () => ok({ deleted: 0 })),
          upsertDocuments: vi.fn(async ({ documents }) => {
            captured.push(...documents);
            return ok({ indexed: documents.length });
          }),
          deleteDocuments: vi.fn(async () => ok(undefined)),
        },
      } as never,
    };
  }

  const placeDoc = (captured: Array<Record<string, unknown>>) =>
    captured.find((d) => d.type === "place")!;

  it("never writes the street address into the index", async () => {
    const { deps, captured } = buildIndexDeps([makePlace()]);
    await buildSearchIndex(deps, { fullReindex: true });

    const doc = placeDoc(captured);
    expect(doc.formattedAddress).toBeNull();
    expect(doc.lat).toBeNull();
    expect(doc.lng).toBeNull();
    expect(doc.locationHidden).toBe(true);
    expectNoStreetAnywhere(doc);
  });

  it("indexes NO geohash for a fully hidden venue — not even the coarse cell (W7)", async () => {
    const { deps, captured } = buildIndexDeps([makePlace()]);
    await buildSearchIndex(deps, { fullReindex: true });

    const doc = placeDoc(captured);
    // A cell of the TRUE point is a position; a hidden venue publishes none.
    expect(doc.geohash6).toBeNull();
    expect(doc).not.toHaveProperty("geohash8");
    expectNoFineGeohash(doc);
  });

  it("a circled venue indexes the coarse cell of its EMITTED centre, never the true point (W7)", async () => {
    const { deps, captured } = buildIndexDeps([
      makePlace({ locationRadiusMeters: 800 }),
    ]);
    await buildSearchIndex(deps, { fullReindex: true });

    const doc = placeDoc(captured);
    expect(doc.lat).not.toBe(TRUE_LAT);
    expect(doc.geohash6).toBe(
      encodeGeohash(doc.lat as number, doc.lng as number, 6),
    );
    expectNoFineGeohash(doc);
  });

  it("applies the same gate on the TARGETED (by-id) reindex path", async () => {
    const { deps, captured } = buildIndexDeps([makePlace()]);
    await buildSearchIndex(deps, { placeIds: [HOUSE_ID] });

    const doc = placeDoc(captured);
    expect(doc.formattedAddress).toBeNull();
    expectNoStreetAnywhere(doc);
  });

  it("changes NOTHING for an existing EXACT venue", async () => {
    const { deps, captured } = buildIndexDeps([makeClub()]);
    await buildSearchIndex(deps, { fullReindex: true });

    const doc = placeDoc(captured);
    expect(doc.formattedAddress).toBe(
      `${THE_STREET}, Nashville, TN ${THE_POSTCODE}`,
    );
    expect(doc.lat).toBe(TRUE_LAT);
    expect(doc.locationIsExact).toBe(true);
  });
});

// ─── 6. The sitemap ─────────────────────────────────────────────────────────

describe("LEAK GATE: the places sitemap", () => {
  it("carries a slug and a date and nothing else — no address surface exists", async () => {
    const deps = {
      repos: {
        places: {
          listForSitemap: vi.fn(async () => [
            {
              placeId: HOUSE_ID,
              pageSlug: "shelby-house-a1b2c3d4",
              pageVisibility: "PUBLIC" as const,
              updatedAt: new Date("2026-01-01T00:00:00.000Z"),
            },
          ]),
        },
      } as unknown as Repos,
      logger: createTestLogger(),
      reportError: vi.fn(),
    };

    const entries = await listPlaceSitemapEntries(deps, {});

    expect(entries).toEqual([
      {
        placeId: HOUSE_ID,
        pageSlug: "shelby-house-a1b2c3d4",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    // Structural, not incidental: `PlaceSitemapEntryRecord` has no address
    // fields at all, so the sitemap cannot leak one. Pinned so a future
    // "enrich the sitemap" change has to break this test to land.
    expectNoStreetAnywhere(entries);
    expect(Object.keys(entries[0]!)).toEqual([
      "placeId",
      "pageSlug",
      "updatedAt",
    ]);
  });
});

// ─── 7. The admin places table ──────────────────────────────────────────────

describe("LEAK GATE: the admin places table (listHumanPlaces)", () => {
  const listItem = (place: PlaceRecord): PlaceListItemRecord =>
    ({ ...place, eventsCount: 0 }) as PlaceListItemRecord;

  function buildDeps(places: PlaceListItemRecord[], orgIds: string[] = []) {
    const repos = {
      places: {
        listAccessibleByHuman: vi.fn(
          async (): Promise<OffsetPaginatedResult<PlaceListItemRecord>> =>
            buildOffsetPaginatedResult({ items: places }),
        ),
      },
      humans: {
        getById: vi.fn(async () => ({
          id: ACTOR_ID,
          name: "Organizer",
          status: "ACTIVE",
          roles: ["USER"],
          createdAt: new Date(),
        })),
      },
      authz: {
        getOrgMemberships: vi.fn(async ({ orgIds: asked }: { orgIds: string[] }) =>
          asked
            .filter((id) => orgIds.includes(id))
            .map((orgId) => ({ orgId, role: "OWNER" })),
        ),
      },
      placeVerificationRequests: {
        getActiveStatusByPlaceIds: vi.fn(async () => new Map()),
      },
    } as unknown as Repos;

    // The D5 manage bar (`canManagePlace`), answered as the real adapter
    // does: a verified direct owner, or an edit-level role in an owning org.
    // The memberships above are all OWNER, so any owning-org link passes.
    const authz = {
      canManagePlace: vi.fn(async ({ placeId }: { placeId: string }) => {
        const place = places.find((p) => p.id === placeId);
        return {
          allowed:
            !!place &&
            (place.humanIdsWithAccess.includes(ACTOR_ID) ||
              place.orgIdsWithAccess.some((id) => orgIds.includes(id))),
        };
      }),
    };

    return { repos, authz, logger: createTestLogger() };
  }

  it("withholds a NON-OWNED venue's address from every other organizer", async () => {
    // This listing deliberately includes globally-VERIFIED venues the actor
    // does not own — that is what makes the venue picker useful, and it is
    // also what makes it a cross-tenant read.
    const notOurs = listItem(
      makePlace({ humanIdsWithAccess: [], orgIdsWithAccess: [OTHER_ORG_ID] }),
    );

    const result = await listHumanPlaces(buildDeps([notOurs]), {
      actorHumanId: ACTOR_ID,
    });

    const row = result.places[0]!;
    expect(row.formattedAddress).toBeNull();
    expect(row.addressLine1).toBeNull();
    expect(row.postalCode).toBeNull();
    expect(row.lat).toBeNull();
    expect(row.lng).toBeNull();
    expect(row.locationIsExact).toBe(false);
    expectNoStreetAnywhere(result);
    expectNoFineGeohash(result);
  });

  it("shows the OWNER their own withheld venue's real address", async () => {
    const ours = listItem(makePlace({ humanIdsWithAccess: [ACTOR_ID] }));

    const result = await listHumanPlaces(buildDeps([ours]), {
      actorHumanId: ACTOR_ID,
    });

    expect(result.places[0]!.formattedAddress).toBe(
      `${THE_STREET}, Nashville, TN ${THE_POSTCODE}`,
    );
    expect(result.places[0]!.locationIsExact).toBe(true);
  });

  it("shows an ORG member their org's withheld venue", async () => {
    const orgOwned = listItem(
      makePlace({ humanIdsWithAccess: [], orgIdsWithAccess: [OTHER_ORG_ID] }),
    );

    const result = await listHumanPlaces(
      buildDeps([orgOwned], [OTHER_ORG_ID]),
      { actorHumanId: ACTOR_ID },
    );

    expect(result.places[0]!.locationIsExact).toBe(true);
    expect(result.places[0]!.addressLine1).toBe(THE_STREET);
  });

  it("changes NOTHING for a non-owned EXACT venue", async () => {
    const publicClub = listItem(
      makeClub({ humanIdsWithAccess: [], orgIdsWithAccess: [OTHER_ORG_ID] }),
    );

    const result = await listHumanPlaces(buildDeps([publicClub]), {
      actorHumanId: ACTOR_ID,
    });

    expect(result.places[0]!.formattedAddress).toBe(
      `${THE_STREET}, Nashville, TN ${THE_POSTCODE}`,
    );
    expect(result.places[0]!.lat).toBe(TRUE_LAT);
  });
});

// ─── 8. An event AT the withheld place ──────────────────────────────────────
//
// The event-side ceiling is pinned in full in
// `use-cases/events/__tests__/venue-address-ceiling.test.ts` (write path +
// public SEO read). This block covers the third surface the event has — the
// SEARCH INDEX — because it reads `Event.locationMode` off the stored row and
// would otherwise keep publishing the pin of an event that was PUBLISHED
// BEFORE its venue was withheld.

describe("LEAK GATE: an event at a withheld place, in the search index", () => {
  const EVENT_ID = "00000000-0000-4000-8000-0000000000e1";

  const publishedEventAtHouse = {
    id: EVENT_ID,
    slug: "basement-show",
    title: "Basement Show",
    status: "PUBLISHED",
    visibility: "PUBLIC",
    // Ungated (N5: a missing gate fails closed to label only).
    gateType: "NONE",
    placeId: HOUSE_ID,
    // Still EXACT on the row: published before the house was withheld.
    locationMode: "EXACT",
    locationRadiusMeters: null,
    addressText: `${THE_STREET}, Nashville, TN ${THE_POSTCODE}`,
    locality: "Nashville",
    region: "TN",
    regionCode: "TN",
    countryCode: "US",
    lat: TRUE_LAT,
    lng: TRUE_LNG,
    startsAt: new Date("2026-02-01T18:00:00.000Z"),
    endsAt: new Date("2026-02-01T23:00:00.000Z"),
    heroImageKey: null,
    categoryId: null,
    orgId: null,
    humanId: ACTOR_ID,
    venueConfirmationStampedAt: null,
    venueConfirmationWithdrawnAt: null,
  } as never;

  function buildEventIndexDeps(place: PlaceRecord) {
    const captured: Array<Record<string, unknown>> = [];
    const repos = {
      events: {
        listPublished: vi.fn(async () =>
          buildOffsetPaginatedResult({ items: [publishedEventAtHouse] }),
        ),
        getById: vi.fn(async () => publishedEventAtHouse),
        listTicketTypesForEventIds: vi.fn(async () => []),
        getPopularityStats: vi.fn(async () => []),
      },
      humans: {
        listForSearchIndex: vi.fn(async () =>
          buildOffsetPaginatedResult({ items: [] }),
        ),
      },
      places: {
        listForSearchIndex: vi.fn(async () =>
          buildOffsetPaginatedResult({ items: [] }),
        ),
        getById: vi.fn(async () => place),
      },
      organizations: {
        listActive: vi.fn(async () => buildOffsetPaginatedResult({ items: [] })),
      },
      categories: { listAll: vi.fn(async () => []), getById: vi.fn(async () => null) },
      entityPages: {
        getByOwner: vi.fn(async () => null),
        getByOwners: vi.fn(async () => []),
      },
      images: {
        getPrimaryImageRefs: vi.fn(async () => new Map()),
        getByKeys: vi.fn(async () => []),
      },
      imageModerationRecords: {
        listByKeys: vi.fn(async () => []),
        getByKeys: vi.fn(async () => []),
      },
      payoutTerms: { listByEvent: vi.fn(async () => []) },
      feePolicies: { resolveEffective: vi.fn(async () => null) },
      platformSettings: { getAll: vi.fn(async () => []) },
    } as unknown as Repos;

    return {
      captured,
      deps: {
        clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
        repos,
        search: {
          ensureIndexes: vi.fn(async () => ok(undefined)),
          // Non-destructive full rebuild: marker, then per-type sweep.
          beginSweep: vi.fn(async () => ok({ marker: "sweep-1" })),
          deleteUnswept: vi.fn(async () => ok({ deleted: 0 })),
          upsertDocuments: vi.fn(async ({ documents }) => {
            captured.push(...documents);
            return ok({ indexed: documents.length });
          }),
          deleteDocuments: vi.fn(async () => ok(undefined)),
        },
      } as never,
    };
  }

  const eventDoc = (captured: Array<Record<string, unknown>>) =>
    captured.find((d) => d.type === "event")!;

  it("re-clamps an already-published EXACT event once its venue is withheld", async () => {
    const { deps, captured } = buildEventIndexDeps(makePlace());
    await buildSearchIndex(deps, { fullReindex: true });

    const doc = eventDoc(captured);
    // No pin, no street address — the venue publishes no map, so nor does the
    // event inside it, and the organizer did not have to re-save anything.
    expect(doc.lat).toBeNull();
    expect(doc.lng).toBeNull();
    expect(doc.addressText).toBe("Nashville, TN");
    expectNoStreetAnywhere(doc);
    expectNoFineGeohash(doc);
  });

  it("changes NOTHING for the same event at an EXACT venue", async () => {
    const { deps, captured } = buildEventIndexDeps(makeClub({ id: HOUSE_ID }));
    await buildSearchIndex(deps, { fullReindex: true });

    const doc = eventDoc(captured);
    expect(doc.lat).toBe(TRUE_LAT);
    expect(doc.addressText).toBe(
      `${THE_STREET}, Nashville, TN ${THE_POSTCODE}`,
    );
  });

  it("fails CLOSED when the venue row cannot be read at all", async () => {
    // A vanished place must not hand the indexer an EXACT floor. A degraded
    // index pass that hides a venue too hard self-heals on the next pass; a
    // published pin does not un-publish.
    const { deps, captured } = buildEventIndexDeps(null as never);
    await buildSearchIndex(deps, { fullReindex: true });

    const doc = eventDoc(captured);
    expect(doc.lat).toBeNull();
    expectNoStreetAnywhere(doc);
  });
});
