"use client";

import { use } from "react";

import { useTranslations } from "@th/ui";

import { EventAdminPageShell } from "../../_components/EventAdminPageShell";
import { EventOpsShell } from "../../_components/EventOpsShell";
import { RolesTab } from "../_components/RolesTab";
import { VolunteeringGate } from "../_components/VolunteeringGate";

type PageProps = {
  params: Promise<{ slug: string; id: string }>;
};

/**
 * Volunteer roles + shifts, promoted from a tab panel to its own route.
 *
 * `requireEdit` + `requireOrgEvent`: `volunteer.roles.list` (and the
 * `signups.counts` that rides on it) is ORG_EDIT_ROLES on the event's org and
 * throws `EVENT_NOT_ORG_OWNED` on a person's event, for everyone.
 */
export default function AdminEventVolunteerRolesPage({ params }: PageProps) {
  const { slug, id: eventId } = use(params);
  const t = useTranslations();

  return (
    <EventAdminPageShell
      slug={slug}
      eventId={eventId}
      requireEdit
      requireOrgEvent
    >
      {({ currentOwner }) => (
        <VolunteeringGate slug={slug} eventId={eventId}>
          <EventOpsShell
            title={String(t("admin.volunteerEventTabRoles"))}
            purpose={String(t("admin.opsVolunteerRolesPurpose"))}
          >
            <RolesTab
              eventId={eventId}
              orgId={currentOwner.kind === "org" ? currentOwner.orgId : null}
            />
          </EventOpsShell>
        </VolunteeringGate>
      )}
    </EventAdminPageShell>
  );
}
