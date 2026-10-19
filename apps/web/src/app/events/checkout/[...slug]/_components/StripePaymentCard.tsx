"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Elements,
  PaymentElement,
  ExpressCheckoutElement,
  useElements,
  useStripe,
} from "@stripe/react-stripe-js";
import type {
  PaymentIntentResult,
  StripeExpressCheckoutElementConfirmEvent,
} from "@stripe/stripe-js";
import { Lock } from "lucide-react";
import { Button, FormErrorBanner, Spinner, useTranslations } from "@th/ui";

import { getStripe } from "@/config/stripe";
import { traceIgnoredError } from "@/lib/trace-ignored-error";
import {
  buildStripeAppearance,
  useThemeColors,
} from "@/lib/stripe-appearance-theme";
import { FG_MUTED, FS_CAP, FS_SM } from "./checkout-tokens";

// ─────────────────────────────────────────────────────────────────────────────
// Inner form (must be rendered inside <Elements>)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Result of `onBeforePayment` for paid orders. `amountCents` is the
 * server-stamped PaymentIntent amount: Elements runs in deferred mode with a
 * frozen client-side estimate, and Stripe REJECTS `confirmPayment` with an
 * IntegrationError when the Elements amount doesn't match the PaymentIntent
 * at confirm time — so we `elements.update({ amount })` to the final value
 * right before confirming (an in-place update; no remount, the typed card
 * survives). Plain-string results are still accepted, with no re-sync;
 * every current caller returns the amount.
 */
export type BeforePaymentResult = {
  clientSecret: string;
  amountCents: number;
};

/** The PaymentIntent statuses that end the card's submit as accepted. */
export type PaymentSuccessStatus = "succeeded" | "processing";

type OnBeforePayment = () => Promise<BeforePaymentResult | string | null>;

type PaymentFormProps = {
  clientSecret?: string | null;
  /**
   * `paymentIntentStatus` is "processing" for a delayed-notification method
   * (US bank debit): Stripe accepted it but the money has not moved and can
   * still fail. Only "succeeded" is paid.
   */
  onSuccess: (
    paymentIntentId: string,
    paymentIntentStatus: PaymentSuccessStatus,
  ) => void;
  /**
   * `code` is Stripe's error code when Stripe answered the confirm with one,
   * and `paymentIntentStatus` the PaymentIntent's status when Stripe returned
   * it. `payment_intent_unexpected_state` comes back both for a PaymentIntent
   * cancelled since the order was made ("canceled": a dead order) and for
   * one already paid ("succeeded"), so a caller reads the status to tell.
   * `paymentIntentId` comes with it when Stripe returned the PaymentIntent,
   * so an already-accepted payment can be confirmed with the server.
   */
  onError: (
    message: string,
    code?: string,
    paymentIntentStatus?: string,
    paymentIntentId?: string,
  ) => void;
  /**
   * Called before confirming payment. Must create the order and return the
   * Stripe clientSecret (plus the final charge amount, see
   * `BeforePaymentResult`). Returns `null` for free orders (no card charge
   * needed). If not provided, falls back to the existing `clientSecret` prop.
   */
  onBeforePayment?: OnBeforePayment;
  /** True while the parent is creating the order (used to disable the button) */
  isCreatingOrder?: boolean;
  /** Formatted total label for the pay button, e.g. "Pay $35.00" */
  totalLabel?: string;
  /** When true, disables the pay button (e.g. T&C not yet accepted). */
  disabled?: boolean;
  /** Reports `isSubmitting` (see StripePaymentCard `onSubmittingChange`). */
  onSubmittingChange?: (submitting: boolean) => void;
};

