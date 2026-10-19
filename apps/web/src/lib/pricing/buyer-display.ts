export type BuyerDisplayTicket = {
  priceCents: number;
  buyerUnitTotalCents?: number | null;
};

export const isBuyerAllInPriceKnown = (
  ticket: BuyerDisplayTicket,
  basePriceCents = ticket.priceCents,
): boolean => {
  if (basePriceCents <= 0) {
    return true;
  }
  if (basePriceCents !== ticket.priceCents) {
    return false;
  }
  return typeof ticket.buyerUnitTotalCents === "number";
};

export const getBuyerPriceAddOnCents = (ticket: BuyerDisplayTicket): number => {
  if (typeof ticket.buyerUnitTotalCents !== "number") {
    return 0;
  }
  return Math.max(0, ticket.buyerUnitTotalCents - ticket.priceCents);
};

export const getBuyerAllInPriceCents = (
  ticket: BuyerDisplayTicket,
  basePriceCents = ticket.priceCents,
): number => {
  return Math.max(0, basePriceCents + getBuyerPriceAddOnCents(ticket));
};

export const getBuyerAllInDisplayCents = (
  ticket: BuyerDisplayTicket,
  basePriceCents = ticket.priceCents,
): number | null => {
  if (!isBuyerAllInPriceKnown(ticket, basePriceCents)) {
    return null;
  }
  return getBuyerAllInPriceCents(ticket, basePriceCents);
};

/**
 * `getBuyerAllInDisplayCents` for a FIXED-price listing row that carries the
 * face its estimate was priced at (`withBuyerUnitTotals` →
 * `buyerUnitPriceCents`, or the event page's `unitPriceCents`). A row priced
 * at another face than the ticket's (a cached row from before the organiser
 * changed the price) is unknown — "Calculating total…" — never the new face
 * plus the old fees and tax. A $0 face counts: a cached "Free" beside a row
 * priced at $20 after a scheduled flip is the same disagreement.
 *
 * Pay-what-you-want tiers are quoted by `payWhatYouWantFromCents`, whose row
 * is priced at the floor, not at the stored $0.
 */
export const getListedBuyerAllInDisplayCents = (
  ticket: BuyerDisplayTicket & { buyerUnitPriceCents?: number | null },
): number | null => {
  if (
    typeof ticket.buyerUnitPriceCents === "number" &&
    ticket.buyerUnitPriceCents !== ticket.priceCents
  ) {
    return null;
  }
  return getBuyerAllInDisplayCents(ticket);
};

export const getBuyerLineTotalCents = (
  ticket: BuyerDisplayTicket,
  quantity: number,
  basePriceCents = ticket.priceCents,
): number => {
  return (
    getBuyerAllInPriceCents(ticket, basePriceCents) * Math.max(0, quantity)
  );
};

export const getBuyerLineTotalDisplayCents = (
  ticket: BuyerDisplayTicket,
  quantity: number,
  basePriceCents = ticket.priceCents,
): number | null => {
  const buyerAllInPriceCents = getBuyerAllInDisplayCents(
    ticket,
    basePriceCents,
  );
  if (buyerAllInPriceCents === null) {
    return null;
  }
  return buyerAllInPriceCents * Math.max(0, quantity);
};

export const getBuyerPriceRange = <T extends BuyerDisplayTicket>(
  tickets: T[],
): { minCents: number; maxCents: number } | null => {
  const prices = tickets
    .map((ticket) => getBuyerAllInDisplayCents(ticket))
    .filter((price): price is number => typeof price === "number")
    .filter((price) => price > 0);

  if (prices.length === 0) {
    return null;
  }

  return {
    minCents: Math.min(...prices),
    maxCents: Math.max(...prices),
  };
};
