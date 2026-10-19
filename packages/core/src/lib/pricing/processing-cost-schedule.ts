import { fail } from "@th/errors";
import { toMajorUnits, currencyFractionDigits } from "../currency-utils";

/**
 * Static Stripe processing cost schedule by payment method type.
 *
 * These are the actual Stripe rates (as of 2025) for US-based accounts.
 * They are used to show buyers the exact processing cost for their chosen
 * payment method — no hidden fees, no blended averages.
 *
 * The `processorFeePct` and `processorFixedCents` in the FeePolicy model
 * represent the card rate (the default / worst case). This schedule maps
 * Stripe PaymentElement `value.type` identifiers to their real costs.
 *
 * NOTE: ACH Direct Debit has a cap ($5.00 = 500 cents) instead of a fixed
 * per-transaction fee.
 */

export type ProcessingCostEntry = {
  /** Stripe PaymentElement `value.type` identifier */
  methodType: string;
  /** Human-readable label */
  label: string;
  /** Percentage rate as a decimal (e.g. 0.029 = 2.9%) */
  pct: number;
  /** Fixed per-transaction fee in cents */
  fixedCents: number;
  /** Optional per-transaction cap in cents (e.g. ACH $5 cap) */
  capCents?: number;
};

/**
 * Known Stripe processing rates by payment method.
 * Source: https://stripe.com/pricing
 */
export const PROCESSING_COST_SCHEDULE: ReadonlyArray<ProcessingCostEntry> = [
  {
    methodType: "card",
    label: "Card",
    pct: 0.029,
    fixedCents: 30,
  },
  {
    methodType: "us_bank_account",
    label: "Direct debit (ACH)",
    pct: 0.008,
    fixedCents: 0,
    capCents: 500,
  },
  {
    methodType: "apple_pay",
    label: "Apple Pay",
    pct: 0.029,
    fixedCents: 30,
  },
  {
    methodType: "google_pay",
    label: "Google Pay",
    pct: 0.029,
    fixedCents: 30,
  },
  {
    methodType: "cashapp",
    label: "Cash App Pay",
    pct: 0.029,
    fixedCents: 30,
  },
  {
    methodType: "amazon_pay",
    label: "Amazon Pay",
    pct: 0.029,
    fixedCents: 30,
  },
  {
    methodType: "link",
    label: "Link",
    pct: 0.029,
    fixedCents: 30,
  },
] as const;

/**
 * Look up the processing cost for a given Stripe payment method type.
 * Falls back to the card rate if the method type is unknown.
 */
export function getProcessingCost(methodType: string): ProcessingCostEntry {
  return (
    PROCESSING_COST_SCHEDULE.find((e) => e.methodType === methodType) ??
    PROCESSING_COST_SCHEDULE[0]! // card is always the fallback
  );
}

/**
 * Format a processing cost entry as a human-readable rate label.
 *
 * When `currency` is provided, monetary amounts are formatted with the
 * correct symbol and fraction digits (zero-decimal aware).  When omitted
 * the function falls back to `$` / 2 decimal places for backward compat.
 *
 * @example
 *   formatProcessingCostLabel(cardEntry)         // "2.9% + $0.30"
 *   formatProcessingCostLabel(achEntry)           // "0.8% (capped at $5.00)"
 *   formatProcessingCostLabel(cardEntry, "jpy")   // "2.9% + ¥30"
 */
export function formatProcessingCostLabel(
  entry: ProcessingCostEntry,
  currency?: string,
): string {
  const pctPart = `${+(entry.pct * 100).toFixed(2)}%`;

  const fmtMoney = (cents: number): string => {
    if (!currency) {
      // Fallback — assume USD
      return `$${(cents / 100).toFixed(2)}`;
    }
    const major = toMajorUnits(cents, currency);
    const digits = currencyFractionDigits(currency);
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency.toUpperCase(),
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(major);
  };

  if (entry.capCents) {
    return `${pctPart} (capped at ${fmtMoney(entry.capCents)})`;
  }

  if (entry.fixedCents > 0) {
    return `${pctPart} + ${fmtMoney(entry.fixedCents)}`;
  }

  return pctPart;
}

/**
 * Compute the processing fee in cents for a given base amount and payment
 * method.
 *
 * `baseCents` is the total the buyer is paying for goods + platform fees +
 * tax — everything **except** the processing fee.  The processing fee is
 * simply Stripe's charge on that base:
 *
 *   processingFee = ceil(baseCents × pct + fixedCents)
 *
 * The fee is added to the PaymentIntent so Stripe can deduct it from the
 * gross settlement.  We do NOT self-include the fee in the calculation
 * (that would double-dip — charging the buyer for Stripe's fee on the fee
 * itself).
 */
