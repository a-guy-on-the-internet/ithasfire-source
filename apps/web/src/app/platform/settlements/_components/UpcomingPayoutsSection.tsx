"use client";

import { useMemo } from "react";
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

import { PayoutOwnerCell, usePlatformTimeZone } from "./PayoutOwner";
import {
  useUpcomingPayouts,
  type TrancheNetting,
  type UpcomingRow,
} from "./use-upcoming-payouts";

// ─────────────────────────────────────────────────────────────────────────────
// "Upcoming payouts" — the FORWARD half of what the platform owes.
//
// The sibling "Payouts owed" section reads `listPayableBalances(now)`, which
// filters `availableAt <= now`. Everything in this table is what that filter
// EXCLUDES: settlement credit that exists, is owed, and has not matured. Before
// this section, that money appeared on the page only inside the single
// undated "Total owed" figure.
//
// THE AMOUNT COLUMN IS `expectedCents`, NOT THE GROSS. The feed is credits
// only, and every non-credit entry — refund debits, payouts, AND dispute
// holds — is already effective in today's payable (a hold bumps the
// pending-hold rollup at write time, and the payable subtracts it every
// night). So exactly ONE thing is netted, by the server: carried-forward
// DEBT — a negative payable today, including the debt a hold creates — is
// consumed by the next tranches, soonest first. A payee at −10,000 with
// +50,000 maturing receives 40,000; a 7,000 credit under a 3,000 hold pays
// 4,000. When debt applies, a caption under the figure shows the gross and
// what came off it.
//
// `heldCents` IS NOT SUBTRACTED, HERE OR ANYWHERE. It is rendered as its own
// phrase — "X under open dispute — already counted in today's payable" — so a
// reader knows why the payable looked low without being invited to take it
// off the figure a second time. It does not appear on the currency tiles.
//
// UNKNOWN IS NEVER A NUMBER. If the server could not read the payable
// (`debtResolved: false`), `expectedCents` is null and the cell renders a
// "could not check debt" badge over the gross-credit caption — not the gross
// dressed up as a net, not $0.00.
//
// THIS STILL FORECASTS MATURITY, NOT PAYMENT, and the intro copy says so in
// those words. On the night, the batch applies its payout minimum, its per-run
// payee cap, three eligibility checks and transfer-time withholding — and a
// refund landing before the date will reduce the tranche, because
// REFUND_DEBITs are always effective while credits wait. A reader who takes a
// row here as a promise is reading it wrong, so the heading never says "will
// be paid".
//
// Rows are per (payee, currency, maturity date); the totals above are computed
// over EVERY tranche before `items` is capped, so a truncated list never
// understates what is coming.
// ─────────────────────────────────────────────────────────────────────────────

const MONO = { fontFamily: "$mono" } as const;
const NOWRAP = { whiteSpace: "nowrap" } as const;

export const upcomingRowKey = (row: UpcomingRow) =>
  `${row.payeeId}:${row.currency}:${row.maturesAt.toISOString()}`;

/**
 * The expected figure, or the honest absence of one. `null` means the debt
 * read failed on the server; rendering the gross here instead would be the
 * exact overstatement this column was rebuilt to stop.
 */
export function ExpectedFigure({
  cents,
  currency,
  variant = "bodySmall",
  tag,
}: {
  cents: number | null;
  currency: string;
  variant?: "bodySmall" | "caption" | "h3";
  tag?: "p";
}) {
  const t = useTranslations();
  if (cents === null) {
    return (
      <Badge tone="warning" size="sm">
        {String(t("admin.pstUpDebtUnknown"))}
      </Badge>
    );
  }
  return (
    <Money
      cents={cents}
      currency={currency.toUpperCase()}
      variant={variant}
      tag={tag}
      weight="bold"
      style={NOWRAP}
      {...MONO}
    />
  );
}

/**
 * True when the caption has something to say beyond the figure itself:
 * debt came off the gross, or debt is UNKNOWN (the badge replaced the figure,
 * so the gross is the only money the cell can state). Keyed on debt ONLY —
 * never on `heldCents`, which is not a deduction.
 */
export const hasNetting = (n: TrancheNetting) =>
  n.debtAppliedCents === null || n.debtAppliedCents > 0;

