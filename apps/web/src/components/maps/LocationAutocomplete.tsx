"use client";

import { useCallback } from "react";
import { MapPin } from "lucide-react";
import { useTranslations } from "@th/ui";

import type { GeocodingResult } from "@/lib/maps/geocoding";
import { useGeocodeSuggestions } from "@/hooks/use-geocode-suggestions";
import { GeocodeSuggestionDropdown } from "./GeocodeSuggestionDropdown";
import { GeocodeStatusHint } from "./GeocodeStatusHint";

/**
 * Minimal place detail shape consumed by `LocationPinInput` and
 * `EventBuilder`. Matches the interface the old Google-backed version
 * exported — no new callers need to change.
 */
export type PlaceDetail = {
  placeId: string;
  name: string | null;
  formattedAddress: string | null;
  line1: string | null;
  city: string | null;
  region: string | null;
  countryCode: string | null;
  postalCode: string | null;
  lat: number | null;
  lng: number | null;
};

export function geocodingResultToPlaceDetail(
  result: GeocodingResult,
): PlaceDetail {
  return {
    placeId: `${result.lat},${result.lng}`,
    name: result.formattedAddress,
    formattedAddress: result.formattedAddress,
    line1: result.streetLine ?? result.formattedAddress,
    city: result.locality,
    region: result.region,
    countryCode: result.countryCode,
    postalCode: result.postalCode,
    lat: result.lat,
    lng: result.lng,
  };
}

export type LocationAutocompleteProps = {
  value: string;
  onChange: (value: string) => void;
  onSelect: (place: PlaceDetail) => void;
  /**
   * The raw geocoder hit behind a pick, fired just before `onSelect`. For a
   * caller that needs what `PlaceDetail` drops, such as the business name.
   */
  onSelectResult?: (result: GeocodingResult) => void;
  placeholder?: string;
  testIdBase?: string;
  /** @deprecated Ignored — kept for backwards compatibility */
  inputProps?: Record<string, unknown>;
  minVisibleQueryLength?: number;
  /** Sets `required` + `aria-required` on the search input. */
  required?: boolean;
  /** `id` for the search input, so a `<label htmlFor>` can name it. */
  inputId?: string;
  /** Marks the search input invalid and points it at its error. */
  invalid?: boolean;
  describedBy?: string;
};

// ── Style tokens (theme-aware via CSS custom properties) ─────────────────
const fg = "var(--foreground, #211C16)";
const bg = "var(--background, #F6F0E4)";

const inputStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  borderRadius: 0,
  border:
    "1px solid color-mix(in srgb, var(--foreground, #211C16) 12%, transparent)",
  background: bg,
  padding: "10px 14px 10px 38px",
  fontSize: 14,
  color: fg,
  transition: "border-color 0.15s",
};

const iconStyle: React.CSSProperties = {
  pointerEvents: "none",
  position: "absolute",
  left: 12,
  top: "50%",
  transform: "translateY(-50%)",
  color: `color-mix(in srgb, var(--foreground, #211C16) 55%, transparent)`,
};

const LocationAutocomplete = ({
  value,
  onChange,
  onSelect,
  onSelectResult,
  placeholder = "Search location…",
  testIdBase = "location-autocomplete",
  minVisibleQueryLength,
  required,
  inputId,
  invalid,
  describedBy,
}: LocationAutocompleteProps) => {
  const geo = useGeocodeSuggestions({
    minQueryLength: minVisibleQueryLength,
  });

  const handleChange = useCallback(
    (next: string) => {
      onChange(next);
      geo.feed(next);
    },
    [onChange, geo.feed],
  );

  const handleSelect = useCallback(
    (result: GeocodingResult) => {
      onChange(result.formattedAddress);
      geo.close();
      onSelectResult?.(result);
      onSelect(geocodingResultToPlaceDetail(result));
    },
    [onChange, onSelect, onSelectResult, geo.close],
  );

  const t = useTranslations();
  const status = geo.status;
  const hasDropdown =
    geo.showDropdown && (geo.suggestions.length > 0 || geo.isFetching);
  // `aria-expanded` describes the popup of OPTIONS; "Searching…" alone is not.
  const hasOptions = geo.showDropdown && geo.suggestions.length > 0;
  // The listbox only exists while the popup does; a dangling id is worse
  // than none.
  const listboxId = hasDropdown ? `${testIdBase}-listbox` : undefined;

  return (
    <div
      style={{
        width: "100%",
        maxWidth: "100%",
        overflow: "visible",
      }}
      data-testid={testIdBase}
    >
      {/* The icon and the popup are positioned against THIS box, which wraps
          only the input. The status hint is its sibling below: inside, it
          would shift `top: 50%` (icon) and `top: 100%` (popup) to the middle
          and bottom of input + hint. */}
      <div
        data-testid={`${testIdBase}-anchor`}
        style={{ position: "relative", width: "100%" }}
      >
      {/* Leading icon */}
      <MapPin size={16} style={iconStyle} />

      {/* Input */}
      <input
        ref={geo.inputRef}
        id={inputId}
        aria-invalid={invalid ? true : undefined}
        aria-describedby={describedBy}
        type="text"
        name={`${testIdBase}-search`}
        value={value}
        onChange={(e) => handleChange(e.target.value)}
        // `handleKeyDown` returns TRUE for the keys it consumed (arrows, Enter,
        // Tab, Escape). Discarding that boolean let a handled key keep
        // bubbling: Escape closing the suggestion list ALSO reached the
        // window-level listener in `@th/ui`'s BottomSheet, so dismissing the
        // dropdown inside /search's mobile filter sheet closed the sheet too.
        // A control that acts on a key has to own it.
        onKeyDown={(e) => {
          if (geo.handleKeyDown(e, handleSelect)) e.stopPropagation();
        }}
        onFocus={geo.reopen}
        placeholder={placeholder}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        enterKeyHint="search"
        data-form-type="other"
        data-lpignore="true"
        role="combobox"
        aria-expanded={hasOptions}
        aria-autocomplete="list"
        aria-controls={listboxId}
        aria-activedescendant={
          geo.activeIdx >= 0
            ? `${testIdBase}-option-${geo.activeIdx}`
            : undefined
        }
        required={required}
        aria-required={required ? true : undefined}
        data-testid={`${testIdBase}-input`}
        style={inputStyle}
      />

      {/* Dropdown */}
      {hasDropdown && (
        <GeocodeSuggestionDropdown
          suggestions={geo.suggestions}
          isFetching={geo.isFetching}
          activeIdx={geo.activeIdx}
          onSelect={handleSelect}
          onHover={geo.setActiveIdx}
          dropdownRef={geo.dropdownRef}
          idPrefix={testIdBase}
          searchingText={String(t("admin.lacSearching"))}
        />
      )}
      </div>

      <GeocodeStatusHint
        status={geo.showDropdown ? status : null}
        noResultsText={String(t("admin.lacNoMatches"))}
        errorText={String(t("admin.lacSearchError"))}
        idPrefix={testIdBase}
        style={{ marginTop: 6 }}
      />
    </div>
  );
};

export default LocationAutocomplete;
