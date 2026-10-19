import { describe, expect, it } from "vitest";

import { computeExpectedPaymentAmount } from "../compute-expected-payment-amount";
import {
  allocateRefundItemBases,
  computeOrderTicketPriceBasis,
} from "../refund-item-base";

type Item = {
  id: string;
  amountCents: number;
  meta: unknown;
  kind?: string;
};

function ticket(id: string, faceCents: number, buyerTotalCents: number): Item {
  return { id, amountCents: faceCents, meta: { buyerTotalCents }, kind: "ticket" };
}

function negative(id: string, amountCents: number, kind: string): Item {
  return { id, amountCents, meta: {}, kind };
}

function order(items: Item[], partial: Partial<{
  amountGrossCents: number;
  feesPlatformCents: number;
  taxAmountCents: number | null;
}> = {}) {
  return {
    amountGrossCents: partial.amountGrossCents ?? 0,
    feesPlatformCents: partial.feesPlatformCents ?? 0,
    taxAmountCents: partial.taxAmountCents ?? 0,
    items,
  };
}

const ticketsOf = (items: Item[]) => items.filter((i) => i.kind === "ticket");

describe("computeOrderTicketPriceBasis", () => {
  it("is the post-discount, PRE-tax charge", () => {
    const items = [
      ticket("a", 2_500, 2_750),
      ticket("b", 2_500, 2_750),
      negative("credit", -1_000, "platform_credit"),
    ];
    const o = order(items, { taxAmountCents: 800 });

    // 2750 + 2750 − 1000 + 800 tax = 5300 charged.
    expect(computeExpectedPaymentAmount(o)).toBe(5_300);
    expect(computeOrderTicketPriceBasis(o)).toBe(4_500);
  });

  it("is kind-agnostic: any negative line item lands in the order total", () => {
    for (const kind of ["platform_credit", "discount", "some_future_kind"]) {
      const o = order([
        ticket("a", 2_500, 2_750),
        ticket("b", 2_500, 2_750),
        negative("adj", -1_000, kind),
      ]);
      expect(computeOrderTicketPriceBasis(o)).toBe(4_500);
    }
  });

  it("treats a missing taxAmountCents as zero", () => {
    const o = {
      amountGrossCents: 0,
      feesPlatformCents: 0,
      items: [ticket("a", 1_000, 1_100)],
    };
    expect(computeOrderTicketPriceBasis(o)).toBe(1_100);
  });

  it("never goes negative when a credit swallows the whole order", () => {
    const o = order([
      ticket("a", 1_000, 1_100),
      negative("credit", -5_000, "platform_credit"),
    ]);
    expect(computeOrderTicketPriceBasis(o)).toBe(0);
  });
});

describe("allocateRefundItemBases", () => {
  it("collapses to computeItemBuyerPaid on an UNdiscounted order", () => {
    const items = [
      ticket("a", 3_000, 3_300),
      ticket("b", 3_000, 3_300),
      ticket("c", 3_000, 4_400),
    ];
    const bases = allocateRefundItemBases(ticketsOf(items), order(items));

    expect(bases.get("a")).toBe(3_300);
    expect(bases.get("b")).toBe(3_300);
    expect(bases.get("c")).toBe(4_400);
  });

  it("splits a discounted order proportionally by buyer-paid weight", () => {
    const items = [
      ticket("a", 2_500, 2_750),
      ticket("b", 2_500, 2_750),
      negative("credit", -1_000, "platform_credit"),
    ];
    const bases = allocateRefundItemBases(ticketsOf(items), order(items));

    expect(bases.get("a")).toBe(2_250);
    expect(bases.get("b")).toBe(2_250);
  });

  it("loses and invents no cent when the discount does not divide evenly", () => {
    const items = [
      ticket("a", 3_000, 3_300),
      ticket("b", 3_000, 3_300),
      ticket("c", 3_000, 3_300),
      negative("credit", -1_000, "platform_credit"),
    ];
    const bases = allocateRefundItemBases(ticketsOf(items), order(items));

    // 8900 / 3 = 2966.67 → largest remainder gives the two spare cents to the
    // lowest ids.
    expect([...bases.values()]).toEqual([2_967, 2_967, 2_966]);
    expect([...bases.values()].reduce((s, v) => s + v, 0)).toBe(8_900);
  });

  it("sums to EXACTLY orderTotal − tax across a fuzz of discounts and weights", () => {
    let checked = 0;
    for (let seed = 1; seed <= 500; seed += 1) {
      const n = 1 + (seed % 5);
      const items: Item[] = Array.from({ length: n }, (_, i) =>
        ticket(`item-${i}`, 1_000 + ((seed * (i + 7)) % 4_000), 1_100 + ((seed * (i + 3)) % 4_500)),
      );
      const gross = items.reduce((s, i) => s + i.amountCents, 0);
      const discount = -((seed * 137) % (gross || 1));
      const tax = (seed * 29) % 900;
      const all = [...items, negative("credit", discount, "platform_credit")];
      const o = order(all, { amountGrossCents: gross, taxAmountCents: tax });

      const bases = allocateRefundItemBases(items, o);
      const sum = [...bases.values()].reduce((s, v) => s + v, 0);

      expect(sum).toBe(computeOrderTicketPriceBasis(o));
      // `Math.max(0, …)`: a fuzz case where the credit swallows more than the
      // buyer totals clamps the charge to 0, and a basis is never negative.
      expect(sum).toBe(Math.max(0, computeExpectedPaymentAmount(o) - tax));
      for (const v of bases.values()) expect(v).toBeGreaterThanOrEqual(0);
      checked += 1;
    }
    expect(checked).toBe(500);
  });

  it("returns an empty allocation when a credit swallows the whole order", () => {
    const items = [ticket("a", 1_000, 1_100)];
    const bases = allocateRefundItemBases(
      items,
      order([...items, negative("credit", -5_000, "platform_credit")]),
    );

    // Nothing was charged, so nothing is refundable — never a negative base.
    expect(bases.get("a") ?? 0).toBe(0);
  });
});

