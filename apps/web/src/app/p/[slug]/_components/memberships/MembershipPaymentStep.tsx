"use client";

import { useCallback, useMemo, useState } from "react";
import {
  Elements,
  PaymentElement,
  useElements,
  useStripe,
} from "@stripe/react-stripe-js";
import type { PaymentIntentResult } from "@stripe/stripe-js";
import { useTranslations } from "@th/ui";

import { getStripe } from "@/config/stripe";
import {
  buildStripeAppearance,
  useThemeColors,
} from "@/lib/stripe-appearance-theme";
import styles from "./memberships.module.css";

/**
 * Stripe Elements confirmation step for a `default_incomplete` membership
 * subscription.
 *
 * `startMembership` creates the subscription with no payment method (the
 * platform-owned Customer has never seen a card) and hands back the first
 * invoice's PaymentIntent client secret; this component confirms it. The
 * confirmation attaches the card to the subscription
 * (`save_default_payment_method: "on_subscription"`, so renewals bill it) and
 * Stripe's webhooks flip the membership active server-side.
 *
 * Elements runs in clientSecret mode — NOT the ticket checkout's deferred
 * mode — deliberately: deferred mode requires the Elements amount to match
 * the PaymentIntent at confirm time, and the first invoice's amount includes
 * server-resolved sales tax the browser never knows. With the clientSecret,
 * Stripe reads the amount off the PaymentIntent itself. The provider
 * (`getStripe`) and appearance config are shared with the ticket checkout
 * (`StripePaymentCard`) so the iframes match the app theme the same way.
 */

type PaymentFormProps = {
  onSuccess: () => void;
  onCancel: () => void;
};

const PaymentForm = ({ onSuccess, onCancel }: PaymentFormProps) => {
  const stripe = useStripe();
  const elements = useElements();
  const t = useTranslations();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isPaymentReady, setIsPaymentReady] = useState(false);
  const [paymentError, setPaymentError] = useState<string | null>(null);

  const handleSubmit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (!stripe || !elements) return;

      setIsSubmitting(true);
      setPaymentError(null);

      // confirmPayment can either resolve with `{ error }` (declines,
      // validation) or REJECT outright (IntegrationErrors). Both paths must
      // land in the inline error so the member can retry — mirrors the
      // ticket checkout's handling.
      let result: PaymentIntentResult;
      try {
        result = await stripe.confirmPayment({
          elements,
          redirect: "if_required",
          confirmParams: { return_url: window.location.href },
        });
      } catch (thrown) {
        setPaymentError(
          thrown instanceof Error && thrown.message
            ? thrown.message
            : String(t("entityMemberships.errorPayment")),
        );
        setIsSubmitting(false);
        return;
      }

      if (result.error) {
        setPaymentError(
          result.error.message ??
            String(t("entityMemberships.errorPayment")),
        );
        setIsSubmitting(false);
        return;
      }

      const status = result.paymentIntent?.status;
      if (status === "succeeded" || status === "processing") {
        // Keep isSubmitting true — the parent swaps to the success state.
        // Server-side activation rides the webhooks; the parent's copy says
        // so honestly.
        onSuccess();
        return;
      }

      setPaymentError(String(t("entityMemberships.errorPayment")));
      setIsSubmitting(false);
    },
    [stripe, elements, onSuccess, t],
  );

  return (
    <form
      className={styles.paymentForm}
      onSubmit={(event) => {
        void handleSubmit(event);
      }}
    >
      <PaymentElement
        options={{ layout: "tabs" }}
        onReady={() => setIsPaymentReady(true)}
        onChange={(event) => {
          if (event.complete) setPaymentError(null);
        }}
      />
      {paymentError && (
        <p className={styles.errorText} role="alert">
          {paymentError}
        </p>
      )}
      <div className={styles.formActions}>
        <button
          type="submit"
          className={styles.joinButton}
          disabled={!stripe || !isPaymentReady || isSubmitting}
          aria-busy={isSubmitting}
        >
          {String(
            t(
              isSubmitting
                ? "entityMemberships.processingPayment"
                : "entityMemberships.payNow",
            ),
          )}
        </button>
        <button
          type="button"
          className={styles.secondaryButton}
          onClick={onCancel}
          disabled={isSubmitting}
        >
          {String(t("entityMemberships.paymentFinishLater"))}
        </button>
      </div>
    </form>
  );
};

type Props = {
  /** The first invoice's PaymentIntent client secret from memberships.start. */
  clientSecret: string;
  tierName: string;
  /** Payment confirmed (succeeded or processing) — webhooks finish activation. */
  onSuccess: () => void;
  /** Member backs out — the incomplete membership stays resumable via the portal. */
  onCancel: () => void;
};

export function MembershipPaymentStep({
  clientSecret,
  tierName,
  onSuccess,
  onCancel,
}: Props) {
  const t = useTranslations();
  const themeColors = useThemeColors();

  // Appearance mirrors the ticket checkout's `StripePaymentCard` so the
  // Stripe iframes render on-theme. react-stripe-js applies appearance
  // changes via elements.update() in place — no remount, unlike a
  // clientSecret change (which never happens here: one secret per mount).
  const appearance = useMemo(
    () => buildStripeAppearance(themeColors),
    [themeColors],
  );

  const options = useMemo(
    () => ({ clientSecret, appearance }),
    [clientSecret, appearance],
  );

  return (
    <div className={styles.memberCard}>
      <span className={styles.memberTierName}>{tierName}</span>
      <p className={styles.memberMeta}>
        {String(t("entityMemberships.paymentPrompt"))}
      </p>
      <Elements stripe={getStripe()} options={options}>
        <PaymentForm onSuccess={onSuccess} onCancel={onCancel} />
      </Elements>
    </div>
  );
}
