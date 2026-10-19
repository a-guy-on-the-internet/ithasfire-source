import { describe, expect, it, vi } from "vitest";

import { createCaller } from "./test-helpers";
import { platformRouter } from "../platform";

// Transport coverage for the two reads added to /platform/settlements:
// "when does the rest go out" and "what did the platform charge". Same
// thin-transport contract as `platform-payouts.test.ts` — auth, the
// `.omit({ actorHumanId })` + `.strict()` input, the output schema and error
// mapping. The arithmetic lives in the use cases and is tested there.

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const PAYEE_ID = "22222222-2222-4222-8222-222222222222";
const ORG_ID = "33333333-3333-4333-8333-333333333333";

const OCT_4 = new Date("2026-10-04T00:00:00.000Z");
const OCT_11 = new Date("2026-10-11T00:00:00.000Z");

const authzWith = (allowed: boolean) => {
  const hasStaffRole = vi.fn(async () => ({ allowed }));
  return {
    authz: {
      hasOrgRole: vi.fn(),
      requireOrgRole: vi.fn(),
      canEditEvent: vi.fn(),
      canManagePlace: vi.fn(),
      canFinanceOrg: vi.fn(),
      hasStaffRole,
    } as any,
    hasStaffRole,
  };
};

function makeUpcomingRepos() {
  return {
    payeeLedger: {
      listUpcomingMaturities: vi.fn(async () => [
        {
          payeeId: PAYEE_ID,
          currency: "usd",
          maturesAt: OCT_4,
          creditCents: 12_000,
          heldCents: 0,
          creditCount: 3,
        },
        {
          payeeId: PAYEE_ID,
          currency: "usd",
          maturesAt: OCT_11,
          creditCents: 4_000,
          heldCents: 0,
          creditCount: 1,
        },
      ]),
      // The debt-netting read: no cells in debt, so expected equals gross.
      listPayableBalances: vi.fn(async () => []),
    },
    payees: {
      getByIds: vi.fn(async () => [
        {
          id: PAYEE_ID,
          subjectType: "ORGANIZATION",
          subjectId: ORG_ID,
          stripeAccountId: "acct_1",
          payoutsEnabled: true,
        },
      ]),
    },
    organizations: {
      getByIds: vi.fn(async () => [
        { id: ORG_ID, name: "DRKMTTR", slug: "drkmttr" },
      ]),
    },
    humans: { getByIds: vi.fn(async () => []) },
  } as any;
}

function makeRevenueRepos() {
  return {
    analytics: {
      sumPlatformRevenueByCurrency: vi.fn(async () => [
        {
          currency: "usd",
          ticketVolumeCents: 33_725,
          platformFeesChargedCents: 1_124,
          taxCollectedCents: 2_781,
          orderCount: 42,
          // The recorded fee split by mode — sums to the 1_124 above.
          platformFeesPassThroughCents: 1_000,
          platformFeesAbsorbCents: 100,
          platformFeesUnknownModeCents: 24,
          // The sweep has stamped 30 of the 42 fee-eligible orders so far:
          // a PARTIAL cost, reported with its coverage.
          processorFeeCents: 1_050,
          processorFeeMeasuredCount: 30,
          processorFeeEligibleCount: 42,
          // ...and has given up on 2 of the remaining 12.
          processorFeeParkedCount: 2,
          // Five refunded ticket items, all five stamped: complete.
          feesReturnedCents: 166,
          feesReturnedMeasuredCount: 5,
          feesReturnedEligibleCount: 5,
          // The net covers 28 of the 42 counted orders — the rest have no
          // recorded fee mode, are DISPUTED, or carry an unstamped input.
          // PARTIAL, and it must surface as such through the transport.
          netKeptCents: 1_408,
          netKeptEligibleCount: 28,
        },
      ]),
    },
    payoutItems: {
      sumConnectAccountFeesByCurrency: vi.fn(async () => [
        { currency: "usd", connectAccountFeeCents: 200, itemCount: 4 },
      ]),
    },
  } as any;
}

