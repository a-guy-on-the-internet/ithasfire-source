"use client";

import { useTranslations } from "@th/ui";

import { FG as fg, FG_MUTED as fgMuted, FS_BODY, FS_SM } from "./checkout-tokens";

/**
 * Above the ticket picker when a confirmed URL (`?step=confirmed&order=`)
 * names an order this page can't show: not this buyer's, not this event's,
 * not a confirmed status, signed out, or a failed load. The buyer's tickets,
 * if any, are in My tickets; the picker below starts empty.
 */
export const CheckoutRestoreNotice = () => {
  const t = useTranslations();
  return (
    <div
      role="status"
      data-testid="checkout-restore-notice"
      style={{
        padding: "12px 16px",
        display: "flex",
        flexWrap: "wrap",
        alignItems: "baseline",
        gap: "4px 12px",
      }}
    >
      <p style={{ margin: 0, fontSize: FS_BODY, color: fg }}>
        {String(t("checkout.restoredOrderUnavailable"))}
      </p>
      <a
        href="/my-tickets"
        style={{ fontSize: FS_SM, fontWeight: 700, color: fgMuted }}
      >
        {String(t("checkout.restoredOrderMyTickets"))}
      </a>
    </div>
  );
};
