"use client";

import { useCallback, useMemo, useState } from "react";
import { XStack, YStack } from "tamagui";
import {
  Button,
  DataTable,
  type DataTableColumn,
  NextLinkAnchor,
  Text,
  useFormatters,
  useTranslations,
} from "@th/ui";
import { Banknote } from "lucide-react";

import { MoneyText } from "../../_components/MoneyText";
import { trpc } from "@/trpc";
import { useIsMobile } from "@/hooks/useIsMobile";
import { formatErrorMessage } from "@/lib/format-error-message";
import { getAppErrorCode } from "@/lib/app-error";
import { fmtDateShort, truncateId } from "@/lib/format";

// ─────────────────────────────────────────────────────────────────────────────
// "Unpaid tax on cash" (door-sales spec 2026-10-07, FR-013; board P1).
//
// Payees whose door cash-sale debt — the tax the organiser kept in cash (and
// the platform fee too, on a sale recorded before the owner ruling of
// 2026-10-08) — has gone unrecovered by later payouts for more than 30 days.
// Staff collect it by hand. Read-only.
//
// The cell that demands action is Payouts "Not set up": no connected Stripe
// account, so no payout will ever net the debt off. Those rows sort first.
//
// Cursor-paged by hand (`utils.fetch` + accumulated pages), not
// `useInfiniteQuery`: the procedure's strict input rejects the `direction`
// key the infinite hook injects. Same pattern as "Payees in debt".
//
// Copy is untranslated English, like the other staff-only platform surfaces.
// ─────────────────────────────────────────────────────────────────────────────

const PAGE_SIZE = 25;

export interface CashDebtRow {
  payeeId: string;
  subjectType: "ORGANIZATION" | "HUMAN";
  subjectId: string;
  orgName: string | null;
  orgSlug: string | null;
  currency: string;
  unrecoveredCashDebtCents: number;
  overdueCashDebtCents: number;
  oldestUnrecoveredAt: Date;
  hasStripeAccount: boolean;
  payoutsEnabled: boolean;
  payableCents: number;
}

type CashDebtPage = {
  items: Array<
    Omit<CashDebtRow, "oldestUnrecoveredAt"> & {
      oldestUnrecoveredAt: Date | string;
    }
  >;
  nextCursor: string | null;
  total: number;
  overdueBefore: Date | string;
};

export const rowKey = (row: Pick<CashDebtRow, "payeeId" | "currency">) =>
  `${row.payeeId}:${row.currency}`;

/** "Not set up" first (nothing will ever recover it), server order after. */
export function orderCashDebtRows(rows: CashDebtRow[]): CashDebtRow[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort(
      (a, b) =>
        Number(a.row.hasStripeAccount) - Number(b.row.hasStripeAccount) ||
        a.index - b.index,
    )
    .map(({ row }) => row);
}

export type PayoutState = "notSetUp" | "paused" | "on";

export function payoutState(
  row: Pick<CashDebtRow, "hasStripeAccount" | "payoutsEnabled">,
): PayoutState {
  if (!row.hasStripeAccount) return "notSetUp";
  return row.payoutsEnabled ? "on" : "paused";
}

const PAYOUT_LABEL: Record<PayoutState, string> = {
  notSetUp: "Not set up",
  paused: "Paused",
  on: "On",
};

const PAYOUT_TONE: Record<PayoutState, "warning" | "muted" | "success"> = {
  notSetUp: "warning",
  paused: "muted",
  on: "success",
};

/** Org rows link to their admin page; a person has none, and no name here. */
export function payeeHref(row: CashDebtRow): string | null {
  if (row.subjectType !== "ORGANIZATION" || !row.orgSlug) return null;
  return `/admin/${encodeURIComponent(row.orgSlug)}`;
}

export function payeeName(row: CashDebtRow): string {
  return row.orgName?.trim() || truncateId(row.subjectId);
}

const NOWRAP = { whiteSpace: "nowrap" } as const;

function PayeeCell({ row }: { row: CashDebtRow }) {
  const href = payeeHref(row);
  const name = payeeName(row);
  return (
    <XStack gap="$1" alignItems="baseline" flexWrap="wrap" minWidth={0}>
      {href ? (
        <NextLinkAnchor href={href}>
          <Text variant="bodySmall" weight="bold" color="$accentText">
            {name}
          </Text>
        </NextLinkAnchor>
      ) : (
        <Text variant="bodySmall" weight="bold">
          {name}
        </Text>
      )}
      {row.subjectType === "HUMAN" && (
        <Text variant="bodySmall" tone="muted">
          {"· person"}
        </Text>
      )}
    </XStack>
  );
}

