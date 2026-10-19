"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { useTheme } from "tamagui";

import { stubTheme } from "../../tokens/colors";

// ---------------------------------------------------------------------------
// CharCountTextarea — multi-line input with live character countdown
//
// Swiss form pattern: character countdown displayed below the field
// ("247 / 500"). Focus state snaps border to orange. Supports auto-expanding
// up to a configurable number of visible lines (default 7), then scrolls.
// ---------------------------------------------------------------------------

/** Max visible lines before the textarea scrolls (when autoExpand is true). */
const DEFAULT_MAX_LINES = 7;
/** Approximate line-height in px for calculating max auto-expand height. */
const LINE_HEIGHT_PX = 22;
/** Vertical padding (top + bottom) applied to the textarea. */
const V_PAD = 20; // 10px top + 10px bottom

export interface CharCountTextareaProps {
  value: string;
  onChange: (value: string) => void;
  maxLength: number;
  /**
   * Fixed height in px. Ignored when `autoExpand` is true (use `minHeight`
   * instead). Default 64.
   */
  height?: number;
  /**
   * Auto-expand the textarea as the user types, up to `maxLines` visible
   * lines, then scroll. Default **true**.
   */
  autoExpand?: boolean;
  /**
   * Minimum height when `autoExpand` is true. Falls back to `height` prop.
   */
  minHeight?: number;
  /**
   * Max visible lines before scrolling (only when `autoExpand`). Default 7.
   */
  maxLines?: number;
  /** DOM id for the underlying <textarea> (label association / autofill —
   *  DevTools flags form fields without an id or name). */
  id?: string;
  placeholder?: string;
  disabled?: boolean;
  /** Show error styling (red border). Also sets `aria-invalid` on the
   *  textarea, so the visual and AT invalid states can never drift apart. */
  error?: boolean;
  /** Id(s) of the element(s) describing this field (e.g. an inline error
   *  with `role="alert"`) — forwarded as `aria-describedby`. */
  ariaDescribedBy?: string;
  /** Mobile keyboard Enter key label hint. */
  enterKeyHint?: React.HTMLAttributes<HTMLTextAreaElement>["enterKeyHint"];
  /** Test automation base id. */
  testIdBase?: string;
}

export function CharCountTextarea({
  value,
  onChange,
  maxLength,
  height = 64,
  autoExpand = true,
  minHeight: minHeightProp,
  maxLines = DEFAULT_MAX_LINES,
  id,
  placeholder,
  disabled,
  error,
  ariaDescribedBy,
  enterKeyHint,
  testIdBase,
}: CharCountTextareaProps) {
  const theme = useTheme();
  const [focused, setFocused] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const accent = theme.brandSecondary?.val ?? stubTheme.brandSecondary;
  const errorColor = theme.danger?.val ?? stubTheme.danger;

  const computedMinHeight = minHeightProp ?? height;
  const computedMaxHeight = autoExpand
    ? maxLines * LINE_HEIGHT_PX + V_PAD
    : undefined;

  // Resize the textarea to fit its content (auto-expand mode only).
  const resize = useCallback(() => {
    const el = textareaRef.current;
    if (!el || !autoExpand) return;
    // Reset to min so scrollHeight recalculates correctly.
    el.style.height = `${computedMinHeight}px`;
    const desired = Math.min(el.scrollHeight, computedMaxHeight ?? Infinity);
    el.style.height = `${Math.max(desired, computedMinHeight)}px`;
    // Show scrollbar only when content exceeds max height.
    el.style.overflowY =
      el.scrollHeight > (computedMaxHeight ?? Infinity) ? "auto" : "hidden";
  }, [autoExpand, computedMinHeight, computedMaxHeight]);

  // Re-measure whenever value changes (e.g. programmatic updates).
  useEffect(() => {
    resize();
  }, [value, resize]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const next = e.target.value;
      if (next.length <= maxLength) {
        onChange(next);
      }
    },
    [onChange, maxLength],
  );

  const restBorder = error
    ? errorColor
    : (theme.borderColor?.val ?? stubTheme.borderColor);
  const focusBorder = error ? errorColor : accent;
  const borderColor = focused ? focusBorder : restBorder;

  const textareaStyle: CSSProperties = autoExpand
    ? {
        width: "100%",
        minHeight: computedMinHeight,
        maxHeight: computedMaxHeight,
        padding: "10px 12px",
        background: theme.surfaceMuted?.val ?? stubTheme.surfaceMuted,
        border: `1px solid ${borderColor}`,
        borderRadius: 0,
        color: theme.color?.val ?? stubTheme.color,
        fontSize: 14,
        lineHeight: `${LINE_HEIGHT_PX}px`,
        fontFamily: "var(--font-body, Inter, sans-serif)",
        transition: "border-color 150ms ease-out, box-shadow 150ms ease-out",
        boxSizing: "border-box" as const,
        resize: "none" as const,
        overflowY: "hidden",
      }
    : {
        width: "100%",
        height,
        padding: "10px 12px",
        background: theme.surfaceMuted?.val ?? stubTheme.surfaceMuted,
        border: `1px solid ${borderColor}`,
        borderRadius: 0,
        color: theme.color?.val ?? stubTheme.color,
        fontSize: 14,
        lineHeight: `${LINE_HEIGHT_PX}px`,
        fontFamily: "var(--font-body, Inter, sans-serif)",
        transition: "border-color 150ms ease-out, box-shadow 150ms ease-out",
        boxSizing: "border-box" as const,
        resize: "none" as const,
        overflow: "auto",
      };

  return (
    <div {...(testIdBase ? { "data-testid": `${testIdBase}-textarea` } : {})}>
      <textarea
        ref={textareaRef}
        id={id}
        value={value}
        onChange={handleChange}
        onInput={resize}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        maxLength={maxLength}
        placeholder={placeholder}
        disabled={disabled}
        enterKeyHint={enterKeyHint}
        aria-invalid={error ? true : undefined}
        aria-describedby={ariaDescribedBy}
        style={textareaStyle}
      />
      <div
        style={{
          fontSize: 11,
          color: theme.colorMuted?.val ?? stubTheme.colorMuted,
          textAlign: "right",
          marginTop: 2,
        }}
      >
        {value.length} / {maxLength}
      </div>
    </div>
  );
}
