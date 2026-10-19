"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname } from "next/navigation";
import { XStack, YStack } from "tamagui";
import {
  Button,
  DataTable,
  type DataTableColumn,
  Modal,
  NextLinkAnchor,
  StyledSelect,
  Text,
  TextInput,
  useFormatters,
  useNotify,
  useTranslations,
} from "@th/ui";
import { CalendarRange } from "lucide-react";
import { nanoid } from "nanoid";

import { EventStatusBadge } from "@/app/admin/[slug]/events/_components/EventStatusBadge";
import { eventPublicLink } from "@/app/admin/[slug]/events/new/_components/event-public-link.helpers";
import {
  buildEnrollTwoFactorUrl,
  useSecondFactorRequiredToast,
} from "@/components/community/use-second-factor-required-toast";
import { useEventOwnerEntities } from "@/hooks/useEventOwnerEntities";
import { useIsMobile } from "@/hooks/useIsMobile";
import { getAppErrorCode } from "@/lib/app-error";
import { formatErrorMessage } from "@/lib/format-error-message";
import { trpc } from "@/trpc";

import {
  LISTING_FILTERS,
  canTakeDownListing,
  filterToStatus,
  humanAdminSlug,
  listingEditHref,
  newListingHref,
  type ListingFilter,
  type ListingStatus,
} from "./community-listings.helpers";

// ─────────────────────────────────────────────────────────────────────────────
// /platform/community-listings: ownerless events the community lists (open
// mics and the like), managed by a platform ADMIN. List + create (the builder)
// + edit (the builder) + remove (take down = cancel). Lifecycle: CLAUDE.md
// "Model Lifecycle Convention" (/platform gets full CRUD).
//
// Cursor-paged by hand (`utils.fetch` + accumulated pages), like "Unpaid tax on
// cash": the first page's `dataUpdatedAt` keys the extra pages so a refetch
// voids the chain behind it.
// ─────────────────────────────────────────────────────────────────────────────

const PAGE_SIZE = 25;
const SEARCH_DEBOUNCE_MS = 300;
const STATUS_FILTER_ID = "community-listings-status";
const SEARCH_ID = "community-listings-search";

export interface ListingRow {
  id: string;
  title: string;
  status: ListingStatus;
  slug: string | null;
  timezone: string;
  startsAt: Date | string;
  endsAt: Date | string;
  recurring: boolean;
  placeId: string | null;
  placeName: string | null;
  city: string | null;
  nextNightStartsAt: Date | string | null;
  upcomingNightCount: number;
  publishedAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

type ListingPage = { items: ListingRow[]; nextCursor: string | null };
type Dialog = { row: ListingRow } | null;

const STATUS_FILTER_KEYS: Record<ListingFilter, string> = {
  ACTIVE: "admin.clStatusActive",
  DRAFT: "admin.eventStatusDraft",
  PUBLISHED: "admin.eventStatusPublished",
  CANCELLED: "admin.eventStatusCancelled",
  COMPLETED: "admin.eventStatusCompleted",
  ARCHIVED: "admin.eventStatusArchived",
};

const SELECT_FRAME_PROPS = {
  fullWidth: true,
  size: "md",
  borderRadius: 0,
  height: 44,
  minHeight: 44,
  paddingHorizontal: 14,
  borderColor: "$borderColorSoft",
  backgroundColor: "$background",
} as const;

/** tRPC's own code rides `data.code`; an app code, if any, rides `appCode`. */
const isForbiddenError = (error: unknown): boolean =>
  getAppErrorCode(error) !== "SECOND_FACTOR_REQUIRED" &&
  ((error as { data?: { code?: unknown } } | null)?.data?.code === "FORBIDDEN" ||
    getAppErrorCode(error) === "FORBIDDEN");

const LABEL_STYLE = { display: "block" } as const;
const NOWRAP = { whiteSpace: "nowrap" } as const;

export function CommunityListingsView() {
  const t = useTranslations();
  const fmt = useFormatters();
  const { toast } = useNotify();
  const utils = trpc.useUtils();
  const isMobile = useIsMobile();
  const handleSecondFactorRequired = useSecondFactorRequiredToast();
  const pathname = usePathname();

  const [filter, setFilter] = useState<ListingFilter>("ACTIVE");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  useEffect(() => {
    const handle = setTimeout(
      () => setSearch(searchInput.trim()),
      SEARCH_DEBOUNCE_MS,
    );
    return () => clearTimeout(handle);
  }, [searchInput]);

  const owners = useEventOwnerEntities();
  const adminSlug = humanAdminSlug(owners.ownersWithSlugs);

  const status = filterToStatus(filter);
  const listInput = {
    ...(status ? { status } : {}),
    ...(search ? { query: search } : {}),
    limit: PAGE_SIZE,
  };
  const query = trpc.community.listListingsForPlatform.useQuery(listInput);

  const [extra, setExtra] = useState<{
    dataUpdatedAt: number;
    pages: ListingPage[];
  }>({ dataUpdatedAt: 0, pages: [] });
  const extraPages = useMemo(
    () => (extra.dataUpdatedAt === query.dataUpdatedAt ? extra.pages : []),
    [extra, query.dataUpdatedAt],
  );
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);

