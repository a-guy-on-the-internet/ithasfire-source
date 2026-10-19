import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { MUTED } from "./tokens";
import { IconCircle } from "./cards";

// ─────────────────────────────────────────────────────────────────────────────
// StatusScreen — full-height centred icon + title + description (404, unsub…)
// ─────────────────────────────────────────────────────────────────────────────

export interface StatusScreenProps {
  icon: LucideIcon;
  iconColor: string;
  iconBg: string;
  title: string;
  description?: string;
  children?: ReactNode;
}

export function StatusScreen({
  icon,
  iconColor,
  iconBg,
  title,
  description,
  children,
}: StatusScreenProps) {
  return (
    <main
      className="swiss-dots"
      style={{
        display: "flex",
        minHeight: "60vh",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 16,
        padding: "0 24px",
        textAlign: "center",
        position: "relative",
        overflow: "hidden",
      }}
    >
      <IconCircle
        icon={icon}
        color={iconColor}
        bg={iconBg}
        size={64}
        iconSize={28}
      />
      <h1
        style={{
          fontSize: 24,
          fontWeight: 900,
          textTransform: "uppercase",
          letterSpacing: "-0.02em",
          color: "var(--foreground)",
        }}
      >
        {title}
      </h1>
      {description && (
        <p style={{ maxWidth: 384, fontSize: 15, color: MUTED }}>
          {description}
        </p>
      )}
      {children}
    </main>
  );
}

// LoadingScreen has moved to ./LoadingScreen.tsx so feedback.tsx stays a
// server-safe module (StatusScreen is consumed by static SSR pages).
