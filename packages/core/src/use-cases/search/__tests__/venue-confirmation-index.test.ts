import { describe, expect, it, vi } from "vitest";

import type { Repos } from "@th/ports/repos";
import { ok } from "@th/ports/search/types";

import { withSearchIndexFence } from "@th/test-utils/fakes/search-index-fence";
import { buildSearchIndex as buildSearchIndexFenced } from "../build-search-index";

/** The fixtures below predate the index-write fence; give them its surface. */
const buildSearchIndex: typeof buildSearchIndexFenced = (deps, input) =>
  buildSearchIndexFenced(
    { ...deps, repos: withSearchIndexFence(deps.repos) },
    input,
  );

// Venue-confirmation spec (docs/specs/2026-08-27): the public search document
// names the place (`venueId`) ONLY when the venue vouches for the event —
// venue-owned, or stamped and not withdrawn. An unconfirmed third-party claim
// indexes address-only. Places are resolved ONCE per distinct placeId per
// batch, never per event.

const TEST_NOW = new Date("2026-01-01T00:00:00.000Z");
const testClock = { now: () => TEST_NOW };

const PLACE_A = "00000000-0000-4000-8000-00000000a001";
const PLACE_B = "00000000-0000-4000-8000-00000000a002";
const VENUE_ORG = "00000000-0000-4000-8000-00000000c001";
const VENUE_HUMAN = "00000000-0000-4000-8000-00000000c002";
const OTHER_ORG = "00000000-0000-4000-8000-00000000c003";
/** Unowned, ACTIVE, bulk-import default `listedInDirectory: false`. */
const PLACE_C = "00000000-0000-4000-8000-00000000a003";
/** Same as PLACE_C but WITHHELD (place OBSCURED with a radius). */
const PLACE_D = "00000000-0000-4000-8000-00000000a004";

const baseEvent = {
  slug: "show",
  title: "Show",
  status: "PUBLISHED" as const,
  orgId: null as string | null,
  humanId: null as string | null,
  categoryId: null,
  addressText: "1 Main St",
  lat: 36.16,
  lng: -86.78,
  locality: "Nashville",
  region: "TN",
  locationMode: "EXACT" as const,
  locationRadiusMeters: null,
  startsAt: new Date("2026-08-01T02:00:00.000Z"),
  endsAt: null,
  visibility: "PUBLIC" as const,
  venueConfirmedAt: null as Date | null,
  venueConfirmationWithdrawnAt: null as Date | null,
  venueConfirmedPlaceId: null as string | null,
};

type Ev = typeof baseEvent & { id: string; placeId: string | null };

function ev(id: string, overrides: Partial<Ev>): Ev {
  return { ...baseEvent, id: `00000000-0000-4000-8000-0000000000${id}`, placeId: PLACE_A, ...overrides };
}

async function indexEvents(
  events: Ev[],
  options: { placesError?: Error; reportError?: (...args: unknown[]) => void } = {},
) {
  const getPlaceById = vi.fn(async (id: string) =>
    options.placesError
      ? Promise.reject(options.placesError)
      : id === PLACE_A
      ? { id, name: "The Basement East", status: "ACTIVE", listedInDirectory: true, orgIdsWithAccess: [VENUE_ORG], humanIdsWithAccess: [VENUE_HUMAN] }
      : id === PLACE_C
      ? { id, name: "Corner Bar", status: "ACTIVE", listedInDirectory: false, locationMode: "EXACT", orgIdsWithAccess: [], humanIdsWithAccess: [] }
      : id === PLACE_D
      ? { id, name: "Hidden Loft", status: "ACTIVE", listedInDirectory: false, locationMode: "OBSCURED", locationRadiusMeters: 500, lat: 36.16, lng: -86.78, locality: "Nashville", region: "TN", orgIdsWithAccess: [], humanIdsWithAccess: [] }
      : id === PLACE_B
        ? { id, orgIdsWithAccess: [], humanIdsWithAccess: [] }
          : null,
  );
  const byId = new Map(events.map((e) => [e.id, e]));
  const repos = {
    events: {
      getById: vi.fn(async (id: string) => byId.get(id) ?? null),
      getPopularityStats: vi.fn(async () => []),
      listTicketTypesForEventIds: vi.fn(async () => []),
    },
    places: { getById: getPlaceById },
    payoutTerms: {
      listByEvent: vi.fn(async () => []),
      listByEventIds: vi.fn(async () => new Map()),
    },
    feePolicies: {
      resolveEffective: vi.fn(async () => null),
      resolveEffectiveForScopes: vi.fn(async () => new Map()),
    },
    images: { getPrimaryImageRefs: vi.fn(async () => new Map()) },
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
        upsertDocuments,
        deleteDocuments: vi.fn(async () => ok(undefined)),
      } as any,
      ...(options.reportError ? { reportError: options.reportError as never } : {}),
    },
    { eventIds: events.map((e) => e.id) },
  );
  const docs = new Map(
    captured.filter((d) => d.type === "event").map((d) => [d.eventId as string, d as { venueId: string | null; venueName?: string | null }]),
  );
  return { docs, getPlaceById };
}

