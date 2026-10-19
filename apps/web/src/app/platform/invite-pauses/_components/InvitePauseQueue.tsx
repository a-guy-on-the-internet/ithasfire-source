"use client";

import { useCallback, useMemo, useState } from "react";
import { useNotify, useTranslations } from "@th/ui";

import { trpc } from "@/trpc";
import { getAppErrorCode } from "@/lib/app-error";
import { formatErrorMessage } from "@/lib/format-error-message";
import { useSecondFactorRequiredToast } from "@/components/community/use-second-factor-required-toast";

import {
  InvitePauseQueueView,
  type InvitePauseDecision,
} from "./InvitePauseQueueView";
import {
  isAwaitingReview,
  orderInvitePauses,
  type InvitePauseFilter,
  type InvitePauseQueueItem,
} from "./invite-pause-queue.helpers";

/** Rows per page (the server's cap); "Load more" fetches the next offset. */
export const INVITE_PAUSE_PAGE_LIMIT = 100;
const LIST_LIMIT = INVITE_PAUSE_PAGE_LIMIT;

const toIso = (value: Date | string) => new Date(value).toISOString();
const toIsoOrNull = (value: Date | string | null) =>
  value === null ? null : toIso(value);

/**
 * /platform/invite-pauses (invite complaint auto-pause, W4): the CONTAINER.
 * Owns the list queries, the decide mutation, cache invalidation and the
 * toasts; renders the pure `InvitePauseQueueView`. Same split as the reports
 * queue (`EntityReportQueue`).
 *
 * Opens on ALL OPEN pauses (one list, review requests first; see
 * `orderInvitePauses`), so a pause nobody asked about is never hidden behind
 * a filter. The sort runs on the merged list, so "Load more" pages fall into
 * place. The waiting badge reads the AWAITING_REVIEW list separately.
 */
