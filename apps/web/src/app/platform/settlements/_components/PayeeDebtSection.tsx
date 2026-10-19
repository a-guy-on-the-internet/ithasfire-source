"use client";

import { useCallback, useMemo, useState } from "react";
import { XStack, YStack } from "tamagui";
import {
  Badge,
  Button,
  DataTable,
  type DataTableColumn,
  NextLinkAnchor,
  Text,
  useFormatters,
  useTranslations,
} from "@th/ui";
import { MoneyText } from "../../_components/MoneyText";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";
import { getAppErrorCode } from "@/lib/app-error";
import { fmtDateShort, truncateId } from "@/lib/format";

// ─────────────────────────────────────────────────────────────────────────────
// "Payees in debt" — payees whose ledger payable is NEGATIVE after a lost
// dispute or a post-payout refund. The payout batch pays them nothing and
// carries the debt forward; this is the only place ops sees that carry.
//
// The one cell that demands action is "Upcoming ticketed events: None" — a
// payee with no future TICKETED sales has no way to net the debt off, so it
// renders in the warning tone. The signal is exactly what it says: PUBLISHED
// TICKETED events (RSVP listings write no orders; membership income is not an
// event and is not counted). Everything else is read-only context.
//
// "Disputes (lifetime)" / "Refunds (lifetime)" are the cell's ALL-TIME debit
// sums, not the slice since `debtSinceAt` — chosen over a since-scoped sum
// because the lifetime figure is what the ledger actually stores and needs
// no second definition to explain.
//
// Cursor-paged by hand (`utils.fetch` + accumulated pages), not
// `useInfiniteQuery`: the procedure's strict input rejects the `direction`
// key the infinite hook injects. Same pattern as the dispute desk.
// ─────────────────────────────────────────────────────────────────────────────

const PAGE_SIZE = 25;

export interface PayeeDebtRow {
  payeeId: string;
  subjectType: "ORGANIZATION" | "HUMAN";
  subjectId: string;
  ownerLabel: string | null;
  ownerSlug: string | null;
  currency: string;
  /** Negative. */
  payableCents: number;
  debtSinceAt: Date | null;
  lastDebitType: "DISPUTE_DEBIT" | "REFUND_DEBIT" | "CASH_SALE_DEBIT" | null;
  lastDebitAt: Date | null;
  disputeDebitCents: number;
  refundDebitCents: number;
  openDisputeCount: number;
  upcomingEventCount: number;
  nextEventAt: Date | null;
}

type DebtPage = {
  items: Array<
    Omit<PayeeDebtRow, "debtSinceAt" | "lastDebitAt" | "nextEventAt"> & {
      debtSinceAt: Date | string | null;
      lastDebitAt: Date | string | null;
      nextEventAt: Date | string | null;
    }
  >;
  nextCursor: string | null;
  total: number;
};

const toDate = (v: Date | string | null): Date | null =>
  v ? new Date(v) : null;

export const rowKey = (row: Pick<PayeeDebtRow, "payeeId" | "currency">) =>
  `${row.payeeId}:${row.currency}`;

/**
 * Where "Owner" links. Organisations have an admin surface at
 * `/admin/<slug>`; humans have no admin page, so the link is the platform
 * humans list pre-filtered by name — the same target the support desk uses
 * (`SupportThreadDetail`). Null = no link (nameless human, slugless org).
 */
export function ownerHref(row: PayeeDebtRow): string | null {
  if (row.subjectType === "ORGANIZATION") {
    return row.ownerSlug ? `/admin/${encodeURIComponent(row.ownerSlug)}` : null;
  }
  const name = row.ownerLabel?.trim();
  return name ? `/platform/humans?q=${encodeURIComponent(name)}` : null;
}

export function ownerName(row: PayeeDebtRow): string {
  return row.ownerLabel?.trim() || truncateId(row.subjectId);
}

// i18n: key pending
const DEBIT_TYPE_LABEL: Record<
  NonNullable<PayeeDebtRow["lastDebitType"]>,
  string
> = {
  DISPUTE_DEBIT: "Dispute",
  REFUND_DEBIT: "Refund",
  CASH_SALE_DEBIT: "Cash sale",
};

const MONO = { fontFamily: "$mono" } as const;
// An amount or a count-with-date must never break mid-token: "MX$12.5 / 0"
// in a 120px column reads as a different number.
const NOWRAP = { whiteSpace: "nowrap" } as const;

