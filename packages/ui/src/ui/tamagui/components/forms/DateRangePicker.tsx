"use client";

import { CalendarRange } from "lucide-react";
import { memo, useCallback, useMemo, useState } from "react";
import { Popover, Stack, XStack, YStack, styled } from "tamagui";

import type {
  DateRangePickerProps,
  DateRangeValue,
} from "./DateRangePicker.types";
import {
  DEFAULT_PLACEHOLDERS,
  formatIsoToDisplay,
  type DateDisplayFormat,
} from "./date-format";
import { RangeCalendar } from "./RangeCalendar";
import { Text } from "../typography/Text";

const Container = styled(YStack, {
  name: "DateRangePicker",
  gap: "$2",
  width: "100%",
});

const TriggerButton = styled(XStack, {
  name: "DateRangePickerTrigger",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "$3",
  borderWidth: 2,
  borderColor: "$borderColor",
  borderRadius: 0,
  paddingHorizontal: "$3",
  paddingVertical: "$2",
  minHeight: 44,
  width: "100%",
  backgroundColor: "$surface",
  cursor: "pointer",
  hoverStyle: {
    borderColor: "$borderColorStrong",
  },
  variants: {
    disabled: {
      true: {
        opacity: 0.6,
        cursor: "not-allowed",
        pointerEvents: "none",
      },
    },
  },
});

const IconWrapper = styled(Stack, {
  name: "DateRangePickerIcon",
  alignItems: "center",
  justifyContent: "center",
  pointerEvents: "none",
  opacity: 0.7,
});

const normalizeRange = (value?: DateRangeValue): DateRangeValue => ({
  start: value?.start ?? undefined,
  end: value?.end ?? undefined,
});

const compareDates = (left?: string, right?: string): number => {
  if (!left || !right) return 0;
  const leftDate = new Date(left);
  const rightDate = new Date(right);
  if (Number.isNaN(leftDate.getTime()) || Number.isNaN(rightDate.getTime()))
    return 0;
  return leftDate.getTime() - rightDate.getTime();
};

const buildSummaryText = (
  start?: string,
  end?: string,
  _format: DateDisplayFormat = "single",
  startFallback = "Select start date",
  endFallback = "Select end date",
) => {
  // The current formatter is ISO-only (YYYY-MM-DD). Display format is used
  // for placeholders/UX copy, not locale formatting.
  const startDisplay = formatIsoToDisplay(start);
  const endDisplay = formatIsoToDisplay(end);

  if (start && end) {
    return `${startDisplay ?? start} – ${endDisplay ?? end}`;
  }
  if (start) {
    return `${startDisplay ?? start} – ${endFallback}`;
  }
  if (end) {
    return `${startFallback} – ${endDisplay ?? end}`;
  }
  return "Select date range";
};

export const DateRangePicker = memo<DateRangePickerProps>(
  ({
    value,
    onChange,
    min,
    max,
    disabled,
    fullWidth,
    alignment = "horizontal",
    startLabel = "Start date",
    endLabel = "End date",
    startPlaceholder,
    endPlaceholder,
    displayFormat = "single",
    triggerMinHeight,
    triggerBorderRadius,
    marginLeft,
    borderWidth,
    borderColor,
    testIdBase,
    qaId,
    forceOpen,
  }) => {
    const [open, setOpen] = useState(false);
    const normalizedValue = useMemo(() => normalizeRange(value), [value]);
    const startValue = normalizedValue.start;
    const endValue = normalizedValue.end;

    const startFallback = startPlaceholder ?? DEFAULT_PLACEHOLDERS.rangeStart;
    const endFallback = endPlaceholder ?? DEFAULT_PLACEHOLDERS.rangeEnd;

    const summary = useMemo(
      () =>
        buildSummaryText(
          startValue,
          endValue,
          displayFormat as DateDisplayFormat,
          startFallback,
          endFallback,
        ),
      [displayFormat, endFallback, endValue, startFallback, startValue],
    );

    const handleSelect = useCallback(
      (_boundary: "start" | "end", isoDate: string) => {
        // RangeCalendar uses a simple interaction model:
        // - first click sets start (clears end)
        // - second click sets end if >= start (else resets start)
        if (!startValue || (startValue && endValue)) {
          onChange({ start: isoDate, end: undefined });
          return;
        }

        if (compareDates(isoDate, startValue) < 0) {
          onChange({ start: isoDate, end: undefined });
          return;
        }

        onChange({ start: startValue, end: isoDate });
        // Intentionally keep the popover open after selecting the end date.
        // Users can click/tap outside to dismiss once they're satisfied.
      },
      [endValue, onChange, startValue],
    );

    const isOpen = forceOpen ?? open;

    return (
      <Container width={fullWidth ? "100%" : undefined}>
        <Popover
          open={isOpen}
          onOpenChange={setOpen}
          placement="bottom"
          allowFlip
        >
          <Popover.Trigger asChild>
            <TriggerButton
              role="button"
              aria-label="Choose date range"
              disabled={disabled}
              width={fullWidth ? "100%" : undefined}
              minHeight={triggerMinHeight}
              borderRadius={triggerBorderRadius}
              marginLeft={marginLeft}
              borderWidth={borderWidth}
              borderColor={borderColor}
              data-testid={testIdBase ? `${testIdBase}-trigger` : undefined}
              data-qa={qaId}
            >
              <YStack flex={1} minWidth={0}>
                <Text variant="body" truncate>
                  {summary}
                </Text>
              </YStack>
              <IconWrapper>
                <CalendarRange size={18} />
              </IconWrapper>
            </TriggerButton>
          </Popover.Trigger>
          <Popover.Content
            padding={0}
            borderWidth={0}
            backgroundColor="transparent"
          >
            <RangeCalendar
              start={startValue}
              end={endValue}
              min={min}
              max={max}
              disabled={disabled}
              orientation={alignment === "vertical" ? "vertical" : "horizontal"}
              onSelect={handleSelect}
              mode="range"
            />
          </Popover.Content>
        </Popover>
      </Container>
    );
  },
);

DateRangePicker.displayName = "DateRangePicker";

export type { DateRangePickerProps, DateRangeValue };
