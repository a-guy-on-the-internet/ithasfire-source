import { describe, expect, it } from "vitest";

import type { OrderItemRecord } from "@th/ports/repos/order-items";

import { computeItemBuyerPaid } from "../../../lib/orders/compute-expected-payment-amount";
import {
  isItemDiscountedToZero,
  refundFaceWeightCents,
  refundWeightCents,
} from "../../../lib/orders/refund-weight";
import {
  ticketsDiscountedToZero,
  type TicketDiscount,
} from "../../../lib/orders/discounted-to-zero";
import { buildNoChargeRefundId } from "../_shared/no-charge-refund";
import { allocateRefundPlatformFeeShares } from "../_shared/refund-platform-fee-share";
import { allocateRefundTaxSharesForOrder } from "../_shared/refund-tax-shares-for-order";
import { allocateFullRefundShares } from "../refund-full-order";

// Owner ruling 2026-10-11: "yeah it should refund 0 because that's what it
// cost. Otherwise we will get taken advantage of".

const item = (
  id: string,
  amountCents: number,
  meta: Record<string, unknown>,
  kind = "ticket",
): OrderItemRecord =>
  ({
    id,
    orderId: "order-1",
    kind,
    ticketTypeId: kind === "ticket" ? "tt" : null,
    qty: 1,
    unitPriceCents: amountCents,
    amountCents,
    meta,
    paidOutAt: null,
    refundedAt: null,
    transferredAt: null,
    status: "active",
  }) as OrderItemRecord;

/** The shape of dev order f425308e. Charged 5245 + 444 tax = 5689. */
const vip = item("vip", 12_500, {
  buyerTotalCents: 12_500,
  discountedToZero: true,
  platformFeePerTicketCents: 0,
  processorFeeShareCents: 0,
});
const ga = item("ga", 5_000, {
  buyerTotalCents: 5_245,
  platformFeePerTicketCents: 50,
  processorFeeShareCents: 195,
});
const discount = item("discount", -12_500, {}, "discount");
const order = {
  id: "order-1",
  amountGrossCents: 5_000,
  feesPlatformCents: 50,
  taxAmountCents: 444,
  items: [discount, vip, ga],
};

describe("refundWeightCents / refundFaceWeightCents", () => {
  it("weigh a ticket a discount brought down to $0 at 0", () => {
    expect(isItemDiscountedToZero(vip)).toBe(true);
    expect(refundWeightCents(vip)).toBe(0);
    expect(refundFaceWeightCents(vip)).toBe(0);
  });

  it("weigh every other ticket as before: buyer-paid, and face", () => {
    expect(isItemDiscountedToZero(ga)).toBe(false);
    expect(refundWeightCents(ga)).toBe(computeItemBuyerPaid(ga));
    expect(refundWeightCents(ga)).toBe(5_245);
    expect(refundFaceWeightCents(ga)).toBe(5_000);
  });

  it("weigh a ticket PRICED at $0 at 0 with no mark", () => {
    const free = item("free", 0, { buyerTotalCents: 0 });
    expect(isItemDiscountedToZero(free)).toBe(false);
    expect(refundWeightCents(free)).toBe(0);
    expect(refundFaceWeightCents(free)).toBe(0);
  });

  it("read only an explicit `true`: an order priced before 2026-10-10 keeps the old weight", () => {
    for (const meta of [
      { buyerTotalCents: 12_500 },
      { buyerTotalCents: 12_500, discountedToZero: "true" },
      { buyerTotalCents: 12_500, discountedToZero: false },
    ]) {
      expect(refundWeightCents(item("old", 12_500, meta))).toBe(12_500);
    }
    expect(refundWeightCents({ amountCents: 700, meta: null })).toBe(700);
  });
});

describe("allocateFullRefundShares: a ticket a discount brought down to $0", () => {
  it("pays the freed ticket nothing and the paid ticket charge − fee", () => {
    const shares = allocateFullRefundShares([vip, ga], 5_689, 195);

    // Pre-fix: vip 4007 − 137 = 3870, ga 1682 − 58 = 1624.
    expect(shares.netRefundCentsForItem("vip")).toBe(0);
    expect(shares.netRefundCentsForItem("ga")).toBe(5_494);
    expect(shares.buyerPaidByItem.get("vip") ?? 0).toBe(0);
    expect(shares.stripeFeeByItem.get("vip") ?? 0).toBe(0);
    expect(
      shares.netRefundCentsForItem("vip") + shares.netRefundCentsForItem("ga"),
    ).toBe(5_689 - 195);
  });

  it("is the same on the per-line tax path (`perLinePaidByItem`)", () => {
    // Two PLATFORM lines summing to the order's tax: sales on the buyer
    // total, entertainment on the ticket face.
    const perLineOrder = { ...order, taxAmountCents: 594 };
    const { taxByItem, perLinePaidByItem } = allocateRefundTaxSharesForOrder({
      useCase: "test",
      order: perLineOrder,
      ticketItems: [vip, ga],
      taxLines: [
        { code: "SALES", base: "BUYER_TOTAL", collector: "PLATFORM", amountCents: 444 },
        { code: "ENT", base: "TICKET_FACE", collector: "PLATFORM", amountCents: 150 },
      ],
    });

    expect(taxByItem.get("vip") ?? 0).toBe(0);
    expect(taxByItem.get("ga")).toBe(594);
    expect(perLinePaidByItem).not.toBeNull();
    expect(perLinePaidByItem!.get("vip")).toBe(0);
    expect(perLinePaidByItem!.get("ga")).toBe(5_245 + 594);

    const shares = allocateFullRefundShares(
      [vip, ga],
      5_245 + 594,
      195,
      perLinePaidByItem,
    );
    expect(shares.netRefundCentsForItem("vip")).toBe(0);
    expect(shares.netRefundCentsForItem("ga")).toBe(5_245 + 594 - 195);
  });
});

