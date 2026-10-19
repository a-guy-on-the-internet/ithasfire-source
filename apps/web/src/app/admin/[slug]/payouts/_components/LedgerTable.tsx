"use client";

import { useMemo, useState } from "react";
import { XStack, YStack } from "tamagui";
import {
  Button,
  DataTable,
  type DataTableColumn,
  Spinner,
  Text,
  useFormatters,
  useTranslations,
} from "@th/ui";
import { formatOrderCode } from "@th/types/order-identifier";
import type { PayeeStatementEntry } from "@th/core/use-cases/payouts/get-payee-statement";

import { fmtCurrency, fmtDateShort } from "@/lib/format";
import { BORDER } from "@/lib/design-tokens";

import {
  LEDGER_ENTRY_LABEL_KEY,
  ledgerEntryChange,
  ledgerHoldVerb,
  olderBalanceAfterCents,
  type LedgerChange,
} from "./ledger-entry-presentation";
import { MoneyText } from "./money-text";
import { DisclosureButton } from "./PayoutsSections";

// ─────────────────────────────────────────────────────────────────────────────
// The ledger: newest first, Date · Entry · Change · Balance. Everything here
// has already happened, so every row carries the balance it left behind —
// `entry.balanceAfterCents`, straight from the server, "—" when the server
// could not compute it. Paging APPENDS (offset/limit) so the running balance
// reads continuously down the page.
//
// Board B (2026-10-14): the 5 newest entries, then "Show all entries" opens
// the full table with Load more. Every row's change is computed against the
// FULL list before the preview is cut, so the 5th row reads the same folded
// or open.
//
// On a phone the four columns do not fit, and Change · Balance are the whole
// point — so below the app-wide 600px breakpoint `DataTable` renders each
// row as a stacked card instead of scrolling the promise off-screen.
// ─────────────────────────────────────────────────────────────────────────────

const EM_DASH = "—";
const MINUS = "−";

type LedgerRow = {
  entry: PayeeStatementEntry;
  change: LedgerChange;
  isFirst: boolean;
};

type LedgerTableProps = {
  entries: PayeeStatementEntry[];
  /** See `useStatementPages` — rows above a seam that may hide a gap. */
  unconfirmedSeams: ReadonlySet<number>;
  currency: string;
  hasMore: boolean;
  canLoadMore: boolean;
  balanceAfterResolved: boolean;
  /** Page 0 has not arrived: a placeholder stands in for the table. */
  isLoading: boolean;
  isLoadingMore: boolean;
  loadMoreError: string | null;
  /** Page 0 failed to refresh but its last result is still shown. */
  refreshError: string | null;
  onLoadMore: () => void;
  onRetry: () => void;
};

/** How many of the newest entries show before "Show all entries". */
export const LEDGER_PREVIEW_ROWS = 5;

const LEDGER_TABLE_ID = "payouts-ledger-table";

const SKELETON_ROWS = 4;
const SKELETON_ROW_HEIGHT = 44;

/**
 * Stands in for `DataTable` while page 0 is loading. `DataTable` delays its
 * own skeleton by 200 ms and shows `emptyState` in the meantime — which for
 * an org with history reads "Nothing has happened yet" for a fifth of a
 * second on every load. So the table is not mounted at all until page 0 has
 * resolved; this keeps the rows' height so the page does not jump.
 */
function LedgerPlaceholder() {
  return (
    <YStack gap="$1" aria-busy data-testid="ledger-skeleton">
      {Array.from({ length: SKELETON_ROWS }, (_, i) => (
        <div
          key={i}
          style={{
            height: SKELETON_ROW_HEIGHT,
            backgroundColor: BORDER,
            opacity: 0.35,
          }}
        />
      ))}
    </YStack>
  );
}

/**
 * The order code goes on the sub-line only when the description does not
 * already carry it — the server's descriptions often read "… — order
 * 0000dead", and "Order #0000DEAD" beside that is the same code twice.
 */
export function orderCodeSuffix(
  description: string,
  orderId: string | null,
): string | null {
  if (!orderId) return null;
  const code = formatOrderCode(orderId);
  const haystack = description.toLowerCase();
  if (haystack.includes(code.toLowerCase()) || haystack.includes(orderId.toLowerCase())) {
    return null;
  }
  return code;
}

/** A whole 8-4-4-4-12 hex UUID token (not part of a longer hex/word run). */
const UUID_TOKEN =
  /(?<![0-9a-z-])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-z-])/gi;

