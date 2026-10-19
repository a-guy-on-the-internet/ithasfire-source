import { describe, expect, it } from "vitest";

import { keepsCheckoutClientKey } from "../checkout-client-key";

describe("keepsCheckoutClientKey", () => {
  it("keeps the key while the first attempt still holds the lock", () => {
    expect(
      keepsCheckoutClientKey({
        message: "IDEMPOTENCY_LOCK_IN_PROGRESS",
        data: { appCode: "IDEMPOTENCY_LOCK_IN_PROGRESS" },
      }),
    ).toBe(true);
    // The message alone (no structured data) is the same code.
    expect(
      keepsCheckoutClientKey(new Error("IDEMPOTENCY_LOCK_IN_PROGRESS")),
    ).toBe(true);
  });

  it.each([
    ["a network error", new TypeError("Failed to fetch")],
    ["a gateway error with no app code", { message: "Bad Gateway" }],
    ["nothing at all", undefined],
    // A code this build does not know reads as no code. Keeping the key is
    // safe: a server refusal has already released it, so the retry runs fresh.
    ["an unregistered code", { data: { appCode: "NOT_A_REAL_CODE" } }],
  ])("keeps the key after %s: the server may have committed", (_label, error) => {
    expect(keepsCheckoutClientKey(error)).toBe(true);
  });

  it.each([
    ["a lost order link", { data: { appCode: "ORDER_NOT_PENDING" } }],
    ["a sold-out refusal", new Error("INSUFFICIENT_CAPACITY")],
    ["a key conflict", { data: { appCode: "IDEMPOTENCY_KEY_CONFLICT" } }],
  ])("rotates the key after %s", (_label, error) => {
    expect(keepsCheckoutClientKey(error)).toBe(false);
  });
});
