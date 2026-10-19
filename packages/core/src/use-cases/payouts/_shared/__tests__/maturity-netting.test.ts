import { describe, expect, it, vi } from "vitest";

import type { PayeeLedgerPayableBalance } from "@th/ports/repos/payee-ledger";

import {
  applyDebtNetting,
  normaliseLedgerCurrency,
  payeeCurrencyCellKey,
  readDebtPositions,
  type MaturityNettingDeps,
} from "../maturity-netting";

const PAYEE = "payee-1";
const OTHER = "payee-2";
const NOW = new Date("2026-09-14T12:00:00.000Z");
const OCT_4 = new Date("2026-10-04T00:00:00.000Z");
const OCT_11 = new Date("2026-10-11T00:00:00.000Z");
const OCT_18 = new Date("2026-10-18T00:00:00.000Z");

const BUDGET = { statementTimeoutMs: 8_000 };
const TELEMETRY = {
  logEvent: "test_debt_lookup_failed",
  useCase: "testCaller",
  step: "applyDebt",
};

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

function tranche(overrides: Partial<{
  payeeId: string;
  currency: string;
  maturesAt: Date;
  creditCents: number;
}> = {}) {
  return {
    payeeId: PAYEE,
    currency: "usd",
    maturesAt: OCT_4,
    creditCents: 10_000,
    ...overrides,
  };
}

function makeDeps(options: { cells?: PayeeLedgerPayableBalance[]; fail?: boolean } = {}) {
  const failure = new Error("payable read timed out");
  const listPayableBalances = vi.fn(async () => {
    if (options.fail) throw failure;
    return options.cells ?? [];
  });
  const reportError = vi.fn();
  const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
  const deps = {
    repos: { payeeLedger: { listPayableBalances } },
    logger,
    reportError,
  } as unknown as MaturityNettingDeps;
  return { deps, listPayableBalances, reportError, logger, failure };
}

describe("readDebtPositions", () => {
  it("issues NO read and resolves empty for an empty payee set", async () => {
    const h = makeDeps();

    const out = await readDebtPositions(h.deps, {
      asOf: NOW,
      payeeIds: [],
      budget: BUDGET,
      telemetry: TELEMETRY,
    });

    expect(out).toEqual({ resolved: true, debtByCell: new Map() });
    expect(h.listPayableBalances).not.toHaveBeenCalled();
  });

  it("dedupes payee ids and passes the budget through to the narrowed read", async () => {
    const h = makeDeps();

    await readDebtPositions(h.deps, {
      asOf: NOW,
      payeeIds: [PAYEE, PAYEE, OTHER],
      budget: BUDGET,
      telemetry: TELEMETRY,
    });

    expect(h.listPayableBalances).toHaveBeenCalledWith(
      NOW,
      [PAYEE, OTHER],
      BUDGET,
    );
  });

  it("reports only NEGATIVE cells, as positive cents to consume", async () => {
    const h = makeDeps({
      cells: [
        payable({ payableCents: -4_000 }),
        payable({ payeeId: OTHER, payableCents: 9_000 }),
      ],
    });

    const out = await readDebtPositions(h.deps, {
      asOf: NOW,
      payeeIds: [PAYEE, OTHER],
      budget: BUDGET,
      telemetry: TELEMETRY,
    });

    expect(out).toEqual({
      resolved: true,
      debtByCell: new Map([[payeeCurrencyCellKey(PAYEE, "usd"), 4_000]]),
    });
  });

  it("folds raw currency casings into ONE cell BEFORE testing the sign", async () => {
    // +5,000 'USD' and −3,000 'usd' are one +2,000 cell with NO debt. Testing
    // the sign per raw row first would invent a 3,000 debt out of nothing.
    const h = makeDeps({
      cells: [
        payable({ currency: "USD", payableCents: 5_000 }),
        payable({ currency: "usd", payableCents: -3_000 }),
      ],
    });

    const out = await readDebtPositions(h.deps, {
      asOf: NOW,
      payeeIds: [PAYEE],
      budget: BUDGET,
      telemetry: TELEMETRY,
    });

    expect(out).toEqual({ resolved: true, debtByCell: new Map() });
  });

  it("swallows a failed payable read, logs at ERROR and reports it", async () => {
    const h = makeDeps({ fail: true });

    const out = await readDebtPositions(h.deps, {
      asOf: NOW,
      payeeIds: [PAYEE],
      budget: BUDGET,
      telemetry: TELEMETRY,
    });

    expect(out).toEqual({ resolved: false });
    expect(h.logger.error).toHaveBeenCalledWith(
      "test_debt_lookup_failed",
      expect.objectContaining({ err: h.failure, payeeCount: 1 }),
    );
    expect(h.reportError).toHaveBeenCalledWith(
      h.failure,
      expect.objectContaining({
        tags: { useCase: "testCaller", step: "applyDebt" },
      }),
    );
    // `logger.warn` is NOT captured by Sentry — the swallow must not use it.
    expect(h.logger.warn).not.toHaveBeenCalled();
  });

  it("a THROWING reporter never turns a degraded read into a failed one", async () => {
    const h = makeDeps({ fail: true });
    h.reportError.mockImplementation(() => {
      throw new Error("sentry is down");
    });

    await expect(
      readDebtPositions(h.deps, {
        asOf: NOW,
        payeeIds: [PAYEE],
        budget: BUDGET,
        telemetry: TELEMETRY,
      }),
    ).resolves.toEqual({ resolved: false });
  });

  it("a MISSING reporter never changes the result either", async () => {
    const h = makeDeps({ fail: true });
    (h.deps as { reportError?: unknown }).reportError = undefined;

    await expect(
      readDebtPositions(h.deps, {
        asOf: NOW,
        payeeIds: [PAYEE],
        budget: BUDGET,
        telemetry: TELEMETRY,
      }),
    ).resolves.toEqual({ resolved: false });
  });
});

