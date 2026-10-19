import type { CalendarEventStatus, CalendarHoldStatus, CalendarView } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Every human-readable string the engine paints, in one typed object.
//
// Two sources, merged in this order:
//   1. English defaults (below) — what a mount outside `AppLocaleProvider`
//      renders, and what the tests assert against.
//   2. The app catalog, via `useTranslations()` — every existing `admin.ec*`
//      key the old engine used is read here; a key that is missing from the
//      active catalog falls back to the default (the translator returns the
//      key itself on a miss, so a raw `admin.ecSun` can never reach the DOM).
//   3. `CalendarEngineProps.labels` — a mount's overrides, last.
//
// Pluralised and interpolated strings are FUNCTIONS, never `${n} ${noun}s`
// concatenation, so a locale with different plural rules can supply its own.
// The proposed `admin.cal*` catalog keys for the new strings are listed in the
// review hand-off; until they land, the defaults carry them. Pure module (no
// React) so `helpers.ts` can share the name tables; the context lives in
// `use-calendar-labels.tsx`.
// ─────────────────────────────────────────────────────────────────────────────

export type CalendarLabels = {
  /** Sunday-first, seven entries. */
  weekdaysShort: readonly string[];
  /** January-first, twelve entries. */
  monthsShort: readonly string[];
  monthsLong: readonly string[];
  statuses: Record<CalendarEventStatus, string>;
  holdStatuses: Record<CalendarHoldStatus, string>;
  views: Record<CalendarView, string>;
  /** aria-label of the view SegmentedControl. */
  viewGroup: string;
  previous: string;
  next: string;
  today: string;
  tomorrow: string;
  /** aria-label of the overflow menu trigger. */
  more: string;
  loading: string;
  /** aria-label of the filter-chip row. */
  filtersGroup: string;
  /** The collapsed filter trigger below 600px. */
  filters: string;
  /** "Filters · 2" — the collapsed trigger once a facet is off its default. */
  filtersWithCount: (count: number) => string;
  /** Group heading over the status toggles inside a filter panel. */
  status: string;
  /** Group heading over the owner toggles, and the owner menu's aria-label. */
  owners: string;
  /** The owner menu's label while every owner is on. */
  allOwners: string;
  /** "3 owners" — the owner menu's label with a partial selection. */
  ownerCount: (count: number) => string;
  /** The Holds filter chip and the week's all-day holds strip. */
  holds: string;
  series: string;
  allSeries: string;
  showAllHours: string;
  showVenueHours: string;
  /** Week footer prefix a mount may use to compose `hoursCaption`. */
  hours: string;
  showMore: string;
  showMoreRange: (range: string) => string;
  /** "+3 more" — the month cell's overflow link. */
  plusMore: (count: number) => string;
  /** "3 more on September 5" — its accessible name. */
  moreOnDate: (count: number, date: string) => string;
  createEventOn: (date: string) => string;
  newEventOn: (date: string) => string;
  nothingOnDay: string;
  emptyWindow: string;
  eventCount: (count: number) => string;
  holdCount: (count: number) => string;
  itemCount: (count: number) => string;
  soldOut: string;
  unconfirmed: string;
  doubleBooked: string;
  /** The continuation chip's time slot. */
  continued: string;
  venueLocal: (time: string) => string;
  hold: string;
  /** "Hold · #2" */
  holdTag: (position: number) => string;
  /** "#2 · Confirmed" */
  holdConfirmedTag: (position: number) => string;
  /** "#2 · Fri · 5:00 PM" — the respond-by on a challenged chip (FR-016). */
  holdChallengedTag: (position: number, respondBy: string) => string;
  holdLine: string;
  openBooking: string;
  publicPage: string;
  edit: string;
  copyLink: string;
  copied: string;
  downloadIcs: string;
  respondBy: (when: string) => string;
  placed: (date: string) => string;
  /** "Date 2 of 6" — the agenda glyph's accessible name. */
  dateOf: (index: number, total: number) => string;
  /** "2 of 6" — the peek's value beside the `date` key. */
  occurrenceOf: (index: number, total: number) => string;
  /** Peek key/value labels. */
  keys: {
    venue: string;
    local: string;
    sold: string;
    going: string;
    date: string;
    series: string;
    owner: string;
  };
};

