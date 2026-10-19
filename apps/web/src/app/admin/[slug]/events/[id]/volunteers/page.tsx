"use client";

import { use } from "react";

import { EventAdminPageShell } from "../_components/EventAdminPageShell";
import { VolunteersSetupView } from "./_components/VolunteersSetupView";

type PageProps = {
  params: Promise<{ slug: string; id: string }>;
};

/**
 * Volunteers — setup. Whether volunteering is on for this event and how
 * signups are handled.
 *
 * Roles / signups / rewards used to be tab panels inside this page; they are
 * now sibling routes (`./roles`, `./signups`, `./rewards`), each linkable and
 * each gating itself.
 *
 * `requireEdit`: the page reads `getEventForEdit` and writes
 * `events.updateSettings`, both edit-gated server-side, so VIEWER / FINANCE /
 * SCANNER only ever got the load-error line here. Deliberately NOT
 * `requireOrgEvent`: both calls serve a person's own event too, which makes
 * this the one volunteer page that works there. `forbidCommunity`: its write
 * (`events.updateSettings`) refuses a COMMUNITY listing for everyone.
 */
export default function AdminEventVolunteersPage({ params }: PageProps) {
  const { slug, id: eventId } = use(params);

  return (
    <EventAdminPageShell
      slug={slug}
      eventId={eventId}
      requireEdit
      forbidCommunity
    >
      {() => <VolunteersSetupView slug={slug} eventId={eventId} />}
    </EventAdminPageShell>
  );
}
