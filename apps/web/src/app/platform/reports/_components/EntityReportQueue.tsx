"use client";

import { useMemo } from "react";
import { useNotify, useTranslations } from "@th/ui";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";
import { useSecondFactorRequiredToast } from "@/components/community/use-second-factor-required-toast";
import { isReportAlreadyReviewedError } from "./entity-report-queue.helpers";
import {
  EntityReportQueueView,
  type EntityReportItem,
} from "./EntityReportQueueView";

const PAGE_LIMIT = 20;

/**
 * /platform/reports (entity-report-intake spec FR-007, relocated to platform
 * trust & safety in spec v1.1): the entity-report
 * review queue. Thin CONTAINER — owns the data contract (infinite query +
 * review mutation + cache invalidation) and per-outcome toasts, then renders
 * the pure `EntityReportQueueView`. Mirrors the `ImageModerationQueue`
 * container/view split (the small precedent).
 *
 * Status filter: none — the sibling queues expose none either, and the
 * server's default is the queue-shaped PENDING set. `pendingCount` from the
 * same procedure is available should the platform nav ever grow a live badge
 * (the static server-declared platform sections carry none today).
 */
export function EntityReportQueue() {
  const t = useTranslations();
  const { toast } = useNotify();
  const utils = trpc.useUtils();
  const handleSecondFactorRequired = useSecondFactorRequiredToast();

  const listQuery = trpc.entityReports.listForModeration.useInfiniteQuery(
    { limit: PAGE_LIMIT },
    {
      staleTime: 15_000,
      getNextPageParam: (last) => last.nextCursor ?? undefined,
    },
  );

  const items = useMemo<EntityReportItem[]>(
    () =>
      listQuery.data?.pages.flatMap((page) =>
        page.items.map((item) => ({
          id: item.id,
          subjectType: item.subjectType,
          subjectId: item.subjectId,
          subjectName: item.subjectName,
          subjectSlug: item.subjectSlug,
          subjectParentType: item.subjectParentType,
          subjectKind: item.subjectKind,
          reporterHumanId: item.reporterHumanId,
          reporterName: item.reporterName,
          reason: item.reason,
          details: item.details,
          // The view is `Date`-free: normalise the serialized timestamp to ISO.
          createdAt: new Date(item.createdAt).toISOString(),
        })),
      ) ?? [],
    [listQuery.data],
  );

  // Freshest page's exact PENDING total — every page response carries it, and
  // later pages reflect any reviews that happened since the first fetch.
  const pages = listQuery.data?.pages;
  const pendingCount = pages?.[pages.length - 1]?.pendingCount;

  const invalidate = () =>
    void utils.entityReports.listForModeration.invalidate();

  const reviewMut = trpc.entityReports.review.useMutation({
    // Every failure branch below shows its own toast — opt out of
    // GlobalMutationErrorNotifier's generic danger toast (it would
    // double-toast AND console-warn on internal-tier codes like
    // SECOND_FACTOR_REQUIRED). Same posture as the suggestions queue.
    meta: { silent: true },
    onSuccess: (_data, vars) => {
      toast.success({
        title: String(
          t(
            vars.verdict === "RESOLVED"
              ? "moderation.reportsResolvedToast"
              : "moderation.reportsDismissedToast",
          ),
        ),
      });
      invalidate();
    },
    onError: (err) => {
      // Enrollment state can change mid-session — surface the 2FA enrollment
      // prompt instead of a generic failure toast.
      if (handleSecondFactorRequired(err)) return;
      // A peer moderator won the PENDING compare-and-set — never show a hard
      // error; tell the moderator and refetch so the row leaves the queue.
      if (isReportAlreadyReviewedError(err)) {
        toast.info({
          title: String(t("moderation.reportsAlreadyReviewedToast")),
        });
        invalidate();
        return;
      }
      toast.danger({
        title: String(t("moderation.reportsDecisionFailedToast")),
        message: formatErrorMessage(err, (key) => String(t(key))),
      });
    },
  });

  // Returns the mutation promise so the view can close its inline panel only
  // once the verdict resolves (and keep it open, preserving the note, on error).
  const handleReview = (
    reportId: string,
    verdict: "RESOLVED" | "DISMISSED",
    note?: string,
  ) =>
    reviewMut.mutateAsync({
      reportId,
      verdict,
      reviewNote: note?.trim() || undefined,
    });

  return (
    <EntityReportQueueView
      items={items}
      pendingCount={pendingCount}
      isLoading={listQuery.isLoading}
      isError={listQuery.isError}
      hasNextPage={listQuery.hasNextPage ?? false}
      isFetchingNextPage={listQuery.isFetchingNextPage}
      isReviewPending={reviewMut.isPending}
      onRetry={() => void listQuery.refetch()}
      onLoadMore={() => void listQuery.fetchNextPage()}
      onReview={handleReview}
    />
  );
}
