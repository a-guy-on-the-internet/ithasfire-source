import { describe, expect, it, vi } from "vitest";

import type {
  PayeeLedgerLiabilityTotal,
  PayeeLedgerPayableBalance,
} from "@th/ports/repos/payee-ledger";

import { DEFAULT_PAYOUT_MINIMUM_CENTS } from "../../settlements/run-batch";

import {
  listPayablePositions,
  PAYABLE_POSITIONS_MAX_ROWS,
  PAYABLE_POSITIONS_STATEMENT_TIMEOUT_MS,
  type ListPayablePositionsDeps,
} from "../list-payable-positions";

const ACTOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_ID = "11111111-1111-4111-8111-111111111111";
const HUMAN_ID = "22222222-2222-4222-8222-222222222222";
const ORG_PAYEE = "payee-org";
const HUMAN_PAYEE = "payee-human";
const NOW = new Date("2026-09-11T12:00:00.000Z");
const AUG_1 = new Date("2026-08-01T00:00:00.000Z");
const SEP_1 = new Date("2026-09-01T00:00:00.000Z");

function cell(
  overrides: Partial<PayeeLedgerPayableBalance> = {},
): PayeeLedgerPayableBalance {
  return {
    payeeId: ORG_PAYEE,
    currency: "usd",
    payableCents: 12_000,
    oldestMaturedAt: AUG_1,
    ...overrides,
  };
}

type Options = {
  allowed?: boolean;
  cells?: PayeeLedgerPayableBalance[];
  liability?: PayeeLedgerLiabilityTotal[];
  payeesFail?: boolean;
  labelsFail?: boolean;
  knownPayees?: string[];
  /** GLOBAL fee policy; `null` exercises the batch-default fallback. */
  payoutMinimumCents?: number | null;
  /** The fee-policy READ throws — distinct from it returning no row. */
  policyFails?: boolean;
  /** Payees whose Connect account is missing / disabled. */
  noStripeAccount?: string[];
  payoutsDisabled?: string[];
};

function makeDeps(options: Options = {}) {
  const cells = options.cells ?? [cell()];
  const hasStaffRole = vi.fn(async () => ({ allowed: options.allowed ?? true }));
  const listPayableBalances = vi.fn(async () => cells);
  const sumOutstandingLiability = vi.fn(
    async () =>
      options.liability ?? [
        {
          currency: "usd",
          unpaidCreditsCents: 90_000,
          reserveHeldCents: 5_000,
          pendingHoldCents: 2_500,
        },
      ],
  );
  const lookupFailure = new Error("db down");
  const known = new Set(options.knownPayees ?? [ORG_PAYEE, HUMAN_PAYEE]);
  const noStripe = new Set(options.noStripeAccount ?? []);
  const disabled = new Set(options.payoutsDisabled ?? []);
  const payees = {
    getByIds: vi.fn(async (ids: string[]) => {
      if (options.payeesFail) throw lookupFailure;
      return ids
        .filter((id) => known.has(id))
        .map((id) => ({
          id,
          subjectType: id === HUMAN_PAYEE ? "HUMAN" : "ORGANIZATION",
          subjectId: id === HUMAN_PAYEE ? HUMAN_ID : ORG_ID,
          stripeAccountId: noStripe.has(id) ? null : `acct_${id}`,
          payoutsEnabled: !disabled.has(id),
        }));
    }),
  };
  const policyFailure = new Error("fee policy read failed");
  const resolveEffective = vi.fn(async () => {
    if (options.policyFails) throw policyFailure;
    return options.payoutMinimumCents === null
      ? null
      : { payoutMinimumCents: options.payoutMinimumCents ?? 1_000 };
  });
  const organizations = {
    getByIds: vi.fn(async (ids: string[]) => {
      if (options.labelsFail) throw lookupFailure;
      return ids
        .filter((id) => id === ORG_ID)
        .map((id) => ({ id, name: "DRKMTTR", slug: "drkmttr" }));
    }),
  };
  const humans = {
    getByIds: vi.fn(async (ids: string[]) =>
      ids
        .filter((id) => id === HUMAN_ID)
        .map((id) => ({ id, name: "Sole Artist" })),
    ),
  };
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
      payeeLedger: { listPayableBalances, sumOutstandingLiability },
      payees,
      organizations,
      humans,
      feePolicies: { resolveEffective },
    },
    authz: { hasStaffRole },
    clock: { now: () => NOW },
    logger,
    reportError,
  } as unknown as ListPayablePositionsDeps;

  return {
    deps,
    hasStaffRole,
    listPayableBalances,
    sumOutstandingLiability,
    resolveEffective,
    organizations,
    payees,
    logger,
    reportError,
    lookupFailure,
    policyFailure,
  };
}

