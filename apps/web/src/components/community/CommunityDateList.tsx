"use client";

import { ArrowRight, CalendarCheck, CalendarX, Check } from "lucide-react";
import { Fragment, useEffect, useId, useMemo, useState } from "react";
import { Text, useFormatters, useTranslations } from "@th/ui";

import { ConfirmDialog } from "@/components/data-table/ConfirmDialog";
import type {
  CommunityEventDate,
  CommunityRecurrenceSummary,
} from "@/server/events";
import { cadenceMessage } from "./cadence-message";
import styles from "./CommunityDateList.module.css";
import { useDateModeration } from "./use-date-moderation";
import { useDateRsvpList, type DateRsvpRow } from "./use-date-rsvp-list";

/** DOM id the "See dates" primary scrolls to for recurring listings. */
export const COMMUNITY_DATES_ANCHOR_ID = "community-upcoming-dates";

/**
 * Where the moderator bar's "Manage schedule" link points — the full schedule
 * surface, which owns the bulk work this inline strip deliberately does not
 * (rewriting the rule, a date's time, a run of nights).
 */
export function moderateScheduleHref(eventId: string): string {
  return `/moderate/listings/${eventId}/schedule`;
}

/**
 * How many dates follow the NEXT card as chips. Past this, the rest live behind
 * the disclosure — a weekly open mic carries 52 upcoming dates and every one of
 * them used to be a full-width row with its own 150px accent button (3,589px of
 * list at 1440w, 5,253px at 390w, and "SIGN IN TO RSVP" printed 52 times).
 */
const THEN_LIMIT = 6;

type DateFormatOptions = Intl.DateTimeFormatOptions;

export type CommunityDateListProps = {
  /** Event UUID (a PUBLISHED recurring RSVP listing). */
  eventId: string;
  /** Server-fetched upcoming dates (seed — avoids a loading flash). */
  initialDates: CommunityEventDate[];
  /** IANA timezone the dates are displayed in. */
  timezone?: string;
  /**
   * Parsed cadence for the "Every Wednesday, 8:00 PM" line, as the server
   * rendered it. Null/undefined → omit that line.
   *
   * A SEED, like `initialDates`: it is handed to {@link useDateRsvpList} and read
   * back from there, so the sentence always describes the same list the dates
   * came from. Reading it straight off the prop is a drift bug — this prop rides
   * an edge-cached document, and the query's payload does not.
   */
  recurrence?: CommunityRecurrenceSummary | null;
  /**
   * True when the loaded list does NOT reach the end of the series — the server
   * caps what it materialises (`MAX_DATES`, and a 12-month window), so an
   * open-ended weekly night hands back 52 dates and stops.
   *
   * Only this flag can tell the two cases apart, and the difference is a factual
   * claim about someone's schedule: with it false the last loaded date IS the
   * end of the run ("52 dates through Sep 2027"); with it true that sentence
   * invents an end date for a night that has none, so the horizon is dropped.
   *
   * It is ALSO half of the zero-dates ruling — see {@link hasRecurrenceRule}.
   *
   * Also a SEED (see `recurrence`) — read back from the hook beside the rows it
   * describes, never from this prop.
   */
  datesTruncated?: boolean;
  /**
   * The occurrence to LEAD with: the first upcoming one still SCHEDULED, or
   * `null` when every upcoming night is called off (or there are none).
   *
   * `initialDates[0]` is NOT a substitute and no longer works: cancelled dates
   * are returned now (that is what lets them be struck through), and a
   * called-off night sorts first like any other — so leading with row zero
   * advertises a night that is off. Also a SEED.
   */
  nextScheduledEventDateId?: string | null;
  /**
   * The listing is driven by a stored recurrence rule.
   *
   * Deliberately NOT derived from `recurrence`, which is null for FIXED_DATES
   * and for any rule the cadence phrasebook cannot state — both of which are
   * very much series. With it true and nothing upcoming still scheduled, this
   * section states the zero-dates case itself rather than letting the page fall
   * back to the event-level RSVP button (see the table below). Also a SEED.
   */
  hasRecurrenceRule?: boolean;
};

