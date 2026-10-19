/**
 * The platform fee a fee waiver took off a held order: Σ each line's
 * `meta.platformFeeWaivedCents`, which `computeOrderAmounts` stamps on every
 * waived ticket line (the hold prices waivers the same way the charge does).
 *
 * Step 1 can't know a waiver — a buyer's allowance needs them signed in, and
 * an organiser's is a shared, moving balance — so when step 2's platform fee
 * comes in under step 1's estimate, this is what explains the drop.
 */
export function platformFeeWaivedCents(
  items: ReadonlyArray<{ meta?: unknown }> | null | undefined,
): number {
  if (!items) return 0;
  let total = 0;
  for (const item of items) {
    const waived = (item.meta as { platformFeeWaivedCents?: unknown } | null)
      ?.platformFeeWaivedCents;
    if (typeof waived === "number" && Number.isFinite(waived) && waived > 0) {
      total += waived;
    }
  }
  return total;
}

/**
 * The fee waiver to explain for an order on screen. Once `createCheckout`
 * has run, ITS figure (`feeWaivedCents`, what the reservation actually got)
 * is the source: the held lines are still on the snapshot after the merge,
 * and another buyer may have taken the last allowance ticket since the hold
 * — the payment step then showed "Fee waiver applied" beside the full fee.
 * Before that, the held lines are.
 */
export function feeWaivedCentsFor(
  order:
    | {
        feeWaivedCents?: number | null;
        items?: ReadonlyArray<{ meta?: unknown }> | null;
      }
    | null
    | undefined,
): number {
  if (!order) return 0;
  if (typeof order.feeWaivedCents === "number") {
    return Math.max(0, order.feeWaivedCents);
  }
  return platformFeeWaivedCents(order.items);
}

