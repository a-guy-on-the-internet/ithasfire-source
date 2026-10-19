"use client";

import { useFormatters, useTranslations } from "@th/ui";

import { trpc } from "@/trpc";

import { formatBucketDollars } from "./VenueStatsBlock";
import formStyles from "./RequestToPlayBlock.module.css";

/**
 * Attendance band (venue-track-record-and-review-switch R4/FR-010/FR-014) →
 * copy key. "Checked in" is the word — these are `Ticket.scannedAt` counts,
 * never tickets sold, and the exact average never leaves core.
 */
const ATTENDANCE_BAND_KEYS: Record<string, string> = {
  under_25: "admin.bkStatsLineAttendanceUnder25",
  "25_to_100": "admin.bkStatsLineAttendance25To100",
  "100_to_300": "admin.bkStatsLineAttendance100To300",
  over_300: "admin.bkStatsLineAttendanceOver300",
};

/**
 * Compact venue-stats context line inside the booking-request form
 * (booking-review-data-weave FR-008; attendance band per
 * venue-track-record-and-review-switch FR-014).
 *
 * Two reads, two provenances, one sentence:
 *
 *   - `placeReviews.getPublicStats` — the PERFORMER snapshot. Its clauses
 *     ("7 performers have reviewed this venue · 85% would play again · median
 *     reported payout $150") render only while a headline is published. The
 *     venue's performer-review switch OFF ⇒ `snapshot: null` ⇒ none of them.
 *   - `places.getTrackRecord` — the DOOR. One clause, "usually 25–100 people
 *     checked in", rendered whenever a band exists, independent of the
 *     performer snapshot: it is the venue's own scan history, not testimony,
 *     so the switch has no say over it. It lives here and nowhere public
 *     (R4 — a placement decision, not an access control).
 *
 * Nothing to say from either read → renders NOTHING: no empty <p>, no
 * reserved space. The form never waits on these queries (no spinner, no
 * error state) — they are purely additive context. Mounted only inside the
 * actual booking form, so signed-out and performer-mode gates never fire
 * them.
 *
 * ONE paint: nothing renders until BOTH reads have settled (data or error).
 * Painting whichever lands first and then reflowing moves the sentence's
 * opening capital from one clause to another under the reader's eyes.
 */
export function RequestToPlayStatsLine({ placeId }: { placeId: string }) {
  const t = useTranslations();
  // Same locale seam as the blocks this borrows its formatter from: the amount
  // must follow the APP's locale, not the runtime's. (This line is
  // client-query-driven, so it renders null on the server and carries no
  // hydration risk — but it was still printing English numerals into Spanish
  // copy.)
  const fmt = useFormatters();

  const queryOptions = {
    staleTime: 5 * 60_000,
    retry: false,
    meta: { silent: true },
  } as const;

  const statsQuery = trpc.placeReviews.getPublicStats.useQuery(
    { placeId },
    queryOptions,
  );
  const trackRecordQuery = trpc.places.getTrackRecord.useQuery(
    { placeId },
    queryOptions,
  );

  const settled = (q: { isPending: boolean; isError: boolean }) =>
    !q.isPending || q.isError;
  if (!settled(statsQuery) || !settled(trackRecordQuery)) return null;

  const snapshot = statsQuery.data?.snapshot;
  const headline = snapshot?.headline;
  const attendanceBand = trackRecordQuery.data?.attendanceBand ?? null;
  const bandKey = attendanceBand ? ATTENDANCE_BAND_KEYS[attendanceBand] : null;

  const parts: string[] = [];
  if (headline?.reviewCountBand) {
    parts.push(
      String(
        t("admin.bkStatsLineReviewed", { count: headline.reviewCountBand }),
      ),
    );
    if (headline.wouldPlayAgainPct != null) {
      parts.push(
        String(
          t("admin.bkStatsLinePlayAgain", { pct: headline.wouldPlayAgainPct }),
        ),
      );
    }
    if (snapshot?.payout) {
      parts.push(
        String(
          t("admin.bkStatsLineMedianPayout", {
            amount: formatBucketDollars(fmt, snapshot.payout.medianCents),
          }),
        ),
      );
    }
  }
  if (bandKey) {
    parts.push(String(t(bandKey)));
  }

  if (parts.length === 0) return null;

  // Every clause is written lowercase so it can follow a "·"; whichever one
  // opens the sentence is capitalised by `.statsLine`'s `::first-letter`, so
  // the copy is never rewritten in code (and stays greppable by its key).
  return (
    <p className={`${formStyles.fieldHint} ${formStyles.statsLine}`}>
      {parts.join(" · ")}
    </p>
  );
}
