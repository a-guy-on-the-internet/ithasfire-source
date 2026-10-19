/**
 * fee-preview-math.ts — client-side mirror of the per-ticket fee math, used
 * ONLY to draw the what-if previews on `/platform/fees`.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THIS IS A MIRROR. THE ORIGINAL IS IN CORE.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * The platform-fee formula is owned by
 * `packages/core/src/lib/pricing/compute-ticket-price-for-agreement.ts`:
 *
 *   fee = 0                                                  when face is $0
 *   fee = max( min(round(face × buyerFeePct), maxFeeCents) + platformFixedCents,
 *              minFeeCents )                                 otherwise
 *
 * (A $0 ticket carries no fee: owner ruling 2026-10-10, "If $0 is the cost of
 * the tickets there shouldn't be any fee.")
 *
 * We do not call that function directly because its shape is an order-pricing
 * shape, not a preview shape: it requires a full `PayoutTerms` agreement with
 * at least one payee line, it parses/returns Zod-validated split allocations,
 * and it deliberately computes NO processor fee (processor fees are solved
 * algebraically at the ORDER level in `computeOrderAmounts`). A preview for a
 * single hypothetical ticket has none of that context.
 *
 * So the formula is duplicated — and duplicated code drifts. It already did:
 * the previous inline copy predated `maxFeeCents` and silently ignored the
 * per-ticket cap, which would have projected $1.66 of fee on a $50 ticket
 * against a real charge of 50¢. The guard against a repeat is
 * `__tests__/fee-preview-math.test.ts`, which sweeps a range of face values
 * through BOTH this module and core's real function and asserts they agree
 * cent-for-cent under the live `PLATFORM_FEE_POLICY`. If you change the
 * formula in core and not here, that test goes red.
 *
 * The PROCESSOR fee below is an approximation and is labelled as such on the
 * page: it applies Stripe's headline rate per ticket, whereas checkout solves
 * it once per order. It is directionally right for a projection and is not
 * used for anything a buyer or organiser is ever charged.
 */

export interface FeePreviewPolicy {
  /** Fraction, NOT percent: `0.0333` is 3.33%. */
  buyerFeePct: number;
  /**
   * PER-TICKET cap in cents, or `null` for uncapped. Not to be confused with
   * `maxPlatformFeeCents`, which caps an entire ORDER and therefore has no
   * effect on single-ticket math.
   */
  maxFeeCents: number | null;
  /** Floor in cents, applied AFTER the cap and the fixed component. */
  minFeeCents: number;
  /** Fixed per-ticket component in cents, added on top of the capped pct. */
  platformFixedCents: number;
  /** Fraction, NOT percent: `0.029` is 2.9%. */
  processorFeePct: number;
  /** Stripe's flat per-charge component, in cents. */
  processorFixedCents: number;
}

export interface FeePreview {
  /** Platform fee for one ticket, in cents. */
  platformFee: number;
  /** Approximate processor fee attributable to one ticket, in cents. */
  processorFee: number;
  /** What the buyer pays for one ticket, in cents. */
  buyerTotal: number;
  /** What the organiser keeps from one ticket, in cents. */
  organiserNet: number;
}

/**
 * The per-ticket platform fee. Mirrors
 * `computeTicketPriceForAgreement`'s `platformFeePerTicketCents` exactly —
 * nothing on a $0 ticket; otherwise cap first, then the fixed component, then
 * the floor.
 */
export function platformFeePerTicket(
  unitPriceCents: number,
  policy: FeePreviewPolicy,
): number {
  // A $0 ticket carries no fee, before the fixed component and the floor.
  if (unitPriceCents <= 0) {
    return 0;
  }
  const pctFee = Math.round(unitPriceCents * policy.buyerFeePct);
  const cappedPctFee = Math.min(
    policy.maxFeeCents ?? Number.POSITIVE_INFINITY,
    pctFee,
  );
  const rawFee = cappedPctFee + policy.platformFixedCents;
  return Math.max(rawFee, policy.minFeeCents);
}

/**
 * PASS_THROUGH: the buyer pays face + platform fee + processor fee. A $0
 * ticket pays nothing at all: no platform fee, and a free ticket never reaches
 * the processor, so no processor fee either.
 */
export function computePassThrough(
  unitPriceCents: number,
  policy: FeePreviewPolicy,
): FeePreview {
  if (unitPriceCents <= 0) {
    return { platformFee: 0, processorFee: 0, buyerTotal: 0, organiserNet: 0 };
  }
  const platformFee = platformFeePerTicket(unitPriceCents, policy);
  const processorFee = Math.ceil(
    (unitPriceCents + platformFee) * policy.processorFeePct +
      policy.processorFixedCents,
  );

  return {
    platformFee,
    processorFee,
    buyerTotal: unitPriceCents + platformFee + processorFee,
    organiserNet: unitPriceCents,
  };
}