export function computeProcessingFee(
  baseCents: number,
  methodType: string,
): number {
  const cost = getProcessingCost(methodType);

  const fee = Math.ceil(baseCents * cost.pct + cost.fixedCents);

  if (cost.capCents) {
    return Math.min(fee, cost.capCents);
  }

  return fee;
}

/**
 * Compute the processor fee given a base amount (everything the payment
 * must cover *except* the processing fee) and a processor rate.
 *
 * This is the order-level equivalent of `computeProcessingFee` but works
 * with raw pct / fixedCents / capCents values instead of looking up a
 * payment-method schedule entry.
 *
 *   processingFee = ceil(baseCents × pct + fixedCents)
 *
 * Rounds up (ceil) so the platform never under-collects.
 */
export function solveProcessingFee(
  baseCents: number,
  pct: number,
  fixedCents: number,
  capCents?: number,
): number {
  const fee = Math.ceil(baseCents * pct + fixedCents);

  if (capCents != null) {
    return Math.min(fee, capCents);
  }

  return fee;
}

/**
 * Solve the EXACT processor-fee gross-up for PASS_THROUGH fee mode.
 *
 * Given a `netTargetCents` (the amount that must remain after the processor
 * deducts its fee — i.e. everything the order has to cover EXCEPT the
 * processing fee: goods + platform fee + tax, minus any discount/credit), this
 * returns the **processor fee in cents** to add on top so that the buyer's
 * charge fully funds Stripe's deduction and the net lands exactly on the
 * target. The buyer charge is `netTargetCents + returnedFee`; Stripe then
 * deducts `solveProcessingFee(charge, …)` from it, leaving the net intact.
 *
 *   charge − solveProcessingFee(charge, pct, fixed, cap) === netTargetCents
 *
 * We do NOT use the naive closed form alone. Stripe's own fee is `ceil`'d, so
 * the closed-form charge `ceil((net + fixed) / (1 − pct))` can overshoot by 1¢
 * (paying the buyer's processor fee on a charge that Stripe would have rounded
 * up anyway). We therefore:
 *   1. start from the closed-form upper bound,
 *   2. tighten down while a 1-cent-smaller charge still nets ≥ the target
 *      (exploiting Stripe's ceil), then
 *   3. bump up if the actual (ceil'd, capped) fee leaves the net short — a
 *      safety net for cap boundaries where the closed form underestimates.
 *
 * The result is the MINIMAL sufficient processor fee.
 *
 * @param netTargetCents Amount that must survive the processor deduction.
 *   `<= 0` returns 0 (free / fully-credited orders never charge a fee).
 * @param pct Processor percentage rate as a decimal (e.g. 0.029 for 2.9%).
 *   Must be `< 1`; a rate ≥ 100% can never be grossed up (the fee would
 *   consume the entire charge), so this throws.
 * @param fixedCents Processor per-transaction fixed fee in cents.
 * @param capCents Optional per-transaction fee cap (e.g. ACH $5 = 500).
 * @returns The processor fee in cents to add to `netTargetCents`.
 */
export function solveProcessingFeeGrossUp(
  netTargetCents: number,
  pct: number,
  fixedCents: number,
  capCents?: number,
): number {
  if (netTargetCents <= 0) return 0;
  if (pct >= 1) {
    throw fail("INTERNAL", {
      message: `cannot gross up processor fee at pct >= 1 (got ${pct})`,
    });
  }

  // Closed-form upper bound, then tighten/verify against the actual
  // (ceil'd, capped) fee.
  let charge = Math.ceil((netTargetCents + fixedCents) / (1 - pct));

  // Tighten down: Stripe's own ceil means a 1-cent-smaller charge may still
  // cover the net target.
  while (
    charge > netTargetCents &&
    charge - 1 - solveProcessingFee(charge - 1, pct, fixedCents, capCents) >=
      netTargetCents
  ) {
    charge -= 1;
  }

  // Safety bump up: guarantees sufficiency in edge/cap cases where the closed
  // form underestimates the charge.
  while (
    charge - solveProcessingFee(charge, pct, fixedCents, capCents) <
    netTargetCents
  ) {
    charge += 1;
  }

  return charge - netTargetCents;
}
