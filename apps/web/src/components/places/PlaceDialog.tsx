"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import nextDynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { XStack, YStack } from "tamagui";

import {
  Button,
  Modal,
  Text,
  TextInput,
  useLocale,
  useTranslations,
} from "@th/ui";
import {
  PLACE_UNIT_MAX_LENGTH,
  stripUnitFromFormatted,
} from "@th/core/lib/location/place-unit";

import { trpc } from "@/trpc";
import { getAppErrorCode } from "@/lib/app-error";
import { formatErrorMessage } from "@/lib/format-error-message";
import { getInvalidFieldsMeta } from "@/lib/suggestion-error";
import { traceIgnoredError } from "@/lib/trace-ignored-error";
import { buildEnrollTwoFactorUrl } from "@/components/community/use-second-factor-required-toast";
import LocationAutocomplete from "@/components/maps/LocationAutocomplete";
import type { GeocodingResult } from "@/lib/maps/geocoding";
import {
  ACCENT_TEXT,
  BORDER,
  DANGER_TEXT,
  MUTED,
  MUTED_TEXT,
} from "@/lib/design-tokens";

import type { PlacePickerItem } from "./PlacePicker";
import {
  geocodingResultToAddressValue,
  isRateLimited,
  readExistingPlace,
  readLinkedListingCount,
  readRefusalReason,
  readRetryAt,
  type AddressValue,
  type PlaceRefusalReason,
} from "./place-or-address.helpers";

// maplibre is ~1 MB; the pin preview loads only once a dialog shows a pin.
const LocationMapPreview = nextDynamic(
  () =>
    import("@/components/maps/LocationMapPreview").then((m) => ({
      default: m.LocationMapPreview,
    })),
  { ssr: false },
);

/** Copy keys for each refusal, title + one-sentence body. */
export const REFUSAL_COPY: Record<
  PlaceRefusalReason,
  { title: string; body: string }
> = {
  OWNED: {
    title: "communityCreate.pfRefusedOwnedTitle",
    body: "communityCreate.pfRefusedOwnedBody",
  },
  CLAIM_PENDING: {
    title: "communityCreate.pfRefusedClaimTitle",
    body: "communityCreate.pfRefusedClaimBody",
  },
  OWNED_EVENTS_AT_PLACE: {
    title: "communityCreate.pfRefusedEventsTitle",
    body: "communityCreate.pfRefusedEventsBody",
  },
  NOT_ACTIVE: {
    title: "communityCreate.pfRefusedNotActiveTitle",
    body: "communityCreate.pfRefusedNotActiveBody",
  },
  NOT_COMMUNITY_ARCHIVED: {
    title: "communityCreate.pfRefusedNotActiveTitle",
    body: "communityCreate.pfRefusedNotActiveBody",
  },
  ADDRESS_WITHHELD: {
    title: "communityCreate.pfRefusedWithheldTitle",
    body: "communityCreate.pfRefusedWithheldBody",
  },
};

export type PlaceDialogMode =
  | {
      kind: "create";
      /** Prefilled Name: the typed query, or the business the address named. */
      initialName: string;
      /** Prefilled Address ("Make this a place"). */
      initialAddress: AddressValue | null;
    }
  | {
      kind: "edit";
      place: PlacePickerItem;
      /** From `community.getPlaceEditability`, asked before the dialog opened. */
      canEdit: boolean;
      canArchive: boolean;
      linkedListingCount: number;
      /**
       * "archive" opens straight on the archive confirm (the platform place
       * panel's "Archive place"); "Keep it" then closes instead of showing the
       * form. A place that cannot be edited always opens there.
       */
      startAt?: "form" | "archive";
      /**
       * True: no archive control at all (not a disabled one). The moderator
       * page editor sets it: archiving there would drop unsaved page edits,
       * and archive stays on the place panel and the listing form.
       */
      hideArchive?: boolean;
    };

export type PlaceDialogProps = {
  /** null = closed. */
  mode: PlaceDialogMode | null;
  onClose: () => void;
  /** Created or corrected: select it. */
  onSaved: (place: PlacePickerItem) => void;
  /** PLACE_ALREADY_EXISTS → "Use this place". */
  onUseExisting: (place: PlacePickerItem) => void;
  onArchived: (place: PlacePickerItem) => void;
};

