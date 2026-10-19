import { solveProcessingFeeGrossUp } from "../processing-cost-schedule";

/**
 * INDEPENDENT test oracle for the `BUYER_TOTAL` (Tennessee) joint solve.
 *
 * Deliberately NOT the production fixed-point iteration: it brute-forces upward
 * for the SMALLEST tax that is self-consistent with the processor fee its own
 * charge implies. A test that re-implemented `solveTaxAndProcessorFee`'s loop
 * would pass on a drifted loop; this one cannot, and it independently pins
 * MINIMALITY (it returns the least solution by construction).
 *
 * Lives outside a `*.test.ts` so more than one suite can share it — importing a
 * test file would re-run its `describe`s inside the importer.
 *
 * @param netBaseCents ticket gross + buyer-funded platform fee (everything the
 *   charge must cover except tax and the processor fee)
 */
export function referenceBuyerTotalTax(
  netBaseCents: number,
  taxRateBps: number,
  processorPct: number,
  processorFixedCents: number,
): { taxCents: number; processorFeeCents: number } {
  for (let taxCents = 0; taxCents <= netBaseCents; taxCents += 1) {
    const processorFeeCents = solveProcessingFeeGrossUp(
      netBaseCents + taxCents,
      processorPct,
      processorFixedCents,
    );
    if (
      taxCents ===
      Math.round(((netBaseCents + processorFeeCents) * taxRateBps) / 10_000)
    ) {
      return { taxCents, processorFeeCents };
    }
  }
  throw new Error(
    `no self-consistent tax/fee pair for netBase=${netBaseCents} rateBps=${taxRateBps}`,
  );
}
