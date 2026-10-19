import { describe, expect, it, vi } from "vitest";

import { buildOffsetPaginatedResult } from "@th/ports/pagination";
import type { Repos } from "@th/ports/repos";
import type { MultiSearchPort } from "@th/ports/search/multi-index.port";

import { buildSearchIndex } from "../build-search-index";
import { scrubSearchDocumentsOrReport } from "../privacy-scrub";
import { bindSearchToTx, isTxBoundSearch } from "../tx-bound-search";

/**
 * Where the fence's document write goes, and what happens when the fence's
 * transaction fails:
 *  · Postgres (`indexLivesInPrimaryDatabase`): through the transaction's own
 *    writer, so a rollback takes the write with it;
 *  · an external engine: the port, plus ONE re-run of the fence if the
 *    transaction rejected after the write started;
 *  · the nightly rebuild: one failed page never ends the run.
 */

const NOW = new Date("2026-09-29T12:00:00.000Z");
const PLACE_A = "a0000000-0000-4000-8000-00000000000a";
const PLACE_B = "b0000000-0000-4000-8000-00000000000b";

const ok = <T>(value: T) => ({ ok: true as const, value });

function place(id: string) {
  return {
    id,
    name: `Venue ${id.slice(0, 1)}`,
    city: "Nashville",
    region: "TN",
    countryCode: "US",
    lat: 36.1,
    lng: -86.7,
    status: "ACTIVE",
    verificationStatus: "VERIFIED",
    listedInDirectory: true,
    locationMode: "EXACT",
    locationRadiusMeters: null,
  };
}

function port(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    autocomplete: vi.fn(),
    getStats: vi.fn(),
    ensureIndexes: vi.fn(async () => ok(undefined)),
    // Non-destructive full rebuild: marker, then per-type sweep.
    beginSweep: vi.fn(async () => ok({ marker: "sweep-1" })),
    deleteUnswept: vi.fn(async () => ok({ deleted: 0 })),
    upsertDocuments: vi.fn(async ({ documents }: { documents: unknown[] }) =>
      ok({ indexed: documents.length, failed: 0 }),
    ),
    deleteDocuments: vi.fn(async () => ok({ deleted: 0 })),
    ...overrides,
  };
}

function writer() {
  return {
    upsertDocuments: vi.fn(async ({ documents }: { documents: unknown[] }) =>
      ok({ indexed: documents.length, failed: 0 }),
    ),
    deleteDocuments: vi.fn(async () => ok({ deleted: 0 })),
  };
}

describe("bindSearchToTx", () => {
  it("routes WRITES to the transaction's writer when the index is a primary-DB table", async () => {
    const search = port({ indexLivesInPrimaryDatabase: true });
    const w = writer();

    const bound = bindSearchToTx(search as unknown as MultiSearchPort, {
      searchDocuments: w,
    });
    await bound.search.upsertDocuments({ documents: [] });
    await bound.search.deleteDocuments({ ids: ["x"] });
    await bound.search.ensureIndexes();

    expect(bound.inTx).toBe(true);
    expect(w.upsertDocuments).toHaveBeenCalledTimes(1);
    expect(w.deleteDocuments).toHaveBeenCalledWith({ ids: ["x"] });
    expect(search.upsertDocuments).not.toHaveBeenCalled();
    expect(search.deleteDocuments).not.toHaveBeenCalled();
    // Non-write calls stay on the port.
    expect(search.ensureIndexes).toHaveBeenCalledTimes(1);
  });

  it("keeps the port for an external engine, or when the tx has no writer", () => {
    const external = port();
    expect(
      bindSearchToTx(external as unknown as MultiSearchPort, {
        searchDocuments: writer(),
      }),
    ).toEqual({ search: external, inTx: false });

    const postgres = port({ indexLivesInPrimaryDatabase: true });
    expect(
      bindSearchToTx(postgres as unknown as MultiSearchPort, {}),
    ).toEqual({ search: postgres, inTx: false });
  });
});