const PaymentForm = ({
  clientSecret,
  onSuccess,
  onError,
  onBeforePayment,
  isCreatingOrder,
  totalLabel,
  disabled,
  onSubmittingChange,
}: PaymentFormProps) => {
  const stripe = useStripe();
  const elements = useElements();
  const t = useTranslations();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [paymentError, setPaymentError] = useState<string | null>(null);
  const [isPaymentReady, setIsPaymentReady] = useState(false);
  /** The Payment Element's selected method is a US bank debit (ACH). */
  const [isBankDebit, setIsBankDebit] = useState(false);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();

      if (disabled) return;
      if (!stripe || !elements) return;

      setIsSubmitting(true);
      setPaymentError(null);

      // Every path that does not end in a Stripe success clears
      // `isSubmitting` — a THROW included (a rejected `elements.submit()`):
      // it used to stay true, leaving the button dead and Checkout's hold
      // auto-reset and way back held off on a dead hold.
      let succeeded = false;
      try {
        // Validate PaymentElement fields first
        const { error: submitError } = await elements.submit();
        if (submitError) {
          setPaymentError(
            submitError.message ?? "Please check your payment details.",
          );
          return;
        }

        // Step 1: create order + get clientSecret if callback is provided
        let secret = clientSecret;
        let finalAmountCents: number | null = null;
        if (onBeforePayment) {
          try {
            const result = await onBeforePayment();
            if (result === null) {
              // Free order — no card charge needed; parent already transitioned to confirmed
              return;
            }
            if (typeof result === "string") {
              secret = result;
            } else {
              secret = result.clientSecret;
              finalAmountCents = result.amountCents;
            }
          } catch {
            // Error is already dispatched by the parent hook
            return;
          }
        }

        if (!secret) {
          setPaymentError(
            "Payment is being prepared — please wait a moment and try again.",
          );
          return;
        }

        // Deferred-mode Elements were initialised with a frozen client-side
        // estimate (see the FREEZE comment below). Stripe requires the Elements
        // amount to equal the PaymentIntent amount at confirm time, otherwise
        // confirmPayment REJECTS with an IntegrationError — so re-sync to the
        // server-stamped amount. `update()` mutates the existing Elements group
        // in place: no remount, the typed card survives.
        if (finalAmountCents != null && finalAmountCents > 0) {
          try {
            elements.update({ amount: finalAmountCents });
          } catch {
            // Elements may have been created without payment-mode options
            // (totalCents unknown at init). confirmPayment surfaces any real
            // mismatch below.
          }
        }

        // Step 2: confirm payment with Stripe (supports all payment methods).
        // confirmPayment can either resolve with `{ error }` (card declines,
        // validation) or REJECT outright (IntegrationErrors such as an
        // amount mismatch or an unmounted Payment Element). Both paths must
        // land in the error banner — an uncaught rejection here used to wipe
        // the form silently with no feedback to the buyer.
        let confirmResult: PaymentIntentResult;
        try {
          confirmResult = await stripe.confirmPayment({
            elements,
            clientSecret: secret,
            redirect: "if_required",
            confirmParams: {
              return_url: window.location.href,
            },
          });
        } catch (thrown) {
          const msg =
            thrown instanceof Error && thrown.message
              ? thrown.message
              : (t("checkout.paymentFailed") as string);
          setPaymentError(msg);
          onError(msg);
          return;
        }
        const { error, paymentIntent } = confirmResult;

        if (error) {
          const msg = error.message ?? (t("checkout.paymentFailed") as string);
          // An already-accepted PaymentIntent pressed again is not a failure:
          // the parent confirms it, so no red banner flashes first.
          const alreadyAccepted =
            error.code === "payment_intent_unexpected_state" &&
            (error.payment_intent?.status === "succeeded" ||
              error.payment_intent?.status === "processing");
          if (!alreadyAccepted) setPaymentError(msg);
          onError(
            msg,
            error.code,
            error.payment_intent?.status,
            error.payment_intent?.id,
          );
          return;
        }

        if (paymentIntent?.status === "succeeded") {
          succeeded = true;
          onSuccess(paymentIntent.id, "succeeded");
          // Keep isSubmitting true — the parent will redirect or show success
          return;
        }

        if (paymentIntent?.status === "processing") {
          // Delayed notification methods (ACH Direct Debit, bank transfer).
          // The payment is in flight and can still fail days later; Stripe
          // fires a webhook when it settles, and only `succeeded` issues
          // tickets. The caller gets "processing" so it can say the payment
          // is pending rather than confirmed.
          succeeded = true;
          onSuccess(paymentIntent.id, "processing");
          return;
        }

        if (paymentIntent?.status === "requires_action") {
          // Some methods need additional action (e.g. microdeposit
          // verification for ACH). Stripe Elements handles the UI
          // automatically; if we reach here it means it wasn't resolved.
          setPaymentError(
            "Additional verification is required. Please follow the on-screen instructions.",
          );
          return;
        }

        // Unexpected status
        setPaymentError(t("checkout.paymentCouldNotComplete") as string);
      } catch (err) {
        // Unexpected (a rejected `elements.submit()`, say) — no longer an
        // unhandled rejection Sentry would catch, so report it here.
        traceIgnoredError("checkout.cardSubmit")(err);
        // A throw AFTER Stripe succeeded (from `onSuccess`) is not a failed
        // payment: the charge went through and the parent is confirming it.
        if (succeeded) return;
        setPaymentError(t("checkout.paymentFailed") as string);
      } finally {
        // The only reset: every path short of a Stripe success lands here.
        if (!succeeded) setIsSubmitting(false);
      }
    },
    [
      stripe,
      elements,
      clientSecret,
      onSuccess,
      onError,
      onBeforePayment,
      disabled,
      t,
    ],
  );

  useEffect(() => {
    onSubmittingChange?.(isSubmitting);
  }, [isSubmitting, onSubmittingChange]);

  return (
    <form
      onSubmit={(event) => {
        void handleSubmit(event);
      }}
      style={{ display: "flex", flexDirection: "column", gap: 20 }}
    >
      {/* Unified Stripe PaymentElement — renders card, wallets and ACH
           bank debit. paymentMethodOrder controls display ordering. BNPL
           methods (Klarna, Afterpay, Affirm) are excluded at the PI level.
           Amazon Pay and Cash App Pay are not offered: the owner turned
           them off in Stripe on 2026-10-13 (reversing 2026-10-12). */}
      <div>
        <PaymentElement
          options={{
            layout: "tabs",
            paymentMethodOrder: [
              "card",
              "apple_pay",
              "google_pay",
              "us_bank_account",
            ],
          }}
          onReady={() => setIsPaymentReady(true)}
          onChange={(event) => {
            if (event.complete) setPaymentError(null);
            setIsBankDebit(event.value?.type === "us_bank_account");
          }}
        />
        {/* Said BEFORE paying: a bank debit is not a confirmed purchase
            until it clears (owner, 2026-10-14). Shared with resale. The
            live region stays mounted so picking the bank tab is announced;
            empty, it is 0px tall (the note carries its own top margin). */}
        <div aria-live="polite" data-testid="bank-debit-live-region">
          {isBankDebit && (
            <p
              data-testid="bank-debit-notice"
              style={{
                margin: "10px 0 0",
                fontSize: FS_SM,
                lineHeight: 1.5,
                color: FG_MUTED,
              }}
            >
              {String(t("checkout.bankDebitNotice"))}
            </p>
          )}
        </div>
      </div>

      {/* Inline error */}
      <FormErrorBanner message={paymentError} />

      {/* Submit */}
      <Button
        variant="primary"
        size="$5"
        width="100%"
        borderRadius="$0"
        marginTop="$2"
        // @ts-expect-error -- Tamagui Button renders <button> on web; type="submit" triggers form submission
        type="submit"
        disabled={
          !stripe ||
          !isPaymentReady ||
          isSubmitting ||
          isCreatingOrder ||
          disabled
        }
      >
        {isSubmitting || isCreatingOrder ? (
          <>
            <Spinner size="sm" indicatorColor="$colorInverted" />
            {String(t("checkout.processing"))}
          </>
        ) : (
          <>
            <Lock size={16} />
            {totalLabel ?? String(t("checkout.payNow"))}
          </>
        )}
      </Button>
    </form>
  );
};

