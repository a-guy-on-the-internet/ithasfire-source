"use client";

import { use } from "react";

import { SuggestionsTab } from "../../new/_components/SuggestionsTab";
import { EventAdminPageShell } from "../_components/EventAdminPageShell";

type PageProps = {
  params: Promise<{ slug: string; id: string }>;
};

/**
 * Owner-side "Suggested edits" inbox as a standalone surface (event-builder
 * regroup FR-201). Gated like the old suggestions tab (FR-203): edit rights
 * AND a PUBLISHED event — suggestions only exist against published events,
 * and reviewing them needs edit rights.
 */
export default function AdminEventSuggestionsPage({ params }: PageProps) {
  const { slug, id: eventId } = use(params);

  return (
    <EventAdminPageShell
      slug={slug}
      eventId={eventId}
      requireEdit
      requirePublished
    >
      {() => <SuggestionsTab eventId={eventId} />}
    </EventAdminPageShell>
  );
}