/** Repos whose `tx` runs `fn` on a tx object carrying `searchDocuments`. */
function placeRepos(opts: {
  txWriter?: ReturnType<typeof writer>;
  /** Make the Nth tx call reject AFTER `fn` resolved (1-based). */
  rejectTxCall?: number;
  pages?: string[][];
}) {
  let txCalls = 0;
  const places = {
    getById: vi.fn(async (id: string) => place(id)),
    listForSearchIndex: vi.fn(async ({ offset }: { offset: number }) => {
      const pages = opts.pages ?? [];
      const index = Math.floor(offset / 1);
      const items = (pages[index] ?? []).map(place);
      return buildOffsetPaginatedResult({
        items,
        total: pages.flat().length,
        limit: 1,
        offset,
      } as never);
    }),
  };
  const txRepos = {
    places,
    events: {
      lockLocationsAtPlace: vi.fn(async () => undefined),
      lockRows: vi.fn(async () => undefined),
    },
    entityPages: {
      getByOwner: vi.fn(async () => null),
      getByOwners: vi.fn(async () => []),
    },
    ...(opts.txWriter ? { searchDocuments: opts.txWriter } : {}),
  };
  const repos = {
    ...txRepos,
    tx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      txCalls += 1;
      const out = await fn(txRepos);
      if (txCalls === opts.rejectTxCall) {
        throw new Error("Transaction already closed: timeout");
      }
      return out;
    }),
  } as unknown as Repos;
  return { repos, places };
}

describe("the fence's write, by backend", () => {
  it("Postgres: the document write goes through the fence's transaction, sorted by id", async () => {
    const search = port({ indexLivesInPrimaryDatabase: true });
    const w = writer();
    const { repos } = placeRepos({ txWriter: w });

    const result = await buildSearchIndex(
      {
        repos,
        search: search as unknown as MultiSearchPort,
        clock: { now: () => NOW },
      },
      { placeIds: [PLACE_B, PLACE_A] },
    );

    expect(result.errors).toEqual([]);
    expect(search.upsertDocuments).not.toHaveBeenCalled();
    expect(w.upsertDocuments).toHaveBeenCalledTimes(1);
    const [{ documents }] = w.upsertDocuments.mock.calls[0]! as unknown as [
      { documents: Array<{ id: string }> },
    ];
    expect(documents.map((d) => d.id)).toEqual([
      `place_${PLACE_A}`,
      `place_${PLACE_B}`,
    ]);
  });

  it("Postgres: a rejected fence transaction is NOT re-run (its write rolled back with it)", async () => {
    const search = port({ indexLivesInPrimaryDatabase: true });
    const w = writer();
    const { repos } = placeRepos({ txWriter: w, rejectTxCall: 1 });

    await expect(
      buildSearchIndex(
        {
          repos,
          search: search as unknown as MultiSearchPort,
          clock: { now: () => NOW },
        },
        { placeIds: [PLACE_A] },
      ),
    ).rejects.toThrow("Transaction already closed");
    expect(repos.tx).toHaveBeenCalledTimes(1);
  });

  it("external engine: a fence rejected AFTER its write runs once more, so committed state is written last", async () => {
    const search = port();
    const { repos } = placeRepos({ rejectTxCall: 1 });

    const result = await buildSearchIndex(
      {
        repos,
        search: search as unknown as MultiSearchPort,
        clock: { now: () => NOW },
      },
      { placeIds: [PLACE_A] },
    );

    expect(result.errors).toEqual([]);
    expect(repos.tx).toHaveBeenCalledTimes(2);
    expect(search.upsertDocuments).toHaveBeenCalledTimes(2);
  });

  it("external engine: re-runs only ONCE", async () => {
    const search = port();
    let calls = 0;
    const { repos } = placeRepos({});
    const tx = repos.tx as unknown as ReturnType<typeof vi.fn>;
    const inner = tx.getMockImplementation()!;
    tx.mockImplementation(async (fn: never) => {
      await inner(fn);
      calls += 1;
      throw new Error(`timeout ${calls}`);
    });

    await expect(
      buildSearchIndex(
        {
          repos,
          search: search as unknown as MultiSearchPort,
          clock: { now: () => NOW },
        },
        { placeIds: [PLACE_A] },
      ),
    ).rejects.toThrow("timeout 2");
    expect(calls).toBe(2);
  });
});

