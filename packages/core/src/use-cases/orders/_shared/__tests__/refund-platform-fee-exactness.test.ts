import { describe, expect, it } from "vitest";

import { allocateRefundItemBases } from "../../../../lib/orders/refund-item-base";
import { computeOrderSplits } from "../../../../lib/pricing/compute-order-splits";
import { attributeCreditToItems } from "../../../settlements/create-credits-from-order";
import { computeAgreementBasis } from "../../finalize-from-payment-intent";
import { allocateRefundPlatformFeeShares } from "../refund-platform-fee-share";

// ---------------------------------------------------------------------------
// WHEN IS THE REFUND STAMP WHAT THE PLATFORM LOST?
//
// The platform's net-kept read (`adapters/db/prisma/analytics.ts`) nets a
// refunded ticket as its stamp, `OrderItem.refundedPlatformFeeCents`. Three
// allocators decide the money a refund actually moves, with three weights:
//
//   * the buyer's refund base        by what the buyer paid   (`allocateRefundItemBases`)
//   * the organiser's REFUND_DEBIT   by face                  (`attributeCreditToItems`)
//   * the stamp                      the ticket's own fee     (`allocateRefundPlatformFeeShares`)
//
// Refunding ticket i costs the platform `base_i − debit_i`. This file runs
// the REAL allocators and compares that with the stamp, because the net-kept
// eligibility conditions (8), (9) and (10) rest on where the two agree.
//
// Fixtures carry `buyerTotalCents = face + platform fee`, with no processing
// fee share, so the difference isolates the platform-fee unit. The processing
// fee is a separate term of the net (see the header of
// `use-cases/platform/get-platform-revenue.ts`).
// ---------------------------------------------------------------------------

type Ticket = {
  id: string;
  kind: "ticket";
  amountCents: number;
  meta: { buyerTotalCents: number; platformFeePerTicketCents: number };
};

function ticket(id: string, faceCents: number, feeCents: number): Ticket {
  return {
    id,
    kind: "ticket",
    amountCents: faceCents,
    meta: {
      buyerTotalCents: faceCents + feeCents,
      platformFeePerTicketCents: feeCents,
    },
  };
}

/**
 * One order as checkout writes it: a ticket item per ticket, the discount as
 * a separate negative `discount` line, `amountGrossCents` post-discount.
 * Returns, per ticket, what a refund of it moves.
 */
function refundMoney(opts: {
  tickets: Ticket[];
  discountCents?: number;
  /** Omitted → an order sold before 2026-10-11 (credited price minus fee). */
  organiserCredit?: "FULL_PRICE";
  /**
   * The payout-terms lines, as percent per payee. Omitted → one payee at
   * 100%. Each payee's credit is its OrderSplit (`computeOrderSplits` over
   * the basis), and `createCreditsFromOrder` attributes EACH payee's credit
   * to the tickets separately, so a refunded ticket's debit is the sum of its
   * per-payee shares.
   */
  payeePercents?: number[];
  /**
   * The OrderSplit amounts themselves, one per payee, in place of
   * `payeePercents`. For split shapes percents cannot reach (any amounts,
   * including ones that do not add up to the credit).
   */
  splitCents?: number[];
}) {
  const discountCents = opts.discountCents ?? 0;
  const faceCents = opts.tickets.reduce((sum, t) => sum + t.amountCents, 0);
  const feesPlatformCents = opts.tickets.reduce(
    (sum, t) => sum + t.meta.platformFeePerTicketCents,
    0,
  );
  const order = {
    amountGrossCents: faceCents - discountCents,
    feesPlatformCents,
    taxAmountCents: 0,
    feePolicySnapshot: {
      feeMode: "PASS_THROUGH",
      ...(opts.organiserCredit
        ? { organiserCredit: opts.organiserCredit }
        : {}),
    },
    items: [
      ...opts.tickets,
      ...(discountCents > 0
        ? [{ id: "discount", kind: "discount", amountCents: -discountCents, meta: {} }]
        : []),
    ],
  };

  const bases = allocateRefundItemBases(opts.tickets, order);
  const creditCents = computeAgreementBasis(order);
  const splits = opts.splitCents
    ? opts.splitCents.map((amountCents) => ({ amountCents }))
    : computeOrderSplits({
        amountCents: creditCents,
        lines: (opts.payeePercents ?? [100]).map((percent, i) => ({
          id: `line_${i}`,
          payeeId: `payee_${i}`,
          percent,
        })),
      }).splits;
  // One attribution PER PAYEE, as createCreditsFromOrder writes them; the
  // refund debits each payee its own attributed share of the ticket. A
  // payee whose split is 0 or less earns no credit (createCreditsFromOrder
  // skips it), so it is attributed nothing.
  const debits: Record<string, number> = {};
  for (const split of splits) {
    if (split.amountCents <= 0) continue;
    const perItem = attributeCreditToItems(
      opts.tickets.map((t) => ({ id: t.id, amountCents: t.amountCents })),
      split.amountCents,
    );
    for (const [id, cents] of Object.entries(perItem)) {
      debits[id] = (debits[id] ?? 0) + cents;
    }
  }
  const stamps = allocateRefundPlatformFeeShares(opts.tickets, feesPlatformCents);

  return {
    feesPlatformCents,
    creditCents,
    splitCents: splits.map((split) => split.amountCents),
    perTicket: Object.fromEntries(
      opts.tickets.map((t) => {
        const baseCents = bases.get(t.id) ?? 0;
        const debitCents = debits[t.id] ?? 0;
        return [
          t.id,
          {
            baseCents,
            debitCents,
            /** What refunding this ticket alone costs the platform. */
            platformLossCents: baseCents - debitCents,
            stampCents: stamps.get(t.id) ?? 0,
          },
        ];
      }),
    ),
  };
}

