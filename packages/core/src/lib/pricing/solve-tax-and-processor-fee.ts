import { fail } from "@th/errors";

import { solveProcessingFeeGrossUp } from "./processing-cost-schedule";
import type { TaxImposition } from "./tax-impositions";
import type { TaxableBase } from "./taxable-base";

/**
 * THE one place an order's admission tax and its pass-through processor fee are
 * computed together.
 *
 * WHY TOGETHER. Under a `BUYER_TOTAL` base (Tennessee) the taxable amount
 * includes the processing fee the buyer is charged — and in PASS_THROUGH that
 * fee is itself grossed up over the tax. The two are genuinely circular:
 *
 *   tax       = round(rate × (gross + platform + processor))
 *   processor = solveProcessingFeeGrossUp(gross + platform + tax, pct, fixed, cap)
 *
 * Computing them in one pass (tax from a tax-free processor estimate, then the
 * processor over that tax) leaves the tax a cent or two short of the amount
 * actually charged. We solve the pair to a FIXED POINT instead, so both
 * equations hold exactly on the numbers we charge.
 *
 * Under `TICKET_FACE` (everywhere else, i.e. every jurisdiction as of today)
 * there is no circularity and this reduces, byte for byte, to the arithmetic
 * every call site ran before: `round(gross × rate)` then one gross-up over
 * `gross + platform + tax`.
 */

export type TaxAndProcessorFeeInput = {
  /**
   * The admission amount the tax applies to at minimum: ticket face AFTER any
   * promo discount, BEFORE any fee. `<= 0` means no tax and no fee.
   */
  taxableGrossCents: number;
  /**
   * Platform fee funded by the BUYER (`buyerFeesCents` / `feesPlatformCents`).
   *
   * Counted ONLY when `passThrough` — in ABSORB the seller eats the platform
   * fee out of the face, the buyer pays face + tax, and there is nothing extra
   * for `BUYER_TOTAL` to tax. Ignoring it here rather than trusting each caller
   * to zero it keeps a caller that passes the ORDER's platform fee (as the hold
   * path does) from taxing money the buyer never pays.
   */
  buyerPlatformFeeCents: number;
  /**
   * Any OTHER fee the buyer is already known to be paying, which does NOT move
   * with the tax and so needs no gross-up. No production caller passes one
   * today: resale solves its processing here too, over basis + tax
   * (`solveResaleCharge`). Always counted in a `BUYER_TOTAL` base, whatever
   * `passThrough` says.
   */
  otherBuyerFundedFeeCents?: number;
  /** Admission tax rate in basis points. `<= 0` means no tax. */
  taxRateBps: number;
  /** Jurisdictional base from `resolveTaxableBase(situs)`. */
  taxableBase: TaxableBase;
  /**
   * True when the buyer funds the processor fee (effective fee mode
   * PASS_THROUGH). False → `processorFeeCents` is 0 and the caller keeps
   * whatever ABSORB-side processor number it already had.
   */
  passThrough: boolean;
  /** Processor percentage rate as a decimal (e.g. 0.029). */
  processorPct: number;
  /** Processor per-ORDER fixed fee in cents (e.g. 30). */
  processorFixedCents: number;
  /** Optional per-transaction processor fee cap (e.g. ACH $5 = 500). */
  processorCapCents?: number;
};

export type TaxAndProcessorFeeResult = {
  /** Admission tax in cents, rounded ONCE over `taxBasisCents`. */
  taxCents: number;
  /** Grossed-up processor fee in cents. 0 unless `passThrough`. */
  processorFeeCents: number;
  /**
   * The amount the tax was actually computed on — the face under
   * `TICKET_FACE`, face + buyer platform fee + processor fee under
   * `BUYER_TOTAL`. Surfaced for audit/logging, not persisted.
   */
  taxBasisCents: number;
  /**
   * Fixed-point iterations used (0 when no circularity existed). Asserted in
   * tests; a caller has no reason to branch on it.
   */
  iterations: number;
};

