import type { CSSProperties } from "react";

import {
  spacing,
  tokens,
  primaryButtonStyle as sharedPrimaryButton,
  secondaryButtonStyle as sharedSecondaryButton,
} from "../theme/tokens";

/**
 * Shared styles for the booking-hold family (BookingHoldPlaced /
 * Challenged / Released / Confirmed / StaffAttention) — the same eyebrow +
 * heading + card + button shapes as BookingRequestReceived, hoisted so five
 * templates don't carry five copies.
 */

const fontFamily = tokens.typography.fontFamily;

export const holdStyles = {
  eyebrow: {
    fontFamily,
    fontSize: "12px",
    letterSpacing: "0.12em",
    textTransform: "uppercase",
    color: tokens.colors.mutedText,
    margin: 0,
    marginBottom: spacing(1),
  } satisfies CSSProperties,
  heading: {
    fontFamily,
    fontSize: "26px",
    fontWeight: 700,
    margin: 0,
    marginBottom: spacing(1),
    color: tokens.colors.text,
    lineHeight: tokens.typography.headingTightLH,
  } satisfies CSSProperties,
  subtitle: {
    fontFamily,
    fontSize: "16px",
    margin: 0,
    color: tokens.colors.mutedText,
  } satisfies CSSProperties,
  card: {
    backgroundColor: tokens.colors.surfaceMuted,
    borderRadius: tokens.radius,
    padding: "20px",
    border: `1px solid ${tokens.colors.border}`,
    marginBottom: spacing(3),
  } satisfies CSSProperties,
  label: {
    fontFamily,
    fontSize: "12px",
    fontWeight: 700,
    textTransform: "uppercase",
    color: tokens.colors.mutedText,
    marginBottom: "4px",
  } satisfies CSSProperties,
  value: {
    fontFamily,
    fontSize: "16px",
    margin: 0,
    fontWeight: 700,
    color: tokens.colors.text,
  } satisfies CSSProperties,
  body: {
    fontFamily,
    fontSize: "16px",
    margin: 0,
    marginBottom: spacing(2),
    color: tokens.colors.text,
    lineHeight: "1.5",
  } satisfies CSSProperties,
  primaryButton: {
    ...sharedPrimaryButton,
    fontFamily,
    textAlign: "center",
  } satisfies CSSProperties,
  secondaryButton: {
    ...sharedSecondaryButton,
    fontFamily,
    textAlign: "center",
    marginLeft: spacing(1),
  } satisfies CSSProperties,
  muted: {
    fontFamily,
    fontSize: "12px",
    color: tokens.colors.mutedText,
    margin: `${spacing(3)} 0 0 0`,
  } satisfies CSSProperties,
  sectionGap: { marginBottom: spacing(3) } satisfies CSSProperties,
  center: { textAlign: "center" } satisfies CSSProperties,
} as const;

/** Row of label/value pairs inside the hold card. */
export type HoldFact = { label: string; value: string };
