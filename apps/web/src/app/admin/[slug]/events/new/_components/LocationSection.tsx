"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { styled, useTheme, XStack, YStack } from "tamagui";
import {
  MapPin,
  RotateCcw,
  Lock,
  LockOpen,
  ExternalLink,
  ShieldAlert,
} from "lucide-react";

import { Text, Button, Spinner, useTranslations } from "@th/ui";
import type { LatLngLiteral } from "@/config/maps";
import { isMapEnabled } from "@/config/maps";
import LocationAutocomplete from "@/components/maps/LocationAutocomplete";
import type { PlaceDetail } from "@/components/maps/LocationAutocomplete";
// Both map components pull maplibre-gl (~1 MB uncompressed). Defer so
// the admin location editor doesn't block on the map chunk.
import nextDynamic from "next/dynamic";
const CoordinatesSelectorMap = nextDynamic(
  () =>
    import("@/components/maps/CoordinatesSelectorMap").then((m) => ({
      default: m.CoordinatesSelectorMap,
    })),
  { ssr: false },
);
const LocationMapPreview = nextDynamic(
  () =>
    import("@/components/maps/LocationMapPreview").then((m) => ({
      default: m.LocationMapPreview,
    })),
  { ssr: false },
);
import { reverseGeocode } from "@/lib/maps/geocoding";
import { PlacePicker } from "@/components/places/PlacePicker";
import type { PlacePickerItem } from "@/components/places/PlacePicker";
import {
  ArchivedPlaceNotice,
  PlaceOrAddressField,
  type AddressValue,
  type PlaceOrAddressValue,
} from "@/components/places/PlaceOrAddressField";
import { usePlaceBookingOptions } from "@/app/p/[slug]/_components/blocks/use-place-booking-options";
import { shouldRetryPlacePrivacyRead } from "@/lib/places/venue-location-ceiling";

import {
  deriveDefaultPlacement,
  placementForCalendar,
  placementForIntent,
  type BookingIntent,
  type BuilderPlacement,
  type BuilderPlacementSource,
} from "./builder-placement.helpers";
import { VenueBookingCascade } from "./VenueBookingCascade";
import { EventFirstSkipNotice } from "./EventFirstSkipNotice";
import type { SaveEventBookingSkip } from "./event-first-skip.helpers";

// ── Types ────────────────────────────────────────────────────────────────────

export type LocationState = {
  thPlaceId?: string;
  thPlaceName?: string;
  addressText?: string;
  lat?: number;
  lng?: number;
  locality?: string;
  region?: string;
  countryCode?: string;
  postalCode?: string;
};

export type LocationMode = "address" | "place";

