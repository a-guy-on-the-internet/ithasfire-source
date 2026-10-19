"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { useRouter } from "@bprogress/next/app";
import { keepPreviousData } from "@tanstack/react-query";
import { YStack, XStack, styled } from "tamagui";
import { Text, Button, StyledSelect, useNotify, useTranslations } from "@th/ui";
import { ArrowLeft, AlertTriangle, Download, Rss } from "lucide-react";
import { computeHoursWindow } from "@th/core/use-cases/places/compute-hours-window";
import * as Sentry from "@sentry/nextjs";

import { trpc } from "@/trpc";
import { getTrpcHttpUrl } from "@/config/trpc";
import { useCreateDraftEvent } from "@/hooks/useCreateDraftEvent";
import { useViewerTimezone } from "@/hooks/useViewerTimezone";
import { adminBookingHref } from "@/lib/agreement-routes";
import {
  buildMonthIcs,
  buildSingleEventIcs,
  copyText,
  downloadTextFile,
  WEBCAL_FEED_LOCALES,
  webcalFeedUrl,
} from "@/lib/calendar/calendar-actions";
import { shouldRetryPlacePrivacyRead } from "@/lib/places/venue-location-ceiling";
import type { QuickCreatePrefill } from "@/lib/quick-create-prefill";
import {
  CalendarEngine,
  applyFilters,
  cellPrefillWallClock,
  distinctSeries,
  getWeekDays,
  isEvent,
  useCalendarText,
  useIcsTexts,
  visibleRangeFor,
  zoneParts,
  zonedInstant,
  CAL_BORDER,
  CAL_WARNING,
  CAL_WARNING_SOFT,
  type CalendarEventItem,
  type CalendarEventStatus,
  type CalendarFilters,
  type CalendarHoldItem,
  type CalendarHoldLineMate,
  type CalendarItem,
  type CalendarItemPressResult,
  type CalendarView,
  type HoursWindow,
} from "@/app/admin/[slug]/_components/calendar";
import {
  VenueEventConfirmDialog,
  type VenueEventConfirmTarget,
} from "./VenueEventConfirmDialog";
import {
  buildVenueCalendarSearch,
  filtersFromUrlState,
  formatHoursSpan,
  parseVenueCalendarParams,
  urlStateWithFilters,
  PLACE_DEFAULT_STATUSES,
  type VenueCalendarUrlState,
} from "./venue-calendar-url";

// ─────────────────────────────────────────────────────────────────────────────
// Place mount of the calendar engine (event-calendar-redesign, phase 2b).
//
// Paints in the VENUE's zone (FR-018), opens in week (FR-008), keeps view /
// anchor / filters / selected calendar in the URL (FR-015), derives the
// week's hours window from CalendarAvailability for the calendar in scope
// (FR-011, FR-005 for "All"), and carries the place's create-on-click
// context (default or selected calendar, sole active space) into quick
// create (FR-019). Holds render per (date, calendar) line (FR-016).
// ─────────────────────────────────────────────────────────────────────────────

const STATUSES: CalendarEventStatus[] = ["PUBLISHED", "DRAFT", "COMPLETED", "CANCELLED"];
const AGENDA_PAGE_DAYS = 30;
/** Ceiling for a rolling agenda page, before the read's own cap is applied. */
const AGENDA_MAX_DAYS = 90;
const DAY_MS = 86_400_000;
/**
 * `getVenueCalendar` (admin mode) rejects `to - from > 90d` outright with
 * `time_window_too_large`, and a BAD_REQUEST here replaces the WHOLE page
 * with the generic error screen — no way back to the calendar.
 *
 * The trap is that the page size is not the span: `visibleRangeFor("agenda")`
 * runs from local MIDNIGHT of the anchor day to the END of day anchor+N, so
 * an N-day page paints N+1 days (and one more again across a DST fall-back).
 * `agendaDaysThatFit` therefore measures the candidate's real painted span
 * rather than trusting arithmetic on the page size.
 */
const MAX_READ_WINDOW_MS = 90 * DAY_MS;
const ALL_CALENDARS = "all";

const PageContainer = styled(YStack, {
  name: "PageContainer",
  gap: "$5",
  padding: "$4",
  width: "100%",
  maxWidth: 1000,
  marginHorizontal: "auto",
  $gtMd: { padding: "$6" },
});

