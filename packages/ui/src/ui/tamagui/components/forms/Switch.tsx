"use client";

import { useCallback, useEffect, useId } from "react";
import { Platform } from "react-native";
import { Label, XStack, styled } from "tamagui";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  saving?: boolean;
  size?: "default" | "small";
  label?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  /**
   * Id(s) of the element(s) DESCRIBING this switch — a helper line, or the
   * reason it is locked. A description is announced after the name and the
   * state, which is where "why is this dimmed?" belongs; folding it into
   * `aria-labelledby` instead makes the reason part of the control's NAME.
   */
  "aria-describedby"?: string;
  id?: string;
  testId?: string;
}

// ---------------------------------------------------------------------------
// Size look-up
// ---------------------------------------------------------------------------

// Must match what `lineHeight="$3"` resolves to on the label (24px — pinned
// in Switch.test.tsx) so the offset below centres the first line on the track.
const LABEL_LINE_HEIGHT = 24;

const SIZES = {
  default: { trackW: 48, trackH: 28, knobSize: 20 },
  small: { trackW: 40, trackH: 24, knobSize: 16 },
} as const;

// ---------------------------------------------------------------------------
// One-time CSS injection (focus ring + reduced-motion)
// ---------------------------------------------------------------------------

const SWITCH_CSS = `
button[data-th-switch]:focus-visible {
	outline: 2px solid var(--brandSecondary, #E2481D);
	outline-offset: 2px;
}
@media (prefers-reduced-motion: reduce) {
	button[data-th-switch],
	button[data-th-switch] > span {
		transition: none !important;
	}
}
`;

let cssInjected = false;
function injectSwitchStyles() {
  if (cssInjected || Platform.OS !== "web" || typeof document === "undefined")
    return;
  if (document.getElementById("th-switch-styles")) {
    cssInjected = true;
    return;
  }
  const el = document.createElement("style");
  el.id = "th-switch-styles";
  el.textContent = SWITCH_CSS;
  document.head.appendChild(el);
  cssInjected = true;
}

// ---------------------------------------------------------------------------
// Styled primitives
// ---------------------------------------------------------------------------

const SwitchRow = styled(XStack, {
  name: "THSwitchRow",
  // Top-aligned like Checkbox/Radio, so when the label wraps the track sits
  // beside the FIRST line rather than floating to the paragraph's middle.
  // The label's marginTop (below) re-centres that first line on the track.
  alignItems: "flex-start",
  // The space scale is integers only ($0–$8) — Tamagui silently drops a style
  // whose token it can't resolve, so a fractional `$2.5` here renders as 0 gap.
  gap: "$3",
  // Same trap Checkbox and Radio guard against: Tamagui flex items get
  // flex-shrink:0 and min-width:auto on web, so a long label holds the row
  // at its single-line width and overflows narrow parents.
  minWidth: 0,
  maxWidth: "100%",
  flexShrink: 1,
});

const buildTestProps = (
  id?: string,
  suffix?: string,
): Record<string, string> => {
  if (!id) return {};
  const full = suffix ? `${id}-${suffix}` : id;
  return Platform.OS === "web" ? { "data-testid": full } : { testID: full };
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function Switch({
  checked,
  onCheckedChange,
  disabled = false,
  saving = false,
  size = "default",
  label,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  "aria-describedby": ariaDescribedBy,
  id: idProp,
  testId,
}: SwitchProps) {
  const autoId = useId();
  const switchId = idProp ?? testId ?? autoId;
  const isDisabled = disabled || saving;
  const { trackW, trackH, knobSize } = SIZES[size];

  // Inject shared CSS once
  useEffect(() => {
    injectSwitchStyles();
  }, []);

  // Knob travel distance = track inner width − knob width
  // Inner width = trackW − 2*border(2) − 2*padding(2) = trackW − 8
  const travel = trackW - 8 - knobSize;

  const handleClick = useCallback(() => {
    if (!isDisabled) onCheckedChange(!checked);
  }, [isDisabled, onCheckedChange, checked]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === " ") {
        e.preventDefault();
        handleClick();
      }
    },
    [handleClick],
  );

  const switchEl = (
    <button
      id={switchId}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel ?? label}
      aria-labelledby={ariaLabelledBy}
      aria-describedby={ariaDescribedBy}
      disabled={isDisabled}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      data-th-switch=""
      style={{
        /* track */
        position: "relative",
        display: "inline-flex",
        alignItems: "center",
        width: trackW,
        height: trackH,
        minWidth: trackW,
        minHeight: trackH,
        padding: 2,
        borderRadius: 0,
        borderWidth: 2,
        borderStyle: "solid",
        borderColor: checked
          ? "var(--brandSecondary, #E2481D)"
          : "var(--borderColor, #211C16)",
        backgroundColor: checked
          ? "var(--brandSecondary, #E2481D)"
          : "var(--surfaceMuted, #EFE7D6)",
        cursor: isDisabled ? "not-allowed" : "pointer",
        opacity: saving ? 0.55 : isDisabled ? 0.5 : 1,
        transition:
          "background-color 200ms ease-out, border-color 200ms ease-out",
        flexShrink: 0,
        boxSizing: "border-box",
      }}
      {...buildTestProps(testId, "track")}
    >
      {/* knob — inverts against whichever track it sits on: paper on the
          accent fill when checked, ink on the muted surface when unchecked.
          A single white knob (the previous value) is invisible on Stub's
          cream `surfaceMuted` track (1.13:1) — the knob IS the affordance. */}
      <span
        style={{
          display: "block",
          width: knobSize,
          height: knobSize,
          borderRadius: 0,
          backgroundColor: checked
            ? "var(--onBrandSecondary, #FFFFFF)"
            : "var(--color, #211C16)",
          transform: checked ? `translateX(${travel}px)` : "translateX(0)",
          transition: "transform 200ms ease-out",
          flexShrink: 0,
        }}
        {...buildTestProps(testId, "thumb")}
      />
    </button>
  );

  if (!label) return switchEl;

  return (
    <SwitchRow>
      {switchEl}
      <Label
        htmlFor={switchId}
        fontFamily="$body"
        fontSize="$3"
        // Without an explicit lineHeight, Tamagui's Label defaults to the
        // $true SIZE token (14px) under 16px type — invisible on one line,
        // overlapping once the label wraps. Same value as Radio/Checkbox.
        lineHeight="$3"
        // Centre the first line on the track (28px default, 24px small), which
        // keeps a one-line label exactly where `alignItems: center` put it.
        marginTop={(trackH - LABEL_LINE_HEIGHT) / 2}
        color="$color"
        cursor={isDisabled ? "not-allowed" : "pointer"}
        opacity={isDisabled ? 0.55 : 1}
        userSelect="none"
        // Let the label shrink and wrap instead of pushing the row wider
        // than its parent. The track never shrinks (flexShrink: 0 above).
        flexShrink={1}
        minWidth={0}
      >
        {label}
      </Label>
    </SwitchRow>
  );
}
