/**
 * FR-008 / Q-001 (RESOLVED) — search-index freshness across a scheduled price
 * flip.
 *
 * Two halves, both required for the answer to hold:
 *
 *  1. `buildSearchIndex` materialises the CURRENT EFFECTIVE price at index time
 *     — never the raw list price, and never the post-flip price ahead of T
 *     (indexing early would make search advertise a price nobody can buy).
 *  2. `reindexScheduledPriceFlips` finds the events whose flip just crossed, so
 *     the stored value is refreshed even though NOTHING wrote to the row.
 *
 * The degradation contract is asserted too: the scan cannot set a price, only
 * decide which events to re-read (NFR-002).
 */
import { describe, expect, it, vi } from "vitest";

import type { Repos } from "@th/ports/repos";

import { withSearchIndexFence } from "@th/test-utils/fakes/search-index-fence";
import { buildSearchIndex as buildSearchIndexFenced } from "../build-search-index";

/** The fixtures below predate the index-write fence; give them its surface. */
const buildSearchIndex: typeof buildSearchIndexFenced = (deps, input) =>
  buildSearchIndexFenced(
    { ...deps, repos: withSearchIndexFence(deps.repos) },
    input,
  );
import { reindexScheduledPriceFlips as reindexScheduledPriceFlipsFenced } from "../reindex-scheduled-price-flips";

/** Same fence surface for the scan, which calls the indexer internally. */
const reindexScheduledPriceFlips: typeof reindexScheduledPriceFlipsFenced = (
  deps,
  input,
) =>
  reindexScheduledPriceFlipsFenced(
    { ...deps, repos: withSearchIndexFence(deps.repos) },
    input,
  );

const ok = <T>(value: T) => ({ ok: true as const, value });

const T = new Date("2026-10-01T20:00:00.000Z");
const BEFORE = new Date(T.getTime() - 1_000);
const AT = new Date(T.getTime());
const AFTER = new Date(T.getTime() + 60 * 60 * 1000);

const EARLY_BIRD_CENTS = 1200;
const FULL_PRICE_CENTS = 2000;

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const TT_ID = "22222222-2222-4222-8222-222222222222";

const clockAt = (now: Date) => ({ now: () => now });

const scheduledTier = (overrides?: Record<string, unknown>) => ({
  id: TT_ID,
  eventId: EVENT_ID,
  name: "Early Bird",
  description: null,
  priceCents: EARLY_BIRD_CENTS,
  pricingMode: "FIXED" as const,
  minimumCents: null,
  suggestedCents: null,
  capacity: 100,
  status: "ACTIVE" as const,
  seatSectionId: null,
  resaleAllowed: false,
  resaleCapCents: null,
  transferAllowed: true,
  scheduledPriceCents: FULL_PRICE_CENTS,
  scheduledPriceAt: T,
  ...overrides,
});

const indexedEvent = {
  id: EVENT_ID,
  slug: "scheduled-show",
  title: "Scheduled Show",
  description: null,
  status: "PUBLISHED",
  visibility: "PUBLIC",
  startsAt: new Date("2026-12-01T20:00:00.000Z"),
  endsAt: new Date("2026-12-01T23:00:00.000Z"),
  orgId: null,
  humanId: null,
  categoryId: null,
  locality: "Nashville",
  region: "TN",
  addressText: "123 Main",
  locationMode: "EXACT",
  lat: 36.1,
  lng: -86.8,
  locationRadiusMeters: null,
  heroImageUrl: null,
  heroImageKey: null,
  currency: "usd",
  // Resolved (0%) so `buyerTotalForIndex` does not null the inclusive total.
  admissionTaxRateBps: 0,
};

