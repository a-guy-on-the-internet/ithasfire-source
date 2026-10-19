"use client";

import { Check } from "lucide-react";
import { Text, useTranslations } from "@th/ui";

import {
  ACCENT,
  ACCENT_FILL,
  ACCENT_FILL_HOVER,
  ACCENT_TEXT,
  ON_ACCENT_FILL,
} from "@/lib/design-tokens";
import { useRsvpToggle } from "./use-rsvp-toggle";

export type RsvpButtonProps = {
  /** Event UUID (must be a PUBLISHED RSVP event). */
  eventId: string;
  /** Server-rendered `viewerRsvped` seed — avoids a loading flash. */
  initialRsvped?: boolean;
};

/**
 * Personal "I'm going" toggle for RSVP (community) listings — the primary
 * CTA that replaces "Get tickets" on free events.
 *
 * FR-004: the button reflects ONLY the viewer's own state. No attendee
 * counts, no lists, nothing public — ever.
 *
 * Signed-in: `community.myRsvpForEvent` (seeded by the server payload) with
 * optimistic rsvp/cancelRsvp toggling. Signed-out: opens the sign-in overlay
 * with a redirect back to this event.
 *
 * Fixed height + full width so toggling, loading, and label swaps never
 * shift the surrounding layout.
 */
export function RsvpButton({ eventId, initialRsvped }: RsvpButtonProps) {
  const t = useTranslations();
  const { going, resolving, disabled, label, handlePress } = useRsvpToggle({
    eventId,
    initialRsvped,
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <button
        type="button"
        onClick={handlePress}
        aria-pressed={going}
        aria-busy={resolving || undefined}
        aria-label={String(t("rsvp.toggleAria"))}
        // The hook's `disabled` also folds in the cross-surface mutation
        // guard (useIsMutating), so any concurrent RSVP mutation blocks this button
        // too. Visual dimming stays keyed on `resolving` only — the brief
        // mutation window must not grey the optimistic flip.
        //
        // aria-disabled (NOT native disabled): the native attribute would
        // yank the button out of the tab order during the brief mutation
        // window, dropping keyboard focus to <body> mid-toggle. Presses are
        // guarded inside handlePress (early-return on `disabled`).
        aria-disabled={disabled || undefined}
        data-testid="event-rsvp-button"
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 10,
          width: "100%",
          maxWidth: 420,
          minHeight: 48,
          padding: "0 20px",
          borderRadius: 0,
          // This 14px/800 label needs AA (4.5:1), and `ACCENT` (#E2481D) offers none in either
          // polarity — white-on-accent is 4.06:1 and accent-as-text is 3.57:1 on cream. So GOING is
          // the #B93312 rung + white (5.92:1) and NOT-GOING is an accent outline + accent-TEXT
          // (#B93312 on cream, 5.22:1). The border may stay #E2481D as an edge (≥3:1), but tracking
          // the fill keeps the solid state coherent.
          border: `2px solid ${going ? ACCENT_FILL : ACCENT}`,
          backgroundColor: going ? ACCENT_FILL : "transparent",
          color: going ? ON_ACCENT_FILL : ACCENT_TEXT,
          cursor: disabled ? "wait" : "pointer",
          opacity: resolving ? 0.55 : 1,
          fontFamily: "Montserrat, sans-serif",
          fontSize: 14,
          fontWeight: 800,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          transition: "background-color 0.15s, color 0.15s, opacity 0.15s",
        }}
        onMouseEnter={(e) => {
          if (disabled) return;
          if (going) {
            // Deepen one rung (#98240B, 8.10:1 with white).
            e.currentTarget.style.backgroundColor = ACCENT_FILL_HOVER;
            e.currentTarget.style.borderColor = ACCENT_FILL_HOVER;
          } else {
            // Preview the going state — fill the rung, flip the label white.
            e.currentTarget.style.backgroundColor = ACCENT_FILL;
            e.currentTarget.style.borderColor = ACCENT_FILL;
            e.currentTarget.style.color = ON_ACCENT_FILL;
          }
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.backgroundColor = going
            ? ACCENT_FILL
            : "transparent";
          e.currentTarget.style.borderColor = going ? ACCENT_FILL : ACCENT;
          e.currentTarget.style.color = going ? ON_ACCENT_FILL : ACCENT_TEXT;
        }}
      >
        {/* Icon rendered in BOTH states so the box never resizes. */}
        <Check
          size={18}
          strokeWidth={3}
          aria-hidden
          style={{ opacity: going ? 1 : 0.35, flexShrink: 0 }}
        />
        {label}
      </button>
      <Text variant="caption" tone="muted">
        {String(t("rsvp.privateHint"))}
      </Text>
    </div>
  );
}
