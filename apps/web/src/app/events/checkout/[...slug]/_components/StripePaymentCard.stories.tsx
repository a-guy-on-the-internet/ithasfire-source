import type { Meta, StoryObj } from "@storybook/react";
import type { Decorator } from "@storybook/react";
import { useState } from "react";

import { TranslationProvider, Spinner } from "@th/ui";
import type { Messages } from "@th/ui";

import enPackage from "@th/locale/messages/en.json";
import enApp from "../../../../../i18n/messages/en";

// ─────────────────────────────────────────────────────────────────────────────
// Translation helper (same pattern as EventContent.stories)
// ─────────────────────────────────────────────────────────────────────────────

const mergeCatalogs = (base: Messages, override: Messages): Messages => {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = result[key];
    if (
      typeof value === "object" &&
      value !== null &&
      typeof existing === "object" &&
      existing !== null
    ) {
      result[key] = mergeCatalogs(existing as Messages, value as Messages);
    } else {
      result[key] = value;
    }
  }
  return result as Messages;
};

const messages = mergeCatalogs(enPackage as unknown as Messages, enApp);

const withTranslations: Decorator = (Story) => (
  <TranslationProvider locale="en" messages={messages}>
    <Story />
  </TranslationProvider>
);

// ─────────────────────────────────────────────────────────────────────────────
// Visual mock — renders the exact same HTML/CSS as StripePaymentCard
// but uses plain <input> elements instead of Stripe iframes so the
// story works without a backend-generated clientSecret.
// ─────────────────────────────────────────────────────────────────────────────

type MockCardProps = {
  /** Simulate an inline card error */
  cardError?: string;
  /** Simulate the "processing" spinner state */
  isSubmitting?: boolean;
};

