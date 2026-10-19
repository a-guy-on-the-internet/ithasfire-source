"use client";

import React from "react";
import { MapPin } from "lucide-react";

import type { GeocodingResult } from "@/lib/maps/geocoding";

// ── Theme-aware style tokens ─────────────────────────────────────────────
const fg = "var(--foreground, #211C16)";
const bg = "var(--background, #F6F0E4)";

const dropdownStyle: React.CSSProperties = {
  position: "absolute",
  top: "100%",
  left: 0,
  right: 0,
  zIndex: 50,
  marginTop: 4,
  borderRadius: 0,
  border:
    "1px solid color-mix(in srgb, var(--foreground, #211C16) 10%, transparent)",
  background: bg,
  boxShadow: "none",
  overflow: "hidden",
  maxHeight: 260,
  overflowY: "auto" as const,
};

export type GeocodeSuggestionDropdownProps = {
  suggestions: GeocodingResult[];
  isFetching: boolean;
  activeIdx: number;
  onSelect: (result: GeocodingResult) => void;
  onHover: (idx: number) => void;
  dropdownRef: React.RefObject<HTMLDivElement | null>;
  idPrefix: string;
  /** Hide the leading MapPin icon on each row. @default false */
  hideRowIcon?: boolean;
  /**
   * Lead each row with the POI / business name when the hit has one, with the
   * street line beneath. Two businesses at one address otherwise render as
   * byte-identical rows. Turn it off for a postal address field (billing),
   * where the street line is the value being chosen. @default true
   */
  showPoiName?: boolean;
  /** Copy for the "Searching…" row. @default "Searching…" */
  searchingText?: string;
};

/**
 * Presentational dropdown that renders geocoding suggestions.
 * Shared between `LocationAutocomplete` and `CheckoutContactForm`.
 */
export const GeocodeSuggestionDropdown = ({
  suggestions,
  isFetching,
  activeIdx,
  onSelect,
  onHover,
  dropdownRef,
  idPrefix,
  hideRowIcon = false,
  showPoiName = true,
  searchingText = "Searching…",
}: GeocodeSuggestionDropdownProps) => {
  const hasContent = suggestions.length > 0 || isFetching;
  if (!hasContent) return null;

  return (
    <div
      ref={dropdownRef}
      id={`${idPrefix}-listbox`}
      role="listbox"
      style={dropdownStyle}
    >
      {suggestions.map((result, idx) => {
        const isActive = idx === activeIdx;
        const poiName = showPoiName ? result.name : null;
        const street = result.streetLine;
        // A named POI leads with its name; the street line moves to the subtitle
        // so the address is still readable.
        const primary = poiName ?? street ?? result.formattedAddress;
        const subtitle = [
          poiName ? street : null,
          result.locality,
          result.regionCode ?? result.region,
          result.postalCode,
        ]
          .filter(Boolean)
          .join(", ");

        return (
          <button
            key={`${result.lat},${result.lng}-${idx}`}
            id={`${idPrefix}-option-${idx}`}
            role="option"
            aria-selected={isActive}
            type="button"
            onClick={() => onSelect(result)}
            onMouseEnter={() => onHover(idx)}
            data-testid={`${idPrefix}-suggestion-${idx}`}
            style={{
              display: "block",
              width: "100%",
              padding: "10px 14px",
              border: "none",
              background: isActive
                ? "color-mix(in srgb, var(--foreground, #211C16) 6%, transparent)"
                : "transparent",
              color: fg,
              fontSize: 13,
              lineHeight: 1.4,
              textAlign: "left",
              cursor: "pointer",
              transition: "background 0.1s",
              borderBottom:
                idx < suggestions.length - 1
                  ? "1px solid color-mix(in srgb, var(--foreground, #211C16) 6%, transparent)"
                  : "none",
            }}
          >
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {!hideRowIcon && (
                <MapPin
                  size={13}
                  style={{
                    flexShrink: 0,
                    color: `color-mix(in srgb, ${fg} 45%, transparent)`,
                  }}
                />
              )}
              <span style={{ minWidth: 0 }}>
                <span style={{ fontWeight: 500 }}>
                  {primary}
                </span>
                {(poiName || street) && subtitle && (
                  <span
                    style={{
                      display: "block",
                      marginTop: 2,
                      fontSize: 12,
                      color: `color-mix(in srgb, ${fg} 55%, transparent)`,
                    }}
                  >
                    {subtitle}
                  </span>
                )}
              </span>
            </span>
          </button>
        );
      })}

      {isFetching && suggestions.length === 0 && (
        <div
          style={{
            padding: "12px 14px",
            fontSize: 13,
            color: `color-mix(in srgb, ${fg} 55%, transparent)`,
            textAlign: "center",
          }}
        >
          {searchingText}
        </div>
      )}
    </div>
  );
};
