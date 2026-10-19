"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";

import type { AppRouter } from "@th/trpc";
import { useTranslations } from "@th/ui";
import { trpc } from "@/trpc";
import { useCartRelease } from "@/hooks/useCartRecovery";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { formatErrorMessage } from "@/lib/format-error-message";
import { traceIgnoredError } from "@/lib/trace-ignored-error";
import { getAppErrorCode } from "@/lib/app-error";
import { keepsCheckoutClientKey } from "@/lib/checkout-client-key";
import { getAttribution } from "@/lib/attribution";
import {
  defaultChosenAmountCents,
  isChosenAmountValid,
  isPayWhatYouWant,
} from "@/lib/pricing/pay-what-you-want";
import { donationInputId } from "@/components/pricing/PayWhatYouWantAmount";
import {
  heldSeatQuotes,
  mapSeatQuotes,
  shownCartLines,
  shownLineCentsByTicketType,
  withSeatQuotes,
  type ShownCartLine,
} from "./checkout-seat-quotes";
import {
  clearStripeRedirectParams,
  isDeadPaymentIntentStatus,
  redirectFailureReason,
  type RedirectFailureReason,
  type RedirectPaymentSeen,
} from "./useStripeRedirectReturn";
import type { TicketTierSellability } from "@/components/events/ticket-tier-state";
import type {
  BillingAddress,
  CheckoutContactFormRef,
} from "./CheckoutContactForm";
import {
  paymentFromConfirmOutcome,
  type ConfirmedPayment,
} from "./confirmed-payment";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type UpdateOrderItemsOutput =
  inferRouterOutputs<AppRouter>["orders"]["updateOrderItems"];

export type TicketTypeSummary = {
  id: string;
  name: string;
  priceCents: number;
  /**
   * The AUTHORED capacity column. NOT availability — no write path decrements
   * it. Still carried because the seat-map picker reads it as the tier's
   * configured size.
   */
  capacity: number;
  /**
   * TRUE availability at page-load time: `capacity - issued - held`, from
   * `events.listEventTicketTypes`. Carried on the summary purely so it
   * survives the trip through `withBuyerUnitTotals` to `TicketTypeGrid`, which
   * renders the row state; NOTHING in this hook reads it, and nothing here
   * may — the server owns the refusal.
   */
  remainingCapacity: number;
  /** The server's sold-out verdict (`remainingCapacity <= 0`). */
  soldOut?: boolean;
  seatSectionId: string | null;
  /** Layout-internal section key for matching with PlaceLayout sections. */
  layoutSectionId: string | null;
  pricingMode?: "FIXED" | "ADJUSTABLE";
  minimumCents?: number | null;
  suggestedCents?: number | null;
  /**
   * PER-TIER availability (FR-010) and the pending scheduled price change
   * (Q-002), straight off `events.listEventTicketTypes`. Carried on the
   * summary purely so they survive the trip through `withBuyerUnitTotals` to
   * `TicketTypeGrid`, which renders the row state; NOTHING in this hook reads
   * them, and nothing here may — the server owns the refusal, the grid only
   * surfaces it a step earlier than the Continue button would.
   */
  sellability?: TicketTierSellability;
  upcomingPriceChange?: { toPriceCents: number; at: Date | string } | null;
};

/** The checkout moves through these phases in order. */
export type CheckoutPhase =
  | "selecting" // picking tickets
  | "holding" // updateOrderItems mutation in flight (locking seats)
  | "held" // seats held — show billing + payment form
  | "creating" // createCheckout mutation in flight
  | "paying" // clientSecret received, Stripe card visible
  | "confirming" // confirmPayment mutation in flight
  | "confirmed" // payment succeeded — show confirmation screen
  | "done"; // redirect initiated

type OrderSnapshot = UpdateOrderItemsOutput["order"] & {
  taxAmountCents?: number;
  /**
   * Account credit applied to the charge, stamped by `createCheckout`.
   * Subtracted from the buyer-facing total display so it matches the
   * PaymentIntent amount (gross + buyerFees + tax − credit).
   */
  creditAppliedCents?: number;
  /**
   * Effective fee mode for this order, stamped by `createCheckout`. In
   * PASS_THROUGH the buyer funds the grossed-up `processorFeeCents`, so the
   * displayed total includes it; in ABSORB it does not. Absent on the held
   * snapshot (`updateOrderItems` doesn't return it) — display components fall
   * back to the fee-rates query's feeMode for the pre-charge phases.
   */
  feeMode?: "ABSORB" | "PASS_THROUGH";
  /**
   * Platform fee a fee waiver took off, stamped by `createCheckout` (what the
   * reservation got). Absent on a held snapshot, where the held lines'
   * `meta.platformFeeWaivedCents` are the source (see `feeWaivedCentsFor`).
   */
  feeWaivedCents?: number;
};

/**
 * Thrown by `handleCheckout` when the hold was reset (expired, or released
 * via "Back to tickets") while `createCheckout` was in flight. The order it
 * minted has been released and nothing was dispatched — the buyer is already
 * on step 1 with the reason on screen — so callers treat it as control flow.
 */
export const HOLD_RESET_DURING_CHECKOUT = "hold-reset-during-checkout";

/**
 * Server refusals that mean the seat map on screen is out of date: a picked
 * seat was taken, or its price changed, after the map was fetched. The map is
 * cached for 15 s, so without a refetch the buyer re-picks from the same
 * stale map and is refused again.
 */
const SEAT_MAP_STALE_ERRORS: ReadonlySet<string> = new Set([
  "seat_taken",
  "seat_unavailable",
  "seat_price_changed",
]);

/**
 * A hold refused because the cart it names can no longer be edited: it has a
 * PaymentIntent (it entered checkout), it is not PENDING any more, or it is
 * gone. Its id must not be sent again.
 */
const UNEDITABLE_CART_CODES: ReadonlySet<string> = new Set([
  "ORDER_HAS_PAYMENT_INTENT",
  "ORDER_NOT_PENDING",
  "ORDER_NOT_FOUND",
]);

/**
 * Every seat the held order's ticket lines name (`meta.seatId` and
 * `meta.seatIds`), priced per seat or not. The backstop in `handleCheckout`
 * compares the selection against this, not against the quotable seats: a
 * seat on a GA-only or multi-seat line is held but has no quote.
 */
function heldSeatIdsOf(
  lines: ReadonlyArray<{ kind: string; meta?: unknown }> | undefined,
): Set<string> {
  const ids = new Set<string>();
  for (const line of lines ?? []) {
    if (line.kind !== "ticket") continue;
    const meta = (line.meta ?? {}) as { seatId?: unknown; seatIds?: unknown };
    if (typeof meta.seatId === "string") ids.add(meta.seatId);
    if (Array.isArray(meta.seatIds)) {
      for (const id of meta.seatIds) if (typeof id === "string") ids.add(id);
    }
  }
  return ids;
}

function isSeatMapStaleError(error: unknown): boolean {
  return (
    error instanceof Error &&
    SEAT_MAP_STALE_ERRORS.has(error.message.toLowerCase())
  );
}

/** The copy for a VERIFIED-dead redirect payment, by reason. */
const REDIRECT_FAILURE_COPY_KEY: Record<RedirectFailureReason, string> = {
  declined: "checkout.redirectFailedDeclined",
  not_completed: "checkout.redirectFailedNotCompleted",
  canceled: "checkout.redirectFailedCanceled",
};

/**
 * The PaymentIntent id inside a client secret (`pi_xxx_secret_yyy` →
 * `pi_xxx`), or null when the secret is not one.
 */
export function paymentIntentIdFromClientSecret(
  clientSecret: string | null | undefined,
): string | null {
  if (!clientSecret) return null;
  const at = clientSecret.indexOf("_secret_");
  if (at <= 3 || !clientSecret.startsWith("pi_")) return null;
  return clientSecret.slice(0, at);
}

/** `data.meta.status` of a tRPC error (PAYMENT_NOT_SUCCEEDED's PI status). */
function appErrorMetaStatus(error: unknown): unknown {
  if (!error || typeof error !== "object") return undefined;
  const meta = (error as { data?: { meta?: unknown } }).data?.meta;
  return meta && typeof meta === "object"
    ? (meta as { status?: unknown }).status
    : undefined;
}

/**
 * Why a payment Stripe may have taken could not be confirmed with our server
 * — each a TERMINAL screen (buying stays closed):
 *  - "received": Stripe said it succeeded; the webhook finishes the order;
 *  - "submitted": an ACH-style payment still processing — we'll email;
 *  - "unverified": neither the page nor the server could tell — check My
 *    tickets before trying again (a retry could charge twice);
 *  - "wrong-account": it was paid from another account (NOT_RESOURCE_OWNER).
 */
export type UnconfirmedPaymentOutcome =
  | "received"
  | "submitted"
  | "unverified"
  | "wrong-account";

/**
 * Thrown by `handleCheckout` once the purchase is settled, or while a
 * redirect return is being verified: no new order may be minted over a
 * payment that already went through. Control flow, like the one above.
 */
export const PURCHASE_ALREADY_SETTLED = "purchase-already-settled";

// ─────────────────────────────────────────────────────────────────────────────
// Reducer — single source of truth for checkout lifecycle
// ─────────────────────────────────────────────────────────────────────────────

type State = {
  phase: CheckoutPhase;
  orderId: string | null;
  order: OrderSnapshot | null;
  holdExpiresAt: string | null;
  clientSecret: string | null;
  errorMessage: string | null;
  /**
   * What the confirmation knows about the payment (see `ConfirmedPayment`).
   * Set when the page reaches "confirmed": the confirm's outcome, `paid` for
   * a free order, `unknown` otherwise.
   */
  payment: ConfirmedPayment;
};

type Action =
  | {
      type: "HOLD_RESUMED";
      orderId: string;
      order: OrderSnapshot;
      holdExpiresAt: string | null;
    }
  | { type: "HOLD_RESUME_FAILED"; error: string }
  | { type: "HOLD_STARTED" }
  | {
      type: "HOLD_SUCCEEDED";
      orderId: string;
      order: OrderSnapshot;
      holdExpiresAt: string | null;
      /**
       * Kept on screen after the hold lands: the re-hold after a Pay refused
       * `seat_price_changed` still says why the price moved.
       */
      notice?: string | null;
    }
  | { type: "HOLD_FAILED"; error: string }
  | { type: "HOLD_UPDATED"; order: OrderSnapshot; holdExpiresAt: string | null }
  | { type: "CHECKOUT_STARTED" }
  | {
      type: "CHECKOUT_SUCCEEDED";
      orderId: string;
      order: Partial<OrderSnapshot>;
      holdExpiresAt: string | null;
      clientSecret: string | null;
    }
  | {
      type: "CHECKOUT_FREE_ORDER";
      orderId: string;
      /** The confirmed order as the confirmation must show it (see below). */
      order: OrderSnapshot | null;
    }
  | { type: "CHECKOUT_FAILED"; error: string }
  | { type: "PAYMENT_CONFIRMING" }
  | {
      type: "PAYMENT_CONFIRMED";
      orderId: string;
      /** `orders.confirmPayment`'s answer: paid, or a debit still in flight. */
      outcome: "confirmed" | "processing";
    }
  | { type: "PAYMENT_FAILED"; error: string; orderId: string | null }
  | { type: "BACK_TO_SELECTING" }
  | { type: "BACK_TO_HELD" }
  | { type: "REDIRECT_PAYMENT_FAILED"; error: string }
  | { type: "RESTORED_CONFIRMATION_FAILED" }
  | { type: "CLEAR_ERROR" };

/**
 * The order as the HELD step must read it — what a fresh hold of the same cart
 * shows, and so what the next `createCheckout` charges.
 *
 * `createCheckout` answers with the gross AFTER its discount (promo codes and
 * member benefits) and CHECKOUT_SUCCEEDED merges it onto the order. Back on
 * the held step that gross was kept, and the held charge solve took the live
 * discount off it a second time: step 2 read a total below the charge. The
 * ticket lines are the source — the hold priced them and nothing rewrites
 * them — so the gross is their sum again (on a snapshot that never reached
 * createCheckout this is the gross it already had).
 *
 * Credit and the stamped tax are dropped for the same reason: the held step never subtracts it (a
 * fresh hold has none — createCheckout applies it), so a stamped credit row
 * beside a pre-credit total would not add up. The fee waiver and buyer fee
 * stay as createCheckout stamped them: its reservation still holds them, so a
 * re-run charges exactly those.
 */
