import { describe, expect, it, vi } from "vitest";

import type {
  PayeeLedgerEntryRecord,
  PayeeLedgerPayableBalance,
  PayeeLedgerUpcomingMaturity,
} from "@th/ports/repos/payee-ledger";

import {
  getOrgPayoutOverview,
  getOrgPayoutOverviewOutputSchema,
  ORG_PAYOUT_OVERVIEW_LINES_PER_TRANCHE,
  ORG_PAYOUT_OVERVIEW_MAX_TRANCHES,
  ORG_PAYOUT_OVERVIEW_RECENT_PAYOUTS,
  ORG_PAYOUT_OVERVIEW_TIMEOUT_MS,
  payoutOverdueVerdict,
  type GetOrgPayoutOverviewDeps,
} from "../get-org-payout-overview";
// The cycle the overdue verdict waits out, imported rather than retyped: a
// literal 36h here would keep passing after the batch was rescheduled and the
// constant moved with it.
import { PAYOUT_BATCH_CYCLE_MS } from "../_shared/payout-batch-cycle";
// The batch's own literal, imported rather than retyped: a hard-coded 1000
// here would keep passing after the batch moved its threshold.
import { DEFAULT_PAYOUT_MINIMUM_CENTS } from "../../settlements/run-batch";

const ACTOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_ID = "11111111-1111-4111-8111-111111111111";
const PAYEE = "payee-org";
const EVENT_ID = "33333333-3333-4333-8333-333333333333";

const NOW = new Date("2026-09-14T12:00:00.000Z");
const OCT_4 = new Date("2026-10-04T00:00:00.000Z");
const OCT_11 = new Date("2026-10-11T00:00:00.000Z");

const BUDGET = { statementTimeoutMs: ORG_PAYOUT_OVERVIEW_TIMEOUT_MS };

function tranche(
  overrides: Partial<PayeeLedgerUpcomingMaturity> = {},
): PayeeLedgerUpcomingMaturity {
  return {
    payeeId: PAYEE,
    currency: "usd",
    maturesAt: OCT_4,
    creditCents: 12_000,
    heldCents: 0,
    creditCount: 3,
    ...overrides,
  };
}

function payable(
  overrides: Partial<PayeeLedgerPayableBalance> = {},
): PayeeLedgerPayableBalance {
  return {
    payeeId: PAYEE,
    currency: "usd",
    payableCents: 0,
    oldestMaturedAt: null,
    ...overrides,
  };
}

function credit(
  overrides: Partial<PayeeLedgerEntryRecord> = {},
): PayeeLedgerEntryRecord {
  return {
    id: "entry-1",
    idempotencyKey: "k1",
    payeeId: PAYEE,
    type: "SETTLEMENT_CREDIT",
    amountCents: 4_000,
    currency: "usd",
    sourceKind: "order",
    sourceId: "order-1",
    orderId: "order-1",
    settlementId: null,
    disputeId: null,
    relatedEntryId: null,
    availableAt: OCT_4,
    consumedByEntryId: null,
    description: "Ticket sales",
    metadata: null,
    createdAt: new Date("2026-09-10T00:00:00.000Z"),
    ...overrides,
  };
}

function payoutItem(overrides: Record<string, unknown> = {}) {
  return {
    id: "item-1",
    payoutId: "payout-1",
    payeeId: PAYEE,
    subjectType: "ORGANIZATION" as const,
    subjectId: ORG_ID,
    currency: "usd",
    amountCents: 50_000,
    netCents: 48_700,
    connectAccountFeeCents: 200,
    recoveredDebtCents: 0,
    reserveHeldCents: 1_100,
    reserveReleasedCents: 0,
    status: "transferred" as const,
    transferredAt: new Date("2026-09-06T00:00:00.000Z"),
    failedAt: null,
    failureReason: null,
    stripeTransferId: "tr_123",
    occurredAt: new Date("2026-09-06T00:00:00.000Z"),
    scheduledFor: new Date("2026-09-05T00:00:00.000Z"),
    payoutStatus: "completed",
    processorBatchId: "batch_1",
    createdAt: new Date("2026-09-05T00:00:00.000Z"),
    ...overrides,
  };
}

type Options = {
  allowed?: boolean;
  payeeRef?: { id: string } | null;
  payeeRow?: Record<string, unknown> | null;
  balance?: Partial<{
    ledgerBalanceCents: number;
    pendingHoldCents: number;
    reserveCents: number;
  }>;
  balanceFail?: boolean;
  payables?: PayeeLedgerPayableBalance[];
  payableFail?: boolean;
  maturities?: PayeeLedgerUpcomingMaturity[];
  maturityFail?: boolean;
  entriesByCall?: PayeeLedgerEntryRecord[][];
  entriesFail?: boolean;
  attributionFail?: boolean;
  historyItems?: ReturnType<typeof payoutItem>[];
  historyFail?: boolean;
  /** `undefined` → a GLOBAL policy carrying 1_000. `null` → NO policy row. */
  feePolicy?: { payoutMinimumCents: number } | null;
  feePolicyFail?: boolean;
  /** Drops `repos.feePolicies` entirely, proving the read is really issued. */
  omitFeePolicies?: boolean;
};