describe("nightly rebuild: one failed page never ends the run", () => {
  it("records the page's ids, reports, and indexes the next page", async () => {
    const search = port();
    const reportError = vi.fn();
    // Page 1 = [A], page 2 = [B]; the FIRST place fence (page 1) keeps failing.
    const { repos } = placeRepos({ pages: [[PLACE_A], [PLACE_B]] });
    const tx = repos.tx as unknown as ReturnType<typeof vi.fn>;
    const inner = tx.getMockImplementation()!;
    let placeFence = 0;
    tx.mockImplementation(async (fn: never) => {
      placeFence += 1;
      // Fails before any write started, so there is no re-run: one call.
      if (placeFence === 1) throw new Error("fence timed out");
      return inner(fn);
    });
    const emptyRepos = repos as unknown as Record<string, unknown>;
    emptyRepos.events = {
      ...(emptyRepos.events as object),
      listPublished: vi.fn(async () => ({ items: [], total: 0 })),
    };
    emptyRepos.humans = {
      listForSearchIndex: vi.fn(async () =>
        buildOffsetPaginatedResult({ items: [] } as never),
      ),
    };
    emptyRepos.organizations = {
      listActive: vi.fn(async () => ({ items: [], total: 0 })),
    };
    emptyRepos.categories = { listAll: vi.fn(async () => []) };

    const result = await buildSearchIndex(
      {
        repos,
        search: search as unknown as MultiSearchPort,
        clock: { now: () => NOW },
        reportError,
      },
      { fullReindex: true, batchSize: 1 },
    );

    expect(result.placesIndexed).toBe(1);
    expect(result.errors).toEqual([
      expect.objectContaining({ type: "place", id: PLACE_A }),
    ]);
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { useCase: "buildSearchIndex", step: "indexPage" },
      }),
    );
    // Page A's documents were NOT rewritten, so sweeping "place" would delete
    // a live venue: the place sweep is skipped; the other types still sweep.
    const swept = search.deleteUnswept.mock.calls.map(
      (c) => (c as unknown as [{ type: string }])[0].type,
    );
    expect(swept).not.toContain("place");
    expect(swept).toEqual(["event", "human", "organization"]);
  });

  it("per-id content errors do not skip the sweep; their documents are kept", async () => {
    const search = port();
    // Page B's build throws for B only (a content error, not a page failure).
    const { repos } = placeRepos({ pages: [[PLACE_A, PLACE_B]] });
    const emptyRepos = repos as unknown as Record<string, unknown>;
    const places = emptyRepos.places as {
      getById: ReturnType<typeof vi.fn>;
    };
    places.getById.mockImplementation(async (id: string) => {
      const row = place(id);
      if (id !== PLACE_B) return row;
      // B's document cannot be built this run (a content error).
      return Object.defineProperty(row, "name", {
        get() {
          throw new Error("corrupt row");
        },
      });
    });
    emptyRepos.events = {
      ...(emptyRepos.events as object),
      listPublished: vi.fn(async () => ({ items: [], total: 0 })),
    };
    emptyRepos.humans = {
      listForSearchIndex: vi.fn(async () =>
        buildOffsetPaginatedResult({ items: [] } as never),
      ),
    };
    emptyRepos.organizations = {
      listActive: vi.fn(async () => ({ items: [], total: 0 })),
    };
    emptyRepos.categories = { listAll: vi.fn(async () => []) };

    const result = await buildSearchIndex(
      {
        repos,
        search: search as unknown as MultiSearchPort,
        clock: { now: () => NOW },
      },
      { fullReindex: true, batchSize: 10 },
    );

    expect(result.errors).toEqual([
      expect.objectContaining({ type: "place", id: PLACE_B }),
    ]);
    const placeSweep = search.deleteUnswept.mock.calls
      .map((c) => (c as unknown as [{ type: string; keepIds: string[] }])[0])
      .find((c) => c.type === "place");
    expect(placeSweep).toBeDefined();
    expect(placeSweep!.keepIds).toEqual([`place_${PLACE_B}`]);
  });

  it("a failed sweep MARKER skips every sweep but still refreshes every document", async () => {
    const search = port({
      beginSweep: vi.fn(async () => ({
        ok: false as const,
        error: new Error("clock read failed"),
      })),
    });
    const reportError = vi.fn();
    const { repos } = placeRepos({ pages: [[PLACE_A]] });
    const r = repos as unknown as Record<string, unknown>;
    r.events = {
      ...(r.events as object),
      listPublished: vi.fn(async () => ({ items: [], total: 0 })),
    };
    r.humans = {
      listForSearchIndex: vi.fn(async () =>
        buildOffsetPaginatedResult({ items: [] } as never),
      ),
    };
    r.organizations = { listActive: vi.fn(async () => ({ items: [], total: 0 })) };
    r.categories = { listAll: vi.fn(async () => []) };

    const result = await buildSearchIndex(
      {
        repos,
        search: search as unknown as MultiSearchPort,
        clock: { now: () => NOW },
        reportError,
      },
      { fullReindex: true, batchSize: 10 },
    );

    expect(result.placesIndexed).toBe(1);
    expect(search.deleteUnswept).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { useCase: "buildSearchIndex", step: "beginSweep" },
      }),
    );
  });
});