function asHeldOrder(order: OrderSnapshot | null): OrderSnapshot | null {
  if (!order) return null;
  const ticketLines = order.items.filter((item) => item.kind === "ticket");
  if (ticketLines.length === 0) return order;
  return {
    ...order,
    amountGrossCents: ticketLines.reduce(
      (sum, item) => sum + item.amountCents,
      0,
    ),
    creditAppliedCents: 0,
    // A tax createCheckout stamped was solved on the DISCOUNTED base; the
    // held step's tax comes from the held charge solve (or, while fee rates
    // are unavailable, the tax estimate) — never from that stamp.
    taxAmountCents: undefined,
  };
}

/** @internal Exported for the reducer's guard tests only. */
export function checkoutStateReducer(state: State, action: Action): State {
  return reducer(state, action);
}

function reducer(state: State, action: Action): State {
  // A settled purchase (confirmed / done) is never replaced by a hold that
  // finishes late: a hold started before a free claim landed would otherwise
  // swap the confirmation for its held step — or, failing, for "sold out"
  // over tickets the buyer now owns. The hook drops those results first
  // (`purchaseSettledRef`); this is the floor.
  // Nor by a late checkout or payment result: a throw after a Stripe success,
  // or a stale createCheckout answer, must not move a confirmed page.
  if (
    (state.phase === "confirmed" || state.phase === "done") &&
    (action.type === "HOLD_STARTED" ||
      action.type === "HOLD_SUCCEEDED" ||
      action.type === "HOLD_FAILED" ||
      // A late cart resume must not send a paid buyer back to step 1.
      action.type === "HOLD_RESUMED" ||
      action.type === "HOLD_RESUME_FAILED" ||
      action.type === "REDIRECT_PAYMENT_FAILED" ||
      action.type === "CHECKOUT_STARTED" ||
      action.type === "CHECKOUT_SUCCEEDED" ||
      action.type === "CHECKOUT_FAILED" ||
      action.type === "PAYMENT_FAILED")
  ) {
    return state;
  }
  switch (action.type) {
    case "HOLD_RESUMED":
      return {
        ...state,
        phase: "held",
        orderId: action.orderId,
        order: action.order,
        holdExpiresAt: action.holdExpiresAt,
        errorMessage: null,
      };

    case "HOLD_RESUME_FAILED":
      return {
        ...state,
        phase: "selecting",
        orderId: null,
        order: null,
        holdExpiresAt: null,
        errorMessage: action.error,
      };

    case "HOLD_STARTED":
      return { ...state, phase: "holding", errorMessage: null };

    case "HOLD_SUCCEEDED":
      return {
        ...state,
        phase: "held",
        orderId: action.orderId,
        order: action.order,
        holdExpiresAt: action.holdExpiresAt,
        errorMessage: action.notice || null,
      };

    case "HOLD_FAILED":
      // Back on step 1 (a refused hold, or the auto-reset when the hold
      // expires mid-checkout): no order is on screen any more — see
      // BACK_TO_SELECTING. The hold is gone (refused, or expired and reaped
      // server-side), so its id and its timer go too: a kept `holdExpiresAt`
      // left "Expired" / a countdown on step 1, and a kept id was sent as
      // `pendingOrderId` for a dead order.
      return {
        ...state,
        phase: "selecting",
        orderId: null,
        order: null,
        holdExpiresAt: null,
        errorMessage: action.error,
      };

    case "HOLD_UPDATED":
      return {
        ...state,
        order: action.order,
        holdExpiresAt: action.holdExpiresAt,
        errorMessage: null,
        clientSecret: null,
      };

    case "CHECKOUT_STARTED":
      // When createCheckout is re-run from the payment step (the Pay button
      // calls onBeforePayment → handleCheckout while phase is already
      // "paying"), we MUST stay in "paying": flipping to "creating" maps the
      // UI back to the details step, which unmounts CheckoutPaymentStep —
      // tearing down the mounted Stripe PaymentElement mid-confirm. That
      // wiped the buyer's typed card and made the subsequent
      // stripe.confirmPayment reject against a dead Elements instance.
      //
      // No order on screen (the hold was reset): stay put — "creating" from
      // step 1 showed the details step with nothing held.
      if (!state.order) return state;
      return {
        ...state,
        phase: state.phase === "paying" ? "paying" : "creating",
        errorMessage: null,
      };

    case "CHECKOUT_SUCCEEDED":
      // No order on screen ⇒ the hold was reset (expired, released) while
      // createCheckout ran: the buyer is on step 1. Landing on "paying" with
      // no order rendered the pre-hold estimate as the Pay label ("Pay
      // $45.42") over a different charge. `handleCheckout` releases the
      // order it minted and never dispatches this; the guard is the floor.
      if (!state.order) return state;
      return {
        ...state,
        phase: "paying",
        orderId: action.orderId,
        order: state.order
          ? { ...state.order, ...action.order, id: action.orderId }
          : null,
        holdExpiresAt: action.holdExpiresAt,
        clientSecret: action.clientSecret,
        errorMessage: null,
      };

    case "CHECKOUT_FREE_ORDER":
      // The order createCheckout confirmed — its stamped figures (credit,
      // discount, tax) on the lines it was priced from. Not whatever is on
      // screen now: after a reset that is nothing (the confirmation fell
      // back to the pre-hold estimate as a cash total for a credit-covered
      // order) or a NEWER hold's snapshot.
      return {
        ...state,
        phase: "confirmed",
        orderId: action.orderId,
        order: action.order,
        holdExpiresAt: null,
        errorMessage: null,
        // Nothing to pay: a free order is settled when it is confirmed.
        payment: "paid",
      };

    case "CHECKOUT_FAILED":
      // The hold was reset while the charge was in flight (a confirm that
      // rejects after the hold expired): stay on step 1 and say why — the
      // held step with no order led, via Continue, to "paying" with none.
      if (!state.order) return { ...state, errorMessage: action.error };
      // A declined card (handlePaymentError) or a failed re-run from the
      // payment step lands here too, AFTER createCheckout merged its order.
      return {
        ...state,
        phase: "held",
        order: asHeldOrder(state.order),
        errorMessage: action.error,
      };

    case "PAYMENT_CONFIRMING":
      return { ...state, phase: "confirming" };

    case "PAYMENT_CONFIRMED":
      return {
        ...state,
        phase: "confirmed",
        orderId: action.orderId,
        payment: paymentFromConfirmOutcome(action.outcome),
      };

    case "PAYMENT_FAILED":
      // If we have an orderId, show confirmation (the order exists on backend)
      // The order Stripe charged is the one confirmed — even when a hold
      // reset during the confirm has nulled `orderId`.
      return {
        ...state,
        phase: action.orderId ? "confirmed" : "paying",
        orderId: action.orderId ?? state.orderId,
        errorMessage: action.orderId ? null : action.error,
        // The confirm failed: nothing says the money moved.
        payment: "unknown",
      };

    case "CLEAR_ERROR":
      return { ...state, errorMessage: null };

    case "BACK_TO_SELECTING":
      // The released hold's snapshot goes with it. Kept, it was still read:
      // step 1 rendered (and announced) the old order's totals, and the tax
      // estimate — gated on "no order yet" — stayed off, so a quantity change
      // dropped the "Taxes (8.88%)" rate from the summary and the tray. The
      // next hold dispatches a fresh order (HOLD_SUCCEEDED).
      // Its timer goes too: kept, "12:04 remaining" and "Reserved for 13:04"
      // went on ticking on step 1 for a hold that had been released. The id
      // stays — if the release failed, the unload beacon retries it.
      return {
        ...state,
        phase: "selecting",
        order: null,
        holdExpiresAt: null,
        errorMessage: null,
      };

    case "REDIRECT_PAYMENT_FAILED":
      // A redirect payment that was NOT taken: the steps, from step 1, with
      // the reason. (Not CHECKOUT_FAILED: with no order it would leave the
      // phase on "confirming" — the payment step — with nothing to pay.)
      return {
        ...state,
        phase: "selecting",
        orderId: null,
        order: null,
        holdExpiresAt: null,
        errorMessage: action.error,
      };

    case "BACK_TO_HELD":
      return {
        ...state,
        phase: "held",
        order: asHeldOrder(state.order),
        errorMessage: null,
      };

    case "RESTORED_CONFIRMATION_FAILED":
      // The confirmed URL's order can't be shown here (not this buyer's, not
      // this event's, not a confirmed status, or signed out): the ordinary,
      // EMPTY picker. Nothing was held or bought on this page load.
      return initialState({});

    default:
      return state;
  }
}

