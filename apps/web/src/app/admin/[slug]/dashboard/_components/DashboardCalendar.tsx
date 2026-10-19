"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import { Download, Rss } from "lucide-react";
import { Button, Text, useNotify, useTranslations } from "@th/ui";

import { trpc } from "@/trpc";
import { getTrpcHttpUrl } from "@/config/trpc";
import { useCreateDraftEvent } from "@/hooks/useCreateDraftEvent";
import { useCurrentAdminOwner } from "@/hooks/useCurrentAdminOwner";
import type { OwnerEntityWithSlug } from "@/hooks/useEventOwnerEntities";
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
import {
  CalendarEngine,
  applyFilters,
  cellPrefillWallClock,
  distinctSeries,
  isEvent,
  stepAnchor,
  useCalendarText,
  useIcsTexts,
  visibleRangeFor,
  zoneParts,
  zonedInstant,
  type CalendarEventItem,
  type CalendarEventStatus,
  type CalendarFilters,
  type CalendarHoldItem,
  type CalendarItem,
  type CalendarView,
} from "@/app/admin/[slug]/_components/calendar";

// ─────────────────────────────────────────────────────────────────────────────
// Dashboard mount of the calendar engine (event-calendar-redesign, phase 2b).
//
// Owns everything the engine deliberately does not: the range-driven
// `events.listMine` reads (one per selected owner, FR-015), the requester-side
// holds (FR-004 / FR-016), view + filter persistence in localStorage, the
// create-on-click owner rule (FR-019) and the webcal / ICS actions (FR-017).
// Paints in the VIEWER's zone (FR-018) — the per-chip glyph is the only
// mismatch signal.
// ─────────────────────────────────────────────────────────────────────────────

/** Same key the retired engine used, so a stored preference carries over. */
export const VIEW_STORAGE_KEY = "th:calendar:viewMode";
export const filtersStorageKey = (slug: string) => `th:calendar:filters:${slug}`;

const VIEWS: CalendarView[] = ["month", "week", "agenda"];
const STATUSES: CalendarEventStatus[] = ["PUBLISHED", "DRAFT", "COMPLETED", "CANCELLED"];
const DEFAULT_STATUSES: CalendarEventStatus[] = ["PUBLISHED", "DRAFT", "COMPLETED"];
/** Agenda page size and the furthest "Show more" reaches (FR-009). */
const AGENDA_PAGE_DAYS = 30;
const AGENDA_MAX_DAYS = 180;
const DAY_MS = 86_400_000;

export type DashboardCalendarProps = {
  slug: string;
  /** The heading's name for the export file ("{name}-2026-09.ics"). */
  displayName: string;
};

type OwnerRef = OwnerEntityWithSlug;

export function ownerKeyOf(owner: OwnerRef): string {
  return owner.kind === "org" ? `org:${owner.orgId}` : `human:${owner.humanId}`;
}
function ownerIdOf(owner: OwnerRef): string {
  return owner.kind === "org" ? owner.orgId : owner.humanId;
}
function ownerTypeOf(owner: OwnerRef): "HUMAN" | "ORGANIZATION" {
  return owner.kind === "org" ? "ORGANIZATION" : "HUMAN";
}
function ownerNameOf(owner: OwnerRef): string {
  return owner.kind === "org" ? owner.orgName : owner.humanName;
}

/** What `th:calendar:filters:{slug}` stores. Owners `null` = every owner. */
type StoredFilters = {
  statuses: string[];
  owners: string[] | null;
  seriesId: string | null;
  showHolds: boolean;
};

export function defaultFilters(): CalendarFilters {
  return { statuses: new Set(DEFAULT_STATUSES), showHolds: true };
}

/** Defensive: a hand-edited or stale blob degrades to the defaults, never throws. */
export function parseStoredFilters(raw: string | null): CalendarFilters | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredFilters>;
    if (!parsed || typeof parsed !== "object") return null;
    const statuses = Array.isArray(parsed.statuses)
      ? parsed.statuses.filter((s): s is CalendarEventStatus =>
          (STATUSES as string[]).includes(s),
        )
      : DEFAULT_STATUSES;
    const owners =
      Array.isArray(parsed.owners) && parsed.owners.every((o) => typeof o === "string")
        ? new Set(parsed.owners)
        : undefined;
    return {
      statuses: new Set(statuses),
      ...(owners ? { owners } : {}),
      ...(typeof parsed.seriesId === "string" ? { seriesId: parsed.seriesId } : {}),
      showHolds: parsed.showHolds !== false,
    };
  } catch {
    return null;
  }
}

