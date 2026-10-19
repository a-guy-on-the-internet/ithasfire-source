"use client";

import { useMemo, useState, useCallback } from "react";
import { useRouter } from "@bprogress/next/app";
import { YStack } from "tamagui";
import {
  DataTable,
  type DataTableColumn,
  Badge,
  Button,
  Text,
  useTranslations,
  useFormatters,
} from "@th/ui";
import { Plus } from "lucide-react";
import { keepPreviousData } from "@tanstack/react-query";

import { trpc } from "@/trpc";
import { EmailVerificationRequired } from "@/components/auth/EmailVerificationRequired";
import { isEmailVerificationRequired } from "@/lib/email-verification-required";
import {
  AdminTabBar,
  type AdminTab,
} from "../../admin/[slug]/_components/AdminTabBar";
import {
  ActionBar,
  TableContainer,
  NoResults,
  Pagination,
} from "@/components/AdminTableParts";
import { useAdminTableParams } from "@/hooks/useAdminTableParams";
import { usePageClamp } from "@/hooks/usePageClamp";
import { formatErrorMessage } from "@/lib/format-error-message";
import { fmtDate, fmtDateShort, fmtCurrency, truncateId } from "@/lib/format";
import {
  originalPriceLine,
  originalPriceText,
} from "@/lib/resale/original-price";

type TabId = "active" | "sold" | "terminal";

const TAB_DEFS: { value: TabId; labelKey: string }[] = [
  { value: "active", labelKey: "admin.sellListingsActive" },
  { value: "sold", labelKey: "admin.sellListingsSold" },
  { value: "terminal", labelKey: "admin.sellListingsExpiredCancelled" },
];

const TAB_STATUSES: Record<TabId, string[]> = {
  active: ["ACTIVE", "HELD"],
  sold: ["SOLD"],
  terminal: ["EXPIRED", "CANCELLED"],
};

