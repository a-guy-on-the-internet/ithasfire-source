"use client";

import { useCallback } from "react";
import { YStack } from "tamagui";
import { Button, Text, useTranslations } from "@th/ui";

import { trpc } from "@/trpc";

import { EventGuestInvites } from "./EventGuestInvites";
import { EventSharedInviteLink } from "./EventSharedInviteLink";
import type { InviteGateType, InviteTranslate } from "./event-invite-helpers";
import type { TemplateOwnerRef } from "./ticket-type-template-helpers";
import { InvitePanel, InviteSection, InviteSectionTitle } from "./_invite-styled";

/**
 * Settings → Access Gate: the "Invite link" and "Invited guests" sections
 * (gated-event invite links, design option A). Mounted by EventGateSettings
 * only while the event is behind a password or an application; with no gate
 * there is nothing for an invite to skip, so nothing renders.
 */

export type EventInviteSettingsProps = {
  eventId: string;
  gateType: InviteGateType;
  /** The EVENT's owner: whose contact lists the list picker offers. */
  owner: TemplateOwnerRef;
};

export function EventInviteSettings({
  eventId,
  gateType,
  owner,
}: EventInviteSettingsProps) {
  const rawT = useTranslations();
  const t: InviteTranslate = useCallback(
    (key, values) => String(rawT(key, values)),
    [rawT],
  );
  const invitesQuery = trpc.events.listInvites.useQuery({ eventId });

  if (invitesQuery.isLoading) {
    return (
      <InviteSection data-testid="invite-settings-loading">
        <InviteSectionTitle>{t("admin.ginLinkTitle")}</InviteSectionTitle>
        <InvitePanel>
          <Text style={{ fontSize: 13 }} tone="muted" role="status">
            {t("admin.ginLoading")}
          </Text>
        </InvitePanel>
      </InviteSection>
    );
  }

  if (invitesQuery.isError || !invitesQuery.data) {
    return (
      <InviteSection data-testid="invite-settings-error">
        <InviteSectionTitle>{t("admin.ginLinkTitle")}</InviteSectionTitle>
        <InvitePanel>
          <YStack gap={8} alignItems="flex-start">
            <Text style={{ fontSize: 13 }} tone="error" role="alert">
              {t("admin.ginLoadError")}
            </Text>
            <Button
              variant="secondary"
              size="$3"
              onPress={() => {
                void invitesQuery.refetch();
              }}
              disabled={invitesQuery.isFetching}
              data-testid="invite-settings-retry"
            >
              {t("admin.ginRetry")}
            </Button>
          </YStack>
        </InvitePanel>
      </InviteSection>
    );
  }

  const { shared, guests } = invitesQuery.data;

  return (
    <>
      <EventSharedInviteLink
        eventId={eventId}
        gateType={gateType}
        shared={shared}
      />
      <EventGuestInvites eventId={eventId} owner={owner} guests={guests} />
    </>
  );
}

export default EventInviteSettings;