function makeDeps(options: Options = {}) {
  const canFinanceOrg = vi.fn(async () => ({
    allowed: options.allowed ?? true,
  }));
  const getBySubject = vi.fn(async () =>
    options.payeeRef === undefined ? { id: PAYEE } : options.payeeRef,
  );
  const getById = vi.fn(async () =>
    options.payeeRow === undefined
      ? { id: PAYEE, defaultCurrency: "USD" }
      : options.payeeRow,
  );
  const balanceFailure = new Error("balance read failed");
  const getBalance = vi.fn(async () => {
    if (options.balanceFail) throw balanceFailure;
    return {
      payeeId: PAYEE,
      currency: "usd",
      ledgerBalanceCents: 30_000,
      pendingHoldCents: 0,
      reserveCents: 0,
      ...options.balance,
    };
  });
  const payableFailure = new Error("payable read timed out");
  const listPayableBalances = vi.fn(async () => {
    if (options.payableFail) throw payableFailure;
    return options.payables ?? [];
  });
  const maturityFailure = new Error("maturity read timed out");
  const listUpcomingMaturities = vi.fn(async () => {
    if (options.maturityFail) throw maturityFailure;
    return options.maturities ?? [];
  });
  const entriesFailure = new Error("entry read failed");
  let entryCall = 0;
  const listEntries = vi.fn(async () => {
    if (options.entriesFail) throw entriesFailure;
    const batch = options.entriesByCall?.[entryCall] ?? [];
    entryCall += 1;
    return batch;
  });
  const attributionFailure = new Error("attribution read failed");
  const getEventAttributionByIds = vi.fn(async (ids: string[]) => {
    if (options.attributionFail) throw attributionFailure;
    return new Map(
      ids.map((id) => [
        id,
        {
          orderId: id,
          orderCode: `TH-${id}`,
          kind: "TICKETING" as const,
          eventId: EVENT_ID,
          eventTitle: "Basement Show",
          eventSlug: "basement-show",
          eventStartsAt: OCT_4,
        },
      ]),
    );
  });
  const historyFailure = new Error("history read failed");
  const listHistory = vi.fn(async () => {
    if (options.historyFail) throw historyFailure;
    return {
      items: options.historyItems ?? [payoutItem()],
      pageInfo: {
        cursorField: "occurredAt",
        nextCursor: null,
        limit: 5,
        hasNextPage: false,
      },
      total: 1,
    };
  });

  const feePolicyFailure = new Error("fee policy read timed out");
  const resolveEffective = vi.fn(async () => {
    if (options.feePolicyFail) throw feePolicyFailure;
    return options.feePolicy === undefined
      ? { payoutMinimumCents: 1_000 }
      : options.feePolicy;
  });

  const logger = {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  };
  logger.child.mockReturnValue(logger);
  const reportError = vi.fn();

  const deps = {
    repos: {
      payeeLedger: {
        getBalance,
        listPayableBalances,
        listUpcomingMaturities,
        listEntries,
      },
      payees: { getBySubject, getById },
      payoutItems: { listHistory },
      orders: { getEventAttributionByIds },
      // Omittable ON PURPOSE. The deps here are cast, so TypeScript cannot
      // prove this surface is reached; a test that drops it and still sees
      // `minimumResolved: false` proves the read is LIVE rather than dead.
      ...(options.omitFeePolicies ? {} : { feePolicies: { resolveEffective } }),
    },
    authz: { canFinanceOrg },
    clock: { now: () => NOW },
    logger,
    reportError,
  } as unknown as GetOrgPayoutOverviewDeps;

  return {
    deps,
    canFinanceOrg,
    getBySubject,
    getBalance,
    listPayableBalances,
    listUpcomingMaturities,
    listEntries,
    getEventAttributionByIds,
    listHistory,
    resolveEffective,
    logger,
    reportError,
    feePolicyFailure,
    balanceFailure,
    payableFailure,
    maturityFailure,
    entriesFailure,
    attributionFailure,
    historyFailure,
  };
}

const run = async (h: ReturnType<typeof makeDeps>) => {
  const out = await getOrgPayoutOverview(h.deps, {
    actorHumanId: ACTOR,
    orgId: ORG_ID,
  });
  // Parse the real output schema on EVERY call: the test file is excluded
  // from every tsconfig in the repo, so this is what actually catches shape
  // drift.
  return getOrgPayoutOverviewOutputSchema.parse(out);
};

