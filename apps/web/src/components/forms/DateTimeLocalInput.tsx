"use client";

import {
  forwardRef,
  useCallback,
  useRef,
  useState,
  type InputHTMLAttributes,
  type MouseEvent,
} from "react";

import { DATE_INPUT_MAX, DATETIME_LOCAL_MAX } from "@/lib/datetime-local";

import styles from "./DateTimeLocalInput.module.css";

/**
 * Width of Chrome's calendar picker indicator, the icon at the right edge of a
 * date or datetime-local field (16px glyph plus its own margins). A mousedown
 * inside the input's right padding plus this zone is left alone so the picker
 * still opens.
 */
const PICKER_INDICATOR_ZONE_PX = 24;

/** The handlers the behaviour hooks into. A caller's own are always called. */
export type DateTimeFieldHandlers = Pick<
  InputHTMLAttributes<HTMLInputElement>,
  "onPointerDown" | "onMouseDown" | "onKeyUp" | "onInput" | "onChange" | "onBlur"
>;

export type DateTimeFieldBehaviourOptions = {
  /**
   * Fires when the field moves between complete and half-typed. Half-typed
   * means `value === ""` while `validity.badInput` is true: some segments
   * hold digits, others are still blank. Called on every check (no dedupe, so
   * a caller that set its own flag out of band is never left stale); the
   * second argument is true once the field has been blurred, the point from
   * which the caller may show its message.
   */
  onIncompleteChange?: (incomplete: boolean, touched: boolean) => void;
};

/**
 * State for one field's incomplete flag, split into the flag that gates submit
 * (`incomplete`, true from the first keyup) and the one that gates the message
 * and `aria-invalid` (`shown`, true only after a blur or a refused submit).
 * A screen reader must not announce an error while the person is still typing.
 *
 * Wire `onIncompleteChange` to the input, call `refuse(halfTyped)` where submit
 * re-reads the field, and render the message from `shown`.
 */
export function useIncompleteField() {
  const [incomplete, setIncomplete] = useState(false);
  const [touched, setTouched] = useState(false);
  const onIncompleteChange = useCallback(
    (next: boolean, wasTouched: boolean) => {
      setIncomplete(next);
      if (wasTouched) setTouched(true);
    },
    [],
  );
  const refuse = useCallback((next: boolean) => {
    setIncomplete(next);
    setTouched(true);
  }, []);
  return {
    incomplete,
    shown: incomplete && touched,
    onIncompleteChange,
    refuse,
  };
}

/** True when the field holds part of a date: some segments typed, not all. */
export function isDateTimeFieldIncomplete(input: HTMLInputElement): boolean {
  return input.value === "" && input.validity.badInput;
}

function isOnPickerIndicator(event: MouseEvent<HTMLInputElement>): boolean {
  const input = event.currentTarget;
  const rect = input.getBoundingClientRect();
  // Not laid out (jsdom, a hidden field): there is no indicator to protect.
  if (rect.width === 0) return false;
  const style = window.getComputedStyle(input);
  const borderRight = parseFloat(style.borderRightWidth) || 0;
  const paddingRight = parseFloat(style.paddingRight) || 0;
  const zoneStart =
    rect.right - borderRight - paddingRight - PICKER_INDICATOR_ZONE_PX;
  return event.clientX >= zoneStart;
}

/**
 * Fixes two Chrome behaviours of native `date` / `datetime-local` fields.
 *
 * 1. Clicking an EMPTY field puts the caret in the segment under the pointer.
 *    Click the year, type `10/24/2026 06:00 PM` and the digits land from the
 *    year onward: the field reads `mm/dd/1024, 02:02 PM` and never commits.
 *    On a mouse press into an empty, unfocused field we cancel the default
 *    caret placement and call `focus()`, which always starts at the first
 *    segment. Touch and pen are left alone (phones open a native picker on
 *    tap), and so is a press on the calendar picker indicator.
 *
 * 2. While a value is half-typed Chrome fires no `input` or `change` event:
 *    `value` stays "" and only `keyup` sees `validity.badInput` turn true. A
 *    form that reads `value` alone treats a half-typed date as "no date" and
 *    saves without it. `onIncompleteChange` reports the half-typed state,
 *    recomputed on keyup, input, change and blur.
 *
 * Returns handlers to spread onto the input; each calls the caller's own.
 */
export function useDateTimeFieldBehaviour(
  handlers: DateTimeFieldHandlers,
  options: DateTimeFieldBehaviourOptions = {},
): Required<DateTimeFieldHandlers> {
  const { onPointerDown, onMouseDown, onKeyUp, onInput, onChange, onBlur } =
    handlers;
  const { onIncompleteChange } = options;
  const lastPointerType = useRef<string | null>(null);
  const touched = useRef(false);

  const report = useCallback(
    (input: HTMLInputElement) => {
      onIncompleteChange?.(isDateTimeFieldIncomplete(input), touched.current);
    },
    [onIncompleteChange],
  );

  return {
    onPointerDown: (event) => {
      lastPointerType.current = event.pointerType;
      onPointerDown?.(event);
    },
    onMouseDown: (event) => {
      onMouseDown?.(event);
      const input = event.currentTarget;
      const pointerType = lastPointerType.current;
      if (
        !event.defaultPrevented &&
        event.button === 0 &&
        (pointerType === null || pointerType === "mouse") &&
        !input.disabled &&
        !input.readOnly &&
        input.value === "" &&
        !input.validity.badInput &&
        input.ownerDocument.activeElement !== input &&
        !isOnPickerIndicator(event)
      ) {
        event.preventDefault();
        input.focus();
      }
    },
    onKeyUp: (event) => {
      onKeyUp?.(event);
      report(event.currentTarget);
    },
    onInput: (event) => {
      onInput?.(event);
      report(event.currentTarget);
    },
    onChange: (event) => {
      onChange?.(event);
      report(event.currentTarget);
    },
    onBlur: (event) => {
      onBlur?.(event);
      touched.current = true;
      report(event.currentTarget);
    },
  };
}

export type DateTimeLocalInputProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "type"
> &
  DateTimeFieldBehaviourOptions & {
    type: "datetime-local" | "date";
    /**
     * `plain` (default): no styling of its own; the caller's `style` or
     * `className` does it all. `boxed`: the design system TextInput's look
     * (2px border, hover and focus borders), for sites that rendered the date
     * through TextInput before.
     */
    variant?: "plain" | "boxed";
  };

/**
 * A plain native `datetime-local` / `date` input with the behaviour above.
 * `max` defaults to a 4-digit year so typed dates commit (see
 * `DATETIME_LOCAL_MAX`); a caller's own `max` wins. Styling stays with the
 * caller (`style`, `className`) unless `variant="boxed"`.
 */
export const DateTimeLocalInput = forwardRef<
  HTMLInputElement,
  DateTimeLocalInputProps
>(function DateTimeLocalInput(
  {
    type,
    max,
    variant = "plain",
    className,
    onIncompleteChange,
    onPointerDown,
    onMouseDown,
    onKeyUp,
    onInput,
    onChange,
    onBlur,
    ...rest
  },
  ref,
) {
  const behaviour = useDateTimeFieldBehaviour(
    { onPointerDown, onMouseDown, onKeyUp, onInput, onChange, onBlur },
    { onIncompleteChange },
  );
  return (
    <input
      ref={ref}
      type={type}
      max={max ?? (type === "date" ? DATE_INPUT_MAX : DATETIME_LOCAL_MAX)}
      className={
        variant === "boxed"
          ? [styles.boxed, className].filter(Boolean).join(" ")
          : className
      }
      {...rest}
      {...behaviour}
    />
  );
});
