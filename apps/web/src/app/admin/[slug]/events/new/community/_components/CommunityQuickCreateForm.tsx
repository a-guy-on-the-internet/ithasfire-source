"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { useRouter } from "@bprogress/next/app";
import { XStack, YStack } from "tamagui";
import { Users } from "lucide-react";

import { Button, Text, TextInput, useTranslations } from "@th/ui";

import { trpc } from "@/trpc";
import { getAppErrorCode } from "@/lib/app-error";
import { formatErrorMessage } from "@/lib/format-error-message";
import { buildRecurrenceSchedule } from "@/lib/recurrence/build-recurrence-schedule";
import { useSecondFactorRequiredToast } from "@/components/community/use-second-factor-required-toast";
import { communityPlaceRefusalMessageKey } from "../../_components/community-builder.helpers";
import {
  PlaceOrAddressField,
  type AddressValue,
  type PlaceOrAddressValue,
} from "@/components/places/PlaceOrAddressField";
import type { PlacePickerItem } from "@/components/places/PlacePicker";

import {
  RecurrenceFields,
  emptyRecurrence,
  type RecurrenceUiState,
} from "./RecurrenceFields";
import {
  Field,
  FieldLabel,
  NativeDateTimeInput,
} from "../../_components/_form-bits";
import {
  validateCommunityListingForm,
  type CommunityListingErrorKey,
  type CommunityListingFieldErrors,
  type CommunityListingGeo,
} from "./community-listing-form-validation";

/**
 * Quick-create for an ownerless COMMUNITY listing — the community counterpart
 * of `QuickCreateEventForm`.
 *
 * ## What changed and why
 *
 * This route used to host the WHOLE authoring experience: a 700-line
 * standalone form with its own category picker, age limit, banner upload and
 * prose editor, which then published the listing in one shot. It had no
 * preview, no editor to return to, no lineup, and — because it mounted
 * `ProseEditor` with no `onImageUpload` / `onAudioUpload` — literally could not
 * put an image in the body: `ProseEditor` gates both toolbar buttons on those
 * handlers existing.
 *
 * The real `EventBuilder` has all of that, and the backend now supports being
 * driven by it (`createListing` takes `status: "DRAFT"`,
 * `community.updateListing` saves a field diff, `community.publishListing`
 * takes it live). So this page shrinks to the one job that has to happen
 * before the builder can exist: minting the row. Everything else moved.
 *
 * ## What stays here, and why it is not smaller
 *
 * `createCommunityListing` REQUIRES `title`, `startsAt`, `endsAt`, `timezone`,
 * `addressText`, `countryCode`, `lat` and `lng` — an ownerless listing has no
 * Place and no saved-location fallback, and slug generation needs the country.
 * Those are the fields on screen; trimming further would just move a server
 * rejection in front of the user.
 *
 * Recurrence stays too, and that is a deliberate exception to "minimal":
 * community listings repeat through `recurrenceSchedule` + `EventDate` rows,
 * which is a DIFFERENT mechanism from the builder's `EventSeries` RRULE editor,
 * and `getEventForEdit` carries no `recurrenceSchedule` to hydrate the builder
 * from. Create is therefore the only place the cadence can currently be set,
 * and dropping it from here would delete a shipped feature rather than move it.
 */

const ERROR_MESSAGE_KEYS: Record<CommunityListingErrorKey, string> = {
  titleRequired: "communityCreate.errTitleRequired",
  startsRequired: "communityCreate.errStartsRequired",
  endsRequired: "communityCreate.errEndsRequired",
  startsIncomplete: "communityCreate.errStartsIncomplete",
  endsIncomplete: "communityCreate.errEndsIncomplete",
  endsBeforeStarts: "communityCreate.errEndsBeforeStarts",
  locationRequired: "communityCreate.errLocationRequired",
  countryMissing: "communityCreate.errCountryMissing",
  ageLimitInvalid: "communityCreate.errAgeLimit",
};

/** Native select — square, token-driven, 44px tap target. */
const SELECT_STYLE: React.CSSProperties = {
  width: "100%",
  minHeight: 44,
  padding: "10px 12px",
  fontSize: 14,
  fontFamily: "inherit",
  color: "var(--color, #211C16)",
  background: "var(--surface, #FDFAF3)",
  border: "1px solid var(--borderColor, #211C16)",
  borderRadius: 0,
  cursor: "pointer",
};

function FieldError({ id, messageKey }: { id: string; messageKey: string }) {
  const t = useTranslations();
  return (
    <Text id={id} variant="caption" tone="error" role="alert">
      {String(t(messageKey))}
    </Text>
  );
}