/** A key per attempt; a definitive refusal releases it for a fresh one. */
function newClientKey(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
  );
}

type Step = "form" | "exists" | "confirmArchive";

/** The address shape `community.createPlace` / `updatePlace` take. */
type CommunityPlaceAddressInput = {
  formatted: string;
  line1?: string;
  /** "Unit or room"; null = none. The server folds it into the text. */
  line2?: string | null;
  city?: string;
  region?: string;
  postalCode?: string;
  countryCode: string;
  lat: number;
  lng: number;
};

type Notice =
  | { kind: "secondFactor" }
  | { kind: "rateLimited"; retryAt: Date | null }
  | { kind: "refused"; reason: PlaceRefusalReason }
  | { kind: "liveListings"; count: number }
  | { kind: "archived"; name: string }
  | { kind: "message"; text: string };

const labelStyle: React.CSSProperties = { display: "block" };

/**
 * Add a place nobody owns, or correct / archive one, without leaving the
 * listing form (board option A, owner pick 2026-10-13). One @th/ui Modal over
 * the unsaved form; `community.createPlace` / `updatePlace` / `archivePlace`.
 *
 * The caller has already checked the moderator role, the second factor and
 * (for edit) `getPlaceEditability`; the server re-checks all of it, and every
 * refusal it can send has a line here.
 */
export function PlaceDialog({
  mode,
  onClose,
  onSaved,
  onUseExisting,
  onArchived,
}: PlaceDialogProps) {
  const open = mode !== null;

  // The body mounts per open (it renders only while `mode` is set), so
  // nothing leaks from the last place.
  return (
    <Modal open={open} onClose={onClose}>
      {mode ? (
        <PlaceDialogBody
          mode={mode}
          onClose={onClose}
          onSaved={onSaved}
          onUseExisting={onUseExisting}
          onArchived={onArchived}
        />
      ) : null}
    </Modal>
  );
}

