"use client";

/**
 * /platform/audit-log — platform-wide, READ-ONLY audit-log viewer.
 *
 * NOT the org-scoped `/admin/[slug]/activity` surface described in
 * `docs/specs/2026-03-03/audit-log-viewer.md` — that is a separate,
 * out-of-scope feature for a different (org-level) audience.
 *
 * `entity` and `action` are free-form strings written by ~65 distinct call
 * sites across the codebase (no enum, no consistent casing convention) — so
 * this page deliberately does NOT attempt per-entity human-readable sentence
 * formatting (e.g. "Alice added Bob as Editor"). Instead it exposes sortable/
 * filterable columns for entity/action/entityId/at, plus a best-effort Actor
 * column (extracted from `data.actorHumanId`, which is NOT a top-level
 * column — just a convention nearly every write site follows), and renders
 * the raw `data` JSON payload pretty-printed in an expandable row.
 *
 * RBAC: ADMIN + REVIEWER (see `listAuditLogs`'s doc comment in
 * `@th/core/use-cases/platform` for why). Automatically step-up-2FA-gated —
 * every `platform.*` tRPC procedure is gated by `requireStaffSecondFactor`
 * (packages/transport/trpc/src/guard.ts), no extra wiring needed here.
 */

import {
  useCallback,
  useMemo,
  useState,
  Suspense,
  type CSSProperties,
} from "react";
import { useTheme, XStack, YStack } from "tamagui";
import { keepPreviousData } from "@tanstack/react-query";
import { ScrollText, Search, RefreshCw, X, ChevronDown } from "lucide-react";

import {
  DataTable,
  type DataTableColumn,
  type DataTableSortState,
  Button,
  Text,
  TextInput,
  useFormatters,
} from "@th/ui";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";
import { fmtDate, truncateId } from "@/lib/format";
import { useIsMobile } from "@/hooks/useIsMobile";
import { PlatformContainer } from "../_components/PlatformPageParts";

import { AuditLogDetail, type AuditLogRow } from "./_components/AuditLogDetail";
import { AuditLogMobileCard } from "./_components/AuditLogMobileCard";

// ─────────────────────────────────────────────────────────────────────────────
// Constants / helpers
// ─────────────────────────────────────────────────────────────────────────────

const PAGE_SIZE = 25;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Native date inputs styled to match the strict-Swiss filter controls used
 * on the org volunteer-hours date-range filter (Tamagui's TextInput ignores
 * type="date" on web). */
const DATE_INPUT_STYLE: CSSProperties = {
  minHeight: 40,
  padding: "8px 12px",
  fontSize: 14,
  borderRadius: 0,
  border: "1px solid var(--borderColor, #211C16)",
  background: "var(--surface, #FDFAF3)",
  color: "var(--color, #211C16)",
};

