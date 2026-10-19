"use client";

// NOT NextLinkAnchor: its inline base style (`color:inherit`) outranks the
// CSS-module rules, which would silently kill the tile's ink/paper hover
// inversion and the back link's themed colour. A bare next/link <a> is what
// CSS-module strict-Swiss styling needs (same call EntityPageTabs makes).
// eslint-disable-next-line no-restricted-imports
import Link from "next/link";
import { useFormatters, useTranslations } from "@th/ui";

import { ReviewTierStamp } from "@/app/p/[slug]/_components/blocks/review-tier";
import {
  formatRelativePast,
  groupRoster,
  type RosterAct,
  type TrackRecordSummary,
} from "./roster-helpers";
import s from "./ActsRoster.module.css";

/* ── ActsRoster ─────────────────────────────────────────────────────────────
 *
 * Every act that has played a venue (venue-track-record-and-review-switch
 * FR-016, ruling R9 "Roster"). Opens with THE DOOR stamp — the same box the
 * venue page's track-record block wears — so a reader arriving from the
 * "All N acts →" link knows this is the same provenance: built from published
 * shows that happened, not from anything anyone said.
 *
 * Two groups. REGULARS are the room's identity (three or more shows here);
 * RECENTLY is everyone else, newest first, and says the room is still open.
 * Each act is a bordered tile with a real tap target; a repeat act carries
 * "×N · last <date>" so it reads as a relationship, not a count.
 *
 * LINKS ARE GATE-AWARE. `/humans/*` 404s while `humanProfilesPublic` is off,
 * so a name only becomes a link when the page passes `linkProfiles` AND the
 * act has a `profileUrl`; otherwise it is text. The page reads the gate the
 * way the human route does, server-side.
 */

type Props = {
  venueName: string;
  /** `/p/{slug}` — the venue page this roster belongs to. */
  venueHref: string;
  acts: ReadonlyArray<RosterAct>;
  summary: TrackRecordSummary;
  /** `humanProfilesPublic` — false renders every name as plain text. */
  linkProfiles: boolean;
  /**
   * IANA zone every date is printed in. Chosen by the SERVER page so SSR and
   * hydration format identically (an implicit zone would differ between the
   * host and the browser and throw the tree away on a text mismatch).
   */
  timeZone: string;
  /** The server's clock at render, ISO. Pins "9 days ago" across hydration. */
  nowIso: string;
};

const DAY_FORMAT: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "numeric",
};

export function ActsRoster({
  venueName,
  venueHref,
  acts,
  summary,
  linkProfiles,
  timeZone,
  nowIso,
}: Props) {
  const t = useTranslations();
  const fmt = useFormatters();
  const now = new Date(nowIso);
  const thisYear = fmt.dateTime(now, { year: "numeric", timeZone });

  /** "Sep 15", or "Jun 2, 2025" once the show is in another year. */
  const formatDay = (iso: string): string => {
    const date = new Date(iso);
    const year = fmt.dateTime(date, { year: "numeric", timeZone });
    return fmt.dateTime(date, {
      ...DAY_FORMAT,
      ...(year === thisYear ? {} : { year: "numeric" }),
      timeZone,
    });
  };

  const { regulars, recently } = groupRoster(acts);

  return (
    <article className={s.roster} aria-labelledby="acts-roster-heading">
      <Link href={venueHref} className={s.backLink}>
        <span aria-hidden="true">←</span>
        {venueName}
      </Link>

      <header className={s.header}>
        <ReviewTierStamp>{t("actsRoster.tier")}</ReviewTierStamp>
        <h1 id="acts-roster-heading" className={s.heading}>
          {t("actsRoster.heading")}
        </h1>
        {summary.showsHosted > 0 ? (
          <p className={s.head}>
            <b>{fmt.number(summary.showsHosted)}</b>{" "}
            <span className={s.dim}>
              {t("actsRoster.headShows", { count: summary.showsHosted })}
            </span>
            {summary.firstShowAt ? (
              <>
                <span className={s.dim}> · {t("actsRoster.headSince")} </span>
                <b>
                  <time dateTime={summary.firstShowAt}>
                    {fmt.dateTime(new Date(summary.firstShowAt), {
                      month: "short",
                      year: "numeric",
                      timeZone,
                    })}
                  </time>
                </b>
              </>
            ) : null}
            {summary.lastShowAt ? (
              <>
                <span className={s.dim}> · {t("actsRoster.headLast")} </span>
                {/* The FIGURE is the absolute day, as on the venue block one
                    click up; the relative phrase stands alone in parentheses
                    after it. Never "last yesterday" / "último ayer". */}
                <b>
                  <time dateTime={summary.lastShowAt}>
                    {formatDay(summary.lastShowAt)}
                  </time>
                </b>{" "}
                <span className={s.dim}>
                  (
                  {formatRelativePast(
                    fmt.locale,
                    new Date(summary.lastShowAt),
                    now,
                    timeZone,
                  )}
                  )
                </span>
              </>
            ) : null}
          </p>
        ) : null}
      </header>

      {acts.length === 0 ? (
        // Shows hosted but no public lineups: the header just said "38 shows",
        // so "nobody's played here" would contradict it. Say what is missing.
        <p className={s.empty}>
          {t(
            summary.showsHosted > 0
              ? "actsRoster.emptyNoLineups"
              : "actsRoster.empty",
          )}
        </p>
      ) : (
        <>
          {regulars.length > 0 ? (
            <RosterGroup
              id="acts-roster-regulars"
              label={t("actsRoster.regulars")}
              acts={regulars}
              linkProfiles={linkProfiles}
              formatDay={formatDay}
              t={t}
            />
          ) : null}
          {recently.length > 0 ? (
            <RosterGroup
              id="acts-roster-recently"
              label={t("actsRoster.recently")}
              acts={recently}
              linkProfiles={linkProfiles}
              formatDay={formatDay}
              t={t}
            />
          ) : null}
        </>
      )}

      <p className={s.foot}>{t("actsRoster.foot")}</p>
    </article>
  );
}

type GroupProps = {
  id: string;
  label: string;
  acts: ReadonlyArray<RosterAct>;
  linkProfiles: boolean;
  formatDay: (iso: string) => string;
  t: ReturnType<typeof useTranslations>;
};

function RosterGroup({ id, label, acts, linkProfiles, formatDay, t }: GroupProps) {
  return (
    <section className={s.group} aria-labelledby={id}>
      <h2 id={id} className={s.groupLabel}>
        {label}
      </h2>
      {/* A real <ul> (NFR-006): assistive tech announces the count and lets a
          reader jump act by act. */}
      <ul className={s.grid}>
        {acts.map((act) => {
          const day = formatDay(act.lastPlayedAt);
          const body = (
            <>
              {/* `title` carries the full name past the ellipsis. */}
              <span className={s.name} title={act.name}>
                {act.name}
              </span>
              {/* The whole line is the <time> (NFR-006): its `dateTime` is the
                  last show, whether the text is "Sep 15" or "×5 · last Sep 15"
                  — an ICU message cannot carry an element inside it. */}
              <time className={s.meta} dateTime={act.lastPlayedAt}>
                {act.timesPlayed > 1
                  ? t("actsRoster.tileMeta", { times: act.timesPlayed, date: day })
                  : day}
              </time>
            </>
          );
          const href = linkProfiles ? act.profileUrl : null;
          return (
            // Core's opaque per-act key — name + profileUrl collides for two
            // same-name acts without a public page.
            <li key={act.key} className={s.item}>
              {href ? (
                <Link href={href} className={s.tile}>
                  {body}
                </Link>
              ) : (
                <span className={s.tile}>{body}</span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
