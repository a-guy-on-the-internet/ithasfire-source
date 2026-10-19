"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { nanoid } from "nanoid";
import { useSearchParams } from "next/navigation";
import { useRouter } from "@bprogress/next/app";
import { MapPin } from "lucide-react";
import { XStack, YStack } from "tamagui";

import {
  Button,
  FormErrorBanner,
  Text,
  TextInput,
  useNotify,
  useTranslations,
} from "@th/ui";

import { trpc } from "@/trpc";
import { useCurrentAdminOwner } from "@/hooks/useCurrentAdminOwner";
import { useFormErrors } from "@/hooks/useFormErrors";
import { formatErrorMessage } from "@/lib/format-error-message";
import {
  extractQuotaExceededMeta,
  type QuotaExceededMeta,
} from "@/lib/quota-error";
import { QuotaExceededDialog } from "@/components/errors/QuotaExceededDialog";
import LocationAutocomplete from "@/components/maps/LocationAutocomplete";
import type { PlaceDetail } from "@/components/maps/LocationAutocomplete";
import { isMapEnabled } from "@/config/maps";
import { reverseGeocode } from "@/lib/maps/geocoding";
import { PlacePicker } from "@/components/places/PlacePicker";
import type { PlacePickerItem } from "@/components/places/PlacePicker";
import { readQuickCreatePrefill } from "@/lib/quick-create-prefill";
import { useCalendarText } from "@/app/admin/[slug]/_components/calendar";

import { Field, FieldLabel, NativeDateTimeInput } from "./_form-bits";
import type { LocationMode, LocationState } from "./LocationSection";
import { toDateTimeLocalValue } from "./event-builder-helpers";
import {
  resolveTimezoneForPlaceSelection,
  type TimezoneAdoptionSource,
} from "./event-timezone";
import { useAddressTimezoneAdoption } from "./use-address-timezone";
import { EventTimezoneNote } from "./EventTimezoneNote";
import {
  buildQuickCreateSaveInput,
  validateQuickCreate,
} from "./quick-create-helpers";

/**
 * Quick create (event-builder regroup FR-301): the focused 3-field form —
 * title / starts-at / venue — rendered as a single centered Swiss card at
 * `/admin/:slug/events/new`. Submit creates a DRAFT through the SAME
 * `createEventForHuman` / `createEventForOrg` procedures the full builder
 * saves with (see quick-create-helpers for the payload mirror), then routes
 * to `/admin/:slug/events/:id/edit`.
 *
 * The venue field reuses the exact search components the builder's
 * LocationSection composes — LocationAutocomplete (freeform address) and
 * PlacePicker (linked Ithas Fire Places) behind the same Address / My Places
 * toggle — minus the map chrome, which belongs to the full builder.
 *
 * The venue is OPTIONAL (owner ruling 2026-09-08). The picker here lists only
 * venues the organiser owns — deliberately no "All venues" mode — so a third
 * party cannot name someone else's venue on this screen. Leaving it blank
 * sends `location: {}` ("no location", a pinned-valid state server-side) and
 * the venue, with the booking cascade, is chosen in the full builder. With no
 * venue the browser zone is what `startsAt` is interpreted in (see
 * `eventTimezone` below).
 *
 * PREFILL (venue-hierarchy FR-011): an admin calendar routes here with the
 * clicked cell's context on the query string —
 * `?startsAt=…&placeId=…&calendarId=…&spaceId=…`. Every value is validated
 * before it touches form state: a hand-edited or stale link degrades to the
 * plain empty form, never to a crash or a bogus date. The placement pair is
 * sent with the save (and stamped onto the created event) ONLY while the
 * resolved venue is still the prefilled place — swap the venue and the
 * placement is dropped, because it belongs to the old one.
 */
