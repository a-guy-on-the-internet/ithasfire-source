"use client";

import type { MouseEvent } from "react";
import { Text } from "@th/ui";
import { Plus } from "lucide-react";

import { CalendarChip } from "./CalendarChip";
import { Mono } from "./Mono";
import {
  MONTH_CHIP_LIMIT,
  chipTestId,
  formatLongDay,
  renderKeyFor,
  startsOnDay,
} from "./helpers";
import {
  CAL_BORDER_SOFT,
  CAL_BORDER_STRONG,
  CAL_TODAY_WASH,
} from "./status-colors";
import type { CalendarDay, CalendarItem, CalendarMode } from "./types";
import { useCalendarLabels } from "./use-calendar-labels";
import { CalendarEmptyState, TodaySquare, type ItemPressHandler } from "./view-shared";

const COLUMNS = "repeat(7, minmax(0, 1fr))";

/**
 * The cell's resting floor: 6px padding, a 22px numeral band, and a chip
 * (35px) with room to spare — a busier day grows past it.
 *
 * Was 124px, 28px of which was reserved for an always-painted create
 * affordance pinned to the cell's bottom. That affordance is now out of flow
 * in the cell's top-right corner and invisible at rest (`.th-cal-create` in
 * calendar.css), so the cell owes it nothing: 124 − 28 = 96. Six week rows ×
 * 28px is the ~170px of empty height the grid carried over its canvas.
 */
export const MONTH_CELL_MIN_HEIGHT_PX = 96;

export type CalendarMonthViewProps = {
  weeks: CalendarDay[][];
  /** 1–12: the month the grid is about; other months' days render muted. */
  month: number;
  /** Null until the clock has mounted — no TODAY square, wash or label before then. */
  todayKey: string | null;
  itemsByDay: Map<string, CalendarItem[]>;
  timezone: string;
  viewerTimezone: string;
  mode: CalendarMode;
  onItemPress?: ItemPressHandler;
  /** Internal only: empty-cell click / the create affordance → local midnight. */
  onCreateAt?: (date: Date) => void;
  /** "+N more" → the engine expands that day's list under the grid. */
  onShowMore?: (day: CalendarDay) => void;
  /** The engine owns a peek for these chips — sets `aria-haspopup`. */
  hasPopup?: boolean;
  /** @deprecated Superseded by `peekRenderKey`; kept for callers that pass it. */
  peekItemId?: string | null;
  /** The render key of the ONE chip whose peek is open. */
  peekRenderKey?: string | null;
  /**
   * Copy for the in-frame empty state under the grid. The grid itself stays
   * painted — the reader still needs the dates to navigate by — and the
   * caption sits beneath it, INSIDE the frame.
   */
  emptyLabel?: string;
};

/**
 * The 7-column month grid (FR-006): a mono weekday header on a 2px black
 * baseline, 96px cells with hairline rules, the TODAY square, up to three
 * chips then "+N more".
 *
 * In internal mode THE CELL IS THE CREATE AFFORDANCE (Google Calendar's
 * behaviour): a click anywhere in it that is not a chip, the "+N more" link
 * or the create button itself opens a draft on that day — on a populated day
 * as much as an empty one. That is the only create path a touch user has,
 * because the painted "+" is now invisible at rest and reveals on hover /
 * focus only; 42 of them at rest read as a second grid of controls laid over
 * the month. The button stays in the DOM and in the tab order regardless.
 */
