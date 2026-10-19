"use client";

import { useTranslations } from "@th/ui";

import {
  FG,
  FG_MUTED,
  sectionHeadingStyle,
  sectionNumStyle,
  sectionPaddingStyle,
  FS_CAP,
  FS_SM,
} from "./checkout-tokens";

/**
 * Compact "01. SELECT YOUR TICKETS" header rendered at the top of both the
 * details and payment steps. Pulled out of `Checkout.tsx` so the inline
 * markup wasn't duplicated word-for-word in two places and so Turbopack's
 * recompile blast radius shrinks when the parent file changes.
 */
export const CheckoutTicketSummaryHeader = ({
  selectedQty,
  onChangeTickets,
  changeTicketsDisabled = false,
}: {
  selectedQty: number;
  /** Tap target for "Change tickets" — opens the hold-release warning dialog. */
  onChangeTickets: () => void;
  /**
   * No way back right now: a Stripe confirm is submitting, or payment is
   * confirming — "Change tickets" would release the order being paid.
   */
  changeTicketsDisabled?: boolean;
}) => {
  const t = useTranslations();
  return (
    <section
      style={sectionPaddingStyle}
      className="checkout-section-padding checkout-ticket-summary-padding"
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <div style={{ minWidth: 0, flex: 1 }}>
          <h2
            style={{
              ...sectionHeadingStyle,
              marginBottom: 2,
              // Wraps instead of truncating: at 320px beside "Change tickets"
              // a one-line heading clipped to "SELECT YOUR TI".
              overflowWrap: "anywhere",
            }}
          >
            <span style={sectionNumStyle} aria-hidden>
              01
            </span>
            {String(t("checkout.selectYourTickets"))}
          </h2>
          <p style={{ margin: 0, fontSize: FS_SM, color: FG_MUTED }}>
            {String(t("checkout.nTickets", { count: selectedQty }))}
          </p>
        </div>
        <button
          type="button"
          onClick={changeTicketsDisabled ? undefined : onChangeTickets}
          disabled={changeTicketsDisabled}
          data-testid="checkout-change-tickets"
          style={{
            padding: "6px 12px",
            fontSize: FS_CAP,
            fontWeight: 700,
            fontFamily: "inherit",
            color: FG_MUTED,
            background: "rgba(33,28,22,0.06)",
            border: "1px solid var(--borderColorSoft, rgba(33,28,22,0.3))",
            borderRadius: 0,
            cursor: changeTicketsDisabled ? "not-allowed" : "pointer",
            opacity: changeTicketsDisabled ? 0.45 : 1,
            transition: "background 0.15s, color 0.15s",
            whiteSpace: "nowrap",
            flexShrink: 0,
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background =
              "rgba(33,28,22,0.10)";
            (e.currentTarget as HTMLButtonElement).style.color = FG;
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background =
              "rgba(33,28,22,0.06)";
            (e.currentTarget as HTMLButtonElement).style.color = FG_MUTED;
          }}
          onFocus={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background =
              "rgba(33,28,22,0.10)";
            (e.currentTarget as HTMLButtonElement).style.color = FG;
          }}
          onBlur={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background =
              "rgba(33,28,22,0.06)";
            (e.currentTarget as HTMLButtonElement).style.color = FG_MUTED;
          }}
        >
          {String(t("checkout.changeTickets"))}
        </button>
      </div>
    </section>
  );
};

CheckoutTicketSummaryHeader.displayName = "CheckoutTicketSummaryHeader";
