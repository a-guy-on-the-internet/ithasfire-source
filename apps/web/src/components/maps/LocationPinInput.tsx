"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { XStack, YStack, styled } from "tamagui";

import { Button, Text, TextInput, useTranslations } from "@th/ui";

// CoordinatesSelectorMap pulls maplibre-gl (~1 MB uncompressed). Defer
// so the input renders without waiting on the map chunk.
import nextDynamic from "next/dynamic";
const CoordinatesSelectorMap = nextDynamic(
  () =>
    import("./CoordinatesSelectorMap").then((m) => ({
      default: m.CoordinatesSelectorMap,
    })),
  { ssr: false },
);
import LocationAutocomplete, { type PlaceDetail } from "./LocationAutocomplete";
import { reverseGeocode } from "@/lib/maps/geocoding";

export type LocationPinValue = {
  label: string;
  placeId?: string;
  latitude: number | null;
  longitude: number | null;
};

export type LocationPinInputProps = {
  value: LocationPinValue;
  onChange: (next: LocationPinValue) => void;
  className?: string;
  testIdBase?: string;
  /** Called when user clicks "Save as place" link */
  onCreatePlaceRequest?: (coords: {
    label: string;
    latitude: number;
    longitude: number;
  }) => void;
};

const toFixedOrEmpty = (value: number | null | undefined) =>
  typeof value === "number" && Number.isFinite(value) ? value.toFixed(6) : "";

const CreatePlaceLink = styled(Text, {
  color: "$accent",
  cursor: "pointer",
  textDecorationLine: "underline",
  textDecorationColor: "$accent",
  hoverStyle: {
    opacity: 0.8,
  },
  pressStyle: {
    opacity: 0.6,
  },
});

