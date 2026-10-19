"use client";

import { YStack } from "tamagui";
import { Text, useTranslations } from "@th/ui";

/**
 * The event is real, the reader is a moderator, and recurrence editing still
 * does not apply: `updateCommunityRecurrence` is a COMMUNITY-listing
 * capability and refuses anything else with `EVENT_NOT_COMMUNITY`.
 *
 * A plain statement rather than a 404 — nothing is missing, and an org-owned
 * event's schedule has an owner and an editor of its own. A client component
 * only so the copy can live in the catalogue with the rest of `/moderate`.
 */
export function OutOfScopeNotice() {
  const t = useTranslations();
  return (
    <YStack
      gap="$2"
      padding="$5"
      borderWidth={2}
      borderColor="$borderColor"
      backgroundColor="$surface"
      data-testid="schedule-out-of-scope"
    >
      <Text variant="h5" tag="h2" weight="bold">
        {String(t("moderation.schedNotCommunity"))}
      </Text>
      <Text variant="bodySmall" tone="muted">
        {String(t("moderation.schedNotCommunityHint"))}
      </Text>
    </YStack>
  );
}

OutOfScopeNotice.displayName = "OutOfScopeNotice";
