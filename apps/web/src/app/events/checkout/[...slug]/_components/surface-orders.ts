/**
 * The order each checkout surface renders, once one exists.
 *
 * The desktop summary and the mobile tray print their Taxes rows from the
 * order they are handed. Checkout built each one inline, and they drifted:
 * with the fee rates unavailable and WELCOME10 applied the summary showed the
 * tax on the discounted base ($4.40) and the tray `order.taxAmountCents ||
 * estimate` ($4.88); after createCheckout the `||` let a cached estimate
 * replace a legitimately stamped $0. Both now carry ONE figure —
 * `useCheckoutDisplayTotal`'s `displayTaxCents`, the tax inside the total.
 */

type SurfaceOrderBase = {
  taxAmountCents?: number | null;
  processorFeeCents: number;
};

/** The summary's order: the page's one tax figure. */
export function summarySurfaceOrder<O extends SurfaceOrderBase>(
  order: O | null,
  displayTaxCents: number | null,
): (O & { taxAmountCents: number }) | null {
  return order ? { ...order, taxAmountCents: displayTaxCents ?? 0 } : null;
}

/**
 * The tray's order: the same tax, and — while held — the solved charge's
 * processing fee (the summary reads it off `heldCharge`), so its rows sum to
 * the total on its button.
 */
export function traySurfaceOrder<O extends SurfaceOrderBase>(
  order: O | null,
  displayTaxCents: number | null,
  heldCharge: { processorFeeCents: number | null } | null,
): (O & { taxAmountCents: number }) | null {
  return order
    ? {
        ...order,
        taxAmountCents: displayTaxCents ?? 0,
        processorFeeCents:
          heldCharge?.processorFeeCents ?? order.processorFeeCents,
      }
    : null;
}
