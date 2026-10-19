import { describe, expect, it, vi } from "vitest";

import type { PlatformRevenueByCurrency } from "@th/types/repos/analytics";
import type { ConnectAccountFeeTotal } from "@th/types/repos/payout-items";

import {
  getPlatformRevenue,
  platformRevenueCurrencyRowSchema,
  PLATFORM_REVENUE_STATUSES,
  type GetPlatformRevenueDeps,
  type PlatformRevenueCurrencyRow,
} from "../get-platform-revenue";

const ACTOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function usdRow(
  overrides: Partial<PlatformRevenueByCurrency> = {},
): PlatformRevenueByCurrency {
  return {
    currency: "usd",
    ticketVolumeCents: 33_725,
    platformFeesChargedCents: 1_124,
    taxCollectedCents: 2_781,
    orderCount: 42,
    // Sums to platformFeesChargedCents.
    platformFeesPassThroughCents: 1_000,
    platformFeesAbsorbCents: 100,
    platformFeesUnknownModeCents: 24,
    // Default fixture: NOTHING measured yet, which is the state every
    // currency starts in before the sweep has run.
    processorFeeCents: 0,
    processorFeeMeasuredCount: 0,
    processorFeeEligibleCount: 42,
    processorFeeParkedCount: 0,
    // Nothing stamped yet either: three refunded ticket items, none
    // attributed (all pre-date the column).
    feesReturnedCents: 0,
    feesReturnedMeasuredCount: 0,
    feesReturnedEligibleCount: 3,
    // And nothing is ELIGIBLE for the net either: the default fixture is a
    // legacy order set with no recorded fee mode, which is exactly the
    // state condition (1) excludes.
    netKeptCents: 0,
    netKeptEligibleCount: 0,
    ...overrides,
  };
}

type Options = {
  allowed?: boolean;
  revenue?: PlatformRevenueByCurrency[];
  connectFees?: ConnectAccountFeeTotal[];
  connectFeesFail?: boolean;
};

function makeDeps(options: Options = {}) {
  const hasStaffRole = vi.fn(async () => ({ allowed: options.allowed ?? true }));
  const sumPlatformRevenueByCurrency = vi.fn(
    async () => options.revenue ?? [usdRow()],
  );
  const connectFailure = new Error("payout items unavailable");
  const sumConnectAccountFeesByCurrency = vi.fn(async () => {
    if (options.connectFeesFail) throw connectFailure;
    return (
      options.connectFees ?? [
        { currency: "usd", connectAccountFeeCents: 200, itemCount: 4 },
      ]
    );
  });
  const reportError = vi.fn();
  const logger = {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  };
  logger.child.mockReturnValue(logger);

  const deps = {
    repos: {
      analytics: { sumPlatformRevenueByCurrency },
      payoutItems: { sumConnectAccountFeesByCurrency },
    },
    authz: { hasStaffRole },
    logger,
    reportError,
  } as unknown as GetPlatformRevenueDeps;

  return {
    deps,
    hasStaffRole,
    sumPlatformRevenueByCurrency,
    sumConnectAccountFeesByCurrency,
    logger,
    reportError,
    connectFailure,
  };
}