function initialState({
  resumeOrderId,
  restoredOrderId,
}: {
  resumeOrderId?: string;
  restoredOrderId?: string | null;
}): State {
  // A reload of the confirmed URL starts ON the confirmation (its loading
  // state), never on the picker: see `restoredOrderId` in the args.
  if (restoredOrderId) {
    return {
      phase: "confirmed",
      orderId: restoredOrderId,
      order: null,
      holdExpiresAt: null,
      clientSecret: null,
      errorMessage: null,
      // The restore reads the order's own status (useConfirmedOrder).
      payment: "unknown",
    };
  }
  return {
    phase: "selecting",
    orderId: resumeOrderId ?? null,
    order: null,
    holdExpiresAt: null,
    clientSecret: null,
    errorMessage: null,
    payment: "unknown",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Countdown hook (extracted)
// ─────────────────────────────────────────────────────────────────────────────

function useCountdown(holdExpiresAt: string | null) {
  const t = useTranslations();
  const [countdown, setCountdown] = useState<string | null>(null);
  const [isExpired, setIsExpired] = useState(false);

  useEffect(() => {
    if (!holdExpiresAt) {
      setCountdown(null);
      setIsExpired(false);
      return;
    }

    const expiry = new Date(holdExpiresAt);
    const formatCountdown = (valueMs: number) => {
      const totalSeconds = Math.max(0, Math.floor(valueMs / 1000));
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = totalSeconds % 60;
      return `${minutes}:${seconds.toString().padStart(2, "0")}`;
    };

    const tick = () => {
      const diffMs = expiry.getTime() - Date.now();
      if (diffMs > 0) {
        setCountdown(formatCountdown(diffMs));
        setIsExpired(false);
      } else {
        setCountdown(t("common.expired") as string);
        setIsExpired(true);
      }
    };

    tick();
    const interval = window.setInterval(tick, 1000);
    return () => window.clearInterval(interval);
  }, [holdExpiresAt, t]);

  return { countdown, isExpired };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main hook
// ─────────────────────────────────────────────────────────────────────────────

export type UseCheckoutStateArgs = {
  event: { id: string; slug: string; pricing?: { currency?: string } | null };
  ticketTypes: TicketTypeSummary[];
  resumeOrderId?: string;
  /**
   * The order a confirmed URL (`?step=confirmed&order=`) names, on a reload.
   * The page starts confirmed on it; `Checkout` then confirms or abandons the
   * restore with `handleRestoreVerdict`.
   */
  restoredOrderId?: string | null;
  /**
   * This request is a Stripe REDIRECT RETURN (`?payment_intent=` /
   * `?payment_intent_client_secret=`), as the SERVER read it from the URL.
   * Seeds "being verified" so the server and the first client render agree
   * (reading `window` here made them differ: a hydration mismatch on every
   * redirect return).
   */
  isStripeRedirectReturn?: boolean;
  /** Persist a guest password-unlock cookie after sign-in before order mutations. */
  shouldSyncSignedUnlock?: boolean;
  /**
   * The event's gate type, sent to the sync route so it converts only the
   * cookie that belongs to this gate (grant → APPLICATION, password →
   * PASSWORD).
   */
  signedUnlockGateType?: "NONE" | "PASSWORD" | "APPLICATION" | null;
  isSignedIn: boolean;
  /**
   * Whether the signed-in user's email is verified. Sign-in is no longer
   * gated on verification (Better Auth `requireEmailVerification: false`),
   * so an authed but unverified buyer can reach checkout — we bounce them
   * to the verify-email overlay here instead, because the ticket QR is
   * delivered via that email and an unverified send is pointless.
   */
  isEmailVerified?: boolean;
  /** Buyer's email — passed to the verify-email overlay when gating. */
  buyerEmail?: string;
  contactFormRef: React.RefObject<CheckoutContactFormRef | null>;
  onSignInRequired: (redirect: string) => void;
  /**
   * Called when the buyer is signed-in but unverified and is trying to
   * advance into checkout. UI side opens the verify-email overlay.
   */
  onEmailVerificationRequired?: (email: string) => void;
  currentUrl: string;
  /** When the event has a waiver, pass the acceptance state. Undefined means no waiver. */
  waiverAccepted?: boolean;
  /** Must be true — buyer must accept the platform ToS before checkout. */
  termsAccepted: boolean;
  /** Must be true — buyer must explicitly acknowledge the refund policy. */
  refundPolicyAccepted: boolean;
  /**
   * Called when the user submits checkout without ticking the ToS box. The
   * UI side handles the user-facing reaction (toast + scroll/focus the
   * checkbox) — keeps this hook free of DOM access. The hook still throws
   * after invoking the callback so the calling flow short-circuits.
   */
  onTermsRequired?: () => void;
  /** Called when the buyer hasn't selected any tickets. UI fires a toast. */
  onSelectionRequired?: () => void;
  /** Called when the billing address is missing. UI fires a toast and
   *  focuses the billing form via its imperative handle. */
  onBillingAddressRequired?: () => void;
  /** Called when a waiver is present and not accepted. UI fires a toast
   *  and focuses + highlights the waiver checkbox. */
  onWaiverRequired?: () => void;
  /** Called when the buyer has not acknowledged the refund policy. */
  onRefundPolicyRequired?: () => void;
};

export function useCheckoutState({
  event,
  ticketTypes,
  resumeOrderId,
  restoredOrderId = null,
  isStripeRedirectReturn = false,
  shouldSyncSignedUnlock = false,
  signedUnlockGateType = null,
  isSignedIn,
  isEmailVerified,
  buyerEmail,
  contactFormRef,
  onSignInRequired,
  onEmailVerificationRequired,
  currentUrl,
  waiverAccepted,
  termsAccepted,
  refundPolicyAccepted,
  onTermsRequired,
  onSelectionRequired,
  onBillingAddressRequired,
  onWaiverRequired,
  onRefundPolicyRequired,
}: UseCheckoutStateArgs) {
  const t = useTranslations();

  // ── Core lifecycle state ─────────────────────────────────────────
  const [state, dispatch] = useReducer(
    reducer,
    { resumeOrderId, restoredOrderId },
    initialState,
  );
  const holdOrderIdRef = useRef<string | null>(null);
  // Bumped whenever the hold is reset out from under the buyer (expiry
  // auto-reset, "Back to tickets"). `handleCheckout` compares it across its
  // await to tell that the order createCheckout minted has no page to land on.
  const holdResetCountRef = useRef(0);

  // Idempotency key for createCheckout. It rotates after every call that
  // returns (paid or free) and after a server refusal. It is kept after a
  // failure with no server code (the request may have committed; the same key
  // replays it) and after IDEMPOTENCY_LOCK_IN_PROGRESS (see
  // `keepsCheckoutClientKey`).
  const checkoutClientKeyRef = useRef<string>(crypto.randomUUID());

  // ── Promo codes ──────────────────────────────────────────────────
  const [promoCodes, setPromoCodes] = useState<string[]>([]);

  // ── Artist attribution selection ─────────────────────────────────
  const [attributionArtistSelection, setAttributionArtistSelection] =
    useState("");

  const handleApplyPromoCode = useCallback(
    (code: string): string | null => {
      const normalized = code.trim().toUpperCase();
      if (promoCodes.some((c) => c.toUpperCase() === normalized)) {
        return "checkout.promoCodeAlreadyApplied";
      }
      if (normalized.length < 3) {
        return "checkout.promoCodeInvalid";
      }
      setPromoCodes((prev) => [...prev, code.trim()]);
      return null;
    },
    [promoCodes],
  );

  const handleRemovePromoCode = useCallback((code: string) => {
    setPromoCodes((prev) => prev.filter((c) => c !== code));
  }, []);

  const getAttributionForCheckout = useCallback(() => {
    const attr = getAttribution();
    if (!attr) return {};
    // Only forward ref if it's a valid UUID — malformed refs would fail Zod validation
    const UUID_RE =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return {
      ...(attr.ref && UUID_RE.test(attr.ref) ? { ref: attr.ref } : {}),
      ...(attr.utmSource ? { utmSource: attr.utmSource } : {}),
      ...(attr.utmMedium ? { utmMedium: attr.utmMedium } : {}),
      ...(attr.utmCampaign ? { utmCampaign: attr.utmCampaign } : {}),
    };
  }, []);

  // A ref in sync with the order snapshot: `handleCheckout` reads the one it
  // started from after its await (the free-order confirmation is built on
  // it). (In-page payment callbacks read `paymentOrderIdRef`; a redirect
  // return has its own entry — no `state.orderId` mirror is needed.)
  const orderRef = useRef<OrderSnapshot | null>(state.order);
  orderRef.current = state.order;
  /**
   * The order whose PaymentIntent was handed to Stripe — set when
   * createCheckout's order goes to the payment step, cleared only once the
   * payment is settled (confirmed / failed) or a NEW hold replaces it. Never
   * by the hold auto-reset: a 3-D Secure challenge can outlast the hold, and
   * when it then SUCCEEDS the charge must still be confirmed. Reading
   * `state.orderId` there (which the reset nulls) dropped `confirmPayment`:
   * charged, shown "Hold expired" on step 1, free to buy again.
   */
  const paymentOrderIdRef = useRef<string | null>(null);
  /**
   * A Stripe confirm is being submitted (card or wallet), as reported by the
   * payment form. While it is, the hold is not reset under it and nothing
   * may release the order being paid ("Change tickets", the stepper).
   */
  const [isPaymentSubmitting, setIsPaymentSubmitting] = useState(false);
  /**
   * The purchase is settled — a free / credit-covered order confirmed, or a
   * paid one confirmed. Set SYNCHRONOUSLY where that is learned (not mirrored
   * from `phase`, which lags a render), so a hold response arriving in the
   * same tick is already dropped. Never cleared: this page is done buying.
   */
  const purchaseSettledRef = useRef(false);
  /**
   * This page load is a Stripe REDIRECT RETURN (`?payment_intent=` /
   * `?payment_intent_client_secret=`) still being verified: the buyer paid on
   * Amazon Pay / Cash App / … and is back. Until `confirmPayment` settles it,
   * leaving must not release the order. Seeded from the `isStripeRedirectReturn`
   * prop, which page.tsx reads from the request's searchParams, so the server
   * render and the first client render agree. The params stay in the URL
   * until the outcome is settled, so a reload seeds it again.
   */
  const [isRedirectReturnPending, setIsRedirectReturnPending] = useState(
    isStripeRedirectReturn,
  );
  /**
   * What the redirect-return page saw of the PaymentIntent before asking the
   * server: Stripe.js said it `succeeded` / is `processing` (ACH), or the page
   * could not tell (`unverified`: no Stripe.js, a retrieve error, an unhandled
   * status). It picks the terminal copy if the server's confirm fails.
   */
  const redirectPaymentStatusRef = useRef<RedirectPaymentSeen | null>(null);
  /**
   * What Stripe said of an IN-PAGE payment (card, wallet, or an
   * already-accepted PaymentIntent pressed again) before the page confirmed
   * it: `succeeded`, or `processing` (ACH, not paid yet). Read only when a
   * confirm sent without an order id fails, so a bank debit still clearing
   * reads "submitted", never "received".
   */
  const inPageSeenRef = useRef<"succeeded" | "processing" | null>(null);
  /**
   * The redirect return came back with `redirect_status=failed`. A hint for
   * the copy only: it turns a dead status the SERVER verifies into
   * "declined", and never decides anything by itself.
   */
  const redirectFailedHintRef = useRef(false);
  /**
   * A confirm sent without an order id (a redirect return, or an in-page
   * success whose order id was lost) failed, and the payment may stand. The
   * outcome is TERMINAL, with buying closed, never back to "paying" (from
   * there Back → Continue minted a second order over a paid one):
   *  - `received`: Stripe said it succeeded; the webhook finalizes the order;
   *  - `submitted`: Stripe said `processing` (ACH); settles later;
   *  - `unverified`: nobody could confirm it either way, including a
   *    PaymentIntent the server reports as still completable
   *    (`requires_action`…); "check My tickets";
   *  - `wrong-account`: signed into another account than the one that paid.
   * Only a PaymentIntent that can no longer complete
   * (`isDeadPaymentIntentStatus`) goes back to the steps instead.
   */
  const [unconfirmedPaymentOutcome, setUnconfirmedPaymentOutcome] =
    useState<UnconfirmedPaymentOutcome | null>(null);
  const isPaymentReceivedUnconfirmed = unconfirmedPaymentOutcome !== null;

  // Cache billing address + phone so they survive the contact form
  // unmounting when the UI transitions from the "details" step to
  // "payment". The form ref becomes null once the component unmounts,
  // but handleCheckout / autoSaveProfile still need the values.
  const cachedBillingRef = useRef<BillingAddress | null>(null);
  const cachedPhoneRef = useRef<string | null>(null);

  // ── Ticket selection ─────────────────────────────────────────────
  const [quantities, setQuantities] = useState<Record<string, number>>(() =>
    Object.fromEntries(ticketTypes.map((tt) => [tt.id, 0])),
  );
  const [selectedSeatIds, setSelectedSeatIds] = useState<
    Record<string, string[]>
  >({});
  const [donationAmounts, setDonationAmounts] = useState<
    Record<string, number>
  >(() =>
    Object.fromEntries(
      ticketTypes
        .filter(isPayWhatYouWant)
        .map((tt) => [tt.id, defaultChosenAmountCents(tt)]),
    ),
  );
  // Set by a "Hold tickets" the amount check refused: from then on every
  // amount field shows its error, including one the buyer never focused.
  const [showDonationErrors, setShowDonationErrors] = useState(false);
  // A refused hold asks for the amount field to be focused — AFTER the
  // re-render that forces its error on. Focusing in the click handler landed
  // on a field whose `aria-describedby` error wasn't in the DOM yet, so a
  // screen reader read the field without its message. `seq` lets a second
  // refusal re-focus the same field.
  const [donationFocusRequest, setDonationFocusRequest] = useState<{
    ticketTypeId: string;
    seq: number;
  } | null>(null);
  useEffect(() => {
    if (!donationFocusRequest || typeof document === "undefined") return;
    document
      .getElementById(donationInputId(donationFocusRequest.ticketTypeId))
      ?.focus();
  }, [donationFocusRequest]);
  /** The amount a PWYW tier is priced at: the buyer's, else the default. */
  const chosenAmountFor = useCallback(
    (tt: TicketTypeSummary) =>
      donationAmounts[tt.id] ?? defaultChosenAmountCents(tt),
    [donationAmounts],
  );
  // True while any SELECTED pay-what-you-want tier holds an amount the hold
  // would refuse. The promo preview pauses on it (see
  // `useCheckoutPromoPreview`'s `paused`), and the hold guard refuses on it.
  const hasInvalidDonation = useMemo(
    () =>
      ticketTypes.some(
        (tt) =>
          (quantities[tt.id] ?? 0) > 0 &&
          isPayWhatYouWant(tt) &&
          !isChosenAmountValid(tt, chosenAmountFor(tt)),
      ),
    [ticketTypes, quantities, chosenAmountFor],
  );
  // The amounts the SERVER quotes (tax estimate, promo preview) are debounced
  // so typing "22.50" is one round trip, not five. Only while selecting: the
  // moment a hold is taken the live amounts are used, so a buyer who types
  // and presses "Hold tickets" inside the debounce window still gets the tax
  // for the amount they held, not the one before it.
  const debouncedDonationAmounts = useDebouncedValue(donationAmounts, 300);
  const quotedDonationAmounts = useMemo(() => {
    const source =
      state.phase === "selecting" ? debouncedDonationAmounts : donationAmounts;
    // Only amounts the hold would ACCEPT are quoted. An over-cap or
    // below-minimum amount is left out, so the server quotes the tier's
    // floor instead: the hold is refused until the buyer fixes it anyway,
    // and sending it made the promo preview fail validation — which the
    // preview used to read as "your newest code can't stack" and delete it.
    return Object.fromEntries(
      ticketTypes
        .filter(isPayWhatYouWant)
        .map((tt) => [tt.id, source[tt.id] ?? defaultChosenAmountCents(tt)] as const)
        .filter(([id, cents]) => {
          const tt = ticketTypes.find((candidate) => candidate.id === id)!;
          return isChosenAmountValid(tt, cents);
        }),
    ) as Record<string, number>;
  }, [state.phase, debouncedDonationAmounts, donationAmounts, ticketTypes]);
  // The promo preview must price the cart the buyer MEANS, so it pauses while
  // any selected PWYW tier is either invalid right now OR not yet quoted.
  // The second half matters: quoting is debounced, so for up to 300ms after
  // an invalid amount is FIXED the quoted map still lacks the tier. Unpausing
  // on the live amount alone let the preview price that tier at its floor,
  // fail a code's minimum order, and prune it.
  const promoPreviewPaused = useMemo(
    () =>
      hasInvalidDonation ||
      ticketTypes.some(
        (tt) =>
          (quantities[tt.id] ?? 0) > 0 &&
          isPayWhatYouWant(tt) &&
          !(tt.id in quotedDonationAmounts),
      ),
    [hasInvalidDonation, ticketTypes, quantities, quotedDonationAmounts],
  );

  // Keyed by BOTH DB seatSectionId AND layout sectionId so callers
  // from either domain (SeatMapPicker passes layout IDs, backend data
  // uses DB UUIDs) can look up the ticket type.
  const sectionToTicketType = useMemo(() => {
    const map = new Map<string, TicketTypeSummary>();
    for (const tt of ticketTypes) {
      if (tt.seatSectionId) map.set(tt.seatSectionId, tt);
      if (tt.layoutSectionId) map.set(tt.layoutSectionId, tt);
    }
    return map;
  }, [ticketTypes]);

  const hasAssignedSeating = useMemo(
    () => ticketTypes.some((tt) => tt.seatSectionId),
    [ticketTypes],
  );

  const selectedItems = useMemo(
    () =>
      ticketTypes
        .map((tt) => {
          const qty = quantities[tt.id] ?? 0;
          if (qty === 0) return null;
          const seatIds = selectedSeatIds[tt.id];
          return {
            ticketTypeId: tt.id,
            qty,
            ...(seatIds && seatIds.length > 0 ? { seatIds } : {}),
            ...(isPayWhatYouWant(tt)
              ? { donationAmountCents: chosenAmountFor(tt) }
              : {}),
          };
        })
        .filter((item): item is NonNullable<typeof item> => item !== null),
    [quantities, ticketTypes, selectedSeatIds, chosenAmountFor],
  );

  const selectedQty = useMemo(
    () => selectedItems.reduce((sum, item) => sum + item.qty, 0),
    [selectedItems],
  );

  const handleQuantityChange = useCallback(
    (ticketTypeId: string, delta: number) => {
      setQuantities((prev) => ({
        ...prev,
        [ticketTypeId]: Math.max(0, (prev[ticketTypeId] ?? 0) + delta),
      }));
    },
    [],
  );

  const handleDonationAmountChange = useCallback(
    (ticketTypeId: string, amountCents: number) => {
      setDonationAmounts((prev) => ({
        ...prev,
        [ticketTypeId]: amountCents,
      }));
    },
    [],
  );

  const handleSeatToggle = useCallback(
    (seatId: string, sectionId: string) => {
      const tt = sectionToTicketType.get(sectionId);
      if (!tt) return;

      setSelectedSeatIds((prev) => {
        const current = prev[tt.id] ?? [];
        const next = current.includes(seatId)
          ? current.filter((id) => id !== seatId)
          : [...current, seatId];

        setQuantities((prevQ) => ({ ...prevQ, [tt.id]: next.length }));
        return { ...prev, [tt.id]: next };
      });
    },
    [sectionToTicketType],
  );

  // ── Queries ──────────────────────────────────────────────────────
  const seatAvailabilityQuery = trpc.events.listEventSeatAvailability.useQuery(
    { eventId: event.id },
    { enabled: hasAssignedSeating, staleTime: 15_000 },
  );
  const refetchSeatAvailability = seatAvailabilityQuery.refetch;
  // What the HOLD sends: the picked items plus, per picked seat with an
  // override, the price the seat map shows (seat-price-overrides D-007). The
  // server refuses `seat_price_changed` rather than hold at a number the
  // buyer was not shown; it never charges from the quote. Pay quotes the
  // held summary instead (`handleCheckout`), see checkout-seat-quotes.ts.
  const seatAvailabilitySeats = seatAvailabilityQuery.data?.seats;
  const holdItems = useMemo(
    () =>
      withSeatQuotes(
        selectedItems,
        ticketTypes,
        mapSeatQuotes(seatAvailabilitySeats),
      ),
    [selectedItems, ticketTypes, seatAvailabilitySeats],
  );

  // The cart at the prices step 1 shows: a PWYW tier at the buyer's amount
  // (its stored price is always 0; pricing it from that made a $15 donation a
  // "free" order), each picked override seat at the price the map shows. The
  // ONE source for the subtotal, the step-1 lines and the estimated total
  // (`Checkout`), so the summary before the hold quotes what the hold
  // answers: a $50 seat on a $35 tier read "$35.00" until Hold re-priced it.
  const shownLines: ShownCartLine[] = useMemo(
    () =>
      shownCartLines(
        ticketTypes,
        quantities,
        selectedSeatIds,
        seatAvailabilitySeats,
        chosenAmountFor,
      ),
    [
      ticketTypes,
      quantities,
      selectedSeatIds,
      seatAvailabilitySeats,
      chosenAmountFor,
    ],
  );
  const shownLineCents = useMemo(
    () => shownLineCentsByTicketType(shownLines),
    [shownLines],
  );
  // A $10 seat on a $0 tier is a paid order, so it needs the billing address.
  const subtotalCents = useMemo(
    () =>
      Object.values(shownLineCents).reduce((sum, cents) => sum + cents, 0),
    [shownLineCents],
  );
  // After a seat refusal, fetch the map again so the buyer sees which seat
  // went and what it costs now. A refetch, not a cache invalidation: it is
  // the one query this page renders the map from.
  const refreshSeatMapIfStale = useCallback(
    (error: unknown) => {
      if (!hasAssignedSeating || !isSeatMapStaleError(error)) return;
      void refetchSeatAvailability();
    },
    [hasAssignedSeating, refetchSeatAvailability],
  );

  const feeRatesQuery = trpc.events.getCheckoutFeeRates.useQuery(
    { eventId: event.id },
    { staleTime: 60_000 },
  );

  const [billingAddressForTax, setBillingAddressForTax] =
    useState<BillingAddress | null>(null);

  // Tax is venue-based (admissionTaxRateBps on the event), not buyer-address-
  // based, so we can estimate as soon as items are selected — no need to wait
  // for the billing address.
  const taxEstimateQuery = trpc.events.estimateCheckoutTax.useQuery(
    {
      eventId: event.id,
      // The chosen PWYW amount rides along so the held step's tax is the
      // tax on the donation, not on the tier's stored $0.
      items: selectedItems.map(({ ticketTypeId, qty }) => ({
        ticketTypeId,
        qty,
        ...(ticketTypeId in quotedDonationAmounts
          ? { donationAmountCents: quotedDonationAmounts[ticketTypeId] }
          : {}),
      })),
    },
    {
      // Also while HELD: that is the step whose summary shows this tax, and
      // a hold taken inside the amount debounce changes the key at the moment
      // the order appears — disabling here would leave that step with no tax.
      enabled:
        selectedItems.length > 0 && (!state.order || state.phase === "held"),
      staleTime: 30_000,
    },
  );

  // ── Saved profile (phone + billing address) for pre-fill ─────────
  const savedProfileQuery = trpc.humans.getMyProfile.useQuery(undefined, {
    enabled: isSignedIn,
    staleTime: 60_000,
  });

  // ── Cart hold release ────────────────────────────────────────────
  // Nothing is released on leaving while a payment is submitting (a redirect
  // method navigates away mid-confirm — the release cancelled its
  // PaymentIntent), a redirect return is being verified, or the order is
  // confirming / paid (the release fired for PAID orders too).
  useCartRelease(state.orderId, event.id, {
    suppressRelease:
      isPaymentSubmitting ||
      isRedirectReturnPending ||
      state.phase === "confirming" ||
      state.phase === "confirmed" ||
      state.phase === "done",
  });

  // ── Mutations ────────────────────────────────────────────────────
  const releaseHoldMutation = trpc.orders.releaseCartHold.useMutation();
  // The releases the buyer did not ask for: the one before a fresh hold, and
  // a late hold's. A failure there has its own message on the page (or none
  // is owed), so no global "Action failed" toast beside it.
  const backgroundReleaseMutation = trpc.orders.releaseCartHold.useMutation({
    meta: { silent: true },
  });

  // Set while the re-hold after a Pay refused `seat_price_changed` is in
  // flight: the message the held step keeps showing once it lands. Non-null
  // also means "a re-hold is already running": a second refused Pay must not
  // start another. Cleared by every hold reset, so a re-hold the buyer left
  // behind never lends its message to the next hold.
  const reholdNoticeRef = useRef<string | null>(null);
  // State twin of "a re-hold is in flight" (`reholdNoticeRef !== null`): the
  // price re-hold after `seat_price_changed`, and the one Pay starts when a
  // picked seat is missing from the held lines (notice ""). Pay looks busy
  // instead of live-but-inert meanwhile. Only `setReholdNotice` writes either.
  const [isPriceReholding, setIsPriceReholding] = useState(false);
  const setReholdNotice = useCallback((notice: string | null) => {
    reholdNoticeRef.current = notice;
    setIsPriceReholding(notice !== null);
  }, []);
  // The order `createCheckout` minted, with a PaymentIntent. `updateOrderItems`
  // refuses such an order (ORDER_HAS_PAYMENT_INTENT), so a re-hold of it must
  // release it (which settles the PaymentIntent and frees the seats) and hold
  // afresh. Cleared by any hold landing.
  const checkoutOrderIdRef = useRef<string | null>(null);
  // True while `releaseAndHoldFresh` waits on its release: a hold started in
  // that window would race the fresh one and strand a second cart. The state
  // twin drives `isHolding` / `isPending`, so Hold and Pay look busy for the
  // whole release (up to minutes when Stripe is slow), not live and inert.
  const releaseInFlightRef = useRef(false);
  const [isReholding, setIsReholding] = useState(false);
  // Set on unmount. A release or hold that answers after the buyer left must
  // not start (or keep) a cart: the unmount beacon already released the one
  // on screen, and nothing would track a new one.
  const disposedRef = useRef(false);
  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
    };
  }, []);
  // Each hold's `holdResetCountRef` at the moment it was sent, keyed by its
  // variables (react-query hands the same object back to onSuccess/onError).
  // A hold that lands after a reset (Back to tickets, the hold expiring) is
  // the buyer's old intent: it must not pull them back to the held step.
  const holdResetsByCallRef = useRef(new WeakMap<object, number>());
  /** Whether this hold was overtaken: the page was left or reset since it went out. */
  const isStaleHold = (variables: object | undefined): boolean => {
    if (disposedRef.current) return true;
    const resetsAtSend = variables
      ? holdResetsByCallRef.current.get(variables)
      : undefined;
    return (
      resetsAtSend !== undefined && resetsAtSend !== holdResetCountRef.current
    );
  };
  /**
   * Release `staleOrderId`, then hold `items` as a NEW cart. For a cart
   * `updateOrderItems` can no longer edit: it entered checkout (it has a
   * PaymentIntent). The fresh hold goes out only when:
   *   - the old cart no longer holds the seats: released now, or `gone`
   *     (missing, or CANCELLED: an earlier release, the expiry reaper, or a
   *     carry-over that retired it; this order holds nothing).
   *     Otherwise `releaseCartHold` KEPT it (its PaymentIntent would not
   *     settle, a race with finalize), or the call threw and we cannot tell.
   *     Then the page keeps pointing at it (`holdOrderIdRef`, and the held
   *     step's `state.orderId` the unload release reads) and says so; a
   *     fresh hold would only be refused those same seats. An API older than
   *     `gone` reads as kept;
   *   - nothing reset the hold meanwhile (Back to tickets, the hold expiring),
   *     the page is still mounted, and the purchase has not settled: the
   *     buyer's newer action owns the page. The old reference is not put
   *     back either: the reset already let go of it.
   * `mutateAsync`, not `mutate` callbacks: those fire only for the LATEST
   * `mutate` on the observer, so another release in the window dropped the
   * re-hold and left `reholdNoticeRef` set for good.
   */
  const releaseAndHoldFresh = async (
    staleOrderId: string,
    items: inferRouterInputs<AppRouter>["orders"]["updateOrderItems"]["items"],
  ): Promise<void> => {
    const resetsAtStart = holdResetCountRef.current;
    const wasCheckoutOrder = checkoutOrderIdRef.current === staleOrderId;
    holdOrderIdRef.current = null;
    checkoutOrderIdRef.current = null;
    releaseInFlightRef.current = true;
    setIsReholding(true);
    let outcome: "released" | "gone" | "kept" = "kept";
    try {
      const result = await backgroundReleaseMutation.mutateAsync({
        orderId: staleOrderId,
      });
      outcome = result.released ? "released" : result.gone ? "gone" : "kept";
    } catch (error: unknown) {
      traceIgnoredError("checkout.reholdRelease")(error);
    } finally {
      releaseInFlightRef.current = false;
      setIsReholding(false);
    }

    if (
      disposedRef.current ||
      holdResetCountRef.current !== resetsAtStart ||
      purchaseSettledRef.current
    ) {
      return;
    }
    if (outcome === "kept") {
      if (holdOrderIdRef.current === null) {
        // Still the buyer's cart, seats and all: never lose the reference.
        holdOrderIdRef.current = staleOrderId;
        if (wasCheckoutOrder) checkoutOrderIdRef.current = staleOrderId;
      }
      const notice = reholdNoticeRef.current;
      setReholdNotice(null);
      const error = notice || (t("checkout.unableToHold") as string);
      // On the held step: stay there on the same cart (CHECKOUT_FAILED keeps
      // `state.orderId`). Pay again quotes the old lines, is refused, and
      // tries this again. With no held order on screen: back to step 1.
      dispatch(
        orderRef.current
          ? { type: "CHECKOUT_FAILED", error }
          : { type: "HOLD_FAILED", error },
      );
      return;
    }
    startHold({ eventId: event.id, items });
  };
  const updateOrderMutation = trpc.orders.updateOrderItems.useMutation({
    onSuccess: (data, variables) => {
      // A hold that finishes AFTER the purchase settled (taken while a free
      // claim was in flight): nobody will use it — release it, and leave the
      // confirmation and `holdOrderIdRef` alone.
      if (purchaseSettledRef.current) {
        // Nothing on the page waits on it; a failure leaves the cart to
        // the expiry reaper, and is reported rather than lost. `.catch`, not
        // a per-call `onError`: TanStack drops that for all but the latest
        // mutate on an observer.
        void backgroundReleaseMutation
          .mutateAsync({ orderId: data.order.id })
          .catch(traceIgnoredError("checkout.lateHoldRelease"));
        return;
      }
      // A hold the buyer has moved on from (Back to tickets, the hold
      // expired, or they left the page) while it was in flight. Landing it
      // would yank them back to the held step with the old selection, so
      // release it instead, unless it is the cart the page holds now.
      if (isStaleHold(variables as typeof variables | undefined)) {
        if (disposedRef.current || data.order.id !== holdOrderIdRef.current) {
          void backgroundReleaseMutation
            .mutateAsync({ orderId: data.order.id })
            .catch(traceIgnoredError("checkout.lateHoldRelease"));
        }
        return;
      }
      holdOrderIdRef.current = data.order.id;
      // A new hold: any earlier PaymentIntent's order is not this page's.
      paymentOrderIdRef.current = null;
      checkoutOrderIdRef.current = null;
      const notice = reholdNoticeRef.current;
      setReholdNotice(null);
      dispatch({
        type: "HOLD_SUCCEEDED",
        orderId: data.order.id,
        order: data.order,
        holdExpiresAt: data.holdExpiresAt,
        notice,
      });
    },
    onError: (error, variables) => {
      // A refusal for a hold the buyer has moved on from: the screen it
      // would explain is gone, and so is the cart it named.
      if (isStaleHold(variables as typeof variables | undefined)) {
        refreshSeatMapIfStale(error);
        return;
      }
      const code = getAppErrorCode(error);
      // react-query always passes the variables; a direct call may not.
      const staleOrderId = (variables as typeof variables | undefined)?.orderId;
      // The cart this hold tried to edit can no longer be edited. Never send
      // its id again: every later hold would fail the same way.
      if (
        staleOrderId &&
        holdOrderIdRef.current === staleOrderId &&
        code !== null &&
        UNEDITABLE_CART_CODES.has(code)
      ) {
        holdOrderIdRef.current = null;
        // A cart holding a PaymentIntent (a resumed cart createCheckout had
        // re-saved) still holds its seats: release it and hold afresh, or
        // the buyer's own held seats refuse every new hold until the TTL.
        if (code === "ORDER_HAS_PAYMENT_INTENT" && !purchaseSettledRef.current) {
          void releaseAndHoldFresh(staleOrderId, variables.items);
          return;
        }
      }
      setReholdNotice(null);
      refreshSeatMapIfStale(error);
      // "Sold out" for tickets the buyer already owns: say nothing.
      if (purchaseSettledRef.current) return;
      dispatch({
        type: "HOLD_FAILED",
        error: formatErrorMessage(error, t),
      });
    },
  });

  /** Send a hold, remembering the reset count it was sent under (`isStaleHold`). */
  const startHold = useCallback(
    (
      variables: inferRouterInputs<AppRouter>["orders"]["updateOrderItems"],
    ) => {
      holdResetsByCallRef.current.set(variables, holdResetCountRef.current);
      updateOrderMutation.mutate(variables);
    },
    [updateOrderMutation],
  );

  // Read through a ref by `handleCheckout`: a new function every render, and
  // it reaches `updateOrderMutation`, which a deps array cannot list first.
  const releaseAndHoldFreshRef = useRef(releaseAndHoldFresh);
  releaseAndHoldFreshRef.current = releaseAndHoldFresh;

  const createCheckoutMutation = trpc.orders.createCheckout.useMutation();

  const saveProfileMutation = trpc.humans.updateProfile.useMutation();

  const syncSignedUnlock = useCallback(async (): Promise<void> => {
    if (!shouldSyncSignedUnlock) return;

    const response = await fetch(`/api/events/${event.id}/sync-unlock`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ gateType: signedUnlockGateType }),
    });
    if (!response.ok) {
      throw new Error("event-unlock-sync-failed");
    }

    const payload = (await response.json().catch(() => null)) as {
      persisted?: boolean;
    } | null;
    if (!payload?.persisted) {
      throw new Error("event-unlock-sync-failed");
    }
  }, [event.id, shouldSyncSignedUnlock, signedUnlockGateType]);

  const confirmPaymentMutation = trpc.orders.confirmPayment.useMutation({
    // Every failure is handled on the page (a terminal screen, or back to the
    // steps with the reason): no global toast contradicting "payment received".
    meta: { silent: true },
    onMutate: () => {
      dispatch({ type: "PAYMENT_CONFIRMING" });
    },
    onSuccess: (data) => {
      // Paid: there is no hold left to release. A later "Tickets" click must
      // never send `releaseCartHold` for a paid order (the server refuses it,
      // Sentry hears about it, and the buyer was dropped back to selection).
      purchaseSettledRef.current = true;
      holdOrderIdRef.current = null;
      paymentOrderIdRef.current = null;
      // A redirect return is settled: no longer "being verified", and a
      // reload need not ask again.
      setIsRedirectReturnPending(false);
      redirectPaymentStatusRef.current = null;
      inPageSeenRef.current = null;
      clearStripeRedirectParams();
      dispatch({
        type: "PAYMENT_CONFIRMED",
        orderId: data.orderId,
        outcome: data.outcome,
      });
      // Don't redirect — the checkout will show the confirmation screen.
      // User can navigate to /my-tickets from there.
    },
    onError: (error, variables) => {
      // The order this confirm was FOR (the one Stripe charged) — not
      // `state.orderId`, which a hold reset during the confirm has nulled.
      // A redirect-return confirm sends no order id: none to show here.
      const oid = variables.orderId ?? null;
      paymentOrderIdRef.current = null;
      if (oid) {
        // Payment failed but we have an order — show confirmation (order may still be recoverable)
        // That screen is past the hold: nothing for "back" to release, and
        // nothing more to hold (the page is confirmed — see
        // `purchaseSettledRef`). No order ⇒ still on the payment step: a
        // retry is a real option, so that branch leaves the flag alone.
        purchaseSettledRef.current = true;
        holdOrderIdRef.current = null;
        dispatch({ type: "PAYMENT_FAILED", error: "", orderId: oid });
        // Nothing confirmed the money moved: the terminal "payment received /
        // submitted / couldn't confirm" screen (no stepper), never a step 4
        // reading "Confirmed". Its copy follows what Stripe said: a bank debit
        // still `processing` is "submitted". (A redirect confirm sends no
        // order id, so its ref is normally empty here; it wins if set.)
        // Reported like the no-order branch: Stripe took a payment our
        // confirm could not finish, with nothing thrown to reach Sentry.
        traceIgnoredError("checkout.confirmWithOrder")(error);
        const seenWithOrder =
          redirectPaymentStatusRef.current ?? inPageSeenRef.current;
        setUnconfirmedPaymentOutcome(
          getAppErrorCode(error) === "NOT_RESOURCE_OWNER"
            ? "wrong-account"
            : seenWithOrder === "processing"
              ? "submitted"
              : seenWithOrder === "succeeded"
                ? "received"
                : "unverified",
        );
      } else {
        // No order id: a redirect-return confirm (or an orphaned in-page
        // one). Stripe already took the payment; this failure does not undo
        // it. Report it, settle the page, and show the terminal "payment
        // received" screen — the webhook finalizes the order. Never back to
        // "paying" with no order and the pre-hold estimate.
        const code = getAppErrorCode(error);
        // An in-page orphan confirm only happens after Stripe accepted the
        // payment: what it said then (`processing` for ACH), else succeeded.
        const seen =
          redirectPaymentStatusRef.current ??
          inPageSeenRef.current ??
          "succeeded";
        const failedHint = redirectFailedHintRef.current;
        setIsRedirectReturnPending(false);
        // The ONE definite "not taken" the server can give: PAYMENT_NOT_SUCCEEDED
        // naming a PaymentIntent that can no longer complete, and only when
        // this page did not itself see the payment go through (an ACH
        // payment still `processing` is NOT a failure). PAYMENT_NOT_SUCCEEDED
        // for `requires_action` (a Cash App approval still pending) or with
        // no status can still be charged: terminal, buying closed.
        const deadStatus = appErrorMetaStatus(error);
        if (
          code === "PAYMENT_NOT_SUCCEEDED" &&
          seen === "unverified" &&
          isDeadPaymentIntentStatus(deadStatus)
        ) {
          redirectPaymentStatusRef.current = null;
          redirectFailedHintRef.current = false;
          clearStripeRedirectParams();
          dispatch({
            type: "REDIRECT_PAYMENT_FAILED",
            error: t(
              REDIRECT_FAILURE_COPY_KEY[
                redirectFailureReason(deadStatus, failedHint)
              ],
            ) as string,
          });
          return;
        }
        traceIgnoredError("checkout.redirectConfirm")(error);
        purchaseSettledRef.current = true;
        holdOrderIdRef.current = null;
        setUnconfirmedPaymentOutcome(
          code === "NOT_RESOURCE_OWNER"
            ? "wrong-account"
            : seen === "processing"
              ? "submitted"
              : seen === "succeeded"
                ? "received"
                : "unverified",
        );
      }
    },
  });

  // ── Cart resume logic ────────────────────────────────────────────
  const [isResumingOrder, setIsResumingOrder] = useState(
    Boolean(resumeOrderId),
  );

  const resumedCartQuery = trpc.orders.getActiveCartHolds.useQuery(
    {},
    { enabled: isResumingOrder && Boolean(resumeOrderId), staleTime: 0 },
  );

  useEffect(() => {
    if (!isResumingOrder || !resumedCartQuery.data?.carts) return;

    const cart = resumedCartQuery.data.carts.find(
      (c) => c.id === resumeOrderId,
    );
    if (!cart) {
      setIsResumingOrder(false);
      dispatch({
        type: "HOLD_RESUME_FAILED",
        error: t("checkout.cartExpired") as string,
      });
      return;
    }

    const newQuantities: Record<string, number> = {};
    for (const tt of ticketTypes) {
      const item = cart.ticketSummary.find((ts) => ts.ticketTypeId === tt.id);
      newQuantities[tt.id] = item?.qty ?? 0;
    }
    setQuantities(newQuantities);
    // The held seats, so Pay buys THESE: without them it sent a bare qty, the
    // server auto-assigned other seats, released the held ones and charged
    // those seats' prices.
    const resumedSeatIds: Record<string, string[]> = {};
    for (const item of cart.ticketSummary) {
      if (item.seatIds.length > 0 && item.seatIds.length === item.qty) {
        resumedSeatIds[item.ticketTypeId] = [...item.seatIds];
      }
    }
    if (Object.keys(resumedSeatIds).length > 0) {
      setSelectedSeatIds((prev) => ({ ...prev, ...resumedSeatIds }));
    }
    // A held PWYW line was priced at the buyer's amount; restore it, or
    // `createCheckout` would re-send the DEFAULT and charge that instead
    // (hold $50, resume, pay $15). The server line's unit price IS the amount.
    const resumedAmounts: Record<string, number> = {};
    for (const tt of ticketTypes) {
      if (!isPayWhatYouWant(tt)) continue;
      const item = cart.ticketSummary.find((ts) => ts.ticketTypeId === tt.id);
      if (item) resumedAmounts[tt.id] = item.unitPriceCents;
    }
    if (Object.keys(resumedAmounts).length > 0) {
      setDonationAmounts((prev) => ({ ...prev, ...resumedAmounts }));
    }
    // The typed codes the hold was priced with. Without them a cart that
    // `createCheckout` re-saved (gross AFTER its discount) resumed with no
    // code: step 2 showed the post-discount gross, and the next charge
    // re-priced at full price.
    if (cart.promoCodes.length > 0) {
      setPromoCodes((prev) => {
        const next = [...prev];
        for (const code of cart.promoCodes) {
          if (!next.some((c) => c.toUpperCase() === code.toUpperCase())) {
            next.push(code);
          }
        }
        return next;
      });
    }

    holdOrderIdRef.current = cart.id;
    dispatch({
      type: "HOLD_RESUMED",
      orderId: cart.id,
      order: {
        id: cart.id,
        eventId: event.id,
        buyerHumanId: "",
        // PRE-discount: the held step takes the (restored) codes' and member
        // benefits' discount off this itself. `cart.amountGrossCents` is
        // post-discount once `createCheckout` has re-saved the cart, so
        // starting from it took the discount off twice.
        amountGrossCents: cart.preDiscountGrossCents,
        feesPlatformCents: cart.feesPlatformCents,
        // The fee mode the hold was priced under, so the held step's rows
        // don't fall back to the event's current setting.
        feeMode: cart.feeMode ?? undefined,
        // The buyer-funded platform fee the hold was priced with. Hard-coded
        // 0 here dropped it from a RESUMED held step (the held charge adds
        // it) — $1.03 under the fresh hold's figure and the charge, with
        // rows that no longer summed.
        buyerFeesCents: cart.buyerFeesCents,
        processorFeeCents: 0,
        // getActiveCartHolds doesn't expose credit — it's only computed and
        // stamped by createCheckout, which re-dispatches the real value via
        // CHECKOUT_SUCCEEDED before any charge happens. 0 is correct here.
        creditAppliedCents: 0,
        currency: cart.currency,
        status: "PENDING",
        // One line per held seat at its own price, as a fresh hold answers:
        // the summary shows each seat's number and Pay quotes it
        // (seat-price-overrides D-007). The per-type `unitPriceCents` is only
        // the first line's, so a type mixing a $50 and a $30 seat read $100.
        // A type without a seat per ticket (GA) stays one line, as does an
        // answer from an API older than `seats` (web and API deploy apart).
        items: cart.ticketSummary.flatMap((item) => {
          const seats = (item.seats as typeof item.seats | undefined) ?? [];
          return seats.length > 0 && seats.length === item.qty
            ? seats.map((seat) => ({
                id: "",
                kind: "ticket" as const,
                ticketTypeId: item.ticketTypeId,
                qty: 1,
                unitPriceCents: seat.unitPriceCents,
                amountCents: seat.unitPriceCents,
                meta: { seatId: seat.seatId, seatIds: [seat.seatId] },
              }))
            : [
                {
                  id: "",
                  kind: "ticket" as const,
                  ticketTypeId: item.ticketTypeId,
                  qty: item.qty,
                  unitPriceCents: item.unitPriceCents,
                  amountCents: item.qty * item.unitPriceCents,
                  // Its seats, so Pay's backstop knows them as held.
                  meta: { seatIds: item.seatIds ?? [] },
                },
              ];
        }),
      },
      holdExpiresAt: cart.holdExpiresAt?.toISOString() ?? null,
    });

    setIsResumingOrder(false);
  }, [
    resumedCartQuery.data,
    resumeOrderId,
    isResumingOrder,
    ticketTypes,
    event.id,
    t,
  ]);

  // ── Countdown ────────────────────────────────────────────────────
  const { countdown, isExpired } = useCountdown(state.holdExpiresAt);
  // Once payment succeeds, the seats are owned, not held — the timer is
  // meaningless past `confirming`. Without this gate the InfoBar keeps
  // ticking down on the "You're all set!" screen, which reads like the
  // tickets are about to expire.
  const isPostPayment = state.phase === "confirmed" || state.phase === "done";
  const isHoldActive = Boolean(
    state.orderId && countdown && !isExpired && !isPostPayment,
  );

  // ── Auto-reset when hold expires during payment phases ───────────
  // If the hold timer runs out while the user is on the billing /
  // payment screen, send them back to ticket selection so they can
  // re-hold. Without this they'd be stuck on a dead checkout form.
  useEffect(() => {
    if (!isExpired) return;
    const paymentPhases: CheckoutPhase[] = ["held", "creating", "paying"];
    if (!paymentPhases.includes(state.phase)) return;
    // Not under a Stripe confirm: the charge may still succeed (3-D Secure
    // outlasting the hold) and must then be confirmed on the payment step.
    // If it fails instead, the form stops submitting and this runs then.
    if (isPaymentSubmitting) return;

    holdOrderIdRef.current = null;
    holdResetCountRef.current += 1;
    setReholdNotice(null);
    dispatch({
      type: "HOLD_FAILED",
      error: t("checkout.holdExpired") as string,
    });
  }, [isExpired, state.phase, isPaymentSubmitting, t, setReholdNotice]);

  // ── Actions ──────────────────────────────────────────────────────
  const autoSaveProfile = useCallback(() => {
    const phone =
      contactFormRef.current?.getPhone() ?? cachedPhoneRef.current ?? undefined;
    const billing =
      contactFormRef.current?.getBillingAddress() ??
      cachedBillingRef.current ??
      undefined;
    if (!phone && !billing) return;

    saveProfileMutation.mutate({
      ...(phone ? { phone } : {}),
      ...(billing
        ? {
            billingAddress: {
              line1: billing.line1,
              ...(billing.line2 ? { line2: billing.line2 } : {}),
              city: billing.city,
              state: billing.state,
              postalCode: billing.postalCode,
              country: billing.country,
            },
          }
        : {}),
    });
  }, [saveProfileMutation, contactFormRef]);

  /**
   * Holds tickets / seats for the user. Creates a PENDING order and locks
   * seats for 15 minutes. Transitions the UI from "selecting" → "held" so
   * the billing + payment form is revealed.
   */
  const handleHoldTickets = useCallback(async (): Promise<void> => {
    if (selectedItems.length === 0) {
      // Toast nudge — no inline banner. Buyer just needs to scroll up
      // and tick a quantity; the action is obvious.
      onSelectionRequired?.();
      return Promise.resolve();
    }
    // A PWYW amount the server would refuse (below the minimum, or empty):
    // stop here, show the message on the field and put the caret in it.
    const invalidDonation = ticketTypes.find(
      (tt) =>
        (quantities[tt.id] ?? 0) > 0 &&
        isPayWhatYouWant(tt) &&
        !isChosenAmountValid(tt, chosenAmountFor(tt)),
    );
    if (invalidDonation) {
      // Error state first; the effect above focuses once it has rendered.
      setShowDonationErrors(true);
      setDonationFocusRequest((prev) => ({
        ticketTypeId: invalidDonation.id,
        seq: (prev?.seq ?? 0) + 1,
      }));
      return Promise.resolve();
    }
    if (!isSignedIn) {
      onSignInRequired(currentUrl);
      return Promise.resolve();
    }
    // Email-verification gate. Sign-in is allowed for unverified accounts,
    // but the ticket QR is delivered via email, so we block checkout here
    // and route the buyer to the OTP card.
    if (
      isEmailVerified === false &&
      buyerEmail &&
      onEmailVerificationRequired
    ) {
      onEmailVerificationRequired(buyerEmail);
      return Promise.resolve();
    }
    if (updateOrderMutation.isPending) return Promise.resolve();
    // A re-hold is releasing the old cart and will hold this selection
    // itself; a hold now would race it into a second cart.
    if (releaseInFlightRef.current) return Promise.resolve();
    // Nothing more to hold once the purchase is settled — or while a
    // redirect return is still being verified.
    if (purchaseSettledRef.current || isRedirectReturnPending) {
      return Promise.resolve();
    }

    await syncSignedUnlock();
    // A free claim may have settled the purchase during that await.
    if (purchaseSettledRef.current) return Promise.resolve();

    dispatch({ type: "HOLD_STARTED" });

    startHold({
      eventId: event.id,
      items: holdItems,
      ...(holdOrderIdRef.current ? { orderId: holdOrderIdRef.current } : {}),
    });
    return Promise.resolve();
  }, [
    selectedItems,
    holdItems,
    isSignedIn,
    isEmailVerified,
    buyerEmail,
    onEmailVerificationRequired,
    onSignInRequired,
    currentUrl,
    updateOrderMutation,
    startHold,
    syncSignedUnlock,
    event.id,
    onSelectionRequired,
    ticketTypes,
    quantities,
    chosenAmountFor,
    isRedirectReturnPending,
  ]);

  /**
   * Creates the order on the backend and returns the Stripe clientSecret
   * plus the final server-stamped charge amount in cents (the PaymentIntent
   * amount — needed so the deferred-mode Stripe Elements can be re-synced
   * before confirmPayment; a mismatch makes Stripe reject the confirm).
   * For free orders it returns `null` (and transitions straight to confirmed).
   * Throws on validation / network errors so the caller can handle them.
   */
  const handleCheckout = useCallback(async (): Promise<{
    clientSecret: string;
    amountCents: number;
  } | null> => {
    // Captured BEFORE the first await (the sign-unlock sync): a reset during
    // that await must count as "during this call" too. So are the held order
    // and the selection this call is for — a free order is confirmed on them.
    // Never a new order over a payment that went through, or one still
    // being verified (a redirect return).
    if (
      purchaseSettledRef.current ||
      isRedirectReturnPending ||
      isPaymentReceivedUnconfirmed
    ) {
      throw new Error(PURCHASE_ALREADY_SETTLED);
    }
    const holdResetsAtStart = holdResetCountRef.current;
    const heldOrderAtStart = orderRef.current;
    const quantitiesAtStart = quantities;
    const seatIdsAtStart = selectedSeatIds;
    const donationAmountsAtStart = donationAmounts;
    // Each user-recoverable validation routes to a sonner toast (via the
    // optional callbacks below) instead of the inline FormErrorBanner.
    // Banner is reserved for state-shifting errors the buyer needs to
    // read and reason about (hold expired, server failure, payment
    // declined). Per-button nudges that point at "tick this box" or
    // "fill this field" are toasts — they disappear once acted on.
    if (selectedItems.length === 0) {
      onSelectionRequired?.();
      throw new Error("selection-required");
    }
    if (!isSignedIn) {
      onSignInRequired(currentUrl);
      throw new Error("sign-in required");
    }
    // Email-verification gate — see handleHoldTickets for rationale.
    if (
      isEmailVerified === false &&
      buyerEmail &&
      onEmailVerificationRequired
    ) {
      onEmailVerificationRequired(buyerEmail);
      throw new Error("email-verification-required");
    }
    await syncSignedUnlock();
    // The hold was reset during that await: nothing has been sent yet, so
    // there is nothing to release — stop before minting an order.
    if (holdResetCountRef.current !== holdResetsAtStart) {
      throw new Error(HOLD_RESET_DURING_CHECKOUT);
    }
    // Billing address is only required when there's a real charge. Free
    // orders go through `claimFreeTickets` on the server, never touch
    // Stripe, and have no tax to compute (admission tax is gated on
    // amountGrossAfterDiscount > 0). Asking for an address here would
    // be pure friction.
    const billingAddress =
      contactFormRef.current?.getBillingAddress() ?? cachedBillingRef.current;
    if (subtotalCents > 0 && !billingAddress) {
      onBillingAddressRequired?.();
      throw new Error("billing-address-required");
    }
    // Validate waiver acceptance when a waiver is present
    if (waiverAccepted === false) {
      onWaiverRequired?.();
      throw new Error("waiver-required");
    }
    // Validate Terms of Service acceptance. The user-facing notice (sonner
    // toast + checkbox scroll/focus/highlight) is handled by the caller via
    // `onTermsRequired` — we don't surface this through `errorMessage`
    // because the inline banner is far above the fold and the buyer has
    // no idea what action it's asking for.
    if (!termsAccepted) {
      onTermsRequired?.();
      throw new Error("terms-required");
    }
    if (!refundPolicyAccepted) {
      onRefundPolicyRequired?.();
      throw new Error("refund-policy-required");
    }
    // Cache for later use (payment step, profile save) — the contact form
    // unmounts when the UI transitions away from the details step.
    cachedBillingRef.current = billingAddress;
    const phone = contactFormRef.current?.getPhone();
    if (phone) cachedPhoneRef.current = phone;
    if (createCheckoutMutation.isPending)
      throw new Error("already in progress");
    // A re-hold is releasing the old cart: there is nothing settled to pay.
    if (releaseInFlightRef.current) throw new Error("already in progress");
    // A re-hold of this cart is in flight (a Pay refused `seat_price_changed`,
    // or a seat picked after the hold): the summary is about to change. Paid
    // now, and the organiser reverting the price meanwhile, createCheckout
    // would mint an order with a PaymentIntent that the re-hold then pulls
    // the buyer off, orphaning it until the reaper.
    if (reholdNoticeRef.current !== null) {
      throw new Error("already in progress");
    }

    // Backstop: Pay quotes the held lines, so every picked seat must be one
    // of them. A seat picked after the hold (the selection moved while a
    // re-hold ran, or around it) has no held price on screen: re-hold the
    // current selection so the summary shows its price, and send nothing.
    // Compared against every seat the held lines name, quotable or not: a
    // held order of GA lines alone holds no seat, so any picked seat is new.
    // Deliberately no HOLD_STARTED: the held step stays up and the summary
    // refreshes in place when the hold lands, as for the price re-hold below.
    const heldQuotes = heldSeatQuotes(heldOrderAtStart?.items);
    const heldSeatIds = heldSeatIdsOf(heldOrderAtStart?.items);
    const unheldSeat =
      heldOrderAtStart !== null &&
      selectedItems.some((item) =>
        (item.seatIds ?? []).some((seatId) => !heldSeatIds.has(seatId)),
      );
    if (unheldSeat) {
      const heldOrderId = holdOrderIdRef.current;
      if (heldOrderId && reholdNoticeRef.current === null) {
        // "" marks the re-hold in flight with nothing to say once it lands.
        setReholdNotice("");
        if (checkoutOrderIdRef.current === heldOrderId) {
          void releaseAndHoldFreshRef.current(heldOrderId, holdItems);
        } else {
          startHold({
            eventId: event.id,
            items: holdItems,
            orderId: heldOrderId,
          });
        }
      }
      throw new Error("already in progress");
    }

    dispatch({ type: "CHECKOUT_STARTED" });

    try {
      const data = await createCheckoutMutation.mutateAsync({
        eventId: event.id,
        clientKey: checkoutClientKeyRef.current,
        // Pay quotes what the held summary shows: the held order's own seat
        // lines, never the live seat map (which can refetch to a number the
        // summary does not show yet).
        items: withSeatQuotes(selectedItems, ticketTypes, heldQuotes),
        ...(billingAddress ? { billingAddress } : {}),
        ...(state.orderId ? { pendingOrderId: state.orderId } : {}),
        ...(promoCodes.length > 0 ? { promoCodes: promoCodes } : {}),
        ...(waiverAccepted != null ? { waiverAccepted } : {}),
        termsAccepted: true,
        refundPolicyAccepted: true,
        ...getAttributionForCheckout(),
        ...(attributionArtistSelection
          ? { checkoutArtistSelection: attributionArtistSelection }
          : {}),
      });

      if (!data.clientSecret) {
        // Free (or fully credit-covered) order — the server CONFIRMED it:
        // the tickets are issued, so this is what the page must show.
        checkoutClientKeyRef.current = crypto.randomUUID(); // rotate for next attempt
        if (holdResetCountRef.current !== holdResetsAtStart) {
          // The hold was reset during the call (expired, or released via
          // "Back to tickets") and the buyer may already hold a NEWER cart.
          // That cart is a second claim on top of tickets they now own, and
          // the confirmation below replaces it on screen — so release it
          // (else it stays held until the reaper) and put the selection
          // back to what was confirmed, not what was being re-picked.
          if (holdOrderIdRef.current) {
            releaseHoldMutation.mutate({ orderId: holdOrderIdRef.current });
          }
          setQuantities(quantitiesAtStart);
          setSelectedSeatIds(seatIdsAtStart);
          setDonationAmounts(donationAmountsAtStart);
        }
        // No hold left to release, no PaymentIntent to confirm — and nothing
        // more to hold: a hold still in flight is dropped when it lands.
        holdOrderIdRef.current = null;
        paymentOrderIdRef.current = null;
        purchaseSettledRef.current = true;
        dispatch({
          type: "CHECKOUT_FREE_ORDER",
          orderId: data.orderId,
          order: heldOrderAtStart
            ? {
                ...heldOrderAtStart,
                id: data.orderId,
                amountGrossCents: data.amountGrossCents,
                feesPlatformCents: data.feesPlatformCents,
                buyerFeesCents: data.buyerFeesCents,
                processorFeeCents: data.processorFeeCents,
                taxAmountCents: data.taxAmountCents,
                creditAppliedCents: data.creditAppliedCents,
                feeMode: data.feeMode,
                ...(data.feeWaivedCents === undefined
                  ? {}
                  : { feeWaivedCents: data.feeWaivedCents }),
              }
            : null,
        });
        return null;
      }

      // Rotate the idempotency key so a future fresh checkout gets a new one.
      checkoutClientKeyRef.current = crypto.randomUUID();

      // The hold was reset while createCheckout ran (it expired on the
      // payment step, or the buyer released it): the page is back on step 1
      // with no order. The order just minted — seats, PaymentIntent, promo
      // and waiver reservations — has nowhere to go: release it, never point
      // `holdOrderIdRef` at it, and dispatch nothing (CHECKOUT_SUCCEEDED here
      // put "paying" on screen with no order and the pre-hold estimate as
      // the Pay label). A FREE order above is already confirmed: it stands.
      if (holdResetCountRef.current !== holdResetsAtStart) {
        releaseHoldMutation.mutate({ orderId: data.orderId });
        throw new Error(HOLD_RESET_DURING_CHECKOUT);
      }

      // createCheckout RETIRED the held cart and minted this order (with its
      // PaymentIntent, seats, promo and fee-waiver holds). "Back to tickets"
      // from the payment step must release THIS one — it used to release the
      // already-cancelled hold, leaving this cart PENDING under a live
      // PaymentIntent (and the buyer's waiver reserved) until the reaper ran.
      // `releaseCartHold` settles the PaymentIntent before de-holding.
      holdOrderIdRef.current = data.orderId;
      checkoutOrderIdRef.current = data.orderId;
      // The order Stripe is about to charge (see `paymentOrderIdRef`).
      paymentOrderIdRef.current = data.orderId;

      dispatch({
        type: "CHECKOUT_SUCCEEDED",
        orderId: data.orderId,
        order: {
          amountGrossCents: data.amountGrossCents,
          feesPlatformCents: data.feesPlatformCents,
          buyerFeesCents: data.buyerFeesCents,
          processorFeeCents: data.processorFeeCents,
          taxAmountCents: data.taxAmountCents,
          creditAppliedCents: data.creditAppliedCents,
          feeMode: data.feeMode,
          // What the reservation actually got — may be less than the hold
          // priced if another buyer took the last allowance ticket.
          feeWaivedCents: data.feeWaivedCents,
        },
        holdExpiresAt: data.holdExpiresAt,
        clientSecret: data.clientSecret,
      });

      // Mirror the server's PaymentIntent amount exactly:
      //   PASS_THROUGH: gross + buyerFees + processorFee + tax − credit
      //   ABSORB:       gross + buyerFees + tax − credit (processor NOT added)
      // The PASS_THROUGH processor fee is the grossed-up amount the buyer
      // funds; omitting it here makes Stripe reject the deferred confirm with
      // an amount mismatch. (See `paymentIntentAmountCents` in
      //  packages/core/src/use-cases/orders/create-checkout.ts.)
      const amountCents =
        data.amountGrossCents +
        data.buyerFeesCents +
        (data.feeMode === "PASS_THROUGH" ? data.processorFeeCents : 0) +
        data.taxAmountCents -
        data.creditAppliedCents;

      return { clientSecret: data.clientSecret, amountCents };
    } catch (error: unknown) {
      refreshSeatMapIfStale(error);
      // A failed attempt gets a fresh idempotency key, or a request that died
      // holding the server's lock would refuse every retry for up to 15
      // minutes. Not while that lock is still held by a running attempt.
      if (!keepsCheckoutClientKey(error)) {
        checkoutClientKeyRef.current = crypto.randomUUID();
      }
      // Step 1 already says why (the hold expired); nothing to dispatch.
      if (
        error instanceof Error &&
        error.message === HOLD_RESET_DURING_CHECKOUT
      ) {
        throw error;
      }
      // A call that FAILED after the hold was reset: the buyer went back on
      // purpose, or "Hold expired" is on screen — a late "checkout failed"
      // would overwrite it. Nothing was minted; say nothing.
      if (holdResetCountRef.current !== holdResetsAtStart) {
        throw new Error(HOLD_RESET_DURING_CHECKOUT);
      }
      const msg = formatErrorMessage(error, t);
      dispatch({ type: "CHECKOUT_FAILED", error: msg });
      // A seat's price moved since the hold. The held summary still shows the
      // old number, so re-hold the same selection: the server re-prices it
      // and the summary shows the new price before Pay can charge it. Until
      // that lands, Pay still quotes the OLD held lines and is refused again,
      // so the new price can never be charged unseen. No quotes on the
      // re-hold: its answer is what the buyer sees next.
      // One re-hold at a time: a Pay pressed again while it runs throws
      // "already in progress" client-side (see `handleCheckout`), so it sends
      // nothing and starts no other; `isPending` shows Pay busy meanwhile.
      // No HOLD_STARTED, deliberately: the held step and its error stay up
      // and the summary re-prices in place when the hold lands.
      // An order that entered checkout cannot be edited (it has a
      // PaymentIntent), so it is released and held afresh instead.
      const heldOrderId = holdOrderIdRef.current;
      if (
        error instanceof Error &&
        error.message === "seat_price_changed" &&
        heldOrderId &&
        !purchaseSettledRef.current &&
        reholdNoticeRef.current === null
      ) {
        setReholdNotice(msg);
        if (checkoutOrderIdRef.current === heldOrderId) {
          void releaseAndHoldFreshRef.current(heldOrderId, selectedItems);
        } else {
          startHold({
            eventId: event.id,
            items: selectedItems,
            orderId: heldOrderId,
          });
        }
      }
      throw error;
    }
  }, [
    setReholdNotice,
    selectedItems,
    holdItems,
    ticketTypes,
    startHold,
    isSignedIn,
    isEmailVerified,
    buyerEmail,
    onEmailVerificationRequired,
    onSignInRequired,
    currentUrl,
    syncSignedUnlock,
    subtotalCents,
    contactFormRef,
    createCheckoutMutation,
    refreshSeatMapIfStale,
    event.id,
    state.orderId,
    promoCodes,
    waiverAccepted,
    termsAccepted,
    refundPolicyAccepted,
    onTermsRequired,
    onSelectionRequired,
    onBillingAddressRequired,
    onWaiverRequired,
    onRefundPolicyRequired,
    getAttributionForCheckout,
    attributionArtistSelection,
    releaseHoldMutation,
    quantities,
    selectedSeatIds,
    donationAmounts,
    isRedirectReturnPending,
    isPaymentReceivedUnconfirmed,
    t,
  ]);

  /**
   * An IN-PAGE Stripe success (card or wallet): confirm the order whose
   * PaymentIntent this page handed to Stripe.
   *
   * `confirmPayment` goes FIRST: the profile save after it is best-effort,
   * and a throw from it used to leave the spinner up forever over a charged
   * card. If the order id is somehow gone (it should not be — see
   * `paymentOrderIdRef`), that is reported, and the confirm is sent with the
   * PaymentIntent alone — the server resolves the order from its metadata —
   * rather than dropped.
   */
  const handlePaymentSuccess = useCallback(
    (
      paymentIntentId: string,
      paymentIntentStatus: "succeeded" | "processing" = "succeeded",
    ) => {
      inPageSeenRef.current = paymentIntentStatus;
      const orderId = paymentOrderIdRef.current;
      if (orderId) {
        confirmPaymentMutation.mutate({ orderId, paymentIntentId });
      } else {
        traceIgnoredError("checkout.paymentSuccessWithoutOrder")(
          new Error(
            `in-page payment success with no order handed to Stripe (${paymentIntentId})`,
          ),
        );
        confirmPaymentMutation.mutate({ paymentIntentId });
      }
      try {
        autoSaveProfile();
      } catch (err) {
        traceIgnoredError("checkout.autoSaveProfile")(err);
      }
    },
    [autoSaveProfile, confirmPaymentMutation],
  );

  /**
   * A Stripe REDIRECT RETURN to confirm with the server (Amazon Pay, Cash
   * App, …): Stripe.js saw it `succeeded` / `processing`, or could not tell
   * (`unverified`). This is a
   * fresh page load, so any order id it remembers is stale (createCheckout
   * retired the held cart). Confirm by the PaymentIntent alone; the server
   * resolves the order from its metadata (same buyer only) and the
   * confirmation shows the order id it returns.
   */
  const handleRedirectPaymentSuccess = useCallback(
    (
      paymentIntentId: string,
      seen: RedirectPaymentSeen = "succeeded",
      failedHint = false,
    ) => {
      redirectPaymentStatusRef.current = seen;
      redirectFailedHintRef.current = failedHint;
      confirmPaymentMutation.mutate({ paymentIntentId });
    },
    [confirmPaymentMutation],
  );

  /**
   * A redirect return the page cannot even ask the server about (no usable
   * PaymentIntent id). The buyer may have paid: terminal "couldn't confirm —
   * check My tickets", and buying stays closed.
   */
  const handleRedirectUnverifiable = useCallback(() => {
    traceIgnoredError("checkout.redirectUnverifiable")(
      new Error("redirect return without a usable payment_intent id"),
    );
    purchaseSettledRef.current = true;
    holdOrderIdRef.current = null;
    setIsRedirectReturnPending(false);
    setUnconfirmedPaymentOutcome("unverified");
  }, []);

  /**
   * The verdict on a confirmation restored from the URL (`restoredOrderId`).
   * "confirm": the purchase is settled, as it is after an in-session confirm.
   * "fallback": the empty picker. `purchaseSettledRef` was never set for the
   * restore, so buying is open as on any fresh load.
   */
  const handleRestoreVerdict = useCallback(
    (verdict: "confirm" | "fallback") => {
      if (verdict === "confirm") {
        purchaseSettledRef.current = true;
        return;
      }
      dispatch({ type: "RESTORED_CONFIRMATION_FAILED" });
    },
    [],
  );

  const clientSecret = state.clientSecret;
  const handlePaymentError = useCallback(
    (
      msg: string,
      code?: string,
      paymentIntentStatus?: string,
      paymentIntentId?: string,
    ) => {
      // `payment_intent_unexpected_state` with the PaymentIntent already
      // `succeeded` / `processing`: Stripe accepted this payment earlier (a
      // confirm whose answer was lost, then a second press). It is not a
      // decline. Confirm it with the server like any success: the server
      // re-reads the PaymentIntent and answers paid or still processing.
      if (
        code === "payment_intent_unexpected_state" &&
        (paymentIntentStatus === "succeeded" ||
          paymentIntentStatus === "processing")
      ) {
        const id = paymentIntentId ?? paymentIntentIdFromClientSecret(clientSecret);
        if (id) {
          handlePaymentSuccess(id, paymentIntentStatus);
          return;
        }
        traceIgnoredError("checkout.acceptedPaymentWithoutIntentId")(
          new Error(
            `payment_intent_unexpected_state (${paymentIntentStatus}) with no PaymentIntent id`,
          ),
        );
      }
      // The PaymentIntent was declined: nothing of it left to confirm. A
      // retry re-runs createCheckout, which hands Stripe a fresh one.
      paymentOrderIdRef.current = null;
      dispatch({ type: "CHECKOUT_FAILED", error: formatErrorMessage(msg, t) });
    },
    [t, clientSecret, handlePaymentSuccess],
  );

  /**
   * A redirect return that DEFINITELY failed: Stripe.js retrieved the
   * PaymentIntent and it is `requires_payment_method` / `canceled`
   * (`redirect_status=failed` alone never lands here). Nothing was taken,
   * so back to the steps with the reason (leaving releases again).
   */
  const handleRedirectPaymentError = useCallback(
    (reason: RedirectFailureReason) => {
      setIsRedirectReturnPending(false);
      paymentOrderIdRef.current = null;
      redirectPaymentStatusRef.current = null;
      redirectFailedHintRef.current = false;
      // Settled: a reload is a fresh checkout, not another redirect return.
      clearStripeRedirectParams();
      dispatch({
        type: "REDIRECT_PAYMENT_FAILED",
        error: t(REDIRECT_FAILURE_COPY_KEY[reason]) as string,
      });
    },
    [t],
  );

  const clearError = useCallback(() => dispatch({ type: "CLEAR_ERROR" }), []);

  // While a Stripe confirm is submitting, or once payment is confirming /
  // confirmed, there is no way back: "back" releases the order being (or
  // already) paid. Enforced here so every entry point — "Change tickets",
  // the stepper, the hold-warning dialog — is covered.
  const isBackNavigationLocked =
    isPaymentSubmitting ||
    // createCheckout in flight from the details step: a free claim confirms
    // on the server mid-call, so "back" there let the buyer re-pick and hold
    // a second cart over the one being claimed.
    state.phase === "creating" ||
    state.phase === "confirming" ||
    state.phase === "confirmed" ||
    state.phase === "done";

  const handleBackToSelecting = useCallback(() => {
    if (isBackNavigationLocked) return;
    // Release the current hold if one exists
    if (holdOrderIdRef.current) {
      releaseHoldMutation.mutate({ orderId: holdOrderIdRef.current });
      holdOrderIdRef.current = null;
    }
    holdResetCountRef.current += 1;
    setReholdNotice(null);
    dispatch({ type: "BACK_TO_SELECTING" });
  }, [releaseHoldMutation, isBackNavigationLocked, setReholdNotice]);

  const handleBackToHeld = useCallback(() => {
    // Back to details unmounts the payment form mid-confirm.
    if (isBackNavigationLocked) return;
    dispatch({ type: "BACK_TO_HELD" });
  }, [isBackNavigationLocked]);

  /** The payment form reports whether a Stripe confirm is submitting. */
  const handlePaymentSubmittingChange = useCallback((submitting: boolean) => {
    setIsPaymentSubmitting(submitting);
  }, []);

  // ── Public surface ───────────────────────────────────────────────
  return {
    // Phase
    phase: state.phase,
    errorMessage: state.errorMessage,
    clearError,

    // Order
    orderId: state.orderId,
    /** What this page learned about the payment (see `ConfirmedPayment`). */
    payment: state.payment,
    // Null on step 1: BACK_TO_SELECTING and HOLD_FAILED clear it, so this
    // and the tax-estimate gate above read the same truth.
    order: state.order,
    clientSecret: state.clientSecret,

    // Countdown
    countdown,
    isExpired,
    isHoldActive,

    // Ticket selection
    quantities,
    selectedItems,
    selectedQty,
    subtotalCents,
    /** Step 1's cart at the shown prices: `estimateCartTotal`'s items. */
    shownLines,
    /** Step 1's line amount per ticket type (face × qty, seat by seat). */
    shownLineCents,
    selectedSeatIds,
    hasAssignedSeating,
    handleQuantityChange,
    handleSeatToggle,
    donationAmounts,
    handleDonationAmountChange,
    showDonationErrors,
    quotedDonationAmounts,
    hasInvalidDonation,
    promoPreviewPaused,

    // Queries
    seatAvailabilityQuery,
    feeRatesQuery,
    taxEstimateQuery,
    savedProfileQuery,
    billingAddressForTax,
    setBillingAddressForTax,

    // Actions
    handleHoldTickets,
    handleBackToSelecting,
    handleBackToHeld,
    handleCheckout,
    handlePaymentSuccess,
    handlePaymentError,
    handleRedirectPaymentSuccess,
    handleRedirectPaymentError,
    /** A Stripe redirect return still being verified (see the state). */
    isRedirectReturnPending,
    /** Paid (or maybe paid), but our confirm failed — a terminal screen. */
    isPaymentReceivedUnconfirmed,
    /** Which terminal screen (see `UnconfirmedPaymentOutcome`). */
    unconfirmedPaymentOutcome,
    handleRedirectUnverifiable,
    handleRestoreVerdict,
    handlePaymentSubmittingChange,
    isPaymentSubmitting,
    isBackNavigationLocked,
    autoSaveProfile,
    // A re-hold's release counts as busy for both: Hold and Pay refuse
    // while it runs, so they must not look live.
    isPending:
      createCheckoutMutation.isPending || isReholding || isPriceReholding,
    isHolding: updateOrderMutation.isPending || isReholding,

    // Promo codes
    promoCodes,
    handleApplyPromoCode,
    handleRemovePromoCode,

    // Attribution
    attributionArtistSelection,
    setAttributionArtistSelection,

    // Update mutation for hold edits
    updateOrderMutation,
  };
}
