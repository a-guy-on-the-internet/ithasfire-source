import { DateTime } from "luxon";

// ---------------------------------------------------------------------------
// Venue track record — THE policy (venue-track-record-and-review-switch spec,
// docs/specs/2026-09-24, FR-009 / FR-010, rulings R4 / R5 / R9).
//
// Pure. No deps, no clock, no repos. Two halves:
//
//   · `computeTrackRecord`   — the six STORED `PlaceStats` columns, written by
//                              `recalculatePlaceStats` every 30 minutes;
//   · `deriveTrackRecordView` — the READ-TIME derivations (this year, years
//                              running, cadence, attendance band). Never
//                              stored: "nothing to keep honest twice" (R9).
//
// BASIS IS `endsAt`, EVERYWHERE (RULED 2026-09-24): a show has "happened" when
// it has ENDED. A show that has started but not ended is not yet history and
// its scans are partial. `firstShowAt` / `lastShowAt` / cadence all read
// `endsAt`. (The older `totalEventCount` / `avgAttendance` pair is on a
// `startsAt <= now` basis and is left alone — it differs only by in-progress
// shows.)
//
// ATTENDANCE IS PEOPLE CHECKED IN, NEVER TICKETS SOLD (R4). A show with zero
// scans is EXCLUDED from the average — it is absent from `scanCounts`, and
// absence is never read as 0. An RSVP-only night contributes to shows-hosted
// and recency, not to attendance (R5): it simply has no scans.
//
// THE EXACT `checkedInAvg` NEVER LEAVES CORE (NFR-004). The band from
// `deriveTrackRecordView` IS the suppression. This module hands the number
// back to its callers (the recalculation job stores it; the public loaders
// derive the band from it) — it is the CALLERS' job never to put the raw
// figure on a public output. Assert it in their tests, not here.
// ---------------------------------------------------------------------------

/** One past event as the recalculation job sees it. */
export interface TrackRecordEventInput {
  id: string;
  /** `Event.endsAt`. The show counts only when this is `<= now`. */
  endsAt: Date;
}

export interface ComputeTrackRecordInput {
  pastEvents: ReadonlyArray<TrackRecordEventInput>;
  /**
   * `TicketsRepo.countScannedByEvent` result: eventId → people admitted
   * (distinct tickets with an ACCEPTED `TicketScan` — R11; a later refund
   * does not erase them). An event with ZERO admits is ABSENT from the map,
   * never present as 0.
   */
  scanCounts: ReadonlyMap<string, number>;
  now: Date;
}

/** The six stored `PlaceStats` track-record columns. */
export interface TrackRecordStats {
  showsHosted: number;
  firstShowAt: Date | null;
  lastShowAt: Date | null;
  scannedEventCount: number;
  checkedInTotal: number;
  /** Rounded mean over shows with ≥1 scan; null when there are none. */
  checkedInAvg: number | null;
}

export const EMPTY_TRACK_RECORD: Readonly<TrackRecordStats> = Object.freeze({
  showsHosted: 0,
  firstShowAt: null,
  lastShowAt: null,
  scannedEventCount: 0,
  checkedInTotal: 0,
  checkedInAvg: null,
});

/**
 * The stored half. Events whose `endsAt` is after `now` are dropped from
 * EVERYTHING — shows hosted, first/last, and the scan figures alike (their
 * door is still open; their count is partial).
 *
 * `scannedEventCount` counts shows that appear in `scanCounts` with a count
 * `> 0`. A `0` entry is tolerated (treated as "no scans", i.e. excluded) so a
 * defensive adapter that emits zeros cannot drag the average down.
 */
export function computeTrackRecord(
  input: ComputeTrackRecordInput,
): TrackRecordStats {
  const nowMs = input.now.getTime();
  const ended = input.pastEvents.filter((e) => e.endsAt.getTime() <= nowMs);
  if (ended.length === 0) return { ...EMPTY_TRACK_RECORD };

  let firstMs = Number.POSITIVE_INFINITY;
  let lastMs = Number.NEGATIVE_INFINITY;
  let scannedEventCount = 0;
  let checkedInTotal = 0;

  for (const event of ended) {
    const endMs = event.endsAt.getTime();
    if (endMs < firstMs) firstMs = endMs;
    if (endMs > lastMs) lastMs = endMs;

    // R4: absent = zero scans = EXCLUDED from the mean. Only a positive count
    // makes a show part of the attendance sample.
    const scans = input.scanCounts.get(event.id);
    if (typeof scans === "number" && Number.isFinite(scans) && scans > 0) {
      scannedEventCount += 1;
      checkedInTotal += scans;
    }
  }

  return {
    showsHosted: ended.length,
    firstShowAt: new Date(firstMs),
    lastShowAt: new Date(lastMs),
    scannedEventCount,
    checkedInTotal,
    checkedInAvg:
      scannedEventCount > 0
        ? Math.round(checkedInTotal / scannedEventCount)
        : null,
  };
}

