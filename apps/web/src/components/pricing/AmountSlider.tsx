"use client";

import type { KeyboardEvent } from "react";
import { RangeSlider } from "@th/ui";

import { magnetizeAmountCents } from "@/lib/pricing/pay-what-you-want";

export type AmountSliderProps = {
  /** The committed amount (cents). May sit outside the track; the handle pins. */
  valueCents: number;
  /** Track start, and the lowest amount a drag or a key can produce. */
  floorCents: number;
  /** Track end. */
  maxCents: number;
  onChange: (cents: number) => void;
  /**
   * Accessible name. Must name the tier and must differ from the amount
   * field's name: two controls announced identically is a defect this repo
   * has shipped before.
   */
  label: string;
  /** `aria-valuetext`: the amount as money ("$25.00"), never raw cents. */
  valueText: string;
  /** Amounts a drag lands on when it passes within 40¢ (floor, suggestion). */
  magnetAnchorsCents?: readonly number[];
  /**
   * Highest amount an arrow key or Page Up can reach. The box office leaves it
   * open (a key press past the track end moves the amount, the handle pins);
   * the buyer's checkout stops at the track end, which is never above the
   * $10,000 cap.
   */
  keyboardCeilingCents?: number;
  disabled?: boolean;
  testId?: string;
};

/**
 * What a key does to the amount: the new amount, `null` for a key that is ours
 * but must not move it, or `undefined` for a key that is not ours.
 *
 * A key never moves the amount against its own direction. An amount typed
 * above the track (or below the floor) is the buyer's statement of intent:
 * ArrowUp on a typed $200 above a $60 track used to "step up" to $60, and
 * ArrowDown on an amount under the floor would have raised it.
 *
 *  - Up / Page Up: + $1 / + $5, capped at `keyboardCeilingCents`; nothing at
 *    or above the ceiling.
 *  - Down / Page Down: − $1 / − $5 from the CURRENT amount, never below the
 *    floor; nothing at or below the floor.
 *  - End: the track end, only from below it. Home: the floor.
 */
export function keyboardAmountCents(
  key: string,
  {
    valueCents,
    floorCents,
    maxCents,
    keyboardCeilingCents,
  }: {
    valueCents: number;
    floorCents: number;
    maxCents: number;
    keyboardCeilingCents: number;
  },
): number | null | undefined {
  const up = key === "ArrowRight" || key === "ArrowUp" || key === "PageUp";
  const down = key === "ArrowLeft" || key === "ArrowDown" || key === "PageDown";
  const step = key === "PageUp" || key === "PageDown" ? 500 : 100;
  let next: number;
  if (up) {
    next = Math.min(keyboardCeilingCents, Math.max(floorCents, valueCents + step));
    return next > valueCents ? next : null;
  }
  if (down) {
    next = Math.max(floorCents, valueCents - step);
    return next < valueCents ? next : null;
  }
  if (key === "End") return maxCents > valueCents ? maxCents : null;
  if (key === "Home") return floorCents;
  return undefined;
}

/**
 * A money slider: the box office's pay-what-you-can handle, shared with the
 * buyer's checkout and the embed.
 *
 *  - A DRAG is imprecise, so it gets help: the handle pulls to round money and
 *    to the anchors (`magnetizeAmountCents`), and never leaves the track.
 *  - The KEYBOARD moves in money (`keyboardAmountCents`): $1 on the arrows,
 *    $5 on Page Up/Down, the floor and the track end on Home/End, never
 *    against the key's direction. It has to be handled here: a native range
 *    input moves by exactly `step` (5¢), and the magnet pulled that nudge
 *    straight back, leaving the control keyboard-dead. Key steps are
 *    deliberate amounts, so they skip the magnet.
 *
 * `onChange` fires for every move, so totals beside it follow the handle.
 * Whoever announces a total to a screen reader should wait for the value to
 * settle (the checkout's live region does).
 */
export function AmountSlider({
  valueCents,
  floorCents,
  maxCents,
  onChange,
  label,
  valueText,
  magnetAnchorsCents,
  keyboardCeilingCents = Number.POSITIVE_INFINITY,
  disabled = false,
  testId,
}: AmountSliderProps) {
  const sliderValue = Math.min(Math.max(valueCents, floorCents), maxCents);

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // Alt/Cmd/Ctrl + a key is the browser's or the OS's (Alt+← is Back),
    // never an amount step.
    if (event.altKey || event.metaKey || event.ctrlKey) return;
    const next = keyboardAmountCents(event.key, {
      valueCents,
      floorCents,
      maxCents,
      keyboardCeilingCents,
    });
    if (next === undefined) return; // Not ours: Tab, Escape, …
    // Ours either way: the native 5¢ step must not run behind our back.
    event.preventDefault();
    if (next !== null) onChange(next);
  };

  /**
   * A drag or a tap: magnetized, put back on the 5¢ grid, kept on the track.
   * The native input steps from `min`, so with a floor like $10.13 the browser
   * hands over $17.38; the grid snap commits $17.40 instead (and the floor
   * itself stays reachable through the clamp).
   */
  const handleValueChange = (next: number) => {
    const magnetized = magnetizeAmountCents(next, magnetAnchorsCents);
    const onGrid =
      magnetAnchorsCents?.includes(magnetized) === true
        ? magnetized
        : Math.round(magnetized / 5) * 5;
    onChange(Math.min(maxCents, Math.max(floorCents, onGrid)));
  };

  return (
    <RangeSlider
      value={sliderValue}
      min={floorCents}
      max={maxCents}
      // 5¢ under the finger, magnetized on the way out.
      step={5}
      onValueChange={handleValueChange}
      onKeyDown={handleKeyDown}
      label={label}
      valueText={valueText}
      disabled={disabled}
      testId={testId}
    />
  );
}
