import { describe, expect, it, vi } from "vitest";

import { buildOffsetPaginatedResult } from "@th/ports/pagination";
import type { PlaceRecord, Repos } from "@th/ports/repos";
import type { HumanRecord } from "@th/types/repos/humans";
import { ok } from "@th/ports/search/types";

import { projectPublicEventLocation } from "../../../lib/location/project-public-event-location";
import { redactPlaceLocation } from "../../../lib/location/redact-place-location";
import { withSearchIndexFence } from "@th/test-utils/fakes/search-index-fence";
import { buildSearchIndex as buildSearchIndexFenced } from "../build-search-index";

/** The fixtures below predate the index-write fence; give them its surface. */
const buildSearchIndex: typeof buildSearchIndexFenced = (deps, input) =>
  buildSearchIndexFenced(
    { ...deps, repos: withSearchIndexFence(deps.repos) },
    input,
  );

// FR-003: the price resolver requires an injected instant. Frozen so these
// assertions describe a fixed moment; no fixture here carries a schedule, so
// the resolved price is the list price and every existing expectation holds.
const TEST_NOW = new Date("2026-01-01T00:00:00.000Z");
const testClock = { now: () => TEST_NOW };

const baseHuman: HumanRecord = {
  id: "00000000-0000-4000-8000-000000000101",
  name: "Demo Human",
  status: "ACTIVE",
  roles: [],
  locale: "en",
  phone: null,
  billingAddressLine1: null,
  billingAddressLine2: null,
  billingCity: null,
  billingState: null,
  billingPostalCode: null,
  billingCountry: null,
  defaultPrimaryPayoutTermsId: null,
  defaultResalePayoutTermsId: null,
  trustTier: "NEW",
  trustBadgeLabel: null,
  trustBadgeIcon: null,
  createdAt: new Date(),
};

const basePage = {
  ownerId: baseHuman.id,
  slug: "demo-human",
  displayName: "Demo Human",
  avatarUrl: null,
  bannerUrl: null,
};

const basePlace: PlaceRecord = {
  id: "00000000-0000-4000-8000-000000000202",
  name: "Demo Venue",
  slug: "demo-venue",
  formattedAddress: "123 Main St",
  addressLine1: "123 Main St",
  addressLine2: null,
  city: "San Francisco",
  region: "CA",
  postalCode: "94105",
  countryCode: "US",
  capacity: 100,
  lat: 37.78,
  lng: -122.4,
  status: "ACTIVE",
  verificationStatus: "VERIFIED",
  orgIdsWithAccess: [],
  humanIdsWithAccess: [],
};

const buildRepos = () => {
  const events = {
    listPublished: vi.fn(async () => buildOffsetPaginatedResult({ items: [] })),
  };

  const humans = {
    listForSearchIndex: vi.fn(async () =>
      buildOffsetPaginatedResult({
        items: [{ human: baseHuman, page: basePage }],
      }),
    ),
  };

  const places = {
    listForSearchIndex: vi.fn(async () =>
      buildOffsetPaginatedResult({ items: [basePlace] }),
    ),
    // The nightly place page is re-read under the index-write fence.
    getById: vi.fn(async (id: string) => (id === basePlace.id ? basePlace : null)),
  };

  const organizations = {
    listActive: vi.fn(async () => buildOffsetPaginatedResult({ items: [] })),
  };

  const categories = {
    listAll: vi.fn(async () => []),
  };

  return {
    events,
    humans,
    places,
    organizations,
    categories,
  } as unknown as Repos;
};

const TRUE_LAT = 40.6892;
const TRUE_LNG = -74.0445;

const baseEvent = {
  id: "00000000-0000-4000-8000-000000000303",
  slug: "secret-show",
  title: "Secret Show",
  status: "PUBLISHED" as const,
  // Ungated (N5: a missing gate fails closed to label only, no `_geo`).
  gateType: "NONE" as const,
  orgId: null,
  categoryId: null,
  addressText: "500 Hidden Way, Brooklyn, NY",
  lat: TRUE_LAT,
  lng: TRUE_LNG,
  locality: "Brooklyn",
  region: "NY",
  startsAt: new Date("2026-08-01T02:00:00.000Z"),
  endsAt: new Date("2026-08-01T05:00:00.000Z"),
  visibility: "PUBLIC" as "PUBLIC" | "PRIVATE",
  admissionTaxRateBps: 0,
};

