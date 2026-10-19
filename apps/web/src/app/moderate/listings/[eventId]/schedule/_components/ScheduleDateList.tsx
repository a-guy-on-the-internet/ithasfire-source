"use client";

import { useEffect, useMemo, useRef } from "react";
import { CalendarCheck, CalendarX } from "lucide-react";
import { DateTime, Text, useTranslations } from "@th/ui";

import styles from "./ListingSchedule.module.css";

export type ScheduleRow = {
  eventDateId: string;
  startsAt: Date;
  status: "SCHEDULED" | "CANCELLED";
  /** The VIEWER's own RSVP. FR-004: there is no public per-date count. */
  viewerRsvped: boolean;
  /**
   * MODERATOR-ONLY: whether anyone at all holds an RSVP on this date. A
   * boolean, never a count. Absent when the read did not carry it.
   */
  hasRsvp?: boolean;
};

export type ScheduleDateListProps = {
  /** Upcoming occurrences, ascending, every status. */
  rows: readonly ScheduleRow[];
  /** IANA zone of the listing. Dates are venue-local, always. */
  timezone: string;
  locale: string;
  /**
   * Dates a STAGED rule change would take off the schedule. Marked in place,
   * beside the date, rather than only counted in the band above — a number is
   * what happened, the marks are which ones.
   */
  doomedIds: ReadonlySet<string>;
  /**
   * The subset of `doomedIds` the new rule still WANTS but cannot reach in one
   * expansion pass. Marked separately because the moderator did not ask for
   * these and would not otherwise connect them to the edit they just made —
   * they are the cap's collateral, not the rule's intent.
   */
  outOfReachIds: ReadonlySet<string>;
  /** Per-date in-flight set — busies and inerts that one row's control. */
  pendingIds: ReadonlySet<string>;
  onCallOff: (row: ScheduleRow) => void;
  onPutBack: (row: ScheduleRow) => void;
  /**
   * True while the call-off confirm is showing. It closing with the night not
   * pending is "Keep this date": the pressed id is dropped so a later re-read
   * cannot act on it.
   */
  callOffConfirmOpen?: boolean;
  /**
   * False on a taken-down or ended listing: the server refuses to restore a
   * night there, so a called-off night shows its tag and no button.
   */
  canPutBack?: boolean;
};

/** One upcoming month's worth of dates. */
type MonthGroup = {
  /** Locale-independent `YYYY-MM` grouping key. Never rendered. */
  key: string;
  /** "September 2026" — rendered, so locale-formatted. */
  label: string;
  rows: ScheduleRow[];
};

/**
 * Splits ascending dates into consecutive month runs.
 *
 * The grouping key is formatted with a FIXED locale (`en-CA` → `2026-09`)
 * because it is an identity, not copy — using one string for both would move
 * React keys when the locale changes.
 */
function groupByMonth(
  rows: readonly ScheduleRow[],
  timezone: string,
  locale: string,
): MonthGroup[] {
  const keyFormat = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    timeZone: timezone,
  });
  const labelFormat = new Intl.DateTimeFormat(locale, {
    month: "long",
    year: "numeric",
    timeZone: timezone,
  });
  const groups: MonthGroup[] = [];
  for (const row of rows) {
    const key = keyFormat.format(row.startsAt);
    const current = groups[groups.length - 1];
    if (current?.key === key) current.rows.push(row);
    else {
      groups.push({ key, label: labelFormat.format(row.startsAt), rows: [row] });
    }
  }
  return groups;
}

/**
 * Every loaded date of a community listing, grouped by month, in its own
 * scrollport — see `.list` in the stylesheet for why it is contained here and
 * why it is taller than the public event page's peephole.
 *
 * A called-off night STAYS in the list, struck through, until it passes: it is
 * the only place a moderator can put it back, and dropping it would say "that
 * date was never on the schedule" when what happened is "that date is off".
 */
