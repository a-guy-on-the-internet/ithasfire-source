import { describe, expect, it, vi } from "vitest";

import type { Repos } from "@th/ports/repos";

import { previewPromos } from "../preview-promos";

/**
 * A promo rejection names the code that failed, in `meta.promoCode` — the bag
 * the legacy error path forwards to the wire as `data.meta`. The checkout used
 * to guess "the newest code" and could delete a perfectly good one; with the
 * code on the error it drops exactly the one that failed.
 */

const EVENT_ID = "00000000-0000-4000-8000-0000000000e1";
const ORG_ID = "00000000-0000-4000-8000-0000000000a1";
const TT_ID = "00000000-0000-4000-8000-0000000000a2";
const NOW = new Date("2026-04-26T20:00:00Z");

const promo = (code: string, overrides: Record<string, unknown> = {}) => ({
  id: `promo-${code}`,
  code,
  codeNormalized: code,
  kind: "PERCENT" as const,
  value: 10,
  currency: "usd",
  scope: "ORG" as const,
  scopeId: ORG_ID,
  startsAt: null,
  endsAt: null,
  maxRedemptions: null,
  maxRedemptionsPerHuman: null,
  minOrderCents: 0,
  maxDiscountCents: null,
  stackable: true,
  isPublic: false,
  status: "ACTIVE" as const,
  ...overrides,
});

const repos = (promos: ReturnType<typeof promo>[]) =>
  ({
    events: {
      getById: vi.fn(async () => ({
        id: EVENT_ID,
        orgId: ORG_ID,
        humanId: null,
        currency: "usd",
      })),
      listTicketTypes: vi.fn(async () => [
        {
          id: TT_ID,
          name: "Pay What You Want",
          priceCents: 0,
          pricingMode: "ADJUSTABLE" as const,
          minimumCents: 0,
          suggestedCents: 1500,
          capacity: 100,
          status: "ACTIVE" as const,
          seatSectionId: null,
        },
      ]),
    },
    promos: {
      findActiveByCodes: vi.fn(async () => promos),
      getRedemptionStats: vi.fn(async () => ({
        totalRedemptions: 0,
        redemptionsForHuman: 0,
      })),
    },
  }) as unknown as Repos;

describe("promo rejections carry the failing code in meta", () => {
  it("the OLDER code failing its minimum order is the one named", async () => {
    // EARLYBIRD (older) needs a $20 order; STUDENT (newer) has no minimum.
    // The buyer drops their amount to $15, so EARLYBIRD — not STUDENT — fails.
    await expect(
      previewPromos(
        {
          repos: repos([
            promo("EARLYBIRD", { minOrderCents: 2000 }),
            promo("STUDENT"),
          ]),
          clock: { now: () => NOW },
        },
        {
          eventId: EVENT_ID,
          codes: ["EARLYBIRD", "STUDENT"],
          ticketSelections: [
            { ticketTypeId: TT_ID, qty: 1, donationAmountCents: 1500 },
          ],
        },
      ),
    ).rejects.toMatchObject({
      message: "promo_min_order_not_met",
      promoCode: "EARLYBIRD",
      meta: { promoCode: "EARLYBIRD" },
    });
  });

  it("a stacking rejection names the non-stackable code", async () => {
    await expect(
      previewPromos(
        {
          repos: repos([promo("EARLYBIRD"), promo("SOLO", { stackable: false })]),
          clock: { now: () => NOW },
        },
        {
          eventId: EVENT_ID,
          codes: ["EARLYBIRD", "SOLO"],
          ticketSelections: [
            { ticketTypeId: TT_ID, qty: 1, donationAmountCents: 1500 },
          ],
        },
      ),
    ).rejects.toMatchObject({
      message: "promo_not_stackable",
      meta: { promoCode: "SOLO" },
    });
  });
});
