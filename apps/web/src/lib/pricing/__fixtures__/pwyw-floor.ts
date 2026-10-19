import { computePlatformFeePerTicketCents } from "@th/core/lib/pricing/compute-ticket-price-for-agreement";
import { solveTaxLinesAndProcessorFee } from "@th/core/lib/pricing/solve-tax-and-processor-fee";

import type { FeeRatesForOrderEstimate } from "../order-estimate";

/**
 * The owner's example for the pay-what-you-want "From" ruling (2026-10-02):
 * a $5 floor at 8.88% sales tax (TICKET_FACE), fees on top — 3.33% platform
 * fee capped at 50¢ a ticket, Stripe's 2.9% + 30¢ processing. The embed
 * header shows "From $6.09" for it.
 */
export const PWYW_FLOOR_CENTS = 500;
export const PWYW_FLOOR_ALL_IN_CENTS = 609;

export const RATES_888: FeeRatesForOrderEstimate & {
  platformFeeRates: NonNullable<FeeRatesForOrderEstimate["platformFeeRates"]>;
  taxImpositions: NonNullable<FeeRatesForOrderEstimate["taxImpositions"]>;
} = {
  feeMode: "PASS_THROUGH",
  admissionTaxRateBps: 888,
  taxImpositions: [
    {
      code: "SALES",
      label: "Sales tax",
      jurisdiction: "US/NY",
      rateBps: 888,
      base: "TICKET_FACE",
      collector: "PLATFORM",
    },
  ],
  processorPct: 0.029,
  processorFixedCents: 30,
  maxPlatformFeeCents: null,
  platformFeeRates: {
    buyerFeePct: 0.0333,
    maxFeeCents: 50,
    minFeeCents: 0,
    platformFixedCents: 0,
  },
  perTicketEstimates: [],
};

/**
 * The per-ticket row `getCheckoutFeeRates` sends for a tier priced at
 * `faceCents` under `RATES_888`: the PASS_THROUGH branch of
 * `estimateBuyerTicketPricingForEvent` (core), built from the same two core
 * functions it calls. A PWYW tier's row is priced at its floor.
 */
export function serverRowAt(ticketTypeId: string, faceCents: number) {
  const platformFeeCents = computePlatformFeePerTicketCents(
    faceCents,
    RATES_888.platformFeeRates,
  );
  const { taxCents, processorFeeCents } = solveTaxLinesAndProcessorFee({
    taxableGrossCents: faceCents,
    buyerPlatformFeeCents: platformFeeCents,
    taxLines: RATES_888.taxImpositions,
    passThrough: true,
    processorPct: RATES_888.processorPct ?? 0,
    processorFixedCents: RATES_888.processorFixedCents ?? 0,
  });
  return {
    ticketTypeId,
    unitPriceCents: faceCents,
    platformFeeCents,
    processorFeeCents,
    taxEstimateCents: taxCents,
    buyerUnitTotalCents:
      faceCents + platformFeeCents + processorFeeCents + taxCents,
  };
}
