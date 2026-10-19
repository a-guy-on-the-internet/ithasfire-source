import { describe, it, expect, vi } from "vitest";

import type { Repos } from "@th/ports/repos";
import type {
  PayeeLedgerLiabilityTotal,
  PayeeLedgerPayableBalance,
} from "@th/ports/repos/payee-ledger";
import type { CollectedTaxTotal } from "@th/ports/repos/orders";
import type {
  PaymentProcessorPort,
  PlatformBalanceSnapshot,
} from "@th/ports/payment-processor-port";
import {
  checkPlatformSolvency,
  SOLVENCY_HEADROOM_FLOOR_RATIO,
  type CheckPlatformSolvencyOutput,
  type PlatformSolvencyCurrencyRow,
} from "../check-platform-solvency";

/**
 * Unit coverage for the solvency read.
 *
 * Two properties carry this suite, and neither survives being asserted
 * loosely:
 *
 *  1. LIABILITY IS NOT PAYABLE. The use case exists because using tonight's
 *     payable as the liability reports the platform solvent while it is
 *     insolvent. The test that matters is therefore the one where tonight
 *     clears comfortably and the existential headroom is already breached.
 *
 *  2. A FAILED READ IS NOT A ZERO. `balanceUnavailable` must leave every
 *     verdict field null and both booleans false. A Stripe outage that
 *     rendered as "available: 0" would page the on-call for insolvency on a
 *     healthy platform, and — worse in the other direction — a future reader
 *     could take `headroomCents: 0` for "measured, exactly break-even".
 *
 * Reporting discipline is asserted the same way as the sibling sweep
 * (`verify-ledger-invariants.test.ts`): ONE grouped report per breached class
 * per run, never per currency, and a throwing reporter or logger never
 * changes the returned value.
 *
 * The SQL behind the three repo reads is proven against real Postgres in
 * adapters/.../payee-ledger-invariants.integration.test.ts; nothing here
 * re-litigates it.
 */

const NOW = new Date("2026-09-12T04:00:00.000Z");

const liabilityRow = (
  over: Partial<PayeeLedgerLiabilityTotal> = {},
): PayeeLedgerLiabilityTotal => ({
  currency: "usd",
  unpaidCreditsCents: 0,
  reserveHeldCents: 0,
  pendingHoldCents: 0,
  ...over,
});

const taxRow = (over: Partial<CollectedTaxTotal> = {}): CollectedTaxTotal => ({
  currency: "usd",
  taxCollectedCents: 0,
  orderCount: 0,
  ...over,
});

const payableRow = (
  over: Partial<PayeeLedgerPayableBalance> = {},
): PayeeLedgerPayableBalance => ({
  payeeId: "payee-1",
  currency: "usd",
  payableCents: 0,
  oldestMaturedAt: null,
  ...over,
});

const balance = (
  over: Partial<PlatformBalanceSnapshot> = {},
): PlatformBalanceSnapshot => ({
  available: [],
  pending: [],
  connectReserved: [],
  ...over,
});

