import { z } from "zod";

import type { Repos } from "@th/ports/repos";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";
import type { ReporterPort } from "@th/ports/reporter";
import { parseInput, describeError } from "../../lib/io";

/**
 * "Do we still have the money?" — the read that was missing.
 *
 * The platform runs a CUSTODIAL model: buyer money lands on OUR Stripe
 * balance via separate charges, and the nightly batch transfers each
 * organiser's share back out of it. That balance is COMMINGLED — organiser
 * float, platform fee revenue, collected sales tax, membership reserves and
 * withheld Connect fees all sit in the same pot. Six comments across the
 * codebase assert "the withheld cents stay on the platform balance" and
 * nothing verified it: `balance.retrieve` was called nowhere in production,
 * nothing summed total liability, and the only signal that the pot had
 * diverged from the obligations was a transfer failing with
 * `balance_insufficient` — i.e. after the fact, to a payee.
 *
 * This use case is the before-the-fact read. It is PURE: it calls one
 * processor read and three repo reads, compares them, and reports. It moves,
 * holds and writes nothing.
 *
 * ── The distinction that makes this worth building ───────────────────────
 *
 *   PAYABLE   = what tonight's batch CAN pay. Filters on maturity
 *               (`availableAt <= now`).
 *   LIABILITY = what we OWE, regardless of maturity. A credit for an event
 *               three weeks out is still the organiser's money.
 *
 * Using payable as liability would report the platform solvent while it was
 * insolvent, so they come from two different repo queries
 * (`listPayableBalances` vs `sumOutstandingLiability`) and are reported as
 * two different numbers with two different headrooms:
 *
 *   headroomCents        = available − liability     → EXISTENTIAL. Negative
 *                          means the money to cover our obligations is not
 *                          there, whether or not anything fails tonight.
 *   tonightHeadroomCents = available − maturedPayable → OPERATIONAL. Negative
 *                          means the batch will hit `balance_insufficient`
 *                          within hours.
 *
 * They fail at different times and for different reasons, which is why both
 * are reported. A platform can be operationally fine for months while
 * quietly going existentially insolvent.
 *
 * ── Deliberate over-statement ────────────────────────────────────────────
 *
 * Liability errs HIGH by construction, in three known ways, because
 * understating it is the direction that hurts:
 *
 *  1. Blocked credits (open dispute / open claim) count in full — they are
 *     still owed to somebody.
 *  2. Dispute holds are added ON TOP of the credits they hold. A held credit
 *     therefore counts twice. Note that Stripe ALSO withdraws a disputed
 *     amount from `available` when the dispute opens, so this term is a
 *     second helping of conservatism rather than a missing one. It is
 *     reported as its own component so a human can subtract it.
 *  3. Tax is gross and all-time: no refund netting, no dispute netting, no
 *     remittance tracking (see `CollectedTaxTotal`).
 *
 * Every component is therefore returned SEPARATELY as well as summed. Do not
 * collapse them.
 *
 * ── Reporting discipline (matches verifyLedgerInvariants) ────────────────
 *
 * READ-ONLY, report never repair. ONE grouped `reportError` per breached
 * class per run — never per currency — plus a `logger.error` carrying the
 * same payload (`logger.warn` is NOT captured by Sentry; per the house
 * convention warn would silently un-Sentry this). Both guarded, so a
 * throwing reporter or logger can never change the outcome.
 *
 * ── What this is NOT ─────────────────────────────────────────────────────
 *
 * NOT a gate. The payout batch does not call it and must not: the balance
 * can change between a pre-check and a transfer, so gating on it would be a
 * TOCTOU race that fails closed on money that was actually there. This is a
 * reporting job.
 */

/**
 * Alert floor for EXISTENTIAL headroom, expressed as a fraction of total
 * liability rather than a dollar figure.
 *
 * Why relative: an absolute floor ("alert under $10,000 of headroom") is
 * correctly calibrated for exactly one month of volume. Early on it fires
 * constantly on a pot that is small because the business is small; later it
 * is silently far too low — $10k of headroom against $2M of obligations is
 * an emergency that an absolute floor reads as healthy. A ratio degrades
 * legibly instead: at $100k owed it alerts below $5k of headroom, at $1M
 * owed below $50k, with no one having to remember to re-tune it.
 *
 * Why LIABILITY is the denominator: liability IS the exposure. Denominating
 * in payable would make the alarm quiet exactly when a large tranche of
 * credits is immature — the case where the gap is easiest to miss and most
 * expensive to discover late.
 *
 * Why 5%: it is roughly the largest single night's payout share we would
 * expect against the whole pot, so a breach means "one ordinary batch could
 * exhaust the buffer" — early enough to act on, far enough above zero not to
 * fire on ordinary intraday settlement timing. It is a judgement call, not a
 * derived constant; move it deliberately, in one place, with this comment.
 *
 * A healthy run alerts on nothing: with zero liability the floor is zero and
 * a non-negative headroom is never below it.
 */
