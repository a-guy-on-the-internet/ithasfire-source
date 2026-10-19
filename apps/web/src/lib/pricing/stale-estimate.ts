import { getListedBuyerAllInDisplayCents } from "./buyer-display";
import {
  isPayWhatYouWant,
  payWhatYouWantFloorCents,
  payWhatYouWantFromCents,
  type PayWhatYouWantTier,
} from "./pay-what-you-want";

/**
 * A listed ticket and the face its per-ticket estimate row was priced at
 * (`withBuyerUnitTotals` → `buyerUnitPriceCents`).
 */
export type ListedEstimateTicket = PayWhatYouWantTier & {
  id: string;
  priceCents: number;
  buyerUnitPriceCents?: number | null;
};

/**
 * The face the server prices a tier's estimate row at: a pay-what-you-want
 * tier's floor, any other tier's price.
 */
export const listedEstimateFaceCents = (ticket: ListedEstimateTicket): number =>
  isPayWhatYouWant(ticket) ? payWhatYouWantFloorCents(ticket) : ticket.priceCents;

/**
 * Whether the tier's row was priced at another face than the tier now has —
 * the case every listing shows as "Calculating total…". The fee-rates query
 * is cached (60s, no refetch on focus), so a price or minimum changed inside
 * that window leaves the row behind the ticket list.
 */
export const isListedEstimateStale = (ticket: ListedEstimateTicket): boolean =>
  typeof ticket.buyerUnitPriceCents === "number" &&
  ticket.buyerUnitPriceCents !== listedEstimateFaceCents(ticket);

/**
 * Identifies the CURRENT set of stale rows ("" when there are none): the same
 * mismatch always yields the same key, so a caller can refetch once per
 * mismatch and never loop on one a refetch did not cure.
 */
export const staleEstimateKey = (
  tickets: readonly ListedEstimateTicket[],
): string =>
  tickets
    .filter(isListedEstimateStale)
    .map(
      (ticket) =>
        `${ticket.id}:${listedEstimateFaceCents(ticket)}:${ticket.buyerUnitPriceCents}`,
    )
    .sort()
    .join("|");

/**
 * A listed tier's all-in unit figure with the stale guard, whatever its
 * pricing: a pay-what-you-want tier's floor all-in (`payWhatYouWantFromCents`,
 * against the row priced at its floor), any other tier's price all-in
 * (`getListedBuyerAllInDisplayCents`). Null while unknown or stale.
 */
export const getListedAllInDisplayCents = (
  ticket: ListedEstimateTicket & { buyerUnitTotalCents?: number | null },
): number | null =>
  isPayWhatYouWant(ticket)
    ? payWhatYouWantFromCents(ticket, {
        buyerUnitTotalCents: ticket.buyerUnitTotalCents,
        unitPriceCents: ticket.buyerUnitPriceCents,
      })
    : getListedBuyerAllInDisplayCents(ticket);