describe("getPlatformRevenue", () => {
  it("refuses a non-staff actor without reading any money", async () => {
    const h = makeDeps({ allowed: false });
    await expect(
      getPlatformRevenue(h.deps, { actorHumanId: ACTOR }),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });
    expect(h.hasStaffRole).toHaveBeenCalledWith({
      actorHumanId: ACTOR,
      requiredRoles: ["ADMIN", "SUPPORT"],
    });
    expect(h.sumPlatformRevenueByCurrency).not.toHaveBeenCalled();
    expect(h.sumConnectAccountFeesByCurrency).not.toHaveBeenCalled();
  });

  it("refuses unknown input keys (strict schema)", async () => {
    const h = makeDeps();
    await expect(
      getPlatformRevenue(h.deps, { actorHumanId: ACTOR, currency: "usd" }),
    ).rejects.toBeTruthy();
  });

  // ── The two MEASURED cost lines, before anything is measured ──────────────
  //
  // Both only ever SUBTRACT from what the platform kept. Returning 0 for
  // either would overstate earnings, every time, by an unknown amount.

  it("returns feesReturned and processorCost as NULL + `unread` before anything is measured — never 0", async () => {
    const h = makeDeps();
    const out = await getPlatformRevenue(h.deps, { actorHumanId: ACTOR });

    const row = out.rows[0]!;
    expect(row.feesReturnedCents).toBeNull();
    expect(row.feesReturnedUnavailableReason).toBe("unread");
    expect(row.feesReturnedCoverage).toEqual({ measured: 0, total: 3 });
    expect(row.processorCostCents).toBeNull();
    expect(row.processorCostUnavailableReason).toBe("unread");
    // Not zero. The distinction is the whole point.
    expect(row.feesReturnedCents).not.toBe(0);
    expect(row.processorCostCents).not.toBe(0);
    // Nor is the NET a zero: no order in this fixture recorded a fee mode,
    // so nothing is eligible and the honest value is null.
    expect(row.netKeptCents).toBeNull();
    expect(row.netKeptUnavailableReason).toBe("unread");
    expect(row.netKeptCoverage).toEqual({ measured: 0, total: 42 });
  });

  it("carries NO payload-wide net flags — the state is per currency now", async () => {
    const h = makeDeps();
    const out = await getPlatformRevenue(h.deps, { actorHumanId: ACTOR });
    // `netKeptUnavailable: true` and
    // `netKeptUnavailableReason: "inputs_incomplete"` are GONE. They
    // asserted no net was derivable from the payload at all, which is no
    // longer true, and a payload-wide flag would have to lie about at
    // least one row the moment two currencies disagree.
    expect(out).not.toHaveProperty("netKeptUnavailable");
    expect(out).not.toHaveProperty("netKeptUnavailableReason");
    expect(Object.keys(out)).toEqual([
      "rows",
      "statuses",
      "recoveredCostsResolved",
    ]);
    // The row is where the net and its state live.
    const keys = Object.keys(out.rows[0]!);
    expect(keys.filter((k) => /net|kept/i.test(k))).toEqual([
      "netKeptCents",
      "netKeptUnavailableReason",
      "netKeptCoverage",
    ]);
  });

  it("carries the platform fee as RECORDED — passed through untouched", async () => {
    const h = makeDeps({
      revenue: [
        usdRow({
          platformFeesChargedCents: 6_600,
          platformFeesPassThroughCents: 6_000,
          platformFeesAbsorbCents: 600,
          platformFeesUnknownModeCents: 0,
        }),
      ],
    });
    const out = await getPlatformRevenue(h.deps, { actorHumanId: ACTOR });
    // Not reduced by a guessed refund share, not reduced by a guessed
    // processor cost, and NOT doubled for PASS_THROUGH either — exactly
    // what the column says was recorded. The pass-through doubling shows up
    // in `netKeptCents`, which is computed per order over the eligible set;
    // this line stays the RECORDED charge.
    expect(out.rows[0]!.platformFeesChargedCents).toBe(6_600);
  });

  // ── Fee-mode split ────────────────────────────────────────────────────────

  it("splits the recorded fee by mode, and the three sum to the total", async () => {
    const h = makeDeps({
      revenue: [
        usdRow({
          platformFeesChargedCents: 1_124,
          platformFeesPassThroughCents: 1_000,
          platformFeesAbsorbCents: 100,
          platformFeesUnknownModeCents: 24,
        }),
      ],
    });
    const out = await getPlatformRevenue(h.deps, { actorHumanId: ACTOR });
    const row = out.rows[0]!;
    expect(row.platformFeesByMode).toEqual({
      passThroughCents: 1_000,
      absorbCents: 100,
      unknownCents: 24,
    });
    expect(
      row.platformFeesByMode.passThroughCents +
        row.platformFeesByMode.absorbCents +
        row.platformFeesByMode.unknownCents,
    ).toBe(row.platformFeesChargedCents);
  });

  it("a payout-only currency has an all-zero mode split, not a missing one", async () => {
    const h = makeDeps({
      revenue: [],
      connectFees: [{ currency: "cad", connectAccountFeeCents: 75, itemCount: 1 }],
    });
    const out = await getPlatformRevenue(h.deps, { actorHumanId: ACTOR });
    expect(out.rows[0]!.platformFeesByMode).toEqual({
      passThroughCents: 0,
      absorbCents: 0,
      unknownCents: 0,
    });
  });

  // ── Tax is a liability ────────────────────────────────────────────────────

  it("names tax as HELD FOR REMITTANCE and keeps it out of every fee field", async () => {
    const h = makeDeps({
      revenue: [usdRow({ platformFeesChargedCents: 1_000, taxCollectedCents: 2_781 })],
    });
    const out = await getPlatformRevenue(h.deps, { actorHumanId: ACTOR });

    const row = out.rows[0]!;
    expect(row.taxCollectedHeldForRemittanceCents).toBe(2_781);
    // The field name is the guard: there is no plain `taxCollectedCents` a
    // consumer could fold into a revenue total by reflex.
    expect(row).not.toHaveProperty("taxCollectedCents");
    // ...and nothing else absorbed it.
    expect(row.platformFeesChargedCents).toBe(1_000);
    expect(row.ticketVolumeCents).toBe(33_725);
  });

  // ── Status set ────────────────────────────────────────────────────────────

  it("reports the captured-money status set, with CANCELLED/PENDING/PROCESSING excluded", async () => {
    const h = makeDeps();
    const out = await getPlatformRevenue(h.deps, { actorHumanId: ACTOR });

    expect(out.statuses).toEqual([
      "SUCCEEDED",
      "PART_REFUNDED",
      "REFUNDED",
      "DISPUTED",
    ]);
    expect(out.statuses).toEqual([...PLATFORM_REVENUE_STATUSES]);
    // A partial refund must NOT remove an order's fee, which is why
    // PART_REFUNDED is in the set at all.
    expect(out.statuses).toContain("PART_REFUNDED");
    for (const excluded of ["CANCELLED", "PENDING", "PROCESSING"]) {
      expect(out.statuses).not.toContain(excluded);
    }
  });

  // ── Currency separation ───────────────────────────────────────────────────

  it("keeps one row per currency and never sums them", async () => {
    const h = makeDeps({
      revenue: [
        usdRow({ currency: "usd", ticketVolumeCents: 10_000, platformFeesChargedCents: 333, taxCollectedCents: 800, orderCount: 3 }),
        usdRow({ currency: "mxn", ticketVolumeCents: 50_000, platformFeesChargedCents: 1_600, taxCollectedCents: 0, orderCount: 7 }),
      ],
      connectFees: [
        { currency: "usd", connectAccountFeeCents: 200, itemCount: 2 },
        { currency: "mxn", connectAccountFeeCents: 50, itemCount: 1 },
      ],
    });

    const out = await getPlatformRevenue(h.deps, { actorHumanId: ACTOR });

    expect(out.rows.map((r) => r.currency)).toEqual(["mxn", "usd"]);
    expect(out.rows[0]).toMatchObject({
      currency: "mxn",
      ticketVolumeCents: 50_000,
      platformFeesChargedCents: 1_600,
      connectAccountFeesRecoveredCents: 50,
    });
    expect(out.rows[1]).toMatchObject({
      currency: "usd",
      ticketVolumeCents: 10_000,
      platformFeesChargedCents: 333,
      connectAccountFeesRecoveredCents: 200,
    });
    // No combined row, and no field anywhere holding 60_000 / 1_933 / 250.
    expect(out.rows).toHaveLength(2);
  });

  it("keeps a currency that exists only on the payout side rather than hiding it", async () => {
    const h = makeDeps({
      revenue: [usdRow({ currency: "usd" })],
      connectFees: [
        { currency: "usd", connectAccountFeeCents: 200, itemCount: 2 },
        { currency: "cad", connectAccountFeeCents: 75, itemCount: 1 },
      ],
    });

    const out = await getPlatformRevenue(h.deps, { actorHumanId: ACTOR });

    expect(out.rows.map((r) => r.currency)).toEqual(["cad", "usd"]);
    expect(out.rows[0]).toMatchObject({
      currency: "cad",
      ticketVolumeCents: 0,
      platformFeesChargedCents: 0,
      orderCount: 0,
      connectAccountFeesRecoveredCents: 75,
    });
  });

  // ── The recovered-cost line ───────────────────────────────────────────────

  it("distinguishes a genuine zero recovered cost from an unread one", async () => {
    // Resolved, no transfers in that currency yet → 0, a real answer.
    const zero = await getPlatformRevenue(
      makeDeps({ connectFees: [] }).deps,
      { actorHumanId: ACTOR },
    );
    expect(zero.recoveredCostsResolved).toBe(true);
    expect(zero.rows[0]!.connectAccountFeesRecoveredCents).toBe(0);
    expect(zero.rows[0]!.payoutItemCount).toBe(0);

    // The read FAILED → null, unknown. Never 0.
    const h = makeDeps({ connectFeesFail: true });
    const failed = await getPlatformRevenue(h.deps, { actorHumanId: ACTOR });
    expect(failed.recoveredCostsResolved).toBe(false);
    expect(failed.rows[0]!.connectAccountFeesRecoveredCents).toBeNull();
    expect(failed.rows[0]!.payoutItemCount).toBeNull();
  });

  it("still shows the revenue when the recovered-cost read fails, and reports the swallow", async () => {
    const h = makeDeps({ connectFeesFail: true });

    const out = await getPlatformRevenue(h.deps, { actorHumanId: ACTOR });

    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]).toMatchObject({
      ticketVolumeCents: 33_725,
      platformFeesChargedCents: 1_124,
      taxCollectedHeldForRemittanceCents: 2_781,
    });
    expect(h.logger.error).toHaveBeenCalledWith(
      "platform_revenue_connect_fee_lookup_failed",
      expect.objectContaining({ err: h.connectFailure }),
    );
    expect(h.reportError).toHaveBeenCalledWith(
      h.connectFailure,
      expect.objectContaining({
        tags: {
          useCase: "getPlatformRevenue",
          step: "sumConnectAccountFees",
        },
      }),
    );
  });

  it("a throwing reportError never changes the result", async () => {
    const h = makeDeps({ connectFeesFail: true });
    (h.reportError as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("sentry is down");
    });

    await expect(
      getPlatformRevenue(h.deps, { actorHumanId: ACTOR }),
    ).resolves.toMatchObject({ recoveredCostsResolved: false });
  });

  it("a MISSING reporter never changes the result either", async () => {
    const h = makeDeps({ connectFeesFail: true });
    (h.deps as { reportError?: unknown }).reportError = undefined;

    await expect(
      getPlatformRevenue(h.deps, { actorHumanId: ACTOR }),
    ).resolves.toMatchObject({ recoveredCostsResolved: false });
  });

  it("returns no rows when there is nothing to report", async () => {
    const h = makeDeps({ revenue: [], connectFees: [] });
    const out = await getPlatformRevenue(h.deps, { actorHumanId: ACTOR });
    expect(out.rows).toEqual([]);
    expect(out.recoveredCostsResolved).toBe(true);
  });
});