export const SOLVENCY_HEADROOM_FLOOR_RATIO = 0.05;

export const checkPlatformSolvencyInputSchema = z.object({}).strict();

const solvencyCurrencyRowSchema = z
  .object({
    /** Lowercase ISO-4217. Rows NEVER combine currencies. */
    currency: z.string(),

    // ── What we HAVE (null when the processor read failed) ──────────────
    /** Settled, spendable now — what an unfunded transfer draws on. */
    stripeAvailableCents: z.number().int().nullable(),
    /** Collected but not yet settled. Runway, not cash. */
    stripePendingCents: z.number().int().nullable(),
    /**
     * Held by Stripe against connected-account negative balances. On our
     * balance object, NOT ours to spend — reported, never added to available.
     */
    stripeConnectReservedCents: z.number().int().nullable(),

    // ── What we OWE (components, each reported separately) ──────────────
    /** Σ per-payee max(0, signed entry sum), ALL maturities. */
    unpaidCreditsCents: z.number().int(),
    /** Σ rolling-reserve cents withheld from past payouts. */
    reserveHeldCents: z.number().int(),
    /** Σ cents held against open disputes. */
    pendingHoldCents: z.number().int(),
    /** Gross collected sales tax, all time. Upper bound — see the header. */
    unremittedTaxCents: z.number().int(),
    /** The sum of the four components above. */
    liabilityCents: z.number().int(),

    /**
     * Σ max(0, payable) at `now` — what tonight's batch would ATTEMPT,
     * before its per-run `limit` and per-item minimum, so an upper bound on
     * tonight's spend.
     */
    maturedPayableCents: z.number().int(),

    // ── The two headrooms (null when the processor read failed) ─────────
    /** available − liability. Existential. */
    headroomCents: z.number().int().nullable(),
    /** available − maturedPayable. Operational: will tonight clear? */
    tonightHeadroomCents: z.number().int().nullable(),

    /** `SOLVENCY_HEADROOM_FLOOR_RATIO` × liability, rounded up. */
    headroomFloorCents: z.number().int(),
    /** headroom < floor. Always false when the balance is unknown. */
    headroomBelowFloor: z.boolean(),
    /** available < maturedPayable. Always false when the balance is unknown. */
    tonightShortfall: z.boolean(),
  })
  .strict();

export const checkPlatformSolvencyOutputSchema = z
  .object({
    /**
     * The processor balance read failed. Liability figures are still
     * reported; every `stripe*` and `headroom*` field is null and NO
     * solvency verdict is drawn — a failed read must not be mistaken for a
     * zero balance and alert the platform insolvent.
     */
    balanceUnavailable: z.boolean(),
    /**
     * The repo reads failed. Everything else is empty; the fault was
     * reported. Kept separate from `balanceUnavailable` so the two
     * dependencies are diagnosable apart.
     */
    ledgerUnavailable: z.boolean(),
    /** One row per currency seen on EITHER side. Never summed together. */
    currencies: z.array(solvencyCurrencyRowSchema),
  })
  .strict();

export type CheckPlatformSolvencyInput = z.infer<
  typeof checkPlatformSolvencyInputSchema
>;
export type CheckPlatformSolvencyOutput = z.infer<
  typeof checkPlatformSolvencyOutputSchema
>;
export type PlatformSolvencyCurrencyRow = z.infer<
  typeof solvencyCurrencyRowSchema
>;

export type CheckPlatformSolvencyDeps = {
  repos: Repos;
  /**
   * Read-only use of the processor: `getPlatformBalance()` and nothing else.
   * A failure here is REPORTED and swallowed — the caller (the ledger
   * invariant sweep) has three other independently valuable checks that must
   * not be lost to a Stripe outage.
   */
  payments: PaymentProcessorPort;
  clock: ClockPort;
  logger?: LoggerPort;
  /**
   * Breaches and dependency faults are REPORTED, never thrown, which makes
   * every one of them a deliberate swallow: it MUST go through `reportError`
   * (house convention; `logger.warn` is not captured). Guarded so a throwing
   * reporter never changes behaviour.
   */
  reportError?: ReporterPort;
};

/** Sentry/Log tag for every report this use case fires. */
const JOB_TAG = "settlements.verify-ledger";

