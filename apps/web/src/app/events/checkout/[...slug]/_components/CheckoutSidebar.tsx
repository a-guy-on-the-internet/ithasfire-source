"use client";

import { useTranslations } from "@th/ui";

import { OrderSummary } from "./OrderSummary";
import type { PreHoldEstimate } from "./pre-hold-rows";
import type {
  OrderSummaryHeldCharge,
  OrderSummaryMemberDiscount,
  OrderSummaryOrder,
  OrderSummaryProps,
  OrderSummaryTicketType,
  ProcessingMethodRate,
} from "./OrderSummary";
import {
  DIVIDER_COLOR,
  primaryActionHoverProps,
  primaryActionStyle,
  SURFACE_OVERLAY,
} from "./checkout-tokens";

export type CheckoutSidebarProps = {
  ticketTypes: OrderSummaryTicketType[];
  quantities: Record<string, number>;
  selectedQty: number;
  subtotalCents: number;
  /** Step 1's estimate, rendered as step 2's rows (see OrderSummary). Required. */
  preHoldEstimate: PreHoldEstimate | null;
  /** The page's one visible total (see OrderSummary `displayTotalCents`). */
  displayTotalCents?: number | null;
  /** The page's one tax figure (see OrderSummary `displayTaxCents`). */
  displayTaxCents?: number | null;
  /** The held step's solved charge (see OrderSummary `heldCharge`). */
  heldCharge?: OrderSummaryHeldCharge | null;
  /** Pre-hold: an invalid PWYW amount — no estimate to quote. */
  estimateUnavailable?: boolean;
  order: OrderSummaryOrder | null;
  orderId: string | null;
  countdown: string | null;
  isExpired: boolean;
  formatPrice: (cents: number) => string;
  selectedSeatLabels?: Record<string, string[]>;
  platformFeeRateLabel?: string | null;
  processorFeeRateLabel?: string | null;
  processingMethodRates?: ProcessingMethodRate[] | null;
  /** The Taxes row's rate label (see OrderSummary `taxRateBps`). */
  taxRateBps?: number | null;
  /** Every quoted tax line (see OrderSummary `taxImpositions`). */
  taxImpositions?: OrderSummaryProps["taxImpositions"];
  promoCodes?: string[];
  /** Kept codes not applying to the cart right now (see OrderSummary). */
  promoCodeRejections?: Record<string, string>;
  /** The promo preview failed for a non-promo reason (see OrderSummary). */
  promoPreviewUnavailable?: boolean;
  /** The link's code couldn't be checked (see OrderSummary). */
  urlPromoCheckUnavailable?: boolean;
  onApplyPromoCode?: (code: string) => string | null;
  onRemovePromoCode?: (code: string) => void;
  promoInputDisabled?: boolean;
  promoDiscountCents?: number;
  /** Membership-granted discount lines — forwarded to OrderSummary for labelling. */
  memberDiscounts?: OrderSummaryMemberDiscount[] | null;
  isPostCheckout?: boolean;
  /** Effective fee mode — forwarded to OrderSummary for processor-fee display. */
  feeMode?: "ABSORB" | "PASS_THROUGH" | null;
  /** When true, show the "Hold tickets" CTA below the summary. */
  showHoldButton: boolean;
  isHolding: boolean;
  onHoldTickets: () => void;
};

export const CheckoutSidebar = ({
  showHoldButton,
  isHolding,
  onHoldTickets,
  ...orderSummaryProps
}: CheckoutSidebarProps) => {
  const t = useTranslations();
  return (
    <div
      style={{
        borderLeft: `1px solid ${DIVIDER_COLOR}`,
        background: SURFACE_OVERLAY,
        padding: "0",
      }}
      className="checkout-sidebar"
      // Read by checkout.css to drop the summary from the mobile flow until
      // there is something to summarise. An attribute rather than a viewport
      // hook so SSR and the first client render agree.
      data-summary={orderSummaryProps.selectedQty === 0 ? "empty" : "filled"}
    >
      <div
        style={{
          position: "sticky",
          top: 24,
          maxHeight: "calc(100vh - 48px)",
          overflowY: "auto",
        }}
      >
        <div style={{ padding: "24px 24px 32px" }}>
          <OrderSummary {...orderSummaryProps} />

          {showHoldButton && (
            /* Desktop-only. Below 960px the fixed `MobileCTABar` carries this
               same action WITH the running total on it, and the two render
               ~48px apart — measured at 390px, the fixed bar clipped this
               button's lower edge, and both read "Hold tickets" to a screen
               reader. The details step can afford two because it names them
               differently ("Continue to payment" inline vs "Continue" in the
               bar) and the inline one sits in the form's tab order; step 1 has
               no form, so this is a pure duplicate there. See checkout.css. */
            <div className="checkout-sidebar-hold" style={{ marginTop: 20 }}>
              <button
                data-testid="checkout-sidebar-hold-btn"
                type="button"
                className="checkout-primary-action"
                onClick={onHoldTickets}
                disabled={isHolding}
                style={primaryActionStyle(isHolding, {
                  padding: "14px 20px",
                  fontSize: 15,
                })}
                {...primaryActionHoverProps(isHolding)}
              >
                {isHolding
                  ? String(t("checkout.reserving"))
                  : String(t("checkout.holdTickets"))}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

CheckoutSidebar.displayName = "CheckoutSidebar";
