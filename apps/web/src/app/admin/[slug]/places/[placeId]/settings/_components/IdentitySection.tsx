"use client";

import { useId, type CSSProperties } from "react";
import { YStack } from "tamagui";
import { Text, TextInput, useTranslations } from "@th/ui";

import { PlaceEditSection } from "./PlaceEditSection";
import { SettingsFieldLabel } from "./SettingsFieldLabel";

/**
 * What the venue is called, how big it is, and how people reach it.
 *
 * PURE and PROP-TAKING on purpose: every value and setter stays with the page
 * that hosts the section, beside the dirty tracking, the save latch and the
 * geocode machinery that read them. A section that reached for the state
 * itself could not be shared without one host losing its save contract.
 *
 * Capacity, phone and website used to be a separate "Capacity & contact"
 * panel on the old details form. The venue settings board folds them in here:
 * the page's section index has one entry per answer the owner looks for, and
 * "what is this room" is one answer. The fields are unchanged.
 *
 * A venue has ONE name and this is it — `PageFieldsEditor` deliberately does
 * not edit `displayName` for a PLACE page (see its comment), so there is no
 * second field anywhere that means the same thing.
 */
export type IdentitySectionProps = {
  name: string;
  onNameChange: (value: string) => void;
  capacity: string;
  onCapacityChange: (value: string) => void;
  phone: string;
  onPhoneChange: (value: string) => void;
  website: string;
  onWebsiteChange: (value: string) => void;
  /** Stable anchor target for the settings section index. */
  headingId?: string;
  /** Forwarded to `PlaceEditSection` — make the heading a jump target. */
  anchor?: boolean;
};

/**
 * DS v2 §5: fields that must line up across rows are a GRID. `auto-fit` with
 * a `min(100%, …)` floor gives two columns where they fit and one where they
 * do not, without a media query — and never a track wider than the panel.
 *
 * The 280px floor keeps it at TWO, as the board has it: at 220 the widest
 * panel (~820px inner at 1440) went three-up and orphaned Website on a row of
 * its own under the phone hint (measured).
 */
const FIELD_GRID_STYLE: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 280px), 1fr))",
  gap: "16px 20px",
};

export function IdentitySection({
  name,
  onNameChange,
  capacity,
  onCapacityChange,
  phone,
  onPhoneChange,
  website,
  onWebsiteChange,
  headingId = "place-edit-identity-heading",
  anchor = false,
}: IdentitySectionProps) {
  const t = useTranslations();
  const idBase = useId();
  const ids = {
    name: `${idBase}-name`,
    capacity: `${idBase}-capacity`,
    phone: `${idBase}-phone`,
    phoneHint: `${idBase}-phone-hint`,
    website: `${idBase}-website`,
  };

  return (
    <PlaceEditSection
      title={String(t("admin.placeEditSectionIdentity"))}
      headingId={headingId}
      anchor={anchor}
    >
      <div style={FIELD_GRID_STYLE}>
        <YStack gap="$2">
          <SettingsFieldLabel htmlFor={ids.name}>
            {String(t("admin.placeEditNameLabel"))}
          </SettingsFieldLabel>
          <TextInput
            id={ids.name}
            value={name}
            onChangeText={onNameChange}
            placeholder={t("admin.placeEditNamePlaceholder") as string}
            clearable
            fullWidth
          />
        </YStack>

        <YStack gap="$2">
          <SettingsFieldLabel htmlFor={ids.capacity}>
            {String(t("admin.placeEditCapacityLabel"))}
          </SettingsFieldLabel>
          <TextInput
            id={ids.capacity}
            value={capacity}
            onChangeText={onCapacityChange}
            placeholder={t("admin.placeEditCapacityPlaceholder") as string}
            clearable
            fullWidth
            inputMode="numeric"
          />
        </YStack>

        <YStack gap="$2">
          <SettingsFieldLabel htmlFor={ids.phone}>
            {String(t("admin.placeEditPhoneLabel"))}
          </SettingsFieldLabel>
          <TextInput
            id={ids.phone}
            value={phone}
            onChangeText={onPhoneChange}
            placeholder={t("admin.placeEditPhonePlaceholder") as string}
            clearable
            fullWidth
            inputMode="tel"
            aria-describedby={ids.phoneHint}
          />
          <Text variant="caption" tone="muted" id={ids.phoneHint}>
            {String(t("admin.placeEditPhoneHint"))}
          </Text>
        </YStack>

        <YStack gap="$2">
          <SettingsFieldLabel htmlFor={ids.website}>
            {String(t("admin.placeEditWebsiteLabel"))}
          </SettingsFieldLabel>
          <TextInput
            id={ids.website}
            value={website}
            onChangeText={onWebsiteChange}
            placeholder={t("admin.placeEditWebsitePlaceholder") as string}
            clearable
            fullWidth
            inputMode="url"
          />
        </YStack>
      </div>
    </PlaceEditSection>
  );
}
