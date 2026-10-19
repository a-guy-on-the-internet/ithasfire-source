"use client";

import type { ReactNode } from "react";
import { Lock } from "lucide-react";
import { MUTED } from "../_shared/tokens";

/**
 * Anonymity / trust reassurance line with a lock icon.
 * Used inline within sensitive form sections (payout, email).
 */
export function TrustLine({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        fontSize: 13,
        color: MUTED,
        letterSpacing: "0.02em",
        fontFamily: "var(--font-body, Inter, sans-serif)",
      }}
    >
      <Lock size={14} style={{ flexShrink: 0, opacity: 0.7 }} />
      <span>{children}</span>
    </div>
  );
}
