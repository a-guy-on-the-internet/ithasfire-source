"use client";

import { Text } from "@th/ui";
import { useTranslations } from "@th/ui";

import { trpc } from "@/trpc";

type Props = {
  /** Public event UUID — the aggregate subject. */
  eventId: string;
  /**
   * When true, the line sits on the immersive dark hero scrim, so it renders
   * as a dimmed on-dark ink (still ≥AA over the ≥0.6 black floor) instead of
   * the themed muted ink, which would be invisible on dark.
   */
  onDark?: boolean;
  /**
   * An explicit colour for the line, overriding `onDark`. The poster-first
   * page passes its `--hero-ink-muted` custom property, which is ink on the
   * phone's paper sheet and the dimmed on-dark rung over the desktop band —
   * a choice only CSS can make, since it turns on a media query.
   */
  ink?: string;
};

/** 0–5 half-step score → "4" / "4.5" (text, never color-only). */
function formatScore(score: number): string {
  return score.toLocaleString(undefined, { maximumFractionDigits: 1 });
}

/**
 * Small, quiet "this event" rating line under the organizer attribution
 * (attendee-reviews FR-005c). A single snapshot-only public read; renders
 * NOTHING until a publishable aggregate exists (below the k-threshold the
 * snapshot has no `summary`), and never blocks the page — the query is
 * `retry: false`, silent, and its loading/error states render nothing.
 *
 * Subject choice: the public event page does not cheaply expose the event's
 * owner id (only `organizerName`/`organizerHref`), so this reads the EVENT
 * aggregate keyed by `eventId` and frames it as "this event" rather than the
 * organizer's cross-event reputation. The organizer/series (OWNER) aggregate
 * surfaces on the org/human entity page instead.
 */
export function EventRatingLine({ eventId, onDark = false, ink }: Props) {
  const t = useTranslations();
  const query = trpc.attendeeReviews.getAggregate.useQuery(
    { subjectType: "EVENT", subjectId: eventId },
    { retry: false, staleTime: 300_000, meta: { silent: true } },
  );

  const summary = query.data?.snapshot?.summary;
  if (!summary) return null;

  return (
    <Text
      variant="bodySmall"
      tone="muted"
      data-testid="event-rating-line"
      style={{
        fontSize: 12,
        letterSpacing: 0.2,
        // On the dark hero scrim the themed muted ink vanishes; a dimmed
        // on-dark ink stays legible while keeping the line quiet.
        ...(ink
          ? { color: ink }
          : onDark
            ? { color: "color-mix(in srgb, var(--onStructure, #FDFAF3) 85%, transparent)" }
            : {}),
      }}
    >
      {String(
        t("eventDetail.attendeeRatingLine", {
          score: formatScore(summary.overallScore),
          count: summary.reviewCountBand,
        }),
      )}
    </Text>
  );
}

EventRatingLine.displayName = "EventRatingLine";
