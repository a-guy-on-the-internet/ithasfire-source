import type { ReactNode, RefObject } from "react";
import type { PreHoldEstimate } from "@/app/events/checkout/[...slug]/_components/pre-hold-rows";
import type { TurnstileInstance } from "@marsidev/react-turnstile";
import type { RefundDisclosureCartLine } from "@/app/events/checkout/[...slug]/_components/RefundDisclosure";
import type { EmbedSummaryLine } from "./EmbedSummaryRows";
import type {
  PaidStatus,
  UnknownOutcomeReport,
} from "./embed-payment-status";

import type {
  CartItem,
  CheckoutStep,
  CheckoutStepId,
  EmbedCheckoutConfirmation,
  EmbedOrderFees,
  EmbedOrderLineItem,
} from "./embed-types";

/**
 * The order the payment step charges: what `createGuestCheckout` returned for
 * a paid cart. The widget holds it, not `EmbedCheckout`, so it outlives the
 * checkout unmounting when the buyer steps back to the event detail, and
 * every figure the payment step shows comes from it, never from the cart.
 */
export type EmbedPaymentOrder = {
  clientSecret: string;
  /**
   * The checkout key the order was created under. The widget rotates its key
   * whenever the purchase changes, so an order whose key is no longer the
   * page's was created for a purchase the buyer has left, and is dropped.
   */
  clientKey: string;
  /** The event the order is for (the one the request was sent for). */
  eventId: string;
  /**
   * The cart that was SENT to create this order. The widget hands the order
   * to the checkout only while the page's cart is the same purchase
   * (`isSameEmbedCart`); a changed cart discards it.
   */
  cart: CartItem[];
  orderFees: EmbedOrderFees & { holdExpiresAt: string | null };
  /** The order's lines as the server priced them (see `orderLines`). */
  lineItems: EmbedOrderLineItem[];
};

/**
 * Persisted billing + acceptance draft. `EmbedCheckout` is conditionally
 * mounted (`screen === "checkout"`), so stepping back to the event detail
 * unmounts it and drops all of its local form state. The page holds this
 * draft across that unmount and feeds it back as `initialDraft` so a remount
 * re-seeds the billing fields, promo codes, and acceptances instead of
 * showing a blank form. Mirrors how `guestName` / `guestEmail` already live
 * on the page and survive navigation.
 */
export type EmbedCheckoutDraft = {
  billingLine1: string;
  billingLine2: string;
  billingCity: string;
  billingState: string;
  billingPostalCode: string;
  billingCountry: string;
  promoCodes: string[];
  waiverAccepted: boolean;
  termsAccepted: boolean;
  refundPolicyAccepted: boolean;
};

export type EmbedCheckoutProps = {
  embedId: string;
  eventId: string;
  cart: CartItem[];
  guestName: string;
  guestEmail: string;
  onGuestNameChange: (v: string) => void;
  onGuestEmailChange: (v: string) => void;
  /** Persisted billing + acceptance draft fed back in on remount. */
  initialDraft?: EmbedCheckoutDraft;
  /** Reports the live draft up to the page on every change. */
  onDraftChange?: (draft: EmbedCheckoutDraft) => void;
  clientKey: string;
  /**
   * The order the payment step charges, or null before one exists for THIS
   * cart. Set ⇒ the payment form shows, for this order's PaymentIntent, and
   * the summary prints this order's figures.
   */
  paymentOrder: EmbedPaymentOrder | null;
  checkoutError: string | null;
  checkoutStep: CheckoutStep;
  /**
   * A created order. `paymentOrder` is null for a free order (no
   * PaymentIntent: it completes on the spot). `sentClientKey` is the key the
   * request went out under, known for a free order too.
   *
   * Answers whether the order is now the page's. An order can land long
   * after it was asked for (the checkout stops waiting, the request does
   * not), and by then the buyer may be buying something else: the widget
   * leaves that order behind and answers false, and the checkout does not
   * go on to complete it.
   *
   * Must be safe to call from a render long gone: the checkout calls the one
   * it held when the request was sent.
   */
  onCheckoutCreated: (
    payload: EmbedCheckoutConfirmation,
    paymentOrder: EmbedPaymentOrder | null,
    sentClientKey: string,
  ) => boolean;
  onCheckoutError: (msg: string) => void;
  /**
   * The raw error from a failed `createGuestCheckout`, reported before
   * `onCheckoutError`. The widget owns `clientKey` and decides from it whether
   * the next attempt needs a fresh one (`keepsCheckoutClientKey`).
   */
  onCheckoutFailed: (error: unknown) => void;
  /**
   * Updates the page's cart from its current value. Used after a
   * `seat_price_changed` refusal to re-quote the picked seats at their new
   * prices (see `withRefreshedSeatQuotes`).
   */
  onCartUpdate?: (update: (cart: CartItem[]) => CartItem[]) => void;
  /**
   * The order is ready for its confirmation, as far as the checkout knows.
   * A free order (no `paid`) is complete as created. For a paid one Stripe's
   * browser side said so, with `paid.status` as it named it; the widget then
   * asks the server and shows the confirmation only on its answer.
   */
  onPaymentSuccess: (
    email: string,
    paid?: { clientSecret: string; status: PaidStatus },
  ) => void;
  /**
   * The server is being asked about the order on the payment step. Back is
   * locked with its reason, as while a payment confirms, and the payment
   * form takes no press.
   */
  isConfirming?: boolean;
  /**
   * This load of the widget is a redirect payment's return. A payment made
   * on it does not save a host origin read from the referrer.
   */
  loadedAsRedirectReturn?: boolean;
  /**
   * The latest an order the buyer left behind can keep its tickets reserved
   * (one the widget could not release); null when there is none, or that time has
   * passed. Said beside a refused checkout, where the buyer is looking: those
   * tickets can be the ones the server just called unavailable.
   */
  earlierReservedUntil: string | null;
  /**
   * Stripe says the order's PaymentIntent is canceled: the reservation ran
   * out and the order was cleaned up. The widget discards it as expired.
   */
  onPaymentOrderExpired: () => void;
  /**
   * Settles once no release is out for an order the buyer left for this
   * event (`embeds.releaseGuestOrder`). Awaited before an order is asked
   * for, so the new checkout is not refused by tickets the old order is
   * still giving back. Bounded by the release's own wait; never rejects.
   */
  waitForReleases?: () => Promise<void>;
  /**
   * A payment confirm is in flight with Stripe. Held by the widget: it locks
   * Back here, and holds off discarding an order whose reservation runs out
   * mid-confirm.
   */
  isPaying: boolean;
  onPayingChange: (paying: boolean) => void;
  /**
   * A confirm on the order with this client secret failed or never answered
   * and nobody could say what became of it: the buyer may have been charged.
   * The widget stops saying "you have not been charged" and reminds them to
   * check their email, until Stripe settles it for THAT order. See
   * `UnknownOutcomeReport` for what each report means.
   */
  onPaymentOutcomeUnknown: (
    clientSecret: string,
    report: UnknownOutcomeReport,
  ) => void;
  onBack: () => void;
  stepperStepId: CheckoutStepId;
  completedStepIds: CheckoutStepId[];
  initialPromoCodes?: string[];
};