export type LocationSectionProps = {
  location: LocationState;
  locationSearch: string;
  locationMode: LocationMode;
  selectedPlace: PlacePickerItem | null;
  visibilityMode: string;
  /** Obfuscation radius in meters; null = FULLY HIDDEN (no public map). */
  visibilityRadius: number | null;
  ownerType: "human" | "org";
  ownerId: string;
  slug?: string;
  hasSavedLocation: boolean;
  /** Marks the address search as required (`required` + `aria-required`). */
  required?: boolean;
  onLocationChange: (loc: LocationState) => void;
  onLocationSearchChange: (search: string) => void;
  onLocationModeChange: (mode: LocationMode) => void;
  onPlaceSelect: (place: PlacePickerItem | null) => void;
  onResetLocation: () => void;
  /**
   * Third-party venue cascade state (venue-confirmation spec). Owned and
   * granted venues never mint one — this section gates on `viewer.authority`
   * from `places.getBookingOptions` and renders nothing new for them.
   */
  placement: BuilderPlacement | null;
  placementSource: BuilderPlacementSource;
  /**
   * The builder seeded calendar + space from the edit read but the request's
   * INTENT (a separate read) has not landed and nothing was touched: the
   * cascade shows its skeleton for that round trip rather than live controls
   * seeded with a PERFORM guess.
   */
  placementIntentPending: boolean;
  onPlacementChange: (placement: BuilderPlacement | null) => void;
  /**
   * The LAST save's refused ask (`bookingRequest.outcome === "skipped"`),
   * already gated by the builder to the venue / intent / calendar / date it
   * was made of — null once any of those change, and always null on a fresh
   * load (a refusal leaves no request row for provenance to report).
   */
  bookingSkip: SaveEventBookingSkip | null;
  /**
   * COMMUNITY listing. ONE box replaces the Address / Place toggle, the
   * address search and the PlacePicker (`PlaceOrAddressField`; owner
   * 2026-10-13: "Ideally it should be the same component"): our places
   * first, then geocoder addresses, then "Add a place" for a moderator.
   * `community.updateListing` takes `fields.placeId`; picking a place puts
   * the builder in "place" mode, picking an address in "address" mode, so
   * the save rules keyed on `locationMode` are unchanged. Also:
   *
   * - No owned list. An ownerless listing has no "My Places": the owned list
   *   would be scoped to the ADMIN CONTEXT's owner, which is not the
   *   listing's owner, because it has none. A place added from the field is
   *   a community place nobody owns (`community.createPlace`), made in a
   *   dialog over the form, so nothing unsaved is lost.
   * - NOTHING booking-related runs: no `places.getBookingOptions` read, no
   *   cascade, no placement committed, no refused-ask notice, no "verify this
   *   place" nudge. Linking a listing to a venue books nothing and confirms
   *   nothing.
   */
  communityMode?: boolean;
  /** The section label's id; names the community one-box combobox. */
  labelledBy?: string;
  /**
   * The selected place is ARCHIVED (its name), or null: the builder's
   * place-privacy read answered PLACE_ARCHIVED. Both modes say so under the
   * picker, the same notice "Edit place" shows in community mode.
   */
  placeArchivedName?: string | null;
};

// ── Styled primitives ────────────────────────────────────────────────────────

const LocationSearchContainer = styled(YStack, {
  gap: 8,
  marginTop: 16,
  minHeight: 60,
});

const MapContainer = styled(YStack, {
  borderWidth: 1,
  borderColor: "$borderColorStrong",
  borderRadius: 0,
  height: 400,
  minHeight: 400,
  overflow: "hidden",
});

// ── Component ────────────────────────────────────────────────────────────────