const buildEventRepos = (
  locationMode: "EXACT" | "OBSCURED",
  locationRadiusMeters: number | null = 500,
  extra: Record<string, unknown> = {},
) => {
  const event = {
    ...baseEvent,
    locationMode,
    locationRadiusMeters,
    ...extra,
  };
  return {
    events: {
      getById: vi.fn(async () => event),
      getPopularityStats: vi.fn(async () => []),
      listTicketTypesForEventIds: vi.fn(async () => []),
      // loadListingBuyerTotalsByEventId → no payout terms and no policy at any
      // scope, so the buyer total is face + tax.
    },
    payoutTerms: {
      listByEvent: vi.fn(async () => []),
      listByEventIds: vi.fn(async () => new Map()),
    },
    feePolicies: {
      resolveEffective: vi.fn(async () => null),
      resolveEffectiveForScopes: vi.fn(async () => new Map()),
    },
    images: {
      getPrimaryImageRefs: vi.fn(
        async () => new Map<string, { publicUrl: string; key: string }>(),
      ),
    },
    imageModerationRecords: {
      resolveByKeys: vi.fn(async () => new Map()),
    },
    categories: {
      getById: vi.fn(async () => null),
    },
  } as unknown as Repos;
};

const collectEventDoc = async (
  locationMode: "EXACT" | "OBSCURED",
  locationRadiusMeters: number | null = 500,
  extra: Record<string, unknown> = {},
) => {
  const repos = buildEventRepos(locationMode, locationRadiusMeters, extra);
  const captured: Array<Record<string, unknown>> = [];
  const upsertDocuments = vi.fn(async ({ documents }) => {
    captured.push(...documents);
    return ok({ indexed: documents.length });
  });
  await buildSearchIndex(
    {
      clock: testClock,
      repos,
      search: {
        ensureIndexes: vi.fn(async () => ok(undefined)),
        // Non-destructive full rebuild: marker, then per-type sweep.
        beginSweep: vi.fn(async () => ok({ marker: "sweep-1" })),
        deleteUnswept: vi.fn(async () => ok({ deleted: 0 })),
        upsertDocuments,
        deleteDocuments: vi.fn(async () => ok(undefined)),
      } as any,
    },
    { eventIds: [baseEvent.id] },
  );
  return captured.find((d) => d.type === "event") as
    | {
        lat: number | null;
        lng: number | null;
        addressText: string | null;
      }
    | undefined;
};

describe("buildSearchIndex FR-013 location redaction", () => {
  it("EXACT event indexes the true pin + full street address", async () => {
    const doc = await collectEventDoc("EXACT");
    expect(doc).toBeDefined();
    expect(doc?.lat).toBe(TRUE_LAT);
    expect(doc?.lng).toBe(TRUE_LNG);
    expect(doc?.addressText).toBe("500 Hidden Way, Brooklyn, NY");
  });

  it("OBSCURED event indexes an obscured pin + coarse label, never the true values", async () => {
    const doc = await collectEventDoc("OBSCURED");
    expect(doc).toBeDefined();
    expect(doc?.lat).not.toBe(TRUE_LAT);
    expect(doc?.lng).not.toBe(TRUE_LNG);
    expect(doc?.addressText).toBe("Brooklyn, NY");
  });

  it("a GATED event (even EXACT) indexes NO coordinates and no street — geo search would be a distance oracle", async () => {
    for (const gateType of ["PASSWORD", "APPLICATION"]) {
      const doc = await collectEventDoc("EXACT", 500, { gateType });
      expect(doc).toBeDefined();
      expect(doc?.lat).toBeNull();
      expect(doc?.lng).toBeNull();
      expect(doc?.addressText).toBe("Brooklyn, NY");
    }
    const open = await collectEventDoc("EXACT", 500, { gateType: "NONE" });
    expect(open?.lat).toBe(TRUE_LAT);
  });

  it("stamps HOW to draw the point: a pin only for EXACT, the projection's circle radius otherwise", async () => {
    const exact = (await collectEventDoc("EXACT")) as Record<string, unknown>;
    expect(exact.locationIsExact).toBe(true);
    expect(exact.locationRadiusMeters).toBeNull();

    // 500 m is on the ladder, so the drawn radius is exactly the stored one.
    const obscured = (await collectEventDoc("OBSCURED", 500)) as Record<string, unknown>;
    expect(obscured.locationIsExact).toBe(false);
    expect(obscured.locationRadiusMeters).toBe(500);

    const hidden = (await collectEventDoc("OBSCURED", null)) as Record<string, unknown>;
    expect(hidden.locationIsExact).toBe(false);
    expect(hidden.locationRadiusMeters).toBeNull();

    // Gated: label only — no point, so nothing to draw, not even a circle.
    const gated = (await collectEventDoc("EXACT", 500, {
      gateType: "PASSWORD",
    })) as Record<string, unknown>;
    expect(gated.locationIsExact).toBe(false);
    expect(gated.locationRadiusMeters).toBeNull();
  });

  it("fully-hidden event (OBSCURED + null radius) indexes NO coordinates at all", async () => {
    const doc = await collectEventDoc("OBSCURED", null);
    expect(doc).toBeDefined();
    expect(doc?.lat).toBeNull();
    expect(doc?.lng).toBeNull();
    // Coarse label only — the street address never reaches the index.
    expect(doc?.addressText).toBe("Brooklyn, NY");
  });
});