/**
 * Hard cap on fixed-point iterations.
 *
 * Convergence bound: a change of δ in the processor fee moves the tax by
 * `rate·δ`, which moves the fee back by `rate·δ·pct/(1 − pct)` — so each pass
 * multiplies the remaining disagreement by `rate·pct/(1 − pct)`, ≈0.0029 at
 * 9.75% tax + 2.9% card. Integer cents then floor it to 0 within a pass or two.
 * Measured over the sweep in `solve-tax-and-processor-fee.test.ts` (gross
 * 1¢–$3,000, rates 0.01%–20%, pct 0–5%): worst case 5 passes, and that only at
 * 20% tax + 5% pct; 3 for every realistic US admission rate.
 *
 * This is a bound, not a guarantee for every LEGAL input: the guard below only
 * refuses `rate + pct >= 1`, so a pathological-but-permitted pair (say 40% tax
 * with a 40% processor, factor ≈0.27 on a large order) can need more than 8
 * passes. That case throws INTERNAL, which is the intended outcome — refusing
 * to price beats charging numbers that satisfy neither equation — but the cap is
 * NOT "impossible to reach", it is "unreachable for anything we sell".
 */
export const MAX_TAX_PROCESSOR_ITERATIONS = 8;

function taxOn(baseCents: number, taxRateBps: number): number {
  return Math.round((baseCents * taxRateBps) / 10_000);
}

// ─────────────────────────────────────────────────────────────────────────────
// The general solve: a LIST of impositions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Input to {@link solveTaxLinesAndProcessorFee}. Identical to
 * {@link TaxAndProcessorFeeInput} except that the single `taxRateBps` +
 * `taxableBase` pair is replaced by the imposition list from
 * `resolveTaxImpositions` (`lib/pricing/tax-impositions.ts`).
 */
export type TaxLinesAndProcessorFeeInput = Omit<
  TaxAndProcessorFeeInput,
  "taxRateBps" | "taxableBase"
> & {
  /**
   * Every imposition the admission owes — PLATFORM and ORGANISER alike. REQUIRED
   * and never defaulted: an empty list is a real answer ("no tax"), a missing
   * one is a wiring bug the compiler should name.
   */
  taxLines: ReadonlyArray<TaxImposition>;
};

/** One imposition, solved. Maps 1:1 onto an `OrderTaxLine` row. */
export type SolvedTaxLine = TaxImposition & {
  /** What the rate was applied to (0 when the line did not tax). */
  taxableAmountCents: number;
  /** `round(taxableAmountCents × rateBps / 10⁴)`, rounded per line. */
  amountCents: number;
};

export type TaxLinesAndProcessorFeeResult = {
  /** Every input line, in input order, with its base and amount. */
  lines: SolvedTaxLine[];
  /**
   * Σ `amountCents` over PLATFORM lines — what the buyer is charged in tax and
   * what `Order.taxAmountCents` stores. ORGANISER lines are NOT in it.
   */
  taxCents: number;
  /** Grossed-up processor fee over gross + fees + ALL platform tax. */
  processorFeeCents: number;
  /** Fixed-point iterations (0 when no circularity existed). */
  iterations: number;
};

function assertKnownLine(line: TaxImposition): void {
  // An unrecognised base/collector is a wiring bug, not a jurisdiction. Refuse
  // rather than pick one — money must not be computed from a guess. Checked
  // for EVERY line, taxing or not, so a bad row cannot hide behind a 0 rate.
  if (line.base !== "TICKET_FACE" && line.base !== "BUYER_TOTAL") {
    throw fail("INTERNAL", {
      message: `unknown taxable base ${JSON.stringify(line.base)}`,
    });
  }
  if (line.collector !== "PLATFORM" && line.collector !== "ORGANISER") {
    throw fail("INTERNAL", {
      message: `unknown tax collector ${JSON.stringify(line.collector)}`,
    });
  }
}

