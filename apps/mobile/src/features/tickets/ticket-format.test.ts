import { describe, expect, it } from "vitest";

import {
  formatTicketCode,
  formatTicketCount,
  formatTicketOrderCurrency,
  formatTicketOrderDateTime,
  getTicketOrderStatusDisplay,
  getTicketStatusDisplay,
  isPastTicketOrder,
} from "./ticket-format";

describe("ticket order formatting", () => {
  it("formats event date and time with a stable locale", () => {
    expect(
      formatTicketOrderDateTime("2026-05-09T18:30:00.000Z", {
        locale: "en-US",
        timeZone: "UTC",
      }),
    ).toBe("Sat, May 9 at 6:30 PM");
  });

  it("falls back when an order has no event date", () => {
    expect(formatTicketOrderDateTime(null)).toBe("Date TBA");
  });

  it("formats integer cents as currency", () => {
    expect(formatTicketOrderCurrency(12345, "usd", { locale: "en-US" })).toBe(
      "$123.45",
    );
  });

  it("pluralizes ticket counts", () => {
    expect(formatTicketCount(1)).toBe("1 ticket");
    expect(formatTicketCount(3)).toBe("3 tickets");
  });

  it("maps known order statuses to mobile badge display values", () => {
    expect(getTicketOrderStatusDisplay("SUCCEEDED")).toEqual({
      label: "Confirmed",
      tone: "success",
    });
    expect(getTicketOrderStatusDisplay("DISPUTED")).toEqual({
      label: "Disputed",
      tone: "danger",
    });
  });

  it("keeps unknown statuses readable", () => {
    expect(getTicketOrderStatusDisplay("manual_review")).toEqual({
      label: "Manual Review",
      tone: "neutral",
    });
  });

  it("maps ticket statuses to mobile badge display values", () => {
    expect(getTicketStatusDisplay("VALID")).toEqual({
      label: "Ready",
      tone: "success",
    });
    expect(getTicketStatusDisplay("SCANNED")).toEqual({
      label: "Used",
      tone: "neutral",
    });
    expect(getTicketStatusDisplay("INVALID")).toEqual({
      label: "Invalid",
      tone: "danger",
    });
  });

  it("trims ticket codes without changing case or internal spacing", () => {
    expect(formatTicketCode("  TK-001   A  ")).toBe("TK-001   A");
  });

  it("detects past event orders", () => {
    const now = new Date("2026-05-10T00:00:00.000Z");
    expect(isPastTicketOrder("2026-05-09T23:59:59.000Z", now)).toBe(true);
    expect(isPastTicketOrder("2026-05-10T00:00:01.000Z", now)).toBe(false);
    expect(isPastTicketOrder(null, now)).toBe(false);
  });
});
