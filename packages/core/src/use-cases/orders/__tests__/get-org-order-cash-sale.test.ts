import { describe, expect, it, vi } from "vitest";

import type { AuthZPort } from "@th/ports/authz";

import { cashSaleDebitKey } from "../../pos/_shared/cash-sale-ledger";
import {
  ACTOR_ID,
  EVENT_ID,
  ORG_ID,
  PAYEE_ID,
  PRICED,
  makeCashWorld,
} from "../../pos/__tests__/cash-refund-world";
import { orgRefundCashSale } from "../../pos/org-refund-cash-sale";
import { getOrgOrder } from "../get-org-order";

/**
 * The cash-sale figures `getOrgOrder` hands the web Orders panel: what the
 * buyer handed over (what a refund gives back), comp vs free-with-a-code,
 * and the CASH_SALE_DEBIT a refund reverses. All computed on the server so
 * the panel never re-derives money.
 *
 * DRIFT GUARD: every cash fixture is read with `getOrgOrder` and then
 * refunded with `orgRefundCashSale` on the same world. The amount the panel
 * shows must be the amount the refund returns, and the debit it shows must
 * be the debit the refund reverses. If either side changes its formula,
 * this fails.
 */

const TICKET_TYPE_ID = "c0000000-0000-4000-8000-0000000000d1";

const TAX_ONLY_ID = "c0000000-0000-4000-8000-00000000a001";
const PRE_RULING_ID = "c0000000-0000-4000-8000-00000000a002";
const PROMO_ID = "c0000000-0000-4000-8000-00000000a003";
const FREE_CODE_ID = "c0000000-0000-4000-8000-00000000a004";
const COMP_ID = "c0000000-0000-4000-8000-00000000a005";
const ZERO_PAID_ID = "c0000000-0000-4000-8000-00000000a006";
const ZERO_TAX_ID = "c0000000-0000-4000-8000-00000000a007";
const LEGACY_ID = "c0000000-0000-4000-8000-00000000a008";
const WEB_ID = "c0000000-0000-4000-8000-00000000a009";
const PROMO_CODE_ROW_ID = "c0000000-0000-4000-8000-00000000c001";

type Redemption = { code: string; amountDiscountCents: number };

/**
 * The cash world, plus the reads `getOrgOrder` makes that the refund does
 * not, and promo redemptions keyed by order.
 */
function makeWorld() {
  const w = makeCashWorld();
  const redemptions = new Map<string, Redemption[]>();
  const repos = w.repos as unknown as Record<string, Record<string, unknown>>;
  Object.assign(repos.events!, {
    listTicketTypes: vi.fn(async () => [{ id: TICKET_TYPE_ID, name: "GA" }]),
  });
  Object.assign(repos.promos!, {
    listRedemptionsByOrderId: vi.fn(async (orderId: string) =>
      (redemptions.get(orderId) ?? []).map((r, n) => ({
        id: `${PROMO_CODE_ROW_ID.slice(0, -1)}${n}`,
        promoId: PROMO_CODE_ROW_ID,
        membershipBenefitId: null,
        orderId,
        humanId: ACTOR_ID,
        code: r.code,
        amountDiscountCents: r.amountDiscountCents,
        redeemedAt: new Date(),
      })),
    ),
  });
  Object.assign(repos.tickets!, {
    listByOrderItemIds: vi.fn(async () => []),
  });
  Object.assign(repos, {
    humans: {
      getByIdWithIdentity: vi.fn(async () => null),
      getByIds: vi.fn(async () => []),
    },
    organizations: {
      getById: vi.fn(async () => ({ id: ORG_ID, name: "Drkmttr" })),
    },
    earlyFraudWarnings: { findActiveForOrder: vi.fn(async () => null) },
  });
  const authz = {
    ...w.authz,
    canFinanceOrg: vi.fn(async () => ({ allowed: true })),
  } as unknown as AuthZPort;
  const findCashSaleDebit = vi.spyOn(w.ledger.repo, "findCashSaleDebit");
  return { w, redemptions, authz, findCashSaleDebit };
}

type World = ReturnType<typeof makeWorld>;

function item(
  orderId: string,
  n: number,
  kind: "ticket" | "discount",
  amountCents: number,
  meta: Record<string, unknown>,
) {
  return {
    id: `d0000000-0000-4000-8000-${orderId.slice(-4)}${n
      .toString(16)
      .padStart(8, "0")}`,
    orderId,
    kind,
    ticketTypeId: kind === "ticket" ? TICKET_TYPE_ID : null,
    qty: 1,
    unitPriceCents: amountCents,
    amountCents,
    meta,
    paidOutAt: null,
    refundedAt: null,
    transferredAt: null,
    resaleListingId: null,
    status: "active",
  };
}

