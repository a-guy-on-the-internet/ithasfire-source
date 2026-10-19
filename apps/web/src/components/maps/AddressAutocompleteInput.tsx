"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { MapPin, Search } from "lucide-react";
import { XStack, YStack } from "tamagui";
import { Spinner, Text, useTranslations } from "@th/ui";

import { useGeocodeSuggestions } from "@/hooks/use-geocode-suggestions";
import type { GeocodingResult } from "@/lib/maps/geocoding";
import { ACCENT, ACCENT_TEXT, MUTED_TEXT } from "@/lib/design-tokens";

// ─────────────────────────────────────────────────────────────────────────────
// AddressAutocompleteInput — debounced Geoapify address search (FR-016/FR-017)
// ─────────────────────────────────────────────────────────────────────────────
//
// NOT to be confused with `app/_components/place-review/_primitives/
// PlaceAutocomplete.tsx`, which searches our OWN place directory for an
// existing Place record and resolves no coordinates. This one resolves a
// STREET ADDRESS through Geoapify and hands back structured fields + lat/lng.
//
// It is a filler, not a field: it owns no persisted value. The caller keeps the
// structured address in its own state and this component only pushes a
// selection into it, so a manual typist never has to touch the search box and
// a provider outage degrades to plain manual entry.

/** Everything a selection resolves. Every string is trimmed and may be `""`. */
export type ResolvedAddress = {
  line1: string;
  city: string;
  region: string;
  postalCode: string;
  countryCode: string;
  formatted: string;
  lat: number;
  lng: number;
};

export type AddressAutocompleteInputProps = {
  /** Accessible label for the search box. */
  label: string;
  placeholder: string;
  /** Fired when the user commits a suggestion (click, Enter). */
  onSelect: (address: ResolvedAddress) => void;
  /**
   * Fired when the user asks to fill the address in by hand — from the
   * no-results hint or the provider-error hint. The caller decides what that
   * means (typically: reveal the structured fields).
   */
  onRequestManualEntry?: () => void;
  disabled?: boolean;
  testId?: string;
};

/**
 * Debounce + minimum length.
 *
 * 350ms matches `useGeocodeSuggestions`' shipped default (the spec asks for
 * "~300ms"), and 4 characters is deliberately stricter than the hook's default
 * of 2: autocomplete bills per request the same as a geocode, Geoapify returns
 * NO remaining-quota header to measure headroom against, and a 2-char street
 * query ("6 ") has nothing to match on anyway.
 */
const DEBOUNCE_MS = 350;
const MIN_QUERY_LENGTH = 4;

const srOnly: React.CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0,0,0,0)",
  whiteSpace: "nowrap",
  border: 0,
};

/**
 * Raw `<input>`, not `@th/ui`'s `TextInput`, for one measured reason: React
 * Native Web's TextInput drops `onKeyDown` (verified in jsdom — `role` and the
 * whole `aria-*` set DO survive the trip, the key handler does not), and a
 * combobox without arrow keys is not a combobox.
 *
 * The values below are the ones its SIBLING inputs actually render, read off
 * the live page with `getComputedStyle` — not the ones `StyledTextInput`
 * declares. Those differ: `globals.css`'s blanket
 * `input:not([type=…])` reset has specificity (0,6,1) and beats Tamagui's
 * atomic classes (0,2,0), so every DS TextInput on this form paints the
 * reset's soft border / `--background` fill / 14px / `10px 14px`, and the
 * declared `$borderColor` ink, `$surface` fill and `$3` (16px) never land.
 * Styling to the DECLARED tokens made this field a visibly different species
 * sitting among them. Inline styles outrank any selector, so these win
 * without `!important` — including over the reset's own `:focus` rule, which
 * is why focus is tracked in state rather than left to CSS.
 */
const inputStyle = (
  focused: boolean,
  disabled: boolean,
): React.CSSProperties => ({
  width: "100%",
  boxSizing: "border-box",
  // The siblings are height-locked at 36 by Tamagui's `_height-t-size-true`
  // class (one of the few declarations the globals reset does NOT override),
  // so matching their padding alone left this field 42px tall and visibly out
  // of step in the stack. Zero vertical padding + an explicit height lets the
  // input centre its own text, which is what the DS ones end up doing too.
  height: 36,
  padding: "0 14px 0 40px",
  borderWidth: 2,
  borderStyle: "solid",
  borderColor: focused ? ACCENT : "var(--borderColorSoft, rgba(33,28,22,0.3))",
  borderRadius: 0,
  background: "var(--background, #F6F0E4)",
  color: "var(--color, #211C16)",
  fontSize: 14,
  fontFamily: "var(--font-body, Montserrat)",
  transition: "border-color 150ms ease-out",
  opacity: disabled ? 0.6 : 1,
  cursor: disabled ? "not-allowed" : "text",
});

