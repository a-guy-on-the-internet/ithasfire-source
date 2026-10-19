import { describe, expect, it, vi } from "vitest";

import type { Repos } from "@th/ports/repos";
import type { SearchIndexStateRecord } from "@th/ports/repos/search-index-state";
import type { MultiSearchPort } from "@th/ports/search/multi-index.port";
import {
  createInMemorySearchIndexState,
  createInMemorySearchReindexPending,
} from "@th/test-utils/fakes/search-reindex-pending";

import { SEARCH_INDEX_FORMAT_VERSION } from "../search-index-format";
import {
  FORMAT_REBUILD_CLAIM_TTL_MS,
  ensureSearchIndexFormat,
  runFullSearchReindex,
} from "../search-index-format-rebuild";

const NOW = new Date("2026-09-30T12:00:00.000Z");
const EVT_OK = "11111111-1111-4111-8111-111111111111";
const EVT_FAIL = "22222222-2222-4222-8222-222222222222";
const PLACE_ID = "33333333-3333-4333-8333-333333333333";
const HUMAN_BROKEN = "44444444-4444-4444-8444-444444444444";

/**
 * A corpus for the full rebuild: at most one published event page, whose
 * fence fails when `failPage` (a PAGE failure) — everything else empty.
 */
function corpus(
  options: {
    failPage?: boolean;
    /** One place page whose fence fails (a PAGE failure in the place pass). */
    failPlacePage?: boolean;
    /** One human whose document cannot be built (a per-id CONTENT error). */
    brokenHuman?: boolean;
    state?: SearchIndexStateRecord | null;
    onListActiveOrgs?: () => Promise<void>;
  } = {},
) {
  const pending = createInMemorySearchReindexPending();
  const state = createInMemorySearchIndexState(options.state ?? null);
  const listPublished = vi.fn(async () => ({
    items: options.failPage ? [{ id: EVT_FAIL, placeId: null }] : [],
    pageInfo: { total: 0 },
  }));
  const repos = {
    searchReindexPending: pending,
    searchIndexState: state,
    events: {
      listPublished,
      lockRows: vi.fn(async () => {
        throw new Error("lock timeout");
      }),
      lockLocationsAtPlace: vi.fn(async () => {
        if (options.failPlacePage) throw new Error("place lock timeout");
      }),
    },
    categories: { listAll: vi.fn(async () => []) },
    humans: {
      listForSearchIndex: vi.fn(async () => ({
        // A page-less human: building its document throws (content error).
        items: options.brokenHuman
          ? [{ human: { id: HUMAN_BROKEN, name: "x" }, page: null }]
          : [],
        pageInfo: { hasNextPage: false },
      })),
    },
    places: {
      listForSearchIndex: vi.fn(async () => ({
        items: options.failPlacePage ? [{ id: PLACE_ID }] : [],
        pageInfo: { hasNextPage: false },
      })),
    },
    organizations: {
      listActive: vi.fn(async () => {
        await options.onListActiveOrgs?.();
        return { items: [] };
      }),
    },
    tx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(repos)),
  } as unknown as Repos;
  const ok = <T>(value: T) => ({ ok: true as const, value });
  const search = {
    ensureIndexes: vi.fn(async () => ok(undefined)),
    beginSweep: vi.fn(async () => ok({ marker: "sweep-1" })),
    deleteUnswept: vi.fn(async () => ok({ deleted: 0 })),
    deleteDocuments: vi.fn(async () => ok(undefined)),
    upsertDocuments: vi.fn(async () => ok({ indexed: 0 })),
  };
  const reportError = vi.fn();
  let now = NOW;
  return {
    pending,
    state,
    search,
    reportError,
    deps: {
      repos,
      search: search as unknown as MultiSearchPort,
      clock: { now: () => now },
      reportError,
    },
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}

describe("SEARCH_INDEX_FORMAT_VERSION", () => {
  it("is bumped past 1 for the 21fb8b51 location_is_exact / radius columns", () => {
    expect(SEARCH_INDEX_FORMAT_VERSION).toBeGreaterThanOrEqual(2);
  });

  it("is bumped past 3 for the SearchDocument `timezone` column", () => {
    expect(SEARCH_INDEX_FORMAT_VERSION).toBeGreaterThanOrEqual(4);
  });
});

