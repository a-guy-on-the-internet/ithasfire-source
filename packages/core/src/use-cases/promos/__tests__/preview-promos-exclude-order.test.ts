import { describe, expect, it, vi } from "vitest";

import type { Repos } from "@th/ports/repos";

import { previewPromos } from "../preview-promos";

// ─────────────────────────────────────────────────────────────────────────────
// Money audit 2026-09-08 #8, the hold-aware follow-up.
//
// Once redemption stats count LIVE holds, a buyer who already holds a
// 1-per-person code on their OWN pending order — they reached the payment
// step, then went back to edit quantity — sees `promo_redeemed_by_human` in
// the live preview: their own hold fills the cap. The preview must be told
// which order to leave out, and only that one — the same exclusion
// `createCheckout`'s routing probe and `claimFreeTickets` apply before they
// retire that cart.
//
// The id is client-supplied. It is honoured ONLY when the session is the
// buyer AND the order belongs to them; anything else is dropped, never
// trusted, so it cannot be used as an oracle over other people's carts.
// ─────────────────────────────────────────────────────────────────────────────

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const BUYER_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_BUYER_ID = "44444444-4444-4444-8444-444444444444";
const PROMO_ID = "55555555-5555-4555-8555-555555555555";
const TT_GA = "66666666-6666-4666-8666-666666666666";
const OWN_PENDING_ORDER_ID = "77777777-7777-4777-8777-777777777777";
const OWN_OTHER_ORDER_ID = "88888888-8888-4888-8888-888888888888";
const STRANGERS_ORDER_ID = "99999999-9999-4999-8999-999999999999";
const OWN_OTHER_EVENT_ORDER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWN_PAID_ORDER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER_EVENT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const NOW = new Date("2026-09-08T12:00:00.000Z");

const onePerPersonPromo = {
  id: PROMO_ID,
  code: "ONCE",
  codeNormalized: "ONCE",
  kind: "AMOUNT" as const,
  value: 500,
  currency: "usd",
  scope: "GLOBAL" as const,
  scopeId: undefined,
  minOrderCents: 0,
  maxRedemptions: undefined,
  maxRedemptionsPerHuman: 1,
  maxDiscountCents: undefined,
  stackable: false,
  isPublic: true,
  status: "ACTIVE" as const,
  startsAt: undefined,
  endsAt: undefined,
  createdAt: NOW,
  updatedAt: NOW,
};

/** The ledger: ONE live hold, on the buyer's own pending order. */
const liveHolds = [{ orderId: OWN_PENDING_ORDER_ID, humanId: BUYER_ID }];

