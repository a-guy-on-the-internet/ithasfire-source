import { describe, expect, it } from "vitest";

import { allocateProportionalCents } from "../allocate-proportional-cents";
import {
  allocateRefundFeeShares,
  allocateRefundTaxShares,
  allocateRefundTaxSharesByLine,
  type RefundTaxLineLike,
} from "../refund-tax-share";

const item = (id: string, buyerTotalCents: number) => ({
  id,
  amountCents: buyerTotalCents,
  meta: { buyerTotalCents },
});

/** A ticket whose face and buyer-paid differ (fees on top of the face). */
const ticket = (id: string, faceCents: number, buyerTotalCents: number) => ({
  id,
  amountCents: faceCents,
  meta: { buyerTotalCents },
});

const salesLine = (amountCents: number): RefundTaxLineLike => ({
  code: "SALES",
  base: "BUYER_TOTAL",
  collector: "PLATFORM",
  amountCents,
});

const entertainmentLine = (amountCents: number): RefundTaxLineLike => ({
  code: "MPLS_ENTERTAINMENT",
  base: "TICKET_FACE",
  collector: "PLATFORM",
  amountCents,
});

const sum = (shares: Map<string, number>) =>
  [...shares.values()].reduce((a, b) => a + b, 0);

describe("allocateRefundTaxShares — ONE rule for both refund paths", () => {
  it("splits the order tax across ALL ticket items so Σ is EXACTLY the tax collected", () => {
    // Three $30 tickets at $3 platform fee each: subtotal 9900, tax 800.
    // 800 / 3 = 266.67 → floor 266 each (798), two cents left over go to the
    // largest remainders — a three-way tie, broken by id ascending.
    const shares = allocateRefundTaxShares(
      [item("a", 3300), item("b", 3300), item("c", 3300)],
      800,
    );

    expect(shares.get("a")).toBe(267);
    expect(shares.get("b")).toBe(267);
    expect(shares.get("c")).toBe(266);
    expect(sum(shares)).toBe(800);
  });

  it("does not depend on which items are being refunded — the input is the whole order", () => {
    const all = [item("a", 3300), item("b", 3300), item("c", 3300)];
    const shares = allocateRefundTaxShares(all, 800);

    // Refunding [a], then [b], then [c] reads the same map three times, so the
    // three separate refunds return exactly what one refund of [a, b, c] does.
    const oneAtATime =
      (shares.get("a") ?? 0) + (shares.get("b") ?? 0) + (shares.get("c") ?? 0);
    expect(oneAtATime).toBe(800);
  });

  it("splits an indivisible tax to the LAST cent — Σ is exactly the order tax", () => {
    const shares = allocateRefundTaxShares(
      [item("a", 1000), item("b", 1000), item("c", 1000)],
      100,
    );

    expect(sum(shares)).toBe(100);
    // 33.33 each: floor to 33/33/33, then the leftover cent goes to the
    // largest remainder — a three-way tie broken by id, deterministically.
    expect(shares.get("a")).toBe(34);
    expect(shares.get("b")).toBe(33);
    expect(shares.get("c")).toBe(33);
  });

  it("weights by what the buyer paid, not by ticket count", () => {
    const shares = allocateRefundTaxShares(
      [item("a", 3000), item("b", 1000)],
      100,
    );

    expect(shares.get("a")).toBe(75);
    expect(shares.get("b")).toBe(25);
  });

  it("gives an item the SAME share regardless of which siblings are refundable", () => {
    // The allocation is over ALL ticket items, so a transferred sibling that
    // never gets refunded cannot inflate the others' recorded tax.
    const all = allocateRefundTaxShares(
      [item("a", 1000), item("b", 1000), item("c", 1000)],
      100,
    );
    const refundedTwo = (all.get("a") ?? 0) + (all.get("b") ?? 0);

    expect(refundedTwo).toBe(67);
    expect(refundedTwo).toBeLessThan(100);
  });

  it("attributes nothing when the order collected no tax", () => {
    const shares = allocateRefundTaxShares([item("a", 1000)], 0);
    expect(shares.size).toBe(0);
  });
});