function PayoutCell({ row }: { row: CashDebtRow }) {
  const state = payoutState(row);
  return (
    <Text variant="overline" tone={PAYOUT_TONE[state]} style={NOWRAP}>
      {PAYOUT_LABEL[state]}
    </Text>
  );
}

function CashDebtMobileCard({ row }: { row: CashDebtRow }) {
  const fmt = useFormatters();
  return (
    <YStack gap="$2" minWidth={0}>
      <XStack
        gap="$2"
        alignItems="flex-start"
        justifyContent="space-between"
        minWidth={0}
      >
        <YStack flex={1} minWidth={0}>
          <PayeeCell row={row} />
        </YStack>
        <YStack alignItems="flex-end" flexShrink={0}>
          <MoneyText
            cents={row.overdueCashDebtCents}
            currency={row.currency}
            variant="bodySmall"
            weight="bold"
            style={NOWRAP}
          />
          <Text variant="caption" tone="muted">
            over 30 days
          </Text>
        </YStack>
      </XStack>
      <XStack gap="$3" flexWrap="wrap" alignItems="baseline">
        <PayoutCell row={row} />
        <Text variant="caption" tone="muted">
          {`Oldest ${fmtDateShort(fmt, row.oldestUnrecoveredAt)}`}
        </Text>
      </XStack>
      <XStack gap="$3" flexWrap="wrap">
        <XStack gap="$1" alignItems="baseline">
          <Text variant="caption" tone="muted">
            All unpaid
          </Text>
          <MoneyText
            cents={row.unrecoveredCashDebtCents}
            currency={row.currency}
            variant="bodySmall"
            style={NOWRAP}
          />
        </XStack>
        <XStack gap="$1" alignItems="baseline">
          <Text variant="caption" tone="muted">
            Balance
          </Text>
          <MoneyText
            cents={row.payableCents}
            currency={row.currency}
            variant="bodySmall"
            style={NOWRAP}
          />
        </XStack>
      </XStack>
    </YStack>
  );
}