/**
 * Solve every admission-tax line + the pass-through processor fee jointly.
 *
 * ALGORITHM. Let `net = gross + staticFees` (staticFees = the buyer platform fee
 * when passing through, plus any `otherBuyerFundedFeeCents`) and `P` the
 * PLATFORM lines with a positive rate on a positive gross.
 *
 *  1. Face lines (`TICKET_FACE`) are FIXED: `tᵢ = round(gross × rᵢ)`, summed
 *     into `T_F`. They cannot move with the fee.
 *  2. No `BUYER_TOTAL` platform line, or nothing passed through (no gross-up):
 *     total lines tax `net` (`= gross + other fees` in ABSORB), and the fee is
 *     ONE gross-up over `net + ΣT`. Zero iterations.
 *  3. Otherwise the total lines and the fee are circular. Seed
 *     `p = grossUp(net + T_F)` — a lower bound, since the fee is non-decreasing
 *     in the tax it covers — then iterate
 *       `T_B = Σⱼ round((net + p) × rⱼ)`,  `p' = grossUp(net + T_F + T_B)`
 *     until neither `T_B` nor `p` moves. Every step is non-decreasing, so the
 *     sequence climbs monotonically from a lower bound and stops at the LEAST
 *     fixed point: the minimal sufficient pair, never a cent short of what the
 *     processor deducts. The fee is grossed up over ALL platform tax (face and
 *     total), because all of it is in the charge.
 *  4. ORGANISER lines are computed last, on the settled numbers (face → gross;
 *     total → `net + p`). They are not in `taxCents` and not in the gross-up
 *     target: the buyer is not charged them.
 *
 * Each line rounds on its own, because each is remitted on its own.
 *
 * CONVERGENCE. One pass multiplies the remaining disagreement by
 * `(Σ r_B)·pct/(1 − pct)`, so the guard refuses `Σ r_B + pct >= 1` (BUYER_TOTAL
 * PLATFORM rates only — face lines and ORGANISER lines never feed the loop)
 * rather than spinning, and non-convergence inside
 * {@link MAX_TAX_PROCESSOR_ITERATIONS} throws `INTERNAL` rather than charging
 * numbers that satisfy neither equation.
 *
 * SINGLE-LINE IDENTITY. With one PLATFORM line this is the 2392f1fc solve,
 * operation for operation: `T_F` is the old face branch's `taxOn(gross)`, the
 * seed is the old `grossUp(net)` (T_F = 0 under BUYER_TOTAL), the loop body and
 * its settle test (`tax unchanged && fee unchanged`, tax starting at 0) are the
 * old loop's. Proven against a frozen copy of the old function in
 * `solve-tax-lines.test.ts` (grid + 40k-case property test).
 */