/**
 * Keeps the mounted Elements group on the current theme. The options handed
 * to `<Elements>` are frozen (see `StripePaymentCard`), so a theme switch after
 * the first render would never reach Stripe; this pushes the new appearance
 * with `elements.update` — in place, no remount. Skips the first run: the
 * initial appearance is already in the options.
 */
const StripeAppearanceSync = ({
  appearance,
}: {
  appearance: ReturnType<typeof buildStripeAppearance>;
}) => {
  // Keyed on the APPEARANCE only: the Elements handle is read through a ref,
  // so a re-render never re-sends an unchanged theme.
  const elements = useElements();
  const elementsRef = useRef(elements);
  elementsRef.current = elements;
  const firstRef = useRef(true);
  useEffect(() => {
    if (firstRef.current) {
      firstRef.current = false;
      return;
    }
    elementsRef.current?.update({ appearance });
  }, [appearance]);
  return null;
};

/**
 * Keeps the mounted Elements group's AMOUNT on `amount`, for every caller.
 * The options handed to `<Elements>` are frozen, so without this a wallet
 * sheet (Apple Pay / Google Pay) keeps showing the first amount after the
 * caller's total changed (a promo, the fee rates or tax arriving), and the
 * buyer authorises a figure that is not the one on the page. `elements.update` is in place:
 * no remount, a typed card survives. Skips an amount equal to the one
 * already in Elements (the frozen initial one included).
 */
