/**
 * The buyer-side fees of a HELD cart, recovered from what the hold persisted.
 *
 * The order row keeps `feesPlatformCents` but not what the buyer funds of it;
 * every ticket line the hold wrote carries the fee mode it was priced under
 * (`meta.effectiveFeeMode`, set by `computeOrderAmounts`). In PASS_THROUGH
 * the buyer funds the whole platform fee — `buyerFeesCents ===
 * feesPlatformCents` after the order-level cap and any waiver, which
 * `computeOrderAmounts` keeps in step — and in ABSORB none of it.
 *
 * Used by the pending-cart read (`getActiveCartHolds`) so a RESUMED held step
 * shows the same total as a fresh one.
 */
export type PendingCartFees = {
  feeMode: "ABSORB" | "PASS_THROUGH" | null;
  buyerFeesCents: number;
};

export function derivePendingCartFees(
  ticketLineMetas: ReadonlyArray<unknown>,
  feesPlatformCents: number,
): PendingCartFees {
  const feeMode =
    ticketLineMetas
      .map(
        (meta) =>
          (meta as { effectiveFeeMode?: unknown } | null)?.effectiveFeeMode,
      )
      .find(
        (mode): mode is "ABSORB" | "PASS_THROUGH" =>
          mode === "ABSORB" || mode === "PASS_THROUGH",
      ) ?? null;
  return {
    feeMode,
    buyerFeesCents: feeMode === "PASS_THROUGH" ? feesPlatformCents : 0,
  };
}

export type PendingCartLine = {
  kind: string;
  amountCents: number;
  meta: unknown;
};

export type PendingCartPricing = PendingCartFees & {
  /**
   * Σ ticket-line `amountCents` — the cart's gross BEFORE any discount.
   * A cart re-saved by `createCheckout` stores `amountGrossCents` AFTER the
   * discount; resuming from that double-applied a member benefit (the
   * preview takes it off again) and lost a typed code's discount on the next
   * charge while step 2 showed it.
   */
  preDiscountGrossCents: number;
  /**
   * The TYPED promo codes the cart was priced with, as the buyer entered
   * them (from its `discount` lines' `meta.code`). Membership benefits are
   * not codes — the preview re-derives them for a signed-in buyer.
   */
  promoCodes: string[];
};

/**
 * Everything a resumed held step needs, from the order's stored lines:
 * buyer-side fees (see `derivePendingCartFees`), the pre-discount gross and
 * the typed codes to restore.
 */
export function derivePendingCartPricing(
  lines: ReadonlyArray<PendingCartLine>,
  feesPlatformCents: number,
): PendingCartPricing {
  const ticketLines = lines.filter((line) => line.kind === "ticket");
  const promoCodes: string[] = [];
  for (const line of lines) {
    if (line.kind !== "discount") continue;
    const code = (line.meta as { code?: unknown } | null)?.code;
    if (
      typeof code === "string" &&
      code.trim() &&
      !promoCodes.some((c) => c.toUpperCase() === code.trim().toUpperCase())
    ) {
      promoCodes.push(code.trim());
    }
  }
  return {
    ...derivePendingCartFees(
      ticketLines.map((line) => line.meta),
      feesPlatformCents,
    ),
    preDiscountGrossCents: ticketLines.reduce(
      (sum, line) => sum + line.amountCents,
      0,
    ),
    promoCodes,
  };
}

