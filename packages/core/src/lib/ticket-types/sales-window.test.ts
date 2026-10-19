import { describe, expect, it } from "vitest";

import { normalizeSalesWindow } from "./sales-window";

const OPEN_AT = new Date("2026-09-01T17:00:00.000Z");
const CLOSE_AT = new Date("2026-09-20T17:00:00.000Z");

const invalid = expect.objectContaining({
  code: "TICKET_TYPE_SALES_WINDOW_INVALID",
});

/**
 * FR-014's write-boundary invariant in isolation, the sibling of
 * `scheduled-price.test.ts`. The use-case tests prove it fires on the real
 * write paths; this file pins the rule itself.
 *
 * The headline difference from the scheduled price: the two bounds are
 * INDEPENDENT. There is no both-or-neither rule here, and asserting that
 * explicitly is the point — a reviewer reading the two validators side by side
 * must be able to see that the asymmetry is deliberate rather than an omission.
 */
describe("normalizeSalesWindow", () => {
  it("accepts a well-ordered window unchanged", () => {
    expect(
      normalizeSalesWindow({ salesOpenAt: OPEN_AT, salesCloseAt: CLOSE_AT }),
    ).toEqual({ salesOpenAt: OPEN_AT, salesCloseAt: CLOSE_AT });
  });

  it("accepts both-absent as unbounded", () => {
    expect(normalizeSalesWindow({})).toEqual({
      salesOpenAt: null,
      salesCloseAt: null,
    });
    expect(
      normalizeSalesWindow({ salesOpenAt: null, salesCloseAt: null }),
    ).toEqual({ salesOpenAt: null, salesCloseAt: null });
  });

  it("accepts an OPEN bound alone — 'opens Friday, never closes' is valid", () => {
    expect(normalizeSalesWindow({ salesOpenAt: OPEN_AT })).toEqual({
      salesOpenAt: OPEN_AT,
      salesCloseAt: null,
    });
  });

  it("accepts a CLOSE bound alone — 'closes Friday' is valid", () => {
    expect(normalizeSalesWindow({ salesCloseAt: CLOSE_AT })).toEqual({
      salesOpenAt: null,
      salesCloseAt: CLOSE_AT,
    });
  });

  it("rejects an INVERTED window", () => {
    expect(() =>
      normalizeSalesWindow({ salesOpenAt: CLOSE_AT, salesCloseAt: OPEN_AT }),
    ).toThrowError(invalid);
  });

  it("rejects a ZERO-WIDTH window — it could never sell anything", () => {
    // `salesOpenAt` is inclusive and `salesCloseAt` exclusive, so open === close
    // is an empty interval: a tier that looks configured and is permanently
    // unpurchasable. That is the "silently unsellable type" FR-016 forbids.
    expect(() =>
      normalizeSalesWindow({ salesOpenAt: OPEN_AT, salesCloseAt: OPEN_AT }),
    ).toThrowError(invalid);
  });

  it("rejects an unparseable OPEN bound", () => {
    expect(() =>
      normalizeSalesWindow({ salesOpenAt: new Date("nope") }),
    ).toThrowError(invalid);
  });

  it("rejects an unparseable CLOSE bound", () => {
    expect(() =>
      normalizeSalesWindow({ salesCloseAt: new Date("nope") }),
    ).toThrowError(invalid);
  });

  it("does not collapse the epoch to 'unset'", () => {
    // Every check is `== null`, never falsy. `new Date(0)` is a real instant.
    const epoch = new Date(0);
    expect(normalizeSalesWindow({ salesOpenAt: epoch })).toEqual({
      salesOpenAt: epoch,
      salesCloseAt: null,
    });
  });
});
