"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "@bprogress/next/app";
import {
  Ticket,
  MapPin,
  Calendar,
  Tag,
  CheckCircle,
  AlertCircle,
  Clock,
  ShieldCheck,
} from "lucide-react";
import { Button, Text, useFormatters, useTranslations } from "@th/ui";
import { formatOrderCode } from "@th/types/order-identifier";

import { trpc } from "@/trpc";
import { authClient } from "@/lib/auth/auth-client";
import { getAppErrorCode } from "@/lib/app-error";
import { EmailVerificationRequired } from "@/components/auth/EmailVerificationRequired";
import { isEmailVerificationRequired } from "@/lib/email-verification-required";
import { keepsCheckoutClientKey } from "@/lib/checkout-client-key";
import { useAppOverlay } from "@/components/layout/AppOverlayProvider";
import { fmtCurrency } from "@/lib/format";
import { ResaleListingFacts } from "@/components/resale/ResaleListingFacts";
import { CURRENT_TERMS_VERSION } from "@/lib/legal-constants";
import { RefundDisclosure } from "@/app/events/checkout/[...slug]/_components/RefundDisclosure";
import { StripePaymentCardSkeleton } from "@/app/events/checkout/[...slug]/_components/StripePaymentCardSkeleton";
import type {
  BeforePaymentResult,
  PaymentSuccessStatus,
} from "@/app/events/checkout/[...slug]/_components/StripePaymentCard";
// StripePaymentCard pulls @stripe/react-stripe-js + Elements. Defer so
// the resale checkout initial render doesn't block on the Stripe chunk.
//
// `loading:` is not optional. Without it this section rendered BARE for the
// length of the chunk fetch and then again while Stripe's iframes mounted —
// the same defect fixed on the ticket checkout, where it cost 952px of content
// collapsing to 544px and growing back in a dozen steps over Slow 4G. The
// skeleton and the height reservation are shared with that fix rather than
// re-derived; see `.checkout-payment-slot` in the checkout's `checkout.css`.
import nextDynamic from "next/dynamic";
const StripePaymentCard = nextDynamic(
  () =>
    import("@/app/events/checkout/[...slug]/_components/StripePaymentCard").then(
      (m) => ({ default: m.StripePaymentCard }),
    ),
  { ssr: false, loading: () => <StripePaymentCardSkeleton /> },
);
import { MUTED, STRUCTURAL } from "@/lib/design-tokens";

// ── Style tokens (mirrors checkout-tokens.ts) ────────────────────────────────
const FG = "var(--color, #211C16)";
const FG_MUTED = "var(--colorMuted, #5C544A)";
const BORDER_SUBTLE = "1px solid var(--borderColor, #211C16)";
const DIVIDER_COLOR = "var(--borderColor, #211C16)";
const SURFACE = "var(--surface, #FDFAF3)";
const REFUND_POLICY_PULSE_MS = 1800;

// ── Types ────────────────────────────────────────────────────────────────────

type Phase =
  | "loading"
  | "viewing"
  | "creating"
  | "paying"
  | "confirming"
  | "confirmed"
  // Stripe accepted a delayed method (US bank debit): the order is
  // PROCESSING and the debit can still fail days later, so it is not paid.
  | "processing"
  | "error";

export type ResaleCheckoutProps = {
  listingId: string;
};

// ── Component ────────────────────────────────────────────────────────────────

