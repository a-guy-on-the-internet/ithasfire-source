"use client";

import {
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Stack, XStack, YStack, styled } from "tamagui";

import { Text } from "../typography/Text";

export interface RangeCalendarProps {
  start?: string;
  end?: string;
  min?: string;
  max?: string;
  disabled?: boolean;
  onSelect(boundary: CalendarBoundary, date: string): void;
  startSlot?: ReactNode;
  endSlot?: ReactNode;
  orientation?: "horizontal" | "vertical";
  mode?: "range" | "single";
}

type CalendarBoundary = "start" | "end";

const WEEKDAY_LABELS = [
  "Sun",
  "Mon",
  "Tue",
  "Wed",
  "Thu",
  "Fri",
  "Sat",
] as const;
const DAY_CELL_SIZE = 44;
const CALENDAR_COLUMNS = WEEKDAY_LABELS.length;
const MONTH_WIDTH = DAY_CELL_SIZE * CALENDAR_COLUMNS;
const HORIZONTAL_WIDTH = MONTH_WIDTH * 2 + 24;

const focusRing = {
  outlineWidth: 2,
  outlineStyle: "solid" as const,
  outlineColor: "$focus",
  outlineOffset: 2,
};

const CalendarFrame = styled(YStack, {
  name: "RangeCalendar",
  gap: "$4",
  padding: "$3",
  borderRadius: 0,
  borderWidth: 2,
  borderColor: "$borderColor",
  backgroundColor: "$surface",
  boxSizing: "border-box",
  variants: {
    orientation: {
      horizontal: {
        width: "fit-content",
        minWidth: HORIZONTAL_WIDTH,
        maxWidth: "100%",
      },
      vertical: {
        width: "fit-content",
        minWidth: MONTH_WIDTH,
        maxWidth: "100%",
      },
    },
  },
  defaultVariants: {
    orientation: "horizontal",
  },
});

const DualMonthLayout = styled(XStack, {
  gap: 24,
  alignItems: "stretch",
  variants: {
    orientation: {
      horizontal: {
        width: "fit-content",
        minWidth: HORIZONTAL_WIDTH,
        flexDirection: "row",
        flexWrap: "nowrap",
        overflowX: "visible",
        justifyContent: "space-between",
      },
      vertical: {
        width: "fit-content",
        minWidth: MONTH_WIDTH,
        flexDirection: "column",
        flexWrap: "nowrap",
      },
    },
  },
  defaultVariants: {
    orientation: "horizontal",
  },
} as const);

const MonthColumn = styled(YStack, {
  gap: "$4",
  width: MONTH_WIDTH,
  minWidth: MONTH_WIDTH,
  maxWidth: MONTH_WIDTH,
  variants: {
    orientation: {
      horizontal: {
        width: MONTH_WIDTH,
      },
      vertical: {
        width: MONTH_WIDTH,
        maxWidth: "100%",
      },
    },
  },
  defaultVariants: {
    orientation: "horizontal",
  },
});

const SlotWrapper = styled(Stack, {
  width: "100%",
});

const MonthHeader = styled(XStack, {
  alignItems: "center",
  justifyContent: "space-between",
});

const HeaderControls = styled(XStack, {
  gap: "$2",
});

const NavButton = styled(Stack, {
  name: "RangeCalendarNavButton",
  width: 40,
  height: 40,
  borderRadius: 0,
  borderWidth: 2,
  borderColor: "$borderColor",
  alignItems: "center",
  justifyContent: "center",
  cursor: "pointer",
  backgroundColor: "$surface",
  // Soft-chrome hover (design-system v2 §4): these arrows are the frame around
  // the calendar, not content, so they get a subtle raised wash + an accent
  // border rather than a decisive inversion. The fill must NOT be
  // `$surfaceStrong`: it resolves to the ink itself on Stub (#211C16 ===
  // `$color`), and the chevron inherits ink via the child button's inline
  // `color: currentColor` — which beats any class-based hover color Tamagui
  // could set, so the icon cannot follow the fill. That pairing rendered an
  // ink chevron on an ink fill (1.00:1 — invisible). `$borderColorHover` is
  // the accent in all three themes and is the real affordance here; the old
  // `$borderColorStrong` was #211C16 -> #000000 on Stub, i.e. no visible
  // change, which is why the (broken) fill was carrying the whole hover.
  hoverStyle: {
    backgroundColor: "$surfaceMuted",
    borderColor: "$borderColorHover",
  },
  focusStyle: focusRing,
  variants: {
    disabled: {
      true: {
        opacity: 0.3,
        cursor: "not-allowed",
        pointerEvents: "none",
      },
    },
  },
} as const);

