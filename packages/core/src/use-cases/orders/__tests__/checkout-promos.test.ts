import { describe, it, expect, vi, beforeEach } from "vitest";

import type { TxRepos } from "@th/ports/repos";
import type { EventRecord } from "@th/ports/repos/events";
import { evaluatePromoApplications } from "../checkout-promos";
import type { MemberBenefitGrant } from "../../memberships/resolve-member-benefits";
import type { TicketLineComputation } from "../checkout-helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Promo eligibility at checkout — scope matching in computeEligibleAmount
// (exercised through evaluatePromoApplications).
//
// SECURITY: a HUMAN-scoped promo must ONLY apply to the human's PERSONAL
// events (orgId = null, humanId = seller). orgId takes precedence as the
// payee everywhere, so an org-owned event that also carries a humanId must
// never match — otherwise a human's promo would discount an org's revenue.
// ─────────────────────────────────────────────────────────────────────────────

const SELLER_HUMAN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_HUMAN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-bbbbbbbbbbbb";
const ORG_ID = "11111111-1111-4111-8111-111111111111";
const BUYER_ID = "22222222-2222-4222-8222-222222222222";
const PROMO_ID = "33333333-3333-4333-8333-333333333333";
const TICKET_TYPE_ID = "55555555-5555-4555-8555-555555555555";
const NOW = new Date("2026-08-05T12:00:00.000Z");

const humanPromo = {
  id: PROMO_ID,
  code: "SELLER10",
  codeNormalized: "SELLER10",
  kind: "AMOUNT" as const,
  value: 500,
  currency: "usd",
  scope: "HUMAN" as const,
  scopeId: SELLER_HUMAN_ID,
  minOrderCents: 0,
  maxRedemptions: undefined,
  maxRedemptionsPerHuman: undefined,
  maxDiscountCents: undefined,
  stackable: false,
  isPublic: false,
  status: "ACTIVE" as const,
  startsAt: undefined,
  endsAt: undefined,
  createdAt: NOW,
  updatedAt: NOW,
};

const ticketLines: TicketLineComputation[] = [
  {
    ticketTypeId: TICKET_TYPE_ID,
    qty: 2,
    unitPriceCents: 2500,
    lineGrossCents: 5000,
  },
];

function makeEvent(overrides: Partial<EventRecord>): EventRecord {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    orgId: null,
    humanId: null,
    ...overrides,
  } as EventRecord;
}

function makeTx(promo: typeof humanPromo) {
  const promos = {
    findActiveByCodes: vi.fn().mockResolvedValue([promo]),
    getRedemptionStats: vi
      .fn()
      .mockResolvedValue({ totalRedemptions: 0, redemptionsForHuman: 0 }),
  };
  return { promos, tx: { promos } as unknown as TxRepos };
}

function evaluateFor(event: EventRecord, promo = humanPromo) {
  const { tx } = makeTx(promo);
  return evaluatePromoApplications({
    codes: [{ original: "SELLER10", normalized: "SELLER10" }],
    tx,
    event,
    buyerHumanId: BUYER_ID,
    now: NOW,
    orderSubtotalCents: 5000,
    ticketLines,
  });
}

describe("evaluatePromoApplications — HUMAN scope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("applies to the seller's own personal event (orgId null)", async () => {
    const result = await evaluateFor(
      makeEvent({ orgId: null, humanId: SELLER_HUMAN_ID }),
    );

    expect(result.applications).toHaveLength(1);
    expect(result.totalDiscountCents).toBe(500);
    const application = result.applications[0]!;
    expect(application.kind).toBe("code");
    if (application.kind !== "code") throw new Error("expected a typed code");
    expect(application.promo.scope).toBe("HUMAN");
  });

  it("rejects on another human's personal event", async () => {
    await expect(
      evaluateFor(makeEvent({ orgId: null, humanId: OTHER_HUMAN_ID })),
    ).rejects.toMatchObject({ message: "promo_not_applicable" });
  });

  it("rejects on an org-owned event", async () => {
    await expect(
      evaluateFor(makeEvent({ orgId: ORG_ID, humanId: null })),
    ).rejects.toMatchObject({ message: "promo_not_applicable" });
  });

  it("SECURITY: rejects on an org-owned event that also carries the seller's humanId", async () => {
    // orgId is the payee — a human's promo must never discount an org's
    // revenue, even when the org event references that human.
    await expect(
      evaluateFor(makeEvent({ orgId: ORG_ID, humanId: SELLER_HUMAN_ID })),
    ).rejects.toMatchObject({ message: "promo_not_applicable" });
  });

  it("rejects when the promo has no scopeId", async () => {
    await expect(
      evaluateFor(makeEvent({ orgId: null, humanId: SELLER_HUMAN_ID }), {
        ...humanPromo,
        scopeId: null as unknown as string,
      }),
    ).rejects.toMatchObject({ message: "promo_not_applicable" });
  });
});

