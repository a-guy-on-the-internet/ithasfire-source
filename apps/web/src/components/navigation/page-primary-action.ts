"use client";

/**
 * The two page-published channels the consumer mobile bottom nav reads:
 *
 * - the ONE contextual action it renders in its raised centre slot
 *   (Get tickets / Request to book / the checkout step's primary), and
 * - the support opener, owned by the globally-mounted `SupportWidget`.
 *
 * This is all that survives of the deleted contextual action bar's registration
 * store. Everything else a page wants to offer lives IN the page — a header
 * slot, a hero `⋯` menu, a sticky builder header. There is no global action
 * surface and none is coming back.
 *
 * ── Ownership-safe cleanup ──────────────────────────────────────────────────
 * Both slots are module-global, so during route transitions and StrictMode
 * remounts the OUTGOING instance's effect cleanup can run AFTER the INCOMING
 * instance's setup. A naive clear on cleanup would then erase what the new
 * instance just published, leaving the bottom nav with no centre action.
 *
 * Each slot therefore carries an OWNER token (a per-hook-instance Symbol).
 * Publishing claims ownership; cleanup clears the slot ONLY while the departing
 * instance still owns it, so a stale cleanup is a no-op.
 *
 * Limitation: at most ONE live publisher per slot. Two mounted components
 * publishing a primary at once is unsupported — the current owner's unmount
 * clears the slot and the older instance never reclaims it (its effect deps
 * haven't changed, so it never re-registers).
 */

import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";

// ── Store ────────────────────────────────────────────────────────────────────

type Listener = () => void;
type Owner = symbol;

export interface PagePrimaryAction {
  /** Short, translated, verb-first label — it renders uppercase in a 64px square. */
  label: string;
  onPress: () => void;
  /**
   * Accessible name, when `label` alone is ambiguous.
   *
   * The bar MIRRORS a control that is already on the page, so its label can
   * collide with that control's. Publish the same qualified string the source
   * uses. It must contain `label` verbatim (WCAG 2.5.3 Label in Name).
   * Omitted ⇒ the accessible name stays `label`.
   */
  ariaLabel?: string;
}

const listeners = new Set<Listener>();

function emit(): void {
  for (const fn of listeners) fn();
}

function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Snapshots ARE the published values: `useSyncExternalStore` compares by
 * reference, so each slot only ever holds an object that changes identity when
 * something visible about it changed.
 */
let primary: PagePrimaryAction | null = null;
let primaryOwner: Owner | null = null;

let supportOpener: (() => void) | null = null;
let supportOwner: Owner | null = null;

function setPrimary(next: PagePrimaryAction, owner: Owner): void {
  primary = next;
  primaryOwner = owner;
  emit();
}

function clearPrimary(owner: Owner): void {
  // Only the current owner may clear — a stale instance's cleanup must never
  // clobber a newer instance's registration.
  if (primaryOwner !== owner) return;
  primary = null;
  primaryOwner = null;
  emit();
}

function setSupportOpener(next: () => void, owner: Owner): void {
  supportOpener = next;
  supportOwner = owner;
  emit();
}

function clearSupportOpener(owner: Owner): void {
  if (supportOwner !== owner) return;
  supportOpener = null;
  supportOwner = null;
  emit();
}

/**
 * Stable per-instance owner token. Created on first render and kept for the
 * lifetime of the component instance (StrictMode's double-invoked effects
 * share one instance, so they share one token).
 */
function useOwnerToken(): Owner {
  const ref = useRef<Owner | null>(null);
  if (ref.current === null) ref.current = Symbol("page-primary-action");
  return ref.current;
}

// ── Publishing ───────────────────────────────────────────────────────────────

export interface UsePagePrimaryActionOptions extends PagePrimaryAction {
  /**
   * Publish only while true. Defaults to true. A page whose primary is
   * conditional (tickets off sale, venue not accepting bookings, …) passes the
   * condition here rather than calling the hook conditionally.
   */
  enabled?: boolean;
}

/**
 * Publish this page's mobile primary action. Cleared on unmount (or when
 * `enabled` goes false), so a stale action can never be invoked from another
 * route.
 */
export function usePagePrimaryAction({
  label,
  ariaLabel,
  onPress,
  enabled = true,
}: UsePagePrimaryActionOptions): void {
  // A ref keeps the published callback stable across renders, so the effect
  // below re-runs on label/enabled changes only.
  const onPressRef = useRef(onPress);
  onPressRef.current = onPress;
  const owner = useOwnerToken();

  useEffect(() => {
    if (!enabled) {
      clearPrimary(owner);
      return;
    }
    setPrimary({ label, ariaLabel, onPress: () => onPressRef.current() }, owner);
    return () => clearPrimary(owner);
    // `ariaLabel` is a dep, not just a passenger: it interpolates the subject's
    // name, and App Router reconciles this tree in place across a soft nav
    // between two venues. Leaving it out would republish venue A's name under
    // venue B until something else changed `label`.
  }, [label, ariaLabel, enabled, owner]);
}

/**
 * Publish the support panel's opener. Owned by `SupportWidget`, which is
 * globally mounted; `enabled` keeps the key absent on routes where support is
 * not offered.
 */
export function useSupportOpener(open: () => void, enabled = true): void {
  const openRef = useRef(open);
  openRef.current = open;
  const owner = useOwnerToken();

  useEffect(() => {
    if (!enabled) {
      clearSupportOpener(owner);
      return;
    }
    setSupportOpener(() => openRef.current(), owner);
    return () => clearSupportOpener(owner);
  }, [enabled, owner]);
}

// ── Reading ──────────────────────────────────────────────────────────────────

/** The currently-published primary, or `null` when the route has none. */
export function usePagePrimaryActionValue(): PagePrimaryAction | null {
  const value = useSyncExternalStore(
    subscribe,
    () => primary,
    () => null,
  );
  // Identity is already stable per publication; the memo just pins it across
  // unrelated store emits (a support registration, say).
  return useMemo(() => value, [value]);
}

/** The currently-published support opener, or `null`. */
export function useSupportOpenerValue(): (() => void) | null {
  return useSyncExternalStore(
    subscribe,
    () => supportOpener,
    () => null,
  );
}