export function ResaleCheckout({ listingId }: ResaleCheckoutProps) {
  const fmt = useFormatters();
  const t = useTranslations();
  const router = useRouter();
  const { showSignInOverlay } = useAppOverlay();

  const sessionQuery = authClient.useSession();
  const [hasMounted, setHasMounted] = useState(false);
  useEffect(() => {
    setHasMounted(true);
  }, []);
  const isSignedIn = hasMounted && Boolean(sessionQuery.data?.user);

  // B2: `resale.createCheckout` refuses an unverified buyer. Ask for the code
  // up front when the session already says so (before a card is typed), and
  // whenever the server refuses anyway. Verifying here clears both.
  const [verificationRefused, setVerificationRefused] = useState(false);
  const [verifiedHere, setVerifiedHere] = useState(false);
  const sessionUnverified =
    (sessionQuery.data?.user as { emailVerified?: boolean } | undefined)
      ?.emailVerified === false;
  const needsVerification =
    isSignedIn && !verifiedHere && (verificationRefused || sessionUnverified);

  // ── State ──────────────────────────────────────────────────────────
  const [phase, setPhase] = useState<Phase>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // A neutral notice: nothing failed, the buyer is told a new figure or that
  // the order has to be made again.
  const [notice, setNotice] = useState<string | null>(null);
  const [orderId, setOrderId] = useState<string | null>(null);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const termsCheckboxRef = useRef<HTMLInputElement | null>(null);
  const [refundPolicyAccepted, setRefundPolicyAccepted] = useState(false);
  const [refundPolicyHighlight, setRefundPolicyHighlight] = useState(false);
  const refundPolicyCheckboxRef = useRef<HTMLInputElement | null>(null);
  const [orderAmounts, setOrderAmounts] = useState<{
    amountGrossCents: number;
    buyerFeesCents: number;
    taxAmountCents: number;
  } | null>(null);

  /** Forget a dead order: the next press of Pay makes a new one. */
  const dropOrder = useCallback(() => {
    setOrderId(null);
    setClientSecret(null);
    setOrderAmounts(null);
    setPhase("viewing");
  }, []);

  const clientKeyRef = useRef(crypto.randomUUID());
  const setAgreementCheckboxRef = useCallback(
    (node: HTMLInputElement | null) => {
      termsCheckboxRef.current = node;
      refundPolicyCheckboxRef.current = node;
    },
    [],
  );

  // ── Data fetching ──────────────────────────────────────────────────
  const listingQuery = trpc.resale.getListing.useQuery(
    { listingId },
    { staleTime: 30_000 },
  );

  const listing = listingQuery.data;

  // Transition from loading to viewing once data arrives
  useEffect(() => {
    if (listing && phase === "loading") {
      setPhase("viewing");
    }
  }, [listing, phase]);

  // ── Mutation ───────────────────────────────────────────────────────
  const createCheckoutMutation = trpc.resale.createCheckout.useMutation({
    // The gate is answered inline by the verify prompt, not a toast.
    meta: { silentWhen: isEmailVerificationRequired },
  });

  const handleTermsRequired = useCallback(() => {
    setErrorMessage(String(t("checkout.termsRequiredToast")));
    const el = termsCheckboxRef.current;
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      window.setTimeout(() => el.focus({ preventScroll: true }), 320);
    }
    setRefundPolicyHighlight(true);
    window.setTimeout(
      () => setRefundPolicyHighlight(false),
      REFUND_POLICY_PULSE_MS,
    );
  }, [t]);

  const handleRefundPolicyRequired = useCallback(() => {
    setErrorMessage(String(t("checkout.refundPolicyRequiredToast")));
    const el = refundPolicyCheckboxRef.current;
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      window.setTimeout(() => el.focus({ preventScroll: true }), 320);
    }
    setRefundPolicyHighlight(true);
    window.setTimeout(
      () => setRefundPolicyHighlight(false),
      REFUND_POLICY_PULSE_MS,
    );
  }, [t]);

  const formatPrice = useCallback(
    (cents: number) => fmtCurrency(fmt, cents, listing?.currency ?? "usd"),
    [fmt, listing?.currency],
  );

  // ── onBeforePayment: creates order + returns clientSecret ──────────
  const handleBeforePayment = useCallback(async (): Promise<BeforePaymentResult> => {
    if (!isSignedIn) {
      showSignInOverlay({ redirect: `/events/resale/${listingId}` });
      throw new Error("sign-in required");
    }

    if (!listing) {
      throw new Error("Listing data not loaded");
    }

    if (!termsAccepted) {
      handleTermsRequired();
      throw new Error("terms-required");
    }

    if (!refundPolicyAccepted) {
      handleRefundPolicyRequired();
      throw new Error("refund-policy-required");
    }

    // The order already exists (the press after a stop below, or a retry
    // after a declined card): pay THAT order. A second createCheckout would
    // be refused, the listing being held for this one.
    if (clientSecret && orderAmounts) {
      setErrorMessage(null);
      setNotice(null);
      // Even past its hold the order stays payable until the reaper cancels
      // its PaymentIntent (and releases the listing in the same pass); that
      // case comes back as `payment_intent_unexpected_state` / canceled and
      // is handled in handlePaymentError.
      return {
        clientSecret,
        amountCents:
          orderAmounts.amountGrossCents +
          orderAmounts.buyerFeesCents +
          orderAmounts.taxAmountCents,
      };
    }

    setPhase("creating");
    setErrorMessage(null);
    setNotice(null);

    let data: Awaited<ReturnType<typeof createCheckoutMutation.mutateAsync>>;
    try {
      data = await createCheckoutMutation.mutateAsync({
        buyerHumanId: sessionQuery.data!.user!.id,
        listingId: listing.id,
        clientKey: clientKeyRef.current,
        termsAccepted: true,
        refundPolicyAccepted: true,
      });

      // Rotate idempotency key for any future retries
      clientKeyRef.current = crypto.randomUUID();
    } catch (err: unknown) {
      // Same rule as the ticket checkout (lib/checkout-client-key.ts): keep
      // the key when the server may have committed the order (no app code)
      // or is still running it (IDEMPOTENCY_LOCK_IN_PROGRESS); rotate after
      // any other refusal, whose claim the server already released.
      if (!keepsCheckoutClientKey(err)) {
        clientKeyRef.current = crypto.randomUUID();
      }
      if (isEmailVerificationRequired(err)) {
        setVerifiedHere(false);
        setVerificationRefused(true);
        setPhase("viewing");
        throw err;
      }
      const msg = formatMutationError(err, t);
      setErrorMessage(msg);
      setPhase("error");
      throw err;
    }

    setOrderId(data.orderId);
    setClientSecret(data.clientSecret);
    setOrderAmounts({
      amountGrossCents: data.amountGrossCents,
      buyerFeesCents: data.buyerFeesCents,
      taxAmountCents: data.taxAmountCents,
    });
    setPhase("paying");

    const chargedCents =
      data.amountGrossCents + data.buyerFeesCents + data.taxAmountCents;

    // Stop and show: the Pay button named a figure (the estimate) or none
    // (tax unknown). A charge ABOVE what the buyer pressed is not confirmed:
    // the page now shows the order's total, and the card refuses this press
    // the way it refuses one without the terms (a thrown error; a wallet
    // sheet is closed as failed). The next press pays this order at the
    // figure on the button. A charge at or below the figure goes ahead, the
    // card re-syncing its amount to it.
    const shownCents = listing.estimatedTotalCents ?? null;
    if (shownCents == null || chargedCents > shownCents) {
      setNotice(
        String(
          t("resell.totalChangedPayAgain", {
            amount: formatPrice(chargedCents),
          }),
        ),
      );
      throw new Error("charge-above-shown");
    }

    return { clientSecret: data.clientSecret, amountCents: chargedCents };
  }, [
    isSignedIn,
    listing,
    listingId,
    clientSecret,
    orderAmounts,
    formatPrice,
    termsAccepted,
    handleTermsRequired,
    refundPolicyAccepted,
    handleRefundPolicyRequired,
    showSignInOverlay,
    sessionQuery.data,
    createCheckoutMutation,
    t,
  ]);

  // ── Payment callbacks ──────────────────────────────────────────────
  const handlePaymentSuccess = useCallback(
    (_paymentIntentId: string, paymentIntentStatus: PaymentSuccessStatus) => {
      setPhase(
        paymentIntentStatus === "processing" ? "processing" : "confirmed",
      );
    },
    [],
  );

  const handlePaymentError = useCallback(
    (msg: string, code?: string, paymentIntentStatus?: string) => {
      if (code === "payment_intent_unexpected_state") {
        // Already accepted (a confirm whose answer was lost, then a second
        // press): the order is the buyer's. Paid if it `succeeded`; a bank
        // debit still `processing` is not paid yet.
        if (
          paymentIntentStatus === "succeeded" ||
          paymentIntentStatus === "processing"
        ) {
          setErrorMessage(null);
          setPhase(
            paymentIntentStatus === "processing" ? "processing" : "confirmed",
          );
          return;
        }
        // Cancelled: the reaper closed it after the hold ran out, and
        // released the listing in the same pass. This order can never be
        // paid; drop it so the next press makes a new one.
        if (paymentIntentStatus === "canceled") {
          dropOrder();
          setErrorMessage(null);
          setNotice(String(t("resell.reservationEnded")));
          return;
        }
      }
      setErrorMessage(msg);
      // Stay on paying phase so user can retry the card
    },
    [dropOrder, t],
  );

  // ── Derived display values ─────────────────────────────────────────
  const orderTotalCents = orderAmounts
    ? orderAmounts.amountGrossCents +
      orderAmounts.buyerFeesCents +
      orderAmounts.taxAmountCents
    : null;

  // The header's price: the order's total once it exists, before that the
  // server's estimated total (processing and tax included, so the header
  // agrees with the rows below it), else the all-in price before tax ("plus
  // tax" beside it) as the server priced it (a listing from before the share
  // existed has only the ask).
  const totalCents =
    orderTotalCents ??
    listing?.estimatedTotalCents ??
    listing?.buyerTotalBeforeTaxCents ??
    listing?.askPriceCents ??
    0;

  // What the buyer will be CHARGED: the order's total once it exists, before
  // that the server's estimate including tax. Null while the tax is unknown,
  // so nothing claims a charge lower than the real one.
  const chargeCents = orderTotalCents ?? listing?.estimatedTotalCents ?? null;

  const payButtonLabel = useMemo(() => {
    // No figure (the card's own "Pay now") until the charge is known.
    if (chargeCents == null || chargeCents <= 0) return undefined;
    return String(
      t("checkout.payAmount", { amount: formatPrice(chargeCents) }),
    );
  }, [chargeCents, formatPrice, t]);

  const dateLabel = useMemo(() => {
    if (!listing?.eventStartsAt) return null;
    const d = new Date(listing.eventStartsAt);
    const weekday = fmt.dateTime(d, { weekday: "short" });
    const monthDay = fmt.dateTime(d, { month: "short", day: "numeric" });
    const time = fmt.dateTime(d, { hour: "numeric", minute: "2-digit" });
    return `${weekday}, ${monthDay} \u00B7 ${time}`;
  }, [listing?.eventStartsAt, fmt]);

  const seatDescription = useMemo(() => {
    if (!listing) return null;
    return formatSeatDescription(
      listing.seatLabel,
      listing.seatRow,
      listing.seatNumber,
    );
  }, [listing]);

  // ── Loading state ──────────────────────────────────────────────────
  if (listingQuery.isLoading || phase === "loading") {
    return (
      <div style={containerStyle}>
        <div style={cardStyle}>
          <div style={{ padding: 40, textAlign: "center" }}>
            <Text variant="body" tone="muted">
              Loading listing...
            </Text>
          </div>
        </div>
      </div>
    );
  }

  // ── Confirmed / processing state ───────────────────────────────────
  // `processing` (a bank debit in flight, marked `data-payment-processing`)
  // keeps the confirmed screen's layout and changes only what is untrue
  // before the money clears: a clock on a warning tint, "Payment
  // processing", and one paragraph on what happens next (owner, board
  // option A, 2026-10-14).
  // Before the not-found / unavailable branches: a purchase is never swapped
  // for "Listing not found" when a background refetch fails. React Query
  // keeps `data` across a refetch error, but the listing is still optional
  // here; without it the screen goes without the listing's names.
  const renderPurchaseDone = (processing: boolean) => {
    // Processing: the primary button opens the order (no ticket held yet).
    const viewOrder = processing && orderId !== null;
    return (
      <div style={containerStyle}>
        <div
          style={cardStyle}
          data-payment-processing={processing ? "true" : undefined}
        >
          <div style={{ padding: "40px 24px", textAlign: "center" }}>
            <div
              style={{
                width: 64,
                height: 64,
                borderRadius: 0,
                background: processing
                  ? "color-mix(in srgb, var(--warningSoft, #92400E) 15%, transparent)"
                  : "rgba(34, 197, 94, 0.15)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                margin: "0 auto 16px",
              }}
            >
              {processing ? (
                <Clock
                  size={32}
                  color="var(--warningSoft, #92400E)"
                  aria-hidden
                />
              ) : (
                <CheckCircle size={32} color="var(--success, #166534)" />
              )}
            </div>
            <Text variant="h3" weight="bold" style={{ marginBottom: 8 }}>
              {processing
                ? String(t("resell.paymentProcessingTitle"))
                : "Purchase confirmed"}
            </Text>
            <Text variant="body" tone="muted" style={{ marginBottom: 4 }}>
              {listing?.eventName ?? "Event"}
            </Text>
            {listing?.ticketTypeName && (
              <Text
                variant="bodySmall"
                tone="muted"
                style={{ marginBottom: 4 }}
              >
                {listing.ticketTypeName}
                {seatDescription ? ` \u2014 ${seatDescription}` : ""}
              </Text>
            )}
            {processing && (
              <Text
                variant="bodySmall"
                style={{
                  display: "block",
                  maxWidth: 460,
                  // The order code below carries the gap to the buttons.
                  margin: orderId ? "12px auto 0" : "12px auto 20px",
                  lineHeight: 1.5,
                }}
              >
                {String(t("resell.paymentProcessingBody"))}
              </Text>
            )}
            {/* The ONE order code — the 8-hex TAIL via `formatOrderCode`,
                matching the primary checkout confirmation and admin search.
                `slice(0, 8)` (what this was) is ALSO 8 hex chars, so it passes
                the search parser and then matches nothing, silently. No
                trailing "…" either: that signalled a truncated UUID, and the
                code is complete, not truncated. Bare (no `#`) because the
                "Order " prefix already labels it. */}
            {orderId && (
              <Text
                variant="caption"
                tone="muted"
                style={{ marginTop: 12, marginBottom: 20 }}
              >
                Order {formatOrderCode(orderId)}
              </Text>
            )}
            <div
              style={{
                display: "flex",
                gap: 12,
                justifyContent: "center",
                flexWrap: "wrap",
              }}
            >
              {listing?.eventSlug && (
                <Button
                  variant="secondary"
                  onPress={() => router.push(`/events/${listing.eventSlug}`)}
                >
                  Back to event
                </Button>
              )}
              {/* Processing: no ticket to hold yet, so the order itself
                  (a resale purchase is an ordinary buyer order). */}
              <Button
                variant="primary"
                onPress={() =>
                  router.push(
                    viewOrder ? `/my-tickets/${orderId}`
                      : "/account/tickets",
                  )
                }
              >
                {viewOrder
                  ? String(t("confirmation.viewOrder"))
                  : "View my tickets"}
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  };
  if (phase === "confirmed" || phase === "processing") {
    return renderPurchaseDone(phase === "processing");
  }

  // ── Listing not found / error ──────────────────────────────────────
  if (listingQuery.isError || !listing) {
    return (
      <div style={containerStyle}>
        <div style={cardStyle}>
          <div style={{ padding: 40, textAlign: "center" }}>
            <AlertCircle
              size={32}
              color="var(--danger, #B91C1C)"
              style={{ marginBottom: 12 }}
            />
            <Text variant="h4" weight="bold" style={{ marginBottom: 8 }}>
              Listing not found
            </Text>
            <Text variant="body" tone="muted" style={{ marginBottom: 20 }}>
              This listing may have been sold, cancelled, or expired.
            </Text>
            <Button variant="secondary" onPress={() => router.push("/")}>
              Back to home
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // ── Listing is not active ──────────────────────────────────────────
  if (
    listing.status !== "ACTIVE" &&
    // (confirmed / processing returned above)
    phase !== "paying" &&
    phase !== "creating"
  ) {
    return (
      <div style={containerStyle}>
        <div style={cardStyle}>
          <div style={{ padding: 40, textAlign: "center" }}>
            <AlertCircle
              size={32}
              color="var(--support, #f59e0b)"
              style={{ marginBottom: 12 }}
            />
            <Text variant="h4" weight="bold" style={{ marginBottom: 8 }}>
              Listing unavailable
            </Text>
            <Text variant="body" tone="muted" style={{ marginBottom: 20 }}>
              This listing is currently {listing.status.toLowerCase()}.
            </Text>
            {listing.eventSlug && (
              <Button
                variant="secondary"
                onPress={() => router.push(`/events/${listing.eventSlug}`)}
              >
                Back to event
              </Button>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ── The viewer's own listing ───────────────────────────────────────
  // The seller opening their own link: checkout would refuse
  // (CANNOT_BUY_OWN_LISTING), so no payment card, only what the page is for.
  if (listing.isOwnListing) {
    return (
      <div style={containerStyle}>
        <div style={cardStyle}>
          <div style={{ padding: 40, textAlign: "center" }}>
            <Text variant="h4" weight="bold" style={{ marginBottom: 8 }}>
              {String(t("resell.ownListingTitle"))}
            </Text>
            <Text variant="body" tone="muted" style={{ marginBottom: 20 }}>
              {String(t("resell.ownListingBody"))}
            </Text>
            {listing.eventSlug && (
              <Button
                variant="secondary"
                onPress={() => router.push(`/events/${listing.eventSlug}`)}
              >
                {String(t("common.backToEvent"))}
              </Button>
            )}
          </div>
        </div>
      </div>
    );
  }


  // ── Main checkout view ─────────────────────────────────────────────
  return (
    <div style={containerStyle}>
      {/* Responsive breakpoint */}
      <style>{`
        @media (max-width: 720px) {
          .resale-checkout-grid { grid-template-columns: 1fr !important; }
        }
      `}</style>

      {/* Back link */}
      {listing.eventSlug && (
        <button
          type="button"
          onClick={() => router.push(`/events/${listing.eventSlug}`)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            background: "none",
            border: "none",
            cursor: "pointer",
            color: STRUCTURAL,
            fontSize: 13,
            fontWeight: 700,
            letterSpacing: 1.2,
            textTransform: "uppercase" as const,
            marginBottom: 16,
            padding: 0,
          }}
        >
          ← Back to event
        </button>
      )}

      <div style={mainGridStyle} className="resale-checkout-grid">
        {/* ── Left column: Listing details ──────────────────────────── */}
        <div style={cardStyle}>
          {/* Event header */}
          <div style={{ padding: "20px 24px", borderBottom: BORDER_SUBTLE }}>
            <Text variant="h4" weight="bold" style={{ marginBottom: 4 }}>
              Resale ticket
            </Text>
            {listing.eventName && (
              <Text variant="body" weight="bold" style={{ marginBottom: 8 }}>
                {listing.eventName}
              </Text>
            )}
            {/* The price the buyer pays comes first (the FTC all-in rule). */}
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                flexWrap: "wrap",
                gap: 8,
                marginBottom: 8,
              }}
              data-testid="resale-all-in-price"
            >
              <Text variant="h3" weight="bold">
                {formatPrice(totalCents)}
              </Text>
              {!orderAmounts && (
                <Text variant="caption" tone="muted">
                  {String(
                    t(
                      listing.estimatedTotalCents != null
                        ? "resell.estimatedTotalWithProcessingAndTax"
                        : listing.buyerTotalBeforeTaxCents != null &&
                            listing.processingPassThroughCents > 0
                          ? "resell.plusTaxIncludesProcessing"
                          : "resell.plusTax",
                    ),
                  )}
                </Text>
              )}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {dateLabel && (
                <div style={metaRowStyle}>
                  <Calendar size={14} color={FG_MUTED} />
                  <Text variant="bodySmall" tone="muted">
                    {dateLabel}
                  </Text>
                </div>
              )}
              {listing.eventLocationLabel && (
                <div style={metaRowStyle}>
                  <MapPin size={14} color={FG_MUTED} />
                  <Text variant="bodySmall" tone="muted">
                    {listing.eventLocationLabel}
                  </Text>
                </div>
              )}
            </div>
          </div>

          {/* Ticket details */}
          <div style={{ padding: "20px 24px" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {/* Ticket type */}
              {listing.ticketTypeName && (
                <div style={metaRowStyle}>
                  <Tag size={14} color={FG_MUTED} />
                  <Text variant="body" weight="medium">
                    {listing.ticketTypeName}
                  </Text>
                </div>
              )}

              {/* Seat info */}
              {seatDescription && (
                <div style={metaRowStyle}>
                  <Ticket size={14} color={FG_MUTED} />
                  <Text variant="body">{seatDescription}</Text>
                </div>
              )}

              {/* Section (when no seat description) */}
              {listing.sectionName && !seatDescription && (
                <div style={metaRowStyle}>
                  <MapPin size={14} color={FG_MUTED} />
                  <Text variant="body">{listing.sectionName}</Text>
                </div>
              )}

              {/* Expiry notice */}
              {listing.expiresAt && (
                <div style={metaRowStyle}>
                  <Clock size={14} color={FG_MUTED} />
                  <Text variant="caption" tone="muted">
                    Available until{" "}
                    {new Date(listing.expiresAt).toLocaleDateString()}
                  </Text>
                </div>
              )}
            </div>

            <div
              style={{
                height: 1,
                background: DIVIDER_COLOR,
                margin: "20px 0",
              }}
            />

            {/* Price breakdown */}
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={priceRowStyle}>
                <Text variant="body">
                  {String(t("checkout.ticketPrice"))}
                </Text>
                <Text variant="body" weight="bold">
                  {formatPrice(listing.askPriceCents)}
                </Text>
              </div>

              {listing.sharePayer === "BUYER" &&
                listing.eventShareCents != null &&
                listing.eventShareCents > 0 && (
                  <div style={priceRowStyle}>
                    <Text variant="bodySmall" tone="muted">
                      {String(t("resell.shareLineLabel"))}
                    </Text>
                    <Text variant="bodySmall" tone="muted">
                      {formatPrice(listing.eventShareCents)}
                    </Text>
                  </div>
                )}

              {/* Processing covers the whole charge, tax included: with an
                  estimate, its processing (so the rows add up to the
                  estimated total); without one, the listing's pre-tax
                  figure beside "Tax is added at checkout". */}
              {(orderAmounts
                ? orderAmounts.buyerFeesCents
                : (listing.estimatedProcessingCents ??
                  listing.processingPassThroughCents)) > 0 && (
                <div style={priceRowStyle}>
                  <Text variant="bodySmall" tone="muted">
                    {String(t("checkout.processingFee"))}
                  </Text>
                  <Text variant="bodySmall" tone="muted">
                    {formatPrice(
                      orderAmounts
                        ? orderAmounts.buyerFeesCents
                        : (listing.estimatedProcessingCents ??
                            listing.processingPassThroughCents),
                    )}
                  </Text>
                </div>
              )}

              {orderAmounts
                ? orderAmounts.taxAmountCents > 0 && (
                    <div style={priceRowStyle}>
                      <Text variant="bodySmall" tone="muted">
                        {String(t("checkout.taxes"))}
                      </Text>
                      <Text variant="bodySmall" tone="muted">
                        {formatPrice(orderAmounts.taxAmountCents)}
                      </Text>
                    </div>
                  )
                : listing.estimatedTaxCents != null &&
                  listing.estimatedTaxCents > 0 && (
                    <div style={priceRowStyle}>
                      <Text variant="bodySmall" tone="muted">
                        {String(t("checkout.estimatedTaxes"))}
                      </Text>
                      <Text variant="bodySmall" tone="muted">
                        {formatPrice(listing.estimatedTaxCents)}
                      </Text>
                    </div>
                  )}

              <div
                style={{
                  height: 1,
                  background: DIVIDER_COLOR,
                  margin: "4px 0",
                }}
              />

              {/* Once the order exists, its total; before that the
                  estimate including tax, or, with the tax unknown, the
                  subtotal and a note that tax is added at checkout. */}
              <div style={priceRowStyle} data-testid="resale-total-row">
                <Text variant="body" weight="bold">
                  {String(
                    t(
                      orderAmounts
                        ? "checkout.total"
                        : chargeCents != null
                          ? "checkout.estimatedTotal"
                          : "checkout.subtotal",
                    ),
                  )}
                </Text>
                <Text variant="body" weight="bold">
                  {formatPrice(chargeCents ?? totalCents)}
                </Text>
              </div>

              {chargeCents == null && (
                <Text variant="caption" tone="muted" style={{ marginTop: 4 }}>
                  {String(t("resell.taxAtCheckout"))}
                </Text>
              )}

              {/* Original price, then where the share goes. */}
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 4,
                  marginTop: 8,
                }}
              >
                <ResaleListingFacts
                  listing={listing}
                  showShare={listing.sharePayer !== "BUYER"}
                />
              </div>
            </div>
          </div>
        </div>

        {/* ── Right column: Payment ────────────────────────────────── */}
        <div style={cardStyle}>
          <div style={{ padding: "20px 24px" }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginBottom: 20,
              }}
            >
              <ShieldCheck size={18} color={FG} />
              <Text variant="h4" weight="bold">
                Payment
              </Text>
            </div>

            {!isSignedIn && hasMounted && (
              <div
                style={{
                  padding: "16px 20px",
                  borderRadius: 0,
                  background: "rgba(59, 130, 246, 0.1)",
                  border: "1px solid rgba(59, 130, 246, 0.2)",
                  marginBottom: 20,
                }}
              >
                <Text variant="body" style={{ marginBottom: 12 }}>
                  Sign in to purchase this ticket
                </Text>
                <Button
                  variant="primary"
                  onPress={() =>
                    showSignInOverlay({
                      redirect: `/events/resale/${listingId}`,
                    })
                  }
                >
                  Sign in
                </Button>
              </div>
            )}

            {notice && (
              <div
                role="status"
                data-testid="resale-checkout-notice"
                style={{
                  padding: "12px 16px",
                  borderRadius: 0,
                  background: MUTED,
                  border: BORDER_SUBTLE,
                  marginBottom: 16,
                }}
              >
                <Text variant="bodySmall">{notice}</Text>
              </div>
            )}

            {errorMessage && (
              <div
                style={{
                  padding: "12px 16px",
                  borderRadius: 0,
                  background: "rgba(239, 68, 68, 0.1)",
                  border: "1px solid rgba(239, 68, 68, 0.2)",
                  marginBottom: 16,
                }}
              >
                <Text variant="bodySmall" style={{ color: "var(--danger, #B91C1C)" }}>
                  {errorMessage}
                </Text>
              </div>
            )}

            {needsVerification ? (
              <EmailVerificationRequired
                context="resale"
                testId="resale-checkout-verify-email"
                // The server refused the Pay press and the card it lived in
                // is gone: put focus on the prompt, not <body>.
                autoFocusHeading={verificationRefused}
                onVerified={() => {
                  setVerifiedHere(true);
                  setVerificationRefused(false);
                }}
              />
            ) : null}

            {isSignedIn && !needsVerification && (
              <>
                <RefundDisclosure
                  id="resale-refund-policy-accept"
                  sale="RESALE"
                  cart={[
                    {
                      id: listing.id,
                      quantity: 1,
                      pricingMode: "FIXED",
                      priceCents: listing.askPriceCents,
                    },
                  ]}
                  refundPolicyHref="/help/buying-tickets/refunds-and-cancellations"
                  checked={refundPolicyAccepted}
                  onCheckedChange={setRefundPolicyAccepted}
                  termsChecked={termsAccepted}
                  onTermsCheckedChange={setTermsAccepted}
                  termsHref={`/terms?v=${CURRENT_TERMS_VERSION}`}
                  checkboxRef={setAgreementCheckboxRef}
                  highlight={refundPolicyHighlight}
                />
                {/* Same reservation as the ticket checkout, deliberately not a
                    resale-specific copy: `.checkout-payment-slot`'s rungs are a
                    CONTAINER query on the slot's own inline size, so they read
                    whatever width this two-column layout gives them without a
                    second ladder to keep in sync.

                    It sits INSIDE the `isSignedIn` branch, not around it. The
                    card only exists for a signed-in buyer, so hoisting the
                    reservation would leave a ~950px hole under the sign-in
                    prompt for everyone else. */}
                <div className="checkout-payment-measure">
                  <div className="checkout-payment-slot">
                    <StripePaymentCard
                      clientSecret={clientSecret}
                      onSuccess={handlePaymentSuccess}
                      onError={handlePaymentError}
                      // Elements' starting amount (the wallet sheet shows
                      // it); the card re-syncs to the order's charge before
                      // confirming. Pre-tax only while the tax is unknown.
                      totalCents={chargeCents ?? totalCents}
                      currency={listing.currency}
                      eventName={listing.eventName ?? undefined}
                      onBeforePayment={handleBeforePayment}
                      isCreatingOrder={createCheckoutMutation.isPending}
                      totalLabel={payButtonLabel}
                      disabled={!termsAccepted || !refundPolicyAccepted}
                      // A wallet sheet shows the card's starting amount, which
                      // is pre-tax while the tax is unknown: no wallets then.
                      expressPay={listing.estimatedTotalCents != null}
                      // After a stop the total changes; the card keeps the
                      // wallet sheet on the new one (StripeAmountSync).
                    />
                  </div>
                </div>
              </>
            )}

            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                marginTop: 16,
                justifyContent: "center",
              }}
            >
              <ShieldCheck size={12} color={FG_MUTED} />
              <Text variant="caption" tone="muted">
                {String(t("checkout.buyerProtectionIncluded"))}
              </Text>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatSeatDescription(
  seatLabel: string | null,
  seatRow: string | null,
  seatNumber: number | null,
): string | null {
  if (!seatLabel && !seatRow && seatNumber == null) return null;
  if (seatRow && seatNumber != null)
    return `Row ${seatRow}, Seat ${seatNumber}`;
  if (seatLabel) return seatLabel;
  if (seatNumber != null) return `Seat ${seatNumber}`;
  return null;
}

function formatMutationError(
  err: unknown,
  t: ReturnType<typeof useTranslations>,
): string {
  const code = getAppErrorCode(err);
  if (code === "CANNOT_BUY_OWN_LISTING") {
    return String(t("errors.cannotBuyOwnListing"));
  }
  if (code === "BUYER_MUST_BE_ACTOR") {
    return "Authentication error. Please try again.";
  }
  if (code === "LISTING_ALREADY_HELD") {
    return "This ticket is currently held by another buyer. Try again shortly.";
  }
  if (code === "LISTING_NOT_ACTIVE") {
    return "This listing is no longer available.";
  }
  if (code === "RESALE_PRICE_EXCEEDS_CAP") {
    return "This listing's price has been flagged. Please contact support.";
  }
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    if (typeof e.message === "string") {
      return e.message;
    }
    // tRPC wraps errors in shape
    const shaped = e as { shape?: { message?: string } };
    if (shaped.shape?.message) return shaped.shape.message;
  }
  return "Something went wrong. Please try again.";
}

// ── Styles ───────────────────────────────────────────────────────────────────

const containerStyle: React.CSSProperties = {
  maxWidth: 960,
  margin: "0 auto",
  padding: "24px 16px 60px",
};

const mainGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: 20,
  alignItems: "start",
};

const cardStyle: React.CSSProperties = {
  borderRadius: 0,
  border: BORDER_SUBTLE,
  background: SURFACE,
  overflow: "hidden",
};

const metaRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
};

const priceRowStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 12,
};
