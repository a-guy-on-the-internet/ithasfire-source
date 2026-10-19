"use client";

import { useMemo, useCallback } from "react";
import { YStack, XStack, styled } from "tamagui";
import {
  DataTable,
  type DataTableColumn,
  Badge,
  Text,
  useTranslations,
  useFormatters,
} from "@th/ui";
import { Banknote, Clock, AlertTriangle } from "lucide-react";
import { keepPreviousData } from "@tanstack/react-query";

import { trpc } from "@/trpc";
import { EmailVerificationRequired } from "@/components/auth/EmailVerificationRequired";
import { isEmailVerificationRequired } from "@/lib/email-verification-required";
import {
  ActionBar,
  TableContainer,
  NoResults,
  Pagination,
} from "@/components/AdminTableParts";
import { useAdminTableParams } from "@/hooks/useAdminTableParams";
import { usePageClamp } from "@/hooks/usePageClamp";
import { formatErrorMessage } from "@/lib/format-error-message";
import { fmtDateShort, fmtCurrency } from "@/lib/format";
import { formatOrderCode } from "@th/types/order-identifier";

const MANUAL_REVIEW_AGE_DAYS = 60;

// ─────────────────────────────────────────────────────────────────────────────
// Styled
// ─────────────────────────────────────────────────────────────────────────────

