import { beforeEach, describe, expect, it, vi } from "vitest";

import { withSearchIndexFence } from "@th/test-utils/fakes/search-index-fence";
import type { PlaceRecord } from "@th/ports/repos/places";
import type { MultiSearchPort } from "@th/ports/search/multi-index.port";
import { ok } from "@th/ports/search/types";

/**
 * THE SEARCH-INDEX SIDE of a venue's community-listing consent.
 *
 * The gap this covers: `acceptsCommunityListings` is the third arm of
 * `isVenueConfirmed`, which `buildSearchIndex` STAMPS into each event's search
 * document. The flag is read live on the page but nothing recomputed the
 * stamp except the nightly `search.full-reindex` (`0 3 * * *` UTC) — so a
 * venue that retracted consent in the morning had search asserting its backing
 * for the rest of the day.
 *
 * Shaped after `community/__tests__/community-edit-reindex.test.ts`: a spy
 * wrapping the REAL `runReindexAfterMutation`, stubbed out for the "what was
 * dispatched" cases and restored for the "search is down" ones.
 */

// The use case drives `runReindexAfterMutation` — the SAME body
// `reindexAfterMutation` wraps, handing back its promise so the fan-out can be
// paced by real completion rather than dispatched all at once.
const { reindexSpy, real } = vi.hoisted(() => ({
  reindexSpy: vi.fn(),
  real: {
    runReindexAfterMutation: undefined as unknown as (
      ...a: never[]
    ) => Promise<void>,
  },
}));
vi.mock("../../search/reindex-after-mutation", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../search/reindex-after-mutation")
    >();
  real.runReindexAfterMutation = actual.runReindexAfterMutation as never;
  return {
    ...actual,
    runReindexAfterMutation: (...args: unknown[]) => reindexSpy(...args),
  };
});

import { setPlaceCommunityListingAcceptance } from "../set-place-community-listing-acceptance";
import type { SetPlaceCommunityListingAcceptanceDeps } from "../set-place-community-listing-acceptance";

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const PLACE_ID = "33333333-3333-4333-8333-333333333333";
const LISTING_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LISTING_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OWNED_EVENT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OTHER_LISTING = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const NOW = new Date("2026-09-12T12:00:00.000Z");

/** Same fixture as `set-place-community-listing-acceptance.test.ts`. */
function buildPlaceRecord(overrides: Partial<PlaceRecord> = {}): PlaceRecord {
  return {
    id: PLACE_ID,
    name: "Test Place",
    slug: "test-place",
    formattedAddress: "123 Main St",
    addressLine1: "123 Main St",
    addressLine2: null,
    city: "City",
    region: "ST",
    postalCode: "12345",
    countryCode: "US",
    addressHash: null,
    admissionTaxRateBps: null,
    taxRateSource: null,
    taxRateFetchedAt: null,
    timezone: null,
    capacity: null,
    lat: null,
    lng: null,
    status: "ACTIVE",
    verificationStatus: "VERIFIED",
    orgIdsWithAccess: [],
    humanIdsWithAccess: [ACTOR_ID],
    phone: null,
    website: null,
    listedInDirectory: false,
    acceptsBookingRequests: false,
    acceptsCommunityListings: false,
    attendeeReviewsPublic: false,
    defaultPrimaryPayoutTermsId: null,
    defaultResalePayoutTermsId: null,
    createdAt: new Date("2024-01-01T00:00:00.000Z"),
    updatedAt: new Date("2024-01-01T00:00:00.000Z"),
    ...overrides,
  } satisfies PlaceRecord;
}

/** `MultiSearchPort` fake; `rejectUpsert` simulates the backend being down. */
function makeSearchFake(options: { rejectUpsert?: boolean } = {}) {
  const upsertDocuments = vi.fn(
    async ({ documents }: { documents: unknown[] }) => {
      if (options.rejectUpsert) {
        throw new Error("meilisearch unreachable");
      }
      return ok({ indexed: documents.length });
    },
  );
  const search = {
    ensureIndexes: vi.fn(async () => ok(undefined)),
    upsertDocuments,
    deleteDocuments: vi.fn(async () => ok(undefined)),
    getStats: vi.fn(async () => ok({} as never)),
    autocomplete: vi.fn(async () => ok({} as never)),
  } as unknown as MultiSearchPort;
  return { search, upsertDocuments };
}

