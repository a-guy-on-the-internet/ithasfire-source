/**
 * The "Original price" line on a resale listing (organiser-resale-share
 * FR-007, FR-009). One place, because the owner has not ruled on a comp or a
 * pay-what-you-want ticket yet (plan: OWNER QUESTION, 2026-10-13). The wording
 * below is the orchestrator's recommendation, shown until the owner decides:
 *
 *   FIXED price            "Original price $40.00"
 *   comp (recorded $0)     "Original price $40.00 · given free" (list price)
 *   pay what you want      "Original price from $5.00" (the type's minimum;
 *                          never the amount the first buyer chose)
 *   no share recorded      no line (a listing from before the share existed)
 *
 * Changing the ruling means changing `originalPriceLine` and three keys.
 */

export type TicketTypePricing = {
  listPriceCents: number;
  pricingMode: "FIXED" | "ADJUSTABLE";
  minimumCents: number | null;
};

export type OriginalPriceLine =
  | { kind: "fixed"; cents: number }
  | { kind: "comp"; cents: number }
  | { kind: "from"; cents: number }
  | null;

export function originalPriceLine(input: {
  originalPriceCents?: number | null;
  /** Null on a listing from before the share existed (a legacy listing). */
  eventShareCents?: number | null;
  ticketTypePricing?: TicketTypePricing | null;
}): OriginalPriceLine {
  const { originalPriceCents, ticketTypePricing } = input;
  // A listing priced before the share existed has no original price to show.
  if (originalPriceCents == null && input.eventShareCents == null) return null;

  // Pay what you want: the public reads send a null original price here (the
  // recorded amount is what the first buyer chose), so this comes first.
  if (ticketTypePricing?.pricingMode === "ADJUSTABLE") {
    const minimum = ticketTypePricing.minimumCents ?? 0;
    // A free minimum has nothing honest to say beyond the amount itself.
    return minimum > 0 ? { kind: "from", cents: minimum } : null;
  }

  if (originalPriceCents == null) return null;

  if (originalPriceCents === 0 && (ticketTypePricing?.listPriceCents ?? 0) > 0) {
    return { kind: "comp", cents: ticketTypePricing!.listPriceCents };
  }

  return { kind: "fixed", cents: originalPriceCents };
}

const ORIGINAL_PRICE_KEYS = {
  fixed: "resell.originalPriceFixed",
  comp: "resell.originalPriceComp",
  from: "resell.originalPriceFrom",
} as const;

/** The translated line, or null when there is none to show. */
export function originalPriceText(
  line: OriginalPriceLine,
  t: (key: string, values?: Record<string, string | number>) => unknown,
  formatCents: (cents: number) => string,
): string | null {
  if (!line) return null;
  return String(t(ORIGINAL_PRICE_KEYS[line.kind], { amount: formatCents(line.cents) }));
}
