"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { XStack, YStack } from "tamagui";
import { Button, Separator, Spinner, Text, useTranslations } from "@th/ui";
import { ChevronDown, ChevronUp } from "lucide-react";

import { trpc } from "@/trpc";
import { formatCents } from "@/lib/format";
import { formatErrorMessage } from "@/lib/format-error-message";

import { CashSalesList } from "./CashSalesList";

/**
 * What's in the box, and whose it is.
 *
 * The cash itself never touches Settlement — the organiser is already holding
 * it — so this panel is the only place the cash is counted. What the box
 * OWES is not the organiser's: the sales tax on a cash sale is the platform's
 * to remit, and it comes out of the next payout (owner rulings R6, and
 * 2026-10-08: no platform fee on cash). So the panel splits the box into tax
 * owed and "yours to keep" (owner pick T1, rows). A platform-fee row shows
 * only for older cash sales that still carried one.
 *
 * Collapsed by default. During a rush the operator wants the catalogue, not
 * accounting; this matters at the end of the night, and once. The exception
 * is `checking`: the till sent the operator here to see whether a sale whose
 * answer was lost got recorded, so the panel opens and takes focus.
 */
const tabular = { fontVariantNumeric: "tabular-nums" } as const;

function TillRow({
  label,
  note,
  amount,
}: {
  label: string;
  note: string;
  amount: string;
}) {
  return (
    <XStack justifyContent="space-between" alignItems="baseline" gap="$3">
      <Text variant="bodySmall" flex={1} minWidth={0}>
        {label}{" "}
        <Text tag="span" variant="bodySmall" tone="muted">
          · {note}
        </Text>
      </Text>
      <Text variant="bodySmall" weight="bold" style={tabular}>
        {amount}
      </Text>
    </XStack>
  );
}

