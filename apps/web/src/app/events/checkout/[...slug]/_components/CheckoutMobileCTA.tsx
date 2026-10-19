"use client";

import { useTranslations } from "@th/ui";

import { MobileCTABar } from "./MobileCTABar";
import type { MobileCTAOrder, MobileCTATicketType } from "./MobileCTABar";
import type { MemberDiscountLine } from "./useCheckoutPromoPreview";
import type { PreHoldEstimate } from "./pre-hold-rows";
import type { CheckoutStepId } from "./CheckoutStepper";

export type CheckoutMobileCTAProps = {
  currentStepId: CheckoutStepId;
  totalLabel: string;
  ticketTypes: MobileCTATicketType[];
  quantities: Record<string, number>;
  formatPrice: (cents: number) => string;
  subtotalCents: number;
  order: MobileCTAOrder | null;
  /** Step 1's estimate, rendered as the tray's rows (see MobileCTABar). Required. */
  preHoldEstimate: PreHoldEstimate | null;
  /** "Taxes (8.88%)" and the Subtotal row, as in the summary (see MobileCTABar). */
  taxRateBps?: number | null;
  isPostCheckout?: boolean;
  selectedSeatLabels?: Record<string, string[]>;
  /** Subtotal of the cart in cents (pre-discount, pre-tax) — used to detect
   *  the "free ticket" pathway for the details-step label. */
  cartSubtotalCents: number;
  isHolding: boolean;
  isPending: boolean;
  payButtonLabel: string;
  platformFeeRateLabel?: string | null;
  processorFeeRateLabel?: string | null;
  /** Effective fee mode — gates the processor-fee row in the breakdown. */
  feeMode?: "ABSORB" | "PASS_THROUGH" | null;
  /** Live promo discount + its member-benefit split (see MobileCTABar). */
  promoDiscountCents?: number;
  memberDiscounts?: MemberDiscountLine[] | null;
  onHoldTickets: () => void;
  onContinueToPayment: () => void;
};

/**
 * Thin wrapper that picks the right CTA label + click handler based on the
 * current step. Pulled out of Checkout.tsx so the parent doesn't carry the
 * step-switch logic inline.
 */
export const CheckoutMobileCTA = ({
  currentStepId,
  totalLabel,
  ticketTypes,
  quantities,
  formatPrice,
  subtotalCents,
  order,
  preHoldEstimate,
  taxRateBps,
  isPostCheckout,
  selectedSeatLabels,
  cartSubtotalCents,
  isHolding,
  isPending,
  payButtonLabel,
  platformFeeRateLabel,
  processorFeeRateLabel,
  feeMode,
  promoDiscountCents,
  memberDiscounts,
  onHoldTickets,
  onContinueToPayment,
}: CheckoutMobileCTAProps) => {
  const t = useTranslations();

  const resolvedLabel =
    currentStepId === "tickets"
      ? isHolding
        ? String(t("checkout.reserving"))
        : String(t("checkout.holdTickets"))
      : currentStepId === "details"
        ? cartSubtotalCents === 0
          ? String(t("checkout.confirmFreeTickets") ?? "Get free tickets")
          : String(t("checkout.continueToPayment"))
        : payButtonLabel;

  return (
    <MobileCTABar
      totalLabel={totalLabel}
      ticketTypes={ticketTypes}
      quantities={quantities}
      formatPrice={formatPrice}
      subtotalCents={subtotalCents}
      order={order}
      preHoldEstimate={preHoldEstimate}
      taxRateBps={taxRateBps}
      isPostCheckout={isPostCheckout}
      selectedSeatLabels={selectedSeatLabels}
      // Payment step deliberately has NO bar CTA: the Stripe Pay button
      // inside the form is the natural primary. Wiring the bar to
      // onContinueToPayment there only re-ran createCheckout; it never
      // confirmed the payment, so it read as a dead "Pay" button.
      onCheckout={
        currentStepId === "tickets"
          ? onHoldTickets
          : currentStepId === "details"
            ? onContinueToPayment
            : undefined
      }
      payButtonLabel={resolvedLabel}
      isPending={currentStepId === "tickets" ? isHolding : isPending}
      platformFeeRateLabel={platformFeeRateLabel}
      processorFeeRateLabel={processorFeeRateLabel}
      feeMode={feeMode}
      promoDiscountCents={promoDiscountCents}
      memberDiscounts={memberDiscounts}
    />
  );
};

CheckoutMobileCTA.displayName = "CheckoutMobileCTA";
