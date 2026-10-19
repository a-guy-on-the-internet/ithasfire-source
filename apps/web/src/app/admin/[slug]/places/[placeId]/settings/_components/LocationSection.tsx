"use client";

import { useId } from "react";
import { YStack, XStack } from "tamagui";
import { Text, TextInput, useTranslations } from "@th/ui";
import { MapPin, ChevronDown, ChevronRight } from "lucide-react";

import {
  AddressAutocompleteInput,
  type ResolvedAddress,
} from "@/components/maps/AddressAutocompleteInput";
import {
  PlaceLocationPrivacyFields,
  type PlaceLocationPrivacyValue,
} from "@/components/places/PlaceLocationPrivacyFields";
import { PlaceEditSection } from "./PlaceEditSection";
import { SettingsFieldLabel } from "./SettingsFieldLabel";

/**
 * Where the venue is, and who is allowed to know precisely.
 *
 * TWO panels, not one: the address fields and the location-privacy choice are
 * siblings rather than nested, because strict Swiss forbids cards inside cards
 * and the privacy control carries a radio group, a slider and a text field —
 * far too much to hang off a 1px rule the way the coordinates read-out does.
 * They ship together because they are one subject, and a host that renders one
 * without the other would be asking half the question.
 *
 * PURE and PROP-TAKING. Every value and every setter belongs to the host page.
 * In particular NOTHING about the save lives here: the `lat`/`lng`
 * form state, the `formattedAddress` preservation, the `||`-not-`??` address
 * check and the in-flight save latch are four separately-documented data-loss
 * fixes that live in `settings/page.tsx`, where they can be read next to the save
 * they protect. This file renders their values; it never re-derives them.
 */
export type LocationSectionProps = {
  // ── Address fields ──────────────────────────────────────────────────────
  addressLine1: string;
  addressLine2: string;
  city: string;
  region: string;
  postalCode: string;
  countryCode: string;
  /**
   * Already wrapped by the host in whatever invalidation it owes — on the
   * settings page
   * that is clearing "these coordinates were resolved for this exact address",
   * which has to happen on the user's keystroke rather than in an effect that
   * could race a re-render.
   */
  onAddressLine1Change: (value: string) => void;
  onAddressLine2Change: (value: string) => void;
  onCityChange: (value: string) => void;
  onRegionChange: (value: string) => void;
  onPostalCodeChange: (value: string) => void;
  onCountryCodeChange: (value: string) => void;

  // ── Manual-entry disclosure (FR-016) ────────────────────────────────────
  manualOpen: boolean;
  onToggleManualFields: () => void;
  onRequestManualEntry: () => void;

  // ── Autocomplete (FR-017) ───────────────────────────────────────────────
  onAddressSelect: (resolved: ResolvedAddress) => void;

  /** True while the country field holds a half-typed 1-character code. */
  countryError: boolean;

  // ── Coordinates read-out ────────────────────────────────────────────────
  lat: number | null;
  lng: number | null;
  /** Coordinates came from an autocomplete selection for the current address. */
  coordsFromSelection: boolean;
  /** Any location field differs from the saved row. */
  isAddressDirty: boolean;

  // ── Address privacy (place-address-withholding) ─────────────────────────
  privacy: PlaceLocationPrivacyValue;
  onPrivacyChange: (value: PlaceLocationPrivacyValue) => void;
  privacyDisabled?: boolean;

  /** Overridable anchor targets (the settings page passes its section ids). */
  locationHeadingId?: string;
  privacyHeadingId?: string;
  /** Forwarded to the Location panel — make its heading a jump target. */
  anchor?: boolean;
};