describe("buildSearchIndex — the indexed point IS the public projection (D2)", () => {
  const HOUSE_ID = "00000000-0000-4000-8000-0000000000a9";
  const HOUSE = {
    id: HOUSE_ID,
    name: "Hidden Way House",
    locationMode: "OBSCURED",
    locationRadiusMeters: 800,
    formattedAddress: "500 Hidden Way, Brooklyn, NY",
    city: "Brooklyn",
    region: "NY",
    lat: TRUE_LAT,
    lng: TRUE_LNG,
    orgIdsWithAccess: [],
    humanIdsWithAccess: [],
    acceptsCommunityListings: false,
  };

  const indexOne = async (event: Record<string, unknown>) => {
    const repos = buildEventRepos("EXACT") as unknown as Record<string, any>;
    repos.events.getById = vi.fn(async () => event);
    repos.places = { getById: vi.fn(async () => HOUSE) };
    const captured: Array<Record<string, unknown>> = [];
    await buildSearchIndex(
      {
        clock: testClock,
        repos: repos as unknown as Repos,
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
        } as any,
      },
      { eventIds: [baseEvent.id] },
    );
    return captured.find((d) => d.type === "event") as Record<string, unknown>;
  };

  it("an OBSCURED event indexes EXACTLY the keyed circle centre the public pages draw", async () => {
    const event = { ...baseEvent, locationMode: "OBSCURED", locationRadiusMeters: 500 };
    const doc = await indexOne(event);
    const shown = projectPublicEventLocation(event);
    expect(doc.lat).toBe(shown.lat);
    expect(doc.lng).toBe(shown.lng);
    expect(doc.addressText).toBe("Brooklyn, NY");
  });

  it("a stale EXACT row at a WITHHELD venue indexes the VENUE's circle, never the street", async () => {
    const doc = await indexOne({
      ...baseEvent,
      placeId: HOUSE_ID,
      locationMode: "EXACT",
      locationRadiusMeters: null,
    });
    const venueCircle = redactPlaceLocation(HOUSE);
    expect(doc.lat).toBe(venueCircle.lat);
    expect(doc.lng).toBe(venueCircle.lng);
    expect(doc.lat).not.toBe(TRUE_LAT);
    // Drawn as the venue's approximate area (800 m snaps UP to the 1 km rung),
    // never as a pin — whatever the stale row claims.
    expect(doc.locationIsExact).toBe(false);
    expect(doc.locationRadiusMeters).toBe(venueCircle.radiusMeters);
    expect(doc.locationRadiusMeters).toBe(1_000);
    expect(doc.addressText).toBe("Brooklyn, NY");
    expect(JSON.stringify(doc)).not.toContain("Hidden Way,");
  });
});

