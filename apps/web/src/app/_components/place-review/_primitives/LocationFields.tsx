"use client";

import { Reveal, FieldLabel } from "@th/ui";
import { getRegionsForCountry } from "@/lib/location/address-data";
import { BORDER, INPUT_STYLE, MAX } from "../_shared/tokens";
import { CountryCombobox, RegionCombobox } from "./CountryCombobox";

// ─────────────────────────────────────────────────────────────────────────────
// LocationFields — city + country + state/region section for custom venues
// ─────────────────────────────────────────────────────────────────────────────

interface LocationFieldsProps {
  show: boolean;
  placeName: string;
  placeCity: string;
  placeCountry: string;
  placeState: string;
  onCustom: (patch: {
    placeName?: string;
    placeCity?: string;
    placeCountry?: string;
    placeState?: string;
  }) => void;
}

export function LocationFields({
  show,
  placeName,
  placeCity,
  placeCountry,
  placeState,
  onCustom,
}: LocationFieldsProps) {
  return (
    <Reveal show={show}>
      <div
        style={{
          marginTop: 12,
          display: "flex",
          flexDirection: "column",
          gap: 10,
          paddingLeft: 12,
          borderLeft: `2px solid ${BORDER}`,
        }}
      >
        <div>
          <FieldLabel>City</FieldLabel>
          <input
            type="text"
            aria-label="City"
            autoComplete="address-level2"
            enterKeyHint="next"
            value={placeCity}
            onChange={(e) => onCustom({ placeName, placeCity: e.target.value })}
            placeholder="City…"
            maxLength={MAX.CITY}
            style={INPUT_STYLE}
          />
        </div>
        <Reveal show={placeCity.length >= 2}>
          <div style={{ marginTop: 4 }}>
            <FieldLabel optional>Country</FieldLabel>
            <CountryCombobox
              value={placeCountry}
              onChange={(code) =>
                onCustom({
                  placeName,
                  placeCountry: code,
                  ...(code !== placeCountry ? { placeState: "" } : {}),
                })
              }
            />
          </div>
        </Reveal>
        <Reveal show={!!placeCountry}>
          <div style={{ marginTop: 4 }}>
            <FieldLabel optional>State / Region</FieldLabel>
            {(() => {
              const regionOptions = placeCountry
                ? getRegionsForCountry(placeCountry)
                : [];
              if (regionOptions.length > 0) {
                return (
                  <RegionCombobox
                    value={placeState}
                    options={regionOptions}
                    onChange={(code) =>
                      onCustom({ placeName, placeState: code })
                    }
                  />
                );
              }
              return (
                <input
                  type="text"
                  aria-label="State or Region"
                  autoComplete="address-level1"
                  enterKeyHint="done"
                  value={placeState}
                  onChange={(e) =>
                    onCustom({ placeName, placeState: e.target.value })
                  }
                  placeholder="State…"
                  maxLength={MAX.CITY}
                  style={INPUT_STYLE}
                />
              );
            })()}
          </div>
        </Reveal>
      </div>
    </Reveal>
  );
}
