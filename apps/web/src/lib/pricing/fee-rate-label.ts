import { formatRateLabel } from "@th/core/lib/pricing/format-rate-label";

/** The per-ticket fee policy, as `getCheckoutFeeRates` / the event payload send it. */
export type PlatformFeeRateParts = {
  buyerFeePct: number;
  maxFeeCents: number | null;
  minFeeCents: number;
  platformFixedCents: number;
};

/**
 * The platform-fee rate as buyers read it, with its per-ticket cap.
 *
 * "Platform fee (3.33%)" beside $1.00 on a $55 order reads like 3.33% of $55;
 * the fee is 3.33% PER TICKET, capped at 50¢ each. When the policy has a
 * per-ticket cap the label says so — always, not only when this cart hits
 * it: the label describes the rate, and a rate that silently changes wording
 * with the cart would be harder to trust.
 *
 * The cap applies to the PERCENTAGE part only:
 *   fee = max( min(round(face × pct), max) + fixed, min )   (0 on a $0 ticket)
 * so the wording follows the formula:
 *   - no fixed part, floor ≤ cap → "3.33%, max $0.50/ticket"
 *   - a fixed part              → "3.33% (max $0.50) + $0.30"
 *     ("3.33% + $0.30, max $0.50/ticket" would claim a ceiling the fixed
 *     part sits above.)
 *   - no cap, no percentage, or a floor above the cap (the fee is then the
 *     floor, and "max" would be false) → the rate label unchanged.
 */
export function platformFeeRateLabel(
  rateLabel: string | null | undefined,
  rates: PlatformFeeRateParts | null | undefined,
  t: (key: string, values?: Record<string, string | number>) => unknown,
  formatPrice: (cents: number) => string,
): string | null {
  if (!rateLabel) return null;
  if (!rates || rates.maxFeeCents == null || !(rates.buyerFeePct > 0)) {
    return rateLabel;
  }
  const { maxFeeCents, minFeeCents, platformFixedCents } = rates;
  if (platformFixedCents > 0) {
    if (minFeeCents > maxFeeCents + platformFixedCents) return rateLabel;
    return String(
      t("checkout.platformFeeRatePctCapped", {
        pct: formatRateLabel(rates.buyerFeePct, 0) ?? rateLabel,
        max: formatPrice(maxFeeCents),
        fixed: formatPrice(platformFixedCents),
      }),
    );
  }
  if (minFeeCents > maxFeeCents) return rateLabel;
  return String(
    t("checkout.platformFeeRateCapped", {
      rate: rateLabel,
      max: formatPrice(maxFeeCents),
    }),
  );
}
