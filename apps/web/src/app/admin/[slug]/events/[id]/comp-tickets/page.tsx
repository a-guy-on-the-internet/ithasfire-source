"use client";

import { use } from "react";

import { CompTicketsTab } from "../../new/_components/CompTicketsTab";
import { EventAdminPageShell } from "../_components/EventAdminPageShell";

type PageProps = {
  params: Promise<{ slug: string; id: string }>;
};

/**
 * Standalone comp-tickets surface (event-builder regroup FR-201): the comps
 * LEDGER, with issuing behind an admin-gated dialog.
 *
 * Gate: edit-OR-finance AND a PUBLISHED event. The read contract is
 * `listCompOrders`' ORG_EDIT_OR_FINANCE_ROLES — FINANCE has to be able to
 * explain why twelve admissions produced $0 — so the route admits the same
 * set the server does (the old edit-only gate predates the ledger, when the
 * page was nothing but the admin-only issue form). Issuing stays
 * ORG_ADMIN_ROLES; the surface gates that trigger separately.
 */
export default function AdminEventCompTicketsPage({ params }: PageProps) {
  const { slug, id: eventId } = use(params);

  return (
    <EventAdminPageShell
      slug={slug}
      eventId={eventId}
      requireEditOrFinance
      requirePublished
      forbidCommunity
    >
      {() => <CompTicketsTab slug={slug} eventId={eventId} />}
    </EventAdminPageShell>
  );
}
