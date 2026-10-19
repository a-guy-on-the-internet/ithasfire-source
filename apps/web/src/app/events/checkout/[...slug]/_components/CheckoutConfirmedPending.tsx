"use client";

import { useTranslations } from "@th/ui";

import { FG as fg, FG_MUTED as fgMuted, FS_BODY, FS_SM } from "./checkout-tokens";
import type { ConfirmedPayment } from "./confirmed-payment";

/**
 * A paid (or being-paid) checkout with no figures to show yet — and so
 * showing NONE, never an estimate:
 *  - "confirming": a Stripe redirect return being verified;
 *  - "loading": confirmed, the order's totals on their way (neutral copy —
 *    a free claim lands here too, with no payment);
 *  - "unavailable": confirmed, but the order could not be loaded;
 * and the terminal "our confirm failed" outcomes (UnconfirmedPaymentOutcome):
 *  - "received": Stripe took the payment — the webhook finishes the order;
 *  - "submitted": an ACH-style payment still processing — we'll email;
 *  - "unverified": nobody could tell — check My tickets before retrying;
 *  - "wrong-account": paid from another account — sign into that one.
 * And, for a confirmation RESTORED from the URL:
 *  - "restore-unavailable": the order could not be checked just now (a
 *    transient failure). Neutral copy — the id is unverified, so nothing
 *    here says it was paid — with a retry.
 * Every status past "loading" links to the buyer's tickets.
 */
const TERMINAL_COPY = {
  unavailable: "checkout.confirmedOrderUnavailable",
  received: "checkout.paymentReceivedFinishing",
  submitted: "checkout.paymentSubmittedFinishing",
  unverified: "checkout.paymentUnverified",
  "wrong-account": "checkout.paymentWrongAccount",
} as const;

export const CheckoutConfirmedPending = ({
  status,
  orderId,
  onRetry,
  retrying = false,
  payment = "unknown",
}: {
  status:
    | "confirming"
    | "loading"
    | "unavailable"
    | "received"
    | "submitted"
    | "unverified"
    | "wrong-account"
    | "restore-unavailable";
  orderId: string | null;
  /** "restore-unavailable" only: ask for the order again. */
  onRetry?: () => void;
  /** A retry is in flight. */
  retrying?: boolean;
  /**
   * "unavailable" only: what the page knows of the payment. Its copy says the
   * payment went through, true only when `paid`; a bank debit still
   * `processing` gets the "submitted, takes a few days" copy, and `unknown`
   * the "couldn't confirm your payment" copy (owner, 2026-10-14). Left out,
   * it is `unknown`: nothing defaults to "your payment went through".
   */
  payment?: ConfirmedPayment;
}) => {
  const t = useTranslations();
  if (status === "restore-unavailable") {
    return (
      <section
        data-testid="checkout-confirmed-pending"
        style={{ padding: "32px 24px", display: "flex", flexDirection: "column", gap: 12 }}
      >
        <p role="alert" style={{ margin: 0, fontSize: FS_BODY, color: fg }}>
          {String(t("checkout.restoredOrderLoadFailed"))}
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "8px 16px" }}>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              disabled={retrying}
              style={{
                fontSize: FS_SM,
                fontWeight: 700,
                color: fg,
                background: "none",
                border: "1px solid currentColor",
                padding: "6px 12px",
                cursor: retrying ? "default" : "pointer",
              }}
            >
              {String(
                t(
                  retrying
                    ? "checkout.restoredOrderRetrying"
                    : "checkout.restoredOrderRetry",
                ),
              )}
            </button>
          )}
          {/* Not /my-tickets/<id>: the id is unverified. */}
          <a
            href="/my-tickets"
            style={{ fontSize: FS_SM, fontWeight: 700, color: fgMuted }}
          >
            {String(t("checkout.restoredOrderMyTickets"))}
          </a>
        </div>
      </section>
    );
  }
  return (
    <section
      data-testid="checkout-confirmed-pending"
      style={{ padding: "32px 24px", display: "flex", flexDirection: "column", gap: 12 }}
    >
      {status === "loading" || status === "confirming" ? (
        <p role="status" style={{ margin: 0, fontSize: FS_BODY, color: fg }}>
          {String(
            t(
              status === "confirming"
                ? "checkout.redirectConfirming"
                : "checkout.confirmedOrderLoading",
            ),
          )}
        </p>
      ) : (
        <>
          <p role="alert" style={{ margin: 0, fontSize: FS_BODY, color: fg }}>
            {String(
              t(
                status === "unavailable" && payment !== "paid"
                  ? payment === "processing"
                    ? TERMINAL_COPY.submitted
                    : TERMINAL_COPY.unverified
                  : TERMINAL_COPY[status],
              ),
            )}
          </p>
          <a
            href={orderId ? `/my-tickets/${orderId}` : "/my-tickets"}
            style={{ fontSize: FS_SM, fontWeight: 700, color: fgMuted }}
          >
            {String(t("confirmation.viewTickets"))}
          </a>
        </>
      )}
    </section>
  );
};
