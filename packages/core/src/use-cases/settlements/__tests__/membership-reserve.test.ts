import { describe, expect, it } from "vitest";

import {
  MEMBERSHIP_RESERVE_TUNING,
  computeMembershipReserve,
  computeReserveHoldCents,
  isReserveReleaseFrozen,
  type MembershipReserveDecision,
} from "../membership-reserve";

const NOW = new Date("2026-08-11T06:00:00Z");

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);
}

function decide(
  overrides: Partial<{
    standing: {
      reserveBps: number;
      reserveReleaseDays: number;
      overriddenBy: string | null;
    } | null;
    latestLostDisputeAt: Date | null;
    firstMembershipPayoutAt: Date | null;
    firstTicketingPayoutAt: Date | null;
  }> = {},
): MembershipReserveDecision {
  return computeMembershipReserve({
    now: NOW,
    standing: overrides.standing ?? null,
    latestLostDisputeAt: overrides.latestLostDisputeAt ?? null,
    firstMembershipPayoutAt: overrides.firstMembershipPayoutAt ?? null,
    firstTicketingPayoutAt: overrides.firstTicketingPayoutAt ?? null,
  });
}

describe("computeMembershipReserve", () => {
  // ── Table-driven bracket coverage ─────────────────────────────────────────
  const cases: Array<{
    name: string;
    input: Parameters<typeof decide>[0];
    expected: MembershipReserveDecision;
  }> = [
    {
      name: "brand-new payee (no history at all) → 1000 bps, basis new",
      input: {},
      expected: { reserveBps: 1000, releaseDays: 90, basis: "new" },
    },
    {
      name: "first membership payout 89 days ago → still the new bracket",
      input: { firstMembershipPayoutAt: daysAgo(89) },
      expected: { reserveBps: 1000, releaseDays: 90, basis: "new" },
    },
    {
      name: "first membership payout exactly 90 days ago → seasoning (500)",
      input: { firstMembershipPayoutAt: daysAgo(90) },
      expected: { reserveBps: 500, releaseDays: 90, basis: "seasoning" },
    },
    {
      name: "first membership payout exactly 180 days ago → still seasoning",
      input: { firstMembershipPayoutAt: daysAgo(180) },
      expected: { reserveBps: 500, releaseDays: 90, basis: "seasoning" },
    },
    {
      name: "first membership payout 181 days ago → seasoned (0)",
      input: { firstMembershipPayoutAt: daysAgo(181) },
      expected: { reserveBps: 0, releaseDays: 90, basis: "seasoned" },
    },
    {
      name: "ticketing head start: established ticketing halves the new bracket",
      input: { firstTicketingPayoutAt: daysAgo(90) },
      expected: { reserveBps: 500, releaseDays: 90, basis: "new" },
    },
    {
      name: "ticketing history only 89 days old does NOT count as established",
      input: { firstTicketingPayoutAt: daysAgo(89) },
      expected: { reserveBps: 1000, releaseDays: 90, basis: "new" },
    },
    {
      name: "ticketing head start applies only to the FIRST bracket (seasoning unaffected)",
      input: {
        firstMembershipPayoutAt: daysAgo(120),
        firstTicketingPayoutAt: daysAgo(400),
      },
      expected: { reserveBps: 500, releaseDays: 90, basis: "seasoning" },
    },
    {
      name: "seasoned payee stays at 0 regardless of ticketing history",
      input: {
        firstMembershipPayoutAt: daysAgo(365),
        firstTicketingPayoutAt: daysAgo(30),
      },
      expected: { reserveBps: 0, releaseDays: 90, basis: "seasoned" },
    },
    {
      name: "lost dispute 30 days ago resets a seasoned payee to 1000",
      input: {
        firstMembershipPayoutAt: daysAgo(365),
        latestLostDisputeAt: daysAgo(30),
      },
      expected: { reserveBps: 1000, releaseDays: 90, basis: "lost_dispute" },
    },
    {
      name: "lost dispute exactly 180 days ago is still inside the window",
      input: {
        firstMembershipPayoutAt: daysAgo(365),
        latestLostDisputeAt: daysAgo(180),
      },
      expected: { reserveBps: 1000, releaseDays: 90, basis: "lost_dispute" },
    },
    {
      name: "lost dispute 181 days ago has aged out — track record resumes",
      input: {
        firstMembershipPayoutAt: daysAgo(365),
        latestLostDisputeAt: daysAgo(181),
      },
      expected: { reserveBps: 0, releaseDays: 90, basis: "seasoned" },
    },
    {
      // The dev-DB demo org's shape: an admin pinned 500 bps / 90 days.
      name: "manual override is used verbatim (demo-org 500bps shape)",
      input: {
        standing: { reserveBps: 500, reserveReleaseDays: 90, overriddenBy: "admin-1" },
        firstMembershipPayoutAt: daysAgo(365),
      },
      expected: { reserveBps: 500, releaseDays: 90, basis: "manual" },
    },
    {
      name: "manual override beats a recent lost dispute",
      input: {
        standing: { reserveBps: 0, reserveReleaseDays: 30, overriddenBy: "admin-1" },
        latestLostDisputeAt: daysAgo(5),
      },
      expected: { reserveBps: 0, releaseDays: 30, basis: "manual" },
    },
    {
      name: "a standing row WITHOUT overriddenBy does not pin anything",
      input: {
        standing: { reserveBps: 123, reserveReleaseDays: 45, overriddenBy: null },
        firstMembershipPayoutAt: daysAgo(365),
      },
      expected: { reserveBps: 0, releaseDays: 90, basis: "seasoned" },
    },
    {
      name: "lost dispute beats the ticketing head start",
      input: {
        firstTicketingPayoutAt: daysAgo(400),
        latestLostDisputeAt: daysAgo(10),
      },
      expected: { reserveBps: 1000, releaseDays: 90, basis: "lost_dispute" },
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(decide(c.input)).toEqual(c.expected);
    });
  }

  it("rejects malformed input (raw-input Zod boundary)", () => {
    expect(() => computeMembershipReserve({ now: NOW })).toThrow();
    expect(() =>
      computeMembershipReserve({
        now: NOW,
        standing: { reserveBps: 20_000, reserveReleaseDays: 90, overriddenBy: null },
        latestLostDisputeAt: null,
        firstMembershipPayoutAt: null,
        firstTicketingPayoutAt: null,
      }),
    ).toThrow();
  });
});

