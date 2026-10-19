"use client";

import { XStack, YStack } from "tamagui";
import { ExternalLink } from "lucide-react";

import { Button, useTranslations } from "@th/ui";

import { EventStatusBadge } from "../events/_components/EventStatusBadge";
import { RailContextTitle } from "./RailContextTitle";

const KNOWN_STATUSES = [
  "DRAFT",
  "PUBLISHED",
  "COMPLETED",
  "CANCELLED",
  "ARCHIVED",
] as const;
type KnownStatus = (typeof KNOWN_STATUSES)[number];

const isKnownStatus = (s: string): s is KnownStatus =>
  (KNOWN_STATUSES as readonly string[]).includes(s);

export type EventRailContextHeaderProps = {
  /** Resolved display title (caller applies the untitled fallback). */
  title: string | null;
  /** Raw event status enum (DRAFT / PUBLISHED / CANCELLED / …) when known. */
  status?: string;
  /**
   * Public path of the live event (`/events/{slug}`), or null when it has no
   * public page yet. Present only once the event is PUBLISHED with a slug —
   * the caller owns that gate.
   */
  viewHref?: string | null;
};

/**
 * Rail context header for the event-context rail (FR-202): event title, a
 * status token chip, and the one link out to the live public page. Slotted
 * between the "← All events" back row and the Build/Manage sections. Tone
 * mapping mirrors the builder header's chip.
 *
 * "View event" lives HERE rather than on each surface because the rail is the
 * one piece of chrome every event route shares — builder, attendees, comps,
 * volunteers, suggestions, feedback. Per-surface copies would be six near
 * identical buttons, each crowding that surface's own primary (Export CSV,
 * Issue comps, Issue badges).
 */
export function EventRailContextHeader({
  title,
  status,
  viewHref,
}: EventRailContextHeaderProps) {
  const t = useTranslations();
  if (!title && !status && !viewHref) return null;
  return (
    <YStack
      paddingHorizontal="$4"
      paddingBottom="$3"
      gap="$2"
      alignItems="flex-start"
      borderBottomWidth={1}
      borderBottomColor="$borderColorSoft"
      data-testid="event-rail-context-header"
    >
      {/* The title is the ONE thing on this header that gives: it clips to
          the rail's width instead of setting it (see RailContextTitle). The
          status chip and "View event" keep their natural size below. */}
      {title ? (
        <RailContextTitle title={title} testId="event-rail-context-title" />
      ) : null}
      <XStack gap="$2" alignItems="center" flexWrap="wrap">
        {status && isKnownStatus(status) ? (
          <EventStatusBadge status={status} />
        ) : null}
        {viewHref ? (
          // New tab, like the builder header's did: an organiser checking the
          // live page is doing it ALONGSIDE the admin work, not instead of it,
          // and losing an unsaved builder form to a same-tab navigation was
          // the exact complaint that made it a new tab in the first place.
          <Button
            variant="ghost"
            size="$2"
            paddingHorizontal="$2"
            onPress={() => {
              window.open(viewHref, "_blank", "noopener,noreferrer");
            }}
            data-testid="event-rail-view-live"
          >
            <ExternalLink size={14} aria-hidden />
            {String(t("pageActions.viewEvent"))}
          </Button>
        ) : null}
      </XStack>
    </YStack>
  );
}

EventRailContextHeader.displayName = "EventRailContextHeader";
