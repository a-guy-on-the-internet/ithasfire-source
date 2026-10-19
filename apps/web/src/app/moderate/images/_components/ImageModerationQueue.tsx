"use client";

import { useMemo } from "react";
import { useNotify, useTranslations } from "@th/ui";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";
import {
  ImageModerationQueueView,
  type FlaggedImageItem,
} from "./ImageModerationQueueView";

const PAGE_LIMIT = 30;

/**
 * /moderate/images (image-moderation spec FR-008): the FLAGGED-image review
 * queue. Thin CONTAINER — owns the data contract (infinite query + review
 * mutation + cache invalidation) and per-channel toasts, then renders the pure
 * `ImageModerationQueueView`. Mirrors the ModerationQueue / ApplicationsQueue
 * list + inline-review pattern.
 */
export function ImageModerationQueue() {
  const t = useTranslations();
  const { toast } = useNotify();
  const utils = trpc.useUtils();

  const listQuery = trpc.moderation.listFlaggedImages.useInfiniteQuery(
    { limit: PAGE_LIMIT },
    {
      staleTime: 15_000,
      getNextPageParam: (last) => last.nextCursor ?? undefined,
    },
  );

  const items = useMemo<FlaggedImageItem[]>(
    () =>
      listQuery.data?.pages.flatMap((page) =>
        page.items.map((item) => ({
          ...item,
          // The view is `Date`-free: normalise the serialized timestamp to ISO.
          moderatedAt: item.moderatedAt
            ? new Date(item.moderatedAt).toISOString()
            : null,
        })),
      ) ?? [],
    [listQuery.data],
  );

  const invalidate = () =>
    void utils.moderation.listFlaggedImages.invalidate();

  const reviewMut = trpc.moderation.reviewImage.useMutation({
    onSuccess: (data, vars) => {
      // A peer moderator won the FLAGGED compare-and-set — never show a false
      // success; surface the real (possibly opposite) outcome and refetch.
      if (data.alreadyDecided) {
        toast.info({ title: String(t("moderation.imagesAlreadyDecidedToast")) });
        invalidate();
        return;
      }
      toast.success({
        title: String(
          t(
            vars.decision === "APPROVE"
              ? "moderation.imagesApprovedToast"
              : "moderation.imagesRejectedToast",
          ),
        ),
      });
      invalidate();
    },
    onError: (err) => {
      toast.danger({
        title: String(t("moderation.imagesDecisionFailedToast")),
        message: formatErrorMessage(err, (key) => String(t(key))),
      });
    },
  });

  // Returns the mutation promise so the view can close its inline panel only
  // once the decision resolves (and keep it open, preserving the note, on error).
  const handleReview = (
    recordId: string,
    decision: "APPROVE" | "REJECT",
    note?: string,
  ) =>
    reviewMut.mutateAsync({
      recordId,
      decision,
      note: note?.trim() || undefined,
    });

  return (
    <ImageModerationQueueView
      items={items}
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