function PlaceDialogBody({
  mode,
  onClose,
  onSaved,
  onUseExisting,
  onArchived,
}: PlaceDialogProps & { mode: PlaceDialogMode }) {
  const t = useTranslations();
  const tr = useCallback(
    (key: string, values?: Record<string, string | number>) =>
      String(t(key, values)),
    [t],
  );
  const pathname = usePathname();
  const utils = trpc.useUtils();
  const ids = useId();
  const nameId = `${ids}-name`;
  const addressId = `${ids}-address`;
  const unitId = `${ids}-unit`;

  const isEdit = mode.kind === "edit";
  const editPlace = mode.kind === "edit" ? mode.place : null;
  // Archive-only: no form behind the confirm, so "Keep it" closes.
  const archiveOnly =
    mode.kind === "edit" && (!mode.canEdit || mode.startAt === "archive");

  const [step, setStep] = useState<Step>(
    archiveOnly ? "confirmArchive" : "form",
  );
  const [name, setName] = useState(
    mode.kind === "create" ? mode.initialName.trim() : (editPlace?.name ?? ""),
  );
  const [nameFromPoi, setNameFromPoi] = useState(false);
  const initialAddress =
    mode.kind === "create" ? mode.initialAddress : null;
  const [address, setAddress] = useState<AddressValue | null>(initialAddress);
  const [addressText, setAddressText] = useState(
    initialAddress?.formatted ?? editPlace?.formattedAddress ?? "",
  );
  const [unit, setUnit] = useState("");
  // Edit: whether the moderator picked a new address. The prefill comes from
  // the public read, which has no street line or postcode, so sending it back
  // unchanged would blank both; an untouched address is left out of the save.
  const [addressPicked, setAddressPicked] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [addressError, setAddressError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [existing, setExisting] = useState<PlacePickerItem | null>(null);
  const [hydrating, setHydrating] = useState(isEdit && !archiveOnly);
  const [hydrateFailed, setHydrateFailed] = useState(false);
  const clientKeyRef = useRef(newClientKey());
  const archiveKeyRef = useRef(newClientKey());
  const keyHeldAfterUnknownRef = useRef(false);

  // Edit: the picker item has no country, street line or postcode, and the
  // write needs the whole address. The public read has them for a place
  // whose address is public, which is the only kind `canEdit` allows.
  useEffect(() => {
    if (!editPlace || !hydrating) return;
    let live = true;
    utils.places.getPlacePublic
      .fetch({ placeId: editPlace.placeId }, { staleTime: 0 })
      .then(({ place }) => {
        if (!live) return;
        // The stored text carries the unit (the server folds it in); Unit
        // shows it on its own and Address without it, so it shows once.
        const storedUnit = place.addressLine2?.trim() ?? "";
        const unitless = stripUnitFromFormatted(
          place.formattedAddress ?? "",
          place.addressLine1,
          storedUnit,
        );
        setAddress({
          formatted: unitless,
          line1: null,
          poiName: null,
          city: place.city,
          region: place.region,
          postalCode: null,
          countryCode: place.countryCode,
          lat: place.lat,
          lng: place.lng,
        });
        setAddressText(unitless);
        setUnit(storedUnit);
        setName(place.name);
      })
      .catch((err) => {
        traceIgnoredError("placeDialog.hydrate")(err);
        if (live) setHydrateFailed(true);
      })
      .finally(() => {
        if (live) setHydrating(false);
      });
    return () => {
      live = false;
    };
    // Once per open: the body remounts for the next one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const createPlace = trpc.community.createPlace.useMutation({
    retry: false,
    meta: { silent: true },
  });
  const updatePlace = trpc.community.updatePlace.useMutation({
    retry: false,
    meta: { silent: true },
  });
  const archivePlace = trpc.community.archivePlace.useMutation({
    retry: false,
    meta: { silent: true },
  });
  const saving = createPlace.isPending || updatePlace.isPending;
  const archiving = archivePlace.isPending;

  /** Every refusal the three writes can send, mapped to its line. */
  const handleError = useCallback(
    (err: unknown, keyRef: React.MutableRefObject<string>) => {
      const code = getAppErrorCode(err);
      // A definitive answer: the server released the key; the next try is
      // a new attempt. An unknown failure keeps it, so a retry of a write
      // that DID land is answered from the idempotency record, not doubled.
      if (code !== null || isRateLimited(err)) {
        keyRef.current = newClientKey();
        keyHeldAfterUnknownRef.current = false;
      } else {
        // Held for a plain retry; a changed Name / Address / Unit is a new
        // attempt and rotates it (the effect on those fields).
        keyHeldAfterUnknownRef.current = true;
      }

      if (code === "SECOND_FACTOR_REQUIRED") {
        setNotice({ kind: "secondFactor" });
        return;
      }
      if (isRateLimited(err)) {
        setNotice({ kind: "rateLimited", retryAt: readRetryAt(err, new Date()) });
        return;
      }
      if (code === "PLACE_ALREADY_EXISTS") {
        const found = readExistingPlace(err);
        if (found) {
          setExisting(found);
          setStep("exists");
          setNotice(null);
          return;
        }
      }
      if (
        code === "INVALID_INPUT" &&
        getInvalidFieldsMeta(err)?.reason === "ADDRESS_INCOMPLETE"
      ) {
        // A name-only edit of a place stored without a country: the fix is
        // a fresh pick, so it is said on the Address field.
        setAddressError(tr("communityCreate.pdErrAddressIncomplete"));
        setNotice(null);
        document.getElementById(addressId)?.focus();
        return;
      }
      if (code === "EDIT_SUGGESTION_INVALID_FIELDS") {
        const meta = getInvalidFieldsMeta(err);
        if (meta?.reason === "blocked_content") {
          setNameError(tr("communityCreate.pdErrBlockedName"));
          setNotice(null);
          return;
        }
      }
      if (code === "PLACE_HAS_OWNER") {
        setNotice({ kind: "refused", reason: readRefusalReason(err) ?? "OWNED" });
        return;
      }
      if (code === "PLACE_ARCHIVED") {
        // Not "staff look after it": it was archived, and can be restored.
        setNotice({ kind: "archived", name: editPlace?.name ?? "" });
        return;
      }
      if (code === "PLACE_NOT_ACTIVE") {
        setNotice({ kind: "refused", reason: "NOT_ACTIVE" });
        return;
      }
      if (code === "IDEMPOTENCY_KEY_CONFLICT") {
        setNotice({
          kind: "message",
          text: tr("communityCreate.pdErrMaybeAdded"),
        });
        return;
      }
      if (code === "PLACE_HAS_LIVE_LISTINGS") {
        setNotice({
          kind: "liveListings",
          count: readLinkedListingCount(err) ?? 1,
        });
        // Back to the form only when there is one to edit; an archive-only
        // dialog (address withheld) stays on its confirm step.
        if (!archiveOnly) setStep("form");
        return;
      }
      if (code === "INSUFFICIENT_ROLE" || code === "STAFF_ONLY") {
        setNotice({
          kind: "message",
          text: tr("communityCreate.errModeratorRequired"),
        });
        return;
      }
      setNotice({
        kind: "message",
        text: formatErrorMessage(err, (key) => tr(key)),
      });
    },
    [tr, editPlace, archiveOnly, addressId],
  );

  // After an unknown failure the key is held so a plain retry is answered
  // from the idempotency record. Changing what is sent makes it a different
  // add, so it gets a fresh key (the server would refuse the old one).
  useEffect(() => {
    if (!keyHeldAfterUnknownRef.current) return;
    keyHeldAfterUnknownRef.current = false;
    clientKeyRef.current = newClientKey();
  }, [name, address, unit]);

  const handleAddressPick = useCallback(
    (result: GeocodingResult) => {
      const next = geocodingResultToAddressValue(result);
      setAddress(next);
      setAddressPicked(true);
      setAddressError(
        next.countryCode ? null : tr("communityCreate.errCountryMissing"),
      );
      // A business picked from the map search names the room — but only an
      // EMPTY Name takes it; what the moderator typed is never overwritten.
      if (next.poiName && name.trim() === "") {
        setName(next.poiName);
        setNameFromPoi(true);
        setNameError(null);
      }
    },
    [name, tr],
  );

  const handleSubmit = useCallback(async () => {
    if (saving) return;
    setNotice(null);
    const trimmedName = name.trim();
    let ok = true;
    if (trimmedName.length < 2) {
      setNameError(tr("communityCreate.pdErrNameRequired"));
      ok = false;
    }
    // Edit with no new pick: a name-only save, so the server keeps every
    // stored address field (`updateCommunityPlace`), and the client checks
    // nothing about the prefill (a place stored without a country gets the
    // server's ADDRESS_INCOMPLETE, said on the Address field). The unit goes
    // as top-level `line2` then, and the server re-folds it into the stored
    // text. Text typed over the prefill (address null) must be picked, though.
    const sendsAddress = !isEdit || addressPicked || address === null;
    if (sendsAddress) {
      if (address?.lat == null || address.lng == null) {
        setAddressError(tr("communityCreate.pdErrAddressRequired"));
        ok = false;
      } else if (!address.countryCode) {
        setAddressError(tr("communityCreate.errCountryMissing"));
        ok = false;
      }
    }
    if (!ok) {
      const target = trimmedName.length < 2 ? nameId : addressId;
      document.getElementById(target)?.focus();
      return;
    }

    // "Unit or room" goes on its own (`Place.addrLine2`); the server folds it
    // into the formatted text. Edit always sends it, so a cleared field
    // clears the stored unit (an absent one would keep it).
    const unitValue = unit.trim() || null;
    let payloadAddress: CommunityPlaceAddressInput | undefined;
    if (sendsAddress && address) {
      payloadAddress = {
        formatted: address.formatted,
        ...(address.line1 ? { line1: address.line1 } : {}),
        ...(isEdit || unitValue ? { line2: unitValue } : {}),
        ...(address.city ? { city: address.city } : {}),
        ...(address.region ? { region: address.region } : {}),
        ...(address.postalCode ? { postalCode: address.postalCode } : {}),
        countryCode: address.countryCode as string,
        lat: address.lat as number,
        lng: address.lng as number,
      };
    }

    try {
      const saved = editPlace
        ? await updatePlace.mutateAsync({
            placeId: editPlace.placeId,
            name: trimmedName,
            ...(payloadAddress
              ? { address: payloadAddress }
              : { line2: unitValue }),
            clientKey: clientKeyRef.current,
          })
        : await createPlace.mutateAsync({
            name: trimmedName,
            address: payloadAddress as CommunityPlaceAddressInput,
            clientKey: clientKeyRef.current,
          });
      onSaved(saved);
    } catch (err) {
      handleError(err, clientKeyRef);
    }
  }, [
    saving,
    name,
    address,
    addressPicked,
    isEdit,
    unit,
    editPlace,
    updatePlace,
    createPlace,
    onSaved,
    handleError,
    nameId,
    addressId,
    tr,
  ]);

  const handleArchive = useCallback(async () => {
    if (!editPlace || archiving) return;
    setNotice(null);
    try {
      await archivePlace.mutateAsync({
        placeId: editPlace.placeId,
        clientKey: archiveKeyRef.current,
      });
      onArchived(editPlace);
    } catch (err) {
      handleError(err, archiveKeyRef);
    }
  }, [editPlace, archiving, archivePlace, onArchived, handleError]);

  const placeName = editPlace?.name ?? name;
  const title =
    step === "exists" && existing
      ? tr("communityCreate.pdExistsTitle", { name: existing.name })
      : step === "confirmArchive"
        ? tr("communityCreate.pdArchiveConfirmTitle", { name: placeName })
        : isEdit
          ? tr("communityCreate.pdEditTitle", { name: placeName })
          : tr("communityCreate.pdAddTitle");
  const subtitle =
    step === "form"
      ? isEdit
        ? tr("communityCreate.pdEditSubtitle")
        : tr("communityCreate.pdAddSubtitle")
      : undefined;

  const archiveBlockedCount =
    notice?.kind === "liveListings"
      ? notice.count
      : mode.kind === "edit" && !mode.canArchive
        ? mode.linkedListingCount
        : 0;
  const canArchive =
    mode.kind === "edit" && mode.canArchive && notice?.kind !== "liveListings";

  return (
    <Modal.Panel width={520} data-testid="place-dialog">
      <Modal.Header title={title} subtitle={subtitle} onClose={onClose} />
      <Modal.Body>
        {step === "exists" && existing ? (
          <YStack gap="$3" data-testid="place-dialog-exists">
            <YStack
              gap={2}
              padding="$3"
              borderWidth={2}
              borderColor="$borderColor"
            >
              <Text variant="body" weight="bold">
                {existing.name}
              </Text>
              {existing.formattedAddress ? (
                <Text variant="caption" tone="muted">
                  {existing.formattedAddress}
                </Text>
              ) : null}
            </YStack>
            <Text variant="bodySmall" tone="muted">
              {tr("communityCreate.pdExistsBody")}
            </Text>
          </YStack>
        ) : step === "confirmArchive" ? (
          <YStack gap="$3" data-testid="place-dialog-archive-confirm">
            <Text variant="bodySmall">
              {tr("communityCreate.pdArchiveConfirmBody")}
            </Text>
          </YStack>
        ) : hydrating ? (
          <Text variant="bodySmall" tone="muted" role="status">
            {tr("communityCreate.pfLoadingPlace")}
          </Text>
        ) : hydrateFailed ? (
          <Text variant="bodySmall" tone="error" role="alert">
            {tr("communityCreate.pfPlaceLoadFailed")}
          </Text>
        ) : (
          <YStack gap="$4">
            {/* ── Name ─────────────────────────────────────────────── */}
            <YStack gap={6}>
              <label htmlFor={nameId} style={labelStyle}>
                <Text variant="overline">{tr("communityCreate.pdName")}</Text>
              </label>
              <TextInput
                id={nameId}
                value={name}
                onChangeText={(v: string) => {
                  setName(v);
                  setNameFromPoi(false);
                  setNameError(null);
                }}
                maxLength={140}
                fullWidth
                required
                status={nameError ? "error" : undefined}
                aria-describedby={nameError ? `${nameId}-error` : undefined}
                testId="place-dialog-name"
              />
              {nameError ? (
                <Text
                  id={`${nameId}-error`}
                  variant="caption"
                  tone="error"
                  role="alert"
                >
                  {nameError}
                </Text>
              ) : nameFromPoi ? (
                <Text variant="caption" tone="muted">
                  {tr("communityCreate.pdNameFromPoi")}
                </Text>
              ) : null}
            </YStack>

            {/* ── Address ──────────────────────────────────────────── */}
            <YStack gap={6}>
              <label htmlFor={addressId} style={labelStyle}>
                <Text variant="overline">
                  {tr("communityCreate.pdAddress")}
                </Text>
              </label>
              <LocationAutocomplete
                inputId={addressId}
                value={addressText}
                onChange={(next) => {
                  setAddressText(next);
                  // Typing un-picks: the pin and the text never drift apart.
                  setAddress(null);
                  setAddressError(null);
                }}
                onSelect={() => undefined}
                onSelectResult={handleAddressPick}
                placeholder={tr("communityCreate.pdAddressPlaceholder")}
                required
                invalid={Boolean(addressError)}
                describedBy={addressError ? `${addressId}-error` : undefined}
                testIdBase="place-dialog-address"
              />
              {addressError ? (
                <Text
                  id={`${addressId}-error`}
                  variant="caption"
                  tone="error"
                  role="alert"
                >
                  {addressError}
                </Text>
              ) : null}
            </YStack>

            {/* ── Unit or room (optional, Place.addrLine2) ─────────── */}
            <YStack gap={6}>
              <label htmlFor={unitId} style={labelStyle}>
                <Text variant="overline">
                  {tr("communityCreate.pdUnit")}{" "}
                  <Text
                    tag="span"
                    variant="caption"
                    tone="muted"
                    textTransform="none"
                    letterSpacing={0}
                  >
                    ({tr("common.optional")})
                  </Text>
                </Text>
              </label>
              <TextInput
                id={unitId}
                value={unit}
                onChangeText={setUnit}
                maxLength={PLACE_UNIT_MAX_LENGTH}
                fullWidth
                placeholder={tr("communityCreate.pdUnitPlaceholder")}
                testId="place-dialog-unit"
              />
            </YStack>

            {/* ── Pin preview ──────────────────────────────────────── */}
            {address?.lat != null && address.lng != null ? (
              <YStack gap={6}>
                <Text variant="overline" aria-hidden>
                  {tr("communityCreate.pdPin")}
                </Text>
                <div style={{ height: 160, border: `1px solid ${BORDER}` }}>
                  <LocationMapPreview
                    latitude={address.lat}
                    longitude={address.lng}
                    label={name || address.formatted}
                    isExact
                    height={160}
                  />
                </div>
                <Text variant="caption" tone="muted">
                  {tr("communityCreate.pdPinHint")}
                </Text>
              </YStack>
            ) : null}

            {!isEdit ? (
              <Text variant="caption" tone="muted">
                {tr("communityCreate.pdDirectoryNote")}
              </Text>
            ) : null}
          </YStack>
        )}

        {notice ? <DialogNotice notice={notice} pathname={pathname} /> : null}
      </Modal.Body>

      <Modal.Footer justifyContent="space-between">
        {step === "exists" && existing ? (
          <XStack gap="$3" flexWrap="wrap" justifyContent="flex-end" flex={1}>
            <Button
              variant="ghost"
              onPress={() => {
                setStep("form");
                setExisting(null);
              }}
            >
              {tr("communityCreate.pdKeepEditing")}
            </Button>
            <Button
              variant="primary"
              onPress={() => onUseExisting(existing)}
              testID="place-dialog-use-existing"
            >
              {tr("communityCreate.pdUseThis")}
            </Button>
          </XStack>
        ) : step === "confirmArchive" ? (
          <XStack gap="$3" flexWrap="wrap" justifyContent="flex-end" flex={1}>
            <Button
              variant="ghost"
              onPress={() => (archiveOnly ? onClose() : setStep("form"))}
              disabled={archiving}
            >
              {tr("communityCreate.pdKeepIt")}
            </Button>
            <Button
              variant="destructive"
              onPress={() => void handleArchive()}
              disabled={archiving || !canArchive}
              testID="place-dialog-archive-confirm-btn"
            >
              {archiving
                ? tr("communityCreate.pdArchiving")
                : tr("communityCreate.pdArchiveConfirm")}
            </Button>
          </XStack>
        ) : (
          <>
            {isEdit && !(mode.kind === "edit" && mode.hideArchive) ? (
              <YStack gap={4} flexShrink={1} minWidth={0}>
                <Button
                  variant="ghost"
                  onPress={() => {
                    setNotice(null);
                    setStep("confirmArchive");
                  }}
                  disabled={!canArchive || saving}
                  testID="place-dialog-archive"
                >
                  <span style={{ color: canArchive ? DANGER_TEXT : undefined }}>
                    {tr("communityCreate.pdArchive")}
                  </span>
                </Button>
                {archiveBlockedCount > 0 ? (
                  <Text
                    variant="caption"
                    tone="muted"
                    data-testid="place-dialog-archive-blocked"
                  >
                    {tr("communityCreate.pdArchiveBlocked", {
                      count: archiveBlockedCount,
                    })}
                  </Text>
                ) : null}
              </YStack>
            ) : (
              <span />
            )}
            <XStack gap="$3" flexWrap="wrap" justifyContent="flex-end">
              <Button variant="ghost" onPress={onClose} disabled={saving}>
                {tr("communityCreate.pdCancel")}
              </Button>
              <Button
                variant="primary"
                onPress={() => void handleSubmit()}
                disabled={saving || hydrating || hydrateFailed}
                testID="place-dialog-submit"
              >
                {saving
                  ? isEdit
                    ? tr("communityCreate.pdSaving")
                    : tr("communityCreate.pdAdding")
                  : isEdit
                    ? tr("communityCreate.pdSave")
                    : tr("communityCreate.pdAdd")}
              </Button>
            </XStack>
          </>
        )}
      </Modal.Footer>
    </Modal.Panel>
  );
}

/** One refusal, said once, in the body above the footer. */
function DialogNotice({
  notice,
  pathname,
}: {
  notice: Notice;
  pathname: string | null;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const tr = (key: string, values?: Record<string, string | number>) =>
    String(t(key, values));

  let title: string | null = null;
  let body: React.ReactNode = null;
  if (notice.kind === "secondFactor") {
    return <SecondFactorNotice pathname={pathname} />;
  }
  if (notice.kind === "rateLimited") {
    title = tr("communityCreate.pdRateLimitedTitle");
    body = notice.retryAt
      ? tr("communityCreate.pdRateLimitedBody", {
          time: new Intl.DateTimeFormat(locale, {
            hour: "numeric",
            minute: "2-digit",
          }).format(notice.retryAt),
        })
      : tr("communityCreate.pdRateLimitedBodyNoTime");
  } else if (notice.kind === "refused") {
    title = tr(REFUSAL_COPY[notice.reason].title);
    body = tr(REFUSAL_COPY[notice.reason].body);
  } else if (notice.kind === "liveListings") {
    title = tr("communityCreate.pdArchiveBlocked", { count: notice.count });
  } else if (notice.kind === "archived") {
    title = tr("communityCreate.pfArchivedTitle", { name: notice.name });
    body = tr("communityCreate.pfIsArchivedBody");
  } else {
    body = notice.text;
  }

  return (
    <div
      role="alert"
      data-testid="place-dialog-notice"
      style={{
        background: MUTED,
        borderLeft: `3px solid ${DANGER_TEXT}`,
        padding: "10px 12px",
        display: "flex",
        flexDirection: "column",
        gap: 2,
      }}
    >
      {title ? (
        <Text variant="bodySmall" weight="bold">
          {title}
        </Text>
      ) : null}
      {body ? (
        <Text variant="caption" style={{ color: MUTED_TEXT }}>
          {body}
        </Text>
      ) : null}
    </div>
  );
}

/**
 * The step-up gate, said where the moderator is. The setup link opens in a
 * NEW TAB: the toast's "Set up now" navigates away and drops the unsaved
 * listing (board question 5).
 */
export function SecondFactorNotice({ pathname }: { pathname: string | null }) {
  const t = useTranslations();
  return (
    <div
      role="alert"
      data-testid="place-second-factor-notice"
      style={{
        background: MUTED,
        borderLeft: `3px solid ${ACCENT_TEXT}`,
        padding: "10px 12px",
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      <Text variant="bodySmall" weight="bold">
        {String(t("communityCreate.pfSecondFactorTitle"))}
      </Text>
      <Text variant="caption" style={{ color: MUTED_TEXT }}>
        {String(t("communityCreate.pfSecondFactorBody"))}
      </Text>
      <a
        href={buildEnrollTwoFactorUrl(pathname)}
        target="_blank"
        rel="noopener noreferrer"
        data-testid="place-second-factor-link"
        style={{
          color: ACCENT_TEXT,
          fontSize: 13,
          fontWeight: 600,
          minHeight: 44,
          display: "inline-flex",
          alignItems: "center",
          alignSelf: "flex-start",
        }}
      >
        {String(t("communityCreate.pfSecondFactorLink"))}
      </a>
    </div>
  );
}