export function LocationSection({
  required,
  communityMode = false,
  labelledBy,
  location,
  locationSearch,
  locationMode,
  selectedPlace,
  visibilityMode,
  visibilityRadius,
  ownerType,
  ownerId,
  slug,
  hasSavedLocation,
  onLocationChange,
  onLocationSearchChange,
  onLocationModeChange,
  onPlaceSelect,
  onResetLocation,
  placement,
  placementSource,
  placementIntentPending,
  onPlacementChange,
  bookingSkip,
  placeArchivedName = null,
}: LocationSectionProps) {
  const theme = useTheme();
  const t = useTranslations();
  // Org mode's archived notice can be dismissed; a dismissal holds for that
  // place only, so picking another archived place says so again.
  const [archivedDismissedFor, setArchivedDismissedFor] = useState<
    string | null
  >(null);
  const showOrgArchivedNotice =
    !communityMode &&
    placeArchivedName !== null &&
    selectedPlace !== null &&
    archivedDismissedFor !== selectedPlace.placeId;
  const [geolocatedCenter, setGeolocatedCenter] =
    useState<LatLngLiteral | null>(null);
  const [isLocating, setIsLocating] = useState(false);
  const [locationError, setLocationError] = useState(false);
  const [isMapUnlocked, setIsMapUnlocked] = useState(false);
  // Spinner state while a map-drag is being reverse-geocoded. Covers both
  // the debounce window (user still adjusting) and the in-flight fetch.
  const [isReverseGeocoding, setIsReverseGeocoding] = useState(false);
  const reverseGeocodeTimer = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  const handleUseMyLocation = useCallback(() => {
    if (!isMapEnabled) return;
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setLocationError(true);
      return;
    }
    const hasLocation = location.lat != null && location.lng != null;
    setLocationError(false);
    setIsLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        setGeolocatedCenter({ lat, lng });

        // When a location already exists, "use my location" just re-centers
        // the visible map — preserve that behavior.
        if (hasLocation) {
          setIsLocating(false);
          return;
        }

        // From-scratch flow: drop the event location at the current position
        // and reverse-geocode to fill in the address. Keep the spinner up
        // across both steps so the button doesn't flicker back to its idle
        // label between the geolocation success and the geocode resolving.
        onLocationChange({
          ...location,
          lat,
          lng,
          thPlaceId: undefined,
          thPlaceName: undefined,
        });
        void reverseGeocode(lat, lng)
          .then((result) => {
            if (result?.formattedAddress) {
              onLocationChange({
                ...location,
                lat,
                lng,
                thPlaceId: undefined,
                thPlaceName: undefined,
                addressText: result.formattedAddress,
                locality: result.locality ?? undefined,
                region: result.region ?? undefined,
                countryCode: result.countryCode ?? undefined,
                postalCode: result.postalCode ?? undefined,
              });
              onLocationSearchChange(result.formattedAddress);
            }
          })
          .finally(() => {
            setIsLocating(false);
          });
      },
      () => {
        setIsLocating(false);
        setLocationError(true);
      },
      { timeout: 5_000, maximumAge: 300_000 },
    );
  }, [location, onLocationChange, onLocationSearchChange]);

  const handlePlaceSelect = useCallback(
    (place: PlaceDetail) => {
      onLocationChange({
        addressText: place.formattedAddress ?? undefined,
        lat: place.lat ?? undefined,
        lng: place.lng ?? undefined,
        locality: place.city ?? undefined,
        region: place.region ?? undefined,
        countryCode: place.countryCode ?? undefined,
        // Carried like the reverse-geocode paths do, so a picked address
        // keeps its postcode.
        postalCode: place.postalCode ?? undefined,
      });
      onLocationSearchChange(place.formattedAddress ?? "");
      setIsMapUnlocked(false);
    },
    [onLocationChange, onLocationSearchChange],
  );

  // Track the last reverse-geocoded position so the geocode callback can
  // verify its result is still relevant (user hasn't dragged further).
  const lastGeocodedPosRef = useRef<{ lat: number; lng: number } | null>(null);

  const handleMapPositionChange = useCallback(
    (position: LatLngLiteral) => {
      // Update coordinates immediately so the pin tracks the drag.
      onLocationChange({
        ...location,
        lat: position.lat,
        lng: position.lng,
        thPlaceId: undefined,
        thPlaceName: undefined,
      });

      // Debounce the reverse geocode with a longer delay so it doesn't
      // fire while the user is still adjusting the position.
      if (reverseGeocodeTimer.current)
        clearTimeout(reverseGeocodeTimer.current);
      lastGeocodedPosRef.current = position;
      setIsReverseGeocoding(true);
      reverseGeocodeTimer.current = setTimeout(() => {
        void reverseGeocode(position.lat, position.lng)
          .then((result) => {
            // Only apply if this is still the most recent geocode request
            // (the user may have dragged further while the request was in flight).
            const latest = lastGeocodedPosRef.current;
            if (
              !latest ||
              latest.lat.toFixed(6) !== position.lat.toFixed(6) ||
              latest.lng.toFixed(6) !== position.lng.toFixed(6)
            ) {
              return;
            }
            if (result?.formattedAddress) {
              onLocationChange({
                ...location,
                lat: position.lat,
                lng: position.lng,
                thPlaceId: undefined,
                thPlaceName: undefined,
                addressText: result.formattedAddress,
                locality: result.locality ?? undefined,
                region: result.region ?? undefined,
                countryCode: result.countryCode ?? undefined,
                postalCode: result.postalCode ?? undefined,
              });
              onLocationSearchChange(result.formattedAddress);
            }
          })
          .finally(() => {
            // Only clear the spinner if no fresher drag has come in. If a
            // newer drag is pending, its own setTimeout will have already
            // re-set isReverseGeocoding=true and we shouldn't fight it.
            const latest = lastGeocodedPosRef.current;
            if (
              latest &&
              latest.lat.toFixed(6) === position.lat.toFixed(6) &&
              latest.lng.toFixed(6) === position.lng.toFixed(6)
            ) {
              setIsReverseGeocoding(false);
            }
          });
      }, 1200);
    },
    [location, onLocationChange, onLocationSearchChange],
  );

  const handleLockMap = useCallback(() => {
    if (reverseGeocodeTimer.current) clearTimeout(reverseGeocodeTimer.current);
    setIsMapUnlocked(false);

    if (location.lat != null && location.lng != null) {
      setIsReverseGeocoding(true);
      void reverseGeocode(location.lat, location.lng)
        .then((result) => {
          if (result?.formattedAddress) {
            onLocationChange({
              ...location,
              addressText: result.formattedAddress,
              locality: result.locality ?? undefined,
              region: result.region ?? undefined,
              countryCode: result.countryCode ?? undefined,
              postalCode: result.postalCode ?? undefined,
            });
            onLocationSearchChange(result.formattedAddress);
          }
        })
        .finally(() => setIsReverseGeocoding(false));
    }
  }, [location, onLocationChange, onLocationSearchChange]);

  const handleThPlaceSelect = useCallback(
    (place: PlacePickerItem | null) => {
      onPlaceSelect(place);
      if (place) {
        onLocationChange({
          thPlaceId: place.placeId,
          thPlaceName: place.name,
          addressText: place.formattedAddress ?? undefined,
          lat: place.lat ?? undefined,
          lng: place.lng ?? undefined,
          locality: place.city ?? undefined,
          region: place.region ?? undefined,
          postalCode: place.postalCode ?? undefined,
        });
        onLocationSearchChange(place.formattedAddress ?? place.name);
      } else {
        onLocationChange({});
        onLocationSearchChange("");
      }
    },
    [onLocationChange, onLocationSearchChange, onPlaceSelect],
  );

  // ── Community: the one box drives the same two modes ───────────────────
  const communityValue = useMemo<PlaceOrAddressValue>(() => {
    if (!communityMode) return null;
    if (locationMode === "place") {
      return selectedPlace ? { kind: "place", place: selectedPlace } : null;
    }
    if (location.addressText && location.lat != null && location.lng != null) {
      return {
        kind: "address",
        address: {
          formatted: location.addressText,
          line1: null,
          poiName: null,
          city: location.locality ?? null,
          region: location.region ?? null,
          postalCode: location.postalCode ?? null,
          countryCode: location.countryCode ?? null,
          lat: location.lat,
          lng: location.lng,
        },
      };
    }
    return null;
  }, [communityMode, locationMode, selectedPlace, location]);

  const handleCommunityPickPlace = useCallback(
    (place: PlacePickerItem) => {
      if (locationMode !== "place") onLocationModeChange("place");
      handleThPlaceSelect(place);
    },
    [locationMode, onLocationModeChange, handleThPlaceSelect],
  );

  const handleCommunityPickAddress = useCallback(
    (address: AddressValue) => {
      // Leaving a place: the mode switch unlinks it (EventBuilder's
      // community rule), and the address below replaces the restored snapshot.
      if (locationMode !== "address") onLocationModeChange("address");
      if (selectedPlace) onPlaceSelect(null);
      onLocationChange({
        addressText: address.formatted,
        lat: address.lat ?? undefined,
        lng: address.lng ?? undefined,
        locality: address.city ?? undefined,
        region: address.region ?? undefined,
        countryCode: address.countryCode ?? undefined,
        postalCode: address.postalCode ?? undefined,
      });
      onLocationSearchChange(address.formatted);
      setIsMapUnlocked(false);
    },
    [
      locationMode,
      selectedPlace,
      onLocationModeChange,
      onPlaceSelect,
      onLocationChange,
      onLocationSearchChange,
    ],
  );

  const handleCommunityClear = useCallback(() => {
    if (locationMode === "place") {
      handleThPlaceSelect(null);
    } else {
      onLocationChange({});
      onLocationSearchChange("");
    }
  }, [locationMode, handleThPlaceSelect, onLocationChange, onLocationSearchChange]);

  // ── Third-party venue cascade ──────────────────────────────────────────
  // One read answers both "may this owner simply put an event here?" and
  // "what can be asked of this venue?". Owners and grant-holders
  // (`authority !== "none"`) see NOTHING new — the owner's ruling; their
  // events land on the default calendar through the server fallback.
  //
  // A community listing never gets here: `activePlaceId` stays null, so the
  // booking read is parked, `effectivePlacement` is null, the commit effect
  // returns early and `showCascade` is false. One switch gates all four.
  const activePlaceId =
    !communityMode && locationMode === "place"
      ? (selectedPlace?.placeId ?? null)
      : null;
  const bookingOwner = useMemo(
    () =>
      ownerType === "org"
        ? ({ kind: "org", orgId: ownerId } as const)
        : ({ kind: "human" } as const),
    [ownerType, ownerId],
  );
  const bookingOptions = usePlaceBookingOptions(activePlaceId ?? "", {
    owner: bookingOwner,
    enabled: activePlaceId !== null,
    // Once, and only for a transient failure: an archived place's NOT_FOUND
    // is final (the builder already says it is archived).
    retry: shouldRetryPlacePrivacyRead,
  });
  const isThirdParty = bookingOptions.authority === "none";
  const isOwnedOrGranted =
    bookingOptions.authority === "owner" ||
    bookingOptions.authority === "grant";

  /**
   * The placement for THIS venue: the organizer's, or the STORED one the
   * builder seeded on hydration (`getEventForEdit.calendarId`, intent from
   * the provenance read), else — for a venue with nothing stored — the
   * derived defaults.
   */
  const effectivePlacement = useMemo<BuilderPlacement | null>(() => {
    if (!activePlaceId || !isThirdParty) return null;
    if (placement?.placeId === activePlaceId) return placement;
    return deriveDefaultPlacement({
      placeId: activePlaceId,
      calendars: bookingOptions.calendars,
      acceptsBookingRequests: bookingOptions.acceptsBookingRequests,
    });
  }, [
    activePlaceId,
    isThirdParty,
    placement,
    bookingOptions.calendars,
    bookingOptions.acceptsBookingRequests,
  ]);

  // A venue PICKED this session commits its defaults as soon as the options
  // land, so pick-and-save sends a request against the default calendar. A
  // HYDRATED venue never does: the stored placement is unknown here
  // (`getEventForEdit` carries no placement columns) and must not be
  // overwritten with defaults — only the organizer's touch commits.
  useEffect(() => {
    if (!activePlaceId || !isThirdParty || placementSource !== "picked") {
      return;
    }
    if (placement?.placeId === activePlaceId) return;
    if (effectivePlacement) onPlacementChange(effectivePlacement);
  }, [
    activePlaceId,
    isThirdParty,
    placementSource,
    placement,
    effectivePlacement,
    onPlacementChange,
  ]);

  const handleIntentChange = useCallback(
    (intent: BookingIntent) => {
      if (!effectivePlacement) return;
      onPlacementChange(
        placementForIntent(bookingOptions.calendars, effectivePlacement, intent),
      );
    },
    [effectivePlacement, bookingOptions.calendars, onPlacementChange],
  );
  const handleCalendarChange = useCallback(
    (calendarId: string) => {
      if (!effectivePlacement) return;
      onPlacementChange(placementForCalendar(effectivePlacement, calendarId));
    },
    [effectivePlacement, onPlacementChange],
  );
  const cascadeStatus = bookingOptions.query.isSuccess ? "ready" : "loading";
  // Once the read settles only a third party gets the cascade. While it is
  // loading the skeleton shows ONLY for a venue picked this session: on
  // hydration the whole editor is loading anyway, and an owned venue must not
  // flash a placeholder for controls it will never get. A FAILED read (after
  // one retry) mounts NOTHING — fail-closed: authority is unknown, so the
  // owner's "nothing new" wins and the event saves as an address, the
  // documented degraded path.
  const showCascade =
    activePlaceId !== null &&
    !bookingOptions.query.isError &&
    (cascadeStatus === "ready" ? isThirdParty : placementSource === "picked");

  return (
    <>
      {communityMode ? (
        <LocationSearchContainer marginTop={0}>
          <PlaceOrAddressField
            value={communityValue}
            onPickPlace={handleCommunityPickPlace}
            onPickAddress={handleCommunityPickAddress}
            onClear={handleCommunityClear}
            required={required}
            inputId="community-location-input"
            labelledBy={labelledBy}
            testIdBase="community-location"
            archivedName={placeArchivedName}
          />
          {isMapEnabled &&
            locationMode === "address" &&
            communityValue === null && (
              <XStack>
                <Button
                  variant="ghost"
                  size="$2"
                  onPress={handleUseMyLocation}
                  disabled={isLocating}
                  data-testid="use-my-location-btn"
                >
                  <MapPin size={14} aria-hidden />
                  {isLocating
                    ? String(t("admin.ebLocating"))
                    : String(t("admin.ebUseMyLocation"))}
                </Button>
              </XStack>
            )}
          {isMapEnabled && locationError && locationMode === "address" && (
            <Text
              variant="caption"
              tone="error"
              aria-live="polite"
              data-testid="use-my-location-error"
            >
              {String(t("search.locationUnavailable"))}
            </Text>
          )}
        </LocationSearchContainer>
      ) : (
      /* Address / Place toggle */
      <XStack
        borderWidth={2}
        borderColor="$borderColorStrong"
        overflow="hidden"
      >
        <XStack
          tag="button"
          flex={1}
          minHeight={44}
          paddingVertical={10}
          justifyContent="center"
          alignItems="center"
          cursor="pointer"
          borderWidth={0}
          // Selected = the AA fill rung: raw $accent under a 13px label is
          // 4.06:1 (white) — it carries no small text in either polarity.
          backgroundColor={
            locationMode === "address" ? "$brandSecondaryHover" : "$surface"
          }
          onPress={() => onLocationModeChange("address")}
          hoverStyle={{
            backgroundColor:
              locationMode === "address"
                ? "$brandSecondaryStrong"
                : "$surfaceMuted",
          }}
          focusVisibleStyle={{
            outlineWidth: 2,
            outlineStyle: "solid",
            outlineColor: "$accent",
            outlineOffset: -2,
          }}
          aria-pressed={locationMode === "address"}
          data-testid="location-mode-address"
        >
          <Text
            variant="bodySmall"
            weight="bold"
            color={locationMode === "address" ? "$onBrandSecondary" : "$color"}
          >
            {String(t("admin.ebAddress"))}
          </Text>
        </XStack>
        <XStack width={1} backgroundColor="$borderColorStrong" />
        <XStack
          tag="button"
          flex={1}
          minHeight={44}
          paddingVertical={10}
          justifyContent="center"
          alignItems="center"
          cursor="pointer"
          borderWidth={0}
          // Selected = the AA fill rung: raw $accent under a 13px label is
          // 4.06:1 (white) — it carries no small text in either polarity.
          backgroundColor={
            locationMode === "place" ? "$brandSecondaryHover" : "$surface"
          }
          onPress={() => onLocationModeChange("place")}
          hoverStyle={{
            backgroundColor:
              locationMode === "place"
                ? "$brandSecondaryStrong"
                : "$surfaceMuted",
          }}
          focusVisibleStyle={{
            outlineWidth: 2,
            outlineStyle: "solid",
            outlineColor: "$accent",
            outlineOffset: -2,
          }}
          aria-pressed={locationMode === "place"}
          data-testid="location-mode-place"
        >
          <Text
            variant="bodySmall"
            weight="bold"
            color={locationMode === "place" ? "$onBrandSecondary" : "$color"}
          >
            {String(t("admin.ebMyPlaces"))}
          </Text>
        </XStack>
      </XStack>
      )}

      {locationMode === "address" ? (
        <>
          {!communityMode && (
          <LocationSearchContainer>
            <LocationAutocomplete
              value={locationSearch}
              onChange={onLocationSearchChange}
              onSelect={handlePlaceSelect}
              required={required}
            />
            {location.addressText && !locationSearch && (
              <Text variant="body" tone="muted">
                {location.addressText}
              </Text>
            )}
            {/* Default-visible affordance: lets a user drop the event at their
                current position from a blank form, mirroring the consumer
                search page. After a location exists it re-centers the map. */}
            {isMapEnabled && (
              <XStack>
                <Button
                  variant="ghost"
                  size="$2"
                  onPress={handleUseMyLocation}
                  disabled={isLocating}
                  data-testid="use-my-location-btn"
                >
                  <MapPin size={14} aria-hidden />
                  {isLocating
                    ? String(t("admin.ebLocating"))
                    : String(t("admin.ebUseMyLocation"))}
                </Button>
              </XStack>
            )}
            {isMapEnabled && locationError && (
              <Text
                variant="caption"
                tone="error"
                aria-live="polite"
                data-testid="use-my-location-error"
              >
                {String(t("search.locationUnavailable"))}
              </Text>
            )}
          </LocationSearchContainer>
          )}
          {/* Reveal map + actions only after a location has been selected */}
          {location.lat != null && location.lng != null && (
            <YStack
              animation="fast"
              enterStyle={{ opacity: 0, y: -8 }}
              opacity={1}
              y={0}
            >
              {isMapEnabled && hasSavedLocation && (
                <XStack marginTop={8} gap={8} alignItems="center">
                  <Button
                    variant="ghost"
                    size="$2"
                    onPress={onResetLocation}
                    data-testid="reset-location-btn"
                  >
                    <RotateCcw size={14} aria-hidden />
                    {String(t("admin.ebResetLocation"))}
                  </Button>
                </XStack>
              )}
              <MapContainer marginTop={16} style={{ position: "relative" }}>
                {!isMapUnlocked &&
                  location.lat != null &&
                  location.lng != null && (
                    <XStack
                      position="absolute"
                      bottom={12}
                      left={0}
                      right={0}
                      zIndex={10}
                      justifyContent="center"
                    >
                      <Button
                        variant="primary"
                        size="$3"
                        onPress={() => setIsMapUnlocked(true)}
                        data-testid="unlock-map-btn"
                      >
                        <LockOpen size={14} aria-hidden />
                        {String(t("admin.ebUnlockMap"))}
                      </Button>
                    </XStack>
                  )}
                <CoordinatesSelectorMap
                  latitude={location.lat ?? geolocatedCenter?.lat ?? undefined}
                  longitude={location.lng ?? geolocatedCenter?.lng ?? undefined}
                  onPositionChangeAction={handleMapPositionChange}
                  interactive={
                    isMapUnlocked ||
                    (location.lat == null && location.lng == null)
                  }
                />
                {isReverseGeocoding && (
                  <XStack
                    position="absolute"
                    top={12}
                    right={12}
                    zIndex={11}
                    paddingHorizontal={10}
                    paddingVertical={6}
                    gap={6}
                    alignItems="center"
                    backgroundColor="$surface"
                    borderRadius={0}
                    borderWidth={1}
                    borderColor="$borderColor"
                    aria-live="polite"
                    data-testid="location-map-reverse-geocoding"
                  >
                    <Spinner size="sm" />
                    <Text variant="caption" tone="muted">
                      Updating address…
                    </Text>
                  </XStack>
                )}
                {isMapUnlocked && location.lat != null && (
                  <XStack
                    position="absolute"
                    bottom={12}
                    left={0}
                    right={0}
                    justifyContent="center"
                    zIndex={10}
                  >
                    <Button
                      variant="primary"
                      size="$3"
                      onPress={handleLockMap}
                      data-testid="lock-map-btn"
                    >
                      <Lock size={14} aria-hidden />
                      {String(t("admin.ebSaveLocation"))}
                    </Button>
                  </XStack>
                )}
              </MapContainer>
            </YStack>
          )}
        </>
      ) : (
        // One column, one gap: picker, the verify nudge, the third-party
        // cascade and the map preview are siblings spaced by `gap`, never by
        // their own margins (DS: gap between siblings).
        <YStack gap={12}>
          {/* Community mode: the one box above is the picker. */}
          {!communityMode && (
            <LocationSearchContainer>
              <PlacePicker
                value={selectedPlace}
                onChange={handleThPlaceSelect}
                orgId={ownerType === "org" ? ownerId : undefined}
                adminSlug={slug}
                includeAllVenues
              />
            </LocationSearchContainer>
          )}
          {showOrgArchivedNotice && selectedPlace && (
            <ArchivedPlaceNotice
              name={placeArchivedName ?? ""}
              onDismiss={() => setArchivedDismissedFor(selectedPlace.placeId)}
              testIdBase="event-location"
            />
          )}
          {/* The "verify this place" nudge links into the Verification
              section of the place's OWN admin settings page — only an owner
              or grant-holder can act on it. */}
          {!communityMode &&
            selectedPlace &&
            isOwnedOrGranted &&
            (selectedPlace.verificationStatus === "UNVERIFIED" ||
              selectedPlace.verificationStatus === "REJECTED") &&
            slug && (
              <a
                href={`/admin/${slug}/places/${selectedPlace.placeId}/settings#verification`}
                target="_blank"
                rel="noopener noreferrer"
                style={{ textDecoration: "none" }}
              >
                <XStack
                  paddingVertical={6}
                  paddingHorizontal={10}
                  gap={6}
                  alignItems="center"
                  backgroundColor="$surfaceMuted"
                  borderRadius={0}
                  cursor="pointer"
                  hoverStyle={{ opacity: 0.8 }}
                >
                  <ShieldAlert size={13} color={theme.warning?.val} />
                  <Text variant="caption" tone="muted">
                    {String(t("admin.ebUnverifiedPlaceHint"))}
                  </Text>
                  <ExternalLink size={11} color={theme.colorMuted?.val} />
                </XStack>
              </a>
            )}
          {showCascade ? (
            <VenueBookingCascade
              status={placementIntentPending ? "loading" : cascadeStatus}
              calendars={bookingOptions.calendars}
              placement={effectivePlacement}
              onIntentChange={handleIntentChange}
              onCalendarChange={handleCalendarChange}
            />
          ) : null}
          {/* The save's "request wasn't sent" notice sits with the cascade
              it answers, not in the tie band's slot — see the component. */}
          {bookingSkip && !communityMode ? (
            <EventFirstSkipNotice
              skip={bookingSkip}
              ownerType={ownerType}
              slug={slug}
            />
          ) : null}
          {location.lat != null && location.lng != null && (
            <MapContainer>
              <LocationMapPreview
                latitude={location.lat}
                longitude={location.lng}
                label={location.thPlaceName ?? location.addressText}
                isExact={visibilityMode === "EXACT"}
                radiusMeters={
                  visibilityMode === "OBSCURED"
                    ? (visibilityRadius ?? undefined)
                    : undefined
                }
                height="100%"
              />
            </MapContainer>
          )}
        </YStack>
      )}
    </>
  );
}
