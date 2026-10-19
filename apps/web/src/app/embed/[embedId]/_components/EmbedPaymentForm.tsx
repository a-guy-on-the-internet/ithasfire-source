"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { CreditCard, Lock } from "lucide-react";
import { Spinner, useTranslations } from "@th/ui";
import {
  ExpressCheckoutElement,
  PaymentElement,
  useElements,
  useStripe,
} from "@stripe/react-stripe-js";
import type {
  Stripe,
  StripeElements,
  StripeExpressCheckoutElementConfirmEvent,
} from "@stripe/stripe-js";

import { traceIgnoredError } from "@/lib/trace-ignored-error";

import type { EmbedPaymentFormProps } from "./embed-checkout-types";
import { formatCurrency } from "./embed-helpers";
import { asPaidStatus, type PaidStatus } from "./embed-payment-status";
import { CONFIRM_WATCHDOG_MS, settledWithin } from "./embed-request-timeouts";
import {
  BORDER,
  DANGER,
  DANGER_BG,
  STEEL_BLUE,
  TEXT_MUTED,
  TEXT_ON_BRAND,
  primaryButtonDisabledStyle,
  primaryButtonStyle,
  sectionLabelStyle,
} from "./embed-theme";

const EMBED_PAYMENT_METHOD_ORDER = ["card"];

/**
 * A confirm error that settles the attempt by itself: the card was refused,
 * or the details never left the page. Nothing was charged, so there is
 * nothing to ask Stripe before saying so.
 */
const isDefinitiveError = (type: string | undefined): boolean =>
  type === "card_error" || type === "validation_error";

/** What one `confirmPayment` call came back with. */
type ConfirmAnswer = {
  /** Stripe's message when it refused; null when it did not. */
  error: string | null;
  /** The refusal settles the attempt (`isDefinitiveError`). */
  definitive: boolean;
  /** The PaymentIntent's status when Stripe answered without an error. */
  status: string | null;
  /** False when the call threw: Stripe gave no answer at all. */
  answered: boolean;
};

/** One confirm. Never rejects: a throw is an answer of its own kind. */
async function sendConfirm(
  stripe: Stripe,
  elements: StripeElements,
  clientSecret: string,
): Promise<ConfirmAnswer> {
  try {
    const { error, paymentIntent } = await stripe.confirmPayment({
      elements,
      clientSecret,
      redirect: "if_required",
      confirmParams: {
        return_url: getEmbedPaymentReturnUrl(),
      },
    });
    if (error) {
      return {
        error: error.message ?? "Payment failed. Please try again.",
        definitive: isDefinitiveError(error.type),
        status: null,
        answered: true,
      };
    }
    return {
      error: null,
      definitive: false,
      status: paymentIntent?.status ?? null,
      answered: true,
    };
  } catch (err) {
    traceIgnoredError("embed.confirmPaymentThrew")(err);
    return { error: null, definitive: false, status: null, answered: false };
  }
}

function getEmbedPaymentReturnUrl(): string {
  const url = new URL(
    `${window.location.origin}${window.location.pathname}${window.location.search}`,
  );
  url.searchParams.delete("payment_intent");
  url.searchParams.delete("payment_intent_client_secret");
  url.searchParams.delete("redirect_status");
  return url.toString();
}