/**
 * Server descriptions written before the writers moved to short codes embed
 * full ids: the entry's own order id (cash sale, cash refund, dispute lines),
 * and others such as a payout id, a payout item id or a dispute id. Show the
 * entry's OWN order id as its order code, then any other full UUID as its last
 * 8 hex chars uppercased (the same shape as `formatOrderCode`). Stored rows
 * keep the long form. `orderCodeSuffix` must keep reading the ORIGINAL
 * description so the order code is neither shown twice nor dropped.
 */
export function descriptionWithOrderCode(
  description: string,
  orderId: string | null,
): string {
  let out = description;
  if (orderId) {
    // Matched on the original string, not a lowercased copy: lowercasing can
    // change a string's length, which would shift the splice points.
    const ownId = new RegExp(orderId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    const code = formatOrderCode(orderId);
    out = out.replace(ownId, () => code);
  }
  return out.replace(UUID_TOKEN, (id) => formatOrderCode(id));
}

function changeText(change: LedgerChange, money: (cents: number) => string) {
  return change.kind === "credit"
    ? `+${money(change.cents)}`
    : change.kind === "debit"
      ? `${MINUS}${money(change.cents)}`
      : EM_DASH;
}

export function LedgerTable({
  entries,
  unconfirmedSeams,
  currency,
  hasMore,
  canLoadMore,
  balanceAfterResolved,
  isLoading,
  isLoadingMore,
  loadMoreError,
  refreshError,
  onLoadMore,
  onRetry,
}: LedgerTableProps) {
  const t = useTranslations();
  const fmt = useFormatters();
  const [showAll, setShowAll] = useState(false);

  const allRows = useMemo<LedgerRow[]>(
    () =>
      entries.map((entry, index) => ({
        entry,
        change: ledgerEntryChange(
          entry,
          olderBalanceAfterCents(entries, index, hasMore, unconfirmedSeams),
        ),
        isFirst: index === 0,
      })),
    [entries, hasMore, unconfirmedSeams],
  );
  // Anything beyond the preview — loaded rows, or pages not loaded yet.
  const hasHidden = entries.length > LEDGER_PREVIEW_ROWS || hasMore;
  const rows = showAll ? allRows : allRows.slice(0, LEDGER_PREVIEW_ROWS);

  const money = useMemo(
    () => (cents: number) => fmtCurrency(fmt, cents, currency),
    [fmt, currency],
  );

  const entryCell = useMemo(
    () =>
      function EntryCell({ entry, change }: LedgerRow) {
        const verb = change.kind === "none" ? ledgerHoldVerb(entry.type) : null;
        const bucketLine =
          verb === "held"
            ? String(t("admin.payoutsEntryHeld", { amount: money(entry.amountCents) }))
            : verb === "released"
              ? String(t("admin.payoutsEntryReleased", { amount: money(entry.amountCents) }))
              : null;
        const code = orderCodeSuffix(entry.description, entry.orderId);
        const sub = [
          bucketLine,
          descriptionWithOrderCode(entry.description, entry.orderId) || null,
          code ? String(t("admin.payoutsEntryOrder", { code })) : null,
        ]
          .filter(Boolean)
          .join(" · ");
        return (
          <YStack gap="$1" minWidth={0}>
            <Text variant="body" weight="medium">
              {String(t(LEDGER_ENTRY_LABEL_KEY[entry.type]))}
            </Text>
            {sub && (
              <Text variant="caption" tone="muted">
                {sub}
              </Text>
            )}
          </YStack>
        );
      },
    [t, money],
  );

  const columns = useMemo<DataTableColumn<LedgerRow>[]>(
    () => [
      {
        id: "date",
        header: String(t("admin.payoutsLedgerColDate")),
        noWrap: true,
        width: 1,
        cell: ({ entry }) => (
          <Text variant="overline" tone="muted">
            {fmtDateShort(fmt, entry.createdAt)}
          </Text>
        ),
      },
      {
        id: "entry",
        header: String(t("admin.payoutsLedgerColEntry")),
        truncate: false,
        width: 4,
        cell: entryCell,
      },
      {
        id: "change",
        header: String(t("admin.payoutsLedgerColChange")),
        align: "right",
        noWrap: true,
        width: 1,
        cell: ({ change }) => (
          <MoneyText
            tone={change.kind === "none" ? "muted" : "default"}
            data-testid="ledger-change"
          >
            {changeText(change, money)}
          </MoneyText>
        ),
      },
      {
        id: "balance",
        header: String(t("admin.payoutsLedgerColBalance")),
        align: "right",
        noWrap: true,
        width: 1,
        cell: ({ entry }) => (
          <MoneyText
            weight="semibold"
            tone={entry.balanceAfterCents === null ? "muted" : "default"}
            data-testid="ledger-balance"
          >
            {entry.balanceAfterCents === null
              ? EM_DASH
              : money(entry.balanceAfterCents)}
          </MoneyText>
        ),
      },
    ],
    [t, fmt, money, entryCell],
  );

  const EntryCell = entryCell;

  return (
    // No heading of its own: the Payouts page's "Ledger" section heading
    // (an anchor target) names it.
    <YStack gap="$3" data-testid="payout-ledger">

      {!balanceAfterResolved && (
        <Text variant="caption" tone="muted" data-testid="ledger-balances-unresolved">
          {String(t("admin.payoutsLedgerBalancesUnresolved"))}
        </Text>
      )}

      {/* A refresh that failed leaves the last good rows in place, with the
          reason above them — never an "unavailable" block over real data. */}
      {refreshError && (
        <XStack gap="$3" alignItems="center" flexWrap="wrap" data-testid="ledger-refresh-error">
          <Text variant="caption" tone="error">
            {String(t("admin.payoutsLedgerStale"))} {refreshError}
          </Text>
          <Button variant="ghost" size="$3" onPress={onRetry}>
            {String(t("admin.retry"))}
          </Button>
        </XStack>
      )}

      {isLoading ? (
        <LedgerPlaceholder />
      ) : (
      <YStack id={LEDGER_TABLE_ID}>
      <DataTable<LedgerRow>
        columns={columns}
        rows={rows}
        getRowKey={(row) => row.entry.id}
        // The one fact the column heads do not say: the order. The heading
        // above names the table; "Balance" says what each row carries.
        caption={String(t("admin.payoutsLedgerNewestFirst"))}
        scrollContainer
        emptyState={
          <Text variant="body" tone="muted">
            {String(t("admin.payoutsLedgerEmpty"))}
          </Text>
        }
        renderMobileCard={(row) => (
          <YStack
            gap="$2"
            paddingVertical="$3"
            paddingLeft="$3"
            borderLeftWidth={row.isFirst ? 3 : 0}
            borderLeftColor="$accent"
            borderBottomWidth={1}
            borderBottomColor="$borderColorSoft"
            data-testid="ledger-card"
          >
            <Text variant="overline" tone="muted">
              {fmtDateShort(fmt, row.entry.createdAt)}
            </Text>
            <EntryCell {...row} />
            <XStack justifyContent="space-between" gap="$3" flexWrap="wrap">
              <XStack gap="$2" alignItems="baseline">
                <Text variant="overline" tone="muted">
                  {String(t("admin.payoutsLedgerColChange"))}
                </Text>
                <MoneyText
                  tone={row.change.kind === "none" ? "muted" : "default"}
                  data-testid="ledger-card-change"
                >
                  {changeText(row.change, money)}
                </MoneyText>
              </XStack>
              <XStack gap="$2" alignItems="baseline">
                <Text variant="overline" tone="muted">
                  {String(t("admin.payoutsLedgerColBalance"))}
                </Text>
                <MoneyText
                  weight="semibold"
                  tone={row.entry.balanceAfterCents === null ? "muted" : "default"}
                  data-testid="ledger-card-balance"
                >
                  {row.entry.balanceAfterCents === null
                    ? EM_DASH
                    : money(row.entry.balanceAfterCents)}
                </MoneyText>
              </XStack>
            </XStack>
          </YStack>
        )}
      />
      </YStack>
      )}

      {/* Paging belongs to the full table: folded, there is nothing to page. */}
      {showAll && loadMoreError && (
        <Text variant="caption" tone="error">
          {loadMoreError}
        </Text>
      )}

      {showAll && canLoadMore && (
        <XStack>
          <Button
            variant="secondary"
            size="$4"
            onPress={onLoadMore}
            disabled={isLoadingMore}
            data-testid="ledger-load-more"
          >
            {isLoadingMore ? <Spinner size="sm" /> : null}
            {String(t("admin.payoutsLedgerLoadMore"))}
          </Button>
        </XStack>
      )}

      {/* The server's offset cap: rows exist beyond what this view pages to.
          Only once rows are actually here — never beside a skeleton. */}
      {showAll && entries.length > 0 && hasMore && !canLoadMore && !isLoadingMore && (
        <Text variant="caption" tone="muted" data-testid="ledger-more-not-shown">
          {String(t("admin.payoutsLedgerMoreNotShown"))}
        </Text>
      )}

      {/* After Load more: open, the paging comes first and the fold sits at
          the end of the table. */}
      {!isLoading && hasHidden && (
        <DisclosureButton
          open={showAll}
          onToggle={() => setShowAll((open) => !open)}
          controlsId={LEDGER_TABLE_ID}
          label={String(
            t(showAll ? "admin.payoutsLedgerShowFewer" : "admin.payoutsLedgerShowAll"),
          )}
          testId="ledger-show-all"
        />
      )}
    </YStack>
  );
}
