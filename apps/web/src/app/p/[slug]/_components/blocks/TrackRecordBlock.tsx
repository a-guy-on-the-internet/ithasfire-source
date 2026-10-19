"use client";

import { useSyncExternalStore } from "react";

import type { PageBlockRecord } from "@th/types/repos/entity-pages";
import type { TrackRecordBlockData } from "@th/core/use-cases/entity-pages/get-public-page";
import { DEFAULT_VENUE_TIMEZONE } from "@th/core/lib/venue-local-time";
import { useFormatters, useTranslations } from "@th/ui";

import { useFeatureGates } from "@/hooks/useFeatureGates";

import { BlockSection, BlockHeading } from "./block-primitives";
import { useBlockPageOwner } from "./block-page-owner-context";
import { useBlockRenderMode } from "./block-render-context";
import { ReviewTierStamp } from "./review-tier";
import styles from "./block-primitives.module.css";
import tr from "./TrackRecordBlock.module.css";

type Props = {
  block: PageBlockRecord;
};

type Formatters = ReturnType<typeof useFormatters>;

/**
 * Cadence bucket → copy key. `cadenceSince` is the start of the current run,
 * so the sentence is "Weekly since Apr", never a bare adverb.
 */
const CADENCE_KEYS: Record<
  NonNullable<TrackRecordBlockData["cadence"]>,
  string
> = {
  weekly: "trackRecord.cadenceWeekly",
  fortnightly: "trackRecord.cadenceFortnightly",
  monthly: "trackRecord.cadenceMonthly",
  occasional: "trackRecord.cadenceOccasional",
};

/**
 * True once hydrated, false during SSR and the hydrating render. The ONLY
 * consumer is the "9 days ago" line: it is measured against the browser
 * clock, and the public page is ISR-cached for 60s (and CDN-cached beyond
 * that), so an SSR'd relative day count is stale by construction and would
 * mismatch the client's on hydration. The absolute date beside it is the
 * primary value and is always in the HTML; the relative line is a client-only
 * refinement, exactly as a live clock would be.
 */
function useIsClient(): boolean {
  return useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
}

/** "Mar 2024" — month + year, for the first show and any date not this year. */
function formatMonthYear(fmt: Formatters, iso: string, timeZone: string): string {
  return fmt.dateTime(iso, { month: "short", year: "numeric", timeZone });
}

/** "Sep 15" / "Sep 15, 2024". */
function formatDay(
  fmt: Formatters,
  iso: string,
  timeZone: string,
  withYear: boolean,
): string {
  return fmt.dateTime(iso, {
    month: "short",
    day: "numeric",
    ...(withYear ? { year: "numeric" as const } : {}),
    timeZone,
  });
}

/** "Apr" / "Nov 2025" — the cadence run's start month. */
function formatMonth(
  fmt: Formatters,
  iso: string,
  timeZone: string,
  withYear: boolean,
): string {
  return fmt.dateTime(iso, {
    month: "short",
    ...(withYear ? { year: "numeric" as const } : {}),
    timeZone,
  });
}

/**
 * The calendar year of an instant in the VENUE's zone. Not `getUTCFullYear`:
 * a show ending late on Dec 31 local is already Jan 1 UTC.
 */
export function yearOf(iso: string, timeZone: string): number {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return Number.NaN;
  return Number(
    new Intl.DateTimeFormat("en-US", { year: "numeric", timeZone }).format(d),
  );
}

/**
 * "9 days ago" / "yesterday" / "3 months ago". Coarse buckets on purpose:
 * `lastShowAt` is an `endsAt`, and "how long since the room was last used" is
 * the fact, not the hour. Returns null on a malformed instant or a runtime
 * without `Intl.RelativeTimeFormat` — the absolute date already carries the
 * value, so the line is simply omitted.
 */
export function formatRelativeDays(
  locale: string,
  iso: string,
  nowMs: number,
): string | null {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  try {
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
    const days = Math.round((then - nowMs) / 86_400_000);
    if (Math.abs(days) < 30) return rtf.format(days, "day");
    const months = Math.round(days / 30);
    if (Math.abs(months) < 12) return rtf.format(months, "month");
    return rtf.format(Math.round(days / 365), "year");
  } catch {
    return null;
  }
}

/**
 * `yearsRunning` arrives floored to a half (2.5 → "2½"). The glyph is a real
 * fraction, not "2.5" — this is a figure on a stub, not a spreadsheet cell.
 */
