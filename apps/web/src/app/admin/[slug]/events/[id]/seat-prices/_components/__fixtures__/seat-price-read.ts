import type {
  SeatPriceRead,
  SeatPriceSeatRead,
  SeatPriceSectionRead,
  SeatPriceTicketTypeRead,
} from "../seat-price-model";

/**
 * Builders for the shape `events.listEventSeatPriceOverridesForEdit` returns.
 * Test-only: nothing in the app imports this folder.
 */

let nextId = 0;
const uid = (prefix: string) => `${prefix}-${(nextId += 1)}`;

export function seatRead(
  over: Partial<SeatPriceSeatRead> = {},
): SeatPriceSeatRead {
  return {
    id: uid("seat"),
    label: "A1",
    row: "A",
    number: 1,
    status: "AVAILABLE",
    glyphKey: "glyph",
    priceOverride: null,
    overrideInvalid: false,
    ...over,
  };
}

export function ticketTypeRead(
  over: Partial<SeatPriceTicketTypeRead> = {},
): SeatPriceTicketTypeRead {
  return {
    id: uid("type"),
    name: "Standard",
    pricingMode: "FIXED",
    status: "ACTIVE",
    currentPriceCents: 4500,
    upcomingPriceChange: null,
    ...over,
  };
}

export function sectionRead(
  over: Partial<SeatPriceSectionRead> = {},
): SeatPriceSectionRead {
  return {
    seatSectionId: uid("section"),
    name: "Orchestra",
    type: "RESERVED",
    layoutSectionId: null,
    placeLayoutId: null,
    tiers: [ticketTypeRead()],
    overrideRefusal: null,
    paidOverrideBlockedBy: null,
    hasPendingScheduledPriceChange: false,
    seats: [],
    ...over,
  };
}

export function seatPriceRead(over: Partial<SeatPriceRead> = {}): SeatPriceRead {
  return {
    eventId: "event-1",
    editable: true,
    sections: [],
    ...over,
  };
}

/** A row of AVAILABLE seats: `rowSeats("orch", "A", [1, 2, 3])` → A1, A2, A3. */
export function rowSeats(
  idPrefix: string,
  row: string,
  numbers: number[],
  over: Partial<SeatPriceSeatRead> = {},
): SeatPriceSeatRead[] {
  return numbers.map((number) =>
    seatRead({
      id: `${idPrefix}-${row}${number}`,
      label: `${row}${number}`,
      row,
      number,
      ...over,
    }),
  );
}