export const LocationPinInput = ({
  value,
  onChange,
  className,
  testIdBase,
  onCreatePlaceRequest,
}: LocationPinInputProps) => {
  const t = useTranslations();
  const [query, setQuery] = useState(value.label);
  const [manualLat, setManualLat] = useState(toFixedOrEmpty(value.latitude));
  const [manualLng, setManualLng] = useState(toFixedOrEmpty(value.longitude));

  // Keep search query in sync with external value updates.
  useEffect(() => {
    setQuery(value.label);
  }, [value.label]);

  useEffect(() => {
    if (value.latitude != null && value.longitude != null) {
      setManualLat(toFixedOrEmpty(value.latitude));
      setManualLng(toFixedOrEmpty(value.longitude));
    }
  }, [value.latitude, value.longitude]);

  const latText = useMemo(
    () => toFixedOrEmpty(value.latitude),
    [value.latitude],
  );
  const lngText = useMemo(
    () => toFixedOrEmpty(value.longitude),
    [value.longitude],
  );

  const handleSelectPlace = useCallback(
    (place: PlaceDetail) => {
      const nextLabel =
        place.formattedAddress ?? place.line1 ?? place.name ?? value.label;

      onChange({
        label: nextLabel,
        placeId: place.placeId,
        latitude: place.lat ?? null,
        longitude: place.lng ?? null,
      });
      setQuery(nextLabel);
    },
    [onChange, value.label],
  );

  const handleQueryChange = useCallback((next: string) => {
    setQuery(next);
  }, []);

  const handleMapPositionChange = useCallback(
    (pos: { lat: number; lng: number }) => {
      setManualLat(pos.lat.toFixed(6));
      setManualLng(pos.lng.toFixed(6));
      // Clear placeId since user moved pin manually
      const nextValue: LocationPinValue = {
        ...value,
        placeId: undefined,
        latitude: pos.lat,
        longitude: pos.lng,
      };
      onChange(nextValue);

      // Try to reverse-geocode for a label
      void reverseGeocode(pos.lat, pos.lng).then((result) => {
        if (result?.formattedAddress) {
          const nextLabel = result.formattedAddress;
          setQuery(nextLabel);
          onChange({ ...nextValue, label: nextLabel });
        }
      });
    },
    [onChange, value],
  );

  const handleManualCoordsApply = useCallback(() => {
    const lat = parseFloat(manualLat);
    const lng = parseFloat(manualLng);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) return;
    if (!Number.isFinite(lng) || lng < -180 || lng > 180) return;

    onChange({
      ...value,
      placeId: undefined,
      latitude: lat,
      longitude: lng,
    });
  }, [manualLat, manualLng, onChange, value]);

  const handleLabelChange = useCallback(
    (next: string) => {
      onChange({
        ...value,
        label: next,
      });
    },
    [onChange, value],
  );

  const handleCreatePlaceClick = useCallback(() => {
    if (!onCreatePlaceRequest) return;
    if (value.latitude == null || value.longitude == null) return;
    onCreatePlaceRequest({
      label: value.label || String(t("admin.lpiNewPlace")),
      latitude: value.latitude,
      longitude: value.longitude,
    });
  }, [onCreatePlaceRequest, value.label, value.latitude, value.longitude]);

  const hasCoordinates = value.latitude != null && value.longitude != null;
  const canCreatePlace =
    onCreatePlaceRequest && hasCoordinates && !value.placeId;

  return (
    <YStack gap="$4" className={className}>
      {/* Address search with Geoapify geocoding */}
      <YStack gap="$2">
        <Text variant="bodySmall" tone="muted" weight="bold">
          {String(t("admin.lpiSearchAddress"))}
        </Text>
        <LocationAutocomplete
          value={query}
          onChange={handleQueryChange}
          onSelect={handleSelectPlace}
          testIdBase={testIdBase ?? "location-pin"}
          placeholder={t("admin.lpiSearchPlaceholder") as string}
        />
      </YStack>

      {/* Map with center pin */}
      <YStack gap="$2">
        <Text variant="bodySmall" tone="muted" weight="bold">
          {String(t("admin.lpiDropPin"))}
        </Text>
        <CoordinatesSelectorMap
          latitude={value.latitude}
          longitude={value.longitude}
          onPositionChangeAction={handleMapPositionChange}
          label={value.label}
        />
        <Text variant="bodySmall" tone="muted">
          {String(t("admin.lpiPanHint"))}
        </Text>
      </YStack>

      {/* Manual coordinate entry */}
      <YStack gap="$2">
        <Text variant="bodySmall" tone="muted" weight="bold">
          {String(t("admin.lpiManualCoords"))}
        </Text>
        <XStack gap="$3" flexWrap="wrap" alignItems="flex-end">
          <YStack gap="$1" flex={1} minWidth={120}>
            <Text variant="bodySmall" tone="muted">
              {String(t("admin.lpiLatitude"))}
            </Text>
            <TextInput
              value={manualLat}
              onChangeText={setManualLat}
              placeholder="-90 to 90"
              keyboardType="decimal-pad"
              testId={testIdBase ? `${testIdBase}-lat-input` : undefined}
            />
          </YStack>
          <YStack gap="$1" flex={1} minWidth={120}>
            <Text variant="bodySmall" tone="muted">
              {String(t("admin.lpiLongitude"))}
            </Text>
            <TextInput
              value={manualLng}
              onChangeText={setManualLng}
              placeholder="-180 to 180"
              keyboardType="decimal-pad"
              testId={testIdBase ? `${testIdBase}-lng-input` : undefined}
            />
          </YStack>
          <Button
            size="$3"
            variant="secondary"
            onPress={handleManualCoordsApply}
          >
            {String(t("admin.lpiApply"))}
          </Button>
        </XStack>
      </YStack>

      {/* Location label (editable) */}
      <YStack gap="$2">
        <Text variant="bodySmall" tone="muted" weight="bold">
          {String(t("admin.lpiLocationLabel"))}
        </Text>
        <TextInput
          value={value.label}
          onChangeText={handleLabelChange}
          placeholder={t("admin.lpiLabelPlaceholder") as string}
          testId={testIdBase ? `${testIdBase}-label-input` : undefined}
        />
        <Text variant="bodySmall" tone="muted">
          {String(t("admin.lpiLabelHint"))}
        </Text>
      </YStack>

      {/* Coordinates summary + create place link */}
      <YStack
        gap="$2"
        padding="$3"
        borderRadius={0}
        backgroundColor="rgba(15, 23, 42, 0.5)"
        borderWidth={2}
        borderColor="rgba(148, 163, 184, 0.2)"
      >
        <XStack justifyContent="space-between" alignItems="center">
          <Text variant="bodySmall" tone="muted" weight="bold">
            {String(t("admin.lpiCoordinates"))}
          </Text>
          {!hasCoordinates && (
            <Text variant="bodySmall" color="$warning">
              {String(t("admin.lpiNotSet"))}
            </Text>
          )}
        </XStack>
        <XStack gap="$4">
          <YStack>
            <Text variant="bodySmall" tone="muted">
              {String(t("admin.lpiLat"))}
            </Text>
            <Text variant="body" style={{ fontFamily: "monospace" }}>
              {latText || "—"}
            </Text>
          </YStack>
          <YStack>
            <Text variant="bodySmall" tone="muted">
              {String(t("admin.lpiLng"))}
            </Text>
            <Text variant="body" style={{ fontFamily: "monospace" }}>
              {lngText || "—"}
            </Text>
          </YStack>
        </XStack>
        {value.placeId && (
          <Text variant="bodySmall" tone="muted" style={{ opacity: 0.7 }}>
            Place ID: {value.placeId}
          </Text>
        )}
        {canCreatePlace && (
          <XStack paddingTop="$2">
            <CreatePlaceLink
              variant="bodySmall"
              onPress={handleCreatePlaceClick}
              testID={
                testIdBase ? `${testIdBase}-create-place-link` : undefined
              }
            >
              {String(t("admin.lpiSaveAsPlace"))}
            </CreatePlaceLink>
          </XStack>
        )}
      </YStack>
    </YStack>
  );
};
