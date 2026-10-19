import type { TxRepos } from "@th/ports/repos";

import type { TicketTypeSummary } from "../../orders/checkout-helpers";

type DoorTicketType = Awaited<
  ReturnType<TxRepos["events"]["listTicketTypes"]>
>[number];

/**
 * The pricing view of the door's sellable ticket types: what
 * `computeOrderAmounts` / `priceCart` read. ONE builder for every door path
 * that prices a cart (the card sale, the cash sale, the Sell-screen quote),
 * so the quote cannot read a field the charge does not, or the other way
 * round (spec 2026-10-07 door-sales-same-price-and-tax, FR-001/FR-010).
 *
 * The caller has already narrowed to `status === "ACTIVE"`.
 */
export function toDoorTicketTypeSummaries(
  ticketTypes: ReadonlyArray<DoorTicketType>,
): Map<string, TicketTypeSummary> {
  return new Map<string, TicketTypeSummary>(
    ticketTypes.map((tt) => [
      tt.id,
      {
        id: tt.id,
        priceCents: tt.priceCents,
        pricingMode: tt.pricingMode ?? "FIXED",
        minimumCents: tt.minimumCents ?? null,
        seatSectionId: tt.seatSectionId ?? null,
        scheduledPriceCents: tt.scheduledPriceCents ?? null,
        scheduledPriceAt: tt.scheduledPriceAt ?? null,
        salesOpenAt: tt.salesOpenAt ?? null,
        salesCloseAt: tt.salesCloseAt ?? null,
      },
    ]),
  );
}
