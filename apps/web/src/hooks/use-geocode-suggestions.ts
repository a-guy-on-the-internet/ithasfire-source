"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  autocompleteAddress,
  forwardGeocode,
  type GeocodingResult,
} from "@/lib/maps/geocoding";
import {
  isAbortError,
  traceIgnoredError,
} from "@/lib/trace-ignored-error";

const DEBOUNCE_MS = 350;

/**
 * Which Geoapify endpoint backs the suggestions.
 *
 * - `search` — `/geocode/search`, tuned for a complete address. The default,
 *   because it is what every caller predating address autocomplete used.
 * - `autocomplete` — `/geocode/autocomplete`, tuned for partial input.
 */
export type GeocodeSuggestionMode = "search" | "autocomplete";

export type UseGeocodeSuggestionsOptions = {
  /** Minimum trimmed query length before firing a geocode request. @default 2 */
  minQueryLength?: number;
  /** @default "search" */
  mode?: GeocodeSuggestionMode;
  /** Debounce window before a request goes out, in ms. @default 350 */
  debounceMs?: number;
};

export type UseGeocodeSuggestionsReturn = {
  suggestions: GeocodingResult[];
  isFetching: boolean;
  showDropdown: boolean;
  activeIdx: number;
  setActiveIdx: React.Dispatch<React.SetStateAction<number>>;
  /**
   * True when the most recent settled request THREW (network down, 401, quota
   * exhausted). Distinct from "settled with zero results" — the UI has to tell
   * "we looked and found nothing" apart from "we could not look", because only
   * the second one means the provider is the problem.
   */
  error: boolean;
  /**
   * The query whose response is currently in {@link suggestions}, or `null`
   * before anything has settled. Lets a caller distinguish "no results yet"
   * from "no results for what you typed".
   */
  settledQuery: string | null;
  /**
   * What to tell the user about an empty list: `"no-results"` (looked, found
   * nothing) or `"error"` (could not look). STICKY across a re-fetch: it keeps
   * its last value while the next keystroke's request is in flight, so an
   * in-flow hint does not vanish and reappear (layout shift) on every
   * character. Cleared when results arrive, on `close()`, and when the query
   * drops below the minimum length.
   */
  status: "no-results" | "error" | null;

  /** Call when the text value changes. Debounces geocode requests automatically. */
  feed: (query: string) => void;
  /** Dismiss the dropdown. */
  close: () => void;
  /** Re-show the dropdown (e.g. on focus) if there are results. */
  reopen: () => void;
  /** Ref to attach to the input element (for click-outside detection). */
  inputRef: React.RefObject<HTMLInputElement | null>;
  /** Ref to attach to the dropdown container (for click-outside detection). */
  dropdownRef: React.RefObject<HTMLDivElement | null>;
  /** Keyboard handler to attach to the input. Returns `true` if the event was handled. */
  handleKeyDown: (
    e: React.KeyboardEvent,
    onCommit: (result: GeocodingResult) => void,
  ) => boolean;
};

/**
 * Headless hook that manages debounced forward-geocode suggestions,
 * keyboard navigation, and click-outside dismissal.
 *
 * Shared by `LocationAutocomplete` (general location search),
 * `CheckoutContactForm` (billing address autocomplete) and
 * `AddressAutocompleteInput` (the admin place editor's address field, which
 * opts into `mode: "autocomplete"`).
 */
