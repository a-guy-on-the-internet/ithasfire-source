import { describe, expect, it } from "vitest";

import {
  leftOnRefundAuditData,
  ticketsLeavingOnRefund,
} from "../tickets-leaving-on-refund";

const ADMITTED_AT = new Date("2026-10-09T23:41:07.000Z");

describe("ticketsLeavingOnRefund", () => {
  it("returns only the SCANNED tickets, with their admit time as ISO, in input order", () => {
    const later = new Date("2026-10-09T23:55:00.000Z");

    expect(
      ticketsLeavingOnRefund([
        { id: "t-valid", status: "VALID", scannedAt: null },
        { id: "t-scanned-2", status: "SCANNED", scannedAt: later },
        { id: "t-listed", status: "LISTED", scannedAt: null },
        { id: "t-scanned-1", status: "SCANNED", scannedAt: ADMITTED_AT },
      ]),
    ).toEqual([
      { ticketId: "t-scanned-2", admittedAt: "2026-10-09T23:55:00.000Z" },
      { ticketId: "t-scanned-1", admittedAt: "2026-10-09T23:41:07.000Z" },
    ]);
  });

  it("goes by status, not by scannedAt: a dead ticket that still carries a scan time is not listed", () => {
    expect(
      ticketsLeavingOnRefund([
        { id: "t-refunded", status: "REFUNDED", scannedAt: ADMITTED_AT },
        { id: "t-invalid", status: "INVALID", scannedAt: ADMITTED_AT },
        { id: "t-valid", status: "VALID", scannedAt: ADMITTED_AT },
      ]),
    ).toEqual([]);
  });

  it("still lists a SCANNED ticket whose scannedAt is missing, with a null admit time", () => {
    expect(
      ticketsLeavingOnRefund([
        { id: "t-null", status: "SCANNED", scannedAt: null },
        { id: "t-absent", status: "SCANNED" },
      ]),
    ).toEqual([
      { ticketId: "t-null", admittedAt: null },
      { ticketId: "t-absent", admittedAt: null },
    ]);
  });

  it("returns nothing for no tickets", () => {
    expect(ticketsLeavingOnRefund([])).toEqual([]);
  });

  it("returns nothing once the void has been written (status REFUNDED, scannedAt cleared)", () => {
    const ticket = { id: "t-1", status: "SCANNED", scannedAt: ADMITTED_AT as Date | null };
    const before = ticketsLeavingOnRefund([ticket]);
    ticket.status = "REFUNDED";
    ticket.scannedAt = null;

    expect(before).toEqual([
      { ticketId: "t-1", admittedAt: "2026-10-09T23:41:07.000Z" },
    ]);
    expect(ticketsLeavingOnRefund([ticket])).toEqual([]);
  });
});

describe("leftOnRefundAuditData", () => {
  it("wraps a non-empty list under the leftOnRefund key", () => {
    const leaving = [{ ticketId: "t-1", admittedAt: "2026-10-09T23:41:07.000Z" }];

    expect(leftOnRefundAuditData(leaving)).toEqual({ leftOnRefund: leaving });
  });

  it("is an empty object for an empty list, so spreading it adds no key", () => {
    const data = { refundId: "re_1", ...leftOnRefundAuditData([]) };

    expect(data).toEqual({ refundId: "re_1" });
    expect(data).not.toHaveProperty("leftOnRefund");
  });
});
