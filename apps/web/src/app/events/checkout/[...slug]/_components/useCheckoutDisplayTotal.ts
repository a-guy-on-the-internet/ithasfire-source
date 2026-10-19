import { useEffect, useMemo, useRef, useState } from "react";

import { useTranslations } from "@th/ui";

import {
  estimateHeldTaxFallback,
  type FeeRatesForOrderEstimate,
} from "@/lib/pricing/order-estimate";

import type { CheckoutPhase } from "./useCheckoutState";

type OrderForDisplay = {
  amountGrossCents: number;
  buyerFeesCents: number;
  taxAmountCents?: number | null;
  /**
   * Processor fee in cents. For PASS_THROUGH this is the grossed-up fee the
   * buyer funds (added to the total); for ABSORB it's a display-only estimate
   * (excluded from the total). May arrive as the held simple-markup estimate
   * before `createCheckout` stamps the final gross-up.
   */
  processorFeeCents?: number | null;
  /** Account credit applied to the charge — stamped by `createCheckout`. */
  creditAppliedCents?: number | null;
};

type TaxEstimate = {
  taxRateBps?: number | null;
  taxAmountCents?: number | null;
  /**
   * Every tax line the quote applied (`estimateCheckoutTax.taxImpositions`).
   * The discounted fallback prices each line on its own base from these; a
   * summed `taxRateBps` cannot (two lines may sit on two bases).
   */
  taxImpositions?: FeeRatesForOrderEstimate["taxImpositions"];
};

/**
 * How long a total must hold before the live region announces it: long
 * enough to skip the figures a slider drag or a half-typed amount passes
 * through, short enough to follow a deliberate change.
 */
export const TOTAL_ANNOUNCE_SETTLE_MS = 500;

export type UseCheckoutDisplayTotalArgs = {
  /**
   * The held step's solved charge (`estimateHeldOrderCharge`): tax and the
   * processor gross-up on the DISCOUNTED subtotal, exactly as createCheckout
   * charges. When present it IS the held total; the per-line recompute below
   * is only the fallback while fee rates are unavailable.
   */
  heldCharge?: { totalCents: number; taxCents: number } | null;
  /**
   * Pre-hold only: a selected pay-what-you-want amount is invalid (over the
   * cap, under the minimum, empty). There is then no honest total to quote —
   * the label reads "—", nothing is announced, and the pay label falls back
   * to it. Quoting the invalid amount announced "$16,815.00" for a hold the
   * page was refusing.
   */
  totalUnavailable?: boolean;
  order: OrderForDisplay | null;
  phase: CheckoutPhase;
  isDisplaySubtotalKnown: boolean;
  displaySubtotalCents: number;
  livePromoDiscountCents: number;
  taxEstimate?: TaxEstimate | null;
  /**
   * Effective fee mode. PASS_THROUGH adds the buyer-funded processor fee to
   * the total; ABSORB / null / undefined leaves it out. Comes from
   * `order.feeMode` once `createCheckout` runs, falling back to the fee-rates
   * query's feeMode for the held/selecting phases.
   */
  feeMode?: "ABSORB" | "PASS_THROUGH" | null;
  formatPrice: (cents: number) => string;
};

export type UseCheckoutDisplayTotalResult = {
  displayTotalCents: number | null;
  /**
   * The tax inside `displayTotalCents` (null before an order exists, where
   * the step-1 estimate carries its own). Feed it to every Taxes row.
   */
  displayTaxCents: number | null;
  payButtonLabel: string;
  displayTotalLabel: string;
  /** aria-live announcement string for the SR-only region. */
  liveAnnouncement: string;
};

/**
 * Derive the buyer-facing total + a11y announcement for the checkout page.
 *
 * Mirrors the server's `paymentIntentAmount` formula:
 *   PASS_THROUGH: amountGrossAfterDiscount + buyerFees + processorFee
 *                   + tax_on_discounted_subtotal − creditApplied
 *   ABSORB:       amountGrossAfterDiscount + buyerFees
 *                   + tax_on_discounted_subtotal − creditApplied
 * For PASS_THROUGH the buyer funds the grossed-up processor fee, so it is
 * added to the displayed total. For ABSORB the processor fee is informational
 * only — the buyer doesn't pay it (nor does the seller: with separate charges
 * and transfers it comes out of the platform's balance) — so it is excluded.
 * See
 *   packages/core/src/use-cases/orders/checkout-helpers.ts
 * and the `paymentIntentAmountCents` formula in `create-checkout.ts`.
 */
