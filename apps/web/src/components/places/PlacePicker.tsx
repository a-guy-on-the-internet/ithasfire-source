"use client";

import { useState, useMemo, useCallback, useId, useRef, useEffect } from "react";
import { useRouter } from "@bprogress/next/app";
import { keepPreviousData } from "@tanstack/react-query";
import { styled, useTheme, XStack, YStack } from "tamagui";
import { MapPin, ChevronDown, Search, X, Plus } from "lucide-react";

import { Text, Button, useTranslations } from "@th/ui";

import { trpc } from "@/trpc";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { traceIgnoredError } from "@/lib/trace-ignored-error";
import {
  PICKER_FOCUS_VISIBLE_STYLE,
  activateKeyProps,
  dismissKeyProps,
  dropdownTriggerKeyProps,
} from "@/lib/dropdown-keyboard";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type PlacePickerItem = {
  placeId: string;
  name: string;
  formattedAddress: string | null;
  city: string | null;
  region: string | null;
  lat: number | null;
  lng: number | null;
  /**
   * The venue's postcode, so a builder that copies the place's address
   * carries it too (the community venue-change rule strips postcodes before
   * comparing street lines). Only an owned-list pick fills it; an "All
   * venues" pick (`places.getPlacePublic`) and the builder's hydration path
   * carry none, and absent/null means "unknown".
   */
  postalCode?: string | null;
  /**
   * The venue's IANA zone, derived from its coordinates at place creation.
   * Null means "unknown" — a legacy row, a failed lookup, or a caller that
   * built this item from a projection that doesn't carry the column (the
   * event builder's hydration path). Consumers must LEAVE their current zone
   * alone on null; never fall back to the browser's.
   */
  timezone: string | null;
  status: string;
  verificationStatus: string;
};

export type PlacePickerProps = {
  /** Currently selected place (controlled). */
  value: PlacePickerItem | null;
  /** Fires when the user picks or clears a place. */
  onChange: (place: PlacePickerItem | null) => void;
  /** Pass the org ID to scope the query when the EventBuilder is in org context. */
  orgId?: string;
  /** Admin slug used to build the "Create Place" link. */
  adminSlug?: string;
  placeholder?: string;
  /**
   * Grouped search (event builder, venue-confirmation spec): ONE box, results
   * grouped "Your venues" (the owned list, as always) then "All venues" — any
   * active place, claimed or not, from the public search index — then an
   * "Add a place" tail. Off by default so the other pickers (embeds subject,
   * ticket presets, quick-create) keep listing owned places only.
   */
  includeAllVenues?: boolean;
  /**
   * List the viewer's OWN places ("Your venues", `places.listHumanPlaces`).
   * Default true. A community listing turns it off: it has no owner, so the
   * moderator's own places are not "yours" to the listing, and the picker
   * searches the public index only (pair with `includeAllVenues`).
   */
  ownedVenues?: boolean;
};

/** Minimum typed length before "All venues" is searched. */
export const ALL_VENUES_MIN_QUERY = 2;
const ALL_VENUES_DEBOUNCE_MS = 250;
const ALL_VENUES_LIMIT = 10;

/* ------------------------------------------------------------------ */
/*  Styles                                                             */
/* ------------------------------------------------------------------ */

const Trigger = styled(XStack, {
  padding: 12,
  paddingHorizontal: 16,
  borderWidth: 1,
  borderColor: "$borderColorStrong",
  backgroundColor: "$surface",
  alignItems: "center",
  gap: 10,
  cursor: "pointer",
  hoverStyle: { borderColor: "$borderColorHover" },
  focusVisibleStyle: PICKER_FOCUS_VISIBLE_STYLE,
});

const DropdownContainer = styled(YStack, {
  position: "absolute",
  top: "100%",
  left: 0,
  right: 0,
  zIndex: 200,
  backgroundColor: "$surface",
  borderWidth: 1,
  borderColor: "$borderColorStrong",
  borderTopWidth: 0,
  maxHeight: 320,
  overflow: "hidden",
});

