"use client";

import { use } from "react";

import { useTranslations } from "@th/ui";

import { EventAdminPageShell } from "../../_components/EventAdminPageShell";
import { EventOpsShell } from "../../_components/EventOpsShell";
import { RewardsTab } from "../_components/RewardsTab";
import { VolunteeringGate } from "../_components/VolunteeringGate";

type PageProps = {
  params: Promise<{ slug: string; id: string }>;
};

/**
 * Volunteer comp rewards, promoted from a tab panel to its own route.
 *
 * `requireFinance` is new work rather than a straight lift: reward config and
 * the grant ledger are ORG_FINANCE_ROLES-gated server-side, and as a tab the
 * client simply never rendered it for non-finance actors. A route is directly
 * addressable, so the gate has to be enforced here — non-finance viewers are
 * redirected rather than left to collect a 403 from the ledger query.
 *
 * `requireEdit` too: before the ledger can load, the tab resolves the event's
 * ask (`asks.listBySubject`, EVENT subject) and its roles
 * (`volunteer.roles.list`), both ORG_EDIT_ROLES. A FINANCE member passed the
 * finance gate and then got an empty page, so the route needs a role in BOTH
 * sets. `requireOrgEvent`: those reads refuse a person's event for everyone.
 */
export default function AdminEventVolunteerRewardsPage({ params }: PageProps) {
  const { slug, id: eventId } = use(params);
  const t = useTranslations();

  return (
    <EventAdminPageShell
      slug={slug}
      eventId={eventId}
      requireEdit
      requireFinance
      requireOrgEvent
    >
      {() => (
        <VolunteeringGate slug={slug} eventId={eventId}>
          <EventOpsShell
            title={String(t("admin.volunteerEventTabRewards"))}
            purpose={String(t("admin.opsVolunteerRewardsPurpose"))}
          >
            {/* Reaching this component means the route's finance gate passed. */}
            <RewardsTab eventId={eventId} canFinance />
          </EventOpsShell>
        </VolunteeringGate>
      )}
    </EventAdminPageShell>
  );
}