/**
 * Vertical room the popup must leave for FIXED bottom chrome.
 *
 * Measured, not guessed: the admin shell's mobile `NavigationBottomBar` is 85px
 * tall and `position: fixed` at the viewport bottom, and at 320×760 the popup
 * ran from y=528 to y=753 straight underneath it — the second suggestion was
 * invisible AND untappable. 96 clears that bar and the floating action dock.
 */
const BOTTOM_CHROME_ALLOWANCE = 96;
const MIN_LIST_HEIGHT = 120;
const MAX_LIST_HEIGHT = 264;
/**
 * Below this much room underneath the field, flipping up is worth considering.
 * Deliberately ABOVE {@link MIN_LIST_HEIGHT}: at 320×760 the field left exactly
 * 130px below the fold, which technically fits but showed barely one of the two
 * suggestions. Only flips when the room above is meaningfully better (1.5×), so
 * a field in the middle of a tall page still opens downward as expected.
 */
const FLIP_THRESHOLD = 160;

type Placement = { side: "top" | "bottom"; maxHeight: number };

const listboxStyle = ({ side, maxHeight }: Placement): React.CSSProperties => ({
  position: "absolute",
  ...(side === "top"
    ? { bottom: "100%", marginBottom: 2 }
    : { top: "100%", marginTop: 2 }),
  left: 0,
  right: 0,
  zIndex: 50,
  listStyle: "none",
  margin: side === "top" ? "0 0 2px" : "2px 0 0",
  padding: 0,
  maxHeight,
  overflowY: "auto",
  // The popup gets the HARD ink edge even though the field itself carries the
  // soft one: it floats over the form and needs a decisive boundary, and an
  // overlay is exactly where v2's print-style border belongs.
  borderWidth: 2,
  borderStyle: "solid",
  borderColor: "var(--borderColor, #211C16)",
  borderRadius: 0,
  background: "var(--surface, #FDFAF3)",
});

