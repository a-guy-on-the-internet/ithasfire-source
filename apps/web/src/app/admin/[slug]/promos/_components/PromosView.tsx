"use client";

import { useCallback, useMemo, useState } from "react";
import { ConfirmDialog } from "@/components/data-table/ConfirmDialog";
import { useParams } from "next/navigation";
import { YStack, XStack } from "tamagui";
import {
  DataTable,
  type DataTableColumn,
  Button,
  Text,
  Badge,
  Spinner,
  useTranslations,
  useFormatters,
  useNotify,
} from "@th/ui";
import {
  Plus,
  Tag,
  Percent,
  DollarSign,
  Archive,
  Pencil,
  Share2,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import {
  RowActionMenu,
  type RowActionMenuItem,
} from "@/components/data-table/RowActionMenu";
import { keepPreviousData } from "@tanstack/react-query";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";
import { useCurrentAdminOwner } from "@/hooks/useCurrentAdminOwner";
import { useAdminOwnerCapabilities } from "@/hooks/useAdminOwnerCapabilities";
import {
  ActionBar,
  TableContainer,
  SearchBar,
  Pagination,
  NoResults,
  FilterChips,
  FilterRow,
  ColumnSelector,
  type ColumnOption,
} from "@/components/AdminTableParts";
import { useAdminTableParams } from "@/hooks/useAdminTableParams";
import { useColumnVisibility } from "@/hooks/useColumnVisibility";
import { PromoFormDialog } from "./PromoFormDialog";
import { ShareEventDialog } from "../../events/_components/ShareEventDialog";
import { AdminPageHeader } from "../../_components/AdminPageHeader";
import { AdminPageData } from "@/app/admin/_components/AdminPageData";
import { fmtDate, fmtCurrency } from "@/lib/format";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface PromoRow {
  id: string;
  code: string;
  kind: "PERCENT" | "AMOUNT";
  value: number;
  scope: string;
  scopeId: string | null;
  status: string;
  startsAt: Date | null;
  endsAt: Date | null;
  maxRedemptions: number | null;
  totalRedemptions: number;
  stackable: boolean;
  isPublic: boolean;
  currency: string;
  minOrderCents: number;
  maxDiscountCents: number | null;
  createdAt: Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function formatPromoValue(
  kind: "PERCENT" | "AMOUNT",
  value: number,
  currency: string,
  fmt: ReturnType<typeof useFormatters>,
): string {
  if (kind === "PERCENT") return `${value}%`;
  return fmtCurrency(fmt, value, currency);
}

function promoExpiry(
  row: PromoRow,
  t: ReturnType<typeof useTranslations>,
  fmt: ReturnType<typeof useFormatters>,
): string {
  if (!row.endsAt) return String(t("admin.cpNoExpiry"));
  const now = new Date();
  if (row.endsAt < now) return String(t("admin.cpExpired"));
  return fmt.dateTime(row.endsAt, { dateStyle: "medium" });
}

type StatusFilter = "ALL" | "ACTIVE" | "ARCHIVED";

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export const PromosView = () => {
  const { slug } = useParams<{ slug: string }>();
  const { currentOwner, isLoading: isOwnerLoading } =
    useCurrentAdminOwner(slug);
  // Promo create/edit/revoke all server-enforce ORG_FINANCE_ROLES
  // (create-promo/update-promo/revoke-promo). Gate every write affordance
  // behind canFinance; the list + detail read paths stay open.
  const { canFinance } = useAdminOwnerCapabilities(currentOwner);
  const t = useTranslations();
  const fmt = useFormatters();
  const { toast } = useNotify();

  const [formOpen, setFormOpen] = useState(false);
  const [editingPromo, setEditingPromo] = useState<PromoRow | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<PromoRow | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("ALL");

  const {
    searchQuery,
    debouncedSearch,
    page,
    pageSize,
    handleSearchChange,
    setPage,
    setPageSize,
  } = useAdminTableParams();

  const ALL_COL_IDS = [
    "code",
    "kind",
    "value",
    "status",
    "redemptions",
    "expiry",
    "createdAt",
  ] as const;

  const columnOptions: ColumnOption[] = useMemo(
    () => [
      { id: "code", label: String(t("admin.cpCodeColumn")) },
      { id: "kind", label: String(t("admin.cpTypeColumn")) },
      { id: "value", label: String(t("admin.cpValueColumn")) },
      { id: "status", label: String(t("admin.cpStatusColumn")) },
      { id: "redemptions", label: String(t("admin.cpRedemptionsColumn")) },
      { id: "expiry", label: String(t("admin.cpExpiryColumn")) },
      { id: "createdAt", label: String(t("admin.createdColumn")) },
    ],
    [t],
  );

  const colVis = useColumnVisibility("admin-promos-columns", ALL_COL_IDS);

  // ── Data ──────────────────────────────────────────────────────────────
  const ownerType =
    currentOwner?.kind === "org"
      ? ("ORGANIZATION" as const)
      : ("HUMAN" as const);
  const ownerId =
    currentOwner?.kind === "org"
      ? currentOwner.orgId
      : currentOwner?.kind === "human"
        ? currentOwner.humanId
        : undefined;
  const utils = trpc.useUtils();

  const { data, isLoading, error, refetch } = trpc.promos.list.useQuery(
    {
      ownerType,
      ownerId: ownerId!,
      status: statusFilter === "ALL" ? undefined : statusFilter,
      limit: 200,
    },
    {
      enabled: !!ownerId,
      staleTime: 30_000,
      placeholderData: keepPreviousData,
    },
  );

  const revokeMutation = trpc.promos.revoke.useMutation({
    onSuccess: () => {
      toast.success(String(t("admin.cpRevoked")));
      utils.promos.list.invalidate();
    },
    onError: (err) => toast.danger(formatErrorMessage(err, t)),
  });

  // ── Row mapping ───────────────────────────────────────────────────────
  const allRows = useMemo<PromoRow[]>(
    () =>
      (data?.items ?? []).map((item) => ({
        id: item.id,
        code: item.code,
        kind: item.kind,
        value: item.value,
        currency: item.currency ?? "usd",
        scope: item.scope,
        scopeId: item.scopeId ?? null,
        status: item.status,
        startsAt: item.startsAt ? new Date(item.startsAt) : null,
        endsAt: item.endsAt ? new Date(item.endsAt) : null,
        maxRedemptions: item.maxRedemptions ?? null,
        totalRedemptions: item.totalRedemptions,
        stackable: item.stackable,
        isPublic: item.isPublic,
        minOrderCents: item.minOrderCents,
        maxDiscountCents: item.maxDiscountCents ?? null,
        createdAt: new Date(item.createdAt),
      })),
    [data],
  );

  // Client-side search
  const filteredRows = useMemo(() => {
    if (!debouncedSearch) return allRows;
    const q = debouncedSearch.toLowerCase();
    return allRows.filter((r) => r.code.toLowerCase().includes(q));
  }, [allRows, debouncedSearch]);

  // Client-side pagination (0-based page index)
  const totalRows = filteredRows.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
  const pagedRows = useMemo(
    () => filteredRows.slice(page * pageSize, (page + 1) * pageSize),
    [filteredRows, page, pageSize],
  );

  // ── Columns ───────────────────────────────────────────────────────────
  const columns: DataTableColumn<PromoRow>[] = useMemo(
    () => [
      {
        id: "code",
        header: String(t("admin.cpCodeColumn")),
        width: 2,
        sortValue: (row: PromoRow) => row.code,
        searchValue: (row: PromoRow) => row.code,
        cell: (row) => (
          <XStack alignItems="center" gap="$2">
            <Tag size={14} color="var(--colorMuted)" />
            <Text variant="body" weight="bold" fontFamily="$mono">
              {row.code}
            </Text>
          </XStack>
        ),
      },
      {
        id: "kind",
        header: String(t("admin.cpTypeColumn")),
        width: 1,
        cell: (row) => (
          <XStack alignItems="center" gap="$1">
            {row.kind === "PERCENT" ? (
              <Percent size={14} color="var(--colorMuted)" />
            ) : (
              <DollarSign size={14} color="var(--colorMuted)" />
            )}
            <Text variant="caption">
              {row.kind === "PERCENT"
                ? String(t("admin.cpPercent"))
                : String(t("admin.cpFixed"))}
            </Text>
          </XStack>
        ),
      },
      {
        id: "value",
        header: String(t("admin.cpValueColumn")),
        width: 1.2,
        sortValue: (row: PromoRow) => row.value,
        cell: (row) => (
          <Text variant="body" weight="bold">
            {formatPromoValue(row.kind, row.value, row.currency, fmt)}
          </Text>
        ),
      },
      {
        id: "status",
        header: String(t("admin.cpStatusColumn")),
        width: 1.2,
        cell: (row) => {
          const isExpired = row.endsAt && row.endsAt < new Date();
          const label =
            row.status === "ARCHIVED"
              ? String(t("admin.cpArchived"))
              : isExpired
                ? String(t("admin.cpExpired"))
                : String(t("admin.cpActive"));
          const tone: "neutral" | "warning" | "success" =
            row.status === "ARCHIVED"
              ? "neutral"
              : isExpired
                ? "warning"
                : "success";
          return (
            <Badge tone={tone} size="sm">
              {label}
            </Badge>
          );
        },
      },
      {
        id: "redemptions",
        header: String(t("admin.cpRedemptionsColumn")),
        width: 1.4,
        sortValue: (row: PromoRow) => row.totalRedemptions,
        cell: (row) => (
          <YStack gap="$1">
            <Text variant="body" style={{ fontVariantNumeric: "tabular-nums" }}>
              {row.totalRedemptions}
              {row.maxRedemptions != null ? ` / ${row.maxRedemptions}` : ""}
            </Text>
            {row.maxRedemptions != null && row.maxRedemptions > 0 && (
              <div
                style={{
                  height: 3,
                  borderRadius: 0,
                  // --borderMuted never existed (track rendered transparent);
                  // borderColorSoft is the soft hairline token it wanted.
                  backgroundColor: "var(--borderColorSoft)",
                  overflow: "hidden",
                  maxWidth: 80,
                }}
              >
                <div
                  style={{
                    height: "100%",
                    borderRadius: 0,
                    backgroundColor:
                      row.totalRedemptions >= row.maxRedemptions
                        ? "var(--danger)"
                        : "var(--success)",
                    width: `${Math.min(100, (row.totalRedemptions / row.maxRedemptions) * 100)}%`,
                    transition: "width 0.2s ease",
                  }}
                />
              </div>
            )}
          </YStack>
        ),
      },
      {
        id: "expiry",
        header: String(t("admin.cpExpiryColumn")),
        width: 1.6,
        noWrap: true,
        sortValue: (row: PromoRow) => row.endsAt,
        cell: (row) => (
          <Text
            variant="caption"
            tone={row.endsAt && row.endsAt < new Date() ? undefined : "muted"}
            color={row.endsAt && row.endsAt < new Date() ? "$red10" : undefined}
          >
            {promoExpiry(row, t, fmt)}
          </Text>
        ),
      },
      {
        id: "createdAt",
        header: String(t("admin.createdColumn")),
        width: 1.6,
        noWrap: true,
        sortValue: (row: PromoRow) => row.createdAt,
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

  // ── Detail expansion (multi) ──────────────────────────────────────────
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const toggleExpand = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // ── Share with event ──────────────────────────────────────────────────
  const [shareTarget, setShareTarget] = useState<PromoRow | null>(null);
  const handleShare = useCallback((row: PromoRow) => {
    setShareTarget(row);
  }, []);

  // Pull org's published events for the share-with-event picker. Only
  // fetched when the share dialog is open so we don't load this on every
  // promos-page render.
  const shareEventsQuery = trpc.events.listMine.useQuery(
    {
      ownerType,
      ownerId: ownerId!,
      status: ["PUBLISHED"],
      limit: 200,
      offset: 0,
    },
    {
      enabled: !!ownerId && !!shareTarget,
      staleTime: 60_000,
      placeholderData: keepPreviousData,
    },
  );

  // ── Row actions ───────────────────────────────────────────────────────
  const handleEdit = useCallback((row: PromoRow) => {
    setEditingPromo(row);
    setFormOpen(true);
  }, []);

  const handleRevoke = useCallback(
    (row: PromoRow) => {
      if (!ownerId) return;
      setRevokeTarget(row);
    },
    [ownerId],
  );

  const confirmRevoke = useCallback(() => {
    if (!revokeTarget || !ownerId) return;
    revokeMutation.mutate(
      { ownerType, ownerId, promoId: revokeTarget.id },
      { onSettled: () => setRevokeTarget(null) },
    );
  }, [revokeTarget, ownerType, ownerId, revokeMutation]);

  const handleCreate = useCallback(() => {
    setEditingPromo(null);
    setFormOpen(true);
  }, []);

  const handleFormSuccess = useCallback(() => {
    setFormOpen(false);
    setEditingPromo(null);
    refetch();
  }, [refetch]);

  const rowActions = useMemo(
    () => ({
      header: "",
      width: 0.8,
      render: (row: PromoRow) => {
        const items: RowActionMenuItem[] = [
          {
            key: "expand",
            label: expandedIds.has(row.id)
              ? String(t("admin.collapseDetails"))
              : String(t("admin.expandDetails")),
            icon: expandedIds.has(row.id) ? (
              <ChevronDown size={14} />
            ) : (
              <ChevronRight size={14} />
            ),
            onPress: () => toggleExpand(row.id),
          },
          // Edit + revoke server-enforce ORG_FINANCE_ROLES — only surface them
          // to finance actors. Share-with-event stays visible to everyone who
          // can reach the page (out of this sweep's scope).
          ...(row.status === "ACTIVE"
            ? [
                ...(canFinance
                  ? [
                      {
                        key: "edit",
                        label: String(t("admin.cpEdit")),
                        icon: <Pencil size={14} />,
                        onPress: () => handleEdit(row),
                      },
                    ]
                  : []),
                // Share-with-event: only useful for codes that can actually
                // be auto-applied from a URL. Private codes are filtered out
                // because the URL-seed path silently drops them.
                ...(row.isPublic
                  ? [
                      {
                        key: "share",
                        label: String(
                          t("admin.cpShareWithEvent") ?? "Share with event",
                        ),
                        icon: <Share2 size={14} />,
                        onPress: () => handleShare(row),
                      },
                    ]
                  : []),
                ...(canFinance
                  ? [
                      {
                        key: "revoke",
                        label: String(t("admin.cpRevoke")),
                        icon: <Archive size={14} />,
                        tone: "danger" as const,
                        disabled: revokeMutation.isPending,
                        onPress: () => handleRevoke(row),
                      },
                    ]
                  : []),
              ]
            : []),
        ];

        return (
          <XStack justifyContent="flex-end">
            <RowActionMenu
              items={items}
              ariaLabel={`Actions for promo ${row.code}`}
            />
          </XStack>
        );
      },
    }),
    [
      canFinance,
      expandedIds,
      handleEdit,
      handleRevoke,
      handleShare,
      revokeMutation.isPending,
      t,
      toggleExpand,
    ],
  );

  const clearFilters = useCallback(() => {
    handleSearchChange("");
    setStatusFilter("ALL");
    setPage(0);
  }, [handleSearchChange, setPage]);

  const hasActiveFilters = Boolean(debouncedSearch) || statusFilter !== "ALL";

  // ── Summary label ─────────────────────────────────────────────────────
  const summaryLabel = useMemo(() => {
    if (totalRows === 0) return undefined;
    const start = page * pageSize + 1;
    const end = Math.min((page + 1) * pageSize, totalRows);
    return `${start}–${end} of ${totalRows} ${String(t("admin.cpPromosLabel"))}`;
  }, [page, pageSize, totalRows, t]);

  // ── Render ────────────────────────────────────────────────────────────
  if (isOwnerLoading || isLoading) {
    return (
      <AdminPageData
        isLoading
        loadingMessage={String(t("admin.loadingPromos"))}
      >
        {null}
      </AdminPageData>
    );
  }

  if (!ownerId) {
    return (
      <YStack padding="$4">
        <Text variant="body" tone="muted">
          {String(t("admin.noOrgSelected"))}
        </Text>
      </YStack>
    );
  }

  if (error) {
    return (
      <YStack padding="$4" gap="$3">
        <Text variant="body" tone="error">
          {formatErrorMessage(error.message)}
        </Text>
        <Button variant="secondary" size="$2" onPress={() => refetch()}>
          {String(t("admin.retry"))}
        </Button>
      </YStack>
    );
  }

  const statusFilterOptions = [
    { value: "ACTIVE" as const, label: String(t("admin.cpActive")) },
    { value: "ARCHIVED" as const, label: String(t("admin.cpArchived")) },
  ];

  return (
    <YStack
      gap="$4"
      flex={1}
      padding="$4"
      maxWidth={1440}
      marginHorizontal="auto"
      width="100%"
    >
      {/* Header */}
      <AdminPageHeader
        title={String(t("admin.cpPromosTitle"))}
        section="promos"
        trailing={
          canFinance ? (
            <Button variant="primary" size="$3" onPress={handleCreate}>
              <Plus size={16} />
              {String(t("admin.cpCreatePromo"))}
            </Button>
          ) : undefined
        }
      />

      {/* Filters row */}
      <FilterRow hasActiveFilters={hasActiveFilters} onClearAll={clearFilters}>
        <SearchBar
          value={searchQuery}
          onChangeText={handleSearchChange}
          placeholder={String(t("admin.cpSearchPlaceholder"))}
          testId="admin-promos-search"
        />
        <FilterChips
          options={statusFilterOptions}
          selected={statusFilter === "ALL" ? undefined : statusFilter}
          onSelect={(v) => {
            setStatusFilter(v ?? "ALL");
            setPage(0);
          }}
        />
      </FilterRow>

      {/* Table */}
      <YStack flex={1} minWidth={640}>
        <ActionBar onRefresh={() => refetch()} countLabel={summaryLabel}>
          <ColumnSelector
            options={columnOptions}
            isVisible={colVis.isVisible}
            onToggle={colVis.toggleColumn}
            onShowAll={colVis.showAll}
            hasHidden={colVis.hasHidden}
          />
        </ActionBar>

        <TableContainer>
          <DataTable<PromoRow>
            columns={visibleColumns}
            rows={pagedRows}
            getRowKey={(row) => row.id}
            isLoading={isLoading}
            clientSort
            onRowPress={(row) => toggleExpand(row.id)}
            rowActions={rowActions}
            renderExpandedRow={(row) =>
              expandedIds.has(row.id) ? (
                <PromoDetailContent row={row} t={t} fmt={fmt} />
              ) : null
            }
            emptyState={
              hasActiveFilters ? (
                <NoResults
                  title={String(t("admin.cpNoResults"))}
                  description={String(t("admin.cpNoResultsDescription"))}
                  onClearFilters={clearFilters}
                />
              ) : (
                // Swiss-block empty state: thick top rule + section
                // number prefix anchor the page when there are no
                // rows yet, instead of a generic centered message
                // that floats in dead space.
                <YStack
                  padding="$8"
                  alignItems="center"
                  justifyContent="center"
                  gap="$4"
                  maxWidth={420}
                  width="100%"
                  marginHorizontal="auto"
                  borderTopWidth={4}
                  borderTopColor="$borderColorStrong"
                  marginTop="$2"
                >
                  <Text
                    variant="label"
                    tone="muted"
                    style={{
                      textTransform: "uppercase",
                      letterSpacing: "0.12em",
                      fontWeight: 700,
                      fontSize: 11,
                    }}
                  >
                    01 / {String(t("admin.cpEmptyEyebrow") ?? "No promos yet")}
                  </Text>
                  <Text variant="h3" weight="bold" textAlign="center">
                    {String(t("admin.cpEmptyTitle"))}
                  </Text>
                  <Text variant="body" tone="muted" textAlign="center">
                    {String(t("admin.cpEmptyDescription"))}
                  </Text>
                  {canFinance && (
                    <Button
                      variant="secondary"
                      size="$3"
                      onPress={handleCreate}
                    >
                      <Plus size={18} />
                      {String(t("admin.cpCreatePromo"))}
                    </Button>
                  )}
                </YStack>
              )
            }
            testIdBase="promos-table"
          />
        </TableContainer>

        <Pagination
          page={page}
          totalPages={totalPages}
          onPageChange={setPage}
          pageSize={pageSize}
          onPageSizeChange={setPageSize}
        />
      </YStack>

      {formOpen && (
        <PromoFormDialog
          ownerType={ownerType}
          ownerId={ownerId!}
          editingPromo={editingPromo}
          onClose={() => {
            setFormOpen(false);
            setEditingPromo(null);
          }}
          onSuccess={handleFormSuccess}
        />
      )}

      {shareTarget && currentOwner && (
        <ShareEventDialog
          open
          onClose={() => setShareTarget(null)}
          ownerContext={
            currentOwner.kind === "org"
              ? { kind: "org", orgId: currentOwner.orgId }
              : { kind: "human", humanId: currentOwner.humanId }
          }
          fixedPromo={{
            id: shareTarget.id,
            code: shareTarget.code,
            kind: shareTarget.kind,
            value: shareTarget.value,
            scope: shareTarget.scope as
              | "GLOBAL"
              | "ORG"
              | "EVENT"
              | "TICKET_TYPE"
              | "HUMAN",
            scopeId: shareTarget.scopeId,
            isPublic: shareTarget.isPublic,
            status: shareTarget.status,
          }}
          events={(shareEventsQuery.data?.items ?? []).map((e) => ({
            id: e.id,
            title: e.title,
            slug: e.slug,
            status: e.status,
          }))}
        />
      )}

      <ConfirmDialog
        open={!!revokeTarget}
        onConfirm={confirmRevoke}
        onCancel={() => setRevokeTarget(null)}
        title={String(t("admin.cpRevoke"))}
        description={String(
          t("admin.cpRevokeConfirm", { code: revokeTarget?.code ?? "" }),
        )}
        confirmLabel={String(t("admin.cpRevoke"))}
        tone="danger"
        loading={revokeMutation.isPending}
      />
    </YStack>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Inline detail content (shown in expanded row)
// ─────────────────────────────────────────────────────────────────────────────

function PromoDetailContent({
  row,
  t,
  fmt,
}: {
  row: PromoRow;
  t: ReturnType<typeof useTranslations>;
  fmt: ReturnType<typeof useFormatters>;
}) {
  const detailItems: Array<{ label: string; value: string }> = [
    {
      label: String(t("admin.cpTypeLabel")),
      value:
        row.kind === "PERCENT"
          ? String(t("admin.cpPercent"))
          : String(t("admin.cpFixed")),
    },
    {
      label: String(t("admin.cpValueLabel")),
      value: formatPromoValue(row.kind, row.value, row.currency, fmt),
    },
    {
      label: String(t("admin.cpStackable")),
      value: row.stackable ? String(t("common.yes")) : String(t("common.no")),
    },
    {
      label: String(t("admin.cpMinOrder")),
      value:
        row.minOrderCents > 0
          ? fmtCurrency(fmt, row.minOrderCents, row.currency)
          : String(t("common.none")),
    },
    {
      label: String(t("admin.cpMaxDiscount")),
      value:
        row.maxDiscountCents != null
          ? fmtCurrency(fmt, row.maxDiscountCents, row.currency)
          : String(t("admin.cpNoLimit")),
    },
    {
      label: String(t("admin.cpStartsAt")),
      value: row.startsAt
        ? fmt.dateTime(row.startsAt, {
            dateStyle: "medium",
            timeStyle: "short",
          })
        : String(t("admin.cpImmediate")),
    },
    {
      label: String(t("admin.cpEndsAt")),
      value: row.endsAt
        ? fmt.dateTime(row.endsAt, { dateStyle: "medium", timeStyle: "short" })
        : String(t("admin.cpNoExpiry")),
    },
    {
      label: String(t("admin.cpMaxRedemptions")),
      value:
        row.maxRedemptions != null
          ? String(row.maxRedemptions)
          : String(t("admin.cpUnlimited")),
    },
    {
      label: String(t("admin.cpRedemptionsColumn")),
      value: String(row.totalRedemptions),
    },
    {
      label: String(t("admin.createdColumn")),
      value: fmt.dateTime(row.createdAt, {
        dateStyle: "medium",
        timeStyle: "short",
      }),
    },
  ];

  return (
    <div style={{ padding: "12px 24px 16px" }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
          gap: "8px 24px",
        }}
      >
        {detailItems.map((item) => (
          <div key={item.label}>
            <Text variant="overline" tone="muted">
              {item.label}
            </Text>
            <Text variant="body" style={{ marginTop: 2 }}>
              {item.value}
            </Text>
          </div>
        ))}
      </div>
    </div>
  );
}
