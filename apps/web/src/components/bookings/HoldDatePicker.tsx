"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import {
  Button,
  NextLinkAnchor,
  Spinner,
  Text,
  useFormatters,
  useTranslations,
} from "@th/ui";

import { holdActLabel } from "@/app/admin/[slug]/_components/event-calendar-holds";
import type { CalendarHold } from "@/app/admin/[slug]/_components/event-calendar-types";
import { formatErrorMessage } from "@/lib/format-error-message";
import { trpc } from "@/trpc";

import { holdPositionKey, HOLD_ACTION_TOUCH } from "./booking-holds";
import { HoldDayRail } from "./HoldDayRail";
import { HoldMonthGrid } from "./HoldMonthGrid";
import {
  addHoldDates,
  addIsoDays,
  availabilityLooksUnconfigured,
  buildHoldMonth,
  EMPTY_HOLD_SELECTION,
  extendHoldSelection,
  initialFocusDate,
  initialHoldMonth,
  isoDate,
  isoWeekday,
  MAX_HOLD_DATES,
  placeDayKey,
  removeHoldDate,
  retainFailedHoldDates,
  selectablePreferredDates,
  selectableWeekdayDates,
  toggleHoldDate,
  type HoldSelection,
} from "./hold-date-grid";
import styles from "./HoldDatePicker.module.css";

// ─────────────────────────────────────────────────────────────────────────────
// HOLD DATE PICKER (booking-holds FR-002; owner rulings 2026-08-31).
//
// TWO RULINGS, ONE CONTROL.
//
// 1. THE SPACE PICKER IS GONE. A hold is a place in line for a DATE on a
//    CALENDAR: the line is keyed `(calendarId, date)` and so are both database
//    guards — one live hold per request per calendar-day, one CONFIRMED winner
//    per calendar-day. Nothing downstream reads a room off a hold. A room
//    picker here promised a reservation the system never made. The calendar's
//    rooms are now PRINTED under its name, read-only; the room is chosen at
//    confirm, on the draft event, where it is real.
//
// 2. ONE DATE PER PASS BECOMES A MONTH. The old form was three selects and one
//    hold per submit, so an act asking for three Fridays cost three passes. The
//    grid takes as many nights as one press can carry (`MAX_HOLD_DATES`).
//
// WHERE THE DATA COMES FROM — three reads, none of them per-day:
//   · `places.listCalendars`         the streams, and each one's rooms
//   · `places.getCalendarEventsAdmin` the live hold overlay for the month, and
//                                     the events that took nights on it
//   · `places.getBookingAvailability` per-day open/closed/blackout, and the
//                                     VENUE's timezone — which is what makes
//                                     "today" the venue's today and not the
//                                     viewer's.
//
// PARTIAL SUCCESS IS A DESIGNED OUTCOME. `placeMany` is one transaction per
// date, so someone else confirming a night between this grid rendering and the
// button landing takes exactly that night. What placed stays placed; what
// failed keeps its chip, marked with the reason, so it can be swapped rather
// than retyped.
// ─────────────────────────────────────────────────────────────────────────────

/** ±1 day of slack so the instant window covers the month in ANY venue zone. */
const WINDOW_PAD_MS = 36 * 60 * 60 * 1000;

/** Statuses that mean a published show owns the night (FR-018). */
const TAKING_EVENT_STATUSES = new Set(["PUBLISHED", "COMPLETED"]);

/**
 * The six codes `placeMany` reports per date, each mapped to the one word its
 * chip wears. The lookup is deliberately open — a code this build has not
 * heard of falls through to the generic word rather than rendering a key.
 */
const FAILURE_LABEL_KEYS: Record<string, string> = {
  booking_hold_exists: "admin.bkHoldPickFailedExists",
  HOLD_LINE_ALREADY_CONFIRMED: "admin.bkHoldPickFailedTaken",
  hold_date_in_past: "admin.bkHoldPickFailedPast",
  invalid_calendar_date: "admin.bkHoldPickFailedInvalid",
  HOLD_LINE_CHANGED: "admin.bkHoldPickFailedRetry",
  unknown_error: "admin.bkHoldPickFailedRetry",
};