export async function checkPlatformSolvency(
  deps: CheckPlatformSolvencyDeps,
  rawInput: unknown,
): Promise<CheckPlatformSolvencyOutput> {
  parseInput(checkPlatformSolvencyInputSchema, rawInput);

  const now = deps.clock.now();

  // ── What we OWE, and what tonight would spend ─────────────────────────
  // Sequential on purpose, same reasoning as the invariant sweep: these are
  // full-table aggregates on the pool the API and the payout batch share,
  // for a job with no latency requirement.
  let liabilityRows: Awaited<
    ReturnType<Repos["payeeLedger"]["sumOutstandingLiability"]>
  >;
  let taxRows: Awaited<ReturnType<Repos["orders"]["sumCollectedTaxByCurrency"]>>;
  let payableRows: Awaited<
    ReturnType<Repos["payeeLedger"]["listPayableBalances"]>
  >;
  try {
    liabilityRows = await deps.repos.payeeLedger.sumOutstandingLiability();
    taxRows = await deps.repos.orders.sumCollectedTaxByCurrency();
    payableRows = await deps.repos.payeeLedger.listPayableBalances(now);
  } catch (err) {
    // Swallowed on purpose: this runs inside the ledger sweep, whose other
    // three invariants are independently valuable and have already reported.
    report(deps, "platform_liability_read_failed", err, {
      error: describeError(err),
    });
    return checkPlatformSolvencyOutputSchema.parse({
      balanceUnavailable: true,
      ledgerUnavailable: true,
      currencies: [],
    });
  }

  // ── What we HAVE ──────────────────────────────────────────────────────
  // A processor failure must NOT fail the sweep, and must NOT be read as a
  // zero balance: with `balanceUnavailable` the verdict fields stay null and
  // nothing alerts on solvency this run.
  let balance: Awaited<
    ReturnType<PaymentProcessorPort["getPlatformBalance"]>
  > | null = null;
  try {
    balance = await deps.payments.getPlatformBalance();
  } catch (err) {
    report(deps, "platform_balance_unavailable", err, {
      error: describeError(err),
    });
  }

  const available = bucketByCurrency(balance?.available);
  const pending = bucketByCurrency(balance?.pending);
  const connectReserved = bucketByCurrency(balance?.connectReserved);

  // FOLD duplicates by summing — never `new Map(rows.map(...))`, which is
  // last-wins and silently discards the earlier row's cents.
  //
  // The adapter now folds casings in SQL too, so this is the SECOND line of
  // defence and NOT a live bug guard. Both currency columns are VARCHAR(3),
  // which a 3-letter code fills exactly — so whitespace padding cannot be
  // stored, and casing is the only duplicate these tables could ever produce.
  // The adapter folds that.
  //
  // It stays anyway, and the reason is the contract, not the current bug:
  // core is written against the PORT, which promises one row per currency
  // (`PayeeLedgerLiabilityTotal`), and a use case must not silently depend on
  // one adapter's SQL to make that true. A second repo implementation, or a
  // future query rewrite, would reintroduce the fault here for free.
  //
  // Overwriting would UNDERSTATE liability, and this file's whole premise is
  // that liability errs high — understating it reports the platform solvent
  // while it is insolvent.
  const liability = new Map<
    string,
    { unpaidCreditsCents: number; reserveHeldCents: number; pendingHoldCents: number }
  >();
  for (const row of liabilityRows) {
    const key = normaliseCurrency(row.currency);
    const acc = liability.get(key);
    liability.set(key, {
      unpaidCreditsCents:
        (acc?.unpaidCreditsCents ?? 0) + row.unpaidCreditsCents,
      reserveHeldCents: (acc?.reserveHeldCents ?? 0) + row.reserveHeldCents,
      pendingHoldCents: (acc?.pendingHoldCents ?? 0) + row.pendingHoldCents,
    });
  }

  const tax = new Map<string, number>();
  for (const row of taxRows) {
    const key = normaliseCurrency(row.currency);
    tax.set(key, (tax.get(key) ?? 0) + row.taxCollectedCents);
  }

  // max(0, payable) per cell, grouped by currency — the batch pays a debt
  // position nothing and carries it forward, so a negative cell must not
  // shrink what tonight would attempt.
  const maturedPayable = new Map<string, number>();
  for (const row of payableRows) {
    const key = normaliseCurrency(row.currency);
    maturedPayable.set(
      key,
      (maturedPayable.get(key) ?? 0) + Math.max(0, row.payableCents),
    );
  }

  // Union of every currency either side knows about. A currency present in
  // the ledger and absent from the balance is exactly the interesting case
  // (we owe it and hold none of it), so it must not be dropped.
  const currencies = [
    ...new Set([
      ...liability.keys(),
      ...tax.keys(),
      ...maturedPayable.keys(),
      ...available.keys(),
      ...pending.keys(),
      ...connectReserved.keys(),
    ]),
  ].sort();

  const rows: PlatformSolvencyCurrencyRow[] = currencies.map((currency) => {
    const owed = liability.get(currency);
    const unpaidCreditsCents = owed?.unpaidCreditsCents ?? 0;
    const reserveHeldCents = owed?.reserveHeldCents ?? 0;
    const pendingHoldCents = owed?.pendingHoldCents ?? 0;
    const unremittedTaxCents = tax.get(currency) ?? 0;
    const liabilityCents =
      unpaidCreditsCents +
      reserveHeldCents +
      pendingHoldCents +
      unremittedTaxCents;
    const maturedPayableCents = maturedPayable.get(currency) ?? 0;

    // A missing entry in a Stripe bucket means zero of that currency; a
    // missing BALANCE means unknown. Only the second suppresses the verdict.
    const availableCents = balance ? (available.get(currency) ?? 0) : null;
    const headroomCents =
      availableCents === null ? null : availableCents - liabilityCents;
    const tonightHeadroomCents =
      availableCents === null ? null : availableCents - maturedPayableCents;
    const headroomFloorCents = Math.ceil(
      liabilityCents * SOLVENCY_HEADROOM_FLOOR_RATIO,
    );

    return {
      currency,
      stripeAvailableCents: availableCents,
      stripePendingCents: balance ? (pending.get(currency) ?? 0) : null,
      stripeConnectReservedCents: balance
        ? (connectReserved.get(currency) ?? 0)
        : null,
      unpaidCreditsCents,
      reserveHeldCents,
      pendingHoldCents,
      unremittedTaxCents,
      liabilityCents,
      maturedPayableCents,
      headroomCents,
      tonightHeadroomCents,
      headroomFloorCents,
      headroomBelowFloor:
        headroomCents !== null && headroomCents < headroomFloorCents,
      tonightShortfall: tonightHeadroomCents !== null && tonightHeadroomCents < 0,
    };
  });

  // ONE grouped report per breached class per run — never per currency.
  const belowFloor = rows.filter((r) => r.headroomBelowFloor);
  if (belowFloor.length > 0) {
    report(
      deps,
      "platform_solvency_headroom_low",
      new Error("platform_solvency_headroom_low"),
      {
        floorRatio: SOLVENCY_HEADROOM_FLOOR_RATIO,
        currencies: belowFloor,
      },
    );
  }

  const shortfall = rows.filter((r) => r.tonightShortfall);
  if (shortfall.length > 0) {
    report(
      deps,
      "platform_tonight_shortfall",
      new Error("platform_tonight_shortfall"),
      { currencies: shortfall },
    );
  }

  return checkPlatformSolvencyOutputSchema.parse({
    balanceUnavailable: balance === null,
    ledgerUnavailable: false,
    currencies: rows,
  });
}

