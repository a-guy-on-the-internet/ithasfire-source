import { payWhatYouWantListingCopy } from "@/components/events/pay-what-you-want-copy";
import {
  getListedAllInDisplayCents,
  type ListedEstimateTicket,
} from "@/lib/pricing/stale-estimate";

type Translate = (
  key: string,
  values?: Record<string, string | number>,
) => unknown;

/**
 * The price line on a seat-map ticket card. Pay-what-you-want tiers use the
 * shared listing copy ("From $6.09", or "Pay what you want" + suggestion at a
 * zero floor, never "Free"), fed the same estimate fields as the embed so the
 * stale guard applies. Fixed tiers: all-in price, "Calculating total…" while
 * unknown or stale, "Free" at zero.
 */
export function seatMapPriceLabel(
  tt: ListedEstimateTicket & { buyerUnitTotalCents?: number | null },
  { formatPrice, t }: { formatPrice: (cents: number) => string; t: Translate },
): { label: string; hint: string | null } {
  if (tt.pricingMode === "ADJUSTABLE") {
    const { label, hint } = payWhatYouWantListingCopy(tt, {
      estimate: {
        buyerUnitTotalCents: tt.buyerUnitTotalCents,
        unitPriceCents: tt.buyerUnitPriceCents,
      },
      formatPrice,
      t,
    });
    return { label, hint };
  }
  const cents = getListedAllInDisplayCents(tt);
  return {
    label:
      cents === null
        ? String(t("checkout.calculatingTotal"))
        : cents === 0
          ? String(t("common.free"))
          : formatPrice(cents),
    hint: null,
  };
}

/**
 * The price text on ONE seat (its list button, its tooltip) when the seat is
 * priced by a pay-what-you-want tier: the same label the section quick-pick
 * row shows ("Pay what you want" at a zero floor, "From $X" above it), never
 * the stored $0.00 or a bare all-in figure that reads as a fixed price.
 * `null` for a fixed tier or a seat with its own price override — those keep
 * their per-seat figure.
 */
export function adjustableSeatPriceLabel(
  tt: (ListedEstimateTicket & { buyerUnitTotalCents?: number | null }) | undefined,
  hasPriceOverride: boolean,
  options: { formatPrice: (cents: number) => string; t: Translate },
): string | null {
  if (!tt || hasPriceOverride || tt.pricingMode !== "ADJUSTABLE") return null;
  return seatMapPriceLabel(tt, options).label;
}
