"use client";

import { useId, useState, type ReactNode } from "react";
import { ChevronUp, Clock } from "lucide-react";
import { Spinner } from "@th/ui";

import type { EmbedTicketLine, EmbedOrderFees } from "./embed-types";
import type { PreHoldEstimate } from "@/app/events/checkout/[...slug]/_components/pre-hold-rows";
import {
  EmbedSummaryRows,
  embedFiguresFromEstimate,
  embedFiguresFromOrder,
  type EmbedSummaryLine,
} from "./EmbedSummaryRows";
import {
  BRAND_ORANGE,
  BRAND_ORANGE_HOVER,
  STEEL_BLUE,
  TEXT,
  TEXT_MUTED,
  TEXT_ON_BRAND,
  SURFACE_OPAQUE,
  SURFACE_MUTED,
  BORDER,
  BORDER_SUBTLE,
  DANGER,
  DANGER_BG,
  OVERLAY,
} from "./embed-theme";

/** A line's face × qty: its shown amount when it has one (override seats). */
const lineCentsOf = (line: EmbedTicketLine) =>
  line.lineCents ?? line.priceCents * line.qty;

export function EmbedMobileCTABar({
  totalLabel,
  tickets,
  order,
  orderLines = null,
  preOrderEstimate = null,
  currency = "usd",
  platformFeeRateLabel,
  processorFeeRateLabel,
  taxRateBps,
  feeMode = null,
  countdown,
  isExpired,
  onAction,
  actionLabel,
  isPending,
}: {
  totalLabel: string;
  tickets: EmbedTicketLine[];
  order: EmbedOrderFees | null;
  /**
   * The order's lines as the server priced them (`embedLinesFromOrder`),
   * shown instead of `tickets` once `order` is set; null keeps `tickets`.
   */
  orderLines?: EmbedSummaryLine[] | null;
  /**
   * The step-1 estimate whose `totalCents` is `totalLabel` — the tray's rows
   * before the order exists. Null while unknown (lines only).
   */
  preOrderEstimate?: PreHoldEstimate | null;
  /** The rows' currency (they print exact money: "$0.00"). */
  currency?: string;
  platformFeeRateLabel?: string | null;
  processorFeeRateLabel?: string | null;
  taxRateBps?: number | null;
  /**
   * Effective fee mode. PASS_THROUGH renders the processor fee as a charged
   * line (the buyer funds it; it is part of the total label); ABSORB / null
   * keeps it as an "Included" estimate excluded from the total.
   */
  feeMode?: "ABSORB" | "PASS_THROUGH" | null;
  countdown: string | null;
  isExpired: boolean;
  onAction?: () => void;
  /**
   * Button label. May be a node so callers can swap wording responsively
   * (e.g. the checkout step's width-dependent "Continue to payment" /
   * "Continue" pair — the bar row is too narrow for the long form <380px).
   */
  actionLabel?: ReactNode;
  isPending?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  // After the order: the server's lines, so the lines, Subtotal and Discount
  // all come from what was charged (never the cart).
  const lines: EmbedSummaryLine[] =
    order && orderLines
      ? orderLines
      : tickets.map((tt) => ({
          id: tt.id,
          name: tt.name,
          qty: tt.qty,
          lineCents: lineCentsOf(tt),
        }));
  const trayId = useId();

  return (
    <>
      <style>{`
        .embed-cta-bar { display: none !important; }
        .embed-cta-backdrop { display: none !important; }
        @media (max-width: 768px) {
          .embed-cta-backdrop {
            display: block !important;
            position: fixed; inset: 0; z-index: 999;
            background: ${OVERLAY};
            opacity: 0; transition: opacity 0.2s ease;
            pointer-events: none;
          }
          .embed-cta-backdrop.open { opacity: 1; pointer-events: auto; }
          .embed-cta-bar {
            display: flex !important;
            flex-direction: column;
            position: fixed; bottom: 0; left: 0; right: 0;
            z-index: 1000;
            background: ${SURFACE_OPAQUE};
            border-top: 2px solid ${BORDER};
          }
        }
      `}</style>

      <div
        className={`embed-cta-backdrop${expanded ? " open" : ""}`}
        onClick={() => setExpanded(false)}
        aria-hidden
      />

      <div className="embed-cta-bar">
        {/* Expandable tray */}
        {expanded && (
          <div
            id={trayId}
            style={{
              maxHeight: "50vh",
              overflowY: "auto",
              padding: "16px 20px 8px",
              borderBottom: `1px solid ${BORDER_SUBTLE}`,
              display: "flex",
              flexDirection: "column",
              gap: 6,
            }}
          >
            {/* Minimize handle */}
            <button
              type="button"
              onClick={() => setExpanded(false)}
              aria-label="Hide order summary"
              aria-controls={trayId}
              style={{
                all: "unset",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: "2px 0 6px",
              }}
            >
              <div
                style={{
                  width: 36,
                  height: 4,
                  borderRadius: 0,
                  background: BORDER,
                }}
              />
            </button>

            {/* The rows — main checkout's, from the estimate before the
                order exists and the stamped order after (EmbedSummaryRows). */}
            <EmbedSummaryRows
              lines={lines}
              figures={
                order
                  ? embedFiguresFromOrder(
                      order,
                      feeMode,
                      lines.reduce((sum, line) => sum + line.lineCents, 0),
                    )
                  : embedFiguresFromEstimate(preOrderEstimate)
              }
              feeMode={feeMode}
              platformFeeRateLabel={platformFeeRateLabel}
              processorFeeRateLabel={processorFeeRateLabel}
              taxRateBps={taxRateBps}
              currency={currency}
              testIdPrefix="embed-tray"
              fontSize={13}
            />
          </div>
        )}

        {/* Hold countdown */}
        {countdown && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "6px 20px",
              background: isExpired ? DANGER_BG : SURFACE_MUTED,
              borderBottom: `1px solid ${BORDER_SUBTLE}`,
              fontSize: 13,
            }}
          >
            <Clock
              size={13}
              style={{ color: isExpired ? DANGER : TEXT_MUTED }}
            />
            {isExpired ? (
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
                  }}
                >
                  {countdown}
                </span>
              </span>
            )}
          </div>
        )}

        {/* Main bar row */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            padding: "12px 20px",
            paddingBottom: "max(12px, env(safe-area-inset-bottom))",
          }}
        >
          <button
            type="button"
            onClick={() => setExpanded((p) => !p)}
            aria-expanded={expanded}
            aria-controls={trayId}
            aria-label={expanded ? "Hide order summary" : "Show order summary"}
            style={{
              all: "unset",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 6,
              // ≥44px tap target on touch surfaces
              minHeight: 44,
            }}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                  color: STEEL_BLUE,
                }}
              >
                Total
              </span>
              <span
                data-testid="embed-tray-total-value"
                style={{
                  fontSize: 18,
                  fontWeight: 700,
                  fontVariantNumeric: "tabular-nums",
                  color: TEXT,
                }}
              >
                {totalLabel}
              </span>
            </div>
            <ChevronUp
              size={15}
              style={{
                color: STEEL_BLUE,
                transition: "transform 0.2s",
                transform: expanded ? "rotate(180deg)" : "rotate(0deg)",
              }}
            />
          </button>

          {onAction && (
            <button
              type="button"
              onClick={onAction}
              disabled={isPending}
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
                padding: "11px 22px",
                // ≥44px tap target on touch surfaces
                minHeight: 44,
                boxSizing: "border-box",
                fontSize: 14,
                fontWeight: 700,
                fontFamily: "inherit",
                textTransform: "uppercase",
                letterSpacing: "0.04em",
                // Ink on the orange fill — white fails AA (3.16:1).
                color: TEXT_ON_BRAND,
                background: BRAND_ORANGE,
                border: "none",
                borderRadius: 0,
                cursor: isPending ? "not-allowed" : "pointer",
                opacity: isPending ? 0.5 : 1,
                whiteSpace: "nowrap",
                transition: "background 0.15s",
              }}
              onMouseEnter={(e) => {
                if (!isPending)
                  e.currentTarget.style.background = BRAND_ORANGE_HOVER;
              }}
              onMouseLeave={(e) => {
                if (!isPending) e.currentTarget.style.background = BRAND_ORANGE;
              }}
              // Keyboard parity with the hover affordance.
              onFocus={(e) => {
                if (!isPending)
                  e.currentTarget.style.background = BRAND_ORANGE_HOVER;
              }}
              onBlur={(e) => {
                if (!isPending) e.currentTarget.style.background = BRAND_ORANGE;
              }}
            >
              {isPending && (
                <Spinner size="sm" indicatorColor={TEXT_ON_BRAND} />
              )}
              {actionLabel ?? "Continue"}
            </button>
          )}
        </div>
      </div>
    </>
  );
}
