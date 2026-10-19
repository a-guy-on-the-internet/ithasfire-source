import type { CSSProperties, ReactNode } from "react";
import {
  ACCENT,
  LABEL,
  MUTED,
  MUTED_LIGHT,
  MUTED_STRONG,
  PILL_BG,
  PILL_BORDER,
  PILL_TEXT,
} from "./tokens";

// ─────────────────────────────────────────────────────────────────────────────
// Pill — small uppercase badge
// ─────────────────────────────────────────────────────────────────────────────

export function Pill({ children }: { children: ReactNode }) {
  return (
    <span
      style={{
        display: "inline-block",
        borderRadius: 0,
        border: `2px solid ${PILL_BORDER}`,
        background: PILL_BG,
        padding: "6px 16px",
        fontSize: 12,
        fontWeight: 700,
        textTransform: "uppercase",
        letterSpacing: "0.1em",
        color: PILL_TEXT,
      }}
    >
      {children}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PageTitle / PageDescription
// ─────────────────────────────────────────────────────────────────────────────

export function PageTitle({ children }: { children: ReactNode }) {
  return (
    <h1
      className="swiss-display-lg"
      style={{
        color: "var(--foreground)",
      }}
    >
      {children}
    </h1>
  );
}

export function PageDescription({ children }: { children: ReactNode }) {
  return (
    <p
      style={{
        maxWidth: 672,
        fontSize: 18,
        lineHeight: 1.6,
        color: MUTED_LIGHT,
        textWrap: "balance",
      }}
    >
      {children}
    </p>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SectionLabel — small uppercase heading for card grids / form sections
// ─────────────────────────────────────────────────────────────────────────────

export function SectionLabel({
  children,
  center = false,
}: {
  children: ReactNode;
  center?: boolean;
}) {
  return (
    <h2
      style={{
        textAlign: center ? "center" : undefined,
        fontSize: 14,
        fontWeight: 700,
        textTransform: "uppercase",
        letterSpacing: "0.06em",
        color: LABEL,
        // Swiss structural accent: left rule for hierarchy
        borderLeft: center ? undefined : `3px solid ${ACCENT}`,
        paddingLeft: center ? undefined : 12,
      }}
    >
      {children}
    </h2>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SectionTitle — h2 used inside content sections
// ─────────────────────────────────────────────────────────────────────────────

export function SectionTitle({
  children,
  size = 20,
}: {
  children: ReactNode;
  size?: number;
}) {
  return (
    <h2
      style={{
        fontSize: size,
        fontWeight: 700,
        textTransform: "uppercase",
        letterSpacing: "-0.02em",
      }}
    >
      {children}
    </h2>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// BodyText — normal readable paragraph with optional emphasis colour
// ─────────────────────────────────────────────────────────────────────────────

export function BodyText({
  children,
  size = 16,
  color = MUTED_STRONG,
  center = false,
}: {
  children: ReactNode;
  size?: number;
  color?: string;
  center?: boolean;
}) {
  return (
    <p
      style={{
        fontSize: size,
        lineHeight: 1.6,
        color,
        textAlign: center ? "center" : undefined,
      }}
    >
      {children}
    </p>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MutedText — secondary body copy
// ─────────────────────────────────────────────────────────────────────────────

export function MutedText({
  children,
  size = 14,
  maxWidth,
  balance = false,
  style,
}: {
  children: ReactNode;
  size?: number;
  maxWidth?: number;
  balance?: boolean;
  style?: CSSProperties;
}) {
  return (
    <p
      style={{
        fontSize: size,
        lineHeight: 1.6,
        color: MUTED,
        maxWidth,
        textWrap: balance ? "balance" : undefined,
        ...style,
      }}
    >
      {children}
    </p>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MonoText — monospace inline text
// ─────────────────────────────────────────────────────────────────────────────

export function MonoText({ children }: { children: ReactNode }) {
  return (
    <span style={{ fontFamily: "var(--font-mono, monospace)" }}>
      {children}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CardTitle — h3 heading inside a Card
// ─────────────────────────────────────────────────────────────────────────────

export function CardTitle({
  children,
  size = 16,
}: {
  children: ReactNode;
  size?: number;
}) {
  return (
    <h3
      style={{
        fontSize: size,
        fontWeight: 700,
        textTransform: "uppercase",
        letterSpacing: "-0.01em",
      }}
    >
      {children}
    </h3>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CardBody — title + description group inside a Card
// ─────────────────────────────────────────────────────────────────────────────

export function CardBody({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <CardTitle>{title}</CardTitle>
      <MutedText>{description}</MutedText>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// DisplayHeading — oversized Swiss headline
// ─────────────────────────────────────────────────────────────────────────────

export function DisplayHeading({
  children,
  size = "lg",
  style,
}: {
  children: ReactNode;
  /** "xl" (hero), "lg" (section), "md" (subsection). */
  size?: "xl" | "lg" | "md";
  style?: CSSProperties;
}) {
  const Tag = size === "xl" ? "h1" : "h2";
  return (
    <Tag
      className={`swiss-display-${size}`}
      style={{ color: "var(--foreground)", ...style }}
    >
      {children}
    </Tag>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Overline — tiny uppercase label (Swiss overline text)
// ─────────────────────────────────────────────────────────────────────────────

export function Overline({
  children,
  style,
}: {
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <span className="swiss-overline" style={style}>
      {children}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SectionNumber — monospace numeral prefix (01, 02, …)
// ─────────────────────────────────────────────────────────────────────────────

export function SectionNumber({
  n,
  accent = false,
  style,
}: {
  /** Section ordinal (1 → "01"). */
  n: number;
  /** Use orange accent colour instead of muted. */
  accent?: boolean;
  style?: CSSProperties;
}) {
  return (
    <span
      className={`swiss-section-num${accent ? " swiss-section-num--accent" : ""}`}
      aria-hidden
      style={style}
    >
      {String(n).padStart(2, "0")}
    </span>
  );
}
