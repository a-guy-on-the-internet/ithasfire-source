"use client";

import { useMemo, useState, useCallback, useEffect, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { useRouter } from "@bprogress/next/app";
import { styled, YStack, XStack } from "tamagui";
import {
  DataTable,
  type DataTableColumn,
  Button,
  Text,
  Badge,
  TextInput,
} from "@th/ui";
import {
  Banknote,
  X,
  ChevronDown,
  ExternalLink,
  Copy,
} from "lucide-react";
import { keepPreviousData } from "@tanstack/react-query";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";
// `truncateId` for our own UUIDs, `truncateProviderId` for Stripe ids — the
// latter are time-ordered and share a head, so head-only truncation renders
// sibling ids identically. See the note on `truncateProviderId`.
import {
  fmtDateShort,
  fmtCurrency,
  truncateId,
  truncateProviderId,
} from "@/lib/format";
import { useTranslations, useFormatters } from "@th/ui";
import { useIsMobile } from "@/hooks/useIsMobile";
import {
  SettlementMobileCard,
  SettlementStatusBadge,
} from "./_components/SettlementMobileCard";
import { PayeeDebtSection } from "./_components/PayeeDebtSection";
import { PayoutsOwedSection } from "./_components/PayoutsOwedSection";
import { PayoutsSentSection } from "./_components/PayoutsSentSection";
import { UpcomingPayoutsSection } from "./_components/UpcomingPayoutsSection";
import { PlatformRevenueSection } from "./_components/PlatformRevenueSection";
import { BatchClock } from "./_components/BatchClock";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type SettlementStatus = "pending" | "transferred" | "failed";

interface SettlementRow {
  id: string;
  payeeId: string;
  payeeSubjectType: string;
  payeeSubjectId: string;
  payeeLabel: string | null;
  date: Date;
  scheduledPayoutDate: Date;
  amountCents: number;
  currency: string;
  status: string;
  stripeTransferId: string | null;
  stripePaymentIntentIds: string[];
  eventId: string | null;
  eventTitle: string | null;
  lineCount: number;
  createdAt: Date;
}

const STATUS_OPTIONS: { value: SettlementStatus; labelKey: string }[] = [
  { value: "pending", labelKey: "admin.pstStatusPending" },
  { value: "transferred", labelKey: "admin.pstStatusTransferred" },
  { value: "failed", labelKey: "admin.pstStatusFailed" },
];

const PAGE_SIZE = 25;

// ─────────────────────────────────────────────────────────────────────────────
// Styled
// ─────────────────────────────────────────────────────────────────────────────

const Container = styled(YStack, {
  padding: 24,
  gap: 20,
  maxWidth: 1400,
  width: "100%",
  marginHorizontal: "auto",
});

const ActionBar = styled(XStack, {
  gap: 12,
  alignItems: "center",
  flexWrap: "wrap",
});

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export default function PlatformSettlementsPage() {
  return (
    <Suspense>
      <SettlementsPageContent />
    </Suspense>
  );
}

function SettlementsPageContent() {
  const t = useTranslations();
  const fmt = useFormatters();
  const searchParams = useSearchParams();
  const router = useRouter();
  const isMobile = useIsMobile();

  // Initialize state from URL query params for deep-linking
  const initialStatus = searchParams.get("status") as SettlementStatus | null;
  const initialSearch = searchParams.get("search") ?? "";

  const [page, setPage] = useState(0);
  const [search, setSearch] = useState(initialSearch);
  const [debouncedSearch, setDebouncedSearch] = useState(initialSearch);
  const [statusFilter, setStatusFilter] = useState<
    SettlementStatus | undefined
  >(
    initialStatus && STATUS_OPTIONS.some((o) => o.value === initialStatus)
      ? initialStatus
      : undefined,
  );
  const [showFilters, setShowFilters] = useState(!!initialStatus);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const toggleExpand = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Sync state changes back to URL
  useEffect(() => {
    const params = new URLSearchParams();
    if (statusFilter) params.set("status", statusFilter);
    if (debouncedSearch) params.set("search", debouncedSearch);
    const qs = params.toString();
    const path = qs ? `/platform/settlements?${qs}` : "/platform/settlements";
    router.replace(path, { scroll: false });
  }, [statusFilter, debouncedSearch, router]);

  // Debounced search
  const searchTimerRef = useState<ReturnType<typeof setTimeout> | null>(null);
  const handleSearchChange = useCallback(
    (value: string) => {
      setSearch(value);
      if (searchTimerRef[0]) clearTimeout(searchTimerRef[0]);
      searchTimerRef[0] = setTimeout(() => {
        setDebouncedSearch(value);
        setPage(0);
      }, 300);
    },
    [searchTimerRef],
  );

  const query = trpc.platform.listSettlements.useQuery(
    {
      status: statusFilter,
      searchQuery: debouncedSearch || undefined,
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    },
    { placeholderData: keepPreviousData },
  );

  const rows: SettlementRow[] = useMemo(
    () =>
      (query.data?.items ?? []).map((item) => ({
        ...item,
        stripePaymentIntentIds: item.stripePaymentIntentIds ?? [],
        date: new Date(item.date),
        scheduledPayoutDate: new Date(item.scheduledPayoutDate),
        createdAt: new Date(item.createdAt),
      })),
    [query.data],
  );

  const totalPages = Math.ceil((query.data?.pageInfo?.total ?? 0) / PAGE_SIZE);

  const columns: DataTableColumn<SettlementRow>[] = useMemo(
    () => [
      {
        id: "id",
        header: String(t("admin.pstId")),
        cell: (row) => (
          <Text variant="code" fontSize={12}>
            {truncateId(row.id)}
          </Text>
        ),
        width: 100,
      },
      {
        id: "payee",
        header: String(t("admin.pstPayee")),
        cell: (row) => (
          <YStack>
            <Text variant="body" fontSize={13} weight="bold">
              {row.payeeLabel || truncateId(row.payeeSubjectId)}
            </Text>
            <Text variant="caption" tone="muted" fontSize={11}>
              {row.payeeSubjectType}
            </Text>
          </YStack>
        ),
        width: 180,
      },
      {
        id: "event",
        header: String(t("admin.pstEvent")),
        cell: (row) => (
          <Text variant="body" fontSize={13} truncate>
            {row.eventTitle || "\u2014"}
          </Text>
        ),
        width: 200,
      },
      {
        id: "amount",
        header: String(t("admin.pstAmount")),
        cell: (row) => (
          <Text variant="body" fontSize={13} weight="bold">
            {fmtCurrency(fmt, row.amountCents, row.currency)}
          </Text>
        ),
        width: 120,
      },
      {
        id: "status",
        header: String(t("admin.status")),
        cell: (row) => <SettlementStatusBadge status={row.status} />,
        width: 110,
      },
      {
        id: "lines",
        header: String(t("admin.pstLines")),
        cell: (row) => (
          <Text variant="body" fontSize={13}>
            {row.lineCount}
          </Text>
        ),
        width: 70,
      },
      {
        id: "scheduledPayoutDate",
        header: String(t("admin.pstPayoutDate")),
        noWrap: true,
        cell: (row) => (
          <Text variant="body" fontSize={13}>
            {fmtDateShort(fmt, row.scheduledPayoutDate)}
          </Text>
        ),
        width: 140,
      },
      {
        id: "stripeTransferId",
        header: String(t("admin.pstTransferId")),
        cell: (row) =>
          row.stripeTransferId ? (
            <Text
              variant="code"
              fontSize={12}
              color="$accent"
              cursor="pointer"
              textDecorationLine="underline"
              onPress={() =>
                window.open(
                  `https://dashboard.stripe.com/connect/transfers/${row.stripeTransferId}`,
                  "_blank",
                )
              }
            >
              {truncateProviderId(row.stripeTransferId)}
            </Text>
          ) : (
            <Text variant="code" fontSize={12} tone="muted">
              {"\u2014"}
            </Text>
          ),
        width: 120,
      },
      {
        id: "stripePaymentIntentIds",
        header: String(t("admin.pstPaymentIntents")),
        cell: (row) =>
          row.stripePaymentIntentIds.length > 0 ? (
            <YStack gap={2}>
              {row.stripePaymentIntentIds.map((piId) => (
                <Text
                  key={piId}
                  variant="code"
                  fontSize={11}
                  color="$accent"
                  cursor="pointer"
                  textDecorationLine="underline"
                  onPress={() =>
                    window.open(
                      `https://dashboard.stripe.com/payments/${piId}`,
                      "_blank",
                    )
                  }
                >
                  {/* Worst case in the app for head-only truncation: this is a
                      LIST inside ONE cell, so several PIs from the same
                      settlement — often bought within the same hour, hence
                      sharing a long prefix — stack up visually identical while
                      each opens a different Stripe URL. */}
                  {truncateProviderId(piId)}
                </Text>
              ))}
            </YStack>
          ) : (
            <Text variant="code" fontSize={12} tone="muted">
              {"\u2014"}
            </Text>
          ),
        width: 140,
      },
      {
        id: "createdAt",
        header: String(t("admin.pstCreated")),
        noWrap: true,
        cell: (row) => (
          <Text variant="body" fontSize={13}>
            {fmtDateShort(fmt, row.createdAt)}
          </Text>
        ),
        width: 130,
      },
      {
        id: "expand",
        header: "",
        cell: (row) => (
          <Button
            variant={expandedIds.has(row.id) ? "primary" : "ghost"}
            size="$1"
            onPress={() => toggleExpand(row.id)}
          >
            <ChevronDown
              size={14}
              style={{
                transition: "transform 0.2s",
                transform: expandedIds.has(row.id)
                  ? "rotate(180deg)"
                  : undefined,
              }}
            />
          </Button>
        ),
        width: 48,
      },
    ],
    [t, fmt, expandedIds, toggleExpand],
  );

  const clearFilters = useCallback(() => {
    setStatusFilter(undefined);
    setSearch("");
    setDebouncedSearch("");
    setPage(0);
  }, []);

  const hasActiveFilters = !!statusFilter || !!debouncedSearch;

  return (
    // On mobile the navigation shell already pads the page 40px per side;
    // stacking the container's own 24 on top leaves a 190px column at 320px.
    // Same override as the dispute desk (`DisputeDesk.tsx`).
    <Container paddingHorizontal={isMobile ? 0 : 24}>
      {/* Header — wraps so the refresh control never overflows at 360px */}
      <XStack
        justifyContent="space-between"
        alignItems="center"
        flexWrap="wrap"
        gap={8}
      >
        <XStack gap={12} alignItems="center">
          <Banknote size={24} />
          <Text variant="h2" tag="h1" fontSize={22}>
            {String(t("admin.pstTitle"))}
          </Text>
          {query.data?.pageInfo?.total != null && (
            <Badge tone="neutral" size="sm">
              {query.data.pageInfo.total}
            </Badge>
          )}
        </XStack>
        <Button variant="ghost" size="$1" onPress={() => query.refetch()}>
          {String(t("admin.pstRefresh"))}
        </Button>
      </XStack>

      {/* Action bar */}
      <ActionBar>
        <XStack flex={1} maxWidth={320}>
          <TextInput
            placeholder={t("admin.pstSearchPlaceholder") as string}
            value={search}
            onChangeText={handleSearchChange}
            size="$1"
          />
        </XStack>
        <Button
          variant={showFilters ? "secondary" : "ghost"}
          size="$1"
          onPress={() => setShowFilters(!showFilters)}
        >
          {String(t("admin.pstFilters"))}
        </Button>
        {hasActiveFilters && (
          <Button variant="ghost" size="$1" onPress={clearFilters}>
            {String(t("admin.pstClear"))}
          </Button>
        )}
      </ActionBar>

      {/* Filters row */}
      {showFilters && (
        <XStack gap={8} flexWrap="wrap">
          {STATUS_OPTIONS.map((opt) => (
            <Button
              key={opt.value}
              variant={statusFilter === opt.value ? "secondary" : "ghost"}
              size="$1"
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

      {/* Error */}
      {query.isError && (
        <Text color="$danger" variant="body">
          {formatErrorMessage(query.error)}
        </Text>
      )}

      {/* Table */}
      <DataTable
        rows={rows}
        columns={columns}
        getRowKey={(r) => r.id}
        isLoading={query.isLoading}
        onRowPress={(row) => toggleExpand(row.id)}
        // Borderless page-flow table with no scrolling ancestor —
        // scoped horizontal panning via DataTable's own wrapper.
        scrollContainer
        // Card mode drops the columns (incl. the expand chevron and inline
        // Stripe links), but the card press still toggles the expanded
        // SettlementDetail, which carries every ID and Stripe link — so all
        // actions stay reachable on phones.
        renderMobileCard={(row) => <SettlementMobileCard row={row} />}
        renderExpandedRow={(row) =>
          expandedIds.has(row.id) ? (
            <SettlementDetail
              row={row}
              onClose={() => toggleExpand(row.id)}
              fmt={fmt}
            />
          ) : null
        }
      />

      {/* Pagination */}
      {totalPages > 1 && (
        <XStack justifyContent="center" alignItems="center" gap={12}>
          <Button
            variant="ghost"
            size="$1"
            disabled={page === 0}
            onPress={() => setPage((p) => Math.max(0, p - 1))}
          >
            {String(t("admin.plPrevious"))}
          </Button>
          <Text variant="caption" tone="muted">
            {String(
              t("admin.plPage", { current: page + 1, total: totalPages }),
            )}
          </Text>
          <Button
            variant="ghost"
            size="$1"
            disabled={page >= totalPages - 1}
            onPress={() => setPage((p) => p + 1)}
          >
            {String(t("admin.plNext"))}
          </Button>
        </XStack>
      )}

      {/* Payout visibility, in the order a reader asks the questions: what do
          we owe NOW, what will we owe and WHEN, what have we sent, and who is
          in the hole. Owed comes first because it is the number with a
          decision attached; upcoming follows it because the two are halves of
          one question the ledger splits on maturity; the debt section stays
          last, where its badge still carries the alarm.

          The batch clock sits above all of them: every figure below is an
          input to a run, and until this line existed the page never said when
          that run happens — or whether it is even switched on. */}
      <XStack justifyContent="flex-end" flexWrap="wrap">
        <BatchClock />
      </XStack>
      <PayoutsOwedSection />
      <UpcomingPayoutsSection />
      <PayoutsSentSection />

      {/* The other book: what the platform kept, as against what it owes.
          Last because it answers a different question from everything above,
          and adjacency would invite a subtraction that means nothing. */}
      <PlatformRevenueSection />

      {/* Payees whose ledger payable is negative — the carry-forward the
          batch never lists. */}
      <PayeeDebtSection />
    </Container>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Settlement Detail Panel
// ─────────────────────────────────────────────────────────────────────────────

function DetailRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <XStack
      justifyContent="space-between"
      alignItems="center"
      paddingVertical={4}
      gap={8}
    >
      <Text variant="caption" tone="muted" fontSize={12} flexShrink={0}>
        {label}
      </Text>
      {/* minWidth 0 lets long IDs shrink and wrap instead of clipping the
          space-between row at narrow (320px) card-mode widths. */}
      <XStack minWidth={0} flexShrink={1} justifyContent="flex-end">
        {children}
      </XStack>
    </XStack>
  );
}

function CopyableId({ value }: { value: string }) {
  return (
    <XStack gap={4} alignItems="center" minWidth={0}>
      <Text
        variant="code"
        fontSize={12}
        minWidth={0}
        style={{ overflowWrap: "anywhere" }}
      >
        {value}
      </Text>
      <Copy
        size={12}
        style={{ cursor: "pointer", opacity: 0.5, flexShrink: 0 }}
        onClick={() => navigator.clipboard.writeText(value)}
      />
    </XStack>
  );
}

function SettlementDetail({
  row,
  onClose,
  fmt,
}: {
  row: SettlementRow;
  onClose: () => void;
  fmt: ReturnType<typeof useFormatters>;
}) {
  return (
    <YStack
      padding={20}
      gap={16}
      backgroundColor="$backgroundStrong"
      borderTopWidth={1}
      borderBottomWidth={1}
      borderColor="$borderColor"
    >
      {/* Header */}
      <XStack justifyContent="space-between" alignItems="center">
        <XStack gap={8} alignItems="center">
          <Text variant="h4" fontSize={16} weight="bold">
            Settlement Detail
          </Text>
          <SettlementStatusBadge status={row.status} />
        </XStack>
        <Button variant="ghost" size="$1" onPress={onClose}>
          <X size={16} />
        </Button>
      </XStack>

      {/* IDs */}
      <YStack gap={2}>
        <Text
          variant="caption"
          tone="muted"
          fontSize={11}
          textTransform="uppercase"
        >
          Identifiers
        </Text>
        <DetailRow label="Settlement ID">
          <CopyableId value={row.id} />
        </DetailRow>
        <DetailRow label="Payee ID">
          <CopyableId value={row.payeeId} />
        </DetailRow>
        {row.eventId && (
          <DetailRow label="Event ID">
            <CopyableId value={row.eventId} />
          </DetailRow>
        )}
      </YStack>

      {/* Payee */}
      <YStack gap={2}>
        <Text
          variant="caption"
          tone="muted"
          fontSize={11}
          textTransform="uppercase"
        >
          Payee
        </Text>
        <DetailRow label="Name">
          <Text variant="body" fontSize={13} weight="bold">
            {row.payeeLabel || "—"}
          </Text>
        </DetailRow>
        <DetailRow label="Type">
          <Badge tone="neutral" size="sm">
            {row.payeeSubjectType}
          </Badge>
        </DetailRow>
      </YStack>

      {/* Event */}
      <YStack gap={2}>
        <Text
          variant="caption"
          tone="muted"
          fontSize={11}
          textTransform="uppercase"
        >
          Event
        </Text>
        <DetailRow label="Event">
          <Text variant="body" fontSize={13}>
            {row.eventTitle || "—"}
          </Text>
        </DetailRow>
      </YStack>

      {/* Financials */}
      <YStack gap={2}>
        <Text
          variant="caption"
          tone="muted"
          fontSize={11}
          textTransform="uppercase"
        >
          Financials
        </Text>
        <DetailRow label="Amount">
          <Text variant="body" fontSize={14} weight="bold">
            {fmtCurrency(fmt, row.amountCents, row.currency)}
          </Text>
        </DetailRow>
        <DetailRow label="Currency">
          <Text variant="body" fontSize={13}>
            {row.currency.toUpperCase()}
          </Text>
        </DetailRow>
        <DetailRow label="Settlement Lines">
          <Text variant="body" fontSize={13}>
            {row.lineCount}
          </Text>
        </DetailRow>
      </YStack>

      {/* Schedule */}
      <YStack gap={2}>
        <Text
          variant="caption"
          tone="muted"
          fontSize={11}
          textTransform="uppercase"
        >
          Schedule
        </Text>
        <DetailRow label="Payout Date">
          <Text variant="body" fontSize={13}>
            {fmtDateShort(fmt, row.scheduledPayoutDate)}
          </Text>
        </DetailRow>
        <DetailRow label="Created">
          <Text variant="body" fontSize={13}>
            {fmtDateShort(fmt, row.createdAt)}
          </Text>
        </DetailRow>
      </YStack>

      {/* Stripe Links */}
      <YStack gap={2}>
        <Text
          variant="caption"
          tone="muted"
          fontSize={11}
          textTransform="uppercase"
        >
          Stripe
        </Text>
        {row.stripeTransferId ? (
          <DetailRow label="Transfer">
            <XStack gap={6} alignItems="center" minWidth={0}>
              <Text
                variant="code"
                fontSize={12}
                color="$accent"
                cursor="pointer"
                textDecorationLine="underline"
                minWidth={0}
                style={{ overflowWrap: "anywhere" }}
                onPress={() =>
                  window.open(
                    `https://dashboard.stripe.com/connect/transfers/${row.stripeTransferId}`,
                    "_blank",
                  )
                }
              >
                {row.stripeTransferId}
              </Text>
              <ExternalLink size={12} style={{ flexShrink: 0 }} />
            </XStack>
          </DetailRow>
        ) : (
          <DetailRow label="Transfer">
            <Text variant="body" fontSize={13} tone="muted">
              Not yet transferred
            </Text>
          </DetailRow>
        )}
        {row.stripePaymentIntentIds.length > 0 && (
          <DetailRow label="Payment Intents">
            <YStack gap={2} alignItems="flex-end" minWidth={0}>
              {row.stripePaymentIntentIds.map((piId) => (
                <Text
                  key={piId}
                  variant="code"
                  fontSize={12}
                  color="$accent"
                  cursor="pointer"
                  textDecorationLine="underline"
                  minWidth={0}
                  style={{ overflowWrap: "anywhere" }}
                  onPress={() =>
                    window.open(
                      `https://dashboard.stripe.com/payments/${piId}`,
                      "_blank",
                    )
                  }
                >
                  {piId}
                </Text>
              ))}
            </YStack>
          </DetailRow>
        )}
      </YStack>
    </YStack>
  );
}