const sumOf = (
  money: ReturnType<typeof refundMoney>,
  key: "platformLossCents" | "stampCents",
) => Object.values(money.perTicket).reduce((sum, t) => sum + t[key], 0);

describe("refund stamp vs. what the platform lost: an order credited FULL_PRICE", () => {
  it("(a) unlike tickets WITH a discount: a partial refund costs more or less than the stamp", () => {
    // Face 1000 / fee 33 and face 2000 / fee 50, 1500 off the order.
    const money = refundMoney({
      tickets: [ticket("a", 1_000, 33), ticket("b", 2_000, 50)],
      discountCents: 1_500,
      organiserCredit: "FULL_PRICE",
    });

    expect(money.creditCents).toBe(1_500);
    // Buyer paid 3083 − 1500 = 1583, split 1033 : 2050.
    // Organiser credited 1500, split 1000 : 2000.
    expect(money.perTicket.b).toEqual({
      baseCents: 1_053,
      debitCents: 1_000,
      platformLossCents: 53,
      stampCents: 50,
    });
    expect(money.perTicket.a).toEqual({
      baseCents: 530,
      debitCents: 500,
      platformLossCents: 30,
      stampCents: 33,
    });
    // `fee − stamp` after refunding b reads 83 − 50 = 33 kept. The platform
    // kept 83 − 53 = 30.
    expect(money.feesPlatformCents - money.perTicket.b!.stampCents).toBe(33);
    expect(money.feesPlatformCents - money.perTicket.b!.platformLossCents).toBe(30);
  });

  it("(a) the same order refunded IN FULL is exact: the differences sum to the order fee", () => {
    const money = refundMoney({
      tickets: [ticket("a", 1_000, 33), ticket("b", 2_000, 50)],
      discountCents: 1_500,
      organiserCredit: "FULL_PRICE",
    });

    expect(sumOf(money, "platformLossCents")).toBe(83);
    expect(sumOf(money, "stampCents")).toBe(83);
    expect(money.feesPlatformCents).toBe(83);
  });

  it("(b) unlike tickets with NO discount: every ticket's loss is its stamp, to the cent", () => {
    const money = refundMoney({
      tickets: [ticket("a", 1_000, 33), ticket("b", 2_000, 50)],
      organiserCredit: "FULL_PRICE",
    });

    expect(money.perTicket.a).toEqual({
      baseCents: 1_033,
      debitCents: 1_000,
      platformLossCents: 33,
      stampCents: 33,
    });
    expect(money.perTicket.b).toEqual({
      baseCents: 2_050,
      debitCents: 2_000,
      platformLossCents: 50,
      stampCents: 50,
    });
  });

  it("(b) no discount stays exact across uneven carts (the weights never matter when nothing is spread)", () => {
    const carts: Array<Array<[number, number]>> = [
      [[1_000, 33], [2_000, 50], [7_500, 50]],
      [[999, 33], [1, 1], [12_345, 50], [3_333, 50]],
      [[500, 17], [500, 17], [500, 16]],
    ];
    for (const cart of carts) {
      const money = refundMoney({
        tickets: cart.map(([face, fee], i) => ticket(`t${i}`, face, fee)),
        organiserCredit: "FULL_PRICE",
      });
      for (const t of Object.values(money.perTicket)) {
        expect(t.platformLossCents).toBe(t.stampCents);
      }
    }
  });

  it("(c) two IDENTICAL tickets with a discount that divides evenly: exact", () => {
    const money = refundMoney({
      tickets: [ticket("a", 1_000, 33), ticket("b", 1_000, 33)],
      discountCents: 500,
      organiserCredit: "FULL_PRICE",
    });

    // Buyer paid 2066 − 500 = 1566 → 783 each; organiser credited 1500 → 750
    // each.
    for (const id of ["a", "b"]) {
      expect(money.perTicket[id]).toEqual({
        baseCents: 783,
        debitCents: 750,
        platformLossCents: 33,
        stampCents: 33,
      });
    }
  });

  it("(c) identical tickets are NOT exact in general: an uneven discount lands its odd cents on different tickets", () => {
    // Three at face 1000 / fee 33 with 101 off. The buyer's base gives its
    // leftover cent to the FIRST id (largest remainder, ties by id); the
    // organiser's attribution gives its leftover to the LAST item.
    const money = refundMoney({
      tickets: [ticket("a", 1_000, 33), ticket("b", 1_000, 33), ticket("c", 1_000, 33)],
      discountCents: 101,
      organiserCredit: "FULL_PRICE",
    });

    expect(Object.values(money.perTicket).map((t) => t.stampCents)).toEqual([33, 33, 33]);
    expect(Object.values(money.perTicket).map((t) => t.platformLossCents)).toEqual([34, 33, 32]);
    // Which is why the net-kept exclusion is "any discount", not "a discount
    // over unlike tickets".
    expect(sumOf(money, "platformLossCents")).toBe(99);
  });

  it("the loss follows fee_i − D × (paid_i/Σpaid − face_i/Σface), within the allocators' rounding", () => {
    const tickets = [ticket("a", 1_000, 33), ticket("b", 2_000, 50), ticket("c", 7_500, 50)];
    const sumPaid = tickets.reduce((s, t) => s + t.meta.buyerTotalCents, 0);
    const sumFace = tickets.reduce((s, t) => s + t.amountCents, 0);
    for (const discountCents of [0, 1, 250, 1_500, 5_000, 10_499]) {
      const money = refundMoney({ tickets, discountCents, organiserCredit: "FULL_PRICE" });
      for (const t of tickets) {
        const predicted =
          t.meta.platformFeePerTicketCents -
          discountCents * (t.meta.buyerTotalCents / sumPaid - t.amountCents / sumFace);
        // Each allocator rounds a share by less than a cent.
        expect(
          Math.abs(money.perTicket[t.id]!.platformLossCents - predicted),
        ).toBeLessThan(2);
      }
    }
  });

  it("a FEE-WAIVED ticket kept beside a refunded one: the stamps reach the order fee while a ticket is still held", () => {
    // `computeOrderAmounts({ waivedTickets })` zeroes one ticket's fee and
    // leaves its face. Ticket a is waived (fee 0), b pays 50; 1500 off.
    const money = refundMoney({
      tickets: [ticket("a", 1_000, 0), ticket("b", 2_000, 50)],
      discountCents: 1_500,
      organiserCredit: "FULL_PRICE",
    });

    // Refunding b alone stamps the whole order fee...
    expect(money.perTicket.b!.stampCents).toBe(money.feesPlatformCents);
    // ...so "Σ stamped = feesPlatformCents" reads this as a full refund,
    // though a is still held and the platform lost 42, not 50.
    expect(money.perTicket.b).toEqual({
      baseCents: 1_042,
      debitCents: 1_000,
      platformLossCents: 42,
      stampCents: 50,
    });
  });
});

