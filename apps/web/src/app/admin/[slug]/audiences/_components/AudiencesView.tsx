"use client";

import { useMemo, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { useRouter } from "@bprogress/next/app";
import { YStack, XStack } from "tamagui";
import {
  DataTable,
  type DataTableColumn,
  Button,
  Text,
  Badge,
  Tooltip,
  useNotify,
  useTranslations,
  useFormatters,
} from "@th/ui";
import { Trash2, Plus } from "lucide-react";
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
  ColumnSelector,
  type ColumnOption,
} from "@/components/AdminTableParts";
import { useAdminTableParams } from "@/hooks/useAdminTableParams";
import { useColumnVisibility } from "@/hooks/useColumnVisibility";
import { AdminPageHeader } from "../../_components/AdminPageHeader";
import { AdminPageData } from "@/app/admin/_components/AdminPageData";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface AudienceRow {
  id: string;
  name: string;
  description: string | null;
  contactCount: number;
  lastImportAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function AudiencesView() {
  const { toast } = useNotify();
  const router = useRouter();
  const { slug } = useParams<{ slug: string }>();
  const utils = trpc.useUtils();
  const { currentOwner, isLoading: isOwnerLoading } =
    useCurrentAdminOwner(slug);
  // Content-edit capability (create / import / edit / delete). Mirrors the
  // server-side ORG_EDIT_ROLES check on comms mutations. Read (list/detail)
  // stays open for every role that can view the page. UX-only; server 403s.
  const { canEdit } = useAdminOwnerCapabilities(currentOwner);
  const t = useTranslations();
  const fmt = useFormatters();

  const [isCreating, setIsCreating] = useState(false);

  // ── Search / pagination state (URL-synced) ─────────────────────────────
  const {
    searchQuery,
    debouncedSearch,
    page,
    pageSize,
    handleSearchChange,
    setPage,
    setPageSize,
  } = useAdminTableParams();

  // ── Column visibility ────────────────────────────────────────────────────
  const ALL_COL_IDS = [
    "name",
    "contactCount",
    "lastImportAt",
    "createdAt",
  ] as const;

  const columnOptions: ColumnOption[] = useMemo(
    () => [
      { id: "name", label: String(t("admin.audienceNameColumn")) },
      { id: "contactCount", label: String(t("admin.contactsColumn")) },
      { id: "lastImportAt", label: String(t("admin.lastImportColumn")) },
      { id: "createdAt", label: String(t("admin.createdColumn")) },
    ],
    [t],
  );

  const colVis = useColumnVisibility("admin-audiences-columns", ALL_COL_IDS);

  const ownerInput = useMemo(() => {
    if (!currentOwner) return null;
    return currentOwner.kind === "human"
      ? { kind: "HUMAN" as const, id: currentOwner.humanId }
      : { kind: "ORG" as const, id: currentOwner.orgId };
  }, [currentOwner]);

  const { data, isLoading, error, refetch } = trpc.comms.listAudiences.useQuery(
    { owner: ownerInput! },
    {
      enabled: !!ownerInput,
      staleTime: 30_000,
      placeholderData: keepPreviousData,
    },
  );

  const createMutation = trpc.comms.createAudience.useMutation({
    meta: { silent: true },
  });
  const deleteMutation = trpc.comms.deleteAudience.useMutation({
    meta: { silent: true },
  });

  // ── Row mapping (listAudiences returns a flat array) ──────────────────

  const allRows = useMemo<AudienceRow[]>(
    () =>
      (data ?? []).map((list) => ({
        id: list.id,
        name: list.name,
        description: list.description,
        contactCount: list.contactCount,
        lastImportAt: list.lastImportAt ? new Date(list.lastImportAt) : null,
        createdAt: new Date(list.createdAt),
        updatedAt: new Date(list.updatedAt),
      })),
    [data],
  );

  // Client-side search (server doesn't support query param)
  const filteredRows = useMemo(() => {
    if (!debouncedSearch) return allRows;
    const q = debouncedSearch.toLowerCase();
    return allRows.filter((r) => r.name.toLowerCase().includes(q));
  }, [allRows, debouncedSearch]);

  // Client-side pagination
  const totalRows = filteredRows.length;
  const totalPages = Math.ceil(totalRows / pageSize);
  const rows = useMemo(
    () => filteredRows.slice(page * pageSize, (page + 1) * pageSize),
    [filteredRows, page, pageSize],
  );

  // ── Actions ────────────────────────────────────────────────────────────

  const handleCreate = useCallback(async () => {
    if (!ownerInput || isCreating) return;
    setIsCreating(true);

    try {
      const result = await createMutation.mutateAsync({
        owner: ownerInput,
        name: "Untitled Audience",
      });
      await utils.comms.listAudiences.invalidate();
      router.push(`/admin/${slug}/audiences/${result.id}`);
    } catch (err) {
      toast.danger({
        id: "audience-create-failed",
        title: t("admin.createFailed") as string,
        message: formatErrorMessage(err, t),
      });
    } finally {
      setIsCreating(false);
    }
  }, [
    ownerInput,
    isCreating,
    slug,
    router,
    createMutation,
    toast,
    utils.comms.listAudiences,
    t,
  ]);

  const handleDelete = useCallback(
    async (row: AudienceRow) => {
      if (
        !confirm(String(t("admin.deleteConfirmAudience", { name: row.name })))
      )
        return;

      try {
        await deleteMutation.mutateAsync({ listId: row.id });
        toast.success({
          id: "audience-deleted",
          title: t("admin.audienceDeleted") as string,
          message: t("admin.audienceDeletedMessage", {
            name: row.name,
          }) as string,
        });
        await utils.comms.listAudiences.invalidate();
      } catch (err) {
        toast.danger({
          id: "audience-delete-failed",
          title: t("admin.deleteFailed") as string,
          message: formatErrorMessage(err, t),
        });
      }
    },
    [deleteMutation, toast, utils.comms.listAudiences, t],
  );

  // ── Columns ────────────────────────────────────────────────────────────

  const columns = useMemo<DataTableColumn<AudienceRow>[]>(
    () => [
      {
        id: "name",
        header: String(t("admin.audienceNameColumn")),
        width: 3,
        sortValue: (row) => row.name,
        cell: (row) => (
          <Text
            variant="body"
            style={{
              fontWeight: 700,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {row.name}
          </Text>
        ),
      },
      {
        id: "contactCount",
        header: String(t("admin.contactsColumn")),
        width: 1,
        sortValue: (row) => row.contactCount,
        cell: (row) => (
          <Badge tone="neutral" size="sm">
            {row.contactCount.toLocaleString()}
          </Badge>
        ),
      },
      {
        id: "lastImportAt",
        header: String(t("admin.lastImportColumn")),
        width: 1.5,
        cell: (row) => (
          <Text variant="caption" tone="muted">
            {row.lastImportAt
              ? fmt.dateTime(row.lastImportAt)
              : String(t("admin.neverImported"))}
          </Text>
        ),
      },
      {
        id: "createdAt",
        header: String(t("admin.createdColumn")),
        width: 1.5,
        noWrap: true,
        sortValue: (row) => row.createdAt,
        cell: (row) => (
          <Text variant="caption" tone="muted">
            {fmt.dateTime(row.createdAt)}
          </Text>
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

  // Row actions (separate from columns so DataTable handles stopPropagation).
  // Delete is an ORG_EDIT_ROLES mutation — hide the whole actions column for
  // read-only roles so a VIEWER/FINANCE/SCANNER sees no delete affordance.
  const rowActions = useMemo(
    () =>
      canEdit
        ? {
            header: String(t("admin.actions")),
            width: 1,
            render: (row: AudienceRow) => (
              <XStack gap="$2" justifyContent="flex-end">
                <Tooltip
                  anchor={
                    <Button
                      size="$2"
                      variant="ghost"
                      icon
                      onPress={() => {
                        void handleDelete(row);
                      }}
                      aria-label={String(
                        t("admin.deleteAudienceLabel", { name: row.name }),
                      )}
                    >
                      <Trash2 size={14} />
                    </Button>
                  }
                  placement="top"
                >
                  {String(t("admin.deleteTooltip"))}
                </Tooltip>
              </XStack>
            ),
          }
        : undefined,
    [canEdit, handleDelete, t],
  );

  // ── Render ─────────────────────────────────────────────────────────────

  if (isOwnerLoading || isLoading) {
    return (
      <AdminPageData
        isLoading
        loadingMessage={String(t("admin.loadingAudiences"))}
      >
        {null}
      </AdminPageData>
    );
  }

  if (!ownerInput) {
    return (
      <YStack padding="$4">
        <Text>{String(t("admin.unableToDetermineOwnerAudiences"))}</Text>
      </YStack>
    );
  }

  if (error) {
    return (
      <YStack padding="$4" gap="$3">
        <Text variant="body" tone="error">
          {String(
            t("admin.failedToLoadAudiences", {
              error: formatErrorMessage(error),
            }),
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

  const hasRows = rows.length > 0;
  const hasActiveSearch = debouncedSearch.length > 0;

  const summaryLabel = (() => {
    if (totalRows === 0) return undefined;
    const start = page * pageSize + 1;
    const end = Math.min((page + 1) * pageSize, totalRows);
    return String(t("admin.nOfTotal", { start, end, total: totalRows }));
  })();

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
        title={String(t("admin.audiencesHeading"))}
        subtitle={String(t("admin.audiencesSubtitle"))}
        section="audiences"
        trailing={
          /* Buttons go in as direct slot children (fragment, like TeamView) —
             the header's trailing XStack already provides gap="$2" plus the
             wrap/shrink behaviour. A nested non-wrapping XStack here defeated
             that: it was one flex item with the un-wrapped sum of both buttons
             as its min-content width, panning the document below ~360px. */
          canEdit ? (
            <>
              <Button
                size="$3"
                variant="secondary"
                onPress={() => router.push(`/admin/${slug}/audiences/import`)}
              >
                {String(t("admin.importButton"))}
              </Button>
              <Button
                variant="primary"
                size="$3"
                onPress={() => {
                  void handleCreate();
                }}
                disabled={isCreating}
              >
                <Plus size={18} />
                {String(t("admin.newAudience"))}
              </Button>
            </>
          ) : undefined
        }
      />

      {/* Table — no minWidth here: a fixed 640px on this wrapper made the
          whole PAGE pan horizontally on phones. The table keeps its 640px
          minimum inside the scoped scroll container below instead. */}
      <YStack flex={1} minWidth={0} width="100%">
        <ActionBar
          onRefresh={() => {
            void refetch();
          }}
          countLabel={summaryLabel}
        >
          <SearchBar
            value={searchQuery}
            onChangeText={handleSearchChange}
            placeholder={String(t("admin.searchAudiencesPlaceholder"))}
          />
          <ColumnSelector
            options={columnOptions}
            isVisible={colVis.isVisible}
            onToggle={colVis.toggleColumn}
            onShowAll={colVis.showAll}
            hasHidden={colVis.hasHidden}
          />
        </ActionBar>

        <TableContainer>
          {/* Scoped horizontal scroll: phones swipe the table sideways
              inside this container; the page itself never pans. Focusable
              so keyboard users can scroll it with arrow keys. */}
          <div
            data-testid="audiences-table-scroll"
            tabIndex={0}
            role="region"
            aria-label={String(t("admin.audiencesHeading"))}
            style={{
              maxWidth: "100%",
              overflowX: "auto",
              WebkitOverflowScrolling: "touch",
            }}
          >
            <div style={{ minWidth: 640 }}>
              <DataTable
                rows={rows}
                columns={visibleColumns}
                clientSort
                getRowKey={(row) => row.id}
                isLoading={isLoading}
                emptyState={
                  hasActiveSearch ? (
                    <NoResults
                      title={String(t("admin.noMatchingAudiences"))}
                      description={String(
                        t("admin.noMatchingAudiencesDescription"),
                      )}
                      onClearFilters={() => handleSearchChange("")}
                    />
                  ) : (
                    <YStack
                      padding="$8"
                      alignItems="center"
                      justifyContent="center"
                      gap="$3"
                    >
                      <Text variant="h4" weight="bold" textAlign="center">
                        {String(t("admin.noAudiencesYet"))}
                      </Text>
                      <Text
                        variant="body"
                        tone="muted"
                        textAlign="center"
                        maxWidth={320}
                      >
                        {String(t("admin.noAudiencesDescription"))}
                      </Text>
                      {canEdit ? (
                        <Button
                          variant="secondary"
                          size="$3"
                          onPress={() => {
                            void handleCreate();
                          }}
                          disabled={isCreating}
                        >
                          <Plus size={18} />
                          {String(t("admin.createFirstAudience"))}
                        </Button>
                      ) : null}
                    </YStack>
                  )
                }
                onRowPress={(row) =>
                  router.push(`/admin/${slug}/audiences/${row.id}`)
                }
                rowActions={rowActions}
                testIdBase="audiences-manager-table"
              />
            </div>
          </div>
        </TableContainer>

        <Pagination
          page={page}
          totalPages={totalPages}
          onPageChange={setPage}
          pageSize={pageSize}
          onPageSizeChange={setPageSize}
        />
      </YStack>
    </YStack>
  );
}