// ── Visibility flag + render payload (isPublic / endsAt / city / addressText) ──
// The index must CARRY the event's visibility (PUBLIC → true, PRIVATE → false)
// and the full render payload, WITHOUT dropping non-public events (a later step
// gates them at query time via isPublic; admin search still needs them here).
describe("buildSearchIndex visibility + render payload stamping", () => {
  const collectEventDocForVisibility = async (
    visibility: "PUBLIC" | "PRIVATE",
  ) => {
    const event = {
      ...baseEvent,
      locationMode: "EXACT" as const,
      locationRadiusMeters: 500,
      visibility,
    };
    const repos = {
      events: {
        getById: vi.fn(async () => event),
        getPopularityStats: vi.fn(async () => []),
        listTicketTypesForEventIds: vi.fn(async () => []),
      },
      payoutTerms: {
        listByEvent: vi.fn(async () => []),
        listByEventIds: vi.fn(async () => new Map()),
      },
      feePolicies: {
        resolveEffective: vi.fn(async () => null),
        resolveEffectiveForScopes: vi.fn(async () => new Map()),
      },
      images: {
        getPrimaryImageRefs: vi.fn(
          async () => new Map<string, { publicUrl: string; key: string }>(),
        ),
      },
      imageModerationRecords: { resolveByKeys: vi.fn(async () => new Map()) },
      categories: { getById: vi.fn(async () => null) },
    } as unknown as Repos;

    const captured: Array<Record<string, unknown>> = [];
    const upsertDocuments = vi.fn(async ({ documents }) => {
      captured.push(...documents);
      return ok({ indexed: documents.length });
    });
    await buildSearchIndex(
      {
        clock: testClock,
        repos,
        search: {
          ensureIndexes: vi.fn(async () => ok(undefined)),
          // Non-destructive full rebuild: marker, then per-type sweep.
          beginSweep: vi.fn(async () => ok({ marker: "sweep-1" })),
          deleteUnswept: vi.fn(async () => ok({ deleted: 0 })),
          upsertDocuments,
          deleteDocuments: vi.fn(async () => ok(undefined)),
        } as any,
      },
      { eventIds: [event.id] },
    );
    return captured.find((d) => d.type === "event") as
      | {
          isPublic: boolean;
          endsAt: Date | null;
          city: string | null;
          addressText: string | null;
        }
      | undefined;
  };

  it("stamps isPublic: true for a PUBLIC event and carries endsAt/city/addressText", async () => {
    const doc = await collectEventDocForVisibility("PUBLIC");
    expect(doc).toBeDefined();
    expect(doc?.isPublic).toBe(true);
    expect(doc?.endsAt).toEqual(baseEvent.endsAt);
    // City is sourced from the event's locality.
    expect(doc?.city).toBe("Brooklyn");
    // EXACT event carries its full street address.
    expect(doc?.addressText).toBe("500 Hidden Way, Brooklyn, NY");
  });

  it("stamps isPublic: false for a PRIVATE event but STILL emits the doc", async () => {
    const doc = await collectEventDocForVisibility("PRIVATE");
    // The event is present in the index (not filtered out) — only flagged.
    expect(doc).toBeDefined();
    expect(doc?.isPublic).toBe(false);
    // Render payload is still populated regardless of visibility.
    expect(doc?.endsAt).toEqual(baseEvent.endsAt);
    expect(doc?.city).toBe("Brooklyn");
  });
});

describe("buildSearchIndex", () => {
  it("indexes humans and places on full reindex", async () => {
    const repos = buildRepos();
    const upsertDocuments = vi.fn(async ({ documents }) =>
      ok({ indexed: documents.length }),
    );
    const ensureIndexes = vi.fn(async () => ok(undefined));
    const deleteDocuments = vi.fn(async () => ok(undefined));
    const beginSweep = vi.fn(async () => ok({ marker: "sweep-1" }));
    const deleteUnswept = vi.fn(async (_input: { type: string }) =>
      ok({ deleted: 0 }),
    );

    const result = await buildSearchIndex(
      {
        clock: testClock,
        repos,
        search: {
          ensureIndexes,
          upsertDocuments,
          deleteDocuments,
          beginSweep,
          deleteUnswept,
        } as any,
      },
      { fullReindex: true, batchSize: 50 },
    );

    // NON-DESTRUCTIVE: nothing is cleared up front; each type's pass is
    // followed by a sweep of the documents it did not rewrite.
    expect(deleteDocuments).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: expect.anything() }),
    );
    expect(deleteUnswept.mock.calls.map(([c]) => c.type)).toEqual([
      "event",
      "human",
      "place",
      "organization",
    ]);

    expect(repos.humans.listForSearchIndex).toHaveBeenCalledWith({
      limit: 50,
      offset: 0,
    });
    expect(repos.places.listForSearchIndex).toHaveBeenCalledWith({
      limit: 50,
      offset: 0,
    });
    expect(result.humansIndexed).toBe(1);
    expect(result.placesIndexed).toBe(1);

    const indexedTypes = upsertDocuments.mock.calls.flatMap(([call]) =>
      call.documents.map((doc: { type: string }) => doc.type),
    );
    expect(indexedTypes).toContain("human");
    expect(indexedTypes).toContain("place");
  });
});

