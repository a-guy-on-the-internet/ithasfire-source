"use client";

import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { Spinner, Text, useTranslations } from "@th/ui";

import { trpc } from "@/trpc";

import styles from "./BookingDatePicker.module.css";

// ─────────────────────────────────────────────────────────────────────────────
// The requester's availability picker. TWO MODES, ONE CALENDAR.
//
// `dateTime` (PERFORM) — every scheduling product this borrows from books ONE
// slot against a calendar the requester can't argue with. Here a performer
// proposes up to three nights IN PREFERENCE ORDER and a human decides later,
// so the control carries a ranked shortlist that none of those references need.
//
// `date` (RENT / USE) — a room hire names its OWN window, typed as start and
// end clocks beside the picker, so a slot off the bill would be a second
// answer to a question already asked. The chips go; the month grid, the
// posted hours and the night's existing bookings stay, because "is the venue
// even open that day, and who else is in" is the whole reason a room-hire
// requester wants a calendar instead of a date field.
//
// All availability maths happens on the server (`places.getBookingAvailability`)
// and arrives as minutes from the venue's local midnight, so this component
// never re-derives a venue's day from instants. Minutes past 1440 mean the
// night runs into tomorrow.
// ─────────────────────────────────────────────────────────────────────────────

export interface BookingDatePickerProps {
  placeId: string;
  /**
   * Which of the venue's programming streams to show availability for
   * (venue-hierarchy FR-007). OMIT unless the surrounding block actually knows
   * a calendar — the server then resolves the place's default, which is the
   * right answer for a venue that has one. Passing a calendar narrows both the
   * posted hours AND the occupancy to that calendar's spaces.
   *
   * ⚠ INVARIANT — READ BEFORE PASSING THIS. Whatever you pass here MUST also
   * be sent as `calendarId` on the `bookingRequests.create` mutation, fed from
   * ONE state value. The server validates submitted dates against the calendar
   * the REQUEST routes to, not the one the picker displayed. Pass calendar B
   * here while the mutation routes to the default A and the performer is shown
   * B's open nights, picks one, and is rejected with `BOOKING_DATE_UNAVAILABLE`
   * on a date the UI just told them was available — with no way to recover.
   *
   * BOTH call sites honour it from one piece of state: `RequestToPlayForm`
   * holds a `calendarId` and spreads it into the picker and the mutation
   * (omitted on a pre-hierarchy place, where the request stays unrouted and
   * the server resolves the default for both); `SpaceRequestForm` does the
   * same with the calendar its own select owns. A third call site must do
   * likewise — never read a calendar from a second source.
   */
  calendarId?: string;
  /**
   * `date` drops the slot chips and stores a bare `YYYY-MM-DD`; `dateTime`
   * (the default) keeps today's slot picking and stores `YYYY-MM-DDTHH:MM`.
   */
  mode?: "date" | "dateTime";
  /** `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM`, in preference order. */
  value: string[];
  onChange: (next: string[]) => void;
  max: number;
  disabled?: boolean;
}

type DayCell = {
  date: string;
  dayOfWeek: number;
  status: "past" | "blackout" | "closed" | "full" | "partial" | "free";
  slots: number[];
  free: Array<{ start: number; end: number }>;
  takenRatio: number;
  bookings: Array<{
    title: string;
    start: number;
    end: number | null;
    assumedEnd: boolean;
  }>;
};

