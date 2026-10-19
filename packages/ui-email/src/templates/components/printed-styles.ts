import { type CSSProperties } from "react";

import { tokens } from "../../theme/tokens";

/**
 * Shared styles for the "Printed" frame (direction B, approved 2026-09-30) used
 * by the five applicant-facing application emails. Every colour is a token
 * literal; email can't read CSS variables.
 */
export const INK = tokens.colors.brand;
export const ACCENT = tokens.colors.brandAccent;
export const MUTED = tokens.colors.mutedText;
export const LINE = tokens.colors.border;
export const SANS = tokens.typography.fontFamily;
export const MONO = tokens.typography.monoFamily;

/** Uppercase, tracked label in the mono idiom (kicker, status labels, ledger keys). */
export const monoLabel = (
  size = 11,
  color: string = MUTED,
  weight = 500,
): CSSProperties => ({
  fontFamily: MONO,
  fontSize: `${size}px`,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color,
  margin: 0,
  lineHeight: 1.4,
  fontWeight: weight,
});

export const bodyText: CSSProperties = {
  fontFamily: SANS,
  fontSize: "16px",
  lineHeight: 1.5,
  color: INK,
  margin: 0,
};

export const smallText: CSSProperties = {
  fontFamily: SANS,
  fontSize: "14px",
  lineHeight: 1.5,
  color: MUTED,
  margin: 0,
};

export const linkStyle: CSSProperties = { color: ACCENT };

export const rawUrlText: CSSProperties = {
  fontFamily: SANS,
  fontSize: "13px",
  lineHeight: 1.5,
  color: MUTED,
  margin: 0,
  wordBreak: "break-all",
};
