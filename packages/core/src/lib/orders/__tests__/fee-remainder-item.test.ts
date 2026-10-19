import { describe, expect, it } from "vitest";

import { feeRemainderItemIndex } from "../fee-remainder-item";

/**
 * The ticket that takes a fee spread's rounding remainder: the last PAID one,
 * so a $0 ticket never picks up a cent of a fee it owes none of (owner ruling
 * 2026-10-10).
 */
describe("feeRemainderItemIndex", () => {
  it("is the last ticket when every ticket is paid (the behaviour before the ruling)", () => {
    expect(feeRemainderItemIndex([3000])).toBe(0);
    expect(feeRemainderItemIndex([3000, 500, 2500])).toBe(2);
  });

  it("skips $0 tickets at the end of the cart", () => {
    expect(feeRemainderItemIndex([3000, 500, 0])).toBe(1);
    expect(feeRemainderItemIndex([3000, 0, 0, 0])).toBe(0);
  });

  it("is still the last paid ticket when $0 tickets come first or in between", () => {
    expect(feeRemainderItemIndex([0, 3000])).toBe(1);
    expect(feeRemainderItemIndex([3000, 0, 500, 0])).toBe(2);
  });

  it("treats a missing price as $0", () => {
    expect(feeRemainderItemIndex([3000, undefined, null])).toBe(0);
  });

  it("falls back to the last ticket when none is paid, so a spread still sums", () => {
    expect(feeRemainderItemIndex([0, 0, 0])).toBe(2);
  });

  it("is -1 for an empty cart", () => {
    expect(feeRemainderItemIndex([])).toBe(-1);
  });
});
