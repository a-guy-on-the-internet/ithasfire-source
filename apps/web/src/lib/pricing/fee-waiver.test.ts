import { describe, expect, it } from "vitest";

import { feeWaivedCentsFor, platformFeeWaivedCents } from "./fee-waiver";

describe("platformFeeWaivedCents", () => {
  it("sums each line's stamped waiver", () => {
    expect(
      platformFeeWaivedCents([
        { meta: { platformFeeWaivedCents: 50 } },
        { meta: { platformFeeWaivedCents: 30 } },
        { meta: {} },
      ]),
    ).toBe(80);
  });

  it("ignores missing / malformed meta and no items", () => {
    expect(
      platformFeeWaivedCents([
        { meta: null },
        {},
        { meta: { platformFeeWaivedCents: "50" } },
        { meta: { platformFeeWaivedCents: -5 } },
      ]),
    ).toBe(0);
    expect(platformFeeWaivedCents(undefined)).toBe(0);
  });
});

describe("feeWaivedCentsFor — whose figure explains the fee", () => {
  const heldLines = [{ meta: { platformFeeWaivedCents: 50 } }, { meta: {} }];

  it("held (no createCheckout figure yet) → the held lines", () => {
    expect(feeWaivedCentsFor({ items: heldLines })).toBe(50);
  });

  it("regression: another buyer took the last allowance ticket — createCheckout says 0, the held lines say 50 → 0 (no stale caption)", () => {
    expect(feeWaivedCentsFor({ items: heldLines, feeWaivedCents: 0 })).toBe(0);
  });

  it("createCheckout's figure wins either way; no order → 0", () => {
    expect(feeWaivedCentsFor({ items: [], feeWaivedCents: 30 })).toBe(30);
    expect(feeWaivedCentsFor(null)).toBe(0);
  });
});