/** Read-side repos `buildSearchIndex` touches for a single-event reindex. */
function makeSearchReadRepos() {
  return {
    getPopularityStats: vi.fn(async () => []),
    listTicketTypesForEventIds: vi.fn(async () => []),
    getById: vi.fn(async (id: string) => ({
      id,
      slug: `event/us/austin/listing-${id.slice(0, 4)}`,
      title: "Weekly Open Mic",
      status: "PUBLISHED" as const,
      orgId: null,
      categoryId: null,
      admissionTaxRateBps: 0,
      addressText: "123 Main St, Austin, TX",
      lat: 30.27,
      lng: -97.74,
      locality: "Austin",
      region: "TX",
      locationMode: "EXACT" as const,
      locationRadiusMeters: null,
    })),
  };
}

type EventRow = {
  id: string;
  stewardship: "COMMUNITY" | "OWNED";
  venueConfirmationWithdrawnAt?: Date | null;
};

type HarnessOptions = {
  /** Starting state of the flag on the place row. */
  acceptsCommunityListings?: boolean;
  search?: MultiSearchPort;
  /** Make the bounded enumeration blow up. */
  rejectEnumeration?: boolean;
  /** The rows that exist at the place, in `startsAt` order. */
  rows?: EventRow[];
};

function buildHarness(options: HarnessOptions = {}) {
  const rows: EventRow[] = options.rows ?? [
    { id: LISTING_A, stewardship: "COMMUNITY" },
    { id: OWNED_EVENT, stewardship: "OWNED" },
    { id: LISTING_B, stewardship: "COMMUNITY" },
  ];

  const order: string[] = [];

  /**
   * Models the ADAPTER, not a convenience stub: the filters are applied BEFORE
   * the `take`, exactly as `packages/adapters/src/db/prisma/events.ts` does.
   * A fake that truncated first and let the caller filter afterwards would be
   * more permissive than production and would hide the very regression this
   * file exists for.
   */
  const listPublishedByPlace = vi.fn(
    async (input: {
      limit?: number;
      stewardship?: "COMMUNITY" | "OWNED";
      excludeVenueConfirmationWithdrawn?: boolean;
    }) => {
      order.push("enumerate");
      if (options.rejectEnumeration) {
        throw new Error("db unreachable");
      }
      const matched = rows.filter(
        (row) =>
          (input.stewardship === undefined ||
            row.stewardship === input.stewardship) &&
          (!input.excludeVenueConfirmationWithdrawn ||
            (row.venueConfirmationWithdrawnAt ?? null) === null),
      );
      const items = matched.slice(0, Math.min(input.limit ?? 20, 100));
      return {
        items,
        pageInfo: {
          total: matched.length,
          limit: input.limit ?? 20,
          offset: 0,
          hasMore: matched.length > items.length,
        },
      };
    },
  );

  // The one-column compare-and-set: it flips only from the opposite value.
  let accepted = options.acceptsCommunityListings ?? false;
  const write = vi.fn(async (input: { accepts: boolean }) => {
    order.push("write");
    if (accepted === input.accepts) return { changed: false };
    accepted = input.accepts;
    return { changed: true };
  });

  const reportError = vi.fn();

  const repos = {
    places: {
      getById: vi.fn(async () =>
        buildPlaceRecord({ acceptsCommunityListings: accepted }),
      ),
      setCommunityListingAcceptance: write,
    },
    authz: { getOrgMemberships: vi.fn(async () => []) },
    audit: { log: vi.fn(async () => {}) },
    events: { listPublishedByPlace, ...makeSearchReadRepos() },
    payoutTerms: { listByEvent: vi.fn(async () => []) },
    feePolicies: { resolveEffective: vi.fn(async () => null) },
    images: {
      getPrimaryImageRefs: vi.fn(
        async () => new Map<string, { publicUrl: string; key: string }>(),
      ),
    },
  } as unknown as SetPlaceCommunityListingAcceptanceDeps["repos"];

  const deps: SetPlaceCommunityListingAcceptanceDeps = {
    // The index-write fence opens its own `repos.tx` and locks.
    repos: withSearchIndexFence(repos),
    clock: { now: () => NOW },
    search: options.search,
    reportError,
  };

  return {
    deps,
    reportError,
    listPublishedByPlace,
    write,
    order,
    run: (accepts: boolean) =>
      setPlaceCommunityListingAcceptance(deps, {
        placeId: PLACE_ID,
        actorHumanId: ACTOR_ID,
        accepts,
      }),
  };
}

