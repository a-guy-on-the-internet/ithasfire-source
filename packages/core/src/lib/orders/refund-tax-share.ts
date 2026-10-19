import type { CreateOrderTaxLineInput } from "@th/ports/repos/orders";

import { allocateProportionalCents } from "./allocate-proportional-cents";
import { refundFaceWeightCents, refundWeightCents } from "./refund-weight";

/**
 * Tax and processor-fee attribution for refunds — the single definition of
 * "how much of this item's refund was tax" and "how much processor fee this
 * item's refund withholds".
 *
 * ## One rule, every path
 *
 * Every refund path (`quoteItemRefund` → `refundOrderItems`,
 * `getRefundEligibility`, `quoteFullRefund` / `refundFullOrder`,
 * `cancelEvent`) allocates the order's tax and the order's actual Stripe fee
 * across ALL ticket items of the order — never just the items being refunded
 * — with `allocateProportionalCents` (largest-remainder rounding, ties broken
 * by item id) and weights equal to what the buyer paid for each item ex-tax
 * (`refundWeightCents`, `refund-weight.ts`: `computeItemBuyerPaid`, except
 * that a ticket a discount brought down to $0 weighs 0).
 *
 * Owner ruling, 2026-10-11: "yeah it should refund 0 because that's what it
 * cost. Otherwise we will get taken advantage of". A ticket marked
 * `meta.discountedToZero` therefore takes no share of the tax, of the
 * processing fee, or of any tax line (`BUYER_TOTAL` or `TICKET_FACE`); the
 * paid tickets beside it carry all of each, and Σ stays exact. An order
 * priced before 2026-10-10 has no mark and keeps the buyer-paid weighting.
 *
 * Per-item MONEY: the item path pays `base + taxShare − feeShare` (`base` =
 * `allocateRefundItemBases`); the full-order paths pay `paid − feeShare`,
 * where `paid` is the buyer-paid split of the tax-inclusive total. On an
 * order whose tax is split per PLATFORM line (`perLine`, below) the
 * full-order paths and the eligibility screen take `paid = base + taxShare`
 * instead (`allocateRefundTaxSharesForOrder(...).perLinePaidByItem` →
 * `allocateFullRefundShares`), so every path moves the same cents per item
 * and the tax term of that money IS the per-line share. Every other order
 * keeps the buyer-paid split unchanged: its numbers predate per-line shares
 * and a different rounding route could move them by a cent.
 *
 * Consequences, all of which the tests pin:
 *
 * - **Exact to the cent.** Σ taxShare over every ticket item is exactly
 *   `Order.taxAmountCents`; Σ feeShare is exactly the Stripe fee. Refunding
 *   every item returns every cent of tax the buyer paid and withholds every
 *   cent of the fee the processor kept — no more, no less.
 * - **Path-independent.** An item's share is a function of the whole order,
 *   so it is the same whether the item is refunded alone, with siblings, or
 *   via a full-order refund; refunding [A], then [B], then [C] on three
 *   separate days returns exactly what one refund of [A, B, C] does.
 * - **Sibling-independent.** A transferred or already-refunded sibling is
 *   still in the allocation, so it can neither inflate nor shrink the others'
 *   shares. A skipped item's share is simply never paid out or stamped.
 *
 * ## What `OrderItem.refundedTaxCents` records
 *
 * The TAX LINE OF THE REFUND THAT WAS ISSUED, so `getTaxNexusRollup` can net
 * it out of the amount we owe a state. `refundOrderItems` stamps it straight
 * off the quote it refunded from, where it is literally the `taxShare` term
 * of the money. `refundFullOrder` and `cancelEvent` stamp the share from the
 * same allocation the money was planned with: on the per-line path that is
 * exactly the tax term of `paid = base + taxShare` (`cancelEvent` carries it
 * from planning into the marking tx); on every other order it is the
 * buyer-paid share of the tax (same weights as `paid`, rounded on its own),
 * as it always was. Never re-derived from other inputs, never idealised.
 *
 * "Tax line", precisely: a refund is `buyerPaid + taxShare − feeShare`, and
 * the withheld processor fee comes off the refund AS A WHOLE, not off the tax
 * component. So the stamp is the full `taxShare`, not `taxShare` less a
 * pro-rata slice of the withheld fee. That matches the policy the refund is
 * issued under (`refund-policy.ts`: tax is refundable; the processor fee is
 * the single non-refundable component), and it is the only reading under
 * which the three legs of a refund sum back to the cents Stripe was asked to
 * return (absent the `Math.max(0, …)` clamp, which only binds when a fee share
 * exceeds price plus tax).
 *
 * ## Per-line tax shares (`allocateRefundTaxSharesByLine`)
 *
 * An order can carry more than one PLATFORM tax line, each with its own
 * taxable base (Minneapolis: state+local SALES on `BUYER_TOTAL`, the 3%
 * entertainment tax on `TICKET_FACE`). Weighting the whole tax by buyer-paid
 * over-attributes face-only tax to items with large fees. So when the order
 * has ≥2 PLATFORM lines with amount > 0 that sum exactly to
 * `Order.taxAmountCents`, each line is split on its own: `TICKET_FACE` by
 * `item.amountCents` (`refundFaceWeightCents`), `BUYER_TOTAL` by
 * `computeItemBuyerPaid` (`refundWeightCents`), the same
 * `base !== "BUYER_TOTAL"` ⇒ face reading the checkout solver uses, and the
 * per-line shares are summed per item. Both weights are 0 for a ticket a
 * discount brought down to $0. Every other order gets exactly the
 * single-weight result above. If the lines disagree with the order's tax, the
 * order keeps the single-weight result and the caller is told
 * (`lineMismatch`, also raised for a lone line that disagrees), never thrown at. Caveat: `amountCents` is the PRE-discount
 * unit price (promo discounts are separate `discount` items), while checkout
 * taxed the post-discount total; an order-wide discount scales every face
 * alike, a TICKET_TYPE-scoped one does not. Σ per line stays exact either
 * way; the buyer-paid weight has the same pre-discount property.
 *
 * ## History
 *
 * Until 2026-09 the item path used `round(buyerPaid / orderTotalPaid × tax)`
 * with a tax-INCLUSIVE denominator, so Σ ratio was `subtotal / (subtotal +
 * tax)` < 1 and refunding every item one at a time returned `tax² / (subtotal
 * + tax)` less tax than was collected (59c on a 9900 + 800 order) while the
 * full-order path returned it all. The stamps faithfully recorded the
 * shortfall, but the buyer was short-changed. Owner ruling 2026-09-15: buyers
 * get the full proportional tax back on every path; hence one allocator.
 */

