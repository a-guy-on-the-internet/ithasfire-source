"use client";

import { useMemo, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { YStack, XStack } from "tamagui";
import {
  DataTable,
  type DataTableColumn,
  DT_CELL_SUB_CLASS,
  Button,
  Text,
  useTranslations,
  useFormatters,
  useNotify,
} from "@th/ui";
import {
  ExternalLink,
  ChevronDown,
  ChevronRight,
  Download,
  Rows3,
} from "lucide-react";
import { keepPreviousData } from "@tanstack/react-query";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";
import { fmtDateCompact, fmtCurrency } from "@/lib/format";
import { useCurrentAdminOwner } from "@/hooks/useCurrentAdminOwner";
import { useAdminOwnerCapabilities } from "@/hooks/useAdminOwnerCapabilities";
import {
  ActionBar,
  TableContainer,
  SearchBar,
  FilterChips,
  FilterRow,
  Pagination,
  NoResults,
  ColumnSelector,
  type ColumnOption,
} from "@/components/AdminTableParts";
import { AdminPageHeader } from "../../_components/AdminPageHeader";
import { AdminPageData } from "@/app/admin/_components/AdminPageData";
import { OrderStatusBadge } from "./OrderStatusBadge";
import { OrderDetailPanel } from "./OrderDetailPanel";
import {
  RowActionMenu,
  type RowActionMenuItem,
} from "@/components/data-table/RowActionMenu";
import { useAdminTableParams } from "@/hooks/useAdminTableParams";
import { useColumnVisibility } from "@/hooks/useColumnVisibility";
import { useTableDensity } from "@/hooks/useTableDensity";
import { usePageClamp } from "@/hooks/usePageClamp";
import { useIsMobile } from "@/hooks/useIsMobile";
import {
  type CsvColumnDef,
  rowsToCsv,
  downloadCsv,
  fetchAllPages,
  getExportGuardStatus,
} from "@/lib/csv-export";
import type { DisputeStatus, OrderStatus, OrderSource } from "@th/types";

interface OrderRow {
  id: string;
  eventId: string;
  eventTitle: string;
  orgId?: string | null;
  buyerHumanId: string;
  buyerName: string | null;
  buyerEmail: string | null;
  amountGrossCents: number;
  feesPlatformCents: number;
  taxAmountCents: number;
  currency: string;
  status: OrderStatus;
  stripePaymentIntentId: string | null;
  occurredAt: Date;
  source: OrderSource;
  /** Mirror of the order's Dispute row — see OrderStatusBadge. */
  disputeStatus?: DisputeStatus | null;
}

const STATUS_KEYS: Record<OrderStatus, string> = {
  PENDING: "admin.statusPending",
  PROCESSING: "admin.statusProcessing",
  SUCCEEDED: "admin.statusSucceeded",
  PART_REFUNDED: "admin.statusPartialRefund",
  REFUNDED: "admin.statusRefunded",
  DISPUTED: "admin.statusDisputed",
  CANCELLED: "admin.statusCancelled",
};

type OrderListItem = Omit<OrderRow, "occurredAt"> & {
  occurredAt: Date | string;
};

function toOrderRow(item: OrderListItem, fallbackOrgId?: string): OrderRow {
  return {
    ...item,
    orgId: item.orgId ?? fallbackOrgId ?? null,
    occurredAt: new Date(item.occurredAt),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

// Formatters are provided via useFormatters() inside the component.

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function OrdersTable() {
  const { slug } = useParams<{ slug: string }>();
  const { currentOwner, isLoading: ownerLoading } = useCurrentAdminOwner(slug);
  // Order export is a finance action: the background path server-enforces
  // ORG_FINANCE_ROLES (orders.requestExport → canFinanceOrg) and the inline CSV
  // path produces the same financial dataset. Gate the whole Export affordance
  // behind canFinance; the list/detail/search/filter read paths stay open.
  const { canFinance } = useAdminOwnerCapabilities(currentOwner);
  const t = useTranslations();
  const fmt = useFormatters();
  const { toast } = useNotify();
  const isMobile = useIsMobile();

  const orgId = currentOwner?.kind === "org" ? currentOwner.orgId : undefined;
  const isOrgOwner = currentOwner?.kind === "org";
  const isHumanOwner = currentOwner?.kind === "human";
  const canQueryOrders = (isOrgOwner && Boolean(orgId)) || isHumanOwner;
  const canUseOrgOrderActions = isOrgOwner && Boolean(orgId);

  const statusOptions = useMemo(() => {
    const statuses: OrderStatus[] = [
      "PENDING",
      "SUCCEEDED",
      "PART_REFUNDED",
      "REFUNDED",
      "DISPUTED",
      "CANCELLED",
    ];
    return statuses.map((s) => ({
      value: s,
      label: String(t(STATUS_KEYS[s])),
    }));
  }, [t]);

  // ── Filter state ─────────────────────────────────────────────────────────
  const {
    searchQuery,
    debouncedSearch,
    page,
    pageSize,
    handleSearchChange,
    setPage,
    setPageSize,
  } = useAdminTableParams();

  const [statusFilter, setStatusFilter] = useState<OrderStatus | undefined>(
    undefined,
  );
  const [expandedOrderIds, setExpandedOrderIds] = useState<Set<string>>(
    new Set(),
  );

  // ── Column visibility ────────────────────────────────────────────────────
  const ALL_COL_IDS = [
    "occurredAt",
    "buyerName",
    "eventTitle",
    "amountGrossCents",
    "feesPlatformCents",
    "taxAmountCents",
    "status",
  ] as const;

  const columnOptions: ColumnOption[] = useMemo(
    () => [
      { id: "occurredAt", label: String(t("admin.date")) },
      { id: "buyerName", label: String(t("admin.buyer")) },
      { id: "eventTitle", label: String(t("admin.event")) },
      { id: "amountGrossCents", label: String(t("admin.amount")) },
      { id: "feesPlatformCents", label: String(t("admin.platformFee")) },
      { id: "taxAmountCents", label: String(t("admin.tax")) },
      { id: "status", label: String(t("admin.status")) },
    ],
    [t],
  );

  const colVis = useColumnVisibility("admin-orders-columns", ALL_COL_IDS);

  // ── Row density (persisted per-table, mirroring the columns key) ─────────
  const { density, toggleDensity } = useTableDensity("admin-orders-density");

  // ── Query ────────────────────────────────────────────────────────────────
  // Always fetch in server-side occurredAt order; client handles other columns.
  const serverSort: "occurredAt_asc" | "occurredAt_desc" = "occurredAt_desc";
  const ordersQueryInput = {
    searchQuery: debouncedSearch || undefined,
    status: statusFilter,
    sort: serverSort,
    limit: pageSize,
    offset: page * pageSize,
  };

  const orgOrdersQuery = trpc.orders.listOrgOrders.useQuery(
    {
      orgId: orgId ?? "",
      ...ordersQueryInput,
    },
    {
      enabled: isOrgOwner && Boolean(orgId),
      staleTime: 30_000,
      placeholderData: keepPreviousData,
    },
  );

  const humanOrdersQuery = trpc.orders.listMyEventOrders.useQuery(
    ordersQueryInput,
    {
      enabled: isHumanOwner,
      staleTime: 30_000,
      placeholderData: keepPreviousData,
    },
  );

  const activeOrdersQuery = isHumanOwner ? humanOrdersQuery : orgOrdersQuery;
  const data = canQueryOrders ? activeOrdersQuery.data : undefined;
  const isLoading = canQueryOrders ? activeOrdersQuery.isLoading : false;
  const error = canQueryOrders ? activeOrdersQuery.error : null;
  const refetch = activeOrdersQuery.refetch;

  const rows: OrderRow[] = useMemo(() => {
    if (!data?.items) return [];
    return data.items.map((item) => toOrderRow(item, orgId));
  }, [data?.items, orgId]);

  const totalRows = data?.pageInfo?.total ?? 0;
  const totalPages = Math.ceil(totalRows / pageSize);

  // Stale/shared URLs (?p=3 against a shrunken dataset) snap back to the
  // last real page once the query settles, instead of stranding an empty
  // "no orders" state with the pager hidden.
  usePageClamp({
    page,
    totalPages,
    isFetching: canQueryOrders ? activeOrdersQuery.isFetching : false,
    setPage,
  });

  // ── CSV export ───────────────────────────────────────────────────────────
  const utils = trpc.useUtils();
  const [exporting, setExporting] = useState(false);

  const csvColumns: CsvColumnDef<OrderRow>[] = useMemo(
    () => [
      { header: "Order ID", value: (r) => r.id },
      { header: "Date", value: (r) => r.occurredAt.toISOString() },
      { header: "Buyer Name", value: (r) => r.buyerName },
      { header: "Buyer Email", value: (r) => r.buyerEmail },
      { header: "Event", value: (r) => r.eventTitle },
      { header: "Gross (cents)", value: (r) => r.amountGrossCents },
      { header: "Platform Fee (cents)", value: (r) => r.feesPlatformCents },
      { header: "Tax (cents)", value: (r) => r.taxAmountCents },
      { header: "Currency", value: (r) => r.currency },
      { header: "Status", value: (r) => r.status },
      { header: "Source", value: (r) => r.source },
      { header: "Stripe PI", value: (r) => r.stripePaymentIntentId },
    ],
    [],
  );

  const handleExportCsv = useCallback(async () => {
    if (!canQueryOrders || exporting) return;
    setExporting(true);
    try {
      const allRows = await fetchAllPages<OrderRow>(
        async ({ limit, offset }) => {
          const baseInput = {
            searchQuery: debouncedSearch || undefined,
            status: statusFilter,
            sort: serverSort,
            limit,
            offset,
          };

          const result =
            isOrgOwner && orgId
              ? await utils.orders.listOrgOrders.fetch({ orgId, ...baseInput })
              : await utils.orders.listMyEventOrders.fetch(baseInput);

          return {
            ...result,
            items: result.items.map((item) => toOrderRow(item, orgId)),
          };
        },
      );

      const csv = rowsToCsv(allRows, csvColumns);
      const dateStr = new Date().toISOString().slice(0, 10);
      downloadCsv(csv, `orders-${dateStr}.csv`);
    } catch (err) {
      console.error("[OrdersTable] CSV export failed", err);
    } finally {
      setExporting(false);
    }
  }, [
    canQueryOrders,
    exporting,
    isOrgOwner,
    orgId,
    utils,
    debouncedSearch,
    statusFilter,
    serverSort,
    csvColumns,
  ]);

  // ── Background export (for large datasets) ──────────────────────────────
  const requestExportMutation = trpc.orders.requestExport.useMutation({
    onSuccess: () => {
      toast.success(String(t("admin.atExportBackgroundQueued")));
    },
    onError: () => {
      toast.danger(String(t("admin.atExportBackgroundFailed")));
    },
  });

  const handleBackgroundExport = useCallback(() => {
    if (!canUseOrgOrderActions || !orgId || requestExportMutation.isPending)
      return;
    requestExportMutation.mutate({
      orgId,
      exportType: "org_orders",
      filters: {
        searchQuery: debouncedSearch || undefined,
        status: statusFilter,
        sort: serverSort,
      },
    });
  }, [
    canUseOrgOrderActions,
    orgId,
    requestExportMutation,
    debouncedSearch,
    statusFilter,
    serverSort,
  ]);

  // ── Summary stats ────────────────────────────────────────────────────────
  const summaryLabel = useMemo(() => {
    if (!data?.pageInfo) return undefined;
    const start = page * pageSize + 1;
    const end = Math.min((page + 1) * pageSize, totalRows);
    if (totalRows === 0) return String(t("admin.noOrders"));
    return String(t("admin.nOfTotal", { start, end, total: totalRows }));
  }, [data?.pageInfo, page, pageSize, totalRows, t]);

  // ── Columns ──────────────────────────────────────────────────────────────
  const columns: DataTableColumn<OrderRow>[] = useMemo(
    () => [
      {
        id: "occurredAt",
        header: String(t("admin.date")),
        width: 3,
        noWrap: true,
        sortValue: (row: OrderRow) => row.occurredAt,
        cell: (row) => (
          <Text variant="body" tone="default">
            {fmtDateCompact(fmt, row.occurredAt)}
          </Text>
        ),
      },
      {
        id: "buyerName",
        header: String(t("admin.buyer")),
        // 2.4 (was 2.5): ceded to the status column so "PARTIAL REFUND"
        // fits unclipped — this column truncates gracefully (ellipsis).
        width: 2.4,
        sortValue: (row: OrderRow) => row.buyerName,
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
            {/* DT_CELL_SUB_CLASS: the secondary line collapses away at
                density="compact" — that collapse is what makes the density
                toggle actually change row height, not just cell padding. */}
            {row.buyerEmail && (
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
                {row.buyerEmail}
              </Text>
            )}
          </YStack>
        ),
      },
      {
        id: "eventTitle",
        header: String(t("admin.event")),
        // 2.4 (was 2.5): ceded to the status column (see buyerName).
        width: 2.4,
        sortValue: (row: OrderRow) => row.eventTitle,
        tooltipValue: (row: OrderRow) => row.eventTitle,
        cell: (row) => (
          <Text
            variant="body"
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {row.eventTitle}
          </Text>
        ),
      },
      {
        id: "amountGrossCents",
        header: String(t("admin.amount")),
        width: 1.5,
        sortValue: (row: OrderRow) => row.amountGrossCents,
        cell: (row) => (
          <Text variant="body" weight="bold">
            {fmtCurrency(fmt, row.amountGrossCents, row.currency)}
          </Text>
        ),
      },
      {
        id: "feesPlatformCents",
        header: String(t("admin.platformFee")),
        width: 1.5,
        sortValue: (row: OrderRow) => row.feesPlatformCents,
        cell: (row) => (
          <Text variant="caption" tone="muted">
            {fmtCurrency(fmt, row.feesPlatformCents, row.currency)}
          </Text>
        ),
      },
      {
        id: "taxAmountCents",
        header: String(t("admin.tax")),
        width: 1.5,
        sortValue: (row: OrderRow) => row.taxAmountCents,
        cell: (row) => (
          <Text variant="caption" tone="muted">
            {row.taxAmountCents > 0
              ? fmtCurrency(fmt, row.taxAmountCents, row.currency)
              : "—"}
          </Text>
        ),
      },
      {
        id: "status",
        header: String(t("admin.status")),
        // 2.4 (was 1.5): at 1.5 the cell content box (~84px at 1440w) hard-
        // clipped the widest badges ("SUCCEEDED" needs ~100px, "PARTIAL
        // REFUND" ~133px). New weights sum ≈ 15.5 → ~71px/unit at a 1103px
        // table → 2.4 ≈ 171px td ≈ 143px content ≥ 133px, with slack.
        width: 2.4,
        noWrap: true,
        truncate: false,
        // The XStack wrapper makes the td a flex context so the badge
        // shrink-wraps its label (alignSelf/pill look) and, when a future
        // narrow viewport squeezes the column, shrinks with an ellipsis
        // instead of silently slicing glyphs.
        cell: (row) => (
          <XStack minWidth={0}>
            <OrderStatusBadge
              status={row.status}
              disputeStatus={row.disputeStatus}
            />
          </XStack>
        ),
      },
    ],
    [t, fmt],
  );

  const { isVisible: isColumnVisible } = colVis;
  const visibleColumns = useMemo(
    () => columns.filter((c) => isColumnVisible(c.id)),
    [columns, isColumnVisible],
  );

  // ── Mobile card (DataTable card mode, <600px) ────────────────────────────
  // Card mode does not render rowActions. For org owners the row press
  // expands OrderDetailPanel (which carries the Stripe link), so every
  // action stays reachable. Human owners have no expanded panel — surface
  // the Stripe link directly on the card when a payment intent exists.
  const renderMobileCard = useCallback(
    (row: OrderRow) => (
      <YStack gap="$2" minWidth={0}>
        <XStack gap="$2" alignItems="center" minWidth={0}>
          <Text
            variant="bodySmall"
            weight="bold"
            tone={row.buyerName ? "default" : "muted"}
            flex={1}
            minWidth={0}
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {row.buyerName || String(t("admin.unknownBuyer"))}
          </Text>
          <XStack flexShrink={0}>
            <OrderStatusBadge
              status={row.status}
              disputeStatus={row.disputeStatus}
            />
          </XStack>
        </XStack>
        <Text
          variant="caption"
          tone="muted"
          minWidth={0}
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {row.eventTitle}
        </Text>
        <XStack gap="$2" alignItems="center" flexWrap="wrap">
          <Text variant="caption" tone="muted">
            {fmtDateCompact(fmt, row.occurredAt)}
          </Text>
          <Text variant="caption" tone="muted" aria-hidden>
            ·
          </Text>
          <Text variant="bodySmall" weight="bold">
            {fmtCurrency(fmt, row.amountGrossCents, row.currency)}
          </Text>
        </XStack>
        {!canUseOrgOrderActions && row.stripePaymentIntentId ? (
          <a
            href={`https://dashboard.stripe.com/payments/${row.stripePaymentIntentId}`}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            style={{ textDecoration: "none", alignSelf: "flex-start" }}
          >
            <XStack gap="$2" alignItems="center" minHeight={44}>
              <ExternalLink size={12} style={{ opacity: 0.7 }} />
              <Text variant="caption" weight="bold" tone="accent">
                {String(t("admin.viewInStripe"))}
              </Text>
            </XStack>
          </a>
        ) : null}
      </YStack>
    ),
    [canUseOrgOrderActions, fmt, t],
  );

  // ── Export guard ─────────────────────────────────────────────────────────
  const exportGuard = getExportGuardStatus(totalRows);

  // ── Expand helpers ───────────────────────────────────────────────────
  const toggleExpandOrder = useCallback((id: string) => {
    setExpandedOrderIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // ── Row actions ──────────────────────────────────────────────────────────
  const rowActions = useMemo(
    () => ({
      header: "",
      width: 0.8,
      render: (row: OrderRow) => {
        const items: RowActionMenuItem[] = [];

        if (canUseOrgOrderActions) {
          items.push({
            key: "expand",
            label: expandedOrderIds.has(row.id)
              ? String(t("admin.collapseDetails"))
              : String(t("admin.expandDetails")),
            icon: expandedOrderIds.has(row.id) ? (
              <ChevronDown size={14} />
            ) : (
              <ChevronRight size={14} />
            ),
            onPress: () => toggleExpandOrder(row.id),
          });
        }

        if (row.stripePaymentIntentId) {
          items.push({
            key: "stripe",
            label: String(t("admin.viewInStripe")),
            icon: <ExternalLink size={14} />,
            onPress: () => {
              window.open(
                `https://dashboard.stripe.com/payments/${row.stripePaymentIntentId}`,
                "_blank",
              );
            },
          });
        }

        return (
          <XStack justifyContent="flex-end">
            <RowActionMenu
              items={items}
              ariaLabel={`Actions for order ${row.id}`}
            />
          </XStack>
        );
      },
    }),
    [canUseOrgOrderActions, expandedOrderIds, toggleExpandOrder, t],
  );

  const handleRowPress = useCallback(
    (row: OrderRow) => {
      toggleExpandOrder(row.id);
    },
    [toggleExpandOrder],
  );

  const clearFilters = useCallback(() => {
    handleSearchChange("");
    setStatusFilter(undefined);
    setPage(0);
  }, [handleSearchChange, setPage]);

  const hasActiveFilters = Boolean(debouncedSearch) || Boolean(statusFilter);

  // ── Loading / error states ───────────────────────────────────────────────
  if (ownerLoading || (isLoading && !data)) {
    return (
      <AdminPageData
        isLoading
        loadingMessage={String(t("admin.loadingOrders"))}
      >
        {null}
      </AdminPageData>
    );
  }

  if (!canQueryOrders) {
    return (
      <YStack
        padding="$6"
        alignItems="center"
        justifyContent="center"
        minHeight={300}
        gap="$3"
      >
        <Text variant="h4" weight="bold">
          {String(t("admin.ordersUnavailable"))}
        </Text>
        <Text variant="body" tone="muted" textAlign="center" maxWidth={400}>
          {String(t("admin.ordersUnavailableDescription"))}
        </Text>
      </YStack>
    );
  }

  if (error) {
    return (
      <YStack padding="$4" gap="$3">
        <Text variant="body" tone="error">
          {String(
            t("admin.failedToLoadOrders", { error: formatErrorMessage(error) }),
          )}
        </Text>
        <Button
          variant="secondary"
          size="$2"
          onPress={() => {
            void refetch();
          }}
        >
          {String(t("admin.retry"))}
        </Button>
      </YStack>
    );
  }

  /**
   * CSV export, in two shapes: a queued background job once the row count
   * crosses the guard, an inline download below it. Finance-only — the server
   * enforces the same set, so a visible-but-403 button would be a worse answer
   * than no button.
   */
  const exportAction = canFinance ? (
    exportGuard === "background" && canUseOrgOrderActions ? (
      <Button
        variant="secondary"
        size="$3"
        onPress={handleBackgroundExport}
        disabled={requestExportMutation.isPending || totalRows === 0}
      >
        <Download size={16} />
        {requestExportMutation.isPending
          ? String(t("admin.atExporting"))
          : String(t("admin.atExportBackground", { total: totalRows }))}
      </Button>
    ) : (
      <Button
        variant="secondary"
        size="$3"
        onPress={() => {
          void handleExportCsv();
        }}
        disabled={exporting || totalRows === 0}
      >
        <Download size={16} />
        {exporting
          ? String(t("admin.atExporting"))
          : exportGuard !== "ok"
            ? String(t("admin.atExportLargeWarning", { total: totalRows }))
            : totalRows > 0
              ? String(t("admin.atExportAll", { total: totalRows }))
              : String(t("admin.atExportCsv"))}
      </Button>
    )
  ) : null;

  return (
    <YStack
      gap="$4"
      flex={1}
      padding="$4"
      maxWidth={1440}
      marginHorizontal="auto"
      width="100%"
    >
      {/* Header. Export is the page's one page-level action, so it sits in the
          trailing slot beside the title like Payments' and Team's do — not
          buried in the table toolbar next to Density and Columns, which is
          where the retired action bar's presence left it. */}
      <AdminPageHeader
        title={String(t("admin.orders"))}
        section="orders"
        trailing={exportAction}
      />

      {/* Filters row */}
      <FilterRow hasActiveFilters={hasActiveFilters} onClearAll={clearFilters}>
        <SearchBar
          value={searchQuery}
          onChangeText={handleSearchChange}
          placeholder={String(t("admin.searchBuyerPlaceholder"))}
          testId="admin-orders-search"
        />
        <FilterChips
          options={statusOptions}
          selected={statusFilter}
          onSelect={(val) => {
            setStatusFilter(val);
            setPage(0);
          }}
        />
      </FilterRow>

      {/* Table — the 640px table floor drops only below useIsMobile's 600px
          breakpoint, the same breakpoint DataTable uses for card mode, so the
          page never overflows horizontally on phones and there is no
          floorless band (Tamagui's $gtSm media query starts at 641px). */}
      <YStack flex={1} minWidth={isMobile ? 0 : 640}>
        <ActionBar
          onRefresh={() => {
            void refetch();
          }}
          countLabel={summaryLabel}
        >
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

        <TableContainer>
          <DataTable
            columns={visibleColumns}
            rows={rows}
            getRowKey={(row) => row.id}
            isLoading={isLoading}
            clientSort
            density={density}
            onRowPress={canUseOrgOrderActions ? handleRowPress : undefined}
            rowActions={rowActions}
            renderMobileCard={renderMobileCard}
            testIdBase="orders-table"
            renderExpandedRow={(row) =>
              expandedOrderIds.has(row.id) && canUseOrgOrderActions && orgId ? (
                <OrderDetailPanel
                  orderId={row.id}
                  orgId={orgId}
                  canFinance={canFinance}
                  // Owner/Admin/Finance (ORG_FINANCE_ROLES): every role
                  // that reads Orders may refund cash. Editors refund from
                  // Sell.
                  canRefundCash={canFinance}
                  onClose={() => {
                    setExpandedOrderIds((prev) => {
                      const next = new Set(prev);
                      next.delete(row.id);
                      return next;
                    });
                  }}
                  onRefundSuccess={() => {
                    void refetch();
                  }}
                />
              ) : null
            }
            emptyState={
              <NoResults
                title={
                  hasActiveFilters
                    ? String(t("admin.noMatchingOrders"))
                    : String(t("admin.noOrdersYetTable"))
                }
                description={
                  hasActiveFilters
                    ? String(t("admin.noMatchingOrdersDescription"))
                    : String(t("admin.noOrdersYetTableDescription"))
                }
                onClearFilters={hasActiveFilters ? clearFilters : undefined}
              />
            }
          />
        </TableContainer>

        <Pagination
          page={page}
          totalPages={totalPages}
          onPageChange={setPage}
          pageSize={pageSize}
          onPageSizeChange={setPageSize}
          total={totalRows}
        />
      </YStack>
    </YStack>
  );
}