// ── Processor-cost coverage ────────────────────────────────────────────────
//
// The column exists now, but it fills one order at a time. A partial sum is
// the dangerous state: it looks like a complete cost, and understating cost
// overstates what the platform kept. These pin the three states apart.

describe("getPlatformRevenue — processor-cost coverage", () => {
  it("reports NOTHING measured as null, never as a zero cost", async () => {
    const { deps } = makeDeps({
      revenue: [
        usdRow({ processorFeeMeasuredCount: 0, processorFeeCents: 0 }),
      ],
    });
    const out = await getPlatformRevenue(deps, { actorHumanId: "h1" });
    const row = out.rows[0]!;
    // "No cost recorded" and "a cost of zero" are different claims.
    expect(row.processorCostCents).toBeNull();
    expect(row.processorCostUnavailableReason).toBe("unread");
    expect(row.processorCostCoverage).toEqual({ measured: 0, total: 42, parked: 0 });
  });

  it("flags a PARTIAL sum as partial rather than passing it off as the cost", async () => {
    const { deps } = makeDeps({
      revenue: [
        usdRow({ processorFeeMeasuredCount: 10, processorFeeCents: 1_500 }),
      ],
    });
    const out = await getPlatformRevenue(deps, { actorHumanId: "h1" });
    const row = out.rows[0]!;
    expect(row.processorCostCents).toBe(1_500);
    expect(row.processorCostUnavailableReason).toBe("partial_coverage");
    expect(row.processorCostCoverage).toEqual({ measured: 10, total: 42, parked: 0 });
  });

  it("surfaces PARKED rows in the coverage without pretending they are measured", async () => {
    // 10 measured, 42 eligible, and the sweep has given up on 5 of the
    // remaining 32. Still partial — the gap is real — but the caption can
    // now say that 5 of it will never fill on its own.
    const { deps } = makeDeps({
      revenue: [
        usdRow({
          processorFeeMeasuredCount: 10,
          processorFeeCents: 1_500,
          processorFeeParkedCount: 5,
        }),
      ],
    });
    const out = await getPlatformRevenue(deps, { actorHumanId: "h1" });
    const row = out.rows[0]!;
    expect(row.processorCostCents).toBe(1_500);
    expect(row.processorCostUnavailableReason).toBe("partial_coverage");
    expect(row.processorCostCoverage).toEqual({ measured: 10, total: 42, parked: 5 });
    // The other line has no sweep and therefore no parked concept.
    expect(row.feesReturnedCoverage).toEqual({ measured: 0, total: 3 });
    expect(row.feesReturnedCoverage).not.toHaveProperty("parked");
  });

  it("a payout-only currency reports parked 0, never a missing field", async () => {
    const { deps } = makeDeps({
      revenue: [],
      connectFees: [{ currency: "cad", connectAccountFeeCents: 75, itemCount: 1 }],
    });
    const out = await getPlatformRevenue(deps, { actorHumanId: "h1" });
    expect(out.rows[0]!.processorCostCoverage).toEqual({ measured: 0, total: 0, parked: 0 });
  });

  it("clears the reason once every eligible order is measured", async () => {
    const { deps } = makeDeps({
      revenue: [
        usdRow({ processorFeeMeasuredCount: 42, processorFeeCents: 6_300 }),
      ],
    });
    const out = await getPlatformRevenue(deps, { actorHumanId: "h1" });
    const row = out.rows[0]!;
    expect(row.processorCostCents).toBe(6_300);
    expect(row.processorCostUnavailableReason).toBeNull();
    expect(row.processorCostCoverage).toEqual({ measured: 42, total: 42, parked: 0 });
  });

  it("the cost lines' coverage is independent of the net's — full cost coverage does not make the net complete", async () => {
    const { deps } = makeDeps({
      revenue: [
        usdRow({
          processorFeeMeasuredCount: 42,
          processorFeeCents: 6_300,
          feesReturnedMeasuredCount: 3,
          feesReturnedCents: 99,
          // ...but only 2 of the 42 orders recorded a fee mode, so the net
          // covers 2 of 42. Pinned to the fixture's unknown-mode bucket:
          // zero that and this test fails rather than quietly becoming a
          // lie.
          netKeptEligibleCount: 2,
          netKeptCents: 120,
        }),
      ],
    });
    const out = await getPlatformRevenue(deps, { actorHumanId: "h1" });
    const row = out.rows[0]!;
    expect(row.processorCostUnavailableReason).toBeNull();
    expect(row.feesReturnedUnavailableReason).toBeNull();
    expect(row.platformFeesByMode.unknownCents).toBeGreaterThan(0);
    expect(row.netKeptCents).toBe(120);
    expect(row.netKeptUnavailableReason).toBe("partial_coverage");
    expect(row.netKeptCoverage).toEqual({ measured: 2, total: 42 });
  });

  it("an order with no payment intent is not a coverage gap", async () => {
    // 42 orders, only 30 charged through Stripe. Measuring all 30 IS full
    // coverage — counting the other 12 against it would keep the figure
    // permanently 'partial' for no reason.
    const { deps } = makeDeps({
      revenue: [
        usdRow({
          orderCount: 42,
          processorFeeEligibleCount: 30,
          processorFeeMeasuredCount: 30,
          processorFeeCents: 4_000,
        }),
      ],
    });
    const out = await getPlatformRevenue(deps, { actorHumanId: "h1" });
    expect(out.rows[0]!.processorCostUnavailableReason).toBeNull();
  });
});