export function CalendarMonthView({
  weeks,
  month,
  todayKey,
  itemsByDay,
  timezone,
  viewerTimezone,
  mode,
  onItemPress,
  onCreateAt,
  onShowMore,
  hasPopup = false,
  peekItemId,
  peekRenderKey,
  emptyLabel,
}: CalendarMonthViewProps) {
  const labels = useCalendarLabels();
  const creatable = mode === "internal" && Boolean(onCreateAt);
  const isEmpty = weeks.every((week) =>
    week.every((day) => (itemsByDay.get(day.key)?.length ?? 0) === 0),
  );

  const onCellClick = (event: MouseEvent<HTMLDivElement>, day: CalendarDay) => {
    if (!creatable) return;
    // Every interactive thing in a cell — chip, "+N more", the create
    // affordance — is a real <button>, so one check covers all of them. The
    // numeral is a <span> on purpose: it is part of the cell, and clicking it
    // creates.
    if ((event.target as HTMLElement).closest("button")) return;
    onCreateAt?.(day.start);
  };

  return (
    <div data-testid="calendar-month-grid" style={{ minWidth: 0 }}>
      <div
        role="presentation"
        style={{
          display: "grid",
          gridTemplateColumns: COLUMNS,
          borderBottom: `2px solid ${CAL_BORDER_STRONG}`,
        }}
      >
        {labels.weekdaysShort.map((label, i) => (
          <div key={i} style={{ padding: "8px 8px 6px", minWidth: 0 }}>
            <Mono size="xs" upper tone="muted">
              {label}
            </Mono>
          </div>
        ))}
      </div>

      <div style={{ position: "relative", minWidth: 0 }}>
        {weeks.map((week, wi) => (
          <div
            key={week[0]?.key ?? wi}
            style={{
              display: "grid",
              gridTemplateColumns: COLUMNS,
              borderBottom: wi === weeks.length - 1 ? undefined : `1px solid ${CAL_BORDER_SOFT}`,
            }}
          >
            {week.map((day, di) => {
              const inMonth = day.month === month;
              const isToday = todayKey !== null && day.key === todayKey;
              const items = itemsByDay.get(day.key) ?? [];
              const shown = items.slice(0, MONTH_CHIP_LIMIT);
              const overflow = items.length - shown.length;
              const longDay = formatLongDay(day, labels);
              return (
                <div
                  key={day.key}
                  className="th-cal-cell"
                  // The cell is the only thing carrying the DATE: a chip's
                  // accessible name is "8:00 PM House Night", so without this a
                  // screen reader never hears which day it belongs to.
                  role="group"
                  aria-label={longDay}
                  data-testid={`calendar-day-${day.key}`}
                  data-today={isToday ? "true" : undefined}
                  data-creatable={creatable ? "true" : undefined}
                  data-out-of-month={inMonth ? undefined : "true"}
                  onClick={(event) => onCellClick(event, day)}
                  style={{
                    // The create affordance is absolutely positioned against
                    // this box (calendar.css), which is what takes it out of
                    // the cell's height.
                    position: "relative",
                    minHeight: MONTH_CELL_MIN_HEIGHT_PX,
                    minWidth: 0,
                    padding: 6,
                    display: "flex",
                    flexDirection: "column",
                    gap: 3,
                    borderRight: di === 6 ? undefined : `1px solid ${CAL_BORDER_SOFT}`,
                    background: isToday ? CAL_TODAY_WASH : undefined,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 6, minHeight: 22 }}>
                    {isToday ? (
                      <>
                        <TodaySquare>
                          <Text variant="span" fontSize={13} lineHeight={16} weight="semibold" color="$onStructure">
                            {day.day}
                          </Text>
                        </TodaySquare>
                        <Mono size="2xs" upper color="$accentText">
                          {labels.today}
                        </Mono>
                      </>
                    ) : (
                      <Text
                        variant="span"
                        fontSize={13}
                        lineHeight={16}
                        weight="semibold"
                        tone={inMonth ? "default" : "muted"}
                        emphasis={inMonth ? "normal" : "subtle"}
                      >
                        {day.day}
                      </Text>
                    )}
                  </div>

                  {shown.map((item) => {
                    // A show that crosses midnight sits in two cells; the second
                    // is a spill (its own render key, `-${day.key}` test id).
                    const spill = !startsOnDay(item, day);
                    const renderKey = renderKeyFor(day, item);
                    return (
                      <CalendarChip
                        key={renderKey}
                        item={item}
                        timezone={timezone}
                        viewerTimezone={viewerTimezone}
                        mode={mode}
                        density="month"
                        continuation={spill}
                        onPress={onItemPress}
                        renderKey={renderKey}
                        testId={chipTestId(
                          item.kind === "hold" ? "calendar-hold-chip" : "calendar-event-chip",
                          item,
                          day,
                        )}
                        hasPopup={hasPopup}
                        expanded={
                          peekRenderKey != null ? peekRenderKey === renderKey : peekItemId === item.id
                        }
                      />
                    );
                  })}

                  {overflow > 0 && (
                    <button
                      type="button"
                      className="th-cal-btn th-cal-textlink"
                      data-testid={`calendar-more-${day.key}`}
                      aria-label={labels.moreOnDate(overflow, longDay)}
                      onClick={(event) => {
                        event.stopPropagation();
                        onShowMore?.(day);
                      }}
                      style={{ alignSelf: "flex-start", padding: "1px 0" }}
                    >
                      <Mono size="xs" upper color="$accentText">
                        {labels.plusMore(overflow)}
                      </Mono>
                    </button>
                  )}

                  {creatable && (
                    <button
                      type="button"
                      className="th-cal-btn th-cal-create"
                      aria-label={labels.createEventOn(longDay)}
                      data-testid={`calendar-day-create-${day.key}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        onCreateAt?.(day.start);
                      }}
                    >
                      <Plus size={12} aria-hidden />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        ))}

        {isEmpty && emptyLabel && <CalendarEmptyState label={emptyLabel} overlay />}
      </div>
    </div>
  );
}
