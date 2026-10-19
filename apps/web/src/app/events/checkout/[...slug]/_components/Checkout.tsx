"use client";

import "./checkout.css";

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import {
  useFormatters,
  useLocale,
  useTranslations,
  FormErrorBanner,
  Money,
} from "@th/ui";
import { useSearchParams } from "next/navigation";
import { authClient } from "@/lib/auth/auth-client";
import { traceIgnoredError } from "@/lib/trace-ignored-error";
import { useAppOverlay } from "@/components/layout/AppOverlayProvider";
import { useCurrentUrl } from "@/hooks/useCurrentUrl";
import type { EventDetail } from "../../../lib/event-format";
import { CheckoutInfoBar } from "./CheckoutInfoBar";
import { CheckoutStepper } from "./CheckoutStepper";
import type { CheckoutStepId } from "./CheckoutStepper";
import { CheckoutSlideContainer } from "./CheckoutSlideContainer";
import type { SlideDirection } from "./CheckoutSlideContainer";
import type { PlaceLayout } from "./SeatMapPicker";
import { CheckoutTicketsStep } from "./CheckoutTicketsStep";
import { CheckoutHoldWarningDialog } from "./CheckoutHoldWarningDialog";
import { CheckoutSidebar } from "./CheckoutSidebar";
import { CheckoutTicketSummaryHeader } from "./CheckoutTicketSummaryHeader";
import { CheckoutPaymentStep } from "./CheckoutPaymentStep";
import { CheckoutConfirmedStep } from "./CheckoutConfirmedStep";
import type {
  BillingAddress,
  CheckoutContactFormRef,
  ContactDraft,
} from "./CheckoutContactForm";
import { CheckoutMobileCTA } from "./CheckoutMobileCTA";
import {
  HOLD_RESET_DURING_CHECKOUT,
  PURCHASE_ALREADY_SETTLED,
  useCheckoutState,
} from "./useCheckoutState";
import type { TicketTypeSummary, CheckoutPhase } from "./useCheckoutState";
import { useCheckoutAcceptanceNudges } from "./useCheckoutAcceptanceNudges";
import { useCheckoutDisplayTotal } from "./useCheckoutDisplayTotal";
import { useConfirmedOrder } from "./useConfirmedOrder";
import { checkoutScreen } from "./checkout-screen";
import { CheckoutConfirmedPending } from "./CheckoutConfirmedPending";
import { stepperPayment } from "./confirmed-payment";
import { CheckoutRestoreNotice } from "./CheckoutRestoreNotice";
import { useApplyRestoreVerdict } from "./useApplyRestoreVerdict";
import {
  restoreStateAfterPhase,
  type RestoreSessionStatus,
  type RestoreState,
} from "./restored-confirmation";
import { summarySurfaceOrder, traySurfaceOrder } from "./surface-orders";
import { useCheckoutPromoPreview } from "./useCheckoutPromoPreview";
import { useHoldWarningDialog } from "./useHoldWarningDialog";
import { useStripeRedirectReturn } from "./useStripeRedirectReturn";
import { useCheckoutUrlSync } from "./useCheckoutUrlSync";
import {
  mergeCheckoutSearch,
  phaseToStep as phaseToUrlStep,
  readCheckoutSearch,
  stashSignInAmounts,
  type CheckoutUrlSnapshot,
} from "./checkout-url-state";
import {
  estimateCartTotal,
  estimateHeldOrderCharge,
  withBuyerUnitTotals,
} from "@/lib/pricing/order-estimate";
import { withStatedHeldFees } from "@/lib/pricing/held-order-fees";
import { useRefetchStaleEstimates } from "@/lib/pricing/useRefetchStaleEstimates";
import { platformFeeRateLabel } from "@/lib/pricing/fee-rate-label";
import { taxRateLabelBps } from "@/lib/pricing/tax-rate-label";
import { derivePendingCartFees } from "@th/core/lib/orders/pending-cart-fees";
import {
  defaultChosenAmountCents,
  isChosenAmountValid,
  isPayWhatYouWant,
} from "@/lib/pricing/pay-what-you-want";
import { CheckoutDetailsStep } from "./CheckoutDetailsStep";
import {
  BORDER_SUBTLE,
  DIVIDER_COLOR,
  srOnlyStyle,
} from "./checkout-tokens";

const EXPECTED_CHECKOUT_CONTROL_FLOW_ERRORS = new Set([
  "selection-required",
  "sign-in required",
  "email-verification-required",
  "billing-address-required",
  "waiver-required",
  "terms-required",
  "refund-policy-required",
  "already in progress",
  // The hold expired (or was released) mid-createCheckout: step 1 already
  // shows why, and the minted order was released.
  HOLD_RESET_DURING_CHECKOUT,
  // The purchase went through (or is being verified): no new order.
  PURCHASE_ALREADY_SETTLED,
]);