export type EmbedPaymentFormProps = {
  clientSecret: string;
  totalCents: number;
  currency: string;
  /**
   * Stripe says the order is paid, with the status it gave: "succeeded", or
   * "processing" for a payment that is still clearing. Not yet a confirmed
   * order: the widget asks the server before it shows a confirmation.
   */
  onSuccess: (status: PaidStatus) => void;
  onError: (msg: string) => void;
  /**
   * Whether a confirm is in flight with Stripe. The checkout locks its Back
   * button meanwhile: stepping back and changing the cart discards this
   * order, and a confirm that then lands would charge an order the buyer has
   * left (a second purchase beside the next one).
   */
  onSubmittingChange?: (submitting: boolean) => void;
  /** The order's reservation ran out: nothing may be confirmed any more. */
  payDisabled?: boolean;
  /**
   * The server is being asked about this order after Stripe said it was
   * paid. The Pay button says so and takes no press.
   */
  confirmingOrder?: boolean;
  /**
   * Called right before each `stripe.confirmPayment`. A confirm can send the
   * buyer to a payment page and back, so the checkout saves here what the
   * return will need (the host page's origin: embed-saved-host-origin.ts).
   */
  onBeforeConfirm?: () => void;
  /** See `EmbedCheckoutProps.onPaymentOutcomeUnknown`. */
  onOutcomeUnknown?: (report: UnknownOutcomeReport) => void;
  /** See `EmbedCheckoutProps.onPaymentOrderExpired`. */
  onOrderExpired?: () => void;
};

export type EmbedCheckoutEventDetail = {
  event?: {
    title: string;
    startsAt: Date;
    /** `Event.timezone`: the summary prints the start in it. */
    timezone?: string | null;
    currency: string;
  } | null;
  ticketTypes?: Array<{
    id: string;
    name: string;
    priceCents: number;
    buyerUnitTotalCents?: number | null;
  }>;
};

