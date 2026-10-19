import { describe, expect, it, vi } from "vitest";

import type { Repos } from "@th/ports/repos";

import { previewPromos } from "../preview-promos";

// ─────────────────────────────────────────────────────────────────────────────
// previewPromos pricing.
//
// The scanner's door preview must quote the SAME discount the POS sale will
// compute. There is no separate door price (door-sales-same-price-and-tax
// spec FR-012): online checkout, the POS and this preview all resolve the
// same unit price, so there is no pricing mode to choose.
// ─────────────────────────────────────────────────────────────────────────────

const EVENT_ID = "00000000-0000-4000-8000-0000000000e1";
const ORG_ID = "00000000-0000-4000-8000-0000000000a1";
const TT_GA = "00000000-0000-4000-8000-0000000000a2";
const NOW = new Date("2026-04-26T20:00:00Z");

function makeRepos(promoOverrides: Record<string, unknown> = {}) {
  const promo = {
    id: "00000000-0000-4000-8000-0000000000b1",
    code: "HALF",
    codeNormalized: "HALF",
    kind: "PERCENT" as const,
    value: 50,
    currency: "usd",
    scope: "ORG" as const,
    scopeId: ORG_ID,
    startsAt: null,
    endsAt: null,
    maxRedemptions: null,
    maxRedemptionsPerHuman: null,
    minOrderCents: 0,
    maxDiscountCents: null,
    stackable: false,
    isPublic: false,
    status: "ACTIVE" as const,
    ...promoOverrides,
  };

  return {
    events: {
      getById: vi.fn(async () => ({
        id: EVENT_ID,
        orgId: ORG_ID,
        humanId: null,
        currency: "usd",
      })),
      listTicketTypes: vi.fn(async () => [
        {
          id: TT_GA,
          name: "GA",
          priceCents: 2000,
          pricingMode: "FIXED" as const,
          minimumCents: null,
          suggestedCents: null,
          capacity: 100,
          status: "ACTIVE" as const,
          seatSectionId: null,
        },
      ]),
    },
    promos: {
      findActiveByCodes: vi.fn(async () => [promo]),
      getRedemptionStats: vi.fn(async () => ({
        totalRedemptions: 0,
        redemptionsForHuman: 0,
      })),
    },
  } as unknown as Repos;
}

describe("previewPromos — one price for every surface", () => {
  it("prices off the resolved ticket price", async () => {
    const result = await previewPromos(
      { repos: makeRepos(), clock: { now: () => NOW } },
      {
        eventId: EVENT_ID,
        codes: ["HALF"],
        ticketSelections: [{ ticketTypeId: TT_GA, qty: 2 }],
      },
    );

    // 2 × $20 = $40 → 50% = $20
    expect(result.orderSubtotalCents).toBe(4000);
    expect(result.totalDiscountCents).toBe(2000);
  });

  it("accepts a request from an older scanner build that still sends the removed pricing field, and prices it identically", async () => {
    // Installed scanner builds send `pricing: "DOOR"`. The input schema is
    // not strict, so the key is stripped rather than refused, and the quote
    // matches what the POS sale charges.
    const legacyInput = {
      eventId: EVENT_ID,
      codes: ["HALF"],
      ticketSelections: [{ ticketTypeId: TT_GA, qty: 2 }],
      pricing: "DOOR",
    } as unknown as Parameters<typeof previewPromos>[1];

    const result = await previewPromos(
      { repos: makeRepos(), clock: { now: () => NOW } },
      legacyInput,
    );

    expect(result.orderSubtotalCents).toBe(4000);
    expect(result.totalDiscountCents).toBe(2000);
  });
});

describe("previewPromos — pay what you want (ADJUSTABLE) lines", () => {
  const PWYW_TIER = {
    id: TT_GA,
    name: "Pay What You Want",
    // The stored list price of every PWYW tier — what the preview used to
    // discount, so every promo on a PWYW line quoted $0 off.
    priceCents: 0,
    pricingMode: "ADJUSTABLE" as const,
    minimumCents: 500,
    suggestedCents: 1500,
    capacity: 100,
    status: "ACTIVE" as const,
    seatSectionId: null,
  };
  const pwywRepos = () => {
    const repos = makeRepos();
    (
      repos.events.listTicketTypes as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValue([PWYW_TIER]);
    return repos;
  };

  it("regression: discounts the CHOSEN amount, like computeOrderAmounts charges it", async () => {
    const result = await previewPromos(
      { repos: pwywRepos(), clock: { now: () => NOW } },
      {
        eventId: EVENT_ID,
        codes: ["HALF"],
        ticketSelections: [
          { ticketTypeId: TT_GA, qty: 2, donationAmountCents: 3000 },
        ],
      },
    );
    // 2 × $30 chosen = $60 → 50% = $30.
    expect(result.orderSubtotalCents).toBe(6000);
    expect(result.totalDiscountCents).toBe(3000);
  });

  it("without an amount, quotes the tier's floor — never its stored $0", async () => {
    const result = await previewPromos(
      { repos: pwywRepos(), clock: { now: () => NOW } },
      {
        eventId: EVENT_ID,
        codes: ["HALF"],
        ticketSelections: [{ ticketTypeId: TT_GA, qty: 1 }],
      },
    );
    expect(result.orderSubtotalCents).toBe(500);
  });

  it("refuses an amount above the $10,000.00 per-ticket cap", async () => {
    await expect(
      previewPromos(
        { repos: pwywRepos(), clock: { now: () => NOW } },
        {
          eventId: EVENT_ID,
          codes: ["HALF"],
          ticketSelections: [
            { ticketTypeId: TT_GA, qty: 1, donationAmountCents: 1_000_001 },
          ],
        },
      ),
    ).rejects.toEqual(
      expect.objectContaining({
          code: "invalid_input",
          issues: expect.arrayContaining([
            expect.objectContaining({
              path: expect.arrayContaining(["donationAmountCents"]),
              message: expect.stringMatching(/\$10,000\.00 per-ticket maximum/),
            }),
          ]),
        }),
    );
  });
});