describe("runFullSearchReindex (search.full-reindex)", () => {
  it("never clears the index; it sweeps per type after rewriting", async () => {
    const c = corpus();
    await runFullSearchReindex(c.deps, { batchSize: 100 });

    expect(c.search.deleteDocuments).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: expect.anything() }),
    );
    expect(c.search.beginSweep).toHaveBeenCalledTimes(1);
    expect(c.search.deleteUnswept).toHaveBeenCalledTimes(4);
  });

  it("clears the marks that existed before the rebuild and records the format version", async () => {
    const c = corpus();
    await c.pending.mark([{ entityType: "event", entityId: EVT_OK }], NOW);
    // A parked row is covered by a full rebuild too.
    await c.pending.recordFailure(
      [{ entityType: "event", entityId: EVT_OK, generation: 1 }],
      { error: "x", at: NOW },
    );

    const out = await runFullSearchReindex(c.deps, { batchSize: 100 });

    expect(out.errors).toEqual([]);
    expect(out.pendingCleared).toBe(1);
    expect(c.pending.rows.size).toBe(0);
    expect(out.formatVersionRecorded).toBe(SEARCH_INDEX_FORMAT_VERSION);
    expect(c.state.state?.formatVersion).toBe(SEARCH_INDEX_FORMAT_VERSION);
  });

  it("a PAGE failure records NO version, keeps that type unswept and its marks pending", async () => {
    const c = corpus({ failPage: true });
    await c.pending.mark(
      [
        { entityType: "event", entityId: EVT_OK },
        { entityType: "event", entityId: EVT_FAIL },
      ],
      NOW,
    );

    const out = await runFullSearchReindex(c.deps, { batchSize: 100 });

    expect(out.errors.map((e) => e.id)).toEqual([EVT_FAIL]);
    expect(out.formatVersionRecorded).toBeNull();
    expect(c.state.state?.formatVersion ?? 0).toBe(0);
    // The failed page's type is not swept (its documents were not rewritten)
    // — so NO event mark is cleared, not even the one that did not fail.
    expect(out.sweptTypes).toEqual(["human", "place", "organization"]);
    expect([...c.pending.rows.keys()].sort()).toEqual(
      [`event:${EVT_FAIL}`, `event:${EVT_OK}`].sort(),
    );
  });

  it("a suspended venue marked before the run stays marked when a place page fails (its stale document was not swept)", async () => {
    const c = corpus({ failPlacePage: true });
    const SUSPENDED = "55555555-5555-4555-8555-555555555555";
    await c.pending.mark([{ entityType: "place", entityId: SUSPENDED }], NOW);
    await c.pending.mark([{ entityType: "event", entityId: EVT_OK }], NOW);

    const out = await runFullSearchReindex(c.deps, { batchSize: 100 });

    expect(out.sweptTypes).not.toContain("place");
    expect(c.search.deleteUnswept).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "place" }),
    );
    // The place mark survives for the drain; the event mark (event type was
    // rewritten AND swept) is cleared.
    expect([...c.pending.rows.keys()]).toEqual([`place:${SUSPENDED}`]);
    expect(out.formatVersionRecorded).toBeNull();
  });

  it("a failed sweep MARKER clears no marks at all", async () => {
    const c = corpus();
    c.search.beginSweep.mockResolvedValueOnce({
      ok: false,
      error: new Error("clock read failed"),
    } as never);
    await c.pending.mark(
      [{ entityType: "organization", entityId: EVT_OK }],
      NOW,
    );

    const out = await runFullSearchReindex(c.deps, { batchSize: 100 });

    expect(out.sweptTypes).toEqual([]);
    expect(out.pendingCleared).toBe(0);
    expect(c.pending.rows.size).toBe(1);
  });

  it("per-id CONTENT errors still record the version", async () => {
    const c = corpus({ brokenHuman: true });

    const out = await runFullSearchReindex(c.deps, { batchSize: 100 });

    expect(out.errors).toEqual([
      expect.objectContaining({ type: "human", id: HUMAN_BROKEN }),
    ]);
    expect(out.sweptTypes).toContain("human");
    expect(out.formatVersionRecorded).toBe(SEARCH_INDEX_FORMAT_VERSION);
  });

  it("per-id CONTENT errors are REPORTED once per type (they are swallowed: old documents kept, version recorded)", async () => {
    const c = corpus({ brokenHuman: true });

    const out = await runFullSearchReindex(c.deps, { batchSize: 100 });

    expect(out.formatVersionRecorded).toBe(SEARCH_INDEX_FORMAT_VERSION);
    const contentReports = c.reportError.mock.calls.filter(
      ([, ctx]) =>
        (ctx as { tags?: { step?: string } } | undefined)?.tags?.step ===
        "contentErrors",
    );
    expect(contentReports).toHaveLength(1);
    expect(contentReports[0]![1]).toMatchObject({
      tags: { useCase: "buildSearchIndex", step: "contentErrors" },
      extra: { type: "human", count: 1, ids: [HUMAN_BROKEN] },
    });
  });

  it("a THROWING reporter does not change the outcome of a run with content errors", async () => {
    const c = corpus({ brokenHuman: true });
    c.reportError.mockImplementation(() => {
      throw new Error("sentry exploded");
    });

    const out = await runFullSearchReindex(c.deps, { batchSize: 100 });

    expect(out.errors).toEqual([
      expect.objectContaining({ type: "human", id: HUMAN_BROKEN }),
    ]);
    expect(out.sweptTypes).toEqual(["event", "human", "place", "organization"]);
    expect(out.formatVersionRecorded).toBe(SEARCH_INDEX_FORMAT_VERSION);
  });

  it("an older build's run never lowers a newer recorded version", async () => {
    const c = corpus({
      state: {
        formatVersion: SEARCH_INDEX_FORMAT_VERSION + 1,
        rebuildClaimedVersion: null,
        rebuildClaimedAt: null,
      },
    });
    await runFullSearchReindex(c.deps, { batchSize: 100 });
    expect(c.state.state?.formatVersion).toBe(SEARCH_INDEX_FORMAT_VERSION + 1);
  });

  it("a mark made while the rebuild ran survives it", async () => {
    let pending!: ReturnType<typeof createInMemorySearchReindexPending>;
    const c = corpus({
      onListActiveOrgs: async () => {
        // An edit commits mid-rebuild, after the snapshot was taken.
        await pending.mark([{ entityType: "event", entityId: EVT_OK }], NOW);
      },
    });
    pending = c.pending;
    await c.pending.mark([{ entityType: "event", entityId: EVT_OK }], NOW);

    const out = await runFullSearchReindex(c.deps, { batchSize: 100 });

    expect(out.pendingCleared).toBe(0);
    expect(c.pending.rows.get(`event:${EVT_OK}`)?.generation).toBe(2);
  });
});