function makeRepos() {
  const repos = {
    events: {
      getById: vi.fn(async () => ({
        id: EVENT_ID,
        orgId: ORG_ID,
        humanId: null,
        categoryId: null,
        placeId: null,
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
      findActiveByCodes: vi.fn(async () => [onePerPersonPromo]),
      // Mirrors the adapter's semantics: a live hold counts unless it sits on
      // the excluded order; the per-human leg is keyed on the caller's human.
      getRedemptionStats: vi.fn(
        async ({
          humanId,
          excludeOrderId,
        }: {
          promoId: string;
          humanId?: string;
          now: Date;
          excludeOrderId?: string;
        }) => {
          const counted = liveHolds.filter(
            (hold) => hold.orderId !== excludeOrderId,
          );
          return {
            totalRedemptions: counted.length,
            redemptionsForHuman: counted.filter(
              (hold) => hold.humanId === humanId,
            ).length,
          };
        },
      ),
      createHolds: vi.fn(),
    },
    orders: {
      getById: vi.fn(async (orderId: string) => {
        const pending = (buyerHumanId: string, eventId: string) => ({
          id: orderId,
          buyerHumanId,
          eventId,
          status: "PENDING",
        });
        if (orderId === OWN_PENDING_ORDER_ID || orderId === OWN_OTHER_ORDER_ID) {
          return pending(BUYER_ID, EVENT_ID);
        }
        if (orderId === STRANGERS_ORDER_ID) {
          return pending(OTHER_BUYER_ID, EVENT_ID);
        }
        if (orderId === OWN_OTHER_EVENT_ORDER_ID) {
          return pending(BUYER_ID, OTHER_EVENT_ID);
        }
        if (orderId === OWN_PAID_ORDER_ID) {
          return { ...pending(BUYER_ID, EVENT_ID), status: "SUCCEEDED" };
        }
        return null;
      }),
    },
    memberships: {
      listForMember: vi.fn(async () => []),
    },
    membershipTiers: {
      listByIds: vi.fn(async () => []),
    },
  };
  return { repos: repos as unknown as Repos, mocks: repos };
}

const baseInput = {
  eventId: EVENT_ID,
  codes: ["ONCE"],
  ticketSelections: [{ ticketTypeId: TT_GA, qty: 1 }],
  buyerHumanId: BUYER_ID,
  includeMemberBenefits: true,
};

describe("previewPromos — excludeOrderId leaves the buyer's OWN pending hold out of the cap", () => {
  it("RED-FIRST: without the exclusion, the buyer's own live hold fills a 1-per-person cap", async () => {
    const { repos } = makeRepos();

    await expect(
      previewPromos({ repos, clock: { now: () => NOW } }, baseInput),
    ).rejects.toMatchObject({ code: "conflict", message: "promo_redeemed_by_human" });
  });

  it("stays eligible when excludeOrderId is the buyer's own pending order", async () => {
    const { repos, mocks } = makeRepos();

    const result = await previewPromos(
      { repos, clock: { now: () => NOW } },
      { ...baseInput, excludeOrderId: OWN_PENDING_ORDER_ID },
    );

    expect(result.applications).toHaveLength(1);
    expect(result.applications[0]?.promoId).toBe(PROMO_ID);
    expect(result.totalDiscountCents).toBe(500);
    expect(mocks.orders.getById).toHaveBeenCalledWith(OWN_PENDING_ORDER_ID);
    expect(mocks.promos.getRedemptionStats).toHaveBeenCalledWith({
      promoId: PROMO_ID,
      humanId: BUYER_ID,
      now: NOW,
      excludeOrderId: OWN_PENDING_ORDER_ID,
    });
  });

  it("is still rejected when the exclusion names a DIFFERENT order of the buyer's — the hold lives elsewhere", async () => {
    const { repos } = makeRepos();

    await expect(
      previewPromos(
        { repos, clock: { now: () => NOW } },
        { ...baseInput, excludeOrderId: OWN_OTHER_ORDER_ID },
      ),
    ).rejects.toMatchObject({ code: "conflict", message: "promo_redeemed_by_human" });
  });

  it("SECURITY: an order that is NOT the buyer's is dropped, not excluded", async () => {
    const { repos, mocks } = makeRepos();

    await expect(
      previewPromos(
        { repos, clock: { now: () => NOW } },
        { ...baseInput, excludeOrderId: STRANGERS_ORDER_ID },
      ),
    ).rejects.toMatchObject({ code: "conflict", message: "promo_redeemed_by_human" });

    // The stats read ran with NO exclusion at all.
    expect(mocks.promos.getRedemptionStats).toHaveBeenCalledWith({
      promoId: PROMO_ID,
      humanId: BUYER_ID,
      now: NOW,
      excludeOrderId: undefined,
    });
  });

  it("the buyer's own PENDING cart on ANOTHER event is dropped — checkout would not retire it", async () => {
    const { repos, mocks } = makeRepos();

    await expect(
      previewPromos(
        { repos, clock: { now: () => NOW } },
        { ...baseInput, excludeOrderId: OWN_OTHER_EVENT_ORDER_ID },
      ),
    ).rejects.toMatchObject({ code: "conflict", message: "promo_redeemed_by_human" });
    expect(mocks.promos.getRedemptionStats).toHaveBeenCalledWith(
      expect.objectContaining({ excludeOrderId: undefined }),
    );
  });

  it("the buyer's own order that is no longer PENDING is dropped — a paid order is a real redemption", async () => {
    const { repos, mocks } = makeRepos();

    await expect(
      previewPromos(
        { repos, clock: { now: () => NOW } },
        { ...baseInput, excludeOrderId: OWN_PAID_ORDER_ID },
      ),
    ).rejects.toMatchObject({ code: "conflict", message: "promo_redeemed_by_human" });
    expect(mocks.promos.getRedemptionStats).toHaveBeenCalledWith(
      expect.objectContaining({ excludeOrderId: undefined }),
    );
  });

  it("SECURITY: an unknown order id is dropped, not excluded", async () => {
    const { repos, mocks } = makeRepos();

    await expect(
      previewPromos(
        { repos, clock: { now: () => NOW } },
        { ...baseInput, excludeOrderId: "00000000-0000-4000-8000-000000000000" },
      ),
    ).rejects.toMatchObject({ code: "conflict", message: "promo_redeemed_by_human" });
    expect(mocks.promos.getRedemptionStats).toHaveBeenCalledWith({
      promoId: PROMO_ID,
      humanId: BUYER_ID,
      now: NOW,
      excludeOrderId: undefined,
    });
  });

  it("SECURITY: an anonymous / door preview never reads the order and never excludes", async () => {
    const { repos, mocks } = makeRepos();

    // Door/POS semantics: identity present but `includeMemberBenefits` absent
    // → the session is not asserted to be the buyer, so nothing is owned.
    const result = await previewPromos(
      { repos, clock: { now: () => NOW } },
      {
        ...baseInput,
        includeMemberBenefits: false,
        excludeOrderId: OWN_PENDING_ORDER_ID,
      },
    );

    // Anonymous per-human leg is 0, so a 1-per-person cap cannot fire here —
    // the point is the exclusion was neither looked up nor forwarded.
    expect(result.applications).toHaveLength(1);
    expect(mocks.orders.getById).not.toHaveBeenCalled();
    expect(mocks.promos.getRedemptionStats).toHaveBeenCalledWith({
      promoId: PROMO_ID,
      humanId: undefined,
      now: NOW,
      excludeOrderId: undefined,
    });
  });
});
