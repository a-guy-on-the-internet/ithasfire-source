import type { PayoutSchedule } from "@th/types";

/**
 * Keyboard navigation for the payout-schedule radio group.
 *
 * Same shape as `embeds-tab-nav.helpers.ts` (pure resolver + roving tabindex in
 * the component), but the ARIA *radio* pattern rather than the tabs pattern:
 * the list is vertical, so Up/Down are the primary keys and Left/Right are
 * accepted as equivalents. Per the radio pattern an arrow key moves focus AND
 * selection together — there is no "focus without selecting" state to model.
 *
 * Wrapping is deliberate (last -> first): the WAI-ARIA radio group pattern
 * specifies a circular list, unlike a listbox.
 */

/** DOM id for a schedule option row, so focus can follow selection. */
export const scheduleOptionDomId = (value: PayoutSchedule): string =>
  `payout-schedule-option-${value}`;

/**
 * Resolve the schedule an arrow/Home/End key should move to, or `null` when the
 * key is not one this group handles (so the caller leaves the event alone —
 * never `preventDefault` a key you did not act on).
 */
export function nextScheduleForKey(
  current: PayoutSchedule | undefined,
  key: string,
  order: readonly PayoutSchedule[],
): PayoutSchedule | null {
  if (order.length === 0) return null;

  // Nothing selected yet (pre-first-save). Handled explicitly rather than via
  // an `idx = -1` sentinel: -1 already means "one before the first", so the
  // usual `idx - 1` wrap lands on the second-to-last option instead of the
  // last. Forward enters at the first option, backward at the last.
  if (current === undefined) {
    switch (key) {
      case "ArrowDown":
      case "ArrowRight":
      case "Home":
        return order[0] ?? null;
      case "ArrowUp":
      case "ArrowLeft":
      case "End":
        return order[order.length - 1] ?? null;
      default:
        return null;
    }
  }

  const idx = order.indexOf(current);
  if (idx === -1) return null;

  switch (key) {
    case "ArrowDown":
    case "ArrowRight":
      return order[(idx + 1) % order.length] ?? null;
    case "ArrowUp":
    case "ArrowLeft":
      return order[(idx - 1 + order.length) % order.length] ?? null;
    case "Home":
      return order[0] ?? null;
    case "End":
      return order[order.length - 1] ?? null;
    default:
      return null;
  }
}

/** Keys that select the currently focused radio without moving focus. */
export function isSelectionKey(key: string): boolean {
  return key === " " || key === "Spacebar";
}