type TicketItemLike = { id: string; amountCents: number; meta: unknown };

/**
 * Allocates `totalCents` across ALL ticket items of an order, weighted by
 * what the buyer paid for each (ex-tax; 0 for a ticket a discount brought
 * down to $0). Largest-remainder rounding, so the shares sum to exactly
 * `totalCents`.
 *
 * Returns a map keyed by order-item id; items absent from the map (or skipped
 * by the caller) are attributed nothing, which is correct — a skipped item's
 * share was not refunded.
 */
function allocateAcrossTicketItems(
  ticketItems: TicketItemLike[],
  totalCents: number,
): Map<string, number> {
  return allocateProportionalCents(ticketItems, totalCents, (item) =>
    refundWeightCents(item),
  );
}

/**
 * Each ticket item's share of `Order.taxAmountCents`. Pass EVERY ticket item
 * of the order, not just the ones being refunded.
 */
export function allocateRefundTaxShares(
  ticketItems: TicketItemLike[],
  orderTaxCents: number,
): Map<string, number> {
  return allocateAcrossTicketItems(ticketItems, orderTaxCents);
}

/**
 * Each ticket item's share of the order's actual Stripe processing fee (the
 * non-refundable component). Same allocator and weights as the tax shares, so
 * for the same order the two maps have identical rounding structure. Pass
 * EVERY ticket item of the order, not just the ones being refunded.
 */
export function allocateRefundFeeShares(
  ticketItems: TicketItemLike[],
  orderStripeFeeCents: number,
): Map<string, number> {
  return allocateAcrossTicketItems(ticketItems, orderStripeFeeCents);
}