describe("allocateRefundFeeShares — the processor fee uses the same rule", () => {
  it("splits the Stripe fee across ALL ticket items so Σ is EXACTLY the fee", () => {
    // Actual Stripe fee 341 on the 3 × 3300 order: 113.67 each → 113/113/113
    // (339), two cents left over → a and b by id.
    const shares = allocateRefundFeeShares(
      [item("a", 3300), item("b", 3300), item("c", 3300)],
      341,
    );

    expect(shares.get("a")).toBe(114);
    expect(shares.get("b")).toBe(114);
    expect(shares.get("c")).toBe(113);
    expect(sum(shares)).toBe(341);
  });

  it("uses the same weights as the tax allocator (buyer-paid, ex-tax)", () => {
    const items = [item("a", 3000), item("b", 1000)];
    expect(allocateRefundFeeShares(items, 100).get("a")).toBe(75);
    expect(allocateRefundFeeShares(items, 100).get("b")).toBe(25);
    expect(allocateRefundFeeShares(items, 100)).toEqual(
      allocateRefundTaxShares(items, 100),
    );
  });

  it("attributes nothing when there is no fee", () => {
    expect(allocateRefundFeeShares([item("a", 1000)], 0).size).toBe(0);
  });
});

describe("allocateProportionalCents", () => {
  it("is exact: Σ allocations === totalCents", () => {
    const shares = allocateProportionalCents(
      [{ id: "a" }, { id: "b" }, { id: "c" }],
      1000,
      () => 1,
    );
    expect([...shares.values()].reduce((a, b) => a + b, 0)).toBe(1000);
  });

  it("puts everything on the first item when every weight is zero", () => {
    const shares = allocateProportionalCents(
      [{ id: "a" }, { id: "b" }],
      500,
      () => 0,
    );
    expect(shares.get("a")).toBe(500);
    expect(shares.get("b")).toBeUndefined();
  });
});

