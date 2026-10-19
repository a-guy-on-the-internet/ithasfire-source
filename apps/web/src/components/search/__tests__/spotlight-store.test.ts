import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  closeSpotlight,
  getContextQuery,
  openSpotlight,
  setContextQuery,
  useContextQuery,
  useSpotlightSnapshot,
} from "../spotlight-store";

/**
 * Each search context remembers its own last query: the navbar and home
 * search rows render it as their resting label, and Spotlight reopens with
 * it. These pin the store-level contract those readers depend on: it
 * survives an open/close cycle, a newer search replaces it, it clears on an
 * empty string, the contexts never bleed into each other, and the snapshot
 * reference only changes when a value actually does.
 */

function resetStore() {
  closeSpotlight();
  setContextQuery("consumer", "");
  setContextQuery("admin", "");
  setContextQuery("platform", "");
}

describe("per-context query via useContextQuery", () => {
  beforeEach(resetStore);

  it("starts empty", () => {
    const { result } = renderHook(() => useContextQuery("consumer"));
    expect(result.current).toBe("");
  });

  it("reflects setContextQuery", () => {
    const { result } = renderHook(() => useContextQuery("consumer"));
    act(() => setContextQuery("consumer", "jazz festival"));
    expect(result.current).toBe("jazz festival");
    expect(getContextQuery("consumer")).toBe("jazz festival");
  });

  it("survives an open/close cycle", () => {
    const { result } = renderHook(() => useContextQuery("consumer"));
    act(() => openSpotlight());
    act(() => setContextQuery("consumer", "jazz festival"));
    act(() => closeSpotlight());
    expect(result.current).toBe("jazz festival");
  });

  it("is replaced when the user searches again", () => {
    const { result } = renderHook(() => useContextQuery("consumer"));
    act(() => setContextQuery("consumer", "jazz"));
    act(() => setContextQuery("consumer", "electronic"));
    expect(result.current).toBe("electronic");
  });

  it("can be cleared to an empty string", () => {
    const { result } = renderHook(() => useContextQuery("consumer"));
    act(() => setContextQuery("consumer", "jazz"));
    act(() => setContextQuery("consumer", ""));
    expect(result.current).toBe("");
  });

  it("keeps each context's query to itself", () => {
    const consumer = renderHook(() => useContextQuery("consumer"));
    const admin = renderHook(() => useContextQuery("admin"));
    const platform = renderHook(() => useContextQuery("platform"));
    act(() => setContextQuery("admin", "ORD-4F2A refund"));
    expect(admin.result.current).toBe("ORD-4F2A refund");
    expect(consumer.result.current).toBe("");
    expect(platform.result.current).toBe("");
  });

  it("changes the snapshot reference when a query changes", () => {
    const { result } = renderHook(() => useSpotlightSnapshot());
    const before = result.current;
    act(() => setContextQuery("consumer", "jazz"));
    expect(result.current).not.toBe(before);
    expect(result.current.consumerQuery).toBe("jazz");
  });

  it("keeps the snapshot reference for an identical query", () => {
    const { result } = renderHook(() => useSpotlightSnapshot());
    act(() => setContextQuery("consumer", "jazz"));
    const before = result.current;
    act(() => setContextQuery("consumer", "jazz"));
    expect(result.current).toBe(before);
  });
});