/**
 * The tax-line fields the per-line allocator reads. A structural slice of the
 * persisted `OrderTaxLine` row (`OrderTaxLineRecord`), so callers pass the
 * records straight through.
 */
export type RefundTaxLineLike = Pick<
  CreateOrderTaxLineInput,
  "code" | "base" | "collector" | "amountCents"
>;

export type RefundTaxSharesByLine = {
  /**
   * Each ticket item's share of `Order.taxAmountCents`. Σ is exactly
   * `orderTaxCents` (when positive and there is at least one item).
   */
  shares: Map<string, number>;
  /**
   * line code → (item id → cents). Populated only when the per-line
   * attribution is exact: the per-line path, or a single PLATFORM line whose
   * amount equals `orderTaxCents`. Each inner map sums to that line's amount.
   * Empty otherwise (no lines, legacy order, mismatch) — the caller cannot
   * attribute the refund to lines and must not guess.
   */
  byLine: Map<string, Map<string, number>>;
  /**
   * True when the order's PLATFORM lines (amount > 0) do NOT sum to
   * `orderTaxCents` — one line or several. `shares` is then the single-weight
   * result; report it. False when there are no such lines (legacy order).
   */
  lineMismatch: boolean;
  /**
   * True only when the per-line split was taken (≥2 PLATFORM lines with
   * amount > 0 summing exactly to `orderTaxCents`). Callers switch the
   * per-item MONEY to `base + shares` on exactly this flag (see "One rule,
   * every path"); never infer it from the lines themselves.
   */
  perLine: boolean;
};

/**
 * Each ticket item's share of `Order.taxAmountCents`, split per PLATFORM tax
 * line by that line's own base (see "Per-line tax shares" above). Pass EVERY
 * ticket item of the order and ALL of its tax lines; ORGANISER lines are
 * ignored (disclosed, never charged). With fewer than two charged lines,
 * `shares` is exactly `allocateRefundTaxShares(ticketItems, orderTaxCents)`.
 */
export function allocateRefundTaxSharesByLine(
  ticketItems: TicketItemLike[],
  orderTaxCents: number,
  taxLines: ReadonlyArray<RefundTaxLineLike> | null | undefined,
): RefundTaxSharesByLine {
  const platformLines = (taxLines ?? []).filter(
    (line) => line.collector === "PLATFORM" && line.amountCents > 0,
  );

  if (platformLines.length < 2) {
    const shares = allocateRefundTaxShares(ticketItems, orderTaxCents);
    const single = platformLines[0];
    const byLine = new Map<string, Map<string, number>>();
    if (single && single.amountCents === orderTaxCents) {
      byLine.set(single.code, new Map(shares));
    }
    return {
      shares,
      byLine,
      lineMismatch: single !== undefined && single.amountCents !== orderTaxCents,
      perLine: false,
    };
  }

  const linesTotal = platformLines.reduce(
    (sum, line) => sum + line.amountCents,
    0,
  );
  if (linesTotal !== orderTaxCents) {
    return {
      shares: allocateRefundTaxShares(ticketItems, orderTaxCents),
      byLine: new Map(),
      lineMismatch: true,
      perLine: false,
    };
  }

  const shares = new Map<string, number>();
  const byLine = new Map<string, Map<string, number>>();
  for (const line of platformLines) {
    // Mirrors the checkout solver: anything that is not BUYER_TOTAL was taxed
    // on the face.
    const lineShares = allocateProportionalCents(
      ticketItems,
      line.amountCents,
      line.base === "BUYER_TOTAL"
        ? (item) => refundWeightCents(item)
        : (item) => refundFaceWeightCents(item),
    );
    // Duplicate codes (not expected) accumulate, so Σ byLine still equals Σ lines.
    const lineEntry = byLine.get(line.code) ?? new Map<string, number>();
    for (const [itemId, cents] of lineShares) {
      lineEntry.set(itemId, (lineEntry.get(itemId) ?? 0) + cents);
      shares.set(itemId, (shares.get(itemId) ?? 0) + cents);
    }
    byLine.set(line.code, lineEntry);
  }

  return { shares, byLine, lineMismatch: false, perLine: true };
}
