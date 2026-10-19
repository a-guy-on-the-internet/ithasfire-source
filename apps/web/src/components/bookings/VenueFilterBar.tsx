"use client";

import { useMemo } from "react";
import { XStack, YStack } from "tamagui";
import {
  Button,
  NextLinkAnchor,
  GroupedMultiSelect,
  Text,
  useTranslations,
  type GroupedMultiSelectGroup,
} from "@th/ui";

/** One org-owned venue, exactly as `bookingRequests.countOpen` returns it. */
export type VenueOpenCount = {
  placeId: string;
  placeName: string;
  openCount: number;
  /**
   * The venue's programming calendars — the OPTIONS of the grouped filter,
   * where the venue is the group. Authoritative (from `countOpen`), never
   * derived from the loaded rows: a calendar absent from here cannot be
   * filtered to, and its requests would read as "nothing there".
   */
  calendars: { id: string; name: string }[];
};

/** Sentinel option value — a placeId can never be the empty string. */
const ALL_VENUES = "";

export interface VenueFilterBarProps {
  /** Admin slug, for the per-place inbox href. */
  slug: string;
  /**
   * THE authoritative owned-venue list — `countOpen.venues`, not a companion
   * `places.listHumanPlaces` result. See the component doc.
   */
  venues: VenueOpenCount[];
  /** The owned-place enumeration hit its ceiling (count OR list scope). */
  truncated: boolean;
  /** Selected CALENDAR ids. Empty = no filter = every venue, every calendar. */
  selectedCalendarIds: string[];
  onSelect: (calendarIds: string[]) => void;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
}

/**
 * The venue control on the org-level Bookings page.
 *
 * WHAT THIS REPLACED, and why. This used to be `VenueInboxesBlock`: a list of
 * the org's venues, each with an open-count badge and a link into that venue's
 * own inbox. It was LINK-OUTS ONLY — an org running six venues had to open six
 * inboxes to find out whether anyone wanted to play, and no request was
 * readable or answerable until you picked a venue.
 *
 * The requests now live in ONE cross-venue list above this bar, so the venue
 * dimension stops being a gate and becomes a FILTER: "All venues" is the
 * default and shows everything, and choosing a venue narrows the same list in
 * place. Nothing is hidden behind a choice any more.
 *
 * The drill-down is kept, not deleted — the per-place inbox is still the
 * canonical place-scoped surface (invite resends, place-level settings) — but
 * it collapses to ONE link that follows the selection. That also disposes of a
 * real accessibility defect the old block had to paper over: N buttons whose
 * visible label was the same three words, distinguishable only by an
 * `aria-label`.
 *
 * A SELECT, NOT CHIPS: the owned-place enumeration caps at 100 venues, and a
 * hundred chips is not a control. A select is the familiar affordance for an
 * option set of that size and costs one line at every width. It hides itself
 * entirely for a single-venue org, where a one-option filter is pure noise —
 * the drill-down link stays.
 *
 * THE VENUE SET AND ITS COUNTS COME FROM ONE SOURCE — `countOpen.venues`. Do
 * not re-pair this against `places.listHumanPlaces({ ownedOnly: true })`: that
 * finder never checks `revokedAt` and doesn't require `verified`, so it returns
 * venues `countOpen` correctly omits — and a missing count would render as
 * "0 open" for a venue that was never counted. Nor derive the set from the
 * request rows: a venue with no requests would vanish from the filter and take
 * its drill-down with it.
 *
 * When the owned-place read hits its ceiling the tail is cut ALPHABETICALLY and
 * silently at the repo, so `truncated` is surfaced as a caption rather than
 * letting the missing venues (and their requests) read as quiet.
 *
 * THE TRUNCATION CAPTION OUTRANKS EVERY OTHER BRANCH, including this bar's own
 * failure. `truncated` is ORed from two independent reads (the count query that
 * feeds this filter, and the list query that feeds the rows), so the count query
 * failing is exactly when the caption matters most: the list still renders rows
 * from the first N venues, and without the caption the missing venues' requests
 * read as "nothing more to answer". That is the one failure this surface exists
 * to prevent, so it is rendered in the error branch, the empty branch and the
 * normal branch alike — with a count only when a venue set is actually known.
 */