function StripePaymentCardMock({
  cardError: initialError,
  isSubmitting: initialSubmitting = false,
}: MockCardProps) {
  const [isSubmitting, setIsSubmitting] = useState(initialSubmitting);
  const [cardError, setCardError] = useState<string | null>(
    initialError ?? null,
  );

  const inputStyle: React.CSSProperties = {
    borderRadius: 0,
    border: "1px solid rgba(237,237,237,0.12)",
    background: "var(--background)",
    padding: "12px 14px",
    fontSize: 15,
    width: "100%",
    fontFamily: "system-ui, -apple-system, sans-serif",
    letterSpacing: "0.01em",
    color: "inherit",
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div
        style={{
          overflow: "hidden",
          borderRadius: 0,
          border: "1px solid rgba(237,237,237,0.07)",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            borderBottom: "1px solid rgba(237,237,237,0.06)",
            background: "rgba(237,237,237,0.02)",
            padding: "14px 20px",
          }}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ color: "rgba(237,237,237,0.40)" }}
          >
            <rect width="20" height="14" x="2" y="5" rx="2" />
            <line x1="2" x2="22" y1="10" y2="10" />
          </svg>
          <h2
            style={{
              fontSize: 14,
              fontWeight: 700,
              color: "var(--foreground)",
            }}
          >
            Payment
          </h2>
        </div>

        {/* Payment form */}
        <div style={{ padding: 20 }}>
          <form
            style={{ display: "flex", flexDirection: "column", gap: 16 }}
            onSubmit={(e) => {
              e.preventDefault();
              setIsSubmitting(true);
              setCardError(null);
              setTimeout(() => setIsSubmitting(false), 2000);
            }}
          >
            {/* Card number */}
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <label
                style={{
                  fontSize: 12,
                  fontWeight: 500,
                  color: "rgba(237,237,237,0.50)",
                }}
              >
                Card number
              </label>
              <div style={{ position: "relative" }}>
                <input
                  type="text"
                  placeholder="1234 1234 1234 1234"
                  maxLength={19}
                  style={{ ...inputStyle, paddingRight: 56 }}
                />
                {/* Card brand icons */}
                <div
                  style={{
                    pointerEvents: "none",
                    position: "absolute",
                    right: 12,
                    top: "50%",
                    display: "flex",
                    transform: "translateY(-50%)",
                    alignItems: "center",
                    gap: 4,
                  }}
                >
                  <svg
                    width="24"
                    height="16"
                    viewBox="0 0 24 16"
                    fill="none"
                    style={{ opacity: 0.25 }}
                  >
                    <rect width="24" height="16" rx="2" fill="#1A1F36" />
                    <circle cx="9" cy="8" r="5" fill="#EB001B" opacity="0.8" />
                    <circle cx="15" cy="8" r="5" fill="#F79E1B" opacity="0.8" />
                  </svg>
                </div>
              </div>
            </div>

            {/* Expiry + CVC row */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 12,
              }}
            >
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <label
                  style={{
                    fontSize: 12,
                    fontWeight: 500,
                    color: "rgba(237,237,237,0.50)",
                  }}
                >
                  Expiry
                </label>
                <input
                  type="text"
                  placeholder="MM / YY"
                  maxLength={7}
                  style={inputStyle}
                />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <label
                  style={{
                    fontSize: 12,
                    fontWeight: 500,
                    color: "rgba(237,237,237,0.50)",
                  }}
                >
                  CVC
                </label>
                <input
                  type="text"
                  placeholder="CVC"
                  maxLength={4}
                  style={inputStyle}
                />
              </div>
            </div>

            {/* Inline error */}
            {cardError && (
              <p style={{ fontSize: 12, fontWeight: 500, color: "#dc2626" }}>
                {cardError}
              </p>
            )}

            {/* Submit */}
            <button
              type="submit"
              disabled={isSubmitting}
              style={{
                position: "relative",
                marginTop: 4,
                width: "100%",
                overflow: "hidden",
                borderRadius: 0,
                background: "var(--foreground)",
                padding: "14px 24px",
                fontSize: 15,
                fontWeight: 700,
                color: "var(--background)",
                border: "none",
                cursor: isSubmitting ? "default" : "pointer",
                opacity: isSubmitting ? 0.35 : 1,
              }}
            >
              {isSubmitting ? (
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 8,
                  }}
                >
                  <Spinner size="sm" indicatorColor="var(--background)" />
                  Processing...
                </span>
              ) : (
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 8,
                  }}
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10" />
                    <path d="m9 12 2 2 4-4" />
                  </svg>
                  Pay now
                </span>
              )}
            </button>
          </form>
        </div>
      </div>

      {/* Trust bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 16,
          fontSize: 12,
          color: "rgba(237,237,237,0.35)",
        }}
      >
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10" />
            <path d="m9 12 2 2 4-4" />
          </svg>
          256-bit encryption
        </span>
        <span
          style={{ height: 12, width: 1, background: "rgba(237,237,237,0.15)" }}
        />
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
            <polyline points="22 4 12 14.01 9 11.01" />
          </svg>
          Instant confirmation
        </span>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Meta
// ─────────────────────────────────────────────────────────────────────────────

const meta: Meta<typeof StripePaymentCardMock> = {
  title: "Checkout/StripePaymentCard",
  component: StripePaymentCardMock,
  decorators: [withTranslations],
  parameters: {
    layout: "centered",
  },
};

export default meta;
type Story = StoryObj<typeof StripePaymentCardMock>;

// ─────────────────────────────────────────────────────────────────────────────
// Stories
// ─────────────────────────────────────────────────────────────────────────────

/** Default idle state — card form ready for input. */
export const Default: Story = {
  args: {},
  decorators: [
    (Story) => (
      <div style={{ width: 420 }}>
        <Story />
      </div>
    ),
  ],
};

/** With a card validation error displayed inline. */
export const WithError: Story = {
  args: {
    cardError: "Your card number is invalid.",
  },
  decorators: [
    (Story) => (
      <div style={{ width: 420 }}>
        <Story />
      </div>
    ),
  ],
};

/** Payment is being processed — button shows spinner. */
export const Processing: Story = {
  args: {
    isSubmitting: true,
  },
  decorators: [
    (Story) => (
      <div style={{ width: 420 }}>
        <Story />
      </div>
    ),
  ],
};

/** Declined card error. */
export const Declined: Story = {
  args: {
    cardError: "Your card was declined. Please try a different payment method.",
  },
  decorators: [
    (Story) => (
      <div style={{ width: 420 }}>
        <Story />
      </div>
    ),
  ],
};

/** Expired card error. */
export const ExpiredCard: Story = {
  args: {
    cardError: "Your card has expired.",
  },
  decorators: [
    (Story) => (
      <div style={{ width: 420 }}>
        <Story />
      </div>
    ),
  ],
};

/** Narrow mobile width. */
export const Mobile: Story = {
  args: {},
  decorators: [
    (Story) => (
      <div style={{ width: 320 }}>
        <Story />
      </div>
    ),
  ],
};

/** Wide desktop width — card should not stretch excessively. */
export const WideContainer: Story = {
  args: {},
  decorators: [
    (Story) => (
      <div style={{ width: 560 }}>
        <Story />
      </div>
    ),
  ],
};