export function AddressAutocompleteInput({
  label,
  placeholder,
  onSelect,
  onRequestManualEntry,
  disabled = false,
  testId = "address-autocomplete",
}: AddressAutocompleteInputProps) {
  const t = useTranslations();
  const reactId = useId().replace(/:/g, "");
  const inputId = `${reactId}-input`;
  const listboxId = `${reactId}-listbox`;
  const hintId = `${reactId}-hint`;
  const optionId = (idx: number) => `${reactId}-option-${idx}`;

  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(false);
  const blurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const geo = useGeocodeSuggestions({
    mode: "autocomplete",
    minQueryLength: MIN_QUERY_LENGTH,
    debounceMs: DEBOUNCE_MS,
  });

  const {
    suggestions,
    isFetching,
    showDropdown,
    activeIdx,
    setActiveIdx,
    error,
    settledQuery,
    feed,
    close,
    reopen,
    inputRef,
  } = geo;

  const open = showDropdown && suggestions.length > 0 && !disabled;

  const [placement, setPlacement] = useState<Placement>({
    side: "bottom",
    maxHeight: MAX_LIST_HEIGHT,
  });

  /**
   * Fit the popup to the room actually available, and flip it above the field
   * when there is not enough below.
   *
   * Purely `top: 100%` put the list under the admin shell's fixed mobile
   * bottom bar at 320px — the second suggestion was neither visible nor
   * tappable. Re-measured on scroll and resize because both move the field
   * relative to that fixed chrome.
   */
  useEffect(() => {
    if (!open) return;
    const measure = () => {
      const rect = inputRef.current?.getBoundingClientRect();
      if (!rect) return;
      const below =
        window.innerHeight - rect.bottom - BOTTOM_CHROME_ALLOWANCE - 8;
      const above = rect.top - 8;
      const clamp = (v: number) =>
        Math.max(MIN_LIST_HEIGHT, Math.min(MAX_LIST_HEIGHT, v));
      setPlacement(
        below < FLIP_THRESHOLD && above > below * 1.5
          ? { side: "top", maxHeight: clamp(above) }
          : { side: "bottom", maxHeight: clamp(below) },
      );
    };
    measure();
    window.addEventListener("resize", measure);
    // Capture phase: the admin shell scrolls an inner container, not the
    // document, so a bubbling listener on `window` would never fire.
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open, suggestions.length, inputRef]);

  useEffect(
    () => () => {
      if (blurTimerRef.current) clearTimeout(blurTimerRef.current);
    },
    [],
  );

  // Keep the highlighted option inside the scroll viewport.
  useEffect(() => {
    if (!open || activeIdx < 0) return;
    // `?.scrollIntoView?.()` — jsdom does not implement it, and a keyboard
    // handler must not throw just because the option happens to be visible.
    document.getElementById(optionId(activeIdx))?.scrollIntoView?.({
      block: "nearest",
    });
    // `optionId` is derived from a stable id; re-deriving it each render is
    // cheaper than memoising it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIdx, open, reactId]);

  const commit = useCallback(
    (result: GeocodingResult) => {
      onSelect({
        line1: result.streetLine?.trim() ?? "",
        city: result.locality?.trim() ?? "",
        // Prefer the ISO subdivision code ("TN") over the long form
        // ("Tennessee"): `Place.region` feeds the slug and the `region` column,
        // which every other write path stores as a code.
        region: (result.regionCode ?? result.region)?.trim() ?? "",
        postalCode: result.postalCode?.trim() ?? "",
        countryCode: result.countryCode?.trim().toUpperCase() ?? "",
        formatted: result.formattedAddress.trim(),
        lat: result.lat,
        lng: result.lng,
      });
      // The box is a tool, not a field — clearing it after a commit makes the
      // structured fields below the single source of truth and stops a stale
      // half-query sitting there looking like unsaved input.
      setQuery("");
      feed("");
      close();
    },
    [close, feed, onSelect],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      switch (event.key) {
        case "ArrowDown":
          if (!open) return;
          event.preventDefault();
          setActiveIdx((prev) => Math.min(prev + 1, suggestions.length - 1));
          return;
        case "ArrowUp":
          if (!open) return;
          event.preventDefault();
          setActiveIdx((prev) => Math.max(prev - 1, 0));
          return;
        case "Home":
          if (!open) return;
          event.preventDefault();
          setActiveIdx(0);
          return;
        case "End":
          if (!open) return;
          event.preventDefault();
          setActiveIdx(suggestions.length - 1);
          return;
        case "Enter":
          if (!open || activeIdx < 0) return;
          event.preventDefault();
          commit(suggestions[activeIdx]!);
          return;
        case "Escape":
          // Dismiss the listbox and KEEP what was typed. Only swallowed while
          // the listbox is open, so a closed combobox lets Escape reach a
          // surrounding dialog.
          if (!open) return;
          event.preventDefault();
          event.stopPropagation();
          close();
          setActiveIdx(-1);
          return;
        case "Tab":
          // NEVER prevented. Tab moves focus onward; the listbox just closes.
          // (The shared hook's own `handleKeyDown` commits on Tab — that is
          // why this component does not use it.)
          if (open) close();
          return;
        default:
      }
    },
    [activeIdx, close, commit, open, setActiveIdx, suggestions],
  );

  const settled = settledQuery !== null && !isFetching;
  const showNoResults = settled && !error && suggestions.length === 0;
  const showError = settled && error;

  /** Single live-region string, so only one announcement lands per change. */
  const announcement = isFetching
    ? String(t("admin.placeEditAddressSearchSearching"))
    : showError
      ? String(t("admin.placeEditAddressSearchError"))
      : showNoResults
        ? String(t("admin.placeEditAddressSearchNoResults"))
        : open
          ? String(
              t("admin.placeEditAddressSearchResultCount", {
                count: suggestions.length,
              }),
            )
          : "";

  return (
    <YStack gap="$2" width="100%">
      {/* A real <label>, not `Text tag="label"`: Tamagui's Paragraph does not
          reliably forward `htmlFor` through RNW, which is how the sibling
          volunteer-pack forms ended up with visible labels a screen reader
          could not see. Wrapping the styled Text in a native label makes the
          association structural instead of attribute-dependent. */}
      <label htmlFor={inputId} style={{ display: "block", cursor: "pointer" }}>
        <Text variant="bodySmall" weight="bold">
          {label}
        </Text>
      </label>

      <div style={{ position: "relative", width: "100%" }} data-testid={testId}>
        <span
          aria-hidden="true"
          style={{
            position: "absolute",
            left: 12,
            top: "50%",
            transform: "translateY(-50%)",
            display: "flex",
            pointerEvents: "none",
            color: MUTED_TEXT,
          }}
        >
          {isFetching ? (
            <Spinner width={16} height={16} borderWidth={2} />
          ) : (
            <Search size={16} strokeWidth={2} color="currentColor" />
          )}
        </span>

        <input
          ref={inputRef}
          id={inputId}
          type="text"
          value={query}
          disabled={disabled}
          placeholder={placeholder}
          // The listbox replaces native autofill on this field; leaving it on
          // stacks the browser's own address dropdown over ours.
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          enterKeyHint="search"
          data-form-type="other"
          data-lpignore="true"
          data-testid={`${testId}-input`}
          role="combobox"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={
            open && activeIdx >= 0 ? optionId(activeIdx) : undefined
          }
          aria-describedby={hintId}
          onChange={(event) => {
            setQuery(event.target.value);
            feed(event.target.value);
          }}
          onKeyDown={handleKeyDown}
          onFocus={() => {
            if (blurTimerRef.current) clearTimeout(blurTimerRef.current);
            setFocused(true);
            reopen();
          }}
          onBlur={() => {
            setFocused(false);
            // Deferred so a pointer press on an option still lands. The
            // options also `preventDefault` on mousedown, so this is the
            // belt to that suspenders (touch/AT activation paths).
            blurTimerRef.current = setTimeout(() => close(), 150);
          }}
          style={inputStyle(focused, disabled)}
        />

        {open && (
          <ul
            id={listboxId}
            role="listbox"
            aria-label={String(t("admin.placeEditAddressSuggestionsLabel"))}
            data-placement={placement.side}
            style={listboxStyle(placement)}
          >
            {suggestions.map((result, idx) => {
              const isActive = idx === activeIdx;
              // A named POI leads with its NAME, not its street. Geoapify
              // returns the venue ("Bowery Ballroom") and the building at the
              // same address as two separate hits with the same `streetLine`,
              // so leading with the street rendered two identical-looking rows
              // — measured on the real provider, not theorised.
              const primary =
                result.name ?? result.streetLine ?? result.formattedAddress;
              const secondary = [
                result.name ? result.streetLine : null,
                result.locality,
                result.regionCode ?? result.region,
                result.postalCode,
              ]
                .filter(Boolean)
                .join(", ");

              return (
                <li
                  key={`${result.lat},${result.lng}-${idx}`}
                  id={optionId(idx)}
                  role="option"
                  aria-selected={isActive}
                  tabIndex={-1}
                  data-testid={`${testId}-option-${idx}`}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActiveIdx(idx)}
                  onClick={() => commit(result)}
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 8,
                    padding: "10px 12px",
                    cursor: "pointer",
                    background: isActive
                      ? "color-mix(in srgb, var(--color, #211C16) 8%, transparent)"
                      : "transparent",
                    // The keyboard cursor. A tint alone is too quiet to answer
                    // "where am I?" at a glance, and this is the ONLY signal a
                    // keyboard user gets — focus never leaves the input. Always
                    // 3px, transparent when inactive, so the row never shifts.
                    borderLeftWidth: 3,
                    borderLeftStyle: "solid",
                    borderLeftColor: isActive ? ACCENT : "transparent",
                    borderBottomWidth: idx < suggestions.length - 1 ? 1 : 0,
                    borderBottomStyle: "solid",
                    borderBottomColor:
                      "var(--borderColorSoft, rgba(33,28,22,0.3))",
                  }}
                >
                  <MapPin
                    size={14}
                    strokeWidth={2}
                    aria-hidden="true"
                    style={{
                      flexShrink: 0,
                      marginTop: 3,
                      color: isActive ? ACCENT_TEXT : MUTED_TEXT,
                    }}
                  />
                  <span style={{ minWidth: 0 }}>
                    <Text variant="bodySmall" weight="bold">
                      {primary}
                    </Text>
                    {secondary ? (
                      <Text variant="caption" tone="muted">
                        {secondary}
                      </Text>
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* One always-mounted live region. Mounting it conditionally means the
          first announcement is missed — assistive tech has to observe the
          region BEFORE its contents change. */}
      <span role="status" aria-live="polite" aria-atomic="true" style={srOnly}>
        {announcement}
      </span>

      {/* `id` lives on a plain wrapper rather than on `Text`, so
          `aria-describedby` cannot dangle if Tamagui declines to forward it. */}
      <div id={hintId} data-testid={`${testId}-hint`}>
        {showNoResults || showError ? (
          <XStack gap="$2" alignItems="center" flexWrap="wrap">
            <Text variant="caption" tone="muted">
              {showError
                ? String(t("admin.placeEditAddressSearchError"))
                : String(t("admin.placeEditAddressSearchNoResults"))}
            </Text>
            {onRequestManualEntry ? (
              <button
                type="button"
                onClick={onRequestManualEntry}
                style={{
                  padding: 0,
                  border: "none",
                  background: "transparent",
                  color: ACCENT_TEXT,
                  fontFamily: "var(--font-body, Montserrat)",
                  fontSize: 12,
                  fontWeight: 700,
                  textDecoration: "underline",
                  cursor: "pointer",
                }}
              >
                {String(t("admin.placeEditAddressManualCta"))}
              </button>
            ) : null}
          </XStack>
        ) : (
          <Text variant="caption" tone="muted">
            {String(t("admin.placeEditAddressSearchHint"))}
          </Text>
        )}
      </div>
    </YStack>
  );
}
