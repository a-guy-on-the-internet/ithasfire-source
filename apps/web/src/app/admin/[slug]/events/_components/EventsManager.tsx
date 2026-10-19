"use client";

import { useMemo, useCallback, useState } from "react";
import { useRouter } from "@bprogress/next/app";
import { YStack, XStack, Stack, styled, Spinner } from "tamagui";
import {
  DataTable,
  type DataTableColumn,
  DT_CELL_SUB_CLASS,
  Button,
  Badge,
  Text,
  useTranslations,
  useFormatters,
  useNotify,
} from "@th/ui";
import {
  Plus,
  Edit,
  Eye,
  Users,
  Gift,
  ChevronDown,
  ChevronRight,
  Ticket,
  Shield,
  Banknote,
  Lock,
  Globe,
  EyeOff,
  Ban,
  HeartHandshake,
  Repeat,
  Rows3,
  Share2,
  Trash2,
} from "lucide-react";
import { keepPreviousData } from "@tanstack/react-query";
import {
  RowActionMenu,
  type RowActionMenuItem,
} from "@/components/data-table/RowActionMenu";
import { ConfirmDialog } from "@/components/data-table/ConfirmDialog";
import type { PayoutSchedule } from "@th/types";
import {
  PAYOUT_DATE_FORMAT,
  expectedPayoutDate,
} from "@/lib/payouts/expected-payout-date";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";
import { fmtDate } from "@/lib/format";
import { cancelEventResultToasts } from "../new/_components/cancel-event-toasts";
import { EventStatusBadge } from "./EventStatusBadge";
import { EventMobileCard } from "./EventMobileCard";
import { ShareEventDialog } from "./ShareEventDialog";
import {
  ActionBar,
  TableContainer,
  SearchBar,
  FilterChips,
  FilterRow,
  Pagination,
  NoResults,
  ColumnSelector,
  AdminTableErrorState,
  type ColumnOption,
} from "@/components/AdminTableParts";
import { useAdminTableParams } from "@/hooks/useAdminTableParams";
import { useColumnVisibility } from "@/hooks/useColumnVisibility";
import { useTableDensity } from "@/hooks/useTableDensity";
import { usePageClamp } from "@/hooks/usePageClamp";
import { useIsMobile } from "@/hooks/useIsMobile";
import { AdminPageData } from "@/app/admin/_components/AdminPageData";
import { AdminPageHeader } from "../../_components/AdminPageHeader";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type EventOwnerContext =
  | { kind: "human"; humanId: string }
  | { kind: "org"; orgId: string };

type EventStatus =
  | "DRAFT"
  | "PUBLISHED"
  | "ARCHIVED"
  | "CANCELLED"
  | "COMPLETED";

/**
 * Chip scopes for the status filter, in lifecycle order.
 *
 * Standard admin-table chip grammar: the default scope is ALL statuses and is
 * expressed by NO chip being selected — there is deliberately no "All" chip
 * (it would sit permanently lit at rest). Values double as the `?status=` URL
 * param and as the value sent to `events.listMine` (`status: [value]`).
 */
const EVENT_STATUS_CHIPS = [
  { value: "DRAFT", labelKey: "admin.eventStatusDraft" },
  { value: "PUBLISHED", labelKey: "admin.eventStatusPublished" },
  { value: "COMPLETED", labelKey: "admin.eventStatusCompleted" },
  { value: "CANCELLED", labelKey: "admin.eventStatusCancelled" },
  { value: "ARCHIVED", labelKey: "admin.eventStatusArchived" },
] as const satisfies ReadonlyArray<{ value: EventStatus; labelKey: string }>;

function isEventStatus(value: string | undefined): value is EventStatus {
  return EVENT_STATUS_CHIPS.some((c) => c.value === value);
}

interface EventRow {
  id: string;
  title: string | null;
  status: EventStatus;
  startsAt: Date | null;
  endsAt: Date | null;
  slug: string | null;
  shortId: string | null;
  visibility: "PUBLIC" | "PRIVATE" | "UNLISTED";
  addressText: string | null;
  placeId: string | null;
  placeName: string | null;
  ticketsSold: number;
  createdAt: Date;
  updatedAt: Date | null;
}

