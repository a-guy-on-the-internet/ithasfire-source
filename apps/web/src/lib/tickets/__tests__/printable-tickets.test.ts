import { describe, expect, it } from "vitest";

import {
  isPrintableTicket,
  selectPrintableTickets,
} from "../printable-tickets";

/**
 * A printed stub is a bearer credential, so this predicate is the thing that
 * decides what goes on paper. It must stay identical to the wallet-button gate
 * on `OrderDetail` (`!transferredAt && status === "VALID"`).
 */
const ticket = (
  status: string,
  transferredAt: Date | null = null,
  hasItem = true,
) => ({
  id: `ticket-${status}-${transferredAt ? "t" : "u"}`,
  status,
  item: hasItem ? { transferredAt } : null,
});

describe("isPrintableTicket", () => {
  it("prints a VALID, untransferred ticket", () => {
    expect(isPrintableTicket(ticket("VALID"))).toBe(true);
  });

  it("prints a VALID ticket whose order-item join did not resolve", () => {
    // `orderItemId` is nullable on the read model; a missing join must not be
    // read as "transferred".
    expect(isPrintableTicket(ticket("VALID", null, false))).toBe(true);
  });

  it("refuses a transferred ticket even though its status is still VALID", () => {
    expect(isPrintableTicket(ticket("VALID", new Date("2026-08-01")))).toBe(
      false,
    );
  });

  it.each(["SCANNED", "REFUNDED", "INVALID", "LISTED"])(
    "refuses a %s ticket",
    (status) => {
      expect(isPrintableTicket(ticket(status))).toBe(false);
    },
  );

  it("accepts a string transferredAt (the API may serialise dates)", () => {
    expect(
      isPrintableTicket({
        status: "VALID",
        item: { transferredAt: "2026-08-01T00:00:00.000Z" },
      }),
    ).toBe(false);
  });
});

describe("selectPrintableTickets", () => {
  it("keeps only printable tickets and preserves order", () => {
    const tickets = [
      ticket("VALID"),
      ticket("SCANNED"),
      ticket("VALID", new Date("2026-08-01")),
      ticket("REFUNDED"),
    ];

    expect(selectPrintableTickets(tickets).map((t) => t.id)).toEqual([
      "ticket-VALID-u",
    ]);
  });

  it("returns an empty list when nothing is printable — the sheet must say so, not print blank paper", () => {
    expect(
      selectPrintableTickets([ticket("REFUNDED"), ticket("SCANNED")]),
    ).toEqual([]);
  });
});