describe("allocateRefundPlatformFeeShares: a ticket a discount brought down to $0", () => {
  it("measured path: the freed ticket's frozen fee is 0", () => {
    const shares = allocateRefundPlatformFeeShares([vip, ga], 50);
    expect(shares.get("vip")).toBe(0);
    expect(shares.get("ga")).toBe(50);
  });

  it("allocated path (frozen fees do not sum to the order fee): still 0", () => {
    // A cap or waiver applied after the meta was written: Σ measured (50)
    // ≠ order fee (40), so the fee is split by refund weight. By buyer-paid
    // the freed ticket took 28 of the 40.
    const shares = allocateRefundPlatformFeeShares([vip, ga], 40);
    expect(shares.get("vip")).toBe(0);
    expect(shares.get("ga")).toBe(40);
  });
});

// Review finding, 2026-10-11: when every ticket weighs 0 the proportional
// allocator hands the whole amount to the first ticket
// (`allocate-proportional-cents.ts`), so a freed ticket would refund real
// money. Traced: checkout cannot produce that order.
//
//  - A charge needs `face − discounts > 0`: `createCheckout` sends anything
//    else to `claimFreeTickets`, which takes no payment
//    (create-checkout.ts `isFree: amountGrossAfterDiscount <= 0`;
//    price-cart.ts `isFree = amountGrossCents <= 0`, which also drops the
//    `discountedToZero` marks).
//  - Every ticket weighing 0 needs each ticket priced $0 or discounted to $0,
//    i.e. discounts spread onto the tickets summing to the face. But
//    `allocateDiscountsToTickets` spreads exactly `min(Σ discounts, face)`,
//    so with `Σ discounts < face` at least one ticket keeps part of its
//    price, carries no mark, and weighs its buyer total.
//  - No other charged line exists on a ticket order: the processing fee and
//    platform fee ride inside ticket `buyerTotalCents`, tax is order-level
//    and computed on the post-discount gross, nothing writes a `surcharge`
//    line, and a pay-what-you-want "donation" IS its ticket's unit price
//    (`resolveSeatUnitPriceCents`), not an amount beside it.
describe("every ticket weighing 0 on a charged order", () => {
  it("cannot come out of checkout: a discount smaller than the face always leaves a ticket with weight", () => {
    // Deterministic sweep over carts of 1 to 5 tickets and 1 to 3 discounts,
    // scoped and order-wide, capped below the face the way a charged order is.
    let seed = 20261011;
    const next = (bound: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % bound;
    };
    for (let round = 0; round < 2_000; round++) {
      const tickets = Array.from({ length: 1 + next(5) }, () => ({
        ticketTypeId: `tt-${next(3)}`,
        unitPriceCents: next(4) === 0 ? 0 : 1 + next(20_000),
      }));
      const face = tickets.reduce((sum, t) => sum + t.unitPriceCents, 0);
      if (face === 0) continue;
      const discounts: TicketDiscount[] = [];
      let left = face - 1; // a charged order: Σ discounts < face
      for (let d = 0; d < 1 + next(3) && left > 0; d++) {
        const cents = 1 + next(left);
        left -= cents;
        discounts.push({
          discountCents: cents,
          ticketTypeId: next(2) === 0 ? null : `tt-${next(3)}`,
        });
      }

      const zeroed = ticketsDiscountedToZero(tickets, discounts);
      const weights = tickets.map((t, index) =>
        refundWeightCents({
          amountCents: t.unitPriceCents,
          meta: {
            buyerTotalCents: t.unitPriceCents,
            ...(zeroed[index] ? { discountedToZero: true } : {}),
          },
        }),
      );
      expect(weights.some((weight) => weight > 0)).toBe(true);
    }
  });

  it("pinned for a row that got there some other way: the first ticket takes the charge, and the order never refunds more than charge − fee", () => {
    // Not a ruling on what such an order SHOULD refund: it is a data anomaly.
    // The pin is that the buyer's money is still returnable (not stranded at
    // $0 on every ticket) and that Σ over the tickets is exact.
    const freedA = item("a", 5_000, {
      buyerTotalCents: 5_000,
      discountedToZero: true,
    });
    const freedB = item("b", 5_000, {
      buyerTotalCents: 5_000,
      discountedToZero: true,
    });

    const shares = allocateFullRefundShares([freedA, freedB], 1_000, 59);

    expect(shares.netRefundCentsForItem("a")).toBe(1_000 - 59);
    expect(shares.netRefundCentsForItem("b")).toBe(0);
    expect(
      shares.netRefundCentsForItem("a") + shares.netRefundCentsForItem("b"),
    ).toBe(1_000 - 59);
  });
});

describe("buildNoChargeRefundId", () => {
  it("is deterministic in the order and the item set, whatever the item order", () => {
    const a = buildNoChargeRefundId("order-1", ["item-a", "item-b"]);
    expect(a).toBe(buildNoChargeRefundId("order-1", ["item-b", "item-a"]));
    expect(a).toMatch(/^nocharge_[0-9a-f]{24}$/);
  });

  it("differs between item sets and between orders", () => {
    const a = buildNoChargeRefundId("order-1", ["item-a"]);
    expect(a).not.toBe(buildNoChargeRefundId("order-1", ["item-b"]));
    expect(a).not.toBe(buildNoChargeRefundId("order-2", ["item-a"]));
  });
});
