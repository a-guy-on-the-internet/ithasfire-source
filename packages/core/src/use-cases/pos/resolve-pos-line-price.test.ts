import { describe, expect, it } from "vitest";

import { resolveUnitPriceCents } from "../../lib/orders/door-pricing";
import { resolvePosUnitPriceCents } from "./resolve-pos-line-price";

const NOW = new Date("2026-08-26T20:00:00Z");
const TT = "tt-1";

describe("resolvePosUnitPriceCents", () => {
  describe("FIXED tiers price at the online checkout price (FR-012: no door price)", () => {
    it("charges priceCents for an unscheduled tier", () => {
      expect(
        resolvePosUnitPriceCents(
          { priceCents: 2500, pricingMode: "FIXED" },
          { ticketTypeId: TT },
          NOW,
        ),
      ).toBe(2500);
    });

    it("ignores a donation amount on a FIXED line — the client cannot name its own price", () => {
      expect(
        resolvePosUnitPriceCents(
          { priceCents: 2500, pricingMode: "FIXED" },
          { ticketTypeId: TT, donationAmountCents: 1 },
          NOW,
        ),
      ).toBe(2500);
    });

    it("treats a null/absent pricingMode as FIXED", () => {
      expect(
        resolvePosUnitPriceCents(
          { priceCents: 1500 },
          { ticketTypeId: TT, donationAmountCents: 99 },
          NOW,
        ),
      ).toBe(1500);
    });

    it("honours a scheduled price flip exactly as online checkout does", () => {
      const scheduled = {
        priceCents: 1000,
        scheduledPriceCents: 2000,
        scheduledPriceAt: new Date("2026-08-26T18:00:00Z"),
        pricingMode: "FIXED" as const,
      };
      const beforeFlip = new Date("2026-08-26T17:59:59.999Z");

      // After the flip: the scheduled price, same as the online resolver.
      expect(
        resolvePosUnitPriceCents(scheduled, { ticketTypeId: TT }, NOW),
      ).toBe(2000);
      expect(
        resolvePosUnitPriceCents(scheduled, { ticketTypeId: TT }, NOW),
      ).toBe(resolveUnitPriceCents(scheduled, { now: NOW }));

      // Before the flip: the list price.
      expect(
        resolvePosUnitPriceCents(scheduled, { ticketTypeId: TT }, beforeFlip),
      ).toBe(1000);
    });
  });

  describe("ADJUSTABLE tiers are buyer-priced", () => {
    const pwyc = {
      // The trap this whole module exists for: `upsertTicketType` stores 0 in
      // `priceCents` for ADJUSTABLE, so the old code charged $0.
      priceCents: 0,
      pricingMode: "ADJUSTABLE" as const,
      minimumCents: 500,
    };

    it("takes the named amount, ignoring the stored price", () => {
      expect(
        resolvePosUnitPriceCents(
          pwyc,
          { ticketTypeId: TT, donationAmountCents: 3500 },
          NOW,
        ),
      ).toBe(3500);
    });

    it("accepts exactly the floor — the floor is a full-price ticket", () => {
      expect(
        resolvePosUnitPriceCents(
          pwyc,
          { ticketTypeId: TT, donationAmountCents: 500 },
          NOW,
        ),
      ).toBe(500);
    });

    it("accepts far above the floor", () => {
      expect(
        resolvePosUnitPriceCents(
          pwyc,
          { ticketTypeId: TT, donationAmountCents: 250_00 },
          NOW,
        ),
      ).toBe(25_000);
    });

    it("refuses below the floor, naming the minimum", () => {
      expect(() =>
        resolvePosUnitPriceCents(
          pwyc,
          { ticketTypeId: TT, donationAmountCents: 499 },
          NOW,
        ),
      ).toThrowError(
        expect.objectContaining({
          code: "invalid_input",
          message: "donation_below_minimum",
          ticketTypeId: TT,
          minimumCents: 500,
        }) as unknown as Error,
      );
    });

    it("refuses a missing amount", () => {
      expect(() =>
        resolvePosUnitPriceCents(pwyc, { ticketTypeId: TT }, NOW),
      ).toThrowError(
        expect.objectContaining({
          code: "invalid_input",
          message: "donation_amount_required",
          ticketTypeId: TT,
        }) as unknown as Error,
      );
    });

    it("treats a null minimum as a zero floor", () => {
      expect(
        resolvePosUnitPriceCents(
          { ...pwyc, minimumCents: null },
          { ticketTypeId: TT, donationAmountCents: 0 },
          NOW,
        ),
      ).toBe(0);
    });
  });
});
