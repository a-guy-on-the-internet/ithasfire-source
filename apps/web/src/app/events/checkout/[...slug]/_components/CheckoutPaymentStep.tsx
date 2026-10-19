"use client";

import nextDynamic from "next/dynamic";

import { useTranslations } from "@th/ui";

import { CheckoutTicketSummaryHeader } from "./CheckoutTicketSummaryHeader";
import { StripePaymentCardSkeleton } from "./StripePaymentCardSkeleton";
import type { PaymentSuccessStatus } from "./StripePaymentCard";
import {
  DIVIDER_COLOR,
  sectionHeadingStyle,
  sectionNumStyle,
  sectionPaddingStyle,
} from "./checkout-tokens";

// `loading:` is not optional here. Without it the step renders an EMPTY
// section for as long as the chunk takes — measured at ~1.5s on a Slow 4G
// connection, during which the checkout card collapsed from 952px of filled
// form to 544px and then grew back in a dozen steps as Stripe's iframes
// mounted one at a time. `Checkout.tsx` warms this chunk on the details step,
// so on a healthy connection the skeleton is never seen at all.
//
// This is the only chunk that lands on a STEP TRANSITION. `CheckoutTicketsStep`
// also loads `SeatMapPicker` lazily, but tickets is always the first step, so
// that chunk is already warm by the time anyone can step back to it.
const StripePaymentCard = nextDynamic(
  () =>
    import("./StripePaymentCard").then((m) => ({
      default: m.StripePaymentCard,
    })),
  { ssr: false, loading: () => <StripePaymentCardSkeleton /> },
);

export type CheckoutPaymentStepProps = {
  selectedQty: number;
  onChangeTickets: () => void;
  /** "Change tickets" is off while the order is being paid (see header). */
  changeTicketsDisabled?: boolean;
  /** The payment form's "a Stripe confirm is submitting" (card or wallet). */
  onPaymentSubmittingChange?: (submitting: boolean) => void;
  clientSecret?: string | null;
  /**
   * StripePaymentCard's `onSuccess`, forwarded whole: the PaymentIntent id
   * and the status Stripe gave (`succeeded` / `processing`). The server's
   * `orders.confirmPayment` outcome still decides paid vs. processing; the
   * status only picks the copy if that confirm fails without an order id.
   */
  onPaymentSuccess: (
    paymentIntentId: string,
    paymentIntentStatus: PaymentSuccessStatus,
  ) => void;
  /** StripePaymentCard's `onError`, forwarded whole (see its doc). */
  onPaymentError: (
    message: string,
    code?: string,
    paymentIntentStatus?: string,
    paymentIntentId?: string,
  ) => void;
  totalCents?: number;
  currency: string;
  eventName: string;
  /** Creates the order; resolves with the clientSecret + final charge
   *  amount in cents (PaymentIntent amount), or `null` for free orders. */
  onBeforePayment: () => Promise<{
    clientSecret: string;
    amountCents: number;
  } | null>;
  isCreatingOrder: boolean;
  payButtonLabel: string;
  termsAccepted: boolean;
  refundPolicyAccepted: boolean;
};

export const CheckoutPaymentStep = ({
  selectedQty,
  onChangeTickets,
  changeTicketsDisabled = false,
  onPaymentSubmittingChange,
  clientSecret,
  onPaymentSuccess,
  onPaymentError,
  totalCents,
  currency,
  eventName,
  onBeforePayment,
  isCreatingOrder,
  payButtonLabel,
  termsAccepted,
  refundPolicyAccepted,
}: CheckoutPaymentStepProps) => {
  const t = useTranslations();
  return (
    <>
      <CheckoutTicketSummaryHeader
        selectedQty={selectedQty}
        onChangeTickets={onChangeTickets}
        changeTicketsDisabled={changeTicketsDisabled}
      />
      <div style={{ height: 1, background: DIVIDER_COLOR }} />
      <section
        style={sectionPaddingStyle}
        className="checkout-section-padding"
      >
        <h2 style={sectionHeadingStyle}>
          <span style={sectionNumStyle} aria-hidden>
            03
          </span>
          {String(t("checkout.payment"))}
        </h2>
        {/* The slot, not the card, owns the height reserved while Stripe
            loads, and the value is a CONTAINER QUERY on this measure wrapper
            rather than an inline style or a media query: Stripe reflows on the
            width it is given, and this slot gets WIDER as the viewport gets
            narrower across the 959px grid flip. The wrapper is padding-free so
            its inline size is the slot's. See `.checkout-payment-slot` in
            checkout.css for the measured curve, the thresholds, the re-measure
            trigger, and why the reservation is never released. */}
        <div className="checkout-payment-measure">
          <div className="checkout-payment-slot">
            <StripePaymentCard
              clientSecret={clientSecret}
              onSuccess={onPaymentSuccess}
              onError={onPaymentError}
              totalCents={totalCents}
              currency={currency}
              eventName={eventName}
              onBeforePayment={onBeforePayment}
              isCreatingOrder={isCreatingOrder}
              totalLabel={payButtonLabel}
              disabled={!termsAccepted || !refundPolicyAccepted}
              onSubmittingChange={onPaymentSubmittingChange}
            />
          </div>
        </div>
      </section>
    </>
  );
};

CheckoutPaymentStep.displayName = "CheckoutPaymentStep";