function serializeFilters(filters: CalendarFilters): string {
  const stored: StoredFilters = {
    statuses: [...filters.statuses],
    owners: filters.owners ? [...filters.owners] : null,
    seriesId: filters.seriesId && filters.seriesId !== "all" ? filters.seriesId : null,
    showHolds: filters.showHolds !== false,
  };
  return JSON.stringify(stored);
}

export function parseStoredView(raw: string | null): CalendarView | null {
  // "day" was removed with the redesign — it falls back to the default.
  return raw && (VIEWS as string[]).includes(raw) ? (raw as CalendarView) : null;
}

type ListMineRow = {
  id: string;
  title: string | null;
  status: string;
  startsAt: Date | null;
  endsAt: Date | null;
  slug: string | null;
  placeName: string | null;
  ticketsSold: number;
  totalCapacity: number | null;
  timezone: string;
  occurrence: { index: number; total: number } | null;
  /** The series an occurrence belongs to (null for a standalone event). */
  seriesId: string | null;
  seriesName: string | null;
};

/** `events.listMine` rows → engine items for one owner. */
export function toEventItems(
  rows: readonly ListMineRow[],
  owner: OwnerRef,
  /** Copy for a row with no title (NFR-002 — never a literal here). */
  untitled = "Untitled event",
): CalendarEventItem[] {
  const out: CalendarEventItem[] = [];
  for (const row of rows) {
    if (!row.startsAt) continue;
    if (!(STATUSES as string[]).includes(row.status)) continue;
    const seriesId = row.seriesId ?? undefined;
    out.push({
      kind: "event",
      id: `${row.id}:${row.occurrence?.index ?? 0}`,
      eventId: row.id,
      title: row.title || untitled,
      status: row.status as CalendarEventStatus,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      timezone: row.timezone,
      ...(row.placeName ? { venueName: row.placeName } : {}),
      ownerName: ownerNameOf(owner),
      ownerKey: ownerKeyOf(owner),
      ...(seriesId ? { seriesId, seriesName: row.seriesName ?? undefined } : {}),
      occurrence: row.occurrence ? { index: row.occurrence.index, total: row.occurrence.total } : null,
      ticketsSold: row.ticketsSold,
      totalCapacity: row.totalCapacity,
      href: {
        // The OWNER's admin slug, so an org event opens in the org context.
        edit: `/admin/${owner.adminSlug}/events/${row.id}/edit`,
        public: `/events/${row.slug ?? row.id}`,
        // There is no /series route; the dates page resolves the series.
        ...(seriesId ? { series: `/admin/${owner.adminSlug}/events/${row.id}/dates` } : {}),
      },
    });
  }
  return out;
}

type RequesterHoldRow = {
  id: string;
  bookingRequestId: string;
  placeName: string;
  /** `YYYY-MM-DD`, place-local. */
  date: string;
  position: number;
  status: "ACTIVE" | "CHALLENGED" | "CONFIRMED" | "RELEASED";
  respondBy: Date | null;
  requestTitle: string | null;
  /** Not on the wire today; honoured when it is. */
  placeTimezone?: string | null;
};

/**
 * `bookingHolds.listForRequester` rows → hold items. Holds are date-level:
 * midnight of the held day in the PLACE's zone when the payload carries it,
 * else in the paint zone (the day is still right; only a hold near a zone
 * boundary could shift).
 */
