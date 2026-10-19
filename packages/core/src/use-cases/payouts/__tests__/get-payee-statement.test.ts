import { describe, expect, it, vi } from "vitest";

import type {
  PayeeLedgerEntryRecord,
  PayeeLedgerPayableBalance,
  PayeeLedgerUpcomingMaturity,
} from "@th/ports/repos/payee-ledger";

import { DEFAULT_PAYOUT_MINIMUM_CENTS } from "../../settlements/run-batch";
import {
  DISPUTE_DEBIT_LOOKUP_CONCURRENCY,
  getPayeeStatement,
  PAYEE_STATEMENT_MAX_OFFSET,
  PAYEE_STATEMENT_TIMEOUT_MS,
  type GetPayeeStatementDeps,
} from "../get-payee-statement";

const ACTOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_ID = "11111111-1111-4111-8111-111111111111";
const PAYEE_ID = "payee-org";

/**
 * The PRODUCTION instant this use case was written against: two credits
 * carrying `availableAt = 2026-09-20`, a ledger balance of 1064, and a
 * payable of 0 because neither has matured.
 */
const NOW = new Date("2026-09-16T12:00:00.000Z");
const SEP_20 = new Date("2026-09-20T05:00:00.000Z");
const SEP_27 = new Date("2026-09-27T05:00:00.000Z");

function entry(
  overrides: Partial<PayeeLedgerEntryRecord> = {},
): PayeeLedgerEntryRecord {
  return {
    id: "ledger-1",
    idempotencyKey: "settlement-credit:order-1:payee-org",
    payeeId: PAYEE_ID,
    type: "SETTLEMENT_CREDIT",
    amountCents: 532,
    currency: "usd",
    sourceKind: "order_split",
    sourceId: "order-1",
    orderId: "order-1",
    settlementId: null,
    disputeId: null,
    relatedEntryId: null,
    availableAt: SEP_20,
    consumedByEntryId: null,
    description: "Ticket revenue — order 1",
    metadata: null,
    createdAt: new Date("2026-09-13T00:00:00.000Z"),
    ...overrides,
  };
}

type Options = {
  allowed?: boolean;
  /** `null` = the subject has no Payee row at all. */
  payeeId?: string | null;
  defaultCurrency?: string;
  balance?: {
    ledgerBalanceCents: number;
    pendingHoldCents: number;
    reserveCents: number;
  };
  payableCells?: PayeeLedgerPayableBalance[];
  maturities?: PayeeLedgerUpcomingMaturity[];
  entries?: PayeeLedgerEntryRecord[];
  /** GLOBAL fee policy; `null` exercises the batch-default fallback. */
  payoutMinimumCents?: number | null;
  /** The fee-policy READ throws — distinct from it returning no row. */
  policyFails?: boolean;
  /** The maturity forecast READ throws. */
  maturitiesFail?: boolean;
  /**
   * The running-balance SEED read throws — i.e. the second `listEntries`
   * call (the `offset` newer rows). The page read itself (first call)
   * stays healthy, so this isolates the best-effort path.
   */
  newerRowsFail?: boolean;
  /** DISPUTE_DEBIT rows per dispute id, for DISPUTE_RELEASE sign resolution. */
  disputeDebits?: Record<string, PayeeLedgerEntryRecord[]>;
  /** The dispute-debit lookup throws. */
  disputeDebitsFail?: boolean;
  /** `reportError` itself throws — must never change the result. */
  reporterThrows?: boolean;
};