  const rows = useMemo<ListingRow[]>(() => {
    const seen = new Set<string>();
    const out: ListingRow[] = [];
    for (const page of [query.data, ...extraPages]) {
      for (const item of (page?.items ?? []) as ListingRow[]) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        out.push(item);
      }
    }
    return out;
  }, [query.data, extraPages]);

  const nextCursor =
    extraPages.length > 0
      ? extraPages[extraPages.length - 1]!.nextCursor
      : (query.data?.nextCursor ?? null);

  const translateKey = useCallback((key: string) => String(t(key)), [t]);

  const handleLoadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      const page = (await utils.community.listListingsForPlatform.fetch({
        ...listInput,
        cursor: nextCursor,
      })) as ListingPage;
      const dataUpdatedAt = query.dataUpdatedAt;
      setExtra((prev) => ({
        dataUpdatedAt,
        pages:
          prev.dataUpdatedAt === dataUpdatedAt ? [...prev.pages, page] : [page],
      }));
    } catch (err) {
      setLoadMoreError(formatErrorMessage(err, translateKey));
    } finally {
      setLoadingMore(false);
    }
    // `listInput` is rebuilt every render; its parts are the real deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nextCursor, loadingMore, utils, query.dataUpdatedAt, status, search]);

  // ── Take down ──────────────────────────────────────────────────────────

  const [dialog, setDialog] = useState<Dialog>(null);
  const closeDialog = useCallback(() => setDialog(null), []);

  const onMutationError = useCallback(
    (error: unknown, titleKey: string) => {
      if (handleSecondFactorRequired(error)) return;
      const code = getAppErrorCode(error);
      if (
        code === "EVENT_ALREADY_CANCELLED" ||
        code === "EVENT_NOT_CANCELLABLE"
      ) {
        void utils.community.listListingsForPlatform.invalidate();
      }
      toast.danger({
        id: "community-listing-takedown-error",
        title: String(t(titleKey)),
        message: formatErrorMessage(error, translateKey),
      });
    },
    [handleSecondFactorRequired, toast, t, translateKey, utils],
  );

  const takeDownMutation = trpc.events.cancelEvent.useMutation({
    retry: false,
    meta: { silent: true },
    onSuccess: () => {
      void utils.community.listListingsForPlatform.invalidate();
      toast.success({
        id: "community-listing-taken-down",
        title: String(t("admin.ebListingTakenDownTitle")),
      });
    },
    onError: (error) => onMutationError(error, "admin.ebTakeDownFailedTitle"),
  });
  const pending = takeDownMutation.isPending;

  const confirmDialog = useCallback(() => {
    if (!dialog) return;
    const eventId = dialog.row.id;
    setDialog(null);
    takeDownMutation.mutate({ eventId, clientKey: nanoid(12) });
  }, [dialog, takeDownMutation]);

  // ── Cells ─────────────────────────────────────────────────────────────────

  const placeLine = useCallback(
    (row: ListingRow) =>
      [row.placeName, row.city].filter(Boolean).join(" · ") ||
      String(t("admin.clNoPlace")),
    [t],
  );

  const nextNightLine = useCallback(
    (row: ListingRow) =>
      row.nextNightStartsAt
        ? String(
            t("admin.clNextNight", {
              when: fmt.dateTime(new Date(row.nextNightStartsAt), {
                weekday: "short",
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
                timeZone: row.timezone,
              }),
            }),
          )
        : String(t("admin.clNoNextNight")),
    [fmt, t],
  );

  const renderActions = useCallback(
    (row: ListingRow, wrap = false) => {
      const publicLink = eventPublicLink({
        status: row.status,
        publishedAt: row.publishedAt,
        slug: row.slug,
        shortId: null,
      });
      return (
        <XStack
          gap="$2"
          flexWrap={wrap ? "wrap" : "nowrap"}
          alignItems="center"
        >
          {adminSlug ? (
            <NextLinkAnchor
              href={listingEditHref(adminSlug, row.id)}
              aria-label={`${String(t("admin.clEdit"))}: ${row.title}`}
            >
              <Button tag="span" variant="outlined" size="$2">
                {String(t("admin.clEdit"))}
              </Button>
            </NextLinkAnchor>
          ) : null}
          {publicLink ? (
            <NextLinkAnchor
              href={publicLink.canonicalPath}
              aria-label={`${String(t("admin.clView"))}: ${row.title}`}
            >
              <Button tag="span" variant="ghost" size="$2">
                {String(t("admin.clView"))}
              </Button>
            </NextLinkAnchor>
          ) : null}
          {canTakeDownListing(row.status) ? (
            <Button
              variant="destructiveGhost"
              size="$2"
              disabled={pending}
              onPress={() => setDialog({ row })}
              aria-label={`${String(t("admin.ebTakeDownListing"))}: ${row.title}`}
            >
              {String(t("admin.ebTakeDownListing"))}
            </Button>
          ) : null}
        </XStack>
      );
    },
    [adminSlug, pending, t],
  );

  const titleCell = (row: ListingRow) => (
    <YStack gap="$1" minWidth={0}>
      <Text variant="bodySmall" weight="bold">
        {row.title}
      </Text>
      <XStack>
        <EventStatusBadge status={row.status} />
      </XStack>
    </YStack>
  );

  const whenCell = (row: ListingRow) => (
    <YStack gap="$1">
      <Text variant="bodySmall">{nextNightLine(row)}</Text>
      {row.recurring && row.upcomingNightCount > 1 ? (
        <Text variant="caption" tone="muted">
          {String(t("admin.clUpcomingNights", { count: row.upcomingNightCount }))}
        </Text>
      ) : null}
    </YStack>
  );

  const columns = useMemo<DataTableColumn<ListingRow>[]>(
    () => [
      { id: "title", header: String(t("admin.clColListing")), cell: titleCell, width: 280 },
      {
        id: "place",
        header: String(t("admin.clColPlace")),
        cell: (row) => <Text variant="bodySmall">{placeLine(row)}</Text>,
        width: 200,
      },
      { id: "when", header: String(t("admin.clColNext")), cell: whenCell, width: 220 },
      { id: "actions", header: "", cell: (row) => renderActions(row, true), width: 360 },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [placeLine, nextNightLine, renderActions, t],
  );

  const statusOptions = useMemo(
    () =>
      LISTING_FILTERS.map((value) => ({
        value,
        label: String(t(STATUS_FILTER_KEYS[value])),
      })),
    [t],
  );

  const forbidden = query.isError && isForbiddenError(query.error);
  // A staff account without a second factor also arrives as tRPC FORBIDDEN;
  // it needs the enrol prompt, not the wrong-role text.
  const secondFactorError =
    query.isError && getAppErrorCode(query.error) === "SECOND_FACTOR_REQUIRED";
  useEffect(() => {
    if (secondFactorError) handleSecondFactorRequired(query.error);
  }, [secondFactorError, query.error, handleSecondFactorRequired]);
  const filtered = filter !== "ACTIVE" || search !== "";

  const newHref = adminSlug ? newListingHref(adminSlug) : null;

  return (
    <YStack
      gap={20}
      width="100%"
      maxWidth={1400}
      marginHorizontal="auto"
      paddingVertical={24}
      paddingHorizontal={isMobile ? 0 : 24}
    >
      <XStack
        justifyContent="space-between"
        alignItems="flex-start"
        flexWrap="wrap"
        gap={12}
      >
        <XStack gap={12} alignItems="flex-start" flexShrink={1} minWidth={0}>
          <CalendarRange
            size={24}
            aria-hidden
            style={{ flexShrink: 0, marginTop: 2 }}
          />
          <Text variant="h2" tag="h1" fontSize={22} lineHeight={28}>
            {String(t("admin.clTitle"))}
          </Text>
        </XStack>
        {newHref && !forbidden ? (
          <NextLinkAnchor href={newHref}>
            <Button tag="span" variant="secondary" size="$3">
              {String(t("admin.clNew"))}
            </Button>
          </NextLinkAnchor>
        ) : null}
      </XStack>

      {forbidden ? (
        <Text variant="body" tone="muted" role="alert">
          {String(t("admin.clForbidden"))}
        </Text>
      ) : (
        <>
          <XStack gap={12} flexWrap="wrap" alignItems="flex-end">
            <YStack gap={4} minWidth={180} flexGrow={1} flexBasis={180}>
              <label htmlFor={STATUS_FILTER_ID} style={LABEL_STYLE}>
                <Text variant="overline" tone="muted" tag="span">
                  {String(t("admin.clStatusFilter"))}
                </Text>
              </label>
              <StyledSelect<ListingFilter>
                value={filter}
                options={statusOptions}
                onChange={setFilter}
                selectId={STATUS_FILTER_ID}
                {...SELECT_FRAME_PROPS}
              />
            </YStack>
            <YStack gap={4} minWidth={180} flexGrow={2} flexBasis={240}>
              <label htmlFor={SEARCH_ID} style={LABEL_STYLE}>
                <Text variant="overline" tone="muted" tag="span">
                  {String(t("admin.clSearch"))}
                </Text>
              </label>
              <TextInput
                id={SEARCH_ID}
                name="listingSearch"
                value={searchInput}
                onChangeText={setSearchInput}
                fullWidth
                height={44}
                minHeight={44}
                autoComplete="off"
              />
            </YStack>
          </XStack>

          {query.isError ? (
            <XStack gap={12} alignItems="center" flexWrap="wrap" role="alert">
              <Text color="$danger" variant="body">
                {secondFactorError
                  ? String(t("moderation.secondFactorRequiredToastMessage"))
                  : formatErrorMessage(query.error, translateKey)}
              </Text>
              {secondFactorError ? (
                <NextLinkAnchor href={buildEnrollTwoFactorUrl(pathname)}>
                  <Button tag="span" variant="secondary" size="$2">
                    {String(t("moderation.secondFactorRequiredToastAction"))}
                  </Button>
                </NextLinkAnchor>
              ) : (
                <Button
                  variant="ghost"
                  size="$1"
                  onPress={() => void query.refetch()}
                  disabled={query.isFetching}
                >
                  {String(t("admin.clRetry"))}
                </Button>
              )}
            </XStack>
          ) : (
            <>
              {query.data && !nextCursor ? (
                <Text variant="overline" tone="muted">
                  {String(t("admin.clCount", { count: rows.length }))}
                </Text>
              ) : null}
              <DataTable
                rows={rows}
                columns={columns}
                getRowKey={(row) => row.id}
                isLoading={query.isLoading}
                scrollContainer
                renderMobileCard={(row) => (
                  <YStack gap="$2" minWidth={0}>
                    {titleCell(row)}
                    <Text variant="caption" tone="muted">
                      {placeLine(row)}
                    </Text>
                    {whenCell(row)}
                    {renderActions(row, true)}
                  </YStack>
                )}
                emptyState={
                  <Text variant="bodySmall" tone="muted">
                    {String(
                      filtered ? t("admin.clEmptyFiltered") : t("admin.clEmpty"),
                    )}
                  </Text>
                }
              />
            </>
          )}

          {loadMoreError ? (
            <Text color="$danger" variant="bodySmall" role="alert">
              {loadMoreError}
            </Text>
          ) : null}

          {nextCursor ? (
            <XStack justifyContent="center">
              <Button
                variant="ghost"
                size="$1"
                onPress={() => void handleLoadMore()}
                disabled={loadingMore}
                style={NOWRAP}
              >
                {String(loadingMore ? t("admin.clLoading") : t("admin.clLoadMore"))}
              </Button>
            </XStack>
          ) : null}
        </>
      )}

      <Modal open={dialog !== null} onClose={closeDialog}>
        <Modal.Panel width={440}>
          <Modal.Header
            title={String(t("admin.ebTakeDownListingConfirmTitle"))}
            onClose={closeDialog}
          />
          <Modal.Body>
            <Text variant="bodySmall" weight="bold">
              {dialog?.row.title}
            </Text>
            <Text variant="body">
              {String(t("admin.ebTakeDownListingConfirmBody"))}
            </Text>
          </Modal.Body>
          <Modal.Footer>
            <Button variant="ghost" onPress={closeDialog}>
              {String(t("admin.ebGoBack"))}
            </Button>
            <Button
              variant="destructive"
              onPress={confirmDialog}
              disabled={pending}
              data-testid="community-listing-takedown-confirm-btn"
            >
              {String(t("admin.ebYesTakeDownListing"))}
            </Button>
          </Modal.Footer>
        </Modal.Panel>
      </Modal>
    </YStack>
  );
}