const DayTable = styled(XStack, {
  flexWrap: "wrap",
  width: MONTH_WIDTH,
  gap: 0,
});

const DayHeaderCell = styled(Stack, {
  height: 32,
  width: DAY_CELL_SIZE,
  alignItems: "center",
  justifyContent: "center",
});

const DayCell = styled(Stack, {
  name: "RangeCalendarDayCell",
  width: DAY_CELL_SIZE,
  height: DAY_CELL_SIZE,
  borderRadius: 0,
  alignItems: "center",
  justifyContent: "center",
  position: "relative",
  padding: 2,
  transition: "background-color $motionFast",
  variants: {
    inRange: {
      true: {
        backgroundColor: "$accentSoft",
      },
    },
    rangeEdge: {
      start: {
        borderTopLeftRadius: 0,
        borderBottomLeftRadius: 0,
      },
      end: {
        borderTopRightRadius: 0,
        borderBottomRightRadius: 0,
      },
      single: {
        borderRadius: 0,
      },
      middle: {},
    },
  },
  defaultVariants: {
    rangeEdge: "middle",
  },
} as const);

const DayButton = styled(Stack, {
  width: "100%",
  height: "100%",
  borderRadius: 0,
  borderWidth: 0,
  alignItems: "center",
  justifyContent: "center",
  cursor: "pointer",
  zIndex: 1,
  transition: "all $motionFast",
  hoverStyle: {
    backgroundColor: "$surfaceMuted",
  },
  focusStyle: focusRing,
  variants: {
    state: {
      default: {
        backgroundColor: "transparent",
      },
      selected: {
        // The #B93312 rung, NOT `$accent` (#E2481D): the selected pill carries the day NUMBER
        // (~16px), and cream-on-#E2481D was ~3.8:1. White on the rung is 5.92:1. (Paired with the
        // `$onBrandSecondary` label below.)
        backgroundColor: "$brandSecondaryHover",
      },
    },
    disabled: {
      true: {
        opacity: 0.4,
        cursor: "not-allowed",
        pointerEvents: "none",
      },
    },
    outside: {
      true: {
        opacity: 0.6,
      },
    },
    // removed explicit today indicator per design request
  },
} as const);

const formatISODate = (value: Date) => {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const parseISODate = (value?: string) => {
  if (!value) return undefined;
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return undefined;
  const date = new Date(year, month - 1, day);
  return Number.isNaN(date.getTime()) ? undefined : date;
};

const compareDates = (left?: string, right?: string) => {
  if (!left || !right) return 0;
  const leftDate = parseISODate(left);
  const rightDate = parseISODate(right);
  if (!leftDate || !rightDate) return 0;
  return leftDate.getTime() - rightDate.getTime();
};

const startOfMonth = (date: Date) =>
  new Date(date.getFullYear(), date.getMonth(), 1);

const addMonths = (date: Date, amount: number) => {
  const next = new Date(date);
  next.setMonth(next.getMonth() + amount, 1);
  return next;
};

const startOfWeek = (date: Date) => {
  const next = new Date(date);
  const day = next.getDay();
  next.setDate(next.getDate() - day);
  next.setHours(0, 0, 0, 0);
  return next;
};

const getDaysInMonth = (monthDate: Date) =>
  new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 0).getDate();

const buildGrid = (monthDate: Date) => {
  const firstOfMonth = startOfMonth(monthDate);
  const leadingBlankCount = firstOfMonth.getDay();
  const monthLength = getDaysInMonth(firstOfMonth);
  const days: Array<{ date: Date; iso: string }> = [];

  for (let index = 0; index < monthLength; index += 1) {
    const cellDate = new Date(firstOfMonth);
    cellDate.setDate(firstOfMonth.getDate() + index);
    cellDate.setHours(0, 0, 0, 0);
    days.push({
      date: cellDate,
      iso: formatISODate(cellDate),
    });
  }

  return { days, leadingBlankCount };
};

