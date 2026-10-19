"use client";

import { use } from "react";

import { AttendeeFeedbackTab } from "../../new/_components/AttendeeFeedbackTab";
import { EventAdminPageShell } from "../_components/EventAdminPageShell";

type PageProps = {
  params: Promise<{ slug: string; id: string }>;
};

/**
 * Private "Attendee feedback" surface as a standalone route (event-builder
 * regroup FR-201). Gated like the old feedback tab (FR-203): edit rights
 * only — its own empty state covers events with no feedback yet, so it does
 * NOT gate on PUBLISHED.
 */
export default function AdminEventFeedbackPage({ params }: PageProps) {
  const { slug, id: eventId } = use(params);

  return (
    <EventAdminPageShell
      slug={slug}
      eventId={eventId}
      requireEdit
      forbidCommunity
    >
      {() => <AttendeeFeedbackTab eventId={eventId} />}
    </EventAdminPageShell>
  );
}
