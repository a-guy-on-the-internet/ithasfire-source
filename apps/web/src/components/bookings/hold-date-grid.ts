import { indexHoldsByDay } from "@/app/admin/[slug]/_components/event-calendar-holds";
import type { CalendarHold } from "@/app/admin/[slug]/_components/event-calendar-types";

// ─────────────────────────────────────────────────────────────────────────────
// THE HOLD MONTH — the pure model behind `HoldDatePicker` (booking-holds
// FR-002, 2026-08-31 owner ruling: "a month you can click across").
//
// A hold is a place in a LINE for a `(calendarId, date)` pair. The one fact
// that decides which night a booker wants is WHAT THEY WOULD BE JOINING, and
// until now that only arrived after the write landed. Every cell this module
// builds carries it up front: the live line's depth, and the position this act
// would take if the cell were clicked (`lineLength + 1` — the same arithmetic
// the server does inside the line lock, so the two agree except across a race).
//
// PURE, and tested without a render (`__tests__/hold-date-grid.test.ts`):
// month construction, per-day state, the offered position, range selection and
// the selection reducer are all plain data in / plain data out. The component
// is thin over this, and owns only i18n, layout and the mutation.
//
// DATE ARITHMETIC IS ISO-STRING ARITHMETIC. Every date here is a place-local
// `YYYY-MM-DD` and every helper goes through `Date.UTC` at noon, so no
// operation can be shifted by the VIEWER's zone — the trap that makes
// `new Date("2026-08-19")` land on Aug 18 west of Greenwich.
//
// WHAT BLOCKS, AND WHAT ONLY WARNS. The server refuses exactly two things: a
// PAST date, and a line with a CONFIRMED winner (`HOLD_LINE_ALREADY_CONFIRMED`
// — what confirming a hold, or publishing an event on the calendar-day, leaves
// behind). Those two are hard-blocked here.
//
// A DARK NIGHT IS NOT ONE OF THEM (owner ruling 2026-08-31). `placeBookingHold`
// never consults availability, so refusing a dark night in the UI forbade
// something the server allows, with no override — and a venue opening specially
// for the right act is a normal booking, not an edge case. Dark nights are
// therefore SELECTABLE and MARKED: the hatch stays, the accessible name still
// says "venue dark", and the tray chip carries the mark so one unusual night
// among five picks is visible at a glance.
//
// BULK SELECTION STILL SKIPS THEM (`bulkSelectable`). A Shift-range or an
// "all open Fridays" sweep must not quietly rope in a night the venue is shut;
// an explicit single click is the intent signal. The one exception is the act's
// OWN asked-for dates, which are a named list rather than a sweep — skipping
// one there would make "Select the act's 3 dates" add two.
//
// `taken` is the server's word, via two sources the overlay now supplies
// together: a PUBLISHED/COMPLETED event on this calendar, and a CONFIRMED hold
// on the line (`booking-hold-overlay.ts` carries CONFIRMED alongside the live
// line for exactly this). Never DRAFT — staff create unrelated drafts freely,
// and making a bookable night unreachable is worse than a rejected date, which
// the `placeMany` `failed[]` tray already handles.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The contract's ceiling: one press may take at most this many dates.
 *
 * MIRRORS `MAX_BOOKING_HOLD_BATCH_DATES` in
 * `packages/core/src/use-cases/booking-holds/place-booking-holds.ts`, and is
 * deliberately NOT imported from it: that module reaches `_shared/hold-context`
 * → repos, ports and `parseInput`, so importing the constant would drag the
 * server-side hold machinery into the client bundle to save one number. The
 * server re-validates the length regardless — this value only decides when the
 * tray stops accepting, so drift costs a rejected press, not a wrong write.
 */
export const MAX_HOLD_DATES = 12;

export type HoldDayStatus =
  /** Before the venue's today. Nothing can be held here (FR-010). */
  | "past"
  /**
   * The venue posts no hours, or has blacked the day out. Still holdable —
   * the server allows it, and the venue can open for the right act.
   */
  | "dark"
  /** A published show already owns the night; the line is over. */
  | "taken"
  /** Holdable — empty, or with a line this act can join. */
  | "open";