const isSameMonth = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();

const clampMonthBetween = (
  candidate: Date,
  minMonth?: Date,
  maxMonth?: Date,
) => {
  const normalized = startOfMonth(candidate);
  if (minMonth && maxMonth && minMonth > maxMonth) {
    return maxMonth;
  }
  if (minMonth && normalized < minMonth) {
    return minMonth;
  }
  if (maxMonth && normalized > maxMonth) {
    return maxMonth;
  }
  return normalized;
};

const compareMonths = (left: Date, right: Date) => {
  if (left.getFullYear() === right.getFullYear()) {
    return left.getMonth() - right.getMonth();
  }
  return left.getFullYear() - right.getFullYear();
};

const resolveInitialMonths = (
  start?: string,
  end?: string,
  min?: string,
  minMonth?: Date,
  maxMonth?: Date,
) => {
  const maxStartBound = maxMonth ? addMonths(maxMonth, -1) : undefined;
  const initialStart = clampMonthBetween(
    getInitialMonth(start, undefined, min),
    minMonth,
    maxStartBound,
  );
  const minEndBound = addMonths(initialStart, 1);
  const endSeed = end
    ? getInitialMonth(undefined, end, min)
    : addMonths(initialStart, 1);
  const initialEnd = clampMonthBetween(endSeed, minEndBound, maxMonth);
  if (compareMonths(initialEnd, initialStart) <= 0) {
    return {
      startMonth: initialStart,
      endMonth: clampMonthBetween(
        addMonths(initialStart, 1),
        minEndBound,
        maxMonth,
      ),
    };
  }
  return { startMonth: initialStart, endMonth: initialEnd };
};

const getInitialMonth = (start?: string, end?: string, min?: string) => {
  const seed =
    parseISODate(start ?? end ?? min ?? formatISODate(new Date())) ??
    new Date();
  return startOfMonth(seed);
};

const isDateDisabled = (iso: string, min?: string, max?: string) => {
  if (min && compareDates(iso, min) < 0) {
    return true;
  }
  if (max && compareDates(iso, max) > 0) {
    return true;
  }
  return false;
};

const getRangeEdgeVariant = (
  isSingle: boolean,
  isStart: boolean,
  isEnd: boolean,
) => {
  if (isSingle) return "single" as const;
  if (isStart) return "start" as const;
  if (isEnd) return "end" as const;
  return "middle" as const;
};

