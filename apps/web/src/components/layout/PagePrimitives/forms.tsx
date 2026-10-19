import type { CSSProperties, ReactNode } from "react";
import { ACCENT_FILL, BORDER, ON_ACCENT, PILL_TEXT } from "./tokens";

// ─────────────────────────────────────────────────────────────────────────────
// Shared input base style
// ─────────────────────────────────────────────────────────────────────────────

const INPUT_BASE: CSSProperties = {
  borderRadius: 0,
  // Ink hairline, matching ButtonOutline's 2px BORDER_STRONG in the sibling
  // buttons.tsx — the retired white alpha vanished on the Stub paper canvas.
  border: `2px solid ${BORDER}`,
  background: "transparent",
  padding: "10px 16px",
  fontSize: 14,
  color: "var(--foreground)",
};

const BTN_BASE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  borderRadius: 0,
  padding: "10px 20px",
  fontSize: 14,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  textDecoration: "none",
  cursor: "pointer",
};

// ─────────────────────────────────────────────────────────────────────────────
// FormField — label + input + optional error
// ─────────────────────────────────────────────────────────────────────────────

export function FormField({
  label,
  htmlFor,
  error,
  children,
}: {
  label: string;
  htmlFor: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <label
        htmlFor={htmlFor}
        style={{
          fontSize: 12,
          fontWeight: 500,
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          color: PILL_TEXT,
        }}
      >
        {label}
      </label>
      {children}
      {error && (
        <span style={{ fontSize: 12, color: "var(--danger)" }}>{error}</span>
      )}
    </div>
  );
}

/** Returns the appropriate input style for error / normal state. */
export function inputStyle(hasError: boolean): CSSProperties {
  return hasError
    ? { ...INPUT_BASE, borderColor: "var(--danger)" }
    : INPUT_BASE;
}

// ─────────────────────────────────────────────────────────────────────────────
// SubmitButton — primary form submit (not a link)
// ─────────────────────────────────────────────────────────────────────────────

export function SubmitButton({
  disabled,
  children,
  style,
}: {
  disabled?: boolean;
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <button
      type="submit"
      disabled={disabled}
      style={{
        ...BTN_BASE,
        justifyContent: "center",
        gap: 8,
        // The #B93312 rung, NOT `ACCENT`: this 14px/700 label needs 4.5:1, and #E2481D offers no
        // AA foreground in either polarity (white 4.06:1, ink 4.38:1). White on this rung is
        // 5.92:1. Matches ButtonPrimary in the sibling buttons.tsx and the @th/ui Button atom.
        border: `2px solid ${ACCENT_FILL}`,
        background: ACCENT_FILL,
        color: ON_ACCENT,
        opacity: disabled ? 0.6 : 1,
        marginTop: 4,
        ...style,
      }}
    >
      {children}
    </button>
  );
}
