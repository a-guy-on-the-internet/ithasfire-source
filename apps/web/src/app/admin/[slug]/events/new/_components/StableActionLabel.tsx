"use client";

import type { CSSProperties, ReactNode } from "react";
import { Button as TamaguiButton } from "tamagui";

/**
 * A button label that flips between two strings — Save → Saving, Publish →
 * Publishing — WITHOUT the button changing width.
 *
 * In the builder header the commit pair sits at the trailing edge of a row
 * whose title takes every pixel they leave. A label that grows by a few
 * characters shoves the title on every save, so the title box breathes each
 * time someone presses ⌘S. Reserving the wider label's width holds the row
 * still (2026-09-15: "one quiet row, with D's centre discipline").
 *
 * Mechanism: both twins render into ONE grid cell (`gridArea: "1 / 1"`) so
 * the cell is as wide as the wider of the two; the inactive one is
 * `visibility: hidden`, which still takes up space but is out of the a11y
 * tree and never painted. No hardcoded widths — the cell is measured from
 * the strings the locale hands us.
 *
 * The icon travels INSIDE each twin, not beside the cell: each twin is an
 * inline-flex row [icon][8px][label], centred in the cell. Reserving only the
 * label's width left the visible "PUBLISH" centred in a "PUBLISHING"-wide
 * cell, ~40px from a Send icon that sat outside it. With icon + label as one
 * unit the visible pair keeps the Button's 8px gap and the slack splits
 * evenly on both sides.
 *
 * Labels are Tamagui's own `ButtonText`, not `<span>`s: the `@th/ui` Button
 * only styles STRING children (Tamagui wraps them in ButtonText), and the
 * frame's font metrics live in `ButtonContext`, not in CSS the label could
 * inherit. `ButtonText` subscribes to that context, so size / weight /
 * tracking / family match a plain string label exactly. `color="inherit"`
 * mirrors what the `@th/ui` wrapper sets through `textProps` on web, so the
 * label tracks the frame's hover and press rungs.
 */
export type StableActionLabelProps = {
  /** The resting label. */
  idle: string;
  /** The in-flight label. */
  busy: string;
  /** Which of the two is visible right now. */
  pending: boolean;
  /**
   * Leading icon, rendered inside BOTH twins so the reserved width covers
   * icon + gap + label as one unit. Pass it here rather than as a sibling of
   * this component.
   */
  icon?: ReactNode;
};

const CELL_STYLE: CSSProperties = { display: "grid" };

/** One twin: icon + the Button's own 8px gap + label, centred in the cell. */
const TWIN_STYLE: CSSProperties = {
  gridArea: "1 / 1",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 8,
};

const ICON_STYLE: CSSProperties = { display: "flex", flexShrink: 0 };

export function StableActionLabel({
  idle,
  busy,
  pending,
  icon,
}: StableActionLabelProps) {
  const twins = [
    ["idle", idle, !pending],
    ["busy", busy, pending],
  ] as const;
  return (
    <span style={CELL_STYLE}>
      {twins.map(([key, label, visible]) => (
        <span
          key={key}
          style={{ ...TWIN_STYLE, visibility: visible ? "visible" : "hidden" }}
          aria-hidden={visible ? undefined : true}
        >
          {icon ? <span style={ICON_STYLE}>{icon}</span> : null}
          <TamaguiButton.Text color="inherit">{label}</TamaguiButton.Text>
        </span>
      ))}
    </span>
  );
}

StableActionLabel.displayName = "StableActionLabel";