/** The in-memory `SearchReindexPending` table `withSearchIndexFence` wired in. */
function pendingRows(harness: ReturnType<typeof buildHarness>) {
  return (
    harness.deps.repos as unknown as {
      searchReindexPending: { rows: Map<string, unknown> };
    }
  ).searchReindexPending.rows;
}

/** Selector ids handed to `runReindexAfterMutation`, in call order. */
function reindexedEventIds(): string[] {
  return reindexSpy.mock.calls.map(
    (call) => (call[2] as { kind: string; id: string }).id,
  );
}

beforeEach(() => {
  reindexSpy.mockReset();
  reindexSpy.mockImplementation(() => undefined);
});

describe("a real consent transition reindexes the place's community listings", () => {
  it("OFF→ON reindexes each COMMUNITY listing and NOTHING else", async () => {
    const { search } = makeSearchFake();
    const harness = buildHarness({
      acceptsCommunityListings: false,
      search,
    });

    const result = await harness.run(true);
    expect(result.acceptsCommunityListings).toBe(true);

    await vi.waitFor(() => expect(reindexSpy).toHaveBeenCalledTimes(2));
    // The OWNED event takes its confirmation from the owner arm — consent
    // never moved it, so re-indexing it would be load with no output change.
    expect(reindexedEventIds()).toEqual([LISTING_A, LISTING_B]);
    expect(reindexSpy.mock.calls[0]![2]).toEqual({
      kind: "event",
      id: LISTING_A,
    });
  });

  it("ON→OFF retraction reindexes too — the direction that over-claims", async () => {
    // A retraction is the dangerous one: leaving the old documents alone means
    // search keeps telling buyers the venue is behind a listing it just
    // disowned.
    const { search } = makeSearchFake();
    const harness = buildHarness({
      acceptsCommunityListings: true,
      search,
    });

    const result = await harness.run(false);
    expect(result.acceptsCommunityListings).toBe(false);

    await vi.waitFor(() => expect(reindexSpy).toHaveBeenCalledTimes(2));
    expect(reindexedEventIds()).toEqual([LISTING_A, LISTING_B]);
  });

  it("threads search, reportError, repos and the frozen clock into the reindex", async () => {
    const { search } = makeSearchFake();
    const harness = buildHarness({ search });

    await harness.run(true);

    await vi.waitFor(() => expect(reindexSpy).toHaveBeenCalled());
    const [reindexDeps, useCaseName] = reindexSpy.mock.calls[0] as [
      { search?: unknown; reportError?: unknown },
      string,
      unknown,
    ];
    expect(useCaseName).toBe("setPlaceCommunityListingAcceptance");
    expect(reindexDeps.search).toBe(search);
    expect(reindexDeps.reportError).toBe(harness.reportError);
    expect(reindexDeps).toMatchObject({
      repos: harness.deps.repos,
      clock: harness.deps.clock,
    });
  });

  it("enumerates AFTER the write commits, never before", async () => {
    // Indexing ahead of the write would publish a confirmation state the write
    // might not land.
    const { search } = makeSearchFake();
    const harness = buildHarness({ search });

    await harness.run(true);

    await vi.waitFor(() =>
      expect(harness.listPublishedByPlace).toHaveBeenCalled(),
    );
    expect(harness.order).toEqual(["write", "enumerate"]);
  });

  it("the enumeration is BOUNDED — one page, forward window, from the injected clock", async () => {
    const { search } = makeSearchFake();
    const harness = buildHarness({ search });

    await harness.run(true);

    await vi.waitFor(() =>
      expect(harness.listPublishedByPlace).toHaveBeenCalled(),
    );
    const args = harness.listPublishedByPlace.mock.calls[0]![0] as {
      placeId: string;
      from: Date;
      to: Date;
      limit: number;
      status: string;
      stewardship?: string;
      excludeVenueConfirmationWithdrawn?: boolean;
      includeDateOccurrences?: boolean;
      venueConfirmedFor?: unknown;
    };
    expect(args.placeId).toBe(PLACE_ID);
    expect(args.from).toEqual(NOW);
    expect(args.to.getTime()).toBeGreaterThan(NOW.getTime());
    // The adapter clamps `limit` to 100; anything above it is a lie about the
    // bound, anything unbounded is a full-table walk off a toggle click.
    expect(args.limit).toBeLessThanOrEqual(100);
    expect(args.status).toBe("upcoming");
    // A recurring listing pins `startsAt` to its next night, which can be
    // stale — without this its later nights never bring it back.
    expect(args.includeDateOccurrences).toBe(true);
    // A confirmed-only filter would return NONE of the listings a retraction
    // needs to re-index.
    expect(args.venueConfirmedFor).toBeUndefined();
    // THE BUDGET MUST BUY LISTINGS. Both filters belong in the query, where
    // the `take` truncates them, not on the page afterwards.
    expect(args.stewardship).toBe("COMMUNITY");
    expect(args.excludeVenueConfirmationWithdrawn).toBe(true);
  });
});