export function QuickCreateEventForm({ slug }: { slug: string }) {
  const router = useRouter();
  const t = useTranslations();
  const ct = useCalendarText();
  const { toast } = useNotify();
  const { currentOwner } = useCurrentAdminOwner(slug);
  const searchParams = useSearchParams();
  const prefill = useMemo(
    () => readQuickCreatePrefill(searchParams),
    [searchParams],
  );

  const {
    fieldErrors,
    formError,
    setError,
    setFieldError,
    clearField,
    clearAll,
  } = useFormErrors<"title" | "startsAt" | "venue">();

  const [title, setTitle] = useState("");
  // Lazy initializer, not an effect: the prefilled date must be there on the
  // FIRST paint, and seeding it later would fight anything the organiser had
  // already typed.
  const [startsAt, setStartsAt] = useState<string | undefined>(
    () => prefill.startsAt,
  );
  // A prefilled venue arrives as an id; the picker needs the whole row, which
  // only lands once `placesQuery` resolves — so the mode flips up front and
  // the picker shows its own empty trigger for that beat.
  const [locationMode, setLocationMode] = useState<LocationMode>(
    prefill.placeId ? "place" : "address",
  );
  const [locationSearch, setLocationSearch] = useState("");
  const [location, setLocation] = useState<LocationState>({});
  const [selectedPlace, setSelectedPlace] = useState<PlacePickerItem | null>(
    null,
  );
  /**
   * The zone `startsAt` is interpreted in at submit. Seeded from the browser
   * as a last resort (there is no event and no venue yet, and it is what the
   * empty date input already means), then ADOPTED from the venue the moment
   * one is picked — see `./event-timezone.ts` for the rule and the
   * wall-clock-stays interpretation.
   *
   * Freeform-address mode adopts too: the address has no zone of its own, but
   * it does have coordinates (from the geocoder pick or "use my location"),
   * which `useAddressTimezoneAdoption` turns into one. The browser zone is
   * still what is SENT until something is adopted — it is what the typed wall
   * clock already means with no location on the form.
   */
  const [eventTimezone, setEventTimezone] = useState<string>(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Chicago",
  );
  const [timezoneAdoptedFrom, setTimezoneAdoptedFrom] =
    useState<TimezoneAdoptionSource | null>(null);
  const [quotaMeta, setQuotaMeta] = useState<QuotaExceededMeta | null>(null);

  // Stash the address-mode selection when the user peeks at My Places so
  // toggling back doesn't lose a typed address (mirrors EventBuilder's
  // handleLocationModeChange).
  const savedAddressRef = useRef<{
    location: LocationState;
    search: string;
  } | null>(null);

  const createForHuman = trpc.events.createEventForHuman.useMutation({
    retry: false,
    meta: { silent: true },
  });
  const createForOrg = trpc.events.createEventForOrg.useMutation({
    retry: false,
    meta: { silent: true },
  });
  const isPending = createForHuman.isPending || createForOrg.isPending;
  // Same-tick double-submit guard (mutation isPending only flips on re-render).
  const inflightRef = useRef(false);

  const handleLocationModeChange = useCallback(
    (mode: LocationMode) => {
      if (mode === locationMode) return;
      setLocationMode(mode);
      // The only venue error refers to the control being hidden; it must not
      // sit under the other one.
      clearField("venue");
      if (mode === "place") {
        savedAddressRef.current = { location, search: locationSearch };
        setLocation({});
        setLocationSearch("");
      } else {
        setSelectedPlace(null);
        setLocation(savedAddressRef.current?.location ?? {});
        setLocationSearch(savedAddressRef.current?.search ?? "");
        // Venue gone → the "adopted from <venue>" note is stale. The zone
        // itself stays: the typed time keeps meaning what it meant, and a
        // freeform address carries no zone to revert to.
        setTimezoneAdoptedFrom(null);
      }
    },
    [clearField, location, locationMode, locationSearch],
  );

  // "Use my location" (address mode) — the from-scratch flow from
  // LocationSection.handleUseMyLocation: geolocate, drop the coordinates, and
  // reverse-geocode to fill the address. There's no map here to re-center, so
  // the button always (re)fills the venue from the current position.
  const [isLocating, setIsLocating] = useState(false);
  const [geoError, setGeoError] = useState(false);
  const handleUseMyLocation = useCallback(() => {
    if (!isMapEnabled) return;
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setGeoError(true);
      return;
    }
    setGeoError(false);
    setIsLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        setLocation({ lat, lng });
        void reverseGeocode(lat, lng)
          .then((result) => {
            if (result?.formattedAddress) {
              setLocation({
                lat,
                lng,
                addressText: result.formattedAddress,
                locality: result.locality ?? undefined,
                region: result.region ?? undefined,
                countryCode: result.countryCode ?? undefined,
                postalCode: result.postalCode ?? undefined,
              });
              setLocationSearch(result.formattedAddress);
              clearField("venue");
            }
          })
          .finally(() => {
            setIsLocating(false);
          });
      },
      () => {
        setIsLocating(false);
        setGeoError(true);
      },
      { timeout: 5_000, maximumAge: 300_000 },
    );
  }, [clearField]);

  // Typing in the address box: clear on input (§6a) — the only venue error is
  // "typed but never picked", and editing the text is the start of fixing it.
  const handleAddressSearchChange = useCallback(
    (value: string) => {
      setLocationSearch(value);
      clearField("venue");
    },
    [clearField],
  );

  // Geocoder pick (address mode) — same fields LocationSection maps.
  const handleAddressSelect = useCallback(
    (place: PlaceDetail) => {
      setLocation({
        addressText: place.formattedAddress ?? undefined,
        lat: place.lat ?? undefined,
        lng: place.lng ?? undefined,
        locality: place.city ?? undefined,
        region: place.region ?? undefined,
        countryCode: place.countryCode ?? undefined,
        postalCode: place.postalCode ?? undefined,
      });
      setLocationSearch(place.formattedAddress ?? "");
      clearField("venue");
    },
    [clearField],
  );

  // Linked-Place pick (My Places mode) — same fields LocationSection maps,
  // plus the venue's zone (same rule as the full builder).
  const handleThPlaceSelect = useCallback(
    (place: PlacePickerItem | null) => {
      setSelectedPlace(place);
      const { timezone, adopted } = resolveTimezoneForPlaceSelection({
        currentTimezone: eventTimezone,
        previousPlaceId: selectedPlace?.placeId ?? null,
        place,
      });
      if (adopted) {
        setEventTimezone(timezone);
        setTimezoneAdoptedFrom(adopted.source);
      } else if (!place) {
        setTimezoneAdoptedFrom(null);
      }
      if (place) {
        setLocation({
          thPlaceId: place.placeId,
          thPlaceName: place.name,
          addressText: place.formattedAddress ?? undefined,
          lat: place.lat ?? undefined,
          lng: place.lng ?? undefined,
          locality: place.city ?? undefined,
          region: place.region ?? undefined,
        });
        clearField("venue");
      } else {
        setLocation({});
        clearField("venue");
      }
    },
    [clearField, eventTimezone, selectedPlace],
  );

  /**
   * Freeform-address zone adoption — the same rule the venue path uses, over
   * the coordinates the geocoder pick and "use my location" already set. There
   * is no map to drag here, so a request only ever follows an explicit pick;
   * the gating in `./use-address-timezone.ts` still applies unchanged.
   *
   * Nothing to prime past the first render: quick create starts empty, so the
   * baseline is "no coordinates" and the organiser's first address is a change.
   */
  const addressCoordinates = useMemo(
    () =>
      location.lat != null && location.lng != null
        ? { lat: location.lat, lng: location.lng }
        : null,
    [location.lat, location.lng],
  );
  const handleTimezoneAdoptedFromAddress = useCallback(
    (adopted: { timezone: string; source: TimezoneAdoptionSource }) => {
      setEventTimezone(adopted.timezone);
      setTimezoneAdoptedFrom(adopted.source);
    },
    [],
  );
  useAddressTimezoneAdoption({
    enabled: locationMode === "address",
    coordinates: addressCoordinates,
    currentTimezone: eventTimezone,
    onAdopt: handleTimezoneAdoptedFromAddress,
  });

  // ── Prefilled venue (FR-011) ─────────────────────────────────────────────
  // Resolve `?placeId=` through the SAME query PlacePicker lists from, so the
  // seeded selection is byte-identical to one the organiser could have made by
  // hand — including the venue's IANA zone, which the timezone adoption rule
  // below depends on. (A lighter `getPlaceForEdit` fetch does not project
  // `timezone`, and the picker item's contract says a null zone must leave the
  // current one alone — i.e. the event would silently keep the browser zone.)
  //
  // Bounded by the procedure's own `limit: 50` ceiling: an owner with more
  // than 50 places may fall outside the page, in which case the prefill is
  // simply skipped and the venue is picked manually. Degrades, never breaks.
  const prefilledOrgId =
    currentOwner?.kind === "org" ? currentOwner.orgId : undefined;

  // FR-019: a draft started from a calendar cell must say WHO it is created
  // as, because a personal dashboard can open the builder under an org.
  const creatingAsLabel = currentOwner
    ? ct("admin.calCreatingAs", "Creating as · {owner}", {
        owner:
          currentOwner.kind === "org" ? currentOwner.orgName : currentOwner.humanName,
      })
    : "";
  const placesQuery = trpc.places.listHumanPlaces.useQuery(
    {
      limit: 50,
      verifiedOnly: false,
      ownedOnly: true,
      ...(prefilledOrgId ? { orgIds: [prefilledOrgId] } : {}),
    },
    {
      enabled: Boolean(prefill.placeId) && Boolean(currentOwner),
      staleTime: 30_000,
      retry: 1,
      meta: { silent: true },
    },
  );

  // Applied at most once. Without the latch, clearing a prefilled venue would
  // snap it straight back on the next render — the organiser could never
  // change their mind.
  const prefilledPlaceAppliedRef = useRef(false);
  useEffect(() => {
    if (prefilledPlaceAppliedRef.current) return;
    const wanted = prefill.placeId;
    if (!wanted || !placesQuery.data) return;
    prefilledPlaceAppliedRef.current = true;
    const match = placesQuery.data.places.find((p) => p.placeId === wanted);
    // Mirrors PlacePicker's own org filter: a place the picker would hide is
    // one the save path would reject with "venue not found".
    if (
      !match ||
      (prefilledOrgId && !match.access.orgIds.includes(prefilledOrgId))
    ) {
      return;
    }
    handleThPlaceSelect({
      placeId: match.placeId,
      name: match.name,
      formattedAddress: match.formattedAddress,
      city: match.city,
      region: match.region,
      lat: match.lat ?? null,
      lng: match.lng ?? null,
      timezone: match.timezone ?? null,
      status: match.status,
      verificationStatus: match.verificationStatus,
    });
  }, [prefill.placeId, placesQuery.data, prefilledOrgId, handleThPlaceSelect]);

  const handleSubmit = useCallback(async () => {
    if (!currentOwner || inflightRef.current || isPending) return;

    const errors = validateQuickCreate({
      title,
      startsAt,
      location,
      // Only address mode can hold typed-but-unpicked text; My Places is a
      // pick-or-nothing control.
      addressSearch: locationMode === "address" ? locationSearch : "",
    });
    clearAll();
    if (errors.title) {
      setFieldError("title", String(t("admin.qcTitleRequired")));
    }
    if (errors.startsAt) {
      setFieldError("startsAt", String(t("admin.qcStartsAtRequired")));
    }
    if (errors.venue) {
      setFieldError("venue", String(t("admin.qcVenueUnresolved")));
    }
    if (errors.title || errors.startsAt || errors.venue) return;

    inflightRef.current = true;
    try {
      const input = buildQuickCreateSaveInput({
        title,
        startsAtLocal: startsAt!,
        // The zone the organizer was shown while typing — the venue's when one
        // was picked, the browser's otherwise. Never recomputed here: the
        // wall clock in `startsAt` was entered against THIS value.
        timezone: eventTimezone,
        location,
        clientKey: nanoid(12),
        // Venue-hierarchy placement (FR-011). Carried ONLY while the resolved
        // venue is still the place the cell came from — see
        // `resolveQuickCreatePlacement`.
        prefill,
      });

      const result =
        currentOwner.kind === "human"
          ? await createForHuman.mutateAsync(input)
          : await createForOrg.mutateAsync({
              ...input,
              orgId: currentOwner.orgId,
            });

      router.push(`/admin/${slug}/events/${result.eventId}/edit`);
    } catch (err) {
      const meta = extractQuotaExceededMeta(err);
      if (meta) {
        setQuotaMeta(meta);
        return;
      }
      console.error("Failed to create draft event:", err);
      setError(err);
      toast.danger({
        id: "event-create-failed",
        title: t("admin.createFailed") as string,
        message: formatErrorMessage(err, t),
      });
    } finally {
      inflightRef.current = false;
    }
  }, [
    currentOwner,
    isPending,
    title,
    startsAt,
    eventTimezone,
    location,
    locationMode,
    locationSearch,
    prefill,
    clearAll,
    setFieldError,
    setError,
    createForHuman,
    createForOrg,
    router,
    slug,
    toast,
    t,
  ]);

  const clearQuotaMeta = useCallback(() => setQuotaMeta(null), []);

  const modeToggle = (
    <XStack borderWidth={2} borderColor="$borderColorStrong" overflow="hidden">
      {(["address", "place"] as const).map((mode, index) => (
        <XStack key={mode} flex={1}>
          {index > 0 && (
            <XStack width={1} backgroundColor="$borderColorStrong" />
          )}
          <XStack
            tag="button"
            flex={1}
            minHeight={44}
            paddingVertical={8}
            justifyContent="center"
            alignItems="center"
            cursor="pointer"
            borderWidth={0}
            backgroundColor={locationMode === mode ? "$accent" : "$surface"}
            onPress={() => handleLocationModeChange(mode)}
            hoverStyle={{
              backgroundColor:
                locationMode === mode ? "$accent" : "$surfaceMuted",
            }}
            focusVisibleStyle={{
              outlineWidth: 2,
              outlineStyle: "solid",
              outlineColor: "$accent",
              outlineOffset: -2,
            }}
            aria-pressed={locationMode === mode}
            data-testid={`qc-location-mode-${mode}`}
          >
            <Text
              variant="bodySmall"
              weight="bold"
              color={locationMode === mode ? "$colorInverted" : "$color"}
            >
              {String(
                t(mode === "address" ? "admin.ebAddress" : "admin.ebMyPlaces"),
              )}
            </Text>
          </XStack>
        </XStack>
      ))}
    </XStack>
  );

  return (
    <YStack
      width="100%"
      alignItems="center"
      paddingHorizontal={16}
      paddingVertical={40}
      $xs={{ paddingVertical: 16 }}
    >
      <YStack
        width="100%"
        maxWidth={560}
        borderWidth={2}
        borderColor="$borderColorStrong"
        borderRadius={0}
        backgroundColor="$surface"
        padding={32}
        gap={24}
        $xs={{ padding: 16 }}
        data-testid="quick-create-card"
      >
        {/* Card header: "New event" + mono step subtitle (approved mockup).
            The owner line above it is FR-019 (event-calendar-redesign): a
            draft started from a calendar cell must say WHO it is created as,
            because a personal dashboard can open the builder under an org. */}
        <YStack gap={6}>
          {currentOwner && (
            <Text
              variant="kicker"
              tone="accent"
              data-testid="event-builder-owner"
            >
              {creatingAsLabel}
            </Text>
          )}
          <Text variant="h2" weight="bold" tag="h1">
            {String(t("admin.qcHeading"))}
          </Text>
          <Text
            variant="caption"
            tone="muted"
            fontFamily="$mono"
            textTransform="uppercase"
            letterSpacing={1.5}
          >
            {String(t("admin.qcStep"))}
          </Text>
        </YStack>

        {formError && (
          <FormErrorBanner
            message={formError}
            onDismiss={clearAll}
            testId="quick-create-error"
          />
        )}

        <Field>
          <FieldLabel required>{String(t("admin.ebEventTitle"))}</FieldLabel>
          <TextInput
            value={title}
            onChangeText={(v: string) => {
              setTitle(v);
              clearField("title");
            }}
            placeholder={t("admin.ebEventTitlePlaceholder") as string}
            maxLength={140}
            fullWidth
            required
            status={fieldErrors.title ? "error" : undefined}
            testId="quick-create-title"
          />
          {fieldErrors.title && (
            <Text variant="caption" tone="error" aria-live="polite">
              {fieldErrors.title}
            </Text>
          )}
        </Field>

        <Field>
          <FieldLabel required>{String(t("admin.qcStartsAt"))}</FieldLabel>
          <NativeDateTimeInput
            type="datetime-local"
            value={startsAt ?? ""}
            min={toDateTimeLocalValue(new Date())}
            required
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
              setStartsAt(e.target.value || undefined);
              clearField("startsAt");
            }}
            data-testid="quick-create-starts-at"
          />
          {fieldErrors.startsAt && (
            <Text variant="caption" tone="error" aria-live="polite">
              {fieldErrors.startsAt}
            </Text>
          )}
          <EventTimezoneNote
            timezone={eventTimezone}
            adoptedFrom={timezoneAdoptedFrom}
            testId="quick-create-timezone-note"
          />
        </Field>

        <Field>
          <FieldLabel optional>{String(t("admin.qcVenue"))}</FieldLabel>
          {modeToggle}
          {locationMode === "address" ? (
            <YStack>
              <LocationAutocomplete
                value={locationSearch}
                onChange={handleAddressSearchChange}
                onSelect={handleAddressSelect}
                testIdBase="quick-create-venue"
              />
              {location.addressText && !locationSearch && (
                <Text variant="body" tone="muted">
                  {location.addressText}
                </Text>
              )}
              {isMapEnabled && (
                <XStack>
                  <Button
                    variant="ghost"
                    size="$2"
                    onPress={handleUseMyLocation}
                    disabled={isLocating}
                    data-testid="quick-create-use-my-location"
                  >
                    <MapPin size={14} aria-hidden />
                    {isLocating
                      ? String(t("admin.ebLocating"))
                      : String(t("admin.ebUseMyLocation"))}
                  </Button>
                </XStack>
              )}
              {isMapEnabled && geoError && (
                <Text
                  variant="caption"
                  tone="error"
                  aria-live="polite"
                  data-testid="quick-create-use-my-location-error"
                >
                  {String(t("search.locationUnavailable"))}
                </Text>
              )}
            </YStack>
          ) : (
            <PlacePicker
              value={selectedPlace}
              onChange={handleThPlaceSelect}
              orgId={
                currentOwner?.kind === "org" ? currentOwner.orgId : undefined
              }
              adminSlug={slug}
            />
          )}
          {/* The one thing a third party needs to know on this screen: the
              list above is only their own venues, and that is fine. */}
          <Text
            variant="caption"
            tone="muted"
            data-testid="quick-create-venue-hint"
          >
            {String(t("admin.qcVenueHint"))}
          </Text>
          {fieldErrors.venue && (
            <Text
              variant="caption"
              tone="error"
              aria-live="polite"
              data-testid="quick-create-venue-error"
            >
              {fieldErrors.venue}
            </Text>
          )}
        </Field>

        <YStack gap={10}>
          <Button
            variant="primary"
            width="100%"
            onPress={() => {
              void handleSubmit();
            }}
            // While "use my location" is resolving, the form holds coordinates
            // with no address yet — a half venue the save would drop. Wait.
            disabled={isPending || !currentOwner || isLocating}
            data-testid="quick-create-submit"
          >
            {String(t(isPending ? "admin.ebSaving" : "admin.qcCreateDraft"))}
          </Button>
          <Text variant="caption" tone="muted">
            {String(t("admin.qcBuilderNext"))}
          </Text>
        </YStack>
      </YStack>

      <QuotaExceededDialog
        open={quotaMeta !== null}
        onClose={clearQuotaMeta}
        meta={quotaMeta}
      />
    </YStack>
  );
}