export const RangeCalendar = memo<RangeCalendarProps>(
  ({
    start,
    end: providedEnd,
    min,
    max,
    disabled,
    onSelect,
    startSlot,
    endSlot,
    orientation = "horizontal",
    mode = "range",
  }) => {
    const isSingleMode = mode === "single";
    const end = isSingleMode ? undefined : providedEnd;
    const minMonth = useMemo(
      () =>
        min ? startOfMonth(parseISODate(min) ?? new Date(min)) : undefined,
      [min],
    );
    const maxMonth = useMemo(
      () =>
        max ? startOfMonth(parseISODate(max) ?? new Date(max)) : undefined,
      [max],
    );
    const initialMonths = useMemo(
      () => resolveInitialMonths(start, end, min, minMonth, maxMonth),
      [end, maxMonth, min, minMonth, start],
    );
    const [startMonth, setStartMonth] = useState(initialMonths.startMonth);
    const [endMonth, setEndMonth] = useState(initialMonths.endMonth);
    const [hoveredDate, setHoveredDate] = useState<string | undefined>();
    const isSelectingEnd = !isSingleMode && Boolean(start && !end);

    const clampStartMonth = useCallback(
      (candidate: Date) => {
        const maxForStart = endMonth
          ? addMonths(endMonth, -1)
          : maxMonth
            ? addMonths(maxMonth, -1)
            : undefined;
        return clampMonthBetween(candidate, minMonth, maxForStart);
      },
      [endMonth, maxMonth, minMonth],
    );

    const clampEndMonth = useCallback(
      (candidate: Date) => {
        const minForEnd = addMonths(startMonth, 1);
        return clampMonthBetween(candidate, minForEnd, maxMonth);
      },
      [maxMonth, startMonth],
    );

    useEffect(() => {
      setStartMonth((prev) => {
        const next = clampStartMonth(prev);
        return isSameMonth(prev, next) ? prev : next;
      });
    }, [clampStartMonth]);

    useEffect(() => {
      setEndMonth((prev) => {
        const next = clampEndMonth(prev);
        return isSameMonth(prev, next) ? prev : next;
      });
    }, [clampEndMonth]);

    useEffect(() => {
      if (!start) return;
      const parsed = parseISODate(start);
      if (!parsed) return;
      const target = clampStartMonth(startOfMonth(parsed));
      setStartMonth((prev) => (isSameMonth(prev, target) ? prev : target));
    }, [clampStartMonth, start]);

    useEffect(() => {
      if (!end) return;
      const parsed = parseISODate(end);
      if (!parsed) return;
      const target = clampEndMonth(startOfMonth(parsed));
      setEndMonth((prev) => (isSameMonth(prev, target) ? prev : target));
    }, [clampEndMonth, end]);

    const startGrid = useMemo(() => buildGrid(startMonth), [startMonth]);
    const endGrid = useMemo(() => buildGrid(endMonth), [endMonth]);

    const effectiveEnd = useMemo(() => {
      if (end) return end;
      if (!isSelectingEnd || !hoveredDate) return undefined;
      return compareDates(hoveredDate, start) >= 0 ? hoveredDate : undefined;
    }, [end, hoveredDate, isSelectingEnd, start]);

    const handleSelect = useCallback(
      (boundary: CalendarBoundary, iso: string) => {
        if (disabled) return;
        onSelect(boundary, iso);
      },
      [disabled, onSelect],
    );

    const handleHover = useCallback(
      (_boundary: CalendarBoundary, iso: string, cellDisabled: boolean) => {
        if (!isSelectingEnd || cellDisabled) return;
        setHoveredDate(iso);
      },
      [isSelectingEnd],
    );

    const handleCellLeave = useCallback(() => {
      setHoveredDate(undefined);
    }, []);

    const changeMonth = useCallback(
      (boundary: CalendarBoundary, delta: number) => {
        if (boundary === "start") {
          setStartMonth((prev) => clampStartMonth(addMonths(prev, delta)));
          return;
        }
        setEndMonth((prev) => clampEndMonth(addMonths(prev, delta)));
      },
      [clampEndMonth, clampStartMonth],
    );

    const startMaxBound = useMemo(
      () =>
        endMonth
          ? addMonths(endMonth, -1)
          : maxMonth
            ? addMonths(maxMonth, -1)
            : undefined,
      [endMonth, maxMonth],
    );
    const endMinBound = useMemo(() => addMonths(startMonth, 1), [startMonth]);

    const startCanGoPrev = useMemo(() => {
      if (!minMonth) return true;
      return compareMonths(addMonths(startMonth, -1), minMonth) >= 0;
    }, [minMonth, startMonth]);

    const startCanGoNext = useMemo(() => {
      if (!startMaxBound) return true;
      return compareMonths(addMonths(startMonth, 1), startMaxBound) <= 0;
    }, [startMaxBound, startMonth]);

    const endCanGoPrev = useMemo(() => {
      return compareMonths(addMonths(endMonth, -1), endMinBound) >= 0;
    }, [endMinBound, endMonth]);

    const endCanGoNext = useMemo(() => {
      if (!maxMonth) return true;
      return compareMonths(addMonths(endMonth, 1), maxMonth) <= 0;
    }, [endMonth, maxMonth]);

    const renderMonth = (
      grid: ReturnType<typeof buildGrid>,
      monthDate: Date,
      boundary: CalendarBoundary,
      slot?: ReactNode,
      canGoPrev?: boolean,
      canGoNext?: boolean,
      columnOrientation: "horizontal" | "vertical" = "horizontal",
    ) => {
      const { days, leadingBlankCount } = grid;
      return (
        <MonthColumn orientation={columnOrientation}>
          {slot ? <SlotWrapper>{slot}</SlotWrapper> : null}
          <MonthHeader>
            <Text variant="subtitle" weight="bold">
              {monthDate.toLocaleDateString(undefined, {
                month: "long",
                year: "numeric",
              })}
            </Text>
            <HeaderControls>
              <NavButton asChild disabled={!canGoPrev}>
                <button
                  type="button"
                  onClick={() => changeMonth(boundary, -1)}
                  aria-label="Previous month"
                  disabled={!canGoPrev}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "currentColor",
                  }}
                >
                  <ChevronLeft size={18} strokeWidth={2.5} />
                </button>
              </NavButton>
              <NavButton asChild disabled={!canGoNext}>
                <button
                  type="button"
                  onClick={() => changeMonth(boundary, 1)}
                  aria-label="Next month"
                  disabled={!canGoNext}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "currentColor",
                  }}
                >
                  <ChevronRight size={18} strokeWidth={2.5} />
                </button>
              </NavButton>
            </HeaderControls>
          </MonthHeader>

          <DayTable>
            {WEEKDAY_LABELS.map((label) => (
              <DayHeaderCell key={`${monthDate.toISOString()}-${label}`}>
                <Text variant="caption" tone="muted">
                  {label}
                </Text>
              </DayHeaderCell>
            ))}
            {days.map((day, dayIndex) => {
              const insetStyle =
                dayIndex === 0 && leadingBlankCount > 0
                  ? { marginLeft: `${leadingBlankCount * DAY_CELL_SIZE}px` }
                  : undefined;
              const isDisabled = disabled || isDateDisabled(day.iso, min, max);
              const isStart = Boolean(
                start && compareDates(day.iso, start) === 0,
              );
              const isEnd = Boolean(end && compareDates(day.iso, end) === 0);
              const isEffectiveEnd = Boolean(
                effectiveEnd && compareDates(day.iso, effectiveEnd) === 0,
              );
              const isSingle = isStart && isEffectiveEnd;
              const isWithinRange = Boolean(
                start &&
                effectiveEnd &&
                compareDates(day.iso, start) >= 0 &&
                compareDates(day.iso, effectiveEnd) <= 0,
              );
              const showRange = isWithinRange;
              const rangeEdge = getRangeEdgeVariant(
                isSingle,
                isStart,
                isEffectiveEnd,
              );

              return (
                <DayCell
                  key={day.iso}
                  onMouseLeave={handleCellLeave}
                  inRange={showRange ? true : undefined}
                  rangeEdge={showRange ? rangeEdge : undefined}
                  backgroundColor={showRange ? "$accentSoft" : undefined}
                  style={insetStyle}
                >
                  <DayButton
                    asChild
                    disabled={isDisabled}
                    state={isStart || isEnd ? "selected" : "default"}
                    onMouseEnter={() =>
                      handleHover(boundary, day.iso, isDisabled)
                    }
                  >
                    <button
                      type="button"
                      onClick={() => handleSelect(boundary, day.iso)}
                      aria-label={`Select date ${day.iso}`}
                      aria-pressed={isStart || isEnd}
                      data-testid={`range-calendar-day-${day.iso}`}
                      data-selected={isStart || isEnd ? "true" : undefined}
                    >
                      <Text
                        variant="body"
                        weight={isStart || isEnd ? "semibold" : "regular"}
                        tone={isDisabled ? "muted" : "default"}
                        color={isStart || isEnd ? "$onBrandSecondary" : undefined}
                        textAlign="center"
                      >
                        {day.date.getDate()}
                      </Text>
                    </button>
                  </DayButton>
                </DayCell>
              );
            })}
          </DayTable>
        </MonthColumn>
      );
    };

    const singleModeStyles = isSingleMode
      ? {
          width: "fit-content" as const,
          minWidth: MONTH_WIDTH,
        }
      : undefined;

    return (
      <CalendarFrame orientation={orientation} style={singleModeStyles}>
        <DualMonthLayout orientation={orientation} style={singleModeStyles}>
          {renderMonth(
            startGrid,
            startMonth,
            "start",
            startSlot,
            startCanGoPrev,
            startCanGoNext,
            orientation,
          )}
          {isSingleMode
            ? null
            : renderMonth(
                endGrid,
                endMonth,
                "end",
                endSlot,
                endCanGoPrev,
                endCanGoNext,
                orientation,
              )}
        </DualMonthLayout>
      </CalendarFrame>
    );
  },
);

RangeCalendar.displayName = "RangeCalendar";
