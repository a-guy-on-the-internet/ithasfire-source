import { describe, expect, it, vi } from "vitest";

import type { Repos, TxRepos } from "@th/ports/repos";
import type { MultiSearchPort } from "@th/ports/search/multi-index.port";
import { ok } from "@th/ports/search";

import {
  INDEX_METHOD_BUMPS,
  withPublicReadBumpOnIndexWrites,
  withPublicReadBumpOnSearchDocumentWrites,
} from "../with-public-read-bump-on-search-writes";

const makeWriter = () => ({
  upsertDocuments: vi.fn(async () => ok({ indexed: 1 }) as never),
  deleteDocuments: vi.fn(async () => ok({ deleted: 1 }) as never),
});

describe("withPublicReadBumpOnIndexWrites", () => {
  const makeSearch = () =>
    ({
      indexLivesInPrimaryDatabase: true,
      health: vi.fn(),
      autocomplete: vi.fn(),
      getStats: vi.fn(),
      ensureIndexes: vi.fn(),
      ...makeWriter(),
    }) as unknown as MultiSearchPort & Record<string, ReturnType<typeof vi.fn>>;

  it("bumps after an upsert and after a delete", async () => {
    const bump = vi.fn(async () => undefined);
    const search = withPublicReadBumpOnIndexWrites(makeSearch(), { bump });

    await search.upsertDocuments({ documents: [] } as never);
    await search.deleteDocuments({ ids: [] } as never);
    expect(bump).toHaveBeenCalledTimes(2);
    expect(bump).toHaveBeenCalledWith("search.index-write");
  });

  it("bumps after the full rebuild's stale-document delete, not after taking the sweep marker", async () => {
    const bump = vi.fn(async () => undefined);
    const inner = Object.assign(makeSearch(), {
      beginSweep: vi.fn(async () => ok({ marker: "t" })),
      deleteUnswept: vi.fn(async () => ok({ deleted: 3 })),
    });
    const search = withPublicReadBumpOnIndexWrites(inner, { bump }) as typeof inner;

    await search.beginSweep();
    expect(bump).not.toHaveBeenCalled();
    await search.deleteUnswept({
      type: "event",
      token: { marker: "t" },
    });
    expect(bump).toHaveBeenCalledTimes(1);
  });

  it("bumps even when the write fails (a partial batch may have landed)", async () => {
    const bump = vi.fn(async () => undefined);
    const inner = makeSearch();
    inner.upsertDocuments.mockRejectedValueOnce(new Error("meili 500"));
    const search = withPublicReadBumpOnIndexWrites(inner, { bump });

    await expect(search.upsertDocuments({} as never)).rejects.toThrow();
    expect(bump).toHaveBeenCalledTimes(1);
  });

  it("does not bump on reads, and passes other members through untouched", async () => {
    const bump = vi.fn(async () => undefined);
    const inner = makeSearch();
    const search = withPublicReadBumpOnIndexWrites(inner, { bump });

    await search.autocomplete({} as never);
    await search.getStats();
    expect(bump).not.toHaveBeenCalled();
    expect(search.indexLivesInPrimaryDatabase).toBe(true);
    expect(search.health).toBe(inner.health);
  });
});

describe("INDEX_METHOD_BUMPS drives the wrapping", () => {
  it.each(Object.entries(INDEX_METHOD_BUMPS))(
    "%s bumps: %s",
    async (method, bumps) => {
      const bump = vi.fn(async () => undefined);
      const inner = { [method]: vi.fn(async () => ok({})) } as never;
      const search = withPublicReadBumpOnIndexWrites(inner, { bump }) as never as Record<
        string,
        () => Promise<unknown>
      >;
      await search[method]!();
      expect(bump).toHaveBeenCalledTimes(bumps ? 1 : 0);
    },
  );
});

describe("withPublicReadBumpOnSearchDocumentWrites", () => {
  /** A fake transaction: runs fn, then "commits" unless fn threw. */
  const makeRepos = () => {
    const events: string[] = [];
    const txWriter = makeWriter();
    const rootWriter = makeWriter();
    const repos = {
      searchDocuments: rootWriter,
      tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) => {
        const result = await fn({
          searchDocuments: txWriter,
          events: { marker: true },
        } as unknown as TxRepos);
        events.push("commit");
        return result;
      }),
    } as unknown as Repos;
    return { repos, events, txWriter, rootWriter };
  };

  it("a write inside repos.tx bumps once, AFTER the commit", async () => {
    const { repos, events } = makeRepos();
    const bump = vi.fn(async () => {
      events.push("bump");
    });
    const decorated = withPublicReadBumpOnSearchDocumentWrites(repos, { bump });

    await decorated.tx(async (tx) => {
      await tx.searchDocuments!.deleteDocuments({ ids: ["event_1"] } as never);
      await tx.searchDocuments!.upsertDocuments({ documents: [] } as never);
      expect(bump).not.toHaveBeenCalled(); // not inside the transaction
    });

    expect(events).toEqual(["commit", "bump"]);
    expect(bump).toHaveBeenCalledTimes(1);
    expect(bump).toHaveBeenCalledWith("search.document-write:tx");
  });

  it("a rolled-back transaction bumps nothing", async () => {
    const { repos } = makeRepos();
    const bump = vi.fn(async () => undefined);
    const decorated = withPublicReadBumpOnSearchDocumentWrites(repos, { bump });

    await expect(
      decorated.tx(async (tx) => {
        await tx.searchDocuments!.deleteDocuments({} as never);
        throw new Error("save failed");
      }),
    ).rejects.toThrow("save failed");
    expect(bump).not.toHaveBeenCalled();
  });

  it("a transaction with no search write bumps nothing, and other tx repos pass through", async () => {
    const { repos } = makeRepos();
    const bump = vi.fn(async () => undefined);
    const decorated = withPublicReadBumpOnSearchDocumentWrites(repos, { bump });

    await decorated.tx(async (tx) => {
      expect((tx as unknown as { events: { marker: boolean } }).events.marker).toBe(
        true,
      );
    });
    expect(bump).not.toHaveBeenCalled();
  });

  it("a root (autocommit) searchDocuments write bumps on return", async () => {
    const { repos } = makeRepos();
    const bump = vi.fn(async () => undefined);
    const decorated = withPublicReadBumpOnSearchDocumentWrites(repos, { bump });

    await decorated.searchDocuments!.upsertDocuments({} as never);
    expect(bump).toHaveBeenCalledWith("search.document-write");
  });
});
