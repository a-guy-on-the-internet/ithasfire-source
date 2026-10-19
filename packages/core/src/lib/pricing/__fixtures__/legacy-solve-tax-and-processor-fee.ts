/**
 * FROZEN ORACLE — a byte-for-byte copy of `solveTaxAndProcessorFee` as it stood
 * at commit 2392f1fc (the single-rate, single-base solve), before it was
 * generalised to a list of tax impositions.
 *
 * DO NOT EDIT THE ARITHMETIC BELOW. Its only job is to let
 * `solve-tax-lines.test.ts` prove the generalised solver is
 * byte-identical to the old one for a single SALES line across a wide input
 * range. Changes vs the original file: this header, import paths (`../` for the
 * sibling modules), and the export renamed to `legacySolveTaxAndProcessorFee`
 * so nothing can import it by accident in place of the real thing.
 *
 * Lives outside a `*.test.ts` for the same reason as `buyer-total-tax-oracle.ts`.
 */
import { fail } from "@th/errors";

import { solveProcessingFeeGrossUp } from "../processing-cost-schedule";
import type { TaxableBase } from "../taxable-base";

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

export type LegacyTaxAndProcessorFeeInput = {
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
   * with the tax and so needs no gross-up — the resale processing pass-through
   * (a simple markup over the ask) is the one case today. Always counted in a
   * `BUYER_TOTAL` base, whatever `passThrough` says.
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

export type LegacyTaxAndProcessorFeeResult = {
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
const MAX_TAX_PROCESSOR_ITERATIONS = 8;

function taxOn(baseCents: number, taxRateBps: number): number {
  return Math.round((baseCents * taxRateBps) / 10_000);
}

/**
 * Solve admission tax + pass-through processor fee jointly.
 *
 * Contract:
 *  - Integer cents throughout; no floating-point money leaves this function.
 *  - `processorFeeCents` keeps `solveProcessingFeeGrossUp`'s contract exactly —
 *    the MINIMAL fee for which the buyer's charge still nets the full
 *    `gross + platform + tax` after the processor's own (ceil'd, capped)
 *    deduction.
 *  - `taxCents === round(taxBasisCents × rate)` on the returned numbers, and
 *    `taxBasisCents` is the base the buyer is actually charged. Both equations
 *    hold simultaneously — that is what "fixed point" buys.
 *  - Throws `INTERNAL` rather than returning a wrong price: on a rate that can
 *    never be grossed up (`rate + pct >= 1`) or on non-convergence.
 */
export function legacySolveTaxAndProcessorFee(
  input: LegacyTaxAndProcessorFeeInput,
): LegacyTaxAndProcessorFeeResult {
  const {
    taxableGrossCents,
    buyerPlatformFeeCents,
    otherBuyerFundedFeeCents = 0,
    taxRateBps,
    taxableBase,
    passThrough,
    processorPct,
    processorFixedCents,
    processorCapCents,
  } = input;

  // An unrecognised base is a wiring bug, not a jurisdiction. Refuse rather
  // than pick one: `taxableBase` is required at every call site precisely so
  // this cannot be reached, and money must not be computed from a guess.
  if (taxableBase !== "TICKET_FACE" && taxableBase !== "BUYER_TOTAL") {
    throw fail("INTERNAL", {
      message: `unknown taxable base ${JSON.stringify(taxableBase)}`,
    });
  }

  const grossUp = (netTargetCents: number): number =>
    passThrough
      ? solveProcessingFeeGrossUp(
          netTargetCents,
          processorPct,
          processorFixedCents,
          processorCapCents,
        )
      : 0;

  // Matches every pre-existing call site's guard: no tax on a zero/negative
  // taxable gross, and no tax at a zero rate.
  const taxable = taxRateBps > 0 && taxableGrossCents > 0;
  // Fees the buyer funds that are already known, i.e. everything except the
  // processor gross-up this function solves. Also the net target the gross-up
  // has to clear.
  const staticBuyerFeeCents =
    (passThrough ? buyerPlatformFeeCents : 0) + otherBuyerFundedFeeCents;
  const netBaseCents = taxableGrossCents + staticBuyerFeeCents;
  // The taxable amount BEFORE the solved processor fee joins it.
  const staticTaxBasisCents =
    taxableBase === "BUYER_TOTAL" ? netBaseCents : taxableGrossCents;

  if (!taxable) {
    return {
      taxCents: 0,
      processorFeeCents: grossUp(netBaseCents),
      taxBasisCents: 0,
      iterations: 0,
    };
  }

  // ── No circularity: face-only base, or the buyer funds no processor fee ──
  // Both reduce to the historical two-step. Keep them on a separate path so
  // the byte-identical claim for every non-TN jurisdiction is structural, not
  // a property of the loop below.
  // Written as `!== "BUYER_TOTAL"` rather than `=== "TICKET_FACE"` so an
  // unexpected value can only ever fall to the NARROWER (historical) base —
  // never silently widen a live charge. The guard above makes that unreachable;
  // this is the belt.
  if (taxableBase !== "BUYER_TOTAL" || !passThrough) {
    const taxCents = taxOn(staticTaxBasisCents, taxRateBps);
    return {
      taxCents,
      processorFeeCents: grossUp(netBaseCents + taxCents),
      taxBasisCents: staticTaxBasisCents,
      iterations: 0,
    };
  }

  // ── BUYER_TOTAL + PASS_THROUGH: solve the pair ──────────────────────────
  // A rate that, together with the processor's cut, consumes the whole charge
  // has no solution. `solveProcessingFeeGrossUp` already refuses pct >= 1;
  // this refuses the combined case rather than spinning to the iteration cap.
  if (taxRateBps / 10_000 + processorPct >= 1) {
    throw fail("INTERNAL", {
      message: `cannot solve taxable base BUYER_TOTAL at rateBps=${taxRateBps} + pct=${processorPct} (>= 100% combined)`,
    });
  }

  // Seed from the tax-free gross-up — a strict lower bound for the processor
  // fee, since the fee is non-decreasing in the tax it has to cover. Iterating
  // UP from a lower bound is what makes the fixed point we land on the least
  // one, i.e. the minimal sufficient pair.
  let processorFeeCents = grossUp(netBaseCents);
  let taxCents = 0;

  for (
    let iteration = 1;
    iteration <= MAX_TAX_PROCESSOR_ITERATIONS;
    iteration += 1
  ) {
    const nextTaxCents = taxOn(
      staticTaxBasisCents + processorFeeCents,
      taxRateBps,
    );
    const nextProcessorFeeCents = grossUp(netBaseCents + nextTaxCents);
    const settled =
      nextTaxCents === taxCents && nextProcessorFeeCents === processorFeeCents;
    taxCents = nextTaxCents;
    processorFeeCents = nextProcessorFeeCents;
    if (settled) {
      // Both equations now hold on these exact numbers (and under
      // BUYER_TOTAL staticTaxBasisCents IS netBaseCents):
      //   taxCents          === round(rate × (taxBasis))
      //   processorFeeCents === grossUp(netBase + taxCents)
      return {
        taxCents,
        processorFeeCents,
        taxBasisCents: staticTaxBasisCents + processorFeeCents,
        iterations: iteration,
      };
    }
  }

  // Unreachable for any realistic input (see the sweep test). Throwing beats
  // charging a price that satisfies neither equation.
  throw fail("INTERNAL", {
    message: `tax/processor fixed point did not converge in ${MAX_TAX_PROCESSOR_ITERATIONS} iterations (gross=${taxableGrossCents}, platform=${buyerPlatformFeeCents}, rateBps=${taxRateBps}, pct=${processorPct}, fixed=${processorFixedCents})`,
  });
}
