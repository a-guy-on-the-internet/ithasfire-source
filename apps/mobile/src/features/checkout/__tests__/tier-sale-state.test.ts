import { describe, expect, it } from "vitest";

import { describeTierSaleState } from "../tier-sale-state";

// 01:00 UTC on Oct 9 is 8 PM on Oct 8 in Chicago (CDT, UTC−5).
const OPENS_AT = "2026-10-09T01:00:00.000Z";

describe("describeTierSaleState (FR-010)", () => {
  it("an available tier gets no note and keeps its stepper", () => {
    expect(
      describeTierSaleState(
        { available: true, reason: "ok", opensAt: null, closedAt: null },
        "America/Chicago",
      ),
    ).toEqual({ isBuyable: true, note: null });
  });

  it("NFR-001: a tier with NO sellability is buyable, exactly as before", () => {
    // An older API build or a cached response. Fail-safe direction for a
    // UX-only hint — the server still refuses; greying every row out over a
    // missing field would break buying entirely on a deploy skew.
    expect(describeTierSaleState(undefined, "America/Chicago")).toEqual({
      isBuyable: true,
      note: null,
    });
    expect(describeTierSaleState(null, null)).toEqual({
      isBuyable: true,
      note: null,
    });
  });

  it("renders the open instant on the EVENT's clock, not the phone's", () => {
    const result = describeTierSaleState(
      { available: false, reason: "not_yet_on_sale", opensAt: OPENS_AT },
      "America/Chicago",
    );
    expect(result.isBuyable).toBe(false);
    // A device reading this in UTC would say "Oct 9, 1:00 AM" — the bug.
    expect(result.note).toContain("Oct 8");
    expect(result.note).toContain("8:00");
    expect(result.note).toContain("CDT");
    expect(result.note!.startsWith("On sale ")).toBe(true);
  });

  it("REFUSES to render a time when the event carries no zone", () => {
    // Refuse, don't degrade: the zone-less option set also drops the
    // abbreviation, so a travelling buyer would read a confidently wrong hour
    // with nothing admitting the substitution.
    expect(
      describeTierSaleState(
        { available: false, reason: "not_yet_on_sale", opensAt: OPENS_AT },
        null,
      ),
    ).toEqual({ isBuyable: false, note: "Not on sale yet" });
  });

  it("survives an unknown timezone id rather than crashing checkout", () => {
    expect(
      describeTierSaleState(
        { available: false, reason: "not_yet_on_sale", opensAt: OPENS_AT },
        "Mars/Olympus_Mons",
      ),
    ).toEqual({ isBuyable: false, note: "Not on sale yet" });
  });

  it("says 'Sales ended' with no date — a passed deadline is not actionable", () => {
    expect(
      describeTierSaleState(
        { available: false, reason: "sales_ended", closedAt: OPENS_AT },
        "America/Chicago",
      ),
    ).toEqual({ isBuyable: false, note: "Sales ended" });
  });

  it("blocks on an UNKNOWN refusal rather than falling through to buyable", () => {
    expect(
      describeTierSaleState(
        { available: false, reason: "some_future_reason" },
        "America/Chicago",
      ),
    ).toEqual({ isBuyable: false, note: "Not available" });
  });
});
