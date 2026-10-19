import { describe, expect, it } from "vitest";

import { PLATFORM_FEE_POLICY } from "@th/core/lib/pricing/platform-fee-policy";
import {
  computePlatformFeePerTicketCents,
  computeTicketPriceForAgreement,
} from "@th/core/lib/pricing/compute-ticket-price-for-agreement";

import {
  computePassThrough,
  platformFeePerTicket,
  type FeePreviewPolicy,
} from "../fee-preview-math";

/**
 * The `/platform/fees` preview duplicates core's per-ticket fee formula (see
 * the header comment on `fee-preview-math.ts` for why it cannot just call the
 * core function). This file is the drift guard for that duplicate.
 *
 * The bug it exists to prevent already shipped once: the inline copy this
 * module replaced predated `maxFeeCents` and had no cap term, so with the live
 * policy it projected 3.33% unbounded — $1.66 on a $50 ticket against a real
 * charge of 50¢.
 */

/** The live policy, in the preview module's shape. */
const LIVE: FeePreviewPolicy = {
  buyerFeePct: PLATFORM_FEE_POLICY.buyerFeePct,
  maxFeeCents: PLATFORM_FEE_POLICY.maxFeeCents ?? null,
  minFeeCents: PLATFORM_FEE_POLICY.minFeeCents ?? 0,
  platformFixedCents: PLATFORM_FEE_POLICY.platformFixedCents ?? 0,
  processorFeePct: PLATFORM_FEE_POLICY.processsorFeePct,
  processorFixedCents: PLATFORM_FEE_POLICY.processorFixedCents,
};

/**
 * Minimal single-payee agreement wrapping the live policy, so core's real
 * pricing function can be asked the same question the preview asks.
 */
function coreFeeForFace(faceCents: number): number {
  return computeTicketPriceForAgreement({
    qty: 1,
    unitPriceCents: faceCents,
    agreement: {
      id: "terms_test",
      feeMode: PLATFORM_FEE_POLICY.feeMode,
      lines: [{ id: "line_1", payeeId: "payee_1", percent: 100 }],
      policy: {
        id: "policy_test",
        version: 1,
        feeMode: PLATFORM_FEE_POLICY.feeMode,
        processsorFeePct: PLATFORM_FEE_POLICY.processsorFeePct,
        processorFixedCents: PLATFORM_FEE_POLICY.processorFixedCents,
        payoutPct: PLATFORM_FEE_POLICY.payoutPct,
        payoutFixedCents: PLATFORM_FEE_POLICY.payoutFixedCents,
        monthlyPayoutCents: PLATFORM_FEE_POLICY.monthlyPayoutCents,
        buyerFeePct: PLATFORM_FEE_POLICY.buyerFeePct,
        maxFeeCents: PLATFORM_FEE_POLICY.maxFeeCents ?? null,
        minFeeCents: PLATFORM_FEE_POLICY.minFeeCents ?? 0,
        platformFixedCents: PLATFORM_FEE_POLICY.platformFixedCents ?? 0,
      },
    },
  }).platformFeePerTicketCents;
}

/** Face values in cents: free, sub-cap, at the knee, and well past it. */
const FACE_SWEEP = [
  0, 1, 50, 100, 250, 500, 1000, 1450, 1487, 1500, 2000, 2500, 4000, 5000,
  7500, 10_000, 15_000, 20_000, 25_000, 100_000,
];

