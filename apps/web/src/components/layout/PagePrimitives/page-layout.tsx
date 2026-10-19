import type { CSSProperties, ReactNode } from "react";
import { BORDER } from "./tokens";

// ─────────────────────────────────────────────────────────────────────────────
// PageContainer — centred column with a max-width
// ─────────────────────────────────────────────────────────────────────────────

export interface PageContainerProps {
  children: ReactNode;
  /** Default 896 (≈ Tailwind max-w-4xl). Legal pages use 768. */
  maxWidth?: number;
  /** Vertical gap between direct children. Default 80. */
  gap?: number;
  /** Extra top/bottom padding. Default "32px 0". */
  padding?: string;
  style?: CSSProperties;
}

export function PageContainer({
  children,
  maxWidth = 896,
  gap = 80,
  padding = "32px 0",
  style,
}: PageContainerProps) {
  return (
    <div
      style={{
        margin: "0 auto",
        display: "flex",
        width: "100%",
        maxWidth,
        flexDirection: "column",
        gap,
        padding,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// HeroSection — centred title block with optional pill badge
// ─────────────────────────────────────────────────────────────────────────────

import { Pill } from "./typography";
import { PageTitle, PageDescription } from "./typography";

export interface HeroSectionProps {
  /** Small uppercase pill label above the title. */
  badge?: string;
  title: string;
  description?: string;
}

export function HeroSection({ badge, title, description }: HeroSectionProps) {
  return (
    <section
      className="swiss-diagonal"
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        gap: 20,
        textAlign: "left",
        // Swiss structural rule: bottom ruled line anchoring the hero
        borderBottom: `2px solid ${BORDER}`,
        paddingBottom: 32,
        position: "relative",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          position: "relative",
          zIndex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-start",
          gap: 20,
        }}
      >
        {badge && <Pill>{badge}</Pill>}
        <PageTitle>{title}</PageTitle>
        {description && <PageDescription>{description}</PageDescription>}
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ContentSection — vertical flex wrapper for page content blocks
// ─────────────────────────────────────────────────────────────────────────────

export function ContentSection({
  children,
  gap = 32,
  center = false,
  maxWidth,
  style,
}: {
  children: ReactNode;
  gap?: number;
  center?: boolean;
  maxWidth?: number;
  style?: CSSProperties;
}) {
  return (
    <section
      style={{
        display: "flex",
        flexDirection: "column",
        gap,
        textAlign: center ? "center" : undefined,
        maxWidth,
        margin: maxWidth ? "0 auto" : undefined,
        // Swiss structural rule: top-edge line between sections
        borderTop: `2px solid ${BORDER}`,
        paddingTop: 32,
        ...style,
      }}
    >
      {children}
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// AsymmetricGrid — Swiss two-column layout (wide/narrow)
// ─────────────────────────────────────────────────────────────────────────────

export function AsymmetricGrid({
  children,
  variant = "default",
  style,
}: {
  children: ReactNode;
  /** "default" = 2fr 1fr, "reversed" = 1fr 2fr, "halves" = 1fr 1fr. */
  variant?: "default" | "reversed" | "halves";
  style?: CSSProperties;
}) {
  const cls =
    variant === "reversed"
      ? "swiss-asym-grid--reversed"
      : variant === "halves"
        ? "swiss-asym-grid--halves"
        : "swiss-asym-grid";
  return (
    <div className={cls} style={style}>
      {children}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// GutterLayout — number/label gutter + main content
// ─────────────────────────────────────────────────────────────────────────────

export function GutterLayout({
  label,
  children,
  style,
}: {
  /** Narrow left column content (e.g. a SectionNumber or a label). */
  label: ReactNode;
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div className="swiss-gutter-layout" style={style}>
      <div className="swiss-gutter-layout__label">{label}</div>
      <div>{children}</div>
    </div>
  );
}
