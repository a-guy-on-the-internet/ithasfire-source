"use client";

import type { Ref } from "react";
import { Info } from "lucide-react";
import { Checkbox, useTranslations, useFormatters } from "@th/ui";
import {
  FG as fg,
  fgAlpha,
  FS_CAP,
  FS_SM,
} from "./checkout-tokens";

// ─────────────────────────────────────────────────────────────────────────────
// RefundDisclosure
//
// Pre-purchase refund disclosure rendered above the pay button. Required by
// launch backlog 2.1 and FTC all-in-pricing guidance: the non-refundable
// platform-fee component must be disclosed before charge, and donation
// purchases must be flagged as non-refundable in their own right.
//
// The text is computed from the cart's ticket-type mix, NOT from event-level
// flags — that way a mixed cart (paid + donation) gets both disclosures.
// ─────────────────────────────────────────────────────────────────────────────

export type RefundDisclosureCartLine = {
  /** Stable id, just for keying / diffing */
  id: string;
  /** Quantity the buyer chose for this ticket type */
  quantity: number;
  /** FIXED = standard paid ticket; ADJUSTABLE = donation / pay-what-you-want */
  pricingMode?: "FIXED" | "ADJUSTABLE";
  /** Set price in cents; 0 means free RSVP */
  priceCents: number;
};

export type RefundDisclosureProps = {
  cart: RefundDisclosureCartLine[];
  /** Optional href to the organizer's refund policy / help page */
  refundPolicyHref?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  checkboxRef?: Ref<HTMLElement>;
  termsChecked?: boolean;
  onTermsCheckedChange?: (checked: boolean) => void;
  termsHref?: string;
  disabled?: boolean;
  id?: string;
  required?: boolean;
  textColor?: string;
  borderColor?: string;
  backgroundColor?: string;
  iconColor?: string;
  linkColor?: string;
  highlight?: boolean;
  /** RESALE has no platform fee, so its paid-ticket sentence leaves it out. */
  sale?: "PRIMARY" | "RESALE";
};

type CartShape = {
  hasPaid: boolean;
  hasDonation: boolean;
  hasFree: boolean;
};

function summarizeCart(cart: RefundDisclosureCartLine[]): CartShape {
  const out: CartShape = { hasPaid: false, hasDonation: false, hasFree: false };
  for (const line of cart) {
    if (line.quantity <= 0) continue;
    if (line.pricingMode === "ADJUSTABLE") {
      out.hasDonation = true;
      continue;
    }
    if (line.priceCents === 0) {
      out.hasFree = true;
      continue;
    }
    out.hasPaid = true;
  }
  return out;
}