describe("platform.listUpcomingPayouts", () => {
  it("rejects an unauthenticated caller", async () => {
    const { caller } = createCaller(
      { listUpcomingPayouts: platformRouter.listUpcomingPayouts },
      { actorHumanId: null, repos: makeUpcomingRepos() },
    );
    await expect(caller.listUpcomingPayouts()).rejects.toThrow(/unauthorized/i);
  });

  it("rejects a non-staff caller via the use case's STAFF_ONLY gate without reading the ledger", async () => {
    const repos = makeUpcomingRepos();
    const { authz, hasStaffRole } = authzWith(false);
    const { caller } = createCaller(
      { listUpcomingPayouts: platformRouter.listUpcomingPayouts },
      { actorHumanId: ACTOR_ID, authz, repos },
    );

    await expect(caller.listUpcomingPayouts()).rejects.toThrow(
      /forbidden|staff/i,
    );
    expect(hasStaffRole).toHaveBeenCalledWith({
      actorHumanId: ACTOR_ID,
      requiredRoles: ["ADMIN", "SUPPORT"],
    });
    expect(repos.payeeLedger.listUpcomingMaturities).not.toHaveBeenCalled();
  });

  it("returns the tranches, the per-date totals and the per-payee next tranche for staff", async () => {
    const repos = makeUpcomingRepos();
    const { authz } = authzWith(true);
    const { caller } = createCaller(
      { listUpcomingPayouts: platformRouter.listUpcomingPayouts },
      { actorHumanId: ACTOR_ID, authz, repos },
    );

    const result = await caller.listUpcomingPayouts();

    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({
      payeeId: PAYEE_ID,
      ownerLabel: "DRKMTTR",
      ownerSlug: "drkmttr",
      maturesAt: OCT_4,
      creditCents: 12_000,
      heldCents: 0,
      debtAppliedCents: 0,
      expectedCents: 12_000,
      creditCount: 3,
      identityResolved: true,
    });
    expect(result.byDate).toEqual([
      {
        maturesAt: OCT_4,
        currency: "usd",
        creditCents: 12_000,
        debtAppliedCents: 0,
        expectedCents: 12_000,
        payeeCount: 1,
        creditCount: 3,
      },
      {
        maturesAt: OCT_11,
        currency: "usd",
        creditCents: 4_000,
        debtAppliedCents: 0,
        expectedCents: 4_000,
        payeeCount: 1,
        creditCount: 1,
      },
    ]);
    // EARLIEST tranche only — not 16_000.
    expect(result.nextByPayee).toEqual([
      {
        payeeId: PAYEE_ID,
        currency: "usd",
        maturesAt: OCT_4,
        nextTrancheCents: 12_000,
        creditCents: 12_000,
        heldCents: 0,
        debtAppliedCents: 0,
      },
    ]);
    expect(result.currencyTotals).toEqual([
      {
        currency: "usd",
        creditCents: 16_000,
        debtAppliedCents: 0,
        expectedCents: 16_000,
        trancheCount: 2,
      },
    ]);
    // The payable read landed, so every expected figure is a number.
    expect(result.debtResolved).toBe(true);
    expect(repos.payeeLedger.listPayableBalances).toHaveBeenCalledWith(
      expect.any(Date),
      [PAYEE_ID],
      expect.objectContaining({ statementTimeoutMs: expect.any(Number) }),
    );
    expect(result.truncated).toBe(false);
    expect(result.total).toBe(2);
  });

  it("keeps the rows and returns schema-valid output with debtResolved:false when the payable read REJECTS, and reports the swallow", async () => {
    // The debt netting is best-effort: a failed payable read must degrade
    // the panel (nulls + a flag), not fail it — and the strict `.output()`
    // schema must accept that degraded shape, or the transport would turn a
    // known-unknown into a 500.
    const repos = makeUpcomingRepos();
    const failure = new Error("payable read timed out");
    repos.payeeLedger.listPayableBalances = vi.fn(async () => {
      throw failure;
    });
    const reportError = vi.fn();
    const { authz } = authzWith(true);
    const { caller } = createCaller(
      { listUpcomingPayouts: platformRouter.listUpcomingPayouts },
      { actorHumanId: ACTOR_ID, authz, repos, reportError },
    );

    const result = await caller.listUpcomingPayouts();

    expect(result.debtResolved).toBe(false);
    expect(result.total).toBe(2);
    expect(result.items).toHaveLength(2);
    // Gross and the dispute annotation are known; nothing debt-dependent is.
    expect(result.items[0]).toMatchObject({
      creditCents: 12_000,
      heldCents: 0,
      debtAppliedCents: null,
      expectedCents: null,
    });
    expect(result.nextByPayee).toEqual([
      {
        payeeId: PAYEE_ID,
        currency: "usd",
        maturesAt: OCT_4,
        nextTrancheCents: null,
        creditCents: 12_000,
        heldCents: 0,
        debtAppliedCents: null,
      },
    ]);
    expect(result.byDate.map((b) => b.expectedCents)).toEqual([null, null]);
    expect(result.currencyTotals).toEqual([
      {
        currency: "usd",
        creditCents: 16_000,
        debtAppliedCents: null,
        expectedCents: null,
        trancheCount: 2,
      },
    ]);
    expect(reportError).toHaveBeenCalledWith(
      failure,
      expect.objectContaining({
        tags: { useCase: "listUpcomingPayouts", step: "applyDebt" },
      }),
    );
  });

  it("refuses unknown input keys (strict schema survives the omit)", async () => {
    const { authz } = authzWith(true);
    const { caller } = createCaller(
      { listUpcomingPayouts: platformRouter.listUpcomingPayouts },
      { actorHumanId: ACTOR_ID, authz, repos: makeUpcomingRepos() },
    );
    const err = await caller
      .listUpcomingPayouts({ cursor: "x" } as never)
      .then(
        () => null,
        (e: unknown) => e as { code?: string; message?: string },
      );
    expect(err?.code).toBe("BAD_REQUEST");
    expect(err?.message).toContain("cursor");
  });
});

