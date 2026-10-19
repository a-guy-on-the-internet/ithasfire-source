"use client";

import { forwardRef } from "react";
import { Text } from "@th/ui";
import { ChevronRight, Globe, Repeat } from "lucide-react";

import { Mono } from "./Mono";
import {
  chipAccessibleName,
  chipTestId,
  dayCountLabel,
  formatDayHeading,
  formatDuration,
  formatSold,
  formatTimeRange,
  renderKeyFor,
  tzMismatch,
  venueLocalTime,
} from "./helpers";
import { CAL_BORDER, CAL_MUTED, STATUS_BAR } from "./status-colors";
import type { CalendarDay, CalendarItem, CalendarMode } from "./types";
import { useCalendarLabels } from "./use-calendar-labels";
import {
  CalendarEmptyState,
  HoldLineTag,
  HoldTag,
  StatusTag,
  type ItemPressHandler,
} from "./view-shared";

const ROW_COLUMNS = "150px minmax(0, 1fr) 110px 128px 40px";
const ROW_COLUMNS_COMPACT = "88px minmax(0, 1fr) 40px";
/**
 * Public mode drops the sold/capacity and status-tag tracks entirely — both
 * are internal facts (see the `internal` guard on the cells themselves), and
 * leaving their tracks in place would strand 238px of empty grid.
 */
const ROW_COLUMNS_PUBLIC = "150px minmax(0, 1fr) 40px";

/**
 * The wide template's fixed tracks add up to 428px, which is more than the
 * engine gets at phone width. `compact` is the intended answer (the engine
 * measures its OWN box, not the viewport), but the row also refuses to leak:
 * a grid whose tracks outgrow its box would otherwise push the whole page
 * sideways — that was the 500px-wide document at a 320px viewport.
 */
const ROW_CONTAINMENT = {
  maxWidth: "100%",
  minWidth: 0,
  overflow: "hidden",
} as const;

export type CalendarAgendaViewProps = {
  days: CalendarDay[];
  /** Null until the clock has mounted — no Today / Tomorrow word before then. */
  todayKey: string | null;
  itemsByDay: Map<string, CalendarItem[]>;
  timezone: string;
  viewerTimezone: string;
  mode: CalendarMode;
  onItemPress?: ItemPressHandler;
  hasMore?: boolean;
  onShowMore?: () => void;
  /** "Sep 13 – Oct 2" — appended to the Show more label. */
  nextPageLabel?: string;
  /** Below 600px: the row collapses to time / title / chevron. */
  compact?: boolean;
  /** The engine owns a peek for these rows — sets `aria-haspopup`. */
  hasPopup?: boolean;
  /** @deprecated Superseded by `peekRenderKey`; kept for callers that pass it. */
  peekItemId?: string | null;
  /** The render key of the ONE row whose peek is open. */
  peekRenderKey?: string | null;
  /** Empty-state copy for the page window. */
  emptyLabel?: string;
};

type RowProps = {
  item: CalendarItem;
  day: CalendarDay;
  timezone: string;
  viewerTimezone: string;
  compact: boolean;
  /**
   * Internal mode. Gates the two INTERNAL facts on the row: the workflow
   * status tag and the sold/capacity count. Neither belongs on a public
   * surface — "Published · 12 / 80" tells a ticket buyer nothing and tells a
   * competitor how the night is selling.
   */
  internal: boolean;
  onItemPress?: ItemPressHandler;
  expanded?: boolean;
  hasPopup: boolean;
};