function isExpectedCheckoutControlFlowError(err: unknown): boolean {
  return (
    err instanceof Error &&
    EXPECTED_CHECKOUT_CONTROL_FLOW_ERRORS.has(err.message)
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase → step mapping
// ─────────────────────────────────────────────────────────────────────────────

const STEP_ORDER: CheckoutStepId[] = [
  "tickets",
  "details",
  "payment",
  "confirmed",
];

/**
 * Map the granular reducer phase to a user-visible step.
 *
 * Two cases pin to "details":
 *  - `creating`: createCheckout is in flight; no clientSecret yet. Flipping
 *    to "payment" here would (a) flash a blank Stripe surface and (b)
 *    unmount the details block — and on error the reducer reverts to
 *    `held`, remounting the form and wiping the user's typed input.
 *  - Free orders (`isFreeOrder = true`) bypass payment entirely; the
 *    server returns `clientSecret: null` and we jump straight to
 *    "confirmed", so keeping non-confirmed phases on "details" avoids
 *    the same blank-Stripe flicker.
 */
function phaseToStep(
  phase: CheckoutPhase,
  isFreeOrder = false,
): CheckoutStepId {
  switch (phase) {
    case "selecting":
    case "holding":
      return "tickets";
    case "held":
      return "details";
    case "creating":
      return "details";
    case "paying":
    case "confirming":
      return isFreeOrder ? "details" : "payment";
    case "confirmed":
    case "done":
      return "confirmed";
  }
}

function completedSteps(step: CheckoutStepId): CheckoutStepId[] {
  const idx = STEP_ORDER.indexOf(step);
  return STEP_ORDER.slice(0, idx);
}

export type WaiverInfo = {
  id: string;
  name: string;
  body: string;
  version: number;
};

export type CheckoutProps = {
  event: EventDetail;
  ticketTypes: TicketTypeSummary[];
  /** Place layout for the venue, if one exists. Null falls back to GA grid. */
  placeLayout: PlaceLayout | null;
  /** Optional order ID to resume (from abandoned cart recovery) */
  resumeOrderId?: string;
  /** Waiver the buyer must accept before checkout, if any. */
  waiver?: WaiverInfo | null;
  /**
   * The server saw a Stripe redirect return in the URL — seeds the hook so
   * the server render and the first client render agree (see useCheckoutState).
   */
  isStripeRedirectReturn?: boolean;
  /** True when a guest password unlock cookie should be persisted after sign-in. */
  shouldSyncSignedUnlock?: boolean;
  /** The event's gate type; picks which signed cookie the sync converts. */
  signedUnlockGateType?: "NONE" | "PASSWORD" | "APPLICATION" | null;
};

export const Checkout = ({
  event,
  ticketTypes,
  placeLayout,
  resumeOrderId,
  waiver,
  isStripeRedirectReturn = false,
  shouldSyncSignedUnlock = false,
  signedUnlockGateType = null,
}: CheckoutProps) => {
  const { showSignInOverlay, showOverlayPanel } = useAppOverlay();
  const currentUrl =
    useCurrentUrl({ absolute: false }) ?? `/events/checkout/${event.slug}`;
  const fmt = useFormatters();
  const searchParams = useSearchParams();
  // A reload of the confirmed URL (`?step=confirmed&order=<uuid>`) restores
  // that order's confirmation instead of seeding a cart. Read once, at mount.
  // Not over a Stripe redirect return or a cart resume: those own the page.
  const [restoredOrderId] = useState<string | null>(() =>
    isStripeRedirectReturn || resumeOrderId
      ? null
      : readCheckoutSearch(searchParams ?? new URLSearchParams()).orderId ??
        null,
  );
  const initialUrlPromoCodesRef = useRef<string[] | null>(null);
  if (initialUrlPromoCodesRef.current === null) {
    initialUrlPromoCodesRef.current = restoredOrderId
      ? []
      : [
          ...readCheckoutSearch(searchParams ?? new URLSearchParams())
            .promoCodes,
        ];
  }
  const initialUrlPromoCodes = initialUrlPromoCodesRef.current;

  const sessionQuery = authClient.useSession();

  // Defer session-dependent rendering until after hydration so the server
  // and initial client tree always match (avoids sign-in gate mismatch).
  const [hasMounted, setHasMounted] = useState(false);
  useEffect(() => {
    setHasMounted(true);
  }, []);
  const isSignedIn = hasMounted && Boolean(sessionQuery.data?.user);
  // The restore waits for the session, so a signed-in buyer's first render
  // (no session yet) is not mistaken for a signed-out one; and a FAILED
  // session read is "unknown" (transient), never "signed-out" (definitive).
  const restoreSession: RestoreSessionStatus =
    !hasMounted || sessionQuery.isPending
      ? "loading"
      : sessionQuery.data?.user
        ? "signed-in"
        : sessionQuery.error
          ? "unknown"
          : "signed-out";
  // "restoring" until the verdict; "failed" shows the picker's notice.
  const [restoreState, setRestoreState] = useState<RestoreState>(
    restoredOrderId ? "restoring" : null,
  );
  const buyerEmail = sessionQuery.data?.user?.email ?? undefined;
  // emailVerified is a standard Better Auth user field. Treat unknown as
  // "verified" so we never accidentally block before the session loads.
  const isEmailVerified =
    !isSignedIn ||
    (sessionQuery.data?.user as { emailVerified?: boolean } | undefined)
      ?.emailVerified !== false;

  const contactFormRef = useRef<CheckoutContactFormRef>(null);
  const detailsSectionRef = useRef<HTMLElement>(null);

  // Persisted draft of the contact + billing form. The details step (and the
  // form inside it) unmounts whenever the buyer steps back to tickets, lets
  // the hold expire, or moves forward to payment — taking the form's local
  // state with it. We mirror every field change into this ref (no re-render)
  // and read it back when computing the form's `default*` props, so a remount
  // re-seeds exactly what the buyer typed instead of a blank form. Ref, not
  // state: the remount is itself a phase-driven render, so reading
  // `.current` there always sees the latest draft without thrashing renders
  // on every keystroke.
  const contactDraftRef = useRef<ContactDraft | null>(null);
  const handleContactDraftChange = useCallback((draft: ContactDraft) => {
    contactDraftRef.current = draft;
  }, []);

  // ── Sign-in redirect that preserves the cart ─────────────────────
  // `currentUrl`'s search portion goes stale: useCurrentUrl re-reads
  // window.location.search only when the *pathname* changes, but
  // useCheckoutUrlSync writes the cart via history.replaceState on the SAME
  // pathname (and debounces 200ms). Redirecting a guest to /sign-in with
  // that stale URL dropped the ?step=…&t=… cart serialization, so they
  // came back to an empty selection. Build the redirect at click time from
  // the live in-memory cart instead (ref-backed: the snapshot is populated
  // after useCheckoutState returns, the callback only runs on user action).
  const cartSnapshotRef = useRef<
    | (CheckoutUrlSnapshot & { donationAmounts?: Record<string, number> })
    | null
  >(null);
  const buildSignInRedirect = useCallback(() => {
    const fallbackPath = `/events/checkout/${event.slug}`;
    if (typeof window === "undefined") return fallbackPath;
    const basePath = window.location.pathname || fallbackPath;
    const snapshot = cartSnapshotRef.current;
    // PWYW amounts never go in the URL: they are stashed in this tab's
    // sessionStorage and only a one-time nonce rides the redirect, so a
    // crafted `a=` link cannot pre-fill an amount (see `takeSignInAmounts`).
    const search = snapshot
      ? mergeCheckoutSearch(window.location.search, {
          step: snapshot.step,
          quantities: snapshot.quantities,
          promoCodes: snapshot.promoCodes,
          amountsToken: snapshot.donationAmounts
            ? stashSignInAmounts(snapshot.donationAmounts)
            : null,
        })
      : window.location.search.replace(/^\?/, "");
    return search ? `${basePath}?${search}` : basePath;
  }, [event.slug]);

  /**
   * Every amount checkout renders goes through the `Money` primitive, so the
   * page, the receipt and the confirmation email agree by construction. This is
   * `Money.format` — the string form, for the inline-styled spans this page is
   * built from, which cannot host a Tamagui `<Text>`.
   *
   * It replaces `fmtCurrency`, one of the paths that predates the money
   * consolidation. Both end at `Intl.NumberFormat(locale, {style:"currency"})`
   * over the same `toMajorUnits`, and `Money.format` pins the currency's
   * fraction digits explicitly (the EXACT contract — a summary is an accounting
   * statement, and a missing ".00" reads as truncation). The active locale is
   * passed through, so this is not the en-US default.
   */
  const locale = useLocale();
  const t = useTranslations();
  const formatPrice = useCallback(
    (cents: number) =>
      Money.format(cents, {
        currency: event.pricing?.currency ?? "usd",
        locale,
      }),
    [locale, event.pricing?.currency],
  );

  const {
    waiverAccepted,
    setWaiverAccepted,
    waiverCheckboxRef,
    waiverHighlight,
    termsAccepted,
    setTermsAccepted,
    refundPolicyAccepted,
    setRefundPolicyAccepted,
    setAgreementCheckboxRef,
    handleTermsRequired,
    handleSelectionRequired,
    handleBillingAddressRequired,
    handleWaiverRequired,
    handleRefundPolicyRequired,
  } = useCheckoutAcceptanceNudges(contactFormRef);

  // ── All checkout state lives in the hook ───────────────────────────
  const {
    phase,
    errorMessage,
    orderId,
    payment: sessionPayment,
    order,
    clientSecret,
    countdown,
    isExpired,
    isHoldActive,
    quantities,
    selectedQty,
    subtotalCents,
    shownLines,
    shownLineCents,
    selectedSeatIds,
    handleQuantityChange,
    handleSeatToggle,
    donationAmounts,
    handleDonationAmountChange,
    showDonationErrors,
    quotedDonationAmounts,
    promoPreviewPaused,
    hasInvalidDonation,
    seatAvailabilityQuery,
    savedProfileQuery,
    feeRatesQuery,
    taxEstimateQuery,
    setBillingAddressForTax,
    handleHoldTickets,
    handleCheckout,
    handlePaymentSuccess,
    handlePaymentError,
    handleRedirectPaymentSuccess,
    handleRedirectPaymentError,
    isRedirectReturnPending,
    isPaymentReceivedUnconfirmed,
    unconfirmedPaymentOutcome,
    handleRedirectUnverifiable,
    handleRestoreVerdict,
    handlePaymentSubmittingChange,
    isPaymentSubmitting,
    isBackNavigationLocked,
    handleBackToSelecting,
    handleBackToHeld,
    isPending,
    isHolding,
    promoCodes,
    handleApplyPromoCode,
    handleRemovePromoCode,
    attributionArtistSelection,
    setAttributionArtistSelection,
  } = useCheckoutState({
    event,
    ticketTypes,
    resumeOrderId,
    restoredOrderId,
    isStripeRedirectReturn,
    shouldSyncSignedUnlock,
    signedUnlockGateType,
    isSignedIn,
    isEmailVerified,
    buyerEmail,
    contactFormRef,
    onSignInRequired: () =>
      showSignInOverlay({ redirect: buildSignInRedirect() }),
    onEmailVerificationRequired: (email) =>
      showOverlayPanel("verify-email", { email }),
    currentUrl,
    waiverAccepted: waiver ? waiverAccepted : undefined,
    termsAccepted,
    refundPolicyAccepted,
    onTermsRequired: handleTermsRequired,
    onSelectionRequired: handleSelectionRequired,
    onBillingAddressRequired: handleBillingAddressRequired,
    onWaiverRequired: handleWaiverRequired,
    onRefundPolicyRequired: handleRefundPolicyRequired,
  });

  // Mirror the live cart into the ref consumed by buildSignInRedirect
  // (declared before the hook call, invoked only from event handlers —
  // an effect is safe: handlers never run before the commit that fills it).
  //
  // The SIGN-IN snapshot also carries the buyer's pay-what-you-want amounts
  // (selected PWYW tiers only): an OAuth round trip is a full navigation, and
  // without them the buyer came back to the default amount. The continuous
  // URL sync below still never writes them.
  useEffect(() => {
    const selectedAmounts: Record<string, number> = {};
    for (const ticketType of ticketTypes) {
      if (!isPayWhatYouWant(ticketType)) continue;
      if ((quantities[ticketType.id] ?? 0) <= 0) continue;
      selectedAmounts[ticketType.id] =
        donationAmounts[ticketType.id] ?? defaultChosenAmountCents(ticketType);
    }
    cartSnapshotRef.current = {
      step: phaseToUrlStep(phase),
      quantities,
      promoCodes,
      donationAmounts: selectedAmounts,
    };
  }, [phase, quantities, promoCodes, ticketTypes, donationAmounts]);

  const {
    livePromoDiscountCents,
    livePromoFeeReductionCents,
    liveHeldCartFees,
    memberDiscounts,
    promoCodeRejections,
    promoPreviewUnavailable,
    urlPromoCheckUnavailable,
  } = useCheckoutPromoPreview({
    eventId: event.id,
    initialUrlPromoCodes,
    quantities,
    donationAmounts: quotedDonationAmounts,
    // The seats step 1 prices from (`shownLines`), so a code on an override
    // seat previews the discount on that seat's own price.
    selectedSeatIds,
    ticketTypes,
    // An amount the hold would refuse — or one fixed but not yet quoted —
    // pauses the preview (and its pruning). See `promoPreviewPaused`.
    paused: promoPreviewPaused,
    promoCodes,
    isSignedIn,
    pendingOrderId: orderId,
    onApplyPromoCode: handleApplyPromoCode,
    onRemovePromoCode: handleRemovePromoCode,
  });

  // Reflect cart state in the URL so refreshes and shared links preserve the
  // buyer's progress. Read-on-mount, debounced write-on-change. Seats and
  // donation amounts are intentionally excluded from the WRITE — they need
  // server-side validation we don't have a re-hold path for yet. (Amounts
  // carried back by the sign-in redirect are read once, below, then stripped.)
  useCheckoutUrlSync({
    phase,
    quantities,
    promoCodes,
    orderId,
    validTicketTypeIds: useMemo(
      () => ticketTypes.map((tt) => tt.id),
      [ticketTypes],
    ),
    onSeedQuantity: useCallback(
      (ticketTypeId: string, qty: number) => {
        // handleQuantityChange is delta-based; replay +1 N times to reach
        // the desired starting quantity. Functional setState batches.
        for (let i = 0; i < qty; i += 1) {
          handleQuantityChange(ticketTypeId, 1);
        }
      },
      [handleQuantityChange],
    ),
    onSeedDonationAmount: useCallback(
      (ticketTypeId: string, amountCents: number) => {
        const ticketType = ticketTypes.find((tt) => tt.id === ticketTypeId);
        if (ticketType && isPayWhatYouWant(ticketType)) {
          handleDonationAmountChange(ticketTypeId, amountCents);
        }
      },
      [ticketTypes, handleDonationAmountChange],
    ),
  });

  // A pay-what-you-want tier is priced at the buyer's chosen amount
  // everywhere below — its stored `priceCents` is always 0. `null` on FIXED
  // tiers.
  const chosenAmountCentsFor = useCallback(
    (ticketType: (typeof ticketTypes)[number]) =>
      isPayWhatYouWant(ticketType)
        ? (donationAmounts[ticketType.id] ??
          defaultChosenAmountCents(ticketType))
        : null,
    [donationAmounts],
  );

  const displayTicketTypes = useMemo(
    () =>
      withBuyerUnitTotals(
        ticketTypes,
        feeRatesQuery.data?.perTicketEstimates,
      ).map((ticketType) => {
        const chosenAmountCents = chosenAmountCentsFor(ticketType);
        return {
          ...ticketType,
          chosenAmountCents,
          // An amount the hold would refuse is never quoted as a line price.
          chosenAmountInvalid:
            chosenAmountCents != null &&
            !isChosenAmountValid(ticketType, chosenAmountCents),
          // Step 1's line at the shown prices: a picked $50 seat on a $35
          // tier is $50 here, as once held.
          shownLineCents: shownLineCents[ticketType.id] ?? null,
        };
      }),
    [
      ticketTypes,
      feeRatesQuery.data?.perTicketEstimates,
      chosenAmountCentsFor,
      shownLineCents,
    ],
  );
  // A cached fee-rates row priced at another face reads "Calculating total…";
  // refetch the rates once so it does not stay that way until a remount.
  useRefetchStaleEstimates(displayTicketTypes, feeRatesQuery.refetch);
  // Pre-hold: with a selected PWYW amount invalid there is no honest total —
  // the summary, the mobile bar and the live region all hold at "—".
  const totalUnavailable = hasInvalidDonation && !order;

  // Pre-hold total estimate with the SERVER's aggregate order math (tax
  // rounded once on the aggregate, processor fixed fee grossed up once per
  // ORDER) — never Σ(fee-inclusive unit × qty), which double-counts the fixed
  // processor fee and drifts on tax rounding. Null = still unknown
  // ("Calculating total…"), matching the previous unknown-estimate guard.
  //
  // The cart at the prices the buyer is shown (`shownLines`): each picked
  // override seat at its own price, fees and tax on that price, as the hold
  // charges it. From `ticketType.priceCents × qty` a $50 seat on a $35 tier
  // estimated $39.85 until Hold re-priced it to $56.58.
  const orderEstimate = useMemo(
    () =>
      estimateCartTotal(
        feeRatesQuery.data,
        shownLines,
        // The live promo discount, priced the way the charge prices it (tax
        // and gross-up on the discounted subtotal). Leaving it out made the
        // visible "Estimated total" ignore an applied code while the live
        // region subtracted it from the full-price total.
        //
        // With it, the platform fee the charge will not take: a ticket the
        // discount brings down to $0 pays no platform fee (owner ruling
        // 2026-10-10). Without it step 1 quoted that ticket's fee, and the
        // tax and processing on it, above the charge.
        {
          discountCents: livePromoDiscountCents,
          platformFeeReductionCents: livePromoFeeReductionCents,
        },
      ),
    [
      feeRatesQuery.data,
      shownLines,
      livePromoDiscountCents,
      livePromoFeeReductionCents,
    ],
  );
  const displaySubtotalCents = orderEstimate?.totalCents ?? 0;
  const isDisplaySubtotalKnown = orderEstimate !== null;

  // A redirect return confirms by the PaymentIntent alone (its own entry —
  // the page's remembered order id is stale after the redirect).
  useStripeRedirectReturn(
    handleRedirectPaymentSuccess,
    handleRedirectPaymentError,
    handleRedirectUnverifiable,
  );

  const {
    showHoldWarning,
    dialogRef: holdWarningDialogRef,
    cancelButtonRef: holdWarningCancelRef,
    openHoldWarning,
    closeHoldWarning,
    handleHoldWarningKeyDown,
  } = useHoldWarningDialog({
    // Never left open over the confirmation.
    forceClosed: phase === "confirmed" || phase === "done",
  });

  /** Handle stepper step clicks — navigate back to completed steps */
  const handleStepClick = useCallback(
    (stepId: CheckoutStepId) => {
      if (stepId === "tickets") {
        // Going back to tickets releases the hold — warn the user first
        openHoldWarning();
      } else if (stepId === "details") {
        // Going back to details from payment is safe — hold is preserved
        handleBackToHeld();
      }
      // Clicking "payment" or "confirmed" when already past them is a no-op
    },
    [handleBackToHeld, openHoldWarning],
  );

  // Build seat label lookup: ticketTypeId → string[] of seat labels
  const selectedSeatLabels = useMemo(() => {
    if (!selectedSeatIds || !seatAvailabilityQuery.data?.seats)
      return undefined;
    const seatMap = new Map<string, string>();
    for (const s of seatAvailabilityQuery.data.seats) {
      seatMap.set(s.id, s.label);
    }
    const result: Record<string, string[]> = {};
    for (const [ttId, ids] of Object.entries(selectedSeatIds)) {
      if (ids.length > 0) {
        result[ttId] = ids.map((id) => seatMap.get(id) ?? id);
      }
    }
    return result;
  }, [selectedSeatIds, seatAvailabilityQuery.data?.seats]);

  // Formatted date label for the info bar
  const dateLabel = useMemo(() => {
    const d = event.startsAt;
    const weekday = fmt.dateTime(d, { weekday: "short" });
    const monthDay = fmt.dateTime(d, { month: "short", day: "numeric" });
    const time = fmt.dateTime(d, { hour: "numeric", minute: "2-digit" });
    return `${weekday}, ${monthDay} \u00B7 ${time}`;
  }, [event.startsAt, fmt]);

  // ── Derive step indicator from phase ────────────────────────────
  // A zero subtotal skips Stripe entirely: `phaseToStep` keeps free orders on
  // "details" until they land on "confirmed". Named because the payment-chunk
  // warm-up below has to make the same distinction.
  const isFreeOrder = subtotalCents === 0;
  const currentStepId = phaseToStep(phase, isFreeOrder);
  const currentCompletedSteps = useMemo(
    () => completedSteps(currentStepId),
    [currentStepId],
  );

  // Track slide direction so the animation knows which way to go
  const prevStepRef = useRef<CheckoutStepId>(currentStepId);
  const [slideDirection, setSlideDirection] =
    useState<SlideDirection>("forward");
  useEffect(() => {
    const prev = prevStepRef.current;
    if (prev !== currentStepId) {
      const prevIdx = STEP_ORDER.indexOf(prev);
      const nextIdx = STEP_ORDER.indexOf(currentStepId);
      setSlideDirection(
        currentStepId === "confirmed"
          ? "fade"
          : nextIdx > prevIdx
            ? "forward"
            : "back",
      );
      prevStepRef.current = currentStepId;
    }
  }, [currentStepId]);

  // ── Warm the payment chunk while the buyer types ────────────────
  // `CheckoutPaymentStep` pulls `StripePaymentCard` in with next/dynamic, so
  // without this the browser only STARTS fetching that chunk on the click
  // that advances to payment — measured at ~1.5s of skeleton over Slow 4G,
  // on top of createCheckout and Stripe's own iframes. Fetch it while the
  // details form is on screen instead, so by the time `currentStepId` flips
  // the module is already resident.
  //
  // Not on the tickets step: there is no hold yet, and a session that never
  // gets one should not pay for Stripe's bundle. (`CheckoutTicketsStep` lazily
  // loads `SeatMapPicker` too, but tickets is always the FIRST step, so that
  // chunk is warm before anyone can transition onto it — this is the only one
  // that lands on a step change.) Not on a FREE order either —
  // `phaseToStep` pins those to "details" for every phase short of
  // "confirmed", so a free checkout never renders `currentStepId === "payment"`
  // and would download Stripe's bundle to render none of it.
  //
  // Idempotent via the ref — the module map would dedupe anyway, but the ref
  // keeps a re-render from even asking.
  const hasWarmedPaymentChunk = useRef(false);
  useEffect(() => {
    if (
      isFreeOrder ||
      currentStepId !== "details" ||
      hasWarmedPaymentChunk.current
    ) {
      return;
    }
    hasWarmedPaymentChunk.current = true;
    void import("./StripePaymentCard").catch(() => {
      // Deliberately swallowed and NOT retried here: this is a prefetch, and
      // the recovery path is next/dynamic issuing the same import when the
      // payment step actually renders — which surfaces the failure to the
      // buyer at the point it matters. Leaving the flag set stops this effect
      // from re-requesting a chunk that is already failing.
    });
  }, [currentStepId, isFreeOrder]);

  // ── Auto-focus: scroll to billing section when hold succeeds ──
  const hasScrolledToDetails = useRef(false);
  useEffect(() => {
    if (
      phase === "held" &&
      !hasScrolledToDetails.current &&
      detailsSectionRef.current
    ) {
      hasScrolledToDetails.current = true;
      detailsSectionRef.current.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
      // Focus first empty input in the contact form
      const firstInput =
        detailsSectionRef.current.querySelector<HTMLInputElement>(
          "input:not([value]):not([disabled])",
        ) ??
        detailsSectionRef.current.querySelector<HTMLInputElement>(
          "input[value='']",
        );
      if (firstInput) {
        setTimeout(() => firstInput.focus(), 400);
      }
    }
    // Reset scroll flag if user goes back to selecting
    if (phase === "selecting") {
      hasScrolledToDetails.current = false;
    }
  }, [phase]);

  // ── Effective fee mode ──────────────────────────────────────────
  // Prefer the order's stamped feeMode (present after createCheckout, i.e.
  // paying/confirming/confirmed); fall back to the fee-rates query for the
  // held/selecting phases where the order snapshot doesn't carry it. Drives
  // whether the buyer-funded processor fee is included in the displayed total.
  //
  // The HOLD's recorded mode wins over the event's current setting whenever
  // there is a hold: `createCheckout`'s stamp, else the mode every held line
  // was priced under (`meta.effectiveFeeMode`, the same field a resumed
  // cart's mode comes from). The rows AND the held-charge solve below read
  // this one value, so they can't disagree.
  const effectiveFeeMode =
    order?.feeMode ??
    (order
      ? derivePendingCartFees(
          order.items.map((item) => item.meta),
          order.feesPlatformCents,
        ).feeMode
      : null) ??
    feeRatesQuery.data?.feeMode ??
    null;

  // ── The held step's charge ────────────────────────────────────────
  // Before createCheckout stamps the real numbers, step 2 shows the charge
  // the SAME solve will produce: tax and (PASS_THROUGH) the processor
  // gross-up on the discounted subtotal. Null once the server is
  // authoritative, or while fee rates can't price it (the old display then
  // stands).
  // "3.33%, max $0.50/ticket" — the rate WITH its per-ticket cap, so "$1.00"
  // beside it on a $55 order doesn't read as a miscalculated 3.33% of $55
  // ("3.33% (max $0.50) + $0.30" when a fixed part sits outside the cap).
  const platformFeeRateLabelText = platformFeeRateLabel(
    feeRatesQuery.data?.platformFeeLabel,
    feeRatesQuery.data?.platformFeeRates,
    t,
    formatPrice,
  );
  const isPostCheckoutPhase =
    phase === "paying" ||
    phase === "confirming" ||
    phase === "confirmed" ||
    phase === "done";
  // ── The held order, at the fee the charge will take ───────────────
  // While held, the order every surface below reads carries the platform
  // fee the SERVER states for this cart with the codes as they stand
  // (`promos.preview`'s `heldCartFees`): a ticket a code brings down to $0
  // pays none, and a fee waiver may sit on a different ticket because of it.
  // The page never works that out from the order's own fee; see
  // `@/lib/pricing/held-order-fees`. Once createCheckout has answered, the
  // order is the server's and is passed through untouched.
  const heldOrder = useMemo(
    () =>
      isPostCheckoutPhase
        ? order
        : withStatedHeldFees(order, liveHeldCartFees, effectiveFeeMode),
    [order, isPostCheckoutPhase, liveHeldCartFees, effectiveFeeMode],
  );
  const heldCharge = useMemo(
    () =>
      heldOrder && !isPostCheckoutPhase
        ? estimateHeldOrderCharge(
            feeRatesQuery.data,
            { ...heldOrder, feeMode: effectiveFeeMode },
            livePromoDiscountCents,
          )
        : null,
    [
      heldOrder,
      isPostCheckoutPhase,
      feeRatesQuery.data,
      livePromoDiscountCents,
      effectiveFeeMode,
    ],
  );

  // The order the confirmation totals (see useConfirmedOrder).
  const isRestoringConfirmation =
    restoreState === "restoring" && orderId === restoredOrderId;
  const confirmedOrder = useConfirmedOrder({
    isConfirmed: phase === "confirmed" || phase === "done",
    restore:
      isRestoringConfirmation
        ? {
            eventId: event.id,
            session: restoreSession,
            refetchSession: sessionQuery.refetch,
            sessionRefetching: sessionQuery.isRefetching,
          }
        : null,
    orderId,
    sessionPayment,
    pageOrder: order
      ? {
          ...order,
          taxAmountCents: order.taxAmountCents ?? 0,
          feeMode: effectiveFeeMode,
        }
      : null,
  });

  // The rate the Taxes rows print — null (amount only) when the charged lines
  // sit on different bases, where no single percentage produces the amount.
  // The fee-rates lines cover the moments the estimate query is not loaded.
  const taxRowRateBps = taxRateLabelBps(
    taxEstimateQuery.data?.taxImpositions ??
      feeRatesQuery.data?.taxImpositions,
  );

  // ── Compute total for mobile CTA + payment button ───────────────
  // Mirrors the server's `paymentIntentAmount` formula:
  //   PASS_THROUGH: gross + buyerFees + processorFee + tax − credit
  //   ABSORB:       gross + buyerFees + tax − credit (processor NOT added)
  // For PASS_THROUGH the buyer funds the grossed-up processor fee; in ABSORB
  // the buyer doesn't, so it's excluded (nor does the seller: with separate
  // charges and transfers it comes out of the platform's balance). See the
  // comment in `packages/core/src/use-cases/orders/checkout-helpers.ts` and
  // the `paymentIntentAmountCents` formula in `create-checkout.ts`.
  const {
    displayTotalCents,
    displayTaxCents,
    payButtonLabel,
    displayTotalLabel,
    liveAnnouncement,
  } = useCheckoutDisplayTotal({
    heldCharge,
    totalUnavailable,
    order: heldOrder,
    phase,
    isDisplaySubtotalKnown,
    displaySubtotalCents,
    livePromoDiscountCents,
    taxEstimate: taxEstimateQuery.data,
    feeMode: effectiveFeeMode,
    formatPrice,
  });

  // ── Contact form defaults (persisted draft wins) ────────────────────
  // Computed every render (not memoized) so the render that remounts the
  // details step re-seeds the form from the latest draft. The persisted
  // draft takes precedence over the saved profile / session so a buyer's
  // in-session edits survive a step back-and-forward; we fall back to the
  // saved profile only when no draft field has been touched yet.
  const contactDraft = contactDraftRef.current;
  const savedProfile = savedProfileQuery.data;
  const defaultNameValue = contactDraft?.name?.trim()
    ? contactDraft.name
    : (sessionQuery.data?.user?.name ?? undefined);
  const defaultEmailValue = contactDraft?.email?.trim()
    ? contactDraft.email
    : (sessionQuery.data?.user?.email ?? undefined);
  const defaultPhoneValue = contactDraft?.phone?.trim()
    ? contactDraft.phone
    : (savedProfile?.phone ?? undefined);
  const draftBilling = contactDraft?.billing;
  const hasDraftBilling = Boolean(
    draftBilling &&
    (draftBilling.line1 ||
      draftBilling.city ||
      draftBilling.state ||
      draftBilling.postalCode ||
      draftBilling.country),
  );
  const defaultBillingValue: BillingAddress | undefined = hasDraftBilling
    ? {
        line1: draftBilling?.line1 ?? "",
        ...(draftBilling?.line2 ? { line2: draftBilling.line2 } : {}),
        city: draftBilling?.city ?? "",
        state: draftBilling?.state ?? "",
        postalCode: draftBilling?.postalCode ?? "",
        country: draftBilling?.country ?? "",
      }
    : savedProfile?.billingAddressLine1
      ? {
          line1: savedProfile.billingAddressLine1,
          line2: savedProfile.billingAddressLine2 ?? undefined,
          city: savedProfile.billingCity ?? "",
          state: savedProfile.billingState ?? "",
          postalCode: savedProfile.billingPostalCode ?? "",
          country: savedProfile.billingCountry ?? "",
        }
      : undefined;

  // Apply the restored confirmation's verdict once it is an answer:
  // "confirm" settles the purchase (as an in-session confirm does);
  // "fallback" drops to the EMPTY picker, whose URL write strips
  // `step=confirmed&order=`, with a notice. A transient "unavailable" does
  // neither: the page, and the confirmed URL, stay put with a retry.
  useApplyRestoreVerdict(confirmedOrder.restoreVerdict, (verdict) => {
    handleRestoreVerdict(verdict);
    setRestoreState(verdict === "confirm" ? "confirmed" : "failed");
  });
  // The notice goes for good once the buyer moves past the picker.
  useEffect(() => {
    setRestoreState((state) => restoreStateAfterPhase(state, phase));
  }, [phase]);

  // A Stripe redirect return being verified, or a payment Stripe took that
  // our confirm could not finish: NOT the steps. Those would mount a fresh
  // Stripe card ("Pay $45.42", from the pre-hold estimate) and quote the same
  // estimate in the sidebar and tray, for an order already paid.
  const checkoutView = checkoutScreen({
    phase,
    isRedirectReturnPending,
    isPaymentReceivedUnconfirmed,
  });
  if (checkoutView !== "steps") {
    return (
      <div
        data-testid="checkout-payment-interstitial"
        style={{ display: "flex", flexDirection: "column", gap: 16 }}
      >
        <CheckoutInfoBar
          eventName={event.name}
          dateLabel={dateLabel}
          venueName={event.location?.name ?? undefined}
          backHref={`/events/${event.slug}`}
          countdown={null}
          backLocked={checkoutView === "redirect-confirming"}
        />
        <CheckoutConfirmedPending
          status={
            checkoutView === "redirect-confirming"
              ? "confirming"
              : (unconfirmedPaymentOutcome ?? "unverified")
          }
          orderId={orderId}
        />
      </div>
    );
  }

  // ── Render ─────────────────────────────────────────────────────────
  return (
    <>
      {/* Screen-reader live region for total / tax updates */}
      <div aria-live="polite" aria-atomic="true" style={srOnlyStyle}>
        {liveAnnouncement}
      </div>

      <div
        className="checkout-wrapper"
        style={{ maxWidth: "100%", boxSizing: "border-box" }}
      >
        {/* ── Event context bar ─────────────────────────────────────────── */}
        <CheckoutInfoBar
          eventName={event.name}
          dateLabel={dateLabel}
          venueName={event.location?.name ?? undefined}
          backHref={`/events/${event.slug}`}
          countdown={isHoldActive ? countdown : null}
          isExpired={isExpired}
          // Not off the page mid-payment (a Stripe confirm submitting, or
          // the confirm in flight). After confirmation it is open again.
          backLocked={isPaymentSubmitting || phase === "confirming"}
        />

        {/* ── Progress stepper ──────────────────────────────────────────── */}
        <CheckoutStepper
          currentStepId={currentStepId}
          completedStepIds={currentCompletedSteps}
          onStepClick={handleStepClick}
          // Locked while a Stripe confirm is submitting, too: "Details"
          // unmounts the form mid-confirm, "Tickets" releases the order.
          backNavigationLocked={isBackNavigationLocked}
          // Step 4 says "Confirmed" only for a known-paid order, in every
          // state of the confirmation (see `stepperPayment`).
          payment={stepperPayment(confirmedOrder, {
            restoring: isRestoringConfirmation,
            sessionPayment,
          })}
        />

        {/* ── Error banner ──────────────────────────────────────────────── */}
        <FormErrorBanner message={errorMessage} />
        {restoreState === "failed" && phase === "selecting" && (
          <CheckoutRestoreNotice />
        )}

        {/* ── Two-column layout ─────────────────────────────────────────── */}
        <div
          style={{
            overflow: "hidden",
            borderRadius: 0,
            border: currentStepId === "confirmed" ? "none" : BORDER_SUBTLE,
            position: "relative",
          }}
          className={`checkout-card-wrapper ${currentStepId === "confirmed" ? "" : "swiss-dots"}`}
        >
          <div
            style={{
              display: "grid",
              gridTemplateColumns:
                currentStepId === "confirmed" ? "1fr" : "1fr 380px",
            }}
            className="checkout-main-grid"
          >
            {/* ── LEFT: sliding step content ─────────────────────────────── */}
            <CheckoutSlideContainer
              stepKey={currentStepId}
              direction={slideDirection}
            >
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  minWidth: 0,
                }}
              >
                {currentStepId === "tickets" && (
                  <CheckoutTicketsStep
                    placeLayout={placeLayout}
                    displayTicketTypes={displayTicketTypes}
                    quantities={quantities}
                    onQuantityChange={handleQuantityChange}
                    formatPrice={formatPrice}
                    seatAvailability={seatAvailabilityQuery.data?.seats}
                    selectedSeatIds={selectedSeatIds}
                    onSeatToggle={handleSeatToggle}
                    isLoadingSeats={seatAvailabilityQuery.isLoading}
                    donationAmounts={donationAmounts}
                    onDonationAmountChange={handleDonationAmountChange}
                    showDonationErrors={showDonationErrors}
                    // FR-010: sale windows and price flips render on the
                    // EVENT's clock, never the buyer's.
                    timezone={event.timezone}
                  />
                )}

                {/* ──── Step 2: Details ─────────────────────────────────── */}
                {currentStepId === "details" && (
                  <>
                    <CheckoutTicketSummaryHeader
                      selectedQty={selectedQty}
                      onChangeTickets={openHoldWarning}
                      // Off while createCheckout runs (a free claim confirms
                      // mid-call) — see `isBackNavigationLocked`.
                      changeTicketsDisabled={isBackNavigationLocked}
                    />

                    <div style={{ height: 1, background: DIVIDER_COLOR }} />

                    <CheckoutDetailsStep
                      eventId={event.id}
                      attributionArtistSelection={attributionArtistSelection}
                      onAttributionArtistChange={setAttributionArtistSelection}
                      contactFormRef={contactFormRef}
                      detailsSectionRef={detailsSectionRef}
                      defaultName={defaultNameValue}
                      defaultEmail={defaultEmailValue}
                      defaultPhone={defaultPhoneValue}
                      defaultBillingAddress={defaultBillingValue}
                      isSignedIn={isSignedIn}
                      onRequestSignIn={() =>
                        showSignInOverlay({ redirect: buildSignInRedirect() })
                      }
                      onBillingAddressComplete={setBillingAddressForTax}
                      onContactDraftChange={handleContactDraftChange}
                      subtotalCents={subtotalCents}
                      waiver={waiver}
                      waiverAccepted={waiverAccepted}
                      onWaiverAcceptedChange={setWaiverAccepted}
                      waiverHighlight={waiverHighlight}
                      waiverCheckboxRef={waiverCheckboxRef}
                      displayTicketTypes={displayTicketTypes}
                      quantities={quantities}
                      refundPolicyAccepted={refundPolicyAccepted}
                      onRefundPolicyChange={setRefundPolicyAccepted}
                      termsAccepted={termsAccepted}
                      onTermsChange={setTermsAccepted}
                      setAgreementCheckboxRef={setAgreementCheckboxRef}
                      isPending={isPending}
                      onContinueToPayment={() => {
                        handleCheckout().catch(
                          traceIgnoredError(
                            "checkout.payNow",
                            isExpectedCheckoutControlFlowError,
                          ),
                        );
                      }}
                    />
                  </>
                )}

                {currentStepId === "payment" && (
                  <CheckoutPaymentStep
                    selectedQty={selectedQty}
                    onChangeTickets={openHoldWarning}
                    // Off while the order is being paid: releasing the hold
                    // then releases the order Stripe is charging.
                    changeTicketsDisabled={isBackNavigationLocked}
                    onPaymentSubmittingChange={handlePaymentSubmittingChange}
                    clientSecret={clientSecret}
                    onPaymentSuccess={handlePaymentSuccess}
                    onPaymentError={handlePaymentError}
                    totalCents={displayTotalCents ?? undefined}
                    currency={event.pricing?.currency ?? "USD"}
                    eventName={event.name}
                    onBeforePayment={handleCheckout}
                    isCreatingOrder={isPending}
                    payButtonLabel={payButtonLabel}
                    termsAccepted={termsAccepted}
                    refundPolicyAccepted={refundPolicyAccepted}
                  />
                )}

                {currentStepId === "confirmed" &&
                  orderId &&
                  confirmedOrder.status !== "ready" && (
                    <CheckoutConfirmedPending
                      status={confirmedOrder.status}
                      orderId={orderId}
                      // "unavailable" says the payment went through only when
                      // this page knows it did.
                      payment={sessionPayment}
                      {...(confirmedOrder.status === "restore-unavailable"
                        ? {
                            onRetry: confirmedOrder.retry,
                            retrying: confirmedOrder.retrying,
                          }
                        : {})}
                    />
                  )}
                {currentStepId === "confirmed" &&
                  orderId &&
                  confirmedOrder.status === "ready" && (
                  <CheckoutConfirmedStep
                    orderId={orderId}
                    eventName={event.name}
                    eventSlug={event.slug}
                    eventDate={event.startsAt}
                    eventId={event.id}
                    venueName={event.location?.name ?? undefined}
                    venueAddress={
                      [
                        event.location?.addressLine1,
                        event.location?.city,
                        event.location?.region,
                      ]
                        .filter(Boolean)
                        .join(", ") || undefined
                    }
                    eventImageUrl={event.images?.[0] ?? null}
                    // The page's order, or — on a redirect return / a confirm
                    // that outlasted the hold — the CONFIRMED order loaded
                    // from the server. Never the pre-hold estimate.
                    order={confirmedOrder.order}
                    fallbackSubtotalCents={
                      displaySubtotalCents || subtotalCents
                    }
                    ticketTypes={displayTicketTypes}
                    quantities={confirmedOrder.quantities ?? quantities}
                    buyerEmail={buyerEmail}
                    currency={event.pricing?.currency ?? "USD"}
                    selectedSeatLabels={selectedSeatLabels}
                    waiverAccepted={waiver ? waiverAccepted : undefined}
                    payment={confirmedOrder.payment}
                  />
                )}
              </div>
            </CheckoutSlideContainer>

            {currentStepId !== "confirmed" && (
              <CheckoutSidebar
                ticketTypes={displayTicketTypes}
                quantities={quantities}
                selectedQty={selectedQty}
                subtotalCents={displaySubtotalCents}
                // The page's ONE total — the same number the mobile button and
                // the live region show, whichever query has failed.
                displayTotalCents={displayTotalCents}
                // Step 1's rows (Subtotal, fees, tax, discount) and its total
                // all come from this ONE object — the same one behind the
                // live region and the mobile button.
                preHoldEstimate={orderEstimate}
                heldCharge={heldCharge}
                estimateUnavailable={totalUnavailable}
                // The page's ONE tax figure — the tax inside the total, and
                // the tray's (see `surface-orders.ts`).
                displayTaxCents={displayTaxCents}
                order={summarySurfaceOrder(heldOrder, displayTaxCents)}
                orderId={orderId}
                countdown={countdown}
                isExpired={isExpired}
                formatPrice={formatPrice}
                selectedSeatLabels={selectedSeatLabels}
                platformFeeRateLabel={platformFeeRateLabelText}
                processorFeeRateLabel={feeRatesQuery.data?.processorFeeLabel}
                processingMethodRates={
                  feeRatesQuery.data?.processingMethodRates
                }
                taxRateBps={taxRowRateBps}
                taxImpositions={taxEstimateQuery.data?.taxImpositions}
                promoCodes={promoCodes}
                promoCodeRejections={promoCodeRejections}
                promoPreviewUnavailable={promoPreviewUnavailable}
                urlPromoCheckUnavailable={urlPromoCheckUnavailable}
                onApplyPromoCode={handleApplyPromoCode}
                onRemovePromoCode={handleRemovePromoCode}
                promoInputDisabled={
                  phase === "creating" ||
                  phase === "paying" ||
                  phase === "confirming"
                }
                promoDiscountCents={livePromoDiscountCents}
                memberDiscounts={memberDiscounts}
                feeMode={effectiveFeeMode}
                isPostCheckout={
                  phase === "paying" ||
                  phase === "confirming" ||
                  phase === "confirmed" ||
                  phase === "done"
                }
                showHoldButton={currentStepId === "tickets" && selectedQty > 0}
                isHolding={isHolding}
                onHoldTickets={() => {
                  void handleHoldTickets();
                }}
              />
            )}
          </div>
        </div>

        {/* Checkout suppresses the shell's bottom nav (see
            `ConsumerBottomNav`'s HIDDEN_PREFIXES), so below 960px this dock is
            the step's one primary action — full-width, with the running total
            on it. */}
        {selectedQty > 0 && currentStepId !== "confirmed" && (
            <CheckoutMobileCTA
              currentStepId={currentStepId}
              totalLabel={displayTotalLabel}
              ticketTypes={displayTicketTypes}
              quantities={quantities}
              formatPrice={formatPrice}
              subtotalCents={displaySubtotalCents}
              // Step 1's tray rows, from the same estimate as the button's
              // total. None for an invalid amount: the button reads "—".
              preHoldEstimate={totalUnavailable ? null : orderEstimate}
              // The summary's Subtotal and "Taxes (8.88%)" rows, in the tray too.
              taxRateBps={taxRowRateBps}
              isPostCheckout={isPostCheckoutPhase}
              // The summary's tax figure, and while held the solved charge's
              // processing fee: its rows sum to the total on its button.
              order={traySurfaceOrder(heldOrder, displayTaxCents, heldCharge)}
              selectedSeatLabels={selectedSeatLabels}
              cartSubtotalCents={subtotalCents}
              isHolding={isHolding}
              isPending={isPending}
              payButtonLabel={payButtonLabel}
              platformFeeRateLabel={platformFeeRateLabelText}
              processorFeeRateLabel={feeRatesQuery.data?.processorFeeLabel}
              feeMode={effectiveFeeMode}
              promoDiscountCents={livePromoDiscountCents}
              memberDiscounts={memberDiscounts}
              onHoldTickets={() => {
                handleHoldTickets().catch(
                  traceIgnoredError("checkout.mobileHoldTickets"),
                );
              }}
              onContinueToPayment={() => {
                handleCheckout().catch(
                  traceIgnoredError(
                    "checkout.mobileContinueToPayment",
                    isExpectedCheckoutControlFlowError,
                  ),
                );
              }}
            />
          )}
      </div>
      {/* end .checkout-wrapper */}

      {showHoldWarning && (
        <CheckoutHoldWarningDialog
          dialogRef={holdWarningDialogRef}
          cancelButtonRef={holdWarningCancelRef}
          onCancel={() => closeHoldWarning()}
          onConfirm={() => {
            closeHoldWarning({ restoreFocus: false });
            handleBackToSelecting();
          }}
          // Locked while the order is being created or paid.
          confirmDisabled={isBackNavigationLocked}
          onKeyDown={handleHoldWarningKeyDown}
        />
      )}
    </>
  );
};
