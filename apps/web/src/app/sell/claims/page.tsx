"use client";

import { useMemo, useState, useCallback } from "react";
import { XStack, YStack } from "tamagui";
import { ChevronDown } from "lucide-react";
import {
  DataTable,
  type DataTableColumn,
  Badge,
  Button,
  Text,
  useTranslations,
  useFormatters,
} from "@th/ui";
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
import { fmtDateShort, truncateId } from "@/lib/format";
import {
  claimKindLabelKey,
  claimResolutionKey,
  claimShortId,
  isClaimUndecided,
  isRefundPending,
} from "@/lib/resale-claims";
import {
  ClaimMobileCard,
  ClaimStatusBadge,
  CLAIM_KIND_LABEL_KEY,
} from "../../platform/claims/_components/ClaimMobileCard";
import {
  SellerClaimPanel,
  sellerClaimPanelId,
} from "./_components/SellerClaimPanel";

// ─────────────────────────────────────────────────────────────────────────────
// Types & helpers
// ─────────────────────────────────────────────────────────────────────────────

type ClaimStatus = "open" | "under_review" | "approved" | "denied" | "expired";

type TabId = "active" | "resolved";

const TAB_DEFS: { value: TabId; labelKey: string }[] = [
  { value: "active", labelKey: "resaleClaim.sellerTabActive" },
  { value: "resolved", labelKey: "resaleClaim.sellerTabResolved" },
];

const TAB_STATUSES: Record<TabId, ClaimStatus[]> = {
  active: ["open", "under_review"],
  resolved: ["approved", "denied", "expired"],
};

// ─────────────────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────────────────

