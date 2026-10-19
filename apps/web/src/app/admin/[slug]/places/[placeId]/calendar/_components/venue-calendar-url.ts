import type {
  CalendarEventStatus,
  CalendarFilters,
  CalendarView,
} from "@/app/admin/[slug]/_components/calendar/types";

// ─────────────────────────────────────────────────────────────────────────────
// The place calendar's URL state (event-calendar-redesign FR-015: "place
// persists the active filters in the URL query string"). View, anchor,
// status / series / holds chips and the selected calendar all live in the
// query so a link to "this week, Main Room, drafts hidden" is shareable and
// survives a reload. Pure: parse and build are unit-tested without React.
//
//   ?view=week&date=2026-09-02&status=published,draft&series=<id>&holds=0&calendar=<id>
//
// Every value is validated on the way in; an unknown or malformed one falls
// back to the default rather than throwing. Defaults are OMITTED on the way
// out so the plain page URL stays clean.
// ─────────────────────────────────────────────────────────────────────────────

export const PLACE_DEFAULT_VIEW: CalendarView = "week";
const VIEWS: CalendarView[] = ["month", "week", "agenda"];
const STATUSES: CalendarEventStatus[] = ["PUBLISHED", "DRAFT", "COMPLETED", "CANCELLED"];
export const PLACE_DEFAULT_STATUSES: CalendarEventStatus[] = ["PUBLISHED", "DRAFT", "COMPLETED"];

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export type VenueCalendarUrlState = {
  view: CalendarView;
  /** `YYYY-MM-DD` in the venue zone, or null for "today". */
  dateKey: string | null;
  statuses: Set<CalendarEventStatus>;
  seriesId: string | null;
  showHolds: boolean;
  /** Null = "All calendars". */
  calendarId: string | null;
};

export type ParamReader = { get(name: string): string | null };

export function parseVenueCalendarParams(
  params: ParamReader | null | undefined,
): VenueCalendarUrlState {
  const get = (k: string) => params?.get(k)?.trim() || null;
  const rawView = get("view");
  const rawDate = get("date");
  const rawStatus = get("status");
  const rawHolds = get("holds");

  const statuses = rawStatus
    ? rawStatus
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter((s): s is CalendarEventStatus => (STATUSES as string[]).includes(s))
    : null;

  return {
    view: rawView && (VIEWS as string[]).includes(rawView) ? (rawView as CalendarView) : PLACE_DEFAULT_VIEW,
    dateKey: rawDate && DATE_RE.test(rawDate) && validDate(rawDate) ? rawDate : null,
    statuses: new Set(statuses && statuses.length > 0 ? statuses : PLACE_DEFAULT_STATUSES),
    seriesId: get("series"),
    showHolds: rawHolds !== "0",
    calendarId: get("calendar"),
  };
}

function validDate(key: string): boolean {
  const [, y, m, d] = DATE_RE.exec(key)!.map(Number) as [number, number, number, number];
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const probe = new Date(Date.UTC(y, m - 1, d, 12));
  return probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

/** `?…` (no leading `?`); empty when everything is at its default. */
export function buildVenueCalendarSearch(state: VenueCalendarUrlState): string {
  const params = new URLSearchParams();
  if (state.view !== PLACE_DEFAULT_VIEW) params.set("view", state.view);
  if (state.dateKey) params.set("date", state.dateKey);
  const statuses = STATUSES.filter((s) => state.statuses.has(s));
  const isDefault =
    statuses.length === PLACE_DEFAULT_STATUSES.length &&
    PLACE_DEFAULT_STATUSES.every((s) => state.statuses.has(s));
  if (!isDefault) params.set("status", statuses.map((s) => s.toLowerCase()).join(","));
  if (state.seriesId) params.set("series", state.seriesId);
  if (!state.showHolds) params.set("holds", "0");
  if (state.calendarId) params.set("calendar", state.calendarId);
  return params.toString();
}

export function filtersFromUrlState(state: VenueCalendarUrlState): CalendarFilters {
  return {
    statuses: state.statuses,
    ...(state.seriesId ? { seriesId: state.seriesId } : {}),
    showHolds: state.showHolds,
  };
}

export function urlStateWithFilters(
  state: VenueCalendarUrlState,
  filters: CalendarFilters,
): VenueCalendarUrlState {
  return {
    ...state,
    statuses: filters.statuses,
    seriesId: filters.seriesId && filters.seriesId !== "all" ? filters.seriesId : null,
    showHolds: filters.showHolds !== false,
  };
}

/** "5:00 PM – 2:00 AM" from minutes-from-midnight (end may pass 1440). */
export function formatHoursSpan(startMinutes: number, endMinutes: number): string {
  return `${formatClock(startMinutes)} – ${formatClock(endMinutes)}`;
}

function formatClock(minutes: number): string {
  const total = ((minutes % 1440) + 1440) % 1440;
  const h = Math.floor(total / 60);
  const m = total % 60;
  const period = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${period}`;
}