/** Mono count tag beside the heading — tags rung, 2px structural frame. */
function CountTag({
  children,
  warning = false,
  testId,
}: {
  children: string;
  warning?: boolean;
  testId?: string;
}) {
  return (
    <span
      data-testid={testId}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "3px 8px",
        border: `2px solid ${CAL_BORDER}`,
        background: warning ? CAL_WARNING_SOFT : "transparent",
        whiteSpace: "nowrap",
      }}
    >
      {warning && <AlertTriangle size={12} aria-hidden />}
      <Text variant="overline" tone="default">
        {children}
      </Text>
    </span>
  );
}

type VenueEventRow = {
  eventId: string;
  slug: string | null;
  title: string;
  startsAt: Date;
  endsAt: Date | null;
  status: string;
  soldOut: boolean | null;
  seriesId: string | null;
  seriesName: string | null;
  /** `Event.calendarId` — null for a listing filed on no named calendar. */
  calendarId: string | null;
  timezone: string;
  occurrence: { index: number; total: number } | null;
  venueConfirmed: boolean;
  venueOwned: boolean;
};

type VenueHoldRow = {
  id: string;
  /**
   * Null for a hold with no request (holds-without-a-request FR-001): the
   * link then opens the inbox, and its label falls back to `holdFallback`
   * until the request-less labels land (plan step 14).
   */
  bookingRequestId: string | null;
  calendarId: string;
  spaceId: string | null;
  date: string;
  position: number;
  status: "ACTIVE" | "CHALLENGED" | "CONFIRMED" | "RELEASED";
  respondBy: Date | null;
  lapsed: boolean;
  actName: string | null;
  performerDisplayName: string | null;
};

/**
 * Venue-confirmation spec (docs/specs/2026-08-27): a third-party listing is
 * one the venue does not own, or has not (yet) confirmed. Those get the
 * Confirm / Not mine / Withdraw dialog on press; venue-owned ones do not.
 */
function isThirdParty(row: Pick<VenueEventRow, "venueConfirmed" | "venueOwned">): boolean {
  return row.venueOwned === false || row.venueConfirmed === false;
}

/**
 * Admin read rows → event items. A selected `calendarId` keeps only that
 * calendar's events — a listing on NO calendar belongs to "All" alone, so
 * it drops too (same rule the holds follow).
 */
export function toVenueEventItems(
  rows: readonly VenueEventRow[],
  opts: {
    slug: string;
    placeName?: string;
    conflictIds: ReadonlySet<string>;
    calendarId?: string | null;
    /** Copy for a row with no title (NFR-002 — never a literal here). */
    untitled?: string;
  },
): CalendarEventItem[] {
  const out: CalendarEventItem[] = [];
  for (const e of rows) {
    if (!(STATUSES as string[]).includes(e.status)) continue;
    if (opts.calendarId && e.calendarId !== opts.calendarId) continue;
    const seriesId = e.seriesId ?? undefined;
    out.push({
      kind: "event",
      id: `${e.eventId}:${e.occurrence?.index ?? 0}`,
      eventId: e.eventId,
      title: e.title || opts.untitled || "Untitled event",
      status: e.status as CalendarEventStatus,
      startsAt: e.startsAt,
      endsAt: e.endsAt,
      timezone: e.timezone,
      ...(opts.placeName ? { venueName: opts.placeName } : {}),
      ...(seriesId ? { seriesId, seriesName: e.seriesName ?? undefined } : {}),
      occurrence: e.occurrence ? { index: e.occurrence.index, total: e.occurrence.total } : null,
      ...(e.soldOut != null ? { soldOut: e.soldOut } : {}),
      venueConfirmed: e.venueConfirmed,
      conflict: opts.conflictIds.has(e.eventId),
      // TODO(FR-014): the place peek cannot show the owning ORG or an "Open
      // booking" action because `calendarEventSchema` (get-venue-calendar)
      // carries neither `ownerName`/`ownerKey` nor `bookingRequestId` on an
      // event row. Deferred rather than widened here — see the spec's
      // open_questions entry.
      href: {
        // A third-party listing is not this venue's to edit — no dead link.
        ...(e.venueOwned !== false
          ? { edit: `/admin/${opts.slug}/events/${e.eventId}/edit` }
          : {}),
        public: `/events/${e.slug ?? e.eventId}`,
        ...(seriesId && e.venueOwned !== false
          ? { series: `/admin/${opts.slug}/events/${e.eventId}/dates` }
          : {}),
      },
    });
  }
  return out;
}

