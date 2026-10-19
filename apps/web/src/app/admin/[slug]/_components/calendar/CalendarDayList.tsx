"use client";

import { Text } from "@th/ui";
import { Plus } from "lucide-react";

import { Mono } from "./Mono";
import {
  chipAccessibleName,
  chipTestId,
  dayCountLabel,
  formatDayLabel,
  formatTimeRange,
  isSoldOut,
  renderKeyFor,
} from "./helpers";
import {
  CAL_BORDER,
  CAL_SOLD_OUT_BAR,
  CAL_SOLD_OUT_BG,
  STATUS_BAR,
} from "./status-colors";
import type { CalendarDay, CalendarItem, CalendarMode } from "./types";
import { useCalendarLabels } from "./use-calendar-labels";
import { HoldLineTag, HoldTag, StatusTag, type ItemPressHandler } from "./view-shared";

export type CalendarDayListProps = {
  day: CalendarDay;
  items: CalendarItem[];
  timezone: string;
  mode: CalendarMode;
  onItemPress?: ItemPressHandler;
  /** Internal: the ghost "+ New event · Sep 5" button → local midnight. */
  onCreateAt?: (date: Date) => void;
  /** The engine owns a peek for these rows — sets `aria-haspopup`. */
  hasPopup?: boolean;
  /** @deprecated Superseded by `peekRenderKey`; kept for callers that pass it. */
  peekItemId?: string | null;
  /** The render key of the ONE row whose peek is open. */
  peekRenderKey?: string | null;
};

/**
 * The tapped day's list beneath the dot grid (FR-010) — and the "+N more"
 * target under the month grid. Rows are 44px-plus tap targets.
 *
 * Below 600px this list IS the public embed's month view (the dot grid carries
 * no chips), so FR-022's sold-out treatment has to live here too or a sold-out
 * show is indistinguishable from an available one on every phone that loads the
 * widget. Same grammar as `CalendarChip`: the FRAME goes neutral (the 12%
 * `--colorMuted` wash plus the neutral status bar), the title and time keep
 * full ink, and a mono "Sold out" tag joins the meta line. No blanket
 * `opacity` — that is what dropped the chip's title under AA.
 */