describe("fee-preview-math", () => {
  it("guards a vacuous sweep", () => {
    expect(FACE_SWEEP.length).toBeGreaterThan(10);
  });

  it("agrees with core's real per-ticket fee at every face value", () => {
    const disagreements = FACE_SWEEP.filter(
      (face) => platformFeePerTicket(face, LIVE) !== coreFeeForFace(face),
    ).map(
      (face) =>
        `face ${face}: preview ${platformFeePerTicket(face, LIVE)} vs core ${coreFeeForFace(face)}`,
    );

    expect(
      disagreements,
      "the /platform/fees preview has drifted from computeTicketPriceForAgreement",
    ).toEqual([]);
  });

  it("applies the per-ticket cap once it binds", () => {
    // Documented in platform-fee-policy.ts: the 50c cap binds from ~$14.87 up.
    expect(platformFeePerTicket(500, LIVE)).toBe(17);
    expect(platformFeePerTicket(1000, LIVE)).toBe(33);
    expect(platformFeePerTicket(1500, LIVE)).toBe(50);
    expect(platformFeePerTicket(5000, LIVE)).toBe(50);
    expect(platformFeePerTicket(100_000, LIVE)).toBe(50);
  });

  it("treats a null cap as uncapped", () => {
    const uncapped: FeePreviewPolicy = { ...LIVE, maxFeeCents: null };
    expect(platformFeePerTicket(5000, uncapped)).toBe(167);
  });

  it("adds the fixed component AFTER the cap, then applies the floor", () => {
    const withFixedAndFloor: FeePreviewPolicy = {
      ...LIVE,
      maxFeeCents: 50,
      platformFixedCents: 10,
      minFeeCents: 100,
    };
    // $50: pct 167 -> capped 50 -> +10 fixed = 60 -> floored up to 100.
    expect(platformFeePerTicket(5000, withFixedAndFloor)).toBe(100);
    // $500: pct 1665 -> capped 50 -> +10 = 60 -> floored up to 100.
    expect(platformFeePerTicket(50_000, withFixedAndFloor)).toBe(100);
  });

  it("pass-through leaves the organiser whole and charges the buyer on top", () => {
    const preview = computePassThrough(5000, LIVE);
    expect(preview.platformFee).toBe(50);
    // ceil((5000 + 50) * 0.029 + 30) = ceil(176.45) = 177
    expect(preview.processorFee).toBe(177);
    expect(preview.buyerTotal).toBe(5000 + 50 + 177);
    expect(preview.organiserNet).toBe(5000);
  });

  // Owner ruling 2026-10-10: "If $0 is the cost of the tickets there shouldn't
  // be any fee." The live policy has no fixed part and no floor, so the sweep
  // above cannot tell whether this mirror holds the rule: at a $0 face the old
  // formula gave 0 there too. These policies can.
  describe("a $0 ticket carries no fee", () => {
    const POLICIES: Array<[string, FeePreviewPolicy]> = [
      ["a fixed part", { ...LIVE, platformFixedCents: 50 }],
      ["a floor", { ...LIVE, minFeeCents: 50 }],
      [
        "a fixed part and a floor",
        { ...LIVE, maxFeeCents: null, platformFixedCents: 30, minFeeCents: 100 },
      ],
    ];

    it.each(POLICIES)("with %s: no platform fee at a $0 face", (_name, policy) => {
      expect(platformFeePerTicket(0, policy)).toBe(0);
    });

    it.each(POLICIES)("with %s: agrees with core at every face value", (_name, policy) => {
      const disagreements = FACE_SWEEP.filter(
        (face) =>
          platformFeePerTicket(face, policy) !==
          computePlatformFeePerTicketCents(face, policy),
      ).map(
        (face) =>
          `face ${face}: preview ${platformFeePerTicket(face, policy)} vs core ${computePlatformFeePerTicketCents(face, policy)}`,
      );

      expect(disagreements).toEqual([]);
      // A paid ticket still pays the fixed part / floor: the rule is for $0.
      expect(platformFeePerTicket(1, policy)).toBeGreaterThan(0);
    });

    it.each(POLICIES)("with %s: the pass-through preview of a $0 ticket is all zero", (_name, policy) => {
      expect(computePassThrough(0, policy)).toEqual({
        platformFee: 0,
        processorFee: 0,
        buyerTotal: 0,
        organiserNet: 0,
      });
    });
  });
});