/**
 * Failures that are NOT a verdict on the night, so the chip reads amber and
 * says "try again" rather than naming a cause:
 *
 *   · HOLD_LINE_CHANGED — a per-line conflict; nothing was written.
 *   · unknown_error     — the batch hit something unexpected on this date
 *                         AFTER committing earlier ones, so it banked the
 *                         committed work, recorded the date and reported to
 *                         Sentry. The operator's move is the same: press again.
 *
 * Every other code is a dead end (the night is gone, the date is past, the
 * request is already in that line) and reads red.
 */
const RETRYABLE_FAILURE_CODES = new Set(["HOLD_LINE_CHANGED", "unknown_error"]);

export type HoldPlacementFailure = { date: string; code: string };

export type HoldDatePickerProps = {
  bookingRequestId: string;
  placeId: string;
  /** `preferredDates` already reduced to `YYYY-MM-DD` by `holdDateFromPreferred`. */
  preferredDates: readonly string[];
  /**
   * Fired once at least one hold landed. `failedCount` is how many dates in
   * the SAME press did not.
   *
   * The caller refreshes its readers on both paths, and decides whether to
   * close — but it MUST NOT close while `failedCount > 0`. The refused dates
   * exist nowhere else: this component is holding them as marked chips so the
   * operator can swap them, and unmounting computes that tray and throws it
   * away. (It did exactly that until 2026-08-31.)
   */
  onPlaced: (placedCount: number, failedCount: number) => void;
  onCancel: () => void;
  /** The caller's toast for a whole-call failure (auth, network, validation). */
  onError: (err: unknown) => void;
  /**
   * The admin context's slug, for the UNCONFIGURED note's "Set your hours"
   * link (`/admin/{slug}/places/{placeId}/calendars`). Optional so the note
   * degrades to its sentence alone rather than fabricating a route when a
   * future caller has no admin context.
   */
  adminSlug?: string;
  disabled?: boolean;
  testIdBase?: string;
};