describe("evaluatePromoApplications — ORG scope (unchanged)", () => {
  const orgPromo = { ...humanPromo, scope: "ORG" as const, scopeId: ORG_ID };

  it("still applies to the org's own event", async () => {
    const result = await evaluateFor(
      makeEvent({ orgId: ORG_ID, humanId: null }),
      orgPromo,
    );

    expect(result.applications).toHaveLength(1);
    expect(result.totalDiscountCents).toBe(500);
  });

  it("does not apply to a personal event owned by a human with the same id shape", async () => {
    await expect(
      evaluateFor(makeEvent({ orgId: null, humanId: SELLER_HUMAN_ID }), orgPromo),
    ).rejects.toMatchObject({ message: "promo_not_applicable" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Membership-granted benefits (memberGrants) — the SECOND eligibility source
// joining the SAME pipeline.
//
// Differences from typed codes, all deliberate:
//   * typed codes THROW on failure; grants skip silently.
//   * a grant carries its own terms and NO code — nothing to dedupe against a
//     typed code, and nothing to leak.
//   * AT MOST ONE benefit applies per order, best for the buyer.
//   * no redemption caps and no min-order: those are campaign limits, so
//     grants never touch getRedemptionStats.
//
// The cross-tenant guard is the grant's derived ownerScope, matched by the
// SAME computeEligibleAmount that gates typed codes — including the
// `event.orgId != null` payee-precedence rule on human-owned tiers.
// ─────────────────────────────────────────────────────────────────────────────

const MEMBERSHIP_ID = "66666666-6666-4666-8666-666666666666";
const TIER_ID = "77777777-7777-4777-8777-777777777777";
const OTHER_TIER_ID = "77777777-7777-4777-8777-888888888888";
const BENEFIT_ID = "88888888-8888-4888-8888-888888888888";
const OTHER_BENEFIT_ID = "88888888-8888-4888-8888-999999999999";

function makeGrant(overrides: Partial<MemberBenefitGrant> = {}): MemberBenefitGrant {
  return {
    benefitId: BENEFIT_ID,
    tierId: TIER_ID,
    tierName: "Sustaining Member",
    membershipId: MEMBERSHIP_ID,
    discountKind: "AMOUNT",
    discountValue: 500,
    maxDiscountCents: null,
    label: null,
    ownerScope: { kind: "ORG", orgId: ORG_ID },
    ...overrides,
  };
}

describe("evaluatePromoApplications — memberGrants", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("auto-applies a granted benefit with NO code typed, and records the source", async () => {
    const { tx, promos } = makeTx(humanPromo);

    const result = await evaluatePromoApplications({
      codes: [],
      tx,
      event: makeEvent({ orgId: ORG_ID, humanId: null }),
      buyerHumanId: BUYER_ID,
      now: NOW,
      orderSubtotalCents: 5000,
      ticketLines,
      memberGrants: [makeGrant()],
    });

    expect(result.applications).toHaveLength(1);
    expect(result.totalDiscountCents).toBe(500);
    expect(result.applications[0]).toMatchObject({
      kind: "membership",
      discountCents: 500,
      grant: { benefitId: BENEFIT_ID, tierId: TIER_ID, membershipId: MEMBERSHIP_ID },
    });
    expect(result.discountItems[0]!.meta).toMatchObject({
      source: "membership",
      membershipBenefitId: BENEFIT_ID,
      membershipId: MEMBERSHIP_ID,
      tierId: TIER_ID,
      appliedDiscountCents: 500,
    });
    // Structurally codeless: no promoId, no code, nothing typed to echo.
    expect(result.discountItems[0]!.meta).not.toHaveProperty("promoId");
    expect(result.discountItems[0]!.meta).not.toHaveProperty("code");
    // No typed codes and no campaign caps → neither promo read fires.
    expect(promos.findActiveByCodes).not.toHaveBeenCalled();
    expect(promos.getRedemptionStats).not.toHaveBeenCalled();
  });

  it("skips (never throws) a grant whose owner scope does not match the event", async () => {
    const { tx } = makeTx(humanPromo);

    // Personal event by some other human — an ORG-owned tier's grant is
    // ineligible. A typed code here would throw promo_not_applicable.
    const result = await evaluatePromoApplications({
      codes: [],
      tx,
      event: makeEvent({ orgId: null, humanId: OTHER_HUMAN_ID }),
      buyerHumanId: BUYER_ID,
      now: NOW,
      orderSubtotalCents: 5000,
      ticketLines,
      memberGrants: [makeGrant()],
    });

    expect(result.applications).toEqual([]);
    expect(result.totalDiscountCents).toBe(0);
  });

  it("SECURITY: an ORG-owned tier's benefit never discounts another org's event", async () => {
    const { tx } = makeTx(humanPromo);

    const result = await evaluatePromoApplications({
      codes: [],
      tx,
      event: makeEvent({ orgId: OTHER_HUMAN_ID, humanId: null }),
      buyerHumanId: BUYER_ID,
      now: NOW,
      orderSubtotalCents: 5000,
      ticketLines,
      memberGrants: [makeGrant()],
    });

    expect(result.applications).toEqual([]);
  });

  it("SECURITY: a HUMAN-owned tier's benefit never discounts an ORG-owned event, even one carrying that human", async () => {
    // Payee precedence: orgId is who gets paid, so a human's entitlement must
    // not come out of the org's revenue. Same rule as PromoScope.HUMAN.
    const { tx } = makeTx(humanPromo);
    const grant = makeGrant({
      ownerScope: { kind: "HUMAN", humanId: SELLER_HUMAN_ID },
    });

    const personal = await evaluatePromoApplications({
      codes: [],
      tx,
      event: makeEvent({ orgId: null, humanId: SELLER_HUMAN_ID }),
      buyerHumanId: BUYER_ID,
      now: NOW,
      orderSubtotalCents: 5000,
      ticketLines,
      memberGrants: [grant],
    });
    expect(personal.applications).toHaveLength(1);

    const orgOwned = await evaluatePromoApplications({
      codes: [],
      tx,
      event: makeEvent({ orgId: ORG_ID, humanId: SELLER_HUMAN_ID }),
      buyerHumanId: BUYER_ID,
      now: NOW,
      orderSubtotalCents: 5000,
      ticketLines,
      memberGrants: [grant],
    });
    expect(orgOwned.applications).toEqual([]);
  });

  it("applies AT MOST ONE benefit per order — the best one for the buyer", async () => {
    const { tx } = makeTx(humanPromo);

    const result = await evaluatePromoApplications({
      codes: [],
      tx,
      event: makeEvent({ orgId: ORG_ID, humanId: null }),
      buyerHumanId: BUYER_ID,
      now: NOW,
      orderSubtotalCents: 5000,
      ticketLines,
      memberGrants: [
        makeGrant({ discountKind: "AMOUNT", discountValue: 500 }),
        makeGrant({
          benefitId: OTHER_BENEFIT_ID,
          tierId: OTHER_TIER_ID,
          discountKind: "PERCENT",
          discountValue: 20,
        }),
      ],
    });

    // 20% of $50 = $10 beats $5 off.
    expect(result.applications).toHaveLength(1);
    expect(result.totalDiscountCents).toBe(1000);
    expect(result.applications[0]).toMatchObject({
      kind: "membership",
      grant: { benefitId: OTHER_BENEFIT_ID },
    });
  });

  it("breaks a tie on the FIRST grant, so the choice is stable across checkouts", async () => {
    const { tx } = makeTx(humanPromo);

    const result = await evaluatePromoApplications({
      codes: [],
      tx,
      event: makeEvent({ orgId: ORG_ID, humanId: null }),
      buyerHumanId: BUYER_ID,
      now: NOW,
      orderSubtotalCents: 5000,
      ticketLines,
      memberGrants: [
        makeGrant({ discountValue: 500 }),
        makeGrant({ benefitId: OTHER_BENEFIT_ID, discountValue: 500 }),
      ],
    });

    expect(result.applications).toHaveLength(1);
    expect(result.applications[0]).toMatchObject({
      grant: { benefitId: BENEFIT_ID },
    });
  });

  it("logs the benefits it declined instead of dropping them silently", async () => {
    const { tx } = makeTx(humanPromo);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

    await evaluatePromoApplications({
      codes: [],
      tx,
      event: makeEvent({ orgId: ORG_ID, humanId: null }),
      buyerHumanId: BUYER_ID,
      now: NOW,
      orderSubtotalCents: 5000,
      ticketLines,
      memberGrants: [
        makeGrant({ discountValue: 500 }),
        makeGrant({ benefitId: OTHER_BENEFIT_ID, discountValue: 100 }),
      ],
      logger: logger as never,
    });

    expect(logger.info).toHaveBeenCalledWith(
      "checkout.member_benefit_skipped",
      expect.objectContaining({
        reason: "one_benefit_per_order",
        benefitIds: [OTHER_BENEFIT_ID],
      }),
    );
  });

  it("respects the clamp: maxDiscountCents caps a percentage grant", async () => {
    const { tx } = makeTx(humanPromo);

    const result = await evaluatePromoApplications({
      codes: [],
      tx,
      event: makeEvent({ orgId: ORG_ID, humanId: null }),
      buyerHumanId: BUYER_ID,
      now: NOW,
      orderSubtotalCents: 5000,
      ticketLines,
      memberGrants: [
        makeGrant({
          discountKind: "PERCENT",
          discountValue: 50,
          maxDiscountCents: 600,
        }),
      ],
    });

    expect(result.totalDiscountCents).toBe(600);
  });

  it("a 100% benefit cancels the whole subtotal (the free path's precondition)", async () => {
    const { tx } = makeTx(humanPromo);

    const result = await evaluatePromoApplications({
      codes: [],
      tx,
      event: makeEvent({ orgId: ORG_ID, humanId: null }),
      buyerHumanId: BUYER_ID,
      now: NOW,
      orderSubtotalCents: 5000,
      ticketLines,
      memberGrants: [makeGrant({ discountKind: "PERCENT", discountValue: 100 })],
    });

    expect(result.totalDiscountCents).toBe(5000);
  });

  it("a typed code keeps first claim on the subtotal; the grant takes only what is left", async () => {
    const typedStackable = {
      ...humanPromo,
      scope: "ORG" as const,
      scopeId: ORG_ID,
      kind: "PERCENT" as const,
      value: 90,
      stackable: true,
    };
    const { tx } = makeTx(typedStackable);

    const result = await evaluatePromoApplications({
      codes: [{ original: "SELLER10", normalized: "SELLER10" }],
      tx,
      event: makeEvent({ orgId: ORG_ID, humanId: null }),
      buyerHumanId: BUYER_ID,
      now: NOW,
      orderSubtotalCents: 5000,
      ticketLines,
      memberGrants: [makeGrant({ discountKind: "AMOUNT", discountValue: 5000 })],
    });

    // Typed 90% takes $45; the $50-off grant is clamped to the remaining $5.
    //
    // NOTE the consequence, pinned deliberately rather than left incidental:
    // the two together zero the subtotal, so createCheckout routes to
    // claimFreeTickets and `zeroFeesForFreeOrder` waives the PLATFORM fee too.
    // That is reachable only because the owner marked their own code
    // `stackable` — the same opt-in that already lets two of their codes
    // combine to 100%. A benefit carries no stackable flag of its own, so it
    // adds no new consent question; if that is ever judged too permissive, the
    // gate to change is `codesAllowStacking` in checkout-promos.ts.
    expect(result.totalDiscountCents).toBe(5000);
    expect(result.applications).toHaveLength(2);
    expect(result.applications[1]).toMatchObject({
      kind: "membership",
      discountCents: 500,
    });
  });

  it("steps aside when a NON-stackable typed code already applied", async () => {
    const typedNonStackable = {
      ...humanPromo,
      scope: "ORG" as const,
      scopeId: ORG_ID,
      stackable: false,
    };
    const { tx } = makeTx(typedNonStackable);

    const result = await evaluatePromoApplications({
      codes: [{ original: "SELLER10", normalized: "SELLER10" }],
      tx,
      event: makeEvent({ orgId: ORG_ID, humanId: null }),
      buyerHumanId: BUYER_ID,
      now: NOW,
      orderSubtotalCents: 5000,
      ticketLines,
      memberGrants: [makeGrant()],
    });

    // Only the typed promo applied; the grant stepped aside rather than
    // throwing promo_not_stackable at the buyer.
    expect(result.applications).toHaveLength(1);
    expect(result.applications[0]).toMatchObject({ kind: "code" });
    expect(result.totalDiscountCents).toBe(500);
  });
});

describe("evaluatePromoApplications — an AMOUNT benefit is per ORDER, not per ticket", () => {
  // Pinned because the break-even calculator's copy ("shows a member uses this
  // at") depends on it, and because an owner reading "$5 off" would otherwise
  // reasonably expect $5 × qty. `clampDiscount` applies AMOUNT once against the
  // SUMMED eligible lines.
  it("gives $5 off a 2-ticket order, not $10", async () => {
    const { tx } = makeTx(humanPromo);

    const result = await evaluatePromoApplications({
      codes: [],
      tx,
      event: makeEvent({ orgId: ORG_ID, humanId: null }),
      buyerHumanId: BUYER_ID,
      now: NOW,
      // ticketLines is a single 2×$25 line = $50 eligible.
      orderSubtotalCents: 5000,
      ticketLines,
      memberGrants: [makeGrant({ discountKind: "AMOUNT", discountValue: 500 })],
    });

    expect(result.totalDiscountCents).toBe(500);
  });

  it("a PERCENT benefit DOES scale with the order, since it is a share of it", async () => {
    const { tx } = makeTx(humanPromo);

    const result = await evaluatePromoApplications({
      codes: [],
      tx,
      event: makeEvent({ orgId: ORG_ID, humanId: null }),
      buyerHumanId: BUYER_ID,
      now: NOW,
      orderSubtotalCents: 5000,
      ticketLines,
      memberGrants: [makeGrant({ discountKind: "PERCENT", discountValue: 10 })],
    });

    expect(result.totalDiscountCents).toBe(500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Redemption caps are HOLD-AWARE (money audit 2026-09-08 #8).
//
// A PENDING hold is a promised slot. Before this change the pre-check counted
// confirmed redemptions only, so a one-per-human code passed on two events at
// once and a 10-cap flash code passed for everyone inside the hold window.
// The adapter's stats now fold live holds in — keyed on the caller's clock —
// and `createPromoHolds` hands that same clock to the lock re-check.
//
// The fake below is the smallest ledger that behaves like the real one: it
// records holds and counts the unexpired ones. It counts NOTHING unless `now`
// arrives, which is what makes the plumbing assertion load-bearing.
// ─────────────────────────────────────────────────────────────────────────────

import { createPromoHolds } from "../checkout-promos";
import type { CreatePromoHoldInput, PromoHoldRecord } from "@th/ports/repos/promos";

const ORDER_ONE = "99999999-9999-4999-8999-111111111111";
const ORDER_TWO = "99999999-9999-4999-8999-222222222222";

function makeHoldAwareTx(promo: typeof humanPromo) {
  const holds: PromoHoldRecord[] = [];
  const promos = {
    findActiveByCodes: vi.fn().mockResolvedValue([promo]),
    getRedemptionStats: vi.fn(
      async (params: { promoId: string; humanId?: string; now?: Date }) => {
        const live = params.now
          ? holds.filter(
              (h) =>
                h.promoId === params.promoId &&
                h.status === "PENDING" &&
                h.expiresAt > params.now!,
            )
          : [];
        return {
          totalRedemptions: live.length,
          redemptionsForHuman: live.filter((h) => h.humanId === params.humanId)
            .length,
        };
      },
    ),
    createHolds: vi.fn(
      async (inputs: CreatePromoHoldInput[], _params: { now: Date }) => {
        const created = inputs.map<PromoHoldRecord>((input, i) => ({
          id: `hold-${holds.length + i}`,
          promoId: input.promoId ?? null,
          membershipBenefitId: input.membershipBenefitId ?? null,
          orderId: input.orderId,
          humanId: input.humanId,
          idempotencyKey: input.idempotencyKey,
          code: input.code,
          amountDiscountCents: input.amountDiscountCents,
          status: "PENDING",
          expiresAt: input.expiresAt,
          createdAt: NOW,
          updatedAt: NOW,
        }));
        holds.push(...created);
        return created;
      },
    ),
  };
  return { promos, holds, tx: { promos } as unknown as TxRepos };
}

describe("evaluatePromoApplications — caps count LIVE HOLDS", () => {
  const perHumanOnce = {
    ...humanPromo,
    scope: "ORG" as const,
    scopeId: ORG_ID,
    maxRedemptionsPerHuman: 1,
  };
  const orgEvent = makeEvent({ orgId: ORG_ID, humanId: null });

  const evaluate = (tx: TxRepos) =>
    evaluatePromoApplications({
      codes: [{ original: "SELLER10", normalized: "SELLER10" }],
      tx,
      event: orgEvent,
      buyerHumanId: BUYER_ID,
      now: NOW,
      orderSubtotalCents: 5000,
      ticketLines,
    });

  it("passes the caller's clock to the stats read — the hold-aware key", async () => {
    const { tx, promos } = makeHoldAwareTx(perHumanOnce);

    await evaluate(tx);

    expect(promos.getRedemptionStats).toHaveBeenCalledWith({
      promoId: PROMO_ID,
      humanId: BUYER_ID,
      now: NOW,
    });
  });

  it("a second evaluation with one PENDING hold outstanding on a one-per-human code throws promo_redeemed_by_human", async () => {
    const { tx } = makeHoldAwareTx(perHumanOnce);

    // Checkout #1 (event A): evaluates clean, takes its hold.
    const first = await evaluate(tx);
    await createPromoHolds(tx.promos, first.applications, {
      orderId: ORDER_ONE,
      buyerHumanId: BUYER_ID,
      now: NOW,
    });

    // Checkout #2 (event B, same buyer, same code, hold still live): must be
    // told the code is spent — not quoted a price it will not get.
    await expect(evaluate(tx)).rejects.toMatchObject({
      code: "conflict",
      message: "promo_redeemed_by_human",
      promoCode: "SELLER10",
    });
  });

  it("the hold is created with the same clock, so the adapter's locked re-check and the pre-check agree", async () => {
    const { tx, promos } = makeHoldAwareTx(perHumanOnce);
    const result = await evaluate(tx);

    await createPromoHolds(tx.promos, result.applications, {
      orderId: ORDER_TWO,
      buyerHumanId: BUYER_ID,
      now: NOW,
    });

    expect(promos.createHolds).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          promoId: PROMO_ID,
          orderId: ORDER_TWO,
          humanId: BUYER_ID,
        }),
      ],
      { now: NOW },
    );
  });

  it("an EXPIRED hold frees the slot", async () => {
    const { tx, holds } = makeHoldAwareTx(perHumanOnce);
    holds.push({
      id: "stale",
      promoId: PROMO_ID,
      membershipBenefitId: null,
      orderId: ORDER_ONE,
      humanId: BUYER_ID,
      idempotencyKey: `order:${ORDER_ONE}:promo:${PROMO_ID}`,
      code: "SELLER10",
      amountDiscountCents: 500,
      status: "PENDING",
      expiresAt: new Date(NOW.getTime() - 1),
      createdAt: NOW,
      updatedAt: NOW,
    });

    const result = await evaluate(tx);
    expect(result.applications).toHaveLength(1);
  });

  it("a global cap counts another buyer's live hold", async () => {
    const flashOne = { ...perHumanOnce, maxRedemptionsPerHuman: undefined, maxRedemptions: 1 };
    const { tx, holds } = makeHoldAwareTx(flashOne);
    holds.push({
      id: "theirs",
      promoId: PROMO_ID,
      membershipBenefitId: null,
      orderId: ORDER_ONE,
      humanId: OTHER_HUMAN_ID,
      idempotencyKey: `order:${ORDER_ONE}:promo:${PROMO_ID}`,
      code: "SELLER10",
      amountDiscountCents: 500,
      status: "PENDING",
      expiresAt: new Date(NOW.getTime() + 60_000),
      createdAt: NOW,
      updatedAt: NOW,
    });

    await expect(evaluate(tx)).rejects.toMatchObject({
      code: "conflict",
      message: "promo_max_redeemed",
    });
  });
});