export function VenueFilterBar({
  slug,
  venues,
  truncated,
  selectedCalendarIds,
  onSelect,
  isLoading,
  isError,
  onRetry,
}: VenueFilterBarProps) {
  const t = useTranslations();

  const totalOpen = useMemo(
    () => venues.reduce((sum, venue) => sum + venue.openCount, 0),
    [venues],
  );

  /**
   * GROUPS for the filter: the venue is the heading, its calendars are the
   * values. The venue is not a value of its own — picking it picks every
   * calendar under it — so the selection stays a flat set of calendar ids and
   * callers filter rows with `selected.has(row.calendarId)` and nothing else.
   */
  const groups = useMemo<GroupedMultiSelectGroup[]>(
    () =>
      venues.map((venue) => ({
        id: venue.placeId,
        label: venue.placeName,
        options: (venue.calendars ?? []).map((calendar) => ({
          id: calendar.id,
          label: calendar.name,
        })),
      })),
    [venues],
  );

  const selectedSet = useMemo(
    () => new Set(selectedCalendarIds),
    [selectedCalendarIds],
  );

  /**
   * The drill-down follows a WHOLE venue only. A selection spanning two
   * venues, or part of one, has no single per-place inbox to point at — and a
   * link that silently picks one of them is worse than no link.
   */
  const selectedVenue =
    venues.find(
      (venue) =>
        (venue.calendars ?? []).length > 0 &&
        (venue.calendars ?? []).every((c) => selectedSet.has(c.id)) &&
        (venue.calendars ?? []).length === selectedSet.size,
    ) ?? null;

  // A single-venue org has nothing to filter, but still has somewhere to go.
  const soleVenue = venues.length === 1 ? venues[0]! : null;
  const drillDownVenue = selectedVenue ?? soleVenue;

  // Rendered in EVERY branch below. When the venue set is unknown (the count
  // failed, or hasn't landed) there is no honest number to quote, so the
  // countless variant is used — "Showing the first 0 venues" would be worse
  // than saying nothing, and saying nothing is the bug.
  const truncationNotice = truncated ? (
    <Text variant="caption" tone="muted" testID="hub-venues-truncated">
      {venues.length > 0
        ? String(t("admin.bkWsVenuesTruncated", { count: venues.length }))
        : String(t("admin.bkWsVenuesTruncatedUnknown"))}
    </Text>
  ) : null;

  if (isError) {
    // The REQUEST list is a different query and has already rendered above —
    // only the venue dimension is missing, so this degrades to a retry line
    // rather than replacing the inbox with an error.
    return (
      <YStack gap="$2">
        <XStack gap="$2" alignItems="center" flexWrap="wrap">
          <Text variant="caption" tone="muted">
            {String(t("admin.bkWsVenuesLoadFailed"))}
          </Text>
          <Button
            variant="secondary"
            size="$2"
            onPress={onRetry}
            testID="hub-venues-retry"
          >
            {String(t("admin.placesRetry"))}
          </Button>
        </XStack>
        {truncationNotice}
      </YStack>
    );
  }

  // No filter to draw yet, and none ever for a pure-act org — but a truncated
  // read still has to say so.
  if (isLoading || venues.length === 0) {
    return truncationNotice ? <YStack>{truncationNotice}</YStack> : null;
  }

  return (
    <YStack gap="$2">
      <XStack gap="$3" alignItems="flex-end" flexWrap="wrap">
        {venues.length > 1 && (
          // flexBasis (not `flex: 1` + minWidth): Tamagui inherits RN's
          // flexShrink: 0, so a flex item with a minWidth never wraps and
          // pushes the document into horizontal scroll at 320px instead.
          //
          // `flexGrow: 0` + a cap, so this reads as a CONTROL rather than a
          // full-bleed banner: measured at 1280 inside the admin shell the row
          // is ~915px wide, and a grown select filled every pixel of it.
          <YStack
            gap="$1"
            flexBasis={300}
            flexGrow={0}
            flexShrink={1}
            minWidth={0}
            maxWidth={360}
          >
            {/* A real <label htmlFor> so clicking the word focuses the select
                and the control is announced with a visible name, not only the
                aria-label. Tamagui's Text has no htmlFor in its prop types. */}
            <GroupedMultiSelect
              groups={groups}
              value={selectedCalendarIds}
              onChange={onSelect}
              label={String(t("admin.bkWsVenueFilterLabel"))}
              allLabel={
                totalOpen > 0
                  ? String(t("admin.bkWsVenueAllOptionCount", { count: totalOpen }))
                  : String(t("admin.bkWsVenueAllOption"))
              }
              allInGroupLabel={String(t("admin.bkWsVenueAllInVenue"))}
              unitLabel={String(t("admin.bkWsVenueUnit"))}
              clearLabel={String(t("admin.bkWsVenueClear"))}
              formatSelectedCount={(count, total) =>
                String(t("admin.bkWsVenueSelectedCount", { count, total }))
              }
              searchPlaceholder={String(t("admin.bkWsVenueSearch"))}
              testIdBase="bookings-venue-filter"
            />
          </YStack>
        )}

        {venues.length === 1 && (
          // No select to filter, but the drill-down button's visible label is
          // three generic words. Without this the single-venue org sees a bare
          // "OPEN INBOX" with no on-screen subject — the venue name reaches
          // assistive tech through the anchor's aria-label, and had to reach
          // sighted users too.
          <YStack gap="$1" minWidth={0} flexShrink={1}>
            <Text
              variant="caption"
              weight="bold"
              tone="muted"
              textTransform="uppercase"
              letterSpacing={0.6}
            >
              {String(t("admin.bkWsVenueFilterLabel"))}
            </Text>
            <Text variant="bodySmall" weight="bold" minWidth={0} truncate>
              {venues[0]!.placeName}
            </Text>
          </YStack>
        )}

        {drillDownVenue && (
          <NextLinkAnchor
            href={`/admin/${slug}/places/${drillDownVenue.placeId}/bookings`}
            // The ANCHOR is the control and carries the name. The Button
            // inside it is decoration: a Tamagui Button emits
            // `role="button" tabindex="0"` even as a span, which would nest an
            // interactive element inside a link and stack two tab stops on one
            // rectangle.
            aria-label={String(
              t("admin.bkWsVenueViewAria", { venue: drillDownVenue.placeName }),
            )}
          >
            <Button
              tag="span"
              variant="outlined"
              size="$2"
              aria-hidden
              tabIndex={-1}
              testID={`hub-venue-inbox-${drillDownVenue.placeId}`}
            >
              {String(t("admin.bkHubVenueView"))}
            </Button>
          </NextLinkAnchor>
        )}
      </XStack>

      {truncationNotice}
    </YStack>
  );
}