export function InvitePauseQueue() {
  const t = useTranslations();
  const { toast } = useNotify();
  const utils = trpc.useUtils();
  const handleSecondFactorRequired = useSecondFactorRequiredToast();
  const [filter, setFilter] = useState<InvitePauseFilter>("OPEN");

  // Decision controls render for ADMIN / REVIEWER only, the set
  // `platform.invitePauses.decide` enforces (INVITE_PAUSE_DECIDE_ROLES).
  // SUPPORT reads the queue. Same staff-roles read as the dispute desk; false
  // while it loads, so nobody sees a button the server would refuse.
  const staffAccessQuery = trpc.platform.checkStaffAccess.useQuery(undefined, {
    staleTime: 60_000,
  });
  const canDecide = (staffAccessQuery.data?.roles ?? []).some(
    (role) => role === "ADMIN" || role === "REVIEWER",
  );

  const listQuery = trpc.platform.invitePauses.list.useQuery(
    { status: filter, limit: LIST_LIMIT },
    { staleTime: 15_000 },
  );
  const waitingQuery = trpc.platform.invitePauses.list.useQuery(
    { status: "AWAITING_REVIEW", limit: LIST_LIMIT },
    { staleTime: 15_000 },
  );

  // Pages past the first, fetched by offset and appended. Keyed to the
  // filter AND the page-1 fetch they were read under: a decision, or any
  // background refetch of page 1 (window focus, another tab's decision),
  // shifts every later offset, so the extra pages are dropped rather than
  // left to skip or repeat rows.
  type ServerItem = NonNullable<typeof listQuery.data>["items"][number];
  const [more, setMore] = useState<{
    filter: InvitePauseFilter;
    firstPageAt: number;
    items: ServerItem[];
    lastPageSize: number;
  } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const firstPageAt = listQuery.dataUpdatedAt;
  const extra =
    more?.filter === filter && more.firstPageAt === firstPageAt ? more : null;

  const firstPage = listQuery.data?.items;
  const loadedRaw = useMemo<ServerItem[]>(() => {
    const first = firstPage ?? [];
    if (!extra) return first;
    const seen = new Set(first.map((item) => item.id));
    return [...first, ...extra.items.filter((item) => !seen.has(item.id))];
  }, [firstPage, extra]);
  const lastPageSize = extra ? extra.lastPageSize : (firstPage?.length ?? 0);
  const hasNextPage = firstPage !== undefined && lastPageSize === LIST_LIMIT;

  const loadMore = useCallback(async () => {
    if (loadingMore || !firstPage) return;
    const offset = firstPage.length + (extra?.items.length ?? 0);
    setLoadingMore(true);
    try {
      const page = await utils.platform.invitePauses.list.fetch({
        status: filter,
        limit: LIST_LIMIT,
        offset,
      });
      // Built on the pages this offset was counted from; if page 1 refetched
      // meanwhile, `firstPageAt` no longer matches and the result is dropped.
      setMore({
        filter,
        firstPageAt,
        items: [...(extra?.items ?? []), ...page.items],
        lastPageSize: page.items.length,
      });
    } catch (err) {
      toast.danger({
        title: String(t("invitePauseQueue.loadMoreFailedToast")),
        message: formatErrorMessage(err, (key) => String(t(key))),
      });
    } finally {
      setLoadingMore(false);
    }
  }, [extra, filter, firstPage, firstPageAt, loadingMore, t, toast, utils]);

  const items = useMemo<InvitePauseQueueItem[]>(
    () =>
      orderInvitePauses(
        loadedRaw.map((item) => ({
          id: item.id,
          ownerKind: item.ownerKind,
          ownerId: item.ownerId,
          ownerName: item.ownerName,
          ownerSlug: item.ownerSlug,
          reason: item.reason,
          complaintCount: item.complaintCount,
          recipientCount: item.recipientCount,
          // The view is Date-free: normalise to ISO strings.
          pausedAt: toIso(item.pausedAt),
          reviewRequestedAt: toIsoOrNull(item.reviewRequestedAt),
          reviewRequestNote: item.reviewRequestNote,
          decision: item.decision,
          decidedAt: toIsoOrNull(item.decidedAt),
          decisionNote: item.decisionNote,
          liftedAt: toIsoOrNull(item.liftedAt),
        })),
        filter,
      ),
    [loadedRaw, filter],
  );

  const waitingCount = waitingQuery.data
    ? waitingQuery.data.items.filter(isAwaitingReview).length
    : undefined;
  // The badge reads one page: a full page means there may be more ("100+").
  const waitingCountIsFloor =
    waitingQuery.data?.items.length === LIST_LIMIT;

  const invalidate = () => {
    setMore(null);
    void utils.platform.invitePauses.list.invalidate();
  };

  const decideMut = trpc.platform.invitePauses.decide.useMutation({
    // Every failure below shows its own toast; skip the global one.
    meta: { silent: true },
    onSuccess: (_data, vars) => {
      toast.success({
        title: String(
          t(
            vars.decision === "LIFTED"
              ? "invitePauseQueue.liftedToast"
              : "invitePauseQueue.keptToast",
          ),
        ),
      });
      invalidate();
    },
    onError: (err) => {
      if (handleSecondFactorRequired(err)) return;
      // Another staff member already lifted it: say so and refetch.
      if (getAppErrorCode(err) === "INVALID_STATUS") {
        toast.info({ title: String(t("invitePauseQueue.alreadyDecidedToast")) });
        invalidate();
        return;
      }
      toast.danger({
        title: String(t("invitePauseQueue.decisionFailedToast")),
        message: formatErrorMessage(err, (key) => String(t(key))),
      });
    },
  });

  const handleDecide = (
    pauseId: string,
    decision: InvitePauseDecision,
    note?: string,
  ) =>
    decideMut.mutateAsync({
      pauseId,
      decision,
      note: note?.trim() || null,
    });

  return (
    <InvitePauseQueueView
      items={items}
      filter={filter}
      onFilterChange={setFilter}
      waitingCount={waitingCount}
      waitingCountIsFloor={waitingCountIsFloor}
      isLoading={listQuery.isLoading}
      isError={listQuery.isError}
      canDecide={canDecide}
      isDecisionPending={decideMut.isPending}
      hasNextPage={hasNextPage}
      isFetchingNextPage={loadingMore}
      onLoadMore={() => void loadMore()}
      onRetry={() => void listQuery.refetch()}
      onDecide={handleDecide}
    />
  );
}
