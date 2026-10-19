import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useColumnVisibility } from "../useColumnVisibility";

// ── localStorage mock ─────────────────────────────────────────────────────

const storage = new Map<string, string>();

beforeEach(() => {
  storage.clear();
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(
    (key) => storage.get(key) ?? null,
  );
  vi.spyOn(Storage.prototype, "setItem").mockImplementation((key, val) => {
    storage.set(key, val);
  });
});

const KEY = "test-columns";
const ALL_IDS = ["a", "b", "c", "d"] as const;

describe("useColumnVisibility", () => {
  it("starts with all columns visible when no saved state", () => {
    const { result } = renderHook(() => useColumnVisibility(KEY, ALL_IDS));

    expect(result.current.hasHidden).toBe(false);
    expect(result.current.visibleColumnIds).toEqual(["a", "b", "c", "d"]);
    ALL_IDS.forEach((id) => {
      expect(result.current.isVisible(id)).toBe(true);
    });
  });

  it("respects defaultHidden on first visit", () => {
    const { result } = renderHook(() =>
      useColumnVisibility(KEY, ALL_IDS, ["b", "d"]),
    );

    expect(result.current.hasHidden).toBe(true);
    expect(result.current.isVisible("a")).toBe(true);
    expect(result.current.isVisible("b")).toBe(false);
    expect(result.current.isVisible("c")).toBe(true);
    expect(result.current.isVisible("d")).toBe(false);
    expect(result.current.visibleColumnIds).toEqual(["a", "c"]);
  });

  it("toggleColumn hides then re-shows a column", () => {
    const { result } = renderHook(() => useColumnVisibility(KEY, ALL_IDS));

    // Hide column "b"
    act(() => result.current.toggleColumn("b"));
    expect(result.current.isVisible("b")).toBe(false);
    expect(result.current.hasHidden).toBe(true);
    expect(result.current.visibleColumnIds).toEqual(["a", "c", "d"]);

    // Re-show column "b"
    act(() => result.current.toggleColumn("b"));
    expect(result.current.isVisible("b")).toBe(true);
    expect(result.current.visibleColumnIds).toEqual(["a", "b", "c", "d"]);
  });

  it("prevents hiding ALL columns (keeps at least one)", () => {
    const { result } = renderHook(() => useColumnVisibility(KEY, ALL_IDS));

    // Hide three of four
    act(() => result.current.toggleColumn("a"));
    act(() => result.current.toggleColumn("b"));
    act(() => result.current.toggleColumn("c"));
    expect(result.current.visibleColumnIds).toEqual(["d"]);

    // Attempting to hide the last one should be a no-op
    act(() => result.current.toggleColumn("d"));
    expect(result.current.visibleColumnIds).toEqual(["d"]);
    expect(result.current.isVisible("d")).toBe(true);
  });

  it("showAll resets all columns to visible", () => {
    const { result } = renderHook(() => useColumnVisibility(KEY, ALL_IDS));

    act(() => result.current.toggleColumn("a"));
    act(() => result.current.toggleColumn("c"));
    expect(result.current.hasHidden).toBe(true);

    act(() => result.current.showAll());
    expect(result.current.hasHidden).toBe(false);
    expect(result.current.visibleColumnIds).toEqual(["a", "b", "c", "d"]);
  });

  it("persists to localStorage and restores on re-mount", () => {
    const { result, unmount } = renderHook(() =>
      useColumnVisibility(KEY, ALL_IDS),
    );

    act(() => result.current.toggleColumn("b"));
    expect(storage.get(KEY)).toBeDefined();

    // Unmount and re-mount — should restore hidden state
    unmount();
    const { result: result2 } = renderHook(() =>
      useColumnVisibility(KEY, ALL_IDS),
    );
    expect(result2.current.isVisible("b")).toBe(false);
    expect(result2.current.visibleColumnIds).toEqual(["a", "c", "d"]);
  });

  it("gracefully handles corrupt localStorage data", () => {
    storage.set(KEY, "not valid json {{{{");
    const { result } = renderHook(() => useColumnVisibility(KEY, ALL_IDS));

    // Falls back to all visible
    expect(result.current.hasHidden).toBe(false);
    expect(result.current.visibleColumnIds).toEqual(["a", "b", "c", "d"]);
  });

  it("ignores unknown column IDs stored in localStorage", () => {
    storage.set(KEY, JSON.stringify(["b", "unknown_col"]));
    const { result } = renderHook(() => useColumnVisibility(KEY, ALL_IDS));

    // "b" stays hidden, "unknown_col" stored but doesn't affect visible list
    expect(result.current.isVisible("b")).toBe(false);
    expect(result.current.visibleColumnIds).toEqual(["a", "c", "d"]);
  });
});
