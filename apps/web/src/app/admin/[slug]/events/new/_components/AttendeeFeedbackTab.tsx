"use client";

import { useCallback, useMemo, useState, type ReactNode } from "react";
import { styled, XStack, YStack } from "tamagui";
import { Flag, Check } from "lucide-react";

import { Button, Spinner, Text, useNotify, useTranslations } from "@th/ui";

import { trpc } from "@/trpc";
import {
  FilterChips,
  FilterRow,
  NoResults,
  Pagination,
} from "@/components/AdminTableParts";
import { usePageClamp } from "@/hooks/usePageClamp";
import { EventOpsShell } from "../../[id]/_components/EventOpsShell";

export type AttendeeFeedbackTabProps = {
  eventId: string;
};

/**
 * The ONLY filter axis this surface has. Each comment deliberately carries no
 * name, rating or timestamp — that unattribution is the feature's privacy
 * guarantee (FR-002), so there is nothing else to sort or filter on, and no
 * free-text search either (searching unattributed prose is a re-identification
 * vector).
 *
 * Per the FilterChips convention, `undefined` is the default scope (every
 * comment) and gets NO chip — deselecting is how you get back to all.
 */
const COMMENT_FILTERS = ["FLAGGED", "UNFLAGGED"] as const;
type CommentFilter = (typeof COMMENT_FILTERS)[number];

/**
 * Comments per page. Filtering and paging are CLIENT-side over the array the
 * query already returned: `listEventFeedback` has no cursor and no filter
 * input (`{eventId, actorHumanId}.strict()`), and returns the whole list in
 * one payload. Slicing something already in memory is honest here; it is not a
 * stand-in for server paging.
 */
const COMMENTS_PER_PAGE = 10;

