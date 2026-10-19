"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { styled, YStack, XStack } from "tamagui";
import { PlatformContainer } from "../_components/PlatformPageParts";
import {
  Badge,
  DataTable,
  type DataTableColumn,
  Button,
  Text,
  useTranslations,
  useFormatters,
} from "@th/ui";
import { ShieldAlert, Filter, X, RefreshCw, ChevronDown } from "lucide-react";
import { keepPreviousData } from "@tanstack/react-query";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";
import { fmtDateShort, truncateId } from "@/lib/format";
import { Pagination, TableContainer } from "@/components/AdminTableParts";
import {
  ClaimMobileCard,
  ClaimStatusBadge,
  CLAIM_KIND_LABEL_KEY,
} from "./_components/ClaimMobileCard";
import {
  StaffClaimPanel,
  staffClaimPanelId,
} from "./_components/StaffClaimPanel";
import {
  claimKindLabelKey,
  claimResolutionKey,
  claimShortId,
  isRefundPending,
} from "@/lib/resale-claims";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type ClaimStatus = "open" | "under_review" | "approved" | "denied" | "expired";

const STATUS_OPTIONS: { value: ClaimStatus; labelKey: string }[] = [
  { value: "open", labelKey: "admin.pclStatusOpen" },
  { value: "under_review", labelKey: "admin.pclStatusUnderReview" },
  { value: "approved", labelKey: "admin.pclStatusApproved" },
  { value: "denied", labelKey: "admin.pclStatusDenied" },
  { value: "expired", labelKey: "admin.pclStatusExpired" },
];

const PAGE_SIZE = 25;

// ─────────────────────────────────────────────────────────────────────────────
// Styled
// ─────────────────────────────────────────────────────────────────────────────

const ActionBar = styled(XStack, {
  gap: 12,
  alignItems: "center",
  flexWrap: "wrap",
});

// ─────────────────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────────────────

const PAGE_HEADING_ID = "platform-claims-heading";

interface Notice {
  id: number;
  message: string;
}

/**
 * A page-level notice. The live region stays mounted and holds only the
 * sentence (keyed by id, so a repeat is re-announced); Dismiss sits outside
 * it so its label is never read as part of the message.
 */
function PageNotice({
  notice,
  urgent,
  onDismiss,
  testId,
}: {
  notice: Notice | null;
  urgent: boolean;
  onDismiss: () => void;
  testId: string;
}) {
  const t = useTranslations();
  return (
    <XStack
      gap="$3"
      alignItems="center"
      flexWrap="wrap"
      padding={notice ? "$3" : 0}
      borderWidth={notice ? 2 : 0}
      borderColor={urgent ? "$danger" : "$borderColor"}
      data-testid={notice ? testId : undefined}
    >
      <YStack
        role={urgent ? "alert" : "status"}
        aria-live={urgent ? undefined : "polite"}
        flex={1}
        minWidth={200}
      >
        {notice && (
          <Text
            key={notice.id}
            variant="bodySmall"
            weight={urgent ? "bold" : undefined}
          >
            {notice.message}
          </Text>
        )}
      </YStack>
      {notice && (
        <Button
          variant="ghost"
          size="$4"
          onPress={onDismiss}
          aria-label={String(t("resaleClaim.dismissMessage"))}
        >
          {String(t("resaleClaim.dismiss"))}
        </Button>
      )}
    </XStack>
  );
}