export function formatHalfYears(years: number): string {
  const whole = Math.floor(years);
  const half = years - whole >= 0.5;
  if (whole === 0) return half ? "½" : "0";
  return half ? `${whole}½` : String(whole);
}

/**
 * The venue's track record — what has actually happened in the room
 * (venue-track-record-and-review-switch R8/R9, FR-011, FR-015). "Ledger" from
 * the From-the-Door artifact: the THE DOOR stamp, three figures on a rule,
 * one cadence line, then who has played here.
 *
 * SECURITY: trust ONLY the server-injected `dataSource: "track_record"`
 * payload (same discipline as `venue_stats`). Owner-stored data can never
 * carry the marker — block-config strips everything but `heading`. No marker
 * → render nothing.
 *
 * PINNED (R6): the block is always on the page. With zero shows it renders
 * the empty state rather than vanishing — absence would read as the venue
 * having removed it, which is the one thing it cannot do.
 *
 * NO ATTENDANCE HERE (R4/NFR-004): the payload has no checked-in field and
 * this file must never grow one. The band lives inside the request-to-play
 * surface only (`RequestToPlayStatsLine`).
 *
 * ACT LINKS are gate-aware: `/humans/*` 404s while `humanProfilesPublic` is
 * off, so a name is a link only when the gate is on AND the act has a page.
 * The gate is read the way the human page reads it (server-seeded, then the
 * feature-gates query), so SSR and the client agree.
 */
