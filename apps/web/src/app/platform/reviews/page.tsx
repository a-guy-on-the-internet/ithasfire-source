"use client";

import { useMemo, useState, useCallback } from "react";
import { useTheme, YStack, XStack } from "tamagui";
import {
  PlatformContainer,
  PlatformFilterBar,
} from "../_components/PlatformPageParts";
import {
  DataTable,
  type DataTableColumn,
  type DataTableSortState,
  Button,
  Text,
  Badge,
  TextInput,
} from "@th/ui";
import {
  MessageSquareWarning,
  Flag,
  EyeOff,
  Eye,
  RefreshCw,
  AlertTriangle,
} from "lucide-react";
import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";
import { useTranslations } from "@th/ui";
import { FilterChips } from "@/components/AdminTableParts";
import { useIsMobile } from "@/hooks/useIsMobile";

import {
  ReviewDetailPanel,
  FlagReasonBox,
  type ReviewRow,
} from "./_components/ReviewDetailPanel";
import {
  ReviewMobileCard,
  getReviewModerationStatus,
} from "./_components/ReviewMobileCard";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type ModerationFilter = "all" | "flagged" | "hidden" | "visible";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

import { formatDateShort } from "@/lib/format";

const FILTER_LABEL_KEY: Record<ModerationFilter, string> = {
  all: "admin.rmFilterAll",
  flagged: "admin.rmFilterFlagged",
  hidden: "admin.rmFilterHidden",
  visible: "admin.rmFilterVisible",
};

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export default function PlatformReviewsPage() {
  const utils = trpc.useUtils();
  const theme = useTheme();
  const t = useTranslations();
  const isMobile = useIsMobile();

  const [venueSearch, setVenueSearch] = useState("");
  const [filter, setFilter] = useState<ModerationFilter>("flagged");
  const [selectedReview, setSelectedReview] = useState<ReviewRow | null>(null);
  const [sort, setSort] = useState<DataTableSortState>({
    columnId: "createdAt",
    direction: "desc",
  });

  const { data, isLoading, error, refetch } =
    trpc.placeReviews.listPlatform.useQuery(
      {
        moderationFilter: filter,
        limit: 50,
        offset: 0,
      },
      { staleTime: 15_000 },
    );

  const hideMut = trpc.placeReviews.hide.useMutation({
    onSuccess: () => void utils.placeReviews.listPlatform.invalidate(),
  });

  const unhideMut = trpc.placeReviews.unhide.useMutation({
    onSuccess: () => void utils.placeReviews.listPlatform.invalidate(),
  });

  const rows: ReviewRow[] = useMemo(() => {
    let all = data?.reviews ?? [];

    // Client-side venue name filter
    if (venueSearch.trim().length >= 2) {
      const q = venueSearch.trim().toLowerCase();
      all = all.filter((r) => r.placeName.toLowerCase().includes(q));
    }

    const sorted = [...all];
    const { columnId, direction } = sort;
    const multiplier = direction === "asc" ? 1 : -1;

    sorted.sort((a, b) => {
      let aVal: string | number;
      let bVal: string | number;

      switch (columnId) {
        case "placeName":
          aVal = a.placeName.toLowerCase();
          bVal = b.placeName.toLowerCase();
          break;
        case "reviewer":
          aVal = (a.anonymousName ?? "").toLowerCase();
          bVal = (b.anonymousName ?? "").toLowerCase();
          break;
        case "createdAt":
          aVal = a.createdAt;
          bVal = b.createdAt;
          break;
        case "status":
          aVal = a.hidden ? 2 : a.flagged ? 1 : 0;
          bVal = b.hidden ? 2 : b.flagged ? 1 : 0;
          break;
        default:
          return 0;
      }

      if (aVal < bVal) return -1 * multiplier;
      if (aVal > bVal) return 1 * multiplier;
      return 0;
    });

    return sorted;
  }, [data?.reviews, venueSearch, sort]);

  const handleHide = useCallback(
    (reviewId: string) => hideMut.mutate({ reviewId }),
    [hideMut],
  );

  const handleUnhide = useCallback(
    (reviewId: string) => unhideMut.mutate({ reviewId }),
    [unhideMut],
  );

  const columns: DataTableColumn<ReviewRow>[] = useMemo(
    () => [
      {
        id: "placeName",
        header: String(t("admin.rmVenue")),
        width: 1.5,
        cell: (row) => (
          <YStack gap="$1" flex={1} minWidth={0}>
            <Text
              variant="body"
              style={{
                fontWeight: 700,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {row.placeName}
            </Text>
            {row.genre && (
              <Text variant="caption" tone="muted">
                {row.genre}
              </Text>
            )}
          </YStack>
        ),
      },
      {
        id: "reviewer",
        header: String(t("admin.rmReviewer")),
        width: 1.2,
        cell: (row) => (
          <YStack gap="$1" flex={1} minWidth={0}>
            <Text
              variant="body"
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {row.anonymousName ?? String(t("admin.rmAnonymous"))}
            </Text>
            {row.anonymousEmail && (
              <Text
                variant="caption"
                tone="muted"
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {row.anonymousEmail}
              </Text>
            )}
          </YStack>
        ),
      },
      {
        id: "comment",
        header: String(t("admin.rmComment")),
        width: 2.5,
        cell: (row) => (
          <YStack gap="$1" flex={1} minWidth={0}>
            <Text
              variant="body"
              tone={row.comment ? undefined : "muted"}
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {row.comment ?? String(t("admin.rmNoComment"))}
            </Text>
            {row.flagged && row.flagReason && (
              <FlagReasonBox>
                <AlertTriangle size={11} color={theme.warning?.val} />
                <Text variant="caption" tone="warning">
                  {String(t("admin.rmFlagReason", { reason: row.flagReason }))}
                </Text>
              </FlagReasonBox>
            )}
          </YStack>
        ),
      },
      {
        id: "status",
        header: String(t("admin.rmStatus")),
        width: 0.8,
        cell: (row) => {
          // Tone/label come from the helper shared with the mobile card so
          // table and card modes always agree.
          const status = getReviewModerationStatus(row);
          const StatusIcon = row.hidden ? EyeOff : row.flagged ? Flag : null;
          const iconColor = row.hidden ? theme.danger?.val : theme.warning?.val;
          return (
            <XStack gap="$1" alignItems="center">
              {StatusIcon && <StatusIcon size={14} color={iconColor} />}
              <Badge tone={status.tone} size="sm">
                {String(t(status.labelKey))}
              </Badge>
            </XStack>
          );
        },
      },
      {
        id: "createdAt",
        header: String(t("admin.rmDate")),
        width: 0.9,
        cell: (row) => (
          <Text variant="body">{formatDateShort(row.createdAt)}</Text>
        ),
      },
    ],
    [t, theme],
  );

  const rowActions = useMemo(
    () => ({
      header: "",
      width: 1,
      render: (row: ReviewRow) => {
        const isMutating = hideMut.isPending || unhideMut.isPending;
        return (
          <XStack gap="$2" justifyContent="flex-end">
            {row.hidden ? (
              <Button
                variant="secondary"
                size="$2"
                onPress={() => handleUnhide(row.id)}
                disabled={isMutating}
              >
                <Eye size={14} />
                {String(t("admin.rmUnhide"))}
              </Button>
            ) : (
              <Button
                variant="secondary"
                size="$2"
                onPress={() => handleHide(row.id)}
                disabled={isMutating}
              >
                <EyeOff size={14} />
                {String(t("admin.rmHide"))}
              </Button>
            )}
          </XStack>
        );
      },
    }),
    [hideMut.isPending, unhideMut.isPending, handleHide, handleUnhide, t],
  );

  const emptyState = (
    <YStack
      padding={48}
      alignItems="center"
      justifyContent="center"
      gap={12}
      borderWidth={2}
      borderColor="$borderColor"
      borderStyle="dashed"
    >
      <MessageSquareWarning size={32} color={theme.colorMuted?.val} />
      <Text variant="body" tone="muted">
        {String(t("admin.rmNoReviews"))}
      </Text>
      <Text variant="caption" tone="muted">
        {String(t("admin.rmAdjustFilter"))}
      </Text>
    </YStack>
  );

  if (error) {
    return (
      <PlatformContainer>
        <YStack gap="$3">
          <Text variant="body" tone="error">
            {String(
              t("admin.rmFailedToLoad", { error: formatErrorMessage(error) }),
            )}
          </Text>
          <Button variant="secondary" size="$2" onPress={() => refetch()}>
            {String(t("admin.rmRetry"))}
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
          <MessageSquareWarning size={20} color={theme.color?.val} />
          <Text variant="h2" tag="h1" weight="bold">
            {String(t("admin.rmTitle"))}
          </Text>
        </XStack>
        <Text variant="body" tone="muted">
          {String(t("admin.rmSubtitle"))}
        </Text>
      </YStack>

      {/* Filters */}
      <XStack gap={12} alignItems="center" flexWrap="wrap">
        <TextInput
          width={280}
          value={venueSearch}
          onChangeText={setVenueSearch}
          placeholder={t("admin.rmSearchPlaceholder") as string}
        />

        <PlatformFilterBar>
          <FilterChips<ModerationFilter>
            options={(Object.keys(FILTER_LABEL_KEY) as ModerationFilter[]).map(
              (key) => ({
                value: key,
                label: String(t(FILTER_LABEL_KEY[key])),
              }),
            )}
            selected={filter}
            onSelect={(v) => setFilter(v ?? "all")}
          />
        </PlatformFilterBar>

        <Button
          variant="ghost"
          size="$2"
          icon
          onPress={() => refetch()}
          aria-label={t("admin.rmRefresh") as string}
        >
          <RefreshCw size={15} />
        </Button>

        {data && (
          <Text variant="caption" tone="muted">
            {String(t("admin.rmReviewCount", { count: data.total }))}
          </Text>
        )}
      </XStack>

      {/* Table — the 640px table floor drops only below useIsMobile's 600px
          breakpoint, the same breakpoint DataTable uses for card mode, so the
          page never overflows horizontally on phones. */}
      <YStack flex={1} minWidth={isMobile ? 0 : 640}>
        <DataTable
          columns={columns}
          rows={rows}
          getRowKey={(row) => row.id}
          isLoading={isLoading}
          emptyState={emptyState}
          sort={sort}
          onSortChange={setSort}
          // Borderless page-flow table with no scrolling ancestor —
          // scoped horizontal panning via DataTable's own wrapper.
          scrollContainer
          rowActions={rowActions}
          onRowPress={(row) => setSelectedReview(row)}
          // Card mode drops rowActions, and the detail panel opened by the
          // card press has no hide/unhide — so the moderation action is
          // surfaced directly on the card.
          renderMobileCard={(row) => (
            <ReviewMobileCard
              row={row}
              onToggleHidden={() =>
                row.hidden ? handleUnhide(row.id) : handleHide(row.id)
              }
              isMutating={hideMut.isPending || unhideMut.isPending}
            />
          )}
          testIdBase="platform-reviews-table"
        />
      </YStack>

      {/* Detail panel */}
      {selectedReview && (
        <ReviewDetailPanel
          review={selectedReview}
          onClose={() => setSelectedReview(null)}
          onReviewUpdated={() =>
            void utils.placeReviews.listPlatform.invalidate()
          }
        />
      )}
    </PlatformContainer>
  );
}
