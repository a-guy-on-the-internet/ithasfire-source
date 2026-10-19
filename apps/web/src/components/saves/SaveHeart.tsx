"use client";

import { useCallback, type CSSProperties, type MouseEvent } from "react";
import { Heart } from "lucide-react";
import { useTranslations } from "@th/ui";

export type SaveHeartProps = {
  /** Current saved state (from `useEventSaves`). */
  saved: boolean;
  /** Toggle handler (from `useEventSaves.toggleSave`). */
  onToggle: () => void;
  /** Icon size in px. Hit target stays ≥44px regardless. */
  iconSize?: number;
  style?: CSSProperties;
  testId?: string;
};

/**
 * Standalone heart toggle for event rows/tiles that don't render through the
 * shared `EventCard` (which has its own built-in heart). Outline = unsaved,
 * filled = saved. Never shows counts — saves are private.
 *
 * Safe inside a clickable row/anchor: stops propagation and prevents the
 * parent navigation.
 */
export function SaveHeart({
  saved,
  onToggle,
  iconSize = 18,
  style,
  testId,
}: SaveHeartProps) {
  const t = useTranslations();

  const label = saved
    ? String(t("saves.removeFromSaved"))
    : String(t("saves.saveEvent"));

  const handleClick = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      e.preventDefault();
      e.stopPropagation();
      onToggle();
    },
    [onToggle],
  );

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-pressed={saved}
      aria-label={label}
      title={label}
      data-testid={testId}
      className="th-save-heart"
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 44,
        height: 44,
        padding: 0,
        border: "none",
        borderRadius: 0,
        background: "transparent",
        cursor: "pointer",
        color: saved
          ? "var(--accent, #E2481D)"
          : "var(--brandSecondary, #E2481D)",
        flexShrink: 0,
        ...style,
      }}
    >
      <Heart
        size={iconSize}
        strokeWidth={2.5}
        stroke="currentColor"
        fill={saved ? "currentColor" : "none"}
        aria-hidden
      />
    </button>
  );
}
