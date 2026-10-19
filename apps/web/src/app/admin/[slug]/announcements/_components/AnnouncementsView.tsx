"use client";

import { useMemo, useState } from "react";
import { useParams } from "next/navigation";
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
import { Plus, Megaphone } from "lucide-react";
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
import { ComposeAnnouncementDialog } from "./ComposeAnnouncementDialog";
import { AdminPageHeader } from "../../_components/AdminPageHeader";
import { AdminPageData } from "@/app/admin/_components/AdminPageData";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface AnnouncementRow {
  id: string;
  subject: string;
  audienceType:
    | "ALL_TICKET_HOLDERS"
    | "EVENT_TICKET_HOLDERS"
    | "MULTIPLE_EVENTS"
    | "EVENT_TICKET_TIER"
    | "CONTACT_LIST";
  audienceRef: string | null;
  recipientCount: number | null;
  eventId: string | null;
  sentAt: Date | null;
  sentBy: string;
  createdAt: Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// Audience badge helper
// ─────────────────────────────────────────────────────────────────────────────

function audienceLabel(
  type: AnnouncementRow["audienceType"],
  t: ReturnType<typeof useTranslations>,
): string {
  switch (type) {
    case "ALL_TICKET_HOLDERS":
      return String(t("admin.audienceAllTicketHolders"));
    case "EVENT_TICKET_HOLDERS":
      return String(t("admin.audienceEventTicketHolders"));
    case "MULTIPLE_EVENTS":
      return String(t("admin.audienceMultipleEvents"));
    case "EVENT_TICKET_TIER":
      return String(t("admin.audienceEventTicketTier"));
    case "CONTACT_LIST":
      return String(t("admin.audienceContactList"));
    default:
      return type;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export const AnnouncementsView = () => {
  const { slug } = useParams<{ slug: string }>();
  const { currentOwner, isLoading: isOwnerLoading } =
    useCurrentAdminOwner(slug);
  // Compose/send (and sendTest) are ORG_EDIT_ROLES mutations. Read-only roles
  // keep the sent-history list but see no compose affordance. UX-only; server 403s.
  const { canEdit } = useAdminOwnerCapabilities(currentOwner);
  const t = useTranslations();
  const fmt = useFormatters();

  const [composeOpen, setComposeOpen] = useState(false);

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
    "subject",
    "audienceType",
    "sentAt",
    "createdAt",
  ] as const;

  const columnOptions: ColumnOption[] = useMemo(
    () => [
      { id: "subject", label: String(t("admin.announcementSubjectColumn")) },
      {
        id: "audienceType",
        label: String(t("admin.announcementAudienceColumn")),
      },
      { id: "sentAt", label: String(t("admin.announcementSentAtColumn")) },
      { id: "createdAt", label: String(t("admin.createdColumn")) },
    ],
    [t],
  );

  const colVis = useColumnVisibility(
    "admin-announcements-columns",
    ALL_COL_IDS,
  );

  // ── Data ─────────────────────────────────────────────────────────────────
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

  const { data, isLoading, error, refetch } = trpc.announcements.list.useQuery(
    { ownerType, ownerId: ownerId!, limit: 100 },
    {
      enabled: !!ownerId,
      staleTime: 30_000,
      placeholderData: keepPreviousData,
    },
  );

  // ── Row mapping ──────────────────────────────────────────────────────────
  const allRows = useMemo<AnnouncementRow[]>(
    () =>
      (data?.items ?? []).map((item) => ({
        id: item.id,
        subject: item.subject,
        audienceType: item.audienceType,
        audienceRef: item.audienceRef,
        recipientCount: item.recipientCount ?? null,
        eventId: item.eventId,
        sentAt: item.sentAt ? new Date(item.sentAt) : null,
        sentBy: item.sentBy,
        createdAt: new Date(item.createdAt),
      })),
    [data],
  );

  // Client-side search
  const filteredRows = useMemo(() => {
    if (!debouncedSearch) return allRows;
    const q = debouncedSearch.toLowerCase();
    return allRows.filter((r) => r.subject.toLowerCase().includes(q));
  }, [allRows, debouncedSearch]);

  // Client-side pagination
  const totalRows = filteredRows.length;
  const totalPages = Math.ceil(totalRows / pageSize);
  const rows = useMemo(
    () => filteredRows.slice(page * pageSize, (page + 1) * pageSize),
    [filteredRows, page, pageSize],
  );

  // ── Columns ──────────────────────────────────────────────────────────────
  const columns = useMemo<DataTableColumn<AnnouncementRow>[]>(
    () => [
      {
        id: "subject",
        header: String(t("admin.announcementSubjectColumn")),
        width: 3,
        sortValue: (row) => row.subject,
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
            {row.subject}
          </Text>
        ),
      },
      {
        id: "audienceType",
        header: String(t("admin.announcementAudienceColumn")),
        width: 1.5,
        sortValue: (row) => row.audienceType,
        cell: (row) => (
          <XStack gap="$2" alignItems="center">
            <Badge tone="neutral" size="sm">
              {audienceLabel(row.audienceType, t)}
            </Badge>
            {row.recipientCount != null && (
              <Text variant="caption" tone="muted">
                ({row.recipientCount})
              </Text>
            )}
          </XStack>
        ),
      },
      {
        id: "sentAt",
        header: String(t("admin.announcementSentAtColumn")),
        width: 1.5,
        sortValue: (row) => row.sentAt?.getTime() ?? 0,
        cell: (row) => (
          <Text variant="caption" tone="muted">
            {row.sentAt ? fmt.dateTime(row.sentAt) : "—"}
          </Text>
        ),
      },
      {
        id: "createdAt",
        header: String(t("admin.createdColumn")),
        width: 1.5,
        noWrap: true,
        sortValue: (row) => row.createdAt.getTime(),
        cell: (row) => (
          <Text variant="caption" tone="muted">
            {fmt.dateTime(row.createdAt)}
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

  // ── Render guards ────────────────────────────────────────────────────────
  if (isOwnerLoading || isLoading) {
    return (
      <AdminPageData
        isLoading
        loadingMessage={String(t("admin.loadingAnnouncements"))}
      >
        {null}
      </AdminPageData>
    );
  }

  if (!ownerId) {
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
            t("admin.announcementsLoadFailed", {
              error: formatErrorMessage(error),
            }),
          )}
        </Text>
        <Button variant="secondary" size="$2" onPress={() => refetch()}>
          {String(t("admin.retry"))}
        </Button>
      </YStack>
    );
  }

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
        title={String(t("admin.announcementsHeading"))}
        subtitle={String(t("admin.announcementsSubtitle"))}
        section="announcements"
        trailing={
          canEdit ? (
            <Button
              variant="primary"
              size="$3"
              onPress={() => setComposeOpen(true)}
            >
              <Plus size={18} />
              {String(t("admin.composeAnnouncement"))}
            </Button>
          ) : undefined
        }
      />

      {/* Table — no minWidth here: a fixed 640px on this wrapper made the
          whole PAGE pan horizontally on phones. The table keeps its 640px
          minimum inside the scoped scroll container below instead. */}
      <YStack flex={1} minWidth={0} width="100%">
        <ActionBar onRefresh={() => refetch()} countLabel={summaryLabel}>
          <SearchBar
            value={searchQuery}
            onChangeText={handleSearchChange}
            placeholder={String(
              t("admin.searchAnnouncementsPlaceholder") ??
                "Search announcements...",
            )}
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
          {/* DataTable is a DIRECT child of TableContainer — the container
              already owns the scroll context (`overflow: auto`), and a
              nested scroll div here defeated the table's sticky header. */}
          <DataTable
            rows={rows}
            columns={visibleColumns}
            clientSort
            getRowKey={(row) => row.id}
            isLoading={isLoading}
            emptyState={
              hasActiveSearch ? (
                <NoResults
                  title={String(t("admin.announcementsEmpty"))}
                  description={String(
                    t("admin.announcementsEmptyDescription"),
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
                  <Megaphone size={40} />
                  <Text variant="h4" weight="bold" textAlign="center">
                    {String(t("admin.announcementsEmpty"))}
                  </Text>
                  <Text
                    variant="body"
                    tone="muted"
                    textAlign="center"
                    maxWidth={320}
                  >
                    {String(t("admin.announcementsEmptyDescription"))}
                  </Text>
                  {canEdit ? (
                    <Button
                      variant="secondary"
                      size="$3"
                      onPress={() => setComposeOpen(true)}
                    >
                      <Plus size={18} />
                      {String(t("admin.composeAnnouncement"))}
                    </Button>
                  ) : null}
                </YStack>
              )
            }
            testIdBase="announcements-table"
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

      {/* Compose dialog — only mounted for roles that may send (ORG_EDIT_ROLES) */}
      {canEdit ? (
        <ComposeAnnouncementDialog
          open={composeOpen}
          onClose={() => setComposeOpen(false)}
          ownerType={ownerType}
          ownerId={ownerId}
          onSent={() => refetch()}
        />
      ) : null}
    </YStack>
  );
};
