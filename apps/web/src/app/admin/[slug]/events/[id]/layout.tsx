"use client";

import { use, type ReactNode } from "react";
import { usePathname } from "next/navigation";

import { useTranslations } from "@th/ui";

import { trpc } from "@/trpc";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { useEventNavIdentity } from "../../_components/event-nav-context";

// Maps the active sub-route segment to a section label key. The base
// `/events/[id]` path is now a pure redirector into these routes, so every
// rendered surface carries a section prefix in its document title.
const SECTION_LABEL_KEY: Record<string, string> = {
  edit: "pageActions.editEvent",
  dates: "admin.sdTitle",
  attendees: "pageActions.attendees",
  volunteers: "pageActions.volunteers",
  "comp-tickets": "pageActions.compTickets",
  "seat-prices": "admin.seatPricesTitle",
  suggestions: "admin.ebTabSuggestions",
  feedback: "admin.ebTabFeedback",
  applications: "admin.applications",
};

type LayoutProps = {
  params: Promise<{ slug: string; id: string }>;
  children: ReactNode;
};

export default function EventDetailLayout({ params, children }: LayoutProps) {
  const { id: eventId } = use(params);
  const pathname = usePathname();
  const t = useTranslations();

  const lastSegment = pathname.split("/").pop() ?? "";

  // On `/edit` the builder already reads the whole event (`getEventForEdit`)
  // and publishes the title here, so this query stays off there. (It was
  // first skipped because `getEventTitle` refused ownerless COMMUNITY
  // listings; it now admits a community moderator, as `getEventForEdit`
  // does.) Off the edit surface nothing publishes, and the query runs
  // exactly as before.
  const onEditSurface = lastSegment === "edit";
  const identity = useEventNavIdentity(eventId);
  const eventTitleQuery = trpc.events.getEventTitle.useQuery(
    { eventId },
    { enabled: Boolean(eventId) && !onEditSurface, staleTime: 60_000 },
  );
  const eventTitle = identity?.title ?? eventTitleQuery.data?.title;

  const sectionKey = SECTION_LABEL_KEY[lastSegment];

  useDocumentTitle(
    eventTitle
      ? sectionKey
        ? `${String(t(sectionKey))} · ${eventTitle}`
        : eventTitle
      : null,
  );

  return <>{children}</>;
}