export function CashDebtsView() {
  const t = useTranslations();
  const fmt = useFormatters();
  const utils = trpc.useUtils();
  const isMobile = useIsMobile();

  const query = trpc.platform.listUnrecoveredCashDebts.useQuery({
    limit: PAGE_SIZE,
  });

  // Extra cursor pages, keyed by the first page's `dataUpdatedAt` so a
  // refetch voids the chain behind it and "Load more" comes back.
  const [extra, setExtra] = useState<{
    dataUpdatedAt: number;
    pages: CashDebtPage[];
  }>({ dataUpdatedAt: 0, pages: [] });
  const extraPages = useMemo(
    () => (extra.dataUpdatedAt === query.dataUpdatedAt ? extra.pages : []),
    [extra, query.dataUpdatedAt],
  );
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);

  const rows = useMemo<CashDebtRow[]>(() => {
    const seen = new Set<string>();
    const out: CashDebtRow[] = [];
    for (const page of [query.data, ...extraPages]) {
      for (const item of page?.items ?? []) {
        const key = rowKey(item);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          ...item,
          oldestUnrecoveredAt: new Date(item.oldestUnrecoveredAt),
        });
      }
    }
    return orderCashDebtRows(out);
  }, [query.data, extraPages]);

  const nextCursor =
    extraPages.length > 0
      ? extraPages[extraPages.length - 1]!.nextCursor
      : (query.data?.nextCursor ?? null);

  const handleLoadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      const page = await utils.platform.listUnrecoveredCashDebts.fetch({
        cursor: nextCursor,
        limit: PAGE_SIZE,
      });
      const dataUpdatedAt = query.dataUpdatedAt;
      setExtra((prev) => ({
        dataUpdatedAt,
        pages:
          prev.dataUpdatedAt === dataUpdatedAt ? [...prev.pages, page] : [page],
      }));
    } catch (err) {
      setLoadMoreError(formatErrorMessage(err, (key) => String(t(key))));
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, loadingMore, utils, query.dataUpdatedAt, t]);

  const columns = useMemo<DataTableColumn<CashDebtRow>[]>(
    () => [
      {
        id: "payee",
        header: "Group",
        cell: (row) => <PayeeCell row={row} />,
        width: 260,
      },
      {
        id: "overdue",
        header: "Over 30 days",
        align: "right",
        cell: (row) => (
          <MoneyText
            cents={row.overdueCashDebtCents}
            currency={row.currency}
            variant="bodySmall"
            weight="bold"
            style={NOWRAP}
          />
        ),
        width: 140,
      },
      {
        id: "unrecovered",
        header: "All unpaid",
        align: "right",
        cell: (row) => (
          <MoneyText
            cents={row.unrecoveredCashDebtCents}
            currency={row.currency}
            variant="bodySmall"
            style={NOWRAP}
          />
        ),
        width: 140,
      },
      {
        id: "oldest",
        header: "Oldest",
        cell: (row) => (
          <Text variant="bodySmall" style={NOWRAP}>
            {fmtDateShort(fmt, row.oldestUnrecoveredAt)}
          </Text>
        ),
        width: 150,
      },
      {
        id: "payouts",
        header: "Payouts",
        cell: (row) => <PayoutCell row={row} />,
        width: 140,
      },
      {
        id: "balance",
        header: "Balance",
        align: "right",
        cell: (row) => (
          <MoneyText
            cents={row.payableCents}
            currency={row.currency}
            variant="bodySmall"
            style={NOWRAP}
          />
        ),
        width: 130,
      },
    ],
    [fmt],
  );

  const total = query.data?.total ?? null;
  const overdueBefore = query.data?.overdueBefore ?? null;

  return (
    // On mobile the navigation shell already pads the page; the container's
    // own 24 on top leaves too narrow a column at 320px (as Settlements).
    <YStack
      gap={20}
      width="100%"
      maxWidth={1400}
      marginHorizontal="auto"
      paddingVertical={24}
      paddingHorizontal={isMobile ? 0 : 24}
    >
      <YStack gap={8}>
        {/* The title wraps at 320px; a fixed line height keeps the two lines
            together and the icon on the first. */}
        <XStack gap={12} alignItems="flex-start">
          <Banknote size={24} aria-hidden style={{ flexShrink: 0, marginTop: 2 }} />
          <Text variant="h2" tag="h1" fontSize={22} lineHeight={28}>
            Unpaid tax on cash
          </Text>
        </XStack>
        <Text variant="bodySmall" tone="muted" maxWidth={760}>
          Tax on door cash sales, plus the platform fee on sales from before
          Oct 8, 2026, that no payout has covered for more than 30 days.
          Collect by hand for now.
        </Text>
      </YStack>

      <XStack
        justifyContent="space-between"
        alignItems="center"
        flexWrap="wrap"
        gap={8}
      >
        <Button
          variant="ghost"
          size="$1"
          onPress={() => void query.refetch()}
          disabled={query.isFetching}
        >
          Refresh
        </Button>
        {total != null && total > 0 && overdueBefore != null && (
          <Text variant="overline" tone="muted">
            {`1–${rows.length} of ${total} · older than ${fmtDateShort(fmt, overdueBefore)}`}
          </Text>
        )}
      </XStack>

      {query.isError &&
        (getAppErrorCode(query.error) === "SERVICE_UNAVAILABLE" ? (
          <XStack gap={12} alignItems="center" flexWrap="wrap" role="alert">
            <Text color="$danger" variant="body">
              This view timed out. Try again.
            </Text>
            <Button
              variant="ghost"
              size="$1"
              onPress={() => void query.refetch()}
              disabled={query.isFetching}
            >
              Retry
            </Button>
          </XStack>
        ) : (
          <Text color="$danger" variant="body" role="alert">
            {formatErrorMessage(query.error, (key) => String(t(key)))}
          </Text>
        ))}

      {!query.isError && (
        <DataTable
          rows={rows}
          columns={columns}
          getRowKey={rowKey}
          isLoading={query.isLoading}
          scrollContainer
          renderMobileCard={(row) => <CashDebtMobileCard row={row} />}
          emptyState={
            <Text variant="bodySmall" tone="muted">
              Nothing unpaid for more than 30 days.
            </Text>
          }
        />
      )}

      {loadMoreError && (
        <Text color="$danger" variant="bodySmall" role="alert">
          {loadMoreError}
        </Text>
      )}

      {nextCursor && (
        <XStack justifyContent="center">
          <Button
            variant="ghost"
            size="$1"
            onPress={() => void handleLoadMore()}
            disabled={loadingMore}
          >
            {loadingMore ? "Loading…" : "Load more"}
          </Button>
        </XStack>
      )}
    </YStack>
  );
}
