"use client";

import { Clock, Lock, ShieldCheck } from "lucide-react";

import type { EmbedOrderSummarySidebarProps } from "./embed-checkout-types";
import { formatEventDateLabel } from "./embed-helpers";
import {
  EmbedSummaryRows,
  embedFiguresFromEstimate,
  embedFiguresFromOrder,
} from "./EmbedSummaryRows";
import {
  BORDER,
  BORDER_SUBTLE,
  DANGER,
  DANGER_BG,
  SURFACE,
  SURFACE_MUTED,
  TEXT,
  TEXT_CAPTION,
  TEXT_MUTED,
  sectionLabelStyle,
  sectionNumStyle,
  trustBadgeStyle,
} from "./embed-theme";

export function EmbedOrderSummarySidebar({
  cart,
  eventDetail,
  lineCentsByTicketType,
  orderLines = null,
  orderFees,
  preOrderEstimate = null,
  displayTotalCents: _displayTotalCents,
  displayTotalLabel,
  currency,
  platformFeeRateLabel,
  processorFeeRateLabel,
  taxRateBps,
  feeMode = null,
  countdown,
  isHoldExpired,
  forceVisibleOnMobile = false,
}: EmbedOrderSummarySidebarProps) {
  // Face × qty — a PWYW line at the buyer's amount (the caller's ticket
  // types), an override seat at its shown price (`lineCentsByTicketType`).
  const cartLines = cart
    .filter((c) => c.qty > 0)
    .flatMap((item) => {
      const tt = eventDetail?.ticketTypes?.find(
        (ticketType) => ticketType.id === item.ticketTypeId,
      );
      return tt
        ? [
            {
              id: item.ticketTypeId,
              name: tt.name,
              qty: item.qty,
              lineCents:
                lineCentsByTicketType?.[item.ticketTypeId] ??
                tt.priceCents * item.qty,
            },
          ]
        : [];
    });
  // Once the order exists, its lines are the server's (`orderLines`), so the
  // lines, Subtotal and Discount all come from what was charged.
  const summaryLines = orderFees && orderLines ? orderLines : cartLines;
  return (
    <div
      className={`th-embed-checkout-sidebar${
        forceVisibleOnMobile ? " th-embed-checkout-sidebar--always" : ""
      }`}
      style={{ width: 260, flexShrink: 0 }}
    >
      <div
        style={{
          overflow: "hidden",
          borderRadius: 0,
          border: `2px solid ${BORDER}`,
          background: SURFACE,
        }}
      >
        <div
          style={{
            borderBottom: `1px solid ${BORDER_SUBTLE}`,
            background: SURFACE_MUTED,
            padding: "10px 16px",
            display: "flex",
            alignItems: "baseline",
            gap: 6,
          }}
        >
          <span style={sectionNumStyle}>02.</span>
          <h3 style={sectionLabelStyle}>Order summary</h3>
        </div>

        {/* Event name */}
        {eventDetail?.event && (
          <div
            style={{
              borderBottom: `1px solid ${BORDER_SUBTLE}`,
              padding: "10px 16px",
            }}
          >
            <p
              style={{
                fontSize: 12,
                fontWeight: 700,
                lineHeight: 1.4,
                color: TEXT,
                margin: 0,
              }}
            >
              {eventDetail.event.title}
            </p>
            <p style={{ marginTop: 2, fontSize: 11, color: TEXT_CAPTION }}>
              {formatEventDateLabel(
                eventDetail.event.startsAt,
                eventDetail.event.timezone,
              )}
            </p>
          </div>
        )}

        {/* The rows — main checkout's, from ONE source: the estimate before
            the order exists, the stamped order after (see EmbedSummaryRows). */}
        <div style={{ padding: "10px 16px" }}>
          <EmbedSummaryRows
            lines={summaryLines}
            figures={
              orderFees
                ? embedFiguresFromOrder(
                    orderFees,
                    feeMode,
                    summaryLines.reduce((sum, line) => sum + line.lineCents, 0),
                  )
                : embedFiguresFromEstimate(preOrderEstimate)
            }
            feeMode={feeMode}
            platformFeeRateLabel={platformFeeRateLabel}
            processorFeeRateLabel={processorFeeRateLabel}
            taxRateBps={taxRateBps}
            currency={currency}
            testIdPrefix="embed-summary"
          />
          {(platformFeeRateLabel || processorFeeRateLabel) && (
            <p
              style={{
                margin: "6px 0 0",
                fontSize: 10,
                lineHeight: 1.6,
                color: TEXT_CAPTION,
              }}
            >
              No hidden charges — exact fees shown.
            </p>
          )}
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            borderTop: `2px solid ${BORDER}`,
            background: SURFACE_MUTED,
            padding: "10px 16px",
          }}
        >
          <span
            style={{
              fontSize: 13,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.04em",
              color: TEXT_MUTED,
            }}
          >
            Total
          </span>
          <span
            data-testid="embed-summary-total-value"
            style={{
              fontSize: 15,
              fontWeight: 700,
              fontVariantNumeric: "tabular-nums",
              color: TEXT,
            }}
          >
            {displayTotalLabel}
          </span>
        </div>

        {/* Hold countdown */}
        {countdown && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              borderTop: isHoldExpired
                ? `1px solid ${DANGER}`
                : `1px solid ${BORDER_SUBTLE}`,
              background: isHoldExpired ? DANGER_BG : SURFACE_MUTED,
              padding: "8px 16px",
              fontSize: 13,
            }}
          >
            <Clock
              size={13}
              style={{ color: isHoldExpired ? DANGER : TEXT_CAPTION }}
            />
            {isHoldExpired ? (
              <span style={{ fontWeight: 700, color: DANGER }}>
                Hold expired
              </span>
            ) : (
              <span style={{ color: TEXT_MUTED }}>
                Reserved for{" "}
                <span
                  style={{
                    fontWeight: 700,
                    fontVariantNumeric: "tabular-nums",
                    color: TEXT,
                  }}
                >
                  {countdown}
                </span>
              </span>
            )}
          </div>
        )}
      </div>

      {/* Trust badges */}
      <div
        style={{
          marginTop: 12,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 6,
        }}
      >
        <span style={trustBadgeStyle}>
          <Lock size={10} />
          Secured by Stripe
        </span>
        <span style={trustBadgeStyle}>
          <ShieldCheck size={10} />
          256-bit encryption
        </span>
      </div>
    </div>
  );
}