describe("listPayablePositions", () => {
  // ── The batch's post-payable gates ────────────────────────────────────────
  //
  // The payable is the batch's INPUT. These flags are the difference between
  // a $4.00 row that quietly never moves and one that says why.

  it("reads the payout minimum from the SAME GLOBAL fee policy the batch does", async () => {
    const h = makeDeps({ payoutMinimumCents: 2_500 });
    const out = await listPayablePositions(h.deps, { actorHumanId: ACTOR });

    expect(h.resolveEffective).toHaveBeenCalledWith({
      scopeType: "GLOBAL",
      scopeId: null,
      at: NOW,
    });
    expect(out.payoutMinimumCents).toBe(2_500);
  });

  it("falls back to the batch's OWN default when no policy resolves", async () => {
    const h = makeDeps({ payoutMinimumCents: null });
    const out = await listPayablePositions(h.deps, { actorHumanId: ACTOR });
    expect(out.payoutMinimumCents).toBe(DEFAULT_PAYOUT_MINIMUM_CENTS);
  });

  it("flags a cell below the minimum — the row the batch skips and carries forward", async () => {
    const h = makeDeps({
      payoutMinimumCents: 1_000,
      cells: [
        cell({ payeeId: ORG_PAYEE, payableCents: 400 }),
        cell({ payeeId: HUMAN_PAYEE, payableCents: 1_000 }),
      ],
    });
    const out = await listPayablePositions(h.deps, { actorHumanId: ACTOR });

    expect(out.items[0]).toMatchObject({ payableCents: 400, belowMinimum: true });
    // Exactly AT the minimum is NOT below it — the batch's test is `<`.
    expect(out.items[1]).toMatchObject({ payableCents: 1_000, belowMinimum: false });
    expect(out.minimumResolved).toBe(true);
    // A skipped row is still owed, so it still counts toward the total.
    expect(out.payableTotals).toEqual([
      { currency: "usd", payableCents: 1_400, cellCount: 2 },
    ]);
  });

  it("names the batch's three eligibility reasons, in the batch's own order of precedence", async () => {
    const h = makeDeps({
      cells: [
        cell({ payeeId: ORG_PAYEE }),
        cell({ payeeId: HUMAN_PAYEE }),
        cell({ payeeId: "payee-orphan" }),
      ],
      noStripeAccount: [ORG_PAYEE],
      payoutsDisabled: [HUMAN_PAYEE],
      knownPayees: [ORG_PAYEE, HUMAN_PAYEE],
    });
    const out = await listPayablePositions(h.deps, { actorHumanId: ACTOR });

    expect(out.items.map((r) => r.ineligibleReason)).toEqual([
      "payee_missing_stripe_account",
      "payee_payouts_disabled",
      // A payable cell with no Payee row is the batch's `payee_not_found`.
      // It must SHOW, flagged — never silently read as payable.
      "payee_not_found",
    ]);
    expect(out.items.every((r) => r.identityResolved)).toBe(true);
  });

  it("leaves an eligible payee unflagged", async () => {
    const h = makeDeps();
    const out = await listPayablePositions(h.deps, { actorHumanId: ACTOR });
    expect(out.items[0]).toMatchObject({
      ineligibleReason: null,
      belowMinimum: false,
      identityResolved: true,
    });
  });

  it("reports eligibility as UNKNOWN, never as eligible, when the payee lookup failed", async () => {
    const h = makeDeps({ payeesFail: true });
    const out = await listPayablePositions(h.deps, { actorHumanId: ACTOR });

    expect(out.items[0]).toMatchObject({
      identityResolved: false,
      ineligibleReason: null,
    });
    // The minimum needs no identity lookup, so that flag stays trustworthy.
    expect(out.items[0]!.belowMinimum).toBe(false);
    expect(out.minimumResolved).toBe(true);
  });

  it("still shows the money when the FEE POLICY read fails, and reports the swallow", async () => {
    const h = makeDeps({ policyFails: true });
    const out = await listPayablePositions(h.deps, { actorHumanId: ACTOR });

    // Both ledger answers are intact — a policy outage must not blank a
    // panel whose job is to show what the platform owes.
    expect(out.items).toHaveLength(1);
    expect(out.items[0]!.payableCents).toBe(12_000);
    expect(out.payableTotals).toEqual([
      { currency: "usd", payableCents: 12_000, cellCount: 1 },
    ]);
    expect(out.liabilityTotals).toHaveLength(1);

    expect(h.logger.error).toHaveBeenCalledWith(
      "payable_positions_fee_policy_lookup_failed",
      expect.objectContaining({ err: h.policyFailure }),
    );
    expect(h.reportError).toHaveBeenCalledWith(
      h.policyFailure,
      expect.objectContaining({
        tags: { useCase: "listPayablePositions", step: "resolveFeePolicy" },
      }),
    );
  });

  it("reports the minimum as UNKNOWN rather than accusing rows against a threshold nobody read", async () => {
    const h = makeDeps({
      policyFails: true,
      cells: [cell({ payableCents: 1 }), cell({ payeeId: HUMAN_PAYEE, payableCents: 900_000 })],
    });
    const out = await listPayablePositions(h.deps, { actorHumanId: ACTOR });

    expect(out.minimumResolved).toBe(false);
    expect(out.payoutMinimumCents).toBeNull();
    // Not `false` — that would silently clear a 1-cent row. Not `true`
    // either — that would accuse it. Unknown is unknown.
    expect(out.items.map((r) => r.belowMinimum)).toEqual([null, null]);
  });

  it("distinguishes a failed policy READ from a policy that simply does not exist", async () => {
    const missing = await listPayablePositions(
      makeDeps({ payoutMinimumCents: null }).deps,
      { actorHumanId: ACTOR },
    );
    // No row is a DEFINED answer: the batch falls back to its own default,
    // so the page does too, and the flags stay meaningful.
    expect(missing.minimumResolved).toBe(true);
    expect(missing.payoutMinimumCents).toBe(DEFAULT_PAYOUT_MINIMUM_CENTS);
    expect(missing.items[0]!.belowMinimum).toBe(false);

    const failed = await listPayablePositions(
      makeDeps({ policyFails: true }).deps,
      { actorHumanId: ACTOR },
    );
    expect(failed.minimumResolved).toBe(false);
    expect(failed.payoutMinimumCents).toBeNull();
    expect(failed.items[0]!.belowMinimum).toBeNull();
  });

  it("a throwing reporter on the policy swallow never changes the result", async () => {
    const h = makeDeps({ policyFails: true });
    (h.reportError as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("sentry is down");
    });
    await expect(
      listPayablePositions(h.deps, { actorHumanId: ACTOR }),
    ).resolves.toMatchObject({ total: 1, minimumResolved: false });
  });

  it("refuses a non-staff actor without touching the ledger", async () => {
    const h = makeDeps({ allowed: false });
    await expect(
      listPayablePositions(h.deps, { actorHumanId: ACTOR }),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });
    expect(h.hasStaffRole).toHaveBeenCalledWith({
      actorHumanId: ACTOR,
      requiredRoles: ["ADMIN", "SUPPORT"],
    });
    expect(h.listPayableBalances).not.toHaveBeenCalled();
    expect(h.sumOutstandingLiability).not.toHaveBeenCalled();
    expect(h.resolveEffective).not.toHaveBeenCalled();
  });

  it("refuses unknown input keys (strict schema)", async () => {
    const h = makeDeps();
    await expect(
      listPayablePositions(h.deps, { actorHumanId: ACTOR, cursor: "nope" }),
    ).rejects.toBeTruthy();
  });

  it("reads the SAME method the payout batch plans from, at the clock's now, with a statement budget", async () => {
    const h = makeDeps();
    await listPayablePositions(h.deps, { actorHumanId: ACTOR });

    expect(h.listPayableBalances).toHaveBeenCalledWith(NOW, undefined, {
      statementTimeoutMs: PAYABLE_POSITIONS_STATEMENT_TIMEOUT_MS,
    });
    expect(h.sumOutstandingLiability).toHaveBeenCalledWith({
      statementTimeoutMs: PAYABLE_POSITIONS_STATEMENT_TIMEOUT_MS,
    });
  });

  it("keeps PAYABLE and LIABILITY as separate numbers — the liability is never the payable's sum", async () => {
    const h = makeDeps({
      cells: [cell({ payableCents: 12_000 }), cell({ payeeId: HUMAN_PAYEE, payableCents: 3_000 })],
      liability: [
        {
          currency: "usd",
          // Deliberately LARGER than the payable: credits that have not
          // matured are owed but unpayable tonight.
          unpaidCreditsCents: 90_000,
          reserveHeldCents: 5_000,
          pendingHoldCents: 2_500,
        },
      ],
    });

    const out = await listPayablePositions(h.deps, { actorHumanId: ACTOR });

    expect(out.payableTotals).toEqual([
      { currency: "usd", payableCents: 15_000, cellCount: 2 },
    ]);
    expect(out.liabilityTotals).toEqual([
      {
        currency: "usd",
        unpaidCreditsCents: 90_000,
        reserveHeldCents: 5_000,
        pendingHoldCents: 2_500,
        totalOwedCents: 97_500,
      },
    ]);
    // The invariant a reader's solvency judgement hangs on.
    expect(out.liabilityTotals[0]!.totalOwedCents).toBeGreaterThan(
      out.payableTotals[0]!.payableCents,
    );
  });

  it("drops negative cells (the batch's own max(0,·) filter) and preserves the adapter's oldest-waiting-first order", async () => {
    const h = makeDeps({
      cells: [
        cell({ payeeId: "p-oldest", payableCents: 500, oldestMaturedAt: AUG_1 }),
        cell({ payeeId: "p-debt", payableCents: -4_000, oldestMaturedAt: null }),
        cell({ payeeId: "p-newer", payableCents: 700, oldestMaturedAt: SEP_1 }),
        cell({ payeeId: "p-zero", payableCents: 0, oldestMaturedAt: null }),
      ],
      knownPayees: [],
    });

    const out = await listPayablePositions(h.deps, { actorHumanId: ACTOR });

    expect(out.items.map((r) => r.payeeId)).toEqual(["p-oldest", "p-newer"]);
    expect(out.total).toBe(2);
    expect(out.payableTotals).toEqual([
      { currency: "usd", payableCents: 1_200, cellCount: 2 },
    ]);
  });

  it("never sums across currencies", async () => {
    const h = makeDeps({
      cells: [
        cell({ currency: "usd", payableCents: 1_000 }),
        cell({ payeeId: HUMAN_PAYEE, currency: "mxn", payableCents: 2_000 }),
      ],
      liability: [
        {
          currency: "mxn",
          unpaidCreditsCents: 2_000,
          reserveHeldCents: 0,
          pendingHoldCents: 0,
        },
        {
          currency: "usd",
          unpaidCreditsCents: 1_000,
          reserveHeldCents: 0,
          pendingHoldCents: 0,
        },
      ],
    });

    const out = await listPayablePositions(h.deps, { actorHumanId: ACTOR });

    expect(out.payableTotals).toEqual([
      { currency: "mxn", payableCents: 2_000, cellCount: 1 },
      { currency: "usd", payableCents: 1_000, cellCount: 1 },
    ]);
    expect(out.liabilityTotals.map((r) => r.currency)).toEqual(["mxn", "usd"]);
  });

  it("resolves who each cell belongs to", async () => {
    const h = makeDeps({
      cells: [cell(), cell({ payeeId: HUMAN_PAYEE, payableCents: 800 })],
    });

    const out = await listPayablePositions(h.deps, { actorHumanId: ACTOR });

    expect(out.items[0]).toMatchObject({
      payeeId: ORG_PAYEE,
      subjectType: "ORGANIZATION",
      subjectId: ORG_ID,
      ownerLabel: "DRKMTTR",
      ownerSlug: "drkmttr",
    });
    expect(out.items[1]).toMatchObject({
      payeeId: HUMAN_PAYEE,
      subjectType: "HUMAN",
      subjectId: HUMAN_ID,
      ownerLabel: "Sole Artist",
      ownerSlug: null,
    });
  });

  it("still lists the money when the payee lookup fails, and reports the swallow", async () => {
    const h = makeDeps({ payeesFail: true });

    const out = await listPayablePositions(h.deps, { actorHumanId: ACTOR });

    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toMatchObject({
      payeeId: ORG_PAYEE,
      payableCents: 12_000,
      subjectType: null,
      subjectId: null,
      ownerLabel: null,
    });
    expect(h.logger.error).toHaveBeenCalledWith(
      "payable_positions_owner_lookup_failed",
      expect.objectContaining({ err: h.lookupFailure }),
    );
    expect(h.reportError).toHaveBeenCalledWith(
      h.lookupFailure,
      expect.objectContaining({
        tags: { useCase: "listPayablePositions", step: "attachOwners" },
      }),
    );
  });

  it("still lists the money when the org label lookup fails, and reports the swallow", async () => {
    const h = makeDeps({ labelsFail: true });

    const out = await listPayablePositions(h.deps, { actorHumanId: ACTOR });

    expect(out.items[0]).toMatchObject({ payableCents: 12_000, ownerLabel: null });
    expect(h.reportError).toHaveBeenCalledTimes(1);
  });

  it("a throwing reporter never changes the result", async () => {
    const h = makeDeps({ labelsFail: true });
    (h.reportError as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("sentry is down");
    });

    await expect(
      listPayablePositions(h.deps, { actorHumanId: ACTOR }),
    ).resolves.toMatchObject({ total: 1 });
  });

  it("caps the visible rows but keeps the totals complete, and says it truncated", async () => {
    const over = PAYABLE_POSITIONS_MAX_ROWS + 5;
    const h = makeDeps({
      cells: Array.from({ length: over }, (_, i) =>
        cell({ payeeId: `p-${i}`, payableCents: 100 }),
      ),
      knownPayees: [],
    });

    const out = await listPayablePositions(h.deps, { actorHumanId: ACTOR });

    expect(out.items).toHaveLength(PAYABLE_POSITIONS_MAX_ROWS);
    expect(out.truncated).toBe(true);
    expect(out.rowLimit).toBe(PAYABLE_POSITIONS_MAX_ROWS);
    expect(out.total).toBe(over);
    // The headline must describe EVERY cell, not the visible page.
    expect(out.payableTotals).toEqual([
      { currency: "usd", payableCents: over * 100, cellCount: over },
    ]);
  });

  it("reports empty totals and an empty list when nothing is payable", async () => {
    const h = makeDeps({ cells: [], liability: [] });

    const out = await listPayablePositions(h.deps, { actorHumanId: ACTOR });

    expect(out).toMatchObject({
      items: [],
      total: 0,
      truncated: false,
      payableTotals: [],
      liabilityTotals: [],
      asOf: NOW,
    });
  });
});
