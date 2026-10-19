import { describe, it, expect } from "vitest";

import { AppError, fail, isAppError } from "../index";

describe("AppError", () => {
  it("sets code, name, and message", () => {
    const err = new AppError("EVENT_NOT_FOUND", { message: "nope" });
    expect(err.code).toBe("EVENT_NOT_FOUND");
    expect(err.name).toBe("AppError");
    expect(err.message).toBe("nope");
    expect(err).toBeInstanceOf(Error);
  });

  it("defaults message to the code", () => {
    const err = new AppError("FORBIDDEN");
    expect(err.message).toBe("FORBIDDEN");
  });

  it("carries an arbitrary meta object", () => {
    const err = new AppError("QUOTA_EXCEEDED", {
      meta: { kind: "events", limitValue: 5, currentUsage: 5 },
    });
    expect(err.meta).toEqual({
      kind: "events",
      limitValue: 5,
      currentUsage: 5,
    });
  });

  it("preserves the cause", () => {
    const cause = new Error("underlying");
    const err = new AppError("TRANSIENT", { cause });
    expect(err.cause).toBe(cause);
  });

  it("carries an optional transport-category hint", () => {
    const err = new AppError("INVALID_STATUS", { category: "CONFLICT" });
    expect(err.category).toBe("CONFLICT");
    const plain = new AppError("NOT_FOUND");
    expect(plain.category).toBeUndefined();
  });
});

describe("fail", () => {
  it("throws an AppError with the given code", () => {
    expect(() => fail("EVENT_NOT_FOUND")).toThrow(AppError);
    try {
      fail("EVENT_NOT_FOUND");
      expect.unreachable("fail() must throw");
    } catch (err) {
      expect(isAppError(err)).toBe(true);
      expect((err as AppError).code).toBe("EVENT_NOT_FOUND");
    }
  });

  it("forwards message, meta, cause, and category", () => {
    const cause = new Error("db exploded");
    try {
      fail("QUOTA_EXCEEDED", {
        message: "quota_exceeded",
        meta: { kind: "events", limitValue: 5 },
        cause,
        category: "FORBIDDEN",
      });
      expect.unreachable("fail() must throw");
    } catch (err) {
      const e = err as AppError;
      expect(e.code).toBe("QUOTA_EXCEEDED");
      expect(e.message).toBe("quota_exceeded");
      expect(e.meta).toEqual({ kind: "events", limitValue: 5 });
      expect(e.cause).toBe(cause);
      expect(e.category).toBe("FORBIDDEN");
    }
  });
});

describe("isAppError", () => {
  it("returns true for an AppError", () => {
    expect(isAppError(new AppError("NOT_FOUND"))).toBe(true);
  });

  it("returns false for a plain Error", () => {
    expect(isAppError(new Error("nope"))).toBe(false);
  });

  it("returns false for a code-shaped object", () => {
    expect(isAppError({ code: "NOT_FOUND" })).toBe(false);
  });

  it("returns false for null", () => {
    expect(isAppError(null)).toBe(false);
  });
});