describe("applyDebtNetting", () => {
  const resolved = (entries: [string, number][]) =>
    ({ resolved: true, debtByCell: new Map(entries) }) as const;

  it("with no debt, expected equals gross", () => {
    const out = applyDebtNetting([tranche()], resolved([]));

    expect(out).toEqual([
      expect.objectContaining({ debtAppliedCents: 0, expectedCents: 10_000 }),
    ]);
  });

  it("consumes debt soonest tranche first, carrying the remainder forward", () => {
    const out = applyDebtNetting(
      [
        tranche({ maturesAt: OCT_4, creditCents: 3_000 }),
        tranche({ maturesAt: OCT_11, creditCents: 5_000 }),
        tranche({ maturesAt: OCT_18, creditCents: 5_000 }),
      ],
      resolved([[payeeCurrencyCellKey(PAYEE, "usd"), 7_000]]),
    );

    expect(
      out.map((r) => [r.debtAppliedCents, r.expectedCents]),
    ).toEqual([
      [3_000, 0],
      [4_000, 1_000],
      [0, 5_000],
    ]);
  });

  it("THE TRACE: gross 7,000 under a 3,000 hold nets to 4,000, not 1,000", () => {
    // The hold is ALREADY inside today's payable (−3,000), so the walk is the
    // only place it may be applied. `heldCents` is never an operand.
    const out = applyDebtNetting(
      [{ ...tranche({ creditCents: 7_000 }), heldCents: 3_000 }],
      resolved([[payeeCurrencyCellKey(PAYEE, "usd"), 3_000]]),
    );

    expect(out[0]!.expectedCents).toBe(4_000);
    expect(out[0]!.heldCents).toBe(3_000);
  });

  it("never nets across currencies or across payees", () => {
    const out = applyDebtNetting(
      [
        tranche({ currency: "eur", creditCents: 4_000 }),
        tranche({ payeeId: OTHER, creditCents: 4_000 }),
        tranche({ creditCents: 4_000 }),
      ],
      resolved([[payeeCurrencyCellKey(PAYEE, "usd"), 4_000]]),
    );

    expect(out.map((r) => r.expectedCents)).toEqual([4_000, 4_000, 0]);
  });

  it("matches a raw-cased payable cell against a normalised tranche", () => {
    const out = applyDebtNetting(
      [tranche({ currency: "USD", creditCents: 5_000 })],
      resolved([[payeeCurrencyCellKey(PAYEE, "usd"), 2_000]]),
    );

    expect(out[0]!.expectedCents).toBe(3_000);
  });

  it("walks in MATURITY order even when the feed arrives out of order, and preserves input order out", () => {
    const out = applyDebtNetting(
      [
        tranche({ maturesAt: OCT_18, creditCents: 5_000 }),
        tranche({ maturesAt: OCT_4, creditCents: 2_000 }),
      ],
      resolved([[payeeCurrencyCellKey(PAYEE, "usd"), 3_000]]),
    );

    // Oct 4 eats 2,000 first; Oct 18 takes the remaining 1,000. Rows come
    // back in the order they went in.
    expect(out.map((r) => [r.maturesAt, r.debtAppliedCents])).toEqual([
      [OCT_18, 1_000],
      [OCT_4, 2_000],
    ]);
  });

  it("clamps expected at zero — a tranche never goes negative", () => {
    const out = applyDebtNetting(
      [tranche({ creditCents: 1_000 })],
      resolved([[payeeCurrencyCellKey(PAYEE, "usd"), 9_000]]),
    );

    expect(out[0]).toMatchObject({
      debtAppliedCents: 1_000,
      expectedCents: 0,
    });
  });

  it("an UNRESOLVED debt read nulls every debt-dependent figure, never zeroes them", () => {
    const out = applyDebtNetting([tranche(), tranche({ maturesAt: OCT_11 })], {
      resolved: false,
    });

    expect(out.map((r) => [r.debtAppliedCents, r.expectedCents])).toEqual([
      [null, null],
      [null, null],
    ]);
    // Gross survives: it came from a read that DID land.
    expect(out.map((r) => r.creditCents)).toEqual([10_000, 10_000]);
  });
});

describe("normaliseLedgerCurrency", () => {
  it("trims and lower-cases", () => {
    expect(normaliseLedgerCurrency("  USD ")).toBe("usd");
  });
});