/** One upcoming month's worth of dates, as the disclosure groups them. */
type MonthGroup = {
  /** Locale-independent `YYYY-MM` grouping key (never rendered). */
  key: string;
  /** "September 2026" — rendered, so locale-formatted. */
  label: string;
  rows: DateRsvpRow[];
};

/**
 * Splits ascending dates into consecutive month runs.
 *
 * The grouping key is formatted with a FIXED locale (`en-CA` → `2026-09`)
 * because it is an identity, not copy: the visible heading is formatted with
 * the reader's locale separately. Using one string for both would make React
 * keys move when the locale changes.
 */
function groupByMonth(
  rows: DateRsvpRow[],
  formatMonth: (d: Date) => string,
  tz: DateFormatOptions,
): MonthGroup[] {
  const keyFormat = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    ...tz,
  });
  const groups: MonthGroup[] = [];
  for (const row of rows) {
    const key = keyFormat.format(row.startsAt);
    const current = groups[groups.length - 1];
    if (current?.key === key) current.rows.push(row);
    else groups.push({ key, label: formatMonth(row.startsAt), rows: [row] });
  }
  return groups;
}

type ToggleDensity = "primary" | "chip" | "rowToggle";

/**
 * One date's personal RSVP toggle at one of three densities. Same behaviour
 * contract at every size (FR-004: the VIEWER's own state, never a count).
 */
function DateToggle({
  density,
  going,
  busy,
  inert,
  signedIn,
  label,
  ariaLabel,
  iconSize,
  onPress,
}: {
  density: ToggleDensity;
  going: boolean;
  busy: boolean;
  /** Presses are ignored (session resolving, or this date is mid-flight). */
  inert: boolean;
  signedIn: boolean;
  label: string;
  ariaLabel: string;
  iconSize: number;
  onPress: () => void;
}) {
  return (
    <button
      type="button"
      className={styles[density]}
      onClick={onPress}
      // Two-state only once we know there IS a viewer: a sign-in CTA is not a
      // pressed/unpressed control.
      {...(signedIn ? { "aria-pressed": going } : {})}
      aria-busy={busy || undefined}
      // The visible label is "SEP 23", or identical across rows ("I'M GOING"),
      // so the date is folded into the accessible name instead.
      aria-label={ariaLabel}
      // aria-disabled (NOT native disabled): the native attribute would yank
      // this toggle out of the tab order during the brief mutation window,
      // dropping keyboard focus to <body> mid-toggle. Presses are guarded
      // inside `toggle` (early-return on sessionPending / pendingIds).
      aria-disabled={inert || undefined}
      data-testid="community-date-rsvp"
      data-going={going ? "true" : undefined}
    >
      {/* Rendered in BOTH states so flipping one never resizes it — a chip that
          grows on select shifts every chip after it in the row. Signed out
          there is no state to show, so no check. */}
      {signedIn ? (
        <Check
          size={iconSize}
          strokeWidth={3}
          aria-hidden
          className={styles.check}
        />
      ) : null}
      {label}
    </button>
  );
}

/**
 * The per-date moderator control: "Call off" on a live night, "Put back" on one
 * already called off.
 *
 * ONE element for both states, deliberately. `Modal` returns focus to whatever
 * opened it, and calling a night off swaps this control's meaning — render two
 * different buttons and the restore lands on a node React has just unmounted,
 * which drops keyboard focus to `<body>` at exactly the moment a moderator
 * wants to confirm the change took.
 *
 * Quiet by construction — a text link's weight, never a button's: the section's
 * one filled control is the RSVP primary, and a second emphatic button beside
 * it would read as the thing the page wants you to do.
 *
 * It lives on FULL-WIDTH rows only: the NEXT card, and the disclosure's rows.
 * Not on the "then" chips — those are a GLANCE surface answering "when is this
 * on next", and hanging a destructive control on each of them turns a summary
 * into a control panel (and cost 328px of extra section at 320px). Both real
 * jobs survive: "this Wednesday is off" is the NEXT card, "the third Wednesday
 * in March is off" is the disclosure, whose rows have room already.
 */
