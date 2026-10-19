import { fail } from "@th/errors";
import type { CreateOrderTaxLineInput } from "@th/ports/repos/orders";

import type { TaxLinesAndProcessorFeeResult } from "../../../lib/pricing/solve-tax-and-processor-fee";

/**
 * Map a solved tax result onto the `OrderTaxLine` rows an order persists, and
 * enforce the one invariant those rows carry:
 *
 *   Σ amountCents over PLATFORM lines === the `taxAmountCents` stored on the
 *   Order (and charged to the buyer).
 *
 * Both numbers come from the same `solveTaxLinesAndProcessorFee` result, so a
 * mismatch is a wiring bug (e.g. a caller that adjusted the tax after solving).
 * It throws INTERNAL inside the order's transaction rather than committing an
 * order whose breakdown disagrees with its charge.
 */
export function toOrderTaxLineInputs(
  solved: Pick<TaxLinesAndProcessorFeeResult, "lines">,
  orderTaxAmountCents: number,
): CreateOrderTaxLineInput[] {
  const lines = solved.lines.map((line) => ({
    code: line.code,
    label: line.label,
    jurisdiction: line.jurisdiction,
    rateBps: line.rateBps,
    base: line.base,
    collector: line.collector,
    taxableAmountCents: line.taxableAmountCents,
    amountCents: line.amountCents,
  }));
  const platformCents = lines.reduce(
    (sum, line) => (line.collector === "PLATFORM" ? sum + line.amountCents : sum),
    0,
  );
  if (platformCents !== orderTaxAmountCents) {
    throw fail("INTERNAL", {
      message: `order tax lines disagree with the charged tax: Σ PLATFORM lines=${platformCents}, taxAmountCents=${orderTaxAmountCents}`,
    });
  }
  return lines;
}