describe("the tx-bound brand", () => {
  it("bindSearchToTx brands its port; the port itself is not branded", () => {
    const search = port({ indexLivesInPrimaryDatabase: true });
    const bound = bindSearchToTx(search as unknown as MultiSearchPort, {
      searchDocuments: writer(),
    });
    expect(isTxBoundSearch(bound.search)).toBe(true);
    expect(isTxBoundSearch(search)).toBe(false);
  });

  it("scrubSearchDocumentsOrReport REFUSES a tx-bound port (the cancel hazard)", async () => {
    const search = port({ indexLivesInPrimaryDatabase: true });
    const w = writer();
    const bound = bindSearchToTx(search as unknown as MultiSearchPort, {
      searchDocuments: w,
    }).search;

    await expect(
      scrubSearchDocumentsOrReport(bound, { docIds: ["event_x"], useCase: "t" }),
    ).rejects.toThrow("transaction-bound search port");
    expect(w.deleteDocuments).not.toHaveBeenCalled();

    // The port itself is fine.
    await expect(
      scrubSearchDocumentsOrReport(search as unknown as MultiSearchPort, {
        docIds: ["event_x"],
        useCase: "t",
      }),
    ).resolves.toBe(true);
  });
});

describe("a failed write is never a success", () => {
  it("nightly place page: a rejected upsert records per-id upsert_failed", async () => {
    const search = port({
      upsertDocuments: vi.fn(async () => ({
        ok: false as const,
        error: new Error("aborted"),
      })),
    });
    const { repos } = placeRepos({ pages: [[PLACE_A]] });
    const r = repos as unknown as Record<string, unknown>;
    r.events = {
      ...(r.events as object),
      listPublished: vi.fn(async () => ({ items: [], total: 0 })),
    };
    r.humans = {
      listForSearchIndex: vi.fn(async () =>
        buildOffsetPaginatedResult({ items: [] } as never),
      ),
    };
    r.organizations = { listActive: vi.fn(async () => ({ items: [], total: 0 })) };
    r.categories = { listAll: vi.fn(async () => []) };

    const result = await buildSearchIndex(
      { repos, search: search as unknown as MultiSearchPort, clock: { now: () => NOW } },
      { fullReindex: true, batchSize: 1 },
    );

    expect(result.placesIndexed).toBe(0);
    expect(result.errors).toEqual([
      expect.objectContaining({
        type: "place",
        id: PLACE_A,
        error: expect.stringContaining("upsert_failed"),
      }),
    ]);
  });

  it("full reindex: a failed stale-document SWEEP is logged at error AND reported", async () => {
    const search = port({
      deleteUnswept: vi.fn(async () => ({
        ok: false as const,
        error: new Error("sweep failed"),
      })),
    });
    const reportError = vi.fn();
    const { repos } = placeRepos({ pages: [] });
    const r = repos as unknown as Record<string, unknown>;
    r.events = {
      ...(r.events as object),
      listPublished: vi.fn(async () => ({ items: [], total: 0 })),
    };
    r.humans = {
      listForSearchIndex: vi.fn(async () =>
        buildOffsetPaginatedResult({ items: [] } as never),
      ),
    };
    r.organizations = { listActive: vi.fn(async () => ({ items: [], total: 0 })) };
    r.categories = { listAll: vi.fn(async () => []) };

    await buildSearchIndex(
      {
        repos,
        search: search as unknown as MultiSearchPort,
        clock: { now: () => NOW },
        reportError,
      },
      { fullReindex: true },
    );

    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { useCase: "buildSearchIndex", step: "deleteUnswept" },
      }),
    );
  });
});