export function ScheduleDateList({
  rows,
  timezone,
  locale,
  doomedIds,
  outOfReachIds,
  pendingIds,
  onCallOff,
  onPutBack,
  canPutBack = true,
  callOffConfirmOpen = false,
}: ScheduleDateListProps) {
  const t = useTranslations();
  const groups = useMemo(
    () => groupByMonth(rows, timezone, locale),
    [rows, timezone, locale],
  );

  const listRef = useRef<HTMLDivElement>(null);
  /**
   * The night whose Call off was last pressed. On a closed listing a
   * called-off night has no Put back, so the button the moderator pressed
   * unmounts once the re-read lands and focus would fall to <body>. When that
   * happens, focus moves to the row itself, which reads its date and
   * "Called off".
   */
  const calledOffIdRef = useRef<string | null>(null);
  const wasConfirmOpenRef = useRef(false);
  useEffect(() => {
    const wasOpen = wasConfirmOpenRef.current;
    wasConfirmOpenRef.current = callOffConfirmOpen;
    const pressed = calledOffIdRef.current;
    // Confirm closed and the night never went pending: "Keep this date".
    if (wasOpen && !callOffConfirmOpen && pressed && !pendingIds.has(pressed)) {
      calledOffIdRef.current = null;
    }
    // The write settled (pending went away) on an open listing: nothing left
    // to hand focus to, so the id must not linger either.
    if (canPutBack && pressed && !callOffConfirmOpen && !pendingIds.has(pressed)) {
      calledOffIdRef.current = null;
    }
  }, [callOffConfirmOpen, pendingIds, canPutBack]);
  useEffect(() => {
    const id = calledOffIdRef.current;
    if (canPutBack || id === null) return;
    const row = rows.find((r) => r.eventDateId === id);
    if (row?.status !== "CANCELLED") return;
    calledOffIdRef.current = null;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    const rowEls =
      listRef.current?.querySelectorAll<HTMLElement>("[data-event-date-id]") ?? [];
    for (const el of rowEls) {
      if (el.dataset.eventDateId === id) {
        el.focus();
        break;
      }
    }
  }, [rows, canPutBack]);

  /** "Wed, Sep 16 · 8:00 PM" — the full, unambiguous accessible label. */
  const fullOf = (row: ScheduleRow) =>
    DateTime.format(row.startsAt, "meta", { timeZone: timezone, locale });

  return (
    <div
      ref={listRef}
      className={styles.list}
      // Focusable + labelled because it scrolls: without this a keyboard
      // reader who tabs past the last visible control has no way to reach the
      // rest of the list.
      tabIndex={0}
      role="group"
      aria-label={String(t("moderation.schedListAria"))}
      data-testid="schedule-date-list"
    >
      {groups.map((group) => (
        <div key={group.key} className={styles.monthGroup}>
          <div className={styles.monthHead}>
            <span className={styles.monthName}>{group.label}</span>
            <span className={styles.monthCount}>
              {String(t("rsvp.monthDateCount", { count: group.rows.length }))}
            </span>
          </div>
          {group.rows.map((row) => {
            const cancelled = row.status === "CANCELLED";
            const doomed = !cancelled && doomedIds.has(row.eventDateId);
            const outOfReach = doomed && outOfReachIds.has(row.eventDateId);
            const busy = pendingIds.has(row.eventDateId);
            const date = fullOf(row);
            const Icon = cancelled ? CalendarCheck : CalendarX;
            const actionless = cancelled && !canPutBack;

            return (
              <div
                key={row.eventDateId}
                className={doomed ? `${styles.row} ${styles.rowDoomed}` : styles.row}
                data-testid="schedule-date-row"
                data-doomed={doomed ? "true" : undefined}
                data-out-of-reach={outOfReach ? "true" : undefined}
                data-status={row.status}
                data-event-date-id={row.eventDateId}
                // Programmatic focus only: where focus lands after a call-off
                // removes the row's only control (see `calledOffIdRef`).
                tabIndex={actionless ? -1 : undefined}
                // The focus target has no control to name it, so it names
                // itself: date and state.
                role={actionless ? "group" : undefined}
                aria-label={
                  actionless
                    ? String(t("rsvp.calledOffRowAria", { date }))
                    : undefined
                }
              >
                <div className={styles.rowDate}>
                  {/* The date primitive's STRING half, rendered into a plain
                      `<time>`. `<DateTime>` itself paints Tamagui atomic
                      classes for font family/size/tracking, which would race
                      this row's mono idiom on equal specificity; `.format()`
                      is the same formatter with no styling attached, so the
                      one source of date truth is kept AND the label idiom is
                      certain. The `datetime` attribute still carries the
                      instant, so copy-paste and calendar detection get the
                      unambiguous value while the text stays venue-local. */}
                  <time
                    dateTime={row.startsAt.toISOString()}
                    className={
                      cancelled
                        ? `${styles.dateText} ${styles.struck}`
                        : styles.dateText
                    }
                  >
                    {date}
                  </time>
                  {cancelled ? (
                    <span className={styles.tagCalledOff}>
                      {String(t("rsvp.calledOff"))}
                    </span>
                  ) : null}
                  {doomed ? (
                    <span className={styles.tagDoomed}>
                      {String(t("moderation.schedComesOffMark"))}
                    </span>
                  ) : null}
                  {/* Second tag, muted, because it qualifies the first rather
                      than replacing it: the date still comes off — this says
                      WHY, and the why is the surprising part. */}
                  {outOfReach ? (
                    <span className={styles.tag}>
                      {String(t("moderation.schedOutOfReachMark"))}
                    </span>
                  ) : null}
                  {/* The ONLY RSVP fact any endpoint exposes is the viewer's
                      own (FR-004 — there is no per-date count, public or
                      moderator). Labelled as such so it cannot be read as
                      "somebody RSVP'd to this night". */}
                  {row.viewerRsvped ? (
                    <span className={styles.tag}>
                      {String(t("moderation.schedYourRsvp"))}
                    </span>
                  ) : null}
                </div>

                {actionless ? null : (
                  <button
                    type="button"
                    className={styles.dateAction}
                    onClick={() => {
                      if (cancelled) {
                        onPutBack(row);
                        return;
                      }
                      calledOffIdRef.current = row.eventDateId;
                      onCallOff(row);
                    }}
                    // The visible label repeats down the list, so the date is
                    // folded into the accessible name.
                    aria-label={String(
                      cancelled
                        ? t("rsvp.putBackAriaForDate", { date })
                        : t("rsvp.callOffAriaForDate", { date }),
                    )}
                    aria-busy={busy || undefined}
                    // aria-disabled, never native `disabled`: the native
                    // attribute yanks the control out of the tab order during
                    // the write and drops keyboard focus to <body> mid-action.
                    // The press is guarded by the caller's pending set.
                    aria-disabled={busy || undefined}
                    data-testid={
                      cancelled ? "schedule-date-put-back" : "schedule-date-call-off"
                    }
                  >
                    {/* Leading icon — it is ABOUT a thing (this night), not a
                        direction. */}
                    <Icon size={13} strokeWidth={2} aria-hidden />
                    {String(cancelled ? t("rsvp.putBack") : t("rsvp.callOff"))}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      ))}
      {rows.length === 0 ? (
        <div className={styles.row}>
          <Text variant="bodySmall" tone="muted">
            {String(t("moderation.schedNoDates"))}
          </Text>
        </div>
      ) : null}
    </div>
  );
}

ScheduleDateList.displayName = "ScheduleDateList";
