"use client";

import { useState, type Ref } from "react";
import * as React from "react";

import { useTranslations } from "@th/ui";

import { CURRENT_TERMS_VERSION } from "@/lib/legal-constants";
import { DANGER } from "@/lib/design-tokens";

import { ArtistAttributionPicker } from "./ArtistAttributionPicker";
import { CheckoutContactForm } from "./CheckoutContactForm";
import type {
  BillingAddress,
  CheckoutContactFormRef,
  ContactDraft,
} from "./CheckoutContactForm";
import { RefundDisclosure } from "./RefundDisclosure";
import type { TicketTypeSummary } from "./useCheckoutState";
import type { WaiverInfo } from "./Checkout";
import {
  BORDER_SUBTLE,
  DIVIDER_COLOR,
  FG,
  FG_MUTED,
  fgAlpha,
  primaryActionHoverProps,
  primaryActionStyle,
  SURFACE_OVERLAY,
  sectionHeadingStyle,
  sectionNumStyle,
  sectionPaddingStyle,
  FS_CAP,
  FS_SM,
} from "./checkout-tokens";

/**
 * The "Contact information + billing + waiver + terms + Continue to payment"
 * body of the details step. Extracted from `Checkout.tsx` to shrink the
 * Turbopack recompile blast radius — every edit to the parent file used to
 * trigger a recompile of this whole block (and vice-versa).
 */
export type CheckoutDetailsStepProps = {
  eventId: string;
  attributionArtistSelection: string;
  onAttributionArtistChange: (value: string) => void;
  contactFormRef: Ref<CheckoutContactFormRef | null>;
  detailsSectionRef: Ref<HTMLElement | null>;
  defaultName?: string;
  defaultEmail?: string;
  defaultPhone?: string;
  defaultBillingAddress?: BillingAddress;
  isSignedIn: boolean;
  onRequestSignIn: () => void;
  onBillingAddressComplete: (address: BillingAddress) => void;
  onContactDraftChange: (draft: ContactDraft) => void;
  subtotalCents: number;
  waiver?: WaiverInfo | null;
  waiverAccepted: boolean;
  onWaiverAcceptedChange: (next: boolean) => void;
  waiverHighlight: boolean;
  waiverCheckboxRef: Ref<HTMLInputElement | null>;
  displayTicketTypes: TicketTypeSummary[];
  quantities: Record<string, number>;
  refundPolicyAccepted: boolean;
  onRefundPolicyChange: (next: boolean) => void;
  termsAccepted: boolean;
  onTermsChange: (next: boolean) => void;
  setAgreementCheckboxRef: (node: HTMLElement | null) => void;
  isPending: boolean;
  onContinueToPayment: () => void;
};