const SearchRow = styled(XStack, {
  padding: 10,
  gap: 8,
  alignItems: "center",
  borderBottomWidth: 1,
  borderBottomColor: "$borderColor",
});

const ResultsList = styled(YStack, {
  overflow: "auto" as never,
  maxHeight: 260,
});

const PlaceRow = styled(XStack, {
  padding: 12,
  paddingHorizontal: 16,
  gap: 10,
  alignItems: "center",
  cursor: "pointer",
  hoverStyle: { backgroundColor: "$surfaceMuted" },
  focusVisibleStyle: {
    ...PICKER_FOCUS_VISIBLE_STYLE,
    outlineOffset: -2,
    backgroundColor: "$surfaceMuted",
  },
});

/** Group header inside the listbox — the label idiom, ornament only. */
const GroupHeader = styled(XStack, {
  paddingHorizontal: 16,
  paddingTop: 10,
  paddingBottom: 4,
});

/** Footer / empty-state actions that navigate away. */
const RowAction = styled(XStack, {
  gap: 4,
  alignItems: "center",
  cursor: "pointer",
  focusVisibleStyle: PICKER_FOCUS_VISIBLE_STYLE,
});

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function PlacePicker({
  value,
  onChange,
  orgId,
  adminSlug,
  placeholder,
  includeAllVenues = false,
  ownedVenues = true,
}: PlacePickerProps) {
  const t = useTranslations();
  const theme = useTheme();
  const router = useRouter();
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  /** The "All venues" row being hydrated into a full item, if any. */
  const [hydratingPlaceId, setHydratingPlaceId] = useState<string | null>(null);
  const [hydrateFailed, setHydrateFailed] = useState(false);
  /**
   * Staleness token for an in-flight "All venues" hydration. Every select,
   * clear, close and new pick bumps it; a hydration that resolves after the
   * token moved on hands NOTHING up — otherwise a slow read could overwrite a
   * later pick, or land a venue in a picker the organizer already closed.
   */
  const selectionTokenRef = useRef(0);
  const bumpSelection = useCallback(() => {
    selectionTokenRef.current += 1;
  }, []);
  const containerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLElement>(null);
  const listboxId = useId();

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        bumpSelection();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open, bumpSelection]);

  // Focus search input when dropdown opens
  useEffect(() => {
    if (open) {
      // Small delay so the dropdown renders first
      requestAnimationFrame(() => searchInputRef.current?.focus());
    }
  }, [open]);

  const listInput = useMemo(
    () => ({
      limit: 50,
      query: query.trim().length >= 2 ? query.trim() : undefined,
      verifiedOnly: false,
      ownedOnly: true,
      ...(orgId ? { orgIds: [orgId] } : {}),
    }),
    [query, orgId],
  );

  const ownedQuery = trpc.places.listHumanPlaces.useQuery(listInput, {
    staleTime: 30_000,
    enabled: open && ownedVenues,
  });
  const data = ownedVenues ? ownedQuery.data : undefined;
  const isLoading = ownedVenues && ownedQuery.isLoading;

  // When editing under an org context, only show places that the org actually
  // has access to.  The backend query uses an OR (human-owned OR org-owned)
  // which can surface places the human owns personally but that are not linked
  // to the current org.  Saving such a place would fail with "venue not found".
  const places = useMemo(() => {
    const raw = data?.places ?? [];
    if (!orgId) return raw;
    return raw.filter((p) => p.access.orgIds.includes(orgId));
  }, [data?.places, orgId]);

  // ── "All venues" — the public search index, any ACTIVE place ────────────
  // `search.autocomplete` with `types: ["place"]` and NO `listedInDirectoryOnly`:
  // its place filter is exactly `status = ACTIVE`, which is the server's
  // attach rule for an event's venue. Debounced and gated on two typed
  // characters so an open dropdown does not hit Meilisearch per keystroke.
  const debouncedQuery = useDebouncedValue(query, ALL_VENUES_DEBOUNCE_MS);
  const allVenuesQueryText = debouncedQuery.trim();
  const canSearchAll =
    includeAllVenues && allVenuesQueryText.length >= ALL_VENUES_MIN_QUERY;
  const allVenuesQuery = trpc.search.autocomplete.useQuery(
    { query: allVenuesQueryText, types: ["place"], limit: ALL_VENUES_LIMIT },
    {
      enabled: open && canSearchAll,
      staleTime: 30_000,
      placeholderData: keepPreviousData,
      meta: { silent: true },
    },
  );

  /** Search hits that are not already in "Your venues". */
  const otherVenues = useMemo(() => {
    if (!canSearchAll) return [];
    const owned = new Set(places.map((p) => p.placeId));
    const suggestions = allVenuesQuery.data?.suggestions ?? [];
    return suggestions.flatMap((s) =>
      s.type === "place" && !owned.has(s.placeId) ? [s] : [],
    );
  }, [canSearchAll, places, allVenuesQuery.data?.suggestions]);

  const handleSelect = useCallback(
    (place: (typeof places)[number]) => {
      bumpSelection();
      onChange({
        placeId: place.placeId,
        name: place.name,
        formattedAddress: place.formattedAddress,
        city: place.city,
        region: place.region,
        lat: place.lat ?? null,
        lng: place.lng ?? null,
        postalCode: place.postalCode ?? null,
        timezone: place.timezone ?? null,
        status: place.status,
        verificationStatus: place.verificationStatus,
      });
      setOpen(false);
      setQuery("");
    },
    [onChange, bumpSelection],
  );

  /**
   * An "All venues" hit carries only `placeId / title / subtitle / city`. The
   * builder's venue-zone wall-clock logic needs `timezone`, and the map
   * preview needs coordinates, so the pick is hydrated before it is handed
   * up: `places.getPlacePublic` for the row, then `places.resolveTimezone`
   * from its coordinates (the public read carries no zone column). A failed
   * zone lookup degrades to `timezone: null`, which consumers already treat
   * as "leave the current zone alone" — but the failure is REPORTED
   * (`traceIgnoredError`), never silently eaten; a failed place read keeps
   * the list open with an inline error rather than handing up a half-built
   * item. Both bail when the selection token moved while they were in flight.
   */
  const handleSelectSuggestion = useCallback(
    async (suggestion: (typeof otherVenues)[number]) => {
      bumpSelection();
      const token = selectionTokenRef.current;
      setHydratingPlaceId(suggestion.placeId);
      setHydrateFailed(false);
      try {
        const { place } = await utils.places.getPlacePublic.fetch(
          { placeId: suggestion.placeId },
          { staleTime: 60_000 },
        );
        let timezone: string | null = null;
        if (place.lat !== null && place.lng !== null) {
          try {
            timezone = (
              await utils.places.resolveTimezone.fetch(
                { lat: place.lat, lng: place.lng },
                { staleTime: Infinity },
              )
            ).timezone;
          } catch (err) {
            traceIgnoredError("placePicker.resolveTimezone")(err);
            timezone = null;
          }
        }
        if (selectionTokenRef.current !== token) return;
        onChange({
          placeId: place.placeId,
          name: place.name,
          formattedAddress: place.formattedAddress,
          city: place.city,
          region: place.region,
          lat: place.lat,
          lng: place.lng,
          timezone,
          status: place.status,
          verificationStatus: place.verificationStatus,
        });
        setOpen(false);
        setQuery("");
      } catch (err) {
        if (selectionTokenRef.current === token) setHydrateFailed(true);
        // The organizer moved on, so no inline error — but the failure is
        // still a failure, and it is recorded.
        else traceIgnoredError("placePicker.hydratePlace")(err);
      } finally {
        setHydratingPlaceId((current) =>
          current === suggestion.placeId ? null : current,
        );
      }
    },
    [onChange, utils, bumpSelection],
  );

  const handleClear = useCallback(
    (e: { stopPropagation: () => void }) => {
      e.stopPropagation();
      bumpSelection();
      onChange(null);
    },
    [onChange, bumpSelection],
  );

  const handleToggle = useCallback(() => {
    if (open) {
      bumpSelection();
      setQuery("");
    }
    setOpen((prev) => !prev);
  }, [open, bumpSelection]);

  /** Escape / re-toggle: close AND hand focus back, or the user is stranded. */
  const closeAndRefocus = useCallback(() => {
    bumpSelection();
    setOpen(false);
    setQuery("");
    triggerRef.current?.focus();
  }, [bumpSelection]);

  const goToPlaces = useCallback(() => {
    bumpSelection();
    setOpen(false);
    router.push(`/admin/${adminSlug}/places`);
  }, [router, adminSlug, bumpSelection]);

  const displayText = value
    ? value.name
    : (placeholder ?? String(t("admin.pckSelectPlace")));

  const displaySubtext = value?.formattedAddress ?? null;

  const typedEnough = query.trim().length >= ALL_VENUES_MIN_QUERY;
  const allVenuesSearching =
    canSearchAll && (allVenuesQuery.isLoading || allVenuesQuery.isFetching);
  // The empty state only speaks when NO group has anything to say: in grouped
  // mode a short query still shows the "type to search" hint below the owned
  // list, and a long one waits for the index before declaring "no places".
  const showEmpty =
    !isLoading &&
    places.length === 0 &&
    (!includeAllVenues ||
      (typedEnough && otherVenues.length === 0 && !allVenuesSearching));

  // Text links on the surface ride `accentText` (raw accent is ~3.9:1 as
  // small text on Stub — AA fails); 44px tall so the tail is a real target.
  const renderAddPlace = (props: { padded: boolean }) =>
    adminSlug ? (
      <RowAction
        {...(props.padded
          ? {
              padding: 10,
              gap: 6,
              justifyContent: "center",
              borderTopWidth: 1,
              borderTopColor: "$borderColor",
              hoverStyle: { backgroundColor: "$surfaceMuted" },
            }
          : { paddingVertical: 6 })}
        minHeight={44}
        role="button"
        tabIndex={0}
        onPress={goToPlaces}
        data-testid="place-picker-add-place"
        {...(activateKeyProps(goToPlaces) as object)}
      >
        <Plus size={12} color={theme.accentText?.val} />
        <Text variant="caption" color="$accentText">
          {String(t("admin.ebVenueSearchAdd"))}
        </Text>
      </RowAction>
    ) : null;

  return (
    <YStack position="relative" ref={containerRef as never}>
      <Trigger
        ref={triggerRef as never}
        onPress={handleToggle}
        // Keyboard-operable disclosure. NOT `tag="button"`: the clear control
        // below is a real <button>, and nesting buttons is invalid HTML.
        role="combobox"
        tabIndex={0}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? listboxId : undefined}
        aria-label={placeholder ?? String(t("admin.pckSelectPlace"))}
        {...(dropdownTriggerKeyProps({
          open,
          onOpen: () => setOpen(true),
          onClose: closeAndRefocus,
        }) as object)}
      >
        <MapPin
          size={16}
          color={value ? theme.color?.val : theme.colorMuted?.val}
        />
        <YStack flex={1} gap={2}>
          <Text variant="body" color={value ? "$color" : "$colorMuted"}>
            {displayText}
          </Text>
          {displaySubtext && (
            <Text variant="caption" color="$colorMuted">
              {displaySubtext}
            </Text>
          )}
        </YStack>
        {value ? (
          <Button
            variant="ghost"
            size="$1"
            onPress={handleClear}
            aria-label={t("admin.pckClearSelection") as string}
          >
            <X size={14} color={theme.colorMuted?.val} />
          </Button>
        ) : (
          <ChevronDown size={16} color={theme.colorMuted?.val} />
        )}
      </Trigger>

      {open && (
        <DropdownContainer {...(dismissKeyProps(closeAndRefocus) as object)}>
          <SearchRow>
            <Search size={14} color={theme.colorMuted?.val} />
            <input
              ref={searchInputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              // "Search your places" is wrong when there is no owned list.
              placeholder={
                (ownedVenues
                  ? t("admin.pckSearchPlaces")
                  : t("search.placeholderVenues")) as string
              }
              style={{
                flex: 1,
                border: "none",
                fontSize: 14,
                backgroundColor: "transparent",
                color: "var(--foreground, inherit)",
              }}
            />
          </SearchRow>

          {/* `role="listbox"` is spread via a cast: Tamagui's Role type is
              RN-derived and omits "listbox" (it has combobox/option but not
              the container role). Same cast pattern as onKeyDown. */}
          <ResultsList
            id={listboxId}
            aria-label={String(t("admin.pckSelectPlace"))}
            {...({ role: "listbox" } as object)}
          >
            {isLoading && (
              <XStack padding={16} justifyContent="center">
                <Text variant="caption" color="$colorMuted">
                  {String(t("admin.pckLoading"))}
                </Text>
              </XStack>
            )}

            {showEmpty && (
              <YStack padding={16} alignItems="center" gap={4}>
                <Text variant="caption" color="$colorMuted">
                  {query.trim().length >= 2
                    ? String(t("admin.pckNoPlacesFound"))
                    : String(t("admin.pckNoPlacesYet"))}
                </Text>
                {includeAllVenues ? (
                  renderAddPlace({ padded: false })
                ) : adminSlug ? (
                  <RowAction
                    paddingVertical={6}
                    minHeight={44}
                    role="button"
                    tabIndex={0}
                    onPress={goToPlaces}
                    {...(activateKeyProps(goToPlaces) as object)}
                  >
                    <Plus size={12} color={theme.accentText?.val} />
                    <Text variant="caption" color="$accentText">
                      {String(t("admin.pckCreatePlace"))}
                    </Text>
                  </RowAction>
                ) : (
                  <Text variant="caption" color="$colorMuted">
                    {String(t("admin.pckAddPlacesHint"))}
                  </Text>
                )}
              </YStack>
            )}

            {/* "Your venues" — the owned list. In grouped mode it sits under
                a header inside a `role="group"`, which is valid listbox
                structure (listbox → group → option). */}
            {!isLoading && places.length > 0 && (
              <YStack
                {...(includeAllVenues
                  ? ({
                      role: "group",
                      "aria-label": String(t("admin.ebVenueSearchYours")),
                    } as object)
                  : {})}
                data-testid="place-picker-group-yours"
              >
                {includeAllVenues && (
                  <GroupHeader aria-hidden>
                    <Text variant="overline" tone="muted">
                      {String(t("admin.ebVenueSearchYours"))}
                    </Text>
                  </GroupHeader>
                )}
                {places.map((place) => {
                  // Parked while an "All venues" pick is being hydrated: two
                  // picks racing would let the slower one win.
                  const pick = () => {
                    if (hydratingPlaceId === null) handleSelect(place);
                  };
                  return (
                  <PlaceRow
                    key={place.placeId}
                    onPress={pick}
                    role="option"
                    aria-selected={value?.placeId === place.placeId}
                    aria-disabled={hydratingPlaceId !== null || undefined}
                    tabIndex={0}
                    {...(activateKeyProps(pick) as object)}
                  >
                    <MapPin size={14} color={theme.color?.val} />
                    <YStack flex={1} gap={1}>
                      <Text variant="body" color="$color">
                        {place.name}
                      </Text>
                      {place.formattedAddress && (
                        <Text variant="caption" color="$colorMuted">
                          {place.formattedAddress}
                        </Text>
                      )}
                    </YStack>
                    {place.verificationStatus === "VERIFIED" && (
                      <Text variant="caption" color="$success">
                        {String(t("admin.ppVerified"))}
                      </Text>
                    )}
                  </PlaceRow>
                  );
                })}
              </YStack>
            )}

            {/* "All venues" — only once two characters are typed. */}
            {includeAllVenues && !isLoading && !typedEnough && (
              <XStack paddingHorizontal={16} paddingVertical={10}>
                <Text
                  variant="caption"
                  color="$colorMuted"
                  data-testid="place-picker-type-to-search"
                >
                  {String(t("admin.ebVenueSearchTypeToSearch"))}
                </Text>
              </XStack>
            )}
            {includeAllVenues && typedEnough && otherVenues.length > 0 && (
              <YStack
                {...({
                  role: "group",
                  "aria-label": String(t("admin.ebVenueSearchAll")),
                } as object)}
                data-testid="place-picker-group-all"
              >
                <GroupHeader aria-hidden>
                  <Text variant="overline" tone="muted">
                    {String(t("admin.ebVenueSearchAll"))}
                  </Text>
                </GroupHeader>
                {otherVenues.map((suggestion) => {
                  const hydrating = hydratingPlaceId === suggestion.placeId;
                  const pick = () => {
                    if (hydratingPlaceId === null)
                      void handleSelectSuggestion(suggestion);
                  };
                  return (
                    <PlaceRow
                      key={suggestion.placeId}
                      onPress={pick}
                      role="option"
                      aria-selected={value?.placeId === suggestion.placeId}
                      aria-busy={hydrating || undefined}
                      tabIndex={0}
                      data-testid={`place-picker-all-${suggestion.placeId}`}
                      {...(activateKeyProps(pick) as object)}
                    >
                      <MapPin size={14} color={theme.color?.val} />
                      <YStack flex={1} gap={1}>
                        <Text variant="body" color="$color">
                          {suggestion.title}
                        </Text>
                        {(suggestion.subtitle ?? suggestion.city) && (
                          <Text variant="caption" color="$colorMuted">
                            {suggestion.subtitle ?? suggestion.city}
                          </Text>
                        )}
                      </YStack>
                      {hydrating && (
                        <Text variant="caption" color="$colorMuted">
                          {String(t("admin.pckLoading"))}
                        </Text>
                      )}
                    </PlaceRow>
                  );
                })}
              </YStack>
            )}
            {includeAllVenues && allVenuesSearching && otherVenues.length === 0 && (
              <XStack padding={12} justifyContent="center">
                <Text variant="caption" color="$colorMuted">
                  {String(t("admin.pckLoading"))}
                </Text>
              </XStack>
            )}
            {hydrateFailed && (
              <XStack paddingHorizontal={16} paddingVertical={8}>
                <Text
                  variant="caption"
                  tone="error"
                  role="alert"
                  data-testid="place-picker-hydrate-error"
                >
                  {String(t("admin.ebVenueLoadFailed"))}
                </Text>
              </XStack>
            )}
          </ResultsList>

          {/* Footer: grouped mode always offers "Add a place" (the search
              index can lag a just-created place); the plain picker keeps
              its "Manage places" link once there is something to manage. */}
          {includeAllVenues
            ? !showEmpty && renderAddPlace({ padded: true })
            : adminSlug &&
              !isLoading &&
              places.length > 0 && (
                <RowAction
                  padding={10}
                  gap={6}
                  minHeight={44}
                  justifyContent="center"
                  borderTopWidth={1}
                  borderTopColor="$borderColor"
                  hoverStyle={{ backgroundColor: "$surfaceMuted" }}
                  role="button"
                  tabIndex={0}
                  onPress={goToPlaces}
                  {...(activateKeyProps(goToPlaces) as object)}
                >
                  <MapPin size={12} color={theme.accentText?.val} />
                  <Text variant="caption" color="$accentText">
                    {String(t("admin.pckManagePlaces"))}
                  </Text>
                </RowAction>
              )}
        </DropdownContainer>
      )}
    </YStack>
  );
}

export default PlacePicker;