// A MARKED order's debit is per payee too. Net-kept condition (9) admits a
// partial refund of a marked order with no discount only when the splits add
// up to the faces AND every payee's share of every ticket is whole: for every
// split s and ticket face f, s × f divides by Σ face (the SQL's
// refunded_order_attribution). `attributionExact` below is that predicate in
// JS, so the sweep at the end checks the SQL's rule against the allocators.
function attributionExact(faces: number[], splitCents: number[]): boolean {
  const faceSum = faces.reduce((sum, f) => sum + f, 0);
  if (faceSum === 0) return false;
  return splitCents.every(
    (s) => s >= 0 && faces.every((f) => f >= 0 && (s * f) % faceSum === 0),
  );
}

describe("refund stamp vs. what the platform lost: a FULL_PRICE order with SEVERAL payees (condition 9)", () => {
  it("two payees, odd faces: each payee's share rounds, so a partial refund is off by a cent and (9) EXCLUDES it", () => {
    // Two at face 1999 / fee 33, splits 1999 : 1999. Each payee attributes
    // 1999 × 1999 / 3998 = 999.5 → 1000 to the first ticket and the
    // remainder 999 to the second, so the debits are 2000 and 1998.
    const money = refundMoney({
      tickets: [ticket("a", 1_999, 33), ticket("b", 1_999, 33)],
      organiserCredit: "FULL_PRICE",
      payeePercents: [50, 50],
    });

    expect(money.splitCents).toEqual([1_999, 1_999]);
    expect(attributionExact([1_999, 1_999], money.splitCents)).toBe(false);
    expect(money.perTicket.a).toEqual({
      baseCents: 2_032,
      debitCents: 2_000,
      platformLossCents: 32,
      stampCents: 33,
    });
    // Refunding b costs 34: the platform kept 66 − 34 = 32, and fee − stamp
    // would read 66 − 33 = 33. An OVERSTATEMENT if (9) admitted it.
    expect(money.perTicket.b).toEqual({
      baseCents: 2_032,
      debitCents: 1_998,
      platformLossCents: 34,
      stampCents: 33,
    });
    // Refunded in full it is exact.
    expect(sumOf(money, "platformLossCents")).toBe(money.feesPlatformCents);
  });

  it("two payees whose shares are whole: exact, which (9) keeps — like tickets with divisible splits, and unlike tickets too", () => {
    // Like: two at face 1000 / fee 33, 50 : 50 → 1000 : 1000, 500 a ticket
    // per payee.
    const like = refundMoney({
      tickets: [ticket("a", 1_000, 33), ticket("b", 1_000, 33)],
      organiserCredit: "FULL_PRICE",
      payeePercents: [50, 50],
    });
    expect(like.splitCents).toEqual([1_000, 1_000]);
    expect(attributionExact([1_000, 1_000], like.splitCents)).toBe(true);
    for (const t of Object.values(like.perTicket)) {
      expect(t.platformLossCents).toBe(t.stampCents);
    }

    // Unlike: faces 1000 and 2000, 50 : 50 → 1500 : 1500, which attributes
    // 500 : 1000 per payee. Not "like", still whole.
    const unlike = refundMoney({
      tickets: [ticket("a", 1_000, 33), ticket("b", 2_000, 50)],
      organiserCredit: "FULL_PRICE",
      payeePercents: [50, 50],
    });
    expect(unlike.splitCents).toEqual([1_500, 1_500]);
    expect(attributionExact([1_000, 2_000], unlike.splitCents)).toBe(true);
    expect(unlike.perTicket.a).toMatchObject({ debitCents: 1_000, platformLossCents: 33, stampCents: 33 });
    expect(unlike.perTicket.b).toMatchObject({ debitCents: 2_000, platformLossCents: 50, stampCents: 50 });
  });

  it("ONE payee, unlike tickets: always exact — the payee's split is the face sum, so every share is the face", () => {
    const tickets = [ticket("a", 1_001, 33), ticket("b", 997, 17), ticket("c", 1_333, 50)];
    const money = refundMoney({ tickets, organiserCredit: "FULL_PRICE" });
    expect(money.splitCents).toEqual([3_331]);
    expect(attributionExact([1_001, 997, 1_333], money.splitCents)).toBe(true);
    for (const t of tickets) {
      expect(money.perTicket[t.id]).toMatchObject({
        debitCents: t.amountCents,
        platformLossCents: t.meta.platformFeePerTicketCents,
        stampCents: t.meta.platformFeePerTicketCents,
      });
    }
  });

  it("the splits must add up to the faces: over them OVERSTATES, under them does not net either", () => {
    const tickets = [ticket("a", 1_000, 33), ticket("b", 1_000, 33)];
    // 2002 over faces of 2000: each ticket debited 1001, so a refund costs
    // 32 against a stamp of 33 — and the platform credited 2 cents it never
    // took. Kept 66 − 2 − 32 = 32; fee − stamp reads 33.
    const over = refundMoney({ tickets, organiserCredit: "FULL_PRICE", splitCents: [2_002] });
    expect(over.perTicket.b).toMatchObject({ debitCents: 1_001, platformLossCents: 32 });
    // 1998 under: debited 999, a refund costs 34, the platform kept the 2
    // uncredited cents. Kept 66 + 2 − 34 = 34; fee − stamp reads 33.
    const under = refundMoney({ tickets, organiserCredit: "FULL_PRICE", splitCents: [1_998] });
    expect(under.perTicket.b).toMatchObject({ debitCents: 999, platformLossCents: 34 });
  });

  it("SWEEP: wherever the splits add up to the faces and attributionExact holds, every ticket's loss is its stamp", () => {
    // Carts of up to three tickets, each split into two or three payees by
    // every percent pair/triple on a 10% grid. No discount, fees recorded
    // and summing to the order fee: the shape (9) is about.
    const carts: Array<Array<[number, number]>> = [
      [[1_000, 33], [1_000, 33]],
      [[1_999, 33], [1_999, 33]],
      [[1_000, 33], [2_000, 50]],
      [[999, 33], [1, 1], [12_345, 50]],
      [[500, 17], [500, 17], [500, 16]],
      [[2_500, 50], [7_500, 50]],
      [[1_001, 33], [997, 17], [1_333, 50]],
    ];
    const percentSets: number[][] = [];
    for (let p = 10; p <= 90; p += 10) percentSets.push([p, 100 - p]);
    for (let p = 10; p <= 80; p += 10) {
      for (let q = 10; p + q <= 90; q += 10) percentSets.push([p, q, 100 - p - q]);
    }

    let exactCount = 0;
    let refusedCount = 0;
    let refusedButExactCount = 0;
    for (const cart of carts) {
      const tickets = cart.map(([face, fee], i) => ticket(`t${i}`, face, fee));
      const faces = tickets.map((t) => t.amountCents);
      for (const payeePercents of percentSets) {
        const money = refundMoney({ tickets, organiserCredit: "FULL_PRICE", payeePercents });
        const splitSum = money.splitCents.reduce((sum, s) => sum + s, 0);
        // computeOrderSplits hands out the whole credit.
        expect(splitSum).toBe(faces.reduce((sum, f) => sum + f, 0));
        const allExact = Object.values(money.perTicket).every(
          (t) => t.platformLossCents === t.stampCents,
        );
        if (attributionExact(faces, money.splitCents)) {
          exactCount += 1;
          expect(allExact).toBe(true);
        } else {
          refusedCount += 1;
          // The predicate is SUFFICIENT, not necessary: two payees' rounded
          // cents can cancel on every ticket. Such an order is exact and is
          // excluded anyway, which costs coverage and never overstates.
          if (allExact) refusedButExactCount += 1;
        }
      }
    }
    // Both branches were exercised, and the refusals include real misses.
    expect(exactCount).toBeGreaterThan(0);
    expect(refusedCount).toBeGreaterThan(refusedButExactCount);
  });
});