function ModeratorDateAction({
  cancelled,
  busy,
  label,
  ariaLabel,
  onPress,
}: {
  cancelled: boolean;
  busy: boolean;
  label: string;
  ariaLabel: string;
  onPress: () => void;
}) {
  const Icon = cancelled ? CalendarCheck : CalendarX;
  return (
    <button
      type="button"
      className={styles.modText}
      onClick={onPress}
      aria-label={ariaLabel}
      aria-busy={busy || undefined}
      // aria-disabled, never native `disabled` — same reason as the RSVP
      // toggles: the native attribute drops keyboard focus to <body> mid-write.
      // The press is guarded inside the hook (early-return on pendingIds).
      aria-disabled={busy || undefined}
      data-testid={
        cancelled ? "community-date-put-back" : "community-date-call-off"
      }
    >
      {/* Leading icon — it is ABOUT a thing (this night), not a direction. */}
      <Icon size={13} strokeWidth={2} aria-hidden />
      {label}
    </button>
  );
}

/**
 * "Upcoming dates" for a recurring COMMUNITY listing (recurring-dates spec,
 * slice 4). Leads with the CADENCE, not the enumeration:
 *
 *   1. a moderator bar, when the viewer maintains this listing
 *   2. "Every Wednesday, 8:00 PM" · "Next 52 dates" (or "52 dates through
 *      Sep 2027" when the loaded list really is the whole series)
 *   3. a NEXT card carrying the section's one and only primary button
 *   4. the following six dates as compact chips, each its own RSVP toggle
 *   5. a quiet disclosure holding the full list, grouped by month, in a
 *      fixed-height scroller so the page cannot grow with the rule
 *
 * Signed out there is exactly ONE sign-in affordance (the NEXT card's primary);
 * every other date renders as a plain label. That is the headline fix: the old
 * list printed a sign-in button per date.
 *
 * FR-004: shows ONLY the viewer's own per-date state — never a count.
 *
 * ── CALLED-OFF NIGHTS ───────────────────────────────────────────────────────
 *
 * A night a moderator called off STAYS HERE, struck through and marked "Called
 * off", until it passes — for EVERYONE, not just moderators. Someone who heard
 * "it's on Wednesday" deserves an answer rather than the date quietly vanishing
 * from the list. It carries no RSVP control in any state (the server refuses
 * one), and for a moderator it carries "Put back" instead of "Call off".
 *
 * The strike is event-intrinsic and rides the edge-cached document. The
 * moderator controls beside it cannot, and do not — see
 * {@link useDateModeration}.
 *
 * ── THE ZERO-DATES RULING ───────────────────────────────────────────────────
 *
 * With no upcoming SCHEDULED occurrence:
 *
 *   hasRecurrenceRule && truncated   → drained but live. Cadence line +
 *                                      "next dates are being scheduled".
 *   hasRecurrenceRule && !truncated  → genuinely ended. "This series has
 *                                      ended."
 *   !hasRecurrenceRule               → not our case; the page renders its
 *                                      single-date RSVP button, unchanged.
 *
 * In neither recurring case is there a per-date RSVP, because there is no date
 * to attach one to — and the event-level button is never the answer here: a
 * drained listing's `Event.startsAt` is a past or synthetic instant, so that
 * fallback offers "I'm going" on a night that already happened. That fallback
 * is the defect this branch exists to remove; `EventDetail` gates on the same
 * `hasRecurrenceRule` so it never reaches for the button at all.
 */
