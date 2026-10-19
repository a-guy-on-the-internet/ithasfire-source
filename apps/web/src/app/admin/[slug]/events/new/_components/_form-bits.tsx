"use client";

import type { ComponentProps, ReactNode } from "react";
import { styled, YStack } from "tamagui";

import { Text, useTranslations } from "@th/ui";

import {
  useDateTimeFieldBehaviour,
  type DateTimeFieldBehaviourOptions,
} from "@/components/forms/DateTimeLocalInput";
import { useIsMobile } from "@/hooks/useIsMobile";
import { DATE_INPUT_MAX, DATETIME_LOCAL_MAX } from "@/lib/datetime-local";

/**
 * Shared event-builder form primitives. Centralizes the label styling so
 * every section of the builder looks the same.
 *
 * Marking rule (docs/design/design-system-v2.md §6a): OPTIONAL fields carry a
 * muted "(optional)" suffix; REQUIRED fields are never marked. Almost every
 * builder field is mandatory, so an asterisk on each would decorate the whole
 * form and tell the reader nothing.
 */

export const Field = styled(YStack, { gap: 6 });

const FieldLabelText = styled(Text, {
  fontSize: 11,
  fontWeight: "700",
  textTransform: "uppercase",
  letterSpacing: 1.2,
  color: "$colorMuted",
  tag: "span",
});

export type FieldLabelProps = ComponentProps<typeof FieldLabelText> & {
  children: ReactNode;
  /**
   * Accepted so call sites can keep declaring intent alongside the control's
   * own `required` / `aria-required`, but it DRAWS NOTHING: required fields
   * are unmarked by rule. Mark the exceptions with `optional` instead.
   */
  required?: boolean;
  /** Appends a muted "(optional)" suffix. */
  optional?: boolean;
};

export function FieldLabel({
  children,
  required: _required,
  optional,
  ...rest
}: FieldLabelProps) {
  const t = useTranslations();
  // 11px uppercase labels read cramped on a phone; step up one size below the
  // 600px mobile breakpoint for legibility. Aligning with `useIsMobile` (599px)
  // instead of Tamagui's `$xs` (480px) closes the 480–600px tablet-portrait
  // seam where the builder switches to mobile structures but the label stayed
  // at the desktop 11px. Desktop (>=600px) keeps the compact 11px.
  const isMobile = useIsMobile();
  return (
    <FieldLabelText fontSize={isMobile ? 12 : 11} {...rest}>
      {children}
      {optional ? (
        <Text
          tag="span"
          variant="caption"
          tone="muted"
          weight="regular"
          textTransform="none"
          letterSpacing={0.4}
          marginLeft={6}
        >
          ({String(t("common.optional"))})
        </Text>
      ) : null}
    </FieldLabelText>
  );
}

FieldLabel.displayName = "FieldLabel";

/**
 * Plain native HTML date / datetime input. Tamagui's RN-Web wrapper around
 * <Input> ignores `type=date|datetime-local` (it stays text), which is why
 * the event builder uses a raw <input> instead. Centralize the styling here
 * so every date field across sections looks identical.
 */
// @ts-ignore — tamagui dropped string HTML element support in styled(); runtime is fine
const NativeDateTimeInputBase = styled("input", {
  width: "auto",
  minHeight: 32,
  borderWidth: 1,
  borderColor: "$borderColor",
  borderRadius: 0,
  backgroundColor: "transparent",
  color: "$color",
  paddingVertical: 4,
  paddingHorizontal: 8,
  fontSize: 13,
});

export type NativeDateTimeInputProps = ComponentProps<
  typeof NativeDateTimeInputBase
> &
  DateTimeFieldBehaviourOptions;

/**
 * Date/datetime input that bumps to a 44px tap target and 16px text below the
 * 600px mobile breakpoint. On touch phones the desktop 32px control is below
 * the 44px tap-target minimum and the 13px text triggers iOS auto-zoom.
 *
 * The bump reads `useIsMobile` (599px) rather than Tamagui's `$xs` (480px) so
 * the 480–600px tablet-portrait band — where the builder already switches to
 * mobile structures — gets touch-sized inputs too. Desktop (>=600px) keeps the
 * compact 32px / 13px treatment unchanged.
 *
 * Date and datetime-local inputs default `max` to a 4-digit year so typed dates
 * commit (see `DATETIME_LOCAL_MAX`); a caller's own `max` wins. A mouse press
 * into the empty field starts typing at the first segment, and
 * `onIncompleteChange` reports a half-typed value (see
 * `useDateTimeFieldBehaviour`). A caller's `ref` reaches the DOM input through
 * the props spread (React 19 passes `ref` as a prop).
 */
export function NativeDateTimeInput({
  onIncompleteChange,
  ...props
}: NativeDateTimeInputProps) {
  const isMobile = useIsMobile();
  const behaviour = useDateTimeFieldBehaviour(
    {
      onPointerDown: props.onPointerDown,
      onMouseDown: props.onMouseDown,
      onKeyUp: props.onKeyUp,
      onInput: props.onInput,
      onChange: props.onChange,
      onBlur: props.onBlur,
    },
    { onIncompleteChange },
  );
  const defaultMax =
    props.type === "datetime-local"
      ? DATETIME_LOCAL_MAX
      : props.type === "date"
        ? DATE_INPUT_MAX
        : undefined;
  return (
    <NativeDateTimeInputBase
      minHeight={isMobile ? 44 : 32}
      paddingVertical={isMobile ? 8 : 4}
      fontSize={isMobile ? 16 : 13}
      {...props}
      {...behaviour}
      max={props.max ?? defaultMax}
    />
  );
}

NativeDateTimeInput.displayName = "NativeDateTimeInput";
