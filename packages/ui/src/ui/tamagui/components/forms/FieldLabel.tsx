import type { ReactNode } from "react";
import { styled, XStack } from "tamagui";
import { Text } from "../typography/Text";

// ---------------------------------------------------------------------------
// FieldLabel — form field label with optional / error states
//
// Swiss form pattern: uppercase, wide-tracked labels that sit above each
// input. OPTIONAL fields are marked with a muted "(optional)" suffix;
// REQUIRED fields are never marked (no asterisks, no dots). Checkout and KYC
// are ~90% mandatory, so marking required would decorate nearly every label
// and communicate nothing. Required-ness travels on the control
// (`required` / `aria-required`), not on the label. See
// docs/design/design-system-v2.md §6a. Error state shows inline error text
// below the label.
// ---------------------------------------------------------------------------

export interface FieldLabelProps {
  children: ReactNode;
  /** Show "(optional)" suffix in muted text. */
  optional?: boolean;
  /** Helper/context text displayed below the label. */
  helperText?: string;
  /**
   * Error message. When truthy the message is rendered in red below the
   * label/helper text, and the label text turns red.
   */
  error?: string;
  /** Test automation base id. */
  testIdBase?: string;
}

const LabelRow = styled(XStack, {
  name: "FieldLabelRow",
  alignItems: "baseline",
  gap: "$1",
});

/**
 * Uses the brand secondary token value (#FF5721) for error states.
 * Kept as a CSS variable reference so Tamagui theme tokens resolve correctly
 * in inline styles where Tamagui's `$token` syntax cannot be used.
 */
const ERROR_COLOR = "var(--brandSecondary, #FF5721)";

export function FieldLabel({
  children,
  optional,
  helperText,
  error,
  testIdBase,
}: FieldLabelProps) {
  return (
    <div {...(testIdBase ? { "data-testid": `${testIdBase}-label` } : {})}>
      <LabelRow>
        {/* The label idiom lives in the `overline` variant (IBM Plex Mono,
            11px/2px/600) rather than being re-rolled here. It used to be a
            caption with uppercase and tracking bolted on inline, which meant
            a field label and every other label in the product could drift. */}
        <Text
          variant="overline"
          style={{
            ...(error ? { color: ERROR_COLOR } : {}),
            transition: "color 150ms ease-out",
          }}
        >
          {children}
        </Text>
        {optional && !error && (
          <Text
            variant="caption"
            tone="muted"
            style={{
              letterSpacing: "0.04em",
              fontWeight: 500,
            }}
          >
            (optional)
          </Text>
        )}
      </LabelRow>
      {helperText && !error && (
        <Text variant="bodySmall" tone="muted" style={{ marginTop: 4 }}>
          {helperText}
        </Text>
      )}
      {error && (
        <div
          style={{
            marginTop: 4,
            fontSize: 12,
            fontWeight: 600,
            color: ERROR_COLOR,
            fontFamily: "var(--font-body, Inter, sans-serif)",
            letterSpacing: "0.01em",
          }}
        >
          {error}
        </div>
      )}
    </div>
  );
}
