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

import {
  PayoutOwnerCell,
  usePlatformTimeZone,
  type PayoutOwnerRef,
} from "./PayoutOwner";
import {
  useUpcomingPayouts,
  nextTrancheKey,
  type NextTranche,
} from "./use-upcoming-payouts";
import {
  ExpectedFigure,
  TrancheNettingCaption,
  UnderDisputeNote,
} from "./UpcomingPayoutsSection";

// ─────────────────────────────────────────────────────────────────────────────
// "Payouts owed" — the OWED half of the platform settlements page.
//
// THE WHOLE POINT OF THIS COMPONENT IS THAT TWO NUMBERS STAY TWO NUMBERS.
//
//   PAYABLE NOW — the matured, unblocked LEDGER BALANCE. The INPUT to
//                 tonight's batch, not its output.
//   TOTAL OWED  — everything we owe, matured or not, plus reserves and
//                 dispute holds.
//
// They are rendered as a headline PAIR with a sentence between them, because
// a reader who mistakes the first for the second concludes the platform is
// solvent when it is not. The table below lists only the payable side, and
// its heading says so; the total-owed figure never appears as a column, so
// there is no row a reader can mistake for "everything this payee is owed".
//
// "PAYABLE NOW" IS NOT "WILL BE SENT", and the copy must not imply it. The
// batch applies its payout minimum, a per-run payee cap, three eligibility
// checks and transfer-time withholding AFTER this number. Rather than let a
// reader discover that when a $4.00 row never moves, each row carries the two
// gates the server can evaluate — `belowMinimum` and `ineligibleReason` —
// and says so in place.
//
// The rows come from the SAME ledger read the payout batch plans from
// (`payeeLedger.listPayableBalances`), so the page and the batch cannot
// disagree about the BALANCE. Order is the adapter's — longest-waiting money
// first — which is also the batch's consideration order.
//
// Not cursor-paged: the underlying ledger read does not page (the batch wants
// the whole feed at once), so the use case caps the rows at a documented
// limit and says so. The TOTALS are computed over every cell regardless, so a
// truncated list never understates what is owed.
// ─────────────────────────────────────────────────────────────────────────────

type IneligibleReason =
  | "payee_not_found"
  | "payee_missing_stripe_account"
  | "payee_payouts_disabled";

interface PayableRow extends PayoutOwnerRef {
  currency: string;
  payableCents: number;
  oldestMaturedAt: Date | null;
  /** Null = unknown (the fee-policy read failed), NOT "no". */
  belowMinimum: boolean | null;
  ineligibleReason: IneligibleReason | null;
  identityResolved: boolean;
}

const INELIGIBLE_LABEL_KEY: Record<IneligibleReason, string> = {
  payee_not_found: "admin.pstOwedSkipNoPayee",
  payee_missing_stripe_account: "admin.pstOwedSkipNoStripe",
  payee_payouts_disabled: "admin.pstOwedSkipPayoutsOff",
};

const MONO = { fontFamily: "$mono" } as const;
// An amount must never break mid-token: "$1,2 / 00" in a narrow column reads
// as a different number.
const NOWRAP = { whiteSpace: "nowrap" } as const;

const toDate = (v: Date | string | null): Date | null =>
  v ? new Date(v) : null;

export const payableRowKey = (
  row: Pick<PayableRow, "payeeId" | "currency">,
) => `${row.payeeId}:${row.currency}`;

/**
 * The headline pair. Deliberately NOT two anonymous big numbers side by side:
 * each carries its own one-line definition, and the total-owed card carries
 * the component breakdown, because "why is owed bigger than payable" is the
 * first question every reader has and the answer is the breakdown.
 */