const StripeAmountSync = ({
  amount,
  initialAmount,
}: {
  amount: number | undefined;
  initialAmount: number;
}) => {
  const elements = useElements();
  const lastRef = useRef(initialAmount);
  useEffect(() => {
    if (!elements || !amount || amount <= 0 || amount === lastRef.current) {
      return;
    }
    try {
      elements.update({ amount });
      lastRef.current = amount;
    } catch {
      // Non-payment-mode Elements; the confirm path re-syncs before paying.
    }
  }, [elements, amount]);
  return null;
};

// ─────────────────────────────────────────────────────────────────────────────
// Express checkout (Apple Pay / Google Pay) — inside <Elements>
// ─────────────────────────────────────────────────────────────────────────────

type ExpressPayProps = {
  clientSecret?: string | null;
  /**
   * `paymentIntentStatus` is "processing" for a delayed-notification method
   * (US bank debit): Stripe accepted it but the money has not moved and can
   * still fail. Only "succeeded" is paid.
   */
  onSuccess: (
    paymentIntentId: string,
    paymentIntentStatus: PaymentSuccessStatus,
  ) => void;
  /**
   * `code` is Stripe's error code when Stripe answered the confirm with one,
   * and `paymentIntentStatus` the PaymentIntent's status when Stripe returned
   * it. `payment_intent_unexpected_state` comes back both for a PaymentIntent
   * cancelled since the order was made ("canceled": a dead order) and for
   * one already paid ("succeeded"), so a caller reads the status to tell.
   * `paymentIntentId` comes with it when Stripe returned the PaymentIntent,
   * so an already-accepted payment can be confirmed with the server.
   */
  onError: (
    message: string,
    code?: string,
    paymentIntentStatus?: string,
    paymentIntentId?: string,
  ) => void;
  onBeforePayment?: OnBeforePayment;
  disabled?: boolean;
  /**
   * True from the wallet's confirm until it fails (or until the parent moves
   * on after a success) — the card form's `isSubmitting`, for the wallet.
   */
  onSubmittingChange?: (submitting: boolean) => void;
  /**
   * The card form is submitting: the wallet stays MOUNTED (unmounting the
   * ExpressCheckoutElement on every card Pay jumped the layout ~90px and
   * churned the element mid-confirm) but is hidden, inert, and refuses to
   * start a second checkout.
   */
  paused?: boolean;
};