export const RefundDisclosure = ({
  cart,
  refundPolicyHref,
  checked,
  onCheckedChange,
  checkboxRef,
  termsChecked,
  onTermsCheckedChange,
  termsHref,
  disabled = false,
  id = "refund-policy-accept",
  required = true,
  textColor = fg,
  borderColor = fgAlpha(10),
  backgroundColor = fgAlpha(2.5),
  iconColor = fgAlpha(60),
  linkColor = "rgba(147,197,253,0.9)",
  highlight = false,
  sale = "PRIMARY",
}: RefundDisclosureProps) => {
  const t = useTranslations();
  const fmt = useFormatters();
  // Resolve a message key with an inline English fallback. The translator
  // returns the raw key when a message is missing, so probe getRawMessage
  // first. Used for the updated refund-policy wording (see report for keys).
  const tx = (key: string, fallback: string): string => {
    const raw = fmt.getRawMessage(key);
    return raw ? String(t(key)) : fallback;
  };
  const shape = summarizeCart(cart);
  const descriptionId = `${id}-description`;
  const labelId = `${id}-label`;
  const hasTermsAgreement =
    typeof termsChecked === "boolean" &&
    Boolean(onTermsCheckedChange) &&
    Boolean(termsHref);
  const agreementChecked = hasTermsAgreement ? checked && termsChecked : checked;

  const handleAgreementChange = (nextChecked: boolean) => {
    onCheckedChange(nextChecked);
    if (hasTermsAgreement) onTermsCheckedChange?.(nextChecked);
  };

  // Nothing in cart → render nothing rather than a hollow disclosure
  if (!shape.hasPaid && !shape.hasDonation && !shape.hasFree) return null;

  const lines: string[] = [];

  if (shape.hasPaid) {
    if (sale === "RESALE") {
      lines.push(
        refundPolicyHref
          ? tx(
              "checkout.refundDisclosureResalePaidWithPolicy",
              "Refundable per the organizer's refund policy. Your ticket price and tax are refundable. Only the payment processing fee isn't, because our payment processor keeps it.",
            )
          : tx(
              "checkout.refundDisclosureResalePaidFallback",
              "Refundable only if the organizer has stated a refund policy or the event is cancelled. Your ticket price and tax are refundable. Only the payment processing fee isn't, because our payment processor keeps it.",
            ),
      );
    } else {
      lines.push(
        refundPolicyHref
          ? tx(
              "checkout.refundDisclosurePaidWithPolicy",
              "Paid tickets are refundable per the organizer's refund policy. Your ticket price, tax, and the platform fee are all refundable; only the payment processing fee is non-refundable, because our payment processor retains it even on a refund.",
            )
          : tx(
              "checkout.refundDisclosurePaidFallback",
              "Paid tickets are refundable only if the organizer has stated a refund policy or the event is cancelled. Your ticket price, tax, and the platform fee are all refundable; only the payment processing fee is non-refundable, because our payment processor retains it even on a refund.",
            ),
      );
    }
  }

  if (shape.hasDonation) {
    lines.push(String(t("checkout.refundDisclosureDonation")));
  }

  if (shape.hasFree && !shape.hasPaid && !shape.hasDonation) {
    lines.push(
      refundPolicyHref
        ? String(t("checkout.refundDisclosureFreeWithPolicy"))
        : String(t("checkout.refundDisclosureFreeFallback")),
    );
  }

  if (shape.hasPaid && shape.hasFree) {
    // Mixed paid + free: the free tickets are implied to be non-refundable
    // because no charge occurs. No extra line needed.
  }

  return (
    <div
      role="group"
      aria-labelledby={labelId}
      aria-describedby={descriptionId}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
        padding: "12px 14px",
        marginBottom: 12,
        border: `1px solid ${highlight ? "rgba(251,191,36,0.85)" : borderColor}`,
        background: highlight ? "rgba(251,191,36,0.12)" : backgroundColor,
        borderRadius: 0,
      }}
    >
      <div
        style={{
          color: textColor,
          fontSize: FS_SM,
          fontWeight: 700,
          lineHeight: 1.5,
        }}
      >
        <Checkbox
          ref={checkboxRef}
          id={id}
          checked={agreementChecked}
          onCheckedChange={(value) =>
            handleAgreementChange(value === true)
          }
          disabled={disabled}
          required={required}
          aria-labelledby={labelId}
          aria-describedby={descriptionId}
          label={
            <span id={labelId}>
              {hasTermsAgreement && termsHref ? (
                <>
                  {String(t("checkout.termsAndRefundAcceptPrefix"))}{" "}
                  <a
                    href={termsHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    style={{
                      color: linkColor,
                      textDecoration: "underline",
                      textUnderlineOffset: 2,
                    }}
                  >
                    {String(t("checkout.termsOfService"))}
                  </a>{" "}
                  {String(t("checkout.termsAndRefundAcceptSuffix"))}.
                </>
              ) : (
                String(t("checkout.refundPolicyAcceptLabel"))
              )}
            </span>
          }
        />
      </div>
      <div
        id={descriptionId}
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 10,
          minWidth: 0,
        }}
      >
        <Info
          size={14}
          aria-hidden
          style={{ flexShrink: 0, marginTop: 2, color: iconColor }}
        />
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 4,
            minWidth: 0,
          }}
        >
          {lines.map((line, i) => (
            <p
              key={i}
              style={{
                margin: 0,
                fontSize: FS_CAP,
                lineHeight: 1.5,
                color: textColor,
              }}
            >
              {line}
            </p>
          ))}
          {refundPolicyHref && (
            <a
              href={refundPolicyHref}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                fontSize: FS_CAP,
                color: linkColor,
                textDecoration: "underline",
                textUnderlineOffset: 2,
                marginTop: 2,
              }}
            >
              {String(t("checkout.refundPolicySeeFull"))}
            </a>
          )}
        </div>
      </div>
    </div>
  );
};

RefundDisclosure.displayName = "RefundDisclosure";
