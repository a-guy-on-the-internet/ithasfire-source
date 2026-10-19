import { describe, expect, it } from "vitest";

import { truncateId, truncateProviderId } from "../format";

/**
 * `truncateProviderId` exists because `truncateId` head-truncates.
 *
 * Stripe ids are roughly time-ordered, so events that fail near each other
 * share a long prefix — three real webhook-DLQ rows captured minutes apart all
 * rendered as `evt_1U1s...`, indistinguishable on the page an operator uses
 * mid-incident. These are those exact ids.
 *
 * This file exists because the only other assertion touching this behaviour
 * (`platform/webhook-dlq/_components/__tests__/DlqMobileCard.test.tsx`)
 * `vi.mock`s `@/lib/format` and re-implements the function, so it would stay
 * green through any regression in the real one.
 */

// Captured from a live Stripe test account during webhook-DLQ QA.
const REAL_COLLIDING_IDS = [
  "evt_1U1sWHPGkPy72rZv8YHYiMRp",
  "evt_1U1sgUAMKOZUzFCjyPLuV4v5",
  "evt_1U1sfYAMKOZUzFCjmI2Vb3uH",
];

describe("truncateProviderId", () => {
  it("keeps time-ordered ids distinguishable where truncateId does not", () => {
    // The regression that motivated the helper: all three collapse to one
    // string under the head-only helper.
    expect(new Set(REAL_COLLIDING_IDS.map(truncateId)).size).toBe(1);
    expect(new Set(REAL_COLLIDING_IDS.map(truncateProviderId)).size).toBe(3);
  });

  it("keeps both ends", () => {
    expect(truncateProviderId("evt_1U1sWHPGkPy72rZv8YHYiMRp")).toBe(
      "evt_1U1sWH…YiMRp",
    );
  });

  it("passes short ids through untouched", () => {
    // Seed/dev ids and anything already short enough to read in full.
    expect(truncateProviderId("pi_123")).toBe("pi_123");
    expect(truncateProviderId("")).toBe("");
  });

  it("truncates at the documented boundary and not before", () => {
    // 16 is passthrough: head+ellipsis+tail is also 16, so truncating would
    // lose information for free. 17 is the first length that actually saves.
    const at16 = "a".repeat(16);
    const at17 = "a".repeat(17);
    expect(truncateProviderId(at16)).toBe(at16);
    expect(truncateProviderId(at17)).not.toBe(at17);
    expect(truncateProviderId(at17)).toHaveLength(16);
  });

  it("never returns more characters than it was given", () => {
    // Guards the boundary from the other side: an off-by-one in the cutoff
    // would make the "truncated" form longer than the original.
    for (const len of [0, 1, 8, 15, 16, 17, 18, 24, 30, 64]) {
      const id = "x".repeat(len);
      expect(truncateProviderId(id).length).toBeLessThanOrEqual(
        Math.max(id.length, 0),
      );
    }
  });

  it("handles every provider id shape we render", () => {
    // Each keeps discriminating characters past the type prefix.
    const shapes = [
      "acct_1U0QrRPGkPy72rZv",
      "pi_3U1sWHPGkPy72rZv0abc1234",
      "ch_3U1sWHPGkPy72rZv0def5678",
      "re_1U1sWHPGkPy72rZv9ghi",
      "tr_1U1sWHPGkPy72rZv9jkl",
      "in_1U1sWHPGkPy72rZv9mno",
    ];
    for (const id of shapes) {
      const out = truncateProviderId(id);
      expect(out.startsWith(id.slice(0, 10))).toBe(true);
      expect(out.endsWith(id.slice(-5))).toBe(true);
    }
    expect(new Set(shapes.map(truncateProviderId)).size).toBe(shapes.length);
  });
});
