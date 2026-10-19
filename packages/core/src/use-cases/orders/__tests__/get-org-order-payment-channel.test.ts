import { describe, expect, it, vi } from "vitest";

import type { AuthZPort } from "@th/ports/authz";
import type { Repos } from "@th/ports/repos";

import { getOrgOrder } from "../get-org-order";

const ACTOR_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_ID = "44444444-4444-4444-8444-444444444444";
const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const EVENT_ID = "22222222-2222-4222-8222-222222222222";
const BUYER_ID = "33333333-3333-4333-8333-333333333333";
const PROMO_A = "55555555-5555-4555-8555-555555555555";
const PROMO_B = "66666666-6666-4666-8666-666666666666";
const BENEFIT = "77777777-7777-4777-8777-777777777777";

const STARTS_AT = new Date("2026-05-01T19:00:00.000Z");
const ENDS_AT = new Date("2026-05-01T23:00:00.000Z");

function redemption(over: Record<string, unknown>) {
  return {
    id: "88888888-8888-4888-8888-888888888888",
    promoId: null,
    membershipBenefitId: null,
    orderId: ORDER_ID,
    humanId: BUYER_ID,
    code: "X",
    amountDiscountCents: 0,
    redeemedAt: new Date("2026-05-01T20:00:00.000Z"),
    ...over,
  };
}

function makeDeps(opts: {
  paymentChannel?: "WEB" | "POS" | "CASH";
  endsAt?: Date | null;
  redemptions?: unknown[];
  orgId?: string;
}) {
  const order = {
    id: ORDER_ID,
    eventId: EVENT_ID,
    kind: "TICKETING",
    buyerHumanId: BUYER_ID,
    amountGrossCents: 0,
    feesPlatformCents: 0,
    taxAmountCents: 0,
    currency: "usd",
    status: "SUCCEEDED",
    source: "PRIMARY",
    stripePaymentIntentId: null,
    stripeTaxCalculationId: null,
    paymentMethodType: null,
    parentOrderId: null,
    feePolicySnapshot: {},
    billingAddressLine1: null,
    occurredAt: new Date("2026-05-01T20:00:00.000Z"),
    paidOutAt: null,
    disputeStatus: null,
    ...(opts.paymentChannel ? { paymentChannel: opts.paymentChannel } : {}),
    items: [],
  };
  const repos = {
    orders: { getById: vi.fn(async () => order) },
    events: {
      getById: vi.fn(async () => ({
        id: EVENT_ID,
        orgId: opts.orgId ?? ORG_ID,
        title: "Door Night",
        startsAt: STARTS_AT,
        endsAt: opts.endsAt === undefined ? ENDS_AT : opts.endsAt,
      })),
      listTicketTypes: vi.fn(async () => []),
    },
    humans: {
      getByIdWithIdentity: vi.fn(async () => null),
      getByIds: vi.fn(async () => []),
    },
    promos: {
      listRedemptionsByOrderId: vi.fn(async () => opts.redemptions ?? []),
    },
    organizations: {
      getById: vi.fn(async () => ({ id: ORG_ID, name: "Drkmttr" })),
    },
    tickets: { listByOrderItemIds: vi.fn(async () => []) },
    earlyFraudWarnings: { findActiveForOrder: vi.fn(async () => null) },
    // The event credit's ledger read (OrderSplit rows); none written here.
    splits: { getForOrder: vi.fn(async () => []) },
    payeeLedger: { findCashSaleDebit: vi.fn(async () => null) },
  } as unknown as Repos;
  const authz = {
    canFinanceOrg: vi.fn(async () => ({ allowed: true })),
  } as unknown as AuthZPort;
  return { repos, authz };
}

const INPUT = { actorHumanId: ACTOR_ID, orgId: ORG_ID, orderId: ORDER_ID };

describe("getOrgOrder — payment channel, cash refund window, promo codes", () => {
  it("a cash door sale carries CASH and the window: event end + 7 days", async () => {
    const out = await getOrgOrder(makeDeps({ paymentChannel: "CASH" }), INPUT);

    expect(out.paymentChannel).toBe("CASH");
    expect(out.cashRefundableUntil?.toISOString()).toBe(
      "2026-05-08T23:00:00.000Z",
    );
  });

  it("an event with no end runs the window from its start", async () => {
    const out = await getOrgOrder(
      makeDeps({ paymentChannel: "CASH", endsAt: null }),
      INPUT,
    );

    expect(out.cashRefundableUntil?.toISOString()).toBe(
      "2026-05-08T19:00:00.000Z",
    );
  });

  it.each(["WEB", "POS"] as const)(
    "a %s order has no cash refund window",
    async (channel) => {
      const out = await getOrgOrder(makeDeps({ paymentChannel: channel }), INPUT);

      expect(out.paymentChannel).toBe(channel);
      expect(out.cashRefundableUntil).toBeNull();
      expect(out).toMatchObject({
        cashAmountPaidCents: null,
        isComp: null,
        isFreeWithCode: null,
        cashSaleDebitCents: null,
      });
    },
  );

  it("a row without the column reads as WEB", async () => {
    const out = await getOrgOrder(makeDeps({}), INPUT);

    expect(out.paymentChannel).toBe("WEB");
    expect(out.cashRefundableUntil).toBeNull();
  });

  it("lists every typed promo code in redemption order, never a membership marker", async () => {
    const out = await getOrgOrder(
      makeDeps({
        paymentChannel: "CASH",
        redemptions: [
          redemption({ membershipBenefitId: BENEFIT, code: `benefit:${BENEFIT}` }),
          redemption({ promoId: PROMO_A, code: "FREEALL", amountDiscountCents: 3000 }),
          redemption({ promoId: PROMO_B, code: "STACK5", amountDiscountCents: 500 }),
        ],
      }),
      INPUT,
    );

    expect(out.promoCodes).toEqual(["FREEALL", "STACK5"]);
    // The single `promo` summary is unchanged: the first typed code.
    expect(out.promo).toEqual({
      source: "code",
      code: "FREEALL",
      amountDiscountCents: 3000,
    });
  });

  it("no redemptions → no codes", async () => {
    const out = await getOrgOrder(makeDeps({ paymentChannel: "CASH" }), INPUT);

    expect(out.promoCodes).toEqual([]);
  });

  it("another org's order still answers ORDER_NOT_IN_ORG, before any of this", async () => {
    await expect(
      getOrgOrder(
        makeDeps({
          paymentChannel: "CASH",
          orgId: "99999999-9999-4999-8999-999999999999",
        }),
        INPUT,
      ),
    ).rejects.toMatchObject({ code: "ORDER_NOT_IN_ORG" });
  });

  it("another org's order reads no ledger row", async () => {
    const deps = makeDeps({
      paymentChannel: "CASH",
      orgId: "99999999-9999-4999-8999-999999999999",
    });
    await expect(getOrgOrder(deps, INPUT)).rejects.toMatchObject({
      code: "ORDER_NOT_IN_ORG",
    });
    expect(deps.repos.payeeLedger.findCashSaleDebit).not.toHaveBeenCalled();
  });

  it("a refused actor reads no ledger row", async () => {
    const deps = makeDeps({ paymentChannel: "CASH" });
    (deps.authz.canFinanceOrg as ReturnType<typeof vi.fn>).mockResolvedValue({
      allowed: false,
    });
    await expect(getOrgOrder(deps, INPUT)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(deps.repos.payeeLedger.findCashSaleDebit).not.toHaveBeenCalled();
  });
});
