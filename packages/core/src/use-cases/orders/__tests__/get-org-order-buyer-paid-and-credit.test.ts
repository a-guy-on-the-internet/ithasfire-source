import { describe, expect, it, vi } from "vitest";

import type { AuthZPort } from "@th/ports/authz";
import type { Repos } from "@th/ports/repos";

import { getOrgOrder } from "../get-org-order";

/**
 * The two figures the org Orders panel shows in place of the old "Total"
 * (which was `amountGrossCents`, the ticket money alone): what the buyer
 * paid, line by line, and what the sale credited the organiser side.
 *
 * Owner ruling 2026-10-11: the buyer pays the platform fee on top and the
 * organiser is credited the full ticket price (orders stamped
 * `organiserCredit: "FULL_PRICE"`); an order sold before it was credited
 * the price minus the fee and keeps that.
 */

const ACTOR_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_ID = "44444444-4444-4444-8444-444444444444";
const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const EVENT_ID = "22222222-2222-4222-8222-222222222222";
const BUYER_ID = "33333333-3333-4333-8333-333333333333";
const ITEM_ID = "99999999-9999-4999-8999-999999999999";
const TICKET_TYPE_ID = "55555555-5555-4555-8555-555555555555";

const INPUT = { actorHumanId: ACTOR_ID, orgId: ORG_ID, orderId: ORDER_ID };

/** The ticket item of the $15 card sale the demo order is (psql, 10-12). */
const CARD_TICKET_META = {
  buyerTotalCents: 1632,
  processorFeeShareCents: 82,
  platformFeePerTicketCents: 50,
  effectiveFeeMode: "PASS_THROUGH",
};

type Split = { payeeId: string; amountCents: number };

const PAYEE_ORG = "e0000000-0000-4000-8000-0000000000a1";
const PAYEE_PLACE = "e0000000-0000-4000-8000-0000000000a2";

/** The splits finalize writes for a credited order: one row per payee. */
function splitRows(rows: Split[]) {
  return rows.map((row, n) => ({
    id: `f0000000-0000-4000-8000-00000000000${n}`,
    orderId: ORDER_ID,
    orderSplitId: `f0000000-0000-4000-8000-00000000000${n}`,
    ...row,
  }));
}

function makeDeps(
  over: Record<string, unknown>,
  splits: Split[] = [{ payeeId: PAYEE_ORG, amountCents: 1500 }],
) {
  const order = {
    id: ORDER_ID,
    eventId: EVENT_ID,
    kind: "TICKETING",
    buyerHumanId: BUYER_ID,
    amountGrossCents: 1500,
    feesPlatformCents: 50,
    taxAmountCents: 159,
    currency: "usd",
    status: "SUCCEEDED",
    source: "PRIMARY",
    stripePaymentIntentId: "pi_test_123",
    stripeTaxCalculationId: null,
    paymentMethodType: "card",
    parentOrderId: null,
    feePolicySnapshot: {
      feeMode: "PASS_THROUGH",
      organiserCredit: "FULL_PRICE",
    },
    billingAddressLine1: null,
    occurredAt: new Date("2026-05-01T20:00:00.000Z"),
    paidOutAt: null,
    disputeStatus: null,
    paymentChannel: "WEB",
    items: [
      {
        id: ITEM_ID,
        kind: "ticket",
        ticketTypeId: TICKET_TYPE_ID,
        qty: 1,
        unitPriceCents: 1500,
        amountCents: 1500,
        meta: CARD_TICKET_META,
        paidOutAt: null,
        refundedAt: null,
        transferredAt: null,
        status: "active",
      },
    ],
    ...over,
  };
  const repos = {
    orders: { getById: vi.fn(async () => order) },
    events: {
      getById: vi.fn(async () => ({
        id: EVENT_ID,
        orgId: ORG_ID,
        title: "Door Night",
        startsAt: new Date("2026-05-01T19:00:00.000Z"),
        endsAt: new Date("2026-05-01T23:00:00.000Z"),
      })),
      listTicketTypes: vi.fn(async () => [{ id: TICKET_TYPE_ID, name: "GA" }]),
    },
    humans: {
      getByIdWithIdentity: vi.fn(async () => null),
      getByIds: vi.fn(async () => []),
    },
    promos: { listRedemptionsByOrderId: vi.fn(async () => []) },
    organizations: {
      getById: vi.fn(async () => ({ id: ORG_ID, name: "Drkmttr" })),
    },
    tickets: { listByOrderItemIds: vi.fn(async () => []) },
    earlyFraudWarnings: { findActiveForOrder: vi.fn(async () => null) },
    payeeLedger: { findCashSaleDebit: vi.fn(async () => null) },
    splits: { getForOrder: vi.fn(async () => splitRows(splits)) },
  } as unknown as Repos;
  const authz = {
    canFinanceOrg: vi.fn(async () => ({ allowed: true })),
  } as unknown as AuthZPort;
  return { repos, authz };
}