function makeDeps(opts: {
  liability?: PayeeLedgerLiabilityTotal[];
  tax?: CollectedTaxTotal[];
  payable?: PayeeLedgerPayableBalance[];
  /** A snapshot, or an Error to throw from `getPlatformBalance`. */
  balance?: PlatformBalanceSnapshot | Error;
  /** Throw from the FIRST ledger read, to exercise `ledgerUnavailable`. */
  ledgerError?: Error;
  logger?: { error: ReturnType<typeof vi.fn> };
  reportError?: ReturnType<typeof vi.fn>;
}) {
  const sumOutstandingLiability = vi.fn(async () => {
    if (opts.ledgerError) throw opts.ledgerError;
    return opts.liability ?? [];
  });
  const sumCollectedTaxByCurrency = vi.fn(async () => opts.tax ?? []);
  const listPayableBalances = vi.fn(async () => opts.payable ?? []);
  const getPlatformBalance = vi.fn(async () => {
    if (opts.balance instanceof Error) throw opts.balance;
    return opts.balance ?? balance();
  });

  const logger = opts.logger ?? {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  const reportError = opts.reportError ?? vi.fn();

  const deps = {
    repos: {
      payeeLedger: { sumOutstandingLiability, listPayableBalances },
      orders: { sumCollectedTaxByCurrency },
    } as unknown as Repos,
    payments: { getPlatformBalance } as unknown as PaymentProcessorPort,
    clock: { now: () => NOW },
    logger: logger as never,
    reportError,
  };

  return {
    deps,
    logger,
    reportError,
    getPlatformBalance,
    listPayableBalances,
  };
}

/** The single row of a single-currency run, for the arithmetic tests. */
const onlyRow = (out: CheckPlatformSolvencyOutput): PlatformSolvencyCurrencyRow =>
  out.currencies[0]!;

const rowFor = (
  out: CheckPlatformSolvencyOutput,
  currency: string,
): PlatformSolvencyCurrencyRow =>
  out.currencies.find((c) => c.currency === currency)!;

/** The `(error, context)` pair a ReporterPort call is made of. */
type ReportCall = [
  unknown,
  { tags: { job: string; invariant: string }; extra: Record<string, unknown> },
];
const reportCalls = (m: { mock: { calls: unknown[][] } }) =>
  m.mock.calls as ReportCall[];
const invariants = (m: { mock: { calls: unknown[][] } }) =>
  reportCalls(m).map((c) => c[1].tags.invariant);

describe("checkPlatformSolvency", () => {
  describe("the arithmetic", () => {
    it("sums liability from its four components and reports each separately", async () => {
      const { deps } = makeDeps({
        liability: [
          liabilityRow({
            unpaidCreditsCents: 100_000,
            reserveHeldCents: 25_000,
            pendingHoldCents: 10_000,
          }),
        ],
        tax: [taxRow({ taxCollectedCents: 7_500 })],
        balance: balance({ available: [{ currency: "usd", amountCents: 1 }] }),
      });

      const row = onlyRow(await checkPlatformSolvency(deps, {}));

      expect(row.liabilityCents).toBe(142_500);
      // Never collapsed: a human triaging a thin balance needs to see which
      // component moved, and they carry different certainty.
      expect(row.unpaidCreditsCents).toBe(100_000);
      expect(row.reserveHeldCents).toBe(25_000);
      expect(row.pendingHoldCents).toBe(10_000);
      expect(row.unremittedTaxCents).toBe(7_500);
    });

    it("derives both headrooms from the two different denominators", async () => {
      const { deps } = makeDeps({
        liability: [liabilityRow({ unpaidCreditsCents: 100_000 })],
        payable: [payableRow({ payableCents: 30_000 })],
        balance: balance({
          available: [{ currency: "usd", amountCents: 80_000 }],
        }),
      });

      const row = onlyRow(await checkPlatformSolvency(deps, {}));

      expect(row.headroomCents).toBe(-20_000); // 80_000 − 100_000
      expect(row.tonightHeadroomCents).toBe(50_000); // 80_000 − 30_000
    });

    it("floors the headroom alarm at the liability ratio, rounded UP", async () => {
      const { deps } = makeDeps({
        // 5% of 100_001 is 5000.05 — proves ceil, not round or floor. A
        // rounded-DOWN floor is quietly the more permissive alarm.
        liability: [liabilityRow({ unpaidCreditsCents: 100_001 })],
        balance: balance({
          available: [{ currency: "usd", amountCents: 105_001 }],
        }),
      });

      const row = onlyRow(await checkPlatformSolvency(deps, {}));

      expect(SOLVENCY_HEADROOM_FLOOR_RATIO).toBe(0.05);
      expect(row.headroomFloorCents).toBe(5_001);
      expect(row.headroomCents).toBe(5_000);
      expect(row.headroomBelowFloor).toBe(true);
    });

    it("headroom sitting EXACTLY on the floor does not alert", async () => {
      // floor = ceil(100_000 × 0.05) = 5_000, headroom = 105_000 − 100_000 =
      // 5_000. The comparison is `<`, not `<=`: a platform parked exactly at
      // its threshold must not alarm forever. The sibling boundary (tonight's
      // shortfall at exactly 0) is covered by the clean-run test.
      const { deps, reportError } = makeDeps({
        liability: [liabilityRow({ unpaidCreditsCents: 100_000 })],
        balance: balance({
          available: [{ currency: "usd", amountCents: 105_000 }],
        }),
      });

      const row = onlyRow(await checkPlatformSolvency(deps, {}));

      expect(row.headroomFloorCents).toBe(5_000);
      expect(row.headroomCents).toBe(5_000);
      expect(row.headroomBelowFloor).toBe(false);
      expect(reportError).not.toHaveBeenCalled();
    });

    it("a clean run alerts on nothing, and zero liability cannot alert", async () => {
      const { deps, reportError, logger } = makeDeps({
        liability: [liabilityRow({ unpaidCreditsCents: 0 })],
        balance: balance({ available: [{ currency: "usd", amountCents: 0 }] }),
      });

      const row = onlyRow(await checkPlatformSolvency(deps, {}));

      // floor = ceil(0 × 0.05) = 0, headroom = 0, and 0 < 0 is false. The
      // degenerate case has to be silent or the job cries wolf from day one.
      expect(row.headroomFloorCents).toBe(0);
      expect(row.headroomBelowFloor).toBe(false);
      expect(row.tonightShortfall).toBe(false);
      expect(reportError).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
    });
  });

  describe("the three Stripe buckets", () => {
    it("reports all three, and counts ONLY `available` toward the headrooms", async () => {
      const { deps } = makeDeps({
        liability: [liabilityRow({ unpaidCreditsCents: 600_000 })],
        payable: [payableRow({ payableCents: 400_000 })],
        balance: balance({
          available: [{ currency: "usd", amountCents: 500_000 }],
          pending: [{ currency: "usd", amountCents: 70_000 }],
          connectReserved: [{ currency: "usd", amountCents: 200_000 }],
        }),
      });

      const row = onlyRow(await checkPlatformSolvency(deps, {}));

      expect(row.stripeAvailableCents).toBe(500_000);
      expect(row.stripePendingCents).toBe(70_000);
      expect(row.stripeConnectReservedCents).toBe(200_000);

      // The load-bearing assertions. `pending` is collected-not-settled and
      // `connectReserved` is Stripe's, held against connected-account negative
      // balances — the port doc says it is NOT ours to spend. Folding either
      // into `available` turns −100_000 into +100_000 (or +170_000) and
      // silences the alarm on a platform that is genuinely short.
      expect(row.headroomCents).toBe(-100_000);
      expect(row.tonightHeadroomCents).toBe(100_000);
      expect(row.headroomBelowFloor).toBe(true);
    });

    it("connect-reserved money cannot rescue a breach", async () => {
      const { deps, reportError } = makeDeps({
        liability: [liabilityRow({ unpaidCreditsCents: 650_000 })],
        balance: balance({
          available: [{ currency: "usd", amountCents: 500_000 }],
          connectReserved: [{ currency: "usd", amountCents: 200_000 }],
        }),
      });

      const row = onlyRow(await checkPlatformSolvency(deps, {}));

      // Folded, this would be +50_000 and healthy. It is neither.
      expect(row.headroomCents).toBe(-150_000);
      expect(row.headroomBelowFloor).toBe(true);
      expect(invariants(reportError)).toEqual([
        "platform_solvency_headroom_low",
      ]);
    });

    it("an OVERDRAWN balance alerts even with nothing owed", async () => {
      const { deps, reportError } = makeDeps({
        balance: balance({
          available: [{ currency: "usd", amountCents: -20_000 }],
        }),
      });

      const row = onlyRow(await checkPlatformSolvency(deps, {}));

      // A Stripe balance CAN go negative (refunds/chargebacks against a thin
      // pot). "Zero liability cannot alert" is about the FLOOR being zero —
      // it must not be read as "zero liability is always silent".
      expect(row.liabilityCents).toBe(0);
      expect(row.headroomFloorCents).toBe(0);
      expect(row.headroomCents).toBe(-20_000);
      expect(row.headroomBelowFloor).toBe(true);

      // BOTH classes fire, and the second is arguably noise: `tonightShortfall`
      // is `available < maturedPayable`, which an overdrawn balance satisfies
      // even when NOTHING is due tonight (maturedPayable = 0). Pinned as the
      // behaviour that exists rather than the behaviour I would have guessed —
      // if the shortfall alarm should require something actually payable, that
      // is a use-case change, not a test change.
      expect(invariants(reportError)).toEqual([
        "platform_solvency_headroom_low",
        "platform_tonight_shortfall",
      ]);
      expect(row.tonightShortfall).toBe(true);
      expect(row.maturedPayableCents).toBe(0);
    });
  });

  describe("liability is not payable — the reason this use case exists", () => {
    it("flags existential insolvency while tonight's batch clears comfortably", async () => {
      const { deps, reportError } = makeDeps({
        // Most of what we owe is immature: absent from payable, present here.
        liability: [liabilityRow({ unpaidCreditsCents: 1_000_000 })],
        payable: [payableRow({ payableCents: 10_000 })],
        balance: balance({
          available: [{ currency: "usd", amountCents: 200_000 }],
        }),
      });

      const row = onlyRow(await checkPlatformSolvency(deps, {}));

      // Operationally fine — tonight pays out without touching the problem.
      expect(row.tonightShortfall).toBe(false);
      expect(row.tonightHeadroomCents).toBe(190_000);
      // Existentially broke. Had payable been used as the liability, this row
      // would have reported healthy.
      expect(row.headroomCents).toBe(-800_000);
      expect(row.headroomBelowFloor).toBe(true);

      expect(invariants(reportError)).toEqual([
        "platform_solvency_headroom_low",
      ]);
    });

    it("flags tonight's shortfall on its own, before any transfer fails", async () => {
      const { deps, reportError } = makeDeps({
        liability: [liabilityRow({ unpaidCreditsCents: 10_000 })],
        payable: [payableRow({ payableCents: 50_000 })],
        balance: balance({
          available: [{ currency: "usd", amountCents: 20_000 }],
        }),
      });

      const row = onlyRow(await checkPlatformSolvency(deps, {}));

      expect(row.tonightHeadroomCents).toBe(-30_000);
      expect(row.tonightShortfall).toBe(true);
      // toEqual, not toContain: a spurious SECOND report is a regression too.
      expect(invariants(reportError)).toEqual(["platform_tonight_shortfall"]);
      // The payload is the whole point of the grouped report — a Sentry event
      // with an empty `extra` is not triageable without a DB query.
      expect(reportCalls(reportError)[0][1].extra).toMatchObject({
        currencies: [expect.objectContaining({ tonightHeadroomCents: -30_000 })],
      });
    });

    it("clamps a negative payable cell at zero so a payee in debt cannot shrink tonight's spend", async () => {
      const { deps } = makeDeps({
        payable: [
          payableRow({ payeeId: "owes-us", payableCents: -80_000 }),
          payableRow({ payeeId: "owed", payableCents: 20_000 }),
        ],
        balance: balance({
          available: [{ currency: "usd", amountCents: 20_000 }],
        }),
      });

      const row = onlyRow(await checkPlatformSolvency(deps, {}));

      // max(0, ·) per cell: 20_000, NOT -60_000. Netting them would report
      // tonight as costing nothing.
      expect(row.maturedPayableCents).toBe(20_000);
    });
  });

  describe("a failed read is never a zero", () => {
    it("balance unavailable: verdict fields null, both booleans false, liability still reported", async () => {
      const stripeDown = new Error("stripe down");
      const { deps, reportError } = makeDeps({
        liability: [liabilityRow({ unpaidCreditsCents: 500_000 })],
        payable: [payableRow({ payableCents: 400_000 })],
        balance: stripeDown,
      });

      const out = await checkPlatformSolvency(deps, {});
      const row = onlyRow(out);

      expect(out.balanceUnavailable).toBe(true);
      expect(out.ledgerUnavailable).toBe(false);

      expect(row.stripeAvailableCents).toBeNull();
      expect(row.stripePendingCents).toBeNull();
      expect(row.stripeConnectReservedCents).toBeNull();
      expect(row.headroomCents).toBeNull();
      expect(row.tonightHeadroomCents).toBeNull();

      // The load-bearing half: with the balance unknown, NO solvency verdict
      // is drawn. These two staying false is what stops a Stripe outage
      // paging someone about insolvency.
      expect(row.headroomBelowFloor).toBe(false);
      expect(row.tonightShortfall).toBe(false);

      // What we owe is knowable without Stripe, so it is still reported.
      expect(row.liabilityCents).toBe(500_000);
      expect(row.maturedPayableCents).toBe(400_000);

      expect(invariants(reportError)).toEqual(["platform_balance_unavailable"]);
      const [thrown, context] = reportCalls(reportError)[0];
      expect(context.tags.job).toBe("settlements.verify-ledger");
      // The CAUGHT error by identity — swapping in a generic Error loses the
      // Stripe type and stack that make the Sentry issue actionable.
      expect(thrown).toBe(stripeDown);
      expect(context.extra.error).toBe("stripe down");
    });

    it("ledger unavailable: reports, returns empty, and never calls the processor", async () => {
      const { deps, reportError, getPlatformBalance } = makeDeps({
        ledgerError: new Error("pg down"),
      });

      const out = await checkPlatformSolvency(deps, {});

      expect(out.ledgerUnavailable).toBe(true);
      // Also true, and deliberately so: nothing was measured this run, so
      // nothing may read as measured.
      expect(out.balanceUnavailable).toBe(true);
      expect(out.currencies).toEqual([]);
      expect(getPlatformBalance).not.toHaveBeenCalled();

      expect(invariants(reportError)).toEqual([
        "platform_liability_read_failed",
      ]);
      expect(reportCalls(reportError)[0][1].extra.error).toBe("pg down");
    });

    it("swallows both faults — the sweep's other invariants must survive an outage", async () => {
      const { deps } = makeDeps({ balance: new Error("stripe down") });
      await expect(checkPlatformSolvency(deps, {})).resolves.toMatchObject({
        balanceUnavailable: true,
      });

      const ledgerDown = makeDeps({ ledgerError: new Error("pg down") });
      await expect(
        checkPlatformSolvency(ledgerDown.deps, {}),
      ).resolves.toMatchObject({ ledgerUnavailable: true });
    });
  });

  describe("reporting discipline", () => {
    it("reports ONE grouped breach per class per run, never one per currency", async () => {
      const { deps, reportError } = makeDeps({
        liability: [
          liabilityRow({ currency: "usd", unpaidCreditsCents: 100_000 }),
          liabilityRow({ currency: "eur", unpaidCreditsCents: 100_000 }),
          liabilityRow({ currency: "gbp", unpaidCreditsCents: 100_000 }),
        ],
        balance: balance({ available: [] }), // read OK, zero of everything
      });

      const out = await checkPlatformSolvency(deps, {});

      expect(out.currencies).toHaveLength(3);
      expect(out.currencies.every((c) => c.headroomBelowFloor)).toBe(true);

      // Three breached currencies, ONE report. Per-currency reporting on a
      // mass breach floods Sentry and destroys the signal.
      expect(reportError).toHaveBeenCalledTimes(1);
      const [error, context] = reportCalls(reportError)[0];
      expect(context.tags.invariant).toBe("platform_solvency_headroom_low");
      expect((error as Error).message).toBe("platform_solvency_headroom_low");
      // Which threshold fired — the only thing telling a human why.
      expect(context.extra.floorRatio).toBe(SOLVENCY_HEADROOM_FLOOR_RATIO);
      // Full ROWS, not just codes: length alone passes for [1,2,3].
      expect(context.extra.currencies).toHaveLength(3);
      expect((context.extra.currencies as PlatformSolvencyCurrencyRow[])[0])
        .toMatchObject({
          currency: "eur",
          liabilityCents: 100_000,
          headroomCents: -100_000,
          headroomFloorCents: 5_000,
        });
    });

    it("reports the two breach classes separately when both fire", async () => {
      const { deps, reportError } = makeDeps({
        liability: [liabilityRow({ unpaidCreditsCents: 100_000 })],
        payable: [payableRow({ payableCents: 90_000 })],
        balance: balance({
          available: [{ currency: "usd", amountCents: 1_000 }],
        }),
      });

      await checkPlatformSolvency(deps, {});

      expect(invariants(reportError)).toEqual([
        "platform_solvency_headroom_low",
        "platform_tonight_shortfall",
      ]);
      // Distinct Error instances per class: Sentry groups by the exception, so
      // one shared error would merge two unrelated breaches into one issue.
      const [first, second] = reportCalls(reportError);
      expect((first[0] as Error).message).toBe("platform_solvency_headroom_low");
      expect((second[0] as Error).message).toBe("platform_tonight_shortfall");
    });

    it("logs at error, never warn — warn is not captured by Sentry", async () => {
      const logger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      };
      const { deps } = makeDeps({
        liability: [liabilityRow({ unpaidCreditsCents: 100_000 })],
        balance: balance({ available: [] }),
        logger: logger as never,
      });

      await checkPlatformSolvency(deps, {});

      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.warn).not.toHaveBeenCalled();
      // The message and the invariant key are what make the log greppable,
      // and pinoIntegration ships this payload to Sentry.
      expect(logger.error).toHaveBeenCalledWith(
        "checkPlatformSolvency.breach",
        expect.objectContaining({ invariant: "platform_solvency_headroom_low" }),
      );
    });

    it("a THROWING reporter never changes the outcome", async () => {
      // Built in two steps on purpose: `vi.fn(() => { throw })` infers its
      // return as `never`/`void` and will not assign to the general mock slot
      // `makeDeps` takes. `mockImplementation` keeps the broad type.
      const reportError = vi.fn();
      reportError.mockImplementation(() => {
        throw new Error("sentry exploded");
      });
      const { deps } = makeDeps({
        liability: [liabilityRow({ unpaidCreditsCents: 100_000 })],
        balance: balance({ available: [] }),
        reportError,
      });

      const out = await checkPlatformSolvency(deps, {});

      expect(reportError).toHaveBeenCalled();
      expect(onlyRow(out).headroomBelowFloor).toBe(true);
    });

    it("a THROWING logger never changes the outcome either", async () => {
      const logger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn((): void => {
          throw new Error("logger exploded");
        }),
        debug: vi.fn(),
      };
      const { deps, reportError } = makeDeps({
        liability: [liabilityRow({ unpaidCreditsCents: 100_000 })],
        balance: balance({ available: [] }),
        logger: logger as never,
      });

      const out = await checkPlatformSolvency(deps, {});

      // The report still fires: the logger's failure must not swallow it.
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(onlyRow(out).headroomBelowFloor).toBe(true);
    });

    it("a throw in the FIRST report never suppresses the SECOND", async () => {
      const reportError = vi.fn();
      reportError.mockImplementation(() => {
        throw new Error("sentry exploded");
      });
      const { deps } = makeDeps({
        liability: [liabilityRow({ unpaidCreditsCents: 100_000 })],
        payable: [payableRow({ payableCents: 90_000 })],
        balance: balance({
          available: [{ currency: "usd", amountCents: 1_000 }],
        }),
        reportError,
      });

      const out = await checkPlatformSolvency(deps, {});

      // Two classes, two attempts. Hoisting the try/catch out of `report()` to
      // wrap both call sites would lose the second breach entirely.
      expect(invariants(reportError)).toEqual([
        "platform_solvency_headroom_low",
        "platform_tonight_shortfall",
      ]);
      expect(onlyRow(out).tonightShortfall).toBe(true);
    });

    it("a missing reporter is fine — reporting is optional by contract", async () => {
      const { deps } = makeDeps({
        liability: [liabilityRow({ unpaidCreditsCents: 100_000 })],
        balance: balance({ available: [] }),
      });
      delete (deps as { reportError?: unknown }).reportError;

      // Assert a real field: `toBeDefined()` only proves it did not throw.
      const out = await checkPlatformSolvency(deps, {});
      expect(onlyRow(out).headroomBelowFloor).toBe(true);
    });
  });

  describe("currencies", () => {
    it("keeps a currency known ONLY to the tax read", async () => {
      const { deps } = makeDeps({
        tax: [taxRow({ currency: "cad", taxCollectedCents: 5_000 })],
        balance: balance({}),
      });

      const out = await checkPlatformSolvency(deps, {});
      const cad = rowFor(out, "cad");

      // Every CAD payee credit is paid out and we hold no CAD, but we still
      // owe the collected tax. Drop `tax.keys()` from the union and this
      // obligation disappears from the report entirely.
      expect(cad).toBeDefined();
      expect(cad.unremittedTaxCents).toBe(5_000);
      expect(cad.liabilityCents).toBe(5_000);
      expect(cad.headroomCents).toBe(-5_000);
      expect(cad.headroomBelowFloor).toBe(true);
    });

    it("keeps a currency known ONLY to a non-available balance bucket", async () => {
      const { deps } = makeDeps({
        balance: balance({ pending: [{ currency: "gbp", amountCents: 7_000 }] }),
      });

      const out = await checkPlatformSolvency(deps, {});
      const gbp = rowFor(out, "gbp");

      expect(gbp).toBeDefined();
      expect(gbp.stripePendingCents).toBe(7_000);
      expect(gbp.stripeAvailableCents).toBe(0);
    });

    it("sorts the rows, so two nights' Sentry payloads diff cleanly", async () => {
      const { deps } = makeDeps({
        // Insertion order is usd, eur, gbp — deliberately NOT sorted, so a
        // deleted `.sort()` fails here instead of passing by coincidence.
        liability: [
          liabilityRow({ currency: "usd" }),
          liabilityRow({ currency: "eur" }),
          liabilityRow({ currency: "gbp" }),
        ],
        balance: balance({}),
      });

      const out = await checkPlatformSolvency(deps, {});

      expect(out.currencies.map((c) => c.currency)).toEqual([
        "eur",
        "gbp",
        "usd",
      ]);
    });

    it("keeps a currency we owe but hold none of — the interesting case", async () => {
      const { deps } = makeDeps({
        liability: [liabilityRow({ currency: "eur", unpaidCreditsCents: 5_000 })],
        balance: balance({
          available: [{ currency: "usd", amountCents: 900_000 }],
        }),
      });

      const out = await checkPlatformSolvency(deps, {});
      const eur = rowFor(out, "eur");

      expect(out.currencies.map((c) => c.currency)).toEqual(["eur", "usd"]);
      // Balance READ fine, just none of this currency — so 0, not null, and
      // the verdict IS drawn. A dollar pile cannot cover a euro debt.
      expect(eur.stripeAvailableCents).toBe(0);
      expect(eur.headroomCents).toBe(-5_000);
      expect(eur.headroomBelowFloor).toBe(true);
    });

    it("never lets one currency's surplus cover another's debt", async () => {
      const { deps } = makeDeps({
        liability: [liabilityRow({ currency: "eur", unpaidCreditsCents: 5_000 })],
        balance: balance({
          available: [{ currency: "usd", amountCents: 900_000 }],
        }),
      });

      const out = await checkPlatformSolvency(deps, {});
      const usd = rowFor(out, "usd");

      expect(usd.headroomCents).toBe(900_000);
      expect(usd.headroomBelowFloor).toBe(false);
    });

    it("normalises case and whitespace so one currency is never two rows", async () => {
      const { deps } = makeDeps({
        liability: [liabilityRow({ currency: " USD " })],
        tax: [taxRow({ currency: "usd", taxCollectedCents: 1_000 })],
        balance: balance({
          available: [{ currency: "UsD", amountCents: 2_000 }],
        }),
      });

      const out = await checkPlatformSolvency(deps, {});

      expect(out.currencies).toHaveLength(1);
      expect(onlyRow(out).currency).toBe("usd");
      expect(onlyRow(out).stripeAvailableCents).toBe(2_000);
      expect(onlyRow(out).unremittedTaxCents).toBe(1_000);
    });

    it("FOLDS duplicate rows from ONE repo read instead of overwriting", async () => {
      // Guards the PORT CONTRACT, not a currently-reachable bug. Both adapters
      // now fold casings in SQL, and the currency columns are VARCHAR(3) — a
      // 3-letter code fills them, so no whitespace variant can be stored
      // either. Nothing in the database can produce two rows for one currency
      // today.
      //
      // The fold stays because core is written against the port, which
      // promises one row per currency. Deleting it would make this use case
      // silently dependent on one adapter's SQL for its own arithmetic to be
      // right — and the direction of that failure is the bad one: dropping a
      // row understates liability, and this file's header promises liability
      // errs HIGH. Understating it reports the platform solvent while it is
      // insolvent, the exact failure the use case exists to catch.
      const { deps } = makeDeps({
        liability: [
          liabilityRow({
            currency: "USD",
            unpaidCreditsCents: 1_000_000,
            reserveHeldCents: 700,
            pendingHoldCents: 300,
          }),
          liabilityRow({
            currency: "usd",
            unpaidCreditsCents: 5_000,
            reserveHeldCents: 70,
            pendingHoldCents: 30,
          }),
        ],
        tax: [
          taxRow({ currency: "USD", taxCollectedCents: 3_000 }),
          taxRow({ currency: "usd", taxCollectedCents: 2_000 }),
        ],
        balance: balance({
          available: [{ currency: "usd", amountCents: 50_000 }],
        }),
      });

      const out = await checkPlatformSolvency(deps, {});
      const row = onlyRow(out);

      expect(out.currencies).toHaveLength(1);
      // All THREE components asserted: each is folded on its own line in the
      // accumulator, so each needs its own non-zero regression guard.
      expect(row.unpaidCreditsCents).toBe(1_005_000);
      expect(row.reserveHeldCents).toBe(770);
      expect(row.pendingHoldCents).toBe(330);
      expect(row.unremittedTaxCents).toBe(5_000);
      expect(row.liabilityCents).toBe(1_011_100);
      // 50_000 − 1_011_100. Last-wins reports +45_000 and stays silent.
      expect(row.headroomCents).toBe(-961_100);
      expect(row.headroomBelowFloor).toBe(true);
    });

    it("sums duplicate entries within a balance bucket rather than dropping them", async () => {
      const { deps } = makeDeps({
        balance: balance({
          // Stripe splits some buckets by source type; dropping the second
          // entry would understate what we hold.
          available: [
            { currency: "usd", amountCents: 30_000 },
            { currency: "usd", amountCents: 12_000 },
          ],
        }),
      });

      expect(onlyRow(await checkPlatformSolvency(deps, {})).stripeAvailableCents).toBe(
        42_000,
      );
    });
  });

  describe("boundary", () => {
    it("reads payable as of the clock's now, not a fresh Date", async () => {
      const { deps, listPayableBalances } = makeDeps({});
      await checkPlatformSolvency(deps, {});
      expect(listPayableBalances).toHaveBeenCalledWith(NOW);
    });

    it("rejects unknown input keys (strict schema at the boundary)", async () => {
      const { deps } = makeDeps({});
      // toThrow() passes on ANY thrown value; the house contract is a typed
      // `{ code }` object that transports map on. Match the sibling sweep.
      await expect(
        checkPlatformSolvency(deps, { graceMinutes: 30 }),
      ).rejects.toMatchObject({ code: "invalid_input" });
    });
  });
});
