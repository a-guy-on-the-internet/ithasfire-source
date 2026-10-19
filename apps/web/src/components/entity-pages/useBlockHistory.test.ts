import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────
const mutateAsyncMock = vi.fn();
const invalidateMock = vi.fn();
const dangerMock = vi.fn();

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      entityPages: { getMyPage: { invalidate: invalidateMock } },
    }),
    entityPages: {
      managePageBlocks: {
        useMutation: () => ({ mutateAsync: mutateAsyncMock }),
      },
    },
  },
}));

vi.mock("@th/ui", () => ({
  useNotify: () => ({ toast: { danger: dangerMock } }),
  useTranslations: () => (key: string) => key,
}));

// Imported after the mocks so the hook picks up the mocked modules.
import { useBlockHistory, type HistoryBlock } from "./useBlockHistory";

// ── Helpers ──────────────────────────────────────────────────────────────────
function block(
  id: string,
  kind: string,
  data: unknown,
  visible = true,
): HistoryBlock {
  return { id, kind, data, visible };
}

/** Drain the convergence's awaited mutation chain + invalidate. */
async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

type BlockAction = { action: string; blockId?: string; [k: string]: unknown };

function actions(): BlockAction[] {
  return mutateAsyncMock.mock.calls.map(
    (call) => (call[0] as { blockAction: BlockAction }).blockAction,
  );
}

type HistoryHarnessProps = {
  blocks: HistoryBlock[];
  mode?: "full" | "edit-only";
};

function renderHistory(initialBlocks: HistoryBlock[]) {
  const initialProps: HistoryHarnessProps = { blocks: initialBlocks };
  return renderHook(
    ({ blocks, mode = "full" }: HistoryHarnessProps) =>
      useBlockHistory({
        blocks,
        ownerType: "HUMAN",
        ownerId: "h1",
        mode,
      }),
    { initialProps },
  );
}

beforeEach(() => {
  mutateAsyncMock.mockReset();
  invalidateMock.mockReset();
  dangerMock.mockReset();
  mutateAsyncMock.mockResolvedValue(undefined);
  invalidateMock.mockResolvedValue(undefined);
});

// ── Tests ────────────────────────────────────────────────────────────────────
describe("useBlockHistory — convergence", () => {
  it("undo of an add deletes the added block", async () => {
    const A = block("A", "about", { text: "one" });
    const B = block("B", "links", { links: [] });
    const { result, rerender } = renderHistory([A]);

    rerender({ blocks: [A, B] });
    expect(result.current.canUndo).toBe(true);

    await act(async () => {
      result.current.undo();
      await flush();
    });

    expect(actions()).toContainEqual(
      expect.objectContaining({ action: "delete", blockId: "B" }),
    );
  });

  it("undo of an edit restores the previous data", async () => {
    const before = block("A", "about", { heading: "x" });
    const after = block("A", "about", { heading: "y" });
    const { result, rerender } = renderHistory([before]);

    rerender({ blocks: [after] });

    await act(async () => {
      result.current.undo();
      await flush();
    });

    expect(actions()).toContainEqual(
      expect.objectContaining({
        action: "edit",
        blockId: "A",
        data: { heading: "x" },
      }),
    );
    // A pure data change must not re-send visibility.
    const editCall = actions().find((a) => a.action === "edit");
    expect(editCall).toBeDefined();
    expect(editCall).not.toHaveProperty("visible");
  });

  it("undo of a reorder restores the previous order", async () => {
    const A = block("A", "about", {});
    const B = block("B", "links", {});
    const { result, rerender } = renderHistory([A, B]);

    rerender({ blocks: [B, A] });

    await act(async () => {
      result.current.undo();
      await flush();
    });

    expect(actions()).toContainEqual(
      expect.objectContaining({
        action: "reorder",
        orderedBlockIds: ["A", "B"],
      }),
    );
  });

  it("remaps a re-created block id across delete → undo → redo", async () => {
    const A = block("A", "about", {});
    const B = block("B", "links", {});
    const { result, rerender } = renderHistory([A, B]);

    // Delete B on the server.
    rerender({ blocks: [A] });
    expect(result.current.canUndo).toBe(true);

    // Undo re-creates B; the server assigns a NEW id (b2).
    mutateAsyncMock.mockResolvedValue({ block: { id: "b2" } });
    await act(async () => {
      result.current.undo();
      await flush();
    });
    expect(actions()).toContainEqual(
      expect.objectContaining({ action: "add", kind: "links" }),
    );

    mutateAsyncMock.mockReset();
    mutateAsyncMock.mockResolvedValue(undefined);

    // Redo must delete the RE-CREATED id (b2), not the stale snapshot id (b1).
    await act(async () => {
      result.current.redo();
      await flush();
    });
    expect(actions()).toContainEqual(
      expect.objectContaining({ action: "delete", blockId: "b2" }),
    );
    expect(actions()).not.toContainEqual(
      expect.objectContaining({ action: "delete", blockId: "B" }),
    );
  });
});