function HeadlineFigure({
  label,
  hint,
  cents,
  currency,
  unknownLabel,
  children,
}: {
  label: string;
  hint: string;
  /** Null = NOT REPORTED. Rendered as an em dash, never as zero. */
  cents: number | null;
  currency: string;
  unknownLabel: string;
  children?: React.ReactNode;
}) {
  return (
    <YStack
      // `flexBasis: 0` explicitly rather than the `flex={1}` shorthand: inside
      // a wrapping row the shorthand's basis is what decides whether the pair
      // sits side by side or stacks, and it is worth not leaving to a
      // shorthand's interpretation.
      flexGrow={1}
      flexShrink={1}
      flexBasis={0}
      minWidth={260}
      gap="$1"
      padding="$3"
      borderWidth={1}
      borderColor="$borderColor"
      borderRadius="$3"
      // `$surface`, NOT `$backgroundStrong`. The name reads like "a stronger
      // background" and it is not: in this theme it resolves to #211C16, the
      // INK, so default-coloured text on it is invisible. The first render of
      // this card lost the entire "Payable now" figure that way — the one
      // number on the page that must never be mistaken for the other.
      backgroundColor="$surface"
    >
      <Text variant="caption" tone="muted" textTransform="uppercase">
        {label}
      </Text>
      {/* Both figures in default ink. The distinction between them is carried
          by the label above and the sentence below, which is unambiguous; an
          accent on one of them would read as an alarm state instead.

          A MISSING figure renders as an em dash and the words "not reported",
          never as $0.00. Defaulting an absent liability to zero would show a
          positive "Payable now" beside "Total owed $0.00" — a silent solvency
          OVERSTATEMENT, and exactly the misread this whole component exists
          to prevent. Fail loud, in the safe direction. */}
      {cents === null ? (
        <YStack gap={2}>
          <Text variant="h3" tag="p" weight="bold" style={NOWRAP} {...MONO}>
            {"\u2014"}
          </Text>
          <Text variant="caption" tone="warning">
            {unknownLabel}
          </Text>
        </YStack>
      ) : (
        <Money
          cents={cents}
          currency={currency.toUpperCase()}
          variant="h3"
          tag="p"
          weight="bold"
          style={NOWRAP}
          {...MONO}
        />
      )}
      <Text variant="caption" tone="muted">
        {hint}
      </Text>
      {children}
    </YStack>
  );
}

