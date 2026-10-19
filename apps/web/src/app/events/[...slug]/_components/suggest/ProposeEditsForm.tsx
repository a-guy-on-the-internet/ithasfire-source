"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { useRouter } from "@bprogress/next/app";
import { XStack, YStack } from "tamagui";
import { CheckCircle2, Upload } from "lucide-react";

import type { inferRouterOutputs } from "@trpc/server";

import type { ProseMirrorDoc } from "@th/schema";
import type { AppRouter } from "@th/trpc";
import {
  Button,
  CharCountTextarea,
  NextLinkAnchor,
  Text,
  TextInput,
  useLocale,
  useNotify,
  useTranslations,
} from "@th/ui";
import { withCategoryDisplayNames } from "@/lib/category-display-name";

import { trpc } from "@/trpc";
import { authClient } from "@/lib/auth/auth-client";
import { getAppErrorCode } from "@/lib/app-error";
import { formatErrorMessage } from "@/lib/format-error-message";
import {
  getInvalidFieldsMeta,
  suggestionReasonMessageKey,
} from "@/lib/suggestion-error";
import LocationAutocomplete, {
  type PlaceDetail,
} from "@/components/maps/LocationAutocomplete";
import {
  Field,
  FieldLabel,
  NativeDateTimeInput,
} from "@/app/admin/[slug]/events/new/_components/_form-bits";
import {
  ProseEditor,
  createEmptyDoc,
} from "@/app/admin/[slug]/events/new/_components/prose-editor";
import { useEventImageUpload } from "@/app/admin/[slug]/events/new/_components/useEventImageUpload";
import {
  EVENT_IMAGE_UPLOAD_ACCEPT,
  EVENT_IMAGE_UPLOAD_TYPES,
} from "@/lib/images/event-image-upload";
import { toDateTimeLocalValue } from "@/app/admin/[slug]/events/new/_components/event-builder-helpers";

import {
  computeProposeDiff,
  extractRichTextDoc,
  type ProposeBaseFields,
  type ProposeErrorKey,
  type ProposeFieldErrors,
  type ProposeGeo,
} from "./propose-edits-helpers";

/**
 * Propose-mode event edit surface (community-managed-event-listings spec
 * FR-006/FR-007): the whitelisted field subset of the event builder, rendered
 * for non-owners — anonymous included — initialized from
 * `eventSuggestions.getBaseForEvent` and submitting ONLY the changed fields
 * as an `eventSuggestions.submit` diff. Nothing here mutates the event; the
 * suggestion waits PENDING for the event's reviewer side.
 *
 * Composition mirrors CommunityListingForm (the approved whitelisted-subset
 * template): _form-bits primitives, Intl timezone select, freeform
 * LocationAutocomplete with geo-clearing on typed input, categories select,
 * age-limit input, ProseEditor body — plus a hero picker over the event's
 * ATTACHED images and (signed-in, COMMUNITY listings only — FR-015) an
 * upload path whose images stay private until the suggestion is approved.
 */

/**
 * Derived from the router output so schema drift becomes a COMPILE error in
 * this form instead of being masked by a cast: `base` satisfies the pure
 * helper module's {@link ProposeBaseFields} structurally (`content` is
 * `unknown` on both sides), enforced at the `computeProposeDiff(base, …)`
 * call site below.
 */
export type SuggestionBaseData =
  inferRouterOutputs<AppRouter>["eventSuggestions"]["getBaseForEvent"];

const ERROR_MESSAGE_KEYS: Record<ProposeErrorKey, string> = {
  titleRequired: "suggestEdit.errTitleRequired",
  startsRequired: "suggestEdit.errStartsRequired",
  endsRequired: "suggestEdit.errEndsRequired",
  endsBeforeStarts: "suggestEdit.errEndsBeforeStarts",
  locationPickRequired: "suggestEdit.errLocationPick",
  countryMissing: "suggestEdit.errCountryMissing",
  ageLimitInvalid: "suggestEdit.errAgeLimit",
};

