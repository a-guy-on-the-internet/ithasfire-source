import { describe, expect, it } from "vitest";

import { normalizeScheduledPrice } from "./scheduled-price";

const AT = new Date("2026-03-06T02:00:00.000Z");

/**
 * FR-005's write-boundary invariant in isolation. The use-case tests
 * (upsert-ticket-type / update-ticket-type) prove it fires on the real write
 * paths; this file pins the rule itself, including the cases the Zod schema
 * would normally catch first — those guards are defence-in-depth for callers
 * that reach the repo through a different schema (template apply, imports).
 */
describe("normalizeScheduledPrice", () => {
  it("accepts a complete schedule unchanged", () => {
    expect(
      normalizeScheduledPrice({
        scheduledPriceCents: 2000,
        scheduledPriceAt: AT,
      }),
    ).toEqual({ scheduledPriceCents: 2000, scheduledPriceAt: AT });
  });

  it("accepts both-absent as unscheduled", () => {
    expect(normalizeScheduledPrice({})).toEqual({
      scheduledPriceCents: null,
      scheduledPriceAt: null,
    });
    expect(
      normalizeScheduledPrice({
        scheduledPriceCents: null,
        scheduledPriceAt: null,
      }),
    ).toEqual({ scheduledPriceCents: null, scheduledPriceAt: null });
  });

  it("accepts 0 as a real post-flip price (a tier that becomes free)", () => {
    expect(
      normalizeScheduledPrice({
        scheduledPriceCents: 0,
        scheduledPriceAt: AT,
      }),
    ).toEqual({ scheduledPriceCents: 0, scheduledPriceAt: AT });
  });

  it("rejects a price with no instant", () => {
    expect(() =>
      normalizeScheduledPrice({ scheduledPriceCents: 2000 }),
    ).toThrowError(
      expect.objectContaining({ code: "TICKET_TYPE_SCHEDULE_INCOMPLETE" }),
    );
  });

  it("rejects an instant with no price", () => {
    expect(() =>
      normalizeScheduledPrice({ scheduledPriceAt: AT }),
    ).toThrowError(
      expect.objectContaining({ code: "TICKET_TYPE_SCHEDULE_INCOMPLETE" }),
    );
  });

  it("rejects a negative price — money is unsigned integer cents", () => {
    expect(() =>
      normalizeScheduledPrice({
        scheduledPriceCents: -1,
        scheduledPriceAt: AT,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "TICKET_TYPE_SCHEDULE_INCOMPLETE" }),
    );
  });

  it("rejects a fractional price", () => {
    expect(() =>
      normalizeScheduledPrice({
        scheduledPriceCents: 12.5,
        scheduledPriceAt: AT,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "TICKET_TYPE_SCHEDULE_INCOMPLETE" }),
    );
  });

  it("rejects an unparseable instant", () => {
    expect(() =>
      normalizeScheduledPrice({
        scheduledPriceCents: 2000,
        scheduledPriceAt: new Date("nope"),
      }),
    ).toThrowError(
      expect.objectContaining({ code: "TICKET_TYPE_SCHEDULE_INCOMPLETE" }),
    );
  });
});