const ExpressPay = ({
  clientSecret,
  onSuccess,
  onError,
  onBeforePayment,
  disabled,
  onSubmittingChange,
  paused = false,
}: ExpressPayProps) => {
  const t = useTranslations();
  const stripe = useStripe();
  const elements = useElements();
  const [visible, setVisible] = useState(false);

  const handleConfirm = useCallback(
    async (event: StripeExpressCheckoutElementConfirmEvent) => {
      // Every return BEFORE `confirmPayment` must tell the wallet so: its
      // sheet (Apple Pay / Google Pay) otherwise stays up, spinning, over a
      // checkout that is not going to happen. Once `confirmPayment` runs,
      // Stripe owns the sheet.
      let confirmStarted = false;
      const failSheet = () => {
        if (confirmStarted) return;
        try {
          event.paymentFailed({ reason: "fail" });
        } catch {
          // Already resolved / no sheet: nothing to close.
        }
      };
      if (disabled || paused || !stripe || !elements) {
        failSheet();
        return;
      }
      onSubmittingChange?.(true);
      // Cleared on every path but a Stripe success — a throw included.
      let succeeded = false;
      try {
        // Deferred-intent mode requires elements.submit() before
        // confirmPayment — it validates and collects the wallet's payment
        // details. The card path does this in PaymentForm.handleSubmit;
        // skipping it here makes confirmPayment reject with an
        // IntegrationError.
        const { error: submitError } = await elements.submit();
        if (submitError) {
          failSheet();
          onError(submitError.message ?? "Payment failed");
          return;
        }

        // Create the order and get a fresh clientSecret if needed
        let secret = clientSecret;
        let finalAmountCents: number | null = null;
        if (onBeforePayment) {
          try {
            const result = await onBeforePayment();
            if (result === null) {
              // A free (credit-covered) order: confirmed, nothing for the
              // wallet to charge. Stripe has no way to close the sheet as a
              // success without `confirmPayment`; `paymentFailed` is the only
              // close, and its reason defaults to "fail", so a wallet may
              // still title it "Payment Not Completed". What IS guaranteed:
              // the sheet closes with this message instead of hanging, and
              // the page under it is the confirmation (handleCheckout
              // dispatched CHECKOUT_FREE_ORDER before returning null).
              confirmStarted = true;
              try {
                event.paymentFailed({
                  message: String(t("checkout.walletNoChargeNeeded")),
                });
              } catch {
                // No sheet to close.
              }
              return;
            }
            if (typeof result === "string") {
              secret = result;
            } else {
              secret = result.clientSecret;
              finalAmountCents = result.amountCents;
            }
          } catch (error) {
            failSheet();
            console.warn("[stripe-payment] onBeforePayment failed", error);
            return;
          }
        }
        if (!secret) {
          failSheet();
          return;
        }

        // Sync the deferred-mode Elements amount to the server-stamped charge —
        // a mismatch makes confirmPayment REJECT with an IntegrationError.
        if (finalAmountCents != null && finalAmountCents > 0) {
          try {
            elements.update({ amount: finalAmountCents });
          } catch {
            // Non-payment-mode Elements; confirmPayment surfaces any mismatch.
          }
        }

        // confirmPayment can REJECT (IntegrationError) as well as resolve with
        // `{ error }` — surface both so the wallet flow never fails silently.
        let confirmResult: PaymentIntentResult;
        try {
          confirmStarted = true;
          confirmResult = await stripe.confirmPayment({
            elements,
            clientSecret: secret,
            redirect: "if_required",
            confirmParams: { return_url: window.location.href },
          });
        } catch (thrown) {
          onError(
            thrown instanceof Error && thrown.message
              ? thrown.message
              : "Payment failed",
          );
          return;
        }
        const { error, paymentIntent } = confirmResult;

        if (error) {
          onError(
            error.message ?? "Payment failed",
            error.code,
            error.payment_intent?.status,
            error.payment_intent?.id,
          );
        } else if (
          paymentIntent?.status === "succeeded" ||
          paymentIntent?.status === "processing"
        ) {
          // Still "submitting": the parent confirms and moves on.
          succeeded = true;
          onSuccess(paymentIntent.id, paymentIntent.status);
        }
      } catch (thrown) {
        traceIgnoredError("checkout.walletSubmit")(thrown);
        failSheet();
        // Thrown after Stripe succeeded (from `onSuccess`): the charge went
        // through — never report it to the parent as a failed payment, which
        // dropped the buyer back to details over a completed charge.
        if (succeeded) return;
        onError(
          thrown instanceof Error && thrown.message
            ? thrown.message
            : "Payment failed",
        );
      } finally {
        if (!succeeded) onSubmittingChange?.(false);
      }
    },
    [
      stripe,
      elements,
      clientSecret,
      onSuccess,
      onError,
      onBeforePayment,
      disabled,
      onSubmittingChange,
      paused,
      t,
    ],
  );

  // Only the terms gate unmounts it.
  if (disabled) return null;

  return (
    <div
      data-testid="express-pay"
      aria-hidden={paused || undefined}
      // Out of the tab order and the a11y tree while paused, not just hidden.
      inert={paused || undefined}
      style={{
        display: visible ? "block" : "none",
        marginBottom: 16,
        // Paused: height kept, nothing visible or clickable.
        ...(paused
          ? { visibility: "hidden" as const, pointerEvents: "none" as const }
          : {}),
      }}
    >
      <ExpressCheckoutElement
        options={{
          buttonType: { applePay: "buy", googlePay: "buy" },
          buttonTheme: { applePay: "black", googlePay: "black" },
          layout: { maxColumns: 2, maxRows: 1 },
        }}
        onConfirm={(event) => {
          void handleConfirm(event);
        }}
        onReady={(event) => {
          // Only show the section when at least one wallet is available
          if (event.availablePaymentMethods) setVisible(true);
        }}
        onClick={(event) => event.resolve()}
      />
      {/* Visual divider between express pay and the card form */}
      {visible && (
        <div
          style={{
            position: "relative",
            margin: "16px 0",
            display: "flex",
            alignItems: "center",
          }}
        >
          <div
            style={{ flex: 1, borderTop: "1px solid var(--borderColorSoft, rgba(33,28,22,0.3))" }}
          />
          <span
            style={{
              padding: "0 12px",
              fontSize: FS_CAP,
              color: "var(--colorMuted, #5C544A)",
            }}
          >
            or
          </span>
          <div
            style={{ flex: 1, borderTop: "1px solid var(--borderColorSoft, rgba(33,28,22,0.3))" }}
          />
        </div>
      )}
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Public wrapper
// ─────────────────────────────────────────────────────────────────────────────

export type StripePaymentCardProps = {
  clientSecret?: string | null;
  /**
   * Called with the PaymentIntent ID once Stripe accepts the payment.
   * `paymentIntentStatus` is "processing" for a delayed-notification method
   * (US bank debit): Stripe accepted it but the money has not moved and can
   * still fail. Only "succeeded" is paid.
   */
  onSuccess: (
    paymentIntentId: string,
    paymentIntentStatus: PaymentSuccessStatus,
  ) => void;
  /**
   * `code` is Stripe's error code when Stripe answered the confirm with one,
   * and `paymentIntentStatus` the PaymentIntent's status when Stripe returned
   * it. `payment_intent_unexpected_state` comes back both for a PaymentIntent
   * cancelled since the order was made ("canceled": a dead order) and for
   * one already paid ("succeeded"), so a caller reads the status to tell.
   * `paymentIntentId` comes with it when Stripe returned the PaymentIntent,
   * so an already-accepted payment can be confirmed with the server.
   */
  onError: (
    message: string,
    code?: string,
    paymentIntentStatus?: string,
    paymentIntentId?: string,
  ) => void;
  /** Total in cents, used for express pay (Apple Pay / Google Pay) */
  totalCents?: number;
  /** Currency code for express pay */
  currency?: string;
  /** Event name label for express pay */
  eventName?: string;
  /**
   * Single-click checkout: called before confirming card payment.
   * Must create the order and return the Stripe clientSecret (plus the
   * final server-stamped charge amount — see `BeforePaymentResult`).
   * Returns `null` for free orders.
   */
  onBeforePayment?: OnBeforePayment;
  /** True while createCheckout mutation is in flight */
  isCreatingOrder?: boolean;
  /** Formatted label for the pay button, e.g. "Pay $35.00" */
  totalLabel?: string;
  /** When true, disables the pay button (e.g. T&C not yet accepted). */
  disabled?: boolean;
  /**
   * False hides the wallet buttons (Apple Pay / Google Pay). A wallet sheet
   * shows `totalCents` as the amount, so a caller that cannot yet name the
   * real charge turns them off rather than show a lower figure. Default true.
   */
  expressPay?: boolean;
  /**
   * True while a Stripe confirm is being submitted — card or wallet — and
   * false again when it fails (it stays true after a success, which the
   * parent moves on from); false on unmount. Checkout uses it to keep the
   * hold from being reset, or released, under a charge that may succeed.
   */
  onSubmittingChange?: (submitting: boolean) => void;
};

export const StripePaymentCard = ({
  clientSecret,
  onSuccess,
  onError,
  totalCents,
  currency,
  eventName: _eventName,
  onBeforePayment,
  isCreatingOrder,
  totalLabel,
  disabled,
  expressPay = true,
  onSubmittingChange,
}: StripePaymentCardProps) => {
  const themeColors = useThemeColors();

  // Card form OR wallet — either one submitting is "submitting".
  const [formSubmitting, setFormSubmitting] = useState(false);
  const [walletSubmitting, setWalletSubmitting] = useState(false);
  const submitting = formSubmitting || walletSubmitting;
  const onSubmittingChangeRef = useRef(onSubmittingChange);
  onSubmittingChangeRef.current = onSubmittingChange;
  useEffect(() => {
    onSubmittingChangeRef.current?.(submitting);
  }, [submitting]);
  useEffect(() => () => onSubmittingChangeRef.current?.(false), []);

  const elementsAppearance = useMemo(
    () => buildStripeAppearance(themeColors),
    [themeColors],
  );

  // Always run Elements in deferred mode. Earlier this branched into
  // clientSecret-mode the moment a secret arrived, which forced a
  // <Elements> remount (key={clientSecret ?? "deferred"}). That remount
  // tore down the PaymentElement iframe just after the buyer saw it —
  // the "card inputs flash in then disappear" bug. In deferred mode the
  // secret is only needed at confirm time and gets passed directly to
  // `stripe.confirmPayment({ elements, clientSecret })` below; Elements
  // never needs to be re-initialised.
  //
  // IMPORTANT: paymentMethodTypes must stay in sync with the Stripe
  // Dashboard PMC. Anything declared here that isn't toggled on at
  // Settings → Payment methods will silently break PaymentElement
  // rendering. It must also stay in sync with the adapter's
  // `paymentMethodsForCurrency`: Amazon Pay and Cash App Pay were dropped
  // from both on 2026-10-13, when the owner turned them off in Stripe.
  //
  // FREEZE: once we hand Stripe its first valid payment-mode options
  // object, we keep returning the SAME reference for the rest of the
  // checkout. The buyer's `totalCents` shifts mid-flow (held estimate
  // → server-stamped final on click-Pay; usually a few-cent tax delta)
  // and React's <Elements> wrapper interprets a new options object as
  // grounds to re-initialise Stripe — which unmounts PaymentElement
  // and wipes the card the buyer just typed. The actual charge amount
  // is taken from the clientSecret at confirm time, not from these
  // options, so freezing here doesn't affect what the buyer pays.
  //
  // `appearance` rides along in the frozen object, but a theme change after
  // that (light ↔ dark) still reaches Stripe: `StripeAppearanceSync` pushes
  // it with `elements.update({ appearance })`, which restyles in place
  // without re-initialising (the typed card survives).
  const frozenElementsOptionsRef = useRef<{
    mode: "payment";
    amount: number;
    currency: string;
    paymentMethodTypes: string[];
    appearance: typeof elementsAppearance;
  } | null>(null);
  const elementsOptions = useMemo(() => {
    if (frozenElementsOptionsRef.current) {
      return frozenElementsOptionsRef.current;
    }
    if (totalCents && currency) {
      frozenElementsOptionsRef.current = {
        mode: "payment" as const,
        amount: totalCents,
        currency: currency.toLowerCase(),
        paymentMethodTypes: ["card", "us_bank_account"],
        appearance: elementsAppearance,
      };
      return frozenElementsOptionsRef.current;
    }
    return { appearance: elementsAppearance };
  }, [totalCents, currency, elementsAppearance]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Payment form — single Elements provider for the lifetime of the
          card. Deferred mode means we never need to remount when the
          clientSecret arrives; confirmPayment receives the secret as a
          parameter and Stripe handles the handoff internally. */}
      <Elements stripe={getStripe()} options={elementsOptions}>
        <StripeAppearanceSync appearance={elementsAppearance} />
        {/* The wallet sheet's amount follows `totalCents` (see
            StripeAmountSync): never a stale figure. */}
        {frozenElementsOptionsRef.current && (
          <StripeAmountSync
            amount={totalCents}
            initialAmount={frozenElementsOptionsRef.current.amount}
          />
        )}
        {/* Express pay (Apple Pay / Google Pay) — only shown when wallets are available */}
        {expressPay && (
          <ExpressPay
            clientSecret={clientSecret}
            onSuccess={onSuccess}
            onError={onError}
            onBeforePayment={onBeforePayment}
            disabled={disabled}
            // Never both at once: a second submission retires the first's
            // order, and the first PaymentIntent's success then confirms
            // against the wrong one.
            paused={formSubmitting}
            onSubmittingChange={setWalletSubmitting}
          />
        )}
        <PaymentForm
          clientSecret={clientSecret ?? undefined}
          onSuccess={onSuccess}
          onError={onError}
          onBeforePayment={onBeforePayment}
          isCreatingOrder={isCreatingOrder}
          totalLabel={totalLabel}
          disabled={disabled || walletSubmitting}
          onSubmittingChange={setFormSubmitting}
        />
      </Elements>
    </div>
  );
};
