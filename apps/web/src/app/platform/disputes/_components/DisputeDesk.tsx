"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { XStack, YStack, useTheme } from "tamagui";
import {
  Badge,
  Button,
  SegmentedControl,
  Text,
  useTranslations,
} from "@th/ui";
import { RefreshCw, ShieldAlert } from "lucide-react";
import { keepPreviousData } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@th/trpc";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useTabVisible } from "@/components/support/useTabVisible";
import { PlatformContainer } from "../../_components/PlatformPageParts";
import { DisputeQueue } from "./DisputeQueue";
import { DisputeDetail } from "./DisputeDetail";
import { DUE_SOON_DAYS, dueTreatment } from "./dispute-desk.helpers";

export type DeskFilter = "open" | "closed" | "all";

export type DisputeRow =
  inferRouterOutputs<AppRouter>["platform"]["disputes"]["list"]["items"][number];

type ListPage = inferRouterOutputs<AppRouter>["platform"]["disputes"]["list"];

const PAGE_SIZE = 50;

/** Attribute-selector-safe form of a row id (ids are UUIDs; anything else is dropped). */
export function rowSelectorId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "");
}

/**
 * Platform dispute desk: every chargeback the platform (merchant of record)
 * is answering for, sorted by evidence due date, with the auto-assembled
 * evidence package to review, approve and submit from one page.
 *
 * Structure mirrors SupportInbox: filter + list on the left, detail on the
 * right; on mobile the detail replaces the list. `?dispute=<id>` deep-links a
 * row (the Discord alert links here).
 */