export type EmbedCheckoutFormSectionProps = {
  guestName: string;
  guestEmail: string;
  onGuestNameChange: (v: string) => void;
  onGuestEmailChange: (v: string) => void;
  promoCodes: string[];
  handleApplyPromoCode: (code: string) => string | null;
  handleRemovePromoCode: (code: string) => void;
  /**
   * The form is submitting: from the Continue press until the create
   * answers. That is while the order is being created AND, before that,
   * while a press is kept waiting on the bot check's token (EmbedCheckout's
   * `isSubmitting`). The button shows as working, and the two inputs the
   * order is made from and keyed by, the email and the promo codes, are
   * locked for all of it. Name, billing and the checkboxes are not.
   */
  isCreating: boolean;
  billingLine1: string;
  billingLine2: string;
  billingCity: string;
  billingState: string;
  billingPostalCode: string;
  billingCountry: string;
  onBillingLine1Change: (v: string) => void;
  onBillingLine2Change: (v: string) => void;
  onBillingCityChange: (v: string) => void;
  onBillingStateChange: (v: string) => void;
  onBillingPostalCodeChange: (v: string) => void;
  onBillingCountryChange: (v: string) => void;
  requiresWaiver: boolean;
  waiverBody: string | null;
  waiverAccepted: boolean;
  onWaiverAcceptedChange: (v: boolean) => void;
  termsAccepted: boolean;
  onTermsAcceptedChange: (v: boolean) => void;
  refundPolicyAccepted: boolean;
  onRefundPolicyAcceptedChange: (v: boolean) => void;
  refundDisclosureCart: RefundDisclosureCartLine[];
  checkoutError: string | null;
  /**
   * Printed under `checkoutError` while there is one: something else that is
   * true and bears on it (see `EmbedCheckoutProps.earlierReservedUntil`).
   */
  checkoutErrorNote?: ReactNode;
  turnstileRef: RefObject<TurnstileInstance | null>;
  turnstileToken: string | null;
  onTurnstileSuccess: (token: string) => void;
  onTurnstileExpire: () => void;
  onTurnstileError: () => void;
  handleCreateCheckout: () => void;
  isFormValid: boolean;
  isFreeOrder: boolean;
  /**
   * Per-field validation error strings (already localized by the parent).
   * `null` when the field is valid OR has not yet been touched / submit not
   * attempted. Drives the red border + helper text + `aria-invalid`.
   */
  fieldErrors: EmbedCheckoutFieldErrors;
  /** Mark a single required field as touched (fired on blur). */
  onFieldBlur: (field: EmbedCheckoutFieldKey) => void;
  /**
   * True once the buyer has clicked "Continue to payment" with an invalid
   * form — gates the inline acceptance error notes (waiver / terms / refund).
   */
  submitAttempted: boolean;
  /** Localized error shown when the waiver box is unchecked after a submit attempt. */
  waiverError: string | null;
  /** Localized error shown when terms / refund acceptance is missing after a submit attempt. */
  acceptanceError: string | null;
  /**
   * Count of required fields currently showing an error. After a submit
   * attempt, drives the validation summary ("N fields need your attention")
   * and whether the "Next field" navigation control is offered.
   */
  invalidFieldCount: number;
  /** Move focus to the next invalid field, cycling through all offenders. */
  onFocusNextInvalid: () => void;
  /**
   * True on standalone (non-iframe) pages where the fixed mobile CTA bar
   * renders and carries the submit action at phone widths — hides the
   * in-form submit button there (≤768px) so the two never collide.
   */
  submitHiddenBehindFixedBar?: boolean;
};

/** Required billing + contact fields that carry inline validation. */
export type EmbedCheckoutFieldKey =
  | "name"
  | "email"
  | "line1"
  | "city"
  | "state"
  | "postalCode"
  | "country";

export type EmbedCheckoutFieldErrors = Record<
  EmbedCheckoutFieldKey,
  string | null
>;

export type EmbedOrderSummarySidebarProps = {
  cart: CartItem[];
  eventDetail: EmbedCheckoutEventDetail | undefined;
  /**
   * Face × qty per ticket type at the shown prices (`embedShownLineCents`):
   * an override seat at the price the seat picker showed. A type missing
   * here prints `priceCents × qty`.
   */
  lineCentsByTicketType?: Readonly<Record<string, number>>;
  /**
   * The order's lines as the server priced them (`embedLinesFromOrder`).
   * Used instead of the cart lines once `orderFees` is set; null keeps the
   * cart lines (the read-back returned none).
   */
  orderLines?: EmbedSummaryLine[] | null;
  orderFees: EmbedOrderFees | null;
  /**
   * The step-1 estimate (`estimateCartTotal`) whose `totalCents` is the total
   * shown — the rows before the order exists come from it. Null while
   * unknown (no fee rows) or for an invalid amount.
   */
  preOrderEstimate?: PreHoldEstimate | null;
  displayTotalCents: number;
  displayTotalLabel: string;
  currency: string;
  platformFeeRateLabel?: string;
  processorFeeRateLabel?: string;
  taxRateBps?: number | null;
  /**
   * Effective fee mode. PASS_THROUGH renders the processor fee as a charged
   * line (and the buyer-facing total — supplied via `displayTotalCents` /
   * `displayTotalLabel` — already includes it); ABSORB / null keeps it as an
   * "Included" estimate excluded from the total.
   */
  feeMode?: "ABSORB" | "PASS_THROUGH" | null;
  countdown: string | null;
  isHoldExpired: boolean;
  /**
   * Keep the summary visible (in-flow, full-width) below the 768px
   * breakpoint instead of hiding it. Used in resize-bridged iframes where
   * the fixed mobile CTA bar (which normally replaces the sidebar on
   * phones) is suppressed because `position: fixed` pins to the iframe's
   * content height, not the visitor's screen.
   */
  forceVisibleOnMobile?: boolean;
};