/**
 * A priced cash sale as `recordCashSale` writes it since the owner ruling
 * of 2026-10-08: each ticket's `buyerTotalCents` is its face, no platform
 * fee, promo `discount` items after the tickets, and a CASH_SALE_DEBIT for
 * the tax when there is tax.
 */
async function addCashSale(
  world: World,
  id: string,
  opts: {
    faces: number[];
    discounts?: Array<{ code: string; cents: number }>;
    taxCents: number;
  },
) {
  const { w, redemptions } = world;
  const discounts = opts.discounts ?? [];
  const faceTotal = opts.faces.reduce((a, b) => a + b, 0);
  const discountTotal = discounts.reduce((a, d) => a + d.cents, 0);
  const items = [
    ...opts.faces.map((face, n) =>
      item(id, n, "ticket", face, {
        platformFeePerTicketCents: 0,
        buyerTotalCents: face,
        buyerUnitTotalCents: face,
      }),
    ),
    ...discounts.map((d, n) =>
      item(id, opts.faces.length + n, "discount", -d.cents, {
        code: d.code,
        normalizedCode: d.code,
      }),
    ),
  ];
  w.orders.set(id, {
    id,
    eventId: EVENT_ID,
    buyerHumanId: `b0000000-0000-4000-8000-${id.slice(-4)}00000000`,
    currency: "usd",
    feePolicySnapshot: {},
    status: "SUCCEEDED",
    stripePaymentIntentId: null,
    source: "PRIMARY",
    nonRefundable: false,
    occurredAt: w.event.startsAt,
    paymentMethodType: null,
    paymentChannel: "CASH",
    paidOutAt: null,
    parentOrderId: null,
    amountGrossCents: faceTotal - discountTotal,
    feesPlatformCents: 0,
    taxAmountCents: opts.taxCents,
    items,
  });
  w.tickets.set(
    id,
    opts.faces.map((_, n) => ({
      id: `e0000000-0000-4000-8000-${id.slice(-4)}${n
        .toString(16)
        .padStart(8, "0")}`,
      orderId: id,
      status: "SCANNED",
      seatId: null,
    })),
  );
  if (discounts.length > 0) {
    redemptions.set(
      id,
      discounts.map((d) => ({ code: d.code, amountDiscountCents: d.cents })),
    );
  }
  if (opts.taxCents > 0) {
    await w.ledger.repo.cashSaleDebit({
      idempotencyKey: cashSaleDebitKey(id),
      payeeId: PAYEE_ID,
      amountCents: opts.taxCents,
      currency: "usd",
      orderId: id,
      description: `Door cash sale — order ${id}`,
      sourceKind: "pos_cash_sale",
      sourceId: id,
    });
  }
}

function read(world: World, orderId: string) {
  return getOrgOrder(
    { repos: world.w.repos, authz: world.authz },
    { actorHumanId: ACTOR_ID, orgId: ORG_ID, orderId },
  );
}

function refund(world: World, orderId: string) {
  return orgRefundCashSale(
    { repos: world.w.repos, authz: world.authz, clock: world.w.clock },
    { actorHumanId: ACTOR_ID, orgId: ORG_ID, orderId },
  );
}

type Case = {
  name: string;
  id: string;
  setup: (world: World) => Promise<unknown> | unknown;
  expected: {
    cashAmountPaidCents: number;
    isComp: boolean;
    isFreeWithCode: boolean;
    cashSaleDebitCents: number;
  };
};