describe("buildSearchIndex — venueId is confirmed-only", () => {
  it("an UNCONFIRMED third-party event indexes with venueId null (address-only)", async () => {
    const { docs } = await indexEvents([ev("01", { orgId: OTHER_ORG })]);
    expect(docs.get(ev("01", {}).id)?.venueId).toBeNull();
  });

  it("a STAMPED third-party event keeps venueId; a WITHDRAWN one loses it", async () => {
    const { docs } = await indexEvents([
      ev("02", { orgId: OTHER_ORG, venueConfirmedPlaceId: PLACE_A, venueConfirmedAt: new Date("2026-06-01T00:00:00.000Z") }),
      ev("03", {
        orgId: OTHER_ORG,
        venueConfirmedPlaceId: PLACE_A, venueConfirmedAt: new Date("2026-06-01T00:00:00.000Z"),
        venueConfirmationWithdrawnAt: new Date("2026-06-02T00:00:00.000Z"),
      }),
    ]);
    expect(docs.get(ev("02", {}).id)?.venueId).toBe(PLACE_A);
    expect(docs.get(ev("03", {}).id)?.venueId).toBeNull();
  });

  it("venue-owned events (org or direct human owner) keep venueId without a stamp", async () => {
    const { docs } = await indexEvents([
      ev("04", { orgId: VENUE_ORG }),
      ev("05", { humanId: VENUE_HUMAN }),
    ]);
    expect(docs.get(ev("04", {}).id)?.venueId).toBe(PLACE_A);
    expect(docs.get(ev("05", {}).id)?.venueId).toBe(PLACE_A);
  });

  it("resolves each distinct place ONCE per batch, never per event; a missing place fails closed", async () => {
    const { docs, getPlaceById } = await indexEvents([
      ev("06", { orgId: VENUE_ORG }),
      ev("07", { orgId: VENUE_ORG }),
      ev("08", { orgId: VENUE_ORG, placeId: PLACE_B }),
      ev("09", { orgId: VENUE_ORG, placeId: "00000000-0000-4000-8000-00000000a999" }),
      ev("10", { orgId: VENUE_ORG, placeId: null }),
    ]);
    // Each DISTINCT place is read once — 5 events on 3 places, not 5 reads.
    // The TAX SITUS reader (`loadListingBuyerTotalsByEventId`) touches Place
    // only for an event it can price; these have no paid tiers, so the
    // venue-confirmation resolver is the only reader here.
    expect(getPlaceById).toHaveBeenCalledTimes(3);
    expect(docs.get(ev("06", {}).id)?.venueId).toBe(PLACE_A);
    expect(docs.get(ev("07", {}).id)?.venueId).toBe(PLACE_A);
    // PLACE_B has no owners and the event is unstamped → not confirmed.
    expect(docs.get(ev("08", {}).id)?.venueId).toBeNull();
    // Vanished place → no owners → not confirmed.
    expect(docs.get(ev("09", {}).id)?.venueId).toBeNull();
    expect(docs.get(ev("10", {}).id)?.venueId).toBeNull();
  });
});

