"use client";

import { useMemo, useState } from "react";
import { YStack, XStack } from "tamagui";
import {
  DataTable,
  type DataTableColumn,
  Button,
  Text,
  Badge,
  useTranslations,
  useFormatters,
} from "@th/ui";
import { Tag, Percent, DollarSign, RefreshCw } from "lucide-react";
import { keepPreviousData } from "@tanstack/react-query";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";
import {
  PromoExpiry,
  PromoMobileCard,
  PromoStatusBadge,
  formatPromoValue,
} from "./_components/PromoMobileCard";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface PromoRow {
  id: string;
  code: string;
  kind: "PERCENT" | "AMOUNT";
  value: number;
  currency: string;
  scope: string;
  scopeId: string | null;
  status: string;
  startsAt: Date | null;
  endsAt: Date | null;
  maxRedemptions: number | null;
  totalRedemptions: number;
  stackable: boolean;
  createdAt: Date;
}

type StatusFilter = "ALL" | "ACTIVE" | "ARCHIVED";

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export default function PlatformPromosPage() {
  const t = useTranslations();
  const fmt = useFormatters();

  const [statusFilter, setStatusFilter] = useState<StatusFilter>("ALL");
  const [search, setSearch] = useState("");

  const { data, isLoading, error, refetch } = trpc.platform.listPromos.useQuery(
    {
      status: statusFilter === "ALL" ? undefined : statusFilter,
      limit: 200,
    },
    { staleTime: 30_000, placeholderData: keepPreviousData },
  );

  // ── Row mapping ───────────────────────────────────────────────────
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
        createdAt: new Date(item.createdAt),
      })),
    [data],
  );

  const filteredRows = useMemo(() => {
    if (!search) return allRows;
    const q = search.toLowerCase();
    return allRows.filter(
      (r) =>
        r.code.toLowerCase().includes(q) || r.scope.toLowerCase().includes(q),
    );
  }, [allRows, search]);

  // ── Columns ───────────────────────────────────────────────────────
  const columns = useMemo<DataTableColumn<PromoRow>[]>(
    () => [
      {
        id: "code",
        header: String(t("admin.cpCodeColumn")),
        width: 1.6,
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
        width: 1,
        cell: (row) => (
          <Text variant="body" weight="bold">
            {formatPromoValue(row.kind, row.value, row.currency)}
          </Text>
        ),
      },
      {
        id: "scope",
        header: String(t("admin.cpScopeColumn")),
        width: 1,
        cell: (row) => <Badge tone="neutral">{row.scope}</Badge>,
      },
      {
        id: "status",
        header: String(t("admin.cpStatusColumn")),
        width: 1,
        cell: (row) => (
          <PromoStatusBadge status={row.status} endsAt={row.endsAt} />
        ),
      },
      {
        id: "redemptions",
        header: String(t("admin.cpRedemptionsColumn")),
        width: 1.2,
        cell: (row) => (
          <Text variant="body">
            {row.totalRedemptions}
            {row.maxRedemptions != null ? ` / ${row.maxRedemptions}` : ""}
          </Text>
        ),
      },
      {
        id: "expiry",
        header: String(t("admin.cpExpiryColumn")),
        width: 1.4,
        cell: (row) => <PromoExpiry endsAt={row.endsAt} />,
      },
      {
        id: "createdAt",
        header: String(t("admin.createdColumn")),
        width: 1.4,
        cell: (row) => (
          <Text variant="caption" tone="muted">
            {fmt.dateTime(row.createdAt, { dateStyle: "medium" })}
          </Text>
        ),
      },
    ],
    [t, fmt],
  );

  // ── Render ────────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <YStack padding="$4">
        <Text variant="body" tone="muted">
          {String(t("admin.loadingDashboard"))}
        </Text>
      </YStack>
    );
  }

  if (error) {
    return (
      <YStack padding="$4">
        <Text variant="body" tone="error">
          {formatErrorMessage(error.message)}
        </Text>
      </YStack>
    );
  }

  return (
    <YStack padding="$4" gap="$4" flex={1}>
      {/* Header — wraps so the refresh control never overflows at 360px */}
      <XStack
        justifyContent="space-between"
        alignItems="center"
        flexWrap="wrap"
        gap="$2"
      >
        <YStack>
          <Text variant="h3">{String(t("admin.cpPlatformTitle"))}</Text>
          <Text variant="body" tone="muted">
            {String(t("admin.cpPlatformSubtitle"))}
          </Text>
        </YStack>
        <Button size="$2" variant="ghost" onPress={() => refetch()}>
          <RefreshCw size={16} />
        </Button>
      </XStack>

      {/* Filters */}
      <XStack gap="$2" alignItems="center" flexWrap="wrap">
        {(["ALL", "ACTIVE", "ARCHIVED"] as const).map((s) => (
          <Button
            key={s}
            size="$2"
            variant={statusFilter === s ? "primary" : "ghost"}
            onPress={() => setStatusFilter(s)}
          >
            {s === "ALL"
              ? String(t("admin.cpFilterAll"))
              : s === "ACTIVE"
                ? String(t("admin.cpActive"))
                : String(t("admin.cpArchived"))}
          </Button>
        ))}
      </XStack>

      {/* Table */}
      {filteredRows.length === 0 ? (
        <YStack padding="$6" alignItems="center" gap="$2">
          <Tag size={32} color="var(--colorMuted)" />
          <Text variant="body" tone="muted">
            {String(t("admin.cpNoResults"))}
          </Text>
        </YStack>
      ) : (
        <DataTable<PromoRow>
          rows={filteredRows}
          columns={columns}
          getRowKey={(row) => row.id}
          // Borderless page-flow table with no scrolling ancestor —
          // scoped horizontal panning via DataTable's own wrapper.
          scrollContainer
          // Read-only table (no rowActions/onRowPress), so card mode loses
          // nothing — every value a staffer needs is on the card.
          renderMobileCard={(row) => <PromoMobileCard row={row} />}
        />
      )}

      <Text variant="caption" tone="muted">
        {filteredRows.length} {String(t("admin.cpPromosLabel"))}
      </Text>
    </YStack>
  );
}