function LiabilityBreakdown({
  row,
  currency,
}: {
  row: {
    unpaidCreditsCents: number;
    reserveHeldCents: number;
    pendingHoldCents: number;
  };
  currency: string;
}) {
  const t = useTranslations();
  const parts: Array<[string, number]> = [
    [String(t("admin.pstOwedUnpaidCredits")), row.unpaidCreditsCents],
    [String(t("admin.pstOwedReserveHeld")), row.reserveHeldCents],
    [String(t("admin.pstOwedPendingHold")), row.pendingHoldCents],
  ];
  return (
    <YStack gap={2} paddingTop="$1">
      {parts.map(([label, cents]) => (
        <XStack key={label} gap="$2" justifyContent="space-between" minWidth={0}>
          <Text variant="caption" tone="muted" flexShrink={1} minWidth={0}>
            {label}
          </Text>
          <Money
            cents={cents}
            currency={currency.toUpperCase()}
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

function CurrencyHeadlines({
  currency,
  payableCents,
  liability,
}: {
  currency: string;
  payableCents: number;
  liability: {
    unpaidCreditsCents: number;
    reserveHeldCents: number;
    pendingHoldCents: number;
    totalOwedCents: number;
  } | null;
}) {
  const t = useTranslations();
  return (
    <YStack gap="$2" minWidth={0}>
      <Text variant="caption" tone="muted" textTransform="uppercase">
        {currency.toUpperCase()}
      </Text>
      {/* Wraps to one column below ~520px so neither figure is ever clipped. */}
      <XStack gap="$3" flexWrap="wrap" alignItems="stretch">
        <HeadlineFigure
          label={String(t("admin.pstOwedPayableNow"))}
          hint={String(t("admin.pstOwedPayableNowHint"))}
          cents={payableCents}
          currency={currency}
          unknownLabel={String(t("admin.pstOwedNotReported"))}
        />
        <HeadlineFigure
          label={String(t("admin.pstOwedTotalOwed"))}
          hint={String(t("admin.pstOwedTotalOwedHint"))}
          // NOT `?? 0` — see HeadlineFigure. A currency the liability query
          // did not report is UNKNOWN, and rendering unknown as zero would
          // understate what we owe.
          cents={liability?.totalOwedCents ?? null}
          currency={currency}
          unknownLabel={String(t("admin.pstOwedNotReported"))}
        >
          {liability && (
            <LiabilityBreakdown row={liability} currency={currency} />
          )}
        </HeadlineFigure>
      </XStack>
    </YStack>
  );
}

/**
 * Why the batch will pass this row over tonight.
 *
 * This is the cell that turns the most misleading row on the page into the
 * most useful one: a $4.00 balance under a heading about money going out is
 * a lie of omission until it says "below the $10.00 minimum". Ineligibility
 * is the louder of the two — an organiser whose Connect account is off is
 * accruing money that will never move until somebody acts.
 *
 * The per-run PAYEE CAP is deliberately absent: it depends on an argument to
 * the job, so a flag for it would be wrong on some nights, and an
 * intermittently-wrong warning is worse than none.
 */
function BatchSkipCell({
  row,
  payoutMinimumCents,
}: {
  row: PayableRow;
  /** Null when the fee-policy read failed. */
  payoutMinimumCents: number | null;
}) {
  const t = useTranslations();

  // Two INDEPENDENT verdicts, rendered independently. An earlier version
  // returned early on `!identityResolved` and swallowed `belowMinimum` with
  // it — but the minimum needs no lookup, so a degraded $4.00 row still
  // knows perfectly well that it is below the minimum, and dropping that
  // threw away the more actionable of the two facts.
  const parts: React.ReactNode[] = [];

  if (row.ineligibleReason) {
    parts.push(
      <Badge key="ineligible" tone="danger" size="sm">
        {String(t(INELIGIBLE_LABEL_KEY[row.ineligibleReason]))}
      </Badge>,
    );
  } else if (!row.identityResolved) {
    parts.push(
      <Text key="eligibility-unknown" variant="caption" tone="muted">
        {String(t("admin.pstOwedSkipUnknown"))}
      </Text>,
    );
  }

  if (row.belowMinimum === true) {
    parts.push(
      <YStack key="minimum" gap={2} alignItems="flex-start">
        <Badge tone="warning" size="sm">
          {String(t("admin.pstOwedSkipBelowMinimum"))}
        </Badge>
        {/* Names the threshold rather than asserting one, so the caption
            cannot drift from the fee policy the batch actually reads. */}
        {payoutMinimumCents !== null && (
          <XStack gap="$1" alignItems="baseline" flexWrap="wrap">
            <Text variant="caption" tone="muted">
              {String(t("admin.pstOwedMinimumIs"))}
            </Text>
            <Money
              cents={payoutMinimumCents}
              currency={row.currency.toUpperCase()}
              variant="caption"
              tone="muted"
              style={NOWRAP}
              {...MONO}
            />
          </XStack>
        )}
      </YStack>,
    );
  } else if (row.belowMinimum === null) {
    parts.push(
      <Text key="minimum-unknown" variant="caption" tone="muted">
        {String(t("admin.pstOwedSkipMinimumUnknown"))}
      </Text>,
    );
  }

  if (parts.length === 0) {
    // "No KNOWN blocker" — the per-run payee cap is deliberately unmodelled
    // (it depends on a job argument), so this column must not deny a gate it
    // cannot see. The footnote under the table names it.
    return (
      <Text variant="caption" tone="muted">
        {String(t("admin.pstOwedSkipNone"))}
      </Text>
    );
  }
  return (
    <YStack gap={4} alignItems="flex-start" minWidth={0}>
      {parts}
    </YStack>
  );
}

/**
 * When this payee's NEXT tranche matures — the forward half of their position,
 * which the payable read filters out by construction.
 *
 * Four distinct states, and none of them collapses into another:
 *   * a date + the first tranche's EXPECTED amount — that tranche ONLY, never
 *     the payee's whole upcoming total (`nextTrancheCents` is named for
 *     this), and NET of carried-forward debt (a negative payable today,
 *     including the debt a hold on an open dispute creates). When debt
 *     applies, a caption shows the gross credit and what came off, so
 *     "$0.00 on Oct 4" beside a $70.00 credit reads as the debt it is. A
 *     hold is shown as its own "under open dispute — already counted in
 *     today's payable" note and is never subtracted again;
 *   * a date + "could not check debt" — the upcoming read landed but its
 *     payable read did not (`nextTrancheCents` is null). The gross is still
 *     shown in the caption, labelled as credit, never as the figure;
 *   * "nothing upcoming" — genuinely no unmatured credit;
 *   * "could not check" — the upcoming read FAILED. Rendering that as
 *     "nothing upcoming" would tell a reader the payee is fully paid up when
 *     we simply do not know, so the failed read says so.
 */
function ExpectedNextCell({
  next,
  currency,
  timeZone,
  zoneResolved,
  upcomingResolved,
}: {
  next: NextTranche | undefined;
  currency: string;
  timeZone: string;
  zoneResolved: boolean;
  upcomingResolved: boolean;
}) {
  const t = useTranslations();

  if (!upcomingResolved) {
    return (
      <Text variant="bodySmall" tone="muted">
        {String(t("admin.pstOwedExpectedUnknown"))}
      </Text>
    );
  }
  if (!next) {
    return (
      <Text variant="bodySmall" tone="muted">
        {String(t("admin.pstOwedNoUpcoming"))}
      </Text>
    );
  }
  return (
    <YStack gap={2} minWidth={0}>
      {zoneResolved ? (
        <DateTime
          value={next.maturesAt}
          timeZone={timeZone}
          format="dateShort"
          variant="bodySmall"
          weight="bold"
          style={NOWRAP}
          {...MONO}
        />
      ) : null}
      <ExpectedFigure
        cents={next.nextTrancheCents}
        currency={currency}
        variant="caption"
      />
      <TrancheNettingCaption
        netting={next}
        currency={currency}
        align="flex-start"
      />
      <UnderDisputeNote
        heldCents={next.heldCents}
        currency={currency}
        align="flex-start"
      />
    </YStack>
  );
}

export function PayoutsOwedSection() {
  const t = useTranslations();
  const { timeZone, resolved: zoneResolved } = usePlatformTimeZone();

  const query = trpc.platform.listPayablePositions.useQuery();

  // Same query key as the "Upcoming payouts" section below — react-query
  // dedupes it to one request, and sharing it keeps the two sections from
  // straddling a maturity boundary and disagreeing about the same money.
  const upcoming = useUpcomingPayouts();
  const nextByPayee = upcoming.nextByPayee;
  const upcomingResolved = upcoming.resolved;

  const rows = useMemo<PayableRow[]>(
    () =>
      (query.data?.items ?? []).map((item) => ({
        ...item,
        oldestMaturedAt: toDate(item.oldestMaturedAt),
      })),
    [query.data],
  );

  // Every currency that appears on EITHER side gets a headline pair. A
  // currency with liability but no payable is exactly the case a reader must
  // not miss — dropping it because nothing is payable tonight would hide
  // money owed.
  const currencies = useMemo(() => {
    const set = new Set<string>();
    for (const row of query.data?.payableTotals ?? []) set.add(row.currency);
    for (const row of query.data?.liabilityTotals ?? []) set.add(row.currency);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [query.data]);

  const payableByCurrency = useMemo(
    () =>
      new Map(
        (query.data?.payableTotals ?? []).map((row) => [row.currency, row]),
      ),
    [query.data],
  );
  const liabilityByCurrency = useMemo(
    () =>
      new Map(
        (query.data?.liabilityTotals ?? []).map((row) => [row.currency, row]),
      ),
    [query.data],
  );

  // Declared ABOVE the columns memo that closes over it: the deps array is
  // evaluated during render, so a `const` declared below throws a TDZ
  // ReferenceError and blanks the whole section. (It did; the section tests
  // caught it, tsc did not.)
  // Null when the fee-policy read failed — NOT coerced to 0, which would
  // name a threshold nobody read.
  const payoutMinimumCents = query.data?.payoutMinimumCents ?? null;

  const columns = useMemo<DataTableColumn<PayableRow>[]>(
    () => [
      {
        id: "payee",
        header: String(t("admin.pstOwedColPayee")),
        cell: (row) => <PayoutOwnerCell row={row} currency={row.currency} />,
        width: 220,
      },
      {
        id: "payable",
        header: String(t("admin.pstOwedColPayable")),
        align: "right",
        cell: (row) => (
          <Money
            cents={row.payableCents}
            currency={row.currency.toUpperCase()}
            variant="bodySmall"
            weight="bold"
            style={NOWRAP}
            {...MONO}
          />
        ),
        width: 160,
      },
      {
        id: "waiting",
        header: String(t("admin.pstOwedColWaiting")),
        noWrap: true,
        cell: (row) =>
          row.oldestMaturedAt ? (
            <DateTime
              value={row.oldestMaturedAt}
              timeZone={timeZone}
              format="date"
              variant="bodySmall"
            />
          ) : (
            <Text variant="bodySmall" tone="muted">
              {String(t("admin.pstOwedNoMatured"))}
            </Text>
          ),
        width: 160,
      },
      {
        id: "expected",
        header: String(t("admin.pstOwedColExpected")),
        noWrap: true,
        cell: (row) => (
          <ExpectedNextCell
            next={nextByPayee.get(nextTrancheKey(row.payeeId, row.currency))}
            currency={row.currency}
            timeZone={timeZone}
            zoneResolved={zoneResolved}
            upcomingResolved={upcomingResolved}
          />
        ),
        width: 170,
      },
      {
        id: "batchSkip",
        header: String(t("admin.pstOwedColTonight")),
        cell: (row) => (
          <BatchSkipCell row={row} payoutMinimumCents={payoutMinimumCents} />
        ),
        width: 210,
      },
    ],
    [
      t,
      timeZone,
      zoneResolved,
      payoutMinimumCents,
      nextByPayee,
      upcomingResolved,
    ],
  );

  const total = query.data?.total ?? null;

  return (
    <YStack gap={12} tag="section" aria-labelledby="payouts-owed-heading">
      <YStack gap={4}>
        <XStack gap={8} alignItems="center" flexWrap="wrap">
          <Text variant="h3" tag="h2" id="payouts-owed-heading">
            {String(t("admin.pstOwedTitle"))}
          </Text>
          {total != null && (
            <Badge tone="neutral" size="sm">
              {total}
            </Badge>
          )}
        </XStack>
        <Text variant="bodySmall" tone="muted">
          {String(t("admin.pstOwedIntro"))}
        </Text>
      </YStack>

      {query.isError &&
        (getAppErrorCode(query.error) === "SERVICE_UNAVAILABLE" ? (
          <XStack gap={12} alignItems="center" flexWrap="wrap" role="alert">
            <Text color="$danger" variant="body">
              {String(t("admin.pstOwedTimedOut"))}
            </Text>
            <Button
              variant="ghost"
              size="$1"
              onPress={() => query.refetch()}
              disabled={query.isFetching}
            >
              {String(t("admin.pstOwedRetry"))}
            </Button>
          </XStack>
        ) : (
          <Text color="$danger" variant="body" role="alert">
            {formatErrorMessage(query.error)}
          </Text>
        ))}

      {currencies.map((currency) => (
        <CurrencyHeadlines
          key={currency}
          currency={currency}
          payableCents={payableByCurrency.get(currency)?.payableCents ?? 0}
          liability={liabilityByCurrency.get(currency) ?? null}
        />
      ))}

      <DataTable
        rows={rows}
        columns={columns}
        getRowKey={payableRowKey}
        isLoading={query.isLoading}
        caption={String(t("admin.pstOwedCaption"))}
        scrollContainer
        renderMobileCard={(row) => (
          <PayableMobileCard
            row={row}
            timeZone={timeZone}
            zoneResolved={zoneResolved}
            payoutMinimumCents={payoutMinimumCents}
            next={nextByPayee.get(nextTrancheKey(row.payeeId, row.currency))}
            upcomingResolved={upcomingResolved}
          />
        )}
        emptyState={
          <Text variant="bodySmall" tone="muted">
            {String(t("admin.pstOwedEmpty"))}
          </Text>
        }
      />

      <Text variant="caption" tone="muted">
        {String(t("admin.pstOwedCapFootnote"))}
      </Text>

      {query.data?.truncated && (
        <Text variant="caption" tone="muted">
          {String(
            t("admin.pstOwedTruncated", {
              limit: query.data.rowLimit,
              total: query.data.total,
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

export function PayableMobileCard({
  row,
  timeZone,
  zoneResolved = true,
  payoutMinimumCents,
  next,
  upcomingResolved = true,
}: {
  row: PayableRow;
  timeZone: string;
  zoneResolved?: boolean;
  payoutMinimumCents: number | null;
  next?: NextTranche;
  upcomingResolved?: boolean;
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
          <Money
            cents={row.payableCents}
            currency={row.currency.toUpperCase()}
            variant="bodySmall"
            weight="bold"
            style={NOWRAP}
            {...MONO}
          />
        </XStack>
      </XStack>
      <XStack gap="$1" alignItems="baseline" flexWrap="wrap">
        <Text variant="caption" tone="muted">
          {String(t("admin.pstOwedColWaiting"))}
        </Text>
        {row.oldestMaturedAt ? (
          <DateTime
            value={row.oldestMaturedAt}
            timeZone={timeZone}
            format="date"
            variant="caption"
            tone="muted"
          />
        ) : (
          <Text variant="caption" tone="muted">
            {String(t("admin.pstOwedNoMatured"))}
          </Text>
        )}
      </XStack>
      {/* The forward half of the position. Same three states as the desktop
          cell — a dated tranche, "nothing upcoming", or "could not check" —
          because a failed read that renders blank reads as "fully paid up". */}
      <XStack gap="$1" alignItems="baseline" flexWrap="wrap">
        <Text variant="caption" tone="muted">
          {String(t("admin.pstOwedColExpected"))}
        </Text>
        {!upcomingResolved ? (
          <Text variant="caption" tone="muted">
            {String(t("admin.pstOwedExpectedUnknown"))}
          </Text>
        ) : !next ? (
          <Text variant="caption" tone="muted">
            {String(t("admin.pstOwedNoUpcoming"))}
          </Text>
        ) : (
          <>
            {zoneResolved ? (
              <DateTime
                value={next.maturesAt}
                timeZone={timeZone}
                format="dateShort"
                variant="caption"
                weight="bold"
                {...MONO}
              />
            ) : null}
            <ExpectedFigure
              cents={next.nextTrancheCents}
              currency={row.currency}
              variant="caption"
            />
          </>
        )}
      </XStack>
      {/* What came off the first tranche, if anything. Own block for the
          same 320px reason as the batch-skip cell below. */}
      {upcomingResolved && next ? (
        <>
          <TrancheNettingCaption
            netting={next}
            currency={row.currency}
            align="flex-start"
          />
          <UnderDisputeNote
            heldCents={next.heldCents}
            currency={row.currency}
            align="flex-start"
          />
        </>
      ) : null}
      {/* Its own block, not a trailing chip on the row above: at 320px a
          badge beside the date squeezed the date to nothing. */}
      <BatchSkipCell row={row} payoutMinimumCents={payoutMinimumCents} />
    </YStack>
  );
}