describe("platform.getPlatformRevenue", () => {
  it("rejects an unauthenticated caller", async () => {
    const { caller } = createCaller(
      { getPlatformRevenue: platformRouter.getPlatformRevenue },
      { actorHumanId: null, repos: makeRevenueRepos() },
    );
    await expect(caller.getPlatformRevenue()).rejects.toThrow(/unauthorized/i);
  });

  it("rejects a non-staff caller via the use case's STAFF_ONLY gate without reading any money", async () => {
    const repos = makeRevenueRepos();
    const { authz, hasStaffRole } = authzWith(false);
    const { caller } = createCaller(
      { getPlatformRevenue: platformRouter.getPlatformRevenue },
      { actorHumanId: ACTOR_ID, authz, repos },
    );

    await expect(caller.getPlatformRevenue()).rejects.toThrow(
      /forbidden|staff/i,
    );
    expect(hasStaffRole).toHaveBeenCalledWith({
      actorHumanId: ACTOR_ID,
      requiredRoles: ["ADMIN", "SUPPORT"],
    });
    expect(repos.analytics.sumPlatformRevenueByCurrency).not.toHaveBeenCalled();
    expect(
      repos.payoutItems.sumConnectAccountFeesByCurrency,
    ).not.toHaveBeenCalled();
  });

  it("returns per-currency charges, both cost lines and the NET, each carrying its coverage", async () => {
    const repos = makeRevenueRepos();
    const { authz } = authzWith(true);
    const { caller } = createCaller(
      { getPlatformRevenue: platformRouter.getPlatformRevenue },
      { actorHumanId: ACTOR_ID, authz, repos },
    );

    const result = await caller.getPlatformRevenue();

    expect(result.rows).toEqual([
      {
        currency: "usd",
        ticketVolumeCents: 33_725,
        platformFeesChargedCents: 1_124,
        platformFeesByMode: {
          passThroughCents: 1_000,
          absorbCents: 100,
          unknownCents: 24,
        },
        taxCollectedHeldForRemittanceCents: 2_781,
        orderCount: 42,
        connectAccountFeesRecoveredCents: 200,
        payoutItemCount: 4,
        // Fully measured: cents, no reason, 5 of 5.
        feesReturnedCents: 166,
        feesReturnedUnavailableReason: null,
        feesReturnedCoverage: { measured: 5, total: 5 },
        // Partial by construction: the number rides with its coverage so a
        // 30-of-42 cost cannot be read as a complete one.
        processorCostCents: 1_050,
        processorCostUnavailableReason: "partial_coverage",
        processorCostCoverage: { measured: 30, total: 42, parked: 2 },
        // A real net, over 28 of 42 orders, labelled as partial. SIGNED and
        // unclamped; `total` is orderCount, not the cost lines' denominator.
        netKeptCents: 1_408,
        netKeptUnavailableReason: "partial_coverage",
        netKeptCoverage: { measured: 28, total: 42 },
      },
    ]);
    expect(result.statuses).toEqual([
      "SUCCEEDED",
      "PART_REFUNDED",
      "REFUNDED",
      "DISPUTED",
    ]);
    expect(result.recoveredCostsResolved).toBe(true);
    // The payload-wide net flags are GONE — the output schema is strict, so
    // a reintroduced `netKeptUnavailable` would fail validation here.
    expect(result).not.toHaveProperty("netKeptUnavailable");
    expect(result).not.toHaveProperty("netKeptUnavailableReason");
  });

  it("refuses unknown input keys (strict schema survives the omit)", async () => {
    const { authz } = authzWith(true);
    const { caller } = createCaller(
      { getPlatformRevenue: platformRouter.getPlatformRevenue },
      { actorHumanId: ACTOR_ID, authz, repos: makeRevenueRepos() },
    );
    const err = await caller
      .getPlatformRevenue({ currency: "usd" } as never)
      .then(
        () => null,
        (e: unknown) => e as { code?: string; message?: string },
      );
    expect(err?.code).toBe("BAD_REQUEST");
    expect(err?.message).toContain("currency");
  });
});
