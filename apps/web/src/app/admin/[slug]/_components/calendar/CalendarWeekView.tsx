"use client";

import { useEffect, useRef, useState, type MouseEvent } from "react";
import { Text } from "@th/ui";
import { Plus } from "lucide-react";

import { CalendarChip } from "./CalendarChip";
import { Mono } from "./Mono";
import {
  HOUR_ROW_PX,
  WEEK_CHIP_MIN_PX,
  WEEK_MIN_COLUMN_PX,
  chipTestId,
  daySegments,
  formatHourLabel,
  formatLongDay,
  layoutWeekItems,
  renderKeyFor,
  visibleHours,
  wallMinutes,
  zoneAbbreviation,
  zonedInstant,
} from "./helpers";
import {
  CAL_ACCENT,
  CAL_BORDER,
  CAL_BORDER_SOFT,
  CAL_BORDER_STRONG,
  CAL_TODAY_WASH,
} from "./status-colors";
import type { CalendarDay, CalendarItem, CalendarMode, HoursWindow } from "./types";
import { useCalendarLabels } from "./use-calendar-labels";
import { CalendarEmptyState, TodaySquare, type ItemPressHandler } from "./view-shared";

const GUTTER = 56;
const MIN_COL = WEEK_MIN_COLUMN_PX;
const COLUMNS = `${GUTTER}px repeat(7, minmax(${MIN_COL}px, 1fr))`;

/**
 * FR-023: the price is a THIRD line inside an already-clipping block, so it
 * only paints when the block can carry it without pushing the title out.
 *
 * Height — the chip's own box, summed: 3px + 3px padding, the 13px time row,
 * a 1px gap, the 15px title, a 1px gap, and the 12px price line (9px mono at
 * the Mono ladder's 1.3 line-height) = 48px. Below that the third line would
 * be clipped by `overflow: hidden`, which reads as a rendering bug, not as
 * restraint. 48px is just over one hour row (44px), so a one-hour show shows
 * no price and anything 75 minutes or longer does.
 *
 * Width — `WEEK_CHIP_MIN_PX` (96px), the same floor `layoutWeekItems` uses to
 * decide how many overlapping blocks a column can hold. Narrower than that
 * and "From $15" truncates to "From…", which is worse than no price at all.
 * The measured column width is what feeds this, so a cascaded half-width
 * block in a 160px column correctly drops its price.
 */
export const WEEK_PRICE_MIN_HEIGHT_PX = 48;
export const WEEK_PRICE_MIN_WIDTH_PX = WEEK_CHIP_MIN_PX;

/**
 * The day column's real width, so `layoutWeekItems` can honour its px floor
 * instead of assuming the grid's minimum. 0 = never measured (SSR, jsdom, no
 * ResizeObserver), and the layout falls back to `MIN_COL`.
 */
function useDayColumnWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(MIN_COL);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect.width ?? 0;
      const next = box > 0 ? Math.max(MIN_COL, (box - GUTTER) / 7) : MIN_COL;
      setWidth((prev) => (Math.abs(prev - next) < 1 ? prev : next));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

export type CalendarWeekViewProps = {
  days: CalendarDay[];
  /** Null until the clock has mounted — no today wash / square before then. */
  todayKey: string | null;
  /** Wall clock for the now-line; null until mounted (SSR paints none). */
  now: Date | null;
  items: CalendarItem[];
  timezone: string;
  viewerTimezone: string;
  mode: CalendarMode;
  hoursWindow?: HoursWindow;
  showAllHours: boolean;
  onShowAllHours?: () => void;
  /** Footer caption, e.g. "Hours · Main Calendar · 5:00 PM – 2:00 AM · America/Chicago". */
  hoursCaption?: string;
  onItemPress?: ItemPressHandler;
  /** Internal only: empty-slot click at 30-minute resolution. */
  onCreateAt?: (date: Date) => void;
  /** A capped overlap group's "+N" slot → expand that day's list. */
  onShowMore?: (day: CalendarDay) => void;
  /** The engine owns a peek for these chips — sets `aria-haspopup`. */
  hasPopup?: boolean;
  /** @deprecated Superseded by `peekRenderKey`; kept for callers that pass it. */
  peekItemId?: string | null;
  /** The render key of the ONE chip whose peek is open. */
  peekRenderKey?: string | null;
  /** Copy for the in-frame empty state when the week paints nothing. */
  emptyLabel?: string;
};