/**
 * Server `EDIT_SUGGESTION_INVALID_FIELDS` rejections carry a `meta.reason` +
 * optional `meta.fields`. The reason → message mapping and the `meta` reader
 * live in the SHARED `@/lib/suggestion-error` module (also used by the
 * moderator review queue). This form additionally maps each reported field to
 * the input group it should anchor the message under.
 */
type ServerAnchor =
  | "title"
  | "schedule"
  | "location"
  | "category"
  | "age"
  | "note"
  | "body"
  | "hero";

/**
 * Whitelisted server field name → the form input group its rejection message
 * anchors under. Fields the form doesn't render individually collapse onto
 * their material group (schedule/location) so the message lands somewhere the
 * user can act on. Anything unmapped falls back to the form-level banner.
 */
const FIELD_ANCHOR: Record<string, ServerAnchor> = {
  title: "title",
  startsAt: "schedule",
  endsAt: "schedule",
  timezone: "schedule",
  addressText: "location",
  countryCode: "location",
  region: "location",
  locality: "location",
  postalCode: "location",
  lat: "location",
  lng: "location",
  categoryId: "category",
  ageLimit: "age",
  content: "body",
  heroImageId: "hero",
  note: "note",
};

/** EventWaiverSection-style native select — square, token-driven, 44px. */
const selectStyle: React.CSSProperties = {
  width: "100%",
  minHeight: 44,
  padding: "10px 12px",
  fontSize: 14,
  fontFamily: "inherit",
  color: "var(--color)",
  background: "var(--surface)",
  border: "1px solid var(--borderColor)",
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

/**
 * Inline server-rejection message (already-translated string, unlike
 * {@link FieldError} which resolves an i18n key). Rendered under the input
 * group the server attributed the `EDIT_SUGGESTION_INVALID_FIELDS` rejection to.
 */
function ServerFieldError({
  id,
  message,
}: {
  id: string;
  message: string | undefined;
}) {
  if (!message) return null;
  return (
    <Text id={id} variant="caption" tone="error" role="alert">
      {message}
    </Text>
  );
}

export function ProposeEditsForm({ data }: { data: SuggestionBaseData }) {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const { toast } = useNotify();
  // Plain annotation (no cast): compile error here if the router's base
  // shape drifts from the pure helper module's contract.
  const base: ProposeBaseFields = data.base;

  const sessionQuery = authClient.useSession();
  const isSignedIn = Boolean(sessionQuery.data?.user);
  // FR-015: suggestion-borne NEW uploads are COMMUNITY listings only, and
  // require sign-in (images key to an uploader identity + quota).
  const canUpload = isSignedIn && data.stewardship === "COMMUNITY";

  // ── Field state, initialized from the loaded base ────────────────────────
  const [title, setTitle] = useState(base.title);
  const [startsAtLocal, setStartsAtLocal] = useState(() =>
    toDateTimeLocalValue(base.startsAt, base.timezone),
  );
  const [endsAtLocal, setEndsAtLocal] = useState(() =>
    base.endsAt ? toDateTimeLocalValue(base.endsAt, base.timezone) : "",
  );
  const [timezone, setTimezone] = useState(base.timezone);
  const [addressText, setAddressText] = useState(base.addressText ?? "");
  const [geo, setGeo] = useState<ProposeGeo | null>(null);
  const [categoryId, setCategoryId] = useState(base.categoryId ?? "");
  const [ageLimitRaw, setAgeLimitRaw] = useState(
    base.ageLimit != null ? String(base.ageLimit) : "",
  );
  const [bodyDoc, setBodyDoc] = useState<ProseMirrorDoc>(
    () => extractRichTextDoc(base.content) ?? createEmptyDoc(),
  );
  // The ProseEditor (TipTap) normalizes its doc on mount (fills default attrs
  // like `attrs.textAlign: null`, rebuilds the envelope). That mount-normalized
  // doc — not the raw stored `base.content` — is the correct baseline for the
  // body diff: comparing against the raw doc flags `content` changed on every
  // pristine submission.
  //
  // The baseline is captured DETERMINISTICALLY from the editor's onCreate
  // (onReady), which fires exactly once before any edit. The first-onChange
  // path below is only a guard: relying on the first update's ordering would
  // swallow a first-action single-transaction edit (e.g. a paste) whose update
  // could be the very first emission, making that edit its own baseline.
  const normalizedBaseDocRef = useRef<ProseMirrorDoc | null>(null);
  // Bumped when the baseline is captured so the diff memo re-runs (the ref
  // itself is not a reactive dependency).
  const [bodyBaselineReady, setBodyBaselineReady] = useState(false);

  // Inline server-rejection messages placed next to the offending field group
  // when the server attributes the rejection via `meta.fields`
  // (blocked_content → the tripped text field; invalid_body → body/detail;
  // heroImage refs → hero picker; schedule/location groups → their inputs).
  // Reasons that carry no field (empty_diff, defensive whitelist errors) fall
  // back to the form-level `submitError` banner. Declared here (above the body
  // callbacks) so `handleBodyChange` can clear the body anchor on edit.
  const [serverFieldErrors, setServerFieldErrors] = useState<
    Partial<Record<ServerAnchor, string>>
  >({});
  const clearServerError = useCallback((anchor: ServerAnchor) => {
    setServerFieldErrors((prev) => {
      if (!prev[anchor]) return prev;
      const next = { ...prev };
      delete next[anchor];
      return next;
    });
  }, []);

  const handleBodyReady = useCallback((doc: ProseMirrorDoc) => {
    normalizedBaseDocRef.current = doc;
    setBodyBaselineReady(true);
  }, []);
  const handleBodyChange = useCallback((doc: ProseMirrorDoc) => {
    if (normalizedBaseDocRef.current === null) {
      normalizedBaseDocRef.current = doc;
      setBodyBaselineReady(true);
    }
    // Editing the body clears a prior server body-rejection message.
    clearServerError("body");
    setBodyDoc(doc);
  }, [clearServerError]);
  const [heroImageId, setHeroImageId] = useState<string | null>(
    base.heroImageId,
  );
  const [uploadedImages, setUploadedImages] = useState<
    { id: string; publicUrl: string }[]
  >([]);
  const [note, setNote] = useState("");

  const [fieldErrors, setFieldErrors] = useState<ProposeFieldErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const clearError = useCallback((key: keyof ProposeFieldErrors) => {
    setFieldErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  // ── Options ──────────────────────────────────────────────────────────────
  const timezones = useMemo(() => {
    const values = Intl.supportedValuesOf("timeZone");
    return values.includes(timezone) ? values : [timezone, ...values];
  }, [timezone]);

  const categoriesQuery = trpc.categories.list.useQuery(undefined, {
    staleTime: 5 * 60_000,
  });
  const categories = withCategoryDisplayNames(
    categoriesQuery.data?.categories ?? [],
    locale,
  );

  // ── Location handlers (typing invalidates the previous geocode) ─────────
  const handleAddressChange = useCallback(
    (next: string) => {
      setAddressText(next);
      setGeo(null);
      clearError("location");
      clearServerError("location");
    },
    [clearError, clearServerError],
  );

  const handlePlaceSelect = useCallback(
    (place: PlaceDetail) => {
      setGeo({
        countryCode: place.countryCode,
        region: place.region,
        locality: place.city,
        postalCode: place.postalCode,
        lat: place.lat,
        lng: place.lng,
      });
      clearError("location");
      clearServerError("location");
      if (!place.countryCode) {
        setFieldErrors((prev) => ({ ...prev, location: "countryMissing" }));
      }
    },
    [clearError, clearServerError],
  );

  // ── Hero image upload (signed-in + COMMUNITY only, FR-015) ──────────────
  const heroFileInputRef = useRef<HTMLInputElement>(null);
  const { uploadImage, isUploading } = useEventImageUpload({
    eventId: data.eventId,
    // Suggestion uploads stay raster-only (no SVG) even though the shared
    // event pipeline accepts SVG for owner-managed events. This guards the
    // picker's "All Files" escape hatch AND drag/drop into the ProseEditor
    // below (both funnel through this uploadImage).
    allowedTypes: EVENT_IMAGE_UPLOAD_TYPES,
    onError: (error) => {
      toast.danger({
        title: String(t("suggestEdit.uploadFailedToast")),
        message: formatErrorMessage(error, (key) => String(t(key))),
      });
    },
  });

  const handleHeroFileChange = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      // Allow re-selecting the same file after a failed attempt.
      event.target.value = "";
      if (!file) return;
      const attrs = await uploadImage(file);
      if (!attrs?.imageId || !attrs.src) return;
      const uploaded = { id: attrs.imageId, publicUrl: attrs.src };
      setUploadedImages((prev) => [...prev, uploaded]);
      setHeroImageId(uploaded.id);
      clearServerError("hero");
    },
    [uploadImage, clearServerError],
  );

  const heroCandidates = useMemo(
    () => [...data.attachedImages, ...uploadedImages],
    [data.attachedImages, uploadedImages],
  );

  // ── Live diff (drives the submit affordance) ─────────────────────────────
  const diff = useMemo(
    () =>
      computeProposeDiff(
        base,
        {
          title,
          startsAtLocal,
          endsAtLocal,
          timezone,
          addressText,
          geo,
          categoryId,
          ageLimitRaw,
          bodyDoc,
          heroImageId,
        },
        // The mount-normalized baseline (null until the editor's onCreate —
        // pass undefined so the diff falls back to the raw stored doc, which
        // matches the initial `bodyDoc` and yields no phantom content change).
        normalizedBaseDocRef.current ?? undefined,
      ),
    [
      base,
      title,
      startsAtLocal,
      endsAtLocal,
      timezone,
      addressText,
      geo,
      categoryId,
      ageLimitRaw,
      bodyDoc,
      heroImageId,
      // Not read directly, but re-runs the memo once the ref-held baseline is
      // captured (onCreate/onChange guard) so the diff picks it up.
      bodyBaselineReady,
    ],
  );
  const hasChanges = Object.keys(diff.fields).length > 0;
  const hasErrors = Object.keys(diff.errors).length > 0;

  // ── Submit ───────────────────────────────────────────────────────────────
  const submitMut = trpc.eventSuggestions.submit.useMutation({
    retry: false,
    meta: { silent: true },
  });
  const pending = submitMut.isPending;

  const handleSubmit = useCallback(async () => {
    if (pending) return;
    setSubmitError(null);
    setServerFieldErrors({});

    if (hasErrors) {
      setFieldErrors(diff.errors);
      return;
    }
    setFieldErrors({});
    if (!hasChanges) return;

    try {
      const trimmedNote = note.trim();
      await submitMut.mutateAsync({
        eventId: data.eventId,
        fields: diff.fields,
        ...(trimmedNote ? { note: trimmedNote } : {}),
      });
      setSubmitted(true);
    } catch (err) {
      const appCode = getAppErrorCode(err);
      const trpcCode = (err as { data?: { code?: string } }).data?.code;
      if (appCode === "RATE_LIMITED" || trpcCode === "TOO_MANY_REQUESTS") {
        toast.warning({
          title: String(t("suggestEdit.rateLimitedToast")),
          message: String(t("suggestEdit.rateLimitedHint")),
        });
        return;
      }
      if (appCode === "EDIT_SUGGESTION_INVALID_FIELDS") {
        // The server tags WHY the diff was rejected via `data.meta.reason`
        // (blocked_content, invalid_body, ends_before_starts, empty_diff,
        // not_an_event_image, …) and, for most reasons, WHICH field(s) via
        // `meta.fields`. The reason → message table is the SHARED, exhaustive
        // `SUGGESTION_REASON_MESSAGE_KEYS` (compile-checked against the core's
        // reason union) — so a schedule/body/field rejection never reads as if
        // the user wrote something offensive.
        const meta = getInvalidFieldsMeta(err);
        const message = String(t(suggestionReasonMessageKey(meta?.reason)));

        // Anchor the message inline under EVERY reported field's input group
        // (blocked_content now names the tripped field; multi-field rejections
        // like schedule/geo pairs anchor on each). Reasons that carry no field
        // (empty_diff, defensive whitelist errors) fall back to the form-level
        // banner.
        const anchors = new Set<ServerAnchor>();
        for (const field of meta?.fields ?? []) {
          const anchor = FIELD_ANCHOR[field];
          if (anchor) anchors.add(anchor);
        }
        if (anchors.size > 0) {
          const next: Partial<Record<ServerAnchor, string>> = {};
          for (const anchor of anchors) next[anchor] = message;
          setServerFieldErrors(next);
          return;
        }
        setSubmitError(message);
        return;
      }
      setSubmitError(formatErrorMessage(err, (key) => String(t(key))));
    }
  }, [
    pending,
    hasErrors,
    hasChanges,
    diff,
    note,
    submitMut,
    data.eventId,
    toast,
    t,
  ]);

  const eventHref = `/events/${data.slug ?? data.eventId}`;

  // ── Success confirmation ─────────────────────────────────────────────────
  if (submitted) {
    return (
      <YStack
        alignItems="center"
        gap="$3"
        padding="$6"
        borderWidth={2}
        borderColor="$borderColor"
        backgroundColor="$surface"
        role="status"
      >
        <CheckCircle2 size={32} aria-hidden />
        <Text variant="h3" weight="bold" textAlign="center">
          {String(t("suggestEdit.successTitle"))}
        </Text>
        <Text variant="body" tone="muted" textAlign="center" maxWidth={460}>
          {String(t("suggestEdit.successBody"))}
        </Text>
        {!isSignedIn ? (
          <Text
            variant="bodySmall"
            tone="muted"
            textAlign="center"
            maxWidth={460}
          >
            {String(t("suggestEdit.successAnonNote"))}
          </Text>
        ) : null}
        <Button variant="secondary" onPress={() => router.push(eventHref)}>
          {String(t("suggestEdit.backToEvent"))}
        </Button>
      </YStack>
    );
  }

  return (
    <YStack gap="$5">
      {/* ── Title ───────────────────────────────────────────────────── */}
      <Field>
        <FieldLabel>{String(t("suggestEdit.fieldTitle"))}</FieldLabel>
        <TextInput
          value={title}
          onChangeText={(v: string) => {
            setTitle(v);
            clearError("title");
            clearServerError("title");
          }}
          maxLength={140}
          fullWidth
          status={
            fieldErrors.title || serverFieldErrors.title ? "error" : undefined
          }
          aria-describedby={
            fieldErrors.title
              ? "suggest-title-error"
              : serverFieldErrors.title
                ? "suggest-title-server-error"
                : undefined
          }
          testId="suggest-title"
        />
        {fieldErrors.title ? (
          <FieldError
            id="suggest-title-error"
            messageKey={ERROR_MESSAGE_KEYS[fieldErrors.title]}
          />
        ) : null}
        <ServerFieldError
          id="suggest-title-server-error"
          message={serverFieldErrors.title}
        />
      </Field>

      {/* ── Date & time ─────────────────────────────────────────────── */}
      <Field>
        <FieldLabel>{String(t("suggestEdit.fieldDateTime"))}</FieldLabel>
        <XStack gap="$3" flexWrap="wrap">
          <YStack flex={1} minWidth={220} gap={6}>
            <FieldLabel>{String(t("suggestEdit.fieldStarts"))}</FieldLabel>
            <NativeDateTimeInput
              type="datetime-local"
              value={startsAtLocal}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                setStartsAtLocal(e.target.value);
                clearError("startsAt");
                clearError("endsAt");
                clearServerError("schedule");
              }}
              aria-invalid={fieldErrors.startsAt ? true : undefined}
              aria-describedby={
                fieldErrors.startsAt ? "suggest-starts-error" : undefined
              }
              data-testid="suggest-starts-at"
            />
            {fieldErrors.startsAt ? (
              <FieldError
                id="suggest-starts-error"
                messageKey={ERROR_MESSAGE_KEYS[fieldErrors.startsAt]}
              />
            ) : null}
          </YStack>
          <YStack flex={1} minWidth={220} gap={6}>
            <FieldLabel>{String(t("suggestEdit.fieldEnds"))}</FieldLabel>
            <NativeDateTimeInput
              type="datetime-local"
              value={endsAtLocal}
              min={startsAtLocal || undefined}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                setEndsAtLocal(e.target.value);
                clearError("endsAt");
                clearServerError("schedule");
              }}
              aria-invalid={fieldErrors.endsAt ? true : undefined}
              aria-describedby={
                fieldErrors.endsAt ? "suggest-ends-error" : undefined
              }
              data-testid="suggest-ends-at"
            />
            {fieldErrors.endsAt ? (
              <FieldError
                id="suggest-ends-error"
                messageKey={ERROR_MESSAGE_KEYS[fieldErrors.endsAt]}
              />
            ) : null}
          </YStack>
        </XStack>
        <ServerFieldError
          id="suggest-schedule-server-error"
          message={serverFieldErrors.schedule}
        />
      </Field>

      {/* ── Timezone ────────────────────────────────────────────────── */}
      <Field>
        <FieldLabel>{String(t("suggestEdit.fieldTimezone"))}</FieldLabel>
        <select
          value={timezone}
          onChange={(e) => {
            setTimezone(e.target.value);
            clearServerError("schedule");
          }}
          aria-label={String(t("suggestEdit.fieldTimezone"))}
          style={selectStyle}
          data-testid="suggest-timezone"
        >
          {timezones.map((tz) => (
            <option key={tz} value={tz}>
              {tz}
            </option>
          ))}
        </select>
      </Field>

      {/* ── Location ────────────────────────────────────────────────── */}
      <Field>
        <FieldLabel>{String(t("suggestEdit.fieldLocation"))}</FieldLabel>
        {base.addressText === null ? (
          <Text variant="caption" tone="muted">
            {String(t("suggestEdit.locationHiddenNote"))}
          </Text>
        ) : null}
        <LocationAutocomplete
          value={addressText}
          onChange={handleAddressChange}
          onSelect={handlePlaceSelect}
          placeholder={String(t("suggestEdit.locationPlaceholder"))}
          testIdBase="suggest-location"
        />
        {geo && !fieldErrors.location ? (
          <Text variant="caption" tone="muted">
            {String(
              t("suggestEdit.locationSelectedHint", {
                country: geo.countryCode ?? "—",
              }),
            )}
          </Text>
        ) : null}
        {fieldErrors.location ? (
          <FieldError
            id="suggest-location-error"
            messageKey={ERROR_MESSAGE_KEYS[fieldErrors.location]}
          />
        ) : null}
        <ServerFieldError
          id="suggest-location-server-error"
          message={serverFieldErrors.location}
        />
      </Field>

      {/* ── Category ────────────────────────────────────────────────── */}
      <Field>
        <FieldLabel>{String(t("suggestEdit.fieldCategory"))}</FieldLabel>
        <select
          value={categoryId}
          onChange={(e) => {
            setCategoryId(e.target.value);
            clearServerError("category");
          }}
          disabled={categoriesQuery.isLoading}
          aria-label={String(t("suggestEdit.fieldCategory"))}
          style={{
            ...selectStyle,
            cursor: categoriesQuery.isLoading ? "wait" : "pointer",
          }}
          data-testid="suggest-category"
        >
          <option value="">{String(t("suggestEdit.categoryNone"))}</option>
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </select>
        <ServerFieldError
          id="suggest-category-server-error"
          message={serverFieldErrors.category}
        />
      </Field>

      {/* ── Age limit ───────────────────────────────────────────────── */}
      <Field>
        <FieldLabel>{String(t("suggestEdit.fieldAgeLimit"))}</FieldLabel>
        <XStack maxWidth={160}>
          <TextInput
            value={ageLimitRaw}
            onChangeText={(v: string) => {
              setAgeLimitRaw(v);
              clearError("ageLimit");
              clearServerError("age");
            }}
            placeholder={String(t("suggestEdit.ageLimitPlaceholder"))}
            maxLength={2}
            inputMode="numeric"
            fullWidth
            status={
              fieldErrors.ageLimit || serverFieldErrors.age
                ? "error"
                : undefined
            }
            aria-describedby={
              fieldErrors.ageLimit
                ? "suggest-age-error"
                : serverFieldErrors.age
                  ? "suggest-age-server-error"
                  : undefined
            }
            testId="suggest-age-limit"
          />
        </XStack>
        <Text variant="caption" tone="muted">
          {String(t("suggestEdit.ageLimitHint"))}
        </Text>
        {fieldErrors.ageLimit ? (
          <FieldError
            id="suggest-age-error"
            messageKey={ERROR_MESSAGE_KEYS[fieldErrors.ageLimit]}
          />
        ) : null}
        <ServerFieldError
          id="suggest-age-server-error"
          message={serverFieldErrors.age}
        />
      </Field>

      {/* ── Photo (hero picker + optional upload) ───────────────────── */}
      <Field>
        <FieldLabel>{String(t("suggestEdit.fieldPhoto"))}</FieldLabel>
        {heroCandidates.length > 0 ? (
          <XStack
            gap="$2"
            flexWrap="wrap"
            role="group"
            aria-label={String(t("suggestEdit.photoPickerAria"))}
          >
            {heroCandidates.map((image, index) => {
              const selected = heroImageId === image.id;
              return (
                <button
                  key={image.id}
                  type="button"
                  aria-pressed={selected}
                  aria-label={String(
                    t("suggestEdit.photoOptionAria", { number: index + 1 }),
                  )}
                  onClick={() => {
                    // Re-clicking the selected photo undoes the change
                    // (falls back to the event's current hero).
                    setHeroImageId(selected ? base.heroImageId : image.id);
                    clearServerError("hero");
                  }}
                  style={{
                    padding: 0,
                    minWidth: 44,
                    minHeight: 44,
                    border: selected
                      ? "3px solid var(--accent)"
                      : "1px solid var(--borderColor)",
                    borderRadius: 0,
                    background: "var(--surface)",
                    cursor: "pointer",
                    display: "block",
                    lineHeight: 0,
                  }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={image.publicUrl}
                    alt=""
                    loading="lazy"
                    style={{
                      width: 120,
                      height: 80,
                      objectFit: "cover",
                      display: "block",
                    }}
                  />
                </button>
              );
            })}
          </XStack>
        ) : (
          <Text variant="caption" tone="muted">
            {String(t("suggestEdit.noPhotosYet"))}
          </Text>
        )}

        {canUpload ? (
          <YStack gap="$2" alignItems="flex-start">
            <Button
              variant="secondary"
              size="$3"
              onPress={() => heroFileInputRef.current?.click()}
              disabled={isUploading || pending}
            >
              <Upload size={14} aria-hidden />
              {isUploading
                ? String(t("suggestEdit.photoUploading"))
                : String(t("suggestEdit.photoUpload"))}
            </Button>
            <input
              ref={heroFileInputRef}
              type="file"
              accept={EVENT_IMAGE_UPLOAD_ACCEPT}
              onChange={(e) => void handleHeroFileChange(e)}
              style={{ display: "none" }}
              aria-hidden
              tabIndex={-1}
            />
            <Text variant="caption" tone="muted">
              {String(t("suggestEdit.photoUnattachedNote"))}
            </Text>
          </YStack>
        ) : null}

        {!isSignedIn && data.stewardship === "COMMUNITY" ? (
          <Text variant="caption" tone="muted">
            {String(t("suggestEdit.photoSignInNudge"))}{" "}
            <NextLinkAnchor href="/sign-in">
              <Text variant="caption" tone="accent" tag="span">
                {String(t("suggestEdit.signInLink"))}
              </Text>
            </NextLinkAnchor>
          </Text>
        ) : null}
        <ServerFieldError
          id="suggest-hero-error"
          message={serverFieldErrors.hero}
        />
      </Field>

      {/* ── Details (rich text) ─────────────────────────────────────── */}
      <Field>
        <FieldLabel>{String(t("suggestEdit.fieldDetails"))}</FieldLabel>
        <ProseEditor
          initialContent={bodyDoc}
          onReady={handleBodyReady}
          onChange={handleBodyChange}
          placeholder={String(t("suggestEdit.detailsPlaceholder"))}
          minHeight={200}
          disabled={pending}
          {...(canUpload ? { onImageUpload: uploadImage } : {})}
        />
        {canUpload ? (
          <Text variant="caption" tone="muted">
            {String(t("suggestEdit.photoUnattachedNote"))}
          </Text>
        ) : null}
        <ServerFieldError
          id="suggest-body-error"
          message={serverFieldErrors.body}
        />
      </Field>

      {/* ── Note to reviewers ───────────────────────────────────────── */}
      <Field>
        <FieldLabel>{String(t("suggestEdit.fieldNote"))}</FieldLabel>
        <CharCountTextarea
          value={note}
          onChange={(v: string) => {
            setNote(v);
            clearServerError("note");
          }}
          maxLength={1000}
          minHeight={72}
          placeholder={String(t("suggestEdit.notePlaceholder"))}
          disabled={pending}
          testIdBase="suggest-note"
        />
        <ServerFieldError
          id="suggest-note-server-error"
          message={serverFieldErrors.note}
        />
      </Field>

      {/* ── Submit ──────────────────────────────────────────────────── */}
      {submitError ? (
        <Text variant="bodySmall" tone="error" role="alert">
          {submitError}
        </Text>
      ) : null}

      <YStack
        gap="$2"
        borderTopWidth={2}
        borderTopColor="$borderColor"
        paddingTop="$4"
      >
        <XStack gap="$3" justifyContent="flex-end" flexWrap="wrap">
          <Button
            variant="ghost"
            onPress={() => router.push(eventHref)}
            disabled={pending}
          >
            {String(t("suggestEdit.cancel"))}
          </Button>
          <Button
            variant="primary"
            onPress={() => void handleSubmit()}
            disabled={pending || (!hasChanges && !hasErrors)}
            testID="suggest-submit"
          >
            {pending
              ? String(t("suggestEdit.submitPending"))
              : String(t("suggestEdit.submit"))}
          </Button>
        </XStack>
        {!hasChanges && !hasErrors ? (
          <Text variant="caption" tone="muted" textAlign="right">
            {String(t("suggestEdit.noChangesHint"))}
          </Text>
        ) : null}
      </YStack>
    </YStack>
  );
}

ProposeEditsForm.displayName = "ProposeEditsForm";
