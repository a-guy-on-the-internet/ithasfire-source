import { describe, expect, it } from "vitest";

import { effectiveResaleCapCents } from "./effective-resale-cap";

// Owner ruling 2026-10-10 (seat-price-overrides spec, Q-001): the resale cap
// is set on the ticket type, and a ticket's cap never falls below what that
// ticket itself was priced at.
describe("effectiveResaleCapCents", () => {
  it("lifts the cap to the ticket's own price: a $50 seat on a $30 type capped at $35", () => {
    expect(
      effectiveResaleCapCents({
        ticketTypeResaleCapCents: 3500,
        ticketUnitPriceCents: 5000,
      }),
    ).toBe(5000);
  });

  it("keeps the type's cap for a ticket bought at the type's own $30", () => {
    expect(
      effectiveResaleCapCents({
        ticketTypeResaleCapCents: 3500,
        ticketUnitPriceCents: 3000,
      }),
    ).toBe(3500);
  });

  it("is the same number when the ticket's own price equals the cap", () => {
    expect(
      effectiveResaleCapCents({
        ticketTypeResaleCapCents: 3500,
        ticketUnitPriceCents: 3500,
      }),
    ).toBe(3500);
  });

  it("lifts by a single cent", () => {
    expect(
      effectiveResaleCapCents({
        ticketTypeResaleCapCents: 3500,
        ticketUnitPriceCents: 3501,
      }),
    ).toBe(3501);
  });

  it.each([null, undefined])(
    "has no cap when the type has none (%s), whatever the ticket cost",
    (ticketTypeResaleCapCents) => {
      expect(
        effectiveResaleCapCents({
          ticketTypeResaleCapCents,
          ticketUnitPriceCents: 5000,
        }),
      ).toBeNull();
      expect(
        effectiveResaleCapCents({
          ticketTypeResaleCapCents,
          ticketUnitPriceCents: null,
        }),
      ).toBeNull();
    },
  );

  it("keeps a $0 cap a cap, lifted to the ticket's own price", () => {
    expect(
      effectiveResaleCapCents({
        ticketTypeResaleCapCents: 0,
        ticketUnitPriceCents: 0,
      }),
    ).toBe(0);
    expect(
      effectiveResaleCapCents({
        ticketTypeResaleCapCents: 0,
        ticketUnitPriceCents: 3000,
      }),
    ).toBe(3000);
  });

  it("leaves a comp ticket ($0 own price) on the type's cap", () => {
    expect(
      effectiveResaleCapCents({
        ticketTypeResaleCapCents: 3500,
        ticketUnitPriceCents: 0,
      }),
    ).toBe(3500);
  });

  // A set-but-unreadable cap must never fail open. `Math.max(NaN, x)` is NaN
  // and `ask > NaN` is false for every ask, so passing it through would refuse
  // nothing at all.
  describe.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ])("a type cap that is not a finite number (%s) fails closed", (ticketTypeResaleCapCents) => {
    it("caps the ticket at its own price", () => {
      const cap = effectiveResaleCapCents({
        ticketTypeResaleCapCents,
        ticketUnitPriceCents: 5000,
      });

      expect(cap).toBe(5000);
      // What the sites do with it: 5000 lists, 5001 does not.
      expect(5000 > cap!).toBe(false);
      expect(5001 > cap!).toBe(true);
    });

    it.each([null, undefined, Number.NaN])(
      "caps at 0 when the ticket's own price is unknown too (%s)",
      (ticketUnitPriceCents) => {
        const cap = effectiveResaleCapCents({
          ticketTypeResaleCapCents,
          ticketUnitPriceCents,
        });

        expect(cap).toBe(0);
        // The smallest ask a listing accepts (1 cent) is refused.
        expect(1 > cap!).toBe(true);
      },
    );
  });

  it("never returns a non-finite or negative cap", () => {
    const caps = [null, undefined, 0, 3500, Number.NaN, Infinity, -Infinity];
    const prices = [null, undefined, -100, 0, 5000, Number.NaN, Infinity];
    for (const ticketTypeResaleCapCents of caps) {
      for (const ticketUnitPriceCents of prices) {
        const cap = effectiveResaleCapCents({
          ticketTypeResaleCapCents,
          ticketUnitPriceCents,
        });
        if (cap === null) {
          expect(ticketTypeResaleCapCents ?? null).toBeNull();
          continue;
        }
        expect(Number.isFinite(cap)).toBe(true);
        expect(cap).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it.each([null, undefined, Number.NaN, Number.POSITIVE_INFINITY])(
    "falls back to the type's cap when the ticket's own price is unknown (%s)",
    (ticketUnitPriceCents) => {
      expect(
        effectiveResaleCapCents({
          ticketTypeResaleCapCents: 3500,
          ticketUnitPriceCents,
        }),
      ).toBe(3500);
    },
  );
});

// organiser-resale-share spec, FR-007 (owner ruling R15): the floor is the
// organiser's price at the first sale, never the previous resale ask.
describe("effectiveResaleCapCents: originalUnitPriceCents", () => {
  it("floors a resold ticket at its original price, not the previous ask", () => {
    // First sold at $40 on a type capped at $35; last bought on resale at $45.
    expect(
      effectiveResaleCapCents({
        ticketTypeResaleCapCents: 3500,
        ticketUnitPriceCents: 4500,
        originalUnitPriceCents: 4000,
      }),
    ).toBe(4000);
  });

  it("the original price below the type's cap leaves the type's cap", () => {
    expect(
      effectiveResaleCapCents({
        ticketTypeResaleCapCents: 3500,
        ticketUnitPriceCents: 5000,
        originalUnitPriceCents: 3000,
      }),
    ).toBe(3500);
  });

  it("null original = unknown: the type's cap, never the purchased price", () => {
    expect(
      effectiveResaleCapCents({
        ticketTypeResaleCapCents: 3500,
        ticketUnitPriceCents: 5000,
        originalUnitPriceCents: null,
      }),
    ).toBe(3500);
  });

  it("omitted, the purchased price is the floor as before", () => {
    expect(
      effectiveResaleCapCents({
        ticketTypeResaleCapCents: 3500,
        ticketUnitPriceCents: 5000,
      }),
    ).toBe(5000);
    expect(
      effectiveResaleCapCents({
        ticketTypeResaleCapCents: 3500,
        ticketUnitPriceCents: 5000,
        originalUnitPriceCents: undefined,
      }),
    ).toBe(5000);
  });

  it("no type cap stays no cap, whatever the original price", () => {
    expect(
      effectiveResaleCapCents({
        ticketTypeResaleCapCents: null,
        ticketUnitPriceCents: 5000,
        originalUnitPriceCents: 9000,
      }),
    ).toBeNull();
  });

  it("a non-finite type cap fails closed to the original price", () => {
    expect(
      effectiveResaleCapCents({
        ticketTypeResaleCapCents: Number.NaN,
        ticketUnitPriceCents: 9000,
        originalUnitPriceCents: 4000,
      }),
    ).toBe(4000);
  });

  it("a non-finite original is unknown", () => {
    expect(
      effectiveResaleCapCents({
        ticketTypeResaleCapCents: 3500,
        ticketUnitPriceCents: 9000,
        originalUnitPriceCents: Number.NaN,
      }),
    ).toBe(3500);
  });
});
