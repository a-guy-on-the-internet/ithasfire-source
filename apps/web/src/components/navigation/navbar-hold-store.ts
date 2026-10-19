/**
 * Holds the consumer navbar SHOWN while an overlay that owns the viewport is
 * open. Read by `ScrollAwareNavbar`.
 *
 * `ScrollAwareNavbar` auto-hides on mobile scroll-down: it translates the bar
 * off the top and sets `pointer-events: none`. An overlay whose trigger lives
 * in the navbar is then stuck with an invisible, non-interactive trigger —
 * measured at 320px, opening the alerts panel after the navbar had already
 * hidden and pressing Escape restored focus to a bell at `top: -76`, outside
 * the viewport and unclickable. Neither the panel's body portal nor its scroll
 * lock can fix that: the navbar was already hidden BEFORE the panel opened.
 * So the overlay holds the navbar shown for as long as it is open.
 *
 * The hold is a COUNTER, not a flag. Two overlays holding at once must not
 * lose-update: the first release has to leave the hold standing while the
 * second still owns one — the same class of bug as a nested scroll lock, where
 * the inner unlock restores a page the outer lock still wants locked.
 *
 * Starts unheld on both server and first client render, so it cannot introduce
 * a hydration mismatch.
 */

import { useEffect, useSyncExternalStore } from "react";

type Listener = () => void;

let holdCount = 0;
const listeners = new Set<Listener>();

function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(): void {
  for (const fn of listeners) fn();
}

/** Is anything currently holding the navbar shown? */
export function isNavbarHeldShown(): boolean {
  return holdCount > 0;
}

/**
 * Take a hold on the navbar being shown. Returns the matching release, which
 * is idempotent — calling it twice must not drop a hold somebody else owns.
 */
export function acquireNavbarShownHold(): () => void {
  holdCount += 1;
  if (holdCount === 1) emit();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holdCount = Math.max(0, holdCount - 1);
    if (holdCount === 0) emit();
  };
}

/** Subscribe to whether the navbar is held shown (false during SSR). */
export function useNavbarHeldShown(): boolean {
  return useSyncExternalStore(subscribe, isNavbarHeldShown, () => false);
}

/**
 * Hold the navbar shown while `active`. Two lines at the call site, and the
 * release rides the effect cleanup — so an overlay that unmounts while open
 * (a route change out from under it) cannot leak a hold.
 */
export function useHoldNavbarShown(active: boolean): void {
  useEffect(() => {
    if (!active) return undefined;
    return acquireNavbarShownHold();
  }, [active]);
}