export function CommunityQuickCreateForm({ slug }: { slug: string }) {
  const t = useTranslations();
  const router = useRouter();
  const handleSecondFactorRequired = useSecondFactorRequiredToast();

  const [title, setTitle] = useState("");
  const [startsAtLocal, setStartsAtLocal] = useState("");
  const [endsAtLocal, setEndsAtLocal] = useState("");
  const [timezone, setTimezone] = useState<string>(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Chicago",
  );
  // One box (board option A): a place on Ithas Fire, or a bare address.
  const [location, setLocation] = useState<PlaceOrAddressValue>(null);
  /** The zone came from the picked place; said under the field. */
  const [timezoneFromPlace, setTimezoneFromPlace] = useState(false);
  const [recurrence, setRecurrence] =
    useState<RecurrenceUiState>(emptyRecurrence);

  const [fieldErrors, setFieldErrors] = useState<CommunityListingFieldErrors>(
    {},
  );
  const [submitError, setSubmitError] = useState<string | null>(null);
  /** The server would not link the picked place (address withheld, no pin). */
  const [placeRefusalKey, setPlaceRefusalKey] = useState<string | null>(null);
  const [recurrenceError, setRecurrenceError] = useState<string | null>(null);

  const clearError = useCallback((key: keyof CommunityListingFieldErrors) => {
    setFieldErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  const handleRecurrenceChange = useCallback((next: RecurrenceUiState) => {
    setRecurrence(next);
    setRecurrenceError((prev) => (prev ? null : prev));
  }, []);

  const timezones = useMemo(() => {
    const values = Intl.supportedValuesOf("timeZone");
    return values.includes(timezone) ? values : [timezone, ...values];
  }, [timezone]);

  const handlePickPlace = useCallback(
    (place: PlacePickerItem) => {
      setLocation({ kind: "place", place });
      setPlaceRefusalKey(null);
      clearError("location");
      // A listing happens where its place is: take the place's zone, as the
      // editor's picker does. Null = unknown; leave the zone alone.
      if (place.timezone) {
        setTimezone(place.timezone);
        setTimezoneFromPlace(true);
      } else {
        setTimezoneFromPlace(false);
      }
    },
    [clearError],
  );

  const handlePickAddress = useCallback(
    (address: AddressValue) => {
      setLocation({ kind: "address", address });
      setPlaceRefusalKey(null);
      setTimezoneFromPlace(false);
      clearError("location");
      if (!address.countryCode) {
        // Surface the contract requirement immediately, not at submit.
        setFieldErrors((prev) => ({ ...prev, location: "countryMissing" }));
      }
    },
    [clearError],
  );

  const handleClearLocation = useCallback(() => {
    setLocation(null);
    setPlaceRefusalKey(null);
    setTimezoneFromPlace(false);
    clearError("location");
  }, [clearError]);

  const address = location?.kind === "address" ? location.address : null;
  const linkedPlaceId =
    location?.kind === "place" ? location.place.placeId : null;
  const geo = useMemo<CommunityListingGeo | null>(
    () =>
      address
        ? {
            countryCode: address.countryCode,
            region: address.region,
            locality: address.city,
            postalCode: address.postalCode,
            lat: address.lat,
            lng: address.lng,
          }
        : null,
    [address],
  );

  const createListing = trpc.community.createListing.useMutation({
    retry: false,
    meta: { silent: true },
  });
  const pending = createListing.isPending;

  const startsRef = useRef<HTMLInputElement>(null);
  const endsRef = useRef<HTMLInputElement>(null);

  const handleSubmit = useCallback(async () => {
    if (pending) return;
    setSubmitError(null);

    const result = validateCommunityListingForm({
      title,
      startsAtLocal,
      endsAtLocal,
      // A half-typed native value reads "" but flags badInput.
      startsIncomplete: startsRef.current?.validity?.badInput ?? false,
      endsIncomplete: endsRef.current?.validity?.badInput ?? false,
      timezone,
      addressText: address?.formatted ?? "",
      geo,
      // A picked place supplies the address and pin; the listing links to it.
      placeId: linkedPlaceId,
      // Both moved into the builder — the validator treats an empty string as
      // "not provided" and emits no key for either.
      categoryId: "",
      ageLimitRaw: "",
    });

    if (!result.ok) {
      setFieldErrors(result.errors);
      return;
    }
    setFieldErrors({});

    let recurrenceSchedule: ReturnType<typeof buildRecurrenceSchedule> = null;
    if (recurrence.freq !== "NONE") {
      if (recurrence.freq === "WEEKLY" && recurrence.byWeekday.length === 0) {
        setRecurrenceError(
          String(t("communityCreate.errRepeatWeekdayRequired")),
        );
        return;
      }
      if (!recurrence.untilLocal) {
        setRecurrenceError(String(t("communityCreate.errRepeatUntilRequired")));
        return;
      }
      const startDay = startsAtLocal.slice(0, 10);
      if (startDay && recurrence.untilLocal < startDay) {
        setRecurrenceError(
          String(t("communityCreate.errRepeatUntilBeforeStart")),
        );
        return;
      }
      recurrenceSchedule = buildRecurrenceSchedule({
        freq: recurrence.freq,
        interval: recurrence.interval,
        byWeekday: recurrence.byWeekday,
        monthlyMode: recurrence.monthlyMode,
        untilLocal: recurrence.untilLocal,
        startsAtLocal,
        timezone,
      });
    }
    setRecurrenceError(null);

    try {
      const res = await createListing.mutateAsync({
        ...result.payload,
        // The whole point of this page: mint the row INVISIBLE so the builder
        // has an eventId to hang body images and the hero off, and let
        // `community.publishListing` be what takes it live.
        status: "DRAFT",
        ...(recurrenceSchedule ? { recurrenceSchedule } : {}),
      });
      router.push(`/admin/${slug}/events/${res.event.id}/edit`);
    } catch (err) {
      if (handleSecondFactorRequired(err)) return;
      // A place the server won't link says why, on the Location field.
      const refusalKey = communityPlaceRefusalMessageKey(err);
      if (refusalKey) {
        setPlaceRefusalKey(refusalKey);
        return;
      }
      const code = getAppErrorCode(err);
      if (code === "INSUFFICIENT_ROLE" || code === "STAFF_ONLY") {
        setSubmitError(String(t("communityCreate.errModeratorRequired")));
        return;
      }
      if (code === "EDIT_SUGGESTION_INVALID_FIELDS") {
        setSubmitError(String(t("communityCreate.errBlockedContent")));
        return;
      }
      if (code === "RECURRENCE_HAS_NO_UPCOMING_DATES") {
        setRecurrenceError(String(t("communityCreate.errRepeatNoDates")));
        return;
      }
      setSubmitError(formatErrorMessage(err, (key) => String(t(key))));
    }
  }, [
    pending,
    createListing,
    title,
    startsAtLocal,
    endsAtLocal,
    timezone,
    address,
    geo,
    linkedPlaceId,
    recurrence,
    handleSecondFactorRequired,
    router,
    slug,
    t,
  ]);

  const handleCancel = useCallback(() => {
    router.push(`/admin/${slug}/events`);
  }, [router, slug]);

  return (
    <YStack
      width="100%"
      maxWidth={760}
      alignSelf="center"
      paddingHorizontal="$4"
      paddingVertical="$5"
      gap="$5"
    >
      {/* ── Header band ─────────────────────────────────────────────── */}
      <YStack
        gap="$2"
        borderBottomWidth={2}
        borderBottomColor="$borderColor"
        paddingBottom="$4"
      >
        <XStack gap="$2" alignItems="center">
          <Users size={18} aria-hidden />
          <Text
            variant="h3"
            weight="bold"
            textTransform="uppercase"
            letterSpacing={1}
            tag="h1"
          >
            {String(t("communityCreate.pageTitle"))}
          </Text>
        </XStack>
        <Text variant="bodySmall" tone="muted">
          {String(t("communityCreate.quickCreateSubtitle"))}
        </Text>
      </YStack>

      {/* ── Title ───────────────────────────────────────────────────── */}
      <Field>
        <FieldLabel required>
          {String(t("communityCreate.fieldTitle"))}
        </FieldLabel>
        <TextInput
          value={title}
          onChangeText={(v: string) => {
            setTitle(v);
            clearError("title");
          }}
          placeholder={String(t("communityCreate.titlePlaceholder"))}
          maxLength={140}
          fullWidth
          required
          status={fieldErrors.title ? "error" : undefined}
          aria-describedby={
            fieldErrors.title ? "community-title-error" : undefined
          }
          testId="community-title"
        />
        {fieldErrors.title ? (
          <FieldError
            id="community-title-error"
            messageKey={ERROR_MESSAGE_KEYS[fieldErrors.title]}
          />
        ) : null}
      </Field>

      {/* ── Date & time ─────────────────────────────────────────────── */}
      <Field>
        <FieldLabel required>
          {String(t("communityCreate.fieldDateTime"))}
        </FieldLabel>
        <XStack gap="$3" flexWrap="wrap">
          <YStack flex={1} minWidth={220} gap={6}>
            <FieldLabel>{String(t("communityCreate.fieldStarts"))}</FieldLabel>
            <NativeDateTimeInput
              ref={startsRef}
              type="datetime-local"
              value={startsAtLocal}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                setStartsAtLocal(e.target.value);
                clearError("startsAt");
                clearError("endsAt");
              }}
              aria-invalid={fieldErrors.startsAt ? true : undefined}
              aria-describedby={
                fieldErrors.startsAt ? "community-starts-error" : undefined
              }
              required
              data-testid="community-starts-at"
            />
            {fieldErrors.startsAt ? (
              <FieldError
                id="community-starts-error"
                messageKey={ERROR_MESSAGE_KEYS[fieldErrors.startsAt]}
              />
            ) : null}
          </YStack>
          <YStack flex={1} minWidth={220} gap={6}>
            {/* Not marked optional: `createCommunityListing` requires an end
                instant (`endsAt > startsAt` is a top-level refinement). */}
            <FieldLabel>{String(t("communityCreate.fieldEnds"))}</FieldLabel>
            <NativeDateTimeInput
              ref={endsRef}
              type="datetime-local"
              value={endsAtLocal}
              min={startsAtLocal || undefined}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                setEndsAtLocal(e.target.value);
                clearError("endsAt");
              }}
              aria-invalid={fieldErrors.endsAt ? true : undefined}
              aria-describedby={
                fieldErrors.endsAt ? "community-ends-error" : undefined
              }
              required
              data-testid="community-ends-at"
            />
            {fieldErrors.endsAt ? (
              <FieldError
                id="community-ends-error"
                messageKey={ERROR_MESSAGE_KEYS[fieldErrors.endsAt]}
              />
            ) : null}
          </YStack>
        </XStack>
      </Field>

      {/* ── Timezone ────────────────────────────────────────────────── */}
      <Field>
        <FieldLabel required>
          {String(t("communityCreate.fieldTimezone"))}
        </FieldLabel>
        <select
          value={timezone}
          onChange={(e) => {
            setTimezone(e.target.value);
            setTimezoneFromPlace(false);
          }}
          required
          aria-label={String(t("communityCreate.fieldTimezone"))}
          style={SELECT_STYLE}
          data-testid="community-timezone"
        >
          {timezones.map((tz) => (
            <option key={tz} value={tz}>
              {tz}
            </option>
          ))}
        </select>
      </Field>

      {/* ── Repeats (optional recurrence) ───────────────────────────── */}
      <RecurrenceFields
        value={recurrence}
        onChange={handleRecurrenceChange}
        startsAtLocal={startsAtLocal}
        timezone={timezone}
        error={recurrenceError}
        disabled={pending}
      />

      {/* ── Location: our places first, then addresses (one box) ────── */}
      <Field>
        <FieldLabel required id="community-location-label">
          {String(t("communityCreate.fieldLocation"))}
        </FieldLabel>
        <PlaceOrAddressField
          inputId="community-location-input"
          labelledBy="community-location-label"
          value={location}
          onPickPlace={handlePickPlace}
          onPickAddress={handlePickAddress}
          onClear={handleClearLocation}
          required
          invalid={Boolean(fieldErrors.location || placeRefusalKey)}
          describedBy={
            fieldErrors.location || placeRefusalKey
              ? "community-location-error"
              : undefined
          }
          testIdBase="community-location"
          selectedNote={
            location?.kind === "place" && timezoneFromPlace ? (
              <Text variant="caption" tone="muted">
                {String(
                  t("communityCreate.pfTimezoneFromPlace", { timezone }),
                )}
              </Text>
            ) : null
          }
        />
        {fieldErrors.location ? (
          <FieldError
            id="community-location-error"
            messageKey={ERROR_MESSAGE_KEYS[fieldErrors.location]}
          />
        ) : placeRefusalKey ? (
          <FieldError
            id="community-location-error"
            messageKey={placeRefusalKey}
          />
        ) : null}
      </Field>

      {/* ── Submit ──────────────────────────────────────────────────── */}
      {submitError ? (
        <Text variant="bodySmall" tone="error" role="alert">
          {submitError}
        </Text>
      ) : null}

      <XStack
        gap="$3"
        justifyContent="flex-end"
        borderTopWidth={2}
        borderTopColor="$borderColor"
        paddingTop="$4"
        flexWrap="wrap"
      >
        <Button variant="ghost" onPress={handleCancel} disabled={pending}>
          {String(t("communityCreate.cancel"))}
        </Button>
        <Button
          variant="primary"
          onPress={() => void handleSubmit()}
          disabled={pending}
          testID="community-continue"
        >
          {pending
            ? String(t("communityCreate.quickCreatePending"))
            : String(t("communityCreate.quickCreateSubmit"))}
        </Button>
      </XStack>
    </YStack>
  );
}

CommunityQuickCreateForm.displayName = "CommunityQuickCreateForm";
