"use client";

import { useMemo, useState, useCallback } from "react";
import { useTheme, YStack, XStack } from "tamagui";
import { PlatformContainer } from "../_components/PlatformPageParts";
import {
  DataTable,
  type DataTableColumn,
  type DataTableSortState,
  Button,
  Text,
  TextInput,
} from "@th/ui";
import {
  Ticket,
  Search,
  Filter,
  X,
  RefreshCw,
  Copy,
  ArrowRightLeft,
  ScanLine,
} from "lucide-react";
import { keepPreviousData } from "@tanstack/react-query";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";
import { fmtDate } from "@/lib/format";
import { formatOrderCode } from "@th/types/order-identifier";
import { useTranslations, useFormatters } from "@th/ui";
import { useIsMobile } from "@/hooks/useIsMobile";
import {
  TicketMobileCard,
  TicketStatusBadge,
  type TicketStatus,
} from "./_components/TicketMobileCard";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface PlatformTicketRow {
  id: string;
  code: string;
  status: TicketStatus;
  eventId: string;
  eventTitle: string;
  ticketTypeId: string | null;
  ticketTypeName: string | null;
  orderId: string | null;
  ownerHumanId: string;
  ownerName: string | null;
  ownerEmail: string | null;
  issuedAt: Date;
  scannedAt: Date | null;
  seatLabel: string | null;
  transferCount: number;
  scanCount: number;
}

const STATUS_OPTIONS: { value: TicketStatus; labelKey: string }[] = [
  { value: "VALID", labelKey: "admin.ptStatusValid" },
  { value: "SCANNED", labelKey: "admin.ptStatusScanned" },
  { value: "INVALID", labelKey: "admin.ptStatusInvalid" },
  { value: "REFUNDED", labelKey: "admin.ptStatusRefunded" },
  { value: "LISTED", labelKey: "admin.ptStatusListed" },
];