export const DEFAULT_CALENDAR_LABELS: CalendarLabels = {
  weekdaysShort: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
  monthsShort: [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ],
  monthsLong: [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ],
  statuses: {
    PUBLISHED: "Published",
    DRAFT: "Draft",
    COMPLETED: "Completed",
    CANCELLED: "Cancelled",
  },
  holdStatuses: {
    ACTIVE: "Held",
    CHALLENGED: "Challenged",
    CONFIRMED: "Confirmed",
  },
  views: { month: "Month", week: "Week", agenda: "Agenda" },
  viewGroup: "Calendar view",
  previous: "Previous",
  next: "Next",
  today: "Today",
  tomorrow: "Tomorrow",
  more: "More",
  loading: "Loading",
  filtersGroup: "Calendar filters",
  filters: "Filters",
  filtersWithCount: (count) => `Filters · ${count}`,
  status: "Status",
  owners: "Owners",
  allOwners: "All owners",
  ownerCount: (count) => (count === 1 ? "1 owner" : `${count} owners`),
  holds: "Holds",
  series: "Series",
  allSeries: "All series",
  showAllHours: "Show all hours",
  showVenueHours: "Show place hours",
  hours: "Hours",
  showMore: "Show more",
  showMoreRange: (range) => `Show more · ${range}`,
  plusMore: (count) => `+${count} more`,
  moreOnDate: (count, date) => `${count} more on ${date}`,
  createEventOn: (date) => `Create event on ${date}`,
  newEventOn: (date) => `New event · ${date}`,
  nothingOnDay: "Nothing on this day.",
  emptyWindow: "No events in this window.",
  eventCount: (count) => (count === 1 ? "1 event" : `${count} events`),
  holdCount: (count) => (count === 1 ? "1 hold" : `${count} holds`),
  itemCount: (count) => (count === 1 ? "1 item" : `${count} items`),
  soldOut: "Sold out",
  unconfirmed: "Unconfirmed",
  doubleBooked: "Double-booked",
  continued: "cont.",
  venueLocal: (time) => `Local time at the place: ${time}`,
  hold: "Hold",
  holdTag: (position) => `Hold · #${position}`,
  holdConfirmedTag: (position) => `#${position} · Confirmed`,
  holdChallengedTag: (position, respondBy) => `#${position} · ${respondBy}`,
  holdLine: "Hold line",
  openBooking: "Open booking",
  publicPage: "Public page",
  edit: "Edit",
  copyLink: "Copy link",
  copied: "Copied",
  downloadIcs: "Download .ics",
  respondBy: (when) => `Respond by ${when}`,
  placed: (date) => `Placed ${date}`,
  dateOf: (index, total) => `Date ${index} of ${total}`,
  occurrenceOf: (index, total) => `${index} of ${total}`,
  keys: {
    venue: "Place",
    local: "Local",
    sold: "Sold",
    going: "Going",
    date: "Date",
    series: "Series",
    owner: "Owner",
  },
};

/** The subset the pure helpers need to name a day or a month. */
export type CalendarNames = Pick<
  CalendarLabels,
  "weekdaysShort" | "monthsShort" | "monthsLong"
>;

export const DEFAULT_CALENDAR_NAMES: CalendarNames = DEFAULT_CALENDAR_LABELS;

// ── Catalog keys (existing `admin.ec*`, read verbatim) ──────────────────────

const WEEKDAY_KEYS = [
  "admin.ecSun",
  "admin.ecMon",
  "admin.ecTue",
  "admin.ecWed",
  "admin.ecThu",
  "admin.ecFri",
  "admin.ecSat",
] as const;

const MONTH_KEYS = [
  "admin.ecJanuary",
  "admin.ecFebruary",
  "admin.ecMarch",
  "admin.ecApril",
  "admin.ecMay",
  "admin.ecJune",
  "admin.ecJuly",
  "admin.ecAugust",
  "admin.ecSeptember",
  "admin.ecOctober",
  "admin.ecNovember",
  "admin.ecDecember",
] as const;