describe("allocateRefundTaxSharesByLine — one split per PLATFORM tax line", () => {
  it("is the single-weight result with fewer than two charged lines", () => {
    // Deterministic spread of orders: 1–4 items, faces and fees varied.
    let seed = 7;
    const next = (max: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % max;
    };

    for (let run = 0; run < 200; run += 1) {
      const items = Array.from({ length: 1 + next(4) }, (_, index) => {
        const face = next(6000);
        return ticket(`i${index}`, face, face + next(400));
      });
      const tax = next(900);
      const organiser: RefundTaxLineLike = {
        code: "ORG_ONLY",
        base: "TICKET_FACE",
        collector: "ORGANISER",
        amountCents: 50 + next(100),
      };
      const old = allocateRefundTaxShares(items, tax);

      for (const lines of [
        undefined,
        null,
        [],
        [salesLine(tax)],
        [salesLine(tax), organiser],
        [entertainmentLine(tax), entertainmentLine(0)],
      ]) {
        const result = allocateRefundTaxSharesByLine(items, tax, lines);
        expect(result.shares).toEqual(old);
        expect(result.lineMismatch).toBe(false);
      }
    }
  });

  it("splits SALES by buyer-paid and the entertainment tax by face (Minneapolis worked example)", () => {
    // a: face 2500 + fees 165 = 2665 paid. b: face 1000 + fees 200 = 1200 paid.
    // SALES 9.03% on the buyer total: 3865 × 0.0903 = 349.
    // Entertainment 3% on the face: 3500 × 0.03 = 105. Order tax = 454.
    const items = [ticket("a", 2500, 2665), ticket("b", 1000, 1200)];
    const result = allocateRefundTaxSharesByLine(items, 454, [
      salesLine(349),
      entertainmentLine(105),
    ]);

    // SALES: 349 × 2665/3865 = 240.64, 349 × 1200/3865 = 108.35 → 240 + 108,
    // the leftover cent to a (larger remainder) → 241 / 108.
    expect(result.byLine.get("SALES")).toEqual(
      new Map([
        ["a", 241],
        ["b", 108],
      ]),
    );
    // Entertainment: 105 × 2500/3500 = 75, 105 × 1000/3500 = 30. Exact.
    expect(result.byLine.get("MPLS_ENTERTAINMENT")).toEqual(
      new Map([
        ["a", 75],
        ["b", 30],
      ]),
    );
    expect(result.shares.get("a")).toBe(316);
    expect(result.shares.get("b")).toBe(138);
    expect(sum(result.shares)).toBe(454);
    expect(result.lineMismatch).toBe(false);

    // The single weight would have put 313 / 141 — b's fees pulling face-only
    // tax towards it.
    const old = allocateRefundTaxShares(items, 454);
    expect(old.get("a")).toBe(313);
    expect(old.get("b")).toBe(141);
  });

  it("falls back to the single-weight result and flags it when the lines do not sum to the order tax", () => {
    const items = [ticket("a", 2500, 2665), ticket("b", 1000, 1200)];
    const result = allocateRefundTaxSharesByLine(items, 460, [
      salesLine(349),
      entertainmentLine(105),
    ]);

    expect(result.lineMismatch).toBe(true);
    expect(result.shares).toEqual(allocateRefundTaxShares(items, 460));
    expect(result.byLine.size).toBe(0);
  });

  it("gives a zero-face item no share of the face tax", () => {
    // A comp beside a paid ticket. Only a carries face, so only a carries the
    // entertainment tax; the comp's fees still draw a slice of the sales tax.
    const items = [ticket("a", 2000, 2150), ticket("comp", 0, 150)];
    const result = allocateRefundTaxSharesByLine(items, 290, [
      salesLine(230),
      entertainmentLine(60),
    ]);

    expect(result.byLine.get("MPLS_ENTERTAINMENT")?.get("a")).toBe(60);
    expect(result.byLine.get("MPLS_ENTERTAINMENT")?.get("comp") ?? 0).toBe(0);
    expect(sum(result.byLine.get("SALES")!)).toBe(230);
    expect(sum(result.shares)).toBe(290);
  });

  it("attributes a single exact PLATFORM line in byLine, and flags it when it disagrees", () => {
    const items = [ticket("a", 1000, 1100)];

    const exact = allocateRefundTaxSharesByLine(items, 99, [salesLine(99)]);
    expect(exact.byLine.get("SALES")).toEqual(new Map([["a", 99]]));
    expect(exact.lineMismatch).toBe(false);

    const off = allocateRefundTaxSharesByLine(items, 99, [salesLine(98)]);
    expect(off.byLine.size).toBe(0);
    expect(off.lineMismatch).toBe(true);
    // The money is untouched: still the single-weight split of the order tax.
    expect(off.shares).toEqual(allocateRefundTaxShares(items, 99));
  });

  it("is exact per line and in total for any two-line order", () => {
    let seed = 11;
    const next = (max: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % max;
    };
    const organiser: RefundTaxLineLike = {
      code: "ORG_ONLY",
      base: "TICKET_FACE",
      collector: "ORGANISER",
      amountCents: 77,
    };

    for (let run = 0; run < 300; run += 1) {
      const items = Array.from({ length: 1 + next(5) }, (_, index) => {
        // Every fifth item is a zero-face comp.
        const face = next(5) === 0 ? 0 : next(8000);
        return ticket(`i${index}`, face, face + next(500));
      });
      const sales = 1 + next(900);
      const entertainment = 1 + next(300);
      const lines = [salesLine(sales), entertainmentLine(entertainment)];
      if (next(2) === 0) lines.push(organiser);

      const result = allocateRefundTaxSharesByLine(
        items,
        sales + entertainment,
        lines,
      );

      expect(result.lineMismatch).toBe(false);
      expect(sum(result.shares)).toBe(sales + entertainment);
      expect(sum(result.byLine.get("SALES")!)).toBe(sales);
      expect(sum(result.byLine.get("MPLS_ENTERTAINMENT")!)).toBe(
        entertainment,
      );
      expect(result.byLine.has("ORG_ONLY")).toBe(false);
      for (const { id } of items) {
        expect(result.shares.get(id) ?? 0).toBe(
          (result.byLine.get("SALES")!.get(id) ?? 0) +
            (result.byLine.get("MPLS_ENTERTAINMENT")!.get(id) ?? 0),
        );
      }
    }
  });
});