const DOW_KEYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** 12-hour, because a bill is never advertised in 24-hour time. */
function clock(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  const suffix = h >= 12 ? "pm" : "am";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m % 60).padStart(2, "0")} ${suffix}`;
}
const nextDay = (minutes: number) => minutes >= 1440;

function toMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}
function toTimeString(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** Split a shortlist entry back into its date and optional start minute. */
function splitEntry(entry: string): { date: string; minutes: number | null } {
  const [date, time] = entry.split("T");
  return { date: date!, minutes: time ? toMinutes(time) : null };
}
function makeEntry(date: string, minutes: number): string {
  // Minutes past midnight belong to the NEXT date as a wall clock, but the
  // request is for that night — keep the night's date and let the venue read
  // "Sat 22, 12:30 am" as the small hours of Saturday's show.
  return `${date}T${toTimeString(minutes)}`;
}

/**
 * Today in the VIEWER's zone — deliberately not UTC. `new Date().toISOString()`
 * rolls over at 18:00 in Chicago and would ask the server for a window
 * starting tomorrow, hiding tonight from an evening reader.
 */
export function localToday(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/** The horizon one read covers: the whole range the picker can page through. */
const AVAILABILITY_DAYS = 62;

/**
 * The `places.getBookingAvailability` input, built in ONE place.
 *
 * Both the picker and `SpaceRequestForm` (which only wants the venue's
 * timezone off the same read) must produce a structurally identical input or
 * React Query gives them separate cache entries and the public place page
 * computes 62 days of availability twice. That is exactly what happened while
 * the two sides derived `from` independently — one local, one UTC — which
 * agreed only before 18:00 in any negative-offset zone.
 *
 * `calendarId` is OMITTED rather than sent as `undefined`: the input schema
 * is `.strict()`.
 */
export function bookingAvailabilityInput(args: {
  placeId: string;
  calendarId?: string | undefined;
}): {
  placeId: string;
  from: string;
  days: number;
  calendarId?: string;
} {
  return {
    placeId: args.placeId,
    from: localToday(),
    days: AVAILABILITY_DAYS,
    ...(args.calendarId ? { calendarId: args.calendarId } : {}),
  };
}
function addDays(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  const probe = new Date(Date.UTC(y!, m! - 1, d!, 12));
  probe.setUTCDate(probe.getUTCDate() + days);
  return probe.toISOString().slice(0, 10);
}
function monthLabel(dateKey: string, locale: string): string {
  const [y, m] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, 1)).toLocaleDateString(locale, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}
function dayLabel(dateKey: string, locale: string): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).toLocaleDateString(locale, {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** Afternoon / Evening / Late — a 15-slot list needs a spine to scan. */
function groupSlots(slots: number[]) {
  const buckets: Array<{
    key: "afternoon" | "evening" | "late";
    slots: number[];
  }> = [
    { key: "afternoon", slots: [] },
    { key: "evening", slots: [] },
    { key: "late", slots: [] },
  ];
  for (const s of slots) {
    if (s < 17 * 60) buckets[0]!.slots.push(s);
    else if (s < 21 * 60) buckets[1]!.slots.push(s);
    else buckets[2]!.slots.push(s);
  }
  return buckets.filter((b) => b.slots.length > 0);
}

export function BookingDatePicker({
  placeId,
  calendarId,
  mode = "dateTime",
  value,
  onChange,
  max,
  disabled = false,
}: BookingDatePickerProps) {
  const t = useTranslations();
  const dateOnly = mode === "date";
  const locale =
    typeof navigator !== "undefined" ? navigator.language : "en-US";

  const today = useMemo(localToday, []);
  const [monthOffset, setMonthOffset] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);

  // One read covers the whole horizon the picker can page through, so paging
  // is instant and the shortlist can be validated against days not on screen.
  // The key must carry `calendarId` too — two calendars at one place have
  // different hours and different occupancy, and a shared cache entry would
  // hand one stream's diary to the other. `bookingAvailabilityInput` is
  // shared with `SpaceRequestForm` so the two land on ONE cache entry.
  const query = trpc.places.getBookingAvailability.useQuery(
    bookingAvailabilityInput({ placeId, calendarId }),
    { staleTime: 60_000, retry: false },
  );

  const byDate = useMemo(() => {
    const map = new Map<string, DayCell>();
    for (const day of (query.data?.days ?? []) as DayCell[])
      map.set(day.date, day);
    return map;
  }, [query.data]);

  // Which month grid to draw: the month containing today, plus the offset.
  const [ty, tm] = today.split("-").map(Number);
  const gridMonth = new Date(Date.UTC(ty!, tm! - 1 + monthOffset, 1));
  const gridYear = gridMonth.getUTCFullYear();
  const gridMonthIndex = gridMonth.getUTCMonth();
  const firstKey = `${gridYear}-${String(gridMonthIndex + 1).padStart(2, "0")}-01`;
  const daysInMonth = new Date(
    Date.UTC(gridYear, gridMonthIndex + 1, 0),
  ).getUTCDate();
  const leading = new Date(Date.UTC(gridYear, gridMonthIndex, 1)).getUTCDay();

  const picks = value.filter(Boolean).map(splitEntry);
  const rankOfDate = (date: string) =>
    picks.findIndex((p) => p.date === date) + 1;

  const cursorDay = cursor ? byDate.get(cursor) : undefined;

  const togglePick = (date: string, minutes: number) => {
    const entry = makeEntry(date, minutes);
    const existing = value.findIndex((v) => v === entry);
    if (existing !== -1) {
      onChange(value.filter((_, i) => i !== existing));
      return;
    }
    // One night, one ask: picking a different time on a night already in the
    // shortlist replaces it rather than spending a second slot.
    const withoutDate = value.filter((v) => splitEntry(v).date !== date);
    if (withoutDate.length >= max) return;
    onChange([...withoutDate, entry]);
  };

  /**
   * `date` mode: the day cell IS the control, so it SELECTS rather than
   * toggles. Clicking a day is also how the rail is opened on it, and a
   * gesture that reads the night's hours must not silently drop the pick
   * the requester already made — removal lives on the tray's ✕.
   */
  const pickDate = (date: string) => {
    if (disabled || value.includes(date)) return;
    const others = value.filter((v) => splitEntry(v).date !== date);
    // `max: 1` is a single answer, not a shortlist: a new day replaces the
    // old one instead of dead-ending on a full tray with no visible reason.
    if (max === 1) {
      onChange([date]);
      return;
    }
    if (others.length >= max) return;
    onChange([...others, date]);
  };

  const removeAt = (index: number) =>
    onChange(value.filter((_, i) => i !== index));

  const moveUp = (index: number) => {
    if (index <= 0) return;
    const next = [...value];
    const prev = next[index - 1]!;
    next[index - 1] = next[index]!;
    next[index] = prev;
    onChange(next);
  };

  /** Nearest nights that still have room — a full night is not a dead end. */
  const alternatives = useMemo(() => {
    if (!cursor || !cursorDay) return [];
    if (cursorDay.status !== "full" && cursorDay.status !== "blackout")
      return [];
    const out: Array<{ date: string; first: number }> = [];
    for (let off = 1; off <= 14 && out.length < 3; off++) {
      for (const delta of [off, -off]) {
        if (out.length >= 3) break;
        const day = byDate.get(addDays(cursor, delta));
        if (day && day.slots.length > 0)
          out.push({ date: day.date, first: day.slots[0]! });
      }
    }
    return out;
  }, [cursor, cursorDay, byDate]);

  if (query.isPending) {
    return (
      <div className={styles.loading}>
        <Spinner size="sm" />
      </div>
    );
  }

  // A failed read must not read as "everything's free" — fall back to the
  // plain date inputs the form has always had.
  if (query.isError) {
    return (
      <div className={styles.fallback}>
        <Text variant="bodySmall" tone="muted">
          {String(t("booking.pickerUnavailable"))}
        </Text>
        {Array.from({ length: max }).map((_, i) => (
          <input
            key={i}
            type="date"
            className={styles.fallbackInput}
            min={today}
            disabled={disabled}
            value={value[i]?.split("T")[0] ?? ""}
            aria-label={
              max === 1
                ? String(t("admin.bkFormDateLabel"))
                : `${String(t("admin.bkFormDatesLabel"))} ${i + 1}`
            }
            onChange={(e) => {
              const next = [...value];
              next[i] = e.target.value;
              onChange(next.filter(Boolean));
            }}
          />
        ))}
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <div className={styles.pane}>
        {/* ── month grid ─────────────────────────────────────────────── */}
        <div className={styles.calendar}>
          <div className={styles.calNav}>
            <button
              type="button"
              className={styles.navBtn}
              disabled={monthOffset <= 0 || disabled}
              onClick={() => setMonthOffset((o) => Math.max(0, o - 1))}
              aria-label={String(t("booking.pickerPrevMonth"))}
            >
              <ChevronLeft size={16} />
            </button>
            <span className={styles.calTitle}>
              {monthLabel(firstKey, locale)}
            </span>
            <button
              type="button"
              className={styles.navBtn}
              disabled={monthOffset >= 1 || disabled}
              onClick={() => setMonthOffset((o) => Math.min(1, o + 1))}
              aria-label={String(t("booking.pickerNextMonth"))}
            >
              <ChevronRight size={16} />
            </button>
          </div>

          <div
            className={styles.grid}
            role="group"
            aria-label={String(t("booking.pickerCalendarLabel"))}
          >
            {DOW_KEYS.map((key, i) => (
              <span key={key} className={styles.dow} aria-hidden="true">
                {DOW_KEYS[i]!.charAt(0)}
              </span>
            ))}
            {Array.from({ length: leading }).map((_, i) => (
              <span key={`pad-${i}`} aria-hidden="true" />
            ))}
            {Array.from({ length: daysInMonth }).map((_, i) => {
              const date = `${gridYear}-${String(gridMonthIndex + 1).padStart(2, "0")}-${String(i + 1).padStart(2, "0")}`;
              const day = byDate.get(date);
              const status = day?.status ?? "closed";
              const rank = rankOfDate(date);
              const selectable =
                !disabled &&
                (status === "free" ||
                  status === "partial" ||
                  status === "full" ||
                  status === "blackout");

              return (
                <button
                  key={date}
                  type="button"
                  className={[
                    styles.day,
                    styles[status] ?? "",
                    rank ? styles.picked : "",
                    cursor === date ? styles.cursor : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  disabled={!selectable}
                  aria-pressed={rank ? true : undefined}
                  aria-label={`${dayLabel(date, locale)} — ${String(
                    t(`booking.pickerStatus_${status}` as never),
                  )}`}
                  onClick={() => {
                    setCursor(date);
                    if (dateOnly) pickDate(date);
                  }}
                >
                  {(status === "partial" || status === "full") && (
                    <span
                      className={styles.fill}
                      style={{
                        height: `${Math.round((day?.takenRatio ?? 0) * 100)}%`,
                      }}
                      aria-hidden="true"
                    />
                  )}
                  {rank > 0 && <span className={styles.rank}>{rank}</span>}
                  <span className={styles.num}>{i + 1}</span>
                </button>
              );
            })}
          </div>

          <div className={styles.legend}>
            <span>
              <i className={styles.keyFree} />{" "}
              {String(t("booking.pickerLegendFree"))}
            </span>
            <span>
              <i className={styles.keyPartial} />{" "}
              {String(t("booking.pickerLegendPartial"))}
            </span>
            <span>
              <i className={styles.keyBlackout} />{" "}
              {String(t("booking.pickerLegendUnavailable"))}
            </span>
            <span>
              <i className={styles.keyPicked} />{" "}
              {String(t("booking.pickerLegendYours"))}
            </span>
          </div>
        </div>

        {/* ── slot rail ──────────────────────────────────────────────── */}
        <div className={styles.rail} aria-live="polite">
          {!cursorDay ? (
            <p className={styles.railEmpty}>
              {String(
                t(dateOnly ? "booking.pickerPromptDate" : "booking.pickerPrompt"),
              )}
            </p>
          ) : (
            <>
              <div className={styles.railHead}>
                <span className={styles.railDate}>
                  {dayLabel(cursor!, locale)}
                </span>
                {cursorDay.free.length > 0 && (
                  <span className={styles.railSub}>
                    {cursorDay.free
                      .map(
                        (g) =>
                          `${clock(g.start)}–${clock(g.end)}${nextDay(g.end) ? " +1" : ""}`,
                      )
                      .join(", ")}
                  </span>
                )}
              </div>

              {cursorDay.bookings.length > 0 && (
                <div className={styles.onNow}>
                  <span className={styles.onNowLabel}>
                    {String(t("booking.pickerAlreadyBooked"))}
                  </span>
                  {cursorDay.bookings.map((b, i) => (
                    <span key={i} className={styles.onNowRow}>
                      {clock(b.start)}
                      {b.end !== null ? `–${clock(b.end)}` : ""} · {b.title}
                    </span>
                  ))}
                </div>
              )}

              {cursorDay.status === "blackout" && (
                <p className={styles.railNote}>
                  {String(t("booking.pickerUnavailableDate"))}
                </p>
              )}

              {/* Slot chips are a `dateTime` answer: in `date` mode the
                  window is typed beside the picker, so a chip here would be
                  a second answer to the same question. */}
              {!dateOnly &&
                groupSlots(cursorDay.slots).map((group) => (
                  <div key={group.key} className={styles.group}>
                    <span className={styles.groupName}>
                      {String(t(`booking.pickerPart_${group.key}` as never))}
                    </span>
                    <div className={styles.slots}>
                      {group.slots.map((minutes) => {
                        const on = value.includes(makeEntry(cursor!, minutes));
                        return (
                          <button
                            key={minutes}
                            type="button"
                            className={[styles.slot, on ? styles.slotOn : ""]
                              .filter(Boolean)
                              .join(" ")}
                            aria-pressed={on}
                            disabled={disabled}
                            onClick={() => togglePick(cursor!, minutes)}
                          >
                            {clock(minutes)}
                            {nextDay(minutes) && (
                              <span className={styles.plusOne}>+1</span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}

              {alternatives.length > 0 && (
                <div className={styles.group}>
                  <span className={styles.groupName}>
                    {String(t("booking.pickerAlternatives"))}
                  </span>
                  {alternatives.map((alt) => (
                    <button
                      key={alt.date}
                      type="button"
                      className={styles.alt}
                      onClick={() => setCursor(alt.date)}
                    >
                      <b>{dayLabel(alt.date, locale)}</b>
                      {/* The first free slot is a `dateTime` fact; in `date`
                          mode it would read as a time being offered. */}
                      {!dateOnly && (
                        <span className={styles.altWhen}>
                          {clock(alt.first)}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* ── ranked shortlist ─────────────────────────────────────────── */}
      <div className={styles.tray}>
        {value.length === 0 ? (
          <p className={styles.trayEmpty}>
            {String(
              dateOnly
                ? t("booking.pickerTrayEmptyDate")
                : t("booking.pickerTrayEmpty", { max }),
            )}
          </p>
        ) : (
          value.map((entry, index) => {
            const { date, minutes } = splitEntry(entry);
            return (
              <div key={entry} className={styles.trayRow}>
                <span className={styles.trayRank}>{index + 1}</span>
                <span className={styles.trayWhen}>
                  {dayLabel(date, locale)}
                  {minutes !== null ? ` · ${clock(minutes)}` : ""}
                </span>
                {/* Rank copy belongs to a ranked shortlist; `date` mode asks
                    for one day, which is not a preference order. */}
                {!dateOnly && index === 0 && (
                  <span className={styles.trayNote}>
                    {String(t("booking.pickerFirstChoice"))}
                  </span>
                )}
                {index > 0 && (
                  <button
                    type="button"
                    className={styles.trayUp}
                    disabled={disabled}
                    onClick={() => moveUp(index)}
                    aria-label={String(t("booking.pickerMoveUp"))}
                  >
                    {String(t("booking.pickerMoveUpShort"))}
                  </button>
                )}
                <button
                  type="button"
                  className={styles.trayX}
                  disabled={disabled}
                  onClick={() => removeAt(index)}
                  aria-label={`${String(t("admin.bkFormRemoveDate"))} ${index + 1}`}
                >
                  <X size={15} />
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
