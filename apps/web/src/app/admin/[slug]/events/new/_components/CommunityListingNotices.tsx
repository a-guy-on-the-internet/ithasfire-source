"use client";

import { Globe, Lock } from "lucide-react";
import type { ReactNode } from "react";
import { XStack, YStack } from "tamagui";

import { Text, useTranslations } from "@th/ui";

import type { CommunityLockedStatus } from "./community-builder.helpers";

/**
 * The two standing statements the builder makes about a COMMUNITY listing,
 * both drawn as the same band so the surface has one vocabulary for "here is
 * a fact about this listing, not a field you can change".
 *
 * Strict Swiss: full-width, square, a 2px bottom rule, no shadow. The band
 * sits directly under the sticky header bar and above everything the
 * moderator can act on, so it reads as a property of the surface rather than
 * a floating alert card.
 *
 * This file replaces `CommunityReadOnlyNotice`, whose single band said a live
 * listing could not be edited here. That stopped being true on 2026-09-16 —
 * `community.updateListing` takes a PUBLISHED listing now. The read-only
 * treatment moved to the three states where it is still the truth (CANCELLED
 * / COMPLETED / ARCHIVED), and the live listing got a band of its own that
 * says what editing one costs instead of refusing it.
 */

const BAND_ICON_SIZE = 18;

function NoticeBand({
  testId,
  icon,
  kicker,
  body,
}: {
  testId: string;
  icon: ReactNode;
  kicker: string;
  body: string;
}) {
  return (
    <XStack
      role="status"
      data-testid={testId}
      width="100%"
      gap="$3"
      alignItems="flex-start"
      paddingHorizontal="$5"
      paddingVertical="$3"
      backgroundColor="$surfaceRaised"
      borderBottomWidth={2}
      borderBottomColor="$borderColor"
      borderRadius={0}
    >
      <YStack paddingTop={2} flexShrink={0}>
        {icon}
      </YStack>
      <YStack gap="$1" flex={1} minWidth={0}>
        <Text variant="overline">{kicker}</Text>
        <Text variant="body" tone="muted">
          {body}
        </Text>
      </YStack>
    </XStack>
  );
}

/**
 * A community listing in one of its three end states. The form is not
 * rendered at all behind this — `community.updateListing` refuses the save
 * (`EVENT_NOT_EDITABLE` / `EVENT_ARCHIVED`), so the preview IS the surface.
 *
 * No call to action: unlike the published case this replaced, there is no
 * other route that works. The suggestion queue cannot change a cancelled
 * listing either, and offering it would be a link to a second refusal.
 */
export function CommunityLockedNotice({
  status,
}: {
  status: CommunityLockedStatus;
}) {
  const t = useTranslations();

  const bodyKey =
    status === "CANCELLED"
      ? "communityBuilder.lockedCancelledBody"
      : status === "COMPLETED"
        ? "communityBuilder.lockedCompletedBody"
        : "communityBuilder.lockedArchivedBody";

  return (
    <NoticeBand
      testId="community-locked-notice"
      icon={<Lock size={BAND_ICON_SIZE} aria-hidden />}
      kicker={String(t("communityBuilder.lockedKicker"))}
      body={String(t(bodyKey))}
    />
  );
}

/**
 * A PUBLISHED community listing, opened for editing.
 *
 * Editing a draft is private and costs nothing. Editing this is public the
 * instant it saves, and a schedule or venue change mails everyone who RSVP'd
 * or saved the event. The moderator has to be able to tell those two
 * situations apart BEFORE they type, which the green PUBLISHED chip beside
 * the title does not do — a status readout is not a statement about
 * consequence, and the chip looks identical on a ticketed event where none of
 * this applies.
 *
 * One quiet line, not a warning: nothing here is wrong, and the material case
 * gets its own confirm at the commit point
 * (`CommunityLiveSaveDialog`). Tinting this red would spend the accent budget
 * on every visit to say "this listing is fine".
 */
export function CommunityLiveEditNotice() {
  const t = useTranslations();

  return (
    <NoticeBand
      testId="community-live-edit-notice"
      icon={<Globe size={BAND_ICON_SIZE} aria-hidden />}
      kicker={String(t("communityBuilder.liveKicker"))}
      body={String(t("communityBuilder.liveBody"))}
    />
  );
}
