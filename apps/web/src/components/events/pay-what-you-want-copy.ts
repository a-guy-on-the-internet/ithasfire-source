import {
  payWhatYouWantFloorCents,
  payWhatYouWantFromCents,
  type PayWhatYouWantFloorEstimate,
  type PayWhatYouWantTier,
} from "@/lib/pricing/pay-what-you-want";

/**
 * How a listing words a pay-what-you-want tier: the event page's Tickets
 * section and hero, the embed's ticket list, and the main checkout's ticket
 * card. One function, so none of them can disagree.
 *
 *  - Floor > 0: "From $6.09", the floor ALL-IN (fees and tax included, as
 *    the charge prices a ticket at the floor; `payWhatYouWantFromCents`). No
 *    "+ fees & tax" line: the figure already includes them, as a fixed tier's
 *    does (owner ruling 2026-10-02). While the estimate is not loaded it reads
 *    "Calculating total…", never the bare floor.
 *  - Floor 0: "Pay what you want", plus a muted "suggested $15.00" when the
 *    organiser set one. The suggestion stays FACE: it is the amount the buyer
 *    types. Never "From {suggested}": the buyer can pay less.
 */
export type PayWhatYouWantListingCopy = {
  label: string;
  /** Muted second line, or null. */
  hint: string | null;
  /** The all-in "From" figure (0 at floor 0), or null while calculating. */
  fromCents: number | null;
};

export function payWhatYouWantListingCopy(
  tier: PayWhatYouWantTier,
  {
    estimate,
    formatPrice,
    t,
  }: {
    /** The tier's per-ticket estimate row, priced at its floor. */
    estimate: PayWhatYouWantFloorEstimate | null | undefined;
    formatPrice: (cents: number) => string;
    t: (key: string, values?: Record<string, string | number>) => unknown;
  },
): PayWhatYouWantListingCopy {
  const floorCents = payWhatYouWantFloorCents(tier);
  if (floorCents === 0) {
    return {
      label: String(t("eventDetail.payWhatYouWant")),
      hint: tier.suggestedCents
        ? String(
            t("eventDetail.suggestedPrice", {
              value: formatPrice(tier.suggestedCents),
            }),
          )
        : null,
      fromCents: 0,
    };
  }
  const fromCents = payWhatYouWantFromCents(tier, estimate);
  return {
    label:
      fromCents === null
        ? String(t("checkout.calculatingTotal"))
        : String(t("eventDetail.fromPrice", { value: formatPrice(fromCents) })),
    hint: null,
    fromCents,
  };
}
