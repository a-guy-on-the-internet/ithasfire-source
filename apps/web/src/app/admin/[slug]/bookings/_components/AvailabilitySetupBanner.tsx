"use client";

import { useMemo, useState } from "react";
import { X } from "lucide-react";
import { XStack, YStack } from "tamagui";
import { Button, NextLinkAnchor, Text, useTranslations } from "@th/ui";

import { trpc } from "@/trpc";
import { HOLD_ACTION_TOUCH } from "@/components/bookings/booking-holds";

// ─────────────────────────────────────────────────────────────────────────────
// UNCONFIGURED-VENUE BANNER (availability-onboarding FR-004).
//
// A Place with zero CalendarAvailability rows renders every date on its public
// booking form as unavailable, so a venue that turned booking requests on is
// silently uncontactable. This banner is the workspace-level tell: it names
// the consequence in the venue's own words and puts the fix (the calendars
// page) one click away.
//
// ONE BANNER, NAMING THE VENUES — never one banner per venue. The workspace
// spans every venue the owner holds, and an owner fresh from setup can have
// several in this state at once; N stacked bands of identical amber copy would
// bury the inbox they sit above, and each would want its own dismiss. One band
// carries the shared sentence, one link per venue carries the fix, and one
// dismissal covers the condition.
//
// WHAT IT COSTS, AND THE CAP. The workspace's one `countOpen` read deliberately
// carries no per-venue settings, so the banner probes ONE read per venue:
// `places.getAvailabilitySetupState` (owner-gated), whose payload carries both
// halves of the trigger — `configured` AND `acceptsBookingRequests`, the RAW
// toggle rather than the public projection, put there precisely so this
// surface would not need a companion `getPlaceForEdit` fan-out.
//
// The probes run only for a small venue set (`MAX_PROBED_VENUES` — one query
// per venue up to the cap). This is an ONBOARDING nudge — the venue that just
// flipped the toggle and doesn't know its form is dead — and an operation
// running more venues than the cap is not in that regime; FR-001's inline
// warning and FR-003's notification still cover it. Probing 100 owner-gated
// reads to maybe render a reminder is the exact fan-out this workspace was
// rebuilt to kill.
//
// FAIL QUIET. A probe that errors (an environment without the procedure, a
// refused actor, a network miss) excludes its venue rather than rendering a
// guess — a missing nudge is recoverable, a wrong one teaches people to
// ignore the banner.
//
// DISMISSAL IS SESSION-SCOPED CLIENT STATE (user-locked): sessionStorage,
// never the database. A venue that knows and is getting to it is not nagged
// again this session; one that forgot is reminded next time. The key includes
// the unconfigured set, so a NEW venue entering the state re-surfaces the
// banner within the session. The moment hours exist the venue leaves the set
// — the hours editors invalidate `getAvailabilitySetupState` — and the banner
// disappears because the condition is gone, not because it was silenced.
// ─────────────────────────────────────────────────────────────────────────────

/** Above this many venues the probes (and the banner) stand down. */
export const MAX_PROBED_VENUES = 12;

const PROBE_OPTIONS = {
  staleTime: 30_000,
  retry: false,
  meta: { silent: true },
} as const;

export type SetupBannerVenue = {
  placeId: string;
  placeName: string;
};

function storageKeyFor(slug: string, placeIds: readonly string[]): string {
  return `bk-hours-banner:${slug}:${[...placeIds].sort().join(",")}`;
}