export const CheckoutDetailsStep = ({
  eventId,
  attributionArtistSelection,
  onAttributionArtistChange,
  contactFormRef,
  detailsSectionRef,
  defaultName,
  defaultEmail,
  defaultPhone,
  defaultBillingAddress,
  isSignedIn,
  onRequestSignIn,
  onBillingAddressComplete,
  onContactDraftChange,
  subtotalCents,
  waiver,
  waiverAccepted,
  onWaiverAcceptedChange,
  waiverHighlight,
  waiverCheckboxRef,
  displayTicketTypes,
  quantities,
  refundPolicyAccepted,
  onRefundPolicyChange,
  termsAccepted,
  onTermsChange,
  setAgreementCheckboxRef,
  isPending,
  onContinueToPayment,
}: CheckoutDetailsStepProps) => {
  const t = useTranslations();

  // Reactive validation snapshot from the contact form (refs aren't reactive),
  // driving the consolidated summary rendered above the CTA below.
  const [validation, setValidation] = useState({
    submitAttempted: false,
    invalidCount: 0,
  });

  // `contactFormRef` is typed as a generic Ref for the prop boundary, but at
  // runtime it's the RefObject created in Checkout.tsx — narrow it so the Next
  // control can call the imperative `focusNextInvalid()`.
  const formRef =
    contactFormRef as React.RefObject<CheckoutContactFormRef | null>;

  // Subtle danger tint derived from the danger token (no hardcoded hex), to
  // match the embed's DANGER_BG intent against the dark checkout surface.
  const dangerBg = `color-mix(in srgb, ${DANGER} 12%, transparent)`;

  return (
    <section
      ref={detailsSectionRef}
      style={sectionPaddingStyle}
      className="checkout-section-padding"
    >
      <h2 style={{ ...sectionHeadingStyle, marginBottom: 4 }}>
        <span style={sectionNumStyle} aria-hidden>
          02
        </span>
        {String(t("checkout.contactDetails"))}
      </h2>
      <p style={{ marginBottom: 20, fontSize: FS_SM, color: FG_MUTED }}>
        {String(t("checkout.contactDetailsDescription"))}
      </p>

      <ArtistAttributionPicker
        eventId={eventId}
        value={attributionArtistSelection}
        onChange={onAttributionArtistChange}
      />

      <CheckoutContactForm
        ref={contactFormRef}
        defaultName={defaultName}
        defaultEmail={defaultEmail}
        defaultPhone={defaultPhone}
        defaultBillingAddress={defaultBillingAddress}
        isSignedIn={isSignedIn}
        onSignIn={onRequestSignIn}
        onBillingAddressComplete={onBillingAddressComplete}
        onDraftChange={onContactDraftChange}
        onValidationStateChange={setValidation}
        hideBillingAddress={subtotalCents === 0}
      />

      {isSignedIn && (
        <p
          style={{
            marginTop: 12,
            fontSize: FS_SM,
            lineHeight: 1.5,
            color: fgAlpha(70),
          }}
        >
          {String(t("checkout.billingDisclosure"))}
        </p>
      )}

      {waiver && (
        <div style={{ marginTop: 24 }}>
          <div
            style={{ height: 1, background: DIVIDER_COLOR, marginBottom: 20 }}
          />
          <h3
            style={{
              margin: "0 0 12px",
              fontSize: FS_SM,
              fontWeight: 700,
              color: FG,
              textTransform: "uppercase",
              letterSpacing: "0.05em",
            }}
          >
            {String(t("checkout.waiverTitle"))}
          </h3>
          <div
            style={{
              maxHeight: 200,
              overflowY: "auto",
              padding: "14px 16px",
              fontSize: FS_SM,
              lineHeight: 1.65,
              color: FG_MUTED,
              background: SURFACE_OVERLAY,
              border: BORDER_SUBTLE,
              borderRadius: 0,
              whiteSpace: "pre-wrap",
              marginBottom: 14,
            }}
          >
            {waiver.body}
          </div>
          <label
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 10,
              cursor: "pointer",
              fontSize: FS_SM,
              lineHeight: 1.5,
              color: FG,
            }}
          >
            <input
              ref={waiverCheckboxRef}
              type="checkbox"
              checked={waiverAccepted}
              onChange={(e) => onWaiverAcceptedChange(e.target.checked)}
              className={waiverHighlight ? "th-terms-pulse" : undefined}
              style={{
                marginTop: 3,
                width: 18,
                height: 18,
                accentColor: "var(--success, #166534)",
                cursor: "pointer",
                flexShrink: 0,
              }}
            />
            <span>{String(t("checkout.waiverAcceptLabel"))}</span>
          </label>
        </div>
      )}

      <div style={{ marginTop: 24 }}>
        <RefundDisclosure
          id="checkout-refund-policy-accept"
          cart={displayTicketTypes.map((tt) => ({
            id: tt.id,
            quantity: quantities[tt.id] ?? 0,
            pricingMode: tt.pricingMode,
            priceCents: tt.priceCents,
          }))}
          refundPolicyHref="/help/buying-tickets/refunds-and-cancellations"
          checked={refundPolicyAccepted}
          onCheckedChange={onRefundPolicyChange}
          termsChecked={termsAccepted}
          onTermsCheckedChange={onTermsChange}
          termsHref={`/terms?v=${CURRENT_TERMS_VERSION}`}
          checkboxRef={setAgreementCheckboxRef}
        />
      </div>

      {/* Validation summary — appears once the buyer has tried to submit and
          contact/billing fields are still missing. Consolidates the count and,
          when more than one field is outstanding, offers a "Next field" jump
          that walks focus through every offender. preventDefault on mousedown
          keeps focus on the current field so the jump anchors off where the
          buyer actually is. (The ToS/refund/waiver gates stay on their own
          toast nudges — they're deliberately not folded in here.) */}
      {validation.submitAttempted && validation.invalidCount > 0 && (
        <div
          role="alert"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            padding: "10px 12px",
            marginTop: 16,
            background: dangerBg,
            border: `1px solid ${DANGER}`,
            borderRadius: 0,
          }}
        >
          <span style={{ fontSize: FS_CAP, fontWeight: 600, color: DANGER }}>
            {String(
              t("checkout.fieldsNeedAttention", {
                count: validation.invalidCount,
              }),
            )}
          </span>
          {validation.invalidCount > 1 && (
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => formRef.current?.focusNextInvalid()}
              style={{
                flexShrink: 0,
                background: "transparent",
                border: "none",
                padding: 0,
                cursor: "pointer",
                fontSize: FS_CAP,
                fontWeight: 700,
                color: DANGER,
                textDecoration: "underline",
                textUnderlineOffset: 2,
              }}
            >
              {String(t("checkout.nextField"))} →
            </button>
          )}
        </div>
      )}

      {/* Inline CTA — visible at EVERY width. It used to be hidden below
          900px because the fixed MobileCTABar carried the same action under
          the same accessible name (an SR/keyboard trap). That bar now stands
          down wherever the shell's ConsumerBottomNav renders, and the bar's
          own centre slot uses the shorter "Continue", so the two no longer
          collide. Keeping this one on mobile also means the step is never
          advanced solely from a 64px square. */}
      <button
        data-testid="checkout-continue-btn"
        type="button"
        className="checkout-inline-continue checkout-primary-action"
        onClick={onContinueToPayment}
        disabled={isPending}
        style={primaryActionStyle(isPending, { marginTop: 16 })}
        {...primaryActionHoverProps(isPending)}
      >
        {isPending
          ? String(t("checkout.processing"))
          : subtotalCents === 0
            ? String(t("checkout.confirmFreeTickets") ?? "Get free tickets")
            : String(t("checkout.continueToPayment"))}
      </button>
    </section>
  );
};

CheckoutDetailsStep.displayName = "CheckoutDetailsStep";
