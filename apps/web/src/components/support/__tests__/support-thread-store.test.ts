import { describe, it, expect, beforeEach, vi } from "vitest";

import {
  getStoredThreadId,
  setStoredThreadId,
  clearStoredThreadId,
} from "../support-thread-store";

const storage = new Map<string, string>();

beforeEach(() => {
  storage.clear();
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(
    (key) => storage.get(key) ?? null,
  );
  vi.spyOn(Storage.prototype, "setItem").mockImplementation((key, val) => {
    storage.set(key, val);
  });
  vi.spyOn(Storage.prototype, "removeItem").mockImplementation((key) => {
    storage.delete(key);
  });
});

describe("support-thread-store", () => {
  it("returns null when no thread is stored for the account", () => {
    expect(getStoredThreadId("human-1")).toBeNull();
  });

  it("returns null for a missing/empty human id", () => {
    expect(getStoredThreadId(null)).toBeNull();
    expect(getStoredThreadId(undefined)).toBeNull();
    expect(getStoredThreadId("")).toBeNull();
  });

  it("round-trips a thread id for a given account", () => {
    setStoredThreadId("human-1", "thread-abc");
    expect(getStoredThreadId("human-1")).toBe("thread-abc");
  });

  it("namespaces the pointer per account so it does not leak across sign-ins", () => {
    setStoredThreadId("human-1", "thread-abc");
    expect(getStoredThreadId("human-2")).toBeNull();
  });

  it("clears a stored pointer", () => {
    setStoredThreadId("human-1", "thread-abc");
    clearStoredThreadId("human-1");
    expect(getStoredThreadId("human-1")).toBeNull();
  });

  it("never throws if localStorage is unavailable", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(() => setStoredThreadId("human-1", "thread-abc")).not.toThrow();
  });
});