export default function SellClaimsPage() {
  const t = useTranslations();
  const fmt = useFormatters();
  const [activeTab, setActiveTab] = useState<TabId>("active");
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  // Page-level status: a claim decided while its seller was replying moves
  // to Resolved on the refetch, taking its panel (and any message) with it.
  const [notice, setNotice] = useState<string | null>(null);
  const translate = useCallback(
    (key: string) => (fmt.getRawMessage(key) ? String(t(key)) : key),
    [fmt, t],
  );
  const toggleExpanded = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
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
  const claimsQuery = trpc.claims.listMy.useQuery(
    {
      status: statusFilter,
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
    void claimsQuery.refetch();
  }, [claimsQuery]);

  type ClaimRow = NonNullable<typeof claimsQuery.data>["items"][number];

  const columns: DataTableColumn<ClaimRow>[] = useMemo(
    () => [
      {
        id: "id",
        header: String(t("admin.pclId")),
        cell: (row) => (
          <Text variant="bodySmall" fontFamily="$mono">
            {truncateId(row.id)}
          </Text>
        ),
        width: 100,
      },
      {
        id: "kind",
        header: String(t("admin.pclKind")),
        cell: (row) => (
          <Text variant="bodySmall">
            {String(t(CLAIM_KIND_LABEL_KEY[row.kind] ?? row.kind))}
          </Text>
        ),
        width: 130,
      },
      {
        id: "status",
        header: String(t("admin.pclStatus")),
        cell: (row) => <ClaimStatusBadge status={row.status} />,
        width: 120,
      },
      // No "Deadline" column: `claim.deadline` is when the buyer's FILING
      // window closed, and nothing expires now (owner rulings Q8/Q9), so a
      // seller would misread it as a cut-off for their reply.
      {
        id: "sellerRespondedAt",
        header: String(t("resaleClaim.sellerColReply")),
        cell: (row) =>
          row.sellerRespondedAt ? (
            <Text variant="bodySmall">
              {fmtDateShort(fmt, new Date(row.sellerRespondedAt))}
            </Text>
          ) : isClaimUndecided(row.status) ? (
            <Badge tone="warning" size="sm">
              {String(t("resaleClaim.sellerReplyNotYet"))}
            </Badge>
          ) : (
            <Text variant="bodySmall" tone="muted">
              {"\u2014"}
            </Text>
          ),
        width: 120,
      },
      {
        id: "resolution",
        header: String(t("admin.pclResolution")),
        cell: (row) => (
          <Text
            variant="bodySmall"
            tone={claimResolutionKey(row) ? undefined : "muted"}
          >
            {claimResolutionKey(row)
              ? String(t(claimResolutionKey(row)!))
              : "\u2014"}
          </Text>
        ),
        width: 130,
      },
      {
        id: "createdAt",
        header: String(t("admin.pclCreated")),
        cell: (row) => (
          <Text variant="bodySmall">
            {fmtDateShort(fmt, new Date(row.createdAt))}
          </Text>
        ),
        width: 120,
      },
    ],
    [t, fmt],
  );

  const rowActions = useMemo(
    () => ({
      header: "",
      width: 1,
      render: (row: ClaimRow) => {
        const open = expandedIds.has(row.id);
        const kindKey = claimKindLabelKey(row.kind);
        const claimRef = `${kindKey ? String(t(kindKey)) : row.kind} ${claimShortId(row.id)}`;
        return (
          <XStack justifyContent="flex-end">
            <Button
              variant={open ? "primary" : "ghost"}
              size="$4"
              icon
              onPress={() => toggleExpanded(row.id)}
              aria-expanded={open}
              aria-controls={sellerClaimPanelId(row.id)}
              aria-label={String(
                t(
                  open
                    ? "resaleClaim.sellerHideClaim"
                    : isClaimUndecided(row.status)
                      ? "resaleClaim.sellerViewAndReply"
                      : "resaleClaim.sellerViewClaim",
                  { claim: claimRef },
                ),
              )}
              data-testid={`seller-claim-toggle-${row.id}`}
            >
              <ChevronDown
                size={16}
                aria-hidden
                style={{
                  transform: open ? "rotate(180deg)" : undefined,
                  transition: "transform 0.15s ease",
                }}
              />
            </Button>
          </XStack>
        );
      },
    }),
    [expandedIds, toggleExpanded, t],
  );

  const totalRows = claimsQuery.data?.total ?? 0;
  const items = claimsQuery.data?.items ?? [];

  // `undefined` whenever the query has NO settled data — initial load OR
  // error. A failed fetch also reports `isFetching: false` / `isLoading:
  // false` with `data: undefined`, so deriving 1 page from `total ?? 0` would
  // let the clamp below rewrite a deep-linked `?p=5` out of the URL on a
  // transient API failure. `usePageClamp` skips `undefined`.
  const settledTotalPages = claimsQuery.data
    ? Math.max(1, Math.ceil(totalRows / pageSize))
    : undefined;

  // Stale/shared URLs (`?p=9` against a shrunken dataset) snap back to the
  // last real page once the query settles, instead of stranding an empty
  // state the user can't navigate out of.
  usePageClamp({
    page,
    totalPages: settledTotalPages,
    isFetching: claimsQuery.isFetching,
    setPage,
  });

  // B2: an unverified account's listings and sales are withheld until it
  // verifies its email; the table, filters and retry cannot help with that.
  if (isEmailVerificationRequired(claimsQuery.error)) {
    return (
      <YStack paddingVertical="$4" width="100%">
        <EmailVerificationRequired
          context="generic"
          headingTag="h1"
          testId="sell-claims-verify-email"
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
          {String(t("admin.sellClaimsTitle"))}
        </Text>
        <Text variant="body" tone="muted">
          {String(t("admin.sellClaimsSubtitle"))}
        </Text>
        <Text variant="bodySmall" tone="muted">
          {String(t("resaleClaim.sellerHint"))}
        </Text>
      </YStack>

      {/* Tabs */}
      <AdminTabBar<TabId>
        tabs={tabs}
        activeTab={activeTab}
        onTabChange={handleTabChange}
      />

      {/* Page-level notice. Polite live region, always mounted. */}
      <YStack role="status" aria-live="polite">
        {notice && (
          <XStack
            gap="$3"
            alignItems="center"
            padding="$3"
            borderWidth={2}
            borderColor="$borderColor"
            flexWrap="wrap"
            data-testid="seller-claims-notice"
          >
            <Text variant="bodySmall" flex={1} minWidth={200}>
              {notice}
            </Text>
            <Button variant="ghost" size="$4" onPress={() => setNotice(null)}>
              {String(t("resaleClaim.dismiss"))}
            </Button>
          </XStack>
        )}
      </YStack>

      {/* Actions */}
      <ActionBar onRefresh={handleRefresh} />

      {/* Error */}
      {claimsQuery.isError && (
        <Text variant="body" tone="error">
          {String(
            t("admin.sellClaimsFailedToLoad", {
              error: formatErrorMessage(claimsQuery.error, translate),
            }),
          )}
        </Text>
      )}

      {/* Table — NoResults is DataTable's `emptyState`, not a sibling that
          replaces the table, so the column headers survive an empty list. */}
      <TableContainer>
        <DataTable<ClaimRow>
          columns={columns}
          rows={items}
          getRowKey={(row) => row.id}
          isLoading={claimsQuery.isLoading}
          onRowPress={(row) => toggleExpanded(row.id)}
          rowActions={rowActions}
          // Card mode (<600px) drops rowActions; pressing the card toggles
          // the same panel the chevron opens, so the reply stays reachable.
          renderMobileCard={(row) => (
            <ClaimMobileCard
              row={row}
              showWindowClosed={false}
              footer={
                isClaimUndecided(row.status) && !row.sellerRespondedAt ? (
                  <XStack>
                    <Badge tone="warning" size="sm">
                      {String(t("resaleClaim.sellerNeedsReply"))}
                    </Badge>
                  </XStack>
                ) : isRefundPending(row) ? (
                  // No Resolution column on a card: never read as settled.
                  <XStack>
                    <Badge tone="warning" size="sm">
                      {String(t("resaleClaim.resolutionRefundPending"))}
                    </Badge>
                  </XStack>
                ) : null
              }
            />
          )}
          renderExpandedRow={(row) =>
            expandedIds.has(row.id) ? (
              <SellerClaimPanel
                claim={row}
                onDecidedBeforeReply={() =>
                  setNotice(String(t("resaleClaim.sellerDecidedBeforeReply")))
                }
              />
            ) : null
          }
          emptyState={
            // DataTable delays its skeleton 200ms; rendering the empty copy in
            // that window would flash a false "no claims yet" on every cold
            // load, so it only mounts once the query has settled. The SAME
            // guard covers the error branch: a failed fetch also lands here
            // with zero rows, and stacking "you have no claims" under
            // "Failed to load" states the opposite of what happened.
            claimsQuery.isLoading || claimsQuery.isError ? (
              <YStack />
            ) : (
              <NoResults
                title={String(t("admin.sellClaimsEmpty"))}
                description={String(t("admin.sellClaimsEmptyDescription"))}
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
