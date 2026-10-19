"use client";

import { YStack } from "tamagui";

import { Spinner, Text, useTranslations } from "@th/ui";

import { trpc } from "@/trpc";
import { EventVolunteeringSection } from "@/app/admin/[slug]/events/new/_components/EventVolunteeringSection";

import { EventOpsShell } from "../../_components/EventOpsShell";

export type VolunteersSetupViewProps = {
  slug: string;
  eventId: string;
};

/**
 * Landing page for the volunteers section: whether volunteering is on for this
 * event, and how signups are handled.
 *
 * Replaces `VolunteersView`, which was the last surface in the admin still
 * running tabs INSIDE a route — roles / signups / rewards were tab panels
 * behind one URL, so none of them was linkable and the settings band doubled
 * as their visibility gate. They are now sibling routes; this page keeps only
 * the settings, and the rail lists the three children beneath it.
 */
export function VolunteersSetupView({
  slug,
  eventId,
}: VolunteersSetupViewProps) {
  const t = useTranslations();
  const eventQuery = trpc.events.getEventForEdit.useQuery(
    { eventId },
    { staleTime: 10_000, retry: 1, enabled: Boolean(eventId) },
  );

  return (
    <EventOpsShell
      title={String(t("admin.volunteers"))}
      purpose={String(t("admin.opsVolunteerSetupPurpose"))}
    >
      {eventQuery.isPending ? (
        <YStack
          padding="$5"
          alignItems="center"
          justifyContent="center"
          minHeight={240}
          gap="$3"
        >
          <Spinner size="lg" />
          <Text variant="body" tone="muted">
            {String(t("admin.loading"))}
          </Text>
        </YStack>
      ) : eventQuery.isError || !eventQuery.data ? (
        <Text variant="body" tone="muted">
          {String(t("admin.eventBuilderLoadErrorDescription"))}
        </Text>
      ) : (
        // `embedded` drops the section's own heading and container — the shell
        // owns both now. No `onEnabledChange`: flipping the toggle no longer
        // has to reveal or hide sibling tabs, because the siblings are routes
        // and each gates itself.
        <EventVolunteeringSection
          eventId={eventId}
          slug={slug}
          initialVolunteeringEnabled={
            eventQuery.data.volunteeringEnabled ?? false
          }
          initialVolunteerAutoApprove={
            eventQuery.data.volunteerAutoApprove ?? false
          }
          initialVolunteerWaiverRequired={
            eventQuery.data.volunteerWaiverRequired ?? false
          }
          initialVolunteerIntroText={eventQuery.data.volunteerIntroText ?? null}
          hasWaiverAssigned={Boolean(eventQuery.data.waiverTemplateId)}
          hideManageRolesLink
          embedded
        />
      )}
    </EventOpsShell>
  );
}

VolunteersSetupView.displayName = "VolunteersSetupView";