describe("getOrgPayoutOverview — authz", () => {
  it("refuses an actor without org finance permission, BEFORE any read", async () => {
    const h = makeDeps({ allowed: false });

    await expect(
      getOrgPayoutOverview(h.deps, { actorHumanId: ACTOR, orgId: ORG_ID }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(h.canFinanceOrg).toHaveBeenCalledWith({
      actorHumanId: ACTOR,
      orgId: ORG_ID,
    });
    expect(h.getBySubject).not.toHaveBeenCalled();
    expect(h.getBalance).not.toHaveBeenCalled();
    // The fee-policy read moved ABOVE the payee lookup; it must still sit
    // BELOW the authz gate.
    expect(h.resolveEffective).not.toHaveBeenCalled();
  });

  it("rejects an unknown input key (strict schema)", async () => {
    const h = makeDeps();

    await expect(
      getOrgPayoutOverview(h.deps, {
        actorHumanId: ACTOR,
        orgId: ORG_ID,
        payeeId: PAYEE,
      }),
    ).rejects.toBeTruthy();
  });
});

describe("getOrgPayoutOverview — no payee", () => {
  it("returns an honest EMPTY overview, not an error and not unknown", async () => {
    const h = makeDeps({ payeeRef: null });

    const out = await run(h);

    expect(out).toEqual({
      payeeId: null,
      currency: "usd",
      otherCurrencies: [],
      balanceCents: 0,
      payableCents: 0,
      payableResolved: true,
      pendingHoldCents: 0,
      reserveCents: 0,
      // The threshold is NAMED even with no payee — a brand-new org is told
      // what it will have to clear. The VERDICT is null, not false: there is
      // no payable to measure.
      payoutMinimumCents: 1_000,
      minimumResolved: true,
      belowMinimum: null,
      // Same null, same reason: there is nothing to be overdue. A FALSE here
      // would read as "checked, and it is fine", which is a claim about an
      // org we never looked anything up for.
      payoutOverdue: null,
      upcoming: [],
      upcomingTruncated: false,
      upcomingTrancheCount: 0,
      upcomingCreditCents: 0,
      upcomingExpectedCents: 0,
      upcomingResolved: true,
      attributionResolved: true,
      recentPayouts: [],
      historyResolved: true,
      // 07:00 CDT on 14 Sep: the batch next runs at midnight Central tonight.
      nextPayoutRun: { runAt: "2026-09-15T05:00:00.000Z", night: "2026-09-14" },
      asOf: NOW,
    });
    // Not one LEDGER read was issued. The fee policy is the deliberate
    // exception — it runs before the payee lookup so the threshold can be
    // named here — and it is asserted separately below.
    expect(h.resolveEffective).toHaveBeenCalledTimes(1);
    expect(h.getBalance).not.toHaveBeenCalled();
    expect(h.listPayableBalances).not.toHaveBeenCalled();
    expect(h.listUpcomingMaturities).not.toHaveBeenCalled();
    expect(h.listHistory).not.toHaveBeenCalled();
  });

  it("asks the payee repo for the ORG subject", async () => {
    const h = makeDeps({ payeeRef: null });

    await run(h);

    expect(h.getBySubject).toHaveBeenCalledWith({
      type: "ORGANIZATION",
      id: ORG_ID,
    });
  });

  it("treats a payee row that vanished between reads as no payee, not a 500", async () => {
    const h = makeDeps({ payeeRow: null });

    const out = await run(h);

    expect(out.payeeId).toBeNull();
    expect(h.logger.error).toHaveBeenCalledWith(
      "org_payout_overview_payee_row_missing",
      { payeeId: PAYEE },
    );
  });
});

describe("getOrgPayoutOverview — the two numbers", () => {
  it("reports balance and payable SEPARATELY, and never merges them", async () => {
    const h = makeDeps({
      balance: { ledgerBalanceCents: 30_000, pendingHoldCents: 500, reserveCents: 700 },
      payables: [payable({ payableCents: 8_000 })],
      maturities: [tranche({ creditCents: 22_000 })],
    });

    const out = await run(h);

    expect(out.balanceCents).toBe(30_000);
    expect(out.payableCents).toBe(8_000);
    expect(out.pendingHoldCents).toBe(500);
    expect(out.reserveCents).toBe(700);
    expect(out.upcomingCreditCents).toBe(22_000);
    // The balance is NOT payable + upcoming and is never asserted to be.
    expect(out.payableResolved).toBe(true);
  });

  it("normalises the payee's currency and asks the ledger in it", async () => {
    const h = makeDeps();

    const out = await run(h);

    expect(out.currency).toBe("usd");
    expect(h.getBalance).toHaveBeenCalledWith(PAYEE, "usd");
  });

  it("an ABSENT payable cell is a true ZERO, not unknown", async () => {
    const h = makeDeps({ payables: [] });

    const out = await run(h);

    expect(out.payableCents).toBe(0);
    expect(out.payableResolved).toBe(true);
  });

  it("reports a NEGATIVE payable as the debt it is, unclamped", async () => {
    const h = makeDeps({ payables: [payable({ payableCents: -4_500 })] });

    const out = await run(h);

    expect(out.payableCents).toBe(-4_500);
  });

  // ── Correct WITHOUT trusting the adapter's narrowing ─────────────────────
  // `listPayableBalances(asOf, [payeeId])` narrows in SQL, so these rows
  // cannot arrive today. The arithmetic is keyed on each row's OWN payee
  // anyway, so a superset-returning adapter could never fold another org's
  // money into this org's headline. Every other fake in this file returns
  // single-payee rows, which is exactly why that drift would otherwise ship
  // green.
  it("ignores a payable cell belonging to ANOTHER payee", async () => {
    const h = makeDeps({
      payables: [
        payable({ payableCents: 600 }),
        // SAME currency — the row that would actually corrupt the headline,
        // rather than merely be disclosed under another heading.
        payable({ payeeId: "someone-else", payableCents: 90_000 }),
        payable({
          payeeId: "someone-else",
          currency: "gbp",
          payableCents: 90_000,
        }),
      ],
    });

    const out = await run(h);

    // Not 90_600, and not 90_000 under a `gbp` heading either.
    expect(out.payableCents).toBe(600);
    // Nor is the other org's currency announced as this one's.
    expect(out.otherCurrencies).toEqual([]);
  });

  it("nets debt only against THIS payee's own negative cell", async () => {
    const h = makeDeps({
      payables: [
        payable({ payableCents: 0 }),
        payable({ payeeId: "someone-else", payableCents: -8_000 }),
      ],
      maturities: [tranche({ creditCents: 12_000 })],
    });

    const out = await run(h);

    // Another payee's debt must never eat this payee's tranche.
    expect(out.upcoming[0]?.debtAppliedCents).toBe(0);
    expect(out.upcoming[0]?.expectedCents).toBe(12_000);
  });

  it("ignores an upcoming tranche belonging to ANOTHER payee", async () => {
    const h = makeDeps({
      maturities: [
        tranche({ creditCents: 12_000 }),
        tranche({
          payeeId: "someone-else",
          maturesAt: OCT_11,
          creditCents: 77_000,
        }),
      ],
    });

    const out = await run(h);

    expect(out.upcomingTrancheCount).toBe(1);
    // 89_000 here would be another org's money on this org's spine.
    expect(out.upcomingCreditCents).toBe(12_000);
    expect(out.upcoming).toHaveLength(1);
  });

  it("issues the ledger reads on TOP-LEVEL repos with the shared budget", async () => {
    const h = makeDeps({ maturities: [tranche()] });

    await run(h);

    expect(h.listPayableBalances).toHaveBeenCalledWith(NOW, [PAYEE], BUDGET);
    expect(h.listUpcomingMaturities).toHaveBeenCalledWith(NOW, [PAYEE], BUDGET);
  });

  it("names the next payout batch run from its own clock", async () => {
    const h = makeDeps({ maturities: [tranche()] });

    const out = await run(h);

    // NOW is 07:00 CDT on 14 Sep; the batch fires at the next Central midnight.
    expect(out.nextPayoutRun).toEqual({
      runAt: "2026-09-15T05:00:00.000Z",
      night: "2026-09-14",
    });
  });

  it("throws when the rollup balance — the one load-bearing read — fails", async () => {
    const h = makeDeps({ balanceFail: true });

    await expect(
      getOrgPayoutOverview(h.deps, { actorHumanId: ACTOR, orgId: ORG_ID }),
    ).rejects.toBe(h.balanceFailure);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE PAYOUT MINIMUM, ported from `get-payee-statement.ts`. Three states that
// must never collapse: it clears, it does not clear, we could not check.
// ─────────────────────────────────────────────────────────────────────────────
describe("getOrgPayoutOverview — the payout minimum", () => {
  it("CLEARS: a payable over the threshold is not flagged", async () => {
    const h = makeDeps({
      payables: [payable({ payableCents: 4_500 })],
      feePolicy: { payoutMinimumCents: 1_000 },
    });

    const out = await run(h);

    expect(out.payoutMinimumCents).toBe(1_000);
    expect(out.minimumResolved).toBe(true);
    expect(out.belowMinimum).toBe(false);
    // The money is untouched by the verdict either way.
    expect(out.payableCents).toBe(4_500);
    // ONE policy read on the normal path too — not one per tranche, not one
    // per call site. (The no-payee test pins the same count on its own path.)
    expect(h.resolveEffective).toHaveBeenCalledTimes(1);
  });

  it("is a verdict on THIS CURRENCY'S cell, never on the payee", async () => {
    // The batch applies the minimum per (payee, currency) cell, so a payee
    // whose default currency holds nothing can still be paid tonight out of
    // another one. The flag cannot see that cell; `otherCurrencies` is the
    // disclosure, and this test pins the pairing the field's doc points at.
    const h = makeDeps({
      payeeRow: { id: PAYEE, defaultCurrency: "EUR" },
      payables: [
        payable({ currency: "usd", payableCents: 50_000 }),
        // No `eur` cell at all.
      ],
      feePolicy: { payoutMinimumCents: 1_000 },
    });

    const out = await run(h);

    expect(out.currency).toBe("eur");
    expect(out.payableCents).toBe(0);
    // TRUE of the eur cell, and true of nothing else. The batch will pay the
    // usd cell tonight, and this page must not be read as denying that.
    expect(out.belowMinimum).toBe(true);
    // The disclosure that stops the flag being a lie about the payee.
    expect(out.otherCurrencies).toEqual(["usd"]);
  });

  it("DOES NOT CLEAR: $6 on a Friday is flagged, and is NOT an error", async () => {
    const h = makeDeps({
      payables: [payable({ payableCents: 600 })],
      feePolicy: { payoutMinimumCents: 1_000 },
    });

    const out = await run(h);

    expect(out.belowMinimum).toBe(true);
    expect(out.minimumResolved).toBe(true);
    expect(out.payoutMinimumCents).toBe(1_000);
    // The reason the block exists: the money is REAL and still sitting there.
    expect(out.payableCents).toBe(600);
    expect(out.balanceCents).toBe(30_000);
    // A below-minimum payee is an ordinary state, not a swallow.
    expect(h.logger.error).not.toHaveBeenCalled();
    expect(h.reportError).not.toHaveBeenCalled();
  });

  it("reads the GLOBAL policy at the overview's own clock", async () => {
    const h = makeDeps();

    await run(h);

    expect(h.resolveEffective).toHaveBeenCalledWith({
      scopeType: "GLOBAL",
      scopeId: null,
      at: NOW,
    });
  });

  it("NO POLICY ROW is a defined answer: the batch's own default, resolved", async () => {
    const h = makeDeps({
      feePolicy: null,
      payables: [payable({ payableCents: 600 })],
    });

    const out = await run(h);

    expect(out.payoutMinimumCents).toBe(DEFAULT_PAYOUT_MINIMUM_CENTS);
    expect(out.minimumResolved).toBe(true);
    expect(out.belowMinimum).toBe(true);
  });

  it("UNREADABLE: null and unresolved — NEVER the batch default", async () => {
    const h = makeDeps({
      feePolicyFail: true,
      payables: [payable({ payableCents: 600 })],
    });

    const out = await run(h);

    expect(out.minimumResolved).toBe(false);
    expect(out.payoutMinimumCents).toBeNull();
    // THE ASSERTION MOST LIKELY TO BE WRITTEN WRONG. Substituting the default
    // makes a test pass and makes the product accuse a payee of missing a
    // threshold nobody read.
    //
    // THIS IS THE BOUNDARY GUARD. `readPayoutMinimum` returns a discriminated
    // union, so a substitution INSIDE the helper is a compile error — but the
    // DTO is flat (deliberately, to match its `get-payee-statement.ts`
    // sibling), so the union's guarantee stops at the assembly site and a
    // `?? DEFAULT_PAYOUT_MINIMUM_CENTS` there would compile clean. Nothing
    // else in the repo catches that. This assertion is the whole defence.
    expect(out.payoutMinimumCents).not.toBe(DEFAULT_PAYOUT_MINIMUM_CENTS);
    // NULL, not false: `600 < 1000` is unknowable without the threshold.
    expect(out.belowMinimum).toBeNull();
    expect(out.belowMinimum).not.toBe(false);
  });

  it("an UNREADABLE policy does NOT fail the overview — one line, not the page", async () => {
    const h = makeDeps({
      feePolicyFail: true,
      payables: [payable({ payableCents: 600 })],
      maturities: [tranche()],
      entriesByCall: [[credit()]],
    });

    const out = await run(h);

    // Every other figure survives intact.
    expect(out.balanceCents).toBe(30_000);
    expect(out.payableCents).toBe(600);
    expect(out.payableResolved).toBe(true);
    expect(out.upcomingResolved).toBe(true);
    expect(out.upcomingCreditCents).toBe(12_000);
    expect(out.upcoming[0]?.lines).toHaveLength(1);
    expect(out.historyResolved).toBe(true);
    expect(out.recentPayouts).toHaveLength(1);
    // ERROR, not warn — warn is not captured by Sentry — plus the reporter.
    expect(h.logger.error).toHaveBeenCalledWith(
      "org_payout_overview_fee_policy_lookup_failed",
      { err: h.feePolicyFailure },
    );
    expect(h.logger.warn).not.toHaveBeenCalled();
    expect(h.reportError).toHaveBeenCalledWith(h.feePolicyFailure, {
      tags: { useCase: "getOrgPayoutOverview", step: "resolveFeePolicy" },
    });
  });

  it("an UNREADABLE PAYABLE also blanks the verdict, with the threshold still named", async () => {
    const h = makeDeps({ payableFail: true });

    const out = await run(h);

    // The threshold was read fine; there is simply nothing to measure.
    expect(out.payoutMinimumCents).toBe(1_000);
    expect(out.minimumResolved).toBe(true);
    expect(out.payableCents).toBeNull();
    expect(out.belowMinimum).toBeNull();
    expect(out.belowMinimum).not.toBe(false);
  });

  it("a NEGATIVE payable is below the minimum, not silently clearing it", async () => {
    const h = makeDeps({ payables: [payable({ payableCents: -4_500 })] });

    const out = await run(h);

    expect(out.payableCents).toBe(-4_500);
    expect(out.belowMinimum).toBe(true);
  });

  it("the fee-policy read is LIVE: drop the repo and the flag goes false", async () => {
    // The deps object is cast, so nothing type-checks this surface. If the
    // use case ever stopped calling it, this test would report a confident
    // `minimumResolved: true` instead — which is exactly how a fake makes a
    // suite pass over dead code.
    const h = makeDeps({ omitFeePolicies: true });

    const out = await run(h);

    expect(out.minimumResolved).toBe(false);
    expect(out.payoutMinimumCents).toBeNull();
    expect(out.balanceCents).toBe(30_000);
  });
});

describe("getOrgPayoutOverview — the debt walk", () => {
  it("nets today's debt against the soonest tranches, soonest first", async () => {
    const h = makeDeps({
      payables: [payable({ payableCents: -7_000 })],
      maturities: [
        tranche({ maturesAt: OCT_4, creditCents: 5_000 }),
        tranche({ maturesAt: OCT_11, creditCents: 9_000 }),
      ],
    });

    const out = await run(h);

    expect(
      out.upcoming.map((t) => [t.creditCents, t.debtAppliedCents, t.expectedCents]),
    ).toEqual([
      [5_000, 5_000, 0],
      [9_000, 2_000, 7_000],
    ]);
    expect(out.upcomingCreditCents).toBe(14_000);
    expect(out.upcomingExpectedCents).toBe(7_000);
  });

  it("NEVER subtracts heldCents — the hold is already inside today's payable", async () => {
    // The trace from the staff view: credit 7,000 under a 3,000 hold, payable
    // −3,000 today. The batch pays 4,000.
    const h = makeDeps({
      payables: [payable({ payableCents: -3_000 })],
      maturities: [tranche({ creditCents: 7_000, heldCents: 3_000 })],
    });

    const out = await run(h);

    expect(out.upcoming[0]).toMatchObject({
      creditCents: 7_000,
      heldCents: 3_000,
      debtAppliedCents: 3_000,
      expectedCents: 4_000,
    });
  });

  it("a FAILED payable nulls the payable AND every debt-dependent figure", async () => {
    const h = makeDeps({
      payableFail: true,
      maturities: [tranche({ creditCents: 6_000 })],
    });

    const out = await run(h);

    expect(out.payableResolved).toBe(false);
    expect(out.payableCents).toBeNull();
    expect(out.upcoming[0]).toMatchObject({
      creditCents: 6_000,
      debtAppliedCents: null,
      expectedCents: null,
    });
    expect(out.upcomingExpectedCents).toBeNull();
    // Gross survives — it came from a read that DID land.
    expect(out.upcomingCreditCents).toBe(6_000);
    expect(h.logger.error).toHaveBeenCalledWith(
      "org_payout_overview_payable_lookup_failed",
      expect.objectContaining({ err: h.payableFailure }),
    );
    expect(h.reportError).toHaveBeenCalledWith(
      h.payableFailure,
      expect.objectContaining({
        tags: { useCase: "getOrgPayoutOverview", step: "listPayableBalances" },
      }),
    );
  });

  it("an EMPTY horizon under a FAILED payable reads unknown, never a confident 0", async () => {
    const h = makeDeps({ payableFail: true, maturities: [] });

    const out = await run(h);

    expect(out.upcomingExpectedCents).toBeNull();
  });
});

describe("getOrgPayoutOverview — the maturity feed", () => {
  it("a FAILED maturity read says 'could not check', never 'nothing coming'", async () => {
    const h = makeDeps({ maturityFail: true });

    const out = await run(h);

    expect(out.upcomingResolved).toBe(false);
    expect(out.upcoming).toEqual([]);
    expect(out.upcomingCreditCents).toBeNull();
    expect(out.upcomingExpectedCents).toBeNull();
    expect(out.upcomingTrancheCount).toBeNull();
    expect(h.reportError).toHaveBeenCalledWith(
      h.maturityFailure,
      expect.objectContaining({
        tags: {
          useCase: "getOrgPayoutOverview",
          step: "listUpcomingMaturities",
        },
      }),
    );
  });

  it("an empty horizon with a RESOLVED read is a real, resolved zero", async () => {
    const h = makeDeps({ maturities: [] });

    const out = await run(h);

    expect(out.upcomingResolved).toBe(true);
    expect(out.upcomingCreditCents).toBe(0);
    expect(out.upcomingExpectedCents).toBe(0);
  });

  it("drops tranches in ANOTHER currency from the spine but DISCLOSES the currency", async () => {
    const h = makeDeps({
      payables: [payable({ currency: "eur", payableCents: 900 })],
      maturities: [
        tranche({ currency: "usd", creditCents: 4_000 }),
        tranche({ currency: "eur", creditCents: 900 }),
      ],
    });

    const out = await run(h);

    expect(out.upcoming).toHaveLength(1);
    expect(out.upcomingCreditCents).toBe(4_000);
    expect(out.otherCurrencies).toEqual(["eur"]);
  });

  it("truncates the spine but totals over EVERY tranche", async () => {
    const over = ORG_PAYOUT_OVERVIEW_MAX_TRANCHES + 3;
    const h = makeDeps({
      maturities: Array.from({ length: over }, (_, i) =>
        tranche({
          maturesAt: new Date(OCT_4.getTime() + i * 86_400_000),
          creditCents: 100,
        }),
      ),
    });

    const out = await run(h);

    expect(out.upcoming).toHaveLength(ORG_PAYOUT_OVERVIEW_MAX_TRANCHES);
    expect(out.upcomingTruncated).toBe(true);
    expect(out.upcomingTrancheCount).toBe(over);
    // Totals ignore the display cap — a truncated list must never understate.
    expect(out.upcomingCreditCents).toBe(over * 100);
    expect(out.upcomingExpectedCents).toBe(over * 100);
  });
});

describe("getOrgPayoutOverview — tranche attribution", () => {
  it("windows each tranche HALF-OPEN on the PREVIOUS tranche, never on asOf", async () => {
    const h = makeDeps({
      maturities: [
        tranche({ maturesAt: OCT_4, creditCents: 4_000 }),
        tranche({ maturesAt: OCT_11, creditCents: 9_000 }),
      ],
      entriesByCall: [[credit()], [credit({ id: "entry-2", availableAt: OCT_11 })]],
    });

    await run(h);

    expect(h.listEntries).toHaveBeenCalledTimes(2);
    // First tranche: lower bound is `asOf`.
    expect(h.listEntries.mock.calls[0]).toEqual([
      PAYEE,
      {
        currency: "usd",
        types: ["SETTLEMENT_CREDIT"],
        availableAtAfter: NOW,
        availableAtBefore: OCT_4,
        excludeBlockedCredits: true,
        limit: ORG_PAYOUT_OVERVIEW_LINES_PER_TRANCHE + 1,
      },
    ]);
    // Second tranche: lower bound is the FIRST tranche's date — not `asOf`,
    // which would list the 4 Oct credits under the 11 Oct heading too.
    expect(h.listEntries.mock.calls[1]).toEqual([
      PAYEE,
      {
        currency: "usd",
        types: ["SETTLEMENT_CREDIT"],
        availableAtAfter: OCT_4,
        availableAtBefore: OCT_11,
        excludeBlockedCredits: true,
        limit: ORG_PAYOUT_OVERVIEW_LINES_PER_TRANCHE + 1,
      },
    ]);
  });

  it("resolves each credit line to its order and the show it came from", async () => {
    const h = makeDeps({
      maturities: [tranche()],
      entriesByCall: [[credit({ orderId: "order-9", amountCents: 4_000 })]],
    });

    const out = await run(h);

    expect(h.getEventAttributionByIds).toHaveBeenCalledWith(["order-9"]);
    expect(out.attributionResolved).toBe(true);
    expect(out.upcoming[0]!.lines).toEqual([
      {
        entryId: "entry-1",
        amountCents: 4_000,
        currency: "usd",
        availableAt: OCT_4,
        createdAt: new Date("2026-09-10T00:00:00.000Z"),
        orderId: "order-9",
        orderCode: "TH-order-9",
        eventId: EVENT_ID,
        eventTitle: "Basement Show",
        eventSlug: "basement-show",
        eventStartsAt: OCT_4,
      },
    ]);
    expect(out.upcoming[0]!.linesResolved).toBe(true);
    expect(out.upcoming[0]!.linesTruncated).toBe(false);
  });

  it("shows a line's EFFECTIVE maturity (the date it is bucketed under), not its stale availableAt", async () => {
    // A RESALE credit whose event moved later: stored availableAt 1 Oct, but
    // the claim window holds it to 4 Oct, which is the tranche it sits in.
    const STALE = new Date("2026-10-01T00:00:00.000Z");
    const h = makeDeps({
      maturities: [tranche({ maturesAt: OCT_4 })],
      entriesByCall: [
        [credit({ availableAt: STALE, effectiveAvailableAt: OCT_4 })],
      ],
    });

    const out = await run(h);

    expect(out.upcoming[0]!.lines[0]!.availableAt).toEqual(OCT_4);
  });

  it("issues ONE batched attribution read for every tranche's orders", async () => {
    const h = makeDeps({
      maturities: [tranche({ maturesAt: OCT_4 }), tranche({ maturesAt: OCT_11 })],
      entriesByCall: [
        [credit({ orderId: "order-a" })],
        [credit({ id: "e2", orderId: "order-b" })],
      ],
    });

    await run(h);

    expect(h.getEventAttributionByIds).toHaveBeenCalledTimes(1);
    expect(h.getEventAttributionByIds).toHaveBeenCalledWith([
      "order-a",
      "order-b",
    ]);
  });

  it("a FAILED line read empties that tranche's lines but keeps its money", async () => {
    const h = makeDeps({ maturities: [tranche({ creditCents: 12_000 })], entriesFail: true });

    const out = await run(h);

    expect(out.upcoming[0]).toMatchObject({
      creditCents: 12_000,
      lines: [],
      linesResolved: false,
    });
    expect(h.reportError).toHaveBeenCalledWith(
      h.entriesFailure,
      expect.objectContaining({
        tags: {
          useCase: "getOrgPayoutOverview",
          step: "listTrancheEntries",
        },
      }),
    );
  });

  it("a FAILED attribution read keeps every line, with the show fields UNKNOWN", async () => {
    const h = makeDeps({
      maturities: [tranche()],
      entriesByCall: [[credit({ orderId: "order-9" })]],
      attributionFail: true,
    });

    const out = await run(h);

    expect(out.attributionResolved).toBe(false);
    expect(out.upcoming[0]!.lines).toHaveLength(1);
    expect(out.upcoming[0]!.lines[0]).toMatchObject({
      orderId: "order-9",
      eventTitle: null,
      eventSlug: null,
    });
  });

  it("flags a truncated line list, because it no longer sums to the heading", async () => {
    const rows = Array.from(
      { length: ORG_PAYOUT_OVERVIEW_LINES_PER_TRANCHE + 1 },
      (_, i) => credit({ id: `e${i}`, orderId: `order-${i}` }),
    );
    const h = makeDeps({ maturities: [tranche()], entriesByCall: [rows] });

    const out = await run(h);

    expect(out.upcoming[0]!.lines).toHaveLength(
      ORG_PAYOUT_OVERVIEW_LINES_PER_TRANCHE,
    );
    expect(out.upcoming[0]!.linesTruncated).toBe(true);
  });

  it("skips the attribution read entirely when no line carries an order", async () => {
    const h = makeDeps({
      maturities: [tranche()],
      entriesByCall: [[credit({ orderId: null })]],
    });

    const out = await run(h);

    expect(h.getEventAttributionByIds).not.toHaveBeenCalled();
    expect(out.attributionResolved).toBe(true);
    expect(out.upcoming[0]!.lines[0]).toMatchObject({
      orderId: null,
      eventId: null,
    });
  });
});

describe("getOrgPayoutOverview — money already sent", () => {
  it("narrows the staff history read to THIS payee and shows every deduction", async () => {
    const h = makeDeps();

    const out = await run(h);

    expect(h.listHistory).toHaveBeenCalledWith({
      status: "all",
      payeeIds: [PAYEE],
      limit: ORG_PAYOUT_OVERVIEW_RECENT_PAYOUTS,
      cursor: null,
      statementTimeoutMs: ORG_PAYOUT_OVERVIEW_TIMEOUT_MS,
    });
    expect(out.recentPayouts[0]).toMatchObject({
      amountCents: 50_000,
      netCents: 48_700,
      connectAccountFeeCents: 200,
      reserveHeldCents: 1_100,
      stripeTransferId: "tr_123",
    });
    expect(out.historyResolved).toBe(true);
  });

  it("keeps a NULL netCents null — a pre-cutover row is not a $0 transfer", async () => {
    const h = makeDeps({ historyItems: [payoutItem({ netCents: null })] });

    const out = await run(h);

    expect(out.recentPayouts[0]!.netCents).toBeNull();
  });

  it("a FAILED history read reports unknown, not 'nothing was ever sent'", async () => {
    const h = makeDeps({ historyFail: true });

    const out = await run(h);

    expect(out.historyResolved).toBe(false);
    expect(out.recentPayouts).toEqual([]);
    expect(h.reportError).toHaveBeenCalledWith(
      h.historyFailure,
      expect.objectContaining({
        tags: { useCase: "getOrgPayoutOverview", step: "listPayoutHistory" },
      }),
    );
  });
});

describe("getOrgPayoutOverview — reporter discipline", () => {
  it("a THROWING reporter never turns a degraded overview into a failed one", async () => {
    const h = makeDeps({ payableFail: true, maturityFail: true, historyFail: true });
    h.reportError.mockImplementation(() => {
      throw new Error("sentry is down");
    });

    const out = await run(h);

    expect(out.payableResolved).toBe(false);
    expect(out.upcomingResolved).toBe(false);
    expect(out.historyResolved).toBe(false);
    expect(out.balanceCents).toBe(30_000);
  });

  it("a MISSING reporter never changes the result either", async () => {
    const h = makeDeps({ payableFail: true });
    (h.deps as { reportError?: unknown }).reportError = undefined;

    await expect(run(h)).resolves.toMatchObject({ payableResolved: false });
  });

  it("never demotes a swallow to logger.warn — warn is not captured by Sentry", async () => {
    const h = makeDeps({
      payableFail: true,
      maturityFail: true,
      historyFail: true,
    });

    await run(h);

    expect(h.logger.warn).not.toHaveBeenCalled();
    expect(h.logger.error).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// `payoutOverdue` — "your money cleared the minimum and nothing was sent".
//
// The verdict with the highest cost of being wrong on this page: TRUE tells an
// organiser their payout is stuck. Every test below is written from the
// direction of the FALSE ACCUSATION — what has to hold for us to say it, and
// which unknown has to blank it — rather than from the happy path.
// ─────────────────────────────────────────────────────────────────────────────

/** Comfortably more than one batch cycle before `NOW`. */
const MATURED_LONG_AGO = new Date(NOW.getTime() - 4 * 24 * 60 * 60 * 1000);
/** Matured, but the batch has not had its turn yet. */
const MATURED_MINUTES_AGO = new Date(NOW.getTime() - 5 * 60 * 1000);

/** A cell that cleared the minimum and has been waiting. */
const OVERDUE_CELL = [
  payable({ payableCents: 40_000, oldestMaturedAt: MATURED_LONG_AGO }),
];

describe("getOrgPayoutOverview — payoutOverdue", () => {
  it("TRUE: money cleared the minimum, nothing was ever sent, and it has waited a full cycle", async () => {
    const h = makeDeps({ payables: OVERDUE_CELL, historyItems: [] });

    const out = await run(h);

    expect(out.payoutOverdue).toBe(true);
    // The three facts the verdict is made of, asserted alongside it so a
    // future change cannot keep the boolean while losing its basis.
    expect(out.payableCents).toBe(40_000);
    expect(out.belowMinimum).toBe(false);
    expect(out.recentPayouts).toEqual([]);
  });

  it("FALSE: below the minimum — the batch holding the money is the rule working", async () => {
    const h = makeDeps({
      payables: [payable({ payableCents: 600, oldestMaturedAt: MATURED_LONG_AGO })],
      historyItems: [],
    });

    const out = await run(h);

    expect(out.belowMinimum).toBe(true);
    expect(out.payoutOverdue).toBe(false);
  });

  it("FALSE: payouts exist, so payouts are not stuck", async () => {
    const h = makeDeps({ payables: OVERDUE_CELL, historyItems: [payoutItem()] });

    const out = await run(h);

    expect(out.recentPayouts).toHaveLength(1);
    expect(out.payoutOverdue).toBe(false);
  });

  it("FALSE: the money matured hours ago, not a cycle ago — the batch has not run yet", async () => {
    const h = makeDeps({
      payables: [
        payable({
          payableCents: 40_000,
          oldestMaturedAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1000),
        }),
      ],
      historyItems: [],
    });

    const out = await run(h);

    // Everything else about this org looks exactly like the TRUE case.
    expect(out.payableCents).toBe(40_000);
    expect(out.belowMinimum).toBe(false);
    expect(out.recentPayouts).toEqual([]);
    expect(out.payoutOverdue).toBe(false);
  });

  it("THE FALSE ACCUSATION THIS FIELD EXISTS TO PREVENT: a brand-new org, minutes after its first credit matured", async () => {
    // Indistinguishable from a stuck payout on every input EXCEPT the clock:
    // real money, over the threshold, and no payout has ever been sent —
    // because this org has existed for one morning. Without the time
    // qualifier this org is told its money should already be gone.
    const h = makeDeps({
      payables: [
        payable({ payableCents: 40_000, oldestMaturedAt: MATURED_MINUTES_AGO }),
      ],
      historyItems: [],
    });

    const out = await run(h);

    expect(out.payoutOverdue).toBe(false);
    expect(out.payoutOverdue).not.toBe(true);
  });

  it("FALSE at EXACTLY one cycle, TRUE a millisecond later — the boundary is not overdue", async () => {
    const onTheBoundary = makeDeps({
      payables: [
        payable({
          payableCents: 40_000,
          oldestMaturedAt: new Date(NOW.getTime() - PAYOUT_BATCH_CYCLE_MS),
        }),
      ],
      historyItems: [],
    });
    const oneMsPast = makeDeps({
      payables: [
        payable({
          payableCents: 40_000,
          oldestMaturedAt: new Date(NOW.getTime() - PAYOUT_BATCH_CYCLE_MS - 1),
        }),
      ],
      historyItems: [],
    });

    expect((await run(onTheBoundary)).payoutOverdue).toBe(false);
    expect((await run(oneMsPast)).payoutOverdue).toBe(true);
  });

  it("FALSE with nothing payable — a resolved empty cell is measured, not unknown", async () => {
    const h = makeDeps({ payables: [], historyItems: [] });

    const out = await run(h);

    expect(out.payableCents).toBe(0);
    expect(out.payoutOverdue).toBe(false);
  });

  it("FALSE for carried-forward DEBT — a negative payable is not money waiting to be sent", async () => {
    const h = makeDeps({
      payables: [
        payable({ payableCents: -4_000, oldestMaturedAt: MATURED_LONG_AGO }),
      ],
      historyItems: [],
    });

    const out = await run(h);

    expect(out.payableCents).toBe(-4_000);
    expect(out.payoutOverdue).toBe(false);
  });
});

describe("getOrgPayoutOverview — payoutOverdue goes BLANK, never 'fine'", () => {
  it("NULL when the PAYABLE read failed — there is no figure to measure", async () => {
    const h = makeDeps({ payableFail: true, historyItems: [] });

    const out = await run(h);

    expect(out.payableResolved).toBe(false);
    expect(out.payoutOverdue).toBeNull();
    // A `false` here would say "checked, your payouts are on time" off the
    // back of a read that never came back.
    expect(out.payoutOverdue).not.toBe(false);
  });

  it("NULL when the FEE POLICY read failed — the exact bug this field is server-side to prevent", async () => {
    // The inputs otherwise spell out the TRUE case, so a rule written in the
    // wrong order lands on TRUE here and tells an organiser their money is
    // missing because a config row would not read.
    const h = makeDeps({
      feePolicyFail: true,
      payables: OVERDUE_CELL,
      historyItems: [],
    });

    const out = await run(h);

    expect(out.minimumResolved).toBe(false);
    expect(out.belowMinimum).toBeNull();
    expect(out.payoutOverdue).toBeNull();
    expect(out.payoutOverdue).not.toBe(false);
    expect(out.payoutOverdue).not.toBe(true);
    // The money is still on the page. Only the verdict went blank.
    expect(out.payableCents).toBe(40_000);
  });

  it("NULL when the HISTORY read failed — an empty list is unknown, not 'never paid'", async () => {
    const h = makeDeps({ payables: OVERDUE_CELL, historyFail: true });

    const out = await run(h);

    expect(out.historyResolved).toBe(false);
    expect(out.recentPayouts).toEqual([]);
    // The empty list is EXACTLY what the TRUE case looks like. Distinguishing
    // them is the whole job of `historyResolved`.
    expect(out.payoutOverdue).toBeNull();
    expect(out.payoutOverdue).not.toBe(false);
    expect(out.payoutOverdue).not.toBe(true);
  });

  it("NULL when the cell has money but no 'payable since' timestamp", async () => {
    // A positive payable whose balance came from non-credit entries only: the
    // port documents `oldestMaturedAt: null` there. Real, but it gives no
    // clock to measure the wait against, and we do not guess in either
    // direction.
    const h = makeDeps({
      payables: [payable({ payableCents: 40_000, oldestMaturedAt: null })],
      historyItems: [],
    });

    const out = await run(h);

    expect(out.payableCents).toBe(40_000);
    expect(out.payoutOverdue).toBeNull();
    expect(out.payoutOverdue).not.toBe(true);
    expect(out.payoutOverdue).not.toBe(false);
  });

  it("NULL for an org with NO PAYEE ROW — nothing failed and nothing is overdue", async () => {
    const h = makeDeps({ payeeRef: null });

    const out = await run(h);

    expect(out.payeeId).toBeNull();
    expect(out.payoutOverdue).toBeNull();
    // Both flags are true here, so a consumer must discriminate on `payeeId`
    // rather than treat the null as an outage.
    expect(out.payableResolved).toBe(true);
    expect(out.minimumResolved).toBe(true);
  });
});

describe("getOrgPayoutOverview — 'payable since' comes from the payable read already issued", () => {
  it("issues no extra read for the maturity timestamp", async () => {
    const h = makeDeps({ payables: OVERDUE_CELL, historyItems: [] });

    const out = await run(h);

    expect(out.payoutOverdue).toBe(true);
    // ONE payable read, the same one `payableCents` came from.
    expect(h.listPayableBalances).toHaveBeenCalledTimes(1);
  });

  it("folds two raw casings of one currency to the EARLIER date, not the last one seen", async () => {
    // Same cell, two casings: it has been waiting since the earlier date.
    // Taking the last row seen would shorten the wait to under a cycle and
    // silently answer FALSE.
    const h = makeDeps({
      payables: [
        payable({
          currency: "USD",
          payableCents: 30_000,
          oldestMaturedAt: MATURED_LONG_AGO,
        }),
        payable({
          currency: "usd",
          payableCents: 10_000,
          oldestMaturedAt: MATURED_MINUTES_AGO,
        }),
      ],
      historyItems: [],
    });

    const out = await run(h);

    expect(out.payableCents).toBe(40_000);
    expect(out.payoutOverdue).toBe(true);
  });

  it("ignores another currency's wait — the verdict is about THIS cell", async () => {
    const h = makeDeps({
      payables: [
        payable({ payableCents: 40_000, oldestMaturedAt: MATURED_MINUTES_AGO }),
        payable({
          currency: "cad",
          payableCents: 90_000,
          oldestMaturedAt: MATURED_LONG_AGO,
        }),
      ],
      historyItems: [],
    });

    const out = await run(h);

    expect(out.otherCurrencies).toEqual(["cad"]);
    expect(out.payoutOverdue).toBe(false);
  });

  it("ignores ANOTHER PAYEE's cell, exactly as the cents fold does", async () => {
    const h = makeDeps({
      payables: [
        payable({
          payeeId: "someone-else",
          payableCents: 90_000,
          oldestMaturedAt: MATURED_LONG_AGO,
        }),
        payable({ payableCents: 40_000, oldestMaturedAt: MATURED_MINUTES_AGO }),
      ],
      historyItems: [],
    });

    const out = await run(h);

    expect(out.payableCents).toBe(40_000);
    expect(out.payoutOverdue).toBe(false);
  });
});

describe("payoutOverdueVerdict — the ORDER of the branches", () => {
  const base = {
    payableCents: 40_000,
    payableResolved: true,
    minimumResolved: true,
    belowMinimum: false as boolean | null,
    historyResolved: true,
    recentPayoutCount: 0,
    oldestMaturedAt: MATURED_LONG_AGO,
    asOf: NOW,
  };

  it("says TRUE only when every input is known and every condition holds", () => {
    expect(payoutOverdueVerdict(base)).toBe(true);
  });

  it("tests the PAYABLE before the maturity clock", () => {
    // An org owed nothing has no `oldestMaturedAt` and never will. Testing
    // maturity first would blank this verdict for every such org, which is
    // most of them — an outage message on a page with nothing wrong.
    expect(
      payoutOverdueVerdict({
        ...base,
        payableCents: 0,
        oldestMaturedAt: null,
      }),
    ).toBe(false);
  });

  it("refuses a NULL belowMinimum rather than reading it as 'clears'", () => {
    const out = payoutOverdueVerdict({ ...base, belowMinimum: null });
    expect(out).toBeNull();
    expect(out).not.toBe(true);
  });

  it("never coalesces a null payable to zero", () => {
    const out = payoutOverdueVerdict({
      ...base,
      payableCents: null,
      payableResolved: false,
    });
    expect(out).toBeNull();
    expect(out).not.toBe(false);
  });

  it("blanks on an unreadable maturity date rather than treating NaN as ancient", () => {
    const out = payoutOverdueVerdict({
      ...base,
      oldestMaturedAt: new Date("not a date"),
    });
    expect(out).toBeNull();
    expect(out).not.toBe(true);
  });

  it("is FALSE, not TRUE, for a maturity date in the FUTURE", () => {
    expect(
      payoutOverdueVerdict({
        ...base,
        oldestMaturedAt: new Date(NOW.getTime() + 60_000),
      }),
    ).toBe(false);
  });
});
