import { describe, expect, it } from "vitest";

import { aggregateTicketSummary } from "../orders";

/**
 * The cart-recovery summary keeps each held seat at its OWN line's price
 * (seat-price-overrides spec D-007). The per-type `unitPriceCents` is the
 * first line's, so a type mixing a $50 override seat and a $30 seat read as
 * "×2 at $50" on a resumed checkout, and a resumed Pay had no per-seat
 * number to quote.
 */

const RES = "33333333-3333-4333-8333-333333333334";
const GA = "33333333-3333-4333-8333-333333333333";
const A1 = "88888888-8888-4888-8888-888888888801";
const A2 = "88888888-8888-4888-8888-888888888802";

const line = (
  ticketTypeId: string,
  unitPriceCents: number,
  seatIds?: string[],
) => ({
  ticketTypeId,
  ticketType: { name: ticketTypeId === RES ? "Reserved" : "GA" },
  qty: 1,
  unitPriceCents,
  meta: seatIds ? { seatId: seatIds[0], seatIds } : { ticketIndex: 0 },
});

describe("aggregateTicketSummary", () => {
  it("one entry per type, with each seat at its own line's unit price", () => {
    expect(
      aggregateTicketSummary([line(RES, 5000, [A1]), line(RES, 3000, [A2])]),
    ).toEqual([
      {
        ticketTypeId: RES,
        ticketTypeName: "Reserved",
        qty: 2,
        unitPriceCents: 5000,
        seatIds: [A1, A2],
        seats: [
          { seatId: A1, unitPriceCents: 5000 },
          { seatId: A2, unitPriceCents: 3000 },
        ],
      },
    ]);
  });

  it("GA lines carry no seats", () => {
    expect(aggregateTicketSummary([line(GA, 3000), line(GA, 3000)])).toEqual([
      {
        ticketTypeId: GA,
        ticketTypeName: "GA",
        qty: 2,
        unitPriceCents: 3000,
        seatIds: [],
        seats: [],
      },
    ]);
  });
});