describe("the page budget buys LISTINGS, not whatever happens to be soonest", () => {
  /**
   * THE REGRESSION THIS FILE EXISTS FOR.
   *
   * A venue that programmes its own room five nights a week has hundreds of
   * upcoming OWNED events. Filtering stewardship in MEMORY spends the whole
   * 100-row budget on that prefix and reaches zero listings — while the info
   * log still reports a full, plausible-looking page. The venue's community
   * listings then keep asserting its backing until 03:00 UTC, which is exactly
   * the bug this use case was written to close.
   */
  const OWNED_PREFIX: EventRow[] = Array.from({ length: 100 }, (_, i) => ({
    id: `owned-${i}`,
    stewardship: "OWNED" as const,
  }));

  it("reindexes listings that sit BEYOND the 100 soonest owned events", async () => {
    const { search } = makeSearchFake();
    const harness = buildHarness({
      search,
      rows: [
        ...OWNED_PREFIX,
        { id: LISTING_A, stewardship: "COMMUNITY" },
        { id: LISTING_B, stewardship: "COMMUNITY" },
      ],
    });

    await harness.run(true);

    await vi.waitFor(() => expect(reindexSpy).toHaveBeenCalledTimes(2));
    expect(reindexedEventIds()).toEqual([LISTING_A, LISTING_B]);
  });

  it("an OWNED event is never reindexed — the filter is the query's, not a leftover in-memory pass", async () => {
    // The in-memory `stewardship === "COMMUNITY"` guard is GONE; this is what
    // keeps owned events out. The fake applies the predicate the way the
    // adapter does, so dropping the param from the query shows up here.
    const { search } = makeSearchFake();
    const harness = buildHarness({
      search,
      rows: [
        { id: OWNED_EVENT, stewardship: "OWNED" },
        { id: LISTING_A, stewardship: "COMMUNITY" },
      ],
    });

    await harness.run(true);

    await vi.waitFor(() => expect(reindexSpy).toHaveBeenCalledTimes(1));
    expect(reindexedEventIds()).toEqual([LISTING_A]);
  });

  it("a WITHDRAWN listing is not reindexed — its document cannot move on this flip", async () => {
    // FR-003: withdrawal negates the community arm, so the listing is
    // unconfirmed before AND after. Skipping it can never miss a change, and
    // it stops a venue that has rejected a run of bad listings from crowding
    // the live ones off the page.
    const { search } = makeSearchFake();
    const harness = buildHarness({
      search,
      rows: [
        {
          id: OTHER_LISTING,
          stewardship: "COMMUNITY",
          venueConfirmationWithdrawnAt: new Date("2026-09-01T00:00:00.000Z"),
        },
        { id: LISTING_A, stewardship: "COMMUNITY" },
      ],
    });

    await harness.run(true);

    await vi.waitFor(() => expect(reindexSpy).toHaveBeenCalledTimes(1));
    expect(reindexedEventIds()).toEqual([LISTING_A]);
  });

  it("paces the fan-out instead of dispatching a full page at once", async () => {
    // One toggle must not put ~1000 queries on the pool the request path is
    // using. The cap is enforced by AWAITING completion, so a dispatch that
    // ignored the returned promise would show up as a spike here.
    const { search } = makeSearchFake();
    const harness = buildHarness({
      search,
      rows: Array.from({ length: 20 }, (_, i) => ({
        id: `listing-${i}`,
        stewardship: "COMMUNITY" as const,
      })),
    });

    let inFlight = 0;
    let peak = 0;
    reindexSpy.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
    });

    await harness.run(true);

    await vi.waitFor(() => expect(reindexSpy).toHaveBeenCalledTimes(20));
    expect(peak).toBeLessThanOrEqual(4);
    // ...and it is genuinely concurrent, not an accidental one-at-a-time loop.
    expect(peak).toBeGreaterThan(1);
  });

  it("a rejecting index pass is REPORTED rather than swallowed, and the flip still succeeds", async () => {
    // `runReindexAfterMutation` never rejects in production — it is
    // `reindexAfterMutation`'s own body and swallows/reports internally, which
    // is why awaiting it is safe. If that contract ever broke, the rejection
    // must surface in Sentry through the terminal catch and must still not
    // reach the caller. Both halves pinned here.
    const { search } = makeSearchFake();
    const harness = buildHarness({
      search,
      rows: Array.from({ length: 6 }, (_, i) => ({
        id: `listing-${i}`,
        stewardship: "COMMUNITY" as const,
      })),
    });

    reindexSpy.mockImplementation(async (...args: unknown[]) => {
      const selector = args[2] as { id: string };
      if (selector.id === "listing-1") throw new Error("index blew up");
    });

    const result = await harness.run(true);
    expect(result.acceptsCommunityListings).toBe(true);

    await vi.waitFor(() => expect(harness.reportError).toHaveBeenCalled());
    expect(harness.reportError.mock.calls[0]![1]).toMatchObject({
      tags: {
        useCase: "setPlaceCommunityListingAcceptance",
        op: "reindexPlaceCommunityListings",
      },
    });
  });

  it("one listing's failure does not abandon the listings after it", async () => {
    // The chunk loop uses `Promise.allSettled` and collects rejections,
    // rethrowing once after every chunk has run. Under `Promise.all` the
    // rejecting chunk aborted the loop and every LATER chunk was dropped, with
    // a single report standing in for the whole tail. Six rows at concurrency
    // 4 is two chunks, and the failure is in the FIRST — so the second chunk
    // running at all is exactly the property this pins.
    const { search } = makeSearchFake();
    const harness = buildHarness({
      search,
      rows: Array.from({ length: 6 }, (_, i) => ({
        id: `listing-${i}`,
        stewardship: "COMMUNITY" as const,
      })),
    });

    reindexSpy.mockImplementation(async (...args: unknown[]) => {
      const selector = args[2] as { id: string };
      if (selector.id === "listing-1") throw new Error("index blew up");
    });

    await harness.run(true);

    await vi.waitFor(() => expect(reindexSpy).toHaveBeenCalledTimes(6));
    const attempted = reindexSpy.mock.calls.map(
      (call) => (call[2] as { id: string }).id,
    );
    expect(attempted).toEqual(
      expect.arrayContaining(["listing-4", "listing-5"]),
    );
  });
});