export type HoldDayCell = {
  /** Place-local `YYYY-MM-DD`. */
  date: string;
  dayOfMonth: number;
  /** 0 = Sunday. */
  weekday: number;
  status: HoldDayStatus;
  /** This day's LIVE holds, in line order. Staff-side data only. */
  line: readonly CalendarHold[];
  /** A challenge clock is running on someone in this line. */
  challenged: boolean;
  /** This request's own position in the line, when it is already in it. */
  minePosition: number | null;
  /**
   * What this act would take by holding here — `line.length + 1`. Null when
   * the day cannot take a hold at all, so a caller can never print an offer
   * for a night that is not on offer.
   */
  offeredPosition: number | null;
  /** The act named this date on its request (`preferredDates`). */
  preferred: boolean;
  /** The show that took the night, when `status === "taken"`. */
  takenLabel: string | null;
  /** Click, Space and Enter do something here. Includes dark nights. */
  selectable: boolean;
  /**
   * Selectable AND ordinary — what a Shift-range or a weekday sweep may take.
   * A dark night is `selectable` but not `bulkSelectable`: bulk must never
   * quietly add a night the venue is shut.
   */
  bulkSelectable: boolean;
};

export type HoldMonth = {
  year: number;
  /** 0-indexed, as `Date` counts them. */
  month: number;
  /** `YYYY-MM-01` — the month's identity, for query keys and labels. */
  firstDate: string;
  /** `YYYY-MM-DD` of the last day. */
  lastDate: string;
  daysInMonth: number;
  /** Weeks of seven, Sunday-first; `null` pads the first and last week. */
  weeks: (HoldDayCell | null)[][];
  /** Every real day, in order. */
  cells: HoldDayCell[];
  byDate: Map<string, HoldDayCell>;
};

// ─────────────────────────────────────────────────────────────────────────────
// ISO date arithmetic — viewer-zone-proof
// ─────────────────────────────────────────────────────────────────────────────

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: string): boolean {
  return ISO_DATE.test(value);
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** `(2026, 9, 6)` → `"2026-10-06"`. `month` is 0-indexed. */
export function isoDate(year: number, month: number, day: number): string {
  return `${year}-${pad(month + 1)}-${pad(day)}`;
}

/** Noon UTC for a `YYYY-MM-DD`, so ±1 day can never cross a DST edge. */
function utcNoon(date: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1, 12));
}

function fromUtc(probe: Date): string {
  return isoDate(probe.getUTCFullYear(), probe.getUTCMonth(), probe.getUTCDate());
}

export function addIsoDays(date: string, days: number): string {
  const probe = utcNoon(date);
  probe.setUTCDate(probe.getUTCDate() + days);
  return fromUtc(probe);
}

/** 0 = Sunday. */
export function isoWeekday(date: string): number {
  return utcNoon(date).getUTCDay();
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0, 12)).getUTCDate();
}

/**
 * Same day-of-month in a neighbouring month, CLAMPED to that month's length —
 * so PageDown from 31 Jan lands on 28 Feb rather than skidding into March,
 * which is what naive `setMonth` does.
 */
export function addIsoMonths(date: string, months: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const target = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1 + months, 1, 12));
  const year = target.getUTCFullYear();
  const month = target.getUTCMonth();
  return isoDate(year, month, Math.min(d ?? 1, daysInMonth(year, month)));
}

/**
 * The place's TODAY, and any instant's place-local calendar day. `en-CA`
 * because it is the one widely-shipped locale whose short date IS ISO order;
 * the alternative is assembling `formatToParts` by hand for the same answer.
 */
