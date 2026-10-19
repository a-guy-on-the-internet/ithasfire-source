"use client";

import { useCallback, useMemo, useState } from "react";
import { XStack, YStack } from "tamagui";
import {
  Badge,
  Button,
  DataTable,
  DateTime,
  Money,
  Text,
  useTranslations,
  type DataTableColumn,
} from "@th/ui";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";
import { getAppErrorCode } from "@/lib/app-error";
import { truncateProviderId } from "@/lib/format";

import { SettlementStatusBadge } from "./SettlementMobileCard";
import {
  PayoutOwnerCell,
  usePlatformTimeZone,
  type PayoutOwnerRef,
} from "./PayoutOwner";

// ─────────────────────────────────────────────────────────────────────────────
// "Payouts sent" — the PAID half of the platform settlements page: when, how
// much, and to whom.
//
// GROSS AND SENT ARE BOTH SHOWN, with the deductions between them. A payout
// view that showed one number would make every withheld cent look like a bug;
// showing "we owed $500, withheld $3.50, sent $496.50" is legible. The
// deduction column lists only the NON-ZERO parts, so a clean transfer reads
// as "None" instead of four zeroes.
//
// WHEN is one value (`occurredAt`), computed server-side: `transferredAt` for
// a transfer that landed, the parent batch's `scheduledFor` for one that has
// not. It is also the sort key, so the visible date and the ordering can
// never disagree. Money in flight therefore sorts above settled history,
// which is what ops wants to see first.
//
// Cursor-paged by hand (`utils.fetch` + accumulated pages), not
// `useInfiniteQuery`: the procedure's strict input rejects the `direction`
// key the infinite hook injects. Same pattern as the dispute desk and the
// sibling "Payees in debt" section.
// ─────────────────────────────────────────────────────────────────────────────

const PAGE_SIZE = 25;

type StatusFilter = "all" | "transferred" | "failed" | "pending";

const STATUS_FILTERS: { value: StatusFilter; labelKey: string }[] = [
  { value: "all", labelKey: "admin.pstPaidFilterAll" },
  { value: "transferred", labelKey: "admin.pstStatusTransferred" },
  { value: "pending", labelKey: "admin.pstStatusPending" },
  { value: "failed", labelKey: "admin.pstStatusFailed" },
];

export interface PayoutSentRow extends PayoutOwnerRef {
  id: string;
  payoutId: string;
  currency: string;
  amountCents: number;
  /** Null on pre-cutover rows — the net was never recorded. */
  netCents: number | null;
  connectAccountFeeCents: number;
  recoveredDebtCents: number;
  reserveHeldCents: number;
  reserveReleasedCents: number;
  status: "pending" | "transferred" | "failed";
  occurredAt: Date;
  transferredAt: Date | null;
  scheduledFor: Date;
  failedAt: Date | null;
  failureReason: string | null;
  stripeTransferId: string | null;
  payoutStatus: string;
  processorBatchId: string | null;
}

type HistoryPage = {
  items: Array<
    Omit<
      PayoutSentRow,
      "occurredAt" | "transferredAt" | "scheduledFor" | "failedAt"
    > & {
      occurredAt: Date | string;
      transferredAt: Date | string | null;
      scheduledFor: Date | string;
      failedAt: Date | string | null;
    }
  >;
  nextCursor: string | null;
  total: number;
};

const MONO = { fontFamily: "$mono" } as const;
const NOWRAP = { whiteSpace: "nowrap" } as const;

const toDate = (v: Date | string): Date => new Date(v);
const toDateOrNull = (v: Date | string | null): Date | null =>
  v ? new Date(v) : null;

/** When: the transfer instant, or the schedule it is still waiting on. */
function WhenCell({
  row,
  timeZone,
}: {
  row: PayoutSentRow;
  timeZone: string;
}) {
  const t = useTranslations();
  return (
    <YStack minWidth={0}>
      {/* The column's `noWrap` does not reach this Text, and "Sep 11, 2026,
          12:00 AM" broke across two lines without it. */}
      <DateTime
        value={row.occurredAt}
        timeZone={timeZone}
        format="datetime"
        variant="bodySmall"
        style={NOWRAP}
      />
      {!row.transferredAt && (
        // Says WHY this date is not a transfer date, so a scheduled instant
        // is never read as "we sent it then".
        <Text variant="caption" tone="muted">
          {String(t("admin.pstPaidScheduled"))}
        </Text>
      )}
    </YStack>
  );
}

/**
 * The deductions that explain gross → sent. Only non-zero parts render: four
 * zeroes in a column is noise, and it buries the one line that mattered.
 */
