/**
 * Visible height of the consumer navbar, published by `ScrollAwareNavbar`.
 *
 * Read by surfaces that must sit just under the navbar while it is shown — and
 * rise to `top: 0` when it slides away on mobile scroll — but cannot inherit a
 * CSS custom property from it: the navbar wrapper is a SIBLING of the content
 * area, and the directions sheet is portalled into `document.body`.
 *
 * Starts at 0 on both server and first client render (no hydration mismatch);
 * the real height lands from `ScrollAwareNavbar`'s mount effect.
 */

import { useSyncExternalStore } from "react";

type Listener = () => void;

let visibleHeight = 0;
const listeners = new Set<Listener>();

function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Publish the navbar's currently VISIBLE height in px (0 while hidden). */
export function setNavbarVisibleHeight(next: number): void {
  const rounded = Math.max(0, Math.round(next));
  if (rounded === visibleHeight) return;
  visibleHeight = rounded;
  for (const fn of listeners) fn();
}

/** Subscribe to the navbar's visible height (0 during SSR / first paint). */
export function useNavbarVisibleHeight(): number {
  return useSyncExternalStore(
    subscribe,
    () => visibleHeight,
    () => 0,
  );
}
