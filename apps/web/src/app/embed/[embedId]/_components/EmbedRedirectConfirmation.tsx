"use client";

import { CheckCircle, Clock } from "lucide-react";
import { useTranslations } from "@th/ui";
import { formatOrderCode } from "@th/types/order-identifier";

import { formatCurrencyExact } from "./embed-helpers";
import {
  BORDER_SUBTLE,
  SUCCESS,
  SUCCESS_BG,
  TEXT,
  TEXT_MUTED,
  WARNING,
  WARNING_BG,
  primaryButtonStyle,
} from "./embed-theme";
import { EmbedTickets } from "./EmbedTickets";
import type { EmbedRedirectPayment } from "./useEmbedRedirectReturn";

/** The redirect return's "paid" copy: English literals, as it was written. */
const RECEIVED_COPY = {
  title: "Payment received",
  body: "Your tickets are on their way to the email you used at checkout.",
};

/**
 * The confirmation the widget shows without `EmbedConfirmation`, always on
 * the SERVER's answer about the order:
 *
 * - After a payment that left the page and came back (a 3-D Secure or
 *   bank authentication redirect; Amazon Pay and Cash App Pay also did until
 *   the owner turned them off in Stripe on 2026-10-13). The return is a
 *   fresh iframe load: the cart, the buyer's email and the event are
 *   gone. So this says the status and the amount Stripe.js read, and never
 *   "Tickets sent to" an address it does not have.
 * - For a payment that is still clearing with the buyer's bank
 *   ("processing"), on a redirect return or on the payment step. The order
 *   is not confirmed and no ticket has been sent, so it says neither: the
 *   payment is with the bank, the tickets are emailed when it clears, and
 *   there is nothing else to do.
 *
 * An in-page purchase the server confirmed keeps the full
 * `EmbedConfirmation`.
 *
 * A confirmed redirect payment shows the order's tickets and its order code
 * when the server sent them (`tickets`, `orderId`). The clearing variant
 * shows neither: no ticket exists for an order that is not confirmed.
 */
export function EmbedRedirectConfirmation({
  payment,
  onDone,
}: {
  payment: Pick<EmbedRedirectPayment, "status" | "amountCents" | "currency"> &
    Partial<Pick<EmbedRedirectPayment, "orderId" | "tickets">>;
  onDone: () => void;
}) {
  const t = useTranslations();
  const received = payment.status === "succeeded";
  const { title, body } = received
    ? RECEIVED_COPY
    : {
        title: String(t("checkout.embedPaymentClearingTitle")),
        body: String(t("checkout.embedPaymentClearingBody")),
      };
  const accent = received ? SUCCESS : WARNING;
  const tickets = received ? (payment.tickets ?? []) : [];
  const orderCode =
    received && payment.orderId ? formatOrderCode(payment.orderId) : null;
  const amount =
    payment.amountCents !== null && payment.currency
      ? formatCurrencyExact(payment.amountCents, payment.currency)
      : null;

  return (
    <div
      className="th-embed-fade-in"
      style={{
        display: "flex",
        minHeight: 260,
        flexDirection: "column",
        justifyContent: "center",
        gap: 16,
        padding: "40px 24px",
      }}
    >
      <div
        role="status"
        style={{ display: "flex", alignItems: "center", gap: 14 }}
      >
        <div
          aria-hidden="true"
          style={{
            display: "flex",
            height: 56,
            width: 56,
            flexShrink: 0,
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 0,
            background: received ? SUCCESS_BG : WARNING_BG,
            border: `2px solid ${accent}`,
          }}
        >
          {received ? (
            <CheckCircle size={28} style={{ color: accent }} />
          ) : (
            <Clock size={28} style={{ color: accent }} />
          )}
        </div>
        <div
          style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}
        >
          <h3
            style={{
              margin: 0,
              fontSize: 18,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.02em",
              color: TEXT,
              overflowWrap: "anywhere",
            }}
          >
            {title}
          </h3>
          <p
            style={{ margin: 0, fontSize: 13, lineHeight: 1.6, color: TEXT_MUTED }}
          >
            {body}
          </p>
        </div>
      </div>

      <EmbedTickets tickets={tickets} />

      {(amount || orderCode) && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            border: `1px solid ${BORDER_SUBTLE}`,
            padding: "12px 14px",
            fontSize: 13,
            color: TEXT,
          }}
        >
          {orderCode && (
            <div
              style={{ display: "flex", justifyContent: "space-between", gap: 12 }}
            >
              <span>{String(t("checkout.embedTicketsOrderLabel"))}</span>
              <span
                data-testid="embed-order-code"
                style={{
                  fontFamily: "var(--font-mono, monospace)",
                  fontWeight: 700,
                  userSelect: "all",
                }}
              >
                #{orderCode}
              </span>
            </div>
          )}
          {amount && (
            <div
              style={{ display: "flex", justifyContent: "space-between", gap: 12 }}
            >
              <span>{received ? "Paid" : "Amount"}</span>
              <span
                data-testid="embed-redirect-amount"
                style={{ fontWeight: 700, fontVariantNumeric: "tabular-nums" }}
              >
                {amount}
              </span>
            </div>
          )}
        </div>
      )}

      <button type="button" onClick={onDone} style={primaryButtonStyle}>
        Done
      </button>
    </div>
  );
}