export function EmbedPaymentForm({
  clientSecret,
  totalCents,
  currency,
  onSuccess,
  onError,
  onSubmittingChange,
  payDisabled = false,
  confirmingOrder = false,
  onBeforeConfirm,
  onOutcomeUnknown,
  onOrderExpired,
}: EmbedPaymentFormProps) {
  const t = useTranslations();
  const stripe = useStripe();
  const elements = useElements();
  const [isSubmitting, setIsSubmitting] = useState(false);
  // A confirm is in flight. The Pay button also disables on `isSubmitting`,
  // but that is state: it is not set until the next render, and a second
  // submit in the same tick (a double click, or the wallet sheet and the Pay
  // button together) would send a second confirm before it is.
  const inFlightRef = useRef(false);
  // This form's order was paid. The checkout mounts one form per order, so
  // `onSuccess` fires at most once per order however many answers say "paid"
  // (the confirm itself, a status read, a confirm that answers late).
  const succeededRef = useRef(false);
  // A form that is gone reports nothing: by then the page may be on another
  // order, and "paid" from this one must not complete that one.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const succeed = useCallback(
    (status: PaidStatus) => {
      if (succeededRef.current || !mountedRef.current) return;
      succeededRef.current = true;
      onSuccess(status);
    },
    [onSuccess],
  );
  const [paymentError, setPaymentError] = useState<string | null>(null);
  const [isPaymentReady, setIsPaymentReady] = useState(false);
  const [showExpressPay, setShowExpressPay] = useState(false);

  // The checkout locks its Back button while a confirm is in flight (see
  // `onSubmittingChange`). The cleanup reports "not submitting" when the form
  // goes away, so a form unmounted mid-confirm cannot leave Back locked.
  useEffect(() => {
    onSubmittingChange?.(isSubmitting);
    return () => onSubmittingChange?.(false);
  }, [isSubmitting, onSubmittingChange]);

  /**
   * What Stripe says the PaymentIntent is now, or null when it cannot be
   * asked. A confirm that errored or never answered is not proof that nothing
   * was charged (the response can be lost after the charge), so the form asks
   * before it tells the buyer the payment failed and frees them to buy again.
   */
  const readIntentStatus = useCallback(async (): Promise<string | null> => {
    if (!stripe) return null;
    try {
      const { paymentIntent } = await stripe.retrievePaymentIntent(clientSecret);
      if (!paymentIntent) {
        // Stripe answered, with nothing to read: as unknown as no answer.
        traceIgnoredError("embed.paymentStatusUnreadable")(
          new Error("retrievePaymentIntent answered without a PaymentIntent"),
        );
        return null;
      }
      return paymentIntent.status;
    } catch (err) {
      traceIgnoredError("embed.paymentStatusUnreadable")(err);
      return null;
    }
  }, [stripe, clientSecret]);

  /**
   * One confirm, card or wallet. `validate` runs the PaymentElement's own
   * field check first (the wallet sheet has none). Whatever happens, the form
   * stops "submitting" unless the payment went through: a rejected promise
   * must not leave the Pay button, and the checkout's Back, locked for good.
   */
  const confirm = useCallback(
    async (validate: boolean) => {
      if (!stripe || !elements || payDisabled || confirmingOrder) return;
      if (!mountedRef.current) return;
      if (inFlightRef.current || succeededRef.current) return;
      inFlightRef.current = true;
      const notCompleted = String(t("checkout.embedPaymentNotCompleted"));

      setIsSubmitting(true);
      setPaymentError(null);
      // Stays true once paid: the widget asks the server about the order and
      // moves on from this form when it has answered.
      let paid = false;
      const fail = (msg: string) => {
        setPaymentError(msg);
        onError(msg);
      };

      try {
        if (validate) {
          // Validate PaymentElement fields first. Nothing has been sent to
          // charge yet, so a rejection here is a plain failure.
          let submitMessage: string | null = null;
          try {
            const { error: submitError } = await elements.submit();
            if (submitError) {
              submitMessage =
                submitError.message ?? "Please check your payment details.";
            }
          } catch (err) {
            traceIgnoredError("embed.paymentElementSubmitThrew")(err);
            submitMessage = notCompleted;
          }
          if (submitMessage !== null) {
            setPaymentError(submitMessage);
            return;
          }
        }

        onBeforeConfirm?.();
        // Said here as well as from the effect above: on the wallet path
        // this line runs in the same tick as `setIsSubmitting(true)`, before
        // any render, and the widget must know a confirm is out from the
        // moment it is (it never releases an order under one).
        onSubmittingChange?.(true);
        const sent = sendConfirm(stripe, elements, clientSecret);
        let answer = await settledWithin(sent, CONFIRM_WATCHDOG_MS);
        // What Stripe says the PaymentIntent is, when the form has to ask.
        let asked: string | null = null;
        while (answer === null && mountedRef.current) {
          // No answer for `CONFIRM_WATCHDOG_MS`. A buyer in their bank's
          // verification is the one confirm that is slow and still going:
          // that one is waited on, and checked again after the same time.
          asked = await readIntentStatus();
          if (asked !== "requires_action") break;
          answer = await settledWithin(sent, CONFIRM_WATCHDOG_MS);
        }
        if (!mountedRef.current) return;

        // Set once the widget has been told this confirm is still out.
        let reportedStillOut = false;
        if (answer === null) {
          // The form stops waiting, but the confirm may still land. If it
          // answers "paid" while this form is up, the buyer moves on then.
          // If it ends unpaid, the widget is told it is no longer out: only
          // then can Stripe's "nothing was charged" be believed. That holds
          // with this form gone too (the buyer went back and came again): the
          // widget keeps the record, and ignores a report it has none for.
          void sent.then((late) => {
            const latePaid = asPaidStatus(late.status);
            if (latePaid) succeed(latePaid);
            else if (reportedStillOut) onOutcomeUnknown?.("late-settled");
          });
        } else if (answer.answered && answer.error === null) {
          // Stripe's own answer.
          const answeredPaid = asPaidStatus(answer.status);
          if (answeredPaid) {
            paid = true;
            succeed(answeredPaid);
            return;
          }
          setPaymentError(
            answer.status === "requires_action"
              ? "Additional verification is required. Please follow the instructions from your bank."
              : notCompleted,
          );
          return;
        } else if (answer.definitive) {
          fail(answer.error ?? notCompleted);
          return;
        } else {
          // An error that does not settle it, or no answer at all: neither
          // is proof that nothing was charged (see `readIntentStatus`).
          asked = await readIntentStatus();
        }

        const askedPaid = asPaidStatus(asked);
        if (askedPaid) {
          paid = true;
          succeed(askedPaid);
          return;
        }
        if (asked === "canceled") {
          // The reservation ran out and the order was cleaned up. Stripe's
          // message for this is about the PaymentIntent's state, which means
          // nothing to a buyer: the widget says the reservation ran out.
          onOrderExpired?.();
          setPaymentError(notCompleted);
          return;
        }
        if (asked === null || answer === null) {
          // Nobody can say whether the charge landed: Stripe could not be
          // asked, or the confirm is still out there and may yet go through.
          // Never "payment failed" here.
          traceIgnoredError("embed.confirmOutcomeUnknown")(
            new Error(
              answer === null
                ? "confirmPayment gave no answer in time"
                : "confirmPayment failed and the PaymentIntent could not be read",
            ),
          );
          reportedStillOut = answer === null;
          onOutcomeUnknown?.(answer === null ? "still-out" : "settled");
          fail(String(t("checkout.embedPaymentOutcomeUnknown")));
          return;
        }
        fail(answer.error ?? notCompleted);
      } finally {
        inFlightRef.current = false;
        if (!paid) {
          setIsSubmitting(false);
          // The direct `true` above gets a direct `false`: a confirm that
          // ends before `isSubmitting` ever rendered true leaves the effect
          // nothing to re-run on. The outcome is already recorded by here.
          onSubmittingChange?.(false);
        }
      }
    },
    [
      stripe,
      elements,
      clientSecret,
      payDisabled,
      confirmingOrder,
      onBeforeConfirm,
      onSubmittingChange,
      readIntentStatus,
      succeed,
      onError,
      onOutcomeUnknown,
      onOrderExpired,
      t,
    ],
  );

  const handleSubmit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      await confirm(true);
    },
    [confirm],
  );

  // A wallet confirm is a confirm in flight too (see onSubmittingChange), and
  // its failure shows on this step like a card's.
  const handleExpressConfirm = useCallback(
    async (_event: StripeExpressCheckoutElementConfirmEvent) => {
      await confirm(false);
    },
    [confirm],
  );

  return (
    <form
      onSubmit={(event) => {
        void handleSubmit(event);
      }}
      style={{ display: "flex", flexDirection: "column", gap: 16 }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <CreditCard size={14} style={{ color: STEEL_BLUE }} aria-hidden />
        <h3 style={sectionLabelStyle}>Payment details</h3>
      </div>

      <p
        style={{
          margin: "-4px 0 0",
          fontSize: 12,
          lineHeight: 1.5,
          color: TEXT_MUTED,
        }}
      >
        {String(t("checkout.embedPaymentMethodsCaption"))}
      </p>

      {/* Express Pay (Apple Pay / Google Pay) */}
      <div style={{ display: showExpressPay ? "block" : "none" }}>
        <ExpressCheckoutElement
          options={{
            buttonType: { applePay: "buy", googlePay: "buy" },
            buttonTheme: { applePay: "black", googlePay: "black" },
            layout: { maxColumns: 2, maxRows: 1 },
          }}
          onReady={(event) => {
            if (event.availablePaymentMethods) setShowExpressPay(true);
          }}
          onConfirm={handleExpressConfirm}
          onClick={(event) =>
            // No wallet sheet over a confirm that is already in flight, or
            // for an order that is already paid.
            payDisabled ||
            confirmingOrder ||
            inFlightRef.current ||
            succeededRef.current
              ? event.reject()
              : event.resolve()
          }
        />
        {showExpressPay && (
          <div
            style={{
              position: "relative",
              margin: "16px 0",
              display: "flex",
              alignItems: "center",
            }}
          >
            <div style={{ flex: 1, borderTop: `1px solid ${BORDER}` }} />
            <span
              style={{ padding: "0 12px", fontSize: 12, color: TEXT_MUTED }}
            >
              or
            </span>
            <div style={{ flex: 1, borderTop: `1px solid ${BORDER}` }} />
          </div>
        )}
      </div>

      <PaymentElement
        options={{
          layout: "tabs",
          paymentMethodOrder: EMBED_PAYMENT_METHOD_ORDER,
        }}
        onReady={() => setIsPaymentReady(true)}
        onChange={(event) => {
          if (event.complete) setPaymentError(null);
        }}
      />

      {paymentError && (
        <div
          role="alert"
          style={{
            borderRadius: 0,
            background: DANGER_BG,
            padding: "10px 14px",
          }}
        >
          <p
            style={{ fontSize: 12, fontWeight: 500, color: DANGER, margin: 0 }}
          >
            {paymentError}
          </p>
        </div>
      )}

      <button
        type="submit"
        disabled={
          !stripe ||
          !isPaymentReady ||
          isSubmitting ||
          payDisabled ||
          confirmingOrder
        }
        style={{
          ...primaryButtonStyle,
          ...(!stripe ||
          !isPaymentReady ||
          isSubmitting ||
          payDisabled ||
          confirmingOrder
            ? primaryButtonDisabledStyle
            : {}),
        }}
      >
        {confirmingOrder ? (
          // Stripe has answered "paid"; the server is being asked about the
          // order. Not "Processing": the payment itself is done.
          <span
            style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
          >
            <Spinner size="sm" indicatorColor={TEXT_ON_BRAND} />
            {String(t("checkout.embedConfirmingOrder"))}
          </span>
        ) : isSubmitting ? (
          <span
            style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
          >
            <Spinner size="sm" indicatorColor={TEXT_ON_BRAND} />
            Processing...
          </span>
        ) : (
          <span
            style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
          >
            <Lock size={14} />
            Pay {totalCents > 0 ? formatCurrency(totalCents, currency) : ""}
          </span>
        )}
      </button>
    </form>
  );
}
