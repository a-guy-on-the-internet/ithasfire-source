"use client";

import { useMemo, useState } from "react";
import { CheckCircle, Share2, Ticket } from "lucide-react";
import { useTranslations } from "@th/ui";
import { formatOrderCode } from "@th/types/order-identifier";

import { CheckoutStepper } from "@/app/events/checkout/[...slug]/_components/CheckoutStepper";
import {
  buildGoogleCalendarUrl,
  buildOutlookCalendarUrl,
} from "@/lib/calendar/web-calendar";
import { downloadICalFile } from "@/lib/calendar/ical";
import { buildCanonicalUrl } from "@/config/site";
import { trpc } from "@/trpc";
import { getEmbedHostOrigin } from "@/lib/embed-host-origin";

import type {
  CheckoutStepId,
  EmbedCheckoutConfirmation,
} from "./embed-types";
import {
  BRAND_ORANGE,
  STEEL_BLUE,
  BORDER,
  TEXT,
  TEXT_MUTED,
  TEXT_CAPTION,
  TEXT_ON_BRAND,
  SURFACE,
  SURFACE_MUTED,
  BORDER_SUBTLE,
  SUCCESS,
  SUCCESS_BG,
  sectionLabelStyle,
} from "./embed-theme";
import { formatCurrencyExact } from "./embed-helpers";
import { EmbedSummaryRows, embedFiguresFromOrder } from "./EmbedSummaryRows";
import { EmbedTickets } from "./EmbedTickets";