describe("useBlockHistory — pinned blocks (R6/FR-012)", () => {
  beforeEach(() => {
    mutateAsyncMock.mockReset();
    mutateAsyncMock.mockResolvedValue(undefined);
    invalidateMock.mockReset();
    dangerMock.mockReset();
  });

  it("never deletes a pinned block mid-converge, and the reorder still covers the whole page", async () => {
    // A snapshot from BEFORE `track_record` was seeded onto the page: undoing
    // to it must not try to delete the pinned block (the server refuses with
    // BLOCK_PINNED and the convergence would strand half-applied) — AND the
    // reorder that follows must still list it, because the server rejects an
    // order whose id set differs from the page's (INVALID_BLOCK_ORDER).
    const A = block("A", "about", { text: "one" });
    const { result, rerender } = renderHistory([A]);

    const T = block("T", "track_record", {});
    const B = block("B", "links", { links: [] });
    rerender({ blocks: [A, T, B] });
    expect(result.current.canUndo).toBe(true);

    // The server's rules, in the mock: a delete of a pinned kind is refused,
    // and a reorder must name exactly the live set. Live = {A, T, B} minus
    // whatever this convergence deletes.
    const live = new Set(["A", "T", "B"]);
    mutateAsyncMock.mockImplementation((input: { blockAction: BlockAction }) => {
      const a = input.blockAction;
      if (a.action === "delete") {
        if (a.blockId === "T") return Promise.reject(new Error("BLOCK_PINNED"));
        live.delete(a.blockId as string);
      }
      if (a.action === "reorder") {
        const ids = a.orderedBlockIds as string[];
        const same =
          ids.length === live.size && ids.every((id) => live.has(id));
        if (!same) return Promise.reject(new Error("INVALID_BLOCK_ORDER"));
      }
      return Promise.resolve(undefined);
    });

    await act(async () => {
      result.current.undo();
      await flush();
    });

    const sent = actions();
    // B (ordinary) is deleted to reach the snapshot; T (pinned) is not.
    expect(sent).toContainEqual(
      expect.objectContaining({ action: "delete", blockId: "B" }),
    );
    expect(sent).not.toContainEqual(
      expect.objectContaining({ action: "delete", blockId: "T" }),
    );
    // The reorder names A and T — T spliced back in at its live index.
    expect(sent).toContainEqual(
      expect.objectContaining({ action: "reorder", orderedBlockIds: ["A", "T"] }),
    );
    // Nothing was refused, so no "partly applied" toast.
    expect(dangerMock).not.toHaveBeenCalled();
  });

  it("drops the visibility half of a pinned diff but still applies its data", async () => {
    const T1 = block("T", "track_record", { heading: "one" }, true);
    const { result, rerender } = renderHistory([T1]);

    // A later state where the pinned block is hidden AND re-headed. Undo
    // converges back to visible + "one"; redo converges forward to hidden +
    // "two" — the visibility flip must be dropped in both directions, the
    // data edit kept.
    const T2 = block("T", "track_record", { heading: "two" }, false);
    rerender({ blocks: [T2] });

    await act(async () => {
      result.current.redo();
      result.current.undo();
      await flush();
    });

    const edits = actions().filter((a) => a.action === "edit");
    expect(edits.length).toBeGreaterThan(0);
    for (const edit of edits) {
      expect(edit).not.toHaveProperty("visible");
      expect(edit).toHaveProperty("data");
    }
  });
});

