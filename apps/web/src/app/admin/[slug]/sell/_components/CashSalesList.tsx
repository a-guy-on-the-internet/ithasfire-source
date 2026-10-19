"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { XStack, YStack } from "tamagui";
import {
  Button,
  Spinner,
  Text,
  TextInput,
  useTranslations,
} from "@th/ui";
import { AlertTriangle, CheckCircle } from "lucide-react";

import { trpc } from "@/trpc";
import { formatCents } from "@/lib/format";
import { formatErrorMessage } from "@/lib/format-error-message";
import { cashRefundError } from "@/lib/cash-refund-error";

import {
  cashRefundWindowState,
  cashSaleAction,
  cashSaleClosedLabel,
  cashSaleKindLabel,
  cashSaleRefundable,
  cashSaleTime,
  mergeCashSalePages,
  ticketsLabel,
  type EventCashSale,
  type EventCashSalesPage,
} from "./cash-sales-list";

/**
 * Every cash sale of the event, newest first, with a Refund (Void, for a $0
 * comp or free sale) on each one the caller may still refund (owner ruling 2026-10-08: Editors refund cash door
 * sales here, not from Orders). No buyer details: `pos.eventCashSales` sends
 * none (pro-social principle 4, contact details stay private).
 *
 * Cursor-paged by hand (`utils.fetch` + accumulated pages), not
 * `useInfiniteQuery`: the procedure's strict input rejects the `direction`
 * key the infinite hook injects. After a refund every loaded page is read
 * again, so the operator keeps their place in a long night's list.
 *
 * Copy is English, like the rest of the Sell screen; refusals resolve
 * through the error catalog (`cashRefundError`).
 */

const PAGE_SIZE = 25;
const SILENT = { meta: { silent: true } } as const;
const tabular = { fontVariantNumeric: "tabular-nums" } as const;
/** A clock time never breaks between its digits and AM/PM at 320px. */
const oneLine = { whiteSpace: "nowrap" } as const;

