"use client";

import { useCallback, useEffect, useState } from "react";
import { XStack, YStack } from "tamagui";
import { Button, Modal, Text, TextInput, useTranslations } from "@th/ui";

import {
  PlaceLocationPrivacyFields,
  newPlacePrivacyValue,
  type PlaceLocationPrivacyValue,
} from "@/components/places/PlaceLocationPrivacyFields";

/**
 * The "New place" quick action's minimum-information step.
 *
 * WHY THIS EXISTS. The quick action used to create a place with ZERO input —
 * `name: "New Place"` and a hard-coded `address: { formatted: "TBD",
 * line1: "TBD" }` — then bounce the organiser into the editor. Every place
 * born from this table therefore carried a forged street address that
 * persisted to `Place.addrLine1`, fed `Place.address` / `addressHash`, and
 * rendered publicly as the venue's address.
 *
 * `line1` is optional now (`upsertPlace`'s `addressSchema`), so the street can
 * honestly be absent. `formatted` is NOT: it is `min(1)` on the server and
 * `Place.address` is NOT NULL. Something real has to go in it — and the only
 * non-sentinel source of "something real" is the person creating the place.
 * Swapping `"TBD"` for `"Unknown"`/`"US"` would be the same bug with different
 * spelling, so this dialog collects the smallest honest address instead:
 * city + country. Both are already required for verification eligibility
 * (`getPlaceVerificationEligibility`), and the name replaces the `"New Place"`
 * placeholder that same helper rejects — so a place created here starts one
 * street address away from being submittable rather than three placeholders
 * away.
 *
 * ADDRESS PRIVACY is asked HERE, not left to the editor this dialog bounces
 * into. Ruled 2026-09-17: every address is shown unless the person creating
 * the venue chooses to hide it, and that choice has to be offered AT CREATION.
 * This dialog is the only way to create a venue in the web app, so it is the
 * only place the ruling can hold. Asking here also matters to the create
 * itself: a venue created with its address hidden starts with performer
 * reviews off (`newPlaceCommunityReviewsDefault`), and a hide picked later in
 * the editor does not change that switch.
 */

export interface NewPlaceDraft {
  name: string;
  city: string;
  countryCode: string;
  /** Starts SHOWN (`newPlacePrivacyValue`); the host spreads it into the create. */
  privacy: PlaceLocationPrivacyValue;
}

export interface NewPlaceDialogProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (draft: NewPlaceDraft) => void;
  /** True while the create mutation is in flight. */
  pending?: boolean;
}

export const NewPlaceDialog = ({
  open,
  onClose,
  onSubmit,
  pending = false,
}: NewPlaceDialogProps) => {
  const t = useTranslations();

  const [name, setName] = useState("");
  const [city, setCity] = useState("");
  // Pre-filled, not forged: it is a visible, editable field the organiser can
  // see and correct before anything is written.
  const [countryCode, setCountryCode] = useState("US");
  const [privacy, setPrivacy] =
    useState<PlaceLocationPrivacyValue>(newPlacePrivacyValue);

  // Reset on each open so a cancelled draft never leaks into the next one.
  useEffect(() => {
    if (open) {
      setName("");
      setCity("");
      setCountryCode("US");
      setPrivacy(newPlacePrivacyValue());
    }
  }, [open]);

  const trimmedName = name.trim();
  const trimmedCity = city.trim();
  const trimmedCountry = countryCode.trim().toUpperCase();

  // Mirrors the server bounds: name `min(2)`, countryCode `length(2)`.
  const isValid =
    trimmedName.length >= 2 &&
    trimmedCity.length >= 1 &&
    trimmedCountry.length === 2;

  const handleClose = useCallback(() => {
    if (pending) return;
    onClose();
  }, [pending, onClose]);

  const handleSubmit = useCallback(() => {
    if (!isValid || pending) return;
    onSubmit({
      name: trimmedName,
      city: trimmedCity,
      countryCode: trimmedCountry,
      privacy,
    });
  }, [
    isValid,
    pending,
    onSubmit,
    trimmedName,
    trimmedCity,
    trimmedCountry,
    privacy,
  ]);

  return (
    <Modal open={open} onClose={handleClose}>
      <Modal.Panel width={440}>
        <Modal.Header
          title={String(t("admin.placesNewPlaceDialogTitle"))}
          onClose={handleClose}
        />
        <Modal.Body>
          <YStack gap="$3">
            <Text variant="body" tone="muted">
              {String(t("admin.placesNewPlaceDialogDescription"))}
            </Text>

            <YStack gap="$1">
              <Text variant="label">
                {String(t("admin.placesNewPlaceNameLabel"))}
              </Text>
              <TextInput
                value={name}
                onChangeText={setName}
                placeholder={
                  t("admin.placesNewPlaceNamePlaceholder") as string
                }
                autoFocus
                maxLength={140}
                fullWidth
                testId="new-place-name-input"
              />
            </YStack>

            <XStack gap="$3" flexWrap="wrap">
              <YStack gap="$1" flex={1} minWidth={160}>
                <Text variant="label">
                  {String(t("admin.placesNewPlaceCityLabel"))}
                </Text>
                <TextInput
                  value={city}
                  onChangeText={setCity}
                  placeholder={
                    t("admin.placesNewPlaceCityPlaceholder") as string
                  }
                  maxLength={120}
                  fullWidth
                  testId="new-place-city-input"
                />
              </YStack>
              <YStack gap="$1" flex={1} minWidth={100}>
                <Text variant="label">
                  {String(t("admin.placesNewPlaceCountryLabel"))}
                </Text>
                <TextInput
                  value={countryCode}
                  onChangeText={setCountryCode}
                  placeholder={
                    t("admin.placesNewPlaceCountryPlaceholder") as string
                  }
                  maxLength={2}
                  fullWidth
                  testId="new-place-country-input"
                />
              </YStack>
            </XStack>

            <Text variant="caption" tone="muted">
              {String(t("admin.placesNewPlaceStreetHint"))}
            </Text>

            {/* Open, not behind a disclosure: the question has to be seen by
                the one person it is for, who will not go looking for it. A
                hairline rule, not a box, separates "where" from "who can see
                it" — strict Swiss forbids a card inside the dialog's panel. */}
            <YStack
              gap="$2"
              borderTopWidth={1}
              borderTopColor="$borderColor"
              paddingTop="$3"
            >
              <Text variant="label">
                {String(t("admin.placePrivacyHeading"))}
              </Text>
              <PlaceLocationPrivacyFields
                value={privacy}
                onChange={setPrivacy}
                countryCode={trimmedCountry}
                disabled={pending}
                newPlace
                testIdPrefix="new-place-privacy"
              />
            </YStack>
          </YStack>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="ghost" onPress={handleClose} disabled={pending}>
            {String(t("admin.cancel"))}
          </Button>
          <Button
            variant="primary"
            onPress={handleSubmit}
            disabled={!isValid || pending}
          >
            {pending
              ? String(t("admin.placesNewPlaceCreating"))
              : String(t("admin.placesNewPlaceCreate"))}
          </Button>
        </Modal.Footer>
      </Modal.Panel>
    </Modal>
  );
};

NewPlaceDialog.displayName = "NewPlaceDialog";
