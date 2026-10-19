"use client";

import { useCallback } from "react";
import { Heart } from "lucide-react";
import { useTheme } from "tamagui";
import { useTranslations } from "@th/ui";

import { useEventSaves } from "./useEventSaves";

export type SaveButtonProps = {
  /** Event UUID. */
  eventId: string;
  /**
   * When true, the button renders for a dark surface (the immersive event
   * hero scrim): light hairline border + on-dark label/icon, instead of the
   * themed ink that would vanish on dark. Saved vs unsaved stays distinguished
   * by the filled heart + label, never by colour alone, so both states clear
   * AA on dark.
   */
  onDark?: boolean;
  /**
   * `poster` renders the button as one of the poster-first page's rail
   * actions (`.event-poster-action` in event-content.css): a 40px square over
   * the poster on a phone, one of three equal 44px buttons under it wide. All
   * of that is CSS, keyed on the viewport — this component renders ONE node
   * and never asks how wide the window is. `onDark` is ignored here; the
   * stylesheet owns both treatments.
   */
  variant?: "default" | "poster";
};

/**
 * Labeled Save / Saved toggle for the event detail header — a secondary
 * action styled to sit beside the ShareDropdown trigger (same 40px bordered
 * chrome), never competing with the Get Tickets CTA.
 *
 * Optimistic via `useEventSaves`; signed-out clicks open the sign-in overlay
 * with a redirect back to this page. No save counts anywhere — saves are
 * private.
 */
export function SaveButton({
  eventId,
  onDark = false,
  variant = "default",
}: SaveButtonProps) {
  const theme = useTheme();
  const t = useTranslations();
  const { isSaved, toggleSave } = useEventSaves([eventId]);

  const saved = isSaved(eventId);
  const label = saved ? String(t("saves.saved")) : String(t("saves.save"));
  const ariaLabel = saved
    ? String(t("saves.removeFromSaved"))
    : String(t("saves.saveEvent"));

  const handleClick = useCallback(() => {
    toggleSave(eventId);
  }, [eventId, toggleSave]);

  if (variant === "poster") {
    return (
      <button
        type="button"
        onClick={handleClick}
        aria-pressed={saved}
        aria-label={ariaLabel}
        data-testid="event-save-button"
        className="event-poster-action event-poster-action--save"
      >
        <Heart
          size={16}
          strokeWidth={2.5}
          stroke="currentColor"
          fill={saved ? "currentColor" : "none"}
          aria-hidden
        />
        <span className="event-poster-action__label">{label}</span>
      </button>
    );
  }

  const accent = theme.accent?.val ?? "var(--accent, #E2481D)";

  // On the immersive dark hero, the themed ink / accent both fall below AA on
  // the scrim, so the chrome flips to on-dark ink. Saved state is signalled by
  // the filled heart + "Saved" label (not colour), so both states stay legible.
  const onDarkInk = "var(--onStructure, #FDFAF3)";
  const restBorder = onDark
    ? "color-mix(in srgb, var(--onStructure, #FDFAF3) 40%, transparent)"
    : (theme.borderColor?.val ??
      "color-mix(in srgb, var(--foreground, #211C16) 20%, transparent)");
  const restInk = onDark
    ? onDarkInk
    : (theme.color?.val ?? "var(--foreground, #211C16)");
  const savedTint = onDark ? onDarkInk : accent;

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-pressed={saved}
      aria-label={ariaLabel}
      data-testid="event-save-button"
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        height: 40,
        padding: "0 14px",
        borderRadius: 0,
        border: `1px solid ${saved ? savedTint : restBorder}`,
        backgroundColor: "transparent",
        color: saved ? savedTint : restInk,
        cursor: "pointer",
        flexShrink: 0,
        marginTop: 2,
        fontFamily: "Montserrat, sans-serif",
        fontSize: 13,
        fontWeight: 700,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        transition: "color 0.15s, border-color 0.15s",
      }}
    >
      <Heart
        size={16}
        strokeWidth={2.5}
        stroke="currentColor"
        fill={saved ? "currentColor" : "none"}
        aria-hidden
      />
      {label}
    </button>
  );
}
