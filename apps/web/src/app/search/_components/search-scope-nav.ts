/**
 * search-scope-nav — keyboard model for /search's scope radiogroup.
 *
 * The scope row (All / Events / People / Groups / Places) is the page's single
 * result-narrowing control, so it has to behave like a real WAI-ARIA
 * radiogroup: one tab stop, arrows move focus AND selection, the list wraps.
 * The logic lives here, pure and framework-free, mirroring the house pattern
 * (`embeds-tab-nav.helpers.ts`, `payout-schedule-nav.helpers.ts`).
 *
 * Returning `null` for an unhandled key is load-bearing: the component must
 * never `preventDefault` a key it did not act on, or Tab becomes a trap.
 */

import type { SearchScope } from "./search-url";

/** Left-to-right order of the scope row. Also the arrow-key traversal order. */
export const SCOPE_ORDER: readonly SearchScope[] = [
  "all",
  "event",
  "human",
  "organization",
  "place",
];

/** DOM id for a scope radio — focus follows selection via getElementById. */
export const scopeRadioDomId = (scope: SearchScope): string =>
  `search-scope-${scope}`;

/**
 * The scope a key press should move to, or `null` when the key is not part of
 * the radiogroup model.
 *
 * Horizontal row, so Left/Right are primary; Up/Down are accepted as
 * equivalents (a wrapped row can read as either axis). Home/End jump to the
 * ends. Space/Enter re-select whatever Tab landed on, which matters because a
 * roving tabindex can put focus on the selected item without a click.
 */
export const nextScopeForKey = (
  current: SearchScope,
  key: string,
  order: readonly SearchScope[] = SCOPE_ORDER,
): SearchScope | null => {
  if (order.length === 0) return null;
  const index = order.indexOf(current);

  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      // `indexOf` returns -1 when the current value is not in the order, which
      // would make `(-1 + 1)` land on the FIRST entry — which is what we want
      // going forward, so the generic form is correct here. Backwards is not
      // (see below), so both directions branch explicitly rather than sharing
      // a modulo that is only accidentally right in one of them.
      return order[index < 0 ? 0 : (index + 1) % order.length] ?? null;
    case "ArrowLeft":
    case "ArrowUp":
      // -1 already means "one before the first", so reusing the wrap formula
      // would land on the second-to-last entry. Branch on "not found" instead.
      return (
        order[index < 0 ? order.length - 1 : (index - 1 + order.length) % order.length] ??
        null
      );
    case "Home":
      return order[0] ?? null;
    case "End":
      return order[order.length - 1] ?? null;
    case " ":
    case "Enter":
      return index < 0 ? (order[0] ?? null) : current;
    default:
      return null;
  }
};