export function deductionParts(
  row: PayoutSentRow,
  t: (key: string) => unknown,
): Array<{ key: string; label: string; cents: number; sign: "-" | "+" }> {
  const parts: Array<{
    key: string;
    label: string;
    cents: number;
    sign: "-" | "+";
  }> = [];
  if (row.connectAccountFeeCents > 0) {
    parts.push({
      key: "fee",
      label: String(t("admin.pstPaidFee")),
      cents: row.connectAccountFeeCents,
      sign: "-",
    });
  }
  if (row.reserveHeldCents > 0) {
    parts.push({
      key: "reserveHeld",
      label: String(t("admin.pstPaidReserveHeld")),
      cents: row.reserveHeldCents,
      sign: "-",
    });
  }
  if (row.recoveredDebtCents > 0) {
    parts.push({
      key: "debt",
      label: String(t("admin.pstPaidDebtRecovered")),
      cents: row.recoveredDebtCents,
      sign: "-",
    });
  }
  // Matured reserve rides ALONG with the transfer — it ADDS. Rendering it in
  // the same column as the withholdings without the sign would read as a
  // deduction and make the arithmetic look wrong.
  if (row.reserveReleasedCents > 0) {
    parts.push({
      key: "reserveReleased",
      label: String(t("admin.pstPaidReserveReleased")),
      cents: row.reserveReleasedCents,
      sign: "+",
    });
  }
  return parts;
}

function DeductionsCell({ row }: { row: PayoutSentRow }) {
  const t = useTranslations();
  const parts = deductionParts(row, t);
  if (parts.length === 0) {
    return (
      <Text variant="caption" tone="muted">
        {String(t("admin.pstPaidNoDeductions"))}
      </Text>
    );
  }
  return (
    <YStack gap={2} minWidth={0}>
      {parts.map((part) => (
        <XStack key={part.key} gap="$1" alignItems="baseline" minWidth={0}>
          <Text variant="caption" tone="muted" flexShrink={1} minWidth={0}>
            {part.label}
          </Text>
          <Text variant="caption" tone="muted" style={NOWRAP} {...MONO}>
            {part.sign}
          </Text>
          <Money
            cents={part.cents}
            currency={row.currency.toUpperCase()}
            variant="caption"
            tone="muted"
            style={NOWRAP}
            {...MONO}
          />
        </XStack>
      ))}
    </YStack>
  );
}

/**
 * What actually reached Stripe — or an honest blank.
 *
 * `plannedNetCents` was added `NOT NULL DEFAULT 0`, so every PayoutItem
 * written before that migration carries a backfilled zero. Rendering it would
 * report a transferred $500 item as "Sent $0.00": money that demonstrably
 * moved, shown as nothing sent. The server maps those rows to null (see
 * `PayoutHistoryItem.netCents`) and they render the same em dash the owed
 * side uses for an unreported figure.
 */
function NetCell({ row }: { row: PayoutSentRow }) {
  const t = useTranslations();
  if (row.netCents === null) {
    return (
      <YStack alignItems="flex-end" gap={2}>
        <Text variant="bodySmall" weight="bold" style={NOWRAP} {...MONO}>
          {"\u2014"}
        </Text>
        <Text variant="caption" tone="muted" textAlign="right">
          {String(t("admin.pstPaidNetNotRecorded"))}
        </Text>
      </YStack>
    );
  }
  return (
    <Money
      cents={row.netCents}
      currency={row.currency.toUpperCase()}
      variant="bodySmall"
      weight="bold"
      style={NOWRAP}
      {...MONO}
    />
  );
}

function TransferCell({ row }: { row: PayoutSentRow }) {
  const t = useTranslations();
  if (row.stripeTransferId) {
    return (
      <Text
        variant="code"
        fontSize={12}
        color="$accent"
        cursor="pointer"
        textDecorationLine="underline"
        onPress={() =>
          window.open(
            // Encoded even though Stripe ids are `tr_` + base62 today: this
            // value is third-party data on a staff page, and `noopener` keeps
            // the opened tab off `window.opener`.
            `https://dashboard.stripe.com/connect/transfers/${encodeURIComponent(
              row.stripeTransferId ?? "",
            )}`,
            "_blank",
            "noopener,noreferrer",
          )
        }
      >
        {truncateProviderId(row.stripeTransferId)}
      </Text>
    );
  }
  if (row.failureReason) {
    return (
      <Text variant="caption" tone="error">
        {String(t("admin.pstPaidFailureReason", { reason: row.failureReason }))}
      </Text>
    );
  }
  return (
    <Text variant="caption" tone="muted">
      {String(t("admin.pstPaidNoTransfer"))}
    </Text>
  );
}

