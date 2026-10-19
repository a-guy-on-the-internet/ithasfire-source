"use client";

import type { ReactNode } from "react";
import { Button, MenuButton, SegmentedControl, Text } from "@th/ui";
import { ChevronLeft, ChevronRight, MoreHorizontal } from "lucide-react";

import { Mono } from "./Mono";
import { CAL_BORDER } from "./status-colors";
import type { CalendarOverflowAction, CalendarView } from "./types";
import { useCalendarLabels } from "./use-calendar-labels";

export type CalendarToolbarProps = {
  view: CalendarView;
  views: CalendarView[];
  onViewChange: (view: CalendarView) => void;
  rangeLabel: string;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
  /** Agenda rolls from today — prev / next are hidden (FR-009). */
  showNav?: boolean;
  /** IANA name of the paint zone; omitted when the mount uses the slot itself. */
  timezone?: string;
  overflowActions?: CalendarOverflowAction[];
  leading?: ReactNode;
  trailing?: ReactNode;
  /** The engine's box is under 600px — every cluster is free to reflow. */
  narrow?: boolean;
};

/**
 * The single toolbar row (FR-017): prev / next / Today + the mono range label
 * on the left; the view SegmentedControl, the timezone label and the overflow
 * menu on the right.
 *
 * When it cannot hold one row the wrap is DELIBERATE: the two clusters break
 * against each other — navigation stays whole on the first row, the control
 * cluster stays whole and right-aligned on the second — rather than letting
 * the timezone label and the overflow button peel off one at a time. (A week
 * range, "AUG 30 – SEP 5, 2026", is materially wider than "SEPTEMBER 2026",
 * so the same toolbar wraps in week and not in month.)
 *
 * Below 600px the control cluster may wrap, but only as a last resort: the
 * timezone label has a zero flex basis, so it never forces a break and takes
 * whatever room is left (short form, truncating first). When the segmented
 * control and the overflow button alone no longer fit (320px, Spanish), the
 * overflow button wraps to a second row, right-aligned. That is an accepted
 * trade-off: the old nowrap row overflowed LEFT over the card border.
 *
 * That only holds while some of the word survives. Once the deficit exceeds
 * the whole label the truncation stops being a label at all — on the dashboard
 * at 390px it painted 1.53px of a "C" against the overflow button. The ENGINE
 * withholds `timezone` below `CALENDAR_TIGHT_PX` for exactly that reason, so a
 * toolbar mounted standalone (this component is exported) has to make the same
 * call for itself.
 */
/**
 * "America/Chicago" → "Chicago". The full IANA name is ~120px of the ~305px a
 * 375px toolbar has for its control cluster; the city alone is unambiguous
 * enough at that width, and the label keeps the full name as its accessible
 * name and in the week's hours caption.
 */
function shortZone(timezone: string): string {
  const tail = timezone.split("/").pop() ?? timezone;
  return tail.replace(/_/g, " ");
}

export function CalendarToolbar({
  view,
  views,
  onViewChange,
  rangeLabel,
  onPrev,
  onNext,
  onToday,
  showNav = true,
  timezone,
  overflowActions,
  leading,
  trailing,
  narrow = false,
}: CalendarToolbarProps) {
  const labels = useCalendarLabels();
  const options = views.map((v) => ({ value: v, label: labels.views[v] }));
  return (
    <div
      data-testid="calendar-toolbar"
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 12,
        padding: "12px 16px",
        borderBottom: `2px solid ${CAL_BORDER}`,
        minWidth: 0,
      }}
    >
      <div
        data-testid="calendar-toolbar-nav"
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 8,
          minWidth: 0,
          flexShrink: 1,
        }}
      >
        {leading}
        {showNav && (
          <>
            <Button
              variant="secondary"
              icon
              height={38}
              minWidth={38}
              width={38}
              aria-label={labels.previous}
              data-testid="calendar-nav-prev"
              onPress={onPrev}
            >
              <ChevronLeft size={16} aria-hidden />
            </Button>
            <Button
              variant="secondary"
              icon
              height={38}
              minWidth={38}
              width={38}
              aria-label={labels.next}
              data-testid="calendar-nav-next"
              onPress={onNext}
            >
              <ChevronRight size={16} aria-hidden />
            </Button>
          </>
        )}
        <Button
          variant="secondary"
          height={38}
          fontSize={12}
          data-testid="calendar-nav-today"
          onPress={onToday}
        >
          {labels.today}
        </Button>
        <Mono
          upper
          fontSize={15}
          letterSpacing={1.5}
          lineHeight={20}
          aria-live="polite"
          data-testid="calendar-nav-label"
          style={{ minWidth: 0 }}
        >
          {rangeLabel}
        </Mono>
      </div>

      <div
        data-testid="calendar-toolbar-controls"
        style={{
          display: "flex",
          // Wide: one cluster, one break. Narrow: the zone label is the elastic
          // part (basis 0, below), so the cluster stays on one row until the
          // segmented control and the overflow button alone no longer fit;
          // then the button wraps. A nowrap row here overflowed to the LEFT
          // (justify flex-end) over the card border at 320px in Spanish.
          flexWrap: narrow ? "wrap" : "nowrap",
          rowGap: 8,
          alignItems: "center",
          justifyContent: "flex-end",
          gap: narrow ? 8 : 12,
          marginLeft: "auto",
          minWidth: 0,
          flexShrink: narrow ? 1 : 0,
        }}
      >
        {options.length > 1 && (
          <div data-testid="calendar-view-mode-toggle">
            <SegmentedControl
              options={options}
              value={view}
              onChange={onViewChange}
              ariaLabel={labels.viewGroup}
              testIdBase="calendar-view"
            />
          </div>
        )}
        {trailing && (
          // The mount's slot (the place calendar's selector) is the one part
          // of this cluster whose width is content-driven — a long calendar
          // name must truncate inside it, not widen a nowrap row.
          <span
            data-testid="calendar-toolbar-trailing"
            style={{ display: "inline-flex", minWidth: 0, flexShrink: 1, maxWidth: 240 }}
          >
            {trailing}
          </span>
        )}
        {timezone && (
          <Text
            variant="overline"
            tone="muted"
            textTransform="none"
            truncate
            aria-label={timezone}
            data-testid="calendar-timezone"
            minWidth={0}
            flexShrink={1}
            {...(narrow ? { flexGrow: 1, flexBasis: "0%", textAlign: "right" } : {})}
          >
            {narrow ? shortZone(timezone) : timezone}
          </Text>
        )}
        {overflowActions && overflowActions.length > 0 && (
          <MenuButton
            label=""
            icon={<MoreHorizontal size={16} aria-hidden />}
            items={overflowActions.map((a) => ({
              label: a.label,
              icon: a.icon,
              onSelect: a.onSelect,
            }))}
            align="right"
            variant="secondary"
            height={38}
            width={38}
            minWidth={38}
            paddingHorizontal={0}
            aria-label={labels.more}
            testId="calendar-overflow"
          />
        )}
      </div>
    </div>
  );
}
