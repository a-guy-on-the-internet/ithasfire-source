"use client";

import { CheckoutConfirmedPending } from "./CheckoutConfirmedPending";
import { OrderConfirmation } from "./OrderConfirmation";
import type { ConfirmedPayment } from "./confirmed-payment";
import type {
  ConfirmationOrderItem,
  ConfirmationTicketType,
} from "./OrderConfirmation";

/**
 * The confirmation screen only renders after `createCheckout` has stamped
 * tax onto the order, so `taxAmountCents` is a guaranteed number — not
 * optional, not null. The parent narrows via `isStamped()` before passing.
 */
type OrderForConfirmation = {
  amountGrossCents: number;
  feesPlatformCents: number;
  buyerFeesCents: number;
  processorFeeCents: number | null;
  taxAmountCents: number;
  /** Gates whether the processor fee is part of the confirmed Total. */
  feeMode?: "ABSORB" | "PASS_THROUGH" | null;
  /** Platform credit applied — subtracted from the confirmed Total. */
  creditAppliedCents?: number | null;
  /**
   * Server-stamped per-line pricing from the held order. Forwarded so line
   * items agree with the Subtotal/fee rows (base pricing), mirroring
   * OrderSummary's switch to `item.amountCents` once an order exists.
   */
  items?: ConfirmationOrderItem[];
} | null;

export type CheckoutConfirmedStepProps = {
  orderId: string;
  eventName: string;
  eventSlug: string;
  eventDate: Date;
  /** Forwarded to the confirmation's "Add to calendar" as the .ics UID basis. */
  eventId: string;
  venueName?: string;
  venueAddress?: string;
  eventImageUrl?: string | null;
  order: OrderForConfirmation;
  fallbackSubtotalCents: number;
  ticketTypes: ConfirmationTicketType[];
  quantities: Record<string, number>;
  buyerEmail?: string;
  currency: string;
  selectedSeatLabels?: Record<string, string[]>;
  waiverAccepted?: boolean;
  /**
   * Whether the money moved (see `ConfirmedPayment`). Required: every paid
   * path sets `paid` (a `confirmed` confirm, a SUCCEEDED order, a free
   * order), so nothing defaults to looking paid. `unknown` shows the
   * "couldn't confirm your payment" copy, never the confirmation.
   */
  payment: ConfirmedPayment;
};

export const CheckoutConfirmedStep = ({
  orderId,
  eventName,
  eventSlug,
  eventDate,
  eventId,
  venueName,
  venueAddress,
  eventImageUrl,
  order,
  fallbackSubtotalCents,
  ticketTypes,
  quantities,
  buyerEmail,
  currency,
  selectedSeatLabels,
  waiverAccepted,
  payment,
}: CheckoutConfirmedStepProps) => {
  // Nothing says the money moved (a failed or lost confirm, a status that is
  // neither paid nor processing): the honest terminal copy, with the order's
  // link, as Checkout shows for its other unconfirmed outcomes.
  if (payment === "unknown") {
    return <CheckoutConfirmedPending status="unverified" orderId={orderId} />;
  }
  return (
    <OrderConfirmation
      orderId={orderId}
      eventName={eventName}
      eventSlug={eventSlug}
      eventDate={eventDate}
      eventId={eventId}
      venueName={venueName}
      venueAddress={venueAddress}
      eventImageUrl={eventImageUrl}
      order={
        order
          ? {
              amountGrossCents: order.amountGrossCents,
              feesPlatformCents: order.feesPlatformCents,
              buyerFeesCents: order.buyerFeesCents,
              processorFeeCents: order.processorFeeCents ?? 0,
              taxAmountCents: order.taxAmountCents,
              feeMode: order.feeMode ?? null,
              creditAppliedCents: order.creditAppliedCents ?? 0,
              items: order.items,
            }
          : {
              amountGrossCents: fallbackSubtotalCents,
              feesPlatformCents: 0,
              buyerFeesCents: 0,
              processorFeeCents: 0,
              taxAmountCents: 0,
              feeMode: null,
            }
      }
      ticketTypes={ticketTypes}
      quantities={quantities}
      buyerEmail={buyerEmail}
      currency={currency}
      selectedSeatLabels={selectedSeatLabels}
      waiverAccepted={waiverAccepted}
      payment={payment}
    />
  );
};

CheckoutConfirmedStep.displayName = "CheckoutConfirmedStep";