// An UNMARKED order (sold before 2026-10-11) nets a refunded ticket as TWO
// stamps on PASS_THROUGH: the buyer-side fee and the basis-side unit. Net-kept
// condition (10) keeps a PARTIAL refund of such an order only when every
// ticket item shares one face and one per-ticket fee, the per-ticket fees sum
// to the order fee, the order carries no discount line, and every payee's
// split (its credit, attributed to the tickets on its own) divides by the
// ticket count and the splits sum to the basis. The cases below
// are why each of those is required; a refund of EVERY ticket stays eligible
// whatever the tickets, because the differences then sum to both units.
describe("refund stamp vs. what the platform lost: an order sold BEFORE the full-price credit (condition 10)", () => {
  it("unlike tickets, NO discount: a partial refund is off by cents, so (10) EXCLUDES it; a full refund is exact and stays in", () => {
    // Unmarked: the organiser was credited gross − fee = 3000 − 83 = 2917,
    // attributed by FACE (972 : 1945), while each ticket's own fee is capped
    // per ticket (33 : 50), which is not the face ratio.
    const money = refundMoney({
      tickets: [ticket("a", 1_000, 33), ticket("b", 2_000, 50)],
    });

    expect(money.creditCents).toBe(2_917);
    expect(money.perTicket.b).toEqual({
      baseCents: 2_050,
      debitCents: 1_945,
      platformLossCents: 105,
      stampCents: 50,
    });
    expect(money.perTicket.a).toEqual({
      baseCents: 1_033,
      debitCents: 972,
      platformLossCents: 61,
      stampCents: 33,
    });
    // The net gives back the stamp twice on an unmarked PASS_THROUGH order:
    // 100 for b against a real 105, 66 for a against a real 61.
    expect(2 * money.perTicket.b!.stampCents).toBe(100);
    expect(2 * money.perTicket.a!.stampCents).toBe(66);
    // A full refund is exact: both units come back. This is why (10) counts
    // items and leaves a refund of every ticket eligible.
    expect(sumOf(money, "platformLossCents")).toBe(2 * money.feesPlatformCents);
  });

  it("unlike tickets WITH a discount: a partial refund is off too, so (10) EXCLUDES it", () => {
    // The worked order sold before the change: 3000 − 1500 off − 83 fee =
    // a credit of 1417, attributed by face (472 : 945).
    const money = refundMoney({
      tickets: [ticket("a", 1_000, 33), ticket("b", 2_000, 50)],
      discountCents: 1_500,
    });

    expect(money.creditCents).toBe(1_417);
    expect(money.perTicket.b!.platformLossCents).not.toBe(2 * money.perTicket.b!.stampCents);
    expect(money.perTicket.a!.platformLossCents).not.toBe(2 * money.perTicket.a!.stampCents);
    expect(sumOf(money, "platformLossCents")).toBe(2 * money.feesPlatformCents);
  });

  it("identical tickets, no discount: exact, which is the partial refund (10) keeps", () => {
    const money = refundMoney({
      tickets: [ticket("a", 1_000, 33), ticket("b", 1_000, 33)],
    });
    for (const id of ["a", "b"]) {
      expect(money.perTicket[id]!.platformLossCents).toBe(
        2 * money.perTicket[id]!.stampCents,
      );
    }
  });

  it("identical tickets across uneven counts and prices, no discount: every ticket's loss is two stamps", () => {
    // ONE payee: its credit is n × (face − fee), which divides by n, so
    // attribution by face hands each ticket exactly face − fee and no
    // leftover cent is left to place. With several payees that holds only
    // when EACH payee's credit divides by n (the two-payee cases below).
    const carts: Array<[number, number, number]> = [
      [3, 1_000, 33],
      [7, 2_500, 50],
      [5, 1, 1],
      [4, 12_345, 50],
    ];
    for (const [count, face, fee] of carts) {
      const money = refundMoney({
        tickets: Array.from({ length: count }, (_, i) => ticket(`t${i}`, face, fee)),
      });
      for (const t of Object.values(money.perTicket)) {
        expect(t.platformLossCents).toBe(2 * t.stampCents);
      }
    }
  });

  it("identical tickets, TWO payees whose credits do not divide by the ticket count: off by a cent, so (10) EXCLUDES it", () => {
    // Two at face 1000 / fee 33: credit 1934, split 50/50 into 967 each.
    // Each payee's 967 is attributed separately, 484 : 483 (leftover on the
    // last ticket), so the debits are 968 : 966, not 967 : 967.
    const money = refundMoney({
      tickets: [ticket("a", 1_000, 33), ticket("b", 1_000, 33)],
      payeePercents: [50, 50],
    });

    expect(money.creditCents).toBe(1_934);
    expect(money.splitCents).toEqual([967, 967]);
    expect(money.perTicket.a).toEqual({
      baseCents: 1_033,
      debitCents: 968,
      platformLossCents: 65,
      stampCents: 33,
    });
    // Refunding b costs 1033 − 966 = 67 where the net gives back 66: an
    // OVERSTATEMENT of the platform's take by 1 if it were kept.
    expect(money.perTicket.b).toEqual({
      baseCents: 1_033,
      debitCents: 966,
      platformLossCents: 67,
      stampCents: 33,
    });
    // A full refund is still exact.
    expect(sumOf(money, "platformLossCents")).toBe(2 * money.feesPlatformCents);
  });

  it("identical tickets, FOUR tickets and two payees: the remainder on the last ticket grows to 3 cents", () => {
    // Four at face 1000 / fee 33: credit 3868, 50/50 → 1934 each, which is
    // 483.5 a ticket: 484, 484, 484 and the remainder 482, per payee.
    const money = refundMoney({
      tickets: ["a", "b", "c", "d"].map((id) => ticket(id, 1_000, 33)),
      payeePercents: [50, 50],
    });
    expect(money.splitCents).toEqual([1_934, 1_934]);
    expect(Object.values(money.perTicket).map((t) => t.platformLossCents)).toEqual([65, 65, 65, 69]);
    expect(Object.values(money.perTicket).map((t) => 2 * t.stampCents)).toEqual([66, 66, 66, 66]);
  });

  it("identical tickets, TWO payees whose credits each divide by the ticket count: exact, which (10) keeps", () => {
    // Two at face 1000 / fee 34: credit 1932, 50/50 → 966 each, 483 : 483
    // per payee, so every ticket is debited 966 = face − fee.
    const money = refundMoney({
      tickets: [ticket("a", 1_000, 34), ticket("b", 1_000, 34)],
      payeePercents: [50, 50],
    });
    expect(money.splitCents).toEqual([966, 966]);
    for (const id of ["a", "b"]) {
      expect(money.perTicket[id]).toMatchObject({ debitCents: 966 });
      expect(money.perTicket[id]!.platformLossCents).toBe(
        2 * money.perTicket[id]!.stampCents,
      );
    }
    // Uneven percents too, as long as each payee's split divides: 3 tickets
    // at face 1100 / fee 100, credit 3000, 70 : 30 → 2100 : 900.
    const uneven = refundMoney({
      tickets: ["a", "b", "c"].map((id) => ticket(id, 1_100, 100)),
      payeePercents: [70, 30],
    });
    expect(uneven.splitCents).toEqual([2_100, 900]);
    for (const t of Object.values(uneven.perTicket)) {
      expect(t.platformLossCents).toBe(2 * t.stampCents);
    }
  });

  it("identical tickets WITH an uneven discount: off by a cent, which is why (10) treats any discount line as unlike", () => {
    // Three at face 1000 / fee 33 with 101 off: credit 2899 − 99 = 2800.
    // The buyer's base gives its leftover cent to the FIRST ticket, the
    // organiser's attribution gives its leftover to the LAST.
    const money = refundMoney({
      tickets: [ticket("a", 1_000, 33), ticket("b", 1_000, 33), ticket("c", 1_000, 33)],
      discountCents: 101,
    });

    expect(money.creditCents).toBe(2_800);
    expect(Object.values(money.perTicket).map((t) => 2 * t.stampCents)).toEqual([66, 66, 66]);
    expect(Object.values(money.perTicket).map((t) => t.platformLossCents)).toEqual([67, 66, 65]);
    // A full refund is still exact.
    expect(sumOf(money, "platformLossCents")).toBe(2 * money.feesPlatformCents);
  });

  it("a FEE-WAIVED ticket beside a fee-bearing one: unlike by fee, so a partial refund is EXCLUDED", () => {
    // Same face, fees 0 and 50: the credit 2000 − 50 = 1950 splits 975 : 975
    // by face, so the waived ticket carries 25 of the fee it never paid.
    const money = refundMoney({
      tickets: [ticket("a", 1_000, 0), ticket("b", 1_000, 50)],
    });

    expect(money.perTicket.a).toMatchObject({ platformLossCents: 25, stampCents: 0 });
    expect(money.perTicket.b).toMatchObject({ platformLossCents: 75, stampCents: 50 });
  });
});