export function toHoldItems(
  rows: readonly RequesterHoldRow[],
  owner: OwnerRef,
  paintTimezone: string,
  /** "Hold at {place}" / the bare "Hold" fallback (NFR-002). */
  copy: { at: (place: string) => string; hold: string } = {
    at: (place) => `Hold at ${place}`,
    hold: "Hold",
  },
): CalendarHoldItem[] {
  const out: CalendarHoldItem[] = [];
  for (const h of rows) {
    // A released hold no longer occupies the line (the read already settles
    // lapses; RELEASED is the terminal state and never paints).
    if (h.status === "RELEASED") continue;
    const [y, m, d] = h.date.split("-").map(Number) as [number, number, number];
    const zone = h.placeTimezone || paintTimezone;
    out.push({
      kind: "hold",
      id: h.id,
      title: h.placeName ? copy.at(h.placeName) : (h.requestTitle ?? copy.hold),
      position: h.position,
      status: h.status,
      respondBy: h.respondBy,
      startsAt: zonedInstant(y, m, d, 0, 0, zone),
      endsAt: null,
      venueName: h.placeName,
      bookingHref: adminBookingHref(owner.adminSlug, h.bookingRequestId),
    });
  }
  return out;
}

function apiOrigin(): string {
  return getTrpcHttpUrl().replace(/\/trpc\/?$/, "");
}

function siteOrigin(): string {
  return typeof window !== "undefined" ? window.location.origin : "";
}

