"use client";

import {
  useCallback,
  useId,
  type CSSProperties,
  type ChangeEvent,
  type KeyboardEvent,
} from "react";

// ─────────────────────────────────────────────────────────────────────────────
// RangeSlider — a themed HTML range input for web.
//
// Uses CSS custom properties from the Tamagui/Ithas Fire theme so it stays
// consistent with the active theme without any JS style recalculation.
// ─────────────────────────────────────────────────────────────────────────────

export interface RangeSliderProps {
  /** Current numeric value (controlled). */
  value: number;
  /** Called when the user drags or clicks to a new value. */
  onValueChange: (value: number) => void;
  /** Minimum allowed value. @default 0 */
  min?: number;
  /** Maximum allowed value. @default 100 */
  max?: number;
  /** Step increment. @default 1 */
  step?: number;
  /** Accessible label text (rendered as `aria-label`). */
  label?: string;
  /**
   * Human-readable announcement of the current value (rendered as
   * `aria-valuetext`). Use when the raw numeric value isn't self-describing —
   * e.g. a unit-aware radius ("31 mi", "50 km", "Worldwide"). Falls back to the
   * native numeric announcement when omitted.
   */
  valueText?: string;
  /** When true, the slider is non-interactive. @default false */
  disabled?: boolean;
  /** data-testid forwarded to the `<input>`. */
  testId?: string;
  /**
   * Key handler forwarded to the `<input>`, for callers that need keyboard
   * steps to differ from `step`.
   *
   * A native range input moves by exactly `step` on an arrow key, which is
   * correct whenever the pointer and the keyboard want the same granularity.
   * They don't always: a money slider wants sub-cent-free dragging AND whole-
   * dollar arrow keys, and a caller that post-processes `onValueChange` (e.g.
   * snapping to round values) can otherwise swallow a single-`step` keypress
   * entirely, leaving the control keyboard-dead. Call `preventDefault()` and
   * set the value yourself to take over.
   */
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
  /** Extra inline styles on the wrapper div. */
  style?: CSSProperties;
}

/**
 * Percentage of the current value within [min, max], clamped to [0, 100].
 */
const pct = (value: number, min: number, max: number): number => {
  if (max <= min) return 0;
  return Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
};

/**
 * `RangeSlider` wraps a native `<input type="range">` with design-system
 * styling that responds to Tamagui CSS custom-property tokens.
 *
 * ## Usage
 * ```tsx
 * <RangeSlider value={radius} onValueChange={setRadius} min={5} max={200} step={5} label="Radius" />
 * ```
 */
export const RangeSlider = ({
  value,
  onValueChange,
  min = 0,
  max = 100,
  step = 1,
  label,
  valueText,
  disabled = false,
  testId,
  style,
  onKeyDown,
}: RangeSliderProps) => {
  const id = useId();

  const handleChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      onValueChange(Number(e.target.value));
    },
    [onValueChange],
  );

  const fill = pct(value, min, max);
  // A class-safe form of the React id ("«r0»" / ":r0:" → "r0"), used for both
  // the selector and the class, so no escaping is needed. `CSS.escape` does
  // not exist on the server, and this renders during SSR (a checkout resumed
  // with a pay-what-you-want ticket already selected).
  const cls = id.replace(/[^a-zA-Z0-9_-]/g, "");

  return (
    <div style={{ width: "100%", ...style }}>
      {/* Scoped styles — injected once per component instance. */}
      <style>{`
        /* The INPUT is the hit area: 24px tall (WCAG 2.5.8's minimum target),
           transparent. The visible 6px track is drawn by the track pseudo-
           elements, so the bar looks exactly as thin as before while a finger
           no longer has to land on a 6px strip. Fallbacks are the Stub
           values (they paint before the theme vars hydrate). */
        .th-range-slider-${cls} {
          -webkit-appearance: none;
          appearance: none;
          display: block;
          width: 100%;
          height: 24px;
          margin: 0;
          padding: 0;
          background: transparent;
          border-radius: 0;
          outline: none;
          cursor: ${disabled ? "not-allowed" : "pointer"};
          opacity: ${disabled ? 0.5 : 1};
          transition: opacity 150ms ease;
        }

        /* ── Track (WebKit): filled/unfilled via gradient ───────────── */
        .th-range-slider-${cls}::-webkit-slider-runnable-track {
          height: 6px;
          border-radius: 0;
          background: linear-gradient(
            to right,
            var(--accent, #E2481D) 0%,
            var(--accent, #E2481D) ${fill}%,
            var(--borderColor, #211C16) ${fill}%,
            var(--borderColor, #211C16) 100%
          );
        }

        /* ── Thumb ──────────────────────────────────────────────────── */
        .th-range-slider-${cls}::-webkit-slider-thumb {
          -webkit-appearance: none;
          appearance: none;
          /* Chromium's UA sizes the thumb border-box: 20px drawn, as before
             the hit-area change. Stated so it cannot drift. */
          box-sizing: border-box;
          width: 20px;
          height: 20px;
          /* Centre the 20px thumb on the 6px track. */
          margin-top: -7px;
          border-radius: 0;
          background: var(--accent, #E2481D);
          border: 2px solid var(--surface, #FDFAF3);
          box-shadow: none;
          transition: transform 120ms ease;
        }
        .th-range-slider-${cls}::-moz-range-thumb {
          width: 20px;
          height: 20px;
          border-radius: 0;
          background: var(--accent, #E2481D);
          border: 2px solid var(--surface, #FDFAF3);
          box-shadow: none;
          transition: transform 120ms ease;
        }

        /* ── Hover / active ─────────────────────────────────────────── */
        .th-range-slider-${cls}:hover::-webkit-slider-thumb {
          transform: scale(1.15);
          box-shadow: none;
        }
        .th-range-slider-${cls}:hover::-moz-range-thumb {
          transform: scale(1.15);
          box-shadow: none;
        }
        .th-range-slider-${cls}:active::-webkit-slider-thumb {
          transform: scale(1.2);
        }
        .th-range-slider-${cls}:active::-moz-range-thumb {
          transform: scale(1.2);
        }

        /* ── Focus ring ─────────────────────────────────────────────── */
        .th-range-slider-${cls}:focus-visible {
          outline: 2px solid var(--accent, #E2481D);
          outline-offset: 2px;
        }

        /* ── Track (Firefox) ────────────────────────────────────────── */
        .th-range-slider-${cls}::-moz-range-track {
          height: 6px;
          border-radius: 0;
          background: var(--borderColor, #211C16);
        }
        .th-range-slider-${cls}::-moz-range-progress {
          height: 6px;
          border-radius: 0;
          background: var(--accent, #E2481D);
        }
      `}</style>

      <input
        id={id}
        className={`th-range-slider-${cls}`}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={handleChange}
        onKeyDown={onKeyDown}
        disabled={disabled}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={valueText}
        data-testid={testId}
      />
    </div>
  );
};

RangeSlider.displayName = "RangeSlider";