export function useCheckoutDisplayTotal({
  order,
  phase,
  isDisplaySubtotalKnown,
  displaySubtotalCents,
  livePromoDiscountCents,
  taxEstimate,
  feeMode,
  formatPrice,
  heldCharge,
  totalUnavailable = false,
}: UseCheckoutDisplayTotalArgs): UseCheckoutDisplayTotalResult {
  const t = useTranslations();

  // `paying` / `confirming`: the server's `order.amountGrossCents` is already
  // post-discount and `taxAmountCents` is the final stamped tax. Trust them —
  // don't subtract the discount a second time. Phase decides (not
  // `order.taxAmountCents > 0`): a stamped $0 is a real tax figure.
  const isServerAuthoritative =
    phase === "paying" ||
    phase === "confirming" ||
    phase === "confirmed" ||
    phase === "done";

  /**
   * The page's ONE tax figure once an order exists — the tax inside
   * `displayTotalCents`, and the figure the summary's and the tray's Taxes
   * rows print. Each surface used to work it out for itself: with the fee
   * rates unavailable and WELCOME10 applied, the total and the summary
   * recomputed $4.40 on the discounted base while the tray printed the hold's
   * undiscounted $4.88.
   */
  const displayTaxCents = useMemo<number | null>(() => {
    if (!order) return null;
    // Stamped by createCheckout — $0 included. Never an estimate: `||` let a
    // cached estimate replace a legitimate stamped $0.
    if (isServerAuthoritative) return order.taxAmountCents ?? 0;
    if (heldCharge) return heldCharge.taxCents;
    // `held`, fee rates unavailable: every quoted tax line on its own base
    // over the post-discount subtotal; with no discount, the hold's own tax.
    return estimateHeldTaxFallback(order, {
      discountCents: livePromoDiscountCents,
      feeMode,
      taxImpositions: taxEstimate?.taxImpositions,
      estimateTaxCents: taxEstimate?.taxAmountCents,
    });
  }, [
    order,
    isServerAuthoritative,
    heldCharge,
    livePromoDiscountCents,
    feeMode,
    taxEstimate?.taxImpositions,
    taxEstimate?.taxAmountCents,
  ]);

  const displayTotalCents = useMemo<number | null>(() => {
    // For PASS_THROUGH the buyer funds the processor fee, so include it in
    // both the server-authoritative and held estimates.
    const passThroughProcessorCents =
      feeMode === "PASS_THROUGH" ? (order?.processorFeeCents ?? 0) : 0;
    if (order) {
      const taxCents = displayTaxCents ?? 0;
      if (isServerAuthoritative) {
        // Subtract applied account credit so the label matches the actual
        // PaymentIntent amount (gross + buyerFees + tax − credit) — see
        // `paymentIntentAmountCents` in create-checkout.ts.
        return Math.max(
          0,
          order.amountGrossCents +
            order.buyerFeesCents +
            passThroughProcessorCents +
            taxCents -
            (order.creditAppliedCents ?? 0),
        );
      }
      if (heldCharge) return heldCharge.totalCents;
      // `held`, fee rates unavailable: estimate the post-discount total
      // locally. The held processor fee is a simple-markup estimate (a few
      // cents below the final gross-up), but including it keeps the mid-flow
      // total in the right ballpark for PASS_THROUGH.
      const taxable = Math.max(
        0,
        order.amountGrossCents - livePromoDiscountCents,
      );
      return Math.max(
        0,
        taxable + order.buyerFeesCents + passThroughProcessorCents + taxCents,
      );
    }
    if (totalUnavailable || !isDisplaySubtotalKnown) {
      return null;
    }
    // Pre-hold: `displaySubtotalCents` is `estimateCartTotal` WITH the live
    // discount already priced in (tax and gross-up on the discounted base).
    // Subtracting it again here is what made the visible total and this
    // announcement disagree.
    return Math.max(0, displaySubtotalCents);
  }, [
    heldCharge,
    totalUnavailable,
    order,
    isServerAuthoritative,
    displayTaxCents,
    isDisplaySubtotalKnown,
    displaySubtotalCents,
    livePromoDiscountCents,
    feeMode,
  ]);

  const displayTotalLabel = useMemo(() => {
    if (!order && totalUnavailable) return "—";
    if (!order && !isDisplaySubtotalKnown) {
      return String(t("checkout.calculatingTotal"));
    }
    if (displayTotalCents == null) {
      return String(t("checkout.calculatingTotal"));
    }
    if (displayTotalCents === 0) {
      return String(t("common.free"));
    }
    return formatPrice(displayTotalCents);
  }, [
    displayTotalCents,
    formatPrice,
    isDisplaySubtotalKnown,
    order,
    t,
    totalUnavailable,
  ]);

  /** Dynamic "Pay $35.00" label for the payment button.
   *  Falls back to displayTotalLabel ("Calculating…" / "Free") when no
   *  positive amount is known yet, so consumers never see undefined. */
  const payButtonLabel = useMemo(() => {
    if (displayTotalCents == null || displayTotalCents <= 0) {
      return displayTotalLabel;
    }
    return String(
      t("checkout.payAmount", { amount: formatPrice(displayTotalCents) }),
    );
  }, [displayTotalCents, displayTotalLabel, t, formatPrice]);

  // aria-live: announce total changes for screen readers — once the total
  // SETTLES. The pay-what-you-want slider commits on every move so the visible
  // total follows the handle, and announcing each of those would read out a
  // stream of figures mid-drag; typing "15000" passes through 1, 15, 150 and
  // 1500 the same way. A figure is announced after it has held for
  // `TOTAL_ANNOUNCE_SETTLE_MS`.
  const [liveAnnouncement, setLiveAnnouncement] = useState("");
  const prevTotalRef = useRef(displayTotalCents);
  // Read at announce time, so a new formatter identity never restarts the wait.
  const formatRef = useRef({ formatPrice, t });
  useEffect(() => {
    formatRef.current = { formatPrice, t };
  }, [formatPrice, t]);
  const showsNoFigure =
    (!order && totalUnavailable) ||
    (!order && !isDisplaySubtotalKnown) ||
    displayTotalCents == null;
  useEffect(() => {
    // The announcement reads the SAME value as the visible total. While that
    // shows no figure ("—" for an invalid amount, or "Calculating…"), the
    // live region is EMPTIED at once, not just left alone: typing 15000
    // passes through a valid 1500, whose total was announced and then kept on
    // the live region after the screen turned to "—" — a number the screen no
    // longer showed. Forgetting the last figure also re-announces the next
    // valid total even if it equals the one before.
    if (showsNoFigure) {
      prevTotalRef.current = null;
      setLiveAnnouncement("");
      return;
    }
    if (displayTotalCents == null || displayTotalCents === prevTotalRef.current) {
      return;
    }
    const settledCents = displayTotalCents;
    const timer = setTimeout(() => {
      const { formatPrice: format, t: translate } = formatRef.current;
      // A $0 total is shown as "Free", so announce that, never the last
      // dollar figure.
      setLiveAnnouncement(
        String(
          translate("checkout.totalUpdated", {
            amount:
              settledCents === 0
                ? String(translate("common.free"))
                : format(settledCents),
          }),
        ),
      );
      prevTotalRef.current = settledCents;
    }, TOTAL_ANNOUNCE_SETTLE_MS);
    // A newer total (the handle moved on) replaces this one before it speaks.
    return () => clearTimeout(timer);
  }, [displayTotalCents, showsNoFigure]);

  return {
    displayTotalCents,
    displayTaxCents,
    payButtonLabel,
    displayTotalLabel,
    liveAnnouncement,
  };
}