export default function PlatformClaimsPage() {
  const t = useTranslations();
  const fmt = useFormatters();

  const [page, setPage] = useState(0);
  const [statusFilter, setStatusFilter] = useState<ClaimStatus | undefined>();
  const [showFilters, setShowFilters] = useState(false);
  // The last decision, announced at page level: with a status filter on, a
  // decided claim leaves the list (and its panel unmounts) on the refetch.
  // Two slots: a routine "denied" must never wipe an unread refund alert.
  // Each message gets a fresh id so a repeat of the same sentence is
  // re-inserted (and so re-announced) inside its persistent live region.
  const [polite, setPolite] = useState<Notice | null>(null);
  const [urgent, setUrgent] = useState<Notice | null>(null);
  const noticeSeq = useRef(0);
  const announce = useCallback(
    (message: string, options?: { urgent?: boolean }) => {
      noticeSeq.current += 1;
      const notice = { id: noticeSeq.current, message };
      if (options?.urgent) setUrgent(notice);
      else setPolite(notice);
    },
    [],
  );
  // The button disappears with the notice, so focus goes to the heading.
  const dismiss = useCallback((set: (value: Notice | null) => void) => {
    set(null);
    document.getElementById(PAGE_HEADING_ID)?.focus();
  }, []);
  const translate = useCallback(
    (key: string) => (fmt.getRawMessage(key) ? String(t(key)) : key),
    [fmt, t],
  );
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const toggleExpanded = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // ── Query ────────────────────────────────────────────────────────────
  const claimsQuery = trpc.claims.list.useQuery(
    {
      status: statusFilter ? [statusFilter] : undefined,
      offset: page * PAGE_SIZE,
      limit: PAGE_SIZE,
    },
    {
      placeholderData: keepPreviousData,
      staleTime: 15_000,
    },
  );

  const claims = claimsQuery.data?.items ?? [];
  const total = claimsQuery.data?.total ?? 0;
  const totalPages = Math.ceil(total / PAGE_SIZE);

  // ── Columns ──────────────────────────────────────────────────────────
  type ClaimRow = (typeof claims)[number];

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
      {
        id: "claimantId",
        header: String(t("admin.pclBuyer")),
        cell: (row) => (
          <Text variant="bodySmall" fontFamily="$mono">
            {row.view === "full" ? truncateId(row.claimantId) : "\u2014"}
          </Text>
        ),
        width: 120,
      },
      {
        id: "respondentId",
        header: String(t("admin.pclSeller")),
        cell: (row) => (
          <Text variant="bodySmall" fontFamily="$mono">
            {row.view === "full" ? truncateId(row.respondentId) : "\u2014"}
          </Text>
        ),
        width: 120,
      },
      {
        // `deadline` is when the buyer's FILING window closed; claims never
        // expire and staff can decide at any time (owner rulings Q8/Q9).
        id: "deadline",
        header: String(t("resaleClaim.windowClosedColumn")),
        cell: (row) => (
          <Text variant="bodySmall">
            {fmtDateShort(fmt, new Date(row.deadline))}
          </Text>
        ),
        width: 120,
      },
      {
        id: "resolution",
        header: String(t("admin.pclResolution")),
        cell: (row) => {
          const key = claimResolutionKey(row);
          return (
            <Text variant="bodySmall" tone={key ? undefined : "muted"}>
              {key ? String(t(key)) : "\u2014"}
            </Text>
          );
        },
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
              aria-controls={staffClaimPanelId(row.id)}
              aria-label={String(
                t(
                  open
                    ? "resaleClaim.staffHideDetails"
                    : "resaleClaim.staffShowDetails",
                  { claim: claimRef },
                ),
              )}
              data-testid={`staff-claim-toggle-${row.id}`}
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

  // ── Render ───────────────────────────────────────────────────────────
  return (
    <PlatformContainer>
      {/* Header */}
      <YStack gap="$2">
        <XStack gap="$3" alignItems="center">
          <ShieldAlert size={24} />
          <Text
            variant="h2"
            tag="h1"
            weight="bold"
            id={PAGE_HEADING_ID}
            tabIndex={-1}
            flexShrink={1}
            minWidth={0}
            $xs={{ fontSize: "$6", lineHeight: "$6" }}
            style={{ hyphens: "auto", overflowWrap: "break-word" }}
          >
            {String(t("admin.pclTitle"))}
          </Text>
        </XStack>
        <Text variant="body" tone="muted">
          {String(t("admin.pclSubtitle"))}
        </Text>
      </YStack>

      {/* Action bar */}
      <ActionBar>
        <Button
          variant="secondary"
          size="$3"
          onPress={() => claimsQuery.refetch()}
        >
          <RefreshCw size={14} />
          {String(t("admin.pclRefresh"))}
        </Button>

        <Button
          variant="secondary"
          size="$3"
          onPress={() => setShowFilters((v) => !v)}
        >
          <Filter size={14} />
          {String(t("admin.pclFilters"))}
        </Button>

        {statusFilter && (
          <Button
            variant="ghost"
            size="$2"
            onPress={() => {
              setStatusFilter(undefined);
              setPage(0);
            }}
          >
            <X size={14} />
            {String(t("admin.pclClear"))}
          </Button>
        )}
      </ActionBar>

      {/* Filters */}
      {showFilters && (
        <XStack gap="$2" flexWrap="wrap">
          {STATUS_OPTIONS.map((opt) => (
            <Button
              key={opt.value}
              variant={statusFilter === opt.value ? "primary" : "secondary"}
              size="$2"
              onPress={() => {
                setStatusFilter(
                  statusFilter === opt.value ? undefined : opt.value,
                );
                setPage(0);
              }}
            >
              {String(t(opt.labelKey))}
            </Button>
          ))}
        </XStack>
      )}

      {/* Last decision, outliving the row when a filter hides it. Routine
          outcomes are polite; a refund that failed after approval needs
          action, so it is an alert in its own slot that only Dismiss or a
          newer alert clears. */}
      <PageNotice
        notice={polite}
        urgent={false}
        onDismiss={() => dismiss(setPolite)}
        testId="staff-claim-announcement"
      />
      <PageNotice
        notice={urgent}
        urgent
        onDismiss={() => dismiss(setUrgent)}
        testId="staff-claim-announcement-urgent"
      />

      {/* Error state */}
      {claimsQuery.isError && (
        <YStack padding="$4" gap="$2">
          <Text variant="body" tone="error">
            {String(
              t("admin.pclFailedToLoad", {
                error: formatErrorMessage(claimsQuery.error, translate),
              }),
            )}
          </Text>
        </YStack>
      )}

      {/* Data table */}
      {!claimsQuery.isError && (
        <>
          {/* TableContainer draws the ledger's top/bottom rules (and owns
              the frame, so card mode's list and the pager below don't add
              second ones) and scopes horizontal panning. Its flex: 1 sizes
              to content here: PlatformContainer is an auto-height column. */}
          <TableContainer>
            <DataTable
              rows={claims}
              columns={columns}
              getRowKey={(row) => row.id}
              isLoading={claimsQuery.isLoading}
              onRowPress={(row) => toggleExpanded(row.id)}
              rowActions={rowActions}
              // Card mode (<600px) drops rowActions; pressing the card toggles
              // the same detail panel (with the decision) the chevron opens.
              renderMobileCard={(row) => (
                <ClaimMobileCard
                  row={row}
                  footer={
                    // The card has no Resolution column: an approved claim
                    // whose refund is unconfirmed must not read as settled.
                    isRefundPending(row) ? (
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
                  <StaffClaimPanel claim={row} onAnnounce={announce} />
                ) : null
              }
              emptyState={
                <YStack alignItems="center" gap="$2" padding="$4">
                  <Text variant="body" tone="muted">
                    {String(t("admin.pclNoResults"))}
                  </Text>
                  <Text variant="bodySmall" tone="muted">
                    {String(t("admin.pclAdjustFilters"))}
                  </Text>
                </YStack>
              }
            />
          </TableContainer>
          {totalPages > 1 && (
            <Pagination
              page={page}
              totalPages={totalPages}
              onPageChange={setPage}
            />
          )}
        </>
      )}
    </PlatformContainer>
  );
}