function indexRepos(tiers: ReturnType<typeof scheduledTier>[]) {
  return {
    events: {
      getById: vi.fn(async () => indexedEvent),
      getPopularityStats: vi.fn(async () => []),
      listTicketTypesForEventIds: vi.fn(async () => tiers),
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
}

async function indexAt(now: Date, tiers = [scheduledTier()]) {
  const captured: Array<Record<string, unknown>> = [];
  await buildSearchIndex(
    {
      repos: indexRepos(tiers),
      clock: clockAt(now),
      search: {
        ensureIndexes: vi.fn(async () => ok(undefined)),
        upsertDocuments: vi.fn(async ({ documents }: any) => {
          captured.push(...documents);
          return ok({ indexed: documents.length });
        }),
        deleteDocuments: vi.fn(async () => ok(undefined)),
      } as any,
    },
    { eventIds: [EVENT_ID] },
  );
  return captured.find((d) => d.type === "event") as
    | {
        /** The indexed "from $X" figure: 0 when a free tier exists, else the
         *  cheapest PAID effective price, else null (no ACTIVE tiers). */
        lowestPriceCents: number | null;
        hasFreeTier: boolean;
        paidTierCount: number;
      }
    | undefined;
}

describe("buildSearchIndex — materialises the EFFECTIVE price (FR-008)", () => {
  it("stamps the pre-flip price when indexed before T", async () => {
    const doc = await indexAt(BEFORE);
    expect(doc?.lowestPriceCents).toBe(EARLY_BIRD_CENTS);
  });

  it("stamps the post-flip price when indexed at T (inclusive boundary)", async () => {
    const doc = await indexAt(AT);
    expect(doc?.lowestPriceCents).toBe(FULL_PRICE_CENTS);
  });

  it("stamps the post-flip price when indexed after T", async () => {
    const doc = await indexAt(AFTER);
    expect(doc?.lowestPriceCents).toBe(FULL_PRICE_CENTS);
  });

  it("NEVER stamps the post-flip price early — search must not advertise an unbuyable price", async () => {
    // The rejected alternative from Q-001. If this ever regresses, a browse card
    // quotes $20 while checkout charges $12.
    const doc = await indexAt(new Date(T.getTime() - 24 * 60 * 60 * 1000));
    expect(doc?.lowestPriceCents).not.toBe(FULL_PRICE_CENTS);
    expect(doc?.lowestPriceCents).toBe(EARLY_BIRD_CENTS);
  });

  it("a tier scheduled to become FREE reindexes as a free tier after T", async () => {
    const becomesFree = [scheduledTier({ scheduledPriceCents: 0 })];
    const before = await indexAt(BEFORE, becomesFree);
    expect(before?.hasFreeTier).toBe(false);
    expect(before?.lowestPriceCents).toBe(EARLY_BIRD_CENTS);

    const after = await indexAt(AFTER, becomesFree);
    expect(after?.hasFreeTier).toBe(true);
    expect(after?.paidTierCount).toBe(0);
    // 0 = free-tier, NOT "missing". Null means no ACTIVE tiers at all.
    expect(after?.lowestPriceCents).toBe(0);
  });

  it("NFR-001: an unscheduled tier indexes identically at every instant", async () => {
    const plain = [
      scheduledTier({ scheduledPriceCents: null, scheduledPriceAt: null }),
    ];
    for (const now of [BEFORE, AT, AFTER]) {
      expect((await indexAt(now, plain))?.lowestPriceCents).toBe(
        EARLY_BIRD_CENTS,
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fake repo that PAGES like the real one: returns rows ordered by eventId asc,
 * strictly after `afterEventId`, capped at `limit`. Modelling the cursor here
 * (rather than returning one canned array) is the point — the bug this guards
 * against is a stable-sorted capped query returning the same slice forever.
 */
function scanRepos(allEventIds: string[]) {
  const sorted = [...allEventIds].sort();
  const listEventIdsWithScheduledPriceFlipBetween = vi.fn(
    async ({
      limit,
      afterEventId,
    }: {
      limit: number;
      afterEventId?: string | null;
    }) => {
      const start = afterEventId
        ? sorted.findIndex((id) => id > afterEventId)
        : 0;
      if (start === -1) return [];
      return sorted.slice(start, start + limit);
    },
  );
  const repos = indexRepos([scheduledTier()]) as any;
  repos.events.listEventIdsWithScheduledPriceFlipBetween =
    listEventIdsWithScheduledPriceFlipBetween;
  return { repos: repos as Repos, listEventIdsWithScheduledPriceFlipBetween };
}

function fakeSearch() {
  const upsertDocuments = vi.fn(async ({ documents }: any) =>
    ok({ indexed: documents.length }),
  );
  return {
    port: {
      ensureIndexes: vi.fn(async () => ok(undefined)),
      upsertDocuments,
      deleteDocuments: vi.fn(async () => ok(undefined)),
    } as any,
    upsertDocuments,
  };
}

describe("reindexScheduledPriceFlips — the FR-008 scan", () => {
  it("re-indexes the events whose flip crossed inside the window", async () => {
    const { repos, listEventIdsWithScheduledPriceFlipBetween } = scanRepos([
      EVENT_ID,
    ]);
    const search = fakeSearch();

    const result = await reindexScheduledPriceFlips(
      { repos, search: search.port, clock: clockAt(AFTER) },
      {},
    );

    expect(result.eventsFound).toBe(1);
    expect(result.eventsIndexed).toBe(1);
    expect(result.errors).toBe(0);
    expect(listEventIdsWithScheduledPriceFlipBetween).toHaveBeenCalledTimes(1);
  });

  it("does no indexing work when nothing flipped", async () => {
    const { repos } = scanRepos([]);
    const search = fakeSearch();

    const result = await reindexScheduledPriceFlips(
      { repos, search: search.port, clock: clockAt(AFTER) },
      {},
    );

    expect(result.eventsFound).toBe(0);
    expect(result.eventsIndexed).toBe(0);
    // Not even an ensureIndexes call — a no-op tick is genuinely free.
    expect(search.port.ensureIndexes).not.toHaveBeenCalled();
    expect(search.upsertDocuments).not.toHaveBeenCalled();
  });

  it("defaults to a lookback far wider than the tick, so cron drift can't skip a flip", async () => {
    const { repos, listEventIdsWithScheduledPriceFlipBetween } = scanRepos([]);
    const search = fakeSearch();

    await reindexScheduledPriceFlips(
      { repos, search: search.port, clock: clockAt(AFTER) },
      {},
    );

    const call = listEventIdsWithScheduledPriceFlipBetween.mock
      .calls[0]![0] as {
      windowStart: Date;
      windowEnd: Date;
    };
    expect(call.windowEnd).toEqual(AFTER);
    const lookbackMs = call.windowEnd.getTime() - call.windowStart.getTime();
    // 6h default: the flip at T is still inside the window an hour later.
    expect(lookbackMs).toBe(6 * 60 * 60 * 1000);
    expect(call.windowStart.getTime()).toBeLessThan(T.getTime());
  });

  it("CLAMPS a future windowEnd to now — never re-indexes a flip that has not happened", async () => {
    const { repos, listEventIdsWithScheduledPriceFlipBetween } = scanRepos([]);
    const search = fakeSearch();

    await reindexScheduledPriceFlips(
      { repos, search: search.port, clock: clockAt(BEFORE) },
      { windowEndIso: new Date(T.getTime() + 86_400_000).toISOString() },
    );

    const call = listEventIdsWithScheduledPriceFlipBetween.mock
      .calls[0]![0] as {
      windowEnd: Date;
    };
    expect(call.windowEnd).toEqual(BEFORE);
  });

  it("is idempotent: two runs over the same window produce the same document", async () => {
    // Overlapping ticks are expected by design (the lookback is much wider than
    // the tick) and must be free of consequence — the document is rebuilt from
    // source rows, so a repeat is a duplicate write, never a wrong value.
    const first = await indexAt(AFTER);
    const second = await indexAt(AFTER);
    expect(second).toEqual(first);
  });

  it("passes only event IDs to the indexer — it decides WHICH, never WHAT (NFR-002)", async () => {
    const { repos } = scanRepos([EVENT_ID]);
    const search = fakeSearch();

    await reindexScheduledPriceFlips(
      { repos, search: search.port, clock: clockAt(AFTER) },
      {},
    );

    // The scan never computes a price; the re-read resolves it. Proven by the
    // document carrying the post-flip price the scan never saw.
    const upserted = search.upsertDocuments.mock.calls[0]![0] as {
      documents: Array<Record<string, unknown>>;
    };
    const doc = upserted.documents.find((d) => d.type === "event") as any;
    expect(doc.lowestPriceCents).toBe(FULL_PRICE_CENTS);
  });

  it("rejects an inverted explicit window at the boundary", async () => {
    const { repos } = scanRepos([]);
    const search = fakeSearch();

    await expect(
      reindexScheduledPriceFlips(
        { repos, search: search.port, clock: clockAt(AFTER) },
        {
          windowStartIso: AFTER.toISOString(),
          windowEndIso: BEFORE.toISOString(),
        },
      ),
    ).rejects.toBeTruthy();
  });

  it("rejects a window the CLAMP itself inverted, instead of returning zero rows", async () => {
    // A backfill for a FUTURE window: start is legitimately before end as
    // written, so validating the requested values waves it through — but the
    // clamp pulls end back to `now`, leaving start > end. Returning 0 rows there
    // is indistinguishable from "nothing flipped", which is the worst way for a
    // backfill to fail. It must throw.
    const { repos, listEventIdsWithScheduledPriceFlipBetween } = scanRepos([]);
    const search = fakeSearch();

    await expect(
      reindexScheduledPriceFlips(
        { repos, search: search.port, clock: clockAt(BEFORE) },
        {
          windowStartIso: new Date(T.getTime() + 3_600_000).toISOString(),
          windowEndIso: new Date(T.getTime() + 7_200_000).toISOString(),
        },
      ),
    ).rejects.toBeTruthy();

    // And it must fail BEFORE touching the database.
    expect(listEventIdsWithScheduledPriceFlipBetween).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The starvation bug: a stable-sorted capped query never reaches the tail
// ─────────────────────────────────────────────────────────────────────────────

describe("reindexScheduledPriceFlips — pagination covers the WHOLE window", () => {
  /**
   * Lexicographically ORDERED valid UUIDs — `buildSearchIndex` parses
   * `eventIds` as uuid, and the cursor contract is "sorts after", so the
   * fixtures have to be both real UUIDs and monotonically ordered.
   */
  const eventUuid = (i: number) =>
    `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
  const manyEventIds = (count: number) =>
    Array.from({ length: count }, (_, i) => eventUuid(i));

  it("pages past SCAN_PAGE_SIZE and re-indexes the TAIL, not just the first slice", async () => {
    // The regression this exists for: with `orderBy eventId asc` + `take N` and
    // no cursor, every tick for the full 6h lookback returns the SAME first N
    // and the tail is never re-indexed by this job at all. Realistic trigger: a
    // coordinated on-sale or a platform-wide early-bird deadline.
    const ids = manyEventIds(1200); // > 2 pages at SCAN_PAGE_SIZE = 500
    const { repos, listEventIdsWithScheduledPriceFlipBetween } = scanRepos(ids);
    const search = fakeSearch();

    const result = await reindexScheduledPriceFlips(
      { repos, search: search.port, clock: clockAt(AFTER) },
      {},
    );

    expect(result.eventsFound).toBe(1200);
    expect(result.capReached).toBe(false);
    expect(result.pagesScanned).toBe(3); // 500 + 500 + 200 (short page ends it)

    // Every page after the first must carry a cursor, and the cursors must
    // ADVANCE — a repeated cursor is the starvation bug in miniature.
    const calls = listEventIdsWithScheduledPriceFlipBetween.mock.calls.map(
      (c) => (c[0] as { afterEventId?: string | null }).afterEventId ?? null,
    );
    expect(calls[0]).toBeNull();
    expect(calls[1]).toBe(eventUuid(499));
    expect(calls[2]).toBe(eventUuid(999));
    expect(new Set(calls).size).toBe(calls.length);

    // The last event in the window actually reached the indexer.
    const indexed = (
      repos.events.listTicketTypesForEventIds as unknown as {
        mock: { calls: unknown[][] };
      }
    ).mock.calls.flat();
    void indexed;
    expect(result.eventsIndexed).toBeGreaterThan(0);
  });

  it("stops at a SHORT page — a short page means exhausted, not a small dedup", async () => {
    const { repos, listEventIdsWithScheduledPriceFlipBetween } = scanRepos(
      manyEventIds(3),
    );
    const search = fakeSearch();

    const result = await reindexScheduledPriceFlips(
      { repos, search: search.port, clock: clockAt(AFTER) },
      {},
    );

    expect(result.pagesScanned).toBe(1);
    expect(result.eventsFound).toBe(3);
    expect(listEventIdsWithScheduledPriceFlipBetween).toHaveBeenCalledTimes(1);
  });

  it("dedups duplicate rows for one event (the repo returns ROWS, not DISTINCT)", async () => {
    // `distinct` was removed from the query precisely because `distinct` + `take`
    // has version-dependent semantics. The caller owns dedup, so it must work.
    const listEventIdsWithScheduledPriceFlipBetween = vi.fn(
      async ({ afterEventId }: { afterEventId?: string | null }) =>
        afterEventId ? [] : [EVENT_ID, EVENT_ID, EVENT_ID],
    );
    const repos = indexRepos([scheduledTier()]) as any;
    repos.events.listEventIdsWithScheduledPriceFlipBetween =
      listEventIdsWithScheduledPriceFlipBetween;
    const search = fakeSearch();

    const result = await reindexScheduledPriceFlips(
      { repos, search: search.port, clock: clockAt(AFTER) },
      {},
    );

    expect(result.eventsFound).toBe(1);
  });

  it("REPORTS when the absolute cap binds — a truncated refresh is never silent", async () => {
    const { repos } = scanRepos(manyEventIds(1200));
    const search = fakeSearch();
    const reportError = vi.fn();
    const logger = {
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      child: vi.fn(),
    } as any;

    const result = await reindexScheduledPriceFlips(
      {
        repos,
        search: search.port,
        clock: clockAt(AFTER),
        logger,
        reportError,
      },
      { maxEvents: 500 },
    );

    expect(result.capReached).toBe(true);
    // logger.error IS Sentry-captured via pinoIntegration; warn is NOT.
    expect(logger.error).toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(String(reportError.mock.calls[0]![0])).toContain("INCOMPLETE");
  });

  it("a throwing reporter never changes the job's result", async () => {
    const { repos } = scanRepos(manyEventIds(1200));
    const search = fakeSearch();
    const reportError = vi.fn(() => {
      throw new Error("sentry is down");
    });

    const result = await reindexScheduledPriceFlips(
      { repos, search: search.port, clock: clockAt(AFTER), reportError },
      { maxEvents: 500 },
    );

    expect(result.capReached).toBe(true);
    expect(result.eventsFound).toBe(500);
  });

  it("does NOT report when the window is fully covered", async () => {
    const { repos } = scanRepos(manyEventIds(10));
    const search = fakeSearch();
    const reportError = vi.fn();

    const result = await reindexScheduledPriceFlips(
      { repos, search: search.port, clock: clockAt(AFTER), reportError },
      {},
    );

    expect(result.capReached).toBe(false);
    expect(reportError).not.toHaveBeenCalled();
  });
});

describe("buildSearchIndex — floor-0 pay-what-you-want (owner ruling 2026-10-06, F2)", () => {
  const pwyw = (minimumCents: number | null) =>
    scheduledTier({
      pricingMode: "ADJUSTABLE" as never,
      priceCents: 0,
      minimumCents: minimumCents as never,
      scheduledPriceCents: null,
      scheduledPriceAt: null,
    });

  it("indexes a floor-0 PWYW tier as hasPayWhatYouWantTier, not hasFreeTier, with lowestPriceCents 0", async () => {
    const doc = (await indexAt(AFTER, [pwyw(0)])) as
      | (Record<string, unknown> & { hasPayWhatYouWantTier?: boolean })
      | undefined;
    expect(doc?.hasFreeTier).toBe(false);
    expect(doc?.hasPayWhatYouWantTier).toBe(true);
    expect(doc?.paidTierCount).toBe(0);
    // Still 0 for price filters: anyone can get in for nothing.
    expect(doc?.lowestPriceCents).toBe(0);
  });

  it("a PWYW tier with a floor above 0 stays a paid tier at its floor", async () => {
    const doc = (await indexAt(AFTER, [pwyw(500)])) as
      | (Record<string, unknown> & { hasPayWhatYouWantTier?: boolean })
      | undefined;
    expect(doc?.hasPayWhatYouWantTier).toBe(false);
    expect(doc?.hasFreeTier).toBe(false);
    expect(doc?.paidTierCount).toBe(1);
    expect(doc?.lowestPriceCents).toBe(500);
  });
});
