"use client";

import { XStack, YStack } from "tamagui";
import { Inbox } from "lucide-react";
import { Text, useTranslations } from "@th/ui";

import { trpc } from "@/trpc";
import { ReceivedBookingRequestsList } from "./ReceivedBookingRequestsList";
import { SectionCard } from "./settings-primitives";
import { SentBookingRequestsList } from "./SentBookingRequestsList";

/**
 * "Booking requests" — both directions in one card, split out of
 * `PerformerSection`. Received first: those are the ones waiting on the user.
 *
 * Neither list is gated on performer mode — an open request received (or sent)
 * before the toggle went off must stay actionable. That matches the pre-split
 * behaviour and `OrgSettingsView`'s equivalent list.
 *
 * Query options must stay byte-identical to PerformerSection's copy of
 * `performers.getMyStatus` — react-query dedupes them and divergent options
 * would silently change retry/error behaviour for whichever mounts first.
 */
export function BookingRequestsSection() {
  const t = useTranslations();

  const statusQuery = trpc.performers.getMyStatus.useQuery(undefined, {
    staleTime: 30_000,
    retry: false,
    meta: { silent: true },
  });

  const adminOrgIds = statusQuery.data?.orgs.map((o) => o.ownerId) ?? [];

  return (
    <SectionCard>
      <XStack gap="$2" alignItems="center">
        <Inbox size={18} color="$colorMuted" />
        <Text variant="h4" weight="bold">
          {String(t("account.sBookingRequestsTitle"))}
        </Text>
      </XStack>

      <Text variant="bodySmall" tone="muted">
        {String(t("account.sBookingRequestsDesc"))}
      </Text>

      {/* Requests organizers sent to this human act (FR-007). Org acts see
          theirs on the group's Bookings workspace (/admin/[slug]/bookings,
          "To you as an act"), which is where that inbox moved out of settings. */}
      <YStack gap="$2">
        <Text variant="body" weight="bold">
          {String(t("account.sPerformerReceivedTitle"))}
        </Text>
        <Text variant="caption" tone="muted">
          {String(t("account.sPerformerReceivedDesc"))}
        </Text>
        <ReceivedBookingRequestsList owner={{ ownerType: "human" }} />
      </YStack>

      <YStack borderBottomWidth={2} borderBottomColor="$borderColor" />

      <YStack gap="$2">
        <Text variant="body" weight="bold">
          {String(t("account.sPerformerSentTitle"))}
        </Text>
        <Text variant="caption" tone="muted">
          {String(t("account.sPerformerRequestsDesc"))}
        </Text>
        <SentBookingRequestsList orgOwnerIds={adminOrgIds} />
      </YStack>
    </SectionCard>
  );
}