describe("isReserveReleaseFrozen", () => {
  it("freezes inside the lost-dispute window, thaws after it", () => {
    expect(isReserveReleaseFrozen(null, NOW)).toBe(false);
    expect(isReserveReleaseFrozen(daysAgo(1), NOW)).toBe(true);
    expect(isReserveReleaseFrozen(daysAgo(180), NOW)).toBe(true);
    expect(isReserveReleaseFrozen(daysAgo(181), NOW)).toBe(false);
  });
});

describe("computeReserveHoldCents", () => {
  it("floors the bps product (never rounds a cent toward the platform)", () => {
    // 3333 * 1000 / 10000 = 333.3 → 333
    expect(
      computeReserveHoldCents({
        membershipPortionCents: 3333,
        reserveBps: 1000,
        headroomCents: 100_000,
      }),
    ).toBe(333);
  });

  it("clamps to the post-debt headroom", () => {
    expect(
      computeReserveHoldCents({
        membershipPortionCents: 10_000,
        reserveBps: 1000,
        headroomCents: 50,
      }),
    ).toBe(50);
  });

  it("returns 0 for zero portion, zero bps, or non-positive headroom", () => {
    expect(
      computeReserveHoldCents({
        membershipPortionCents: 0,
        reserveBps: 1000,
        headroomCents: 100,
      }),
    ).toBe(0);
    expect(
      computeReserveHoldCents({
        membershipPortionCents: 100,
        reserveBps: 0,
        headroomCents: 100,
      }),
    ).toBe(0);
    expect(
      computeReserveHoldCents({
        membershipPortionCents: 100,
        reserveBps: 1000,
        headroomCents: 0,
      }),
    ).toBe(0);
  });

  it("tuning sanity: constants keep their spec'd relationships", () => {
    const T = MEMBERSHIP_RESERVE_TUNING;
    expect(T.ESTABLISHED_TICKETING_STARTER_BPS).toBeLessThan(
      T.NEW_PAYEE_RESERVE_BPS,
    );
    expect(T.SEASONED_RESERVE_BPS).toBe(0);
    expect(T.LOST_DISPUTE_RESERVE_BPS).toBe(T.NEW_PAYEE_RESERVE_BPS);
    expect(T.SEASONING_STARTS_AT_DAYS).toBeLessThan(T.SEASONED_AFTER_DAYS);
  });
});