describe("getOrgOrder — what the buyer paid and what the event is credited", () => {
  it("a FULL_PRICE card sale: buyer paid 1791 in four lines, organiser credited the full 1500", async () => {
    const out = await getOrgOrder(makeDeps({}), INPUT);

    expect(out.buyerTotalCents).toBe(1791);
    expect(out.charges).toEqual({
      buyerFeeMode: "PASS_THROUGH",
      subtotalCents: 1500,
      platformFeeCents: 50,
      processingFeeCents: 82,
      taxCents: 159,
      creditCents: 0,
      totalCents: 1791,
    });
    // The lines add up to what the buyer paid.
    const c = out.charges;
    expect(
      c.subtotalCents +
        c.platformFeeCents +
        c.processingFeeCents +
        c.taxCents +
        c.creditCents,
    ).toBe(out.buyerTotalCents);
    expect(out.eventCredit).toEqual({
      ticketPriceCents: 1500,
      platformFeeTakenCents: 0,
      expectedCreditCents: 1500,
      creditState: "CREDITED",
      creditedCents: 1500,
      payeeCount: 1,
    });
    // The refund confirm's figure: the base every refund starts from.
    expect(out.refundBasePaidCents).toBe(1791);
    // The stored ticket money is unchanged and still exposed as itself.
    expect(out.amountGrossCents).toBe(1500);
  });

  it.each([
    ["a snapshot without the marker", { feeMode: "PASS_THROUGH" }],
    ["an empty snapshot", {}],
    ["no snapshot", null],
  ])(
    "an order sold before the 2026-10-11 ruling (%s) is credited price minus fee",
    async (_label, feePolicySnapshot) => {
      const out = await getOrgOrder(
        makeDeps({ feePolicySnapshot }, [
          { payeeId: PAYEE_ORG, amountCents: 1450 },
        ]),
        INPUT,
      );

      expect(out.eventCredit).toEqual({
        ticketPriceCents: 1500,
        platformFeeTakenCents: 50,
        expectedCreditCents: 1450,
        creditState: "CREDITED",
        creditedCents: 1450,
        payeeCount: 1,
      });
      const credit = out.eventCredit!;
      expect(credit.ticketPriceCents - credit.platformFeeTakenCents).toBe(
        credit.expectedCreditCents,
      );
      // What the buyer paid does not depend on the credit rule.
      expect(out.buyerTotalCents).toBe(1791);
    },
  );

  it("a door cash sale: buyer paid the cash the panel and refund name; no organiser credit", async () => {
    const out = await getOrgOrder(
      makeDeps({
        paymentChannel: "CASH",
        stripePaymentIntentId: null,
        paymentMethodType: null,
        feesPlatformCents: 0,
        feePolicySnapshot: {},
        items: [
          {
            id: ITEM_ID,
            kind: "ticket",
            ticketTypeId: TICKET_TYPE_ID,
            qty: 1,
            unitPriceCents: 1500,
            amountCents: 1500,
            meta: { platformFeePerTicketCents: 0, buyerTotalCents: 1500 },
            paidOutAt: null,
            refundedAt: null,
            transferredAt: null,
            status: "active",
          },
        ],
      }),
      INPUT,
    );

    expect(out.buyerTotalCents).toBe(1659);
    expect(out.buyerTotalCents).toBe(out.cashAmountPaidCents);
    expect(out.charges).toMatchObject({
      subtotalCents: 1500,
      platformFeeCents: 0,
      processingFeeCents: 0,
      taxCents: 159,
      totalCents: 1659,
    });
    // The organiser holds the cash; the sale credits nothing on the platform.
    expect(out.eventCredit).toBeNull();
  });

  it("a card sale at the door (POS) is credited like a web sale", async () => {
    const out = await getOrgOrder(makeDeps({ paymentChannel: "POS" }), INPUT);

    expect(out.eventCredit?.creditedCents).toBe(1500);
  });

  it.each(["REFUNDED", "PART_REFUNDED", "DISPUTED"])(
    "a %s order still shows the credit made at sale",
    async (status) => {
      const out = await getOrgOrder(makeDeps({ status }), INPUT);

      expect(out.eventCredit?.creditedCents).toBe(1500);
      expect(out.buyerTotalCents).toBe(1791);
    },
  );

  it.each(["PENDING", "PROCESSING", "CANCELLED"])(
    "a %s order took no money, so it credited no one",
    async (status) => {
      const out = await getOrgOrder(makeDeps({ status }), INPUT);

      expect(out.eventCredit).toBeNull();
    },
  );

  it("a resale order has no organiser credit by this rule (resale terms share the markup)", async () => {
    const out = await getOrgOrder(makeDeps({ source: "RESALE" }), INPUT);

    expect(out.eventCredit).toBeNull();
    expect(out.buyerTotalCents).toBe(1791);
  });

  it("a comp credits no one and the buyer paid nothing", async () => {
    const out = await getOrgOrder(
      makeDeps({
        source: "COMP",
        stripePaymentIntentId: null,
        amountGrossCents: 0,
        feesPlatformCents: 0,
        taxAmountCents: 0,
        feePolicySnapshot: {},
        items: [
          {
            id: ITEM_ID,
            kind: "ticket",
            ticketTypeId: TICKET_TYPE_ID,
            qty: 1,
            unitPriceCents: 0,
            amountCents: 0,
            meta: {},
            paidOutAt: null,
            refundedAt: null,
            transferredAt: null,
            status: "active",
          },
        ],
      }),
      INPUT,
    );

    expect(out.eventCredit).toBeNull();
    expect(out.buyerTotalCents).toBe(0);
  });

  it("the credited figure is the ledger's: the splits of a 70/30 deal sum to the basis, two payees", async () => {
    const deps = makeDeps({}, [
      { payeeId: PAYEE_PLACE, amountCents: 1050 },
      { payeeId: PAYEE_ORG, amountCents: 450 },
    ]);
    const out = await getOrgOrder(deps, INPUT);

    expect(deps.repos.splits.getForOrder).toHaveBeenCalledWith(ORDER_ID);
    expect(out.eventCredit).toMatchObject({
      expectedCreditCents: 1500,
      creditedCents: 1500,
      payeeCount: 2,
    });
  });

  it("no split written yet: NOT_YET, credited is null, the rule's figure stays as the expected credit", async () => {
    const out = await getOrgOrder(makeDeps({}, []), INPUT);

    expect(out.eventCredit).toMatchObject({
      expectedCreditCents: 1500,
      creditState: "NOT_YET",
      creditedCents: null,
      payeeCount: 0,
    });
  });

  it("a free order (claimFreeTickets: PRIMARY, SUCCEEDED, $0, no splits) is credited $0, not pending", async () => {
    const out = await getOrgOrder(
      makeDeps(
        {
          stripePaymentIntentId: null,
          paymentMethodType: null,
          amountGrossCents: 0,
          feesPlatformCents: 0,
          taxAmountCents: 0,
          items: [
            {
              id: ITEM_ID,
              kind: "ticket",
              ticketTypeId: TICKET_TYPE_ID,
              qty: 1,
              unitPriceCents: 0,
              amountCents: 0,
              meta: {},
              paidOutAt: null,
              refundedAt: null,
              transferredAt: null,
              status: "active",
            },
          ],
        },
        [],
      ),
      INPUT,
    );

    expect(out.buyerTotalCents).toBe(0);
    expect(out.eventCredit).toEqual({
      ticketPriceCents: 0,
      platformFeeTakenCents: 0,
      expectedCreditCents: 0,
      creditState: "CREDITED",
      creditedCents: 0,
      payeeCount: 0,
    });
  });

  it("a failed split read still returns the order, marks the credit UNAVAILABLE, and reports", async () => {
    const deps = makeDeps({});
    const err = new Error("splits read failed");
    vi.mocked(deps.repos.splits.getForOrder).mockRejectedValueOnce(err);
    const reportError = vi.fn();
    const logger = { error: vi.fn(), child: () => logger };

    const out = await getOrgOrder(
      { ...deps, reportError, logger } as unknown as Parameters<
        typeof getOrgOrder
      >[0],
      INPUT,
    );

    expect(out.id).toBe(ORDER_ID);
    expect(out.buyerTotalCents).toBe(1791);
    expect(out.eventCredit).toEqual({
      ticketPriceCents: 1500,
      platformFeeTakenCents: 0,
      expectedCreditCents: 1500,
      creditState: "UNAVAILABLE",
      creditedCents: null,
      payeeCount: 0,
    });
    expect(reportError).toHaveBeenCalledWith(err, {
      tags: { useCase: "getOrgOrder", source: "splits" },
      extra: { orderId: ORDER_ID },
    });
    expect(logger.error).toHaveBeenCalledWith(
      "get_org_order.splits_lookup_failed",
      expect.objectContaining({ orderId: ORDER_ID, err }),
    );
  });

  it("a throwing reporter does not change the failed-read outcome", async () => {
    const deps = makeDeps({});
    vi.mocked(deps.repos.splits.getForOrder).mockImplementationOnce(() => {
      throw new Error("sync throw");
    });
    const reportError = vi.fn(() => {
      throw new Error("reporter down");
    });

    const out = await getOrgOrder({ ...deps, reportError }, INPUT);

    expect(reportError).toHaveBeenCalledTimes(1);
    expect(out.eventCredit?.creditState).toBe("UNAVAILABLE");
  });

  it("does not read splits where the event is not credited by the rule", async () => {
    const deps = makeDeps({ source: "RESALE" });
    await getOrgOrder(deps, INPUT);

    expect(deps.repos.splits.getForOrder).not.toHaveBeenCalled();
  });

  it("a legacy cash sale whose breakdown leaves out the fee: buyer paid is the cash handed over, no lines", async () => {
    // No per-item buyer totals, no PaymentIntent, recorded ABSORB: the
    // breakdown totals gross + tax (1659) while the cash refund hands back
    // gross + fee + tax (1709). The panel must show one figure, the cash.
    const out = await getOrgOrder(
      makeDeps({
        paymentChannel: "CASH",
        stripePaymentIntentId: null,
        paymentMethodType: null,
        feesPlatformCents: 50,
        feePolicySnapshot: { feeMode: "ABSORB" },
        items: [
          {
            id: ITEM_ID,
            kind: "ticket",
            ticketTypeId: TICKET_TYPE_ID,
            qty: 1,
            unitPriceCents: 1500,
            amountCents: 1500,
            meta: {},
            paidOutAt: null,
            refundedAt: null,
            transferredAt: null,
            status: "active",
          },
        ],
      }),
      INPUT,
    );

    expect(out.cashAmountPaidCents).toBe(1709);
    expect(out.buyerTotalCents).toBe(1709);
    expect(out.charges).toBeNull();
    expect(out.eventCredit).toBeNull();
  });

  it.each([
    ["PENDING", "NOT_CHARGED"],
    ["CANCELLED", "NOT_CHARGED"],
    ["PROCESSING", "PROCESSING"],
    ["SUCCEEDED", "PAID"],
    ["REFUNDED", "PAID"],
    ["PART_REFUNDED", "PAID"],
    ["DISPUTED", "PAID"],
  ] as const)(
    "a %s order: chargeState %s, buyerPaid only when PAID",
    async (status, chargeState) => {
      const out = await getOrgOrder(makeDeps({ status }), INPUT);

      expect(out.chargeState).toBe(chargeState);
      expect(out.buyerPaid).toBe(chargeState === "PAID");
      // The lines still say what the order costs, paid or not.
      expect(out.buyerTotalCents).toBe(1791);
    },
  );
});
