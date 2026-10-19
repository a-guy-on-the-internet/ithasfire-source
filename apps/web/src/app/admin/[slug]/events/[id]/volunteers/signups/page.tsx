"use client";

import { use } from "react";
import { IdCard } from "lucide-react";

import { Button, NextLinkAnchor, useTranslations } from "@th/ui";

import { EventAdminPageShell } from "../../_components/EventAdminPageShell";
import { EventOpsShell } from "../../_components/EventOpsShell";
import { SignupsTab } from "../_components/SignupsTab";
import { VolunteeringGate } from "../_components/VolunteeringGate";

type PageProps = {
  params: Promise<{ slug: string; id: string }>;
};

/**
 * The volunteer signup review queue, promoted from a tab panel to its own
 * route — the one of the three with a real dataset behind it, so "the pending
 * signups screen" is now a link you can send someone.
 *
 * `requireEdit` + `requireOrgEvent`: `volunteer.signups.list` and
 * `volunteer.roles.list` are ORG_EDIT_ROLES on the event's org and refuse a
 * person's event outright.
 */
export default function AdminEventVolunteerSignupsPage({ params }: PageProps) {
  const { slug, id: eventId } = use(params);
  const t = useTranslations();

  return (
    <EventAdminPageShell
      slug={slug}
      eventId={eventId}
      requireEdit
      requireOrgEvent
    >
      {() => (
        <VolunteeringGate slug={slug} eventId={eventId}>
          <EventOpsShell
            title={String(t("admin.volunteerEventTabSignups"))}
            purpose={String(t("admin.opsVolunteerSignupsPurpose"))}
            actions={
              /*
               * Badges are ORGANIZER/VENUE-issued credential stock, so their
               * entry point belongs on the surface run by whoever is
               * accountable at the door — this one. Secondary, not primary:
               * approving signups is what this screen is for, and a roster with
               * nothing approved has no badges to issue.
               *
               * Leading icon per the icon grammar (an object — the badge —
               * not a direction), mirroring the ticket sheet's entry point on
               * `OrderDetail`.
               */
              <NextLinkAnchor
                href={`/admin/${slug}/events/${eventId}/volunteers/badges/print`}
                style={{ textDecoration: "none", width: "fit-content" }}
              >
                <Button
                  tag="span"
                  variant="secondary"
                  size="$2"
                  minHeight={44}
                  data-testid="volunteer-badges-entry"
                >
                  <IdCard size={15} aria-hidden />
                  {String(t("admin.volunteerBadgesEntry"))}
                </Button>
              </NextLinkAnchor>
            }
          >
            <SignupsTab eventId={eventId} />
          </EventOpsShell>
        </VolunteeringGate>
      )}
    </EventAdminPageShell>
  );
}
