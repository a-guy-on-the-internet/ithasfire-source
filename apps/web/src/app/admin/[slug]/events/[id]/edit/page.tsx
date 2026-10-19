"use client";

import { use } from "react";
import { useSearchParams } from "next/navigation";
import { useRouter } from "@bprogress/next/app";

import { EventBuilder } from "../../new/_components/EventBuilder";
import { EventAdminPageShell } from "../_components/EventAdminPageShell";
import { isEventBuildSectionId } from "../../../_components/event-nav-context";

type PageProps = {
  params: Promise<{ slug: string; id: string }>;
};

/**
 * The event's Build surface (event-builder regroup FR-201). Hosts
 * EventBuilder in edit-surface mode: the ops surfaces live at their real
 * sibling routes reached via the contextual admin rail (FR-202/FR-207);
 * Preview is an in-view Edit|Preview toggle over the current form state
 * (D4 reversed 2026-07-28; the new-tab link is a secondary affordance) and
 * the seating editor is a full-screen takeover launched from the Tickets
 * section (FR-205). Viewers without edit rights still land here — the
 * builder renders its read-only event preview directly (no tab chrome).
 */
export default function AdminEventEditPage({ params }: PageProps) {
  const { slug, id: eventId } = use(params);
  const router = useRouter();
  const searchParams = useSearchParams();

  // `?seating=legacy` — the base redirector maps old `?tab=seating` deep
  // links here; the builder opens the seating takeover over Build on mount
  // (FR-205). The takeover only renders when the event actually has a place
  // layout + the feature gate is on, so stale links degrade gracefully.
  const initialSeatingOpen = searchParams.get("seating") === "legacy";

  // `?section=…` — Build-section deep link: the contextual rail's Build
  // anchors land here from ops routes (essentials/details/tickets/lineup/
  // splits/settings), and the Dates page's "Edit schedule" link uses
  // `scheduling` (expands the Scheduling settings group). Unknown values are
  // ignored.
  const sectionParam = searchParams.get("section");
  const focusSection =
    sectionParam === "scheduling"
      ? ("scheduling" as const)
      : isEventBuildSectionId(sectionParam)
        ? sectionParam
        : undefined;

  // `?view=preview` — deep link into the in-place preview toggle (D4
  // reversed): the builder opens with the main column swapped to the live
  // preview of the current form state. Any other value renders Edit.
  const initialViewMode =
    searchParams.get("view") === "preview" ? ("preview" as const) : undefined;

  return (
    <EventAdminPageShell slug={slug} eventId={eventId}>
      {({ ownerType, ownerId, canEditEvent, canManageEvent }) => (
        <EventBuilder
          surface="edit"
          ownerType={ownerType}
          ownerId={ownerId}
          slug={slug}
          eventId={eventId}
          initialSeatingOpen={initialSeatingOpen}
          focusSection={focusSection}
          initialViewMode={initialViewMode}
          canEditEvent={canEditEvent}
          canManageEvent={canManageEvent}
          onCancel={() => {
            router.push(`/admin/${slug}/events`);
          }}
        />
      )}
    </EventAdminPageShell>
  );
}
