import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useTableDensity } from "../useTableDensity";

// ── localStorage mock (mirrors useColumnVisibility.test) ──────────────────

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

const KEY = "test-density";

describe("useTableDensity", () => {
  it("defaults to comfortable when nothing is stored", () => {
    const { result } = renderHook(() => useTableDensity(KEY));
    expect(result.current.density).toBe("comfortable");
  });

  it("toggles between comfortable and compact, persisting each flip", () => {
    const { result } = renderHook(() => useTableDensity(KEY));

    act(() => result.current.toggleDensity());
    expect(result.current.density).toBe("compact");
    expect(storage.get(KEY)).toBe("compact");

    act(() => result.current.toggleDensity());
    expect(result.current.density).toBe("comfortable");
    expect(storage.get(KEY)).toBe("comfortable");
  });

  it("restores a stored density on mount", () => {
    storage.set(KEY, "compact");
    const { result } = renderHook(() => useTableDensity(KEY));
    expect(result.current.density).toBe("compact");
  });

  it("falls back to the default on corrupt stored values", () => {
    storage.set(KEY, "cozy???");
    const { result } = renderHook(() => useTableDensity(KEY));
    expect(result.current.density).toBe("comfortable");
  });

  it("respects a custom default density", () => {
    const { result } = renderHook(() => useTableDensity(KEY, "compact"));
    expect(result.current.density).toBe("compact");
  });
});
