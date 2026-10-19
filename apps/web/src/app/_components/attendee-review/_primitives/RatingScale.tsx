"use client";

import { useRef, type CSSProperties, type KeyboardEvent } from "react";
import { ACCENT } from "@/lib/design-tokens";
import { BG, BORDER, FG, MUTED } from "../_shared/tokens";

// ─────────────────────────────────────────────────────────────────────────────
// RatingScale — big tappable 1-5 selector for the conversational review form.
//
// Swiss: five rectangular blocks (borderRadius 0), ≥44px tap targets, accent
// fill up to the selected value. Full keyboard support: 1-5 set the value,
// Arrow keys nudge, and each block is a real <button> (Enter/Space). Selecting
// a value fires `onCommit` so the orchestrator can gently auto-advance.
// ─────────────────────────────────────────────────────────────────────────────

export interface RatingScaleProps {
  value: number;
  onChange: (value: number) => void;
  /** Fired after a value is picked (used for gentle auto-advance). */
  onCommit?: (value: number) => void;
  /** Endpoint labels, e.g. ["Poor", "Great"]. */
  lowLabel: string;
  highLabel: string;
  /** Accessible name for the group (the current question). */
  ariaLabel: string;
  max?: number;
  testIdBase?: string;
}

export function RatingScale({
  value,
  onChange,
  onCommit,
  lowLabel,
  highLabel,
  ariaLabel,
  max = 5,
  testIdBase,
}: RatingScaleProps) {
  const groupRef = useRef<HTMLDivElement>(null);

  const commit = (n: number) => {
    onChange(n);
    onCommit?.(n);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const key = e.key;
    if (key >= "1" && key <= String(max)) {
      e.preventDefault();
      commit(Number(key));
      return;
    }
    if (key === "ArrowRight" || key === "ArrowUp") {
      e.preventDefault();
      commit(Math.min(max, (value || 0) + 1));
      return;
    }
    if (key === "ArrowLeft" || key === "ArrowDown") {
      e.preventDefault();
      commit(Math.max(1, (value || max) - 1));
    }
  };

  const blocks = Array.from({ length: max }, (_, i) => i + 1);

  const blockStyle = (n: number): CSSProperties => {
    const filled = n <= value;
    return {
      flex: "1 1 0",
      minWidth: 0,
      minHeight: 56,
      height: 56,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      borderRadius: 0,
      border: `2px solid ${filled ? ACCENT : BORDER}`,
      background: filled ? ACCENT : BG,
      color: filled ? "#000000" : MUTED,
      cursor: "pointer",
      fontFamily: "var(--font-body, 'Montserrat', sans-serif)",
      fontSize: 18,
      fontWeight: 800,
      transition: "background 150ms ease-out, border-color 150ms ease-out, color 150ms ease-out",
    };
  };

  return (
    <div
      {...(testIdBase ? { "data-testid": `${testIdBase}-ratingscale` } : {})}
      style={{ display: "flex", flexDirection: "column", gap: 10 }}
    >
      <div
        ref={groupRef}
        role="radiogroup"
        aria-label={ariaLabel}
        onKeyDown={handleKeyDown}
        style={{ display: "flex", gap: 6 }}
      >
        {blocks.map((n) => (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={value === n}
            aria-label={`${n} ${n === 1 ? lowLabel : n === max ? highLabel : `of ${max}`}`}
            // Only the selected block (or the first, when unset) is in the tab
            // order — arrow keys move within the group per WAI-ARIA radiogroup.
            tabIndex={value === n || (value === 0 && n === 1) ? 0 : -1}
            onClick={() => commit(n)}
            style={blockStyle(n)}
            data-testid={testIdBase ? `${testIdBase}-block-${n}` : undefined}
          >
            {n}
          </button>
        ))}
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: 12,
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          color: value > 0 ? FG : MUTED,
        }}
        aria-hidden="true"
      >
        <span>{lowLabel}</span>
        <span>{highLabel}</span>
      </div>
    </div>
  );
}
