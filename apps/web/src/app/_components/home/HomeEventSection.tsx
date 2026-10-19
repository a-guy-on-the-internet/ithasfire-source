"use client";

import { type ReactNode, useCallback, useState, memo } from "react";
import { useRouter } from "@bprogress/next/app";

import { useIsMobile } from "@/hooks/useIsMobile";
import { YStack, XStack, styled } from "tamagui";

import {
  EventGrid,
  Text,
  ViewToggle,
  type EventSummary,
  type EventGridVariant,
  type ViewToggleMode,
} from "@th/ui";

const SectionContainer = styled(YStack, {
  name: "HomeEventSection",
  gap: "$3",
  // Swiss structural rule: visible top-edge line between content sections
  borderTopWidth: 2,
  borderTopColor: "$borderColor",
  paddingTop: "$4",
  // `position: relative` is the containing block for the .swiss-diagonal
  // pseudo-element. No `overflow: hidden` here: the pseudo is
  // `position: absolute; inset: 0`, so it is ALREADY constrained to this
  // element's padding box — the clip bought nothing and cut the 4px offset
  // shadow off the grid's rightmost column and bottom row (v2 --shadow-card).
  position: "relative",
});

const SectionHeader = styled(XStack, {
  name: "HomeEventSectionHeader",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "$3",
  flexWrap: "wrap",
});

export interface HomeEventSectionProps {
  title: string;
  subtitle?: string;
  events: EventSummary[];
  loading?: boolean;
  variant?: EventGridVariant;
  /** Curated event rendered as the grid's feature poster. One per page. */
  featuredEventId?: string;
  testIdBase?: string;
  /** Called when user clicks "View All" or similar action */
  onViewAll?: () => void;
  /** If provided, renders when events array is empty */
  renderEmptyState?: () => ReactNode;
  /** Custom action in header */
  headerAction?: ReactNode;
  /** Swiss section number prefix (1 → "01"). When omitted, no number shown. */
  sectionNumber?: number;
  /** Show grid/list toggle button pair. Only applies when variant is "grid" or "list". */
  showViewToggle?: boolean;
  /**
   * Save-heart toggle handler. When provided, cards render the heart overlay
   * (wire through `useSavedEventSummaries` so `events[].favorite` is set).
   */
  onFavoriteToggle?: (eventId: string) => void;
}

/**
 * A reusable section component for displaying event grids on the home page.
 * Handles navigation to event details and provides consistent styling.
 */
export const HomeEventSection = memo(function HomeEventSection({
  title,
  subtitle,
  events,
  loading = false,
  variant = "carousel",
  featuredEventId,
  testIdBase,
  onViewAll,
  renderEmptyState,
  headerAction,
  sectionNumber,
  showViewToggle = false,
  onFavoriteToggle,
}: HomeEventSectionProps) {
  const router = useRouter();

  // Toggle state — only meaningful when showViewToggle is true.
  // Initialise from the supplied variant so the default matches the layout intent.
  const [viewMode, setViewMode] = useState<ViewToggleMode>(
    variant === "list" ? "list" : "grid",
  );
  /** Whether the reader has chosen a view themselves — their choice wins. */
  const [viewModeTouched, setViewModeTouched] = useState(false);

  // On a phone the grid collapses to ONE column, so a "grid" of vertical
  // cards renders each event as a full-bleed portrait poster: 443px of art on
  // an 844px screen, i.e. 1.9 events per viewport. That is the feature-poster
  // treatment (EventGrid documents it as "one per grid, and one per PAGE")
  // applied to every row. The list variant renders the same EventCard as a
  // dense horizontal row instead — art beside the text, not under it.
  //
  // Reference point, measured on dice.fm/browse at 390x844: a 96px square
  // thumbnail on a 120px row pitch, seven events per screen.
  const isMobile = useIsMobile();
  const compactByDefault = isMobile && !viewModeTouched;

  const handleViewModeChange = useCallback((next: ViewToggleMode) => {
    setViewModeTouched(true);
    setViewMode(next);
  }, []);

  const effectiveVariant: EventGridVariant =
    showViewToggle && variant !== "carousel"
      ? compactByDefault
        ? "list"
        : viewMode
      : variant;

  const handleEventCardPress = useCallback(
    (event: EventSummary) => {
      if (event.slug) {
        router.push(`/events/${event.slug}`);
      }
      // Events without slug can't be navigated until we enrich the search index
    },
    [router],
  );

  // Don't render section at all if empty and no empty state
  if (!loading && events.length === 0 && !renderEmptyState) {
    return null;
  }

  return (
    <SectionContainer className="swiss-diagonal">
      <SectionHeader style={{ position: "relative", zIndex: 1 }}>
        <XStack gap="$2" alignItems="baseline" flexShrink={1} minWidth={0}>
          {sectionNumber != null && (
            <Text
              variant="kicker"
              tone="accent"
              weight="bold"
              aria-hidden
              fontSize={14}
              minWidth={28}
            >
              {String(sectionNumber).padStart(2, "0")}
            </Text>
          )}
          <YStack gap="$1" flexShrink={1} minWidth={0}>
            {/* tag="h2": section titles sit directly under the hero h1 —
                keeps the h3 visual scale without skipping a heading level. */}
            <Text
              variant="h3"
              tag="h2"
              weight="bold"
              textTransform="uppercase"
              letterSpacing={0.5}
              $xs={{ fontSize: "$5", lineHeight: "$5" }}
              $sm={{ fontSize: "$6", lineHeight: "$6" }}
            >
              {title}
            </Text>
            {subtitle ? (
              <Text
                variant="caption"
                tone="muted"
                textTransform="uppercase"
                letterSpacing={1}
              >
                {subtitle}
              </Text>
            ) : null}
          </YStack>
        </XStack>

        {/* On a phone the title eats the whole first line, so this cluster wraps
            onto its own.

            It briefly claimed that whole line (`flexGrow: 1` +
            `space-between`) to mirror the one-line desktop header, but the two
            readings are not equivalent: on desktop the controls sit apart
            because a TITLE is between them, and with nothing between them on
            mobile the same rule just opened ~180px of dead space and left the
            toggle stranded at the far edge. Content-width and grouped reads as
            one control cluster, which is what it is. Same `$3` gap the desktop
            header already puts between these two. */}
        <XStack gap="$3" alignItems="center" flexShrink={0}>
          {showViewToggle && variant !== "carousel" && (
            <ViewToggle
              value={compactByDefault ? "list" : viewMode}
              onChange={handleViewModeChange}
            />
          )}
          {headerAction}
        </XStack>
      </SectionHeader>

      <div style={{ position: "relative", zIndex: 1 }}>
        <EventGrid
          events={events}
          loading={loading}
          variant={effectiveVariant}
          featuredEventId={featuredEventId}
          testIdBase={testIdBase}
          renderEmptyState={renderEmptyState}
          onCardPress={handleEventCardPress}
          onFavoriteToggle={
            onFavoriteToggle
              ? (eventId) => onFavoriteToggle(eventId)
              : undefined
          }
        />
      </div>
    </SectionContainer>
  );
});