// ── Fees-returned coverage ─────────────────────────────────────────────────
//
// The mirror of the block above for the OTHER cost line. It fills one refund
// at a time (`OrderItem.refundedPlatformFeeCents`, stamped at execution), so
// it has the same three states and the same danger: a partial sum looks like
// a complete one, and understating what went back overstates what we kept.

describe("getPlatformRevenue — fees-returned coverage", () => {
  it("reports NOTHING measured as null + `unread`, never as zero returned", async () => {
    const { deps } = makeDeps({
      revenue: [
        usdRow({ feesReturnedMeasuredCount: 0, feesReturnedCents: 0, feesReturnedEligibleCount: 7 }),
      ],
    });
    const out = await getPlatformRevenue(deps, { actorHumanId: "h1" });
    const row = out.rows[0]!;
    expect(row.feesReturnedCents).toBeNull();
    expect(row.feesReturnedUnavailableReason).toBe("unread");
    expect(row.feesReturnedCoverage).toEqual({ measured: 0, total: 7 });
  });

  it("flags a PARTIAL sum as partial rather than passing it off as the total returned", async () => {
    const { deps } = makeDeps({
      revenue: [
        usdRow({ feesReturnedMeasuredCount: 2, feesReturnedCents: 66, feesReturnedEligibleCount: 7 }),
      ],
    });
    const out = await getPlatformRevenue(deps, { actorHumanId: "h1" });
    const row = out.rows[0]!;
    expect(row.feesReturnedCents).toBe(66);
    expect(row.feesReturnedUnavailableReason).toBe("partial_coverage");
    expect(row.feesReturnedCoverage).toEqual({ measured: 2, total: 7 });
  });

  it("clears the reason once every refunded ticket item is measured", async () => {
    const { deps } = makeDeps({
      revenue: [
        usdRow({ feesReturnedMeasuredCount: 7, feesReturnedCents: 231, feesReturnedEligibleCount: 7 }),
      ],
    });
    const out = await getPlatformRevenue(deps, { actorHumanId: "h1" });
    const row = out.rows[0]!;
    expect(row.feesReturnedCents).toBe(231);
    expect(row.feesReturnedUnavailableReason).toBeNull();
    expect(row.feesReturnedCoverage).toEqual({ measured: 7, total: 7 });
  });

  it("a measured ZERO returned is a real zero, not `unread`", async () => {
    // One refund on a fee-waived order: stamped 0. That is a known value.
    const { deps } = makeDeps({
      revenue: [
        usdRow({ feesReturnedMeasuredCount: 1, feesReturnedCents: 0, feesReturnedEligibleCount: 1 }),
      ],
    });
    const out = await getPlatformRevenue(deps, { actorHumanId: "h1" });
    const row = out.rows[0]!;
    expect(row.feesReturnedCents).toBe(0);
    expect(row.feesReturnedUnavailableReason).toBeNull();
  });

  it("no refunds at all (0 of 0) is a CONFIDENT zero, not `unread`", async () => {
    // BEHAVIOUR CHANGE, deliberate: this used to be null + `unread`, which
    // made the page badge "Not read yet" on a platform that has simply never
    // refunded anything. Zero refunded ticket items means exactly zero fee
    // returned — the sum of an empty set, not an estimate.
    const { deps } = makeDeps({
      revenue: [
        usdRow({ feesReturnedMeasuredCount: 0, feesReturnedCents: 0, feesReturnedEligibleCount: 0 }),
      ],
    });
    const out = await getPlatformRevenue(deps, { actorHumanId: "h1" });
    const row = out.rows[0]!;
    expect(row.feesReturnedCents).toBe(0);
    expect(row.feesReturnedUnavailableReason).toBe("nothing_to_report");
    expect(row.feesReturnedCoverage).toEqual({ measured: 0, total: 0 });
  });

  it("keeps `unread` for refunds that EXIST and are unstamped — 0 of 3 is not 0 of 0", async () => {
    // The guard on the change above: an empty population is a confident 0,
    // a REAL population nobody measured is still null. These must not
    // collapse back into one another.
    const { deps } = makeDeps({
      revenue: [
        usdRow({ feesReturnedMeasuredCount: 0, feesReturnedCents: 0, feesReturnedEligibleCount: 3 }),
      ],
    });
    const out = await getPlatformRevenue(deps, { actorHumanId: "h1" });
    const row = out.rows[0]!;
    expect(row.feesReturnedCents).toBeNull();
    expect(row.feesReturnedUnavailableReason).toBe("unread");
  });

  it("no chargeable orders at all (0 of 0) is a CONFIDENT zero processor cost", async () => {
    // Nothing with a payment intent in this currency, so Stripe charged
    // exactly nothing. Not "we have not looked".
    const { deps } = makeDeps({
      revenue: [
        usdRow({
          processorFeeMeasuredCount: 0,
          processorFeeCents: 0,
          processorFeeEligibleCount: 0,
        }),
      ],
    });
    const out = await getPlatformRevenue(deps, { actorHumanId: "h1" });
    const row = out.rows[0]!;
    expect(row.processorCostCents).toBe(0);
    expect(row.processorCostUnavailableReason).toBe("nothing_to_report");
    expect(row.processorCostCoverage).toEqual({
      measured: 0,
      total: 0,
      parked: 0,
    });
  });

  it("the two cost lines are independent — one complete does not clear the other", async () => {
    const { deps } = makeDeps({
      revenue: [
        usdRow({
          processorFeeMeasuredCount: 42,
          processorFeeCents: 6_300,
          feesReturnedMeasuredCount: 1,
          feesReturnedCents: 33,
          feesReturnedEligibleCount: 3,
        }),
      ],
    });
    const out = await getPlatformRevenue(deps, { actorHumanId: "h1" });
    const row = out.rows[0]!;
    expect(row.processorCostUnavailableReason).toBeNull();
    expect(row.feesReturnedUnavailableReason).toBe("partial_coverage");
  });
});

