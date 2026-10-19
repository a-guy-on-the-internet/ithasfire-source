import type { CSSProperties, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { BORDER, SURFACE } from "./tokens";
import { SectionNumber } from "./typography";

// ─────────────────────────────────────────────────────────────────────────────
// Card — bordered rounded surface
// ─────────────────────────────────────────────────────────────────────────────

export interface CardProps {
  children: ReactNode;
  /** Stack direction inside. Default "column". */
  direction?: "row" | "column";
  /** centre items horizontally + vertically. Default false. */
  center?: boolean;
  /** Gap between children. Default 16. */
  gap?: number;
  /** Custom padding. Default "32px 24px". */
  padding?: string;
  style?: CSSProperties;
}

export function Card({
  children,
  direction = "column",
  center = false,
  gap = 16,
  padding = "32px 24px",
  style,
}: CardProps) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: direction,
        alignItems: center ? "center" : undefined,
        gap,
        borderRadius: 0,
        // Swiss structural lines: top and bottom only — not boxed in
        borderTop: `2px solid ${BORDER}`,
        borderBottom: `1px solid ${BORDER}`,
        padding,
        textAlign: center ? "center" : undefined,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SurfaceCard — Card with a subtle background (used for CTAs)
// ─────────────────────────────────────────────────────────────────────────────

export function SurfaceCard({
  children,
  center = false,
  gap = 20,
  padding = "48px 24px",
  style,
}: Omit<CardProps, "direction">) {
  return (
    <div
      className="swiss-dots"
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: center ? "center" : undefined,
        gap,
        borderRadius: 0,
        borderTop: `2px solid ${BORDER}`,
        borderBottom: `1px solid ${BORDER}`,
        padding,
        textAlign: center ? "center" : undefined,
        background: SURFACE,
        position: "relative",
        overflow: "hidden",
        ...style,
      }}
    >
      {/* Content sits above the pseudo-element texture */}
      <div
        style={{
          position: "relative",
          zIndex: 1,
          display: "flex",
          flexDirection: "column",
          gap,
          alignItems: center ? "center" : undefined,
          width: "100%",
        }}
      >
        {children}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// NumberedSection — section with a leading ordinal + ruled top
// ─────────────────────────────────────────────────────────────────────────────

export function NumberedSection({
  n,
  title,
  accent = false,
  children,
  gap = 24,
  style,
}: {
  /** Section ordinal (1 → "01"). */
  n: number;
  /** Heading text. */
  title: string;
  /** Use orange accent for the number. */
  accent?: boolean;
  children: ReactNode;
  gap?: number;
  style?: CSSProperties;
}) {
  return (
    <section className="swiss-numbered-section" style={{ gap, ...style }}>
      <div className="swiss-numbered-section__head">
        <SectionNumber n={n} accent={accent} />
        <h2>{title}</h2>
      </div>
      {children}
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// IconCircle — coloured circle with a Lucide icon
// ─────────────────────────────────────────────────────────────────────────────

export interface IconCircleProps {
  icon: LucideIcon;
  color: string;
  bg: string;
  /** Default 48. */
  size?: number;
  /** Icon stroke size. Default 22. */
  iconSize?: number;
}

export function IconCircle({
  icon: Icon,
  color,
  bg,
  size = 48,
  iconSize = 22,
}: IconCircleProps) {
  return (
    <div
      style={{
        display: "flex",
        height: size,
        width: size,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 0,
        background: bg,
      }}
    >
      <Icon size={iconSize} style={{ color }} />
    </div>
  );
}