function OwnerCell({ row }: { row: PayeeDebtRow }) {
  const href = ownerHref(row);
  const name = ownerName(row);
  // i18n: key pending
  const kind = row.subjectType === "ORGANIZATION" ? "Group" : "Human";
  return (
    <YStack minWidth={0}>
      {href ? (
        <NextLinkAnchor
          href={href}
          aria-label={`${name}, ${row.currency.toUpperCase()} ledger`}
        >
          <Text variant="bodySmall" weight="bold" color="$accentText">
            {name}
          </Text>
        </NextLinkAnchor>
      ) : (
        <Text variant="bodySmall" weight="bold">
          {name}
        </Text>
      )}
      <Text variant="caption" tone="muted">
        {kind}
      </Text>
    </YStack>
  );
}

/**
 * A cell that is negative with NO journal crossing and NO debit is a pending
 * DISPUTE_HOLD exceeding the matured credit: nothing has been lost yet, the
 * money is merely withheld while the dispute runs. Rendering that as red
 * "Owes" would tell ops a debt exists that may never materialise.
 */
export function isHeldOnly(row: PayeeDebtRow): boolean {
  return row.debtSinceAt === null && row.lastDebitType === null;
}

/** The badge half of a held-only cell — "Held" + "(dispute pending)" as two
 *  short runs so it fits a 140px column instead of clipping as one phrase. */
function HeldBadge() {
  return (
    <YStack alignItems="flex-end" gap={2}>
      <Badge tone="warning" size="sm">
        {/* i18n: key pending */}
        Held
      </Badge>
      {/* Wraps rather than clips if a column is ever narrower than this. */}
      <Text variant="caption" tone="muted" textAlign="right">
        {/* i18n: key pending */}
        (dispute pending)
      </Text>
    </YStack>
  );
}

function OwesCell({
  row,
  withBadge = true,
}: {
  row: PayeeDebtRow;
  /** Card mode renders the badge on its own line instead (see the card). */
  withBadge?: boolean;
}) {
  if (isHeldOnly(row)) {
    return (
      <YStack alignItems="flex-end" gap={2}>
        {withBadge && <HeldBadge />}
        <MoneyText
          cents={-row.payableCents}
          currency={row.currency}
          variant="caption"
          tone="muted"
          style={NOWRAP}
          {...MONO}
        />
      </YStack>
    );
  }
  return (
    <MoneyText
      cents={-row.payableCents}
      currency={row.currency}
      tone="error"
      weight="bold"
      style={NOWRAP}
      {...MONO}
    />
  );
}

// i18n: key pending
const SINCE_HINT =
  "Approximate — credits are weighted by today's availability, so the crossing point can move as credits mature or unblock.";

function NoneUpcoming() {
  return (
    <Text variant="bodySmall" weight="bold" tone="warning">
      {/* i18n: key pending */}
      None
    </Text>
  );
}

// i18n: key pending
const nextLabel = (
  fmt: ReturnType<typeof useFormatters>,
  row: PayeeDebtRow,
) => `Next ${fmtDateShort(fmt, row.nextEventAt)}`;

function UpcomingCell({
  row,
  fmt,
}: {
  row: PayeeDebtRow;
  fmt: ReturnType<typeof useFormatters>;
}) {
  if (row.upcomingEventCount === 0) return <NoneUpcoming />;
  return (
    <YStack minWidth={0}>
      <Text variant="bodySmall" {...MONO}>
        {row.upcomingEventCount}
      </Text>
      <Text variant="caption" tone="muted">
        {nextLabel(fmt, row)}
      </Text>
    </YStack>
  );
}

function OpenDisputesCell({ row }: { row: PayeeDebtRow }) {
  if (row.openDisputeCount === 0) {
    return (
      <Text variant="bodySmall" tone="muted" {...MONO}>
        0
      </Text>
    );
  }
  return (
    <NextLinkAnchor
      href="/platform/disputes"
      // The desk has no owner filter today, so the label promises only what
      // the link does. i18n: key pending
      aria-label={`${row.openDisputeCount} open for ${ownerName(row)} — open the dispute desk`}
    >
      <Text variant="bodySmall" weight="bold" color="$accentText" {...MONO}>
        {row.openDisputeCount}
      </Text>
    </NextLinkAnchor>
  );
}