const PAGE_SIZE = 25;

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export default function PlatformTicketsPage() {
  // ── State ────────────────────────────────────────────────────────────────
  const theme = useTheme();
  const t = useTranslations();
  const fmt = useFormatters();
  const isMobile = useIsMobile();
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<TicketStatus | undefined>(
    undefined,
  );
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState<DataTableSortState>({
    columnId: "issuedAt",
    direction: "desc",
  });
  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(null);

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

  // ── Query ────────────────────────────────────────────────────────────────
  const sortParam = sort.direction === "asc" ? "issuedAt_asc" : "issuedAt_desc";

  const { data, isLoading, error, refetch } =
    trpc.platform.listTickets.useQuery(
      {
        searchQuery: debouncedSearch || undefined,
        status: statusFilter,
        sort: sortParam as "issuedAt_asc" | "issuedAt_desc",
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      },
      {
        staleTime: 30_000,
        placeholderData: keepPreviousData,
      },
    );

  const rows: PlatformTicketRow[] = useMemo(() => {
    if (!data?.items) return [];
    return data.items.map((item) => ({
      ...item,
      issuedAt: new Date(item.issuedAt),
      scannedAt: item.scannedAt ? new Date(item.scannedAt) : null,
    }));
  }, [data?.items]);

  const totalRows = data?.pageInfo?.total ?? 0;
  const totalPages = Math.ceil(totalRows / PAGE_SIZE);

  const summaryLabel = useMemo(() => {
    if (!data?.pageInfo) return undefined;
    const start = page * PAGE_SIZE + 1;
    const end = Math.min((page + 1) * PAGE_SIZE, totalRows);
    if (totalRows === 0) return String(t("admin.ptSummaryEmpty"));
    return String(t("admin.ptSummary", { start, end, total: totalRows }));
  }, [data?.pageInfo, page, totalRows, t]);

  // ── Columns ──────────────────────────────────────────────────────────────
  const columns: DataTableColumn<PlatformTicketRow>[] = useMemo(
    () => [
      {
        id: "code",
        header: String(t("admin.ptTicketCode")),
        width: 1.5,
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
            {row.code}
          </Text>
        ),
      },
      {
        id: "status",
        header: String(t("admin.status")),
        width: 1,
        cell: (row) => <TicketStatusBadge status={row.status} />,
      },
      {
        id: "ownerName",
        header: String(t("admin.ptOwner")),
        width: 2,
        cell: (row) => (
          <YStack gap="$1">
            <Text
              variant="body"
              weight="bold"
              tone={row.ownerName ? "default" : "muted"}
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {row.ownerName || String(t("admin.ptUnknownOwner"))}
            </Text>
            {row.ownerEmail && (
              <Text
                variant="caption"
                tone="muted"
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {row.ownerEmail}
              </Text>
            )}
          </YStack>
        ),
      },
      {
        id: "eventTitle",
        header: String(t("admin.ptEvent")),
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
            {row.eventTitle}
          </Text>
        ),
      },
      {
        id: "ticketTypeName",
        header: String(t("admin.ptTicketType")),
        width: 1.5,
        cell: (row) => (
          <Text
            variant="body"
            tone={row.ticketTypeName ? "default" : "muted"}
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {row.ticketTypeName || "\u2014"}
          </Text>
        ),
      },
      {
        id: "orderId",
        header: String(t("admin.ptOrder")),
        width: 1.2,
        cell: (row) => (
          <Text
            variant="body"
            tone={row.orderId ? "default" : "muted"}
            style={{
              fontSize: 12,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {/* The ONE order code (8-hex TAIL), not `truncateId`'s HEAD \u2014 the
                head is also 8 hex chars, so it passes admin search's identifier
                shape and then matches nothing. Bare: the "Order" header labels
                the column. */}
            {row.orderId ? formatOrderCode(row.orderId) : "\u2014"}
          </Text>
        ),
      },
      {
        id: "issuedAt",
        header: String(t("admin.ptIssuedAt")),
        width: 1.6,
        cell: (row) => (
          <Text variant="body" tone="default">
            {fmtDate(fmt, row.issuedAt)}
          </Text>
        ),
      },
      {
        id: "scannedAt",
        header: String(t("admin.ptScannedAt")),
        width: 1.6,
        cell: (row) => (
          <Text variant="body" tone={row.scannedAt ? "default" : "muted"}>
            {fmtDate(fmt, row.scannedAt)}
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
      width: 0.8,
      render: (row: PlatformTicketRow) => (
        <XStack gap="$1" justifyContent="flex-end">
          {row.transferCount > 0 && (
            <XStack gap="$1" alignItems="center" opacity={0.5}>
              <ArrowRightLeft size={12} />
              <Text variant="caption">{row.transferCount}</Text>
            </XStack>
          )}
          {row.scanCount > 0 && (
            <XStack gap="$1" alignItems="center" opacity={0.5}>
              <ScanLine size={12} />
              <Text variant="caption">{row.scanCount}</Text>
            </XStack>
          )}
        </XStack>
      ),
    }),
    [],
  );

  // ── Filter handlers ──────────────────────────────────────────────────────
  const handleStatusToggle = useCallback((status: TicketStatus) => {
    setStatusFilter((prev) => (prev === status ? undefined : status));
    setPage(0);
  }, []);

  const clearFilters = useCallback(() => {
    setSearchQuery("");
    setDebouncedSearch("");
    setStatusFilter(undefined);
    setPage(0);
  }, []);

  const hasActiveFilters = Boolean(debouncedSearch) || Boolean(statusFilter);

  // ── Error state ──────────────────────────────────────────────────────────
  if (error) {
    return (
      <PlatformContainer>
        <YStack gap="$3">
          <Text variant="body" tone="error">
            {String(
              t("admin.ptFailedToLoadTickets", {
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
    <PlatformContainer>
      {/* Header */}
      <YStack gap={8}>
        <XStack gap={8} alignItems="center">
          <Ticket size={20} color={theme.color?.val} />
          <Text variant="h2" tag="h1" weight="bold">
            {String(t("admin.ptTitle"))}
          </Text>
        </XStack>
        <Text variant="body" tone="muted">
          {String(t("admin.ptSubtitle"))}
        </Text>
      </YStack>

      {/* Filters */}
      <YStack gap="$3">
        <XStack gap="$3" flexWrap="wrap" alignItems="center">
          <XStack alignItems="center" gap="$2" flex={1} maxWidth={340}>
            <Search size={16} color={theme.colorMuted?.val} />
            <TextInput
              flex={1}
              value={searchQuery}
              onChangeText={handleSearchChange}
              placeholder={t("admin.ptSearchPlaceholder") as string}
            />
          </XStack>

          {hasActiveFilters && (
            <Button variant="ghost" size="$2" onPress={clearFilters}>
              <X size={14} aria-hidden />
              {String(t("admin.ptClear"))}
            </Button>
          )}
        </XStack>

        {/* Status chips */}
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
      </YStack>

      {/* Action bar */}
      <XStack paddingHorizontal="$1" paddingVertical="$2" alignItems="center">
        <Button
          variant="ghost"
          size="$2"
          onPress={() => refetch()}
          aria-label={t("admin.ptRefresh") as string}
          paddingHorizontal="$3"
        >
          <RefreshCw size={14} aria-hidden />
          {String(t("admin.ptRefresh"))}
        </Button>
        <XStack flex={1} />
        {summaryLabel && (
          <Text variant="caption" tone="muted" paddingHorizontal="$3">
            {summaryLabel}
          </Text>
        )}
      </XStack>

      {/* Table — the 640px table floor drops only below useIsMobile's 600px
          breakpoint, the same breakpoint DataTable uses for card mode, so
          phones get cards with no horizontal pan; the outer overflow XStack
          keeps the scoped sideways scroll for narrow desktop windows. */}
      <XStack overflow="scroll" flex={1}>
        <YStack flex={1} minWidth={isMobile ? 0 : 640}>
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
            onRowPress={(row) =>
              setSelectedTicketId((prev) => (prev === row.id ? null : row.id))
            }
            rowActions={rowActions}
            // Card mode drops rowActions, which here are passive
            // transfer/scan counters — both counts are shown in the
            // PlatformTicketDetail panel that the card press opens, so
            // nothing becomes unreachable on phones.
            renderMobileCard={(row) => <TicketMobileCard row={row} />}
            testIdBase="platform-tickets-table"
            emptyState={
              <YStack
                padding="$8"
                alignItems="center"
                justifyContent="center"
                gap="$3"
              >
                <Ticket size={32} color="var(--colorMuted)" />
                <Text variant="h4" weight="bold">
                  {hasActiveFilters
                    ? String(t("admin.ptNoMatchingTickets"))
                    : String(t("admin.ptNoTicketsYet"))}
                </Text>
                <Text
                  variant="body"
                  tone="muted"
                  textAlign="center"
                  maxWidth={360}
                >
                  {hasActiveFilters
                    ? String(t("admin.ptNoMatchingTicketsDesc"))
                    : String(t("admin.ptNoTicketsYetDesc"))}
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

      {/* Detail panel (selected ticket) */}
      {selectedTicketId && (
        <PlatformTicketDetail
          ticketId={selectedTicketId}
          ticket={rows.find((r) => r.id === selectedTicketId) ?? null}
          onClose={() => setSelectedTicketId(null)}
        />
      )}

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

// ─────────────────────────────────────────────────────────────────────────────
// Inline detail panel
// ─────────────────────────────────────────────────────────────────────────────

function PlatformTicketDetail({
  ticketId,
  ticket,
  onClose,
}: {
  ticketId: string;
  ticket: PlatformTicketRow | null;
  onClose: () => void;
}) {
  const t = useTranslations();
  const fmt = useFormatters();

  return (
    <YStack
      borderWidth={2}
      borderColor="$borderColor"
      borderRadius={0}
      padding="$4"
      gap="$3"
      backgroundColor="$surfaceMuted"
    >
      <XStack justifyContent="space-between" alignItems="center">
        <Text variant="body" weight="bold">
          {String(t("admin.ptTicketDetail"))}
        </Text>
        <Button
          variant="ghost"
          size="$2"
          icon
          onPress={onClose}
          aria-label={t("admin.ptClose") as string}
        >
          <X size={14} />
        </Button>
      </XStack>

      {ticket && (
        <YStack gap="$2">
          <XStack gap="$4" flexWrap="wrap">
            <YStack gap="$1">
              <Text variant="caption" tone="muted">
                {String(t("admin.ptCode"))}
              </Text>
              <Text
                variant="body"
                style={{
                  fontSize: 12,
                  userSelect: "all",
                }}
              >
                {ticket.code}
              </Text>
            </YStack>
            <YStack gap="$1">
              <Text variant="caption" tone="muted">
                {String(t("admin.status"))}
              </Text>
              <TicketStatusBadge status={ticket.status} />
            </YStack>
            <YStack gap="$1">
              <Text variant="caption" tone="muted">
                {String(t("admin.ptOwner"))}
              </Text>
              <Text variant="body">
                {ticket.ownerName || String(t("admin.ptUnknownOwner"))}
              </Text>
              {ticket.ownerEmail && (
                <Text variant="caption" tone="muted">
                  {ticket.ownerEmail}
                </Text>
              )}
            </YStack>
            <YStack gap="$1">
              <Text variant="caption" tone="muted">
                {String(t("admin.ptEvent"))}
              </Text>
              <Text variant="body">{ticket.eventTitle}</Text>
            </YStack>
            <YStack gap="$1">
              <Text variant="caption" tone="muted">
                {String(t("admin.ptTicketType"))}
              </Text>
              <Text variant="body">{ticket.ticketTypeName || "\u2014"}</Text>
            </YStack>
            {ticket.seatLabel && (
              <YStack gap="$1">
                <Text variant="caption" tone="muted">
                  {String(t("admin.ptSeat"))}
                </Text>
                <Text variant="body">{ticket.seatLabel}</Text>
              </YStack>
            )}
          </XStack>

          <XStack gap="$4" flexWrap="wrap">
            <YStack gap="$1">
              <Text variant="caption" tone="muted">
                {String(t("admin.ptIssued"))}
              </Text>
              <Text variant="body">{fmtDate(fmt, ticket.issuedAt)}</Text>
            </YStack>
            <YStack gap="$1">
              <Text variant="caption" tone="muted">
                {String(t("admin.ptScanned"))}
              </Text>
              <Text variant="body">{fmtDate(fmt, ticket.scannedAt)}</Text>
            </YStack>
            <YStack gap="$1">
              <Text variant="caption" tone="muted">
                {String(t("admin.ptTransfers"))}
              </Text>
              <Text variant="body">{ticket.transferCount}</Text>
            </YStack>
            <YStack gap="$1">
              <Text variant="caption" tone="muted">
                {String(t("admin.ptScans"))}
              </Text>
              <Text variant="body">{ticket.scanCount}</Text>
            </YStack>
          </XStack>
        </YStack>
      )}

      <XStack gap="$3" flexWrap="wrap">
        <Button
          variant="secondary"
          size="$2"
          onPress={() => {
            void navigator.clipboard.writeText(ticket?.code ?? ticketId);
          }}
        >
          <Copy size={14} />
          {String(t("admin.ptCopyCode"))}
        </Button>
        {ticket?.orderId && (
          <Button
            variant="secondary"
            size="$2"
            onPress={() => {
              window.location.href = `/platform/orders?search=${ticket.orderId}`;
            }}
          >
            {String(t("admin.ptViewOrder"))}
          </Button>
        )}
      </XStack>

      <Text variant="caption" tone="muted">
        {String(t("admin.ptDetailNotice"))}
      </Text>
    </YStack>
  );
}