export function CashTillPanel({
  eventId,
  orgId,
  checking = false,
  onCashSaleRefunded,
}: {
  eventId: string;
  /** The org the till sells for: the cash-sales list is read against it. */
  orgId: string;
  /** Open on mount and focus the toggle: the operator was sent here to check. */
  checking?: boolean;
  /** A sale refunded from the cash-sales list, by order id. */
  onCashSaleRefunded?: (orderId: string) => void;
}) {
  const [open, setOpen] = useState(checking);
  const t = useTranslations();

  const toggleRef = useRef<HTMLElement | null>(null);
  const resolveToggleRef = useCallback((node: unknown) => {
    toggleRef.current = node instanceof HTMLElement ? node : null;
  }, []);
  // Mount-only: the operator pressed "See Cash taken tonight" on the tender
  // screen, which unmounted under them. Focus lands where they were sent.
  const checkingOnMount = useRef(checking);
  useEffect(() => {
    if (!checkingOnMount.current) return;
    const frame = requestAnimationFrame(() => toggleRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);

  const tillQuery = trpc.pos.cashTillReport.useQuery(
    // `recentSales` is no longer drawn: the full cash-sales list below
    // replaced it. 1 is the smallest read the input takes.
    { eventId, recentLimit: 1 },
    // Only fetched once opened — a door tablet shouldn't poll an accounting
    // read all night for a panel nobody has looked at.
    { enabled: open, staleTime: 10_000 },
  );

  const data = tillQuery.data;

  return (
    <YStack
      borderWidth={1}
      borderColor="$borderColor"
      backgroundColor="$surfaceMuted"
      data-testid="cash-till-panel"
    >
      <XStack
        padding="$3"
        gap="$2"
        alignItems="center"
        justifyContent="space-between"
        cursor="pointer"
        // Real <button>: the disclosure toggles on Enter/Space natively.
        tag="button"
        ref={resolveToggleRef}
        width="100%"
        // A <button> paints the UA's grey `buttonface` unless told not to;
        // the toggle sits on the panel's own surface.
        backgroundColor="transparent"
        borderWidth={0}
        aria-expanded={open}
        aria-label="Cash taken tonight"
        minHeight={44}
        onPress={() => setOpen((v) => !v)}
        focusStyle={{
          outlineWidth: 2,
          outlineColor: "$accent",
          outlineStyle: "solid",
          outlineOffset: -2,
        }}
      >
        <Text variant="body" weight="bold" textAlign="left">
          Cash taken tonight
        </Text>
        <XStack gap="$2" alignItems="center">
          {open && data ? (
            <Text variant="body" weight="bold">
              {formatCents(data.cashCollectedCents, data.currency)}
            </Text>
          ) : null}
          {open ? (
            <ChevronUp size={16} aria-hidden="true" />
          ) : (
            <ChevronDown size={16} aria-hidden="true" />
          )}
        </XStack>
      </XStack>

      {open ? (
        <YStack gap="$3" padding="$3" paddingTop={0}>
          <Separator />

          {tillQuery.isLoading ? (
            <XStack padding="$3" justifyContent="center">
              <Spinner size="small" />
            </XStack>
          ) : tillQuery.error ? (
            <YStack gap="$2">
              <Text variant="bodySmall" tone="error">
                {formatErrorMessage(tillQuery.error, t)}
              </Text>
              <Button
                variant="secondary"
                size="$2"
                minHeight={44}
                onPress={() => void tillQuery.refetch()}
              >
                Retry
              </Button>
            </YStack>
          ) : data ? (
            <YStack gap="$3">
              <YStack gap="$1">
                <Text variant="h3" weight="bold">
                  {formatCents(data.cashCollectedCents, data.currency)}
                </Text>
                <Text variant="caption" tone="muted">
                  should be in the box · {data.paidSaleCount}{" "}
                  {data.paidSaleCount === 1 ? "sale" : "sales"} ·{" "}
                  {data.paidTicketCount}{" "}
                  {data.paidTicketCount === 1 ? "ticket" : "tickets"}
                </Text>
              </YStack>

              <YStack gap="$2">
                <Separator />
                <TillRow
                  label="Sales tax"
                  note="owed, we pay it to the state"
                  amount={formatCents(data.taxCents, data.currency)}
                />
                {data.platformFeeOwedCents > 0 ? (
                  // Only cash sales taken before cash stopped carrying a
                  // platform fee can owe one; hidden when none do.
                  <TillRow
                    label="Platform fee"
                    note="owed"
                    amount={formatCents(
                      data.platformFeeOwedCents,
                      data.currency,
                    )}
                  />
                ) : null}
                <Separator />
                <XStack
                  justifyContent="space-between"
                  alignItems="baseline"
                  gap="$3"
                  data-testid="cash-till-yours"
                >
                  <Text variant="bodySmall" weight="bold">
                    Yours to keep
                  </Text>
                  <Text
                    variant="body"
                    weight="black"
                    fontSize={18}
                    style={tabular}
                  >
                    {formatCents(data.organiserKeepsCents, data.currency)}
                  </Text>
                </XStack>
                <Text
                  variant="caption"
                  tone="muted"
                  data-testid="cash-till-keep-note"
                >
                  {data.platformFeeOwedCents > 0
                    ? "Cash sales before Oct 8, 2026 carried a platform fee. That fee and the tax come out of your next payout."
                    : "No platform fee on cash. The tax comes out of your next payout."}
                </Text>
              </YStack>

              <Separator />

              <XStack gap="$4" flexWrap="wrap">
                <YStack gap="$1" minWidth={120}>
                  <Text variant="caption" tone="muted">
                    Comped
                  </Text>
                  <Text variant="body" weight="bold">
                    {data.compSaleCount}{" "}
                    {data.compSaleCount === 1 ? "sale" : "sales"} ·{" "}
                    {data.compTicketCount}{" "}
                    {data.compTicketCount === 1 ? "ticket" : "tickets"}
                  </Text>
                </YStack>

                {/*
                  Separate from comps (owner ruling): a 100%-off code makes
                  a $0 SALE, never a comp.
                */}
                <YStack gap="$1" minWidth={120} data-testid="cash-till-free-with-code">
                  <Text variant="caption" tone="muted">
                    Free with a code
                  </Text>
                  <Text variant="body" weight="bold">
                    {data.freeWithCodeSaleCount}{" "}
                    {data.freeWithCodeSaleCount === 1 ? "sale" : "sales"} ·{" "}
                    {data.freeWithCodeTicketCount}{" "}
                    {data.freeWithCodeTicketCount === 1 ? "ticket" : "tickets"}
                  </Text>
                </YStack>

                {data.refundedSaleCount > 0 ? (
                  <YStack gap="$1" minWidth={120}>
                    <Text variant="caption" tone="muted">
                      Handed back
                    </Text>
                    {/*
                      Reported separately rather than silently netted, so a
                      short drawer has an explanation on the same screen
                      instead of just being a smaller number than the operator
                      remembers taking.
                    */}
                    <Text variant="body" weight="bold">
                      {formatCents(data.refundedCents, data.currency)} ·{" "}
                      {data.refundedSaleCount}{" "}
                      {data.refundedSaleCount === 1 ? "refund" : "refunds"}
                    </Text>
                  </YStack>
                ) : null}
              </XStack>

              <Separator />
              <CashSalesList
                orgId={orgId}
                eventId={eventId}
                currency={data.currency}
                onRefunded={onCashSaleRefunded}
              />

              {data.truncated ? (
                <Text variant="caption" tone="warning">
                  This event has more cash sales than this report reads at once
                  — the figures above cover the most recent ones only.
                </Text>
              ) : null}

              <Text variant="caption" tone="muted">
                Cash stays with your group. This is the only place the cash
                itself is counted; the tax on it shows in Payouts.
              </Text>
            </YStack>
          ) : null}
        </YStack>
      ) : null}
    </YStack>
  );
}