function untilLabel(at: Date | string): string {
  return new Date(at).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function CashSalesList({
  orgId,
  eventId,
  currency,
  onRefunded,
}: {
  orgId: string;
  eventId: string;
  currency: string;
  /** After a refund lands, with the refunded order's id. */
  onRefunded?: (orderId: string) => void;
}) {
  const t = useTranslations();
  const translate = useCallback((key: string) => String(t(key)), [t]);
  const utils = trpc.useUtils();

  const query = trpc.pos.eventCashSales.useQuery(
    { orgId, eventId, limit: PAGE_SIZE },
    { staleTime: 10_000 },
  );

  // Extra cursor pages, keyed by the first page's `dataUpdatedAt` so a
  // background refetch voids the chain behind it ("Load more" comes back),
  // while `reloadAll` rebuilds the chain in step with the new first page.
  const [extra, setExtra] = useState<{
    dataUpdatedAt: number;
    pages: EventCashSalesPage[];
  }>({ dataUpdatedAt: 0, pages: [] });
  const extraPages = useMemo(
    () => (extra.dataUpdatedAt === query.dataUpdatedAt ? extra.pages : []),
    [extra, query.dataUpdatedAt],
  );
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);

  // The clock the window is read against; moved forward whenever the list
  // is read again (a refund's re-read, a background refetch, a focus
  // refetch), so a window that closed while the screen sat open shows.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (query.dataUpdatedAt) setNow(new Date());
  }, [query.dataUpdatedAt]);

  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [rowError, setRowError] = useState<{
    orderId: string;
    message: string;
  } | null>(null);
  const [done, setDone] = useState<{
    orderId: string;
    amountCents: number;
    alreadyRefunded: boolean;
  } | null>(null);

  const refundMutation = trpc.orders.orgRefundCashSale.useMutation(SILENT);
  // `isPending` only flips on the next render, so two taps in the same tick
  // would both get through it; the second would come back alreadyRefunded
  // and replace "Hand $X back" with "Already refunded." This ref closes that
  // gap: set before `mutate`, cleared when the call settles.
  const inFlight = useRef(false);

  const page = query.data;
  const rows = useMemo(
    () => mergeCashSalePages([page, ...extraPages]),
    [page, extraPages],
  );
  const nextCursor =
    extraPages.length > 0
      ? extraPages[extraPages.length - 1]!.nextCursor
      : (page?.nextCursor ?? null);

  const handleLoadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      const next = await utils.pos.eventCashSales.fetch(
        { orgId, eventId, cursor: nextCursor, limit: PAGE_SIZE },
        { staleTime: 0 },
      );
      const dataUpdatedAt = query.dataUpdatedAt;
      setExtra((prev) => ({
        dataUpdatedAt,
        pages:
          prev.dataUpdatedAt === dataUpdatedAt ? [...prev.pages, next] : [next],
      }));
    } catch (err) {
      setLoadMoreError(formatErrorMessage(err, translate));
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, loadingMore, utils, orgId, eventId, query, translate]);

  /** Read the first page and as many more as were loaded, in order. */
  const reloadAll = useCallback(async () => {
    const depth = extraPages.length;
    const first = await query.refetch();
    setNow(new Date());
    const pages: EventCashSalesPage[] = [];
    let cursor = first.data?.nextCursor ?? null;
    try {
      for (let i = 0; i < depth && cursor; i++) {
        const next = await utils.pos.eventCashSales.fetch(
          { orgId, eventId, cursor, limit: PAGE_SIZE },
          { staleTime: 0 },
        );
        pages.push(next);
        cursor = next.nextCursor;
      }
    } catch {
      // The first page is fresh; the rest fall back to "Load more".
    }
    setExtra({ dataUpdatedAt: first.dataUpdatedAt, pages });
  }, [extraPages.length, query, utils, orgId, eventId]);

  const startConfirm = (orderId: string) => {
    if (inFlight.current || refundMutation.isPending) return;
    setConfirmingId(orderId);
    setNote("");
    setRowError(null);
    setDone(null);
  };

  const confirmRefund = (sale: EventCashSale) => {
    // No double submit: one refund in flight at a time, from any row.
    if (inFlight.current || refundMutation.isPending) return;
    inFlight.current = true;
    const trimmed = note.trim();
    setRowError(null);
    refundMutation.mutate(
      {
        orgId,
        orderId: sale.orderId,
        ...(trimmed ? { note: trimmed } : {}),
      },
      {
        onSuccess: (result) => {
          setConfirmingId(null);
          setNote("");
          setDone({
            orderId: sale.orderId,
            amountCents: result.amountReturnedCents,
            alreadyRefunded: result.alreadyRefunded,
          });
          void reloadAll();
          void utils.pos.cashTillReport.invalidate({ eventId });
          onRefunded?.(sale.orderId);
        },
        onError: (err) => {
          const { message, refetch } = cashRefundError(err, translate);
          setRowError({ orderId: sale.orderId, message });
          if (refetch) {
            setConfirmingId(null);
            void reloadAll();
          }
        },
        onSettled: () => {
          inFlight.current = false;
        },
      },
    );
  };

  const windowState = page ? cashRefundWindowState(page, now) : null;

  return (
    <YStack gap="$2" data-testid="cash-sales-list">
      <Text variant="overline" tone="muted" tag="h3">
        Cash sales
      </Text>

      {page && windowState === "open" ? (
        <Text variant="caption" tone="muted">
          Refunds stay open until{" "}
          <span style={oneLine}>{untilLabel(page.refundableUntil)}</span>, seven
          days after the event ends.
        </Text>
      ) : page && windowState === "closed" ? (
        <Text variant="caption" tone="muted">
          The refund window closed on{" "}
          <span style={oneLine}>{untilLabel(page.refundableUntil)}</span>.
          Contact support to refund a sale.
        </Text>
      ) : page && windowState === "cannot" ? (
        <Text variant="caption" tone="muted">
          An Owner, Admin or Editor can refund a sale here.
        </Text>
      ) : null}

      {query.isLoading ? (
        <XStack padding="$3" justifyContent="center">
          <Spinner size="small" />
        </XStack>
      ) : query.error ? (
        <YStack gap="$2">
          <Text variant="bodySmall" tone="error">
            {formatErrorMessage(query.error, translate)}
          </Text>
          <Button
            variant="secondary"
            size="$2"
            minHeight={44}
            onPress={() => void query.refetch()}
          >
            Retry
          </Button>
        </YStack>
      ) : rows.length === 0 ? (
        <Text variant="caption" tone="muted">
          No cash sales recorded for this event yet.
        </Text>
      ) : (
        <YStack>
          {rows.map((sale) => {
            const time = cashSaleTime(sale.soldAt, now);
            const amount = formatCents(sale.amountPaidCents, currency);
            const kind = cashSaleKindLabel(sale);
            const refunded = sale.status !== "SUCCEEDED";
            const doneHere = done?.orderId === sale.orderId ? done : null;
            // A row this screen just refunded never offers Refund again,
            // even in the moment before the refetch brings its new status.
            const refundable =
              !doneHere && !!page && cashSaleRefundable(sale, page, now);
            const confirming = confirmingId === sale.orderId && refundable;
            const pendingHere =
              refundMutation.isPending &&
              refundMutation.variables?.orderId === sale.orderId;
            const error =
              rowError?.orderId === sale.orderId ? rowError.message : null;
            const action = cashSaleAction(sale);
            const isVoid = action.verb === "void";

            return (
              <YStack
                key={sale.orderId}
                gap="$2"
                paddingVertical="$2"
                borderTopWidth={1}
                borderColor="$borderColor"
                data-testid="cash-sale-row"
              >
                {/* Wraps at a phone width: Refund drops to its own line rather
                    than squeezing the clock time into the amount. */}
                <XStack alignItems="center" gap="$2" flexWrap="wrap">
                  {/* min-content, not react-native-web's default 0: the row
                      wraps on the clock time's real width instead of letting
                      it run under the amount. */}
                  <YStack
                    flex={1}
                    flexBasis={0}
                    style={{ minWidth: "min-content" }}
                  >
                    <Text
                      variant="bodySmall"
                      weight="bold"
                      style={{ ...tabular, ...oneLine }}
                    >
                      {time}
                    </Text>
                    <Text
                      variant="caption"
                      tone="muted"
                      style={{ overflowWrap: "anywhere" }}
                    >
                      {ticketsLabel(sale.ticketCount)}
                      {kind ? ` · ${kind}` : ""}
                    </Text>
                    {/* Its own line: no separator left dangling at a wrap. */}
                    {refunded ? (
                      <Text
                        variant="caption"
                        tone="muted"
                        style={oneLine}
                        data-testid="cash-sale-closed"
                      >
                        {cashSaleClosedLabel(sale, now)}
                      </Text>
                    ) : null}
                  </YStack>
                  {/* Struck through and muted once handed back, so the live
                      sales read at a glance. */}
                  <Text
                    variant="bodySmall"
                    weight="bold"
                    tone={refunded ? "muted" : "default"}
                    marginLeft="auto"
                    textDecorationLine={refunded ? "line-through" : "none"}
                    style={tabular}
                  >
                    {amount}
                  </Text>
                  {refundable && !confirming ? (
                    <Button
                      variant="secondary"
                      size="$2"
                      minHeight={44}
                      marginLeft="auto"
                      disabled={refundMutation.isPending}
                      aria-label={
                        isVoid
                          ? `Void the ${time} ${action.noun}`
                          : `Refund the ${time} sale, ${amount}`
                      }
                      onPress={() => startConfirm(sale.orderId)}
                    >
                      {isVoid ? "Void" : "Refund"}
                    </Button>
                  ) : null}
                </XStack>

                {confirming ? (
                  <YStack
                    gap="$2"
                    padding="$3"
                    borderWidth={1}
                    borderColor="$borderColor"
                    backgroundColor="$surface"
                    data-testid="cash-sale-confirm"
                  >
                    <Text variant="bodySmall">
                      {isVoid
                        ? `Void this ${action.noun}? Their tickets stop working and go back on sale.`
                        : `Hand back ${amount}. Their tickets stop working and go back on sale.`}
                    </Text>
                    <YStack gap="$1">
                      <Text variant="overline" tone="muted">
                        Note (optional)
                      </Text>
                      <TextInput
                        value={note}
                        onChangeText={setNote}
                        placeholder="Why, for the record"
                        aria-label="Note (optional)"
                        maxLength={500}
                        fullWidth
                        minHeight={44}
                        disabled={pendingHere}
                      />
                    </YStack>
                    <XStack gap="$2" flexWrap="wrap">
                      <Button
                        variant="primary"
                        size="$3"
                        minHeight={44}
                        disabled={refundMutation.isPending}
                        onPress={() => confirmRefund(sale)}
                      >
                        {pendingHere
                          ? isVoid
                            ? "Voiding…"
                            : "Refunding…"
                          : isVoid
                            ? `Void ${action.noun}`
                            : `Refund ${amount}`}
                      </Button>
                      <Button
                        variant="ghost"
                        size="$3"
                        minHeight={44}
                        disabled={pendingHere}
                        onPress={() => setConfirmingId(null)}
                      >
                        Cancel
                      </Button>
                    </XStack>
                  </YStack>
                ) : null}

                {error ? (
                  <XStack gap="$2" alignItems="flex-start" role="alert">
                    <AlertTriangle
                      size={14}
                      color="var(--danger, #B91C1C)"
                      style={{ flexShrink: 0, marginTop: 2 }}
                      aria-hidden
                    />
                    <Text variant="caption" tone="error">
                      {error}
                    </Text>
                  </XStack>
                ) : null}

                {doneHere ? (
                  <XStack gap="$2" alignItems="flex-start" role="status">
                    <CheckCircle
                      size={14}
                      color="var(--success, #166534)"
                      style={{ flexShrink: 0, marginTop: 2 }}
                      aria-hidden
                    />
                    <Text variant="caption">
                      {doneHere.alreadyRefunded
                        ? isVoid
                          ? "Already voided."
                          : "Already refunded."
                        : doneHere.amountCents > 0
                          ? `Refunded. Hand ${formatCents(doneHere.amountCents, currency)} back to the buyer.`
                          : "Voided. Their tickets no longer work."}
                    </Text>
                  </XStack>
                ) : null}
              </YStack>
            );
          })}
        </YStack>
      )}

      {nextCursor && !query.error ? (
        <Button
          variant="ghost"
          size="$2"
          minHeight={44}
          disabled={loadingMore}
          onPress={() => void handleLoadMore()}
        >
          {loadingMore ? "Loading…" : "Load more"}
        </Button>
      ) : null}
      {loadMoreError ? (
        <Text variant="caption" tone="error" role="alert">
          {loadMoreError}
        </Text>
      ) : null}
    </YStack>
  );
}