/**
 * Live holds → one item per hold, each carrying the WHOLE line for its
 * (date, calendar) so the peek can show who is ahead (FR-014 / FR-016).
 * Lapsed / released holds are dropped; a selected calendar filters to its
 * own line.
 */
export function toVenueHoldItems(
  rows: readonly VenueHoldRow[],
  opts: {
    slug: string;
    timezone: string;
    placeName?: string;
    calendarId: string | null;
    spaceNames: ReadonlyMap<string, string>;
    /** Copy for a hold whose request names no act (NFR-002). */
    holdFallback?: string;
  },
): CalendarHoldItem[] {
  const live = rows.filter(
    (h) =>
      !h.lapsed &&
      h.status !== "RELEASED" &&
      (opts.calendarId === null || h.calendarId === opts.calendarId),
  );
  const lines = new Map<string, VenueHoldRow[]>();
  for (const h of live) {
    const key = `${h.date}|${h.calendarId}`;
    const line = lines.get(key) ?? [];
    line.push(h);
    lines.set(key, line);
  }
  const titleOf = (h: VenueHoldRow) =>
    h.actName || h.performerDisplayName || opts.holdFallback || "Hold";
  const out: CalendarHoldItem[] = [];
  for (const line of lines.values()) {
    line.sort((a, b) => a.position - b.position);
    const mates: CalendarHoldLineMate[] = line.map((h) => ({
      position: h.position,
      title: titleOf(h),
      status: h.status as CalendarHoldLineMate["status"],
      respondBy: h.respondBy,
    }));
    for (const h of line) {
      const [y, m, d] = h.date.split("-").map(Number) as [number, number, number];
      const spaceName = h.spaceId ? opts.spaceNames.get(h.spaceId) : undefined;
      out.push({
        kind: "hold",
        id: h.id,
        title: titleOf(h),
        position: h.position,
        status: h.status as CalendarHoldItem["status"],
        respondBy: h.respondBy,
        startsAt: zonedInstant(y, m, d, 0, 0, opts.timezone),
        endsAt: null,
        ...(opts.placeName ? { venueName: opts.placeName } : {}),
        ...(spaceName ? { spaceName } : {}),
        bookingHref: adminBookingHref(opts.slug, h.bookingRequestId),
        lineMates: mates,
      });
    }
  }
  return out;
}

/** "5:00 PM – 2:00 AM" across the visible week, or the no-hours copy. */
export function describeHoursWindow(
  window: HoursWindow | undefined,
  noHoursLabel = "No hours set",
): string {
  const open = (window ?? []).filter((w): w is NonNullable<typeof w> => w !== null);
  if (open.length === 0) return noHoursLabel;
  const start = Math.min(...open.map((w) => w.startMinutes));
  const end = Math.max(...open.map((w) => w.endMinutes));
  return formatHoursSpan(start, end);
}

/**
 * The largest page size ≤ `wanted` whose PAINTED agenda span still fits the
 * read's 90-day cap. Measures `visibleRangeFor` for each candidate instead of
 * subtracting a day and hoping — the span also stretches by an hour across a
 * DST boundary, which a `- 1` would not catch.
 */
export function agendaDaysThatFit(
  wanted: number,
  floor: number,
  anchor: Date,
  timezone: string,
): number {
  for (let days = wanted; days > floor; days -= 1) {
    const range = visibleRangeFor(
      "agenda",
      anchor,
      timezone,
      new Date(anchor.getTime() + days * DAY_MS),
    );
    if (range.to.getTime() - range.from.getTime() <= MAX_READ_WINDOW_MS) return days;
  }
  return floor;
}

function apiOrigin(): string {
  return getTrpcHttpUrl().replace(/\/trpc\/?$/, "");
}
function siteOrigin(): string {
  return typeof window !== "undefined" ? window.location.origin : "";
}

