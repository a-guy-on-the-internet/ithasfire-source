"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type TurnstileInstance } from "@marsidev/react-turnstile";
import { Elements } from "@stripe/react-stripe-js";
import { Spinner, useTranslations } from "@th/ui";

import { trpc } from "@/trpc";
import {
  EMBED_ORIGIN_BLOCKED_MESSAGE,
  getEmbedHostOrigin,
} from "@/lib/embed-host-origin";
import { getStripe } from "@/config/stripe";
import { formatErrorMessage } from "@/lib/format-error-message";
import { traceIgnoredError } from "@/lib/trace-ignored-error";
import { CheckoutStepper } from "@/app/events/checkout/[...slug]/_components/CheckoutStepper";

import type { EmbedBillingAddress } from "./embed-types";
import type {
  EmbedCheckoutProps,
  EmbedCheckoutFieldKey,
  EmbedPaymentOrder,
} from "./embed-checkout-types";
import {
  DEFAULT_SUPPORT_EMAIL,
  TURNSTILE_SITE_KEY,
  buyerTaxRateBps,
  embedEventUrl,
  formatCurrency,
} from "./embed-helpers";
import {
  SURFACE,
  BORDER_SUBTLE,
  STEEL_BLUE,
  getResolvedEmbedStripeColors,
} from "./embed-theme";
import { EmbedCheckoutHeader } from "./EmbedCheckoutHeader";
import { EmbedEarlierOrderNote } from "./EmbedOrderNotice";
import { EmbedMobileCTABar } from "./EmbedMobileCTABar";
import {
  embedCheckoutItems,
  embedEstimateItems,
  embedShownLineCents,
  withEmbedChosenLinePrices,
} from "./embed-pwyw";
import {
  seatSectionsInCart,
  withRefreshedSeatQuotes,
} from "./embed-seat-quotes";
import { platformFeeRateLabel as cappedPlatformFeeRateLabel } from "@/lib/pricing/fee-rate-label";
import { EmbedPaymentForm } from "./EmbedPaymentForm";
import { saveEmbedHostOrigin } from "./embed-saved-host-origin";
import { rememberEmbedReceiptSecret } from "./embed-receipt-secret";
import { EmbedCheckoutFormSection } from "./EmbedCheckoutFormSection";
import { EmbedGatedEventCard } from "./EmbedGatedEventCard";
import { EmbedErrorScreen } from "./EmbedErrorScreen";
import { EmbedOrderSummarySidebar } from "./EmbedOrderSummarySidebar";
import { embedLinesFromOrder } from "./EmbedSummaryRows";
import {
  CREATE_CHECKOUT_TIMEOUT_MS,
  VERIFICATION_WAIT_MS,
  settledWithin,
} from "./embed-request-timeouts";
import { readEmbedTickets } from "./embed-tickets";
import { useCountdown } from "./useCountdown";
import { useIsFramed } from "./useIsFramed";
import {
  estimateCartTotal,
  withBuyerUnitTotals,
} from "@/lib/pricing/order-estimate";
import { useRefetchStaleEstimates } from "@/lib/pricing/useRefetchStaleEstimates";
import { getRegionsForCountry } from "@/app/events/checkout/[...slug]/_components/address-data";