export function solveTaxLinesAndProcessorFee(
  input: TaxLinesAndProcessorFeeInput,
): TaxLinesAndProcessorFeeResult {
  const {
    taxableGrossCents,
    buyerPlatformFeeCents,
    otherBuyerFundedFeeCents = 0,
    taxLines,
    passThrough,
    processorPct,
    processorFixedCents,
    processorCapCents,
  } = input;

  // A missing list is a wiring bug (an `as never` caller), never "no tax":
  // refuse rather than quote a price with every imposition silently dropped.
  if (!Array.isArray(taxLines)) {
    throw fail("INTERNAL", { message: "tax imposition list is required" });
  }
  for (const line of taxLines) assertKnownLine(line);

  const grossUp = (netTargetCents: number): number =>
    passThrough
      ? solveProcessingFeeGrossUp(
          netTargetCents,
          processorPct,
          processorFixedCents,
          processorCapCents,
        )
      : 0;

  // No tax on a zero/negative taxable gross, and none at a zero rate — the
  // same guard every call site ran before. `> 0` is false for NaN too.
  const grossTaxes = taxableGrossCents > 0;
  const taxes = (line: TaxImposition): boolean =>
    grossTaxes && line.rateBps > 0;

  const staticBuyerFeeCents =
    (passThrough ? buyerPlatformFeeCents : 0) + otherBuyerFundedFeeCents;
  const netBaseCents = taxableGrossCents + staticBuyerFeeCents;

  // `!== "BUYER_TOTAL"` rather than `=== "TICKET_FACE"`: an unexpected value can
  // only fall to the NARROWER base. `assertKnownLine` makes that unreachable;
  // this is the belt.
  const isTotal = (line: TaxImposition) => line.base === "BUYER_TOTAL";
  const platformTaxing = taxLines.filter(
    (line) => line.collector === "PLATFORM" && taxes(line),
  );
  const faceLines = platformTaxing.filter((line) => !isTotal(line));
  const totalLines = platformTaxing.filter(isTotal);

  const faceTaxCents = faceLines.reduce(
    (sum, line) => sum + taxOn(taxableGrossCents, line.rateBps),
    0,
  );
  const totalTaxAt = (processorFeeCents: number): number =>
    totalLines.reduce(
      (sum, line) =>
        sum + taxOn(netBaseCents + processorFeeCents, line.rateBps),
      0,
    );

  let processorFeeCents: number;
  let iterations = 0;

  if (totalLines.length === 0 || !passThrough) {
    // ── No circularity ──────────────────────────────────────────────────
    // Face-only, or the buyer funds no processor fee (grossUp ≡ 0, so the
    // total lines tax `net`). The historical two-step.
    const taxCents = faceTaxCents + totalTaxAt(0);
    processorFeeCents = grossUp(netBaseCents + taxCents);
  } else {
    // ── BUYER_TOTAL + PASS_THROUGH: solve the circle ────────────────────
    const totalRateBps = totalLines.reduce((sum, line) => sum + line.rateBps, 0);
    if (totalRateBps / 10_000 + processorPct >= 1) {
      throw fail("INTERNAL", {
        message: `cannot solve taxable base BUYER_TOTAL at rateBps=${totalRateBps} + pct=${processorPct} (>= 100% combined)`,
      });
    }

    processorFeeCents = grossUp(netBaseCents + faceTaxCents);
    let totalTaxCents = 0;
    let settled = false;
    for (
      let iteration = 1;
      iteration <= MAX_TAX_PROCESSOR_ITERATIONS;
      iteration += 1
    ) {
      const nextTotalTaxCents = totalTaxAt(processorFeeCents);
      const nextProcessorFeeCents = grossUp(
        netBaseCents + faceTaxCents + nextTotalTaxCents,
      );
      settled =
        nextTotalTaxCents === totalTaxCents &&
        nextProcessorFeeCents === processorFeeCents;
      totalTaxCents = nextTotalTaxCents;
      processorFeeCents = nextProcessorFeeCents;
      if (settled) {
        iterations = iteration;
        break;
      }
    }
    if (!settled) {
      // Unreachable for any realistic input (see the sweep tests). Throwing
      // beats charging a price that satisfies neither equation.
      throw fail("INTERNAL", {
        message: `tax/processor fixed point did not converge in ${MAX_TAX_PROCESSOR_ITERATIONS} iterations (gross=${taxableGrossCents}, platform=${buyerPlatformFeeCents}, rateBps=${totalRateBps}, pct=${processorPct}, fixed=${processorFixedCents})`,
      });
    }
  }

  // Every line — PLATFORM and ORGANISER — on the SETTLED numbers. For PLATFORM
  // lines this recomputes exactly what the branch above summed (same `p`).
  const lines: SolvedTaxLine[] = taxLines.map((line) => {
    if (!taxes(line)) {
      return { ...line, taxableAmountCents: 0, amountCents: 0 };
    }
    const taxableAmountCents = isTotal(line)
      ? netBaseCents + processorFeeCents
      : taxableGrossCents;
    return {
      ...line,
      taxableAmountCents,
      amountCents: taxOn(taxableAmountCents, line.rateBps),
    };
  });

  const taxCents = lines.reduce(
    (sum, line) =>
      line.collector === "PLATFORM" ? sum + line.amountCents : sum,
    0,
  );

  return { lines, taxCents, processorFeeCents, iterations };
}

// ─────────────────────────────────────────────────────────────────────────────
// Single-imposition form
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The 2392f1fc single-rate API, now a ONE-LINE call into
 * {@link solveTaxLinesAndProcessorFee}.
 *
 * KEPT so the pinned literals in `solve-tax-and-processor-fee.test.ts` run
 * UNCHANGED against the generalised solve — that suite passing untouched is
 * part of the identity proof. It is NOT for money sites: a caller holding one
 * rate and one base is the exact shape that drops a local imposition. Every
 * charge and estimate passes the resolved imposition list to
 * `solveTaxLinesAndProcessorFee`; `solve-tax-lines.callers.test.ts` fails if a
 * production file imports this.
 *
 * @deprecated for production use — see above.
 */
export function solveTaxAndProcessorFee(
  input: TaxAndProcessorFeeInput,
): TaxAndProcessorFeeResult {
  const { taxRateBps, taxableBase, ...rest } = input;
  const result = solveTaxLinesAndProcessorFee({
    ...rest,
    taxLines: [
      {
        code: "SALES",
        label: "Sales tax",
        jurisdiction: "UNKNOWN",
        rateBps: taxRateBps,
        base: taxableBase,
        collector: "PLATFORM",
      },
    ],
  });
  return {
    taxCents: result.taxCents,
    processorFeeCents: result.processorFeeCents,
    taxBasisCents: result.lines[0]?.taxableAmountCents ?? 0,
    iterations: result.iterations,
  };
}