export function DisputeDesk() {
  const t = useTranslations();
  const theme = useTheme();
  const router = useRouter();
  const isMobile = useIsMobile();
  const tabVisible = useTabVisible();
  const utils = trpc.useUtils();

  const searchParams = useSearchParams();
  const disputeParam = searchParams.get("dispute");

  // A deep-linked dispute may be closed, so the filter opens on ALL in that
  // case — the row must be findable regardless of the operator's default.
  const [filter, setFilter] = useState<DeskFilter>(
    disputeParam ? "all" : "open",
  );
  const [selectedId, setSelectedId] = useState<string | null>(disputeParam);
  // Focus moves into the detail only for a selection the operator made; a
  // deep-linked initial load leaves focus at the top of the document.
  const [focusOnLoad, setFocusOnLoad] = useState(false);

  // "Now" is sampled once per render cycle of the list (not per row) so the
  // due-date treatment is consistent across rows; refreshed with the poll.
  const [now, setNow] = useState(() => new Date());

  const listQuery = trpc.platform.disputes.list.useQuery(
    { status: filter, limit: PAGE_SIZE },
    {
      // Working surface, not a passive page: keep the queue fresh while the
      // tab is visible. Backgrounded tabs stop polling entirely (mirrors
      // SupportInbox). Refresh is still available on demand.
      refetchInterval: tabVisible ? 20_000 : false,
      refetchIntervalInBackground: false,
      staleTime: 10_000,
      placeholderData: keepPreviousData,
    },
  );

  useEffect(() => {
    if (listQuery.dataUpdatedAt) setNow(new Date());
  }, [listQuery.dataUpdatedAt]);

  // Cursor pages beyond the first, fetched on demand. Kept OUT of
  // `useInfiniteQuery` on purpose: tRPC's infinite hook injects a top-level
  // `direction` key that the strict `list` input rejects with BAD_REQUEST.
  // Keyed by filter AND by the first page's `dataUpdatedAt`: when page 1
  // reshuffles (poll or Refresh) the cursor chain behind it is void, so the
  // extra pages are dropped and "Load more" comes back.
  const [extra, setExtra] = useState<{
    filter: DeskFilter;
    dataUpdatedAt: number;
    pages: ListPage[];
  }>({ filter, dataUpdatedAt: 0, pages: [] });
  const extraPages = useMemo(
    () =>
      extra.filter === filter && extra.dataUpdatedAt === listQuery.dataUpdatedAt
        ? extra.pages
        : [],
    [extra, filter, listQuery.dataUpdatedAt],
  );
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);

  const rows = useMemo<DisputeRow[]>(() => {
    const seen = new Set<string>();
    const out: DisputeRow[] = [];
    const pages = [listQuery.data, ...extraPages];
    for (const page of pages) {
      for (const item of page?.items ?? []) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        out.push(item);
      }
    }
    return out;
  }, [listQuery.data, extraPages]);

  const nextCursor =
    extraPages.length > 0
      ? extraPages[extraPages.length - 1].nextCursor
      : (listQuery.data?.nextCursor ?? null);

  const handleLoadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      const page = await utils.platform.disputes.list.fetch({
        status: filter,
        cursor: nextCursor,
        limit: PAGE_SIZE,
      });
      const dataUpdatedAt = listQuery.dataUpdatedAt;
      setExtra((prev) => ({
        filter,
        dataUpdatedAt,
        pages:
          prev.filter === filter && prev.dataUpdatedAt === dataUpdatedAt
            ? [...prev.pages, page]
            : [page],
      }));
    } catch (err) {
      setLoadMoreError(formatErrorMessage(err, (key) => String(t(key))));
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, loadingMore, utils, filter, t, listQuery.dataUpdatedAt]);

  // Write actions render for ADMIN only — the exact set the desk's write use
  // cases enforce (`DISPUTE_DESK_WRITE_ROLES`). SUPPORT gets a read-only desk.
  const staffAccessQuery = trpc.platform.checkStaffAccess.useQuery(undefined, {
    staleTime: 60_000,
  });
  const canWrite = (staffAccessQuery.data?.roles ?? []).includes("ADMIN");

  // ── Selection + focus management ──────────────────────────────────────────
  const queueRef = useRef<HTMLDivElement>(null);
  const detailHeadingRef = useRef<HTMLHeadingElement>(null);
  const pendingFocusRow = useRef<string | null>(null);

  const syncUrl = useCallback(
    (id: string | null) => {
      const params = new URLSearchParams(searchParams.toString());
      if (id) params.set("dispute", id);
      else params.delete("dispute");
      const qs = params.toString();
      router.replace(qs ? `?${qs}` : "?", { scroll: false });
    },
    [router, searchParams],
  );

  const handleSelect = useCallback(
    (id: string) => {
      setSelectedId(id);
      setFocusOnLoad(true);
      syncUrl(id);
    },
    [syncUrl],
  );

  const handleClose = useCallback(() => {
    pendingFocusRow.current = selectedId;
    setSelectedId(null);
    syncUrl(null);
  }, [selectedId, syncUrl]);

  // Closing the detail returns focus to the row that opened it (DataTable
  // rows are tabbable). Focus INTO the detail is owned by DisputeDetail —
  // its heading only exists once the query resolves.
  useEffect(() => {
    if (selectedId) return;
    const rowId = pendingFocusRow.current;
    if (!rowId) return;
    pendingFocusRow.current = null;
    const safe = rowSelectorId(rowId);
    const raf = requestAnimationFrame(() => {
      const root = queueRef.current;
      const row =
        root?.querySelector<HTMLElement>(`[data-row-key="${safe}"]`) ??
        root?.querySelector<HTMLElement>(
          `[data-testid="dispute-desk-table-row-${safe}"]`,
        );
      row?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [selectedId]);

  const handleChanged = useCallback(() => {
    void utils.platform.disputes.list.invalidate();
  }, [utils]);

  // ── Header signal: how many loaded rows are due within 3 days / overdue ──
  const urgentCount = useMemo(
    () =>
      rows.filter(
        (row) =>
          dueTreatment(row.evidenceDueBy, now, row.evidencePastDue).intent !==
          "none",
      ).length,
    [rows, now],
  );

  const showDetail = selectedId !== null;
  const showQueue = !isMobile || !showDetail;
  const split = !isMobile && showDetail;

  const filterOptions: Array<{ value: DeskFilter; label: string }> = [
    // i18n: key pending
    { value: "open", label: "Open" },
    { value: "closed", label: "Closed" },
    { value: "all", label: "All" },
  ];

  const selectedSafe = selectedId ? rowSelectorId(selectedId) : null;

  return (
    // On mobile the navigation shell already pads the page 40px per side
    // (NavigationShellRow 16 + NavigationShellContent 24); adding the
    // container's own 24 left a 190px column at 320px, which is what made
    // 9-letter words break mid-word in the detail. Measured, not guessed.
    <PlatformContainer size="lg" paddingHorizontal={isMobile ? 0 : 24}>
      {/* Selected-row highlight. DataTable owns the <tr>, so the highlight
          rides its `data-row-key` attribute (and the card-mode test id). */}
      {selectedSafe && (
        <style>{`
          .dispute-desk-queue tr[data-row-key="${selectedSafe}"] td {
            background: var(--surfaceMuted, #EFE7D6);
          }
          .dispute-desk-queue tr[data-row-key="${selectedSafe}"] td:first-child,
          .dispute-desk-queue [data-testid="dispute-desk-table-row-${selectedSafe}"] {
            box-shadow: inset 4px 0 0 var(--accent, #E2481D);
          }
        `}</style>
      )}

      <YStack gap={8}>
        <XStack gap={8} alignItems="center" flexWrap="wrap">
          <ShieldAlert size={20} color={theme.color?.val} aria-hidden />
          <Text variant="h2" tag="h1" weight="bold">
            {/* i18n: key pending */}
            Disputes
          </Text>
          {urgentCount > 0 && (
            <Badge
              tone="warning"
              size="sm"
              aria-label={`${urgentCount} due within ${DUE_SOON_DAYS} days or overdue`}
            >
              {urgentCount}
            </Badge>
          )}
        </XStack>
        <Text variant="body" tone="muted">
          {/* i18n: key pending */}
          Chargebacks the platform is answering for. Review the evidence
          package, approve it, and submit it to Stripe before the due date.
        </Text>
      </YStack>

      {showQueue && (
        <XStack gap="$3" alignItems="center" flexWrap="wrap">
          <SegmentedControl<DeskFilter>
            options={filterOptions}
            value={filter}
            onChange={(next) => {
              setFilter(next);
              setLoadMoreError(null);
            }}
            size="sm"
            ariaLabel="Dispute status filter"
            testIdBase="dispute-desk-filter"
          />
          <XStack flex={1} />
          {listQuery.data && (
            <Text variant="caption" tone="muted">
              {rows.length === 1
                ? "1 dispute"
                : `${rows.length} disputes${nextCursor ? "+" : ""}`}
            </Text>
          )}
          <Button
            variant="ghost"
            size={isMobile ? "$4" : "$2"}
            onPress={() => {
              setNow(new Date());
              void listQuery.refetch();
            }}
            aria-label="Refresh queue"
          >
            <RefreshCw size={14} aria-hidden />
            {String(t("admin.refresh"))}
          </Button>
        </XStack>
      )}

      <div
        style={{
          display: "grid",
          // Detail gets a bounded column; the queue takes the rest and scrolls
          // inside its own container when the compact column set still does
          // not fit.
          gridTemplateColumns: split
            ? "minmax(0, 1fr) minmax(400px, 480px)"
            : "minmax(0, 1fr)",
          gap: 16,
          alignItems: "start",
        }}
      >
        {showQueue && (
          <div ref={queueRef} className="dispute-desk-queue" style={{ minWidth: 0 }}>
            <DisputeQueue
              rows={rows}
              filter={filter}
              now={now}
              isMobile={isMobile}
              compact={split}
              isLoading={listQuery.isLoading}
              isError={listQuery.isError}
              errorMessage={
                listQuery.error
                  ? formatErrorMessage(listQuery.error, (key) => String(t(key)))
                  : null
              }
              onRetry={() => void listQuery.refetch()}
              onSelect={handleSelect}
              hasMore={Boolean(nextCursor)}
              isLoadingMore={loadingMore}
              loadMoreError={loadMoreError}
              onLoadMore={() => void handleLoadMore()}
            />
          </div>
        )}
        {showDetail && selectedId && (
          <DisputeDetail
            // Remount per selection so focus moves into the panel even when
            // the next dispute is already cached.
            key={selectedId}
            disputeId={selectedId}
            canWrite={canWrite}
            isMobile={isMobile}
            now={now}
            headingRef={detailHeadingRef}
            focusOnLoad={focusOnLoad}
            onClose={handleClose}
            onChanged={handleChanged}
          />
        )}
      </div>
    </PlatformContainer>
  );
}

DisputeDesk.displayName = "DisputeDesk";
