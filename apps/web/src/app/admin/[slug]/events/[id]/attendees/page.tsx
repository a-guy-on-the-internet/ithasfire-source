"use client";

import { use } from "react";

import { AttendeesTab } from "../../new/_components/AttendeesTab";
import { EventAdminPageShell } from "../_components/EventAdminPageShell";

type PageProps = {
  params: Promise<{ slug: string; id: string }>;
};

/**
 * Standalone attendees surface (event-builder regroup FR-201).
 *
 * Gated on edit-OR-finance rights, matching the role set
 * `searchEventAttendees` enforces server-side. The route previously admitted
 * every role that could resolve the admin slug — parity with the old
 * `?tab=attendees` tab — so VIEWER and SCANNER reached the page and then hit
 * a 403 from the query. The gate, the rail item's `rbac` and the use case are
 * now one rule.
 */
export default function AdminEventAttendeesPage({ params }: PageProps) {
  const { slug, id: eventId } = use(params);

  return (
    <EventAdminPageShell
      slug={slug}
      eventId={eventId}
      requireEditOrFinance
      forbidCommunity
    >
      {/* AttendeesTab renders its own EventOpsShell — it owns the filter state
          that fills the shell's filter slot. */}
      {() => <AttendeesTab slug={slug} eventId={eventId} />}
    </EventAdminPageShell>
  );
}
