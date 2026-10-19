"use client";

import { useMemo, useState, useCallback, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { useTheme, YStack, XStack } from "tamagui";
import {
  PlatformContainer,
  PlatformTabBar,
  PlatformTab,
  scrollTabIntoView,
} from "../_components/PlatformPageParts";
import { FilterChips } from "@/components/AdminTableParts";
import {
  DataTable,
  type DataTableColumn,
  type DataTableSortState,
  Button,
  Text,
  Badge,
  TextInput,
  NextLinkAnchor,
  useTranslations,
  useFormatters,
} from "@th/ui";
import {
  ShoppingCart,
  Search,
  Filter,
  X,
  ExternalLink,
  ChevronDown,
  RefreshCw,
} from "lucide-react";
import { keepPreviousData } from "@tanstack/react-query";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";
import { fmtDate, fmtCurrency } from "@/lib/format";
import { formatOrderCode } from "@th/types/order-identifier";
import { useIsMobile } from "@/hooks/useIsMobile";
import { OrderStatusBadge } from "../../admin/[slug]/orders/_components/OrderStatusBadge";
import { OrderMobileCard } from "./_components/OrderMobileCard";
import type { OrderStatus, OrderSource } from "@th/types";

import {
  PlatformOrderDetail,
  type PlatformOrderRow,
  type PlatformOrderItemSummary,
  SOURCE_LABEL_KEY,
} from "./_components/OrderDetailPanel";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type TabFilter = "all" | "active_carts" | "disputed";

const STATUS_OPTIONS: { value: OrderStatus; labelKey: string }[] = [
  { value: "PENDING", labelKey: "admin.statusPending" },
  { value: "SUCCEEDED", labelKey: "admin.statusSucceeded" },
  { value: "PART_REFUNDED", labelKey: "admin.statusPartialRefund" },
  { value: "REFUNDED", labelKey: "admin.statusRefunded" },
  { value: "DISPUTED", labelKey: "admin.statusDisputed" },
  { value: "CANCELLED", labelKey: "admin.statusCancelled" },
];

const SOURCE_OPTIONS: { value: OrderSource; labelKey: string }[] = [
  { value: "PRIMARY", labelKey: "admin.plSourcePrimary" },
  { value: "RESALE", labelKey: "admin.plSourceResale" },
];

const TAB_CONFIG: { key: TabFilter; labelKey: string }[] = [
  { key: "all", labelKey: "admin.plTabAll" },
  { key: "active_carts", labelKey: "admin.plTabActiveCarts" },
  { key: "disputed", labelKey: "admin.plTabDisputed" },
];

const PAGE_SIZE = 25;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export default function PlatformOrdersPage() {
  return (
    <Suspense>
      <PlatformOrdersPageContent />
    </Suspense>
  );
}

function PlatformOrdersPageContent() {
  // ── i18n ─────────────────────────────────────────────────────────────────
  const t = useTranslations();
  const fmt = useFormatters();
  const isMobile = useIsMobile();

  // ── Deep-link params ───────────────────────────────────────────────────────
  // Operators arrive here from the support inbox: `?humanId=<uuid>` scopes the
  // list to one buyer; `?orderId=<uuid>` seeds the search to surface a single
  // order. We only accept the humanId UUID here — never an attendee email.
  const searchParams = useSearchParams();
  const humanIdParam = searchParams.get("humanId");
  const orderIdParam = searchParams.get("orderId");

  // ── State ────────────────────────────────────────────────────────────────
  const theme = useTheme();
  const [activeTab, setActiveTab] = useState<TabFilter>("all");
  const [searchQuery, setSearchQuery] = useState(orderIdParam ?? "");
  const [debouncedSearch, setDebouncedSearch] = useState(orderIdParam ?? "");
  const [statusFilter, setStatusFilter] = useState<OrderStatus | undefined>(
    undefined,
  );
  const [sourceFilter, setSourceFilter] = useState<OrderSource | undefined>(
    undefined,
  );
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState<DataTableSortState>({
    columnId: "occurredAt",
    direction: "desc",
  });
  const [expandedOrderIds, setExpandedOrderIds] = useState<Set<string>>(
    new Set(),
  );

  // Search debounce
  const searchTimeout = useState<ReturnType<typeof setTimeout> | null>(null);
  const handleSearchChange = useCallback(
    (value: string) => {
      setSearchQuery(value);
      if (searchTimeout[0]) clearTimeout(searchTimeout[0]);
      searchTimeout[0] = setTimeout(() => {
        setDebouncedSearch(value.trim());
        setPage(0);
      }, 300);
    },
    [searchTimeout],
  );

  // ── Expand helpers ───────────────────────────────────────────────────
  const toggleExpandOrder = useCallback((id: string) => {
    setExpandedOrderIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Derive status from tab
  const effectiveStatus = useMemo(() => {
    if (activeTab === "active_carts") return "PENDING" as OrderStatus;
    if (activeTab === "disputed") return "DISPUTED" as OrderStatus;
    return statusFilter;
  }, [activeTab, statusFilter]);

  // ── Query ────────────────────────────────────────────────────────────────
  const sortParam =
    sort.direction === "asc" ? "occurredAt_asc" : "occurredAt_desc";

  const { data, isLoading, error, refetch } = trpc.platform.listOrders.useQuery(
    {
      searchQuery: debouncedSearch || undefined,
      status: effectiveStatus,
      source: sourceFilter,
      humanId: humanIdParam ?? undefined,
      sort: sortParam as "occurredAt_asc" | "occurredAt_desc",
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    },
    {
      staleTime: 30_000,
      placeholderData: keepPreviousData,
    },
  );

  const rows: PlatformOrderRow[] = useMemo(() => {
    if (!data?.items) return [];
    return data.items.map((item) => ({
      ...item,
      occurredAt: new Date(item.occurredAt),
      createdAt: new Date(item.createdAt),
      updatedAt: new Date(item.updatedAt),
      items: (item.items ?? []).map((i: Record<string, unknown>) => ({
        ...i,
        paidOutAt: i.paidOutAt ? new Date(i.paidOutAt as string) : null,
        refundedAt: i.refundedAt ? new Date(i.refundedAt as string) : null,
        transferredAt: i.transferredAt
          ? new Date(i.transferredAt as string)
          : null,
        ticketScannedAt: i.ticketScannedAt
          ? new Date(i.ticketScannedAt as string)
          : null,
      })) as PlatformOrderItemSummary[],
    }));
  }, [data?.items]);

  const totalRows = data?.pageInfo?.total ?? 0;
  const totalPages = Math.ceil(totalRows / PAGE_SIZE);

  const summaryLabel = useMemo(() => {
    if (!data?.pageInfo) return undefined;
    const start = page * PAGE_SIZE + 1;
    const end = Math.min((page + 1) * PAGE_SIZE, totalRows);
    if (totalRows === 0) return String(t("admin.noOrders"));
    return String(t("admin.nOfTotal", { start, end, total: totalRows }));
  }, [data?.pageInfo, page, totalRows, t]);

  // ── Columns ──────────────────────────────────────────────────────────────
  const columns: DataTableColumn<PlatformOrderRow>[] = useMemo(
    () => [
      {
        id: "id",
        header: String(t("admin.plOrderId")),
        width: 1.3,
        // The ONE order code — `formatOrderCode`, the 8-hex TAIL uppercased.
        // NOT `truncateId`, which renders the HEAD (`9f2c1d4e…`): the detail
        // panel this row opens shows the tail, so the same order read two
        // different codes depending on where you looked, and the head — being
        // 8 hex chars — passes admin search's identifier shape and then
        // matches nothing. `truncateId` stays correct for the settlement /
        // role / human / audit-log / claim tables, which are not orders.
        // Bare (no `#`): the "Order ID" column header labels the column.
        cell: (row) => (
          <Text
            variant="body"
            style={{
              fontSize: 12,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {formatOrderCode(row.id)}
          </Text>
        ),
      },
      {
        id: "status",
        header: String(t("admin.status")),
        width: 1.3,
        cell: (row) => <OrderStatusBadge status={row.status} />,
      },
      {
        id: "buyerName",
        header: String(t("admin.buyer")),
        width: 2.2,
        cell: (row) => (
          <YStack gap="$1">
            <Text
              variant="body"
              weight="bold"
              tone={row.buyerName ? "default" : "muted"}
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {row.buyerName || String(t("admin.unknownBuyer"))}
            </Text>
            {row.buyerEmail && (
              <Text
                variant="caption"
                tone="muted"
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {row.buyerEmail}
              </Text>
            )}
          </YStack>
        ),
      },
      {
        id: "eventTitle",
        header: String(t("admin.event")),
        width: 2,
        cell: (row) => (
          <Text
            variant="body"
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {row.eventTitle ?? "Membership" /* i18n: key pending */}
          </Text>
        ),
      },
      {
        id: "orgName",
        header: String(t("admin.plOrg")),
        width: 1.5,
        cell: (row) => (
          <Text
            variant="body"
            tone={row.orgName ? "default" : "muted"}
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {row.orgName || "\u2014"}
          </Text>
        ),
      },
      {
        id: "amountGrossCents",
        header: String(t("admin.plGross")),
        width: 1.2,
        cell: (row) => (
          <Text variant="body" weight="bold">
            {fmtCurrency(fmt, row.amountGrossCents, row.currency)}
          </Text>
        ),
      },
      {
        id: "feesPlatformCents",
        header: String(t("admin.platformFee")),
        width: 1.2,
        cell: (row) => (
          <Text variant="caption" tone="muted">
            {fmtCurrency(fmt, row.feesPlatformCents, row.currency)}
          </Text>
        ),
      },
      {
        id: "itemCount",
        header: String(t("admin.plItems")),
        width: 0.7,
        cell: (row) => (
          <Text variant="body" tone="muted">
            {row.itemCount}
          </Text>
        ),
      },
      {
        id: "source",
        header: String(t("admin.plSource")),
        width: 0.9,
        cell: (row) => (
          <Badge tone={row.source === "RESALE" ? "info" : "neutral"} size="sm">
            {String(t(SOURCE_LABEL_KEY[row.source]))}
          </Badge>
        ),
      },
      {
        id: "occurredAt",
        header: String(t("admin.date")),
        width: 1.8,
        noWrap: true,
        cell: (row) => (
          <Text variant="body" tone="default">
            {fmtDate(fmt, row.occurredAt)}
          </Text>
        ),
      },
    ],
    [t, fmt],
  );

  // ── Row actions ──────────────────────────────────────────────────────────
  const rowActions = useMemo(
    () => ({
      header: "",
      width: 1,
      render: (row: PlatformOrderRow) => (
        <XStack gap="$2" justifyContent="flex-end">
          <Button
            variant={expandedOrderIds.has(row.id) ? "primary" : "ghost"}
            size="$2"
            icon
            onPress={() => toggleExpandOrder(row.id)}
            aria-label={String(t("admin.viewDetails"))}
          >
            <ChevronDown
              size={14}
              style={{
                transform: expandedOrderIds.has(row.id)
                  ? "rotate(180deg)"
                  : undefined,
                transition: "transform 0.15s ease",
              }}
            />
          </Button>
          {row.stripePaymentIntentId && (
            <Button
              variant="ghost"
              size="$2"
              icon
              onPress={() => {
                window.open(
                  `https://dashboard.stripe.com/payments/${row.stripePaymentIntentId}`,
                  "_blank",
                );
              }}
              aria-label={String(t("admin.viewInStripe"))}
            >
              <ExternalLink size={14} />
            </Button>
          )}
        </XStack>
      ),
    }),
    [expandedOrderIds, toggleExpandOrder, t],
  );

  // ── Filter handlers ──────────────────────────────────────────────────────
  const handleTabChange = useCallback((tab: TabFilter) => {
    setActiveTab(tab);
    setStatusFilter(undefined);
    setSourceFilter(undefined);
    setPage(0);
  }, []);

  const handleStatusToggle = useCallback((status: OrderStatus) => {
    setStatusFilter((prev) => (prev === status ? undefined : status));
    setPage(0);
  }, []);

  const clearFilters = useCallback(() => {
    setSearchQuery("");
    setDebouncedSearch("");
    setStatusFilter(undefined);
    setSourceFilter(undefined);
    setPage(0);
  }, []);

  const hasActiveFilters =
    Boolean(debouncedSearch) || Boolean(statusFilter) || Boolean(sourceFilter);

  // Show status chips only on the "all" tab (tabs override status for the other tabs)
  const showStatusChips = activeTab === "all";

  // ── Error state ──────────────────────────────────────────────────────────
  if (error) {
    return (
      <PlatformContainer size="lg">
        <YStack gap="$3">
          <Text variant="body" tone="error">
            {String(
              t("admin.plFailedToLoadOrders", {
                error: formatErrorMessage(error),
              }),
            )}
          </Text>
          <Button variant="secondary" size="$2" onPress={() => refetch()}>
            {String(t("admin.retry"))}
          </Button>
        </YStack>
      </PlatformContainer>
    );
  }

  return (
    <PlatformContainer size="lg">
      {/* Header */}
      <YStack gap={8}>
        <XStack gap={8} alignItems="center">
          <ShoppingCart size={20} color={theme.color?.val} />
          <Text variant="h2" tag="h1" weight="bold">
            {String(t("admin.plOrdersTitle"))}
          </Text>
        </XStack>
        <Text variant="body" tone="muted">
          {String(t("admin.plOrdersSubtitle"))}
        </Text>
        {humanIdParam && (
          <XStack
            alignItems="center"
            gap="$2"
            flexWrap="wrap"
            paddingHorizontal="$3"
            paddingVertical="$2"
            borderWidth={2}
            borderColor="$borderColor"
            backgroundColor="$surfaceMuted"
            alignSelf="flex-start"
            maxWidth="100%"
          >
            <Filter size={14} color={theme.colorMuted?.val} aria-hidden />
            <Text variant="bodySmall" weight="semibold">
              {String(t("admin.plFilteredToBuyer"))}
            </Text>
            <NextLinkAnchor
              href="/platform/orders"
              aria-label={String(t("admin.plClearBuyerFilter"))}
            >
              <XStack
                tag="span"
                alignItems="center"
                gap="$1"
                paddingHorizontal="$2"
                paddingVertical="$1"
                hoverStyle={{ backgroundColor: "$surface" }}
              >
                <X size={13} aria-hidden />
                <Text variant="caption" weight="semibold">
                  {String(t("admin.plClearBuyerFilter"))}
                </Text>
              </XStack>
            </NextLinkAnchor>
          </XStack>
        )}
      </YStack>

      {/* Tabs */}
      {/* `overflowX` via style: Tamagui's `overflow` type has no "auto". At
          320 the three tabs are 422px wide and scroll inside the bar. */}
      <PlatformTabBar style={{ overflowX: "auto" }}>
        {TAB_CONFIG.map((tab) => (
          <PlatformTab
            key={tab.key}
            active={activeTab === tab.key}
            aria-pressed={activeTab === tab.key}
            onPress={() => handleTabChange(tab.key)}
            onFocus={scrollTabIntoView}
          >
            <Text
              variant="bodySmall"
              weight={activeTab === tab.key ? "semibold" : "regular"}
              color={activeTab === tab.key ? "$color" : "$colorMuted"}
            >
              {String(t(tab.labelKey))}
            </Text>
          </PlatformTab>
        ))}
      </PlatformTabBar>

      {/* Filters */}
      <YStack gap="$3">
        <XStack gap="$3" flexWrap="wrap" alignItems="center">
          {/* Floor of icon + gap + 240px field, as before the field could
              shrink: the row still wraps under 640px where it used to. */}
          <XStack
            alignItems="center"
            gap="$2"
            flex={1}
            maxWidth={340}
            minWidth="min(100%, 264px)"
          >
            <Search size={16} color={theme.colorMuted?.val} />
            {/* TextInput's frame is a fixed 240px and does not shrink; this
                box does, so at 320 the field fits the column. */}
            <XStack flex={1} minWidth={0} maxWidth={240}>
              <TextInput
                fullWidth
                value={searchQuery}
                onChangeText={handleSearchChange}
                placeholder={t("admin.plSearchPlaceholder") as string}
              />
            </XStack>
          </XStack>

          {/* Source filter */}
          <FilterChips<OrderSource>
            options={SOURCE_OPTIONS.map((opt) => ({
              value: opt.value,
              label: String(t(opt.labelKey)),
            }))}
            selected={sourceFilter}
            onSelect={(v) => {
              setSourceFilter(v);
              setPage(0);
            }}
          />

          {hasActiveFilters && (
            <Button variant="ghost" size="$2" onPress={clearFilters}>
              <X size={14} aria-hidden />
              {String(t("admin.clearFilters"))}
            </Button>
          )}
        </XStack>

        {/* Status chips (only on "all" tab) */}
        {showStatusChips && (
          <XStack gap="$2" flexWrap="wrap" alignItems="center">
            <Filter size={14} color={theme.colorMuted?.val} />
            {STATUS_OPTIONS.map((opt) => (
              <Button
                key={opt.value}
                variant={statusFilter === opt.value ? "primary" : "secondary"}
                size="$2"
                onPress={() => handleStatusToggle(opt.value)}
              >
                {String(t(opt.labelKey))}
              </Button>
            ))}
          </XStack>
        )}
      </YStack>

      {/* Action bar */}
      <XStack paddingHorizontal="$1" paddingVertical="$2" alignItems="center">
        <Button
          variant="ghost"
          size="$2"
          onPress={() => refetch()}
          aria-label={t("admin.plRefresh") as string}
          paddingHorizontal="$3"
        >
          <RefreshCw size={14} aria-hidden />
          {String(t("admin.plRefresh"))}
        </Button>
        <XStack flex={1} />
        {summaryLabel && (
          <Text variant="caption" tone="muted" paddingHorizontal="$3">
            {summaryLabel}
          </Text>
        )}
      </XStack>

      {/* Table — the 1100px table floor drops only below useIsMobile's 600px
          breakpoint, the same breakpoint DataTable uses for card mode, so the
          page never pans horizontally on phones; the scoped scroll wrapper
          still handles desktop windows narrower than the floor. */}
      <XStack overflow="scroll" flex={1}>
        <YStack flex={1} minWidth={isMobile ? 0 : 1100}>
          <DataTable
            columns={columns}
            rows={rows}
            getRowKey={(row) => row.id}
            isLoading={isLoading}
            sort={sort}
            onSortChange={(newSort) => {
              setSort(newSort);
              setPage(0);
            }}
            onRowPress={(row) => toggleExpandOrder(row.id)}
            rowActions={rowActions}
            // Card mode (<600px). rowActions are not rendered as cards, but
            // both actions stay reachable: pressing a card toggles the same
            // PlatformOrderDetail expanded panel (the chevron's job), and the
            // panel carries the "View in Stripe" link and a close button.
            renderMobileCard={(row) => <OrderMobileCard row={row} />}
            testIdBase="platform-orders-table"
            renderExpandedRow={(row) =>
              expandedOrderIds.has(row.id) ? (
                <PlatformOrderDetail
                  row={row}
                  onClose={() => {
                    setExpandedOrderIds((prev) => {
                      const next = new Set(prev);
                      next.delete(row.id);
                      return next;
                    });
                  }}
                />
              ) : null
            }
            emptyState={
              <YStack
                padding="$8"
                alignItems="center"
                justifyContent="center"
                gap="$3"
              >
                <ShoppingCart size={32} color="var(--colorMuted)" />
                <Text variant="h4" weight="bold">
                  {hasActiveFilters
                    ? String(t("admin.plNoMatchingOrders"))
                    : String(t("admin.plNoOrdersYet"))}
                </Text>
                <Text
                  variant="body"
                  tone="muted"
                  textAlign="center"
                  maxWidth={360}
                >
                  {hasActiveFilters
                    ? String(t("admin.plNoMatchingOrdersDesc"))
                    : String(t("admin.plNoOrdersYetDesc"))}
                </Text>
                {hasActiveFilters && (
                  <Button variant="secondary" size="$2" onPress={clearFilters}>
                    {String(t("admin.plClearFilters"))}
                  </Button>
                )}
              </YStack>
            }
          />
        </YStack>
      </XStack>

      {/* Pagination */}
      {totalPages > 1 && (
        <XStack
          justifyContent="center"
          alignItems="center"
          gap="$3"
          paddingVertical="$3"
        >
          <Button
            variant="secondary"
            size="$2"
            onPress={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0}
          >
            {String(t("admin.plPrevious"))}
          </Button>
          <Text variant="bodySmall" tone="muted">
            {String(
              t("admin.plPage", { current: page + 1, total: totalPages }),
            )}
          </Text>
          <Button
            variant="secondary"
            size="$2"
            onPress={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            disabled={page >= totalPages - 1}
          >
            {String(t("admin.plNext"))}
          </Button>
        </XStack>
      )}
    </PlatformContainer>
  );
}