export function LocationSection({
  addressLine1,
  addressLine2,
  city,
  region,
  postalCode,
  countryCode,
  onAddressLine1Change,
  onAddressLine2Change,
  onCityChange,
  onRegionChange,
  onPostalCodeChange,
  onCountryCodeChange,
  manualOpen,
  onToggleManualFields,
  onRequestManualEntry,
  onAddressSelect,
  countryError,
  lat,
  lng,
  coordsFromSelection,
  isAddressDirty,
  privacy,
  onPrivacyChange,
  privacyDisabled = false,
  locationHeadingId = "place-edit-location-heading",
  privacyHeadingId = "place-edit-privacy-heading",
  anchor = false,
}: LocationSectionProps) {
  const t = useTranslations();
  // Real label ↔ input associations (the fields used to be labelled by a bare
  // <Text>, so each one's accessible name was only its placeholder).
  const idBase = useId();
  const fieldId = (field: string) => `${idBase}-${field}`;

  return (
    <>
      {/* ── Location (FR-016/FR-017) ─────────────────────────────────────
          The six plain inputs are no longer the way IN — the combobox above
          them is. They stay VISIBLE rather than hidden behind the search,
          because this is an edit surface: the stored address must be readable
          and correctable without trusting a third party to resolve it first.
          Geoapify cannot find DIY spaces, new construction or most rural
          addresses, and when it is down the form still has to work.

          The coordinates read-out is FOLDED IN here rather than sitting in a
          top-level panel of its own: coordinates ARE the location, and a whole
          bordered box for two numbers overstated them. */}
      <PlaceEditSection
        title={String(t("admin.placeEditSectionLocation"))}
        headingId={locationHeadingId}
        anchor={anchor}
      >
        <AddressAutocompleteInput
          label={String(t("admin.placeEditAddressSearchLabel"))}
          placeholder={t("admin.placeEditAddressSearchPlaceholder") as string}
          onSelect={onAddressSelect}
          onRequestManualEntry={onRequestManualEntry}
          testId="place-address-autocomplete"
        />

        {/* A real <button>, not a pressable Stack: `onPress` on a Tamagui
            Stack is a click handler, so Enter/Space would never open the
            section for a keyboard user. */}
        <button
          type="button"
          aria-expanded={manualOpen}
          aria-controls="place-address-fields"
          onClick={onToggleManualFields}
          data-testid="place-address-fields-toggle"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            alignSelf: "flex-start",
            minHeight: 44,
            padding: "8px 0",
            border: "none",
            background: "transparent",
            color: "var(--color, #211C16)",
            cursor: "pointer",
          }}
        >
          {manualOpen ? (
            <ChevronDown size={14} strokeWidth={2} aria-hidden="true" />
          ) : (
            <ChevronRight size={14} strokeWidth={2} aria-hidden="true" />
          )}
          <Text variant="bodySmall" weight="bold">
            {String(
              t(
                manualOpen
                  ? "admin.placeEditAddressFieldsHide"
                  : "admin.placeEditAddressFieldsShow",
              ),
            )}
          </Text>
        </button>

        {manualOpen && (
          <YStack gap="$4" id="place-address-fields">
            <YStack gap="$2">
              <SettingsFieldLabel htmlFor={fieldId("line1")}>
                {String(t("admin.placeEditAddressLine1Label"))}
              </SettingsFieldLabel>
              <TextInput
                id={fieldId("line1")}
                value={addressLine1}
                onChangeText={onAddressLine1Change}
                placeholder={
                  t("admin.placeEditAddressLine1Placeholder") as string
                }
                clearable
                fullWidth
              />
            </YStack>

            <YStack gap="$2">
              <SettingsFieldLabel htmlFor={fieldId("line2")}>
                {String(t("admin.placeEditAddressLine2Label"))}
              </SettingsFieldLabel>
              <TextInput
                id={fieldId("line2")}
                value={addressLine2}
                onChangeText={onAddressLine2Change}
                placeholder={
                  t("admin.placeEditAddressLine2Placeholder") as string
                }
                clearable
                fullWidth
              />
            </YStack>

            {/* City's floor is 140, not the 200 it used to be. A wrapping
                flex item's hypothetical main size is its flex-basis CLAMPED
                by min-width, so `minWidth: 200` also pins the field's used
                width once it is alone on a line — and at a 320px viewport the
                admin shell leaves this panel roughly 170px of inner width
                (320 − 32 shell row − 2 ContentArea border − 48 content − 32
                page − 32 panel padding − 4 PlaceEditSection's own 2px border
                on both sides), which the 200 could not fit inside. 140 clears
                it with room to spare and still keeps the pair side-by-side
                from 272px of inner width up. */}
            <XStack gap="$3" flexWrap="wrap">
              <YStack gap="$2" flex={1} minWidth={140}>
                <SettingsFieldLabel htmlFor={fieldId("city")}>
                  {String(t("admin.placeEditCityLabel"))}
                </SettingsFieldLabel>
                <TextInput
                  id={fieldId("city")}
                  value={city}
                  onChangeText={onCityChange}
                  placeholder={t("admin.placeEditCityPlaceholder") as string}
                  clearable
                  fullWidth
                />
              </YStack>
              <YStack gap="$2" flex={1} minWidth={120}>
                <SettingsFieldLabel htmlFor={fieldId("region")}>
                  {String(t("admin.placeEditRegionLabel"))}
                </SettingsFieldLabel>
                <TextInput
                  id={fieldId("region")}
                  value={region}
                  onChangeText={onRegionChange}
                  placeholder={t("admin.placeEditRegionPlaceholder") as string}
                  clearable
                  fullWidth
                />
              </YStack>
            </XStack>

            <XStack gap="$3" flexWrap="wrap">
              <YStack gap="$2" flex={1} minWidth={120}>
                <SettingsFieldLabel htmlFor={fieldId("postal")}>
                  {String(t("admin.placeEditPostalCodeLabel"))}
                </SettingsFieldLabel>
                <TextInput
                  id={fieldId("postal")}
                  value={postalCode}
                  onChangeText={onPostalCodeChange}
                  placeholder={
                    t("admin.placeEditPostalCodePlaceholder") as string
                  }
                  clearable
                  fullWidth
                />
              </YStack>
              <YStack gap="$2" flex={1} minWidth={120}>
                <SettingsFieldLabel htmlFor={fieldId("country")}>
                  {String(t("admin.placeEditCountryCodeLabel"))}
                </SettingsFieldLabel>
                <TextInput
                  id={fieldId("country")}
                  value={countryCode}
                  onChangeText={onCountryCodeChange}
                  placeholder={
                    t("admin.placeEditCountryCodePlaceholder") as string
                  }
                  clearable
                  fullWidth
                  maxLength={2}
                  status={countryError ? "error" : undefined}
                  aria-invalid={countryError || undefined}
                />
                {countryError && (
                  <Text variant="caption" tone="error">
                    {String(t("admin.placeEditCountryCodeInvalidMessage"))}
                  </Text>
                )}
              </YStack>
            </XStack>
          </YStack>
        )}

        {/* Coordinates — read-only, but reads from FORM state, not the server
            row, so an autocomplete selection shows its lat/lng immediately
            (FR-017) instead of only after a save round-trip. A 1px rule, not
            another bordered box: strict Swiss forbids cards inside cards. */}
        {lat != null && lng != null && (
          <YStack
            gap="$2"
            borderTopWidth={1}
            borderTopColor="$borderColor"
            paddingTop="$3"
          >
            <Text variant="bodySmall" weight="bold">
              {String(t("admin.placeEditCoordinatesLabel"))}
            </Text>
            <XStack gap="$2" alignItems="center">
              <MapPin
                size={14}
                strokeWidth={2}
                style={{ opacity: 0.5, flexShrink: 0 }}
                aria-hidden="true"
              />
              <Text
                variant="body"
                tone="muted"
                flexShrink={1}
                minWidth={0}
                style={{ fontVariantNumeric: "tabular-nums" }}
                data-testid="place-edit-coordinates"
              >
                {lat.toFixed(6)}, {lng.toFixed(6)}
              </Text>
            </XStack>
            <Text variant="caption" tone="muted">
              {String(
                t(
                  coordsFromSelection
                    ? "admin.placeEditCoordinatesFromSelection"
                    : isAddressDirty
                      ? "admin.placeEditCoordinatesPending"
                      : "admin.placeEditCoordinatesNote",
                ),
              )}
            </Text>
          </YStack>
        )}
      </PlaceEditSection>

      {/* ── Address privacy (place-address-withholding) ──────────────────
          WHY THIS SURFACE. The venue's own settings form already owns every
          address field this setting governs — the choice reads as the last
          question about the address, right under the address. The
          alternatives were worse for concrete reasons: `/page` edits the
          PUBLIC PROFILE (blocks, bio, photos) and would file "where do we
          actually live" as a layout choice; `/calendars` and `/bookings` are
          scheduling and inbound requests; `/verify` is a workflow with the
          platform, and putting a privacy control inside it would suggest the
          platform grants the privacy rather than the venue setting it. */}
      <PlaceEditSection
        title={String(t("admin.placePrivacyHeading"))}
        headingId={privacyHeadingId}
      >
        <PlaceLocationPrivacyFields
          value={privacy}
          onChange={onPrivacyChange}
          countryCode={countryCode}
          disabled={privacyDisabled}
        />
      </PlaceEditSection>
    </>
  );
}