export function CalendarDayList({
  day,
  items,
  timezone,
  mode,
  onItemPress,
  onCreateAt,
  hasPopup = false,
  peekItemId,
  peekRenderKey,
}: CalendarDayListProps) {
  const labels = useCalendarLabels();
  const internal = mode === "internal";
  const heading = formatDayLabel(day, labels);
  const visible = internal ? items : items.filter((i) => i.kind === "event");
  return (
    <div data-testid="calendar-day-list" style={{ minWidth: 0 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          gap: 12,
          padding: "14px 16px 6px",
          borderBottom: `2px solid ${CAL_BORDER}`,
        }}
      >
        <Mono size="sm" upper>
          {heading}
        </Mono>
        <Mono size="xs" tone="muted">
          {dayCountLabel(visible, labels)}
        </Mono>
      </div>

      {visible.length === 0 && (
        <div style={{ padding: "20px 16px" }}>
          <Text variant="bodySmall" tone="muted">
            {labels.nothingOnDay}
          </Text>
        </div>
      )}

      {visible.map((item) => {
        const renderKey = renderKeyFor(day, item);
        const expanded =
          peekRenderKey != null ? peekRenderKey === renderKey : peekItemId === item.id;
        const rowTestId = chipTestId("calendar-day-list-row", item, day);
        // Public mode only — sold/capacity is internal vocabulary, and the
        // internal list already ends every row with its status tag.
        const soldOut = item.kind === "event" && !internal && isSoldOut(item);
        return (
          <button
            key={renderKey}
            type="button"
            className="th-cal-btn th-cal-row"
            data-testid={rowTestId}
            data-kind={item.kind}
            data-sold-out={soldOut ? "true" : undefined}
            data-render-key={renderKey}
            aria-label={chipAccessibleName(
              item,
              timezone,
              labels,
              soldOut ? labels.soldOut : null,
            )}
            aria-haspopup={hasPopup ? "dialog" : undefined}
            aria-expanded={hasPopup ? expanded : undefined}
            onClick={(event) => onItemPress?.(item, event.currentTarget, renderKey)}
            style={{
              gridTemplateColumns: internal ? "76px minmax(0, 1fr) auto" : "76px minmax(0, 1fr)",
              minHeight: 56,
              padding: "0 16px 0 0",
              columnGap: 12,
              // The sold-out wash rides `background-image`, not `background`:
              // `.th-cal-row:hover` sets the background SHORTHAND, so an
              // inline background-color would out-specify it and kill the
              // row's hover response (the day list is reachable on desktop
              // via "+N more"). As an image layer the wash paints OVER the
              // hover fill instead, and both still read.
              ...(soldOut
                ? {
                    backgroundImage: `linear-gradient(${CAL_SOLD_OUT_BG}, ${CAL_SOLD_OUT_BG})`,
                  }
                : {}),
              // Same containment rule as the agenda row: a fixed-track grid
              // may never widen the page (320px overflow regression).
              maxWidth: "100%",
              minWidth: 0,
              overflow: "hidden",
            }}
          >
            {item.kind === "hold" ? (
              <span style={{ display: "flex", alignItems: "center", paddingLeft: 16 }}>
                <Mono size="xs" tone="muted">
                  {labels.hold}
                </Mono>
              </span>
            ) : (
              <span style={{ display: "flex", alignItems: "stretch", gap: 12, alignSelf: "stretch" }}>
                <span
                  aria-hidden
                  style={{
                    width: 3,
                    flexShrink: 0,
                    background: soldOut ? CAL_SOLD_OUT_BAR : STATUS_BAR[item.status],
                  }}
                />
                <span style={{ display: "flex", alignItems: "center", minWidth: 0 }}>
                  <Mono size="md" truncate>
                    {formatTimeRange(item.startsAt, null, timezone)}
                  </Mono>
                </span>
              </span>
            )}
            <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, padding: "8px 0" }}>
              <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                {item.kind === "hold" && <HoldLineTag position={item.position} />}
                <Text variant="span" fontSize={15} lineHeight={19} weight="semibold" truncate>
                  {item.title}
                </Text>
              </span>
              {(soldOut || (item.kind === "event" && item.venueName)) && (
                <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                  {/* Mono label idiom, muted — 5.98:1 on the washed row, so it
                      stays AA at the 2xs rung. PUBLIC-facing on purpose: unlike
                      the status tag, "Sold out" is the buyer's word. */}
                  {soldOut && (
                    <Mono
                      size="2xs"
                      upper
                      tone="muted"
                      data-testid={`${rowTestId}-sold-out`}
                      style={{ whiteSpace: "nowrap", flexShrink: 0 }}
                    >
                      {labels.soldOut}
                    </Mono>
                  )}
                  {item.kind === "event" && item.venueName && (
                    <Text variant="bodySmall" tone="muted" truncate>
                      {item.venueName}
                    </Text>
                  )}
                </span>
              )}
            </span>
            {/* Workflow state is INTERNAL. On a third-party page every row
                ended in "Published", which is meaningless to a ticket buyer
                and leaks our editorial vocabulary. */}
            {internal &&
              (item.kind === "hold" ? (
                <HoldTag status={item.status} />
              ) : (
                <StatusTag status={item.status} />
              ))}
          </button>
        );
      })}

      {internal && onCreateAt && (
        <div style={{ padding: "8px 16px 12px" }}>
          <button
            type="button"
            className="th-cal-btn th-cal-action"
            data-variant="ghost"
            data-testid={`calendar-day-list-create-${day.key}`}
            onClick={() => onCreateAt(day.start)}
            style={{ minHeight: 44, width: "100%", justifyContent: "flex-start" }}
          >
            <Plus size={14} aria-hidden />
            {labels.newEventOn(`${labels.monthsShort[day.month - 1]} ${day.day}`)}
          </button>
        </div>
      )}
    </div>
  );
}
