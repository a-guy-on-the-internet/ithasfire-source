/**
 * Spotlight Search — External Store
 *
 * Manages the open/close state and per-context query for the spotlight search
 * overlay. Uses `useSyncExternalStore` (same pattern as `cab-store.ts`) so any
 * component can read/write spotlight state without prop drilling or context
 * providers.
 *
 * State is split by context so that:
 *   - Consumer spotlight and /search share the same query.
 *   - Admin spotlight and /admin/:slug/search share their own query.
 *   - Platform (future) has its own query.
 *
 * ── Usage ──────────────────────────────────────────────────────────────────
 *
 *   // Read state:
 *   const { isOpen, consumerQuery, adminQuery } = useSpotlightSnapshot();
 *
 *   // Read the query for the current context:
 *   const query = useContextQuery("consumer"); // or "admin" / "platform"
 *
 *   // Imperative control:
 *   import { openSpotlight, closeSpotlight, setContextQuery } from "./spotlight-store";
 *   setContextQuery("consumer", "live music");
 *
 *   // React hook for the keyboard shortcut + cleanup. GlobalOverlays mounts
 *   // it; nothing else needs to (extra mounts are harmless — ref-counted):
 *   useSpotlightKeyboard();
 */

import { useSyncExternalStore } from "react";
import { useEffect } from "react";
import { isCommandPaletteChord } from "@th/ui/keyboard";

// ── Types ────────────────────────────────────────────────────────────────────

export type SearchContext = "consumer" | "admin" | "platform";

// ── State ────────────────────────────────────────────────────────────────────

interface SpotlightState {
  isOpen: boolean;
  consumerQuery: string;
  adminQuery: string;
  platformQuery: string;
}

let state: SpotlightState = {
  isOpen: false,
  consumerQuery: "",
  adminQuery: "",
  platformQuery: "",
};

// ── Subscription machinery ───────────────────────────────────────────────────

const listeners = new Set<() => void>();

/** Frozen snapshot object — new reference only when state actually changes. */
let snapshot: Readonly<SpotlightState> = Object.freeze({ ...state });

function emit() {
  snapshot = Object.freeze({ ...state });
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function getSnapshot(): Readonly<SpotlightState> {
  return snapshot;
}

// SSR — always closed.
const SERVER_SNAPSHOT: Readonly<SpotlightState> = Object.freeze({
  isOpen: false,
  consumerQuery: "",
  adminQuery: "",
  platformQuery: "",
});

function getServerSnapshot(): Readonly<SpotlightState> {
  return SERVER_SNAPSHOT;
}

// ── Context key mapping ──────────────────────────────────────────────────────

const CONTEXT_KEY: Record<
  SearchContext,
  keyof Pick<SpotlightState, "consumerQuery" | "adminQuery" | "platformQuery">
> = {
  consumer: "consumerQuery",
  admin: "adminQuery",
  platform: "platformQuery",
};

/**
 * Derive the search context from the current pathname.
 *
 *   /admin/:slug/*      → "admin"     (org admin)
 *   /platform/*         → "platform"  (super admin, future)
 *   everything else     → "consumer"  (public browsing)
 *
 * Lives here, beside `CONTEXT_KEY`, because it decides WHICH query slot a
 * component reads and writes — every caller must agree or the contexts bleed
 * into each other. It had been copy-pasted into `SpotlightSearch` and a
 * since-deleted `useSpotlightSearch` hook; this is the one copy.
 */
export function detectSearchContext(pathname: string): SearchContext {
  if (pathname.startsWith("/admin")) return "admin";
  if (pathname.startsWith("/platform")) return "platform";
  return "consumer";
}

// ── Mutators ─────────────────────────────────────────────────────────────────

export function openSpotlight(): void {
  if (!state.isOpen) {
    state = { ...state, isOpen: true };
    emit();
  }
}

export function closeSpotlight(): void {
  if (state.isOpen) {
    state = { ...state, isOpen: false };
    emit();
  }
}

export function toggleSpotlight(): void {
  state = { ...state, isOpen: !state.isOpen };
  emit();
}

/** Set the search query for a specific context. */
export function setContextQuery(context: SearchContext, query: string): void {
  const key = CONTEXT_KEY[context];
  if (state[key] !== query) {
    state = { ...state, [key]: query };
    emit();
  }
}

/** Whether the overlay is open right now (non-reactive). */
export function isSpotlightOpen(): boolean {
  return state.isOpen;
}

/** Read the current query for a specific context (non-reactive). */
export function getContextQuery(context: SearchContext): string {
  return state[CONTEXT_KEY[context]];
}

// ── React hooks ──────────────────────────────────────────────────────────────

/** Subscribe to the full spotlight state snapshot. */
export function useSpotlightSnapshot(): Readonly<SpotlightState> {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Read only the query string for a given search context. */
export function useContextQuery(context: SearchContext): string {
  const snap = useSpotlightSnapshot();
  return snap[CONTEXT_KEY[context]];
}

/**
 * The one document-level shortcut handler. Module-level so every mount of
 * `useSpotlightKeyboard` shares the same function reference — the listener is
 * attached once and `addEventListener` could not double it even if it tried.
 */
function handleSpotlightKeyDown(e: KeyboardEvent): void {
  // ⌘K (Apple) / Ctrl+K (elsewhere; on a Mac Ctrl+K stays the OS kill-line)
  // — toggle spotlight. The platform rule is `isCommandPaletteChord`, shared
  // with the shell's palette shortcut. A modifier chord, so
  // it works from inside inputs too (the spotlight's own input included, which
  // is how ⌘K closes it again). A handler deeper in the tree that already
  // claimed the chord (`defaultPrevented`) keeps it; holding the keys does not
  // strobe the overlay open/closed on auto-repeat.
  if (isCommandPaletteChord(e)) {
    if (e.defaultPrevented) return;
    e.preventDefault();
    if (!e.repeat) toggleSpotlight();
    return;
  }
  // Escape — close spotlight (only if open, to avoid swallowing Escape for
  // other uses). `preventDefault` marks it handled, which is how a layer
  // underneath (the alerts panel listens on `window`, after this `document`
  // listener) knows to leave this one Escape alone.
  if (e.key === "Escape" && state.isOpen) {
    e.preventDefault();
    closeSpotlight();
  }
}

/** Live `useSpotlightKeyboard` mounts — the listener lives while this is > 0. */
let keyboardMounts = 0;

/**
 * Register the global keyboard shortcut (⌘+K / Ctrl+K) for spotlight.
 *
 * Mounted by GlobalOverlays, which every AppChrome branch with chrome renders
 * (public pages, /admin, /platform). The handler is attached in an effect, so
 * it is client-only, and is reference-counted: any number of mounts (StrictMode's
 * mount → unmount → mount included) yield exactly one listener, removed when
 * the last mount goes.
 */
export function useSpotlightKeyboard(): void {
  useEffect(() => {
    keyboardMounts += 1;
    if (keyboardMounts === 1) {
      document.addEventListener("keydown", handleSpotlightKeyDown);
    }
    return () => {
      keyboardMounts -= 1;
      if (keyboardMounts === 0) {
        document.removeEventListener("keydown", handleSpotlightKeyDown);
      }
    };
  }, []);
}
