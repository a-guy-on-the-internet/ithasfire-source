import {
  solveTaxLinesAndProcessorFee,
  type TaxLinesAndProcessorFeeResult,
} from "./solve-tax-and-processor-fee";
import type { TaxImposition } from "./tax-impositions";

/**
 * What a resale buyer is charged: the basis, the processing pass-through and
 * the tax, solved together. The ONE resale call into the joint solve, shared
 * by the listing (pre-tax figure), the listing page's estimate and
 * `createResaleCheckout`, so the three never disagree.
 *
 * Owner, 2026-10-14: "WE DO NOT ABSORB THE 2.9% PROCESSING FEE. YEP FOR
 * CONSISTENCY." So processing is grossed up over the FULL charge, tax
 * included, with the same solve and the same inputs a primary PASS_THROUGH
 * sale uses (`priceComputedCart`): the basis is the taxable gross, there is no
 * platform fee on a resale (R11), and the processor fee is solved jointly with
 * every tax line (a `BUYER_TOTAL` line taxes basis + processing, a
 * `TICKET_FACE` line the basis alone). A resale and a primary sale of the same
 * amount, tax lines and processor rate charge the same processing to the cent.
 *
 * Cash has no processing fee, but a resale is always a card charge.
 */
export type ResaleChargeInput = {
  /** The ask, plus the event's share when the buyer pays it. */
  basisCents: number;
  /**
   * Every imposition, resolved exactly as checkout resolves them. `[]` gives
   * the pre-tax figure a listing stores and shows ("plus tax").
   */
  taxLines: ReadonlyArray<TaxImposition>;
  /** Processor rate as a decimal (fee policy `processsorFeePct`). */
  processorPct: number;
  /** Processor per-charge fixed fee (fee policy `processorFixedCents`). */
  processorFixedCents: number;
};

export type ResaleCharge = {
  basisCents: number;
  /** Σ PLATFORM tax lines: `Order.taxAmountCents`. */
  taxCents: number;
  /** Processing the buyer pays, grossed up over basis + tax. */
  processingPassThroughCents: number;
  /** `basisCents + processingPassThroughCents + taxCents`: the charge. */
  totalCents: number;
  /** The full solve, for the order's tax lines. */
  taxSolve: TaxLinesAndProcessorFeeResult;
};

export function solveResaleCharge(input: ResaleChargeInput): ResaleCharge {
  const taxSolve = solveTaxLinesAndProcessorFee({
    taxableGrossCents: input.basisCents,
    buyerPlatformFeeCents: 0,
    taxLines: input.taxLines,
    passThrough: true,
    processorPct: input.processorPct,
    processorFixedCents: input.processorFixedCents,
  });
  const taxCents = taxSolve.taxCents;
  const processingPassThroughCents = taxSolve.processorFeeCents;
  return {
    basisCents: input.basisCents,
    taxCents,
    processingPassThroughCents,
    totalCents: input.basisCents + processingPassThroughCents + taxCents,
    taxSolve,
  };
}