// ── The net ────────────────────────────────────────────────────────────────
//
// `netKeptCents` is the adapter's per-order expression summed over ELIGIBLE
// orders. The use case's job is the three-state rule and nothing else — it
// never recomputes, defaults or clamps the figure. These pin the states and
// the sign.

describe("getPlatformRevenue — the net", () => {
  it("reports NOTHING eligible as null + `unread`, never as a zero net", async () => {
    // The state every legacy currency is in: orders exist, none of them
    // recorded a fee mode. A zero here would claim the platform kept
    // nothing, which is a different (and false) statement.
    const { deps } = makeDeps({
      revenue: [usdRow({ netKeptEligibleCount: 0, netKeptCents: 0 })],
    });
    const out = await getPlatformRevenue(deps, { actorHumanId: "h1" });
    const row = out.rows[0]!;
    expect(row.netKeptCents).toBeNull();
    expect(row.netKeptUnavailableReason).toBe("unread");
    expect(row.netKeptCoverage).toEqual({ measured: 0, total: 42 });
    expect(row.netKeptCents).not.toBe(0);
  });

  it("flags a PARTIAL net as partial rather than passing it off as the total kept", async () => {
    const { deps } = makeDeps({
      revenue: [usdRow({ netKeptEligibleCount: 10, netKeptCents: 640 })],
    });
    const out = await getPlatformRevenue(deps, { actorHumanId: "h1" });
    const row = out.rows[0]!;
    expect(row.netKeptCents).toBe(640);
    expect(row.netKeptUnavailableReason).toBe("partial_coverage");
    expect(row.netKeptCoverage).toEqual({ measured: 10, total: 42 });
  });

  it("clears the reason once EVERY counted order is eligible", async () => {
    const { deps } = makeDeps({
      revenue: [usdRow({ netKeptEligibleCount: 42, netKeptCents: 2_048 })],
    });
    const out = await getPlatformRevenue(deps, { actorHumanId: "h1" });
    const row = out.rows[0]!;
    expect(row.netKeptCents).toBe(2_048);
    expect(row.netKeptUnavailableReason).toBeNull();
    expect(row.netKeptCoverage).toEqual({ measured: 42, total: 42 });
  });

  it("0 of 0 is a CONFIDENT zero net — no orders means exactly nothing kept", async () => {
    // BEHAVIOUR CHANGE, deliberate: this used to be null + `unread`. A
    // currency with no counted orders has an empty eligible set, and the sum
    // over it is exactly 0. `unread` is reserved for orders that EXIST and
    // are not eligible — pinned by the test above, which keeps its null.
    const { deps } = makeDeps({
      revenue: [
        usdRow({ orderCount: 0, netKeptEligibleCount: 0, netKeptCents: 0 }),
      ],
    });
    const out = await getPlatformRevenue(deps, { actorHumanId: "h1" });
    const row = out.rows[0]!;
    expect(row.netKeptCents).toBe(0);
    expect(row.netKeptUnavailableReason).toBe("nothing_to_report");
    expect(row.netKeptCoverage).toEqual({ measured: 0, total: 0 });
  });

  it("a payout-only currency reports 0-of-0 rather than a missing field", async () => {
    const { deps } = makeDeps({
      revenue: [],
      connectFees: [
        { currency: "cad", connectAccountFeeCents: 75, itemCount: 1 },
      ],
    });
    const out = await getPlatformRevenue(deps, { actorHumanId: "h1" });
    const row = out.rows[0]!;
    expect(row.currency).toBe("cad");
    // BEHAVIOUR CHANGE, deliberate: was null + `unread`. A payout-only
    // currency has no orders, so all THREE measured lines are 0 of 0 and all
    // three report a confident 0 — which is why they are asserted together
    // here: the one helper drives them, so they must move together.
    expect(row.netKeptCents).toBe(0);
    expect(row.netKeptUnavailableReason).toBe("nothing_to_report");
    expect(row.netKeptCoverage).toEqual({ measured: 0, total: 0 });
    expect(row.feesReturnedCents).toBe(0);
    expect(row.feesReturnedUnavailableReason).toBe("nothing_to_report");
    expect(row.processorCostCents).toBe(0);
    expect(row.processorCostUnavailableReason).toBe("nothing_to_report");
    // And the Connect fee is NOT netted against it: separate line, per
    // PayoutItem rather than per order. The net's 0 is over ORDERS, of which
    // there are none — it is not a claim that the 75 was kept.
    expect(row.connectAccountFeesRecoveredCents).toBe(75);
  });

  // ── The two modes, arithmetically ─────────────────────────────────────────
  //
  // The adapter does the arithmetic; these state what the contract's numbers
  // MEAN, so a future change to the expression has to change a test that
  // spells out the worked example rather than one that just echoes a mock.

  it("a PASS_THROUGH order keeps BOTH fee units and gives BOTH back on refund", async () => {
    // One order: gross 10_000, fee 333, PASS_THROUGH, one ticket refunded
    // with 333 stamped. The buyer paid the fee on top (+333) and the basis
    // was reduced by it as well (+333, uncapped at this gross), so 666 was
    // kept; the refund returns both units (−666). Net 0. The buyer funded
    // the processor fee via the gross-up, so nothing is subtracted for it.
    const { deps } = makeDeps({
      revenue: [
        usdRow({
          orderCount: 1,
          ticketVolumeCents: 10_000,
          platformFeesChargedCents: 333,
          platformFeesPassThroughCents: 333,
          platformFeesAbsorbCents: 0,
          platformFeesUnknownModeCents: 0,
          feesReturnedCents: 333,
          feesReturnedMeasuredCount: 1,
          feesReturnedEligibleCount: 1,
          netKeptEligibleCount: 1,
          netKeptCents: 333 + 333 - 333 * 2,
        }),
      ],
    });
    const out = await getPlatformRevenue(deps, { actorHumanId: "h1" });
    const row = out.rows[0]!;
    expect(row.netKeptCents).toBe(0);
    expect(row.netKeptUnavailableReason).toBeNull();
    // The RECORDED charge is still one unit — the net is the only place the
    // second unit is counted.
    expect(row.platformFeesChargedCents).toBe(333);
  });

  it("an ABSORB order keeps ONE fee unit and subtracts the processor cost", async () => {
    // Gross 10_000, fee 333, ABSORB, processor fee 320 stamped, no refunds.
    // The organiser bore the fee out of the basis (+333); the processor fee
    // is ours (−320). Net 13.
    const { deps } = makeDeps({
      revenue: [
        usdRow({
          orderCount: 1,
          ticketVolumeCents: 10_000,
          platformFeesChargedCents: 333,
          platformFeesPassThroughCents: 0,
          platformFeesAbsorbCents: 333,
          platformFeesUnknownModeCents: 0,
          processorFeeCents: 320,
          processorFeeMeasuredCount: 1,
          processorFeeEligibleCount: 1,
          feesReturnedCents: 0,
          feesReturnedMeasuredCount: 0,
          feesReturnedEligibleCount: 0,
          netKeptEligibleCount: 1,
          netKeptCents: 333 - 320,
        }),
      ],
    });
    const out = await getPlatformRevenue(deps, { actorHumanId: "h1" });
    const row = out.rows[0]!;
    expect(row.netKeptCents).toBe(13);
    expect(row.netKeptUnavailableReason).toBeNull();
  });

  it("passes a NEGATIVE net through unclamped — refunds and credits can exceed the fee", async () => {
    const { deps } = makeDeps({
      revenue: [
        usdRow({
          orderCount: 2,
          netKeptEligibleCount: 2,
          netKeptCents: -1_250,
        }),
      ],
    });
    const out = await getPlatformRevenue(deps, { actorHumanId: "h1" });
    const row = out.rows[0]!;
    // Not 0, not null, not Math.max'd: a loss is the answer.
    expect(row.netKeptCents).toBe(-1_250);
    expect(row.netKeptUnavailableReason).toBeNull();
  });

  it("keeps each currency's net and coverage to itself", async () => {
    const { deps } = makeDeps({
      revenue: [
        usdRow({
          currency: "usd",
          orderCount: 10,
          netKeptEligibleCount: 10,
          netKeptCents: 5_000,
        }),
        usdRow({
          currency: "mxn",
          orderCount: 4,
          netKeptEligibleCount: 1,
          netKeptCents: -700,
        }),
      ],
      connectFees: [],
    });
    const out = await getPlatformRevenue(deps, { actorHumanId: "h1" });

    expect(out.rows.map((r) => r.currency)).toEqual(["mxn", "usd"]);
    expect(out.rows[0]).toMatchObject({
      currency: "mxn",
      netKeptCents: -700,
      netKeptUnavailableReason: "partial_coverage",
      netKeptCoverage: { measured: 1, total: 4 },
    });
    expect(out.rows[1]).toMatchObject({
      currency: "usd",
      netKeptCents: 5_000,
      netKeptUnavailableReason: null,
      netKeptCoverage: { measured: 10, total: 10 },
    });
    // 5_000 + (−700) = 4_300 must exist nowhere.
    expect(JSON.stringify(out)).not.toContain("4300");
  });
});


