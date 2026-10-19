"use client";

import { Calendar } from "lucide-react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import { Stack, XStack, YStack, styled } from "tamagui";

import { Popover } from "./Popover";
import { RangeCalendar } from "./forms/RangeCalendar";
import { Text } from "./typography/Text";
import { TextInput } from "./forms/TextInput";
import type { DatePickerProps } from "./forms/DatePicker.types";
import {
  DEFAULT_PLACEHOLDERS,
  formatDigitsForDisplay,
  formatIsoToDisplay,
  formatIsoToHumanDisplay,
  isIsoWithinBounds,
  parseDisplayToIso,
} from "./forms/date-format";

type HybridChangeEvent =
  | ChangeEvent<HTMLInputElement>
  | { nativeEvent?: { text?: string }; target?: { value?: string } };
type AutomationTuple = readonly [string, string];

const resolveAutomationProps = (testId?: string, qaId?: string) => {
  if (!testId && !qaId) {
    return {};
  }

  const entries = [
    testId ? (["data-testid", testId] as const) : null,
    qaId ? (["data-qa", qaId] as const) : null,
  ].filter(Boolean) as ReadonlyArray<readonly [string, string]>;

  return Object.fromEntries(entries);
};

const buildAutomationAttributes = (testId?: string, qaId?: string) => {
  const entries = [
    testId ? (["data-testid", testId] as AutomationTuple) : null,
    qaId ? (["data-qa", qaId] as AutomationTuple) : null,
  ].filter(Boolean) as AutomationTuple[];

  return entries.length ? Object.fromEntries(entries) : {};
};

const focusRing = {
  outlineWidth: 2,
  outlineStyle: "solid" as const,
  outlineColor: "$accent",
  outlineOffset: 2,
};

const Container = styled(YStack, {
  name: "DatePicker",
  gap: "$3",
  width: "100%",
});

const FieldGroup = styled(YStack, {
  gap: "$1",
  flex: 1,
});