describe("ensureSearchIndexFormat (search.ensure-format, post-deploy)", () => {
  const behind = {
    formatVersion: 1,
    rebuildClaimedVersion: null,
    rebuildClaimedAt: null,
  };

  it("a current index is a one-row read: no claim, no rebuild", async () => {
    const c = corpus({
      state: { ...behind, formatVersion: SEARCH_INDEX_FORMAT_VERSION },
    });
    const out = await ensureSearchIndexFormat(c.deps, { batchSize: 100 });
    expect(out.outcome).toBe("current");
    expect(c.search.beginSweep).not.toHaveBeenCalled();
    expect(c.state.state?.rebuildClaimedVersion).toBeNull();
  });

  it("an OLDER revision (stored version ahead of its constant) is a no-op", async () => {
    const c = corpus({
      state: { ...behind, formatVersion: SEARCH_INDEX_FORMAT_VERSION + 1 },
    });
    const out = await ensureSearchIndexFormat(c.deps, { batchSize: 100 });
    expect(out).toMatchObject({
      outcome: "current",
      storedVersion: SEARCH_INDEX_FORMAT_VERSION + 1,
      codeVersion: SEARCH_INDEX_FORMAT_VERSION,
    });
    expect(c.search.beginSweep).not.toHaveBeenCalled();
  });

  it("a stale index: claim, non-destructive rebuild, record the version", async () => {
    const c = corpus({ state: behind });
    const out = await ensureSearchIndexFormat(c.deps, { batchSize: 100 });
    expect(out.outcome).toBe("rebuilt");
    expect(c.search.beginSweep).toHaveBeenCalledTimes(1);
    expect(c.state.state?.formatVersion).toBe(SEARCH_INDEX_FORMAT_VERSION);
  });

  it("a never-recorded index (no state row) counts as stale", async () => {
    const c = corpus({ state: null });
    await expect(
      ensureSearchIndexFormat(c.deps, { batchSize: 100 }),
    ).resolves.toMatchObject({ outcome: "rebuilt" });
  });

  it("redelivered N times at once, it rebuilds exactly once", async () => {
    const c = corpus({ state: behind });
    const outcomes = await Promise.all(
      Array.from({ length: 6 }, () =>
        ensureSearchIndexFormat(c.deps, { batchSize: 100 }),
      ),
    );
    const kinds = outcomes.map((o) => o.outcome);
    expect(kinds.filter((k) => k === "rebuilt")).toHaveLength(1);
    expect(c.search.beginSweep).toHaveBeenCalledTimes(1);
  });

  it("per-id content errors still record the version: no repeating rebuild", async () => {
    const c = corpus({ state: behind, brokenHuman: true });
    const first = await ensureSearchIndexFormat(c.deps, { batchSize: 100 });
    expect(first.outcome).toBe("rebuilt");
    c.advance(FORMAT_REBUILD_CLAIM_TTL_MS + 60_000);
    const later = await ensureSearchIndexFormat(c.deps, { batchSize: 100 });
    expect(later.outcome).toBe("current");
  });

  it("a rebuild that THROWS is reported, gives the claim back and rethrows (the delivery retries)", async () => {
    const c = corpus({ state: behind });
    c.search.ensureIndexes.mockResolvedValueOnce({
      ok: false,
      error: new Error("backend down"),
    } as never);

    await expect(
      ensureSearchIndexFormat(c.deps, { batchSize: 100 }),
    ).rejects.toThrow("backend down");
    expect(c.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { useCase: "ensureSearchIndexFormat", op: "formatRebuild" },
      }),
    );
    expect(c.state.state?.rebuildClaimedVersion).toBeNull();
    await expect(
      ensureSearchIndexFormat(c.deps, { batchSize: 100 }),
    ).resolves.toMatchObject({ outcome: "rebuilt" });
  });

  it("a failed claim RELEASE is reported (guarded) and the rebuild error still surfaces", async () => {
    const c = corpus({ state: behind });
    c.search.ensureIndexes.mockResolvedValueOnce({
      ok: false,
      error: new Error("backend down"),
    } as never);
    const releaseErr = new Error("release failed");
    c.state.releaseFormatRebuildClaim = vi.fn(async () => {
      throw releaseErr;
    });

    await expect(
      ensureSearchIndexFormat(c.deps, { batchSize: 100 }),
    ).rejects.toThrow("backend down");
    expect(c.reportError).toHaveBeenCalledWith(
      releaseErr,
      expect.objectContaining({
        tags: {
          useCase: "ensureSearchIndexFormat",
          op: "releaseFormatRebuildClaim",
        },
      }),
    );
  });

  it("a THROWING reporter on the release path cannot mask the rebuild error", async () => {
    const c = corpus({ state: behind });
    c.search.ensureIndexes.mockResolvedValueOnce({
      ok: false,
      error: new Error("backend down"),
    } as never);
    c.state.releaseFormatRebuildClaim = vi.fn(async () => {
      throw new Error("release failed");
    });
    c.reportError.mockImplementation(() => {
      throw new Error("sentry exploded");
    });

    await expect(
      ensureSearchIndexFormat(c.deps, { batchSize: 100 }),
    ).rejects.toThrow("backend down");
  });
});