// ── The cents/reason pairing, at the SCHEMA ────────────────────────────────
//
// `coverageLine` is the only writer today and cannot produce a mismatched
// pair. The schema pins it anyway because the tRPC router runs it as
// `.output()`, which turns the pairing into a contract a FUTURE writer has to
// keep. These parse hand-built rows, since the use case cannot emit the
// states under test.

describe("platformRevenueCurrencyRowSchema — cents and reason are one fact", () => {
  const row = (
    overrides: Partial<PlatformRevenueCurrencyRow> = {},
  ): PlatformRevenueCurrencyRow => ({
    currency: "usd",
    ticketVolumeCents: 0,
    platformFeesChargedCents: 0,
    platformFeesByMode: {
      passThroughCents: 0,
      absorbCents: 0,
      unknownCents: 0,
    },
    taxCollectedHeldForRemittanceCents: 0,
    orderCount: 0,
    connectAccountFeesRecoveredCents: 0,
    payoutItemCount: 0,
    feesReturnedCents: 0,
    feesReturnedUnavailableReason: "nothing_to_report",
    feesReturnedCoverage: { measured: 0, total: 0 },
    processorCostCents: 0,
    processorCostUnavailableReason: "nothing_to_report",
    processorCostCoverage: { measured: 0, total: 0, parked: 0 },
    netKeptCents: 0,
    netKeptUnavailableReason: "nothing_to_report",
    netKeptCoverage: { measured: 0, total: 0 },
    ...overrides,
  });

  it("accepts the four legitimate pairings", () => {
    // nothing_to_report → 0; unread → null; partial_coverage → a figure;
    // null → a figure. One row cannot hold all four, so this walks them.
    expect(platformRevenueCurrencyRowSchema.safeParse(row()).success).toBe(true);
    expect(
      platformRevenueCurrencyRowSchema.safeParse(
        row({
          feesReturnedCents: null,
          feesReturnedUnavailableReason: "unread",
          feesReturnedCoverage: { measured: 0, total: 3 },
          processorCostCents: 500,
          processorCostUnavailableReason: "partial_coverage",
          processorCostCoverage: { measured: 2, total: 9, parked: 0 },
          netKeptCents: -1_250,
          netKeptUnavailableReason: null,
          netKeptCoverage: { measured: 4, total: 4 },
        }),
      ).success,
    ).toBe(true);
  });

  it("REJECTS null cents with `nothing_to_report` — the worst-of-both state", () => {
    // This is the one the guard exists for: the UI would paint a dash AND
    // the "nothing to report" caption AND no badge, claiming the answer is
    // both missing and finished.
    for (const bad of [
      row({ feesReturnedCents: null }),
      row({ processorCostCents: null }),
      row({ netKeptCents: null }),
    ]) {
      const parsed = platformRevenueCurrencyRowSchema.safeParse(bad);
      expect(parsed.success).toBe(false);
      expect(
        parsed.success ? "" : parsed.error.issues[0]!.message,
      ).toMatch(/must be a number/);
    }
  });

  it("REJECTS a figure paired with `unread` — an unmeasured line has none", () => {
    for (const bad of [
      row({ feesReturnedCents: 0, feesReturnedUnavailableReason: "unread" }),
      row({ processorCostCents: 700, processorCostUnavailableReason: "unread" }),
      row({ netKeptCents: 0, netKeptUnavailableReason: "unread" }),
    ]) {
      const parsed = platformRevenueCurrencyRowSchema.safeParse(bad);
      expect(parsed.success).toBe(false);
      expect(parsed.success ? "" : parsed.error.issues[0]!.message).toMatch(
        /must be null/,
      );
    }
  });

  it("REJECTS null cents with `partial_coverage` or no reason at all", () => {
    for (const bad of [
      row({
        feesReturnedCents: null,
        feesReturnedUnavailableReason: "partial_coverage",
      }),
      row({ netKeptCents: null, netKeptUnavailableReason: null }),
    ]) {
      expect(platformRevenueCurrencyRowSchema.safeParse(bad).success).toBe(
        false,
      );
    }
  });

  it("every row the use case actually emits satisfies the pairing", () => {
    // The guard must not be stricter than the producer. `coverageLine`'s
    // own output is re-parsed here rather than assumed compatible.
    expect(() =>
      platformRevenueCurrencyRowSchema.parse(
        row({
          feesReturnedCents: null,
          feesReturnedUnavailableReason: "unread",
          feesReturnedCoverage: { measured: 0, total: 2 },
        }),
      ),
    ).not.toThrow();
  });
});