describe("runReindexAfterMutation's never-rejects contract", () => {
  // The chunked driver AWAITS this helper, so "never rejects" stopped being a
  // nicety and became load-bearing: a rejection would abandon the rest of the
  // page. Pinned against the REAL implementation, with the search backend
  // down.
  it("resolves (never rejects) even when the index write blows up", async () => {
    const { search, upsertDocuments } = makeSearchFake({ rejectUpsert: true });
    const harness = buildHarness({ search });
    const reportError = vi.fn();

    await expect(
      real.runReindexAfterMutation(
        {
          repos: harness.deps.repos,
          search,
          clock: harness.deps.clock,
          reportError,
        } as never,
        "contractCheck" as never,
        { kind: "event", id: LISTING_A } as never,
      ),
    ).resolves.toBeUndefined();

    expect(upsertDocuments).toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it("resolves immediately when no search port is wired", async () => {
    const harness = buildHarness();

    await expect(
      real.runReindexAfterMutation(
        { repos: harness.deps.repos, clock: harness.deps.clock } as never,
        "contractCheck" as never,
        { kind: "event", id: LISTING_A } as never,
      ),
    ).resolves.toBeUndefined();
  });
});

describe("the reindex is skipped when there was no real transition", () => {
  it("an idempotent ON→ON flip does not reindex, and does not even enumerate", async () => {
    const { search } = makeSearchFake();
    const harness = buildHarness({
      acceptsCommunityListings: true,
      search,
    });

    await harness.run(true);

    // Give the fire-and-forget chain a turn to prove nothing was scheduled.
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The compare-and-set ran once and moved nothing (no enumeration below).
    expect(harness.write).toHaveBeenCalledTimes(1);
    expect(harness.listPublishedByPlace).not.toHaveBeenCalled();
    expect(reindexSpy).not.toHaveBeenCalled();
  });

  it("an idempotent OFF→OFF flip does not reindex either", async () => {
    const { search } = makeSearchFake();
    const harness = buildHarness({
      acceptsCommunityListings: false,
      search,
    });

    await harness.run(false);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.listPublishedByPlace).not.toHaveBeenCalled();
    expect(reindexSpy).not.toHaveBeenCalled();
  });

  it("no search port: no immediate pass, but the listings are still MARKED for the drain", async () => {
    const harness = buildHarness({ search: undefined });

    const result = await harness.run(true);

    expect(result.acceptsCommunityListings).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The durable half does not depend on a search port being wired here:
    // the scheduled drain (jobs) has one.
    expect(harness.listPublishedByPlace).toHaveBeenCalledTimes(1);
    expect([...pendingRows(harness).keys()].sort()).toEqual(
      [`event:${LISTING_A}`, `event:${LISTING_B}`].sort(),
    );
    expect(reindexSpy).not.toHaveBeenCalled();
    expect(harness.reportError).not.toHaveBeenCalled();
  });
});

describe("a failing reindex never fails the flip, and is never silent", () => {
  it("a throwing ENUMERATION fails the flip: it runs in the flip's transaction, so nothing commits without its marks", async () => {
    const { search } = makeSearchFake();
    const harness = buildHarness({ search, rejectEnumeration: true });

    await expect(harness.run(true)).rejects.toThrow("db unreachable");
    expect(pendingRows(harness).size).toBe(0);
    expect(reindexSpy).not.toHaveBeenCalled();
  });

  it("the enumerated listings are marked in the flip's transaction; the owned event is not", async () => {
    const { search } = makeSearchFake();
    const harness = buildHarness({ search });

    await harness.run(true);

    expect([...pendingRows(harness).keys()].sort()).toEqual(
      [`event:${LISTING_A}`, `event:${LISTING_B}`].sort(),
    );
    expect(pendingRows(harness).has(`event:${OWNED_EVENT}`)).toBe(false);
  });

  it("a throwing SEARCH PORT is reported per listing, and the mutation still succeeds", async () => {
    // Drive the REAL fire-and-forget reindex end to end.
    reindexSpy.mockImplementation((...args: unknown[]) =>
      (real.runReindexAfterMutation as (...a: unknown[]) => Promise<void>)(
        ...args,
      ),
    );
    const { search, upsertDocuments } = makeSearchFake({ rejectUpsert: true });
    const harness = buildHarness({ search });

    const result = await harness.run(true);
    expect(result.acceptsCommunityListings).toBe(true);

    // 2 listings × 2 writes: this fake is an EXTERNAL engine (no
    // `indexLivesInPrimaryDatabase`), so a fence whose write rejected runs
    // once more (see `withIndexWriteFence`) before the failure surfaces.
    await vi.waitFor(() =>
      expect(upsertDocuments).toHaveBeenCalledTimes(4),
    );
    // Still reported exactly once per listing.
    await vi.waitFor(() =>
      expect(harness.reportError).toHaveBeenCalledTimes(2),
    );
    expect(harness.reportError.mock.calls[0]![1]).toMatchObject({
      tags: {
        useCase: "setPlaceCommunityListingAcceptance",
        op: "reindexAfterMutation",
      },
    });
  });

  it("a THROWING reporter cannot turn the swallow into an unhandled rejection", async () => {
    reindexSpy.mockImplementation((...args: unknown[]) =>
      (real.runReindexAfterMutation as (...a: unknown[]) => Promise<void>)(
        ...args,
      ),
    );
    const { search, upsertDocuments } = makeSearchFake({ rejectUpsert: true });
    const harness = buildHarness({ search });
    harness.reportError.mockImplementation(() => {
      throw new Error("sentry transport exploded");
    });

    const result = await harness.run(true);
    expect(result.acceptsCommunityListings).toBe(true);

    await vi.waitFor(() => expect(upsertDocuments).toHaveBeenCalled());
    await vi.waitFor(() => expect(harness.reportError).toHaveBeenCalled());
    // Give the microtask chain room to surface an unhandled rejection.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

});