export function TrackRecordBlock({ block }: Props) {
  const t = useTranslations();
  const fmt = useFormatters();
  const mode = useBlockRenderMode();
  const owner = useBlockPageOwner();
  const { gates } = useFeatureGates();
  const isClient = useIsClient();

  // Owner editor: stored data has no server marker (get-my-page doesn't
  // inject track_record), so show the labelled placeholder — same treatment
  // as the sibling stats blocks. The copy says it is pinned and not editable.
  if (mode === "editor") {
    return (
      <div className={styles.editorPlaceholder}>
        <span className={styles.editorPlaceholderLabel}>
          {String(t("admin.peBlockKindTrackRecord"))}
        </span>
        <p className={styles.editorPlaceholderHint}>
          {String(t("admin.peBlockFieldTrackRecordHelp"))}
        </p>
      </div>
    );
  }

  const data = block.data as Partial<TrackRecordBlockData> | undefined;
  if (data?.dataSource !== "track_record") return null;

  const heading = data.heading?.trim() || String(t("trackRecord.heading"));
  // The VENUE's IANA zone, carried IN the payload (spec FU-001). The three
  // dates are `endsAt` instants, and a Nashville show ending 23:00 CDT is
  // already the next UTC day — any zone but the venue's prints most US shows
  // a day late. As data it is identical on the server and in the browser,
  // which is what keeps the SSR'd date hydration-safe; "the viewer's zone"
  // would not be. The fallback covers a payload from before the field
  // existed (a stale ISR entry or pre-column cache), never the live loader.
  const timeZone = data.timeZone ?? DEFAULT_VENUE_TIMEZONE;
  // FR-015: the landmark's name carries the provenance, so a screen reader
  // moving between regions hears which side of the door each block is.
  const sectionLabel = String(t("trackRecord.blockLabel", { heading }));
  const showsHosted = data.showsHosted ?? 0;
  const empty = !(showsHosted > 0) || !data.firstShowAt || !data.lastShowAt;

  if (empty) {
    return (
      <BlockSection className={tr.section} aria-label={sectionLabel}>
        <ReviewTierStamp>{String(t("trackRecord.tier"))}</ReviewTierStamp>
        <BlockHeading>{heading}</BlockHeading>
        <p className={tr.empty}>{String(t("trackRecord.empty"))}</p>
        <p className={tr.foot}>{String(t("trackRecord.footEmpty"))}</p>
      </BlockSection>
    );
  }

  const firstShowAt = data.firstShowAt as string;
  const lastShowAt = data.lastShowAt as string;
  const showsThisYear = data.showsThisYear ?? 0;
  const yearsRunning = data.yearsRunning ?? null;
  const recentActs = data.recentActs ?? [];
  const allActsCount = data.allActsCount ?? recentActs.length;
  const actsLinkable = gates?.humanProfilesPublic === true;
  // The Roster page (FR-016) hangs off the slug the reader arrived on. No
  // owner context (a non-place render) → the count stays, the link goes.
  const actsHref = owner?.place?.pageSlug
    ? `/p/${owner.place.pageSlug}/acts`
    : null;

  // "This year" is the venue's calendar year, derived server-side. It doubles
  // as the deterministic signal for whether the last show needs its year
  // spelled out — no `new Date()` in the SSR path.
  const lastShowIsThisYear = showsThisYear > 0;
  const lastShowRelative = isClient
    ? formatRelativeDays(fmt.locale, lastShowAt, Date.now())
    : null;

  const cadenceLine =
    data.cadence && data.cadenceSince
      ? String(
          t(CADENCE_KEYS[data.cadence], {
            since: formatMonth(
              fmt,
              data.cadenceSince,
              timeZone,
              yearOf(data.cadenceSince, timeZone) !== yearOf(lastShowAt, timeZone),
            ),
          }),
        )
      : null;

  return (
    <BlockSection className={tr.section} aria-label={sectionLabel}>
      <ReviewTierStamp>{String(t("trackRecord.tier"))}</ReviewTierStamp>
      <BlockHeading>{heading}</BlockHeading>

      <dl className={tr.ledger}>
        <div className={tr.cell}>
          <dt className={tr.term}>{String(t("trackRecord.showsHosted"))}</dt>
          <dd className={tr.figure}>
            {fmt.number(showsHosted)}
            {/* A quiet year is said, not left blank (ruled 2026-09-25): the
                absence of shows this year is the signal, not missing data. */}
            <small className={tr.sub}>
              {showsThisYear > 0
                ? String(t("trackRecord.thisYear", { count: showsThisYear }))
                : String(t("trackRecord.thisYearNone"))}
            </small>
          </dd>
        </div>

        <div className={tr.cell}>
          <dt className={tr.term}>{String(t("trackRecord.firstShow"))}</dt>
          <dd className={`${tr.figure} ${tr.figureDate}`}>
            <time dateTime={firstShowAt}>
              {formatMonthYear(fmt, firstShowAt, timeZone)}
            </time>
            {yearsRunning != null && yearsRunning > 0 && (
              <small className={tr.sub}>
                {yearsRunning < 1
                  ? String(t("trackRecord.yearsRunningHalf"))
                  : yearsRunning === 1
                    ? String(t("trackRecord.yearsRunningOne"))
                    : String(
                        t("trackRecord.yearsRunning", {
                          years: formatHalfYears(yearsRunning),
                        }),
                      )}
              </small>
            )}
          </dd>
        </div>

        <div className={tr.cell}>
          <dt className={tr.term}>{String(t("trackRecord.lastShow"))}</dt>
          <dd className={`${tr.figure} ${tr.figureDate}`}>
            <time dateTime={lastShowAt}>
              {formatDay(fmt, lastShowAt, timeZone, !lastShowIsThisYear)}
            </time>
            {lastShowRelative && (
              <small className={tr.sub}>{lastShowRelative}</small>
            )}
          </dd>
        </div>
      </dl>

      {cadenceLine && <p className={tr.cadence}>{cadenceLine}</p>}

      {recentActs.length > 0 && (
        <div className={tr.acts}>
          <p className={tr.actsLabel}>
            <span>{String(t("trackRecord.playedRecently"))}</span>
            {actsHref ? (
              <a className={tr.actsAll} href={actsHref}>
                {String(t("trackRecord.allActs", { count: allActsCount }))}
                <span aria-hidden="true"> →</span>
              </a>
            ) : (
              <span className={tr.actsAll}>
                {String(t("trackRecord.allActs", { count: allActsCount }))}
              </span>
            )}
          </p>
          {/* `role="list"` is explicit: `list-style: none` strips the list
              semantics in WebKit/VoiceOver, and the list IS the point. */}
          <ul className={tr.actsList} role="list">
            {recentActs.map((act) => (
              // Core's opaque per-act key: two acts can share a name (a linked
              // "Sam" with no public page and an unlinked "Sam"), so name +
              // profileUrl collides.
              <li className={tr.actsItem} key={act.key}>
                {actsLinkable && act.profileUrl ? (
                  <a className={tr.actLink} href={act.profileUrl}>
                    {act.name}
                  </a>
                ) : (
                  <span>{act.name}</span>
                )}
                {act.timesPlayed > 1 && (
                  <span className={tr.times}>
                    <span aria-hidden="true">×{fmt.number(act.timesPlayed)}</span>
                    <span className={tr.srOnly}>
                      {String(
                        t("trackRecord.timesPlayed", { count: act.timesPlayed }),
                      )}
                    </span>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className={tr.foot}>{String(t("trackRecord.foot"))}</p>
    </BlockSection>
  );
}