const TriggerButton = styled(XStack, {
  name: "DatePickerTrigger",
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
  transition: "all $motionFast",
  hoverStyle: {
    borderColor: "$borderColorStrong",
  },
  focusStyle: {
    ...focusRing,
    borderColor: "$accent",
    outlineColor: "$accent",
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

const TriggerButtonElement = styled(Stack, {
  name: "DatePickerTriggerButton",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "$3",
  width: "100%",
  paddingHorizontal: "$3",
  paddingVertical: "$2",
  minHeight: 44,
  borderWidth: 2,
  borderColor: "$borderColor",
  borderRadius: 0,
  backgroundColor: "$surface",
  cursor: "pointer",
  transition: "all $motionFast",
  hoverStyle: {
    borderColor: "$borderColorStrong",
  },
  focusStyle: {
    ...focusRing,
    borderColor: "$accent",
    outlineColor: "$accent",
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

const TriggerTextGroup = styled(YStack, {
  gap: "$1",
  flex: 1,
  minWidth: 0,
});

const CalendarIconWrapper = styled(Stack, {
  alignItems: "center",
  justifyContent: "center",
  pointerEvents: "none",
  opacity: 0.7,
});

const buildAssistiveText = (value?: string) =>
  value ? "Tap to adjust date" : "Tap to pick a date";

type BaseInputProps = Omit<
  DatePickerProps,
  | "variant"
  | "label"
  | "alignment"
  | "forceOpen"
  | "triggerTestId"
  | "triggerQaId"
>;

const DateInputField = forwardRef<HTMLInputElement | null, BaseInputProps>(
  (
    {
      value,
      onChange,
      min,
      max,
      placeholder,
      ariaLabel,
      disabled,
      fullWidth,
      id,
      testId,
      qaId,
    },
    ref,
  ) => {
    const inputRef = useRef<HTMLInputElement>(null);
    const automationProps = useMemo(
      () => resolveAutomationProps(testId, qaId ?? testId),
      [qaId, testId],
    );
    // date-format.ts only supports deterministic YYYY-MM-DD on web.
    const resolvedPlaceholder = placeholder ?? DEFAULT_PLACEHOLDERS.single;
    // For accessibility + tests, the input's aria-label should match the explicit placeholder
    // when provided (e.g. "Select date"), otherwise fall back to the formatted placeholder.
    const resolvedAriaLabel = ariaLabel ?? resolvedPlaceholder;
    const displayValue = useMemo(() => formatIsoToDisplay(value), [value]);
    const [textValue, setTextValue] = useState(displayValue);
    const lastSubmittedValueRef = useRef<DatePickerProps["value"]>(value);

    useEffect(() => {
      lastSubmittedValueRef.current = value;
    }, [value]);

    useImperativeHandle<HTMLInputElement | null, HTMLInputElement | null>(
      ref,
      () => inputRef.current,
      [],
    );

    useEffect(() => {
      setTextValue(displayValue);
    }, [displayValue]);

    const emitIfChanged = useCallback(
      (nextValue: DatePickerProps["value"]) => {
        if (lastSubmittedValueRef.current === nextValue) {
          return;
        }

        lastSubmittedValueRef.current = nextValue;
        onChange(nextValue);
      },
      [onChange],
    );

    const commitValue = useCallback(
      (nextValue: string) => {
        const formatted = formatDigitsForDisplay(nextValue);
        setTextValue(formatted);

        if (formatted.length === 0) {
          emitIfChanged(undefined);
          return;
        }

        const isoValue = parseDisplayToIso(formatted);
        if (!isoValue) {
          return;
        }

        if (!isIsoWithinBounds(isoValue, { min, max })) {
          return;
        }

        emitIfChanged(isoValue);
      },
      [emitIfChanged, max, min],
    );

    const handleTextChange = useCallback(
      (next: string) => {
        if (disabled) return;
        commitValue(next);
      },
      [commitValue, disabled],
    );

    const handleInputChange = useCallback(
      (event: HybridChangeEvent) => {
        if (disabled) return;
        const nativeText = (event as { nativeEvent?: { text?: string } })
          .nativeEvent?.text;
        if (typeof nativeText === "string") {
          commitValue(nativeText);
          return;
        }

        const domValue =
          (event as ChangeEvent<HTMLInputElement>).target?.value ?? "";
        commitValue(domValue);
      },
      [commitValue, disabled],
    );

    const handleBlur = useCallback(() => {
      setTextValue(displayValue);
    }, [displayValue]);

    return (
      <TextInput
        {...automationProps}
        ref={inputRef as never}
        id={id}
        value={textValue}
        onChangeText={handleTextChange}
        onChange={handleInputChange as never}
        onBlur={handleBlur}
        placeholder={resolvedPlaceholder}
        aria-label={resolvedAriaLabel}
        disabled={disabled}
        fullWidth={fullWidth}
        inputMode="numeric"
        autoComplete="off"
        testId={testId}
        qaId={qaId}
        autoCorrect={false}
        spellCheck={false}
        maxLength={10}
      />
    );
  },
);

DateInputField.displayName = "DateInputField";

export const DatePicker = forwardRef<HTMLInputElement | null, DatePickerProps>(
  (
    {
      value,
      onChange,
      min,
      max,
      placeholder,
      ariaLabel,
      disabled,
      fullWidth,
      id,
      testId,
      qaId,
      displayFormat = "single",
      variant = "picker",
      label,
      alignment = "horizontal",
      forceOpen,
      triggerTestId,
      triggerQaId,
    },
    ref,
  ) => {
    const baseInputProps: BaseInputProps = {
      value,
      onChange,
      min,
      max,
      placeholder,
      ariaLabel,
      disabled,
      fullWidth,
      id,
      testId,
      qaId,
    };

    if (variant === "input") {
      return <DateInputField {...baseInputProps} ref={ref} />;
    }

    const resolvedPlaceholder = placeholder ?? DEFAULT_PLACEHOLDERS.single;
    const resolvedLabel = label ?? ariaLabel ?? resolvedPlaceholder;
    // Keep the trigger label stable for tests and screen readers.
    const triggerLabel = "Date picker";
    const triggerId =
      triggerTestId ?? (testId ? `${testId}-trigger` : undefined);
    const triggerQa = triggerQaId ?? (qaId ? `${qaId}-trigger` : undefined);
    const triggerAutomationProps = useMemo(
      () => buildAutomationAttributes(triggerId, triggerQa),
      [triggerId, triggerQa],
    );

    const [draftValue, setDraftValue] = useState(value);
    const [isOpen, setOpen] = useState(false);
    const containerRef = useRef<HTMLDivElement | null>(null);
    const popoverContentId = useId();

    useEffect(() => {
      setDraftValue(value);
    }, [value]);

    const assistiveCopy = useMemo(
      () => buildAssistiveText(draftValue),
      [draftValue],
    );
    const summaryText = useMemo(() => {
      if (!draftValue) return resolvedPlaceholder;
      return formatIsoToHumanDisplay(draftValue) || draftValue;
    }, [draftValue, resolvedPlaceholder]);

    const isPopoverMode = !forceOpen;

    const closePopover = useCallback(() => {
      if (!isPopoverMode) return;
      setOpen(false);
    }, [isPopoverMode]);

    const togglePopover = useCallback(() => {
      if (!isPopoverMode || disabled) return;
      setOpen((prev) => !prev);
    }, [disabled, isPopoverMode]);

    useEffect(() => {
      if (!isPopoverMode || !isOpen) return undefined;
      const handlePointerDown = (event: PointerEvent) => {
        if (!containerRef.current) return;
        if (containerRef.current.contains(event.target as Node)) {
          return;
        }
        closePopover();
      };

      document.addEventListener("pointerdown", handlePointerDown, {
        capture: true,
      });
      return () => {
        document.removeEventListener("pointerdown", handlePointerDown, {
          capture: true,
        });
      };
    }, [closePopover, isOpen, isPopoverMode]);

    useEffect(() => {
      if (!isPopoverMode || !isOpen) return undefined;
      const handleKeyDown = (event: globalThis.KeyboardEvent) => {
        if (event.key === "Escape") {
          closePopover();
        }
      };

      window.addEventListener("keydown", handleKeyDown);
      return () => {
        window.removeEventListener("keydown", handleKeyDown);
      };
    }, [closePopover, isOpen, isPopoverMode]);

    useEffect(() => {
      if (!isPopoverMode) return;
      if (disabled && isOpen) {
        setOpen(false);
      }
    }, [disabled, isOpen, isPopoverMode]);

    const emitChange = useCallback(
      (next?: string) => {
        setDraftValue(next);
        onChange(next);
      },
      [onChange],
    );

    const handleInputChange = useCallback(
      (next?: string) => {
        emitChange(next);
      },
      [emitChange],
    );

    const handleCalendarSelect = useCallback(
      (_boundary: "start" | "end", isoDate: string) => {
        emitChange(isoDate);
        if (isPopoverMode) {
          setOpen(false);
        }
      },
      [emitChange, isPopoverMode],
    );

    const calendarContent = (
      <YStack
        gap="$4"
        width={fullWidth ? "100%" : undefined}
        id={popoverContentId}
      >
        <RangeCalendar
          start={draftValue}
          min={min}
          max={max}
          disabled={disabled}
          onSelect={handleCalendarSelect}
          orientation={alignment}
          mode="single"
          startSlot={
            <FieldGroup>
              <Text variant="bodySmall" tone="muted">
                {resolvedLabel}
              </Text>
              <DateInputField
                {...baseInputProps}
                value={draftValue}
                onChange={handleInputChange}
                placeholder={resolvedPlaceholder}
                ariaLabel={resolvedLabel}
                fullWidth
                ref={ref}
              />
            </FieldGroup>
          }
        />
      </YStack>
    );

    return (
      <Container ref={containerRef} width={fullWidth ? "100%" : undefined}>
        <Text variant="bodySmall" tone="muted">
          {resolvedLabel}
        </Text>
        {isPopoverMode ? (
          <Popover
            open={isOpen}
            placement="bottom"
            tone="surface"
            anchor={
              <TriggerButtonElement disabled={disabled} asChild>
                <button
                  type="button"
                  onClick={togglePopover}
                  disabled={disabled}
                  {...triggerAutomationProps}
                  aria-label={triggerLabel}
                  aria-haspopup="dialog"
                  aria-expanded={isOpen}
                  aria-controls={isOpen ? popoverContentId : undefined}
                >
                  <TriggerTextGroup>
                    <Text variant="body" weight="bold" truncate>
                      {summaryText}
                    </Text>
                    <Text variant="bodySmall" tone="muted" truncate>
                      {assistiveCopy}
                    </Text>
                  </TriggerTextGroup>
                  <CalendarIconWrapper aria-hidden>
                    <Calendar
                      size={18}
                      strokeWidth={1.75}
                      color="currentColor"
                    />
                  </CalendarIconWrapper>
                </button>
              </TriggerButtonElement>
            }
          >
            {calendarContent}
          </Popover>
        ) : (
          calendarContent
        )}
      </Container>
    );
  },
);

DatePicker.displayName = "DatePicker";

export type { DatePickerProps };