// forwardRef so the engine's peek Popover can anchor to the row button.
const Row = forwardRef<HTMLButtonElement, RowProps>(function Row(
  { item, day, timezone, viewerTimezone, compact, internal, onItemPress, expanded, hasPopup },
  ref,
) {
  const labels = useCalendarLabels();
  const columns = compact
    ? ROW_COLUMNS_COMPACT
    : internal
      ? ROW_COLUMNS
      : ROW_COLUMNS_PUBLIC;
  const renderKey = renderKeyFor(day, item);
  const popupProps = hasPopup
    ? { "aria-haspopup": "dialog" as const, "aria-expanded": Boolean(expanded) }
    : {};

  if (item.kind === "hold") {
    const place = [item.venueName, item.spaceName].filter(Boolean).join(" · ");
    return (
      <button
        type="button"
        ref={ref}
        className="th-cal-btn th-cal-row"
        data-testid={chipTestId("calendar-agenda-row", item, day)}
        data-kind="hold"
        data-render-key={renderKey}
        aria-label={chipAccessibleName(item, timezone, labels)}
        {...popupProps}
        onClick={(event) => onItemPress?.(item, event.currentTarget, renderKey)}
        style={{ ...ROW_CONTAINMENT, gridTemplateColumns: columns, minHeight: 58, paddingRight: 12 }}
      >
        <span style={{ display: "flex", alignItems: "center", paddingLeft: 15 }}>
          <HoldLineTag position={item.position} />
        </span>
        <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, padding: "8px 12px 8px 0" }}>
          <Text variant="span" fontSize={15} lineHeight={19} weight="semibold" truncate>
            {item.title}
          </Text>
          {(place || compact) && (
            <Text variant="bodySmall" tone="muted" truncate>
              {compact ? [place, labels.holdStatuses[item.status]].filter(Boolean).join(" · ") : place}
            </Text>
          )}
        </span>
        {!compact && internal && <span />}
        {!compact && internal && (
          <span style={{ display: "flex", justifyContent: "flex-start" }}>
            <HoldTag status={item.status} />
          </span>
        )}
        <ChevronRight size={16} color={CAL_MUTED} aria-hidden style={{ justifySelf: "end" }} />
      </button>
    );
  }

  const mismatch = tzMismatch(item, viewerTimezone);
  const duration = formatDuration(item.startsAt, item.endsAt);
  const secondLine = mismatch ? venueLocalTime(item) : duration;
  const meta = [item.venueName, item.ownerName].filter(Boolean).join(" · ");
  const repeat = Boolean(item.seriesId || item.occurrence);

  return (
    <button
      type="button"
      ref={ref}
      className="th-cal-btn th-cal-row"
      data-testid={chipTestId("calendar-agenda-row", item, day)}
      data-kind="event"
      data-status={item.status}
      data-render-key={renderKey}
      aria-label={chipAccessibleName(item, timezone, labels)}
      {...popupProps}
      onClick={(event) => onItemPress?.(item, event.currentTarget, renderKey)}
      style={{ ...ROW_CONTAINMENT, gridTemplateColumns: columns, minHeight: 58, paddingRight: 12 }}
    >
      <span style={{ display: "flex", alignItems: "stretch", gap: 12, alignSelf: "stretch", minWidth: 0 }}>
        <span aria-hidden style={{ width: 3, flexShrink: 0, background: STATUS_BAR[item.status] }} />
        <span
          style={{
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            gap: 2,
            padding: "8px 0",
            minWidth: 0,
          }}
        >
          <span style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 0 }}>
            {mismatch && (
              <Globe
                size={11}
                role="img"
                aria-label={labels.venueLocal(venueLocalTime(item))}
                style={{ flexShrink: 0, color: "currentColor" }}
              />
            )}
            <Mono size="md" truncate>
              {compact
                ? formatTimeRange(item.startsAt, null, timezone)
                : formatTimeRange(item.startsAt, item.endsAt, timezone)}
            </Mono>
          </span>
          {secondLine && (
            <Mono size="xs" tone="muted" truncate>
              {secondLine}
            </Mono>
          )}
        </span>
      </span>

      <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, padding: "8px 12px 8px 0" }}>
        <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
          <Text variant="span" fontSize={15} lineHeight={19} weight="semibold" truncate>
            {item.title}
          </Text>
          {repeat && (
            <Repeat
              size={12}
              role="img"
              aria-label={
                item.occurrence
                  ? labels.dateOf(item.occurrence.index, item.occurrence.total)
                  : labels.series
              }
              style={{ flexShrink: 0, color: CAL_MUTED }}
            />
          )}
        </span>
        {(meta || (compact && internal)) && (
          <Text variant="bodySmall" tone="muted" truncate>
            {compact && internal ? [meta, formatSold(item)].filter(Boolean).join(" · ") : meta}
          </Text>
        )}
      </span>

      {!compact && internal && (
        <Mono size="lg" data-testid={`calendar-agenda-sold-${item.id}`}>
          {formatSold(item)}
        </Mono>
      )}
      {!compact && internal && (
        <span style={{ display: "flex", justifyContent: "flex-start" }}>
          <StatusTag status={item.status} />
        </span>
      )}
      <ChevronRight size={16} color={CAL_MUTED} aria-hidden style={{ justifySelf: "end" }} />
    </button>
  );
});

/**
 * Rolling agenda (FR-009): today through the page end, grouped by day with
 * a mono heading on a 2px ink rule, table-like rows on a fixed/fluid grid,
 * sold/capacity in mono, a status tag, and a centred "Show more" footer.
 */
export function CalendarAgendaView({
  days,
  todayKey,
  itemsByDay,
  timezone,
  viewerTimezone,
  mode,
  onItemPress,
  hasMore = false,
  onShowMore,
  nextPageLabel,
  compact = false,
  hasPopup = false,
  peekItemId,
  peekRenderKey,
  emptyLabel,
}: CalendarAgendaViewProps) {
  const labels = useCalendarLabels();
  const groups = days
    .map((day) => ({ day, items: itemsByDay.get(day.key) ?? [] }))
    .filter((g) => g.items.length > 0);
  const publicOnly = mode === "public";

  return (
    <div data-testid="calendar-agenda" style={{ minWidth: 0 }}>
      {groups.length === 0 && <CalendarEmptyState label={emptyLabel ?? labels.emptyWindow} />}

      {groups.map(({ day, items }) => {
        const heading = formatDayHeading(day, todayKey, timezone, labels);
        const relative =
          heading.relative === "today"
            ? labels.today
            : heading.relative === "tomorrow"
              ? labels.tomorrow
              : null;
        return (
          <section key={day.key} data-testid={`calendar-agenda-day-${day.key}`} aria-label={heading.label}>
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
                {relative ? `${heading.label} · ${relative}` : heading.label}
              </Mono>
              <Mono size="xs" tone="muted">
                {dayCountLabel(items, labels)}
              </Mono>
            </div>
            {items.map((item) => {
              if (publicOnly && item.kind === "hold") return null;
              const renderKey = renderKeyFor(day, item);
              return (
                <Row
                  key={renderKey}
                  item={item}
                  day={day}
                  timezone={timezone}
                  viewerTimezone={viewerTimezone}
                  compact={compact}
                  internal={!publicOnly}
                  onItemPress={onItemPress}
                  hasPopup={hasPopup}
                  expanded={
                    peekRenderKey != null ? peekRenderKey === renderKey : peekItemId === item.id
                  }
                />
              );
            })}
          </section>
        );
      })}

      {hasMore && (
        <div style={{ display: "flex", justifyContent: "center", padding: 16 }}>
          <button
            type="button"
            className="th-cal-btn th-cal-action th-cal-action--wrap"
            data-testid="calendar-agenda-show-more"
            onClick={onShowMore}
          >
            {nextPageLabel ? labels.showMoreRange(nextPageLabel) : labels.showMore}
          </button>
        </div>
      )}
    </div>
  );
}