// ---------------------------------------------------------------------------
// Read-time derivations
// ---------------------------------------------------------------------------

export const CADENCES = [
  "weekly",
  "fortnightly",
  "monthly",
  "occasional",
] as const;
export type Cadence = (typeof CADENCES)[number];

export const ATTENDANCE_BANDS = [
  "under_25",
  "25_to_100",
  "100_to_300",
  "over_300",
] as const;
export type AttendanceBand = (typeof ATTENDANCE_BANDS)[number];

/** Trailing window the cadence is judged over. */
export const CADENCE_WINDOW_DAYS = 180;
/** Fewer NIGHTS than this in the window → no cadence claim. */
export const CADENCE_MIN_SHOWS = 3;
/**
 * A show ending before this hour (place zone) belongs to the PREVIOUS
 * calendar night: an early + late double bill whose late set ends at 01:30
 * is one night, not two a day apart.
 */
export const NIGHT_ROLLOVER_HOUR = 6;
/**
 * Inside a cadence run, ONE out-of-bucket gap is tolerated when it is at most
 * this many times the median — a weekly residency that skipped a week is
 * still "weekly since" before the skip. Two consecutive out-of-bucket gaps
 * end the run.
 */
export const CADENCE_SKIP_TOLERANCE = 2;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface DeriveTrackRecordViewInput {
  /** The stored columns (or the subset the caller has). */
  stats: Pick<TrackRecordStats, "firstShowAt" | "checkedInAvg">;
  /**
   * `endsAt` of past shows at the place ending on or after
   * `min(startOfYearInZone(now), now − 180d)` — the union of what
   * `showsThisYear` and the cadence window read. Earlier rows are
   * unnecessary (a loader may bound its page read there); any after `now`
   * are ignored.
   */
  pastEventEnds: ReadonlyArray<Date>;
  now: Date;
  /**
   * The PLACE's IANA zone — "this year" is the venue's calendar year, not the
   * server's. `null` or an unknown zone falls back to UTC.
   */
  timeZone: string | null;
}

export interface TrackRecordView {
  /** Shows whose `endsAt` falls in the current calendar year in `timeZone`. */
  showsThisYear: number;
  /**
   * Years from `firstShowAt` to `now`, rounded DOWN to the nearest 0.5.
   * `null` when there is no first show or it is under half a year ago.
   */
  yearsRunning: number | null;
  /** Median gap between consecutive shows in the trailing window, bucketed. */
  cadence: Cadence | null;
  /**
   * The earliest show in the trailing window from which every gap up to the
   * last show stays in the `cadence` bucket — "weekly since <this>". `null`
   * whenever `cadence` is.
   */
  cadenceSince: Date | null;
  /** Coarsened `checkedInAvg`. The ONLY attendance figure that may go public. */
  attendanceBand: AttendanceBand | null;
}

export function bucketCadence(gapDays: number): Cadence {
  if (gapDays <= 10) return "weekly";
  if (gapDays <= 21) return "fortnightly";
  if (gapDays <= 45) return "monthly";
  return "occasional";
}

/**
 * FR-010. Boundaries are lower-inclusive: 25 → `25_to_100`, 100 → `100_to_300`,
 * 300 → `over_300`.
 */
export function attendanceBandFor(
  checkedInAvg: number | null,
): AttendanceBand | null {
  if (checkedInAvg === null || !Number.isFinite(checkedInAvg)) return null;
  if (checkedInAvg < 25) return "under_25";
  if (checkedInAvg < 100) return "25_to_100";
  if (checkedInAvg < 300) return "100_to_300";
  return "over_300";
}

/**
 * Half-year floor: 2.54 → 2.5, 0.49 → null. CALENDAR years (Luxon's
 * `diff(..., "years")`), not `days / 365.25` — the second anniversary of a
 * first show must read 2, and 730 days over a mean year is 1.9986, which
 * floors to 1.5. Computed in UTC on both sides so the diff is zone-neutral.
 */
export function yearsRunningFor(
  firstShowAt: Date | null,
  now: Date,
): number | null {
  if (firstShowAt === null) return null;
  const years = DateTime.fromJSDate(now, { zone: "utc" }).diff(
    DateTime.fromJSDate(firstShowAt, { zone: "utc" }),
    "years",
  ).years;
  if (!Number.isFinite(years) || years < 0) return null;
  const halves = Math.floor(years * 2);
  return halves < 1 ? null : halves / 2;
}

/**
 * The instant in the place zone. A bogus (or null) zone yields an invalid
 * DateTime, so fall back to UTC rather than compute on NaN.
 */
function inZone(date: Date, zone: string | null): DateTime {
  const dt = DateTime.fromJSDate(date, { zone: zone ?? "utc" });
  return dt.isValid ? dt : DateTime.fromJSDate(date, { zone: "utc" });
}

/** Zone-aware calendar year. */
function calendarYearIn(date: Date, zone: string | null): number {
  return inZone(date, zone).year;
}