function getListingStatusMeta(status: string) {
  switch (status) {
    case "ACTIVE":
      return {
        badgeTone: "success" as const,
        labelKey: "admin.sellListingsStatusLive",
        detailKey: "admin.sellListingsStatusLiveHint",
      };
    case "HELD":
      return {
        badgeTone: "info" as const,
        labelKey: "admin.sellListingsStatusHeld",
        detailKey: "admin.sellListingsStatusHeldHint",
      };
    case "SOLD":
      return {
        badgeTone: "neutral" as const,
        labelKey: "admin.sellListingsStatusSold",
        detailKey: "admin.sellListingsStatusSoldHint",
      };
    case "CANCELLED":
      return {
        badgeTone: "warning" as const,
        labelKey: "admin.sellListingsStatusCancelled",
        detailKey: "admin.sellListingsStatusCancelledHint",
      };
    case "EXPIRED":
      return {
        badgeTone: "warning" as const,
        labelKey: "admin.sellListingsStatusExpired",
        detailKey: "admin.sellListingsStatusExpiredHint",
      };
    default:
      return {
        badgeTone: "neutral" as const,
        labelKey: "admin.sellListingsStatusUnknown",
        detailKey: "admin.sellListingsStatusUnknownHint",
      };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────────────────

export default function SellListingsPage() {
  const t = useTranslations();
  const fmt = useFormatters();
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<TabId>("active");
  const { page, pageSize, setPage, setPageSize } = useAdminTableParams();

  const tabs: AdminTab<TabId>[] = useMemo(
    () =>
      TAB_DEFS.map((d) => ({ value: d.value, label: String(t(d.labelKey)) })),
    [t],
  );

  const statusFilter = TAB_STATUSES[activeTab];

  // `page` from useAdminTableParams is ZERO-based, so the offset is a plain
  // multiply. (`(page - 1) * pageSize` sent offset: -25 on first load, which
  // the server's `offset: z.number().int().min(0)` rejected with BAD_REQUEST.)
  const listingsQuery = trpc.resale.listMyListings.useQuery(
    {
      status: statusFilter as Array<
        "ACTIVE" | "HELD" | "SOLD" | "CANCELLED" | "EXPIRED"
      >,
      limit: pageSize,
      offset: page * pageSize,
    },
    { placeholderData: keepPreviousData },
  );

  const handleTabChange = useCallback(
    (tab: TabId) => {
      setActiveTab(tab);
      // Zero-based: a new tab is a new dataset, so go to the FIRST page.
      setPage(0);
    },
    [setPage],
  );

  const handleRefresh = useCallback(() => {
    void listingsQuery.refetch();
  }, [listingsQuery]);

  type ListingRow = NonNullable<typeof listingsQuery.data>["items"][number];

  const columns: DataTableColumn<ListingRow>[] = useMemo(
    () => [
      {
        id: "eventId",
        header: String(t("admin.sellListingsEvent")),
        cell: (row) => (
          <YStack gap="$1">
            <Text variant="body" fontFamily="$mono">
              {truncateId(row.eventId)}
            </Text>
            <Text variant="bodySmall" tone="muted" fontFamily="$mono">
              {truncateId(row.ticketId)}
            </Text>
          </YStack>
        ),
      },
      {
        id: "pricing",
        header: String(t("admin.sellListingsPricing")),
        cell: (row) => {
          const money = (cents: number) => fmtCurrency(fmt, cents, row.currency);
          const original = originalPriceText(
            originalPriceLine(row),
            t,
            money,
          );
          return (
            <YStack gap="$1">
              <Text variant="body" weight="bold">
                {money(row.askPriceCents)}
              </Text>
              {row.buyerTotalBeforeTaxCents != null && (
                <Text variant="bodySmall" tone="muted">
                  {String(
                    t("resell.buyerPaysAllIn", {
                      amount: money(row.buyerTotalBeforeTaxCents),
                      note: String(
                        t(
                          row.processingPassThroughCents > 0
                            ? "resell.plusTaxIncludesProcessing"
                            : "resell.plusTax",
                        ),
                      ),
                    }),
                  )}
                </Text>
              )}
              {row.sellerReceivesCents != null && (
                <Text variant="bodySmall" tone="muted">
                  {String(
                    t("resell.youReceiveAmount", {
                      amount: money(row.sellerReceivesCents),
                    }),
                  )}
                </Text>
              )}
              {row.eventShareCents != null &&
                row.eventShareCents > 0 &&
                row.sharePayer && (
                  <Text variant="bodySmall" tone="muted">
                    {String(
                      t(
                        row.sharePayer === "BUYER"
                          ? "resell.shareToEventBuyer"
                          : "resell.shareToEventSeller",
                        {
                          amount: money(row.eventShareCents),
                          ticket: money(row.askPriceCents),
                        },
                      ),
                    )}
                  </Text>
                )}
              {original ? (
                <Text variant="bodySmall" tone="muted">
                  {original}
                </Text>
              ) : row.eventShareCents == null && row.faceValueCents !== null ? (
                <Text variant="bodySmall" tone="muted">
                  {String(
                    t("resell.originalPriceFixed", {
                      amount: money(row.faceValueCents),
                    }),
                  )}
                </Text>
              ) : null}
            </YStack>
          );
        },
      },
      {
        id: "status",
        header: String(t("admin.sellListingsStatus")),
        cell: (row) => {
          const meta = getListingStatusMeta(row.status);
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
        id: "timeline",
        header: String(t("admin.sellListingsReleaseOrCutoff")),
        cell: (row) => {
          if (row.status === "SOLD") {
            return (
              <YStack gap="$1">
                <Text variant="body">
                  {row.payoutReleaseAt
                    ? fmtDateShort(fmt, row.payoutReleaseAt)
                    : "\u2014"}
                </Text>
                <Text variant="bodySmall" tone="muted">
                  {row.payoutReleaseAt
                    ? String(t("admin.sellListingsReleaseTargetHint"))
                    : String(t("admin.sellListingsReleaseTargetUnavailable"))}
                </Text>
              </YStack>
            );
          }

          if (row.saleCutoffAt) {
            return (
              <YStack gap="$1">
                <Text variant="body">{fmtDate(fmt, row.saleCutoffAt)}</Text>
                <Text variant="bodySmall" tone="muted">
                  {String(t("admin.sellListingsSaleCutoffHint"))}
                </Text>
              </YStack>
            );
          }

          if (row.expiresAt) {
            return (
              <YStack gap="$1">
                <Text variant="body">{fmtDate(fmt, row.expiresAt)}</Text>
                <Text variant="bodySmall" tone="muted">
                  {String(t("admin.sellListingsListingExpiryHint"))}
                </Text>
              </YStack>
            );
          }

          return (
            <Text variant="body" tone="muted">
              {"\u2014"}
            </Text>
          );
        },
      },
      {
        id: "createdAt",
        header: String(t("admin.sellListingsListedAt")),
        cell: (row) => (
          <Text variant="body" tone="muted">
            {fmtDateShort(fmt, row.createdAt)}
          </Text>
        ),
      },
    ],
    [t, fmt],
  );

  const totalRows = listingsQuery.data?.total ?? 0;
  const items = listingsQuery.data?.items ?? [];

  // `undefined` whenever the query has NO settled data — initial load OR
  // error. A failed fetch also reports `isFetching: false` / `isLoading:
  // false` with `data: undefined`, so deriving 1 page from `total ?? 0` would
  // let the clamp below rewrite a deep-linked `?p=5` out of the URL on a
  // transient API failure. `usePageClamp` skips `undefined`.
  const settledTotalPages = listingsQuery.data
    ? Math.max(1, Math.ceil(totalRows / pageSize))
    : undefined;

  // Stale/shared URLs (`?p=9` against a shrunken dataset) snap back to the
  // last real page once the query settles, instead of stranding an empty
  // state the user can't navigate out of.
  usePageClamp({
    page,
    totalPages: settledTotalPages,
    isFetching: listingsQuery.isFetching,
    setPage,
  });

  // B2: an unverified account's listings and sales are withheld until it
  // verifies its email; the table, filters and retry cannot help with that.
  if (isEmailVerificationRequired(listingsQuery.error)) {
    return (
      <YStack paddingVertical="$4" width="100%">
        <EmailVerificationRequired
          context="generic"
          headingTag="h1"
          testId="sell-listings-verify-email"
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
          {String(t("admin.sellListingsTitle"))}
        </Text>
        <Text variant="body" tone="muted">
          {String(t("admin.sellListingsSubtitle"))}
        </Text>
      </YStack>

      <YStack gap="$1" padding="$4" borderWidth={1} borderColor="$borderColor">
        <Text
          variant="bodySmall"
          weight="bold"
          textTransform="uppercase"
          letterSpacing={1}
        >
          {String(t("admin.sellListingsExplainerTitle"))}
        </Text>
        <Text variant="bodySmall" tone="muted">
          {String(t("admin.sellListingsExplainerBody"))}
        </Text>
      </YStack>

      {/* Tabs */}
      <AdminTabBar<TabId>
        tabs={tabs}
        activeTab={activeTab}
        onTabChange={handleTabChange}
      />

      {/* Actions */}
      <ActionBar onRefresh={handleRefresh}>
        {/* v2 atom grammar: plain string label + one leading object icon
            (aria-hidden, currentColor) — no inner Text override. */}
        <Button
          size="$3"
          variant="primary"
          onPress={() => router.push("/sell/listings/new")}
        >
          <Plus size={16} aria-hidden />
          {String(t("admin.sellListingsListTicket"))}
        </Button>
      </ActionBar>

      {/* Error */}
      {listingsQuery.isError && (
        <Text variant="body" tone="error">
          {String(
            t("admin.sellListingsFailedToLoad", {
              error: formatErrorMessage(listingsQuery.error),
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
          isLoading={listingsQuery.isLoading}
          emptyState={
            // DataTable delays its skeleton 200ms; rendering the empty copy in
            // that window would flash a false "no listings yet" on every cold
            // load, so it only mounts once the query has settled. The SAME
            // guard covers the error branch: a failed fetch also lands here
            // with zero rows, and stacking "you haven't listed any tickets"
            // under "Failed to load" states the opposite of what happened.
            listingsQuery.isLoading || listingsQuery.isError ? (
              <YStack />
            ) : (
              <NoResults
                title={String(t("admin.sellListingsEmpty"))}
                description={String(t("admin.sellListingsEmptyDescription"))}
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