const STATUS_KEYS: Record<CalendarEventStatus, string> = {
  PUBLISHED: "admin.ecPublished",
  DRAFT: "admin.ecDraft",
  COMPLETED: "admin.ecCompleted",
  CANCELLED: "admin.ecCancelled",
};

const VIEW_KEYS: Record<CalendarView, string> = {
  month: "admin.ecMonth",
  week: "admin.ecWeek",
  agenda: "admin.ecAgenda",
};

export type CalendarTranslate = (key: string, values?: Record<string, string | number>) => string;

/**
 * Catalog → labels. A key the active catalog lacks yields the English default
 * (the translator hands the key back on a miss, which is the signal).
 * Proposed `admin.cal*` keys are read here too, so they light up the moment
 * they land in the catalog without another engine change.
 */
export function resolveCalendarLabels(
  t: CalendarTranslate,
  overrides?: Partial<CalendarLabels>,
): CalendarLabels {
  const d = DEFAULT_CALENDAR_LABELS;
  const tr = (key: string, fallback: string): string => {
    const value = t(key);
    return value === key ? fallback : value;
  };
  const trFn = <A extends unknown[]>(
    key: string,
    values: (...args: A) => Record<string, string | number>,
    fallback: (...args: A) => string,
  ) => {
    return (...args: A): string => {
      const value = t(key, values(...args));
      return value === key ? fallback(...args) : value;
    };
  };

  const monthsLong = MONTH_KEYS.map((key, i) => tr(key, d.monthsLong[i]!));
  const monthsShort = d.monthsShort.map((fallback, i) => {
    const own = tr(`admin.calMonthShort${i + 1}`, "");
    if (own) return own;
    // A localised long name without a short key still beats an English stub.
    return monthsLong[i] === d.monthsLong[i] ? fallback : monthsLong[i]!.slice(0, 3);
  });

  const resolved: CalendarLabels = {
    weekdaysShort: WEEKDAY_KEYS.map((key, i) => tr(key, d.weekdaysShort[i]!)),
    monthsShort,
    monthsLong,
    statuses: {
      PUBLISHED: tr(STATUS_KEYS.PUBLISHED, d.statuses.PUBLISHED),
      DRAFT: tr(STATUS_KEYS.DRAFT, d.statuses.DRAFT),
      COMPLETED: tr(STATUS_KEYS.COMPLETED, d.statuses.COMPLETED),
      CANCELLED: tr(STATUS_KEYS.CANCELLED, d.statuses.CANCELLED),
    },
    holdStatuses: {
      ACTIVE: tr("admin.calHeld", d.holdStatuses.ACTIVE),
      CHALLENGED: tr("admin.calChallenged", d.holdStatuses.CHALLENGED),
      CONFIRMED: tr("admin.calConfirmed", d.holdStatuses.CONFIRMED),
    },
    views: {
      month: tr(VIEW_KEYS.month, d.views.month),
      week: tr(VIEW_KEYS.week, d.views.week),
      agenda: tr(VIEW_KEYS.agenda, d.views.agenda),
    },
    viewGroup: tr("admin.calViewGroup", d.viewGroup),
    previous: tr("admin.ecPrevious", d.previous),
    next: tr("admin.ecNext", d.next),
    today: tr("admin.ecToday", d.today),
    tomorrow: tr("admin.calTomorrow", d.tomorrow),
    more: tr("admin.calMore", d.more),
    loading: tr("admin.calLoading", d.loading),
    filtersGroup: tr("admin.calFiltersGroup", d.filtersGroup),
    filters: tr("admin.calFilters", d.filters),
    filtersWithCount: trFn(
      "admin.calFiltersWithCount",
      (count: number) => ({ count }),
      d.filtersWithCount,
    ),
    status: tr("admin.calStatus", d.status),
    owners: tr("admin.calOwners", d.owners),
    allOwners: tr("admin.calAllOwners", d.allOwners),
    ownerCount: trFn("admin.calOwnerCount", (count: number) => ({ count }), d.ownerCount),
    holds: tr("admin.calHolds", d.holds),
    series: tr("admin.calSeries", d.series),
    allSeries: tr("admin.calAllSeries", d.allSeries),
    showAllHours: tr("admin.calShowAllHours", d.showAllHours),
    showVenueHours: tr("admin.calShowVenueHours", d.showVenueHours),
    hours: tr("admin.calHours", d.hours),
    showMore: tr("admin.calShowMore", d.showMore),
    showMoreRange: trFn("admin.calShowMoreRange", (range: string) => ({ range }), d.showMoreRange),
    plusMore: trFn("admin.calPlusMore", (count: number) => ({ count }), d.plusMore),
    moreOnDate: trFn(
      "admin.calMoreOnDate",
      (count: number, date: string) => ({ count, date }),
      d.moreOnDate,
    ),
    createEventOn: trFn("admin.ecCreateEventOn", (date: string) => ({ date }), d.createEventOn),
    newEventOn: trFn("admin.calNewEventOn", (date: string) => ({ date }), d.newEventOn),
    nothingOnDay: tr("admin.calNothingOnDay", d.nothingOnDay),
    emptyWindow: tr("admin.calEmptyWindow", d.emptyWindow),
    eventCount: trFn("admin.venueCalendarEventCount", (count: number) => ({ count }), d.eventCount),
    holdCount: trFn("admin.ecHoldCount", (count: number) => ({ count }), d.holdCount),
    itemCount: trFn("admin.calItemCount", (count: number) => ({ count }), d.itemCount),
    soldOut: tr("admin.calSoldOut", d.soldOut),
    unconfirmed: tr("admin.venueCalUnconfirmed", d.unconfirmed),
    doubleBooked: tr("admin.ecConflict", d.doubleBooked),
    continued: tr("admin.calContinued", d.continued),
    venueLocal: trFn("admin.calVenueLocal", (time: string) => ({ time }), d.venueLocal),
    hold: tr("admin.ecHoldLegend", d.hold),
    holdTag: trFn("admin.calHoldTag", (position: number) => ({ position }), d.holdTag),
    holdConfirmedTag: trFn(
      "admin.calHoldConfirmedTag",
      (position: number) => ({ position }),
      d.holdConfirmedTag,
    ),
    holdChallengedTag: trFn(
      "admin.calHoldChallengedTag",
      (position: number, respondBy: string) => ({ position, respondBy }),
      d.holdChallengedTag,
    ),
    holdLine: tr("admin.calHoldLine", d.holdLine),
    openBooking: tr("admin.calOpenBooking", d.openBooking),
    publicPage: tr("admin.calPublicPage", d.publicPage),
    edit: tr("admin.calEdit", d.edit),
    copyLink: tr("admin.calCopyLink", d.copyLink),
    copied: tr("admin.calCopied", d.copied),
    downloadIcs: tr("admin.ecDownloadIcs", d.downloadIcs),
    respondBy: trFn("admin.calRespondBy", (when: string) => ({ when }), d.respondBy),
    placed: trFn("admin.calPlaced", (date: string) => ({ date }), d.placed),
    dateOf: trFn(
      "admin.calDateOf",
      (index: number, total: number) => ({ index, total }),
      d.dateOf,
    ),
    occurrenceOf: trFn(
      "admin.calOccurrenceOf",
      (index: number, total: number) => ({ index, total }),
      d.occurrenceOf,
    ),
    keys: {
      venue: tr("admin.calKeyVenue", d.keys.venue),
      local: tr("admin.calKeyLocal", d.keys.local),
      sold: tr("admin.calKeySold", d.keys.sold),
      going: tr("admin.calKeyGoing", d.keys.going),
      date: tr("admin.calKeyDate", d.keys.date),
      series: tr("admin.calKeySeries", d.keys.series),
      owner: tr("admin.calKeyOwner", d.keys.owner),
    },
  };

  if (!overrides) return resolved;
  return {
    ...resolved,
    ...overrides,
    statuses: { ...resolved.statuses, ...overrides.statuses },
    holdStatuses: { ...resolved.holdStatuses, ...overrides.holdStatuses },
    views: { ...resolved.views, ...overrides.views },
    keys: { ...resolved.keys, ...overrides.keys },
  };
}