/**
 * Week (FR-011): a 56px mono gutter, seven day columns on 44px hour rows,
 * hours from the venue window (union across the week, widened to every
 * painted segment) or auto-fit with a 09:00–24:00 floor, midnight-crossing
 * continuations in the next column, Google-style cascaded overlaps, a
 * now-line on today, and a "Show all hours" footer. Holds are date-level and
 * sit in an all-day strip above the hour grid — a hold painted at a clock
 * time would be a lie about the show.
 *
 * Each day header carries a focusable create affordance — the keyboard path
 * to a slot, landing on the window's first hour. It is invisible at rest and
 * reveals on that column header's hover or its own focus (seven painted "+"
 * glyphs across the header read as a toolbar the week does not have); its box
 * stays in flow, so the weekday label never shifts when it appears. Pointer
 * and touch users create by clicking any slot, which is unchanged.
 */
export function CalendarWeekView({
  days,
  todayKey,
  now,
  items,
  timezone,
  viewerTimezone,
  mode,
  hoursWindow,
  showAllHours,
  onShowAllHours,
  hoursCaption,
  onItemPress,
  onCreateAt,
  onShowMore,
  hasPopup = false,
  peekItemId,
  peekRenderKey,
  emptyLabel,
}: CalendarWeekViewProps) {
  const labels = useCalendarLabels();
  const creatable = mode === "internal" && Boolean(onCreateAt);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const dayColumnWidth = useDayColumnWidth(gridRef);
  const segmentsByDay = days.map((day) => daySegments(items, day, timezone));
  const hours = visibleHours(hoursWindow, segmentsByDay.flat(), showAllHours);
  const rowCount = Math.ceil((hours.endMinutes - hours.startMinutes) / 60);
  const bodyHeight = rowCount * HOUR_ROW_PX;
  const hourRows = Array.from({ length: rowCount }, (_, i) => hours.startMinutes + i * 60);
  const holdsByDay = days.map((day) =>
    items.filter(
      (item) => item.kind === "hold" && item.startsAt >= day.start && item.startsAt < day.end,
    ),
  );
  const anyHolds = holdsByDay.some((list) => list.length > 0);
  // Nothing at all in the painted week — neither an hour block nor a hold.
  const isEmpty = !anyHolds && segmentsByDay.every((segments) => segments.length === 0);

  const createAtMinutes = (day: CalendarDay, minutes: number) => {
    onCreateAt?.(
      zonedInstant(day.year, day.month, day.day, Math.floor(minutes / 60), minutes % 60, timezone),
    );
  };

  const onSlotClick = (event: MouseEvent<HTMLDivElement>, day: CalendarDay) => {
    if (!creatable) return;
    if ((event.target as HTMLElement).closest("button")) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const y = Math.max(0, event.clientY - rect.top);
    const minutes = hours.startMinutes + Math.floor((y / HOUR_ROW_PX) * 60 / 30) * 30;
    createAtMinutes(day, minutes);
  };

  const isExpanded = (renderKey: string, itemId: string) =>
    peekRenderKey != null ? peekRenderKey === renderKey : peekItemId === itemId;

  return (
    <div data-testid="calendar-week-grid" style={{ minWidth: 0 }}>
      <div style={{ position: "relative", minWidth: 0 }}>
        <div ref={gridRef} style={{ overflowX: "auto", width: "100%" }}>
          <div style={{ minWidth: GUTTER + MIN_COL * 7 }}>
            {/* Header */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: COLUMNS,
                borderBottom: `2px solid ${CAL_BORDER_STRONG}`,
              }}
            >
              <div style={{ padding: "8px 6px 6px", textAlign: "right" }}>
                <Mono size="xs" upper tone="muted" data-testid="calendar-week-zone">
                  {zoneAbbreviation(days[0]?.start ?? new Date(), timezone)}
                </Mono>
              </div>
              {days.map((day) => {
                const isToday = todayKey !== null && day.key === todayKey;
                return (
                  <div
                    key={day.key}
                    className="th-cal-weekhead"
                    data-testid={`calendar-week-header-${day.key}`}
                    data-today={isToday ? "true" : undefined}
                    style={{
                      padding: "6px 8px 6px",
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      minWidth: 0,
                      borderLeft: `1px solid ${CAL_BORDER_SOFT}`,
                      background: isToday ? CAL_TODAY_WASH : undefined,
                    }}
                  >
                    <Mono size="xs" upper tone="muted">
                      {labels.weekdaysShort[day.weekday]}
                    </Mono>
                    {isToday ? (
                      <TodaySquare>
                        <Text variant="span" fontSize={13} lineHeight={16} weight="semibold" color="$onStructure">
                          {day.day}
                        </Text>
                      </TodaySquare>
                    ) : (
                      <Text variant="span" fontSize={13} lineHeight={16} weight="semibold">
                        {day.day}
                      </Text>
                    )}
                    {creatable && (
                      <button
                        type="button"
                        className="th-cal-btn th-cal-create"
                        data-inline="true"
                        aria-label={labels.createEventOn(formatLongDay(day, labels))}
                        data-testid={`calendar-week-create-${day.key}`}
                        onClick={() => createAtMinutes(day, hours.startMinutes)}
                      >
                        <Plus size={12} aria-hidden />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>

            {/* All-day holds strip */}
            {anyHolds && (
              <div
                data-testid="calendar-week-holds"
                style={{
                  display: "grid",
                  gridTemplateColumns: COLUMNS,
                  borderBottom: `1px solid ${CAL_BORDER_SOFT}`,
                }}
              >
                <div style={{ padding: "6px 6px", textAlign: "right" }}>
                  <Mono size="2xs" upper tone="muted">
                    {labels.holds}
                  </Mono>
                </div>
                {days.map((day, i) => (
                  <div
                    key={day.key}
                    style={{
                      padding: 4,
                      display: "flex",
                      flexDirection: "column",
                      gap: 3,
                      minWidth: 0,
                      borderLeft: `1px solid ${CAL_BORDER_SOFT}`,
                      background: todayKey !== null && day.key === todayKey ? CAL_TODAY_WASH : undefined,
                    }}
                  >
                    {holdsByDay[i]!.map((hold) => {
                      const renderKey = renderKeyFor(day, hold);
                      return (
                        <CalendarChip
                          key={renderKey}
                          item={hold}
                          timezone={timezone}
                          viewerTimezone={viewerTimezone}
                          mode={mode}
                          density="month"
                          onPress={onItemPress}
                          renderKey={renderKey}
                          testId={chipTestId("calendar-hold-chip", hold, day)}
                          hasPopup={hasPopup}
                          expanded={isExpanded(renderKey, hold.id)}
                        />
                      );
                    })}
                  </div>
                ))}
              </div>
            )}

            {/* Hour grid */}
            <div style={{ display: "grid", gridTemplateColumns: COLUMNS }}>
              <div style={{ position: "relative", height: bodyHeight }}>
                {hourRows.map((minutes, i) => (
                  <div
                    key={minutes}
                    style={{
                      height: HOUR_ROW_PX,
                      paddingRight: 6,
                      paddingTop: 2,
                      textAlign: "right",
                      borderBottom: i === hourRows.length - 1 ? undefined : `1px solid ${CAL_BORDER_SOFT}`,
                    }}
                  >
                    <Mono
                      size="xs"
                      upper
                      tone="muted"
                      data-testid="calendar-hour-label"
                      style={{ whiteSpace: "nowrap" }}
                    >
                      {formatHourLabel(minutes)}
                    </Mono>
                  </div>
                ))}
              </div>

              {days.map((day, i) => {
                const isToday = todayKey !== null && day.key === todayKey;
                const { placed, overflows } = layoutWeekItems(
                  segmentsByDay[i]!,
                  hours,
                  dayColumnWidth,
                );
                const nowMinutes = now && isToday ? wallMinutes(now, day, timezone) : null;
                const showNow =
                  nowMinutes !== null &&
                  nowMinutes >= hours.startMinutes &&
                  nowMinutes <= hours.endMinutes;
                return (
                  <div
                    key={day.key}
                    className="th-cal-slot"
                    data-testid={isToday ? "calendar-week-col-today" : `calendar-week-col-${day.key}`}
                    data-creatable={creatable ? "true" : undefined}
                    onClick={(event) => onSlotClick(event, day)}
                    style={{
                      position: "relative",
                      height: bodyHeight,
                      minWidth: 0,
                      borderLeft: `1px solid ${CAL_BORDER_SOFT}`,
                      background: isToday ? CAL_TODAY_WASH : undefined,
                    }}
                  >
                    {hourRows.map((minutes, r) => (
                      <div
                        key={minutes}
                        aria-hidden
                        style={{
                          position: "absolute",
                          top: r * HOUR_ROW_PX,
                          left: 0,
                          right: 0,
                          height: HOUR_ROW_PX,
                          borderBottom: r === hourRows.length - 1 ? undefined : `1px solid ${CAL_BORDER_SOFT}`,
                          pointerEvents: "none",
                        }}
                      />
                    ))}

                    {placed.map((p) => {
                      const renderKey = renderKeyFor(day, p.item, p.continuation);
                      const blockHeight = Math.max((p.height / 60) * HOUR_ROW_PX, 22);
                      const blockWidth = (p.widthPercent / 100) * dayColumnWidth;
                      const priceLine =
                        p.item.kind === "event" &&
                        !p.continuation &&
                        blockHeight >= WEEK_PRICE_MIN_HEIGHT_PX &&
                        blockWidth >= WEEK_PRICE_MIN_WIDTH_PX
                          ? (p.item.priceLabel ?? null)
                          : null;
                      return (
                        <CalendarChip
                          key={renderKey}
                          item={p.item}
                          timezone={timezone}
                          viewerTimezone={viewerTimezone}
                          mode={mode}
                          density="week"
                          continuation={p.continuation}
                          onPress={onItemPress}
                          renderKey={renderKey}
                          testId={chipTestId("calendar-event-chip", p.item, day, p.continuation)}
                          hasPopup={hasPopup}
                          expanded={isExpanded(renderKey, p.item.id)}
                          // A block sharing its group draws a paper edge on its
                          // left so the columns read as separate cards.
                          separated={p.leftPercent > 0}
                          priceLine={priceLine}
                          style={{
                            position: "absolute",
                            top: (p.top / 60) * HOUR_ROW_PX,
                            height: blockHeight,
                            left: `${p.leftPercent}%`,
                            width: `calc(${p.widthPercent}% - 2px)`,
                            zIndex: p.zIndex,
                            minWidth: 0,
                            overflow: "hidden",
                          }}
                        />
                      );
                    })}

                    {/* One per capped group, so a day can carry several. */}
                    {overflows.map((o, oi) => (
                      <button
                        key={o.top}
                        type="button"
                        className="th-cal-btn th-cal-week-more"
                        data-testid={`calendar-week-more-${day.key}-${oi}`}
                        aria-label={labels.moreOnDate(o.count, formatLongDay(day, labels))}
                        onClick={(event) => {
                          event.stopPropagation();
                          onShowMore?.(day);
                        }}
                        style={{
                          position: "absolute",
                          top: (o.top / 60) * HOUR_ROW_PX,
                          height: Math.max((o.height / 60) * HOUR_ROW_PX, 22),
                          left: `${o.leftPercent}%`,
                          width: `calc(${o.widthPercent}% - 2px)`,
                          zIndex: 4,
                        }}
                      >
                        <Mono size="2xs" upper color="$accentText" truncate>
                          {labels.plusMore(o.count)}
                        </Mono>
                      </button>
                    ))}

                    {showNow && (
                      <div
                        aria-hidden
                        data-testid="calendar-now-line"
                        style={{
                          position: "absolute",
                          left: 0,
                          right: 0,
                          top: ((nowMinutes - hours.startMinutes) / 60) * HOUR_ROW_PX,
                          height: 2,
                          background: CAL_ACCENT,
                          zIndex: 5,
                          pointerEvents: "none",
                        }}
                      >
                        <span
                          style={{
                            position: "absolute",
                            left: 0,
                            top: -3,
                            width: 8,
                            height: 8,
                            background: CAL_ACCENT,
                          }}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Centred over the SCROLLER, not over its 896px min-width content:
            at phone width the message must land in the visible box. */}
        {isEmpty && emptyLabel && <CalendarEmptyState label={emptyLabel} overlay />}
      </div>

      {/* Footer */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) auto",
          alignItems: "center",
          gap: 12,
          padding: "8px 16px",
          borderTop: `2px solid ${CAL_BORDER}`,
        }}
      >
        <Mono size="xs" upper tone="muted" truncate data-testid="calendar-hours-caption">
          {hoursCaption ?? ""}
        </Mono>
        <button
          type="button"
          className="th-cal-btn th-cal-textlink"
          data-testid="calendar-show-all-hours"
          aria-pressed={showAllHours}
          onClick={onShowAllHours}
          style={{ minHeight: 28 }}
        >
          <Mono size="xs" upper color="$accentText">
            {showAllHours ? labels.showVenueHours : labels.showAllHours}
          </Mono>
        </button>
      </div>
    </div>
  );
}