/** Mean (0–5 or 0–100) → one-decimal text. Organizers see their own exact numbers. */
function formatMean(mean: number): string {
  return mean.toLocaleString(undefined, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
}

const StatGrid = styled(XStack, {
  gap: "$4",
  flexWrap: "wrap",
});

const StatCell = styled(YStack, {
  gap: 2,
  minWidth: 120,
});

/**
 * Comment prose. `pre-wrap` preserves the attendee's own line breaks but wraps
 * at whitespace ONLY — review text is unbounded free text, so a pasted URL or
 * a 120-character token has no break opportunity and runs out of the card.
 * `overflow-wrap: anywhere` gives it one; `word-break: normal` keeps ordinary
 * words whole rather than hard-cutting mid-word. Same pairing, same reasons as
 * the event-card title rule in globals.css.
 *
 * This matters more since the list moved into the 7fr track: the same string
 * now has ~55% of the shell width to overflow instead of 100%.
 */
const commentTextStyle: React.CSSProperties = {
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
  wordBreak: "normal",
};

/**
 * The list's count kicker, matched to `Pagination`'s own kicker
 * (`paginationKickerStyle`, AdminTableParts.tsx) — the two numeric labels
 * bracket the card list, so they must not wear three different trackings
 * between them.
 */
const countKickerStyle: React.CSSProperties = {
  fontWeight: 700,
  fontSize: 11,
  letterSpacing: 1.5,
  textTransform: "uppercase",
  fontVariantNumeric: "tabular-nums",
};

const CommentCard = styled(YStack, {
  gap: "$3",
  padding: "$4",
  borderWidth: 2,
  borderColor: "$borderColor",
  borderRadius: 0,
  backgroundColor: "$surface",
});

/**
 * A single exact aggregate stat. Rendered only when the mean is present — a
 * facet nobody rated is ABSENT, never shown as 0 (mirrors the public block's
 * present-keys-only discipline, just with exact numbers here).
 */
function AggStat({ label, value }: { label: string; value: string }) {
  return (
    <StatCell>
      <Text variant="h4" weight="bold">
        {value}
      </Text>
      <Text
        variant="caption"
        tone="muted"
        textTransform="uppercase"
        letterSpacing={0.4}
      >
        {label}
      </Text>
    </StatCell>
  );
}

/**
 * Private, owner-facing "Attendee feedback" tab for the EventBuilder
 * (attendee-reviews FR-007). Shows the organizer's OWN exact aggregate (no
 * k-threshold — organizers may see their own precise numbers) plus the
 * UNATTRIBUTED comment list, newest first, each with a quiet "Report" action
 * that flags the comment to platform staff.
 *
 * PRIVACY: the data contract carries NO name, rating, or timestamp per comment
 * — only opaque `reviewId` + `text` + `flagged`. This surface renders exactly
 * that and invents no attribution (FR-002). Authz is enforced by the procedure;
 * the tab is additionally gated on the builder's edit-role signal.
 *
 * LAYOUT: a DS v2 §5 two-region grid (`.th-attendee-feedback-cols` in
 * globals.css) — comment list in the 7fr track, aggregate summary in the 5fr
 * one, collapsing to a single column by re-declaring `grid-template-columns`
 * (no JS viewport hook, which would flash on first paint). The collapse is a
 * `@container` query on this surface's own width, NOT a viewport media query:
 * the 256px admin rail appears at 960px, so a viewport rule would give the
 * summary less room at 960 than at 940.
 *
 * The comment list stays a CARD LIST, not a DataTable: the rows are
 * variable-length prose with one action each, and table columns would imply
 * attributes this contract deliberately does not carry.
 */
export function AttendeeFeedbackTab({ eventId }: AttendeeFeedbackTabProps) {
  const t = useTranslations();
  const { toast } = useNotify();
  const utils = trpc.useUtils();

  const feedbackQuery = trpc.attendeeReviews.listEventFeedback.useQuery(
    { eventId },
    { retry: false },
  );

  const flagMutation = trpc.attendeeReviews.flagFeedback.useMutation({
    onSuccess: () => {
      void utils.attendeeReviews.listEventFeedback.invalidate({ eventId });
      toast.success({
        id: "attendee-feedback-reported",
        title: String(t("attendeeFeedback.reportedToastTitle")),
        message: String(t("attendeeFeedback.reportedToastMessage")),
      });
    },
    onError: () => {
      toast.danger({
        id: "attendee-feedback-report-failed",
        title: String(t("attendeeFeedback.reportFailedTitle")),
        message: String(t("attendeeFeedback.reportFailedMessage")),
      });
    },
  });

  const handleReport = useCallback(
    (reviewId: string) => {
      flagMutation.mutate({ reviewId });
    },
    [flagMutation],
  );

  // ── Filter + pager state ────────────────────────────────────────────────
  //
  // Deliberately LOCAL state, not `useAdminTableParams`' `?p=/?ps=` URL sync
  // (which every DataTable surface here uses). Two reasons:
  //
  //  1. Privacy. A shareable link to "page 3 of this event's unattributed
  //     feedback" makes an individual comment's position addressable outside
  //     the ops context, on the one surface whose whole contract is that its
  //     contents are unattributed and private to the organizer. Nothing about
  //     this list benefits from being deep-linkable.
  //  2. Nothing to restore. The payload arrives in one query, so the pager
  //     triggers no refetch and survives no navigation — there is no
  //     server round-trip for a URL to reproduce.
  //
  // No URL can carry a stale page in, and a filter change can't strand one
  // either (`handleFilterSelect` resets to 0). The single real vector is a
  // REFETCH that shrinks the current scope: report the last unreported
  // comment while the UNFLAGGED chip is on and you are on the final page, and
  // `flagFeedback`'s invalidation drops that page out from under you. Two
  // complementary clamps cover it — `pageIndex` clamps in RENDER, so the list
  // never flashes empty for the frame an effect-only clamp would allow, and
  // `usePageClamp` then converges the state so Prev/Next count from the page
  // actually on screen.
  const [commentFilter, setCommentFilter] = useState<CommentFilter | undefined>(
    undefined,
  );
  const [page, setPage] = useState(0);

  const allComments = feedbackQuery.data?.feedback;

  const filteredComments = useMemo(() => {
    const items = allComments ?? [];
    if (!commentFilter) return items;
    return items.filter((item) =>
      commentFilter === "FLAGGED" ? item.flagged : !item.flagged,
    );
  }, [allComments, commentFilter]);

  const totalPages = Math.max(
    1,
    Math.ceil(filteredComments.length / COMMENTS_PER_PAGE),
  );
  // Visible page — clamped in render so an out-of-range `page` can never
  // strand an empty list, not even for one paint.
  const pageIndex = Math.min(page, totalPages - 1);

  usePageClamp({
    page,
    // `undefined` until the query settles: usePageClamp must not clamp
    // against a not-yet-loaded (or failed) dataset.
    totalPages: allComments === undefined ? undefined : totalPages,
    isFetching: feedbackQuery.isFetching,
    setPage,
  });

  // Changing the filter always returns to the first page — page 2 of the old
  // scope is meaningless in the new one.
  const handleFilterSelect = useCallback((next: CommentFilter | undefined) => {
    setCommentFilter(next);
    setPage(0);
  }, []);

  const handleClearAll = useCallback(() => {
    setCommentFilter(undefined);
    setPage(0);
  }, []);

  // The bespoke 960/alignSelf frame and its uppercase h4 are now the shell's
  // job — one container width and one h1 across all five ops surfaces.
  const frame = (children: ReactNode, filters?: ReactNode) => (
    <EventOpsShell
      title={String(t("attendeeFeedback.title"))}
      purpose={String(t("attendeeFeedback.subtitle"))}
      filters={filters}
    >
      {children}
    </EventOpsShell>
  );

  // 1. Loading.
  if (feedbackQuery.isPending) {
    return frame(
      <XStack gap="$3" alignItems="center" paddingVertical="$4">
        <Spinner size="sm" />
        <Text variant="body" tone="muted">
          {String(t("attendeeFeedback.loading"))}
        </Text>
      </XStack>,
    );
  }

  // 2. Error — actionable retry.
  if (feedbackQuery.isError) {
    return frame(
      <YStack gap="$3" paddingVertical="$4" alignItems="flex-start">
        <Text variant="body" tone="muted">
          {String(t("attendeeFeedback.errorMessage"))}
        </Text>
        <Button
          size="$3"
          variant="secondary"
          onPress={() => void feedbackQuery.refetch()}
          disabled={feedbackQuery.isFetching}
        >
          {feedbackQuery.isFetching ? <Spinner size="sm" /> : null}
          {String(t("attendeeFeedback.retry"))}
        </Button>
      </YStack>,
    );
  }

  const { aggregate, feedback } = feedbackQuery.data;

  // 3. Honest empty state — no reviews at all yet.
  if (aggregate.reviewCount === 0) {
    return frame(
      <YStack
        gap="$2"
        paddingVertical="$6"
        alignItems="center"
        data-testid="attendee-feedback-empty"
      >
        <Text variant="body" weight="semibold">
          {String(t("attendeeFeedback.emptyTitle"))}
        </Text>
        <Text variant="bodySmall" tone="muted" textAlign="center">
          {String(t("attendeeFeedback.emptyBody"))}
        </Text>
      </YStack>,
    );
  }

  const aggStats: Array<{ label: string; value: string }> = [];
  if (aggregate.overallMean != null) {
    aggStats.push({
      label: String(t("attendeeFeedback.aggOverall")),
      value: String(
        t("attendeeFeedback.scoreOutOf", {
          score: formatMean(aggregate.overallMean),
        }),
      ),
    });
  }
  if (aggregate.recommendPct != null) {
    aggStats.push({
      label: String(t("attendeeFeedback.aggRecommend")),
      value: `${Math.round(aggregate.recommendPct)}%`,
    });
  }
  const facetMeans: Array<[number | null, string]> = [
    [aggregate.soundQualityMean, "attendeeFeedback.aggSound"],
    [aggregate.venueComfortMean, "attendeeFeedback.aggVenueComfort"],
    [aggregate.organizationMean, "attendeeFeedback.aggOrganization"],
    [aggregate.valueForMoneyMean, "attendeeFeedback.aggValue"],
  ];
  for (const [mean, labelKey] of facetMeans) {
    if (mean != null) {
      aggStats.push({
        label: String(t(labelKey)),
        value: String(
          t("attendeeFeedback.scoreOutOf", { score: formatMean(mean) }),
        ),
      });
    }
  }

  const pageComments = filteredComments.slice(
    pageIndex * COMMENTS_PER_PAGE,
    pageIndex * COMMENTS_PER_PAGE + COMMENTS_PER_PAGE,
  );

  // Count kicker over the FILTERED list — "6 of 23 comments" while a chip is
  // on, the plain total otherwise. The pager below counts the same array.
  const countLabel = commentFilter
    ? String(
        t("attendeeFeedback.commentCountFiltered", {
          shown: filteredComments.length,
          total: feedback.length,
        }),
      )
    : String(
        t("attendeeFeedback.commentCount", { count: filteredComments.length }),
      );

  return frame(
    /* DS v2 §5 two-region grid — template and collapse live in globals.css
       (`.th-attendee-feedback-cols`). Plain <div>s on purpose: Tamagui stacks
       force `display: flex`.

       The OUTER div exists only to carry `container-type: inline-size`. It
       cannot be merged into the grid (an element never matches a container
       query it establishes itself) and it deliberately is not hoisted onto
       EventOpsShell's shared body node, where `contain: layout` would make it
       the containing block for AttendeesTab's absolutely-positioned overlay
       BulkActionBar. The query measures the width this surface ACTUALLY has,
       which a viewport rule cannot: the 256px admin rail appears at 960px, so
       a media query would hand the summary LESS room at 960 than at 940.

       DOM order is summary-then-comments, which IS the stacked phone order:
       the aggregate is a six-cell scan of how the show went and it frames the
       prose that explains it, so burying it under a paged card list (and its
       pager) on a phone would hide the headline number at the bottom of the
       page. Once the container clears the threshold, the grid PLACES the list
       in the 7fr track — it is what the organizer came for — and the summary
       in the 5fr one. The summary holds no interactive elements, so the wide
       visual order differing from DOM order costs nothing in focus order. */
    <div className="th-attendee-feedback">
      <div className="th-attendee-feedback-cols">
        {/* ── Exact aggregate (organizer's own numbers, no k-gate) ──────── */}
        <YStack
          gap="$3"
          className="th-attendee-feedback-summary"
          data-testid="attendee-feedback-aggregate"
        >
          <YStack gap="$1">
            <Text
              variant="caption"
              tone="muted"
              textTransform="uppercase"
              letterSpacing={0.4}
            >
              {String(
                t("attendeeFeedback.reviewCount", {
                  count: aggregate.reviewCount,
                }),
              )}
            </Text>
            {/* Scope line. The filter row renders in the shell ABOVE the whole
              grid, so in two-column mode it sits over this column too — but it
              only narrows the comment list, and `reviewCount` counts every review
              including the ratings left with no comment at all. Without this,
              "2 of 6 comments" on the left beside "12 reviews · 4.3 overall"
              on the right reads as a contradiction. Scoping the aggregate to
              the filter would be the WRONG fix: these are the organizer's
              real numbers for the event, not for a subset of prose. */}
            <Text variant="caption" tone="muted" aria-live="polite">
              {String(
                t(
                  commentFilter
                    ? "attendeeFeedback.aggregateScopeFiltered"
                    : "attendeeFeedback.aggregateScope",
                ),
              )}
            </Text>
          </YStack>
          <StatGrid>
            {aggStats.map((stat) => (
              <AggStat key={stat.label} label={stat.label} value={stat.value} />
            ))}
          </StatGrid>
        </YStack>

        {/* ── Unattributed comment list, newest first ───────────────────── */}
        <YStack gap="$3" className="th-attendee-feedback-list">
          {feedback.length === 0 ? (
            <Text
              variant="bodySmall"
              tone="muted"
              data-testid="attendee-feedback-no-comments"
            >
              {String(t("attendeeFeedback.noComments"))}
            </Text>
          ) : (
            <>
              <YStack gap="$1">
                {/* aria-live: toggling a chip swaps the whole list with no other
                  announcement — `aria-pressed` says the control is on, not
                  what happened to the list. This node already carries the
                  outcome ("2 of 6 comments", "0 of 6 comments"), so it is the
                  right thing to speak. Prev/Next are not covered by it (the
                  scope count is the same on every page, so the text does not
                  change): there, focus stays on the pressed control and
                  Pagination's own "page 2 of 3" label updates beside it. */}
                <Text
                  variant="caption"
                  tone="muted"
                  aria-live="polite"
                  style={countKickerStyle}
                  data-testid="attendee-feedback-count"
                >
                  {countLabel}
                </Text>
                <Text variant="bodySmall" tone="muted">
                  {String(t("attendeeFeedback.commentsIntro"))}
                </Text>
              </YStack>

              {filteredComments.length === 0 ? (
                /* A filter that matches nothing is NOT "no comments yet" — it
                 says so, and offers its own way out. The button's label
                 (`admin.atClearFiltersShowAll`) is deliberately distinct from
                 FilterRow's "Clear filters", which is on screen at the same
                 time. */
                <YStack data-testid="attendee-feedback-no-matches">
                  <NoResults
                    title={String(t("attendeeFeedback.noMatchTitle"))}
                    description={String(t("attendeeFeedback.noMatchBody"))}
                    onClearFilters={handleClearAll}
                  />
                </YStack>
              ) : (
                <YStack gap="$3" data-testid="attendee-feedback-comments">
                  {pageComments.map((item) => {
                    const reporting =
                      flagMutation.isPending &&
                      flagMutation.variables?.reviewId === item.reviewId;
                    return (
                      <CommentCard
                        key={item.reviewId}
                        data-testid="attendee-feedback-comment"
                      >
                        <Text variant="body" style={commentTextStyle}>
                          {item.text}
                        </Text>
                        <XStack justifyContent="flex-end">
                          {item.flagged ? (
                            <XStack
                              gap={6}
                              alignItems="center"
                              data-testid="attendee-feedback-reported"
                            >
                              <Check size={14} aria-hidden />
                              <Text variant="caption" tone="muted">
                                {String(t("attendeeFeedback.reportedLabel"))}
                              </Text>
                            </XStack>
                          ) : (
                            <Button
                              size="$3"
                              variant="ghost"
                              onPress={() => handleReport(item.reviewId)}
                              disabled={reporting}
                              aria-label={String(
                                t("attendeeFeedback.reportAria"),
                              )}
                              data-testid="attendee-feedback-report"
                            >
                              {reporting ? (
                                <Spinner size="sm" />
                              ) : (
                                <Flag size={14} aria-hidden />
                              )}
                              {String(t("attendeeFeedback.report"))}
                            </Button>
                          )}
                        </XStack>
                      </CommentCard>
                    );
                  })}
                </YStack>
              )}

              {/* Renders nothing at one page — a short list stays clean. */}
              <Pagination
                page={pageIndex}
                totalPages={totalPages}
                onPageChange={setPage}
              />
            </>
          )}
        </YStack>
      </div>
    </div>,
    // Filters only exist once there is prose to filter. `flagged` is the only
    // axis the contract carries; there is no chip for the default "all".
    feedback.length > 0 ? (
      <FilterRow
        hasActiveFilters={commentFilter !== undefined}
        onClearAll={handleClearAll}
      >
        <FilterChips<CommentFilter>
          options={COMMENT_FILTERS.map((value) => ({
            value,
            label: String(
              t(
                value === "FLAGGED"
                  ? "attendeeFeedback.filterFlagged"
                  : "attendeeFeedback.filterUnflagged",
              ),
            ),
          }))}
          selected={commentFilter}
          onSelect={handleFilterSelect}
          ariaLabel={String(t("attendeeFeedback.filterAriaLabel"))}
        />
      </FilterRow>
    ) : null,
  );
}

AttendeeFeedbackTab.displayName = "AttendeeFeedbackTab";
