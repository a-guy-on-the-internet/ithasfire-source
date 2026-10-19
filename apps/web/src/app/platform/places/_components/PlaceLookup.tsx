"use client";

import { useMemo, useState } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import { XStack, YStack } from "tamagui";
import { Badge, Spinner, Text, useTranslations } from "@th/ui";
import { MapPin, SearchX } from "lucide-react";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";
import { SearchBar } from "@/components/AdminTableParts";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import type { PlatformPlaceRow, PlaceVerificationStatus } from "./types";

/**
 * Staff place lookup for /platform/places (FR-015).
 *
 * The verification queue only ever lists places that HAVE an open request, so
 * before this there was no way to reach an arbitrary place from the queue —
 * which is exactly what the "Waive verification" action needs (a place that
 * never submitted documents by definition has no queue row).
 *
 * Authorization: this reuses `platform.listPlaces`, which is `authedProcedure`
 * + `listPlatformPlaces`'s own `hasStaffRole` gate, and sits under the
 * `platform.*` staff second-factor guard. No new endpoint, no widened access —
 * a non-staff caller gets STAFF_ONLY from the same use case that already
 * powers the All Places tab.
 */

/** Matches NFR-002's debounce convention elsewhere in the app. */
const DEBOUNCE_MS = 300;
/** Below this a query is too broad to be useful and just burns round-trips. */
const MIN_QUERY_LENGTH = 2;
const MAX_RESULTS = 8;
/** Mirrors listPlatformPlacesInputSchema's `query: z.string().max(200)`. */
const MAX_QUERY_LENGTH = 200;

const VERIFICATION_BADGE_TONE: Record<
  PlaceVerificationStatus,
  "success" | "info" | "danger" | "warning"
> = {
  VERIFIED: "success",
  PENDING: "info",
  REJECTED: "danger",
  UNVERIFIED: "warning",
};

const VERIFICATION_LABEL_KEY: Record<PlaceVerificationStatus, string> = {
  VERIFIED: "admin.ppVerified",
  PENDING: "admin.ppPending",
  REJECTED: "admin.ppRejected",
  UNVERIFIED: "admin.ppUnverified",
};

function ResultRow({
  place,
  onPress,
}: {
  place: PlatformPlaceRow;
  onPress: () => void;
}) {
  const t = useTranslations();

  const secondary = useMemo(() => {
    // Location alone is the disambiguator between same-named venues. This
    // used to lead with `Place.slug`, a DIRECTORY key nothing ever routed on;
    // the column is deprecated and no longer minted, so on any recent venue it
    // would render blank.
    return [place.city, place.region, place.countryCode]
      .filter(Boolean)
      .join(", ");
  }, [place.city, place.region, place.countryCode]);

  // Web-only a11y props Tamagui doesn't type on its Stack surface — same
  // escape hatch QueueRow uses.
  const a11y: object = {
    role: "button",
    tabIndex: 0,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onPress();
      }
    },
  };

  return (
    <XStack
      gap="$3"
      alignItems="center"
      justifyContent="space-between"
      padding="$3"
      borderTopWidth={2}
      borderTopColor="$borderColor"
      backgroundColor="$surface"
      cursor="pointer"
      hoverStyle={{ backgroundColor: "$surfaceMuted" }}
      onPress={onPress}
      {...a11y}
    >
      <YStack gap="$1" flex={1} minWidth={0}>
        <Text variant="body" weight="bold" truncate>
          {place.name}
        </Text>
        {secondary ? (
          <Text variant="caption" tone="muted" truncate>
            {secondary}
          </Text>
        ) : null}
      </YStack>
      <Badge tone={VERIFICATION_BADGE_TONE[place.verificationStatus]} size="sm">
        {String(t(VERIFICATION_LABEL_KEY[place.verificationStatus]))}
      </Badge>
    </XStack>
  );
}

export function PlaceLookup({
  onSelectPlace,
  excludePlaceIds,
  hint,
}: {
  /** Opens the place in the shared PlaceDetailPanel (waive lives there). */
  onSelectPlace: (place: PlatformPlaceRow) => void;
  /** Places never offered (the merge picker leaves out the current place). */
  excludePlaceIds?: readonly string[];
  /** Replaces the default idle hint. */
  hint?: string;
}) {
  const t = useTranslations();
  const [term, setTerm] = useState("");
  const debounced = useDebouncedValue(term, DEBOUNCE_MS);

  const trimmed = debounced.trim();
  const enabled = trimmed.length >= MIN_QUERY_LENGTH;

  const lookupQuery = trpc.platform.listPlaces.useQuery(
    { query: trimmed, limit: MAX_RESULTS, offset: 0 },
    { enabled, staleTime: 15_000, placeholderData: keepPreviousData },
  );

  const results = enabled
    ? (lookupQuery.data?.places ?? []).filter(
        (p) => !excludePlaceIds?.includes(p.placeId),
      )
    : [];
  // While the debounce is still settling the previous results are stale —
  // show the spinner rather than a list that doesn't match what's typed.
  const isSettling = term.trim() !== trimmed;
  const isBusy = enabled && (lookupQuery.isFetching || isSettling);

  return (
    <YStack
      gap={0}
      borderWidth={2}
      borderColor="$borderColor"
      backgroundColor="$surface"
    >
      <XStack
        gap="$3"
        alignItems="center"
        padding="$3"
        flexWrap="wrap"
        justifyContent="space-between"
      >
        <SearchBar
          value={term}
          onChangeText={setTerm}
          placeholder={String(t("admin.ppLookupPlaceholder"))}
          maxLength={MAX_QUERY_LENGTH}
          testId="platform-place-lookup-input"
        />
        {isBusy ? <Spinner size="small" /> : null}
      </XStack>

      {enabled ? (
        <YStack gap={0} data-testid="platform-place-lookup-results">
          {lookupQuery.error ? (
            <YStack
              padding="$3"
              borderTopWidth={2}
              borderTopColor="$borderColor"
            >
              <Text variant="bodySmall" tone="error">
                {formatErrorMessage(lookupQuery.error, t)}
              </Text>
            </YStack>
          ) : results.length === 0 && !lookupQuery.isLoading ? (
            <XStack
              gap="$2"
              alignItems="center"
              padding="$3"
              borderTopWidth={2}
              borderTopColor="$borderColor"
            >
              <SearchX size={14} style={{ opacity: 0.5 }} />
              <Text variant="bodySmall" tone="muted">
                {String(t("admin.ppLookupNoResults", { query: trimmed }))}
              </Text>
            </XStack>
          ) : (
            results.map((place) => (
              <ResultRow
                key={place.placeId}
                place={place}
                onPress={() => onSelectPlace(place)}
              />
            ))
          )}
        </YStack>
      ) : (
        <XStack
          gap="$2"
          alignItems="center"
          padding="$3"
          borderTopWidth={2}
          borderTopColor="$borderColor"
        >
          <MapPin size={14} style={{ opacity: 0.5 }} />
          <Text variant="bodySmall" tone="muted">
            {hint ?? String(t("admin.ppLookupHint"))}
          </Text>
        </XStack>
      )}
    </YStack>
  );
}