// ── Fee-inclusive buyer total: null-tax guard ─────────────────────────────
// A null `admissionTaxRateBps` makes the estimator compute tax as 0, so the
// buyer total would understate what checkout charges (checkout resolves tax
// live). The index must store null in that case so the card degrades to the
// face-value label instead of a confidently-understated "inclusive" price.
describe("buildSearchIndex fee-inclusive buyer total", () => {
  const PAID_TIER = {
    id: "00000000-0000-4000-8000-000000000404",
    eventId: baseEvent.id,
    status: "ACTIVE" as const,
    priceCents: 2500,
    pricingMode: "FIXED" as const,
  };

  const collectDocForTaxRate = async (admissionTaxRateBps: number | null) => {
    const event = {
      ...baseEvent,
      locationMode: "EXACT" as const,
      locationRadiusMeters: 500,
      admissionTaxRateBps,
    };
    const repos = {
      events: {
        getById: vi.fn(async () => event),
        getPopularityStats: vi.fn(async () => []),
        listTicketTypesForEventIds: vi.fn(async () => [PAID_TIER]),
      },
      payoutTerms: {
        listByEvent: vi.fn(async () => []),
        listByEventIds: vi.fn(async () => new Map()),
      },
      feePolicies: {
        resolveEffective: vi.fn(async () => null),
        resolveEffectiveForScopes: vi.fn(async () => new Map()),
      },
      images: {
        getPrimaryImageRefs: vi.fn(
          async () => new Map<string, { publicUrl: string; key: string }>(),
        ),
      },
      imageModerationRecords: { resolveByKeys: vi.fn(async () => new Map()) },
      categories: { getById: vi.fn(async () => null) },
    } as unknown as Repos;

    const captured: Array<Record<string, unknown>> = [];
    await buildSearchIndex(
      {
        clock: testClock,
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
        } as any,
      },
      { eventIds: [event.id] },
    );
    return captured.find((d) => d.type === "event") as
      | {
          lowestBuyerTotalCents: number | null;
          lowestPriceCents: number | null;
        }
      | undefined;
  };

  it("stores the fee-inclusive buyer total when the admission-tax rate is stamped (non-null)", async () => {
    const doc = await collectDocForTaxRate(0);
    expect(doc?.lowestBuyerTotalCents).toBe(2500);
  });

  it("an unstamped event stores the all-in figure at the rate the event page quotes", async () => {
    // No location on the fixture ⇒ `resolveQuoteTaxRateBps` quotes 0 (checkout
    // charges 0 there too), and no fee policy ⇒ the all-in figure is the face.
    const doc = await collectDocForTaxRate(null);
    expect(doc?.lowestBuyerTotalCents).toBe(2500);
    expect(doc?.lowestPriceCents).toBe(2500);
  });
});

