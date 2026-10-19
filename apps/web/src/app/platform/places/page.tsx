"use client";

import { useMemo, useState, useCallback, useEffect, useRef } from "react";
import { ConfirmDialog } from "@/components/data-table/ConfirmDialog";
import { useTheme, YStack, XStack, Stack } from "tamagui";
import {
  PlatformContainer,
  PlatformFilterBar,
} from "../_components/PlatformPageParts";
import {
  DataTable,
  type DataTableColumn,
  type DataTableSortState,
  Button,
  Modal,
  Text,
  Tooltip,
  useNotify,
} from "@th/ui";
import {
  MapPin,
  ShieldCheck,
  ShieldX,
  Users,
  Eye,
  BookOpen,
  BookX,
  Upload,
  Archive,
  Trash2,
  RefreshCw,
} from "lucide-react";
import { keepPreviousData } from "@tanstack/react-query";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";
import { VERIFICATION_ICON_MAP } from "@/lib/verification-config";
import { useTranslations } from "@th/ui";
import { authClient } from "@/lib/auth/auth-client";
import { buildFreshClientKey } from "@/lib/crypto-utils";

import {
  ActionBar,
  TableContainer,
  SearchBar,
  Pagination,
  NoResults,
  ColumnSelector,
  FilterChips,
  type ColumnOption,
} from "@/components/AdminTableParts";
import { useAdminTableParams } from "@/hooks/useAdminTableParams";
import { useColumnVisibility } from "@/hooks/useColumnVisibility";
import { useIsMobile } from "@/hooks/useIsMobile";

import {
  CsvImportDialog,
  type CsvImportResult,
} from "../../admin/[slug]/_components/CsvImportDialog";
import { PLACE_IMPORT_FIELDS } from "@/lib/place-import-fields";
import { buildPlaceCsvAddress } from "@/lib/place-csv-address";
import {
  VerificationReviewDetail,
  type ReviewContext,
} from "./_components/VerificationReviewDetail";
import { PlaceDetailPanel } from "./_components/PlaceDetailPanel";
import { PlatformVerificationQueue } from "./_components/PlatformVerificationQueue";
import {
  type PlaceStatus,
  type PlaceStatusFilter,
  type PlaceVerificationStatus,
  type VerificationFilter,
  type PlatformPlaceRow,
} from "./_components/types";
import {
  PlatformPlaceMobileCard,
  PlaceArchivedBadge,
  PlaceVerificationBadge,
  PlaceDirectoryBadge,
  buildLocationString,
} from "./_components/PlatformPlaceMobileCard";
import { pruneSelection } from "./_lib/prune-selection";

type TopTab = "queue" | "all" | "directory";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const FILTER_TO_STATUS: Record<
  VerificationFilter,
  PlaceVerificationStatus[] | undefined
> = {
  all: undefined,
  pending: ["PENDING"],
  unverified: ["UNVERIFIED"],
  verified: ["VERIFIED"],
  rejected: ["REJECTED"],
};

const FILTER_LABEL_KEY: Record<VerificationFilter, string> = {
  all: "admin.ppFilterAll",
  pending: "admin.ppPending",
  unverified: "admin.ppUnverified",
  verified: "admin.ppVerified",
  rejected: "admin.ppRejected",
};

const VERIFICATION_FILTERS = Object.keys(
  FILTER_LABEL_KEY,
) as VerificationFilter[];

/** The `?filter=` param. Absent means "pending" (the default view). */
const FILTER_PARAM = "filter";
/** The `?status=` param. Absent means "active" (like the owner's Places page). */
const STATUS_PARAM = "status";
const TABLE_PARAM_EXTRA_KEYS = [FILTER_PARAM, STATUS_PARAM];

/** URL contract: no `?filter=`, or an unknown value, means "pending". */
function parseVerificationFilter(raw: string | undefined): VerificationFilter {
  return VERIFICATION_FILTERS.find((f) => f === raw) ?? "pending";
}

/** Lifecycle chips → `listPlaces.status`. SUSPENDED rides with Active. */
const STATUS_FILTER_TO_STATUS: Record<
  PlaceStatusFilter,
  PlaceStatus[] | undefined
> = {
  active: ["ACTIVE", "SUSPENDED"],
  archived: ["ARCHIVED"],
  all: undefined,
};

const STATUS_FILTER_LABEL_KEY: Record<PlaceStatusFilter, string> = {
  active: "admin.ppDetailStatusActive",
  archived: "admin.ppDetailStatusArchived",
  all: "admin.ppFilterAll",
};