/**
 * "of $70.00 credit · $30.00 applied to carried-forward debt". Rendered under
 * an expected figure whenever debt came off the gross (or could not be
 * checked), so the credit that exists stays visible beside what will
 * actually move. Silent when nothing was netted.
 */
export function TrancheNettingCaption({
  netting,
  currency,
  align = "flex-end",
}: {
  netting: TrancheNetting;
  currency: string;
  align?: "flex-start" | "flex-end";
}) {
  const t = useTranslations();
  if (!hasNetting(netting)) return null;
  const cur = currency.toUpperCase();
  const parts: string[] = [
    String(
      t("admin.pstUpOfCredit", {
        credit: Money.format(netting.creditCents, { currency: cur }),
      }),
    ),
  ];
  if (netting.debtAppliedCents !== null && netting.debtAppliedCents > 0) {
    parts.push(
      String(
        t("admin.pstUpDebt", {
          amount: Money.format(netting.debtAppliedCents, { currency: cur }),
        }),
      ),
    );
  }
  return (
    <YStack gap={0} alignItems={align} minWidth={0}>
      {parts.map((line) => (
        <Text key={line} variant="caption" tone="muted" {...MONO}>
          {line}
        </Text>
      ))}
    </YStack>
  );
}

/**
 * "$30.00 under open dispute — already counted in today's payable". An
 * INFORMATIONAL phrase, deliberately worded so nobody subtracts it from the
 * figure above: the hold is inside the payable already and reached this row
 * as debt. Silent when nothing is under dispute.
 */
export function UnderDisputeNote({
  heldCents,
  currency,
  align = "flex-end",
}: {
  heldCents: number;
  currency: string;
  align?: "flex-start" | "flex-end";
}) {
  const t = useTranslations();
  if (heldCents <= 0) return null;
  return (
    <YStack alignItems={align} minWidth={0}>
      <Text variant="caption" tone="muted">
        {String(
          t("admin.pstUpUnderDispute", {
            amount: Money.format(heldCents, {
              currency: currency.toUpperCase(),
            }),
          }),
        )}
      </Text>
    </YStack>
  );
}