describe("useBlockHistory — derived-overlay strip (core regression)", () => {
  it("does NOT write a derived block when an unrelated block is undone", async () => {
    const derivedV1 = block("D", "shows", {
      heading: "Tour",
      dataSource: "shows",
      events: [{ id: "e1" }],
    });
    const plainV1 = block("P", "about", { text: "one" });
    const { result, rerender } = renderHistory([derivedV1, plainV1]);

    // Edit the plain block. The derived overlay ALSO drifts (a fresh read pulled
    // a new events array) even though nothing about the derived block was
    // authored — this is exactly what previously produced a spurious edit.
    const derivedV2 = block("D", "shows", {
      heading: "Tour",
      dataSource: "shows",
      events: [{ id: "e1" }, { id: "e2" }],
    });
    const plainV2 = block("P", "about", { text: "two" });
    rerender({ blocks: [derivedV2, plainV2] });
    expect(result.current.canUndo).toBe(true);

    await act(async () => {
      result.current.undo();
      await flush();
    });

    // The unrelated plain block is reverted...
    expect(actions()).toContainEqual(
      expect.objectContaining({ action: "edit", blockId: "P" }),
    );
    // ...and the derived block is NEVER touched.
    expect(actions().some((a) => a.blockId === "D")).toBe(false);
  });

  it("undo-of-delete recreates a derived block with authored data only", async () => {
    const derived = block("D", "shows", {
      heading: "Tour",
      dataSource: "shows",
      events: [{ id: "e1" }],
    });
    const plain = block("P", "about", { text: "one" });
    const { result, rerender } = renderHistory([derived, plain]);

    // Delete the derived block.
    rerender({ blocks: [plain] });

    mutateAsyncMock.mockResolvedValue({ block: { id: "D2" } });
    await act(async () => {
      result.current.undo();
      await flush();
    });

    const addCall = actions().find((a) => a.action === "add");
    expect(addCall).toBeDefined();
    // Only the authored heading is re-persisted — never the derived overlay.
    expect(addCall?.data).toEqual({ heading: "Tour" });
    expect(addCall?.data).not.toHaveProperty("events");
    expect(addCall?.data).not.toHaveProperty("dataSource");
  });
});

describe("useBlockHistory — full → edit-only truncation", () => {
  it("drops stranded structural history when the editor falls to edit-only", async () => {
    const A = block("A", "about", {});
    const B = block("B", "links", {});
    const { result, rerender } = renderHistory([A, B]);

    // Structural change in the full editor (reorder).
    rerender({ blocks: [B, A], mode: "full" });
    expect(result.current.canUndo).toBe(true);

    // The entityPageEditor gate flips off mid-session → edit-only. Undoing the
    // reorder would half-apply (its `reorder` replay is now FORBIDDEN), so the
    // stack is truncated to the current server state.
    rerender({ blocks: [B, A], mode: "edit-only" });
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);

    // Undo is inert — no mutations are issued.
    await act(async () => {
      result.current.undo();
      await flush();
    });
    expect(actions()).toHaveLength(0);

    // A subsequent content edit in edit-only IS undoable, and its convergence
    // uses only the always-allowed `edit` action.
    rerender({
      blocks: [block("B", "links", { heading: "z" }), A],
      mode: "edit-only",
    });
    expect(result.current.canUndo).toBe(true);
    await act(async () => {
      result.current.undo();
      await flush();
    });
    expect(actions()).toEqual([
      expect.objectContaining({ action: "edit", blockId: "B", data: {} }),
    ]);
  });
});

describe("useBlockHistory — partial-apply failure", () => {
  it("surfaces an honest partial-apply message when convergence fails mid-sequence", async () => {
    const A = block("A", "about", { heading: "x" });
    const B = block("B", "links", {});
    const { result, rerender } = renderHistory([A]);

    rerender({ blocks: [A, B] });

    // The delete of B fails partway through the sequence.
    mutateAsyncMock.mockRejectedValue(new Error("boom"));
    await act(async () => {
      result.current.undo();
      await flush();
    });

    expect(dangerMock).toHaveBeenCalledTimes(1);
    expect(dangerMock.mock.calls[0]![0]).toMatchObject({
      title: "admin.peUndoPartial",
      message: "admin.peHistoryPartialBody",
    });
    // Server truth is re-synced.
    expect(invalidateMock).toHaveBeenCalled();
  });
});
