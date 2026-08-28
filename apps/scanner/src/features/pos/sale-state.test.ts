import { describe, expect, it } from "vitest";

import { describeSaleState } from "./sale-state";

/**
 * FR-010 — the Sell screen's per-tier sale-window copy.
 *
 * The behaviour that matters at a door: the operator must be able to see that a
 * tier is not sellable BEFORE tapping, and the reason must render on the
 * VENUE's clock. The till's own refusal (`assertTicketTypeOnSale` inside
 * `startPosSale` / `recordCashSale`) is untouched by any of this.
 */
const OPENS_AT = "2026-10-09T01:00:00.000Z"; // 8:00 PM Oct 8, America/Chicago

describe("describeSaleState", () => {
  it("NFR-001: a tier with no sellability field is plainly sellable", () => {
    // Older API build / cached response. Fail-SAFE for a UX hint: the server
    // still refuses the sale, whereas graying every row out over a missing
    // field would take the door offline on a deploy skew.
    expect(describeSaleState(undefined, "America/Chicago")).toEqual({
      isSellable: true,
      note: null,
    });
    expect(describeSaleState(null, "America/Chicago")).toEqual({
      isSellable: true,
      note: null,
    });
  });

  it("an available tier gets no note", () => {
    expect(
      describeSaleState(
        { available: true, reason: "ok", opensAt: null, closedAt: null },
        "America/Chicago",
      ),
    ).toEqual({ isSellable: true, note: null });
  });

  it("renders the open instant on the EVENT's clock, not the device's", () => {
    const result = describeSaleState(
      { available: false, reason: "not_yet_on_sale", opensAt: OPENS_AT },
      "America/Chicago",
    );
    expect(result.isSellable).toBe(false);
    // 01:00 UTC on Oct 9 is 8 PM on Oct 8 in Chicago (CDT, UTC-5). A device
    // reading this in UTC would say "Oct 9, 1:00 AM" — the bug this pins.
    expect(result.note).toContain("Oct 8");
    expect(result.note).toContain("8:00");
    expect(result.note).toContain("CDT");
    expect(result.note!.startsWith("On sale ")).toBe(true);
  });

  it("renders the SAME instant differently for a different event zone", () => {
    const chicago = describeSaleState(
      { available: false, reason: "not_yet_on_sale", opensAt: OPENS_AT },
      "America/Chicago",
    ).note;
    const london = describeSaleState(
      { available: false, reason: "not_yet_on_sale", opensAt: OPENS_AT },
      "Europe/London",
    ).note;
    expect(chicago).not.toEqual(london);
    expect(london).toContain("Oct 9");
  });

  it("DST: an instant on the far side of a fall-back transition reads CST", () => {
    // 2026-11-01T08:00Z is 2:00 AM CST — after Chicago falls back. A resolver
    // that probed the offset once at the naive instant would say 3:00 AM CDT.
    const note = describeSaleState(
      {
        available: false,
        reason: "not_yet_on_sale",
        opensAt: "2026-11-01T08:00:00.000Z",
      },
      "America/Chicago",
    ).note;
    expect(note).toContain("CST");
    expect(note).toContain("2:00");
  });

  it("says 'Sales ended' with no date — a passed deadline is not actionable", () => {
    expect(
      describeSaleState(
        { available: false, reason: "sales_ended", closedAt: OPENS_AT },
        "America/Chicago",
      ),
    ).toEqual({ isSellable: false, note: "Sales ended" });
  });

  it("degrades to zone-free copy when the instant is unreadable", () => {
    expect(
      describeSaleState(
        { available: false, reason: "not_yet_on_sale", opensAt: "nonsense" },
        "America/Chicago",
      ),
    ).toEqual({ isSellable: false, note: "Not on sale yet" });
    expect(
      describeSaleState(
        { available: false, reason: "not_yet_on_sale", opensAt: null },
        "America/Chicago",
      ).note,
    ).toBe("Not on sale yet");
  });

  it("REFUSES to render a time when the event carries no zone", () => {
    // Not a degrade to the device's clock: a touring operator's tablet on home
    // time would state a wall time that is hours wrong with no abbreviation to
    // give it away. Zone-free copy is the honest answer.
    const result = describeSaleState(
      { available: false, reason: "not_yet_on_sale", opensAt: OPENS_AT },
      null,
    );
    expect(result).toEqual({ isSellable: false, note: "Not on sale yet" });
    expect(
      describeSaleState(
        { available: false, reason: "not_yet_on_sale", opensAt: OPENS_AT },
        undefined,
      ).note,
    ).toBe("Not on sale yet");
  });

  it("survives an unknown timezone id rather than crashing the Sell tab", () => {
    const result = describeSaleState(
      { available: false, reason: "not_yet_on_sale", opensAt: OPENS_AT },
      "Mars/Olympus_Mons",
    );
    expect(result).toEqual({ isSellable: false, note: "Not on sale yet" });
  });

  it("stops the tap on an UNKNOWN refusal reason rather than falling through", () => {
    // No other reason is reachable today (the POS passes an event-level permit
    // into the resolver), but an unrecognised refusal must never read as
    // sellable.
    expect(
      describeSaleState(
        { available: false, reason: "something_new" },
        "America/Chicago",
      ),
    ).toEqual({ isSellable: false, note: "Not available" });
  });
});