function makeDeps(options: Options = {}) {
  const canFinanceOrg = vi.fn(async () => ({
    allowed: options.allowed ?? true,
  }));

  const payeeId = options.payeeId === undefined ? PAYEE_ID : options.payeeId;
  const getBySubject = vi.fn(async () => (payeeId ? { id: payeeId } : null));
  const getById = vi.fn(async (id: string) => ({
    id,
    subjectType: "ORGANIZATION" as const,
    subjectId: ORG_ID,
    stripeAccountId: "acct_1",
    status: "ACTIVE" as const,
    payoutsEnabled: true,
    chargesEnabled: true,
    defaultCurrency: options.defaultCurrency ?? "usd",
    resaleNegativeBalanceCents: 0,
    resaleNegativeBalanceOpenedAt: null,
    resaleNegativeBalanceAgingStartsAt: null,
    resalePayoutBlockReason: null,
    resalePayoutBlockedAt: null,
  }));

  const balanceValues = options.balance ?? {
    ledgerBalanceCents: 1064,
    pendingHoldCents: 0,
    reserveCents: 0,
  };
  const getBalance = vi.fn(async (id: string, currency: string) => ({
    payeeId: id,
    currency,
    ledgerBalanceCents: balanceValues.ledgerBalanceCents,
    pendingHoldCents: balanceValues.pendingHoldCents,
    reserveCents: balanceValues.reserveCents,
    availableCents:
      balanceValues.ledgerBalanceCents - balanceValues.pendingHoldCents,
  }));

  // PRODUCTION DEFAULT: no matured cell at all, because both credits mature
  // on 20 Sep and `asOf` is 16 Sep.
  const listPayableBalances = vi.fn(async () => options.payableCells ?? []);

  const maturityFailure = new Error("maturity read timed out");
  const listUpcomingMaturities = vi.fn(async () => {
    if (options.maturitiesFail) throw maturityFailure;
    return (
      options.maturities ?? [
        {
          payeeId: PAYEE_ID,
          currency: "usd",
          maturesAt: SEP_20,
          creditCents: 1064,
          heldCents: 0,
          creditCount: 2,
        },
      ]
    );
  });

  const allEntries = options.entries ?? [entry()];
  const newerRowsFailure = new Error("newer rows read timed out");
  let entriesCalls = 0;
  const listEntries = vi.fn(
    async (_payeeId: string, opts: { limit?: number; offset?: number } = {}) => {
      // Call 0 is the PAGE read (load-bearing); call 1, when it happens, is
      // the running-balance seed (best-effort).
      const call = entriesCalls++;
      if (options.newerRowsFail && call >= 1) throw newerRowsFailure;
      const offset = opts.offset ?? 0;
      const take = opts.limit ?? 50;
      return allEntries.slice(offset, offset + take);
    },
  );
  const disputeDebitsFailure = new Error("dispute debit read failed");
  let disputeDebitsInFlight = 0;
  const disputeDebitsPeak = { value: 0 };
  const listDebitsForDispute = vi.fn(async (disputeId: string) => {
    if (options.disputeDebitsFail) throw disputeDebitsFailure;
    disputeDebitsInFlight += 1;
    disputeDebitsPeak.value = Math.max(disputeDebitsPeak.value, disputeDebitsInFlight);
    await new Promise((r) => setTimeout(r, 1));
    disputeDebitsInFlight -= 1;
    return options.disputeDebits?.[disputeId] ?? [];
  });

  const policyFailure = new Error("fee policy read failed");
  const resolveEffective = vi.fn(async () => {
    if (options.policyFails) throw policyFailure;
    return options.payoutMinimumCents === null
      ? null
      : { payoutMinimumCents: options.payoutMinimumCents ?? 1_000 };
  });

  const reportError = vi.fn(() => {
    if (options.reporterThrows) throw new Error("sentry is down");
  });
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
      payeeLedger: {
        getBalance,
        listPayableBalances,
        listUpcomingMaturities,
        listEntries,
        listDebitsForDispute,
      },
      payees: { getBySubject, getById },
      feePolicies: { resolveEffective },
    },
    authz: { canFinanceOrg },
    clock: { now: () => NOW },
    logger,
    reportError,
  } as unknown as GetPayeeStatementDeps;

  return {
    deps,
    canFinanceOrg,
    getBySubject,
    getById,
    getBalance,
    listPayableBalances,
    listUpcomingMaturities,
    listEntries,
    listDebitsForDispute,
    disputeDebitsPeak,
    resolveEffective,
    reportError,
    logger,
    maturityFailure,
    policyFailure,
    newerRowsFailure,
    disputeDebitsFailure,
  };
}

const orgInput = { actorHumanId: ACTOR, orgId: ORG_ID };

