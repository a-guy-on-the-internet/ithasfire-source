import { describe, expect, it, vi } from "vitest";

import type { MembershipTierRecord } from "@th/types/repos/membership-tiers";

import {
  RECURRING_REVENUE_STATEMENT_TIMEOUT_MS,
  summariseRecurringRevenue,
  type SummariseRecurringRevenueDeps,
} from "../summarise-recurring-revenue";

const ACTOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function tier(overrides: Partial<MembershipTierRecord> = {}): MembershipTierRecord {
  return {
    id: "tier-monthly",
    ownerOrgId: "org-1",
    ownerHumanId: null,
    name: "Sustaining Member",
    description: null,
    benefitsDescription: null,
    priceCents: 1_200,
    currency: "usd",
    interval: "MONTH",
    stripeProductId: null,
    stripePriceId: null,
    status: "ACTIVE",
    sortOrder: 0,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

type Options = {
  allowed?: boolean;
  grouped?: Array<{ tierId: string; status: string; count: number }>;
  tiers?: MembershipTierRecord[];
  tiersFail?: boolean;
};

function makeDeps(options: Options = {}) {
  const hasStaffRole = vi.fn(async () => ({ allowed: options.allowed ?? true }));
  const countByTierAndStatus = vi.fn(async () => options.grouped ?? []);
  const listByIds = vi.fn(async () => {
    if (options.tiersFail) throw new Error("pg is down");
    return options.tiers ?? [];
  });
  const error = vi.fn();
  const reportError = vi.fn();

  const deps = {
    repos: {
      memberships: { countByTierAndStatus },
      membershipTiers: { listByIds },
    },
    authz: { hasStaffRole },
    logger: { error, warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
    reportError,
  } as unknown as SummariseRecurringRevenueDeps;

  return {
    deps,
    hasStaffRole,
    countByTierAndStatus,
    listByIds,
    error,
    reportError,
    run: () => summariseRecurringRevenue(deps, { actorHumanId: ACTOR }),
  };
}

describe("summariseRecurringRevenue — authz", () => {
  it("refuses a non-staff actor with STAFF_ONLY", async () => {
    const h = makeDeps({ allowed: false });
    await expect(h.run()).rejects.toMatchObject({ code: "STAFF_ONLY" });
    // And it refuses BEFORE reading anything.
    expect(h.countByTierAndStatus).not.toHaveBeenCalled();
  });

  it("checks ADMIN|SUPPORT in the use case, not at the transport", async () => {
    const h = makeDeps();
    await h.run();
    expect(h.hasStaffRole).toHaveBeenCalledWith({
      actorHumanId: ACTOR,
      requiredRoles: ["ADMIN", "SUPPORT"],
    });
  });

  it("refuses an input with unknown keys (strict)", async () => {
    const h = makeDeps();
    await expect(
      summariseRecurringRevenue(h.deps, {
        actorHumanId: ACTOR,
        ownerOrgId: "org-1",
      }),
    ).rejects.toBeTruthy();
  });
});

describe("summariseRecurringRevenue — the annual normalisation rule", () => {
  it("annualises a MONTHLY tier by twelve, exactly, before any division", async () => {
    const h = makeDeps({
      grouped: [{ tierId: "tier-monthly", status: "active", count: 4 }],
      tiers: [tier({ priceCents: 1_200 })],
    });
    const out = await h.run();
    const usd = out.ownerRevenueByCurrency[0]!;

    expect(usd.annualisedCents).toBe(1_200 * 12 * 4);
    expect(usd.monthlyCents).toBe(1_200 * 4);
    expect(usd.monthlyRemainderCents).toBe(0);
    expect(usd.annualBilledCount).toBe(0);
  });

  it("divides the CURRENCY TOTAL once, not each annual membership", async () => {
    // THE load-bearing half of the rule. $119.99/yr × 3: dividing per
    // membership floors 11999/12 = 999 three times (2,997) and throws away 3×11
    // = 33 cents. Dividing the total once throws away at most 11, ever.
    const h = makeDeps({
      grouped: [{ tierId: "tier-annual", status: "active", count: 3 }],
      tiers: [
        tier({ id: "tier-annual", interval: "YEAR", priceCents: 11_999 }),
      ],
    });
    const out = await h.run();
    const usd = out.ownerRevenueByCurrency[0]!;

    expect(usd.annualisedCents).toBe(35_997);
    // floor(35997 / 12) = 2999, NOT 3 × floor(11999/12) = 2997.
    expect(usd.monthlyCents).toBe(2_999);
    expect(usd.monthlyRemainderCents).toBe(35_997 % 12);
    expect(usd.annualBilledCount).toBe(3);
  });

  it("returns the floored remainder rather than silently dropping it", async () => {
    const h = makeDeps({
      grouped: [
        { tierId: "tier-monthly", status: "active", count: 4 },
        { tierId: "tier-annual", status: "active", count: 3 },
        { tierId: "tier-small", status: "active", count: 1 },
        { tierId: "tier-human", status: "active", count: 1 },
      ],
      tiers: [
        tier({ priceCents: 1_200 }),
        tier({ id: "tier-annual", interval: "YEAR", priceCents: 11_999 }),
        tier({ id: "tier-small", priceCents: 500 }),
        tier({ id: "tier-human", priceCents: 800 }),
      ],
    });
    const out = await h.run();
    const usd = out.ownerRevenueByCurrency[0]!;

    // 57,600 + 35,997 + 6,000 + 9,600 — the dev seed's own USD book.
    expect(usd.annualisedCents).toBe(109_197);
    expect(usd.monthlyCents).toBe(9_099);
    expect(usd.monthlyRemainderCents).toBe(9);
    // The reported monthly figure is NEVER larger than the money that exists.
    expect(usd.monthlyCents * 12).toBeLessThanOrEqual(usd.annualisedCents);
    expect(usd.monthlyCents * 12 + usd.monthlyRemainderCents).toBe(
      usd.annualisedCents,
    );
  });

  it("produces only integers — no float has touched the money", async () => {
    const h = makeDeps({
      grouped: [{ tierId: "tier-annual", status: "active", count: 7 }],
      tiers: [tier({ id: "tier-annual", interval: "YEAR", priceCents: 4_999 })],
    });
    const out = await h.run();
    const usd = out.ownerRevenueByCurrency[0]!;
    for (const value of [
      usd.annualisedCents,
      usd.monthlyCents,
      usd.monthlyRemainderCents,
    ]) {
      expect(Number.isInteger(value)).toBe(true);
    }
  });
});

describe("summariseRecurringRevenue — trialing and currencies", () => {
  it("counts trialing members but values them at nothing", async () => {
    const h = makeDeps({
      grouped: [
        { tierId: "tier-monthly", status: "active", count: 2 },
        { tierId: "tier-monthly", status: "trialing", count: 5 },
      ],
      tiers: [tier({ priceCents: 1_000 })],
    });
    const out = await h.run();
    const usd = out.ownerRevenueByCurrency[0]!;

    expect(usd.activeCount).toBe(2);
    expect(usd.trialingCount).toBe(5);
    // Five trials would have added $50/mo to the running rate.
    expect(usd.annualisedCents).toBe(1_000 * 12 * 2);
  });

  it("never sums currencies together", async () => {
    const h = makeDeps({
      grouped: [
        { tierId: "tier-monthly", status: "active", count: 1 },
        { tierId: "tier-mxn", status: "active", count: 2 },
      ],
      tiers: [
        tier({ priceCents: 1_200 }),
        tier({ id: "tier-mxn", currency: "mxn", priceCents: 15_000 }),
      ],
    });
    const out = await h.run();

    expect(out.ownerRevenueByCurrency.map((r) => r.currency)).toEqual([
      "mxn",
      "usd",
    ]);
    const mxn = out.ownerRevenueByCurrency[0]!;
    const usd = out.ownerRevenueByCurrency[1]!;
    expect(mxn.annualisedCents).toBe(15_000 * 12 * 2);
    expect(usd.annualisedCents).toBe(1_200 * 12);
  });

  it("reads only the two statuses it values or counts, under a statement budget", async () => {
    const h = makeDeps();
    await h.run();
    expect(h.countByTierAndStatus).toHaveBeenCalledWith({
      statuses: ["active", "trialing"],
      statementTimeoutMs: RECURRING_REVENUE_STATEMENT_TIMEOUT_MS,
    });
  });
});

describe("summariseRecurringRevenue — degraded tier lookup", () => {
  it("says the book is partial instead of reporting it as empty", async () => {
    const h = makeDeps({
      grouped: [{ tierId: "tier-monthly", status: "active", count: 3 }],
      tiersFail: true,
    });
    const out = await h.run();

    expect(out.tiersResolved).toBe(false);
    // A count with no tier behind it has no price and no currency, so it is
    // DROPPED rather than valued at zero. Zero is a claim; absent is not.
    expect(out.ownerRevenueByCurrency).toEqual([]);
    expect(h.error).toHaveBeenCalledWith(
      "recurring_revenue_tier_lookup_failed",
      expect.objectContaining({ err: expect.any(Error) }),
    );
    expect(h.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { useCase: "summariseRecurringRevenue", step: "listTiers" },
      }),
    );
  });

  it("a THROWING reporter never turns a degraded panel into a failed one", async () => {
    const h = makeDeps({
      grouped: [{ tierId: "tier-monthly", status: "active", count: 3 }],
      tiersFail: true,
    });
    h.reportError.mockImplementation(() => {
      throw new Error("sentry is down too");
    });
    await expect(h.run()).resolves.toMatchObject({ tiersResolved: false });
  });

  it("drops a count whose tier is simply missing, without claiming a failure", async () => {
    const h = makeDeps({
      grouped: [
        { tierId: "tier-monthly", status: "active", count: 1 },
        { tierId: "tier-vanished", status: "active", count: 9 },
      ],
      tiers: [tier({ priceCents: 1_000 })],
    });
    const out = await h.run();

    expect(out.tiersResolved).toBe(true);
    expect(out.ownerRevenueByCurrency).toHaveLength(1);
    expect(out.ownerRevenueByCurrency[0]!.activeCount).toBe(1);
    expect(out.activeTierCount).toBe(1);
  });
});