// Owner ruling 2026-10-11: "yeah it should refund 0 because that's what it
// cost. Otherwise we will get taken advantage of". A ticket a discount brought
// down to $0 (`meta.discountedToZero`) weighs nothing in a refund; the paid
// tickets beside it carry the whole charge.
describe("allocateRefundItemBases: a ticket a discount brought down to $0", () => {
  // The shape of dev order f425308e: a $125 VIP freed by a 100% VIP code
  // beside a paid $50 GA. Charged 5245 + 444 tax = 5689.
  const vip: Item = {
    id: "vip",
    amountCents: 12_500,
    kind: "ticket",
    meta: {
      buyerTotalCents: 12_500,
      discountedToZero: true,
      platformFeePerTicketCents: 0,
      processorFeeShareCents: 0,
    },
  };
  const ga: Item = {
    id: "ga",
    amountCents: 5_000,
    kind: "ticket",
    meta: {
      buyerTotalCents: 5_245,
      platformFeePerTicketCents: 50,
      processorFeeShareCents: 195,
    },
  };
  const discount = negative("discount", -12_500, "discount");
  const freedOrder = order([discount, vip, ga], {
    amountGrossCents: 5_000,
    feesPlatformCents: 50,
    taxAmountCents: 444,
  });

  it("gives the freed ticket a base of 0 and the paid ticket the whole basis", () => {
    expect(computeExpectedPaymentAmount(freedOrder)).toBe(5_689);
    expect(computeOrderTicketPriceBasis(freedOrder)).toBe(5_245);

    const bases = allocateRefundItemBases([vip, ga], freedOrder);

    expect(bases.get("vip") ?? 0).toBe(0);
    expect(bases.get("ga")).toBe(5_245);
  });

  it("is independent of item order", () => {
    const bases = allocateRefundItemBases([ga, vip], freedOrder);
    expect(bases.get("vip") ?? 0).toBe(0);
    expect(bases.get("ga")).toBe(5_245);
  });

  it("splits the basis over the paid tickets only, exactly", () => {
    const ga2: Item = { ...ga, id: "ga2" };
    const o = order([discount, vip, ga, ga2], { taxAmountCents: 889 });
    const bases = allocateRefundItemBases([vip, ga, ga2], o);

    expect(bases.get("vip") ?? 0).toBe(0);
    expect(bases.get("ga")).toBe(5_245);
    expect(bases.get("ga2")).toBe(5_245);
    expect([...bases.values()].reduce((a, b) => a + b, 0)).toBe(
      computeOrderTicketPriceBasis(o),
    );
  });

  it("leaves a ticket discounted to an amount above $0 on the buyer-paid weight", () => {
    // 50% off VIP: nothing is marked, so today's weighting is unchanged.
    const halfVip: Item = {
      id: "vip",
      amountCents: 12_500,
      kind: "ticket",
      meta: { buyerTotalCents: 12_750 },
    };
    const o = order([negative("discount", -6_250, "discount"), halfVip, ga]);
    const bases = allocateRefundItemBases([halfVip, ga], o);

    // 12750 + 5245 − 6250 = 11745, split 12750 : 5245.
    expect(bases.get("vip")).toBe(8_322);
    expect(bases.get("ga")).toBe(3_423);
  });

  it("a ticket PRICED at $0 with no discount already weighs 0", () => {
    const free: Item = {
      id: "free",
      amountCents: 0,
      kind: "ticket",
      meta: { buyerTotalCents: 0, platformFeePerTicketCents: 0 },
    };
    const o = order([free, ga], { taxAmountCents: 444 });
    const bases = allocateRefundItemBases([free, ga], o);

    expect(bases.get("free") ?? 0).toBe(0);
    expect(bases.get("ga")).toBe(5_245);
  });
});