type SolvencyFault =
  | "platform_solvency_headroom_low"
  | "platform_tonight_shortfall"
  | "platform_balance_unavailable"
  | "platform_liability_read_failed";

/**
 * One grouped `logger.error` + `reportError` for a breached class. Both
 * guarded: a throwing logger or reporter must never change the read's
 * outcome (see ReporterPort's best-effort contract).
 */
function report(
  deps: CheckPlatformSolvencyDeps,
  invariant: SolvencyFault,
  error: unknown,
  extra: Record<string, unknown>,
): void {
  try {
    deps.logger?.error("checkPlatformSolvency.breach", { invariant, ...extra });
  } catch {
    /* a throwing logger must not stop the read */
  }
  try {
    deps.reportError?.(error, {
      tags: { job: JOB_TAG, invariant },
      extra,
    });
  } catch {
    /* best-effort reporting only — see ReporterPort */
  }
}

function normaliseCurrency(currency: string): string {
  return currency.trim().toLowerCase();
}

/**
 * One Stripe balance bucket → cents by lowercase currency. Duplicate
 * currency entries are summed (Stripe splits some buckets by source type on
 * other endpoints; summing is right, dropping would understate what we hold).
 * `undefined` in, empty map out — the caller distinguishes "no balance read"
 * from "no money in this currency", not this helper.
 */
function bucketByCurrency(
  bucket: Array<{ currency: string; amountCents: number }> | undefined,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const entry of bucket ?? []) {
    const key = normaliseCurrency(entry.currency);
    out.set(key, (out.get(key) ?? 0) + entry.amountCents);
  }
  return out;
}