export interface EventsManagerProps {
  /** Who owns these events - the current user or an organization */
  ownerContext: EventOwnerContext;
  /** Title shown above the table */
  title?: string;
  /**
   * Caller-pinned status scope. When provided it OVERRIDES the user-facing
   * status chips (which are then not rendered) — the surface is locked to the
   * caller's scope. Omit it (the default) to get the standard chip row:
   * no chip selected = all statuses.
   */
  statusFilter?: EventStatus[];
  /** Callback when "Create Event" is clicked */
  onCreateEvent?: () => void;
  /** Custom URL builder for editing an event */
  getEditUrl?: (event: EventRow) => string;
  /** Custom URL builder for viewing an event */
  getViewUrl?: (event: EventRow) => string;
  /** Custom URL builder for viewing attendees of an event */
  getAttendeesUrl?: (event: EventRow) => string;
  /** Custom URL builder for the volunteers page */
  getVolunteersUrl?: (event: EventRow) => string;
  /** Custom URL builder for comping tickets */
  getCompUrl?: (event: EventRow) => string;
  /** Custom URL builder for the series Dates page (series events only) */
  getDatesUrl?: (event: EventRow) => string;
  /** Whether to show the create button */
  showCreateButton?: boolean;
  /**
   * Whether the current actor may edit content (create/edit/comp). Mirrors
   * `ORG_EDIT_ROLES` (OWNER/ADMIN/EDITOR) plus profile-owner humans. Read/share
   * affordances (VIEW, SHARE) stay available regardless. Defaults to `true` so
   * existing call sites keep full affordances until threaded. Server-side
   * use-case checks remain the real boundary; this is UX-only.
   */
  canEdit?: boolean;
  /**
   * Whether the current actor may perform destructive management actions
   * (Cancel Event, Delete Event). Mirrors `ORG_ADMIN_ROLES` (OWNER/ADMIN only,
   * per cancel-event.ts / delete-event.ts) plus profile-owner humans. Narrower
   * than `canEdit` so an EDITOR — who can edit/comp — does not see Cancel/Delete
   * affordances the server would 403. Defaults to `true` (backward-safe).
   * Server-side use-case checks remain the real boundary; this is UX-only.
   */
  canManage?: boolean;
  /** Max height for the table container */
  maxHeight?: number | string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function EventsManager({
  ownerContext,
  title,
  statusFilter,
  onCreateEvent,
  getEditUrl,
  getViewUrl,
  getAttendeesUrl,
  getVolunteersUrl,
  getCompUrl,
  getDatesUrl,
  showCreateButton = true,
  canEdit = true,
  canManage = true,
  maxHeight,
}: EventsManagerProps) {
  const router = useRouter();
  const t = useTranslations();
  const fmt = useFormatters();
  const { toast } = useNotify();
  const isMobile = useIsMobile();

  // ── Expanded row state ─────────────────────────────────────────────────
  const [expandedRowIds, setExpandedRowIds] = useState<Set<string>>(new Set());
  const toggleExpand = useCallback((id: string) => {
    setExpandedRowIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // `statusFilter` (caller-pinned) wins over the chips; when it is set the
  // chip row is not rendered at all, so there is no way for the two to
  // disagree on screen. A pinned surface also stops MANAGING `?status=` —
  // otherwise the hook would keep writing a param that lies about a scope the
  // user cannot change. Anything unrecognised in `?status=` normalises to the
  // default (all statuses / no chip lit).
  const isStatusPinned = statusFilter !== undefined;
  const statusExtraKeys = useMemo(
    () => (isStatusPinned ? [] : ["status"]),
    [isStatusPinned],
  );

  // ── Search / filter / pagination state (URL-synced) ────────────────────
  const {
    searchQuery,
    debouncedSearch,
    page,
    pageSize,
    extra,
    handleSearchChange,
    setPage,
    setPageSize,
    setExtra,
  } = useAdminTableParams({ extraKeys: statusExtraKeys });

  const chipStatus: EventStatus | undefined =
    !isStatusPinned && isEventStatus(extra.status) ? extra.status : undefined;
  // events.listMine takes `status` as an ARRAY of EventStatus (verified in
  // packages/core/src/use-cases/events/list-my-events.ts —
  // `status: z.array(eventStatusSchema).optional()`), so a single chip is
  // sent as a one-element array. `undefined` = no server-side status filter.
  const effectiveStatus: EventStatus[] | undefined = isStatusPinned
    ? statusFilter
    : chipStatus
      ? [chipStatus]
      : undefined;

  const statusChipOptions = useMemo(
    () =>
      EVENT_STATUS_CHIPS.map((chip) => ({
        value: chip.value,
        label: String(t(chip.labelKey)),
      })),
    [t],
  );

  // ── Column visibility ──────────────────────────────────────────────────
  const ALL_COL_IDS = [
    "title",
    "status",
    "attendees",
    "startsAt",
    "createdAt",
  ] as const;

  const columnOptions: ColumnOption[] = useMemo(
    () => [
      { id: "title", label: String(t("admin.eventColumn")) },
      { id: "status", label: String(t("admin.statusColumn")) },
      {
        id: "attendees",
        label: String(t("admin.attendeesColumn") ?? "Attendees"),
      },
      { id: "startsAt", label: String(t("admin.dateColumn")) },
      { id: "createdAt", label: String(t("admin.createdColumn")) },
    ],
    [t],
  );

  const colVis = useColumnVisibility("admin-events-columns", ALL_COL_IDS);

  // ── Row density (persisted per-table, mirroring the columns key) ────────
  const { density, toggleDensity } = useTableDensity("admin-events-density");

  // Build query params
  const ownerType = ownerContext.kind === "human" ? "HUMAN" : "ORGANIZATION";
  const ownerId =
    ownerContext.kind === "human" ? ownerContext.humanId : ownerContext.orgId;

  // Server search contract is trim + min(2) + max(140) — anything shorter is
  // sent as "no query" instead of a guaranteed BAD_REQUEST on every 1-char
  // keystroke (the guard already proven on the places listing).
  const trimmedSearch = debouncedSearch.trim();
  const searchInput =
    trimmedSearch.length >= 2 ? trimmedSearch.slice(0, 140) : undefined;

  const { data, isLoading, isFetching, error, refetch } =
    trpc.events.listMine.useQuery(
      {
        ownerType,
        ownerId,
        status: effectiveStatus,
        // Server-side search: the repo applies the title/addressText match
        // inside the same where-clause it counts, so `pageInfo.total` is the
        // FILTERED total and the pager's range label tells the truth.
        query: searchInput,
        limit: pageSize,
        offset: page * pageSize,
      },
      {
        staleTime: 30_000,
        placeholderData: keepPreviousData,
      },
    );

  // Pull per-event volunteer signup counts (PENDING / APPROVED) for the rows
  // currently on screen so we can render a "needs review" cell without an
  // N+1 fetch. The query gracefully no-ops when there are no events yet.
  const visibleEventIds = useMemo(
    () => (data?.items ?? []).map((e) => e.id),
    [data?.items],
  );
  const volunteerCountsQuery =
    trpc.volunteer.signups.statusCountsBatch.useQuery(
      { eventIds: visibleEventIds, ownerType, ownerId },
      {
        enabled: visibleEventIds.length > 0,
        staleTime: 30_000,
        meta: { silent: true },
      },
    );
  const volunteerCounts = volunteerCountsQuery.data ?? {};

  // Rows arrive FILTERED and WINDOWED by the server — no client re-filter (a
  // per-page filter would lie about the dataset's true size).
  //
  // ORDERING is NOT server-owned here: the table still passes `clientSort`,
  // so clicking a column header re-sorts only the rows on screen (25 of N),
  // not the dataset. Known limitation — server-side sort for events.listMine
  // is a separate backend slice (the one PlacesTable already got via
  // `sort.field` + `sortable: false` on non-sortable columns).
  const rows: EventRow[] = data?.items ?? [];
  const totalRows = data?.pageInfo?.total ?? 0;
  const totalPages = Math.ceil(totalRows / pageSize);

  // Stale/shared URLs (?p=3 against a shrunken or newly-filtered dataset)
  // snap back to the last real page once the query settles, instead of
  // stranding an empty state with the pager hidden.
  usePageClamp({ page, totalPages, isFetching, setPage });

  // Navigation handlers
  const handleEditEvent = useCallback(
    (event: EventRow) => {
      const url = getEditUrl?.(event) ?? `/events/${event.id}`;
      router.push(url);
    },
    [router, getEditUrl],
  );

  const handleViewEvent = useCallback(
    (event: EventRow) => {
      const url =
        getViewUrl?.(event) ??
        (event.slug ? `/events/${event.slug}` : `/events/${event.id}`);
      router.push(url);
    },
    [router, getViewUrl],
  );

  const handleViewAttendees = useCallback(
    (event: EventRow) => {
      if (getAttendeesUrl) {
        router.push(getAttendeesUrl(event));
      }
    },
    [router, getAttendeesUrl],
  );

  const handleCompTickets = useCallback(
    (event: EventRow) => {
      if (getCompUrl) {
        router.push(getCompUrl(event));
      }
    },
    [router, getCompUrl],
  );

  // ── Share event with promo ────────────────────────────────────────────
  const [shareTarget, setShareTarget] = useState<EventRow | null>(null);
  const handleShareEvent = useCallback((event: EventRow) => {
    setShareTarget(event);
  }, []);

  // ── Cancel event ──────────────────────────────────────────────────────
  const [cancelTarget, setCancelTarget] = useState<EventRow | null>(null);
  const [cancelScope, setCancelScope] = useState<
    "this_only" | "this_and_future" | "all"
  >("this_only");

  // Lazy lookup: when cancel target is set, check if it's in a series
  const calendarInfoQuery = trpc.events.getCalendarInfo.useQuery(
    { eventIds: cancelTarget ? [cancelTarget.id] : [] },
    { enabled: !!cancelTarget, staleTime: 60_000 },
  );
  const seriesInfo = calendarInfoQuery.data?.items?.[0] ?? null;
  const isSeriesEvent = !!seriesInfo?.seriesId;

  const cancelMutation = trpc.events.cancelEvent.useMutation({
    onSuccess: (result) => {
      setCancelTarget(null);
      setCancelScope("this_only");
      refetch();
      // The same report the event builder gives: one line for the
      // cancellation, then one per thing that still needs a person (card
      // refunds that failed, cash to hand back, door sales left open).
      for (const { tone, ...options } of cancelEventResultToasts(result, t)) {
        toast[tone](options);
      }
    },
    onError: () => {
      setCancelTarget(null);
      setCancelScope("this_only");
    },
  });

  const cancelSeriesMutation = trpc.series.cancelEventSeries.useMutation({
    onSuccess: () => {
      setCancelTarget(null);
      setCancelScope("this_only");
      refetch();
    },
    onError: () => {
      setCancelTarget(null);
      setCancelScope("this_only");
    },
  });

  const handleCancelEvent = useCallback((event: EventRow) => {
    setCancelTarget(event);
    setCancelScope("this_only");
  }, []);

  const isCancelPending =
    cancelMutation.isPending || cancelSeriesMutation.isPending;

  const confirmCancel = useCallback(() => {
    if (!cancelTarget) return;

    if (isSeriesEvent && seriesInfo && cancelScope !== "this_only") {
      cancelSeriesMutation.mutate({
        seriesId: seriesInfo.seriesId,
        occurrenceId: seriesInfo.occurrenceId,
        scope: cancelScope,
        clientKey: `cancel-series-${seriesInfo.seriesId}-${Date.now()}`,
      });
    } else {
      cancelMutation.mutate({
        eventId: cancelTarget.id,
        clientKey: `cancel-${cancelTarget.id}-${Date.now()}`,
      });
    }
  }, [
    cancelTarget,
    cancelScope,
    isSeriesEvent,
    seriesInfo,
    cancelMutation,
    cancelSeriesMutation,
  ]);

  // ── Delete event (DRAFT only) ─────────────────────────────────────────
  const [deleteTarget, setDeleteTarget] = useState<EventRow | null>(null);

  const deleteMutation = trpc.events.deleteEvent.useMutation({
    onSuccess: () => {
      setDeleteTarget(null);
      refetch();
    },
    onError: () => {
      setDeleteTarget(null);
    },
  });

  const handleDeleteEvent = useCallback((event: EventRow) => {
    setDeleteTarget(event);
  }, []);

  const confirmDelete = useCallback(() => {
    if (!deleteTarget) return;
    deleteMutation.mutate({ eventId: deleteTarget.id });
  }, [deleteTarget, deleteMutation]);

  // Column definitions
  const columns: DataTableColumn<EventRow>[] = useMemo(
    () => [
      {
        id: "title",
        header: String(t("admin.eventColumn")),
        width: 2.4,
        truncate: false,
        tooltipValue: (row) => {
          const place = row.placeName ?? row.addressText ?? null;
          const title = row.title ?? String(t("admin.untitledEvent"));
          return place ? `${title} — ${place}` : title;
        },
        sortValue: (row) => row.title ?? "",
        cell: (row) => (
          <YStack gap="$1">
            <Text
              variant="body"
              tone={row.title ? "default" : "muted"}
              style={{
                fontWeight: row.title ? 700 : 400,
                fontStyle: row.title ? "normal" : "italic",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {row.title || String(t("admin.untitledEvent"))}
            </Text>
            {/* DT_CELL_SUB_CLASS: the secondary line collapses away when the
                table renders at density="compact" — that collapse is what
                makes the density toggle actually change row height, not just
                cell padding. */}
            {row.placeId && row.placeName ? (
              <Text
                variant="caption"
                tone="muted"
                className={DT_CELL_SUB_CLASS}
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                  }}
                >
                  📍 {row.placeName}
                </span>
              </Text>
            ) : row.addressText ? (
              <Text
                variant="caption"
                tone="muted"
                className={DT_CELL_SUB_CLASS}
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {row.addressText}
              </Text>
            ) : null}
          </YStack>
        ),
      },
      {
        id: "status",
        header: String(t("admin.statusColumn")),
        // Wide enough for the widest badge (COMPLETADO/FINALIZADO ≈ 95px incl.
        // bar + padding) at the 640px table floor; fixed layout ignores
        // content min-width.
        width: 2.1,
        sortValue: (row) => row.status,
        cell: (row) => <EventStatusBadge status={row.status} />,
      },
      {
        id: "attendees",
        header: String(t("admin.attendeesColumn") ?? "Attendees"),
        width: 1,
        sortValue: (row) => row.ticketsSold,
        cell: (row) => (
          <Text variant="body" tone={row.ticketsSold > 0 ? "default" : "muted"}>
            {row.ticketsSold > 0 ? row.ticketsSold : "—"}
          </Text>
        ),
      },
      {
        id: "startsAt",
        header: String(t("admin.dateColumn")),
        width: 2,
        noWrap: true,
        sortValue: (row) => (row.startsAt ? new Date(row.startsAt) : null),
        cell: (row) => (
          <Text variant="body" tone={row.startsAt ? "default" : "muted"}>
            {fmtDate(fmt, row.startsAt)}
          </Text>
        ),
      },
      {
        id: "createdAt",
        header: String(t("admin.createdColumn")),
        width: 1.5,
        noWrap: true,
        sortValue: (row) => new Date(row.createdAt),
        cell: (row) => (
          <Text variant="caption" tone="muted">
            {fmtDate(fmt, row.createdAt)}
          </Text>
        ),
      },
    ],
    [t, fmt],
  );

  const visibleColumns = useMemo(
    () => columns.filter((c) => colVis.isVisible(c.id)),
    [columns, colVis.isVisible],
  );

  // Row actions
  const rowActions = useMemo(
    () => ({
      header: String(t("admin.actions")),
      width: 1.2,
      render: (row: EventRow) => {
        const isCancellable =
          row.status === "DRAFT" || row.status === "PUBLISHED";
        const isCancelling =
          cancelMutation.isPending && cancelTarget?.id === row.id;

        const items: RowActionMenuItem[] = [
          {
            key: "expand",
            label: expandedRowIds.has(row.id)
              ? String(t("admin.collapseDetails"))
              : String(t("admin.expandDetails")),
            icon: expandedRowIds.has(row.id) ? (
              <ChevronDown size={14} />
            ) : (
              <ChevronRight size={14} />
            ),
            onPress: () => toggleExpand(row.id),
          },
          ...(row.status === "PUBLISHED"
            ? [
                {
                  key: "view",
                  label: String(t("admin.viewTooltip")),
                  icon: <Eye size={14} />,
                  onPress: () => handleViewEvent(row),
                },
                {
                  key: "share",
                  label: String(t("admin.shareEvent")),
                  icon: <Share2 size={14} />,
                  onPress: () => handleShareEvent(row),
                },
              ]
            : []),
          ...(canEdit
            ? [
                {
                  key: "edit",
                  label: String(t("admin.editTooltip")),
                  icon: <Edit size={14} />,
                  onPress: () => handleEditEvent(row),
                },
              ]
            : []),
          ...(canEdit && getCompUrl && row.status === "PUBLISHED"
            ? [
                {
                  key: "comp",
                  label: String(t("pageActions.compTickets")),
                  icon: <Gift size={14} />,
                  onPress: () => handleCompTickets(row),
                },
              ]
            : []),
          ...(getAttendeesUrl
            ? [
                {
                  key: "attendees",
                  label: String(t("admin.attendeesTooltip")),
                  icon: <Users size={14} />,
                  onPress: () => handleViewAttendees(row),
                },
              ]
            : []),
          ...(canManage && isCancellable
            ? [
                {
                  key: "cancel",
                  label: isCancelling
                    ? "Cancelling..."
                    : String(t("admin.cancelEvent")),
                  icon: <Ban size={14} />,
                  tone: "danger" as const,
                  disabled: isCancelling,
                  onPress: () => handleCancelEvent(row),
                },
              ]
            : []),
          ...(canManage && row.status === "DRAFT"
            ? [
                {
                  key: "delete",
                  label:
                    deleteMutation.isPending && deleteTarget?.id === row.id
                      ? String(t("admin.deletingEvent") ?? "Deleting...")
                      : String(t("admin.deleteEvent") ?? "Delete Event"),
                  icon: <Trash2 size={14} />,
                  tone: "danger" as const,
                  disabled:
                    deleteMutation.isPending && deleteTarget?.id === row.id,
                  onPress: () => handleDeleteEvent(row),
                },
              ]
            : []),
        ];

        return (
          <XStack justifyContent="flex-end">
            <RowActionMenu
              items={items}
              ariaLabel={`Actions for ${row.title}`}
            />
          </XStack>
        );
      },
    }),
    [
      handleEditEvent,
      handleViewEvent,
      handleViewAttendees,
      handleCompTickets,
      handleCancelEvent,
      handleDeleteEvent,
      handleShareEvent,
      getAttendeesUrl,
      getCompUrl,
      t,
      expandedRowIds,
      toggleExpand,
      cancelMutation.isPending,
      cancelTarget,
      deleteMutation.isPending,
      deleteTarget,
      canEdit,
      canManage,
    ],
  );

  // ── Filters (search + URL-synced status chip) ──────────────────────────
  const hasActiveSearch = debouncedSearch.length > 0;
  // A caller-pinned `statusFilter` is not a user filter — it is the surface's
  // fixed scope, so it must not light up "Clear filters".
  const hasActiveFilters = hasActiveSearch || chipStatus !== undefined;

  const clearFilters = useCallback(() => {
    handleSearchChange("");
    setExtra("status", undefined);
    // Same-commit page reset (mirrors the chip handler) — the hook's own
    // post-commit reset then no-ops instead of costing a stale-offset fetch.
    setPage(0);
  }, [handleSearchChange, setExtra, setPage]);

  // Whether the header's primary "Create event" button renders at all. ONE
  // source for the header and the pristine empty-state copy so the two cannot
  // drift: the copy is an imperative, and both an org VIEWER/FINANCE/SCANNER
  // (canEdit false) and a workspace with the createEvents gate off
  // (showCreateButton false) reach the pristine empty table with no create
  // affordance anywhere on the page.
  const canCreateFromHeader =
    canEdit && showCreateButton && onCreateEvent !== undefined;

  // Empty states, by context — all three are the SAME `NoResults` block that
  // OrdersTable uses, rendered inside the table chrome. Only the copy and the
  // presence of a clear button differ. Resolved as ONE chained ternary here
  // (mirroring PlacesTable) rather than split between this const and the
  // DataTable's `emptyState` prop 150 lines below, where the three-way choice
  // could not be read in one place.
  //
  // ORDER MATTERS: `hasActiveFilters` must come first. A caller-pinned scope
  // suppresses the chip (`chipStatus` is forced undefined when pinned) but NOT
  // the search box, so a pinned surface with an active search has to offer the
  // clear button for the part the user *can* clear.
  //
  // • user filters active  → NoResults + clear (the filters stay reachable)
  // • caller-pinned scope  → NoResults describing the pinned scope, NO clear
  //   button: the scope is not the user's to clear.
  // • pristine             → NoResults describing the empty table, NO CTA.
  //   The page header already owns the one primary "Create event" action
  //   (v2 §04 one-primary-per-viewport); the old SkeletonEmptyState painted a
  //   second create button over 300px of ghost rows, duplicating it. The
  //   description is suppressed when that header button is absent — telling a
  //   read-only viewer to "get started by creating your first event" is an
  //   instruction with nothing to act on.
  const emptyState = hasActiveFilters ? (
    <NoResults
      title={String(t("admin.noMatchingEvents"))}
      description={String(t("admin.noMatchingEventsDescription"))}
      onClearFilters={clearFilters}
    />
  ) : isStatusPinned ? (
    <NoResults
      title={String(t("admin.noMatchingEvents"))}
      description={String(t("admin.noMatchingEventsDescription"))}
    />
  ) : (
    <NoResults
      title={String(t("admin.noEventsYet"))}
      description={
        canCreateFromHeader ? String(t("admin.getStartedEvents")) : undefined
      }
    />
  );

  const summaryLabel = (() => {
    if (!data?.pageInfo || totalRows === 0) return undefined;
    const start = page * pageSize + 1;
    const end = Math.min((page + 1) * pageSize, totalRows);
    return String(t("admin.nOfTotal", { start, end, total: totalRows }));
  })();

  if (isLoading && !data) {
    return (
      <AdminPageData
        isLoading
        loadingMessage={String(t("admin.loadingEvents"))}
      >
        {null}
      </AdminPageData>
    );
  }

  return (
    <YStack
      gap="$4"
      flex={1}
      padding="$4"
      maxWidth={1440}
      marginHorizontal="auto"
      width="100%"
    >
      <AdminPageHeader
        title={title ?? String(t("admin.myEvents"))}
        section="events"
        trailing={
          canCreateFromHeader ? (
            <Button variant="primary" size="$3" onPress={onCreateEvent}>
              <Plus size={18} />
              {String(t("admin.createEvent"))}
            </Button>
          ) : undefined
        }
      />

      {/* Filters row — search + the URL-synced status chip group. Sits ABOVE
          the table area (mirroring OrdersTable / PlacesTable) so search is
          never nested inside the ActionBar's tool cluster. Stays mounted even
          when the query errors so a filter/search-induced failure is always
          self-recoverable in place. */}
      <FilterRow hasActiveFilters={hasActiveFilters} onClearAll={clearFilters}>
        <SearchBar
          value={searchQuery}
          onChangeText={handleSearchChange}
          placeholder={String(t("admin.searchEventsPlaceholder"))}
          // Server cap on `query` (max 140).
          maxLength={140}
          // e2e admin-tables.spec.ts selects this id (mirrors
          // OrdersTable / PlacesTable).
          testId="admin-events-search"
        />
        {/* Non-default scopes only — nothing selected = all statuses;
            deselecting a chip drops `?status` and falls back to it.
            setPage(0) batches the page reset into the same commit as the
            filter change so the hook's post-commit reset no-ops instead of
            costing a stale-offset fetch. Hidden entirely when the caller
            pins `statusFilter` (the scope is then not the user's to change). */}
        {!isStatusPinned && (
          <FilterChips
            options={statusChipOptions}
            selected={chipStatus}
            onSelect={(value) => {
              setExtra("status", value);
              setPage(0);
            }}
          />
        )}
      </FilterRow>

      {/* Table area — replaced by the shared error surface on failure while
          the header + filters above stay mounted, so an error caused by a bad
          filter/search is always recoverable in place (Retry alone would just
          re-send the same bad input).

          The 640px table floor drops only below useIsMobile's 600px
          breakpoint, the same breakpoint DataTable uses for card mode, so the
          page never overflows horizontally on phones and there is no
          floorless band (Tamagui's $gtSm media query starts at 641px). */}
      {error ? (
        <YStack flex={1} minHeight={400}>
          <AdminTableErrorState
            message={String(
              t("admin.failedToLoadEvents", {
                error: formatErrorMessage(error),
              }),
            )}
            onRetry={() => {
              void refetch();
            }}
            retryLabel={String(t("admin.retryLoad"))}
            testId="admin-events-error"
          />
        </YStack>
      ) : (
        /* The table chrome stays mounted for EVERY non-error state, including
           the pristine-empty one — matching OrdersTable and PlacesTable. The
           empty state renders inside the DataTable so it keeps the bordered
           TableContainer and the column header row around it; the old
           pristine branch dropped the chrome entirely and floated a bare
           block on the page. */
        <YStack flex={1} minWidth={isMobile ? 0 : 640}>
          <ActionBar onRefresh={() => refetch()} countLabel={summaryLabel}>
            {/* Density toggle — plain-English label on purpose: admin-only
                chrome, and a new i18n key would require editing the locale
                JSON catalogs (same rule as the range label in Pagination). */}
            <Button
              variant="ghost"
              size="$2"
              onPress={toggleDensity}
              aria-pressed={density === "compact"}
              paddingHorizontal="$3"
            >
              <XStack gap="$2" alignItems="center">
                <Rows3 size={14} />
                <Text variant="overline">Density</Text>
              </XStack>
            </Button>
            <ColumnSelector
              options={columnOptions}
              isVisible={colVis.isVisible}
              onToggle={colVis.toggleColumn}
              onShowAll={colVis.showAll}
              hasHidden={colVis.hasHidden}
            />
          </ActionBar>

          <TableContainer maxHeight={maxHeight}>
            <DataTable
              columns={visibleColumns}
              rows={rows}
              getRowKey={(row) => row.id}
              isLoading={isLoading}
              emptyState={emptyState}
              clientSort
              density={density}
              onRowPress={(row) => toggleExpand(row.id)}
              rowActions={rowActions}
              renderMobileCard={(row) => <EventMobileCard row={row} />}
              renderExpandedRow={(row) =>
                expandedRowIds.has(row.id) ? (
                  <EventDetailPanel
                    row={row}
                    fmt={fmt}
                    t={t}
                    ownerContext={ownerContext}
                    canEdit={canEdit}
                    canManage={canManage}
                    getEditUrl={getEditUrl}
                    getViewUrl={getViewUrl}
                    getAttendeesUrl={getAttendeesUrl}
                    getVolunteersUrl={getVolunteersUrl}
                    getCompUrl={getCompUrl}
                    getDatesUrl={getDatesUrl}
                    // Share/cancel/delete live only in the rowActions menu,
                    // which card mode (<600px) does not render — surface them
                    // in the expanded panel so they stay reachable on phones.
                    onShare={handleShareEvent}
                    onCancel={handleCancelEvent}
                    onDelete={handleDeleteEvent}
                  />
                ) : null
              }
              testIdBase="events-manager-table"
            />
          </TableContainer>

          {/* `total` renders the shared "ROWS X–Y OF Z" range label. Honest
              under every filter: search and status are both applied by the
              server inside the same where-clause it counts, so `total` is the
              filtered total — not the whole-table total. */}
          <Pagination
            page={page}
            totalPages={totalPages}
            onPageChange={setPage}
            pageSize={pageSize}
            onPageSizeChange={setPageSize}
            total={totalRows}
          />
        </YStack>
      )}

      {shareTarget && (
        <ShareEventDialog
          open
          onClose={() => setShareTarget(null)}
          ownerContext={ownerContext}
          fixedEvent={{
            id: shareTarget.id,
            title: shareTarget.title,
            slug: shareTarget.slug,
            status: shareTarget.status,
          }}
        />
      )}

      <ConfirmDialog
        open={cancelTarget !== null}
        onConfirm={confirmCancel}
        onCancel={() => {
          setCancelTarget(null);
          setCancelScope("this_only");
        }}
        title={String(t("admin.cancelEvent"))}
        description={
          isSeriesEvent ? (
            <YStack gap="$3">
              <Text variant="body" tone="muted">
                {`"${cancelTarget?.title}" is part of a series. How would you like to cancel?`}
              </Text>
              {(["this_only", "this_and_future", "all"] as const).map(
                (scope) => (
                  <XStack
                    key={scope}
                    gap="$2"
                    alignItems="flex-start"
                    cursor="pointer"
                    onPress={() => setCancelScope(scope)}
                    padding="$2"
                    borderRadius={0}
                    backgroundColor={
                      cancelScope === scope
                        ? "rgba(33,28,22,0.06)"
                        : "transparent"
                    }
                    hoverStyle={{ backgroundColor: "rgba(33,28,22,0.04)" }}
                  >
                    <Stack
                      width={16}
                      height={16}
                      borderRadius={8}
                      borderWidth={2}
                      borderColor={
                        cancelScope === scope
                          ? "$brandSecondary"
                          : "$borderColor"
                      }
                      backgroundColor={
                        cancelScope === scope
                          ? "$brandSecondary"
                          : "transparent"
                      }
                      marginTop={2}
                    />
                    <YStack flex={1} gap="$1">
                      <Text variant="body" weight="bold" fontSize={13}>
                        {String(
                          t(
                            scope === "this_only"
                              ? "admin.cancelScopeThisOnly"
                              : scope === "this_and_future"
                                ? "admin.cancelScopeThisAndFuture"
                                : "admin.cancelScopeAll",
                          ),
                        )}
                      </Text>
                      <Text variant="bodySmall" tone="muted" fontSize={12}>
                        {String(
                          t(
                            scope === "this_only"
                              ? "admin.cancelScopeThisOnlyDesc"
                              : scope === "this_and_future"
                                ? "admin.cancelScopeThisAndFutureDesc"
                                : "admin.cancelScopeAllDesc",
                          ),
                        )}
                      </Text>
                    </YStack>
                  </XStack>
                ),
              )}
            </YStack>
          ) : (
            // Not "refunds all ticket holders": cash door sales are marked
            // refunded but the organiser hands the cash back (owner ruling).
            <YStack gap="$2">
              <Text variant="body" tone="muted">
                {`This will cancel "${cancelTarget?.title}" and cannot be undone.`}
              </Text>
              <Text variant="body" tone="muted">
                {String(t("admin.ebCancelConfirmRefundNote"))}
              </Text>
            </YStack>
          )
        }
        confirmLabel={String(t("admin.cancelEvent"))}
        cancelLabel="Keep Event"
        tone="danger"
        loading={isCancelPending}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
        title={String(t("admin.deleteEvent") ?? "Delete Event")}
        description={`This will permanently delete the draft "${deleteTarget?.title ?? "Untitled event"}". This cannot be undone.`}
        confirmLabel={String(t("admin.deleteEvent") ?? "Delete Event")}
        cancelLabel="Keep Event"
        tone="danger"
        loading={deleteMutation.isPending}
      />
    </YStack>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Payout schedule label (same keys as EventFinanceSettings). The expected
// date is core's own rule via `expectedPayoutDate`; the old fixed day
// offsets were wrong for every schedule (no Sunday snap, no weekend roll).
// ─────────────────────────────────────────────────────────────────────────────

const PAYOUT_SCHEDULE_LABEL_KEYS: Record<PayoutSchedule, string> = {
  ASAP: "admin.ebPayoutSchedAsapNextDay",
  WEEK_OF_EVENT: "admin.ebPayoutSchedWeekOf",
  ONE_WEEK_AFTER: "admin.ebPayoutSchedOneWeek",
  TWO_WEEKS_AFTER: "admin.ebPayoutSchedTwoWeeks",
  FOUR_WEEKS_AFTER: "admin.ebPayoutSchedFourWeeks",
};

// ─────────────────────────────────────────────────────────────────────────────
// Gate type display helpers
// ─────────────────────────────────────────────────────────────────────────────

const GATE_ICONS: Record<string, typeof Lock> = {
  NONE: Globe,
  APPLICATION: Shield,
  PASSWORD: Lock,
};

const GATE_LABELS: Record<string, string> = {
  NONE: "Open",
  APPLICATION: "Application Required",
  PASSWORD: "Password Protected",
};

const VISIBILITY_ICONS: Record<string, typeof Globe> = {
  PUBLIC: Globe,
  PRIVATE: EyeOff,
  UNLISTED: Eye,
};

// ─────────────────────────────────────────────────────────────────────────────
// Styled primitives
// ─────────────────────────────────────────────────────────────────────────────

const PanelContainer = styled(YStack, {
  padding: "$5",
  paddingTop: "$4",
  gap: "$4",
  backgroundColor: "$surfaceMuted",
  borderTopWidth: 2,
  borderTopColor: "$borderColor",
});

const SectionRow = styled(XStack, {
  gap: "$5",
  flexWrap: "wrap",
});

const SectionBlock = styled(YStack, {
  gap: "$3",
  flex: 1,
  minWidth: 200,
});

const SectionLabel = styled(Text, {
  fontSize: 10,
  textTransform: "uppercase",
  letterSpacing: 1.5,
  tag: "span",
  variants: {
    bold: {
      true: {
        fontWeight: "700",
      },
    },
  } as const,
  defaultVariants: {
    bold: true,
  },
});

const MetricBox = styled(XStack, {
  gap: "$3",
  alignItems: "center",
  padding: "$3",
  borderWidth: 2,
  borderColor: "$borderColor",
  borderRadius: 0,
  backgroundColor: "$surface",
  // Wrap instead of crushing at phone widths (SectionRow has flexWrap).
  minWidth: 140,
});

const MetricIconBox = styled(XStack, {
  width: 32,
  height: 32,
  alignItems: "center",
  justifyContent: "center",
  borderRadius: 0,
  backgroundColor: "$surfaceMuted",
});

// ─────────────────────────────────────────────────────────────────────────────
// Expanded row detail panel
// ─────────────────────────────────────────────────────────────────────────────

function EventDetailPanel({
  row,
  fmt,
  t,
  ownerContext,
  canEdit,
  canManage,
  getEditUrl,
  getViewUrl,
  getAttendeesUrl,
  getVolunteersUrl,
  getCompUrl,
  getDatesUrl,
  onShare,
  onCancel,
  onDelete,
}: {
  row: EventRow;
  fmt: ReturnType<typeof useFormatters>;
  t: ReturnType<typeof useTranslations>;
  ownerContext: EventOwnerContext;
  /** Whether the actor may edit — gates Edit/Comp on mobile. */
  canEdit: boolean;
  /** Whether the actor may manage — gates Cancel/Delete on mobile. */
  canManage: boolean;
  getEditUrl?: (event: EventRow) => string;
  getViewUrl?: (event: EventRow) => string;
  getAttendeesUrl?: (event: EventRow) => string;
  getVolunteersUrl?: (event: EventRow) => string;
  getCompUrl?: (event: EventRow) => string;
  getDatesUrl?: (event: EventRow) => string;
  /**
   * Row-level actions mirrored from the table's rowActions menu. The menu is
   * table-only (DataTable card mode does not render rowActions), so the
   * expanded panel is the canonical mobile home for these.
   */
  onShare?: (event: EventRow) => void;
  onCancel?: (event: EventRow) => void;
  onDelete?: (event: EventRow) => void;
}) {
  // ── Lazy-fetch rich event data ──────────────────────────────────────────
  const detailQuery = trpc.events.getEventForEdit.useQuery(
    { eventId: row.id },
    { staleTime: 60_000 },
  );

  // ── Stripe connect status (for conditional payout display) ─────────────
  const orgId = ownerContext.kind === "org" ? ownerContext.orgId : undefined;
  const connectQuery = trpc.stripeConnect.getStatus.useQuery(
    { orgId: orgId! },
    { enabled: Boolean(orgId), staleTime: 120_000 },
  );
  const payoutsEnabled = connectQuery.data?.payoutsEnabled === true;

  const detail = detailQuery.data;
  const isLoading = detailQuery.isLoading;

  if (isLoading) {
    return (
      <PanelContainer
        alignItems="center"
        justifyContent="center"
        minHeight={80}
      >
        <Spinner size="small" color="$accent" />
      </PanelContainer>
    );
  }

  if (!detail) {
    // Fallback — show basic info from the list row
    return (
      <PanelContainer>
        <SectionRow>
          <DetailItem
            label={String(t("admin.eventColumn"))}
            value={row.title ?? String(t("admin.untitledEvent"))}
          />
          <DetailItem
            label={String(t("admin.statusColumn"))}
            value={row.status}
          />
          <DetailItem
            label={String(t("admin.dateColumn"))}
            value={fmtDate(fmt, row.startsAt)}
          />
        </SectionRow>
      </PanelContainer>
    );
  }

  // ── Derived values ─────────────────────────────────────────────────────
  const GateIcon = GATE_ICONS[detail.gateType] ?? Globe;
  const gateLabel = GATE_LABELS[detail.gateType] ?? detail.gateType;
  const VisIcon = VISIBILITY_ICONS[detail.visibility] ?? Globe;
  const payoutSchedule = detail.payoutSchedule as PayoutSchedule | null;
  const scheduleLabel = payoutSchedule
    ? String(t(PAYOUT_SCHEDULE_LABEL_KEYS[payoutSchedule]))
    : null;
  const expectedPayout = payoutSchedule
    ? expectedPayoutDate(payoutSchedule, {
        startsAt: detail.startsAt,
        endsAt: detail.endsAt,
      })
    : null;

  return (
    <PanelContainer>
      {/* ── Row 0: Quick navigation — primary reason to expand the row ── */}
      {(() => {
        const isPublished = row.status === "PUBLISHED";
        // Edit/Comp are content writes — gate on canEdit (ORG_EDIT_ROLES).
        // Cancel/Delete are destructive management — gate on canManage
        // (ORG_ADMIN_ROLES) so an EDITOR doesn't see actions the server 403s.
        // View, Share, Attendees and Volunteers are read/share — always shown.
        const showEdit = canEdit && Boolean(getEditUrl);
        const showAttendees = Boolean(getAttendeesUrl) && isPublished;
        const showComp = canEdit && Boolean(getCompUrl) && isPublished;
        const showView = Boolean(getViewUrl) && isPublished;
        const showShare = Boolean(onShare) && isPublished;
        const showCancel =
          canManage &&
          Boolean(onCancel) &&
          (row.status === "DRAFT" || row.status === "PUBLISHED");
        const showDelete =
          canManage && Boolean(onDelete) && row.status === "DRAFT";
        const anyLink =
          showEdit ||
          showAttendees ||
          Boolean(getVolunteersUrl) ||
          showComp ||
          showView ||
          showShare ||
          showCancel ||
          showDelete;
        if (!anyLink) return null;
        return (
          <XStack
            gap="$2"
            flexWrap="wrap"
            paddingBottom="$3"
            marginBottom="$2"
            borderBottomWidth={2}
            borderBottomColor="$borderColor"
          >
            {showEdit && getEditUrl && (
              <DetailLink
                href={getEditUrl(row)}
                icon={<Edit size={14} />}
                label="Edit"
              />
            )}
            {showAttendees && getAttendeesUrl && (
              <DetailLink
                href={getAttendeesUrl(row)}
                icon={<Users size={14} />}
                label="Attendees"
              />
            )}
            {getVolunteersUrl && (
              <DetailLink
                href={getVolunteersUrl(row)}
                icon={<HeartHandshake size={14} />}
                label="Volunteers"
              />
            )}
            {detail.seriesId && getDatesUrl && (
              <DetailLink
                href={getDatesUrl(row)}
                icon={<Repeat size={14} />}
                label={String(t("admin.sdManageDates"))}
              />
            )}
            {showComp && getCompUrl && (
              <DetailLink
                href={getCompUrl(row)}
                icon={<Gift size={14} />}
                label="Comp tickets"
              />
            )}
            {showView && getViewUrl && (
              <DetailLink
                href={getViewUrl(row)}
                icon={<Eye size={14} />}
                label="View event"
                external
              />
            )}
            {showShare && onShare && (
              <Button
                variant="secondary"
                size="$2"
                minHeight={44}
                onPress={() => onShare(row)}
              >
                <Share2 size={14} />
                {String(t("admin.shareEvent"))}
              </Button>
            )}
            {showCancel && onCancel && (
              <Button
                variant="destructive"
                size="$2"
                minHeight={44}
                onPress={() => onCancel(row)}
              >
                <Ban size={14} />
                {String(t("admin.cancelEvent"))}
              </Button>
            )}
            {showDelete && onDelete && (
              <Button
                variant="destructive"
                size="$2"
                minHeight={44}
                onPress={() => onDelete(row)}
              >
                <Trash2 size={14} />
                {String(t("admin.deleteEvent"))}
              </Button>
            )}
          </XStack>
        );
      })()}

      {/* ── Row 1: Key metrics ─────────────────────────────────────── */}
      <SectionRow>
        <MetricBox flex={1}>
          <MetricIconBox>
            <Ticket size={16} color="var(--accent)" />
          </MetricIconBox>
          <YStack gap={2}>
            <Text
              variant="overline"
              tone="muted"
              style={{
                fontWeight: "700",
              }}
            >
              Tickets Sold
            </Text>
            <Text
              variant="body"
              color="$color"
              style={{ fontSize: 18, fontWeight: "900" }}
            >
              {detail.ticketsSold}
            </Text>
          </YStack>
        </MetricBox>

        <MetricBox flex={1}>
          <MetricIconBox>
            <GateIcon size={16} color="var(--accent)" />
          </MetricIconBox>
          <YStack gap={2}>
            <Text
              variant="overline"
              tone="muted"
              style={{
                fontWeight: "700",
              }}
            >
              Access Gate
            </Text>
            <Text variant="body" color="$color" style={{ fontWeight: "700" }}>
              {gateLabel}
            </Text>
          </YStack>
        </MetricBox>

        <MetricBox flex={1}>
          <MetricIconBox>
            <VisIcon size={16} color="var(--accent)" />
          </MetricIconBox>
          <YStack gap={2}>
            <Text
              variant="overline"
              tone="muted"
              style={{
                fontWeight: "700",
              }}
            >
              Visibility
            </Text>
            <Text variant="body" color="$color" style={{ fontWeight: "700" }}>
              {detail.visibility}
            </Text>
          </YStack>
        </MetricBox>

        {payoutsEnabled && payoutSchedule && (
          <MetricBox flex={1}>
            <MetricIconBox>
              <Banknote size={16} color="var(--accent)" />
            </MetricIconBox>
            <YStack gap={2}>
              <Text
                variant="overline"
                tone="muted"
                style={{
                  fontWeight: "700",
                }}
              >
                {String(t("admin.emPayoutLabel"))}
              </Text>
              <Text variant="body" color="$color" style={{ fontWeight: "700" }}>
                {scheduleLabel}
              </Text>
              {expectedPayout && (
                <Text variant="caption" tone="muted" style={{ fontSize: 11 }}>
                  {String(
                    t("admin.ebPayoutExpected", {
                      date: fmt.dateTime(expectedPayout, PAYOUT_DATE_FORMAT),
                    }),
                  )}
                </Text>
              )}
            </YStack>
          </MetricBox>
        )}
      </SectionRow>

      {/* ── Row 2: Event details ───────────────────────────────────── */}
      <XStack
        borderTopWidth={2}
        borderTopColor="$borderColor"
        paddingTop="$4"
        gap="$5"
        flexWrap="wrap"
      >
        <SectionBlock>
          <SectionLabel color="$accent">Schedule</SectionLabel>
          <DetailItem label="Starts" value={fmtDate(fmt, detail.startsAt)} />
          <DetailItem
            label="Ends"
            value={detail.endsAt ? fmtDate(fmt, detail.endsAt) : "—"}
          />
          {detail.refundCutoffAt && (
            <DetailItem
              label="Refund Cutoff"
              value={fmtDate(fmt, detail.refundCutoffAt)}
            />
          )}
        </SectionBlock>

        <SectionBlock>
          <SectionLabel color="$accent">Location</SectionLabel>
          <DetailItem label="Address" value={detail.addressText ?? "—"} />
          <DetailItem label="Display Mode" value={detail.locationMode} />
          {detail.locationLabel && (
            <DetailItem label="Label" value={detail.locationLabel} />
          )}
        </SectionBlock>

        <SectionBlock>
          <SectionLabel color="$accent">Settings</SectionLabel>
          <DetailItem label="Slug" value={detail.slug ?? "—"} />
          <DetailItem label="Short ID" value={detail.shortId ?? "—"} />
          {detail.currency && (
            <DetailItem label="Currency" value={detail.currency} />
          )}
          {detail.seriesId && (
            <DetailItem label="Series" value="Recurring event" />
          )}
          {detail.waiverTemplateId && (
            <DetailItem label="Waiver" value="Required" />
          )}
          {detail.placeLayoutId && (
            <DetailItem label="Seating" value="Assigned layout" />
          )}
        </SectionBlock>
      </XStack>
    </PanelContainer>
  );
}

function DetailLink({
  href,
  icon,
  label,
  external,
}: {
  href: string;
  icon: React.ReactNode;
  label: string;
  external?: boolean;
}) {
  return (
    <a
      href={href}
      {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      style={{ textDecoration: "none", display: "inline-flex" }}
    >
      <XStack
        paddingHorizontal="$3"
        paddingVertical="$3"
        gap="$2"
        alignItems="center"
        cursor="pointer"
        borderWidth={2}
        borderColor="$borderColor"
        borderRadius={0}
        backgroundColor="$surface"
        minHeight={44}
        hoverStyle={{
          backgroundColor: "$surfaceMuted",
          borderColor: "$accent",
        }}
      >
        {icon}
        <Text variant="bodySmall" color="$color">
          {label}
        </Text>
      </XStack>
    </a>
  );
}

function DetailItem({ label, value }: { label: string; value: string }) {
  return (
    <YStack gap={2} minWidth={120}>
      <Text variant="overline" tone="muted">
        {label}
      </Text>
      <Text variant="body" color="$color">
        {value}
      </Text>
    </YStack>
  );
}

function VolunteerReviewCell({
  counts,
}: {
  counts: Partial<Record<string, number>> | undefined;
}) {
  const t = useTranslations();
  if (!counts) {
    return (
      <Text variant="caption" tone="muted">
        —
      </Text>
    );
  }
  const pending = counts.PENDING ?? 0;
  const approved = counts.APPROVED ?? 0;
  if (pending === 0 && approved === 0) {
    return (
      <Text variant="caption" tone="muted">
        {String(t("admin.eventVolunteerNone"))}
      </Text>
    );
  }
  return (
    <XStack gap="$2" alignItems="center" flexWrap="wrap">
      {pending > 0 ? (
        <Badge tone="warning" size="sm">
          {`${pending} ${String(t("admin.eventVolunteerPending"))}`}
        </Badge>
      ) : null}
      {approved > 0 ? (
        <Badge tone="success" size="sm">
          {`${approved} ${String(t("admin.eventVolunteerApproved"))}`}
        </Badge>
      ) : null}
    </XStack>
  );
}
