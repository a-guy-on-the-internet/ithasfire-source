import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import { ACCENT_FILL, BORDER_STRONG, MUTED_LIGHT, ON_ACCENT } from "./tokens";

// ─────────────────────────────────────────────────────────────────────────────
// Shared button base style
// ─────────────────────────────────────────────────────────────────────────────

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
// ButtonPrimary / ButtonOutline — CTA links
// ─────────────────────────────────────────────────────────────────────────────

export function ButtonPrimary({
  href,
  children,
  style,
}: {
  href: string;
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <Link
      href={href}
      style={{
        ...BTN_BASE,
        // The #B93312 rung, NOT `ACCENT` — this button carries a 14px/700 label, and #E2481D has
        // no AA foreground in either polarity. White on this fill is 5.92:1. This is what the
        // `@th/ui` Button atom rests on ($brandSecondaryHover); the old comment here claimed to
        // match that atom while actually doing the opposite.
        background: ACCENT_FILL,
        color: ON_ACCENT,
        border: `2px solid ${ACCENT_FILL}`,
        ...style,
      }}
    >
      {children}
    </Link>
  );
}

export function ButtonOutline({
  href,
  children,
  style,
}: {
  href: string;
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <Link
      href={href}
      style={{
        ...BTN_BASE,
        border: `2px solid ${BORDER_STRONG}`,
        color: "var(--foreground)",
        ...style,
      }}
    >
      {children}
    </Link>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ButtonRow — horizontal flex container for CTA pairs
// ─────────────────────────────────────────────────────────────────────────────

export function ButtonRow({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 12, paddingTop: 4 }}>{children}</div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// GhostButton — text-only button with underline (for "Send another", resets…)
// ─────────────────────────────────────────────────────────────────────────────

export function GhostButton({
  onClick,
  children,
  style,
}: {
  onClick: () => void;
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        fontSize: 14,
        fontWeight: 500,
        color: MUTED_LIGHT,
        background: "none",
        border: "none",
        textDecoration: "underline",
        textUnderlineOffset: 4,
        cursor: "pointer",
        ...style,
      }}
    >
      {children}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TextLink — simple underlined anchor
// ─────────────────────────────────────────────────────────────────────────────

export function TextLink({
  href,
  children,
  muted = false,
  size = 14,
  style,
}: {
  href: string;
  children: ReactNode;
  muted?: boolean;
  size?: number;
  style?: CSSProperties;
}) {
  const isExternal = href.startsWith("http") || href.startsWith("mailto:");
  const Component = isExternal ? "a" : Link;
  const extraProps = isExternal ? { href } : { href };
  return (
    <Component
      {...extraProps}
      style={{
        fontSize: size,
        fontWeight: 500,
        // Muted ink (matches GhostButton above) — the retired white alpha was
        // invisible on the Stub paper canvas.
        color: muted ? MUTED_LIGHT : "var(--foreground)",
        textDecoration: "underline",
        textUnderlineOffset: 4,
        marginTop: muted ? "auto" : undefined,
        ...style,
      }}
    >
      {children}
    </Component>
  );
}