export function useGeocodeSuggestions(
  opts: UseGeocodeSuggestionsOptions = {},
): UseGeocodeSuggestionsReturn {
  const minLen = opts.minQueryLength ?? 2;
  const mode = opts.mode ?? "search";
  const debounceMs = opts.debounceMs ?? DEBOUNCE_MS;

  const [suggestions, setSuggestions] = useState<GeocodingResult[]>([]);
  const [isFetching, setIsFetching] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const [error, setError] = useState(false);
  const [settledQuery, setSettledQuery] = useState<string | null>(null);
  const [status, setStatus] = useState<"no-results" | "error" | null>(null);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // ── Feed a new query string ────────────────────────────────────────
  const feed = useCallback(
    (query: string) => {
      setActiveIdx(-1);

      if (debounceRef.current) clearTimeout(debounceRef.current);

      const trimmed = query.trim();
      if (trimmed.length < minLen) {
        // Retiring the request id here is load-bearing, not tidiness. Without
        // it, typing a long query and then deleting back under `minLen` left
        // the already-dispatched request live: its `.then` still matched
        // `requestIdRef.current`, so it repopulated `suggestions` AFTER the
        // clear and the listbox reopened over an input the user had emptied.
        // The abort is the same fix one layer down — stop paying for a
        // response nobody will read.
        requestIdRef.current += 1;
        abortRef.current?.abort();
        abortRef.current = null;
        setSuggestions([]);
        setShowDropdown(false);
        setIsFetching(false);
        setError(false);
        setSettledQuery(null);
        setStatus(null);
        return;
      }

      setIsFetching(true);
      setShowDropdown(true);

      debounceRef.current = setTimeout(() => {
        const reqId = ++requestIdRef.current;
        // Cancel the previous in-flight lookup before starting another. The
        // `reqId` guard below still stands on its own (an abort can lose the
        // race with a response already being parsed) — this just stops us
        // burning a Geoapify credit's worth of bandwidth on a dead answer.
        abortRef.current?.abort();
        const controller = new AbortController();
        abortRef.current = controller;

        const lookup = mode === "autocomplete" ? autocompleteAddress : forwardGeocode;

        void lookup(trimmed, { signal: controller.signal })
          .then((results) => {
            if (reqId !== requestIdRef.current) return;
            setSuggestions(results);
            setError(false);
            setSettledQuery(trimmed);
            setStatus(results.length === 0 ? "no-results" : null);
          })
          .catch((err) => {
            traceIgnoredError("geocode.suggest", isAbortError)(err);
            if (reqId !== requestIdRef.current) return;
            setSuggestions([]);
            // An abort is US superseding the request, not a provider failure —
            // surfacing "lookup unavailable" for it would flash an error on
            // every fast typist's screen.
            if (!isAbortError(err)) {
              setError(true);
              setSettledQuery(trimmed);
              setStatus("error");
            }
          })
          .finally(() => {
            if (reqId === requestIdRef.current) setIsFetching(false);
          });
      }, debounceMs);
    },
    [debounceMs, minLen, mode],
  );

  // ── Keyboard navigation ────────────────────────────────────────────
  const handleKeyDown = useCallback(
    (
      e: React.KeyboardEvent,
      onCommit: (result: GeocodingResult) => void,
    ): boolean => {
      if (!showDropdown) return false;
      // Escape must close (and be consumed) even with no options on screen:
      // "Searching…" is still a popup, and an unconsumed Escape bubbles to a
      // surrounding sheet or dialog and closes THAT instead.
      if (e.key === "Escape") {
        setShowDropdown(false);
        return true;
      }
      if (suggestions.length === 0) {
        // Tab with no rows: close the popup so a "Searching…" box (and the
        // rows that would land later) cannot open over the field focus just
        // moved to. Not consumed, so focus still moves.
        if (e.key === "Tab") setShowDropdown(false);
        return false;
      }

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIdx((prev) => Math.min(prev + 1, suggestions.length - 1));
        return true;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIdx((prev) => Math.max(prev - 1, 0));
        return true;
      }
      if (e.key === "Enter" && activeIdx >= 0) {
        e.preventDefault();
        onCommit(suggestions[activeIdx]);
        return true;
      }
      if (e.key === "Tab" && suggestions.length > 0) {
        // Select the highlighted item, or the first item if none highlighted
        const idx = activeIdx >= 0 ? activeIdx : 0;
        e.preventDefault();
        onCommit(suggestions[idx]);
        return true;
      }
      return false;
    },
    [showDropdown, suggestions, activeIdx],
  );

  const close = useCallback(() => {
    setShowDropdown(false);
    setStatus(null);
  }, []);

  const reopen = useCallback(() => {
    if (suggestions.length > 0) setShowDropdown(true);
  }, [suggestions.length]);

  // ── Click-outside ──────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node) &&
        inputRef.current &&
        !inputRef.current.contains(e.target as Node)
      ) {
        setShowDropdown(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // Never leave a timer or a socket behind on unmount.
  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      abortRef.current?.abort();
    },
    [],
  );

  return {
    suggestions,
    isFetching,
    showDropdown,
    activeIdx,
    setActiveIdx,
    error,
    settledQuery,
    status,
    feed,
    close,
    reopen,
    inputRef,
    dropdownRef,
    handleKeyDown,
  };
}