export function EmbedConfirmation({
  embedId,
  eventId,
  checkout,
  email,
  onDone,
  completedStepIds,
}: {
  embedId: string;
  eventId: string | null;
  checkout: EmbedCheckoutConfirmation | null;
  email: string;
  onDone: () => void;
  completedStepIds: CheckoutStepId[];
}) {
  const t = useTranslations();
  const [shareCopied, setShareCopied] = useState(false);
  const { data: eventDetail } = trpc.embeds.getEventDetail.useQuery(
    { embedId, eventId: eventId ?? "", hostOrigin: getEmbedHostOrigin() },
    { enabled: Boolean(eventId), staleTime: 30_000 },
  );

  const currency = eventDetail?.event.currency ?? "usd";

  const calendarEvent = useMemo(() => {
    if (!eventDetail?.event) return null;
    // `toISOString` throws on an unreadable date: no real start, no calendar
    // block; an unreadable end is dropped (the builders default to +2h).
    const start = new Date(eventDetail.event.startsAt);
    if (Number.isNaN(start.getTime())) return null;
    const end = eventDetail.event.endsAt
      ? new Date(eventDetail.event.endsAt)
      : null;
    return {
      // The .ics UID basis — a second "Add to calendar" then updates the entry
      // the buyer already holds rather than duplicating it.
      id: eventDetail.event.id,
      title: eventDetail.event.title,
      startsAt: start.toISOString(),
      ...(end && !Number.isNaN(end.getTime())
        ? { endsAt: end.toISOString() }
        : {}),
      ...(eventDetail.event.addressText
        ? { location: eventDetail.event.addressText }
        : {}),
      // An absolute link on the web app's own site: a calendar entry is read
      // outside any page, where a bare path leads nowhere, and the host
      // page's origin has no /events route. Built from the configured site
      // URL (the widget's link-outs use the same), so the server render and
      // hydration agree; `window` is never read here.
      description: `Tickets purchased via Ithas Fire.${eventDetail.event.slug ? ` Event: ${buildCanonicalUrl(`/events/${eventDetail.event.slug}`)}` : ""}`,
    };
  }, [eventDetail?.event]);

  const handleShare = async () => {
    const eventSlug = eventDetail?.event.slug;
    const shareUrl = eventSlug
      ? `${window.location.origin}/events/${eventSlug}`
      : window.location.href;

    if (navigator.share) {
      await navigator.share({
        title: eventDetail?.event.title ?? "Event",
        text: "I just got tickets.",
        url: shareUrl,
      });
      return;
    }

    await navigator.clipboard.writeText(shareUrl);
    setShareCopied(true);
    window.setTimeout(() => setShareCopied(false), 1500);
  };

  // The charged Total must use the same basis as EmbedCheckout.displayTotalCents
  // and the sidebar: `buyerFeesCents` (what the buyer actually paid), NOT
  // `feesPlatformCents` (the platform fee regardless of who funded it). In
  // ABSORB those differ — buyerFeesCents is 0 while feesPlatformCents is the
  // seller-absorbed amount — so using feesPlatformCents here would overstate the
  // buyer's Total versus the sidebar/charge. The rows below (EmbedSummaryRows)
  // print the same basis: Platform = `buyerFeesCents` in PASS_THROUGH, and an
  // absorbed fee reads "Included".
  //
  // In PASS_THROUGH the buyer funds the grossed-up processor fee (it is part of
  // the charge), so it is added to the Total and rendered as a charged line. In
  // ABSORB the processor fee is display-only (Stripe deducts it from the
  // organizer's settlement), so it is excluded from the Total and annotated
  // "Included". There is no credit to subtract: createEmbedGuestCheckout passes
  // `applyPlatformCredit: false`, so an embed order never redeems the buyer's
  // platform credit (owner ruling 2026-10-03). Mirrors OrderSummary /
  // EmbedOrderSummarySidebar.
  const isPassThrough = checkout?.orderFees.feeMode === "PASS_THROUGH";
  const orderTotal = checkout
    ? checkout.orderFees.amountGrossCents +
      checkout.orderFees.buyerFeesCents +
      (isPassThrough ? (checkout.orderFees.processorFeeCents ?? 0) : 0) +
      checkout.orderFees.taxAmountCents
    : 0;
  // The lines as charged, from the SERVER's persisted order (the guest
  // checkout reads them back after pricing): face × qty, a pay-what-you-want
  // line at the buyer's amount. Never rebuilt from the cart, which can
  // disagree with what was priced. Pre-discount, so Σ lineCents −
  // amountGrossCents is the Discount row EmbedSummaryRows prints.
  const confirmationLines = (checkout?.lineItems ?? []).map((line) => ({
    id: `${line.ticketTypeId}:${line.unitPriceCents}`,
    name: line.name,
    qty: line.qty,
    lineCents: line.lineCents,
  }));

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {/* Stepper — all done */}
      <div
        style={{
          borderBottom: `1px solid ${BORDER_SUBTLE}`,
          background: SURFACE,
        }}
      >
        <CheckoutStepper
          currentStepId="confirmed"
          completedStepIds={completedStepIds}
        />
      </div>

      <div
        style={{
          display: "flex",
          minHeight: 260,
          flexDirection: "column",
          alignItems: "stretch",
          justifyContent: "center",
          gap: 16,
          padding: "40px 24px",
          textAlign: "left",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div
            className="th-embed-confirmation-pop"
            style={{
              display: "flex",
              height: 56,
              width: 56,
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 0,
              background: SUCCESS_BG,
              border: `2px solid ${SUCCESS}`,
              flexShrink: 0,
            }}
          >
            <CheckCircle size={28} style={{ color: SUCCESS }} />
          </div>

          <div
            className="th-embed-fade-in-up"
            // minWidth 0: a flex child will not shrink below its content
            // otherwise, and a narrow iframe clips the heading and email.
            style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}
          >
            <h3
              style={{
                fontSize: 18,
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "0.02em",
                color: TEXT,
                margin: 0,
                overflowWrap: "anywhere",
              }}
            >
              Order confirmed
            </h3>
            <p
              style={{
                fontSize: 13,
                lineHeight: 1.6,
                color: TEXT_MUTED,
                margin: 0,
              }}
            >
              Tickets sent to{" "}
              <span
                style={{
                  fontWeight: 700,
                  color: STEEL_BLUE,
                  overflowWrap: "anywhere",
                }}
              >
                {email}
              </span>
            </p>
            {checkout?.orderId && (
              // The ONE order code (`formatOrderCode`): what the buyer quotes
              // to the box office or to support, tickets on screen or not.
              <p
                style={{
                  margin: 0,
                  fontSize: 12,
                  lineHeight: 1.6,
                  color: TEXT_CAPTION,
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                  fontWeight: 700,
                }}
              >
                {String(t("checkout.embedTicketsOrderLabel"))}{" "}
                <span
                  data-testid="embed-order-code"
                  style={{
                    fontFamily: "var(--font-mono, monospace)",
                    color: TEXT,
                    userSelect: "all",
                  }}
                >
                  #{formatOrderCode(checkout.orderId)}
                </span>
              </p>
            )}
          </div>
        </div>

        {/* The scannable code first: a buyer whose email is slow or mistyped
            still has something to show at the door. Nothing renders without
            tickets (an older API, or codes the server withheld). */}
        <EmbedTickets tickets={checkout?.tickets ?? []} />

        {eventDetail?.event && (
          <div
            style={{
              border: `1px solid ${BORDER_SUBTLE}`,
              background: SURFACE_MUTED,
              padding: "12px 14px",
              display: "flex",
              flexDirection: "column",
              gap: 4,
            }}
          >
            <p
              style={{
                margin: 0,
                fontSize: 12,
                color: TEXT_CAPTION,
                textTransform: "uppercase",
                letterSpacing: "0.08em",
                fontWeight: 700,
              }}
            >
              Event
            </p>
            <p
              style={{ margin: 0, fontSize: 14, fontWeight: 700, color: TEXT }}
            >
              {eventDetail.event.title}
            </p>
            {eventDetail.event.addressText && (
              <p style={{ margin: 0, fontSize: 12, color: TEXT_MUTED }}>
                {eventDetail.event.addressText}
              </p>
            )}
          </div>
        )}

        {checkout && (
          <div
            style={{
              border: `1px solid ${BORDER_SUBTLE}`,
              background: SURFACE,
              padding: "12px 14px",
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            <h4 style={sectionLabelStyle}>Order summary</h4>

            {/* The embed's shared rows (the sidebar's and the tray's): face
                lines, Subtotal (pre-discount), Platform (what the buyer paid),
                Processing, Taxes ($0.00 at zero) and — with a promo — the
                Discount, so they add up to the Total below. Exact money
                throughout. */}
            <EmbedSummaryRows
              lines={confirmationLines}
              figures={embedFiguresFromOrder(
                checkout.orderFees,
                checkout.orderFees.feeMode ?? null,
                confirmationLines.reduce((sum, line) => sum + line.lineCents, 0),
              )}
              feeMode={checkout.orderFees.feeMode ?? null}
              currency={currency}
              testIdPrefix="embed-confirmation"
            />
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 4,
                fontSize: 12,
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  borderTop: `1px solid ${BORDER_SUBTLE}`,
                  paddingTop: 6,
                  marginTop: 2,
                }}
              >
                <span
                  style={{
                    color: TEXT,
                    fontWeight: 700,
                    textTransform: "uppercase",
                    letterSpacing: "0.04em",
                  }}
                >
                  Total
                </span>
                <span
                  data-testid="embed-confirmation-total-value"
                  style={{ color: TEXT, fontWeight: 700 }}
                >
                  {formatCurrencyExact(orderTotal, currency)}
                </span>
              </div>
            </div>
          </div>
        )}

        <div
          style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}
        >
          <button
            type="button"
            onClick={handleShare}
            style={{
              borderRadius: 0,
              border: `1px solid ${BORDER}`,
              background: SURFACE,
              padding: "10px 12px",
              fontSize: 12,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.04em",
              color: STEEL_BLUE,
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
            }}
          >
            <Share2 size={14} />
            {shareCopied ? "Copied" : "Share"}
          </button>

          <button
            type="button"
            onClick={() => onDone()}
            style={{
              borderRadius: 0,
              border: "none",
              background: BRAND_ORANGE,
              padding: "10px 12px",
              fontSize: 12,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.04em",
              // Ink on the orange fill — white fails AA (3.16:1).
              color: TEXT_ON_BRAND,
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
            }}
          >
            <Ticket size={14} />
            Done
          </button>
        </div>

        {calendarEvent && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <h4 style={sectionLabelStyle}>Add to calendar</h4>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr 1fr",
                gap: 8,
              }}
            >
              <a
                href={buildGoogleCalendarUrl(calendarEvent)}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  borderRadius: 0,
                  border: `1px solid ${BORDER}`,
                  background: SURFACE,
                  padding: "9px 8px",
                  fontSize: 11,
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: "0.04em",
                  color: STEEL_BLUE,
                  textDecoration: "none",
                  textAlign: "center",
                }}
              >
                Google
              </a>
              <a
                href={buildOutlookCalendarUrl(calendarEvent)}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  borderRadius: 0,
                  border: `1px solid ${BORDER}`,
                  background: SURFACE,
                  padding: "9px 8px",
                  fontSize: 11,
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: "0.04em",
                  color: STEEL_BLUE,
                  textDecoration: "none",
                  textAlign: "center",
                }}
              >
                Outlook
              </a>
              <button
                type="button"
                onClick={() => downloadICalFile(calendarEvent)}
                style={{
                  borderRadius: 0,
                  border: `1px solid ${BORDER}`,
                  background: SURFACE,
                  padding: "9px 8px",
                  fontSize: 11,
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: "0.04em",
                  color: STEEL_BLUE,
                  cursor: "pointer",
                }}
              >
                iCal
              </button>
            </div>
          </div>
        )}

        {checkout?.orderId && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <h4 style={sectionLabelStyle}>Wallet passes</h4>
            <p
              style={{
                margin: 0,
                fontSize: 11,
                lineHeight: 1.5,
                color: TEXT_CAPTION,
              }}
            >
              Add your tickets to Apple or Google Wallet from the My Tickets
              page after signing in.
            </p>
          </div>
        )}

        <button
          type="button"
          onClick={onDone}
          className="th-embed-fade-in-up"
          style={{
            marginTop: 2,
            borderRadius: 0,
            border: `1px solid ${BORDER}`,
            background: SURFACE,
            padding: "10px 16px",
            fontSize: 12,
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "0.04em",
            color: STEEL_BLUE,
            cursor: "pointer",
            animationDelay: "150ms",
          }}
        >
          Close
        </button>
      </div>
    </div>
  );
}
