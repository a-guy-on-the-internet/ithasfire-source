"use client";

import { ArrowLeft } from "lucide-react";
import { useTranslations } from "@th/ui";

import {
  SURFACE,
  TEXT_MUTED,
  backButtonStyle,
  headerBarStyle,
  headerTitleStyle,
} from "./embed-theme";

/** The line that says why Back is locked while a payment confirms. */
const BACK_LOCKED_NOTE_ID = "embed-checkout-back-locked";
/** Why Back is locked while the order is created (read out, not shown). */
const BACK_LOCKED_CREATING_ID = "embed-checkout-back-creating";
/** One line of that text (12px at 1.5) plus its 8px padding above and below. */
const BACK_LOCKED_NOTE_HEIGHT = 34;

/**
 * The checkout's header: Back and the title.
 *
 * Back is locked while an order is being created, while a payment is
 * confirming, and while the server is asked about an order Stripe says is
 * paid. Back + a changed cart leaves that order behind, and one landing after
 * that would be an order (or a charge) the buyer cannot see. Locked with
 * `aria-disabled` and a no-op click, not `disabled`, so the button stays
 * focusable and its reason is announced.
 *
 * The reason sits in a live region that is always in the page and empty until
 * a payment starts: a screen reader announces text that arrives in a region
 * it already knows, not a region that arrives with its text. On the payment
 * step the region keeps its one line of height while empty, so the form below
 * does not move when a payment starts or ends.
 *
 * While the order is being created the reason is not printed (the Continue
 * button already shows it working, and a line appearing above the form would
 * push it down): it is the button's description, in an element that is
 * `hidden` and still read by `aria-describedby`.
 */
export function EmbedCheckoutHeader({
  onBack,
  isCreating,
  isPaying,
  isConfirming = false,
  onPaymentStep,
}: {
  onBack: () => void;
  /** `createGuestCheckout` is in flight. */
  isCreating: boolean;
  /** A payment confirm is in flight with Stripe. */
  isPaying: boolean;
  /** The server is being asked about the order after Stripe said "paid". */
  isConfirming?: boolean;
  /** The payment form is showing (an order exists for this cart). */
  onPaymentStep: boolean;
}) {
  const t = useTranslations();
  const locked = isCreating || isPaying || isConfirming;
  const noteShown = isPaying || isConfirming;
  const reserveNoteHeight = onPaymentStep || noteShown;
  return (
    <>
      <div style={headerBarStyle}>
        <button
          type="button"
          onClick={locked ? undefined : onBack}
          aria-disabled={locked || undefined}
          aria-describedby={
            noteShown
              ? BACK_LOCKED_NOTE_ID
              : isCreating
                ? BACK_LOCKED_CREATING_ID
                : undefined
          }
          aria-label={String(t("common.back"))}
          style={
            locked
              ? { ...backButtonStyle, cursor: "not-allowed", opacity: 0.4 }
              : backButtonStyle
          }
        >
          <ArrowLeft size={16} aria-hidden />
        </button>
        <h2 style={headerTitleStyle}>Checkout</h2>
        <span id={BACK_LOCKED_CREATING_ID} hidden>
          {String(t("checkout.embedBackLockedCreating"))}
        </span>
      </div>
      <p
        id={BACK_LOCKED_NOTE_ID}
        role="status"
        style={{
          margin: 0,
          boxSizing: "border-box",
          minHeight: reserveNoteHeight ? BACK_LOCKED_NOTE_HEIGHT : 0,
          padding: reserveNoteHeight ? "8px 16px" : 0,
          fontSize: 12,
          lineHeight: 1.5,
          color: TEXT_MUTED,
          background: SURFACE,
        }}
      >
        {isConfirming
          ? String(t("checkout.embedBackLockedConfirming"))
          : isPaying
            ? String(t("checkout.embedBackLockedPaying"))
            : null}
      </p>
    </>
  );
}