describe("getPayeeStatement", () => {
  describe("balance vs payable", () => {
    it("reports the PRODUCTION case — balance 1064, payable 0 — as two numbers", async () => {
      // The exact bug this use case exists to prevent: both credits carry
      // `availableAt = 20 Sep` and `asOf` is 16 Sep, so the ledger owes
      // $10.64 while tonight's batch can send nothing. Neither figure may be
      // derived from, or substituted for, the other.
      const h = makeDeps({
        balance: {
          ledgerBalanceCents: 1064,
          pendingHoldCents: 0,
          reserveCents: 0,
        },
        payableCells: [],
      });

      const result = await getPayeeStatement(h.deps, orgInput);

      expect(result.balanceCents).toBe(1064);
      expect(result.payableCents).toBe(0);
      expect(result.currency).toBe("usd");
      expect(result.payeeId).toBe(PAYEE_ID);
      expect(result.asOf).toEqual(NOW);
      // 07:00 CDT on 16 Sep: the batch next runs at midnight Central tonight.
      expect(result.nextPayoutRun).toEqual({
        runAt: "2026-09-17T05:00:00.000Z",
        night: "2026-09-16",
      });
    });

    it("keeps the two apart when BOTH are non-zero and different", async () => {
      const h = makeDeps({
        balance: {
          ledgerBalanceCents: 9_000,
          pendingHoldCents: 500,
          reserveCents: 250,
        },
        payableCells: [
          {
            payeeId: PAYEE_ID,
            currency: "usd",
            payableCents: 3_500,
            oldestMaturedAt: new Date("2026-09-01T00:00:00.000Z"),
          },
        ],
      });

      const result = await getPayeeStatement(h.deps, orgInput);

      expect(result.balanceCents).toBe(9_000);
      expect(result.payableCents).toBe(3_500);
      expect(result.pendingHoldCents).toBe(500);
      expect(result.reserveCents).toBe(250);
    });

    it("returns a NEGATIVE payable as-is — a debt position is not clamped away", async () => {
      const h = makeDeps({
        balance: {
          ledgerBalanceCents: -400,
          pendingHoldCents: 0,
          reserveCents: 0,
        },
        payableCells: [
          {
            payeeId: PAYEE_ID,
            currency: "usd",
            payableCents: -400,
            oldestMaturedAt: null,
          },
        ],
      });

      const result = await getPayeeStatement(h.deps, orgInput);

      expect(result.payableCents).toBe(-400);
    });

    it("reads the payable cell for the payee's OWN currency, not another's", async () => {
      const h = makeDeps({
        defaultCurrency: "usd",
        payableCells: [
          {
            payeeId: PAYEE_ID,
            currency: "cad",
            payableCents: 5_000,
            oldestMaturedAt: null,
          },
          {
            payeeId: PAYEE_ID,
            currency: "usd",
            payableCents: 700,
            oldestMaturedAt: null,
          },
        ],
      });

      const result = await getPayeeStatement(h.deps, orgInput);

      expect(result.payableCents).toBe(700);
    });

    it("narrows every ledger read to this payee and budgets the aggregates", async () => {
      const h = makeDeps();

      await getPayeeStatement(h.deps, orgInput);

      expect(h.listPayableBalances).toHaveBeenCalledWith(NOW, [PAYEE_ID], {
        statementTimeoutMs: PAYEE_STATEMENT_TIMEOUT_MS,
      });
      expect(h.listUpcomingMaturities).toHaveBeenCalledWith(NOW, [PAYEE_ID], {
        statementTimeoutMs: PAYEE_STATEMENT_TIMEOUT_MS,
      });
      expect(h.getBalance).toHaveBeenCalledWith(PAYEE_ID, "usd");
    });
  });

  describe("arrival date", () => {
    it("takes the EARLIEST upcoming maturity, not the first row returned", async () => {
      const h = makeDeps({
        maturities: [
          {
            payeeId: PAYEE_ID,
            currency: "usd",
            maturesAt: SEP_27,
            creditCents: 4_000,
            heldCents: 0,
            creditCount: 1,
          },
          {
            payeeId: PAYEE_ID,
            currency: "usd",
            maturesAt: SEP_20,
            creditCents: 1_064,
            heldCents: 0,
            creditCount: 2,
          },
        ],
      });

      const result = await getPayeeStatement(h.deps, orgInput);

      expect(result.nextArrivalAt).toEqual(SEP_20);
      expect(result.nextArrivalCents).toBe(1_064);
      expect(result.arrivalResolved).toBe(true);
    });

    it("ignores tranches in another currency", async () => {
      const h = makeDeps({
        defaultCurrency: "usd",
        maturities: [
          {
            payeeId: PAYEE_ID,
            currency: "cad",
            maturesAt: SEP_20,
            creditCents: 9_999,
            heldCents: 0,
            creditCount: 1,
          },
          {
            payeeId: PAYEE_ID,
            currency: "usd",
            maturesAt: SEP_27,
            creditCents: 1_064,
            heldCents: 0,
            creditCount: 2,
          },
        ],
      });

      const result = await getPayeeStatement(h.deps, orgInput);

      expect(result.nextArrivalAt).toEqual(SEP_27);
      expect(result.nextArrivalCents).toBe(1_064);
    });

    it("is null when nothing is upcoming — and says so is RESOLVED", async () => {
      const h = makeDeps({ maturities: [] });

      const result = await getPayeeStatement(h.deps, orgInput);

      expect(result.nextArrivalAt).toBeNull();
      expect(result.nextArrivalCents).toBeNull();
      expect(result.arrivalResolved).toBe(true);
    });

    it("degrades to arrivalResolved:false — never to 'nothing upcoming' — when the read fails", async () => {
      const h = makeDeps({ maturitiesFail: true });

      const result = await getPayeeStatement(h.deps, orgInput);

      expect(result.arrivalResolved).toBe(false);
      expect(result.nextArrivalAt).toBeNull();
      expect(result.nextArrivalCents).toBeNull();
      // The money the statement DOES know is still reported.
      expect(result.balanceCents).toBe(1064);
      expect(h.reportError).toHaveBeenCalledWith(h.maturityFailure, {
        tags: { useCase: "getPayeeStatement", step: "listUpcomingMaturities" },
        extra: { payeeId: PAYEE_ID },
      });
      // ERROR, not warn: `logger.warn` is not captured by Sentry.
      expect(h.logger.error).toHaveBeenCalledWith(
        "payee_statement_maturity_lookup_failed",
        expect.objectContaining({ err: h.maturityFailure }),
      );
    });
  });

  describe("payout minimum", () => {
    it("uses the GLOBAL policy's minimum and flags a payable below it", async () => {
      const h = makeDeps({
        payoutMinimumCents: 1_000,
        payableCells: [
          {
            payeeId: PAYEE_ID,
            currency: "usd",
            payableCents: 400,
            oldestMaturedAt: null,
          },
        ],
      });

      const result = await getPayeeStatement(h.deps, orgInput);

      expect(h.resolveEffective).toHaveBeenCalledWith({
        scopeType: "GLOBAL",
        scopeId: null,
        at: NOW,
      });
      expect(result.payoutMinimumCents).toBe(1_000);
      expect(result.minimumResolved).toBe(true);
      expect(result.belowMinimum).toBe(true);
    });

    it("falls back to the BATCH's default when NO policy row exists", async () => {
      const h = makeDeps({ payoutMinimumCents: null });

      const result = await getPayeeStatement(h.deps, orgInput);

      expect(result.payoutMinimumCents).toBe(DEFAULT_PAYOUT_MINIMUM_CENTS);
      expect(result.minimumResolved).toBe(true);
    });

    it("a FAILED read yields null — never the default — and is reported", async () => {
      const h = makeDeps({ policyFails: true });

      const result = await getPayeeStatement(h.deps, orgInput);

      expect(result.payoutMinimumCents).toBeNull();
      expect(result.minimumResolved).toBe(false);
      // Unknown, never "no": the payee is not accused of being below a
      // threshold nobody managed to read.
      expect(result.belowMinimum).toBeNull();
      expect(h.reportError).toHaveBeenCalledWith(h.policyFailure, {
        tags: { useCase: "getPayeeStatement", step: "resolveFeePolicy" },
        extra: undefined,
      });
      expect(h.logger.error).toHaveBeenCalledWith(
        "payee_statement_fee_policy_lookup_failed",
        expect.objectContaining({ err: h.policyFailure }),
      );
      // The money is still reported — a policy outage must not blank it.
      expect(result.balanceCents).toBe(1064);
    });

    it("a THROWING reporter cannot turn a degraded statement into a failed one", async () => {
      const h = makeDeps({ policyFails: true, reporterThrows: true });

      const result = await getPayeeStatement(h.deps, orgInput);

      expect(result.minimumResolved).toBe(false);
      expect(result.balanceCents).toBe(1064);
    });
  });

  describe("authorization", () => {
    it("refuses a non-member with FORBIDDEN", async () => {
      const h = makeDeps({ allowed: false });

      await expect(getPayeeStatement(h.deps, orgInput)).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    });

    it("reads NO ledger data when the actor is refused", async () => {
      const h = makeDeps({ allowed: false });

      await expect(getPayeeStatement(h.deps, orgInput)).rejects.toBeTruthy();

      expect(h.getBySubject).not.toHaveBeenCalled();
      expect(h.getBalance).not.toHaveBeenCalled();
      expect(h.listPayableBalances).not.toHaveBeenCalled();
      expect(h.listEntries).not.toHaveBeenCalled();
      expect(h.resolveEffective).not.toHaveBeenCalled();
    });

    it("gates the org path on canFinanceOrg for the requested org", async () => {
      const h = makeDeps();

      await getPayeeStatement(h.deps, orgInput);

      expect(h.canFinanceOrg).toHaveBeenCalledWith({
        actorHumanId: ACTOR,
        orgId: ORG_ID,
      });
      expect(h.getBySubject).toHaveBeenCalledWith({
        type: "ORGANIZATION",
        id: ORG_ID,
      });
    });

    it("resolves the HUMAN path to the actor's own payee, with no org probe", async () => {
      const h = makeDeps();

      await getPayeeStatement(h.deps, { actorHumanId: ACTOR });

      expect(h.canFinanceOrg).not.toHaveBeenCalled();
      expect(h.getBySubject).toHaveBeenCalledWith({
        type: "HUMAN",
        id: ACTOR,
      });
    });

    it("refuses unknown input keys — no way to smuggle another subject in", async () => {
      const h = makeDeps();

      await expect(
        getPayeeStatement(h.deps, {
          actorHumanId: ACTOR,
          payeeId: "payee-someone-else",
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });
    });
  });

  describe("no payee row", () => {
    it("returns a ZEROED statement, not an error", async () => {
      const h = makeDeps({ payeeId: null });

      const result = await getPayeeStatement(h.deps, orgInput);

      expect(result).toMatchObject({
        payeeId: null,
        balanceCents: 0,
        payableCents: 0,
        pendingHoldCents: 0,
        reserveCents: 0,
        nextArrivalAt: null,
        nextArrivalCents: null,
        arrivalResolved: true,
        entries: [],
        hasMore: false,
        nextOffset: null,
        // Nothing was read, so nothing failed.
        balanceAfterResolved: true,
      });
      expect(h.getBalance).not.toHaveBeenCalled();
      expect(h.listEntries).not.toHaveBeenCalled();
    });

    it("still names the payout minimum on the zeroed statement", async () => {
      const h = makeDeps({ payeeId: null, payoutMinimumCents: 1_000 });

      const result = await getPayeeStatement(h.deps, orgInput);

      expect(result.payoutMinimumCents).toBe(1_000);
      expect(result.minimumResolved).toBe(true);
      // No payable at all, so "below the minimum" has no meaning.
      expect(result.belowMinimum).toBeNull();
    });
  });

  describe("journal pagination", () => {
    const many = Array.from({ length: 5 }, (_, i) =>
      entry({ id: `ledger-${i + 1}`, idempotencyKey: `k-${i + 1}` }),
    );

    it("asks for one row MORE than the limit and reports hasMore exactly", async () => {
      const h = makeDeps({ entries: many });

      const result = await getPayeeStatement(h.deps, {
        ...orgInput,
        limit: 2,
        offset: 0,
      });

      expect(h.listEntries).toHaveBeenCalledWith(PAYEE_ID, {
        currency: "usd",
        limit: 3,
        offset: 0,
      });
      expect(result.entries.map((e) => e.id)).toEqual(["ledger-1", "ledger-2"]);
      expect(result.hasMore).toBe(true);
      expect(result.nextOffset).toBe(2);
      expect(result.limit).toBe(2);
      expect(result.offset).toBe(0);
    });

    it("walks every page in a stable order with no row repeated or dropped", async () => {
      const seen: string[] = [];
      let offset: number | null = 0;
      while (offset !== null) {
        const h = makeDeps({ entries: many });
        const page = await getPayeeStatement(h.deps, {
          ...orgInput,
          limit: 2,
          offset,
        });
        seen.push(...page.entries.map((e) => e.id));
        offset = page.nextOffset;
      }

      expect(seen).toEqual([
        "ledger-1",
        "ledger-2",
        "ledger-3",
        "ledger-4",
        "ledger-5",
      ]);
      expect(new Set(seen).size).toBe(seen.length);
    });

    it("closes the walk — the last page is hasMore:false, nextOffset:null", async () => {
      const h = makeDeps({ entries: many });

      const result = await getPayeeStatement(h.deps, {
        ...orgInput,
        limit: 2,
        offset: 4,
      });

      expect(result.entries.map((e) => e.id)).toEqual(["ledger-5"]);
      expect(result.hasMore).toBe(false);
      expect(result.nextOffset).toBeNull();
    });

    it("maps each entry to the statement DTO, keeping availableAt", async () => {
      const h = makeDeps();

      const result = await getPayeeStatement(h.deps, orgInput);

      expect(result.entries[0]).toEqual({
        id: "ledger-1",
        type: "SETTLEMENT_CREDIT",
        amountCents: 532,
        currency: "usd",
        description: "Ticket revenue — order 1",
        createdAt: new Date("2026-09-13T00:00:00.000Z"),
        // In the balance, out of the payable — the row-level form of the
        // distinction the whole statement is built around.
        availableAt: SEP_20,
        orderId: "order-1",
        // The newest row's balance-after IS the headline balance.
        balanceAfterCents: 1064,
      });
    });

    it("refuses an offset past the documented ceiling", async () => {
      const h = makeDeps();

      await expect(
        getPayeeStatement(h.deps, {
          ...orgInput,
          offset: PAYEE_STATEMENT_MAX_OFFSET + 1,
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });
      expect(h.listEntries).not.toHaveBeenCalled();
    });

    describe("the advertised cursor never exceeds the ceiling the input enforces", () => {
      const limit = 25;
      // More rows than the ceiling, so every page below it has more.
      const deep = Array.from({ length: PAYEE_STATEMENT_MAX_OFFSET + 60 }, (_, i) =>
        entry({ id: `deep-${i + 1}`, idempotencyKey: `deep-${i + 1}` }),
      );

      it("at exactly MAX − limit the next page lands ON the ceiling and is still offered", async () => {
        const h = makeDeps({ entries: deep });

        const result = await getPayeeStatement(h.deps, {
          ...orgInput,
          limit,
          offset: PAYEE_STATEMENT_MAX_OFFSET - limit,
        });

        expect(result.hasMore).toBe(true);
        expect(result.nextOffset).toBe(PAYEE_STATEMENT_MAX_OFFSET);
        // ...and that cursor is accepted when followed.
        const next = await getPayeeStatement(makeDeps({ entries: deep }).deps, {
          ...orgInput,
          limit,
          offset: result.nextOffset!,
        });
        expect(next.entries).toHaveLength(limit);
      });

      it("one past it: hasMore stays TRUE but nextOffset is null — no 'Load more' that 400s", async () => {
        const h = makeDeps({ entries: deep });

        const result = await getPayeeStatement(h.deps, {
          ...orgInput,
          limit,
          offset: PAYEE_STATEMENT_MAX_OFFSET - limit + 1,
        });

        expect(result.hasMore).toBe(true);
        expect(result.nextOffset).toBeNull();
        expect(result.entries).toHaveLength(limit);
      });

      it("the ceiling page itself: rows served, more exists, cursor withheld", async () => {
        const h = makeDeps({ entries: deep });

        const result = await getPayeeStatement(h.deps, {
          ...orgInput,
          limit,
          offset: PAYEE_STATEMENT_MAX_OFFSET,
        });

        expect(result.entries).toHaveLength(limit);
        expect(result.hasMore).toBe(true);
        expect(result.nextOffset).toBeNull();
      });
    });
  });

  describe("running balance", () => {
    /**
     * Newest first, as the port returns them. Applied oldest→newest the
     * balance goes 1000 → 3000 → 2700 → 2700 (hold) → 2700 (reserve) →
     * 2200 (payout), so the headline is 2200 and the column, read top to
     * bottom, is 2200, 2700, 2700, 2700, 3000, 1000.
     */
    const mixed: PayeeLedgerEntryRecord[] = [
      entry({
        id: "e6-payout",
        idempotencyKey: "payout:item-1",
        type: "PAYOUT",
        amountCents: 500,
        availableAt: null,
        orderId: null,
        createdAt: new Date("2026-09-16T00:00:00.000Z"),
      }),
      entry({
        id: "e5-reserve",
        idempotencyKey: "reserve-hold:item-1",
        type: "RESERVE_HOLD",
        amountCents: 100,
        availableAt: null,
        orderId: null,
        createdAt: new Date("2026-09-15T00:00:00.000Z"),
      }),
      entry({
        id: "e4-hold",
        idempotencyKey: "dispute-hold:d1",
        type: "DISPUTE_HOLD",
        amountCents: 200,
        availableAt: null,
        disputeId: "d1",
        createdAt: new Date("2026-09-14T00:00:00.000Z"),
      }),
      entry({
        id: "e3-refund",
        idempotencyKey: "refund-debit:order-1",
        type: "REFUND_DEBIT",
        amountCents: 300,
        availableAt: null,
        createdAt: new Date("2026-09-13T00:00:00.000Z"),
      }),
      entry({
        id: "e2-credit",
        idempotencyKey: "settlement-credit:order-2",
        amountCents: 2000,
        orderId: "order-2",
        createdAt: new Date("2026-09-12T00:00:00.000Z"),
      }),
      entry({
        id: "e1-credit",
        idempotencyKey: "settlement-credit:order-1",
        amountCents: 1000,
        createdAt: new Date("2026-09-11T00:00:00.000Z"),
      }),
    ];
    const mixedBalance = {
      ledgerBalanceCents: 2200,
      pendingHoldCents: 200,
      reserveCents: 100,
    };

    it("the first page's first row equals the headline balance, with NO seed read", async () => {
      const h = makeDeps({ entries: mixed, balance: mixedBalance });

      const result = await getPayeeStatement(h.deps, { ...orgInput, offset: 0 });

      expect(result.entries[0]!.balanceAfterCents).toBe(result.balanceCents);
      expect(result.balanceAfterResolved).toBe(true);
      // One read: the page. `offset: 0` needs no newer rows.
      expect(h.listEntries).toHaveBeenCalledTimes(1);
      expect(h.listDebitsForDispute).not.toHaveBeenCalled();
    });

    it("walks a page of mixed types newest-first; holds and reserves repeat the value above", async () => {
      const h = makeDeps({ entries: mixed, balance: mixedBalance });

      const result = await getPayeeStatement(h.deps, orgInput);

      expect(
        result.entries.map((e) => [e.id, e.balanceAfterCents] as const),
      ).toEqual([
        ["e6-payout", 2200],
        ["e5-reserve", 2700],
        ["e4-hold", 2700],
        ["e3-refund", 2700],
        ["e2-credit", 3000],
        ["e1-credit", 1000],
      ]);
      // The oldest row's balance-after minus its own effect is the balance
      // BEFORE anything happened: zero. The walk closes.
      const oldest = result.entries.at(-1)!;
      expect(oldest.balanceAfterCents! - oldest.amountCents).toBe(0);
    });

    it("a page past the first seeds from the `offset` NEWER rows, read under the same filters", async () => {
      const h = makeDeps({ entries: mixed, balance: mixedBalance });

      const result = await getPayeeStatement(h.deps, {
        ...orgInput,
        limit: 2,
        offset: 4,
      });

      expect(
        result.entries.map((e) => [e.id, e.balanceAfterCents] as const),
      ).toEqual([
        ["e2-credit", 3000],
        ["e1-credit", 1000],
      ]);
      expect(result.balanceAfterResolved).toBe(true);
      expect(h.listEntries).toHaveBeenNthCalledWith(1, PAYEE_ID, {
        currency: "usd",
        limit: 3,
        offset: 4,
      });
      expect(h.listEntries).toHaveBeenNthCalledWith(2, PAYEE_ID, {
        currency: "usd",
        limit: 4,
        offset: 0,
      });
    });

    it("every page of a walk agrees with every other page (no seam at the page boundary)", async () => {
      const seen = new Map<string, number | null>();
      let offset: number | null = 0;
      while (offset !== null) {
        const h = makeDeps({ entries: mixed, balance: mixedBalance });
        const page = await getPayeeStatement(h.deps, {
          ...orgInput,
          limit: 2,
          offset,
        });
        expect(page.balanceAfterResolved).toBe(true);
        for (const e of page.entries) {
          expect(e.balanceAfterCents).not.toBeNull();
          seen.set(e.id, e.balanceAfterCents);
        }
        offset = page.nextOffset;
      }
      const h = makeDeps({ entries: mixed, balance: mixedBalance });
      const whole = await getPayeeStatement(h.deps, { ...orgInput, limit: 10 });
      expect(whole.balanceAfterResolved).toBe(true);
      expect(whole.entries).toHaveLength(mixed.length);
      expect(seen.size).toBe(mixed.length);
      for (const e of whole.entries) {
        expect(e.balanceAfterCents).not.toBeNull();
        expect(seen.get(e.id)).toBe(e.balanceAfterCents);
      }
    });

    it("a DISPUTE_RELEASE adds only when it compensates a DISPUTE_DEBIT, never when it releases a hold", async () => {
      // Newest first: a won-after-lost reversal (relates to debit-1, +400),
      // a hold release (relates to hold-1, 0), the debit itself (−400), the
      // hold (0) and the credit (+1000). Balance: 1000 − 400 + 400 = 1000.
      const debit = entry({
        id: "debit-1",
        idempotencyKey: "dispute-debit:d1",
        type: "DISPUTE_DEBIT",
        amountCents: 400,
        availableAt: null,
        disputeId: "d1",
        relatedEntryId: "hold-1",
        createdAt: new Date("2026-09-13T00:00:00.000Z"),
      });
      const rows: PayeeLedgerEntryRecord[] = [
        entry({
          id: "release-won",
          idempotencyKey: "dispute-debit-reversal:d1",
          type: "DISPUTE_RELEASE",
          amountCents: 400,
          availableAt: null,
          disputeId: "d1",
          relatedEntryId: "debit-1",
          createdAt: new Date("2026-09-15T00:00:00.000Z"),
        }),
        entry({
          id: "release-hold",
          idempotencyKey: "dispute-release:d2:hold-2",
          type: "DISPUTE_RELEASE",
          amountCents: 250,
          availableAt: null,
          disputeId: "d2",
          relatedEntryId: "hold-2",
          createdAt: new Date("2026-09-14T00:00:00.000Z"),
        }),
        debit,
        entry({
          id: "hold-1",
          idempotencyKey: "dispute-hold:d1",
          type: "DISPUTE_HOLD",
          amountCents: 400,
          availableAt: null,
          disputeId: "d1",
          createdAt: new Date("2026-09-12T00:00:00.000Z"),
        }),
        entry({
          id: "credit-1",
          idempotencyKey: "settlement-credit:order-1",
          amountCents: 1000,
          createdAt: new Date("2026-09-11T00:00:00.000Z"),
        }),
      ];
      const h = makeDeps({
        entries: rows,
        balance: { ledgerBalanceCents: 1000, pendingHoldCents: 0, reserveCents: 0 },
        disputeDebits: { d1: [debit], d2: [] },
      });

      const result = await getPayeeStatement(h.deps, orgInput);

      expect(
        result.entries.map((e) => [e.id, e.balanceAfterCents] as const),
      ).toEqual([
        ["release-won", 1000],
        ["release-hold", 600],
        ["debit-1", 600],
        ["hold-1", 1000],
        ["credit-1", 1000],
      ]);
      // One lookup per DISTINCT dispute among the releases, never per row.
      expect(h.listDebitsForDispute).toHaveBeenCalledTimes(2);
      expect(h.listDebitsForDispute).toHaveBeenCalledWith("d1");
      expect(h.listDebitsForDispute).toHaveBeenCalledWith("d2");
    });

    it("a DISPUTE_RELEASE with relatedEntryId but NO disputeId degrades to 0, deliberately", async () => {
      // No writer produces this shape (both set `disputeId`); if one ever
      // did, the lookup has no dispute to ask and must not guess a +.
      const h = makeDeps({
        entries: [
          entry({
            id: "release-orphan",
            type: "DISPUTE_RELEASE",
            amountCents: 400,
            availableAt: null,
            disputeId: null,
            relatedEntryId: "debit-1",
          }),
          entry({ id: "credit-1", amountCents: 1000 }),
        ],
        balance: { ledgerBalanceCents: 1000, pendingHoldCents: 0, reserveCents: 0 },
      });

      const result = await getPayeeStatement(h.deps, orgInput);

      expect(result.balanceAfterResolved).toBe(true);
      expect(
        result.entries.map((e) => [e.id, e.balanceAfterCents] as const),
      ).toEqual([
        ["release-orphan", 1000],
        ["credit-1", 1000],
      ]);
      expect(h.listDebitsForDispute).not.toHaveBeenCalled();
    });

    it("a DISPUTE_RELEASE whose related debit belongs to a DIFFERENT dispute degrades to 0, deliberately", async () => {
      // The lookup pivots on the release's own `disputeId`; a debit filed
      // under another dispute is never a candidate, so the sign stays 0
      // rather than borrowing one from a row this release does not own.
      const foreignDebit = entry({
        id: "debit-other",
        type: "DISPUTE_DEBIT",
        amountCents: 400,
        availableAt: null,
        disputeId: "d-other",
      });
      const h = makeDeps({
        entries: [
          entry({
            id: "release-cross",
            type: "DISPUTE_RELEASE",
            amountCents: 400,
            availableAt: null,
            disputeId: "d1",
            relatedEntryId: "debit-other",
          }),
          entry({ id: "credit-1", amountCents: 1000 }),
        ],
        balance: { ledgerBalanceCents: 1000, pendingHoldCents: 0, reserveCents: 0 },
        disputeDebits: { d1: [], "d-other": [foreignDebit] },
      });

      const result = await getPayeeStatement(h.deps, orgInput);

      expect(result.balanceAfterResolved).toBe(true);
      expect(
        result.entries.map((e) => [e.id, e.balanceAfterCents] as const),
      ).toEqual([
        ["release-cross", 1000],
        ["credit-1", 1000],
      ]);
      expect(h.listDebitsForDispute).toHaveBeenCalledTimes(1);
      expect(h.listDebitsForDispute).toHaveBeenCalledWith("d1");
    });

    it("bounds dispute-debit lookups to DISPUTE_DEBIT_LOOKUP_CONCURRENCY in flight", async () => {
      const releases = Array.from({ length: 25 }, (_, i) =>
        entry({
          id: `release-${i}`,
          idempotencyKey: `release-${i}`,
          type: "DISPUTE_RELEASE",
          amountCents: 10,
          availableAt: null,
          disputeId: `d${i}`,
          relatedEntryId: `debit-${i}`,
        }),
      );
      const h = makeDeps({
        entries: releases,
        balance: { ledgerBalanceCents: 0, pendingHoldCents: 0, reserveCents: 0 },
      });

      const result = await getPayeeStatement(h.deps, { ...orgInput, limit: 25 });

      expect(result.balanceAfterResolved).toBe(true);
      expect(h.listDebitsForDispute).toHaveBeenCalledTimes(25);
      expect(h.disputeDebitsPeak.value).toBeGreaterThan(1);
      expect(h.disputeDebitsPeak.value).toBeLessThanOrEqual(
        DISPUTE_DEBIT_LOOKUP_CONCURRENCY,
      );
    });

    it("a failed seed read blanks EVERY row (null, never 0), flags it, and reports ONCE", async () => {
      const h = makeDeps({
        entries: mixed,
        balance: mixedBalance,
        newerRowsFail: true,
      });

      const result = await getPayeeStatement(h.deps, {
        ...orgInput,
        limit: 2,
        offset: 4,
      });

      // The statement still renders — the money it DOES know is intact.
      expect(result.balanceCents).toBe(2200);
      expect(result.entries.map((e) => e.id)).toEqual(["e2-credit", "e1-credit"]);
      expect(result.entries.map((e) => e.balanceAfterCents)).toEqual([null, null]);
      expect(result.balanceAfterResolved).toBe(false);
      expect(h.reportError).toHaveBeenCalledTimes(1);
      expect(h.reportError).toHaveBeenCalledWith(h.newerRowsFailure, {
        tags: { useCase: "getPayeeStatement", step: "newerEntries" },
        extra: { payeeId: PAYEE_ID, offset: 4 },
      });
      // ERROR, not warn: `logger.warn` is not captured by Sentry.
      expect(h.logger.error).toHaveBeenCalledWith(
        "payee_statement_running_balance_seed_failed",
        expect.objectContaining({ err: h.newerRowsFailure, step: "newerEntries" }),
      );
    });

    it("a failed dispute-debit lookup degrades the same way, tagged as its own read", async () => {
      const h = makeDeps({
        entries: [
          entry({
            id: "release-won",
            type: "DISPUTE_RELEASE",
            amountCents: 400,
            availableAt: null,
            disputeId: "d1",
            relatedEntryId: "debit-1",
          }),
        ],
        balance: { ledgerBalanceCents: 400, pendingHoldCents: 0, reserveCents: 0 },
        disputeDebitsFail: true,
      });

      const result = await getPayeeStatement(h.deps, orgInput);

      expect(result.entries[0]!.balanceAfterCents).toBeNull();
      expect(result.balanceAfterResolved).toBe(false);
      expect(h.reportError).toHaveBeenCalledTimes(1);
      expect(h.reportError).toHaveBeenCalledWith(h.disputeDebitsFailure, {
        tags: { useCase: "getPayeeStatement", step: "disputeDebits" },
        extra: { payeeId: PAYEE_ID, offset: 0 },
      });
    });

    it("a THROWING reporter changes nothing about the degraded result", async () => {
      const h = makeDeps({
        entries: mixed,
        balance: mixedBalance,
        newerRowsFail: true,
        reporterThrows: true,
      });

      const result = await getPayeeStatement(h.deps, {
        ...orgInput,
        limit: 2,
        offset: 4,
      });

      expect(result.balanceAfterResolved).toBe(false);
      expect(result.entries.map((e) => e.balanceAfterCents)).toEqual([null, null]);
      expect(result.balanceCents).toBe(2200);
      expect(h.reportError).toHaveBeenCalledTimes(1);
    });

    it("a healthy first page is unaffected by a seed read that WOULD fail — it is never issued", async () => {
      const h = makeDeps({
        entries: mixed,
        balance: mixedBalance,
        newerRowsFail: true,
      });

      const result = await getPayeeStatement(h.deps, { ...orgInput, offset: 0 });

      expect(result.balanceAfterResolved).toBe(true);
      expect(result.entries[0]!.balanceAfterCents).toBe(2200);
      expect(h.reportError).not.toHaveBeenCalled();
    });
  });

  describe("hard failures", () => {
    it("throws when the BALANCE read fails — there is no honest statement", async () => {
      const h = makeDeps();
      (
        h.deps.repos.payeeLedger.getBalance as unknown as ReturnType<typeof vi.fn>
      ).mockRejectedValue(new Error("db down"));

      await expect(getPayeeStatement(h.deps, orgInput)).rejects.toThrow(
        "db down",
      );
    });

    it("throws when the PAYABLE read fails", async () => {
      const h = makeDeps();
      h.listPayableBalances.mockRejectedValue(new Error("payable timed out"));

      await expect(getPayeeStatement(h.deps, orgInput)).rejects.toThrow(
        "payable timed out",
      );
    });
  });
});