// ── Hero image moderation gate (FR-005) ───────────────────────────────────
// Search cards must not surface a pending/flagged hero. The gate keeps only
// APPROVED heroes (or heroes with NO record — legacy/visible), in one batched
// resolveByKeys call.
describe("buildSearchIndex hero moderation gate", () => {
  const HERO_KEY = "events/secret-show/images/hero.png";
  const HERO_URL = `https://cdn.example/${HERO_KEY}`;

  const collectDocWithHero = async (
    status: "APPROVED" | "PENDING" | "FLAGGED" | "REJECTED" | null,
  ) => {
    const event = { ...baseEvent, locationMode: "EXACT" as const };
    const recordMap = new Map<string, { storageKey: string; status: string }>();
    if (status) recordMap.set(HERO_KEY, { storageKey: HERO_KEY, status });
    const resolveByKeys = vi.fn(
      async (keys: string[]) =>
        new Map(
          keys
            .filter((k) => recordMap.has(k))
            .map((k) => [k, recordMap.get(k)!]),
        ),
    );
    const repos = {
      events: {
        getById: vi.fn(async () => event),
        getPopularityStats: vi.fn(async () => []),
        listTicketTypesForEventIds: vi.fn(async () => []),
      },
      payoutTerms: {
        listByEvent: vi.fn(async () => []),
        listByEventIds: vi.fn(async () => new Map()),
      },
      feePolicies: {
        resolveEffective: vi.fn(async () => null),
        resolveEffectiveForScopes: vi.fn(async () => new Map()),
      },
      images: {
        getPrimaryImageRefs: vi.fn(
          async () =>
            new Map([[event.id, { publicUrl: HERO_URL, key: HERO_KEY }]]),
        ),
      },
      imageModerationRecords: { resolveByKeys },
      categories: { getById: vi.fn(async () => null) },
    } as unknown as Repos;

    const captured: Array<Record<string, unknown>> = [];
    await buildSearchIndex(
      {
        clock: testClock,
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
        } as any,
      },
      { eventIds: [event.id] },
    );
    const doc = captured.find((d) => d.type === "event") as
      | { imageUrl: string | null }
      | undefined;
    return { doc, resolveByKeys };
  };

  it("indexes an APPROVED hero url", async () => {
    const { doc, resolveByKeys } = await collectDocWithHero("APPROVED");
    expect(doc?.imageUrl).toBe(HERO_URL);
    expect(resolveByKeys).toHaveBeenCalledTimes(1);
    expect(resolveByKeys).toHaveBeenCalledWith([HERO_KEY]);
  });

  it.each(["PENDING", "FLAGGED", "REJECTED"] as const)(
    "drops a %s hero (indexes no image)",
    async (status) => {
      const { doc } = await collectDocWithHero(status);
      expect(doc?.imageUrl).toBeNull();
    },
  );

  it("indexes a legacy hero with NO moderation record", async () => {
    const { doc } = await collectDocWithHero(null);
    expect(doc?.imageUrl).toBe(HERO_URL);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Upsert-or-DELETE: the incremental event reindex must REMOVE a stale doc for
// any event that is no longer PUBLISHED (cancelled / unpublished-DRAFT / hidden
// / deleted / missing), keyed by its `event_<id>` doc id, so a hidden event
// doesn't linger on search + the search-served embed until the nightly rebuild.
// ─────────────────────────────────────────────────────────────────────────────
describe("buildSearchIndex event upsert-or-delete", () => {
  const EVENT_ID = "00000000-0000-4000-8000-0000000009aa";
  const DOC_ID = `event_${EVENT_ID}`;

  // getByIdResult === undefined → the event is missing (getById resolves null).
  const runReindex = async (
    getByIdResult: { status: string } | null,
  ): Promise<{
    upsertDocuments: ReturnType<typeof vi.fn>;
    deleteDocuments: ReturnType<typeof vi.fn>;
  }> => {
    const event =
      getByIdResult === null
        ? null
        : {
            ...baseEvent,
            id: EVENT_ID,
            status: getByIdResult.status,
            locationMode: "EXACT" as const,
            locationRadiusMeters: null,
          };
    const repos = {
      events: {
        getById: vi.fn(async () => event),
        getPopularityStats: vi.fn(async () => []),
        listTicketTypesForEventIds: vi.fn(async () => []),
      },
      payoutTerms: {
        listByEvent: vi.fn(async () => []),
        listByEventIds: vi.fn(async () => new Map()),
      },
      feePolicies: {
        resolveEffective: vi.fn(async () => null),
        resolveEffectiveForScopes: vi.fn(async () => new Map()),
      },
      images: {
        getPrimaryImageRefs: vi.fn(
          async () => new Map<string, { publicUrl: string; key: string }>(),
        ),
      },
      imageModerationRecords: { resolveByKeys: vi.fn(async () => new Map()) },
      categories: { getById: vi.fn(async () => null) },
    } as unknown as Repos;

    const upsertDocuments = vi.fn(async ({ documents }) =>
      ok({ indexed: documents.length }),
    );
    const deleteDocuments = vi.fn(async () => ok({ deleted: 1 }));

    await buildSearchIndex(
      {
        clock: testClock,
        repos,
        search: {
          ensureIndexes: vi.fn(async () => ok(undefined)),
          // Non-destructive full rebuild: marker, then per-type sweep.
          beginSweep: vi.fn(async () => ok({ marker: "sweep-1" })),
          deleteUnswept: vi.fn(async () => ok({ deleted: 0 })),
          upsertDocuments,
          deleteDocuments,
        } as any,
      },
      { eventIds: [EVENT_ID] },
    );

    return { upsertDocuments, deleteDocuments };
  };

  it("REMOVES a CANCELLED event's doc (does not upsert)", async () => {
    const { upsertDocuments, deleteDocuments } = await runReindex({
      status: "CANCELLED",
    });
    expect(deleteDocuments).toHaveBeenCalledWith({ ids: [DOC_ID] });
    expect(upsertDocuments).not.toHaveBeenCalled();
  });

  it.each(["DRAFT", "HIDDEN"] as const)(
    "REMOVES a %s (non-PUBLISHED) event's doc",
    async (status) => {
      const { upsertDocuments, deleteDocuments } = await runReindex({ status });
      expect(deleteDocuments).toHaveBeenCalledWith({ ids: [DOC_ID] });
      expect(upsertDocuments).not.toHaveBeenCalled();
    },
  );

  it("REMOVES a missing/deleted event's doc (getById → null)", async () => {
    const { upsertDocuments, deleteDocuments } = await runReindex(null);
    expect(deleteDocuments).toHaveBeenCalledWith({ ids: [DOC_ID] });
    expect(upsertDocuments).not.toHaveBeenCalled();
  });

  it("UPSERTS a PUBLISHED event's doc (no removal — publish path unchanged)", async () => {
    const { upsertDocuments, deleteDocuments } = await runReindex({
      status: "PUBLISHED",
    });
    expect(upsertDocuments).toHaveBeenCalledTimes(1);
    const [{ documents }] = upsertDocuments.mock.calls[0];
    expect(documents).toHaveLength(1);
    expect(documents[0].id).toBe(DOC_ID);
    expect(deleteDocuments).not.toHaveBeenCalled();
  });
});

// After a privacy scrub (`privacy-scrub.ts`) the incremental upsert is what
// puts the redacted document back. A failed upsert used to come back as
// "0 indexed, 0 errors", so `reindexAfterMutation` logged success and the
// entity sat out of search with no Sentry signal. It is a per-id error now.
describe("buildSearchIndex incremental upsert failure is a per-id error", () => {
  const failingSearch = () => ({
    ensureIndexes: vi.fn(async () => ok(undefined)),
    // Non-destructive full rebuild: marker, then per-type sweep.
    beginSweep: vi.fn(async () => ok({ marker: "sweep-1" })),
    deleteUnswept: vi.fn(async () => ok({ deleted: 0 })),
    upsertDocuments: vi.fn(async () => ({
      ok: false as const,
      error: new Error("index write failed"),
    })),
    deleteDocuments: vi.fn(async () => ok({ deleted: 0 })),
  });

  it("place: the failed id is reported in errors", async () => {
    const repos = {
      places: { getById: vi.fn(async () => basePlace) },
      entityPages: { getByOwner: vi.fn(async () => null) },
    } as unknown as Repos;

    const result = await buildSearchIndex(
      { clock: testClock, repos, search: failingSearch() as any },
      { placeIds: [basePlace.id] },
    );

    expect(result.placesIndexed).toBe(0);
    expect(result.errors).toEqual([
      {
        type: "place",
        id: basePlace.id,
        error: "upsert_failed: index write failed",
      },
    ]);
  });

  it("event: the failed id is reported in errors", async () => {
    const repos = buildEventRepos("EXACT", null);

    const result = await buildSearchIndex(
      { clock: testClock, repos, search: failingSearch() as any },
      { eventIds: [baseEvent.id] },
    );

    expect(result.eventsIndexed).toBe(0);
    expect(result.errors).toEqual([
      expect.objectContaining({ type: "event", id: baseEvent.id }),
    ]);
  });
});

// A batch that upserts some ids and removes others: when the REMOVAL fails
// (on Postgres, aborting the fence transaction), the upserted ids were rolled
// back too and must not be counted as indexed.
describe("buildSearchIndex remove-after-upsert failure", () => {
  it("a failed removal also marks the upserted ids as failed", async () => {
    const PUBLISHED = baseEvent.id;
    const DRAFT = "00000000-0000-4000-8000-000000000404";
    const repos = buildEventRepos("EXACT", null);
    const events = (repos as unknown as { events: Record<string, unknown> })
      .events;
    events.getById = vi.fn(async (id: string) =>
      id === DRAFT
        ? { ...baseEvent, id: DRAFT, status: "DRAFT" }
        : { ...baseEvent, locationMode: "EXACT", locationRadiusMeters: null },
    );

    const result = await buildSearchIndex(
      {
        clock: testClock,
        repos,
        search: {
          ensureIndexes: vi.fn(async () => ok(undefined)),
          // Non-destructive full rebuild: marker, then per-type sweep.
          beginSweep: vi.fn(async () => ok({ marker: "sweep-1" })),
          deleteUnswept: vi.fn(async () => ok({ deleted: 0 })),
          upsertDocuments: vi.fn(async ({ documents }) =>
            ok({ indexed: documents.length }),
          ),
          deleteDocuments: vi.fn(async () => ({
            ok: false as const,
            error: new Error("delete failed"),
          })),
        } as any,
      },
      { eventIds: [PUBLISHED, DRAFT] },
    );

    expect(result.eventsIndexed).toBe(0);
    expect(result.errors.map((e) => [e.id, e.error.split(":")[0]]).sort()).toEqual(
      [
        [DRAFT, "remove_failed"],
        [PUBLISHED, "upsert_failed"],
      ].sort(),
    );
  });
});

// ── The category tag is a fact about the event, not about `active` ─────────
// The full rebuild used to build its slug lookup from `listActive()` while the
// incremental path read `getById` with no active check, so the same event got
// a different `tags` array depending on which path wrote it last: after a
// deactivation the nightly rebuild dropped the tag and the next edit put it
// back. Both paths now tag every category; `discoverEventsByCategory` reads
// `Category.active`.
describe("buildSearchIndex category tag: full and incremental paths agree", () => {
  const INACTIVE_CATEGORY = {
    id: "00000000-0000-4000-8000-0000000000c1",
    slug: "nightlife",
    name: "Nightlife",
    active: false,
    sortOrder: 1,
    seoType: "MusicEvent",
    nameTranslations: { es: "Vida nocturna" },
    createdAt: TEST_NOW,
    updatedAt: TEST_NOW,
  };

  const reposWithInactiveCategory = () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- structural test double
    const repos = buildEventRepos("EXACT", 500, {
      categoryId: INACTIVE_CATEGORY.id,
    }) as any;
    let listed = false;
    repos.events.listPublished = vi.fn(async () => {
      if (listed) return buildOffsetPaginatedResult({ items: [] });
      listed = true;
      return buildOffsetPaginatedResult({
        items: [await repos.events.getById()],
      });
    });
    repos.humans = {
      listForSearchIndex: vi.fn(async () =>
        buildOffsetPaginatedResult({ items: [] }),
      ),
    };
    repos.places = {
      listForSearchIndex: vi.fn(async () =>
        buildOffsetPaginatedResult({ items: [] }),
      ),
    };
    repos.organizations = {
      listActive: vi.fn(async () => buildOffsetPaginatedResult({ items: [] })),
    };
    repos.categories = {
      // What the old full rebuild read: an inactive category is not in it.
      listActive: vi.fn(async () => []),
      listAll: vi.fn(async () => [INACTIVE_CATEGORY]),
      getById: vi.fn(async (id: string) =>
        id === INACTIVE_CATEGORY.id ? INACTIVE_CATEGORY : null,
      ),
    };
    return repos as Repos;
  };

  const eventTags = async (
    input: Parameters<typeof buildSearchIndex>[1],
    field: "tags" | "categoryNames" = "tags",
  ): Promise<string[] | undefined> => {
    const captured: Array<Record<string, unknown>> = [];
    await buildSearchIndex(
      {
        clock: testClock,
        repos: reposWithInactiveCategory(),
        search: {
          ensureIndexes: vi.fn(async () => ok(undefined)),
          beginSweep: vi.fn(async () => ok({ marker: "sweep-1" })),
          deleteUnswept: vi.fn(async () => ok({ deleted: 0 })),
          upsertDocuments: vi.fn(async ({ documents }) => {
            captured.push(...documents);
            return ok({ indexed: documents.length });
          }),
          deleteDocuments: vi.fn(async () => ok(undefined)),
        } as any,
      },
      input,
    );
    return captured.find((d) => d.type === "event")?.[field] as
      | string[]
      | undefined;
  };

  it("the FULL rebuild tags an event whose category is inactive", async () => {
    const tags = await eventTags({ fullReindex: true, batchSize: 50 });

    expect(tags).toContain("nightlife");
  });

  it("the incremental path writes the same tags for that event", async () => {
    const full = await eventTags({ fullReindex: true, batchSize: 50 });
    const incremental = await eventTags({ eventIds: [baseEvent.id] });

    expect(incremental).toContain("nightlife");
    expect(incremental).toEqual(full);
  });

  // category-translations spec: searchable text in every language, and never
  // a tag (the slug in `tags` is the only category filter).
  it("both paths put the English and translated names in categoryNames, not in tags", async () => {
    const full = await eventTags(
      { fullReindex: true, batchSize: 50 },
      "categoryNames",
    );
    const incremental = await eventTags(
      { eventIds: [baseEvent.id] },
      "categoryNames",
    );

    expect(full).toEqual(["Nightlife", "Vida nocturna"]);
    expect(incremental).toEqual(full);
    const tags = await eventTags({ fullReindex: true, batchSize: 50 });
    expect(tags).not.toContain("Vida nocturna");
    expect(tags).not.toContain("Nightlife");
  });
});

// The adapters format the result's date (`helper`, "Oct 12") in the doc's
// zone, so the indexer must carry `Event.timezone` onto the document.
// Regression (prod, 2026-10-13): with no zone, a UTC server printed a 7pm
// Chicago show as the next day.
describe("buildSearchIndex carries the event's timezone", () => {
  it("stamps Event.timezone on the event document", async () => {
    const doc = (await collectEventDoc("EXACT", null, {
      timezone: "America/Los_Angeles",
    })) as { timezone?: string } | undefined;
    expect(doc?.timezone).toBe("America/Los_Angeles");
  });

  it("falls back to America/Chicago for an unknown or missing zone", async () => {
    const unknown = (await collectEventDoc("EXACT", null, {
      timezone: "Mars/Olympus_Mons",
    })) as { timezone?: string } | undefined;
    expect(unknown?.timezone).toBe("America/Chicago");

    const missing = (await collectEventDoc("EXACT", null)) as
      | { timezone?: string }
      | undefined;
    expect(missing?.timezone).toBe("America/Chicago");
  });
});
