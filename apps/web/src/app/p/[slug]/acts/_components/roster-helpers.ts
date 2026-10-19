import type { PageBlockRecord } from "@th/types/repos/entity-pages";

/* ── Roster helpers ─────────────────────────────────────────────────────────
 *
 * Pure functions behind `/p/[slug]/acts` (venue-track-record-and-review-switch
 * FR-016, ruling R9 "Roster"). No React, no I/O: the grouping rule, the
 * header-line read, and the relative-date wording live here so the tests can
 * pin each one without rendering.
 */

/** One act as the roster renders it. `lastPlayedAt` is ISO — it crosses the
 *  server → client boundary as a string. */
export type RosterAct = {
  /** Opaque per-act identity from core (`LineupHistoryAct.key`) — the React key. */
  key: string;
  name: string;
  /** `/humans/{slug}` for a linked act with a page; null otherwise. */
  profileUrl: string | null;
  timesPlayed: number;
  lastPlayedAt: string;
};

/** FR-016: three or more shows here makes an act a REGULAR. */
export const REGULAR_THRESHOLD = 3;

const ms = (iso: string): number => new Date(iso).getTime();

/**
 * REGULARS (timesPlayed ≥ 3) by timesPlayed desc then lastPlayedAt desc;
 * RECENTLY (everyone else) by lastPlayedAt desc. Name breaks every tie so two
 * acts from the same night never reorder between renders.
 */
export function groupRoster(acts: ReadonlyArray<RosterAct>): {
  regulars: RosterAct[];
  recently: RosterAct[];
} {
  const byName = (a: RosterAct, b: RosterAct) => a.name.localeCompare(b.name);
  const byRecency = (a: RosterAct, b: RosterAct) =>
    ms(b.lastPlayedAt) - ms(a.lastPlayedAt) || byName(a, b);

  const regulars = acts
    .filter((act) => act.timesPlayed >= REGULAR_THRESHOLD)
    .sort((a, b) => b.timesPlayed - a.timesPlayed || byRecency(a, b));
  const recently = acts
    .filter((act) => act.timesPlayed < REGULAR_THRESHOLD)
    .sort(byRecency);

  return { regulars, recently };
}

/** The three figures the header line prints. Zero shape when unknown. */
export type TrackRecordSummary = {
  showsHosted: number;
  firstShowAt: string | null;
  lastShowAt: string | null;
  /**
   * The venue's IANA zone (spec FU-001), so this page and the venue block one
   * click up print the same calendar day for the same show. Null when the
   * block predates the field; the page then falls back to the platform zone.
   */
  timeZone: string | null;
};

const EMPTY_SUMMARY: TrackRecordSummary = {
  showsHosted: 0,
  firstShowAt: null,
  lastShowAt: null,
  timeZone: null,
};

const isoOrNull = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

/**
 * Reads shows-hosted / first / last from the public page's server-injected
 * `track_record` block, so the acts page and the venue page print the same
 * numbers from the same read. The block is pinned (never omitted from a
 * PLACE page), but a page from before it existed has none — that renders as
 * "nothing to say" rather than as zero shows.
 */
export function readTrackRecordSummary(
  blocks: ReadonlyArray<PageBlockRecord>,
): TrackRecordSummary {
  const block = blocks.find((b) => b.kind === "track_record");
  const data = block?.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return EMPTY_SUMMARY;
  }
  const record = data as Record<string, unknown>;
  // The trusted-marker discipline every server-built block carries: owner-
  // stored data has no `dataSource`, and is never read as a figure.
  if (record.dataSource !== "track_record") return EMPTY_SUMMARY;

  const showsHosted =
    typeof record.showsHosted === "number" && record.showsHosted > 0
      ? record.showsHosted
      : 0;
  return {
    showsHosted,
    firstShowAt: isoOrNull(record.firstShowAt),
    lastShowAt: isoOrNull(record.lastShowAt),
    timeZone: isoOrNull(record.timeZone),
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The calendar day `date` falls on in `timeZone`, as a day count since the epoch. */
function localDayNumber(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((p) => p.type === type)?.value);
  return Math.floor(
    Date.UTC(part("year"), part("month") - 1, part("day")) / DAY_MS,
  );
}

/**
 * "9 days ago" / "yesterday" / "1 month ago" — the parenthetical after the
 * header's absolute `last` date. It STANDS ALONE (never behind a "last" /
 * "último" prefix — "last yesterday", "último ayer" were the bug), so every
 * wording must read as a complete phrase: days use `numeric: "auto"` for the
 * natural "today" / "yesterday"; months and years use `numeric: "always"`,
 * because "last month" is an ambiguous fragment where "1 month ago" is not.
 * Counted in CALENDAR days in the venue's zone, the way a person counts them:
 * a show on the evening of the 15th is "9 days ago" on the 24th, not "8 days
 * ago" because fewer than 9×24 hours have elapsed. A show that ended after
 * `now` (a clock skew, never real data) reads as "today", never the future.
 */
export function formatRelativePast(
  locale: string,
  from: Date,
  now: Date,
  timeZone: string,
): string {
  const days = Math.max(
    0,
    localDayNumber(now, timeZone) - localDayNumber(from, timeZone),
  );
  if (days < 30) {
    return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(
      -days,
      "day",
    );
  }
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "always" });
  if (days < 365) return rtf.format(-Math.round(days / 30), "month");
  return rtf.format(-Math.round(days / 365), "year");
}