export function CommunityDateList({
  eventId,
  initialDates,
  timezone,
  recurrence,
  datesTruncated = false,
  nextScheduledEventDateId = null,
  hasRecurrenceRule = false,
}: CommunityDateListProps) {
  const t = useTranslations();
  const fmt = useFormatters();
  /**
   * `cadence`, `truncated`, `nextId` and `hasRule` come OUT of the hook rather
   * than off the props above, even though the props are what seeded them.
   *
   * The props arrive on the event-page document, which is edge-cached
   * (`s-maxage=120, stale-while-revalidate=300`); `rows` arrive on an uncached
   * query. Mixing the two prints a sentence about a list that is not on screen:
   * replace a bounded rule with an open-ended one and a signed-in viewer loading
   * from a warm edge gets `datesTruncated: false` beside 60 fresh, truncated rows
   * — "60 DATES THROUGH SEP 2027" and "All 60 dates" about a night with no end,
   * which is the exact false horizon this section exists to avoid. The lead date
   * is worse still: a stale `nextScheduledEventDateId` points the NEXT card at a
   * night that has since been called off. The hook resolves all of them from one
   * source; see its return statement.
   */
  const {
    rows,
    recurrence: cadence,
    truncated,
    nextScheduledEventDateId: nextId,
    hasRecurrenceRule: hasRule,
    sessionPending,
    isSignedIn,
    pendingIds,
    toggle,
  } = useDateRsvpList({
    eventId,
    initialDates,
    initialRecurrence: recurrence ?? null,
    initialTruncated: datesTruncated,
    initialNextScheduledEventDateId: nextScheduledEventDateId,
    initialHasRecurrenceRule: hasRecurrenceRule,
  });

  const [showAll, setShowAll] = useState(false);
  const panelId = `community-dates-all-${useId()}`;

  /**
   * `authClient.useSession()` is a CLIENT store, so a server render has no
   * session by construction: `isPending` is true and `isSignedIn` is false
   * there, every time, for everyone. The SSR HTML is therefore always the
   * signed-out shape — and deriving the first CLIENT render from anything else
   * is a hydration mismatch on every load. It was one: the server painted
   * `aria-disabled="true"` on the primary (session pending) while the client
   * painted nothing, and React does not patch attributes up.
   *
   * Gating on "have we mounted yet" makes the first client render identical to
   * the server's by premise rather than by luck. The signed-in shape arrives on
   * the commit right after hydration — which is when it arrived before too, so
   * nothing is slower; only the console error is gone.
   *
   * EVERY session- or role-derived attribute goes through this gate, including
   * the moderator probe below — it is passed `signedIn`, which is already
   * gated, so the moderator bar and the per-date controls are absent from the
   * server render by premise too. That is load-bearing twice over here: the
   * document those bytes land in is edge-cached and shared with strangers.
   */
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    setHydrated(true);
  }, []);
  const signedIn = hydrated && isSignedIn;
  const sessionResolving = hydrated && sessionPending;

  const moderation = useDateModeration({ eventId, enabled: signedIn });
  const { isModerator } = moderation;

  /** The date awaiting confirmation, or null. A call-off emails people. */
  const [confirming, setConfirming] = useState<DateRsvpRow | null>(null);

  const tz = useMemo<DateFormatOptions>(
    () => (timezone ? { timeZone: timezone } : {}),
    [timezone],
  );

  /** "8:00 PM" */
  const timeOf = (d: Date) =>
    fmt.dateTime(d, { hour: "numeric", minute: "2-digit", ...tz });
  /** "Wed, Sep 16 · 8:00 PM" — the full, unambiguous label. */
  const fullOf = (d: Date) =>
    `${fmt.dateTime(d, {
      weekday: "short",
      month: "short",
      day: "numeric",
      ...tz,
    })} · ${timeOf(d)}`;
  /** "Sep 23" — a chip. */
  const chipOf = (d: Date) =>
    fmt.dateTime(d, { month: "short", day: "numeric", ...tz });
  /**
   * A row inside the full list. Drops the clock when the cadence line above
   * already states it — a recurring rule fires at the same local time every
   * occurrence, so 52 repetitions of "8:00 PM" buy nothing and cost the row its
   * fit: measured at 320px, "TUE, SEP 15 · 8:30 PM" (175px) leaves 218px of row
   * to also hold a 92px toggle, so every row wrapped to two lines. Without a
   * cadence line nothing else states the time, so it stays.
   *
   * The MONTH stays either way: `{weekday, day}` alone renders "15 Tue" in
   * en-US — Intl orders the parts, and dropping the month flips the pair.
   */
  const monthRowOf = (d: Date) =>
    cadence
      ? fmt.dateTime(d, {
          weekday: "short",
          month: "short",
          day: "numeric",
          ...tz,
        })
      : fullOf(d);

  const monthGroups = useMemo(
    () =>
      showAll
        ? groupByMonth(
            rows,
            (d) => fmt.dateTime(d, { month: "long", year: "numeric", ...tz }),
            tz,
          )
        : [],
    [showAll, rows, fmt, tz],
  );

  const first = rows[0];
  const last = rows[rows.length - 1];

  /**
   * The occurrence the section LEADS with. Resolved by id from the server's
   * answer, never as `rows[0]`: cancelled dates are in `rows` now, they sort
   * first like any other, and leading with one advertises a night that is off.
   *
   * The `find`-by-status fallback covers only an id/rows mismatch (a seed from
   * one payload beside rows from another, for the beat before the query
   * settles). It still cannot pick a cancelled row — which is the property that
   * matters — and `null` stays `null`, because `null` is a real answer here: it
   * is the zero-dates state.
   */
  const next =
    (nextId ? rows.find((row) => row.eventDateId === nextId) : undefined) ??
    (nextId ? rows.find((row) => row.status === "SCHEDULED") : undefined) ??
    null;

  /**
   * A recurring listing with nothing upcoming still scheduled. `truncated`
   * separates the two halves — see the component header.
   */
  const zeroState: "PENDING" | "ENDED" | null =
    hasRule && !next ? (truncated ? "PENDING" : "ENDED") : null;

  /**
   * "Every Wednesday, 8:00 PM". Omitted outright when the server has no rule to
   * summarise — a cadence inferred from the deltas between dates would be a
   * guess, and a confidently wrong sentence is worse than no sentence.
   *
   * The sentence itself comes from {@link cadenceMessage}, which the
   * moderator's schedule page renders through as well, so both surfaces
   * describe one rule with one sentence. It reads the weekday NAMES off the
   * real occurrences (locale-correct for free) and drops a day list it cannot
   * fill rather than half-stating a rule; `byday` and `interval` only decide
   * WHICH sentence to build.
   *
   * The clock is read off `rows[0]` whatever its STATUS: a called-off night is
   * still an occurrence the rule produced at the rule's time, so a drained
   * listing whose remaining rows are all cancelled can still state its cadence.
   * That is half of what the "drained but live" state is supposed to say.
   */
  const cadenceLine = (() => {
    if (!cadence || !first) return null;
    const message = cadenceMessage({
      recurrence: cadence,
      dates: rows,
      time: timeOf(first.startsAt),
      timezone,
      locale: fmt.locale,
    });
    return message ? String(t(message.key, message.values)) : null;
  })();

  /**
   * The span meta line, in two flavours, because only ONE of them is a true
   * sentence at a time.
   *
   * Unbounded list (`truncated`) → "Next 52 dates", no horizon at all. The
   * server caps what it materialises (MAX_DATES = 60, inside a 12-month window),
   * so the last LOADED date is just where the loader stopped — printing "through
   * Sep 2027" there tells a reader that an open-ended weekly night ends next
   * September, and tells a daily listing it ends in two months.
   *
   * Complete list → "52 dates through Sep 2027". Still the last LOADED date
   * rather than `cadence.until` (an UNTIL can fall after the final
   * occurrence), and with nothing truncated the two agree anyway.
   *
   * Dropped entirely in the zero-dates state: with every remaining row called
   * off, both phrasings count nights that are not happening, and the notice
   * below is the sentence that is actually true.
   */
  const spanLine =
    !last || zeroState
      ? null
      : truncated
        ? String(t("rsvp.datesNext", { count: rows.length }))
        : String(
            t("rsvp.datesThrough", {
              count: rows.length,
              through: fmt.dateTime(last.startsAt, {
                month: "short",
                year: "numeric",
                ...tz,
              }),
            }),
          );

  // Nothing to say and no rule to say it about — a non-recurring listing gets
  // its single RSVP button from the page instead. A recurring one always has a
  // zeroState to state, even with zero rows.
  if (!first && !zeroState) return null;

  /**
   * Everything after the lead, in chronological order. Filtering by IDENTITY
   * rather than slicing from index 1: with `next` chosen by status, a night
   * called off BEFORE it still sorts ahead of it, and it belongs in the list —
   * struck through, where it visibly explains why the lead skipped forward.
   */
  const thenRows = rows.filter((row) => row !== next).slice(0, THEN_LIMIT);
  const visibleCount = (next ? 1 : 0) + thenRows.length;
  /**
   * True when the panel would hold nothing the reader cannot already see. For
   * anyone but a moderator that means no disclosure at all — 2 or 3 dates
   * should read as deliberate, not as a stub with a collapsed empty drawer.
   */
  const panelAddsNothingVisible = rows.length <= visibleCount;
  /**
   * A moderator gets the disclosure whatever the count, because for them the
   * panel is not "the rest of the list", it is the CONTROL SURFACE: the
   * full-width rows are the only place a specific date can be called off or put
   * back, now that the chips carry nothing.
   *
   * Without this there is a state with no inline way out. Every remaining night
   * called off, few enough of them that nothing is hidden, and so no NEXT card
   * to hang a control on either — a moderator can then SEE a called-off night
   * and have no way to put it back except leaving for /moderate. The approved
   * design says a called-off night shows moderators a "Put back" control, and
   * "one named click away on another page" is a weaker promise than that.
   *
   * Do not fold this back into the count test.
   */
  const showDisclosure = !panelAddsNothingVisible || (isModerator && rows.length > 0);

  const labelFor = (row: DateRsvpRow) =>
    !signedIn
      ? String(t("rsvp.signInToRsvp"))
      : row.viewerRsvped
        ? String(t("rsvp.going"))
        : String(t("rsvp.imGoing"));

  const ariaFor = (row: DateRsvpRow) =>
    !signedIn
      ? String(t("rsvp.signInToRsvp"))
      : row.viewerRsvped
        ? String(t("rsvp.goingAriaForDate", { date: fullOf(row.startsAt) }))
        : String(t("rsvp.toggleAriaForDate", { date: fullOf(row.startsAt) }));

  const modBusy = (row: DateRsvpRow) =>
    moderation.pendingIds.has(row.eventDateId);

  /**
   * "Call off" / "Put back" for one row. Full-width rows only — the NEXT card
   * and the disclosure's rows; see {@link ModeratorDateAction}.
   */
  const renderModAction = (row: DateRsvpRow) => {
    const cancelled = row.status === "CANCELLED";
    const date = fullOf(row.startsAt);
    return (
      <ModeratorDateAction
        cancelled={cancelled}
        busy={modBusy(row)}
        label={String(cancelled ? t("rsvp.putBack") : t("rsvp.callOff"))}
        ariaLabel={String(
          cancelled
            ? t("rsvp.putBackAriaForDate", { date })
            : t("rsvp.callOffAriaForDate", { date }),
        )}
        onPress={() => {
          // Restoring is additive and reversible, so it goes straight through.
          // Calling off emails everyone holding a live RSVP on that night —
          // that must never be one stray tap.
          if (cancelled) moderation.putBack(row.eventDateId);
          else setConfirming(row);
        }}
      />
    );
  };

  /** "SEP 23 · CALLED OFF" — the chip-row rendering of a night that is off. */
  const calledOffChip = (row: DateRsvpRow) => (
    <span className={styles.calledOffChip}>
      {/* The strike is the GLANCE signal and announces nothing; the word is
          what a screen reader reads. Both, always. */}
      <span className={styles.struck}>{chipOf(row.startsAt)}</span>
      <span className={styles.calledOffMark}>{String(t("rsvp.calledOff"))}</span>
    </span>
  );

  return (
    <div
      id={COMMUNITY_DATES_ANCHOR_ID}
      data-testid="community-date-list"
      className={styles.root}
      style={{ scrollMarginTop: 88 }}
    >
      {isModerator ? (
        /* Two things only: the stamp, and the way out to the full surface.
           There is deliberately no sentence explaining that the reader is a
           moderator — the stamp says it, and the row of controls below says it
           again. At a 240px column that sentence cost the bar a third line. */
        <div className={styles.modBar} data-testid="community-date-mod-bar">
          <span className={styles.modTag}>
            {String(t("rsvp.moderatorTag"))}
          </span>
          {/* A plain anchor, not next/link: this crosses into the gated
              /moderate shell, where a full load is what re-runs the edge gate
              rather than soft-navigating around it. */}
          <a
            className={styles.modLink}
            href={moderateScheduleHref(eventId)}
            data-testid="community-date-manage-schedule"
          >
            {String(t("rsvp.manageSchedule"))}
            <ArrowRight
              size={13}
              strokeWidth={2.5}
              aria-hidden
              className={styles.modLinkIcon}
            />
          </a>
        </div>
      ) : null}

      {cadenceLine ? (
        <div className={styles.cadence} data-testid="community-date-cadence">
          <span className={styles.cadenceRule}>{cadenceLine}</span>
          {spanLine ? (
            <span className={styles.cadenceSpan}>{spanLine}</span>
          ) : null}
        </div>
      ) : null}

      {next ? (
        <div className={styles.nextCard}>
          <div className={styles.nextMeta}>
            <Text variant="overline" tone="muted">
              {String(t("rsvp.nextLabel"))}
            </Text>
            <span className={styles.nextDate}>{fullOf(next.startsAt)}</span>
          </div>
          <div className={styles.nextActions}>
            <DateToggle
              density="primary"
              going={next.viewerRsvped}
              busy={pendingIds.has(next.eventDateId)}
              inert={pendingIds.has(next.eventDateId) || sessionResolving}
              signedIn={signedIn}
              label={labelFor(next)}
              ariaLabel={ariaFor(next)}
              iconSize={16}
              onPress={() => toggle(next)}
            />
            {isModerator ? renderModAction(next) : null}
          </div>
        </div>
      ) : zeroState ? (
        /* The zero-dates notice replaces the NEXT card — and with it the one
           RSVP primary. `role="status"` so a moderator who has just called the
           last live night off hears the section change under them. */
        <div
          className={styles.notice}
          role="status"
          data-testid="community-date-notice"
        >
          <span className={styles.noticeText}>
            {String(
              zeroState === "PENDING"
                ? t("rsvp.datesPending")
                : t("rsvp.seriesEnded"),
            )}
          </span>
        </div>
      ) : null}

      {thenRows.length > 0 ? (
        <div className={styles.thenBlock}>
          {/* The word is repeated as the group's accessible name below, so the
              visible eyebrow is ornament here. Dropped when there is no lead
              date for these to come "then" after. */}
          {next ? (
            <Text variant="overline" tone="muted" aria-hidden>
              {String(t("rsvp.thenLabel"))}
            </Text>
          ) : null}
          <div
            className={styles.chipRow}
            role="group"
            aria-label={String(
              next ? t("rsvp.thenLabel") : t("rsvp.moreDatesLabel"),
            )}
          >
            {/*
              IDENTICAL markup for a moderator and for anyone else. This row is
              a GLANCE surface — it answers "when is this on next" — and a
              moderator is a reader of this page before they are an operator of
              it. A called-off night here is still struck through and marked
              "Called off" for everyone; acting on it happens on a full-width
              row, in the disclosure below or on the NEXT card above.
            */}
            {thenRows.map((row) => (
              // A keyed Fragment, not a wrapper element: the chip row is a flex
              // container and an extra box in it would take over the wrapping.
              <Fragment key={row.eventDateId}>
                {row.status === "CANCELLED" ? (
                  calledOffChip(row)
                ) : signedIn ? (
                  <DateToggle
                    density="chip"
                    going={row.viewerRsvped}
                    busy={pendingIds.has(row.eventDateId)}
                    inert={pendingIds.has(row.eventDateId) || sessionResolving}
                    signedIn
                    label={chipOf(row.startsAt)}
                    ariaLabel={ariaFor(row)}
                    iconSize={13}
                    onPress={() => toggle(row)}
                  />
                ) : (
                  // Signed out these are NOT controls — the section gets ONE
                  // sign-in affordance (the primary above), not one per date —
                  // but they keep the chip's box. As bare text the six dates ran
                  // together into one line ("Sep 23  Sep 30  Oct 7 …") instead of
                  // reading as six separate dates. A <span> with no tabindex and
                  // no handler, in the mono date-stamp idiom rather than the
                  // chip's bold sans, so the box separates without impersonating
                  // a button.
                  <span className={styles.staticDate}>
                    {chipOf(row.startsAt)}
                  </span>
                )}
              </Fragment>
            ))}
          </div>
        </div>
      ) : null}

      {showDisclosure ? (
        <>
          <button
            type="button"
            className={styles.disclosure}
            aria-expanded={showAll}
            aria-controls={panelId}
            onClick={() => setShowAll((open) => !open)}
            data-testid="community-date-disclosure"
          >
            {showAll
              ? String(t("rsvp.hideDates"))
              : truncated && !panelAddsNothingVisible
                ? // The panel does not hold ALL of them — the series runs past
                  // the loaded list — so it cannot promise a count.
                  String(t("rsvp.showMoreDates"))
                : // It holds every loaded row, so it can name the count even
                  // when the SERIES runs on: `truncated` is a claim about the
                  // schedule, not about this panel. "Show more dates" would be
                  // the actual lie in the moderator-only case — there are no
                  // more than the ones already on screen. Nothing above has
                  // stated a horizon either (the drained notice and the
                  // horizon-less span line both refuse to), so the count cannot
                  // be misread as the series' total.
                  String(t("rsvp.showAllDates", { count: rows.length }))}
          </button>
          <div
            id={panelId}
            className={styles.panel}
            // The `hidden` ATTRIBUTE, not a class: a class can be overridden
            // by anything with more specificity, and this has to be genuinely
            // out of the a11y tree and the tab order when closed.
            hidden={!showAll}
            // Focusable + labelled because it scrolls: signed out it holds no
            // control at all, so nothing else would let a keyboard reader reach
            // the bottom of it.
            tabIndex={0}
            role="group"
            // Same test as the trigger's label above, for the same reason: the
            // scroller is only "some of the dates" when it really is.
            aria-label={String(
              truncated && !panelAddsNothingVisible
                ? t("rsvp.moreDatesLabel")
                : t("rsvp.allDatesLabel"),
            )}
            data-testid="community-date-all-panel"
          >
            {monthGroups.map((group) => (
              <div key={group.key} className={styles.monthGroup}>
                <div className={styles.monthHead}>
                  <span className={styles.monthName}>{group.label}</span>
                  <span className={styles.monthCount}>
                    {String(
                      t("rsvp.monthDateCount", { count: group.rows.length }),
                    )}
                  </span>
                </div>
                {group.rows.map((row) => {
                  const cancelled = row.status === "CANCELLED";
                  return (
                    <div key={row.eventDateId} className={styles.monthRow}>
                      <span
                        className={
                          cancelled
                            ? `${styles.monthRowDate} ${styles.struck}`
                            : styles.monthRowDate
                        }
                      >
                        {monthRowOf(row.startsAt)}
                      </span>
                      {cancelled || signedIn || isModerator ? (
                        <span className={styles.rowActions}>
                          {cancelled ? (
                            <span className={styles.calledOffMark}>
                              {String(t("rsvp.calledOff"))}
                            </span>
                          ) : signedIn ? (
                            <DateToggle
                              density="rowToggle"
                              going={row.viewerRsvped}
                              busy={pendingIds.has(row.eventDateId)}
                              inert={
                                pendingIds.has(row.eventDateId) ||
                                sessionResolving
                              }
                              signedIn
                              label={
                                row.viewerRsvped
                                  ? String(t("rsvp.going"))
                                  : String(t("rsvp.rsvpShort"))
                              }
                              ariaLabel={ariaFor(row)}
                              iconSize={12}
                              onPress={() => toggle(row)}
                            />
                          ) : null}
                          {isModerator ? renderModAction(row) : null}
                        </span>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </>
      ) : null}

      {/* No RSVP anywhere in the zero-dates state, so no note about how private
          RSVPs are and no invitation to sign in and make one. */}
      {zeroState ? null : (
        <Text variant="caption" tone="muted">
          {String(signedIn ? t("rsvp.privateHint") : t("rsvp.datesSignInHint"))}
        </Text>
      )}

      {/* Calling a night off emails everyone holding a live RSVP on it. The
          confirm states that outcome rather than asking "are you sure". */}
      <ConfirmDialog
        open={confirming !== null}
        tone="danger"
        title={String(t("rsvp.callOffConfirmTitle"))}
        description={String(
          t("rsvp.callOffConfirmBody", {
            date: confirming ? fullOf(confirming.startsAt) : "",
          }),
        )}
        confirmLabel={String(t("rsvp.callOffConfirmAction"))}
        cancelLabel={String(t("rsvp.callOffConfirmKeep"))}
        onCancel={() => setConfirming(null)}
        onConfirm={() => {
          if (confirming) moderation.callOff(confirming.eventDateId);
          // Closed straight away rather than held open on a spinner: the row
          // itself goes busy, which keeps the progress beside the date the
          // moderator is looking at, and lets the modal hand focus back before
          // the list re-reads.
          setConfirming(null);
        }}
      />
    </div>
  );
}

CommunityDateList.displayName = "CommunityDateList";
