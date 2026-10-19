import {
  isPlausibleIndexedBuyerTotal,
  renderListingPrice,
  resolveListingPrice,
  type ListingPrice,
  type ListingPriceWords,
} from "@th/types/money";

/**
 * Search-result price — the shared ALL-IN listing rule (`resolveListingPrice`,
 * owner ruling 2026-10-02), the same one the event cards use, so a result row
 * and the card it links to cannot disagree by a cent or a word. Returned as
 * data; the page words it in the viewer's language (`useListingPriceWords`).
 * Null means "no price slot": no paid, free or pay-what-you-want tier, or the
 * all-in figure is unknown. It never falls back to the face price.
 *
 * Search results are INDEX-sourced, and the stored total can be stale against
 * the face beside it, so it passes `isPlausibleIndexedBuyerTotal` first. With a
 * free or floor-0 pay-what-you-want tier the face is that tier's 0 (index
 * semantics), but "Free+" and "Pay what you want" never print a total, so the
 * guard has nothing to check there.
 */
export function searchListingPrice(event: {
  lowestPriceCents?: number | null;
  lowestBuyerTotalCents?: number | null;
  paidTierCount?: number | null;
  hasFreeTier?: boolean | null;
  hasPayWhatYouWantTier?: boolean | null;
  currency?: string | null;
}): ListingPrice | null {
  const hasFreeTier = event.hasFreeTier === true;
  const hasPayWhatYouWantTier = event.hasPayWhatYouWantTier === true;
  const zeroFace = hasFreeTier || hasPayWhatYouWantTier;
  const paidTierCount = event.paidTierCount ?? 0;
  const minPaidPriceCents = zeroFace ? null : (event.lowestPriceCents ?? null);
  let lowestBuyerTotalCents = event.lowestBuyerTotalCents ?? null;
  if (
    lowestBuyerTotalCents != null &&
    !zeroFace &&
    (minPaidPriceCents == null ||
      !isPlausibleIndexedBuyerTotal(lowestBuyerTotalCents, minPaidPriceCents))
  ) {
    lowestBuyerTotalCents = null;
  }
  return resolveListingPrice({
    hasFreeTier,
    hasPayWhatYouWantTier,
    paidTierCount,
    minPaidPriceCents,
    lowestBuyerTotalCents,
    currency: event.currency ?? "USD",
  });
}

/**
 * {@link searchListingPrice} in words: the viewer's language when `words` is
 * given (`useListingPriceWords`), English otherwise. Null = no price slot.
 */
export function searchPriceLabel(
  event: Parameters<typeof searchListingPrice>[0],
  words?: ListingPriceWords,
): string | null {
  const price = searchListingPrice(event);
  return price ? renderListingPrice(price, words) : null;
}
