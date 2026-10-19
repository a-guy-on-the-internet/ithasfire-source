import { describe, expect, it } from "vitest";

import { readEmbedTickets, ticketsForOrder } from "./embed-tickets";

const GA = { code: "TCK-1", ticketTypeName: "General Admission", seatLabel: null };

describe("readEmbedTickets", () => {
  it("reads the server's tickets as sent", () => {
    const seated = { code: "TCK-2", ticketTypeName: "Balcony", seatLabel: "Balcony · Q5" };
    expect(readEmbedTickets([GA, seated])).toEqual([GA, seated]);
  });

  it.each([undefined, null, "TCK-1", 7, {}, { tickets: [GA] }])(
    "no list (%j) → no tickets",
    (value) => {
      expect(readEmbedTickets(value)).toEqual([]);
    },
  );

  it("leaves out anything that is not a ticket with a code", () => {
    expect(
      readEmbedTickets([
        null,
        "TCK-0",
        { ticketTypeName: "No code", seatLabel: null },
        { code: "", ticketTypeName: "Empty code", seatLabel: null },
        { code: 12345, ticketTypeName: "Numeric code", seatLabel: null },
        GA,
      ]),
    ).toEqual([GA]);
  });

  it("a name or seat that is missing or blank reads as none", () => {
    expect(
      readEmbedTickets([{ code: "TCK-3" }, { code: "TCK-4", ticketTypeName: " ", seatLabel: 5 }]),
    ).toEqual([
      { code: "TCK-3", ticketTypeName: null, seatLabel: null },
      { code: "TCK-4", ticketTypeName: null, seatLabel: null },
    ]);
  });
});

describe("ticketsForOrder", () => {
  it("a confirmed answer about this order → its tickets", () => {
    expect(
      ticketsForOrder("order-1", { outcome: "confirmed", orderId: "order-1", tickets: [GA] }),
    ).toEqual([GA]);
  });

  it("a confirmed answer about ANOTHER order → none", () => {
    expect(
      ticketsForOrder("order-2", { outcome: "confirmed", orderId: "order-1", tickets: [GA] }),
    ).toEqual([]);
  });

  it.each(["processing", "not_paid", "unanswered"])(
    "a %s answer → none, whatever it carries",
    (outcome) => {
      expect(
        ticketsForOrder("order-1", { outcome, orderId: "order-1", tickets: [GA] }),
      ).toEqual([]);
    },
  );

  it("a confirmed answer with no tickets field (an older API) → none", () => {
    expect(ticketsForOrder("order-1", { outcome: "confirmed", orderId: "order-1" })).toEqual([]);
  });
});