/** Parse a `YYYY-MM-DD` value from `<input type="date">` at local midnight. */
function dateInputToLocalDate(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** End-of-day (23:59:59.999 local) for an inclusive `atLte` upper bound. */
function endOfLocalDay(picked: Date): Date {
  return new Date(
    picked.getFullYear(),
    picked.getMonth(),
    picked.getDate(),
    23,
    59,
    59,
    999,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export default function PlatformAuditLogPage() {
  return (
    <Suspense>
      <PlatformAuditLogPageContent />
    </Suspense>
  );
}

function PlatformAuditLogPageContent() {
  const theme = useTheme();
  const fmt = useFormatters();
  const isMobile = useIsMobile();

  // ── State ────────────────────────────────────────────────────────────────
  const [entityInput, setEntityInput] = useState("");
  const [debouncedEntity, setDebouncedEntity] = useState("");
  const [actionInput, setActionInput] = useState("");
  const [debouncedAction, setDebouncedAction] = useState("");
  const [actorInput, setActorInput] = useState("");
  const [debouncedActor, setDebouncedActor] = useState("");
  const [fromDateStr, setFromDateStr] = useState("");
  const [toDateStr, setToDateStr] = useState("");
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState<DataTableSortState>({
    columnId: "at",
    direction: "desc",
  });
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const entityTimeout = useState<ReturnType<typeof setTimeout> | null>(null);
  const handleEntityChange = useCallback(
    (value: string) => {
      setEntityInput(value);
      if (entityTimeout[0]) clearTimeout(entityTimeout[0]);
      entityTimeout[0] = setTimeout(() => {
        setDebouncedEntity(value.trim());
        setPage(0);
      }, 300);
    },
    [entityTimeout],
  );

  const actionTimeout = useState<ReturnType<typeof setTimeout> | null>(null);
  const handleActionChange = useCallback(
    (value: string) => {
      setActionInput(value);
      if (actionTimeout[0]) clearTimeout(actionTimeout[0]);
      actionTimeout[0] = setTimeout(() => {
        setDebouncedAction(value.trim());
        setPage(0);
      }, 300);
    },
    [actionTimeout],
  );

  const actorTimeout = useState<ReturnType<typeof setTimeout> | null>(null);
  const handleActorChange = useCallback(
    (value: string) => {
      setActorInput(value);
      if (actorTimeout[0]) clearTimeout(actorTimeout[0]);
      actorTimeout[0] = setTimeout(() => {
        setDebouncedActor(value.trim());
        setPage(0);
      }, 300);
    },
    [actorTimeout],
  );

  // Actor filter is a JSON-path lookup on `data.actorHumanId` server-side —
  // only sent once it looks like a valid UUID so a half-typed value doesn't
  // 400 against the strict input schema.
  const actorHumanIdFilter =
    debouncedActor && UUID_RE.test(debouncedActor) ? debouncedActor : undefined;

  const atGte = useMemo(() => {
    const d = dateInputToLocalDate(fromDateStr);
    return d ?? undefined;
  }, [fromDateStr]);
  const atLte = useMemo(() => {
    const d = dateInputToLocalDate(toDateStr);
    return d ? endOfLocalDay(d) : undefined;
  }, [toDateStr]);

  const sortParam: "at_asc" | "at_desc" =
    sort.direction === "asc" ? "at_asc" : "at_desc";

  const toggleExpand = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // ── Query ────────────────────────────────────────────────────────────────
  const { data, isLoading, error, refetch } =
    trpc.platform.listAuditLogs.useQuery(
      {
        entity: debouncedEntity || undefined,
        action: debouncedAction || undefined,
        humanId: actorHumanIdFilter,
        atGte,
        atLte,
        sort: sortParam,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      },
      {
        staleTime: 15_000,
        placeholderData: keepPreviousData,
      },
    );

  const rows: AuditLogRow[] = useMemo(() => {
    if (!data?.items) return [];
    return data.items.map((item) => ({
      ...item,
      at: new Date(item.at),
    }));
  }, [data?.items]);

  const totalRows = data?.pageInfo?.total ?? 0;
  const totalPages = Math.ceil(totalRows / PAGE_SIZE);
  const hasActiveFilters = Boolean(
    debouncedEntity ||
    debouncedAction ||
    debouncedActor ||
    fromDateStr ||
    toDateStr,
  );

  const clearFilters = useCallback(() => {
    setEntityInput("");
    setDebouncedEntity("");
    setActionInput("");
    setDebouncedAction("");
    setActorInput("");
    setDebouncedActor("");
    setFromDateStr("");
    setToDateStr("");
    setPage(0);
  }, []);

  // ── Columns ──────────────────────────────────────────────────────────────
  const columns: DataTableColumn<AuditLogRow>[] = useMemo(
    () => [
      {
        id: "entity",
        header: "Entity",
        width: 1.4,
        cell: (row) => (
          <Text
            variant="body"
            weight="bold"
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {row.entity}
          </Text>
        ),
      },
      {
        id: "action",
        header: "Action",
        width: 1.8,
        cell: (row) => (
          <Text
            variant="body"
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {row.action}
          </Text>
        ),
      },
      {
        id: "entityId",
        header: "Entity ID",
        width: 1.6,
        cell: (row) => (
          <Text
            variant="body"
            tone={row.entityId ? "default" : "muted"}
            style={{
              fontSize: 12,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {row.entityId ? truncateId(row.entityId) : "—"}
          </Text>
        ),
      },
      {
        id: "actorHumanId",
        header: "Actor",
        width: 1.4,
        cell: (row) => (
          <Text
            variant="body"
            tone={row.actorHumanId ? "default" : "muted"}
            style={{
              fontSize: 12,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {row.actorHumanId ? truncateId(row.actorHumanId) : "—"}
          </Text>
        ),
      },
      {
        id: "at",
        header: "At",
        width: 1.8,
        noWrap: true,
        cell: (row) => (
          <Text variant="body" tone="default">
            {fmtDate(fmt, row.at)}
          </Text>
        ),
      },
    ],
    [fmt],
  );

  const rowActions = useMemo(
    () => ({
      header: "",
      width: 0.6,
      render: (row: AuditLogRow) => (
        <XStack gap="$2" justifyContent="flex-end">
          <Button
            variant={expandedIds.has(row.id) ? "primary" : "ghost"}
            size="$2"
            icon
            onPress={() => toggleExpand(row.id)}
            aria-label="View details"
          >
            <ChevronDown
              size={14}
              style={{
                transform: expandedIds.has(row.id)
                  ? "rotate(180deg)"
                  : undefined,
                transition: "transform 0.15s ease",
              }}
            />
          </Button>
        </XStack>
      ),
    }),
    [expandedIds, toggleExpand],
  );

  // ── Error state ──────────────────────────────────────────────────────────
  if (error) {
    return (
      <PlatformContainer size="lg">
        <YStack gap="$3">
          <Text variant="body" tone="error">
            {`Failed to load audit logs: ${formatErrorMessage(error)}`}
          </Text>
          <Button variant="secondary" size="$2" onPress={() => refetch()}>
            Retry
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
          <ScrollText size={20} color={theme.color?.val} />
          <Text variant="h2" tag="h1" weight="bold">
            Audit Log
          </Text>
        </XStack>
        <Text variant="body" tone="muted">
          Read-only, platform-wide feed of every audit-log entry. `entity` and
          `action` are free-form strings written across the codebase — filter
          with contains-style search rather than exact match.
        </Text>
      </YStack>

      {/* Filters */}
      <YStack gap="$3">
        <XStack gap="$3" flexWrap="wrap" alignItems="center">
          <XStack alignItems="center" gap="$2" minWidth={220} maxWidth={260}>
            <Search size={16} color={theme.colorMuted?.val} />
            <TextInput
              flex={1}
              value={entityInput}
              onChangeText={handleEntityChange}
              placeholder="Filter by entity"
            />
          </XStack>

          <XStack alignItems="center" gap="$2" minWidth={220} maxWidth={260}>
            <Search size={16} color={theme.colorMuted?.val} />
            <TextInput
              flex={1}
              value={actionInput}
              onChangeText={handleActionChange}
              placeholder="Filter by action"
            />
          </XStack>

          <XStack alignItems="center" gap="$2" minWidth={260} maxWidth={320}>
            <Search size={16} color={theme.colorMuted?.val} />
            <TextInput
              flex={1}
              value={actorInput}
              onChangeText={handleActorChange}
              placeholder="Actor human ID (UUID)"
            />
          </XStack>

          <XStack gap="$2" alignItems="center">
            <Text variant="caption" tone="muted">
              From
            </Text>
            <input
              type="date"
              value={fromDateStr}
              max={toDateStr || undefined}
              onChange={(e) => {
                setFromDateStr(e.target.value);
                setPage(0);
              }}
              data-testid="audit-log-filter-from"
              style={DATE_INPUT_STYLE}
            />
            <Text variant="caption" tone="muted">
              To
            </Text>
            <input
              type="date"
              value={toDateStr}
              min={fromDateStr || undefined}
              onChange={(e) => {
                setToDateStr(e.target.value);
                setPage(0);
              }}
              data-testid="audit-log-filter-to"
              style={DATE_INPUT_STYLE}
            />
          </XStack>

          {hasActiveFilters && (
            <Button variant="ghost" size="$2" onPress={clearFilters}>
              <X size={14} aria-hidden />
              Clear filters
            </Button>
          )}
        </XStack>
      </YStack>

      {/* Action bar */}
      <XStack paddingHorizontal="$1" paddingVertical="$2" alignItems="center">
        <Button
          variant="ghost"
          size="$2"
          onPress={() => refetch()}
          aria-label="Refresh"
          paddingHorizontal="$3"
        >
          <RefreshCw size={14} aria-hidden />
          Refresh
        </Button>
        <XStack flex={1} />
        {data?.pageInfo && (
          <Text variant="caption" tone="muted" paddingHorizontal="$3">
            {totalRows === 0
              ? "No audit-log entries yet"
              : `${page * PAGE_SIZE + 1}–${Math.min(
                  (page + 1) * PAGE_SIZE,
                  totalRows,
                )} of ${totalRows}`}
          </Text>
        )}
      </XStack>

      {/* Table */}
      <XStack overflow="scroll" flex={1}>
        <YStack flex={1} minWidth={isMobile ? 0 : 1000}>
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
            rowActions={rowActions}
            renderMobileCard={(row) => <AuditLogMobileCard row={row} />}
            renderExpandedRow={(row) =>
              expandedIds.has(row.id) ? (
                <AuditLogDetail
                  row={row}
                  fmt={fmt}
                  onClose={() => toggleExpand(row.id)}
                />
              ) : null
            }
            testIdBase="platform-audit-log-table"
            emptyState={
              <YStack
                padding="$8"
                alignItems="center"
                justifyContent="center"
                gap="$3"
              >
                <ScrollText size={32} color="var(--colorMuted)" />
                <Text variant="h4" weight="bold">
                  {hasActiveFilters
                    ? "No matching audit-log entries"
                    : "No audit-log entries yet"}
                </Text>
                {hasActiveFilters && (
                  <Button variant="secondary" size="$2" onPress={clearFilters}>
                    Clear filters
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
            Previous
          </Button>
          <Text variant="bodySmall" tone="muted">
            {`Page ${page + 1} of ${totalPages}`}
          </Text>
          <Button
            variant="secondary"
            size="$2"
            onPress={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            disabled={page >= totalPages - 1}
          >
            Next
          </Button>
        </XStack>
      )}
    </PlatformContainer>
  );
}
