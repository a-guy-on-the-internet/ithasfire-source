import { describe, expect, it } from "vitest";

import {
  buildCacheFingerprint,
  resolveOrderTicketsState,
  toCacheableTickets,
  toIsoOrNull,
  type OrderTicketsQueryState,
} from "../order-tickets-state";

const CACHED = {
  orderId: "o1",
  cachedAt: "2026-07-30T00:00:00.000Z",
  tickets: [{ id: "t1", code: "AAA", status: "VALID", scannedAt: null }],
};

const LIVE = [{ id: "t9", code: "ZZZ", status: "VALID", scannedAt: null }];

const base: OrderTicketsQueryState = {
  liveTickets: undefined,
  cached: null,
  cacheChecked: false,
  isQueryLoading: true,
  isQueryError: false,
  queryErrorMessage: null,
};

describe("resolveOrderTicketsState", () => {
  it("prefers live data over a cached copy", () => {
    const state = resolveOrderTicketsState({
      ...base,
      liveTickets: LIVE,
      cached: CACHED,
      cacheChecked: true,
      isQueryLoading: false,
    });

    expect(state.source).toBe("live");
    expect(state.tickets).toEqual(LIVE);
    expect(state.cachedAt).toBeNull();
  });

  it("serves the cache when the query has failed — the door case", () => {
    // The whole point of the feature: no signal at the venue, but the buyer
    // still gets their pass.
    const state = resolveOrderTicketsState({
      ...base,
      cached: CACHED,
      cacheChecked: true,
      isQueryLoading: false,
      isQueryError: true,
      queryErrorMessage: "Network request failed",
    });

    expect(state.source).toBe("cache");
    expect(state.tickets).toHaveLength(1);
    expect(state.cachedAt).toBe(CACHED.cachedAt);
    // Critically: NOT surfaced as an error, and NOT stuck loading.
    expect(state.errorMessage).toBeNull();
    expect(state.isLoading).toBe(false);
  });

  it("serves the cache while the query is still in flight", () => {
    const state = resolveOrderTicketsState({
      ...base,
      cached: CACHED,
      cacheChecked: true,
      isQueryLoading: true,
    });

    expect(state.source).toBe("cache");
    expect(state.isLoading).toBe(false);
  });

  it("errors only once the cache has been checked and came back empty", () => {
    const stillChecking = resolveOrderTicketsState({
      ...base,
      cacheChecked: false,
      isQueryLoading: false,
      isQueryError: true,
      queryErrorMessage: "boom",
    });
    // Must not flash an error while the cache read is outstanding — that
    // would show a failure to someone whose pass is about to appear.
    expect(stillChecking.errorMessage).toBeNull();
    expect(stillChecking.isLoading).toBe(true);

    const checked = resolveOrderTicketsState({
      ...base,
      cacheChecked: true,
      isQueryLoading: false,
      isQueryError: true,
      queryErrorMessage: "boom",
    });
    expect(checked.errorMessage).toBe("boom");
    expect(checked.source).toBe("none");
  });

  it("does not treat an empty cached entry as usable", () => {
    const state = resolveOrderTicketsState({
      ...base,
      cached: { ...CACHED, tickets: [] },
      cacheChecked: true,
      isQueryLoading: false,
      isQueryError: true,
      queryErrorMessage: "boom",
    });

    expect(state.source).toBe("none");
    expect(state.errorMessage).toBe("boom");
  });

  it("reports loading until either source resolves", () => {
    const state = resolveOrderTicketsState(base);
    expect(state.isLoading).toBe(true);
    expect(state.source).toBe("none");
    expect(state.errorMessage).toBeNull();
  });

  it("falls back to a generic message when the query error has none", () => {
    const state = resolveOrderTicketsState({
      ...base,
      cacheChecked: true,
      isQueryLoading: false,
      isQueryError: true,
      queryErrorMessage: "",
    });

    expect(state.errorMessage).toBe("Couldn't load your tickets.");
  });

  it("prefers live data even when the query also reports an error", () => {
    // A background refetch can fail while `data` is still populated; the
    // buyer should keep seeing their tickets, not an error card.
    const state = resolveOrderTicketsState({
      ...base,
      liveTickets: LIVE,
      cacheChecked: true,
      isQueryLoading: false,
      isQueryError: true,
      queryErrorMessage: "stale refetch failed",
    });

    expect(state.source).toBe("live");
    expect(state.errorMessage).toBeNull();
  });
});

describe("toIsoOrNull", () => {
  it("serialises a Date", () => {
    expect(toIsoOrNull(new Date("2026-07-30T00:00:00.000Z"))).toBe(
      "2026-07-30T00:00:00.000Z",
    );
  });

  it("passes a string through untouched", () => {
    expect(toIsoOrNull("2026-07-30T00:00:00.000Z")).toBe(
      "2026-07-30T00:00:00.000Z",
    );
  });

  it("maps absent and invalid values to null", () => {
    expect(toIsoOrNull(null)).toBeNull();
    expect(toIsoOrNull(undefined)).toBeNull();
    expect(toIsoOrNull(new Date("nonsense"))).toBeNull();
  });
});

describe("toCacheableTickets", () => {
  it("narrows to exactly the persisted fields", () => {
    // The point of the explicit field list: a widened wire type must not
    // silently start writing extra PII into the keychain next to the codes.
    const out = toCacheableTickets([
      {
        id: "t1",
        code: "AAA",
        status: "VALID",
        scannedAt: null,
        // @ts-expect-error deliberately passing an unmodelled field
        buyerEmail: "someone@example.com",
      },
    ]);

    expect(out).toEqual([
      { id: "t1", code: "AAA", status: "VALID", scannedAt: null },
    ]);
    expect(JSON.stringify(out)).not.toContain("example.com");
  });

  it("normalises a Date scannedAt to ISO", () => {
    const out = toCacheableTickets([
      {
        id: "t1",
        code: "AAA",
        status: "SCANNED",
        scannedAt: new Date("2026-07-30T01:00:00.000Z"),
      },
    ]);
    expect(out[0].scannedAt).toBe("2026-07-30T01:00:00.000Z");
  });
});

describe("buildCacheFingerprint", () => {
  const tickets = [
    { id: "t1", code: "AAA", status: "VALID", scannedAt: null },
  ];

  it("is stable for identical input, so a refetch does not rewrite", () => {
    expect(buildCacheFingerprint("o1", tickets, null)).toBe(
      buildCacheFingerprint("o1", tickets, null),
    );
  });

  it("differs across orders holding an identical ticket shape", () => {
    // Without the order id in the key, the second order's write would be
    // skipped as a duplicate and it would never get an offline copy.
    expect(buildCacheFingerprint("o1", tickets, null)).not.toBe(
      buildCacheFingerprint("o2", tickets, null),
    );
  });

  it("changes when the event date is learned", () => {
    // An entry first cached from the pass screen has no date. When the user
    // opens order detail we learn it — that must trigger a rewrite, or the
    // entry stays undated and never becomes evictable.
    expect(buildCacheFingerprint("o1", tickets, null)).not.toBe(
      buildCacheFingerprint("o1", tickets, "2026-08-01T00:00:00.000Z"),
    );
  });

  it("changes when a ticket is scanned", () => {
    expect(buildCacheFingerprint("o1", tickets, null)).not.toBe(
      buildCacheFingerprint(
        "o1",
        [{ ...tickets[0], status: "SCANNED" }],
        null,
      ),
    );
  });
});
