"use client";

import { Text } from "@th/ui";

import { Mono } from "./Mono";
import { formatLongDay } from "./helpers";
import {
  CAL_ACCENT,
  CAL_BORDER,
  CAL_BORDER_SOFT,
  CAL_BORDER_STRONG,
  CAL_INK,
  CAL_ON_INK,
} from "./status-colors";
import type { CalendarDay, CalendarItem } from "./types";
import { useCalendarLabels } from "./use-calendar-labels";

export type CalendarDotGridProps = {
  weeks: CalendarDay[][];
  /** 1–12. */
  month: number;
  /** Null until the clock has mounted — no today ring is painted before then. */
  todayKey: string | null;
  selectedKey: string | null;
  onSelectDay: (day: CalendarDay) => void;
  itemsByDay: Map<string, CalendarItem[]>;
};

function Dot({ item }: { item: CalendarItem }) {
  if (item.kind === "hold") {
    return (
      <span
        data-dot="hold"
        style={{ width: 7, height: 7, border: `1.5px dashed ${CAL_BORDER}`, flexShrink: 0 }}
      />
    );
  }
  return (
    <span
      data-dot={item.status === "PUBLISHED" ? "published" : "other"}
      style={{
        width: 5,
        height: 5,
        background: item.status === "PUBLISHED" ? CAL_ACCENT : CAL_INK,
        flexShrink: 0,
      }}
    />
  );
}

/**
 * The <600px month (FR-010): seven columns of 48px day buttons, the number in
 * a 28px square (selected = ink fill; today = accent inset ring), up to
 * three 5px dots beneath. Tapping a day drives `CalendarDayList`. Plain
 * buttons in a plain grid — each carries its full name, so no grid/row roles.
 */
export function CalendarDotGrid({
  weeks,
  month,
  todayKey,
  selectedKey,
  onSelectDay,
  itemsByDay,
}: CalendarDotGridProps) {
  const labels = useCalendarLabels();
  return (
    <div data-testid="calendar-month-dotgrid" style={{ minWidth: 0 }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(7, minmax(0, 1fr))",
          borderBottom: `2px solid ${CAL_BORDER_STRONG}`,
        }}
      >
        {labels.weekdaysShort.map((label, i) => (
          <div key={i} style={{ padding: "8px 0 6px", textAlign: "center" }}>
            <Mono size="xs" upper tone="muted">
              {label.slice(0, 1)}
            </Mono>
          </div>
        ))}
      </div>
      {weeks.map((week, wi) => (
        <div
          key={week[0]?.key ?? wi}
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(7, minmax(0, 1fr))",
            borderBottom: wi === weeks.length - 1 ? undefined : `1px solid ${CAL_BORDER_SOFT}`,
          }}
        >
          {week.map((day) => {
            const items = itemsByDay.get(day.key) ?? [];
            const selected = day.key === selectedKey;
            const isToday = todayKey !== null && day.key === todayKey;
            const inMonth = day.month === month;
            return (
              <button
                key={day.key}
                type="button"
                className="th-cal-btn th-cal-dot-day"
                aria-pressed={selected}
                aria-label={`${formatLongDay(day, labels)}, ${labels.itemCount(items.length)}`}
                data-testid={`calendar-dot-${day.key}`}
                data-today={isToday ? "true" : undefined}
                onClick={() => onSelectDay(day)}
                style={{ minHeight: 48, padding: "4px 0" }}
              >
                <span
                  className="th-cal-dot-num"
                  style={{
                    width: 28,
                    height: 28,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    background: selected ? CAL_INK : "transparent",
                    color: selected ? CAL_ON_INK : undefined,
                    boxShadow: isToday && !selected ? `inset 0 0 0 2px ${CAL_ACCENT}` : undefined,
                  }}
                >
                  <Text
                    variant="span"
                    fontSize={13}
                    lineHeight={16}
                    weight="semibold"
                    tone={selected ? "inherit" : inMonth ? "default" : "muted"}
                    emphasis={inMonth || selected ? "normal" : "subtle"}
                  >
                    {day.day}
                  </Text>
                </span>
                <span aria-hidden style={{ display: "flex", gap: 3, height: 7, alignItems: "center" }}>
                  {items.slice(0, 3).map((item) => (
                    <Dot key={item.id} item={item} />
                  ))}
                </span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