function LastDebitCell({
  row,
  fmt,
}: {
  row: PayeeDebtRow;
  fmt: ReturnType<typeof useFormatters>;
}) {
  if (!row.lastDebitType) {
    return (
      <Text variant="bodySmall" tone="muted">
        {"—"}
      </Text>
    );
  }
  return (
    <YStack minWidth={0}>
      <Text variant="bodySmall">{DEBIT_TYPE_LABEL[row.lastDebitType]}</Text>
      <Text variant="caption" tone="muted">
        {fmtDateShort(fmt, row.lastDebitAt)}
      </Text>
    </YStack>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Mobile card (DataTable card mode, <600px)
// ─────────────────────────────────────────────────────────────────────────────

export function PayeeDebtMobileCard({ row }: { row: PayeeDebtRow }) {
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
          <OwnerCell row={row} />
        </YStack>
        <XStack flexShrink={0}>
          <OwesCell row={row} withBadge={false} />
        </XStack>
      </XStack>

      {/* The badge gets its own line: inside the header row its width
          squeezed the owner column to nothing at 320px. */}
      {isHeldOnly(row) && (
        <XStack>
          <HeldBadge />
        </XStack>
      )}

      {/* Two caption lines, not a dot-separated row: at 320px the pair
          wraps and a separator glyph is left dangling at the line end. */}
      <YStack gap={2}>
        {/* Plain span for the hover hint: `title` is not a Text prop. */}
        <span title={SINCE_HINT}>
          <Text variant="caption" tone="muted">
            {/* i18n: key pending */}
            {`First unrecovered debit ${fmtDateShort(fmt, row.debtSinceAt)}`}
          </Text>
        </span>
        {row.lastDebitType && (
          <Text variant="caption" tone="muted">
            {/* i18n: key pending */}
            {`Last debit: ${DEBIT_TYPE_LABEL[row.lastDebitType]} ${fmtDateShort(fmt, row.lastDebitAt)}`}
          </Text>
        )}
      </YStack>

      <XStack gap="$3" flexWrap="wrap">
        <XStack gap="$1" alignItems="baseline">
          <Text variant="caption" tone="muted">
            {/* i18n: key pending */}
            Disputes (lifetime)
          </Text>
          <MoneyText
            cents={row.disputeDebitCents}
            currency={row.currency}
            variant="bodySmall"
            {...MONO}
          />
        </XStack>
        <XStack gap="$1" alignItems="baseline">
          <Text variant="caption" tone="muted">
            {/* i18n: key pending */}
            Refunds (lifetime)
          </Text>
          <MoneyText
            cents={row.refundDebitCents}
            currency={row.currency}
            variant="bodySmall"
            {...MONO}
          />
        </XStack>
      </XStack>

      <XStack gap="$3" flexWrap="wrap" alignItems="flex-start">
        <XStack gap="$1" alignItems="baseline">
          <Text variant="caption" tone="muted">
            {/* i18n: key pending */}
            Open disputes
          </Text>
          <OpenDisputesCell row={row} />
        </XStack>
        {/* Label + count on one line, the next date as its own caption
            line — a single nowrap run overflowed the card at 320px. */}
        <YStack gap={2} minWidth={0}>
          <XStack gap="$1" alignItems="baseline">
            <Text variant="caption" tone="muted">
              {/* i18n: key pending */}
              Upcoming ticketed
            </Text>
            {row.upcomingEventCount === 0 ? (
              <NoneUpcoming />
            ) : (
              <Text variant="span" {...MONO}>
                {row.upcomingEventCount}
              </Text>
            )}
          </XStack>
          {row.upcomingEventCount > 0 && (
            <Text variant="caption" tone="muted">
              {nextLabel(fmt, row)}
            </Text>
          )}
        </YStack>
      </XStack>
    </YStack>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Section
// ─────────────────────────────────────────────────────────────────────────────

export function PayeeDebtSection() {
  const t = useTranslations();
  const fmt = useFormatters();
  const utils = trpc.useUtils();

  const query = trpc.platform.listPayeeDebtPositions.useQuery({
    limit: PAGE_SIZE,
  });

  // Extra cursor pages, keyed by the first page's `dataUpdatedAt` so a
  // refetch voids the chain behind it and "Load more" comes back.
  const [extra, setExtra] = useState<{ dataUpdatedAt: number; pages: DebtPage[] }>(
    { dataUpdatedAt: 0, pages: [] },
  );
  const extraPages = useMemo(
    () => (extra.dataUpdatedAt === query.dataUpdatedAt ? extra.pages : []),
    [extra, query.dataUpdatedAt],
  );
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);

  const rows = useMemo<PayeeDebtRow[]>(() => {
    const seen = new Set<string>();
    const out: PayeeDebtRow[] = [];
    for (const page of [query.data, ...extraPages]) {
      for (const item of page?.items ?? []) {
        const key = rowKey(item);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          ...item,
          debtSinceAt: toDate(item.debtSinceAt),
          lastDebitAt: toDate(item.lastDebitAt),
          nextEventAt: toDate(item.nextEventAt),
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
      const page = await utils.platform.listPayeeDebtPositions.fetch({
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

  const columns = useMemo<DataTableColumn<PayeeDebtRow>[]>(
    () => [
      {
        id: "owner",
        // i18n: key pending
        header: "Owner",
        cell: (row) => <OwnerCell row={row} />,
        width: 200,
      },
      {
        id: "owes",
        // i18n: key pending
        header: "Owes",
        align: "right",
        cell: (row) => <OwesCell row={row} />,
        width: 160,
      },
      {
        id: "since",
        // Header carries the approximation hint both as a hover title and in
        // the accessible name. i18n: key pending
        header: (
          <span
            title={SINCE_HINT}
            aria-label={`First unrecovered debit (${SINCE_HINT})`}
          >
            First unrecovered debit
          </span>
        ),
        cell: (row) => (
          <Text variant="bodySmall">{fmtDateShort(fmt, row.debtSinceAt)}</Text>
        ),
        width: 170,
      },
      {
        id: "lastDebit",
        // i18n: key pending
        header: "Last debit",
        cell: (row) => <LastDebitCell row={row} fmt={fmt} />,
        width: 130,
      },
      {
        id: "disputeDebits",
        // i18n: key pending
        header: "Disputes (lifetime)",
        align: "right",
        cell: (row) => (
          <MoneyText
            cents={row.disputeDebitCents}
            currency={row.currency}
            variant="bodySmall"
            {...MONO}
          />
        ),
        width: 130,
      },
      {
        id: "refundDebits",
        // i18n: key pending
        header: "Refunds (lifetime)",
        align: "right",
        cell: (row) => (
          <MoneyText
            cents={row.refundDebitCents}
            currency={row.currency}
            variant="bodySmall"
            {...MONO}
          />
        ),
        width: 130,
      },
      {
        id: "openDisputes",
        // i18n: key pending
        header: "Open disputes",
        align: "right",
        cell: (row) => <OpenDisputesCell row={row} />,
        width: 120,
      },
      {
        id: "upcoming",
        // i18n: key pending
        header: "Upcoming ticketed events",
        cell: (row) => <UpcomingCell row={row} fmt={fmt} />,
        width: 170,
      },
    ],
    [fmt],
  );

  const total = query.data?.total ?? null;

  return (
    <YStack gap={12} tag="section" aria-labelledby="payee-debt-heading">
      <YStack gap={4}>
        <XStack gap={8} alignItems="center" flexWrap="wrap">
          <Text variant="h3" tag="h2" id="payee-debt-heading">
            {/* i18n: key pending */}
            Payees in debt
          </Text>
          {total != null && (
            <Badge tone={total > 0 ? "danger" : "neutral"} size="sm">
              {total}
            </Badge>
          )}
        </XStack>
        <Text variant="bodySmall" tone="muted">
          {/* i18n: key pending */}
          Negative ledger balances after a lost dispute or a post-payout refund.
          The payout batch pays these payees nothing until future sales cover the
          debt — a payee with no upcoming ticketed events has nothing to recover
          from; membership income is not counted here.
        </Text>
      </YStack>

      {query.isError &&
        (getAppErrorCode(query.error) === "SERVICE_UNAVAILABLE" ? (
          <XStack gap={12} alignItems="center" flexWrap="wrap" role="alert">
            <Text color="$danger" variant="body">
              {/* i18n: key pending */}
              Debt view timed out — try again.
            </Text>
            <Button
              variant="ghost"
              size="$1"
              onPress={() => query.refetch()}
              disabled={query.isFetching}
            >
              {/* i18n: key pending */}
              Retry debt view
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
        getRowKey={rowKey}
        isLoading={query.isLoading}
        // i18n: key pending
        caption="Payees whose ledger balance is negative"
        scrollContainer
        renderMobileCard={(row) => <PayeeDebtMobileCard row={row} />}
        emptyState={
          <Text variant="bodySmall" tone="muted">
            {/* i18n: key pending */}
            No payee owes the platform anything.
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
            {/* i18n: key pending */}
            {loadingMore ? "Loading…" : "Load more payees in debt"}
          </Button>
        </XStack>
      )}
    </YStack>
  );
}
