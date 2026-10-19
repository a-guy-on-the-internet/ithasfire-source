import { describe, expect, it } from "vitest";

import { taxRateLabelBps, type TaxLineForLabel } from "./tax-rate-label";

const line = (
  rateBps: number,
  base: TaxLineForLabel["base"],
  collector: TaxLineForLabel["collector"] = "PLATFORM",
): TaxLineForLabel => ({ rateBps, base, collector });

describe("taxRateLabelBps — the Taxes row prints a % only when one % produces the amount", () => {
  it("one SALES line on the face: its rate (unchanged single-line jurisdictions)", () => {
    expect(taxRateLabelBps([line(888, "TICKET_FACE")])).toBe(888);
  });

  it("one SALES line on the buyer total (Tennessee, Minnesota outside Minneapolis): its rate, as before", () => {
    expect(taxRateLabelBps([line(903, "BUYER_TOTAL")])).toBe(903);
  });

  it("two PLATFORM lines on one base: the summed rate", () => {
    expect(
      taxRateLabelBps([line(625, "TICKET_FACE"), line(300, "TICKET_FACE")]),
    ).toBe(925);
  });

  it("regression: Minneapolis (9.03% on the buyer total + 3% on the face) prints no rate — never '12.03%'", () => {
    expect(
      taxRateLabelBps([line(903, "BUYER_TOTAL"), line(300, "TICKET_FACE")]),
    ).toBeNull();
  });

  it("ORGANISER lines are not charged, so they neither add to the rate nor break uniformity", () => {
    expect(
      taxRateLabelBps([
        line(888, "TICKET_FACE"),
        line(300, "BUYER_TOTAL", "ORGANISER"),
      ]),
    ).toBe(888);
  });

  it("nothing charged, or no lines yet: null", () => {
    expect(taxRateLabelBps([])).toBeNull();
    expect(taxRateLabelBps([line(300, "TICKET_FACE", "ORGANISER")])).toBeNull();
    expect(taxRateLabelBps(null)).toBeNull();
    expect(taxRateLabelBps(undefined)).toBeNull();
  });
});