const STATUS_FILTERS = Object.keys(
  STATUS_FILTER_LABEL_KEY,
) as PlaceStatusFilter[];

/** URL contract: no `?status=`, or an unknown value, means "active". */
function parseStatusFilter(raw: string | undefined): PlaceStatusFilter {
  return STATUS_FILTERS.find((f) => f === raw) ?? "active";
}

// ─────────────────────────────────────────────────────────────────────────────
// Column IDs & options
// ─────────────────────────────────────────────────────────────────────────────

const ALL_COL_IDS = [
  "name",
  "verificationStatus",
  "ownerCount",
  "capacity",
  "listedInDirectory",
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export default function PlatformPlacesPage() {
  const utils = trpc.useUtils();
  const theme = useTheme();
  const t = useTranslations();
  const { toast } = useNotify();
  const { data: session } = authClient.useSession();
  const isMobile = useIsMobile();

  // ── Search / pagination / status filter (URL-synced) ─────────────────
  const {
    searchQuery,
    debouncedSearch,
    page,
    pageSize,
    extra,
    handleSearchChange,
    setPage,
    setPageSize,
    setExtra,
  } = useAdminTableParams({ extraKeys: TABLE_PARAM_EXTRA_KEYS });

  // Owned by the table-params hook, like `?q=`/`?p=`/`?ps=`: the hook reads
  // `?filter=` once at mount and from then on its state is the source of
  // truth, written back to the URL. A later URL change while the page stays
  // mounted (e.g. the sidebar "Places" link from `?filter=verified`) does
  // NOT reset the filter, same as the other table params.
  //
  // It used to be a separate useState plus an effect copying `?filter=` into
  // it. `router.replace` updates `useSearchParams` only when its navigation
  // Transition commits, so that effect saw the old URL and reverted a click
  // to "pending" in the meantime; and when the click also reset the page,
  // the hook wrote the reset from that stale URL after the click's write,
  // dropping the filter for good. One owner, one writer.
  const filter = parseVerificationFilter(extra[FILTER_PARAM]);
  const statusFilter = parseStatusFilter(extra[STATUS_PARAM]);

  // ── Column visibility ────────────────────────────────────────────────
  const columnOptions: ColumnOption[] = useMemo(
    () => [
      { id: "name", label: String(t("admin.ppPlace")) },
      { id: "verificationStatus", label: String(t("admin.ppVerification")) },
      { id: "ownerCount", label: String(t("admin.ppOwners")) },
      { id: "capacity", label: String(t("admin.ppCapacity")) },
      { id: "listedInDirectory", label: String(t("admin.ppDirectory")) },
    ],
    [t],
  );
  const colVis = useColumnVisibility("platform-places-columns", ALL_COL_IDS);

  // ── Local state ──────────────────────────────────────────────────────
  const [topTab, setTopTab] = useState<TopTab>("queue");
  const [sort, setSort] = useState<DataTableSortState>({
    columnId: "name",
    direction: "asc",
  });
  const [reviewPlace, setReviewPlace] = useState<PlatformPlaceRow | null>(null);
  const [detailPlace, setDetailPlace] = useState<PlatformPlaceRow | null>(null);
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [showBulkDeleteConfirm, setShowBulkDeleteConfirm] = useState(false);

  // The hook resets the page on a changed filter, and builds every URL
  // write from its own state, so `?filter=` survives the reset.
  const setFilterAndUrl = useCallback(
    (nextFilter: VerificationFilter) => {
      setExtra(FILTER_PARAM, nextFilter === "pending" ? undefined : nextFilter);
    },
    [setExtra],
  );
  const setStatusFilterAndUrl = useCallback(
    (next: PlaceStatusFilter) => {
      setExtra(STATUS_PARAM, next === "active" ? undefined : next);
    },
    [setExtra],
  );

  // ── Mutations ────────────────────────────────────────────────────────
  const toggleDirectoryMut =
    trpc.placeReviews.toggleDirectoryListing.useMutation({
      onSuccess: () => void utils.platform.listPlaces.invalidate(),
    });

  const bulkArchiveMutation = trpc.places.bulkArchivePlaces.useMutation({
    onSuccess: (data) => {
      toast.success({
        title: String(
          t("admin.ppBulkArchiveSuccess", { count: data.archived }),
        ),
      });
      setSelectedKeys(new Set());
      void utils.platform.listPlaces.invalidate();
    },
    onError: (err) => {
      toast.danger({
        title: String(t("admin.ppBulkArchiveFailed")),
        message: formatErrorMessage(err, t),
      });
    },
  });

  const bulkDeleteMutation = trpc.platform.adminBulkDeletePlaces.useMutation({
    onSuccess: (data) => {
      toast.success({
        title: String(t("admin.ppBulkDeleteSuccess", { count: data.deleted })),
      });
      setSelectedKeys(new Set());
      void utils.platform.listPlaces.invalidate();
    },
    onError: (err) => {
      toast.danger({
        title: String(t("admin.ppBulkDeleteFailed")),
        message: formatErrorMessage(err, t),
      });
    },
  });

  const bulkImportMutation = trpc.places.bulkImportPlaces.useMutation({
    meta: { silent: true },
  });

  const reindexMutation = trpc.platformJobs.runJob.useMutation({
    onSuccess: () => {
      toast.success({ title: String(t("admin.ppReindexQueued")) });
    },
    onError: (err) => {
      toast.danger({
        title: String(t("admin.ppReindexFailed")),
        message: formatErrorMessage(err, t),
      });
    },
  });

  const approveMut = trpc.platform.updatePlaceVerificationStatus.useMutation({
    onSuccess: () => {
      toast.success({ title: String(t("admin.ppApproveSuccess")) });
      void utils.platform.listPlaces.invalidate();
    },
    onError: (err) => {
      toast.danger({
        title: String(t("admin.ppApproveFailed")),
        message: formatErrorMessage(err, t),
      });
    },
  });

  // ── Query ────────────────────────────────────────────────────────────
  const listInput = useMemo(
    () => ({
      limit: pageSize,
      offset: page * pageSize,
      query: debouncedSearch || undefined,
      verificationStatus: FILTER_TO_STATUS[filter],
      status: STATUS_FILTER_TO_STATUS[statusFilter],
    }),
    [debouncedSearch, filter, statusFilter, page, pageSize],
  );

  const { data, isLoading, isFetching, error, refetch } =
    trpc.platform.listPlaces.useQuery(listInput, {
      staleTime: 30_000,
      placeholderData: keepPreviousData,
    });

  // Reset selection when filters/search/page change
  useEffect(() => {
    setSelectedKeys(new Set());
  }, [debouncedSearch, filter, statusFilter, page, pageSize]);

  // Drop selected keys whose rows left the loaded page: an approve, reject,
  // unlist or detail-panel edit (or another admin's change) refetches a row
  // out of the current filter while its key stayed selected, unseen but
  // still counted by the bulk bar and sent by bulk archive/delete. Pruned
  // against the server page; the client-sorted `rows` hold the same keys.
  // During a `keepPreviousData` page/filter load `data` is the previous
  // page, which is harmless: the reset above has already emptied the
  // selection, and anything ticked on the placeholder rows is pruned when
  // the new page lands. `pruneSelection` returns `prev` when nothing left,
  // so the updater bails out with no re-render.
  const loadedPlaces = data?.places;
  useEffect(() => {
    if (!loadedPlaces) return;
    const loadedKeys = loadedPlaces.map((p) => p.placeId);
    setSelectedKeys((prev) => pruneSelection(prev, loadedKeys));
  }, [loadedPlaces]);

  // A prune (or any other path) can empty the selection while "Delete
  // selected" is open; the dialog would then offer to delete 0 places and the
  // server rejects an empty list. Close it, so it can't reappear on the next
  // tick either. The dialog's `open` is also gated on a non-empty selection
  // so the "delete 0" frame never paints before this effect runs.
  useEffect(() => {
    if (selectedKeys.size === 0) setShowBulkDeleteConfirm(false);
  }, [selectedKeys]);

  // ── Sorted rows (client-side sort within current page) ───────────────
  const rows: PlatformPlaceRow[] = useMemo(() => {
    const all = data?.places ?? [];
    const sorted = [...all];
    const { columnId, direction } = sort;
    const multiplier = direction === "asc" ? 1 : -1;

    sorted.sort((a, b) => {
      let aVal: string | number;
      let bVal: string | number;

      switch (columnId) {
        case "name":
          aVal = a.name.toLowerCase();
          bVal = b.name.toLowerCase();
          break;
        case "verificationStatus":
          aVal = a.verificationStatus;
          bVal = b.verificationStatus;
          break;
        case "ownerCount":
          aVal = a.ownerCount;
          bVal = b.ownerCount;
          break;
        case "capacity":
          aVal = a.capacity ?? 0;
          bVal = b.capacity ?? 0;
          break;
        default:
          return 0;
      }

      if (aVal < bVal) return -1 * multiplier;
      if (aVal > bVal) return 1 * multiplier;
      return 0;
    });

    return sorted;
  }, [data?.places, sort]);

  // ── Pagination info ──────────────────────────────────────────────────
  const totalRows = data?.pageInfo?.total ?? 0;
  const totalPages = Math.ceil(totalRows / pageSize);
  const hasActiveSearch = debouncedSearch.length > 0;

  const summaryLabel = useMemo(() => {
    if (!data?.pageInfo || totalRows === 0) return undefined;
    const start = page * pageSize + 1;
    const end = Math.min((page + 1) * pageSize, totalRows);
    return `${start}\u2013${end} of ${totalRows}`;
  }, [data?.pageInfo, totalRows, page, pageSize]);

  // Hold the last non-undefined label so it doesn't flash blank during
  // background refetches (keepPreviousData means data stays but the
  // count can snap when switching filters or pages).
  const stableLabelRef = useRef<string | undefined>(undefined);
  if (!isFetching && summaryLabel !== undefined) {
    stableLabelRef.current = summaryLabel;
  }
  const displayLabel = isFetching ? stableLabelRef.current : summaryLabel;

  // ── Handlers ─────────────────────────────────────────────────────────
  const handleDecisionMade = useCallback(async () => {
    await utils.platform.listPlaces.invalidate();
  }, [utils.platform.listPlaces]);

  const handleRowPress = useCallback((row: PlatformPlaceRow) => {
    setDetailPlace(row);
  }, []);

  // ── CSV import ───────────────────────────────────────────────────────
  const handleCsvImport = useCallback(
    async (csvRows: Record<string, string>[]): Promise<CsvImportResult> => {
      const BATCH_SIZE = 500;
      const mapped = csvRows.map((row) => ({
        name: row.name,
        address: {
          // Shared with the org-admin importer. `line1` is now simply absent
          // when the row has no street address instead of being filled with
          // the literal "TBD" that used to persist to `Place.addrLine1` and
          // render as the venue's street on its public page.
          ...buildPlaceCsvAddress(row),
          lat: row.lat
            ? isNaN(parseFloat(row.lat))
              ? undefined
              : parseFloat(row.lat)
            : undefined,
          lng: row.lng
            ? isNaN(parseFloat(row.lng))
              ? undefined
              : parseFloat(row.lng)
            : undefined,
        },
        // NO owner. A bulk-imported venue is scraped, not operated by the staff
        // human running the import — it must land UNOWNED so
        // `getPlaceClaimEligibility` keeps it `claimable` for the venue's real
        // operator instead of routing them to the dispute path.
        capacity: row.capacity
          ? parseInt(row.capacity, 10) || undefined
          : undefined,
        phone: row.phone || undefined,
        website: row.website || undefined,
        listedInDirectory: true,
      }));

      let totalCreated = 0;
      for (let i = 0; i < mapped.length; i += BATCH_SIZE) {
        const batch = mapped.slice(i, i + BATCH_SIZE);
        const batchResult = await bulkImportMutation.mutateAsync({
          places: batch,
        });
        totalCreated += batchResult.created;
      }

      void utils.platform.listPlaces.invalidate();
      return { total: mapped.length, imported: totalCreated, skipped: 0 };
    },
    [bulkImportMutation, utils.platform.listPlaces],
  );

  // ── Columns ──────────────────────────────────────────────────────────
  const columns: DataTableColumn<PlatformPlaceRow>[] = useMemo(
    () => [
      {
        id: "name",
        header: String(t("admin.ppPlace")),
        width: 3,
        cell: (row) => {
          const location = buildLocationString(row);
          return (
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
                {row.name}
              </Text>
              {location || row.status === "ARCHIVED" ? (
                <XStack gap="$2" alignItems="center" minWidth={0}>
                  {location ? (
                    <XStack
                      gap="$1"
                      alignItems="center"
                      opacity={0.7}
                      flexShrink={1}
                      minWidth={0}
                    >
                      <MapPin size={11} style={{ flexShrink: 0 }} />
                      <Text
                        variant="caption"
                        tone="muted"
                        style={{
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {location}
                      </Text>
                    </XStack>
                  ) : null}
                  {row.status === "ARCHIVED" ? (
                    <XStack flexShrink={0}>
                      <PlaceArchivedBadge />
                    </XStack>
                  ) : null}
                </XStack>
              ) : null}
            </YStack>
          );
        },
      },
      {
        id: "verificationStatus",
        header: String(t("admin.ppVerification")),
        // Widths are shares of the table. At 1280 the old 1.2 / 0.9 shares
        // clipped VERIFICATION, CAPACITY and DIRECTORY while the actions
        // column (at most two 32px icon buttons) took 165px; the shares
        // below move that slack to the headers.
        width: 1.4,
        cell: (row) => {
          const v = VERIFICATION_ICON_MAP[row.verificationStatus];
          return (
            <XStack gap="$2" alignItems="center">
              <v.Icon size={14} color={theme[v.themeKey]?.val} />
              <PlaceVerificationBadge status={row.verificationStatus} />
            </XStack>
          );
        },
      },
      {
        id: "ownerCount",
        header: String(t("admin.ppOwners")),
        width: 1,
        align: "right",
        cell: (row) => (
          <XStack gap="$1" alignItems="center" justifyContent="flex-end">
            <Users size={13} style={{ opacity: 0.5 }} />
            <Text variant="body">{row.ownerCount}</Text>
          </XStack>
        ),
      },
      {
        id: "capacity",
        header: String(t("admin.ppCapacity")),
        width: 1,
        align: "right",
        cell: (row) => (
          <Text variant="body" tone={row.capacity ? undefined : "muted"}>
            {row.capacity ? row.capacity.toLocaleString() : "\u2014"}
          </Text>
        ),
      },
      {
        id: "listedInDirectory",
        header: String(t("admin.ppDirectory")),
        width: 1.1,
        cell: (row) => {
          const listed = row.listedInDirectory;
          return (
            <XStack gap="$1" alignItems="center">
              {listed ? (
                <BookOpen size={14} color={theme.success?.val} />
              ) : (
                <BookX size={14} color={theme.colorMuted?.val} />
              )}
              <PlaceDirectoryBadge listed={listed} />
            </XStack>
          );
        },
      },
    ],
    [t, theme],
  );

  const visibleColumns = useMemo(
    () => columns.filter((c) => colVis.isVisible(c.id)),
    [columns, colVis.isVisible],
  );

  // ── Row actions ──────────────────────────────────────────────────────
  const rowActions = useMemo(
    () => ({
      header: "",
      width: 0.9,
      render: (row: PlatformPlaceRow) => {
        const canReview = row.verificationStatus === "PENDING";
        // An archived place is not up for verification (the panel hides
        // its Verification section too).
        const archived = row.status === "ARCHIVED";
        const canApprove = row.verificationStatus === "UNVERIFIED" && !archived;
        return (
          <XStack gap="$2" justifyContent="flex-end">
            {/* An archived place is out of the directory's reach (it lists
                ACTIVE places only), so its list/unlist toggle is hidden. */}
            {!archived && (
              <Tooltip
                anchor={
                  <Button
                    variant="ghost"
                    size="$2"
                    icon
                    onPress={(e: { stopPropagation?: () => void }) => {
                      e?.stopPropagation?.();
                      toggleDirectoryMut.mutate({
                        placeId: row.placeId,
                        listedInDirectory: !row.listedInDirectory,
                      });
                    }}
                    disabled={toggleDirectoryMut.isPending}
                    aria-label={
                      row.listedInDirectory
                        ? String(t("admin.ppUnlist"))
                        : String(t("admin.ppList"))
                    }
                  >
                    {row.listedInDirectory ? (
                      <BookX size={14} />
                    ) : (
                      <BookOpen size={14} />
                    )}
                  </Button>
                }
                placement="top"
              >
                {row.listedInDirectory
                  ? String(t("admin.ppUnlist"))
                  : String(t("admin.ppList"))}
              </Tooltip>
            )}
            {canApprove && (
              <Tooltip
                anchor={
                  <Button
                    variant="ghost"
                    size="$2"
                    icon
                    onPress={(e: { stopPropagation?: () => void }) => {
                      e?.stopPropagation?.();
                      approveMut.mutate({
                        placeId: row.placeId,
                        verificationStatus: "VERIFIED",
                        clientKey: buildFreshClientKey(),
                      });
                    }}
                    disabled={approveMut.isPending}
                    aria-label={String(t("admin.ppApprove"))}
                  >
                    <ShieldCheck size={14} />
                  </Button>
                }
                placement="top"
              >
                {String(t("admin.ppApprove"))}
              </Tooltip>
            )}
            {canReview && (
              <Tooltip
                anchor={
                  <Button
                    variant="ghost"
                    size="$2"
                    icon
                    onPress={(e: { stopPropagation?: () => void }) => {
                      e?.stopPropagation?.();
                      setReviewPlace(row);
                    }}
                    aria-label={String(t("admin.ppReview"))}
                  >
                    <Eye size={14} />
                  </Button>
                }
                placement="top"
              >
                {String(t("admin.ppReview"))}
              </Tooltip>
            )}
            {row.verificationStatus === "VERIFIED" && (
              <Stack paddingHorizontal={6} paddingVertical={4}>
                <ShieldCheck size={15} color={theme.success?.val} />
              </Stack>
            )}
            {row.verificationStatus === "REJECTED" && (
              <Stack paddingHorizontal={6} paddingVertical={4}>
                <ShieldX size={15} color={theme.danger?.val} />
              </Stack>
            )}
          </XStack>
        );
      },
    }),
    [toggleDirectoryMut, approveMut, theme, t],
  );

  // ── Empty state (skeleton + overlay) ─────────────────────────────────
  // `alignSelf="stretch"`: DataTable centres the empty state in a column
  // with `alignItems="center"`, which shrinks this box to its intrinsic
  // width. The ghost bars are flex-sized with no intrinsic width, so that
  // came to just the rows' padding and gaps (64px): 0px bars, and an overlay
  // heading spilling out of a 64px box. Stretch fills the cell instead.
  const emptyState = (
    <YStack position="relative" minHeight={320} alignSelf="stretch">
      {/* Ghost rows */}
      <YStack opacity={0.4}>
        {Array.from({ length: 4 }).map((_, i) => (
          <XStack
            key={i}
            paddingHorizontal="$4"
            paddingVertical="$3"
            borderBottomWidth={i < 3 ? 1 : 0}
            borderBottomColor="$borderColor"
            gap="$4"
          >
            <YStack
              flex={3}
              height={14}
              backgroundColor="$surfaceMuted"
              borderRadius={0}
            />
            <YStack
              flex={1}
              height={14}
              backgroundColor="$surfaceMuted"
              borderRadius={0}
            />
            <YStack
              flex={0.7}
              height={14}
              backgroundColor="$surfaceMuted"
              borderRadius={0}
            />
          </XStack>
        ))}
      </YStack>

      {/* Overlay */}
      <YStack
        position="absolute"
        top={0}
        left={0}
        right={0}
        bottom={0}
        alignItems="center"
        justifyContent="center"
        gap="$3"
        zIndex={1}
      >
        <MapPin size={32} color={theme.colorMuted?.val} />
        <Text variant="h4" weight="bold" textAlign="center">
          {filter === "pending"
            ? String(t("admin.ppNoPendingRequests"))
            : String(
                t("admin.ppNoPlacesFound", {
                  status: String(t(FILTER_LABEL_KEY[filter])).toLowerCase(),
                }),
              )}
        </Text>
        {hasActiveSearch && (
          <Text variant="body" tone="muted" textAlign="center">
            {String(t("admin.ppAdjustSearch"))}
          </Text>
        )}
      </YStack>
    </YStack>
  );

  // ── Error state ──────────────────────────────────────────────────────
  if (error) {
    return (
      <PlatformContainer>
        <YStack gap="$3">
          <Text variant="body" tone="error">
            {String(
              t("admin.ppFailedToLoad", {
                error: formatErrorMessage(error, t),
              }),
            )}
          </Text>
          <Button variant="secondary" size="$2" onPress={() => refetch()}>
            {String(t("admin.ppRetry"))}
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
          <MapPin size={20} color={theme.color?.val} />
          <Text
            variant="h2"
            tag="h1"
            weight="bold"
            // $xs: at 320px the 40px h1 is wider than the ~190px box beside
            // the icon. Step down so "VERIFICATION" fits whole, and let the
            // heading wrap instead of overflowing.
            $xs={{ fontSize: "$5", lineHeight: "$5" }}
            flexShrink={1}
            minWidth={0}
            style={{ overflowWrap: "break-word" }}
          >
            {String(t("admin.ppTitle"))}
          </Text>
        </XStack>
        <Text variant="body" tone="muted">
          {String(t("admin.ppSubtitle"))}
        </Text>
      </YStack>

      {/* Top-level tab nav: Queue / All Places / Directory. The Queue tab
				uses the new platform verification workbench (acknowledge / approve /
				reject / release). The other two stay on the existing place listing. */}
      <XStack
        gap={4}
        flexWrap="wrap"
        borderBottomWidth={2}
        borderBottomColor="$borderColor"
      >
        {(["queue", "all", "directory"] as TopTab[]).map((tab) => (
          <Button
            key={tab}
            size="$2"
            variant={topTab === tab ? "primary" : "ghost"}
            onPress={() => {
              setTopTab(tab);
              if (tab === "directory") {
                setFilterAndUrl("verified");
              }
            }}
          >
            {tab === "queue"
              ? "Queue"
              : tab === "all"
                ? "All Places"
                : "Directory"}
          </Button>
        ))}
      </XStack>

      {topTab === "queue" ? (
        <PlatformVerificationQueue
          actorHumanId={session?.user?.id}
          onSelectPlace={setDetailPlace}
        />
      ) : (
        <>
          {/* Search + filters */}
          <XStack gap={12} alignItems="center" flexWrap="wrap">
            <SearchBar
              value={searchQuery}
              onChangeText={handleSearchChange}
              placeholder={t("admin.ppSearchPlaceholder") as string}
              testId="platform-places-search"
            />

            <PlatformFilterBar>
              <FilterChips<VerificationFilter>
                options={(
                  Object.keys(FILTER_LABEL_KEY) as VerificationFilter[]
                ).map((key) => ({
                  value: key,
                  label: String(t(FILTER_LABEL_KEY[key])),
                }))}
                selected={filter}
                onSelect={(v) => setFilterAndUrl(v ?? "all")}
                ariaLabel={String(t("admin.ppVerification"))}
              />
              {/* Two groups, two names: both carry an "All" chip. */}
              <FilterChips<PlaceStatusFilter>
                icon={
                  <Stack
                    width={2}
                    height={20}
                    backgroundColor="$borderColor"
                    marginHorizontal="$1"
                    aria-hidden
                  />
                }
                options={STATUS_FILTERS.map((key) => ({
                  value: key,
                  label: String(t(STATUS_FILTER_LABEL_KEY[key])),
                }))}
                selected={statusFilter}
                // A single-select scope: pressing the lit chip keeps it.
                onSelect={(v) => setStatusFilterAndUrl(v ?? statusFilter)}
                ariaLabel={String(t("admin.ppStatusFilter"))}
              />
            </PlatformFilterBar>
          </XStack>

          {/* Table area — the 640px table floor drops only below
              useIsMobile's 600px breakpoint, the same breakpoint DataTable
              uses for card mode, so the page never pans horizontally on
              phones. */}
          <YStack flex={1} minWidth={isMobile ? 0 : 640} minHeight={400}>
            {selectedKeys.size > 0 ? (
              <ActionBar
                onRefresh={() => refetch()}
                countLabel={String(
                  t("admin.ppSelectedCount", { count: selectedKeys.size }),
                )}
              >
                <Button
                  size="$2"
                  variant="ghost"
                  onPress={() => setSelectedKeys(new Set())}
                  paddingHorizontal="$3"
                >
                  {String(t("admin.ppDeselectAll"))}
                </Button>
                <Button
                  size="$2"
                  variant="secondary"
                  onPress={() => {
                    bulkArchiveMutation.mutate({ placeIds: [...selectedKeys] });
                  }}
                  disabled={bulkArchiveMutation.isPending}
                  paddingHorizontal="$3"
                >
                  <Archive size={14} aria-hidden />
                  {String(t("admin.ppArchiveSelected"))}
                </Button>
                <Button
                  size="$2"
                  variant="destructive"
                  onPress={() => setShowBulkDeleteConfirm(true)}
                  disabled={bulkDeleteMutation.isPending}
                  paddingHorizontal="$3"
                >
                  <Trash2 size={14} aria-hidden />
                  {String(t("admin.ppDeleteSelected"))}
                </Button>
              </ActionBar>
            ) : (
              <ActionBar onRefresh={() => refetch()} countLabel={displayLabel}>
                <Button
                  size="$2"
                  variant="ghost"
                  onPress={() => setShowImportDialog(true)}
                  paddingHorizontal="$3"
                  data-testid="platform-places-csv-import"
                >
                  <Upload size={14} aria-hidden />
                  {String(t("admin.ppImportCsv"))}
                </Button>
                <Button
                  size="$2"
                  variant="ghost"
                  onPress={() =>
                    reindexMutation.mutate({ name: "search.full-reindex" })
                  }
                  disabled={reindexMutation.isPending}
                  paddingHorizontal="$3"
                  data-testid="platform-places-reindex"
                >
                  <RefreshCw size={14} aria-hidden />
                  {String(t("admin.ppReindexSearch"))}
                </Button>
                <ColumnSelector
                  options={columnOptions}
                  isVisible={colVis.isVisible}
                  onToggle={colVis.toggleColumn}
                  onShowAll={colVis.showAll}
                  hasHidden={colVis.hasHidden}
                />
              </ActionBar>
            )}

            <TableContainer>
              <DataTable
                columns={visibleColumns}
                rows={rows}
                getRowKey={(row) => row.placeId}
                isLoading={isLoading}
                emptyState={
                  hasActiveSearch ? (
                    <NoResults
                      title={String(t("admin.ppNoPlacesFound", { status: "" }))}
                      description={String(t("admin.ppAdjustSearch"))}
                      onClearFilters={() => handleSearchChange("")}
                    />
                  ) : (
                    emptyState
                  )
                }
                sort={sort}
                onSortChange={setSort}
                onRowPress={handleRowPress}
                rowActions={rowActions}
                // Card mode (<600px). rowActions are not rendered as cards,
                // but every action stays reachable: pressing a card opens the
                // same PlaceDetailPanel as a table row press, and the panel
                // carries the directory toggle, approve (UNVERIFIED), and
                // open-review (PENDING) actions. Selection checkboxes still
                // render on cards, so bulk archive/delete keep working.
                renderMobileCard={(row) => (
                  <PlatformPlaceMobileCard row={row} />
                )}
                selectable={{
                  selectedKeys,
                  onSelectionChange: setSelectedKeys,
                  // Touch surface: card mode makes the checkbox itself the
                  // tap target, so use the large size per DataTable's docs.
                  checkboxSize: "lg",
                }}
                testIdBase="platform-places-table"
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
        </>
      )}

      {/* Place detail panel. The row it shows follows the loaded page, so
          a directory toggle or an edit made in the panel shows there. */}
      {detailPlace && (
        <PlaceDetailPanel
          place={
            loadedPlaces?.find((p) => p.placeId === detailPlace.placeId) ??
            detailPlace
          }
          open={!!detailPlace}
          onClose={() => setDetailPlace(null)}
          onMutated={() => void utils.platform.listPlaces.invalidate()}
          onOpenReview={(p) => {
            setDetailPlace(null);
            setReviewPlace(p);
          }}
          onOpenPlace={setDetailPlace}
        />
      )}

      {/* Verification review — consolidated, lock-aware flow. Resolves the
          request by placeId (table rows carry no requestId) and writes only
          through trpc.places.*. */}
      {reviewPlace && (
        <Modal open={!!reviewPlace} onClose={() => setReviewPlace(null)}>
          <Modal.Panel width={640}>
            <Modal.Header
              title={String(t("admin.vqReviewTitle"))}
              subtitle={reviewPlace.name}
              onClose={() => setReviewPlace(null)}
            />
            <Modal.Body>
              <VerificationReviewDetail
                placeId={reviewPlace.placeId}
                actorHumanId={session?.user?.id}
                context={
                  {
                    placeName: reviewPlace.name,
                    address: reviewPlace.formattedAddress,
                    city: reviewPlace.city,
                    region: reviewPlace.region,
                    countryCode: reviewPlace.countryCode,
                    capacity: reviewPlace.capacity,
                    ownerCount: reviewPlace.ownerCount,
                    website: null,
                    phone: null,
                    submitterName: null,
                    submittedAt: null,
                    status:
                      reviewPlace.verificationStatus === "PENDING"
                        ? "PENDING"
                        : null,
                    acknowledgerHumanId: null,
                    acknowledgerName: null,
                    reviewerName: null,
                    reviewedAt: null,
                  } satisfies ReviewContext
                }
                onDecided={() => {
                  void handleDecisionMade();
                  setReviewPlace(null);
                }}
                onClose={() => setReviewPlace(null)}
              />
            </Modal.Body>
          </Modal.Panel>
        </Modal>
      )}

      {/* CSV Import dialog */}
      <CsvImportDialog
        open={showImportDialog}
        onClose={() => setShowImportDialog(false)}
        fields={PLACE_IMPORT_FIELDS}
        onSubmit={handleCsvImport}
        title={String(t("admin.ppImportTitle"))}
        description={String(t("admin.ppImportDescription"))}
      />

      {/* Bulk delete confirmation */}
      <ConfirmDialog
        open={showBulkDeleteConfirm && selectedKeys.size > 0}
        onConfirm={() => {
          if (selectedKeys.size === 0) {
            setShowBulkDeleteConfirm(false);
            return;
          }
          bulkDeleteMutation.mutate(
            { placeIds: [...selectedKeys] },
            { onSettled: () => setShowBulkDeleteConfirm(false) },
          );
        }}
        onCancel={() => setShowBulkDeleteConfirm(false)}
        title={String(t("admin.ppDeleteSelected"))}
        description={String(
          t("admin.ppBulkDeleteConfirm", { count: selectedKeys.size }),
        )}
        confirmLabel={String(t("admin.ppDeleteSelected"))}
        tone="danger"
        loading={bulkDeleteMutation.isPending}
      />
    </PlatformContainer>
  );
}
