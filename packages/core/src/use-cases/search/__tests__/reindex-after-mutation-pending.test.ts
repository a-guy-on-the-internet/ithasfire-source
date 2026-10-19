import { describe, expect, it, vi } from "vitest";

import type { Repos } from "@th/ports/repos";
import type { MultiSearchPort } from "@th/ports/search/multi-index.port";
import { withSearchIndexFence } from "@th/test-utils/fakes/search-index-fence";
import { createInMemorySearchReindexPending } from "@th/test-utils/fakes/search-reindex-pending";

import { runReindexAfterMutation } from "../reindex-after-mutation";

/**
 * The immediate post-commit attempt and the durable `SearchReindexPending`
 * mark: success clears the mark, failure keeps it, and a mark made by a
 * concurrent edit WHILE the reindex was reading survives the clear.
 */

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const T0 = new Date("2026-09-30T12:00:00.000Z");
const T1 = new Date("2026-09-30T12:00:05.000Z");
const clock = { now: () => T0 };

/**
 * An event that no longer exists: `buildSearchIndex` then REMOVES its
 * document, which is the smallest successful incremental pass.
 */
function setup(
  options: {
    deleteDocuments?: (input: { ids?: string[] }) => Promise<unknown>;
  } = {},
) {
  const pending = createInMemorySearchReindexPending();
  const repos = withSearchIndexFence({
    events: { getById: vi.fn(async () => null) },
    searchReindexPending: pending,
  }) as unknown as Repos;
  const deleteDocuments = vi.fn<[{ ids?: string[] }], Promise<unknown>>(
    options.deleteDocuments ??
      (async () => ({ ok: true as const, value: undefined })),
  );
  const search = {
    ensureIndexes: vi.fn(async () => ({ ok: true as const })),
    upsertDocuments: vi.fn(async () => ({
      ok: true as const,
      value: { indexed: 0 },
    })),
    deleteDocuments,
  } as unknown as MultiSearchPort;
  return { pending, repos, search, deleteDocuments };
}

describe("reindexAfterMutation × SearchReindexPending", () => {
  it("a successful reindex clears the entity's mark", async () => {
    const { pending, repos, search } = setup();
    await pending.mark([{ entityType: "event", entityId: EVENT_ID }], T0);

    await runReindexAfterMutation({ repos, search, clock }, "saveEvent", {
      kind: "event",
      id: EVENT_ID,
    });

    expect(pending.rows.size).toBe(0);
  });

  it("a failed reindex KEEPS the mark for the drain (and reports)", async () => {
    const reportError = vi.fn();
    const { pending, repos, search } = setup({
      deleteDocuments: async () => ({
        ok: false as const,
        error: new Error("search backend down"),
      }),
    });
    await pending.mark([{ entityType: "event", entityId: EVENT_ID }], T0);

    await runReindexAfterMutation(
      { repos, search, clock, reportError },
      "saveEvent",
      { kind: "event", id: EVENT_ID },
    );

    expect(pending.rows.has(`event:${EVENT_ID}`)).toBe(true);
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it("a NEWER mark made while the reindex was reading survives the clear", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reachedWrite!: () => void;
    const atWrite = new Promise<void>((resolve) => {
      reachedWrite = resolve;
    });
    const { pending, repos, search } = setup({
      deleteDocuments: async () => {
        reachedWrite();
        await gate;
        return { ok: true as const, value: undefined };
      },
    });
    await pending.mark([{ entityType: "event", entityId: EVENT_ID }], T0);

    const run = runReindexAfterMutation({ repos, search, clock }, "saveEvent", {
      kind: "event",
      id: EVENT_ID,
    });
    // The reindex has taken its snapshot and read the (old) source row; a
    // second edit commits now and marks again.
    await atWrite;
    await pending.mark([{ entityType: "event", entityId: EVENT_ID }], T1);
    release();
    await run;

    const row = pending.rows.get(`event:${EVENT_ID}`);
    expect(row).toBeDefined();
    expect(row!.generation).toBe(2);
    expect(row!.markedAt).toEqual(T1);
  });

  it("a failing snapshot read is reported, the reindex still runs, and the mark stays", async () => {
    const reportError = vi.fn();
    const { pending, repos, search, deleteDocuments } = setup();
    await pending.mark([{ entityType: "event", entityId: EVENT_ID }], T0);
    pending.getMany = vi.fn(async () => {
      throw new Error("read blip");
    });

    await runReindexAfterMutation(
      { repos, search, clock, reportError },
      "saveEvent",
      { kind: "event", id: EVENT_ID },
    );

    expect(deleteDocuments).toHaveBeenCalled();
    expect(pending.rows.size).toBe(1);
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { useCase: "saveEvent", op: "searchReindexPending.snapshot" },
      }),
    );
  });

  it("a failing clear is reported and never rejects", async () => {
    const reportError = vi.fn();
    const { pending, repos, search } = setup();
    await pending.mark([{ entityType: "event", entityId: EVENT_ID }], T0);
    pending.clearIfUnchanged = vi.fn(async () => {
      throw new Error("delete blip");
    });

    await expect(
      runReindexAfterMutation(
        { repos, search, clock, reportError },
        "saveEvent",
        { kind: "event", id: EVENT_ID },
      ),
    ).resolves.toBeUndefined();
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { useCase: "saveEvent", op: "searchReindexPending.clear" },
      }),
    );
  });
});