export function placeDayKey(instant: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(instant);
  } catch {
    // An unknown zone must not take the picker down with it: fall back to the
    // viewer's own day, which is within a day of right everywhere.
    return isoDate(instant.getFullYear(), instant.getMonth(), instant.getDate());
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Month construction
// ─────────────────────────────────────────────────────────────────────────────

export type HoldMonthInput = {
  year: number;
  /** 0-indexed. */
  month: number;
  /** The VENUE's today, `YYYY-MM-DD` — never the viewer's. */
  today: string;
  /** The request being placed, so its own holds read as "yours", not "theirs". */
  bookingRequestId: string;
  /** The calendar overlay's LIVE holds for the window (any date range). */
  holds: readonly CalendarHold[];
  /** Days the venue posts no hours for, or has blacked out. */
  closedDates: ReadonlySet<string>;
  /** Date → the show that owns the night. See the module header on under-marking. */
  takenDates: ReadonlyMap<string, string>;
  /** Dates the act named on its request. */
  preferredDates: ReadonlySet<string>;
};

export function buildHoldMonth(input: HoldMonthInput): HoldMonth {
  const { year, month } = input;
  const total = daysInMonth(year, month);
  const byDay = indexHoldsByDay(input.holds);

  const cells: HoldDayCell[] = [];
  for (let day = 1; day <= total; day += 1) {
    cells.push(deriveHoldDay(isoDate(year, month, day), byDay, input));
  }

  const firstDate = isoDate(year, month, 1);
  const leading = isoWeekday(firstDate);
  const padded: (HoldDayCell | null)[] = [
    ...Array.from({ length: leading }, () => null),
    ...cells,
  ];
  while (padded.length % 7 !== 0) padded.push(null);

  const weeks: (HoldDayCell | null)[][] = [];
  for (let i = 0; i < padded.length; i += 7) weeks.push(padded.slice(i, i + 7));

  return {
    year,
    month,
    firstDate,
    lastDate: isoDate(year, month, total),
    daysInMonth: total,
    weeks,
    cells,
    byDate: new Map(cells.map((cell) => [cell.date, cell])),
  };
}

function deriveHoldDay(
  date: string,
  byDay: ReadonlyMap<string, CalendarHold[]>,
  input: Pick<
    HoldMonthInput,
    "today" | "bookingRequestId" | "closedDates" | "takenDates" | "preferredDates"
  >,
): HoldDayCell {
  const line = byDay.get(date) ?? [];
  const mine = line.find((h) => h.bookingRequestId === input.bookingRequestId) ?? null;
  const takenLabel = input.takenDates.get(date) ?? null;

  // PRECEDENCE. Past beats everything (nothing can be held there at all), then
  // a taken night (the line is over even if the venue is nominally open), then
  // the venue being dark. Each is a different sentence, so only the first true
  // one is the day's state.
  const status: HoldDayStatus =
    date < input.today
      ? "past"
      : takenLabel !== null
        ? "taken"
        : input.closedDates.has(date)
          ? "dark"
          : "open";

  // Already in this line? The DB's one-live-hold-per-(request, calendar, date)
  // unique means a second press is `booking_hold_exists`, so the day is shown
  // as held rather than offered again.
  const holdable = (status === "open" || status === "dark") && mine === null;

  return {
    date,
    dayOfMonth: Number(date.slice(8, 10)),
    weekday: isoWeekday(date),
    status,
    line,
    challenged: line.some((h) => h.status === "CHALLENGED"),
    minePosition: mine?.position ?? null,
    offeredPosition: holdable ? line.length + 1 : null,
    preferred: input.preferredDates.has(date),
    takenLabel,
    selectable: holdable,
    bulkSelectable: holdable && status === "open",
  };
}

/**
 * Whether the in-cell "Dark" word is NOISE this month (availability-onboarding
 * FR-006 `note:`). When every rendered day the word could sit on is dark, 31
 * repetitions of one word carry no information — the hatch and the legend
 * already say it — so the grid suppresses the WORD and nothing else: the
 * hatch, the legend entry and the "venue dark" accessible name all stay.
 *
 * PAST days don't break the run. A month that is half past and half dark
 * still shows a uniform field of "Dark" on every cell that prints a word at
 * all (past cells print none), which is the same noise. Anything else — an
 * open night, a taken night, a night this request already holds — is a real
 * difference between days, and the word returns so the dark ones read against
 * it.
 */
export function monthReadsAllDark(cells: readonly HoldDayCell[]): boolean {
  let sawDark = false;
  for (const cell of cells) {
    if (cell.status === "dark") {
      sawDark = true;
      continue;
    }
    if (cell.status !== "past") return false;
  }
  return sawDark;
}

/**
 * Client-side stand-in for the UNCONFIGURED detector
 * (`places.getAvailabilitySetupState`), derived from the one availability
 * window the picker already holds.
 *
 * A Place with ZERO CalendarAvailability rows computes every day as `closed`
 * and can never produce a `blackout` (a blackout requires an explicit dated
 * row — the spec's `why_precise`). So "every non-past day reads closed, and
 * nothing is blacked out or open" is the zero-rows signature — a single
 * blackout or open window proves somebody has stated hours, and one
 * non-closed day is enough to say the venue is configured.
 *
 * A PER-MONTH APPROXIMATION, deliberately second fiddle: a configured venue
 * that genuinely shuts for the whole rendered month looks identical from
 * here. Callers must prefer the server detector's answer whenever it has one
 * and fall back to this only while that read has not answered.
 */
export function availabilityLooksUnconfigured(
  days: readonly { status: string }[],
): boolean {
  let sawClosed = false;
  for (const day of days) {
    if (day.status === "closed") {
      sawClosed = true;
      continue;
    }
    if (day.status !== "past") return false;
  }
  return sawClosed;
}

/**
 * What a cell SAYS, as data — so the component can render one i18n sentence
 * per case and the cases themselves stay pinned by tests. `preferred` rides
 * on the cell and is appended by the caller; it qualifies every case.
 */
export type HoldDayDescriptor =
  | { kind: "past" }
  | { kind: "taken"; label: string }
  | { kind: "held"; position: number }
  /** Holdable, venue open. */
  | { kind: "open"; lineLength: number; offered: number }
  /** Holdable, venue shut — the same offer, with the warning attached. */
  | { kind: "dark"; lineLength: number; offered: number };

export function describeHoldDay(cell: HoldDayCell): HoldDayDescriptor {
  if (cell.status === "past") return { kind: "past" };
  if (cell.status === "taken") {
    return { kind: "taken", label: cell.takenLabel ?? "" };
  }
  if (cell.minePosition !== null) {
    return { kind: "held", position: cell.minePosition };
  }
  const offer = {
    lineLength: cell.line.length,
    offered: cell.offeredPosition ?? cell.line.length + 1,
  };
  return cell.status === "dark"
    ? { kind: "dark", ...offer }
    : { kind: "open", ...offer };
}

// ─────────────────────────────────────────────────────────────────────────────
// Selection
// ─────────────────────────────────────────────────────────────────────────────

export type HoldSelection = {
  /** Chosen dates, always ascending — the order the tray and the wire use. */
  dates: readonly string[];
  /** Last date picked by hand; the point a Shift-range runs FROM. */
  anchor: string | null;
};

export const EMPTY_HOLD_SELECTION: HoldSelection = { dates: [], anchor: null };

function sorted(dates: Iterable<string>): string[] {
  return [...new Set(dates)].sort();
}

export function isHoldDateSelected(selection: HoldSelection, date: string): boolean {
  return selection.dates.includes(date);
}

/** Click / Space / Enter. A full tray still lets you DESELECT. */
export function toggleHoldDate(
  selection: HoldSelection,
  cell: HoldDayCell,
): HoldSelection {
  if (selection.dates.includes(cell.date)) {
    return {
      dates: selection.dates.filter((d) => d !== cell.date),
      anchor: selection.anchor === cell.date ? null : selection.anchor,
    };
  }
  if (!cell.selectable) return selection;
  if (selection.dates.length >= MAX_HOLD_DATES) return selection;
  return { dates: sorted([...selection.dates, cell.date]), anchor: cell.date };
}

/**
 * Shift-click / Shift+Arrow: everything from the anchor to `date`, inclusive.
 *
 * SKIPS what it will not take — taken nights, past days, dates this request
 * already holds, AND dark nights — rather than refusing the whole range.
 * Dragging across a dark Monday is the normal case for a venue, and a range
 * that silently does nothing because one day in the middle is unavailable is
 * the kind of control people stop trusting. Dark is skipped here even though a
 * single click would take it: a sweep is not an intent signal for an unusual
 * night (owner ruling 2026-08-31).
 *
 * The cap applies mid-range: dates are taken in ascending order until the tray
 * is full, so a long drag fills deterministically rather than at random.
 */
export function extendHoldSelection(
  selection: HoldSelection,
  month: HoldMonth,
  date: string,
): HoldSelection {
  const cell = month.byDate.get(date);
  if (!cell) return selection;
  if (selection.anchor === null) return toggleHoldDate(selection, cell);

  const from = selection.anchor < date ? selection.anchor : date;
  const to = selection.anchor < date ? date : selection.anchor;

  const next = new Set(selection.dates);
  for (let cursor = from; cursor <= to; cursor = addIsoDays(cursor, 1)) {
    if (next.size >= MAX_HOLD_DATES) break;
    const candidate = month.byDate.get(cursor);
    if (candidate?.bulkSelectable) next.add(cursor);
  }
  return { dates: sorted(next), anchor: date };
}

/** The quick actions ("Select the act's 3 dates", "All open Fridays"). */
export function addHoldDates(
  selection: HoldSelection,
  month: HoldMonth,
  dates: readonly string[],
): HoldSelection {
  const next = new Set(selection.dates);
  let anchor = selection.anchor;
  for (const date of dates) {
    if (next.size >= MAX_HOLD_DATES) break;
    if (!month.byDate.get(date)?.selectable) continue;
    next.add(date);
    anchor = date;
  }
  return { dates: sorted(next), anchor };
}

export function removeHoldDate(
  selection: HoldSelection,
  date: string,
): HoldSelection {
  return {
    dates: selection.dates.filter((d) => d !== date),
    anchor: selection.anchor === date ? null : selection.anchor,
  };
}

/** After a `placeMany`: drop what landed, keep what did not so it can be swapped. */
export function retainFailedHoldDates(
  selection: HoldSelection,
  failedDates: readonly string[],
): HoldSelection {
  const failed = new Set(failedDates);
  return {
    dates: selection.dates.filter((d) => failed.has(d)),
    anchor: null,
  };
}

/**
 * Dates the act asked for that this month can take — DARK INCLUDED. This is a
 * named list, not a sweep: silently dropping a dark night would make the
 * button's own count ("Select the act's 3 dates") add two, and each one lands
 * in the tray carrying its dark mark anyway.
 */
export function selectablePreferredDates(month: HoldMonth): string[] {
  return month.cells.filter((c) => c.preferred && c.selectable).map((c) => c.date);
}

/**
 * Every OPEN day in the month sharing a weekday — "all open Fridays". A sweep,
 * so `bulkSelectable`: dark nights are not roped in.
 */
export function selectableWeekdayDates(month: HoldMonth, weekday: number): string[] {
  return month.cells
    .filter((c) => c.weekday === weekday && c.bulkSelectable)
    .map((c) => c.date);
}

// ─────────────────────────────────────────────────────────────────────────────
// Roving focus
// ─────────────────────────────────────────────────────────────────────────────

export type HoldGridMove =
  | "prevDay"
  | "nextDay"
  | "prevWeek"
  | "nextWeek"
  | "weekStart"
  | "weekEnd"
  | "prevMonth"
  | "nextMonth";

/**
 * Where a key takes focus. Arrows deliberately CROSS the month boundary — the
 * caller pages the grid to follow, which is what every date picker worth using
 * does; refusing at the edge leaves an arrow key that does nothing on six days
 * out of thirty.
 */
export function moveHoldFocus(date: string, move: HoldGridMove): string {
  switch (move) {
    case "prevDay":
      return addIsoDays(date, -1);
    case "nextDay":
      return addIsoDays(date, 1);
    case "prevWeek":
      return addIsoDays(date, -7);
    case "nextWeek":
      return addIsoDays(date, 7);
    case "weekStart":
      return addIsoDays(date, -isoWeekday(date));
    case "weekEnd":
      return addIsoDays(date, 6 - isoWeekday(date));
    case "prevMonth":
      return addIsoMonths(date, -1);
    case "nextMonth":
      return addIsoMonths(date, 1);
  }
}

/** `Home`/`End`/arrows/`PageUp`/`PageDown` → a move, or null for "not ours". */
export function holdGridMoveForKey(key: string): HoldGridMove | null {
  switch (key) {
    case "ArrowLeft":
      return "prevDay";
    case "ArrowRight":
      return "nextDay";
    case "ArrowUp":
      return "prevWeek";
    case "ArrowDown":
      return "nextWeek";
    case "Home":
      return "weekStart";
    case "End":
      return "weekEnd";
    case "PageUp":
      return "prevMonth";
    case "PageDown":
      return "nextMonth";
    default:
      return null;
  }
}

/**
 * The MONTH the picker opens on: the one holding the act's first asked-for
 * date that has not passed, else the current month.
 *
 * Opening on "today's month" is wrong for the normal case. A request made in
 * August for two Fridays in October opened on August, where every single day
 * is past and disabled, so the operator's first action was always "press
 * next-month twice" — and further out, worse. This is `initialFocusDate`'s
 * idea one level up: never open on a screen where nothing can be picked.
 *
 * `today` is the caller's best available answer at mount, which is the
 * VIEWER's day until the availability read returns the venue's zone. The two
 * can differ by a day, and that only changes the answer when a preferred date
 * is today-or-yesterday AND sits on a month boundary — in which case the
 * fallback is still a month with usable days in it.
 */
export function initialHoldMonth(
  preferredDates: readonly string[],
  today: string,
): { year: number; month: number } {
  const upcoming = [...preferredDates]
    .filter(isIsoDate)
    .sort()
    .find((date) => date >= today);
  const seed = upcoming ?? today;
  return { year: Number(seed.slice(0, 4)), month: Number(seed.slice(5, 7)) - 1 };
}

/**
 * The day the grid opens on: the act's first holdable asked-for date, else the
 * first holdable day, else the first of the month. Opening on a day the
 * operator cannot use wastes the first keystroke.
 */
export function initialFocusDate(month: HoldMonth): string {
  const preferred = month.cells.find((c) => c.preferred && c.selectable);
  if (preferred) return preferred.date;
  // An ORDINARY open night first — landing the cursor on a dark Monday would
  // make the unusual case look like the default.
  const open = month.cells.find((c) => c.bulkSelectable);
  return open?.date ?? month.cells.find((c) => c.selectable)?.date ?? month.firstDate;
}