/** Write the URL state without a navigation; Next syncs `useSearchParams`. */
function replaceSearch(next: VenueCalendarUrlState) {
  if (typeof window === "undefined") return;
  const search = buildVenueCalendarSearch(next);
  const { pathname, hash } = window.location;
  window.history.replaceState(null, "", `${pathname}${search ? `?${search}` : ""}${hash}`);
}

export function VenueCalendar() {
  const { slug, placeId } = useParams<{ slug: string; placeId: string }>();
  const router = useRouter();
  const t = useTranslations();
  // Every mount-owned string goes through the per-key fallback translator, so
  // a key that has not landed in the catalog renders English, never the key.
  const ct = useCalendarText();
  const icsTexts = useIcsTexts();
  const { toast } = useNotify();
  const searchParams = useSearchParams();

  // ── URL state (FR-015) ──────────────────────────────────────────────────
  const urlState = useMemo(() => parseVenueCalendarParams(searchParams), [searchParams]);
  const { view, dateKey, calendarId: requestedCalendarId } = urlState;
  const filters = useMemo(() => filtersFromUrlState(urlState), [urlState]);
  const [agendaDays, setAgendaDays] = useState(AGENDA_PAGE_DAYS);
  // Stable "today" for the anchor when the URL names no date — a fresh
  // `new Date()` per render would churn the fetch window every paint.
  const [today] = useState(() => new Date());

  // ── Reads ───────────────────────────────────────────────────────────────
  const placeTitleQuery = trpc.places.getPlaceTitle.useQuery(
    { placeId },
    { enabled: Boolean(placeId), staleTime: 60_000, retry: 2 },
  );
  const placeName = placeTitleQuery.data?.name;

  // Whether the venue hides its address, for the confirm dialog's disclosure
  // (confirming releases the street to that event's ticket holders). The
  // ANONYMOUS projection on purpose: it answers "what does this venue
  // publish?" and carries nothing a manager-only read would add.
  // `getPlaceTitle` must not grow a location field (see its router doc).
  const placePrivacyQuery = trpc.places.getPlacePublic.useQuery(
    { placeId },
    {
      enabled: Boolean(placeId),
      staleTime: 60_000,
      // Once, and only for a transient failure: a NOT_FOUND is final.
      retry: shouldRetryPlacePrivacyRead,
    },
  );
  // Unknown (loading, failed) counts as withheld: the cost of the line on a
  // venue that publishes its address is one sentence; the cost of a missing
  // line is a venue sharing its street without being told.
  const venueWithholdsAddress =
    placePrivacyQuery.data?.place.locationIsExact !== true;

  const calendarsQuery = trpc.places.listCalendars.useQuery(
    { placeId },
    { enabled: Boolean(placeId), staleTime: 60_000, retry: 1 },
  );
  const calendars = useMemo(() => calendarsQuery.data ?? [], [calendarsQuery.data]);
  const selectedCalendar = useMemo(
    () =>
      requestedCalendarId ? (calendars.find((c) => c.id === requestedCalendarId) ?? null) : null,
    [calendars, requestedCalendarId],
  );
  // A calendar id the place no longer has (deleted, wrong link) reads as "All".
  const selectedCalendarId = selectedCalendar?.id ?? null;

  const availabilityQuery = trpc.places.listCalendarAvailability.useQuery(
    { placeId },
    { enabled: Boolean(placeId), staleTime: 60_000, retry: 1 },
  );

  const viewerTimezone = useViewerTimezone();

  // The paint zone is the VENUE's (FR-018). It arrives with the first page;
  // until then the viewer's zone stands in and the grid re-derives once.
  const [venueTimezoneSeen, setVenueTimezoneSeen] = useState<string | null>(null);
  const timezone = venueTimezoneSeen ?? viewerTimezone;

  const anchor = useMemo(() => {
    if (!dateKey) return today;
    const [y, m, d] = dateKey.split("-").map(Number) as [number, number, number];
    return zonedInstant(y, m, d, 12, 0, timezone);
  }, [dateKey, timezone, today]);

  const agendaPageEnd = useMemo(
    () => new Date(anchor.getTime() + agendaDays * DAY_MS),
    [anchor, agendaDays],
  );
  const range = useMemo(
    () => visibleRangeFor(view, anchor, timezone, agendaPageEnd),
    [view, anchor, timezone, agendaPageEnd],
  );

  // `keepPreviousData`: stepping keeps the previous window painted (dimmed)
  // until the next lands, instead of swapping the grid for a spinner.
  const { data, isLoading, isPlaceholderData, error } = trpc.places.getVenueCalendar.useQuery(
    { placeId, from: range.from, to: range.to },
    {
      enabled: Boolean(placeId),
      staleTime: 30_000,
      retry: 1,
      placeholderData: keepPreviousData,
    },
  );
  if (data?.venueTimezone && data.venueTimezone !== venueTimezoneSeen) {
    // Derived from the read, not an effect: no extra paint in the wrong zone.
    setVenueTimezoneSeen(data.venueTimezone);
  }

  // ── Items ───────────────────────────────────────────────────────────────
  const conflictIds = useMemo(() => {
    const ids = new Set<string>();
    for (const c of data?.conflicts ?? []) {
      ids.add(c.eventAId);
      ids.add(c.eventBId);
    }
    return ids;
  }, [data?.conflicts]);

  const eventRows = useMemo(() => data?.events ?? [], [data?.events]);
  const eventItems = useMemo(
    () =>
      toVenueEventItems(eventRows, {
        slug,
        placeName,
        conflictIds,
        calendarId: selectedCalendarId,
        untitled: ct("admin.calUntitledEvent", "Untitled event"),
      }),
    [eventRows, slug, placeName, conflictIds, selectedCalendarId, ct],
  );
  // The heading's conflict tag follows the painted set: a double-booking
  // counts while at least one of its events is on the calendar in scope.
  const conflictCount = useMemo(() => {
    const painted = new Set(eventItems.map((e) => e.eventId));
    return (data?.conflicts ?? []).filter(
      (c) => painted.has(c.eventAId) || painted.has(c.eventBId),
    ).length;
  }, [data?.conflicts, eventItems]);

  const spaceNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of calendars) for (const s of c.spaces) map.set(s.id, s.name);
    return map;
  }, [calendars]);

  const holdItems = useMemo(
    () =>
      toVenueHoldItems(data?.holds ?? [], {
        slug,
        timezone,
        placeName,
        calendarId: selectedCalendarId,
        spaceNames,
        holdFallback: ct("admin.ecHoldLegend", "Hold"),
      }),
    [data?.holds, slug, timezone, placeName, selectedCalendarId, spaceNames, ct],
  );

  const items = useMemo<CalendarItem[]>(
    () => [...eventItems, ...holdItems],
    [eventItems, holdItems],
  );

  const seriesOptions = useMemo(
    () => distinctSeries(eventItems, ct("admin.calSeries", "Series")),
    [eventItems, ct],
  );

  const filterOptions = useMemo(
    () => ({
      ...(seriesOptions.length > 0 ? { series: seriesOptions } : {}),
      // Offer the Holds chip only where a hold exists — or where the reader
      // has already switched them off, so the control is always undoable
      // (the state lives in the URL and would otherwise be unreachable).
      ...(holdItems.length > 0 || filters.showHolds === false ? { holds: true } : {}),
      // The chips' neutral state, for the collapsed "Filters · {n}" badge.
      defaults: { statuses: new Set(PLACE_DEFAULT_STATUSES), showHolds: true },
    }),
    [seriesOptions, holdItems.length, filters.showHolds],
  );

  // ── Hours window (FR-011 / FR-005) ──────────────────────────────────────
  const weekDays = useMemo(() => getWeekDays(anchor, timezone), [anchor, timezone]);
  const hoursWindow = useMemo<HoursWindow | undefined>(() => {
    const rows = availabilityQuery.data;
    if (!rows) return undefined;
    return computeHoursWindow({
      rows,
      scope: selectedCalendarId ? { calendarId: selectedCalendarId } : "all",
      weekDays: weekDays.map((d) => d.start),
      timezone,
    });
  }, [availabilityQuery.data, selectedCalendarId, weekDays, timezone]);
  const [showAllHours, setShowAllHours] = useState(false);

  /**
   * NFR-003: a FAILED availability read used to be indistinguishable from a
   * venue that has set no hours — both produced `undefined` and the caption
   * read "No hours set", quietly telling the operator their opening hours are
   * missing. The window still falls back to auto-fit (the week must paint),
   * but the caption says so and the failure is reported once.
   */
  const hoursUnavailable = availabilityQuery.isError;
  const reportedHoursError = useRef(false);
  useEffect(() => {
    if (!hoursUnavailable || reportedHoursError.current) return;
    reportedHoursError.current = true;
    try {
      Sentry.captureException(availabilityQuery.error, {
        tags: { area: "calendar", surface: "venue-calendar", read: "listCalendarAvailability" },
        extra: { placeId },
      });
    } catch {
      // A throwing reporter must never change what the operator sees.
    }
  }, [hoursUnavailable, availabilityQuery.error, placeId]);

  const hoursSpan = hoursUnavailable
    ? ct("admin.calHoursUnavailable", "Hours unavailable")
    : describeHoursWindow(hoursWindow, ct("admin.calNoHoursSet", "No hours set"));
  const hoursCaption = ct("admin.calHoursCaption", "Hours · {scope} · {span} · {zone}", {
    scope: selectedCalendar?.name ?? ct("admin.calAllCalendars", "All calendars"),
    span: hoursSpan,
    zone: timezone,
  });

  // ── URL writers ─────────────────────────────────────────────────────────
  const handleViewChange = useCallback(
    (next: CalendarView) => {
      if (next !== urlState.view) replaceSearch({ ...urlState, view: next });
    },
    [urlState],
  );
  const handleAnchorChange = useCallback(
    (next: Date) => {
      const p = zoneParts(next, timezone);
      const key = `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
      setAgendaDays(AGENDA_PAGE_DAYS);
      replaceSearch({ ...urlState, dateKey: key });
    },
    [urlState, timezone],
  );
  const handleFiltersChange = useCallback(
    (next: CalendarFilters) => replaceSearch(urlStateWithFilters(urlState, next)),
    [urlState],
  );
  // "Show more" may only grow the page while the PAINTED span still fits the
  // read's 90-day cap — a 90-day page spans 91 days and the read rejects it,
  // which replaced the whole page with the generic error screen.
  const nextAgendaDays = useCallback(
    (current: number) =>
      agendaDaysThatFit(
        Math.min(current + AGENDA_PAGE_DAYS, AGENDA_MAX_DAYS),
        current,
        anchor,
        timezone,
      ),
    [anchor, timezone],
  );
  const handleAgendaShowMore = useCallback(
    () => setAgendaDays((d) => nextAgendaDays(d)),
    [nextAgendaDays],
  );
  const hasMoreAgenda = nextAgendaDays(agendaDays) > agendaDays;

  const handleCalendarChange = useCallback(
    (value: string) =>
      replaceSearch({ ...urlState, calendarId: value === ALL_CALENDARS ? null : value }),
    [urlState],
  );

  // ── Confirm / Not mine / Withdraw (venue-confirmation spec) ─────────────
  // Pressing a THIRD-PARTY chip opens the decision dialog INSTEAD of the
  // engine's peek (the press is taken over — `false`); a venue-owned chip
  // gets the peek.
  const [confirmTarget, setConfirmTarget] = useState<VenueEventConfirmTarget | null>(null);
  const handleItemPress = useCallback(
    (item: CalendarItem): CalendarItemPressResult => {
      if (item.kind !== "event") return;
      const row = eventRows.find((e) => e.eventId === item.eventId);
      if (!row || !isThirdParty(row)) return;
      setConfirmTarget({
        id: row.eventId,
        title: row.title,
        startsAt: row.startsAt,
        venueConfirmed: row.venueConfirmed !== false,
      });
      return false;
    },
    [eventRows],
  );
  const closeConfirmDialog = useCallback(() => setConfirmTarget(null), []);

  const backToEdit = useCallback(
    () => router.push(`/admin/${slug}/places/${placeId}/settings`),
    [router, slug, placeId],
  );

  // ── Create-on-click (venue-hierarchy FR-011, FR-019) ────────────────────
  // The SELECTED calendar wins; otherwise the place's default. A space is
  // auto-picked only when the calendar joins exactly one ACTIVE space —
  // guessing between two is how a UI creates a double-booking.
  const targetCalendar = useMemo(
    () => selectedCalendar ?? calendars.find((c) => c.isDefault) ?? calendars[0] ?? null,
    [selectedCalendar, calendars],
  );
  const soleSpaceId = useMemo(() => {
    const active = (targetCalendar?.spaces ?? []).filter((r) => r.status === "ACTIVE");
    return active.length === 1 ? (active[0]?.id ?? null) : null;
  }, [targetCalendar]);

  const { createDraftAt, modeChoiceDialog } = useCreateDraftEvent(slug);

  const handleCreateAt = useCallback(
    (date: Date, opts: { view: CalendarView }) => {
      const prefill: QuickCreatePrefill = {
        startsAt: cellPrefillWallClock(date, timezone, {
          dateOnly: opts.view !== "week",
          defaultStartTime: targetCalendar?.defaultStartTime,
        }),
        placeId,
        ...(targetCalendar ? { calendarId: targetCalendar.id } : {}),
        ...(soleSpaceId ? { spaceId: soleSpaceId } : {}),
      };
      createDraftAt(prefill);
    },
    [timezone, targetCalendar, placeId, soleSpaceId, createDraftAt],
  );

  // ── Overflow (FR-017) + ICS (FR-014) ────────────────────────────────────
  const subscribe = useCallback(async (feedLocale: string) => {
    const url = webcalFeedUrl({ kind: "place", placeId }, apiOrigin(), feedLocale);
    const ok = await copyText(url);
    if (ok) toast.success({ id: "calendar-webcal", title: t("admin.ecCopiedWebcal"), message: url });
    else
      toast.danger({
        id: "calendar-webcal",
        title: ct("admin.calCopyFailed", "Couldn't copy"),
        message: url,
      });
  }, [placeId, toast, t, ct]);

  const exportMonth = useCallback(() => {
    const visible = applyFilters(items, filters, "internal").filter(isEvent);
    const p = zoneParts(anchor, timezone);
    const { filename, content } = buildMonthIcs(
      visible,
      p.year,
      p.month,
      placeName ?? ct("admin.calVenueFallbackName", "Place"),
      { siteBaseUrl: siteOrigin(), ...icsTexts },
    );
    downloadTextFile(filename, content);
  }, [items, filters, anchor, timezone, placeName, ct, icsTexts]);

  const overflowActions = useMemo(
    () => [
      ...WEBCAL_FEED_LOCALES.map((l) => ({
        label: t("admin.ecSubscribe", { language: l.name }),
        icon: <Rss size={14} aria-hidden />,
        onSelect: () => void subscribe(l.code),
      })),
      {
        label: ct("admin.calExportMonth", "Export month"),
        icon: <Download size={14} aria-hidden />,
        onSelect: exportMonth,
      },
    ],
    [subscribe, exportMonth, t, ct],
  );

  const downloadIcs = useCallback(
    (item: CalendarEventItem) => {
      const { filename, content } = buildSingleEventIcs(item, {
        siteBaseUrl: siteOrigin(),
        ...icsTexts,
      });
      downloadTextFile(filename, content);
    },
    [icsTexts],
  );

  // ── Error ───────────────────────────────────────────────────────────────
  if (error) {
    const isForbidden = error.data?.code === "FORBIDDEN";
    return (
      <YStack
        flex={1}
        justifyContent="center"
        alignItems="center"
        padding="$6"
        gap="$4"
        maxWidth={480}
        marginHorizontal="auto"
      >
        <YStack
          width={64}
          height={64}
          borderRadius={0}
          backgroundColor={isForbidden ? "$dangerMuted" : "$warningMuted"}
          justifyContent="center"
          alignItems="center"
        >
          {/* lucide writes `color` straight to `stroke`, so a Tamagui token
              name ("$danger") is invalid CSS and the glyph fell back to
              currentColor. Raw-DOM paths take `var(--token, <stub hex>)`. */}
          <AlertTriangle
            size={28}
            color={isForbidden ? "var(--danger, #B91C1C)" : CAL_WARNING}
          />
        </YStack>
        <Text variant="h3" textAlign="center">
          {isForbidden
            ? String(t("admin.venueCalendarAccessDenied"))
            : String(t("admin.venueCalendarGenericError"))}
        </Text>
        <Text variant="body" tone="muted" textAlign="center">
          {isForbidden
            ? String(t("admin.venueCalendarAccessDeniedDescription"))
            : String(t("admin.venueCalendarGenericErrorDescription"))}
        </Text>
        <Button onPress={backToEdit}>{String(t("admin.venueCalendarBackToVenue"))}</Button>
      </YStack>
    );
  }

  const calendarPicker: ReactNode = calendars.length > 0 && (
    <StyledSelect
      value={selectedCalendarId ?? ALL_CALENDARS}
      options={[
        { value: ALL_CALENDARS, label: ct("admin.calAllCalendars", "All calendars") },
        ...calendars.map((c) => ({ value: c.id, label: c.name })),
      ]}
      onChange={handleCalendarChange}
      ariaLabel={ct("admin.calCalendarPicker", "Calendar")}
      testId="venue-calendar-picker"
      height={38}
      minHeight={38}
      // Fills the toolbar's bounded trailing slot so a long calendar name
      // truncates inside the control instead of widening the toolbar row.
      fullWidth
    />
  );

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <PageContainer>
      <XStack alignItems="flex-start" gap="$3" flexWrap="wrap">
        <Button
          variant="ghost"
          size="$1"
          onPress={backToEdit}
          aria-label={t("admin.venueCalendarBackToVenue") as string}
        >
          <ArrowLeft size={18} />
        </Button>
        <YStack flex={1} minWidth={200} gap="$1">
          <Text variant="kicker" tone="accent" data-testid="venue-calendar-place">
            {placeName ?? " "}
          </Text>
          <Text
            variant="h2"
            tag="h2"
            style={{ textTransform: "uppercase", letterSpacing: -1, fontWeight: 900 }}
          >
            {t("admin.venueCalendarHeading")}
          </Text>
        </YStack>
        {data && (
          <XStack gap="$2" flexWrap="wrap" alignItems="center" paddingTop="$1">
            <CountTag testId="venue-calendar-event-count">
              {t("admin.venueCalendarEventCount", { count: eventItems.length })}
            </CountTag>
            {conflictCount > 0 && (
              <CountTag warning testId="venue-calendar-conflict-badge">
                {t("admin.venueCalendarConflictCount", { count: conflictCount })}
              </CountTag>
            )}
            {holdItems.length > 0 && (
              <CountTag testId="venue-calendar-hold-count">
                {t("admin.ecHoldCount", { count: holdItems.length })}
              </CountTag>
            )}
          </XStack>
        )}
      </XStack>

      <CalendarEngine
        mode="internal"
        items={items}
        view={view}
        onViewChange={handleViewChange}
        anchor={anchor}
        onAnchorChange={handleAnchorChange}
        timezone={timezone}
        viewerTimezone={viewerTimezone}
        filters={filters}
        onFiltersChange={handleFiltersChange}
        filterOptions={filterOptions}
        hoursWindow={showAllHours ? undefined : hoursWindow}
        hoursCaption={hoursCaption}
        onShowAllHours={setShowAllHours}
        loading={isLoading || isPlaceholderData}
        onCreateAt={handleCreateAt}
        onItemPress={handleItemPress}
        toolbarTrailing={calendarPicker}
        showTimezoneLabel={false}
        overflowActions={overflowActions}
        agendaPageEnd={agendaPageEnd}
        onAgendaShowMore={handleAgendaShowMore}
        hasMoreAgenda={hasMoreAgenda}
        peekVariant="place"
        onDownloadIcs={downloadIcs}
        emptyLabel={ct("admin.calVenueEmptyWindow", "Nothing at this place in this window.")}
      />

      {/* Community moderators get the Ticketed-vs-Community chooser before
          quick create; without this mounted the cell click does nothing for
          them (the hook only opens a dialog). Renders null otherwise. */}
      {modeChoiceDialog}

      <VenueEventConfirmDialog
        event={confirmTarget}
        onClose={closeConfirmDialog}
        venueWithholdsAddress={venueWithholdsAddress}
      />
    </PageContainer>
  );
}
