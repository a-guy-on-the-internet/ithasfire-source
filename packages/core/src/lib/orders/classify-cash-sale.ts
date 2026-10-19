/**
 * What kind of door cash sale an order is: a comp, a $0 sale made free by a
 * promo code, or a paid sale.
 *
 * ONE rule for every reader of a stored cash order (the till report, the
 * card/cash completion read), and it is `recordCashSale`'s own definition
 * restated over what that use case writes:
 *
 * - A COMP is the explicit Comp action only (`comp: true`, or the legacy
 *   alias `amountCollectedCents: 0` with `comp` unset and NO promo code).
 *   Both go through `recordComp`, which stamps `meta.comp: true` on every
 *   ticket item and redeems no promo. That stamp is the signal.
 * - A sale with a promo code is NEVER a comp (owner ruling: a 100%-off code
 *   makes a $0 SALE). When its total is 0 it is FREE WITH A CODE.
 * - A priced sale (its items carry `buyerTotalCents`, written by `priceCart`
 *   since the door was priced, 2026-10-07) with no code and a $0 total, e.g.
 *   a free tier sold with `comp: false`, is a paid sale that collected $0,
 *   as `recordCashSale` reported it.
 * - An order recorded before the door was priced carries neither stamp. Then
 *   `recordCashSale` called a $0 sale a comp, so $0 with no code still reads
 *   as one.
 *
 * Pure; the adapter and the use cases call it with what they already read.
 */
export type CashSaleClassificationInput = {
  /** What the buyer paid, in cents (ticket net of discount + fee + tax). */
  totalCents: number;
  /** Promo codes typed for this sale (membership benefits excluded). */
  promoCodes: readonly string[];
  items: ReadonlyArray<{ meta: unknown }>;
};

export type CashSaleClassification = {
  isComp: boolean;
  isFreeWithCode: boolean;
};

export function classifyCashSale(
  input: CashSaleClassificationInput,
): CashSaleClassification {
  if (input.promoCodes.length > 0) {
    return { isComp: false, isFreeWithCode: input.totalCents === 0 };
  }
  if (input.items.some((item) => metaOf(item).comp === true)) {
    return { isComp: true, isFreeWithCode: false };
  }
  const priced = input.items.some(
    (item) => typeof metaOf(item).buyerTotalCents === "number",
  );
  if (priced) {
    return { isComp: false, isFreeWithCode: false };
  }
  return { isComp: input.totalCents === 0, isFreeWithCode: false };
}

function metaOf(item: { meta: unknown }): Record<string, unknown> {
  return item.meta && typeof item.meta === "object"
    ? (item.meta as Record<string, unknown>)
    : {};
}