const InfoCard = styled(YStack, {
  padding: "$4",
  borderRadius: 0,
  borderWidth: 1,
  borderColor: "$borderColor",
  gap: "$2",
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function getReleaseTimelineMeta(payoutReleaseAt: string | null, nowMs: number) {
  if (!payoutReleaseAt) {
    return {
      badgeTone: "warning" as const,
      labelKey: "admin.sellPayoutsTimelineUnavailable",
      detailKey: "admin.sellPayoutsTimelineUnavailableHint",
    };
  }

  const releaseMs = new Date(payoutReleaseAt).getTime();
  if (Number.isNaN(releaseMs)) {
    return {
      badgeTone: "warning" as const,
      labelKey: "admin.sellPayoutsTimelineUnavailable",
      detailKey: "admin.sellPayoutsTimelineUnavailableHint",
    };
  }

  const ageDays = (nowMs - releaseMs) / (1000 * 60 * 60 * 24);
  if (ageDays > MANUAL_REVIEW_AGE_DAYS) {
    return {
      badgeTone: "danger" as const,
      labelKey: "admin.sellPayoutsTimelineAttention",
      detailKey: "admin.sellPayoutsTimelineAttentionHint",
    };
  }

  if (releaseMs > nowMs) {
    return {
      badgeTone: "info" as const,
      labelKey: "admin.sellPayoutsTimelineScheduled",
      detailKey: "admin.sellPayoutsTimelineScheduledHint",
    };
  }

  return {
    badgeTone: "neutral" as const,
    labelKey: "admin.sellPayoutsTimelineReached",
    detailKey: "admin.sellPayoutsTimelineReachedHint",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────────────────

export default function SellPayoutsPage() {
  const t = useTranslations();
  const fmt = useFormatters();
  const { page, pageSize, setPage, setPageSize } = useAdminTableParams();

  // Fetch only SOLD listings — these represent completed sales that generate payouts.
  // `page` from useAdminTableParams is ZERO-based, so the offset is a plain
  // multiply. (`(page - 1) * pageSize` sent offset: -25 on first load, which
  // the server's `offset: z.number().int().min(0)` rejected with BAD_REQUEST.)
  const soldQuery = trpc.resale.listMyListings.useQuery(
    {
      status: ["SOLD"],
      limit: pageSize,
      offset: page * pageSize,
    },
    { placeholderData: keepPreviousData },
  );

  const handleRefresh = useCallback(() => {
    void soldQuery.refetch();
  }, [soldQuery]);

  type ListingRow = NonNullable<typeof soldQuery.data>["items"][number];
  const nowMs = Date.now();

  const columns: DataTableColumn<ListingRow>[] = useMemo(
    () => [
      {
        id: "buyerOrderId",
        header: String(t("admin.sellPayoutsBuyerOrder")),
        cell: (row) => (
          // The ONE order code (8-hex TAIL) \u2014 a seller quoting this to support
          // has to hit the same row admin search resolves. `truncateId` gave
          // the HEAD, which is also 8 hex chars: it satisfies the identifier
          // shape and then matches nothing. Bare: the "Buyer order" header
          // labels the column.
          <Text variant="bodySmall" fontFamily="$mono">
            {row.buyerOrderId ? formatOrderCode(row.buyerOrderId) : "\u2014"}
          </Text>
        ),
        width: 110,
      },
      {
        id: "askPriceCents",
        header: String(t("admin.sellPayoutsPricing")),
        cell: (row) => (
          <YStack gap="$1">
            <Text variant="body" weight="bold">
              {fmtCurrency(fmt, row.askPriceCents, row.currency)}
            </Text>
            <Text variant="bodySmall" tone="muted">
              {String(
                t("admin.sellPayoutsFaceValueRow", {
                  amount:
                    row.faceValueCents === null
                      ? "\u2014"
                      : fmtCurrency(fmt, row.faceValueCents, row.currency),
                }),
              )}
            </Text>
          </YStack>
        ),
      },
      {
        id: "timeline",
        header: String(t("admin.sellPayoutsTimeline")),
        cell: (row) => {
          const meta = getReleaseTimelineMeta(row.payoutReleaseAt, nowMs);
          return (
            <YStack gap="$1">
              <Badge tone={meta.badgeTone} size="sm">
                {String(t(meta.labelKey))}
              </Badge>
              <Text variant="bodySmall" tone="muted">
                {String(t(meta.detailKey))}
              </Text>
            </YStack>
          );
        },
      },
      {
        id: "payoutReleaseAt",
        header: String(t("admin.sellPayoutsReleaseTarget")),
        cell: (row) => (
          <Text variant="bodySmall" tone="muted">
            {fmtDateShort(fmt, row.payoutReleaseAt)}
          </Text>
        ),
      },
      {
        id: "createdAt",
        header: String(t("admin.sellPayoutsListedAt")),
        cell: (row) => (
          <Text variant="bodySmall" tone="muted">
            {fmtDateShort(fmt, row.createdAt)}
          </Text>
        ),
      },
    ],
    [t, fmt, nowMs],
  );

  const totalRows = soldQuery.data?.total ?? 0;
  const items = soldQuery.data?.items ?? [];

  // `undefined` whenever the query has NO settled data — initial load OR
  // error. A failed fetch also reports `isFetching: false` / `isLoading:
  // false` with `data: undefined`, so deriving 1 page from `total ?? 0` would
  // let the clamp below rewrite a deep-linked `?p=5` out of the URL on a
  // transient API failure. `usePageClamp` skips `undefined`.
  const settledTotalPages = soldQuery.data
    ? Math.max(1, Math.ceil(totalRows / pageSize))
    : undefined;

  // Stale/shared URLs (`?p=9` against a shrunken dataset) snap back to the
  // last real page once the query settles, instead of stranding an empty
  // state the user can't navigate out of.
  usePageClamp({
    page,
    totalPages: settledTotalPages,
    isFetching: soldQuery.isFetching,
    setPage,
  });

  // Current-page summary only. We intentionally avoid implying account-wide payout truth.
  const totalEarningsCents = items.reduce(
    (sum, item) => sum + item.askPriceCents,
    0,
  );
  const currency = items[0]?.currency ?? "usd";
  const timelineSummary = items.reduce(
    (summary, item) => {
      const meta = getReleaseTimelineMeta(item.payoutReleaseAt, nowMs);
      if (meta.labelKey === "admin.sellPayoutsTimelineScheduled") {
        summary.scheduled += 1;
      } else if (meta.labelKey === "admin.sellPayoutsTimelineReached") {
        summary.reached += 1;
      } else if (meta.labelKey === "admin.sellPayoutsTimelineAttention") {
        summary.attention += 1;
      } else {
        summary.unavailable += 1;
      }
      return summary;
    },
    { scheduled: 0, reached: 0, attention: 0, unavailable: 0 },
  );

  // B2: an unverified account's listings and sales are withheld until it
  // verifies its email; the table, filters and retry cannot help with that.
  if (isEmailVerificationRequired(soldQuery.error)) {
    return (
      <YStack paddingVertical="$4" width="100%">
        <EmailVerificationRequired
          context="generic"
          headingTag="h1"
          testId="sell-payouts-verify-email"
        />
      </YStack>
    );
  }

  return (
    <YStack flex={1} gap="$4" padding="$4">
      {/* Header */}
      <YStack
        gap="$1"
        borderBottomWidth={2}
        borderBottomColor="$borderColor"
        paddingBottom="$3"
      >
        <Text
          variant="h1"
          // $xs: the 48px h1 breaks long words mid-letter in the ~174px box at
          // 320px, so drop to 24px, and hyphenate (html[lang] is the locale)
          // so "PUBLICACIONES" splits at a syllable, not mid-letter.
          $xs={{ fontSize: "$6", lineHeight: "$6" }}
          style={{ hyphens: "auto", overflowWrap: "break-word" }}
        >
          {String(t("admin.sellPayoutsTitle"))}
        </Text>
        <Text variant="body" tone="muted">
          {String(t("admin.sellPayoutsSubtitle"))}
        </Text>
      </YStack>

      {/* Info cards */}
      <XStack gap="$4" flexWrap="wrap">
        <InfoCard flex={1} minWidth={240}>
          <XStack alignItems="center" gap="$2">
            <Clock size={18} color="var(--color)" aria-hidden />
            <Text variant="bodySmall" weight="bold">
              {String(t("admin.sellPayoutsHowItWorks"))}
            </Text>
          </XStack>
          <Text variant="bodySmall" tone="muted">
            {String(t("admin.sellPayoutsHowItWorksDescription"))}
          </Text>
        </InfoCard>

        {items.length > 0 && (
          <InfoCard flex={1} minWidth={240}>
            <XStack alignItems="center" gap="$2">
              <Banknote size={18} color="var(--color)" aria-hidden />
              <Text variant="bodySmall" weight="bold">
                {String(t("admin.sellPayoutsCurrentPageSales"))}
              </Text>
            </XStack>
            {/* h2 scale for the stat, span semantics — a currency value is
                data, not a section heading (keeps the h1→h2 ladder clean). */}
            <Text variant="h2" tag="span">
              {fmtCurrency(fmt, totalEarningsCents, currency)}
            </Text>
            <Text variant="bodySmall" tone="muted">
              {String(
                t("admin.sellPayoutsCurrentPageSalesNote", {
                  shown: items.length,
                  total: totalRows,
                }),
              )}
            </Text>
          </InfoCard>
        )}

        {items.length > 0 && (
          <InfoCard flex={1} minWidth={240}>
            <XStack alignItems="center" gap="$2">
              <AlertTriangle size={18} color="var(--color)" aria-hidden />
              <Text variant="bodySmall" weight="bold">
                {String(t("admin.sellPayoutsTimelineSummaryPage"))}
              </Text>
            </XStack>
            <Text variant="bodySmall" tone="muted">
              {String(
                t("admin.sellPayoutsScheduledCount", {
                  count: timelineSummary.scheduled,
                }),
              )}
            </Text>
            <Text variant="bodySmall" tone="muted">
              {String(
                t("admin.sellPayoutsReachedCount", {
                  count: timelineSummary.reached,
                }),
              )}
            </Text>
            <Text variant="bodySmall" tone="muted">
              {String(
                t("admin.sellPayoutsAttentionCount", {
                  count: timelineSummary.attention,
                }),
              )}
            </Text>
            {timelineSummary.unavailable > 0 && (
              <Text variant="bodySmall" tone="muted">
                {String(
                  t("admin.sellPayoutsUnavailableCount", {
                    count: timelineSummary.unavailable,
                  }),
                )}
              </Text>
            )}
            <Text variant="bodySmall" tone="muted">
              {String(
                t("admin.sellPayoutsTimelineSummaryNote", {
                  shown: items.length,
                  total: totalRows,
                }),
              )}
            </Text>
          </InfoCard>
        )}
      </XStack>

      <Text variant="bodySmall" tone="muted">
        {String(t("admin.sellPayoutsDelayNote"))}
      </Text>

      {/* Actions */}
      <ActionBar onRefresh={handleRefresh} />

      {/* Error */}
      {soldQuery.isError && (
        <Text variant="body" tone="error">
          {String(
            t("admin.sellPayoutsFailedToLoad", {
              error: formatErrorMessage(soldQuery.error),
            }),
          )}
        </Text>
      )}

      {/* Table — NoResults is DataTable's `emptyState`, not a sibling that
          replaces the table, so the column headers survive an empty list. */}
      <TableContainer>
        <DataTable<ListingRow>
          columns={columns}
          rows={items}
          isLoading={soldQuery.isLoading}
          emptyState={
            // DataTable delays its skeleton 200ms; rendering the empty copy in
            // that window would flash a false "no sales yet" on every cold
            // load, so it only mounts once the query has settled. The SAME
            // guard covers the error branch: a failed fetch also lands here
            // with zero rows, and stacking "no sales yet" under "Failed to
            // load" states the opposite of what happened.
            soldQuery.isLoading || soldQuery.isError ? (
              <YStack />
            ) : (
              <NoResults
                title={String(t("admin.sellPayoutsNoSales"))}
                description={String(t("admin.sellPayoutsNoSalesDescription"))}
              />
            )
          }
        />
      </TableContainer>

      {/* Pagination — rendered unconditionally: it hides its own prev/next
          when there is one page, but the rows-per-page selector and the row
          range must stay reachable. */}
      <Pagination
        page={page}
        totalPages={settledTotalPages ?? 1}
        onPageChange={setPage}
        pageSize={pageSize}
        onPageSizeChange={setPageSize}
        total={totalRows}
      />
    </YStack>
  );
}
