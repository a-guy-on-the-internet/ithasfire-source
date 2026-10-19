import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";

import { allocateRefundItemBases } from "../../../lib/orders/refund-item-base";
import {
  allocateRefundTaxSharesByLine,
  type RefundTaxLineLike,
} from "../../../lib/orders/refund-tax-share";

type TicketItemLike = { id: string; amountCents: number; meta: unknown };

export type OrderRefundTaxShares = {
  /** Each ticket item's share of `Order.taxAmountCents`; Σ is exactly it. */
  taxByItem: Map<string, number>;
  /**
   * Each ticket item's tax-INCLUSIVE paid amount, `base + taxShare`, where
   * `base` is `allocateRefundItemBases` (the item path's ex-tax base). Set
   * ONLY on the per-line path (`perLine`); null for every other order, whose
   * callers keep their existing buyer-paid split of the tax-inclusive total
   * unchanged. Σ is exactly `computeExpectedPaymentAmount(order)` (Σ base =
   * total − tax, Σ tax = tax).
   */
  perLinePaidByItem: Map<string, number> | null;
};

/**
 * Each ticket item's share of an order's tax for a refund, split per PLATFORM
 * tax line (`allocateRefundTaxSharesByLine`), with the line-mismatch fallback
 * REPORTED, and — on the per-line path only — the per-item paid amount every
 * refund path must pay from (see `refund-tax-share.ts`, "One rule, every
 * path").
 *
 * Every refund path calls this instead of the allocator directly so the
 * mismatch branch is reported the same way everywhere. When the order's
 * PLATFORM lines do not sum to `Order.taxAmountCents`, the allocator falls
 * back to the single buyer-paid weight; the refund still pays from that
 * fallback (it is what every order got before per-line shares existed), so
 * this is a deliberate swallow and, per CLAUDE.md's error-reporting
 * convention, goes to `reportError` as well as `logger.error`. The reporter is
 * guarded: a throwing one never changes the refund. Pass no reporter (and no
 * logger) where the same order was already allocated — and reported — earlier
 * in the same operation.
 */
export function allocateRefundTaxSharesForOrder(params: {
  /** Tag value — which refund path is allocating. */
  useCase: string;
  /** The order; `taxAmountCents` and the base inputs are read from it. */
  order: {
    id: string;
    amountGrossCents: number;
    feesPlatformCents: number;
    taxAmountCents?: number | null;
    items: Array<{ amountCents: number; meta: unknown; kind?: string }>;
  };
  /** EVERY ticket item of the order, not just the ones being refunded. */
  ticketItems: TicketItemLike[];
  /** ALL of the order's tax lines (`orders.listTaxLines` rows). */
  taxLines: ReadonlyArray<RefundTaxLineLike>;
  logger?: LoggerPort;
  reportError?: ReporterPort | null;
}): OrderRefundTaxShares {
  const { useCase, order, ticketItems, taxLines } = params;
  const orderTaxCents = order.taxAmountCents ?? 0;
  const result = allocateRefundTaxSharesByLine(
    ticketItems,
    orderTaxCents,
    taxLines,
  );

  if (result.perLine) {
    const bases = allocateRefundItemBases(ticketItems, order);
    const perLinePaidByItem = new Map<string, number>();
    for (const item of ticketItems) {
      perLinePaidByItem.set(
        item.id,
        (bases.get(item.id) ?? 0) + (result.shares.get(item.id) ?? 0),
      );
    }
    return { taxByItem: result.shares, perLinePaidByItem };
  }

  if (result.lineMismatch) {
    reportLineMismatch(params, orderTaxCents);
  }
  return { taxByItem: result.shares, perLinePaidByItem: null };
}

function reportLineMismatch(
  params: Parameters<typeof allocateRefundTaxSharesForOrder>[0],
  orderTaxCents: number,
): void {
  const { useCase, order, taxLines } = params;
  const platformLines = taxLines.filter(
    (line) => line.collector === "PLATFORM" && line.amountCents > 0,
  );
  const extra = {
    orderId: order.id,
    orderTaxCents,
    platformLinesTotalCents: platformLines.reduce(
      (sum, line) => sum + line.amountCents,
      0,
    ),
    platformLines: platformLines.map((line) => ({
      code: line.code,
      base: line.base,
      amountCents: line.amountCents,
    })),
  };

  params.logger?.error("refund.tax_lines_mismatch", { useCase, ...extra });
  try {
    params.reportError?.(
      new Error("refund tax lines do not sum to order tax"),
      {
        tags: {
          useCase,
          step: "allocateRefundTaxShares",
          reason: "tax_lines_mismatch",
        },
        extra,
      },
    );
  } catch {
    // A throwing reporter never changes behaviour.
  }
}