export function HoldDatePicker({
  bookingRequestId,
  placeId,
  preferredDates,
  onPlaced,
  onCancel,
  onError,
  adminSlug,
  disabled = false,
  testIdBase = "hold-picker",
}: HoldDatePickerProps) {
  const t = useTranslations();
  const fmt = useFormatters();
  const utils = trpc.useUtils();

  // ── Calendars ────────────────────────────────────────────────────────────
  const calendarsQuery = trpc.places.listCalendars.useQuery(
    { placeId },
    { staleTime: 60_000, retry: 1 },
  );
  const calendars = useMemo(() => calendarsQuery.data ?? [], [calendarsQuery.data]);
  const [calendarId, setCalendarId] = useState<string | null>(null);
  const calendar = useMemo(
    () =>
      calendars.find((c) => c.id === calendarId) ??
      calendars.find((c) => c.isDefault) ??
      calendars[0] ??
      null,
    [calendars, calendarId],
  );
  const rooms = useMemo(
    () =>
      (calendar?.spaces ?? [])
        .filter((s) => s.status === "ACTIVE")
        .map((s) => s.name),
    [calendar],
  );

  // ── The window ───────────────────────────────────────────────────────────
  // The month on screen is state, not a derived offset: paging with PageUp from
  // a cell has to be able to land on a specific date, not just "one month back".
  //
  // It OPENS on the act's first asked-for date that has not passed, never
  // blindly on the current month — see `initialHoldMonth`. The venue's zone has
  // not arrived at mount, so the viewer's day seeds it; the month is a coarse
  // enough unit that a one-day difference almost never changes the answer, and
  // the fallback is still a month with usable days.
  const [cursor, setCursor] = useState(() => {
    const now = new Date();
    return initialHoldMonth(
      preferredDates,
      isoDate(now.getFullYear(), now.getMonth(), now.getDate()),
    );
  });
  const firstOfMonth = `${cursor.year}-${String(cursor.month + 1).padStart(2, "0")}-01`;
  const monthLength = new Date(Date.UTC(cursor.year, cursor.month + 1, 0)).getUTCDate();

  const availabilityQuery = trpc.places.getBookingAvailability.useQuery(
    {
      placeId,
      from: firstOfMonth,
      days: monthLength,
      ...(calendar ? { calendarId: calendar.id } : {}),
    },
    { enabled: calendar !== null, staleTime: 30_000, retry: 1 },
  );

  // The UNCONFIGURED detector (availability-onboarding FR-006): zero
  // CalendarAvailability rows anywhere on the place, so every day computes as
  // closed — a different sentence from "genuinely dark on Mondays", and the
  // one this venue's own staff have to hear. Owner-gated; fails quiet for a
  // viewer who cannot ask (the note simply doesn't render off this read).
  const setupQuery = trpc.places.getAvailabilitySetupState.useQuery(
    { placeId },
    { staleTime: 30_000, retry: false, meta: { silent: true } },
  );

  // The note has TWO scopes, and the words must not overclaim (live-drive
  // finding, 2026-08-31):
  //
  //   · "venue" — the server detector says the PLACE holds zero availability
  //     rows anywhere. Only then may the note say "this venue has no hours".
  //   · "calendar" — the venue IS configured (or the detector hasn't
  //     answered), but the SELECTED calendar's month computes every non-past
  //     day as closed with nothing blacked out. No place-wide row and no row
  //     of its own covers this calendar, so it renders exactly the all-dark
  //     month the venue note exists to explain — one calendar over. Keying
  //     the note only on the venue detector recreated the "31 dark cells
  //     reads like a bug" state on any second calendar.
  //
  // The calendar signal is `availabilityLooksUnconfigured` over the
  // calendar-scoped availability read — a PER-MONTH approximation: it sees
  // only the rendered month, and a month of explicit blackouts (a stated
  // decision, not absent hours) correctly does not trip it. It is also the
  // fallback while the detector has not answered, because it is the sentence
  // that cannot overclaim: "no hours cover this calendar" is true in both
  // scopes, "this venue has no hours" only in one.
  const monthReadsBare = availabilityLooksUnconfigured(
    availabilityQuery.data?.days ?? [],
  );
  const unconfiguredScope: "venue" | "calendar" | null =
    setupQuery.data !== undefined && !setupQuery.data.configured
      ? "venue"
      : monthReadsBare
        ? "calendar"
        : null;

  const windowFrom = useMemo(
    () => new Date(new Date(`${firstOfMonth}T00:00:00Z`).getTime() - WINDOW_PAD_MS),
    [firstOfMonth],
  );
  const windowTo = useMemo(
    () =>
      new Date(
        new Date(`${addIsoDays(firstOfMonth, monthLength - 1)}T00:00:00Z`).getTime() +
          WINDOW_PAD_MS,
      ),
    [firstOfMonth, monthLength],
  );

  const calendarQuery = trpc.places.getCalendarEventsAdmin.useQuery(
    { calendarId: calendar?.id ?? "", from: windowFrom, to: windowTo },
    { enabled: calendar !== null, staleTime: 30_000, retry: 1 },
  );

  // The VENUE's zone, so "past" and "today" are the venue's. Until availability
  // answers, the viewer's zone is the honest stand-in — within a day of right
  // everywhere, and the grid re-derives the moment the real zone lands.
  const timezone =
    availabilityQuery.data?.timezone ??
    (typeof Intl !== "undefined"
      ? Intl.DateTimeFormat().resolvedOptions().timeZone
      : "UTC");
  const today = useMemo(() => placeDayKey(new Date(), timezone), [timezone]);

  const closedDates = useMemo(() => {
    const set = new Set<string>();
    for (const day of availabilityQuery.data?.days ?? []) {
      if (day.status === "closed" || day.status === "blackout") set.add(day.date);
    }
    return set;
  }, [availabilityQuery.data]);

  const holds = useMemo(
    () => (calendarQuery.data?.holds ?? []) as CalendarHold[],
    [calendarQuery.data],
  );

  // WHAT ENDS A LINE, from the two sources the admin overlay supplies:
  //
  //   · a PUBLISHED / COMPLETED event on THIS calendar (FR-018 — publishing
  //     takes the calendar-day). Never DRAFT: staff create unrelated drafts
  //     freely, and making a bookable night unreachable is worse than eating
  //     one rejected date, which the tray already handles.
  //   · a CONFIRMED hold on the line — literally the state the server refuses
  //     with HOLD_LINE_ALREADY_CONFIRMED. It reaches us because
  //     `booking-hold-overlay.ts` carries CONFIRMED alongside the live line;
  //     `indexHoldsByDay` still filters the LINE itself to ACTIVE/CHALLENGED,
  //     so a confirmed winner ends the night without appearing in it.
  //
  // The confirmed hold's act name is the better label when there is one: it
  // says who won the night, which is what a booker is about to ask.
  const takenDates = useMemo(() => {
    const map = new Map<string, string>();
    for (const event of calendarQuery.data?.events ?? []) {
      if (!TAKING_EVENT_STATUSES.has(event.status)) continue;
      map.set(placeDayKey(new Date(event.startsAt), timezone), event.title);
    }
    for (const hold of holds) {
      if (hold.status !== "CONFIRMED" || hold.lapsed) continue;
      map.set(hold.date, holdActLabel(hold) ?? map.get(hold.date) ?? "");
    }
    return map;
  }, [calendarQuery.data, holds, timezone]);

  const preferredSet = useMemo(() => new Set(preferredDates), [preferredDates]);

  const month = useMemo(
    () =>
      buildHoldMonth({
        year: cursor.year,
        month: cursor.month,
        today,
        bookingRequestId,
        holds,
        closedDates,
        takenDates,
        preferredDates: preferredSet,
      }),
    [bookingRequestId, closedDates, cursor, holds, preferredSet, takenDates, today],
  );

  // ── Selection + focus ────────────────────────────────────────────────────
  const [selection, setSelection] = useState<HoldSelection>(EMPTY_HOLD_SELECTION);
  const [focusDate, setFocusDate] = useState<string | null>(null);
  const [focusNonce, setFocusNonce] = useState(0);
  const [failures, setFailures] = useState<readonly HoldPlacementFailure[]>([]);
  const [placedCount, setPlacedCount] = useState<number | null>(null);

  // ── Seeding the cursor ───────────────────────────────────────────────────
  // The grid opens on the act's first holdable asked-for date. Three events
  // move that cursor, and they are not the same event:
  //
  //   1. the month or calendar changed          → seed the new month
  //   2. the overlay + availability LANDED      → seed AGAIN. The first pass
  //      ran against an empty month, where every day looks holdable and the
  //      seed lands on day 1 — including days that are actually taken, dark or
  //      already ours. Keying only on the month short-circuits this.
  //   3. an arrow key crossed the month boundary → the keystroke already named
  //      the day it wants, so seeding must stand aside. `pendingFocus` is
  //      written synchronously in the handler, before the cursor commits.
  const seededMonth = useRef<string | null>(null);
  const seededWithData = useRef(false);
  const pendingFocus = useRef<string | null>(null);
  const monthKey = `${firstOfMonth}:${calendar?.id ?? ""}`;
  const dataReady =
    calendar !== null && !calendarQuery.isLoading && !availabilityQuery.isLoading;
  useEffect(() => {
    const monthChanged = seededMonth.current !== monthKey;
    const dataArrived = dataReady && !seededWithData.current;
    if (!monthChanged && !dataArrived) return;
    seededMonth.current = monthKey;
    seededWithData.current = dataReady;

    const requested = pendingFocus.current;
    pendingFocus.current = null;
    if (requested && month.byDate.has(requested)) return;

    setFocusDate(initialFocusDate(month));
  }, [dataReady, month, monthKey]);

  const effectiveFocus = focusDate ?? month.firstDate;
  const focusedCell = month.byDate.get(effectiveFocus) ?? null;

  const goToDate = useCallback(
    (date: string) => {
      // Claim the seed BEFORE the cursor commits: if this crosses a month
      // boundary the effect above must honour the keystroke, not re-seed.
      pendingFocus.current = date;
      const year = Number(date.slice(0, 4));
      const monthIndex = Number(date.slice(5, 7)) - 1;
      setCursor((prev) =>
        prev.year === year && prev.month === monthIndex
          ? prev
          : { year, month: monthIndex },
      );
      setFocusDate(date);
      setFocusNonce((n) => n + 1);
    },
    [],
  );

  const onNavigate = useCallback(
    (date: string, extend: boolean) => {
      goToDate(date);
      // Shift+Arrow extends as it walks, exactly like Shift-click.
      if (extend) {
        setSelection((prev) => extendHoldSelection(prev, month, date));
      }
    },
    [goToDate, month],
  );

  const onActivate = useCallback(
    (date: string, extend: boolean) => {
      const cell = month.byDate.get(date);
      if (!cell) return;
      setFocusDate(date);
      setFocusNonce((n) => n + 1);
      setSelection((prev) =>
        extend ? extendHoldSelection(prev, month, date) : toggleHoldDate(prev, cell),
      );
    },
    [month],
  );

  const stepMonth = useCallback(
    (delta: number) => {
      setCursor((prev) => {
        const next = new Date(Date.UTC(prev.year, prev.month + delta, 1));
        return { year: next.getUTCFullYear(), month: next.getUTCMonth() };
      });
      setFocusDate(null);
    },
    [],
  );

  // ── Quick actions ────────────────────────────────────────────────────────
  const askedForHere = useMemo(() => selectablePreferredDates(month), [month]);
  // "All open Fridays" only earns its place when the act actually asked for a
  // weekday: a fixed Friday button on a venue that programs Tuesdays is noise.
  const askedWeekday = useMemo(() => {
    const weekdays = new Set(preferredDates.map(isoWeekday));
    return weekdays.size === 1 ? [...weekdays][0]! : null;
  }, [preferredDates]);
  const weekdayDates = useMemo(
    () => (askedWeekday === null ? [] : selectableWeekdayDates(month, askedWeekday)),
    [askedWeekday, month],
  );

  // ── Placing ──────────────────────────────────────────────────────────────
  const placeMany = trpc.bookingHolds.placeMany.useMutation({
    retry: false,
    meta: { silent: true },
  });

  const submit = useCallback(() => {
    if (!calendar || selection.dates.length === 0 || placeMany.isPending) return;
    placeMany.mutate(
      {
        bookingRequestId,
        calendarId: calendar.id,
        dates: [...selection.dates],
      },
      {
        onSuccess: (result) => {
          setFailures(result.failed);
          setPlacedCount(result.placed.length);
          // What landed leaves the tray; what did not stays, marked, so the
          // operator swaps one date instead of rebuilding the whole pick.
          setSelection((prev) =>
            retainFailedHoldDates(
              prev,
              result.failed.map((f) => f.date),
            ),
          );
          // The overlay this month was built from is now stale by exactly the
          // holds just written. Refreshed HERE, not only by the caller: on a
          // partial failure this component stays mounted, and the chips still
          // in the tray must re-derive their offered positions against the new
          // line rather than quoting the pre-press one.
          void utils.places.getCalendarEventsAdmin.invalidate();
          if (result.placed.length > 0) {
            onPlaced(result.placed.length, result.failed.length);
          }
        },
        onError,
      },
    );
  }, [bookingRequestId, calendar, onError, onPlaced, placeMany, selection.dates, utils]);

  const failureByDate = useMemo(
    () => new Map(failures.map((f) => [f.date, f.code])),
    [failures],
  );
  const failedDates = useMemo(() => new Set(failures.map((f) => f.date)), [failures]);

  const dayChip = useCallback(
    (date: string) =>
      fmt.dateTime(new Date(`${date}T12:00:00Z`), {
        weekday: "short",
        day: "numeric",
        timeZone: "UTC",
      }),
    [fmt],
  );
  const ordinal = useCallback(
    (position: number) =>
      String(t(holdPositionKey(position), { position: String(position) })),
    [t],
  );

  const loading = calendarsQuery.isLoading;
  const busy = disabled || placeMany.isPending;

  // ── States ───────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className={styles.root} data-testid={`${testIdBase}-loading`}>
        <div className={styles.picker}>
          <div className={styles.gridCol}>
            <MonthSkeleton />
          </div>
        </div>
      </div>
    );
  }

  if (calendarsQuery.isError) {
    return (
      <div className={styles.root}>
        <div className={styles.picker}>
          <div className={styles.state} role="alert" data-testid={`${testIdBase}-error`}>
            <Text variant="bodySmall" tone="error">
              {formatErrorMessage(calendarsQuery.error, t)}
            </Text>
            <Button variant="ghost" size="$2" $sm={HOLD_ACTION_TOUCH} onPress={onCancel}>
              {String(t("common.cancel"))}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (!calendar) {
    return (
      <div className={styles.root}>
        <div className={styles.picker}>
          <div className={styles.state} data-testid={`${testIdBase}-no-calendars`}>
            <Text variant="h6" weight="bold">
              {String(t("admin.bkHoldPickNoCalendars"))}
            </Text>
            <Text variant="bodySmall" tone="muted">
              {String(t("admin.bkHoldPickNoCalendarsBody"))}
            </Text>
            <Button variant="ghost" size="$2" $sm={HOLD_ACTION_TOUCH} onPress={onCancel}>
              {String(t("common.cancel"))}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <div className={styles.picker} data-testid={`${testIdBase}-form`}>
        {placedCount !== null ? (
          <div className={styles.banner} role="status" data-testid={`${testIdBase}-result`}>
            <Text variant="overline" tone={failures.length > 0 ? "error" : "muted"}>
              {failures.length > 0
                ? String(
                    t("admin.bkHoldPickPlacedSome", {
                      placed: placedCount,
                      total: placedCount + failures.length,
                    }),
                  )
                : String(t("admin.bkHoldPickPlacedAll", { count: placedCount }))}
            </Text>
            <Text variant="bodySmall" tone="muted">
              {failures.length > 0
                ? String(t("admin.bkHoldPickPartialBody"))
                : String(t("admin.bkHoldPickPlacedBody"))}
            </Text>
          </div>
        ) : null}

        {/* ── Head: the ask, the calendar, and the rooms it programs ── */}
        <div className={styles.head}>
          <div className={styles.headText}>
            <Text variant="h6" weight="bold">
              {String(t("admin.bkHoldPickTitle"))}
            </Text>
            <Text variant="bodySmall" tone="muted">
              {preferredDates.length > 0
                ? String(
                    t("admin.bkHoldPickAsked", {
                      dates: preferredDates.map(dayChip).join(" · "),
                    }),
                  )
                : String(t("admin.bkHoldPickAskedNone"))}
            </Text>
          </div>
          <div className={styles.headCal}>
            {calendars.length > 1 ? (
              <div
                className={styles.calSwitch}
                role="group"
                aria-label={String(t("admin.bkHoldCalendarLabel"))}
              >
                {calendars.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className={styles.calBtn}
                    aria-pressed={c.id === calendar.id}
                    disabled={busy}
                    data-testid={`${testIdBase}-calendar-${c.id}`}
                    onClick={() => {
                      setCalendarId(c.id);
                      setSelection(EMPTY_HOLD_SELECTION);
                      setFailures([]);
                      setPlacedCount(null);
                    }}
                  >
                    {c.name}
                  </button>
                ))}
              </div>
            ) : (
              <Text variant="overline" tone="muted">
                {calendar.name}
              </Text>
            )}
            <Text variant="bodySmall" tone="muted" data-testid={`${testIdBase}-rooms`}>
              {rooms.length > 0
                ? String(t("admin.bkHoldPickRooms", { rooms: rooms.join(" · ") }))
                : String(t("admin.bkHoldPickRoomsNone"))}
            </Text>
            <Text variant="caption" tone="muted">
              {String(t("admin.bkHoldPickRoomNote"))}
            </Text>
          </div>
        </div>

        <div className={styles.body}>
          <div className={styles.gridCol}>
            <div className={styles.monthBar}>
              <Text variant="h6" weight="bold">
                {fmt.dateTime(new Date(`${firstOfMonth}T12:00:00Z`), {
                  month: "long",
                  year: "numeric",
                  timeZone: "UTC",
                })}
              </Text>
              <div style={{ display: "flex", gap: 6 }}>
                <button
                  type="button"
                  className={styles.navBtn}
                  aria-label={String(t("admin.bkHoldPickPrevMonth"))}
                  disabled={busy}
                  data-testid={`${testIdBase}-prev`}
                  onClick={() => stepMonth(-1)}
                >
                  <ChevronLeft size={15} strokeWidth={2.5} aria-hidden />
                </button>
                <button
                  type="button"
                  className={styles.navBtn}
                  aria-label={String(t("admin.bkHoldPickNextMonth"))}
                  disabled={busy}
                  data-testid={`${testIdBase}-next`}
                  onClick={() => stepMonth(1)}
                >
                  <ChevronRight size={15} strokeWidth={2.5} aria-hidden />
                </button>
              </div>
            </div>

            {askedForHere.length > 0 || weekdayDates.length > 0 ? (
              <div className={styles.quick}>
                {askedForHere.length > 0 ? (
                  <button
                    type="button"
                    className={styles.quickBtn}
                    disabled={busy}
                    data-testid={`${testIdBase}-pick-asked`}
                    onClick={() =>
                      setSelection((prev) => addHoldDates(prev, month, askedForHere))
                    }
                  >
                    {String(
                      t("admin.bkHoldPickSelectAsked", { count: askedForHere.length }),
                    )}
                  </button>
                ) : null}
                {weekdayDates.length > 0 && askedWeekday !== null ? (
                  <button
                    type="button"
                    className={styles.quickBtn}
                    disabled={busy}
                    data-testid={`${testIdBase}-pick-weekday`}
                    onClick={() =>
                      setSelection((prev) => addHoldDates(prev, month, weekdayDates))
                    }
                  >
                    {String(
                      t("admin.bkHoldPickSelectWeekday", {
                        weekday: fmt.dateTime(
                          new Date(Date.UTC(2021, 7, 1 + askedWeekday, 12)),
                          { weekday: "long", timeZone: "UTC" },
                        ),
                      }),
                    )}
                  </button>
                ) : null}
              </div>
            ) : null}

            {/* Nothing covers this month (availability-onboarding FR-006):
                said ONCE above the grid — venue-worded when the place has no
                hours at all, calendar-worded when only the selected calendar
                is bare — instead of letting a month of identical dark cells
                read as a broken control. The grid stays fully usable
                underneath: a hold on a dark night is legal, and staff may
                still pencil an act in. */}
            {dataReady && unconfiguredScope !== null ? (
              <div
                className={styles.setupNote}
                data-scope={unconfiguredScope}
                data-testid={`${testIdBase}-unconfigured`}
              >
                <Text variant="caption" tone="muted">
                  {String(
                    t(
                      unconfiguredScope === "venue"
                        ? "admin.bkHoldPickUnconfigured"
                        : "admin.bkHoldPickCalUnconfigured",
                    ),
                  )}
                </Text>
                {adminSlug ? (
                  <NextLinkAnchor
                    href={`/admin/${adminSlug}/places/${placeId}/calendars`}
                  >
                    <Text
                      variant="caption"
                      weight="bold"
                      textDecorationLine="underline"
                    >
                      {String(t("admin.bkHoldPickUnconfiguredLink"))}
                    </Text>
                  </NextLinkAnchor>
                ) : null}
              </div>
            ) : null}

            {!dataReady ? (
              <MonthSkeleton />
            ) : (
              <HoldMonthGrid
                month={month}
                selection={selection}
                focusDate={effectiveFocus}
                focusNonce={focusNonce}
                failedDates={failedDates}
                onNavigate={onNavigate}
                onActivate={onActivate}
                disabled={busy}
                testIdBase={testIdBase}
              />
            )}

            {calendarQuery.isError || availabilityQuery.isError ? (
              <Text variant="caption" tone="error" role="alert" marginTop="$2">
                {String(t("admin.bkHoldPickOverlayError"))}
              </Text>
            ) : null}

            <div className={styles.legend}>
              <LegendItem swatch="" label={String(t("admin.bkHoldPickLegendOpen"))} />
              <LegendItem
                swatch={styles.swatchLine}
                label={String(t("admin.bkHoldPickLegendLine"))}
              />
              <LegendItem
                swatch={styles.swatchAsked}
                label={String(t("admin.bkHoldPickLegendAsked"))}
              />
              <LegendItem
                swatch={styles.swatchDark}
                label={String(t("admin.bkHoldPickLegendDark"))}
              />
              <LegendItem
                swatch={styles.swatchTaken}
                label={String(t("admin.bkHoldPickLegendTaken"))}
              />
              <LegendItem
                swatch={styles.swatchSelected}
                label={String(t("admin.bkHoldPickLegendSelected"))}
              />
            </div>
          </div>

          <div className={styles.railCol}>
            <HoldDayRail cell={focusedCell} testIdBase={testIdBase} />
          </div>
        </div>

        {/* ── Tray ──────────────────────────────────────────────────── */}
        <div className={styles.tray}>
          <div className={styles.chips} role="status" data-testid={`${testIdBase}-tray`}>
            {selection.dates.length === 0 ? (
              <Text variant="bodySmall" tone="muted">
                {String(t("admin.bkHoldPickTrayEmpty", { max: MAX_HOLD_DATES }))}
              </Text>
            ) : (
              selection.dates.map((date) => {
                const cell = month.byDate.get(date);
                const failure = failureByDate.get(date);
                const retryable = failure ? RETRYABLE_FAILURE_CODES.has(failure) : false;
                // A dark pick is legal but unusual. The chip carries the grid's
                // own hatch AND the word, so one odd night among five is
                // visible without re-reading the month.
                const dark = cell?.status === "dark";
                return (
                  <span
                    key={date}
                    className={[
                      styles.chip,
                      failure ? (retryable ? styles.chipRetry : styles.chipFailed) : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    data-dark={dark || undefined}
                    data-testid={`${testIdBase}-chip-${date}`}
                  >
                    {/* The label block wraps inside the chip; the drop button
                        is a fixed second column. A chip must never be wider
                        than the tray that holds it — measured at 146px of
                        container, the flat inline-flex version overflowed by
                        130px inside the admin table's expanded row. */}
                    <span className={styles.chipBody}>
                      <span className={styles.chipDate}>{dayChip(date)}</span>
                      {dark ? (
                        <span className={styles.chipMark}>
                          {String(t("admin.bkHoldPickShortDark"))}
                        </span>
                      ) : null}
                      <span className={styles.chipPos}>
                        {failure
                          ? String(
                              t(
                                FAILURE_LABEL_KEYS[failure] ??
                                  "admin.bkHoldPickFailedOther",
                              ),
                            )
                          : cell?.offeredPosition
                            ? ordinal(cell.offeredPosition)
                            : ""}
                      </span>
                    </span>
                    <button
                      type="button"
                      className={styles.chipDrop}
                      disabled={busy}
                      aria-label={String(
                        t(
                          dark
                            ? "admin.bkHoldPickRemoveDark"
                            : "admin.bkHoldPickRemove",
                          { date: dayChip(date) },
                        ),
                      )}
                      data-testid={`${testIdBase}-drop-${date}`}
                      onClick={() => setSelection((prev) => removeHoldDate(prev, date))}
                    >
                      <X size={13} strokeWidth={2} aria-hidden />
                    </button>
                  </span>
                );
              })
            )}
          </div>
          <div className={styles.trayActions}>
            <Button
              variant="ghost"
              size="$2"
              $sm={HOLD_ACTION_TOUCH}
              disabled={busy}
              onPress={onCancel}
              testID={`${testIdBase}-cancel`}
            >
              {String(t("common.cancel"))}
            </Button>
            <Button
              variant="secondary"
              size="$2"
              disabled={busy || selection.dates.length === 0}
              onPress={submit}
              testID={`${testIdBase}-submit`}
              $sm={{ ...HOLD_ACTION_TOUCH, flex: 1, paddingHorizontal: "$2" }}
              textProps={{ whiteSpace: "normal", textAlign: "center" }}
            >
              {placeMany.isPending ? (
                <Spinner size="sm" />
              ) : (
                String(t("admin.bkHoldPickCta", { count: selection.dates.length }))
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function LegendItem({ swatch, label }: { swatch: string; label: string }) {
  return (
    <span className={styles.legendItem}>
      <i className={`${styles.swatch}${swatch ? ` ${swatch}` : ""}`} aria-hidden />
      {label}
    </span>
  );
}

/** Holds the real grid's height, so the tray never jumps when the month lands. */
function MonthSkeleton() {
  return (
    <div aria-hidden style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      {Array.from({ length: 6 }, (_, week) => (
        <div key={week} className={styles.skeletonWeek}>
          {Array.from({ length: 7 }, (_, day) => (
            <span key={day} className={styles.skeletonCell} />
          ))}
        </div>
      ))}
    </div>
  );
}
