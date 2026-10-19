"use client";

import type { ReactNode } from "react";
import { Text } from "@th/ui";

import { Mono } from "./Mono";
import {
  CAL_BORDER,
  CAL_INK,
  CAL_ON_INK,
  CAL_SURFACE,
  CAL_WARNING_SOFT,
  STATUS_BG,
} from "./status-colors";
import type { CalendarHoldItem, CalendarItem, CalendarEventStatus } from "./types";
import { useCalendarLabels } from "./use-calendar-labels";

export type ItemPressHandler = (
  item: CalendarItem,
  anchor: HTMLButtonElement,
  renderKey: string,
) => void;

/**
 * The one empty state every view shares (month, week, agenda). It lives
 * INSIDE the frame — a caption rendered outside it by a mount reads as page
 * copy, not as the calendar's answer, which is what the embed used to do.
 * `data-testid` is stable across all three views on purpose.
 *
 * `overlay` centres it OVER the painted body instead of stacking it beneath.
 * The agenda collapses to nothing when empty, so its caption is the only
 * thing in the box; the month and week grids stay painted (the reader still
 * navigates by date), and a caption below six empty week rows sits ~740px
 * down — off the fold, in the one state where the message is the whole
 * point. The overlay is `pointer-events: none` so the cells underneath keep
 * their internal-mode click-to-create.
 */
export function CalendarEmptyState({
  label,
  overlay = false,
}: {
  label: string;
  overlay?: boolean;
}) {
  const caption = (
    <div
      data-testid="calendar-empty-state"
      style={{
        padding: overlay ? "16px 24px" : "32px 16px",
        textAlign: "center",
        minWidth: 0,
        maxWidth: "100%",
        // Paper behind the words, so they never read as text laid over the
        // hairline rules of the empty grid.
        background: overlay ? CAL_SURFACE : undefined,
      }}
    >
      <Text variant="body" tone="muted">
        {label}
      </Text>
    </div>
  );
  if (!overlay) return caption;
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        pointerEvents: "none",
        minWidth: 0,
      }}
    >
      {caption}
    </div>
  );
}

/** The TODAY square: ink fill, paper numeral. */
export function TodaySquare({ children, size = 22 }: { children: ReactNode; size?: number }) {
  return (
    <span
      data-testid="calendar-today-marker"
      style={{
        width: size,
        height: size,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        background: CAL_INK,
        color: CAL_ON_INK,
        flexShrink: 0,
      }}
    >
      {children}
    </span>
  );
}

/** Mono status tag — tags/badges rung, status fill. */
export function StatusTag({ status }: { status: CalendarEventStatus }) {
  const labels = useCalendarLabels();
  return (
    <Mono
      size="2xs"
      upper
      data-testid="calendar-status-tag"
      style={{ background: STATUS_BG[status], padding: "3px 8px", whiteSpace: "nowrap" }}
    >
      {labels.statuses[status]}
    </Mono>
  );
}

/** Held (dashed) / Challenged (warning wash) / Confirmed (solid) tag. */
export function HoldTag({ status }: { status: CalendarHoldItem["status"] }) {
  const labels = useCalendarLabels();
  const frame =
    status === "CHALLENGED"
      ? { background: CAL_WARNING_SOFT, border: "2px solid transparent" }
      : status === "CONFIRMED"
        ? { border: `2px solid ${CAL_BORDER}` }
        : { border: `2px dashed ${CAL_BORDER}` };
  return (
    <Mono
      size="2xs"
      upper
      data-testid="calendar-hold-tag"
      data-hold-status={status}
      style={{ ...frame, padding: "1px 6px", whiteSpace: "nowrap" }}
    >
      {labels.holdStatuses[status]}
    </Mono>
  );
}

/** "HOLD · #2" — the dashed mono tag before a hold row's title. */
export function HoldLineTag({ position }: { position: number }) {
  const labels = useCalendarLabels();
  return (
    <Mono
      size="2xs"
      upper
      style={{ border: `2px dashed ${CAL_BORDER}`, padding: "1px 6px", whiteSpace: "nowrap" }}
    >
      {labels.holdTag(position)}
    </Mono>
  );
}
