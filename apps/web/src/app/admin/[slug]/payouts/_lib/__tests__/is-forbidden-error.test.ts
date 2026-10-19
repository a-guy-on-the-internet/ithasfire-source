import { describe, expect, it } from "vitest";

import { isForbiddenError } from "../is-forbidden-error";

describe("isForbiddenError", () => {
  it("is true for a tRPC FORBIDDEN (role refusal)", () => {
    expect(isForbiddenError({ data: { code: "FORBIDDEN" } })).toBe(true);
  });

  it("is false for real failures and non-errors", () => {
    expect(isForbiddenError({ data: { code: "INTERNAL_SERVER_ERROR" } })).toBe(
      false,
    );
    expect(isForbiddenError({ data: { code: "UNAUTHORIZED" } })).toBe(false);
    expect(isForbiddenError({ data: null })).toBe(false);
    expect(isForbiddenError(new Error("boom"))).toBe(false);
    expect(isForbiddenError(null)).toBe(false);
    expect(isForbiddenError(undefined)).toBe(false);
  });
});
