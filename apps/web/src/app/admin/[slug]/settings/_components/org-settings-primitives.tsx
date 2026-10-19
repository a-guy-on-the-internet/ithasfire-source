"use client";

/**
 * Shared chrome for the per-route org-settings sections.
 *
 * The flat `SETTINGS_SECTIONS` table and the private `SettingsSideRail` that
 * consumed it are gone: sections are real routes now, the grouped nav model
 * lives in `../_lib/org-settings-sections.tsx`, and it is rendered by the same
 * `@/components/settings` `SettingsNav` the account page uses.
 */

import { XStack, YStack } from "tamagui";
import { Button, Spinner, Text, useTranslations } from "@th/ui";

export function SectionHeading({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <YStack gap="$2">
      <Text variant="h4" weight="bold">
        {title}
      </Text>
      {description ? (
        <Text variant="body" tone="muted">
          {description}
        </Text>
      ) : null}
    </YStack>
  );
}

/**
 * Save affordance for a section that edits org fields.
 *
 * ONE per route, on purpose. The pre-route version rendered this same bar at
 * the top AND the bottom of a nine-section scroll — two buttons with the
 * identical accessible name "Save changes" on one page, which is the exact
 * defect class that shipped from the passkey work. A section route is one or
 * two fields tall, so a single bar below the form is always in view.
 *
 * The dirty state is announced, not just implied by the button's enabled-ness:
 * `role="status"` so a screen reader hears that there is something to save.
 */
export function OrgSaveBar({
  hasChanges,
  isPending,
  onSave,
  testID = "org-settings-save",
}: {
  hasChanges: boolean;
  isPending: boolean;
  onSave: () => void;
  testID?: string;
}) {
  const t = useTranslations();

  return (
    <XStack
      gap="$3"
      alignItems="center"
      justifyContent="flex-end"
      flexWrap="wrap"
    >
      <Text variant="caption" tone="muted" role="status" aria-live="polite">
        {hasChanges ? String(t("admin.settingsUnsavedChanges")) : ""}
      </Text>
      <Button
        variant="primary"
        onPress={onSave}
        disabled={!hasChanges || isPending}
        testID={testID}
      >
        {isPending ? <Spinner size="sm" /> : String(t("admin.saveChanges"))}
      </Button>
    </XStack>
  );
}