// Owner ruling 2026-10-11: a ticket a discount brought down to $0 refunds $0,
// so it takes no share of the tax or of the processing fee either.
describe("a ticket a discount brought down to $0 (meta.discountedToZero)", () => {
  // The shape of dev order f425308e.
  const vip = {
    id: "vip",
    amountCents: 12_500,
    meta: { buyerTotalCents: 12_500, discountedToZero: true },
  };
  const ga = { id: "ga", amountCents: 5_000, meta: { buyerTotalCents: 5_245 } };
  const items = [vip, ga];

  it("takes no share of the tax (single weight)", () => {
    const shares = allocateRefundTaxShares(items, 444);
    expect(shares.get("vip") ?? 0).toBe(0);
    expect(shares.get("ga")).toBe(444);
    expect(sum(shares)).toBe(444);
  });

  it("takes no share of the processing fee", () => {
    const shares = allocateRefundFeeShares(items, 195);
    expect(shares.get("vip") ?? 0).toBe(0);
    expect(shares.get("ga")).toBe(195);
    expect(sum(shares)).toBe(195);
  });

  it("takes no share of a lone PLATFORM line", () => {
    const result = allocateRefundTaxSharesByLine(items, 444, [salesLine(444)]);
    expect(result.perLine).toBe(false);
    expect(result.shares.get("vip") ?? 0).toBe(0);
    expect(result.shares.get("ga")).toBe(444);
    expect(result.byLine.get("SALES")!.get("vip") ?? 0).toBe(0);
    expect(result.byLine.get("SALES")!.get("ga")).toBe(444);
  });

  it("takes no share of a BUYER_TOTAL line nor of a TICKET_FACE line", () => {
    const result = allocateRefundTaxSharesByLine(items, 444 + 150, [
      salesLine(444),
      entertainmentLine(150),
    ]);

    expect(result.perLine).toBe(true);
    expect(result.byLine.get("SALES")!.get("vip") ?? 0).toBe(0);
    expect(result.byLine.get("SALES")!.get("ga")).toBe(444);
    // TICKET_FACE weighs by `amountCents`, which is the freed ticket's
    // PRE-discount price (12500): it must still weigh 0.
    expect(result.byLine.get("MPLS_ENTERTAINMENT")!.get("vip") ?? 0).toBe(0);
    expect(result.byLine.get("MPLS_ENTERTAINMENT")!.get("ga")).toBe(150);
    expect(result.shares.get("vip") ?? 0).toBe(0);
    expect(result.shares.get("ga")).toBe(594);
    expect(sum(result.shares)).toBe(594);
  });

  it("a ticket PRICED at $0 with no discount already weighs 0 on both bases", () => {
    const free = { id: "free", amountCents: 0, meta: { buyerTotalCents: 0 } };
    const result = allocateRefundTaxSharesByLine([free, ga], 594, [
      salesLine(444),
      entertainmentLine(150),
    ]);

    expect(result.shares.get("free") ?? 0).toBe(0);
    expect(result.byLine.get("MPLS_ENTERTAINMENT")!.get("free") ?? 0).toBe(0);
    expect(result.shares.get("ga")).toBe(594);
    expect(allocateRefundFeeShares([free, ga], 195).get("free") ?? 0).toBe(0);
  });

  it("a ticket discounted to an amount above $0 keeps the buyer-paid weight", () => {
    const half = { id: "vip", amountCents: 12_500, meta: { buyerTotalCents: 12_750 } };
    const shares = allocateRefundTaxShares([half, ga], 444);
    // 444 × 12750 / 17995 = 314.6, 444 × 5245 / 17995 = 129.4.
    expect(shares.get("vip")).toBe(315);
    expect(shares.get("ga")).toBe(129);
  });
});