const CASES: Case[] = [
  {
    // Since 2026-10-08: 2 × $25 face, no fee, 9.75% tax = 488.
    name: "a tax-only cash sale",
    id: TAX_ONLY_ID,
    setup: (world) =>
      addCashSale(world, TAX_ONLY_ID, { faces: [2500, 2500], taxCents: 488 }),
    expected: {
      cashAmountPaidCents: 5488,
      isComp: false,
      isFreeWithCode: false,
      cashSaleDebitCents: 488,
    },
  },
  {
    // Before 2026-10-08: face + platform fee per ticket, debit = fee + tax.
    name: "a pre-ruling fee + tax cash sale",
    id: PRE_RULING_ID,
    setup: (world) => world.w.addPricedCashOrder(PRE_RULING_ID),
    expected: {
      cashAmountPaidCents: PRICED.totalCents,
      isComp: false,
      isFreeWithCode: false,
      cashSaleDebitCents: PRICED.debitCents,
    },
  },
  {
    // 2 × $25 − $10 code = $40, tax 9.75% of the discounted face = 390.
    name: "a promo-discounted cash sale",
    id: PROMO_ID,
    setup: (world) =>
      addCashSale(world, PROMO_ID, {
        faces: [2500, 2500],
        discounts: [{ code: "TENOFF", cents: 1000 }],
        taxCents: 390,
      }),
    expected: {
      cashAmountPaidCents: 4390,
      isComp: false,
      isFreeWithCode: false,
      cashSaleDebitCents: 390,
    },
  },
  {
    // A 100%-off code: a $0 SALE, never a comp (owner ruling).
    name: "a $0 sale made free by a code",
    id: FREE_CODE_ID,
    setup: (world) =>
      addCashSale(world, FREE_CODE_ID, {
        faces: [2500],
        discounts: [{ code: "FREEALL", cents: 2500 }],
        taxCents: 0,
      }),
    expected: {
      cashAmountPaidCents: 0,
      isComp: false,
      isFreeWithCode: true,
      cashSaleDebitCents: 0,
    },
  },
  {
    // The Comp button: `meta.comp: true` on the ticket item.
    name: "an explicit comp",
    id: COMP_ID,
    setup: (world) => world.w.addCompCashOrder(COMP_ID),
    expected: {
      cashAmountPaidCents: 0,
      isComp: true,
      isFreeWithCode: false,
      cashSaleDebitCents: 0,
    },
  },
  {
    // A free tier sold with `comp: false` and no code: a paid sale of $0.
    name: "a $0 comp:false sale with no code",
    id: ZERO_PAID_ID,
    setup: (world) =>
      addCashSale(world, ZERO_PAID_ID, { faces: [0], taxCents: 0 }),
    expected: {
      cashAmountPaidCents: 0,
      isComp: false,
      isFreeWithCode: false,
      cashSaleDebitCents: 0,
    },
  },
  {
    name: "a 0%-tax cash sale",
    id: ZERO_TAX_ID,
    setup: (world) =>
      addCashSale(world, ZERO_TAX_ID, { faces: [2500], taxCents: 0 }),
    expected: {
      cashAmountPaidCents: 2500,
      isComp: false,
      isFreeWithCode: false,
      cashSaleDebitCents: 0,
    },
  },
  {
    // Recorded before the door was priced: the operator's typed gross.
    name: "a cash order recorded before the door was priced",
    id: LEGACY_ID,
    setup: (world) => world.w.addLegacyCashOrder(LEGACY_ID, 2000),
    expected: {
      cashAmountPaidCents: 2000,
      isComp: false,
      isFreeWithCode: false,
      cashSaleDebitCents: 0,
    },
  },
];

describe("getOrgOrder — server-computed cash-sale figures", () => {
  it.each(CASES)("$name", async ({ id, setup, expected }) => {
    const world = makeWorld();
    await setup(world);

    const out = await read(world, id);

    expect(out.paymentChannel).toBe("CASH");
    expect({
      cashAmountPaidCents: out.cashAmountPaidCents,
      isComp: out.isComp,
      isFreeWithCode: out.isFreeWithCode,
      cashSaleDebitCents: out.cashSaleDebitCents,
    }).toEqual(expected);
    expect(world.findCashSaleDebit).toHaveBeenCalledWith(cashSaleDebitKey(id));
  });

  it.each(CASES)(
    "drift guard, $name: the panel's figures are what orgRefundCashSale returns and reverses",
    async ({ id, setup }) => {
      const world = makeWorld();
      await setup(world);

      const before = await read(world, id);
      const refunded = await refund(world, id);

      expect(refunded.alreadyRefunded).toBe(false);
      expect(before.cashAmountPaidCents).toBe(refunded.amountReturnedCents);
      expect(before.cashSaleDebitCents).toBe(
        refunded.feeAndTaxNoLongerOwedCents,
      );
    },
  );

  it("after a refund the debit still reads at its recorded amount, and the paid amount is unchanged", async () => {
    const world = makeWorld();
    await addCashSale(world, TAX_ONLY_ID, {
      faces: [2500, 2500],
      taxCents: 488,
    });
    await refund(world, TAX_ONLY_ID);

    const after = await read(world, TAX_ONLY_ID);

    expect(after.status).toBe("REFUNDED");
    expect(after.cashAmountPaidCents).toBe(5488);
    expect(after.cashSaleDebitCents).toBe(488);
  });

  it("a WEB order carries no cash figures and reads no ledger row", async () => {
    const world = makeWorld();
    await world.w.addCardOrder(WEB_ID);

    const out = await read(world, WEB_ID);

    expect(out.paymentChannel).toBe("WEB");
    expect(out).toMatchObject({
      cashAmountPaidCents: null,
      isComp: null,
      isFreeWithCode: null,
      cashSaleDebitCents: null,
    });
    expect(world.findCashSaleDebit).not.toHaveBeenCalled();
  });

  it("a ledger read failure fails the read, never a guessed 0", async () => {
    const world = makeWorld();
    await addCashSale(world, TAX_ONLY_ID, {
      faces: [2500, 2500],
      taxCents: 488,
    });
    world.findCashSaleDebit.mockRejectedValueOnce(new Error("db down"));

    await expect(read(world, TAX_ONLY_ID)).rejects.toMatchObject({
      code: "dependency_failed",
      message: "repos.payeeLedger.findCashSaleDebit",
    });
  });
});