export function AvailabilitySetupBanner({
  slug,
  venues,
}: {
  /** Admin context slug, for the calendars-page links. */
  slug: string;
  /**
   * The workspace's authoritative venue set (`countOpen.venues`) — the same
   * list the filter bar renders, never a companion place query.
   */
  venues: readonly SetupBannerVenue[];
}) {
  const t = useTranslations();

  const probed = useMemo(
    () => (venues.length <= MAX_PROBED_VENUES ? venues : []),
    [venues],
  );

  const setupResults = trpc.useQueries((q) =>
    probed.map((venue) =>
      q.places.getAvailabilitySetupState(
        { placeId: venue.placeId },
        PROBE_OPTIONS,
      ),
    ),
  );

  // FR-004's trigger, exactly: unconfigured AND accepting booking requests —
  // both halves off the ONE settled detector read. A loading or refused probe
  // excludes its venue.
  const unconfigured = useMemo(
    () =>
      probed.filter(
        (venue, index) =>
          setupResults[index]?.data?.configured === false &&
          setupResults[index]?.data?.acceptsBookingRequests === true,
      ),
    [probed, setupResults],
  );

  const storageKey = storageKeyFor(
    slug,
    unconfigured.map((venue) => venue.placeId),
  );

  // Session dismissal. The stored read is derived (not an effect) so a
  // dismissed banner never flashes on remount; it only runs once the probes
  // have produced a non-empty set, which is strictly post-hydration, so SSR
  // never sees a different answer. Storage can refuse (private mode, quota) —
  // then the in-memory latch still hides it for this mount, which is the
  // honest floor.
  const [dismissedNow, setDismissedNow] = useState<string | null>(null);
  const storedDismissed = useMemo(() => {
    if (unconfigured.length === 0) return false;
    try {
      return window.sessionStorage.getItem(storageKey) === "1";
    } catch {
      return false;
    }
  }, [storageKey, unconfigured.length]);

  if (
    unconfigured.length === 0 ||
    storedDismissed ||
    dismissedNow === storageKey
  ) {
    return null;
  }

  const dismiss = () => {
    setDismissedNow(storageKey);
    try {
      window.sessionStorage.setItem(storageKey, "1");
    } catch {
      // Private mode / quota: the in-memory latch above still hides it.
    }
  };

  const single = unconfigured.length === 1 ? unconfigured[0]! : null;

  return (
    <YStack
      role="status"
      borderWidth={2}
      borderColor="$warning"
      backgroundColor="$surface"
      padding="$3"
      gap="$2"
      testID="bookings-hours-banner"
    >
      <XStack gap="$2" alignItems="flex-start">
        <YStack gap="$1" flex={1} minWidth={0}>
          <Text variant="overline" color="$warningSoft">
            {String(t("admin.bkWsHoursBannerTitle"))}
          </Text>
          <Text variant="bodySmall">
            {single
              ? String(
                  t("admin.bkWsHoursBannerOne", { venue: single.placeName }),
                )
              : String(t("admin.bkWsHoursBannerMany"))}
          </Text>
        </YStack>
        <Button
          variant="ghost"
          size="$2"
          $sm={HOLD_ACTION_TOUCH}
          aria-label={String(t("admin.bkWsHoursBannerDismiss"))}
          onPress={dismiss}
          testID="bookings-hours-banner-dismiss"
        >
          <X size={15} strokeWidth={2} aria-hidden />
        </Button>
      </XStack>

      {/* MEASURED at 320×800 in the running app before this layout: a link
          reading "SET HOURS — CHEER UP CHARLIES" overran its 250px parent by
          97.7px and pushed the page into horizontal scroll (scrollWidth 348).
          Tamagui inherits RN's flexShrink: 0 and the mono label never wraps,
          so a long venue name simply left the viewport. Three defences, all
          needed: the anchor may shrink (minWidth 0), the label may wrap
          (whiteSpace normal, height auto), and under $sm the links stop
          sharing a row at all — they stack full-width, where a wrapped
          two-line label keeps its 44px touch floor instead of squeezing. */}
      <XStack
        gap="$2"
        flexWrap="wrap"
        $sm={{ flexDirection: "column", alignItems: "stretch" }}
      >
        {unconfigured.map((venue) => (
          <NextLinkAnchor
            key={venue.placeId}
            href={`/admin/${slug}/places/${venue.placeId}/calendars`}
            aria-label={String(
              t("admin.bkWsHoursBannerCtaAria", { venue: venue.placeName }),
            )}
            // The adapter forwards only DOM-safe props to the rendered <a>,
            // so this is plain CSS, not Tamagui style props: flex makes the
            // inner button fill the anchor, minWidth lets it shrink below
            // its label's intrinsic width instead of overflowing the row.
            style={{ display: "flex", minWidth: 0, maxWidth: "100%" }}
          >
            <Button
              tag="span"
              variant="outlined"
              size="$2"
              aria-hidden
              tabIndex={-1}
              flex={1}
              flexShrink={1}
              minWidth={0}
              height="auto"
              minHeight={36}
              $sm={HOLD_ACTION_TOUCH}
              // whiteSpace only: `textAlign` in textProps reaches the DOM
              // unconverted on this Button configuration and logs a React
              // unknown-prop error (measured live). Left-aligned wrap is fine.
              textProps={{ whiteSpace: "normal" }}
              testID={`bookings-hours-banner-link-${venue.placeId}`}
            >
              {single
                ? String(t("admin.bkWsHoursBannerCta"))
                : String(
                    t("admin.bkWsHoursBannerCtaVenue", {
                      venue: venue.placeName,
                    }),
                  )}
            </Button>
          </NextLinkAnchor>
        ))}
      </XStack>
    </YStack>
  );
}
