import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * Roving tabindex for the editor's toolbars (the WAI-ARIA toolbar pattern):
 * the whole toolbar is ONE tab stop, arrow keys move between its buttons,
 * Home/End jump to the ends, and Tab leaves it.
 *
 * DOM-driven rather than state-driven: the toolbar's buttons come and go
 * (image/audio by capability, a whole set folding into "More" at narrow
 * widths), so the order of record is the DOM order. Items render with
 * `tabIndex={-1}` and never change that prop, so React never writes the
 * attribute again after mount; `syncRovingTabStops` is the only writer of
 * the single `0`.
 */

/** Marks an element as one stop in a roving group. */
export const ROVING_ITEM_ATTR = "data-roving-item";

const ITEM_SELECTOR = `[${ROVING_ITEM_ATTR}]`;

export type RovingOrientation = "horizontal" | "both";

const isEnabled = (el: HTMLElement) =>
  el.getAttribute("aria-disabled") !== "true";

/** Every item of the group in DOM order, disabled ones included. */
export function allRovingItems(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(ITEM_SELECTOR));
}

/** The group's items in DOM order, minus disabled ones (they are skipped). */
export function rovingItems(container: HTMLElement): HTMLElement[] {
  return allRovingItems(container).filter(isEnabled);
}

/**
 * Give exactly one item `tabIndex = 0`: `preferred` when it is still an
 * enabled item of this group, else the first enabled item. Every other item,
 * disabled ones included, gets -1. Returns the tab stop (null when every item
 * is disabled, e.g. a read-only editor).
 */
export function syncRovingTabStops(
  container: HTMLElement,
  preferred: HTMLElement | null,
): HTMLElement | null {
  const enabled = rovingItems(container);
  const stop =
    preferred && enabled.includes(preferred) ? preferred : (enabled[0] ?? null);
  for (const el of Array.from(
    container.querySelectorAll<HTMLElement>(ITEM_SELECTOR),
  )) {
    const next = el === stop ? 0 : -1;
    if (el.tabIndex !== next) el.tabIndex = next;
  }
  return stop;
}

/**
 * Where a key press moves focus from `current`, or null when the key is not
 * a roving key. Left/Right wrap; Up/Down only count for `"both"` (a wrapped
 * panel), since a horizontal toolbar leaves them to whatever it opens.
 *
 * `items` is the FULL list, disabled items included: the position is taken
 * from it and disabled items are stepped over. A filtered list cannot place
 * `current` once it has itself turned disabled (Redo, right after the redo
 * that emptied the stack), and the arrows then jumped to the wrong end.
 */
export function rovingTarget(
  items: HTMLElement[],
  current: HTMLElement,
  key: string,
  orientation: RovingOrientation = "horizontal",
): HTMLElement | null {
  const enabled = items.filter(isEnabled);
  if (enabled.length === 0) return null;
  const n = items.length;
  const i = items.indexOf(current);
  const step = (dir: 1 | -1) => {
    if (i === -1) return dir === 1 ? enabled[0] : enabled[enabled.length - 1];
    for (let k = 1; k <= n; k++) {
      const el = items[(((i + dir * k) % n) + n) % n];
      if (isEnabled(el)) return el;
    }
    return null;
  };
  const next = () => step(1);
  const prev = () => step(-1);
  switch (key) {
    case "ArrowRight":
      return next();
    case "ArrowLeft":
      return prev();
    case "ArrowDown":
      return orientation === "both" ? next() : null;
    case "ArrowUp":
      return orientation === "both" ? prev() : null;
    case "Home":
      return enabled[0];
    case "End":
      return enabled[enabled.length - 1];
    default:
      return null;
  }
}

/**
 * Wire a roving group onto an element; returns the callback ref to put on it.
 * A callback ref (held in state) rather than a ref object, because the
 * toolbars mount late: the editor renders a placeholder until Tiptap is
 * ready, and an effect keyed on a ref object would have run once against
 * null and never attached.
 *
 * Re-syncs the tab stop after every render of the calling component, so a
 * button that turns disabled (Undo at the bottom of the history) or unmounts
 * hands the stop on instead of leaving the toolbar with no tab stop at all.
 */
export function useRovingTabStops(
  orientation: RovingOrientation = "horizontal",
): (node: unknown) => void {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const lastFocused = useRef<HTMLElement | null>(null);

  // No dependency list on purpose: runs after every commit of the caller.
  useLayoutEffect(() => {
    if (el) lastFocused.current = syncRovingTabStops(el, lastFocused.current);
  });

  useEffect(() => {
    if (!el) return;
    const itemOf = (target: EventTarget | null) => {
      const node = target instanceof HTMLElement ? target : null;
      const item = node?.closest<HTMLElement>(ITEM_SELECTOR) ?? null;
      return item && el.contains(item) ? item : null;
    };
    const onFocusIn = (event: FocusEvent) => {
      const item = itemOf(event.target);
      if (!item) return;
      lastFocused.current = syncRovingTabStops(el, item);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const item = itemOf(event.target);
      if (!item) return;
      const target = rovingTarget(
        allRovingItems(el),
        item,
        event.key,
        orientation,
      );
      if (!target) return;
      event.preventDefault();
      target.focus();
    };
    el.addEventListener("focusin", onFocusIn);
    el.addEventListener("keydown", onKeyDown);
    return () => {
      el.removeEventListener("focusin", onFocusIn);
      el.removeEventListener("keydown", onKeyDown);
    };
  }, [el, orientation]);

  return useCallback((node: unknown) => {
    setEl(node instanceof HTMLElement ? node : null);
  }, []);
}