export function PayoutsSentSection() {
  const t = useTranslations();
  const { timeZone, resolved: timeZoneResolved } = usePlatformTimeZone();
  const utils = trpc.useUtils();

  const [status, setStatus] = useState<StatusFilter>("all");

  const query = trpc.platform.listPayoutHistory.useQuery({
    status,
    limit: PAGE_SIZE,
  });

  // Extra cursor pages, keyed by the first page's `dataUpdatedAt` so a
  // refetch — or a filter change — voids the chain behind it and "Load more"
  // comes back.
  const [extra, setExtra] = useState<{
    dataUpdatedAt: number;
    pages: HistoryPage[];
  }>({ dataUpdatedAt: 0, pages: [] });
  const extraPages = useMemo(
    () => (extra.dataUpdatedAt === query.dataUpdatedAt ? extra.pages : []),
    [extra, query.dataUpdatedAt],
  );
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);

  const rows = useMemo<PayoutSentRow[]>(() => {
    const seen = new Set<string>();
    const out: PayoutSentRow[] = [];
    for (const page of [query.data, ...extraPages]) {
      for (const item of page?.items ?? []) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        out.push({
          ...item,
          occurredAt: toDate(item.occurredAt),
          transferredAt: toDateOrNull(item.transferredAt),
          scheduledFor: toDate(item.scheduledFor),
          failedAt: toDateOrNull(item.failedAt),
        });
      }
    }
    return out;
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
      const page = await utils.platform.listPayoutHistory.fetch({
        status,
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
  }, [nextCursor, loadingMore, utils, query.dataUpdatedAt, status, t]);

  // `DataTableColumn.width` is a RELATIVE WEIGHT, not pixels: DataTable
  // normalises the weights to percentages of a `width: 100%` table, so a
  // column can never push the table wider — widening one column STARVES the
  // rest. Two clipped cells were produced exactly that way ("MX$4,150.0(" and
  // a "TRANSFERR…" badge) by bumping two neighbours. These weights are sized
  // against the widest real content in each column, with the total left
  // comfortably under the available width so nothing is squeezed.
  const columns = useMemo<DataTableColumn<PayoutSentRow>[]>(
    () => [
      {
        id: "when",
        header: String(t("admin.pstPaidColWhen")),
        noWrap: true,
        cell: (row) => <WhenCell row={row} timeZone={timeZone} />,
        // "Sep 11, 2026, 12:00 AM", nowrap.
        width: 170,
      },
      {
        id: "payee",
        header: String(t("admin.pstPaidColPayee")),
        cell: (row) => <PayoutOwnerCell row={row} currency={row.currency} />,
        width: 150,
      },
      {
        id: "gross",
        header: String(t("admin.pstPaidColGross")),
        align: "right",
        cell: (row) => (
          <Money
            cents={row.amountCents}
            currency={row.currency.toUpperCase()}
            variant="bodySmall"
            tone="muted"
            style={NOWRAP}
            {...MONO}
          />
        ),
        // "MX$4,150.00" — the widest currency the seed exercises.
        width: 110,
      },
      {
        id: "deductions",
        header: String(t("admin.pstPaidColDeductions")),
        cell: (row) => <DeductionsCell row={row} />,
        // "Reserve released + $68.00" on ONE line: at a smaller share the
        // label wrapped and left the sign and figure beside its second line.
        width: 190,
      },
      {
        id: "net",
        header: String(t("admin.pstPaidColNet")),
        align: "right",
        cell: (row) => <NetCell row={row} />,
        width: 115,
      },
      {
        id: "status",
        header: String(t("admin.status")),
        // Above the settlements table's 110: "TRANSFERRED" is the longest of
        // the three labels and the badge clipped it to "TRANSF…" there.
        cell: (row) => <SettlementStatusBadge status={row.status} />,
        width: 120,
      },
      {
        id: "transfer",
        header: String(t("admin.pstTransferId")),
        cell: (row) => <TransferCell row={row} />,
        width: 135,
      },
    ],
    [t, timeZone],
  );

  const total = query.data?.total ?? null;
  // "No payout has ever run" and "no FAILED payouts" are different facts and
  // must not share a sentence: the first is a state of the platform, the
  // second is a state of this filter.
  const emptyMessage =
    status === "all"
      ? String(t("admin.pstPaidEmptyEver"))
      : String(t("admin.pstPaidEmptyFiltered"));

  return (
    <YStack gap={12} tag="section" aria-labelledby="payouts-sent-heading">
      <YStack gap={4}>
        <XStack gap={8} alignItems="center" flexWrap="wrap">
          <Text variant="h3" tag="h2" id="payouts-sent-heading">
            {String(t("admin.pstPaidTitle"))}
          </Text>
          {total != null && (
            <Badge tone="neutral" size="sm">
              {total}
            </Badge>
          )}
        </XStack>
        <Text variant="bodySmall" tone="muted">
          {String(t("admin.pstPaidIntro"))}
        </Text>
        {/* Only after the zone is resolved client-side. Rendering it during
            SSR would bake the SERVER's zone into the markup and mismatch on
            hydration for every reader outside it. */}
        {timeZoneResolved && (
          <Text variant="caption" tone="muted">
            {String(t("admin.pstPaidTimeZoneNote", { zone: timeZone }))}
          </Text>
        )}
      </YStack>

      <XStack gap={8} flexWrap="wrap" role="group" aria-label={String(t("admin.status"))}>
        {STATUS_FILTERS.map((opt) => (
          <Button
            key={opt.value}
            variant={status === opt.value ? "secondary" : "ghost"}
            size="$1"
            aria-pressed={status === opt.value}
            onPress={() => {
              setStatus(opt.value);
              // Cursor pages belong to the previous filter; keeping them
              // would splice two different result sets into one list.
              setExtra({ dataUpdatedAt: 0, pages: [] });
              setLoadMoreError(null);
            }}
          >
            {String(t(opt.labelKey))}
          </Button>
        ))}
      </XStack>

      {query.isError &&
        (getAppErrorCode(query.error) === "SERVICE_UNAVAILABLE" ? (
          <XStack gap={12} alignItems="center" flexWrap="wrap" role="alert">
            <Text color="$danger" variant="body">
              {String(t("admin.pstPaidTimedOut"))}
            </Text>
            <Button
              variant="ghost"
              size="$1"
              onPress={() => query.refetch()}
              disabled={query.isFetching}
            >
              {String(t("admin.pstPaidRetry"))}
            </Button>
          </XStack>
        ) : (
          <Text color="$danger" variant="body" role="alert">
            {formatErrorMessage(query.error)}
          </Text>
        ))}

      <DataTable
        rows={rows}
        columns={columns}
        getRowKey={(r) => r.id}
        isLoading={query.isLoading}
        caption={String(t("admin.pstPaidCaption"))}
        scrollContainer
        renderMobileCard={(row) => (
          <PayoutSentMobileCard row={row} timeZone={timeZone} />
        )}
        emptyState={
          <Text variant="bodySmall" tone="muted">
            {emptyMessage}
          </Text>
        }
      />

      {loadMoreError && (
        <Text color="$danger" variant="bodySmall">
          {loadMoreError}
        </Text>
      )}

      {nextCursor && (
        <XStack justifyContent="center">
          <Button
            variant="ghost"
            size="$1"
            onPress={handleLoadMore}
            disabled={loadingMore}
          >
            {loadingMore
              ? String(t("admin.pstPaidLoading"))
              : String(t("admin.pstPaidLoadMore"))}
          </Button>
        </XStack>
      )}
    </YStack>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Mobile card (DataTable card mode, <600px)
// ─────────────────────────────────────────────────────────────────────────────

export function PayoutSentMobileCard({
  row,
  timeZone,
}: {
  row: PayoutSentRow;
  timeZone: string;
}) {
  const t = useTranslations();
  const parts = deductionParts(row, t);
  return (
    <YStack gap="$2" minWidth={0}>
      <XStack
        gap="$2"
        alignItems="flex-start"
        justifyContent="space-between"
        minWidth={0}
      >
        <YStack flex={1} minWidth={0}>
          <PayoutOwnerCell row={row} currency={row.currency} />
        </YStack>
        <XStack flexShrink={0}>
          <NetCell row={row} />
        </XStack>
      </XStack>

      {/* Status gets its own line: inside the header row its width squeezed
          the payee column to nothing at 320px. */}
      <XStack gap="$2" alignItems="center" flexWrap="wrap">
        <SettlementStatusBadge status={row.status} />
        <DateTime
          value={row.occurredAt}
          timeZone={timeZone}
          format="datetime"
          variant="caption"
          tone="muted"
        />
      </XStack>

      <XStack gap="$1" alignItems="baseline" flexWrap="wrap">
        <Text variant="caption" tone="muted">
          {String(t("admin.pstPaidColGross"))}
        </Text>
        <Money
          cents={row.amountCents}
          currency={row.currency.toUpperCase()}
          variant="caption"
          tone="muted"
          style={NOWRAP}
          {...MONO}
        />
      </XStack>

      {parts.length > 0 && (
        <YStack gap={2} minWidth={0}>
          {parts.map((part) => (
            <XStack key={part.key} gap="$1" alignItems="baseline" minWidth={0}>
              <Text variant="caption" tone="muted" flexShrink={1} minWidth={0}>
                {part.label}
              </Text>
              <Text variant="caption" tone="muted" style={NOWRAP} {...MONO}>
                {part.sign}
              </Text>
              <Money
                cents={part.cents}
                currency={row.currency.toUpperCase()}
                variant="caption"
                tone="muted"
                style={NOWRAP}
                {...MONO}
              />
            </XStack>
          ))}
        </YStack>
      )}

      {row.failureReason && (
        <Text variant="caption" tone="error">
          {String(t("admin.pstPaidFailureReason", { reason: row.failureReason }))}
        </Text>
      )}
    </YStack>
  );
}
