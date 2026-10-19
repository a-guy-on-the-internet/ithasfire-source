"use client";

import type { CSSProperties } from "react";

import type { EmbedView } from "@/lib/embed-view";

import { STEEL_BLUE, SURFACE, TEXT_INVERTED } from "./embed-theme";

// ─────────────────────────────────────────────────────────────────────────────
// Viewer-facing List/Calendar switcher (FR-004).
//
// Rendered on the BROWSE screen only, and only when the embed has
// `viewToggle` on and an org/human subject. Flipping it swaps the browse view
// client-side inside the same iframe — no navigation, no reload — so this is a
// pure controlled input; EmbedWidget owns the state and the lazy second query.
//
// Raw elements + `embed-theme` tokens (not @th/ui) for the same reason
// EmbedEventGrid uses them: the widget renders inside third-party iframes on a
// forced-light palette, and every colour here must stay overridable by the
// host's `--hf-*` theme params. Focus rings are the platform's global
// `:focus-visible` ring; `body[data-th-embed]` points its colour at the
// host accent when one is set (globals.css).
//
// Two `aria-pressed` toggle buttons rather than a radiogroup: both segments sit
// in the Tab order and Enter/Space activates them, which is the complete
// keyboard model for a native <button>. A radiogroup would promise roving
// tabindex + arrow keys that this control does not implement.
// ─────────────────────────────────────────────────────────────────────────────

const OPTIONS: readonly { value: EmbedView; label: string }[] = [
  { value: "list", label: "List" },
  { value: "calendar", label: "Calendar" },
];

const rowStyle: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  padding: "12px 16px 0",
};

const groupStyle: CSSProperties = {
  display: "inline-flex",
  border: `2px solid ${STEEL_BLUE}`,
  background: SURFACE,
};

const segmentStyle = (active: boolean): CSSProperties => ({
  // 44px is this surface's tap-target floor, stated twice in its own token
  // file (`primaryButtonStyle`, `inputStyle`) — the switcher is a touch
  // target like any other and does not get to be the exception.
  minHeight: 44,
  padding: "0 16px",
  border: "none",
  borderRadius: 0,
  background: active ? STEEL_BLUE : "transparent",
  color: active ? TEXT_INVERTED : STEEL_BLUE,
  fontFamily: "inherit",
  fontSize: 11,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  cursor: active ? "default" : "pointer",
  transition: "background 120ms ease-out, color 120ms ease-out",
});

type Props = {
  /** The FR-003 resolved view — the switcher's initial position. */
  value: EmbedView;
  onChange: (next: EmbedView) => void;
};

export function EmbedViewToggle({ value, onChange }: Props) {
  return (
    <div style={rowStyle}>
      <div style={groupStyle} role="group" aria-label="Browse view">
        {OPTIONS.map((option) => {
          const active = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={active}
              style={segmentStyle(active)}
              onClick={() => {
                // Guard the no-op so a repeated click can't churn state (and,
                // via the lazy query gate, can't re-trigger a fetch).
                if (!active) onChange(option.value);
              }}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