/**
 * The calendar NIGHT a show belongs to, in the place zone, with the
 * `NIGHT_ROLLOVER_HOUR` shift so a set ending after midnight stays on the
 * night it started.
 */
function nightKeyOf(ms: number, zone: string | null): string {
  return inZone(new Date(ms), zone)
    .minus({ hours: NIGHT_ROLLOVER_HOUR })
    .toISODate()!;
}

/**
 * Collapse show instants to DISTINCT NIGHTS: one entry per night, carrying
 * that night's earliest instant. An early + late double bill is one night;
 * gaps are measured between nights, never between the two sets of one bill
 * (which would read as a 0.15-day "weekly" gap and skew the median).
 */
function distinctNights(
  sortedMs: ReadonlyArray<number>,
  zone: string | null,
): number[] {
  const firstByNight = new Map<string, number>();
  for (const ms of sortedMs) {
    const key = nightKeyOf(ms, zone);
    if (!firstByNight.has(key)) firstByNight.set(key, ms);
  }
  return [...firstByNight.values()];
}

/**
 * Cadence over the trailing window. Shows are collapsed to distinct NIGHTS
 * in the place zone; gaps are between consecutive nights; the median gap is
 * bucketed. `since` walks BACKWARDS from the last night while each gap stays
 * in the median's bucket, so a room that went weekly two months ago after a
 * sparse spring reads "weekly since <the first weekly night>", not since the
 * spring.
 *
 * ONE SKIP IS FORGIVEN: an out-of-bucket gap of at most
 * `CADENCE_SKIP_TOLERANCE × median` is stepped over when the gap before it
 * is back in-bucket — a weekly residency that missed one week is still
 * "weekly since" the start of the residency. Two consecutive out-of-bucket
 * gaps (or one wider than the tolerance) end the run there.
 */
export function cadenceFor(
  pastEventEnds: ReadonlyArray<Date>,
  now: Date,
  timeZone: string | null = null,
): { cadence: Cadence | null; cadenceSince: Date | null } {
  const nowMs = now.getTime();
  const windowStart = nowMs - CADENCE_WINDOW_DAYS * DAY_MS;
  const inWindow = distinctNights(
    pastEventEnds
      .map((d) => d.getTime())
      .filter((ms) => ms <= nowMs && ms >= windowStart)
      .sort((a, b) => a - b),
    timeZone,
  );

  if (inWindow.length < CADENCE_MIN_SHOWS) {
    return { cadence: null, cadenceSince: null };
  }

  const gapsDays: number[] = [];
  for (let i = 1; i < inWindow.length; i += 1) {
    gapsDays.push((inWindow[i]! - inWindow[i - 1]!) / DAY_MS);
  }
  const sortedGaps = [...gapsDays].sort((a, b) => a - b);
  const mid = Math.floor(sortedGaps.length / 2);
  const medianGap =
    sortedGaps.length % 2 === 1
      ? sortedGaps[mid]!
      : (sortedGaps[mid - 1]! + sortedGaps[mid]!) / 2;
  const cadence = bucketCadence(medianGap);

  // Walk back from the last night. `gapsDays[i - 1]` is the gap INTO night
  // `i`; an in-bucket gap extends the run, a tolerable skip is stepped over
  // only when the gap before it is in-bucket, anything else ends the run.
  const maxSkip = medianGap * CADENCE_SKIP_TOLERANCE;
  const inBucket = (gap: number) => bucketCadence(gap) === cadence;
  let sinceIndex = inWindow.length - 1;
  while (sinceIndex > 0) {
    const gapIn = gapsDays[sinceIndex - 1]!;
    if (inBucket(gapIn)) {
      sinceIndex -= 1;
      continue;
    }
    const gapBefore = sinceIndex >= 2 ? gapsDays[sinceIndex - 2] : undefined;
    if (gapIn <= maxSkip && gapBefore !== undefined && inBucket(gapBefore)) {
      // One forgiven skip: land on the night before it (its own gap in is
      // in-bucket, so the loop keeps walking from there).
      sinceIndex -= 1;
      continue;
    }
    break;
  }

  return { cadence, cadenceSince: new Date(inWindow[sinceIndex]!) };
}

export function deriveTrackRecordView(
  input: DeriveTrackRecordViewInput,
): TrackRecordView {
  const zone = input.timeZone ?? "utc";
  const nowMs = input.now.getTime();
  const thisYear = calendarYearIn(input.now, zone);

  const showsThisYear = input.pastEventEnds.filter(
    (d) => d.getTime() <= nowMs && calendarYearIn(d, zone) === thisYear,
  ).length;

  const { cadence, cadenceSince } = cadenceFor(
    input.pastEventEnds,
    input.now,
    zone,
  );

  return {
    showsThisYear,
    yearsRunning: yearsRunningFor(input.stats.firstShowAt, input.now),
    cadence,
    cadenceSince,
    attendanceBand: attendanceBandFor(input.stats.checkedInAvg),
  };
}