export function DashboardCalendar({ slug, displayName }: DashboardCalendarProps) {
  const t = useTranslations();
  // Per-key English fallback: a catalog gap must render English, never the key.
  const ct = useCalendarText();
  const icsTexts = useIcsTexts();
  const { toast } = useNotify();
  const utils = trpc.useUtils();
  const { currentOwner, ownerEntities } = useCurrentAdminOwner(slug);
  const { createDraftAt, modeChoiceDialog } = useCreateDraftEvent(slug);
  const timezone = useViewerTimezone();

  // ── Owners (FR-015) ─────────────────────────────────────────────────────
  // A personal dashboard spans the human plus every org they belong to; an
  // org dashboard is its single implicit owner (no chips).
  const owners = useMemo<OwnerRef[]>(() => {
    if (!currentOwner) return [];
    if (currentOwner.kind === "org") return [currentOwner];
    return ownerEntities.ownersWithSlugs ?? [currentOwner];
  }, [currentOwner, ownerEntities.ownersWithSlugs]);
  const isHumanDashboard = currentOwner?.kind === "human";

  // ── View / anchor / filters, persisted (SSR-safe) ───────────────────────
  // Initial state is the default on both server and client; storage is read
  // in an effect after mount so the first paint never drifts.
  const [view, setView] = useState<CalendarView>("agenda");
  const [anchor, setAnchor] = useState<Date>(() => new Date());
  const [agendaDays, setAgendaDays] = useState(AGENDA_PAGE_DAYS);
  const [filters, setFilters] = useState<CalendarFilters>(defaultFilters);
  const hydrated = useRef(false);

  useEffect(() => {
    try {
      const storedView = parseStoredView(window.localStorage.getItem(VIEW_STORAGE_KEY));
      if (storedView) setView(storedView);
      const storedFilters = parseStoredFilters(
        window.localStorage.getItem(filtersStorageKey(slug)),
      );
      if (storedFilters) setFilters(storedFilters);
    } catch {
      // Storage unavailable (private mode, quota) — defaults stand.
    }
    hydrated.current = true;
  }, [slug]);

  const handleViewChange = useCallback((next: CalendarView) => {
    setView(next);
    try {
      window.localStorage.setItem(VIEW_STORAGE_KEY, next);
    } catch {
      // non-critical
    }
  }, []);

  const handleFiltersChange = useCallback(
    (next: CalendarFilters) => {
      setFilters(next);
      try {
        window.localStorage.setItem(filtersStorageKey(slug), serializeFilters(next));
      } catch {
        // non-critical
      }
    },
    [slug],
  );

  const handleAnchorChange = useCallback((next: Date) => {
    setAnchor(next);
    // A new agenda start rolls a fresh 30-day page.
    setAgendaDays(AGENDA_PAGE_DAYS);
  }, []);

  const selectedOwners = useMemo(() => {
    if (!filters.owners) return owners;
    const picked = owners.filter((o) => filters.owners!.has(ownerKeyOf(o)));
    // Every stored key stale (left an org) ⇒ all, never an empty calendar.
    return picked.length > 0 ? picked : owners;
  }, [owners, filters.owners]);

  // ── Range-driven fetch ──────────────────────────────────────────────────
  const agendaPageEnd = useMemo(
    () => new Date(anchor.getTime() + agendaDays * DAY_MS),
    [anchor, agendaDays],
  );
  const range = useMemo(
    () => visibleRangeFor(view, anchor, timezone, agendaPageEnd),
    [view, anchor, timezone, agendaPageEnd],
  );

  const eventQueries = trpc.useQueries((q) =>
    selectedOwners.map((owner) =>
      q.events.listMine(
        {
          ownerType: ownerTypeOf(owner),
          ownerId: ownerIdOf(owner),
          limit: 100,
          expandDates: true,
          dateRange: range,
        },
        { staleTime: 60_000, placeholderData: keepPreviousData },
      ),
    ),
  );

  const holdsOn = filters.showHolds !== false;
  const holdQueries = trpc.useQueries((q) =>
    selectedOwners.map((owner) =>
      q.bookingHolds.listForRequester(
        { ownerType: ownerTypeOf(owner), ownerId: ownerIdOf(owner) },
        { staleTime: 60_000, enabled: holdsOn },
      ),
    ),
  );

  // Prefetch the adjacent month / week so stepping paints from cache.
  useEffect(() => {
    if (view === "agenda") return;
    for (const dir of [-1, 1] as const) {
      const next = visibleRangeFor(view, stepAnchor(anchor, view, dir, timezone), timezone);
      for (const owner of selectedOwners) {
        void utils.events.listMine.prefetch(
          {
            ownerType: ownerTypeOf(owner),
            ownerId: ownerIdOf(owner),
            limit: 100,
            expandDates: true,
            dateRange: next,
          },
          { staleTime: 60_000 },
        );
      }
    }
  }, [view, anchor, timezone, selectedOwners, utils]);

  // ── Items ───────────────────────────────────────────────────────────────
  const untitledLabel = ct("admin.calUntitledEvent", "Untitled event");
  const eventItems = useMemo(() => {
    const out: CalendarEventItem[] = [];
    selectedOwners.forEach((owner, i) => {
      const rows = eventQueries[i]?.data?.items;
      if (rows) out.push(...toEventItems(rows, owner, untitledLabel));
    });
    return out;
  }, [selectedOwners, eventQueries, untitledLabel]);

  const holdCopy = useMemo(
    () => ({
      at: (place: string) => ct("admin.calHoldAt", "Hold at {place}", { place }),
      hold: ct("admin.ecHoldLegend", "Hold"),
    }),
    [ct],
  );
  const holdItems = useMemo(() => {
    if (!holdsOn) return [] as CalendarHoldItem[];
    const out: CalendarHoldItem[] = [];
    selectedOwners.forEach((owner, i) => {
      const rows = holdQueries[i]?.data?.holds;
      if (rows) out.push(...toHoldItems(rows, owner, timezone, holdCopy));
    });
    return out;
  }, [holdsOn, selectedOwners, holdQueries, timezone, holdCopy]);

  const items = useMemo<CalendarItem[]>(
    () => [...eventItems, ...holdItems],
    [eventItems, holdItems],
  );

  // The series select offers the DISTINCT series among the fetched items —
  // no separate series read, and never a series that would empty the grid.
  const seriesOptions = useMemo(
    () => distinctSeries(eventItems, ct("admin.calSeries", "Series")),
    [eventItems, ct],
  );

  /**
   * The Holds chip is offered only once a hold has actually been seen (a chip
   * that filters nothing is noise), and stays offered while the reader has
   * them switched OFF — otherwise the control that hid them disappears with
   * them and the stored preference is unreachable. `seenHold` latches so a
   * refetch that momentarily returns nothing does not flicker the chip away.
   */
  const seenHold = useRef(false);
  if (holdItems.length > 0) seenHold.current = true;
  const offerHolds = seenHold.current || filters.showHolds === false;

  const filterOptions = useMemo(
    () => ({
      ...(isHumanDashboard && owners.length > 1
        ? { owners: owners.map((o) => ({ key: ownerKeyOf(o), label: ownerNameOf(o) })) }
        : {}),
      ...(seriesOptions.length > 0 ? { series: seriesOptions } : {}),
      ...(offerHolds ? { holds: true } : {}),
      // The chips' neutral state, for the collapsed "Filters · {n}" badge.
      defaults: { statuses: new Set(DEFAULT_STATUSES), showHolds: true },
    }),
    [isHumanDashboard, owners, seriesOptions, offerHolds],
  );

  const loading = eventQueries.some((q) => q.isPending || q.isPlaceholderData);
  // Retry has to refetch EVERY failing owner, not just the first: a personal
  // dashboard fans out one read per owner and one press left the rest broken.
  const failedQueries = eventQueries.filter((q) => q.isError);
  const retryFailed = useCallback(() => {
    for (const q of failedQueries) void q.refetch();
  }, [failedQueries]);

  // ── Create (FR-019) ─────────────────────────────────────────────────────
  const handleCreateAt = useCallback(
    (date: Date, opts: { view: CalendarView }) => {
      const startsAt = cellPrefillWallClock(date, timezone, { dateOnly: opts.view !== "week" });
      const sole = selectedOwners.length === 1 ? selectedOwners[0] : undefined;
      // Exactly one org selected on a personal dashboard: the draft is that
      // org's, so the builder opens in the org's context. It still goes
      // through `createDraftAt` — a straight `router.push` skipped the
      // Ticketed-vs-Community chooser, so a community moderator creating from
      // an org cell silently got a ticketed draft and no way to say otherwise.
      const targetSlug =
        sole?.kind === "org" && currentOwner && sole.adminSlug !== currentOwner.adminSlug
          ? sole.adminSlug
          : undefined;
      createDraftAt({ startsAt }, targetSlug ? { slug: targetSlug } : undefined);
    },
    [timezone, selectedOwners, currentOwner, createDraftAt],
  );

  // ── Overflow (FR-017) + ICS (FR-014) ────────────────────────────────────
  const subscribe = useCallback(async (feedLocale: string) => {
    if (!currentOwner) return;
    const url = webcalFeedUrl(
      currentOwner.kind === "org"
        ? { kind: "org", orgId: currentOwner.orgId }
        : { kind: "human", humanId: currentOwner.humanId },
      apiOrigin(),
      feedLocale,
    );
    const ok = await copyText(url);
    if (ok) {
      toast.success({ id: "calendar-webcal", title: t("admin.ecCopiedWebcal"), message: url });
    } else {
      toast.danger({
        id: "calendar-webcal",
        title: ct("admin.calCopyFailed", "Couldn't copy"),
        message: url,
      });
    }
  }, [currentOwner, toast, t, ct]);

  const exportMonth = useCallback(() => {
    const visible = applyFilters(items, filters, "internal").filter(isEvent);
    const p = zoneParts(anchor, timezone);
    const { filename, content } = buildMonthIcs(visible, p.year, p.month, displayName, {
      siteBaseUrl: siteOrigin(),
      ...icsTexts,
    });
    downloadTextFile(filename, content);
  }, [items, filters, anchor, timezone, displayName, icsTexts]);

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

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
      {failedQueries.length > 0 && (
        <div
          role="alert"
          data-testid="dashboard-calendar-error"
          style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}
        >
          <Text variant="bodySmall" tone="error">
            {ct("admin.calScheduleLoadFailed", "Couldn't load your schedule.")}
          </Text>
          <Button variant="secondary" size="$2" onPress={retryFailed}>
            {t("admin.retry")}
          </Button>
        </div>
      )}
      <CalendarEngine
        mode="internal"
        items={items}
        view={view}
        onViewChange={handleViewChange}
        views={VIEWS}
        anchor={anchor}
        onAnchorChange={handleAnchorChange}
        timezone={timezone}
        viewerTimezone={timezone}
        filters={filters}
        onFiltersChange={handleFiltersChange}
        filterOptions={filterOptions}
        loading={loading}
        onCreateAt={handleCreateAt}
        overflowActions={overflowActions}
        agendaPageEnd={agendaPageEnd}
        onAgendaShowMore={() => setAgendaDays((d) => Math.min(d + AGENDA_PAGE_DAYS, AGENDA_MAX_DAYS))}
        hasMoreAgenda={agendaDays < AGENDA_MAX_DAYS}
        peekVariant="dashboard"
        onDownloadIcs={downloadIcs}
        emptyLabel={ct("admin.calDashboardEmptyWindow", "Nothing scheduled in this window.")}
      />
      {modeChoiceDialog}
    </div>
  );
}
