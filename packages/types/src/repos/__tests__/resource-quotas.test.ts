import { describe, expect, it } from "vitest";
import {
  orgTrustLevelFromPayoutCount,
  isTrustScaledKind,
  TRUST_LEVEL_THRESHOLDS,
  TRUST_LEVEL_LIMITS,
  TRUST_SCALED_KINDS,
  DEFAULT_RESOURCE_LIMITS,
  QUOTA_UNLIMITED,
} from "../resource-quotas";

// ─────────────────────────────────────────────────────────────────────────────
// orgTrustLevelFromPayoutCount
// ─────────────────────────────────────────────────────────────────────────────

describe("orgTrustLevelFromPayoutCount", () => {
  it("returns 0 for zero payouts", () => {
    expect(orgTrustLevelFromPayoutCount(0)).toBe(0);
  });

  it("returns 1 at threshold boundary (1 payout)", () => {
    expect(orgTrustLevelFromPayoutCount(1)).toBe(1);
  });

  it("returns 1 for payouts between 1 and 4", () => {
    expect(orgTrustLevelFromPayoutCount(4)).toBe(1);
  });

  it("returns 2 at threshold boundary (5 payouts)", () => {
    expect(orgTrustLevelFromPayoutCount(5)).toBe(2);
  });

  it("returns 2 for payouts between 5 and 19", () => {
    expect(orgTrustLevelFromPayoutCount(19)).toBe(2);
  });

  it("returns 3 at threshold boundary (20 payouts)", () => {
    expect(orgTrustLevelFromPayoutCount(20)).toBe(3);
  });

  it("returns 3 for large payout counts", () => {
    expect(orgTrustLevelFromPayoutCount(500)).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isTrustScaledKind
// ─────────────────────────────────────────────────────────────────────────────

describe("isTrustScaledKind", () => {
  it.each([
    "EVENTS_PER_ORG",
    "MEMBERS_PER_ORG",
    "ANNOUNCEMENTS_PER_DAY",
    "STORAGE_BYTES_ORG",
  ] as const)("returns true for %s", (kind) => {
    expect(isTrustScaledKind(kind)).toBe(true);
  });

  it.each(["ORGS_OWNED", "ORGS_JOINED", "STORAGE_BYTES_HUMAN"] as const)(
    "returns false for %s",
    (kind) => {
      expect(isTrustScaledKind(kind)).toBe(false);
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// TRUST_LEVEL_LIMITS consistency checks
// ─────────────────────────────────────────────────────────────────────────────

describe("TRUST_LEVEL_LIMITS", () => {
  it("level 0 limits match DEFAULT_RESOURCE_LIMITS for all scaled kinds", () => {
    for (const kind of TRUST_SCALED_KINDS) {
      expect(TRUST_LEVEL_LIMITS[0][kind]).toBe(DEFAULT_RESOURCE_LIMITS[kind]);
    }
  });

  it("limits increase monotonically across trust levels for all scaled kinds", () => {
    for (const kind of TRUST_SCALED_KINDS) {
      expect(TRUST_LEVEL_LIMITS[1][kind]).toBeGreaterThan(
        TRUST_LEVEL_LIMITS[0][kind],
      );
      expect(TRUST_LEVEL_LIMITS[2][kind]).toBeGreaterThanOrEqual(
        TRUST_LEVEL_LIMITS[1][kind],
      );
      expect(TRUST_LEVEL_LIMITS[3][kind]).toBeGreaterThanOrEqual(
        TRUST_LEVEL_LIMITS[2][kind],
      );
    }
  });

  it("EVENTS_PER_ORG is QUOTA_UNLIMITED at trust levels 2 and 3", () => {
    expect(TRUST_LEVEL_LIMITS[2].EVENTS_PER_ORG).toBe(QUOTA_UNLIMITED);
    expect(TRUST_LEVEL_LIMITS[3].EVENTS_PER_ORG).toBe(QUOTA_UNLIMITED);
  });

  it("STORAGE_BYTES_ORG scales across all trust levels", () => {
    expect(TRUST_LEVEL_LIMITS[0].STORAGE_BYTES_ORG).toBe(1_073_741_824n); // 1 GiB
    expect(TRUST_LEVEL_LIMITS[1].STORAGE_BYTES_ORG).toBe(5_368_709_120n); // 5 GiB
    expect(TRUST_LEVEL_LIMITS[2].STORAGE_BYTES_ORG).toBe(21_474_836_480n); // 20 GiB
    expect(TRUST_LEVEL_LIMITS[3].STORAGE_BYTES_ORG).toBe(107_374_182_400n); // 100 GiB
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TRUST_LEVEL_THRESHOLDS consistency
// ─────────────────────────────────────────────────────────────────────────────

describe("TRUST_LEVEL_THRESHOLDS", () => {
  it("thresholds increase strictly", () => {
    expect(TRUST_LEVEL_THRESHOLDS[0]).toBeLessThan(TRUST_LEVEL_THRESHOLDS[1]);
    expect(TRUST_LEVEL_THRESHOLDS[1]).toBeLessThan(TRUST_LEVEL_THRESHOLDS[2]);
    expect(TRUST_LEVEL_THRESHOLDS[2]).toBeLessThan(TRUST_LEVEL_THRESHOLDS[3]);
  });

  it("level 0 starts at zero", () => {
    expect(TRUST_LEVEL_THRESHOLDS[0]).toBe(0);
  });
});
