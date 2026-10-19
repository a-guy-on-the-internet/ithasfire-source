"use client";

import { useRef, type KeyboardEvent } from "react";

import type { BookingIntent } from "./request-to-play-form.helpers";
import formStyles from "./RequestToPlayBlock.module.css";

/**
 * Step 1 of the booking dialog: which intent the request carries.
 *
 * A radiogroup, not tabs — the choice filters ONE form, it does not swap
 * panels. Hand-rolled instead of `@th/ui`'s `SegmentedControl` for two
 * reasons the shared molecule cannot meet here: the segments must WRAP (three
 * uppercase labels do not fit one row at 320px), and the booking form is
 * themed through the entity page's `--th-color-*` custom properties, which a
 * Tamagui-token control would ignore. The keyboard model is the same WAI-ARIA
 * one: roving tabindex, arrows/Home/End move and select, Enter/Space
 * activate.
 *
 * Selected = accent border + accent wash + ink label (v2 `.chip.on`), never a
 * full fill — the fill is the submit button's.
 */
export function IntentPicker({
  value,
  options,
  onChange,
  label,
  disabled = false,
}: {
  value: BookingIntent;
  options: { value: BookingIntent; label: string }[];
  onChange: (next: BookingIntent) => void;
  /** Accessible name for the group; also rendered as the field label. */
  label: string;
  disabled?: boolean;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  const select = (next: BookingIntent, index: number) => {
    if (disabled) return;
    if (next !== value) onChange(next);
    refs.current[index]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const len = options.length;
    const current = options.findIndex((o) => o.value === value);
    let next: number | null = null;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        next = (current + 1) % len;
        break;
      case "ArrowLeft":
      case "ArrowUp":
        next = (current - 1 + len) % len;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = len - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const target = options[next];
    if (target) select(target.value, next);
  };

  return (
    <div className={formStyles.fieldGroup}>
      <span className={formStyles.fieldLabel} aria-hidden="true">
        {label}
      </span>
      <div
        className={formStyles.intentGroup}
        role="radiogroup"
        aria-label={label}
        aria-disabled={disabled || undefined}
        onKeyDown={onKeyDown}
      >
        {options.map((option, index) => {
          const selected = option.value === value;
          return (
            <button
              key={option.value}
              ref={(el) => {
                refs.current[index] = el;
              }}
              type="button"
              role="radio"
              aria-checked={selected}
              tabIndex={disabled ? -1 : selected ? 0 : -1}
              disabled={disabled}
              className={formStyles.intentOption}
              onClick={() => select(option.value, index)}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