// Required contact + billing fields, ordered top-to-bottom as rendered in
// EmbedCheckoutFormSection, paired with the DOM ids on each input. Drives both
// the "focus the first/next invalid field" navigation and the invalid-field
// count shown in the validation summary.
const FIELD_DOM_IDS: { key: EmbedCheckoutFieldKey; id: string }[] = [
  { key: "name", id: "embed-guest-name" },
  { key: "email", id: "embed-guest-email" },
  { key: "line1", id: "embed-billing-line1" },
  { key: "city", id: "embed-billing-city" },
  { key: "state", id: "embed-billing-state" },
  { key: "postalCode", id: "embed-billing-postal" },
  { key: "country", id: "embed-billing-country" },
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Single source of truth for "is this required field's value blocking?" —
// shared by the `fieldErrors` message map (which adds localized copy on top)
// and `showValidationErrors` (which needs the raw boolean to pick the first
// offender before the touched/submit re-render lands).
function isFieldValueInvalid(
  key: EmbedCheckoutFieldKey,
  value: string,
): boolean {
  const v = value.trim();
  if (!v) return true;
  if (key === "email") return !EMAIL_RE.test(v);
  return false;
}

export function EmbedCheckout({
  embedId,
  eventId,
  cart,
  guestName,
  guestEmail,
  onGuestNameChange,
  onGuestEmailChange,
  initialDraft,
  onDraftChange,
  clientKey,
  paymentOrder,
  checkoutError,
  checkoutStep: _checkoutStep,
  onCheckoutCreated,
  onCheckoutError,
  onCheckoutFailed,
  onCartUpdate,
  onPaymentSuccess,
  isPaying,
  onPayingChange,
  isConfirming = false,
  loadedAsRedirectReturn = false,
  onPaymentOutcomeUnknown,
  earlierReservedUntil,
  onPaymentOrderExpired,
  waitForReleases,
  onBack,
  stepperStepId,
  completedStepIds,
  initialPromoCodes = [],
}: EmbedCheckoutProps) {
  const t = useTranslations();
  // Resize-bridged iframes grow to content height, so `position: fixed`
  // chrome pins to the END of the widget — suppress the fixed CTA bar and
  // keep the order summary in the flow instead.
  const isFramed = useIsFramed();
  const [isCreating, setIsCreating] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const turnstileRef = useRef<TurnstileInstance | null>(null);
  // The buyer pressed Continue with everything filled in while the bot check
  // was still fetching its token (it starts over each time the details form
  // comes back). The press is kept: the button shows as working, and the
  // order is asked for as soon as the token arrives, with the email and
  // promo codes locked as they were at the press (see `isSubmitting`).
  const [continueWhenVerified, setContinueWhenVerified] = useState(false);
  const createCheckout = trpc.embeds.createGuestCheckout.useMutation();
  const utils = trpc.useUtils();

  // The order the payment step charges, held by the widget so it survives
  // this component unmounting (back to the event detail and forward again).
  // The widget passes it only while the cart is the one it was priced from.
  const clientSecret = paymentOrder?.clientSecret ?? null;
  // Its fee breakdown, from createGuestCheckout.
  const orderFees = paymentOrder?.orderFees ?? null;
  // Its lines as the server priced them, kept beside its fees: once the
  // order exists the summary prints these, never the cart (a seat the buyer
  // saw plain may have been charged a new override, unquoted).
  const orderLineItems = paymentOrder?.lineItems ?? null;
  const orderLines = useMemo(
    () => embedLinesFromOrder(orderLineItems),
    [orderLineItems],
  );

  // ── Promo code state ────────────────────────────────────────────
  // Seeded from the persisted draft so a remount (back to event detail →
  // forward) keeps the buyer's codes.
  const [promoCodes, setPromoCodes] = useState<string[]>(
    () => initialDraft?.promoCodes ?? [],
  );

  const hasAppliedInitialCodesRef = useRef(false);
  useEffect(() => {
    if (hasAppliedInitialCodesRef.current) return;
    hasAppliedInitialCodesRef.current = true;
    // A restored draft already carries the buyer's codes — don't clobber them
    // with the URL seed.
    if (promoCodes.length > 0) return;
    if (initialPromoCodes.length === 0) return;
    setPromoCodes(initialPromoCodes.slice(0, 5));
    // Run once on mount; `promoCodes` is read as the seeded value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPromoCodes]);
  // Billing + acceptances are also seeded from the persisted draft so they
  // survive the details step unmounting when the buyer steps back to tickets.
  const [billingLine1, setBillingLine1] = useState(
    () => initialDraft?.billingLine1 ?? "",
  );
  const [billingLine2, setBillingLine2] = useState(
    () => initialDraft?.billingLine2 ?? "",
  );
  const [billingCity, setBillingCity] = useState(
    () => initialDraft?.billingCity ?? "",
  );
  const [billingState, setBillingState] = useState(
    () => initialDraft?.billingState ?? "",
  );
  const [billingPostalCode, setBillingPostalCode] = useState(
    () => initialDraft?.billingPostalCode ?? "",
  );
  const [billingCountry, setBillingCountry] = useState(
    () => initialDraft?.billingCountry ?? "US",
  );
  const [waiverAccepted, setWaiverAccepted] = useState(
    () => initialDraft?.waiverAccepted ?? false,
  );
  const [termsAccepted, setTermsAccepted] = useState(
    () => initialDraft?.termsAccepted ?? false,
  );
  const [refundPolicyAccepted, setRefundPolicyAccepted] = useState(
    () => initialDraft?.refundPolicyAccepted ?? false,
  );

  // ── Inline validation ────────────────────────────────────────────────
  // `touched` = the field was blurred at least once; `submitAttempted` = the
  // buyer clicked "Continue to payment" while the form was invalid. A field's
  // error only renders once it's touched OR a submit was attempted, so the
  // buyer isn't yelled at before they've had a chance to type. Errors are
  // derived live from current values, so fixing a field clears its error on
  // the next render (no manual reset).
  const [touched, setTouched] = useState<
    Partial<Record<EmbedCheckoutFieldKey, boolean>>
  >({});
  const [submitAttempted, setSubmitAttempted] = useState(false);
  // A confirm can send the buyer to a payment page and back; the return
  // needs the host page's origin, which Firefox cannot compute by then.
  const saveHostOriginForReturn = useCallback(
    () =>
      saveEmbedHostOrigin(embedId, {
        loadIsRedirectReturn: loadedAsRedirectReturn,
      }),
    [embedId, loadedAsRedirectReturn],
  );
  const markTouched = useCallback(
    (field: EmbedCheckoutFieldKey) =>
      setTouched((prev) => ({ ...prev, [field]: true })),
    [],
  );

  // Mirror the live draft up to the page so it persists across this
  // component unmounting (back to event detail) and remounting.
  useEffect(() => {
    onDraftChange?.({
      billingLine1,
      billingLine2,
      billingCity,
      billingState,
      billingPostalCode,
      billingCountry,
      promoCodes,
      waiverAccepted,
      termsAccepted,
      refundPolicyAccepted,
    });
  }, [
    billingLine1,
    billingLine2,
    billingCity,
    billingState,
    billingPostalCode,
    billingCountry,
    promoCodes,
    waiverAccepted,
    termsAccepted,
    refundPolicyAccepted,
    onDraftChange,
  ]);

  // Reconcile a stale region code: if the selected country has a known region
  // list but billingState isn't one of its codes (e.g. a restored draft whose
  // country/state don't match), clear it so the blank <select> and the value
  // stay in sync and an invalid ISO region can't pass validation.
  useEffect(() => {
    const regions = getRegionsForCountry(billingCountry);
    if (
      regions.length > 0 &&
      billingState &&
      !regions.some((r) => r.code === billingState)
    ) {
      setBillingState("");
    }
  }, [billingCountry, billingState]);

  const handleApplyPromoCode = useCallback(
    (code: string): string | null => {
      const upper = code.trim().toUpperCase();
      if (upper.length < 3) return "Code must be at least 3 characters.";
      if (promoCodes.includes(upper)) return "Code already applied.";
      if (promoCodes.length >= 5) return "Maximum 5 promo codes.";
      setPromoCodes((prev) => [...prev, upper]);
      return null;
    },
    [promoCodes],
  );

  const handleRemovePromoCode = useCallback((code: string) => {
    setPromoCodes((prev) => prev.filter((c) => c !== code));
  }, []);

  const { countdown, isExpired: isHoldExpired } = useCountdown(
    orderFees?.holdExpiresAt ?? null,
  );

  const eventDetailQuery = trpc.embeds.getEventDetail.useQuery(
    { embedId, eventId, hostOrigin: getEmbedHostOrigin() },
    { staleTime: 30_000 },
  );
  const eventDetail = eventDetailQuery.data;

  // A gated event's waiver and fee rates are refused by
  // `ensureFullEventReadAccessByEventId` (FORBIDDEN, event_password_required /
  // event_application_required; EVENT_GATED is checkout's and seats'), and an
  // unanswered fee-rate read left "Calculating total…" up for good. The detail
  // screen never offers checkout for one; this covers an event gated after
  // its detail was read. A detail from an API older than the field is ungated.
  const ungated =
    eventDetail !== undefined &&
    (eventDetail.event.gateType ?? "NONE") === "NONE";
  const { data: waiverData } = trpc.waivers.getEventWaiver.useQuery(
    { eventId },
    { staleTime: 60_000, enabled: ungated },
  );

  // Fee rate labels for transparency display
  const feeRatesQuery = trpc.events.getCheckoutFeeRates.useQuery(
    { eventId },
    { staleTime: 60_000, enabled: ungated },
  );

  const displayTicketTypes = useMemo(
    () =>
      withBuyerUnitTotals(
        eventDetail?.ticketTypes ?? [],
        feeRatesQuery.data?.perTicketEstimates,
      ),
    [eventDetail?.ticketTypes, feeRatesQuery.data?.perTicketEstimates],
  );
  // A cached fee-rates row priced at another face reads "Calculating total…";
  // refetch the rates once so it does not stay that way until a remount.
  useRefetchStaleEstimates(displayTicketTypes, feeRatesQuery.refetch);

  const currency = eventDetail?.event?.currency ?? "usd";

  // Pre-hold cart total with the server's aggregate order math (tax rounded
  // once, processor fixed fee grossed up once per ORDER) — never
  // Σ(fee-inclusive unit × qty). Null = still unknown ("Calculating…").
  //
  // Pay-what-you-want lines are priced at the buyer's amount (see
  // `embedEstimateItems`).
  const orderEstimate = useMemo(
    () =>
      estimateCartTotal(
        feeRatesQuery.data,
        embedEstimateItems(cart, displayTicketTypes),
      ),
    [cart, displayTicketTypes, feeRatesQuery.data],
  );
  // For the LINE displays only: a PWYW line shows the buyer's amount, not
  // the tier floor's all-in.
  const lineTicketTypes = useMemo(
    () => withEmbedChosenLinePrices(displayTicketTypes, cart),
    [displayTicketTypes, cart],
  );
  // Each line's face × qty at the shown prices: an override seat at the
  // price the seat picker showed, as `orderEstimate` prices it.
  const shownLineCents = useMemo(
    () => embedShownLineCents(cart, displayTicketTypes),
    [cart, displayTicketTypes],
  );
  const totalCents = orderEstimate?.totalCents ?? 0;
  const isTotalKnown = orderEstimate !== null;

  const refundDisclosureCart = useMemo(() => {
    const ticketTypeMap = new Map(
      displayTicketTypes.map((ticketType) => [ticketType.id, ticketType]),
    );
    return cart.flatMap((item) => {
      const ticketType = ticketTypeMap.get(item.ticketTypeId);
      if (!ticketType) return [];
      return [
        {
          id: item.ticketTypeId,
          quantity: item.qty,
          pricingMode: ticketType.pricingMode,
          priceCents: ticketType.priceCents,
        },
      ];
    });
  }, [cart, displayTicketTypes]);

  // Effective fee mode for display. Once createGuestCheckout runs we trust the
  // order's stamped feeMode; before that we fall back to the fee-rates query so
  // the pre-charge labels are in the right ballpark. Mirrors the main checkout's
  // `effectiveFeeMode = order?.feeMode ?? feeRatesQuery.data?.feeMode ?? null`.
  const effectiveFeeMode: "ABSORB" | "PASS_THROUGH" | null =
    orderFees?.feeMode ?? feeRatesQuery.data?.feeMode ?? null;

  // When order fees are available, mirror the server's PaymentIntent amount:
  //   PASS_THROUGH: gross + buyerFees + processorFee + tax
  //   ABSORB:       gross + buyerFees + tax
  // In PASS_THROUGH the buyer funds the grossed-up processor fee — createCheckout
  // adds it to the charged PaymentIntent (see
  // packages/core/src/use-cases/embeds/create-embed-guest-checkout.ts), so the
  // displayed total must include it or it understates what the buyer pays. In
  // ABSORB the processor fee is display-only (Stripe deducts it from the
  // organizer's settlement), so it stays out of the total.
  const displayTotalCents = orderFees
    ? orderFees.amountGrossCents +
      orderFees.buyerFeesCents +
      (effectiveFeeMode === "PASS_THROUGH"
        ? (orderFees.processorFeeCents ?? 0)
        : 0) +
      orderFees.taxAmountCents
    : totalCents;

  const displayTotalLabel = orderFees
    ? formatCurrency(displayTotalCents, currency)
    : !isTotalKnown
      ? String(t("checkout.calculatingTotal"))
      : displayTotalCents === 0
        ? String(t("common.free"))
        : formatCurrency(displayTotalCents, currency);

  const isFreeOrder = isTotalKnown && totalCents === 0;

  // The platform-fee rate WITH its per-ticket cap ("3.33%, max $0.50/ticket")
  // — main checkout's label. The bare "3.33%" beside a $1.00 fee on a $55
  // order read like 3.33% of $55.
  const platformFeeLabel =
    cappedPlatformFeeRateLabel(
      feeRatesQuery.data?.platformFeeLabel,
      feeRatesQuery.data?.platformFeeRates,
      t,
      (cents) => formatCurrency(cents, currency),
    ) ?? undefined;

  const billingAddress: EmbedBillingAddress | null = useMemo(() => {
    const line1 = billingLine1.trim();
    const city = billingCity.trim();
    const state = billingState.trim();
    const postalCode = billingPostalCode.trim();
    const country = billingCountry.trim().toUpperCase();
    if (!line1 || !city || !state || !postalCode || country.length !== 2)
      return null;
    return {
      line1,
      ...(billingLine2.trim() ? { line2: billingLine2.trim() } : {}),
      city,
      state,
      postalCode,
      country,
    };
  }, [
    billingLine1,
    billingLine2,
    billingCity,
    billingState,
    billingPostalCode,
    billingCountry,
  ]);

  const requiresWaiver = Boolean(waiverData?.waiver);

  // Everything the buyer fills in themselves.
  const isFilledIn =
    guestName.trim().length > 0 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(guestEmail.trim()) &&
    !!billingAddress &&
    (!requiresWaiver || waiverAccepted) &&
    termsAccepted &&
    refundPolicyAccepted;
  const isFormValid = isFilledIn && (!TURNSTILE_SITE_KEY || !!turnstileToken);
  // Nothing is missing but the bot check's token.
  const lacksOnlyVerification =
    isFilledIn && Boolean(TURNSTILE_SITE_KEY) && !turnstileToken;

  // ── Per-field error strings ──────────────────────────────────────────
  // Specific, action-oriented copy ("Enter your city") so a buyer scanning a
  // blocked form knows exactly what to fix, instead of a wall of identical
  // "This field is required." lines. Localized via the shared @th/locale
  // catalog (en + es). Computed live from the current values +
  // touched/submitAttempted, so fixing a field clears its error next render.
  const fieldErrors = useMemo(() => {
    // The state control is a <select> for countries with a known region list
    // (e.g. US) and a free-text input otherwise — phrase the prompt to match.
    const stateIsSelect = getRegionsForCountry(billingCountry).length > 0;
    const requiredMessages: Record<EmbedCheckoutFieldKey, string> = {
      name: String(t("checkout.enterFullName")),
      email: String(t("checkout.enterEmail")),
      line1: String(t("checkout.enterStreetAddress")),
      city: String(t("checkout.enterCity")),
      state: stateIsSelect
        ? String(t("checkout.selectState"))
        : String(t("checkout.enterStateOrRegion")),
      postalCode: String(t("checkout.enterPostalCode")),
      country: String(t("checkout.selectCountry")),
    };
    const show = (field: EmbedCheckoutFieldKey) =>
      Boolean(touched[field]) || submitAttempted;
    const requiredError = (field: EmbedCheckoutFieldKey, value: string) =>
      show(field) && !value.trim() ? requiredMessages[field] : null;
    const emailError = () => {
      if (!show("email")) return null;
      const v = guestEmail.trim();
      if (!v) return requiredMessages.email;
      return EMAIL_RE.test(v) ? null : String(t("checkout.invalidEmail"));
    };
    return {
      name: requiredError("name", guestName),
      email: emailError(),
      line1: requiredError("line1", billingLine1),
      city: requiredError("city", billingCity),
      state: requiredError("state", billingState),
      postalCode: requiredError("postalCode", billingPostalCode),
      country: requiredError("country", billingCountry),
    };
  }, [
    t,
    touched,
    submitAttempted,
    guestName,
    guestEmail,
    billingLine1,
    billingCity,
    billingState,
    billingPostalCode,
    billingCountry,
  ]);

  // Ordered DOM ids of the fields currently showing an error — drives the
  // validation summary count and the "next invalid field" navigation.
  const invalidFieldIds = useMemo(
    () =>
      FIELD_DOM_IDS.filter(({ key }) => fieldErrors[key]).map(({ id }) => id),
    [fieldErrors],
  );

  // Acceptance-gate messages: only surfaced once a submit has been attempted,
  // and only while the relevant box is still unchecked.
  const waiverError =
    submitAttempted && requiresWaiver && !waiverAccepted
      ? String(t("checkout.waiverRequired"))
      : null;
  // Combined terms + refund acceptance gate.
  const acceptanceError =
    submitAttempted && (!termsAccepted || !refundPolicyAccepted)
      ? String(t("checkout.acceptTermsToContinue"))
      : null;

  // Last field the buyer was *navigated* to (via submit or "Next field"), so
  // the Next control can advance from there even though clicking it would
  // otherwise move focus to the button. The button also preventDefaults its
  // mousedown, so in practice focus stays on the field and document.activeElement
  // is the primary source; this ref is the keyboard/edge-case fallback.
  const lastNavRef = useRef<string | null>(null);
  const focusFieldById = useCallback((id: string) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    // Focus after the smooth-scroll settles so the page doesn't snap.
    window.setTimeout(() => el.focus({ preventScroll: true }), 320);
  }, []);

  /**
   * Reveal every blocking validation error and focus the first invalid field.
   * Called from `handleCreateCheckout` when the buyer clicks "Continue to
   * payment" with an invalid form, so the rejection is never silent. Marks all
   * required fields touched + flips `submitAttempted` (which also surfaces the
   * acceptance/turnstile notes + the validation summary), then scrolls/focuses
   * the first empty/invalid input. Computes the first offender from the raw
   * values (not `invalidFieldIds`, which is stale until the touched/submit
   * state this sets has re-rendered).
   */
  const showValidationErrors = useCallback(() => {
    setTouched({
      name: true,
      email: true,
      line1: true,
      city: true,
      state: true,
      postalCode: true,
      country: true,
    });
    setSubmitAttempted(true);

    const values: Record<EmbedCheckoutFieldKey, string> = {
      name: guestName,
      email: guestEmail,
      line1: billingLine1,
      city: billingCity,
      state: billingState,
      postalCode: billingPostalCode,
      country: billingCountry,
    };
    const firstInvalid = FIELD_DOM_IDS.find(({ key }) =>
      isFieldValueInvalid(key, values[key]),
    );
    if (!firstInvalid) return;
    lastNavRef.current = firstInvalid.id;
    focusFieldById(firstInvalid.id);
  }, [
    guestName,
    guestEmail,
    billingLine1,
    billingCity,
    billingState,
    billingPostalCode,
    billingCountry,
    focusFieldById,
  ]);

  /**
   * Move focus to the next invalid field, cycling top-to-bottom (wraps to the
   * first). Anchors off the currently-focused field when it's one of the
   * invalid ones, else off the last field we navigated to — so repeated
   * "Next field" clicks walk through every offender without getting stuck.
   */
  const focusNextInvalid = useCallback(() => {
    if (invalidFieldIds.length === 0) return;
    const activeId =
      typeof document !== "undefined"
        ? (document.activeElement?.id ?? null)
        : null;
    const fromId =
      activeId && invalidFieldIds.includes(activeId)
        ? activeId
        : lastNavRef.current;
    const fromIdx = fromId ? invalidFieldIds.indexOf(fromId) : -1;
    const nextId = invalidFieldIds[(fromIdx + 1) % invalidFieldIds.length];
    lastNavRef.current = nextId;
    focusFieldById(nextId);
  }, [invalidFieldIds, focusFieldById]);

  // After a `seat_price_changed` refusal: re-read the picked seats' prices
  // and re-quote the cart, so the summary shows the new price and the next
  // attempt quotes what the buyer now sees. The seats stay picked. A section
  // whose re-read fails keeps its old quote: the retry is refused again
  // (never charged at an unshown price) and the seat picker re-reads it.
  const refreshSeatQuotes = useCallback(async () => {
    const sections = seatSectionsInCart(cart);
    if (sections.length === 0 || !onCartUpdate) return;
    await utils.embeds.listAvailableSeats.invalidate();
    const hostOrigin = getEmbedHostOrigin();
    const reads = await Promise.allSettled(
      sections.map((seatSectionId) =>
        utils.embeds.listAvailableSeats.fetch({
          embedId,
          eventId,
          seatSectionId,
          hostOrigin,
        }),
      ),
    );
    const seatsBySection = new Map(
      reads.flatMap((read, index) =>
        read.status === "fulfilled"
          ? [[sections[index]!, read.value.seats] as const]
          : [],
      ),
    );
    onCartUpdate((current) => withRefreshedSeatQuotes(current, seatsBySection));
  }, [cart, embedId, eventId, onCartUpdate, utils]);

  const handleCreateCheckout = useCallback(async () => {
    if (isCreating) return;
    // Invalid form → reveal what's missing and focus the first offender
    // instead of silently no-op'ing behind a disabled button.
    if (!isFormValid) {
      if (lacksOnlyVerification) {
        // Nothing for the buyer to fix: the token is on its way. Wait for it
        // (see `continueWhenVerified`) instead of dropping the press with
        // nothing on screen to say why.
        setContinueWhenVerified(true);
        return;
      }
      setContinueWhenVerified(false);
      showValidationErrors();
      return;
    }

    setContinueWhenVerified(false);
    setIsCreating(true);
    onCheckoutError("");

    // What this request is FOR, pinned before the await: the order that comes
    // back is stamped with the cart and key that were sent, whatever the
    // page's cart is by then.
    const sentCart = cart;
    const sentClientKey = clientKey;
    const sentEventId = eventId;

    // An order the buyer just left for this event may still be giving its
    // tickets back, and until it has, this checkout can be refused by them.
    // The widget's wait is bounded and never rejects; the button is already
    // showing as working, and Back is locked, so the cart and key pinned
    // above are still the page's when the request goes out. A wait that
    // fails is never a reason not to ask for the order.
    if (waitForReleases) {
      await waitForReleases().catch(
        traceIgnoredError("embed.waitForReleasesFailed"),
      );
    }

    // A created order, handed to the widget. Shared by the answer that comes
    // in time and the one that comes after the checkout stopped waiting.
    const land = (
      result: Awaited<ReturnType<typeof createCheckout.mutateAsync>>,
    ) => {
      // The order's receipt secret, kept in this tab before the payment step
      // exists, so before Stripe's `confirmPayment` can send the buyer away
      // on a redirect method. Sent back with every `confirmGuestPayment`; it
      // is what earns the ticket codes (embed-receipt-secret.ts). Kept for a
      // late answer too: it is the same order's secret.
      if (result.clientSecret) {
        rememberEmbedReceiptSecret(
          embedId,
          result.clientSecret,
          result.receiptSecret,
        );
      }
      // The order the payment step charges, with the cart and the key it was
      // created from (the ones sent below). Null for a free order: no
      // PaymentIntent.
      const createdPaymentOrder: EmbedPaymentOrder | null = result.clientSecret
        ? {
            clientSecret: result.clientSecret,
            clientKey: sentClientKey,
            eventId: sentEventId,
            cart: sentCart,
            orderFees: {
              amountGrossCents: result.amountGrossCents,
              feesPlatformCents: result.feesPlatformCents,
              buyerFeesCents: result.buyerFeesCents,
              processorFeeCents: result.processorFeeCents,
              feeMode: result.feeMode,
              taxAmountCents: result.taxAmountCents,
              holdExpiresAt: result.holdExpiresAt,
            },
            lineItems: result.lineItems,
          }
        : null;

      const isThePagesOrder = onCheckoutCreated(
        {
          orderId: result.orderId,
          clientSecret: result.clientSecret,
          // Resolved from getEventDetail for the ACTUAL charged event (see
          // EmbedCheckoutConfirmation.currency). The detail query is warm by the
          // time a buyer reaches this handler (same key as EmbedEventDetail's).
          currency,
          orderFees: {
            amountGrossCents: result.amountGrossCents,
            feesPlatformCents: result.feesPlatformCents,
            buyerFeesCents: result.buyerFeesCents,
            processorFeeCents: result.processorFeeCents,
            feeMode: result.feeMode,
            taxAmountCents: result.taxAmountCents,
          },
          // The persisted order's lines — the confirmation prints these, not
          // the cart.
          lineItems: result.lineItems,
          billingAddress,
          waiverAccepted: requiresWaiver ? waiverAccepted : false,
          // A free order is complete as created, with no confirm call, so
          // its tickets can only come with this answer. Still read through
          // `readEmbedTickets`: an older API sends no such field. A paid
          // order's tickets come from the server's "confirmed" answer.
          ...(result.clientSecret
            ? {}
            : { tickets: readEmbedTickets(result.tickets) }),
        },
        createdPaymentOrder,
        sentClientKey,
      );

      // Free order — jump straight to confirmation. Not one the widget left
      // behind (it landed after the buyer moved on to another purchase): the
      // page stays on what they are doing now.
      if (!result.clientSecret && isThePagesOrder) {
        onPaymentSuccess(guestEmail.trim());
      }
    };

    try {
      const request = createCheckout.mutateAsync({
        embedId,
        eventId,
        hostOrigin: getEmbedHostOrigin(),
        guestName: guestName.trim(),
        guestEmail: guestEmail.trim(),
        clientKey: sentClientKey,
        ...(turnstileToken ? { turnstileToken } : {}),
        // A pay-what-you-want line sends the buyer's amount (the ticket's
        // price — fees and tax go on top); fixed lines never carry one.
        items: embedCheckoutItems(sentCart, displayTicketTypes),
        ...(promoCodes.length > 0 ? { promoCodes } : {}),
        ...(billingAddress ? { billingAddress } : {}),
        ...(requiresWaiver ? { waiverAccepted } : {}),
        termsAccepted: true,
        refundPolicyAccepted: true,
      });
      const result = await settledWithin(request, CREATE_CHECKOUT_TIMEOUT_MS);
      if (result === null) {
        // No answer. The button and Back are freed (the `finally` below) and
        // the key is KEPT: `onCheckoutFailed` is not called, so the widget
        // does not rotate it, and a retry of this cart replays the order this
        // request made, or is told the request is still running. A fresh key
        // would make a second order beside it.
        traceIgnoredError("embed.checkoutCreateTimedOut")(
          new Error("createGuestCheckout gave no answer in time"),
        );
        onCheckoutError(String(t("checkout.embedCheckoutTimedOut")));
        // The verification token went out with the request and may be spent.
        turnstileRef.current?.reset();
        setTurnstileToken(null);
        // The request may still land. An order it brings is handed over like
        // any other (the widget drops one whose key is no longer the page's).
        // A refusal changes nothing here: the key is not rotated on it (a
        // retry may be in flight under that key), and the buyer's next
        // attempt gets its own answer.
        void request.then(land, traceIgnoredError("embed.lateCheckoutRefused"));
        return;
      }
      land(result);
      // The verification token went out with the request and is spent. The
      // details form comes back when this order is discarded (its time ran
      // out, the tickets changed), and the next Continue needs its own.
      turnstileRef.current?.reset();
      setTurnstileToken(null);
    } catch (err: unknown) {
      // First, so the widget's key rotation lands before the re-render that
      // `onCheckoutError` triggers hands this component its next `clientKey`.
      onCheckoutFailed(err);
      // An origin-allowlist rejection carries a raw EMBED_ORIGIN_NOT_ALLOWED
      // message — show the human copy instead. Keyed on the precise appCode
      // (not the FORBIDDEN bucket) so Turnstile / purchasing-disabled errors
      // keep their own messages.
      const appCode = (err as { data?: { appCode?: string } } | null)?.data
        ?.appCode;
      // Every other refusal goes through the shared copy table, so a server
      // code (`seat_price_changed`, `seat_taken`, …) reads as a sentence
      // instead of the raw identifier.
      const msg =
        appCode === "EMBED_ORIGIN_NOT_ALLOWED"
          ? EMBED_ORIGIN_BLOCKED_MESSAGE
          : err instanceof Error
            ? formatErrorMessage(err, t)
            : "Unable to start checkout. Please try again.";
      onCheckoutError(msg);
      // Reset the Turnstile widget so user can re-verify on retry
      turnstileRef.current?.reset();
      setTurnstileToken(null);
      // A seat's price moved since the picker showed it: re-quote before the
      // button frees up, so a retry cannot resend the stale price.
      if (err instanceof Error && err.message === "seat_price_changed") {
        try {
          await refreshSeatQuotes();
        } catch {
          // The quotes stay as they were; see refreshSeatQuotes.
        }
      }
    } finally {
      setIsCreating(false);
    }
  }, [
    isFormValid,
    lacksOnlyVerification,
    isCreating,
    showValidationErrors,
    createCheckout,
    embedId,
    eventId,
    guestName,
    guestEmail,
    clientKey,
    onCheckoutFailed,
    refreshSeatQuotes,
    currency,
    turnstileToken,
    promoCodes,
    billingAddress,
    requiresWaiver,
    waiverAccepted,
    cart,
    displayTicketTypes,
    onCheckoutCreated,
    onCheckoutError,
    onPaymentSuccess,
    waitForReleases,
    t,
  ]);

  // Only while the details form is on screen: an order that lands meanwhile
  // (a request that had gone unanswered) takes the buyer to the payment step.
  const awaitingVerification = continueWhenVerified && clientSecret === null;
  // The token arrived for a Continue that was waiting on it.
  useEffect(() => {
    if (awaitingVerification && turnstileToken) void handleCreateCheckout();
  }, [awaitingVerification, turnstileToken, handleCreateCheckout]);
  // No token in time: stop showing the button as working, and point at the
  // verification, which may be asking the buyer to do something.
  useEffect(() => {
    if (!continueWhenVerified) return;
    const timer = window.setTimeout(() => {
      setContinueWhenVerified(false);
      setSubmitAttempted(true);
    }, VERIFICATION_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [continueWhenVerified]);
  const stopWaitingOnVerification = () => {
    if (!continueWhenVerified) return;
    setContinueWhenVerified(false);
    setSubmitAttempted(true);
  };
  // The details form is submitting: from the Continue press until the create
  // answers, or until a kept press stops waiting. ONE flag for the wait and
  // the request, because the order is made from what the form holds when the
  // token arrives: the email and promo codes lock at the press, not at the
  // request, so the buyer cannot be halfway through changing one of them
  // when it goes out. (The token arriving ends the wait and starts the
  // request in one update: no render in between has the form open.)
  const isSubmitting = isCreating || awaitingVerification;

  // Header: Back locks while an order is being created or a payment
  // confirms (see EmbedCheckoutHeader). One element, shared by both screens.
  const header = (
    <EmbedCheckoutHeader
      onBack={onBack}
      isCreating={isCreating}
      isPaying={isPaying}
      isConfirming={isConfirming}
      onPaymentStep={clientSecret !== null}
    />
  );

  // No order is under way yet: the buyer is still on the details form. Once
  // one is, its payment step renders whatever the detail read says.
  const beforeOrder = clientSecret === null && !isPaying && !isConfirming;

  // The detail read has not answered (loading, or an error with nothing
  // cached): the form waits for it. Without it the waiver read never starts
  // (`ungated` above), so the form would ask for no waiver and the submit
  // would fail on WAIVER_REQUIRED with the waiver never shown.
  if (!eventDetail && beforeOrder) {
    return (
      <div style={{ display: "flex", flexDirection: "column" }}>
        {header}
        {eventDetailQuery.isError ? (
          <EmbedErrorScreen
            error={eventDetailQuery.error}
            onRetry={() => void eventDetailQuery.refetch()}
            supportEmail={DEFAULT_SUPPORT_EMAIL}
          />
        ) : (
          <div
            data-testid="embed-checkout-detail-loading"
            style={{
              display: "flex",
              minHeight: 200,
              alignItems: "center",
              justifyContent: "center",
              padding: 24,
            }}
          >
            <Spinner size="md" indicatorColor={STEEL_BLUE} />
          </div>
        )}
      </div>
    );
  }

  // Gated since its detail was read, and no order is under way: the same card
  // the detail screen shows, never a form whose total cannot be quoted.
  const detailGate = eventDetail?.event.gateType;
  const gatedEvent =
    eventDetail && detailGate && detailGate !== "NONE"
      ? { ...eventDetail.event, gateType: detailGate }
      : null;
  if (gatedEvent && beforeOrder) {
    return (
      <div style={{ display: "flex", flexDirection: "column" }}>
        {header}
        <EmbedGatedEventCard
          event={gatedEvent}
          buildEventUrl={embedEventUrl}
          showAction={!eventDetail?.salesClosed}
        />
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {header}

      {/* Stepper */}
      <div
        style={{
          borderBottom: `1px solid ${BORDER_SUBTLE}`,
          background: SURFACE,
        }}
      >
        <CheckoutStepper
          currentStepId={stepperStepId}
          completedStepIds={completedStepIds}
        />
      </div>

      {/* Two-column layout. flex-direction and padding live in the
          .th-embed-checkout-cols class (globals.css) — inline styles
          here would override the ≥768px media query and pin the
          summary below the form at every width. */}
      <div
        className={
          isFramed
            ? "th-embed-checkout-cols"
            : "th-embed-checkout-cols th-embed-checkout-cols--with-fixed-bar"
        }
        style={{
          display: "flex",
          gap: 20,
        }}
      >
        {/* LEFT — Form */}
        <div
          style={{
            display: "flex",
            minWidth: 0,
            flex: 1,
            flexDirection: "column",
            gap: 20,
          }}
        >
          {/* Guest info — shown before checkout is created */}
          {!clientSecret && (
            <EmbedCheckoutFormSection
              guestName={guestName}
              guestEmail={guestEmail}
              onGuestNameChange={onGuestNameChange}
              onGuestEmailChange={onGuestEmailChange}
              promoCodes={promoCodes}
              handleApplyPromoCode={handleApplyPromoCode}
              handleRemovePromoCode={handleRemovePromoCode}
              isCreating={isSubmitting}
              billingLine1={billingLine1}
              billingLine2={billingLine2}
              billingCity={billingCity}
              billingState={billingState}
              billingPostalCode={billingPostalCode}
              billingCountry={billingCountry}
              onBillingLine1Change={setBillingLine1}
              onBillingLine2Change={setBillingLine2}
              onBillingCityChange={setBillingCity}
              onBillingStateChange={setBillingState}
              onBillingPostalCodeChange={setBillingPostalCode}
              onBillingCountryChange={(country) => {
                setBillingCountry(country);
                if (country !== billingCountry) setBillingState("");
              }}
              requiresWaiver={requiresWaiver}
              waiverBody={waiverData?.waiver?.body ?? null}
              waiverAccepted={waiverAccepted}
              onWaiverAcceptedChange={setWaiverAccepted}
              termsAccepted={termsAccepted}
              onTermsAcceptedChange={setTermsAccepted}
              refundPolicyAccepted={refundPolicyAccepted}
              onRefundPolicyAcceptedChange={setRefundPolicyAccepted}
              refundDisclosureCart={refundDisclosureCart}
              checkoutError={checkoutError}
              checkoutErrorNote={
                earlierReservedUntil ? (
                  <EmbedEarlierOrderNote reservedUntil={earlierReservedUntil} />
                ) : null
              }
              turnstileRef={turnstileRef}
              turnstileToken={turnstileToken}
              onTurnstileSuccess={setTurnstileToken}
              onTurnstileExpire={() => {
                setTurnstileToken(null);
                turnstileRef.current?.reset();
              }}
              onTurnstileError={() => {
                setTurnstileToken(null);
                stopWaitingOnVerification();
              }}
              handleCreateCheckout={() => {
                void handleCreateCheckout();
              }}
              isFormValid={isFormValid}
              isFreeOrder={isFreeOrder}
              fieldErrors={fieldErrors}
              onFieldBlur={markTouched}
              submitAttempted={submitAttempted}
              waiverError={waiverError}
              acceptanceError={acceptanceError}
              invalidFieldCount={invalidFieldIds.length}
              onFocusNextInvalid={focusNextInvalid}
              submitHiddenBehindFixedBar={!isFramed}
            />
          )}

          {/* Stripe payment — PaymentElement with all methods.
              Stripe renders in its own iframes, so `var(--hf-*)` strings
              never resolve there: feed it the RESOLVED theme values
              (getResolvedEmbedStripeColors walks the same chain as the
              rest of the embed: host --hf-* override, else the platform
              token on <body>, else Stub). Computed lazily once the clientSecret
              exists — by then useEmbedThemeOverrides has applied any
              overrides. fontSizeBase 16px keeps iOS Safari from zooming
              Stripe's inputs on focus. */}
          {clientSecret && (
            <div className="th-embed-fade-in-up">
              {/* Keyed by the order: Elements reads its clientSecret once,
                  at mount, so a new order must mount a new one (and a new
                  payment form with it) rather than reuse the last order's. */}
              <Elements
                key={clientSecret}
                stripe={getStripe()}
                options={{
                  clientSecret,
                  appearance: (() => {
                    const colors = getResolvedEmbedStripeColors();
                    return {
                      theme: "stripe" as const,
                      variables: {
                        colorPrimary: colors.primary,
                        colorBackground: colors.inputBackground,
                        colorText: colors.text,
                        colorTextSecondary: colors.textMuted,
                        colorTextPlaceholder: colors.textMuted,
                        fontFamily: "Montserrat, system-ui, sans-serif",
                        fontSizeBase: "16px",
                        borderRadius: "0px",
                        colorDanger: colors.danger,
                      },
                      rules: {
                        ".Input": {
                          border: `1px solid ${colors.border}`,
                          boxShadow: "none",
                          transition: "border-color 0.15s",
                        },
                        ".Input:focus": {
                          border: `1px solid ${colors.brand}`,
                          boxShadow: "none",
                        },
                        ".Tab": {
                          border: `1px solid ${colors.border}`,
                          borderRadius: "0px",
                          boxShadow: "none",
                        },
                        ".Tab--selected": {
                          borderColor: colors.accent,
                          boxShadow: "none",
                        },
                      },
                    };
                  })(),
                }}
              >
                <EmbedPaymentForm
                  clientSecret={clientSecret}
                  totalCents={displayTotalCents}
                  currency={currency}
                  onSuccess={(status) =>
                    onPaymentSuccess(guestEmail.trim(), {
                      clientSecret,
                      status,
                    })
                  }
                  onError={onCheckoutError}
                  onSubmittingChange={onPayingChange}
                  payDisabled={isHoldExpired}
                  confirmingOrder={isConfirming}
                  onBeforeConfirm={saveHostOriginForReturn}
                  onOutcomeUnknown={(report) =>
                    onPaymentOutcomeUnknown(clientSecret, report)
                  }
                  onOrderExpired={onPaymentOrderExpired}
                />
              </Elements>
            </div>
          )}
        </div>

        {/* RIGHT — Order summary card. On standalone pages it hides on
            mobile (the fixed CTA bar shows the total); inside resize-bridged
            iframes the fixed bar is suppressed, so the summary stays
            visible in the flow at every width. */}
        <EmbedOrderSummarySidebar
          forceVisibleOnMobile={isFramed}
          cart={cart}
          eventDetail={
            eventDetail
              ? { ...eventDetail, ticketTypes: lineTicketTypes }
              : eventDetail
          }
          lineCentsByTicketType={shownLineCents}
          orderLines={orderLines}
          orderFees={orderFees}
          preOrderEstimate={orderEstimate}
          displayTotalCents={displayTotalCents}
          displayTotalLabel={displayTotalLabel}
          currency={currency}
          platformFeeRateLabel={platformFeeLabel}
          processorFeeRateLabel={
            feeRatesQuery.data?.processorFeeLabel ?? undefined
          }
          taxRateBps={buyerTaxRateBps(feeRatesQuery.data)}
          feeMode={effectiveFeeMode}
          // The row is the time left to pay. Once that has run out the widget
          // discards the order and says so in its own words; for the moment
          // in between (Stripe may be asked about the payment first) the row
          // is hidden instead of printing its "Hold expired" text.
          countdown={isHoldExpired ? null : countdown}
          isHoldExpired={isHoldExpired}
        />
      </div>

      {/* Mobile CTA bar — visible on small screens. Only meaningful when
          the embed page IS the visitor's viewport (standalone); inside a
          resize-bridged iframe `fixed` pins to the widget's end, so the
          in-flow summary above carries the total instead. On the details
          step the bar CARRIES the submit action (mirroring the event-detail
          step): the in-form button hides at phone widths under the fixed
          bar, which would otherwise cover it at max scroll. Once the
          payment step starts (clientSecret set) the bar goes back to
          total-only — Stripe's PaymentElement owns the pay action. */}
      {!isFramed && (
      <EmbedMobileCTABar
        onAction={
          clientSecret
            ? undefined
            : () => {
                void handleCreateCheckout();
              }
        }
        actionLabel={
          isFreeOrder ? (
            "Complete order"
          ) : (
            // The long form overflows the bar row at <380px viewports
            // (Total block + button exceed the width); the pair swaps via
            // the .th-embed-cta-label-* classes in globals.css.
            <>
              <span className="th-embed-cta-label-long">
                Continue to payment
              </span>
              <span className="th-embed-cta-label-short">Continue</span>
            </>
          )
        }
        isPending={isSubmitting}
        totalLabel={displayTotalLabel}
        tickets={cart
          .filter((c) => c.qty > 0)
          .map((item) => {
            const tt = lineTicketTypes.find(
              (t) => t.id === item.ticketTypeId,
            );
            return {
              id: item.ticketTypeId,
              name: tt?.name ?? "Ticket",
              priceCents: tt?.priceCents ?? 0,
              buyerUnitTotalCents: tt?.buyerUnitTotalCents ?? null,
              qty: item.qty,
              lineCents: shownLineCents[item.ticketTypeId],
            };
          })}
        order={orderFees}
        orderLines={orderLines}
        preOrderEstimate={orderEstimate}
        currency={currency}
        platformFeeRateLabel={platformFeeLabel}
        processorFeeRateLabel={
          feeRatesQuery.data?.processorFeeLabel ?? undefined
        }
        taxRateBps={buyerTaxRateBps(feeRatesQuery.data)}
        feeMode={effectiveFeeMode}
        // Hidden once expired, as in the summary above.
        countdown={isHoldExpired ? null : countdown}
        isExpired={isHoldExpired}
      />
      )}
    </div>
  );
}