export function UpcomingPayoutsSection() {
  const t = useTranslations();
  const { timeZone, resolved } = usePlatformTimeZone();
  const query = useUpcomingPayouts();

  const rows = query.rows;

  const columns = useMemo<DataTableColumn<UpcomingRow>[]>(
    () => [
      {
        id: "maturesAt",
        header: String(t("admin.pstUpColDate")),
        noWrap: true,
        // Zone-dependent text waits for the reader's zone to resolve after
        // mount — see `usePlatformTimeZone`. Rendering during SSR formats in
        // the server's zone and hydrates in the browser's.
        cell: (row) =>
          resolved ? (
            <DateTime
              value={row.maturesAt}
              timeZone={timeZone}
              format="dateShort"
              variant="bodySmall"
              weight="bold"
              style={NOWRAP}
              {...MONO}
            />
          ) : null,
        width: 150,
      },
      {
        id: "payee",
        header: String(t("admin.pstUpColPayee")),
        cell: (row) => <PayoutOwnerCell row={row} currency={row.currency} />,
        width: 220,
      },
      {
        id: "credits",
        header: String(t("admin.pstUpColCredits")),
        align: "right",
        cell: (row) => (
          <Text variant="bodySmall" tone="muted" style={NOWRAP} {...MONO}>
            {row.creditCount}
          </Text>
        ),
        width: 110,
      },
      {
        id: "amount",
        header: String(t("admin.pstUpColAmount")),
        align: "right",
        cell: (row) => (
          <YStack gap={2} alignItems="flex-end" minWidth={0}>
            <ExpectedFigure cents={row.expectedCents} currency={row.currency} />
            <TrancheNettingCaption netting={row} currency={row.currency} />
            <UnderDisputeNote heldCents={row.heldCents} currency={row.currency} />
          </YStack>
        ),
        width: 200,
      },
    ],
    [t, timeZone, resolved],
  );

  return (
    <YStack gap={12} tag="section" aria-labelledby="upcoming-payouts-heading">
      <YStack gap={4}>
        <XStack gap={8} alignItems="center" flexWrap="wrap">
          <Text variant="h3" tag="h2" id="upcoming-payouts-heading">
            {String(t("admin.pstUpTitle"))}
          </Text>
          {query.total != null && (
            <Badge tone="neutral" size="sm">
              {query.total}
            </Badge>
          )}
        </XStack>
        <Text variant="bodySmall" tone="muted">
          {String(t("admin.pstUpIntro"))}
        </Text>
      </YStack>

      {query.isError &&
        (getAppErrorCode(query.error) === "SERVICE_UNAVAILABLE" ? (
          <XStack gap={12} alignItems="center" flexWrap="wrap" role="alert">
            <Text color="$danger" variant="body">
              {String(t("admin.pstUpTimedOut"))}
            </Text>
            <Button
              variant="ghost"
              size="$1"
              onPress={() => query.refetch()}
              disabled={query.isFetching}
            >
              {String(t("admin.pstUpRetry"))}
            </Button>
          </XStack>
        ) : (
          <Text color="$danger" variant="body" role="alert">
            {formatErrorMessage(query.error)}
          </Text>
        ))}

      {/* Per-currency totals, never summed across currencies. The headline
          is the EXPECTED total; when debt was netted off the gross, the
          caption shows the gross and the debt. No hold figure here: the
          annotation is per order and sums to nothing a reader should use. */}
      {query.currencyTotals.length > 0 && (
        <XStack gap="$3" flexWrap="wrap" alignItems="stretch">
          {query.currencyTotals.map((total) => (
            <YStack
              key={total.currency}
              flexGrow={1}
              flexShrink={1}
              flexBasis={0}
              minWidth={220}
              gap="$1"
              padding="$3"
              borderWidth={1}
              borderColor="$borderColor"
              borderRadius="$3"
              backgroundColor="$surface"
            >
              <Text variant="caption" tone="muted" textTransform="uppercase">
                {`${String(t("admin.pstUpTotal"))} · ${total.currency.toUpperCase()}`}
              </Text>
              <ExpectedFigure
                cents={total.expectedCents}
                currency={total.currency}
                variant="h3"
                tag="p"
              />
              <TrancheNettingCaption
                netting={total}
                currency={total.currency}
                align="flex-start"
              />
              <Text variant="caption" tone="muted">
                {String(
                  t("admin.pstUpCreditCount", { count: total.trancheCount }),
                )}
              </Text>
            </YStack>
          ))}
        </XStack>
      )}

      <DataTable
        rows={rows}
        columns={columns}
        getRowKey={upcomingRowKey}
        isLoading={query.isLoading}
        caption={String(t("admin.pstUpCaption"))}
        scrollContainer
        renderMobileCard={(row) => (
          <UpcomingMobileCard
            row={row}
            timeZone={timeZone}
            resolved={resolved}
          />
        )}
        emptyState={
          <Text variant="bodySmall" tone="muted">
            {String(t("admin.pstUpEmpty"))}
          </Text>
        }
      />

      {query.truncated && (
        <Text variant="caption" tone="muted">
          {String(
            t("admin.pstUpTruncated", {
              limit: query.rowLimit,
              total: query.total,
            }),
          )}
        </Text>
      )}
    </YStack>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Mobile card (DataTable card mode, <600px)
// ─────────────────────────────────────────────────────────────────────────────

export function UpcomingMobileCard({
  row,
  timeZone,
  resolved,
}: {
  row: UpcomingRow;
  timeZone: string;
  resolved: boolean;
}) {
  const t = useTranslations();
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
          <ExpectedFigure cents={row.expectedCents} currency={row.currency} />
        </XStack>
      </XStack>
      {/* Its own block, left-aligned: at 320px a three-line caption beside
          the owner squeezed both to nothing. */}
      <TrancheNettingCaption
        netting={row}
        currency={row.currency}
        align="flex-start"
      />
      <UnderDisputeNote
        heldCents={row.heldCents}
        currency={row.currency}
        align="flex-start"
      />
      <XStack gap="$2" alignItems="baseline" flexWrap="wrap">
        <Text variant="caption" tone="muted">
          {String(t("admin.pstUpColDate"))}
        </Text>
        {resolved ? (
          <DateTime
            value={row.maturesAt}
            timeZone={timeZone}
            format="dateShort"
            variant="caption"
            weight="bold"
            {...MONO}
          />
        ) : null}
        <Text variant="caption" tone="muted">
          {String(t("admin.pstUpCreditCount", { count: row.creditCount }))}
        </Text>
      </XStack>
    </YStack>
  );
}
