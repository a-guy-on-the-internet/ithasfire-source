"use client";

import { useTranslations } from "@th/ui";

import { SuggestionInbox } from "@/components/community/SuggestionInbox";
import { EventOpsShell } from "../../[id]/_components/EventOpsShell";

export type SuggestionsTabProps = {
  eventId: string;
};

/**
 * Embedded owner-side "Suggested edits" inbox for the EventBuilder
 * (community-managed-event-listings spec FR-016) — the personal-event
 * equivalent of the org dashboard inbox, scoped to THIS event. The shared
 * SuggestionInbox owns loading/empty/error/review states; this wrapper just
 * frames it inside the builder's tab panel.
 */
export function SuggestionsTab({ eventId }: SuggestionsTabProps) {
  const t = useTranslations();
  return (
    <EventOpsShell
      title={String(t("ownerSuggestions.title"))}
      purpose={String(t("ownerSuggestions.eventSubtitle"))}
    >
      <SuggestionInbox scope={{ kind: "event", eventId }} />
    </EventOpsShell>
  );
}

SuggestionsTab.displayName = "SuggestionsTab";