describe("buildSearchIndex — the place-read swallow is reported (ReporterPort convention)", () => {
  it("a rejecting places.getById degrades that place's events to venueId null AND reports once per place", async () => {
    const reportError = vi.fn();
    const err = new Error("db down");
    const { docs } = await indexEvents([ev("11", { orgId: VENUE_ORG }), ev("12", { orgId: VENUE_ORG })], {
      placesError: err,
      reportError,
    });
    // The doc still ships — address-only.
    expect(docs.get(ev("11", {}).id)?.venueId).toBeNull();
    expect(docs.get(ev("12", {}).id)?.venueId).toBeNull();
    // Pinned PER STEP rather than by raw count: the same failing place read is
    // now reported by both batch readers (venue confirmation and tax situs), and
    // each has to stay visible on its own.
    const byStep = (step: string) =>
      reportError.mock.calls.filter(
        ([, context]) =>
          (context as { tags?: Record<string, string> } | undefined)?.tags
            ?.step === step,
      );
    expect(byStep("resolveVenueConfirmedByEvent")).toHaveLength(1);
    expect(reportError).toHaveBeenCalledWith(err, {
      tags: { useCase: "buildSearchIndex", step: "resolveVenueConfirmedByEvent" },
      extra: { placeId: PLACE_A },
    });
    // No paid tier ⇒ no all-in figure to compute ⇒ no situs read to fail.
    // (The situs-failure report is pinned in listing-buyer-totals.test.ts and
    // taxable-base-index.test.ts.)
    expect(byStep("resolveEventTaxSitus")).toHaveLength(0);
    expect(docs.get(ev("11", {}).id)?.lowestBuyerTotalCents ?? null).toBeNull();
  });

  it("a THROWING reporter never changes behaviour: the doc still ships", async () => {
    const reportError = vi.fn(() => {
      throw new Error("sentry down");
    });
    const { docs } = await indexEvents([ev("13", { orgId: VENUE_ORG })], {
      placesError: new Error("db down"),
      reportError,
    });
    expect(docs.get(ev("13", {}).id)).toBeDefined();
    expect(docs.get(ev("13", {}).id)?.venueId).toBeNull();
    // The failing read tries to report; the reporter throws and is swallowed.
    expect(reportError).toHaveBeenCalledTimes(1);
  });
});

// Owner ruling 2026-10-06 (option B): an UNCONFIRMED community listing may be
// indexed with the venue's NAME (plain text) — but never its `venueId`.
describe("buildSearchIndex — name-only community listings", () => {
  const community = (id: string, overrides: Partial<Ev> & Record<string, unknown> = {}) =>
    ev(id, {
      placeId: PLACE_C,
      stewardship: "COMMUNITY",
      gateType: "NONE",
      ...overrides,
    } as Partial<Ev>);

  it("name-only: venueName set, venueId null", async () => {
    const { docs } = await indexEvents([community("20")]);
    const doc = docs.get(community("20").id);
    expect(doc?.venueName).toBe("Corner Bar");
    expect(doc?.venueId).toBeNull();
  });

  it("withdrawn, or not a community listing → no name", async () => {
    const { docs } = await indexEvents([
      community("21", { venueConfirmationWithdrawnAt: new Date("2026-06-02T00:00:00.000Z") }),
      community("22", { stewardship: "OWNED", orgId: OTHER_ORG } as Partial<Ev>),
    ]);
    expect(docs.get(community("21").id)?.venueName).toBeNull();
    expect(docs.get(community("22").id)?.venueName).toBeNull();
  });

  it("name-only on an obscured location → no name (the name never undoes the obscuring)", async () => {
    const { docs } = await indexEvents([
      community("23", { locationMode: "OBSCURED", locationRadiusMeters: 500 } as unknown as Partial<Ev>),
    ]);
    expect(docs.get(community("23").id)?.venueName).toBeNull();
    expect(docs.get(community("23").id)?.venueId).toBeNull();
  });

  it("name-only at a WITHHELD venue (place OBSCURED, event row EXACT) → no name", async () => {
    const { docs } = await indexEvents([community("25", { placeId: PLACE_D })]);
    expect(docs.get(community("25").id)?.venueName).toBeNull();
    expect(docs.get(community("25").id)?.venueId).toBeNull();
  });

  it("name-only on a GATED (PASSWORD) EXACT listing → no name", async () => {
    const { docs } = await indexEvents([community("26", { gateType: "PASSWORD" } as Partial<Ev>)]);
    expect(docs.get(community("26").id)).toBeDefined();
    expect(docs.get(community("26").id)?.venueName).toBeNull();
  });

  it("confirmed (venue-owned) is unchanged: venueId AND venueName", async () => {
    const { docs } = await indexEvents([ev("24", { orgId: VENUE_ORG })]);
    expect(docs.get(ev("24", {}).id)?.venueId).toBe(PLACE_A);
    expect(docs.get(ev("24", {}).id)?.venueName).toBe("The Basement East");
  });
});
