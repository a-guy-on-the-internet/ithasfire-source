"use client";

import type { inferRouterOutputs } from "@trpc/server";
import { XStack, YStack } from "tamagui";
import type { AppRouter } from "@th/trpc";
import {
  Badge,
  Button,
  Money,
  Text,
  useTranslations,
  type TextProps,
} from "@th/ui";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";
import { getAppErrorCode } from "@/lib/app-error";

// ─────────────────────────────────────────────────────────────────────────────
// "Platform revenue" — the OTHER book on this page.
//
// Every other section here answers "what do we owe them". This one answers
// "what did we keep", and the two must never be added, subtracted or read as
// one ledger: ticket volume is buyer money that was never ours, owed is
// organiser money we hold.
//
// THE CENTRAL FACT THIS COMPONENT EXISTS TO RENDER HONESTLY: net kept is a
// REAL figure over a SUBSET of orders, and the subset is the whole story. The
// backend nets only the orders where every input is known and reports its
// coverage — `{ measured, total }` — exactly as the two cost lines do. So the
// net has the same FOUR states they have, and rides through the SAME helper
// so it cannot drift from them:
//
//   0 of 0                 → cents 0, "nothing_to_report"    → $0.00 + caption
//   measured === 0 < total → cents null, reason "unread"     → dash + badge
//   0 < measured < total   → cents, "partial_coverage"       → figure + badge
//   measured === total > 0 → cents, reason null              → figure, bare
//
// The partial state is the dangerous one on every line, the net included: a
// partial sum looks exactly like a finished one. It is shown WITH its
// coverage and badged, never bare.
//
// `nothing_to_report` IS AN ANSWER, AND IS RENDERED AS ONE. An empty
// population sums to exactly 0 — no refunds means exactly no fee returned —
// so it gets a real $0.00 and a caption saying why, never a dash and never
// "Not read yet". It used to share `unread`, and the result was a platform
// with zero refunds reporting its finished, correct answer as an unfinished
// feature. This is NOT a breach of "unknown never renders as 0" below: an
// empty population is not unknown.
//
// EIGHT THINGS PUT AN ORDER OUT OF THE NET — counted in `total`, absent from
// `measured`. Four are MISSING DATA: its `feePolicySnapshot` records no fee
// mode, so the buyer-side unit cannot be attributed (most historical orders
// record none); it is DISPUTED, where the realised principal is a platform
// cost this read cannot see; it is ABSORB with an unread processor fee, the
// mode where that cost is ours to bear; or it carries a refunded ticket item
// whose fee share was never stamped.
//
// The other four are REFUND SHAPES THE ARITHMETIC CANNOT CLOSE, and they
// matter for reading the caption: such an order is missing NOTHING and is
// still left out. A refunded ABSORB order recovers its processor fee through
// the buyer's reduced refund, and how much was recovered is not stored. A
// refunded order that spent platform credit likewise recovers the credit,
// and that share is not stored either. A partially refunded order whose fee
// exceeded its discounted gross cannot have the give-back pro-rated without
// erring toward keeping profit. And a RESALE order books the platform's cut
// as a split line rather than in the fee column, so its `feesPlatformCents`
// of 0 is not "we kept nothing".
//
// None of the eight is estimated away — the estimate is the bug. A cancelled
// event will visibly push coverage DOWN, because it refunds every order; that
// is correct, not a regression.
//
// THE NET CAN BE NEGATIVE, and that is data, not an error: over a currency's
// eligible set, refunds and recovered costs can exceed the fee retained. It
// renders as a signed figure in the total rule, with no error styling.
//
// TWO STATEMENTS THE NET DOES NOT RETRACT:
//
//   * "Fees charged" is the fee RECORDED AT CHECKOUT, and it is neither a
//     total nor a bound in EITHER mode. The fee is computed on full face
//     while gross is post-discount. On an order sold before the 2026-10-11
//     change the organiser's basis was `max(gross − fee, 0)`, so a deeply
//     discounted ticket records a fee larger than anyone paid — and that
//     basis-side unit IS the ABSORB fee, so the cap bites under ABSORB too,
//     not only under PASS_THROUGH. An order stamped
//     `feePolicySnapshot.organiserCredit === "FULL_PRICE"` has no basis-side
//     unit and no cap. The by-mode split under the line is there so a reader
//     can see how much of the figure sits on each basis.
//   * How many times a PASS_THROUGH sale's fee is kept depends on when it was
//     sold, and `get-platform-revenue.ts` reads the rule off the order:
//       - sold BEFORE the 2026-10-11 change (no `organiserCredit` marker):
//         kept TWICE, once from the buyer on top of the ticket and once out
//         of the organiser's basis (a dev order: gross 7500, fee 50,
//         organiser credited 7450, buyer charged the 50 on top). These orders
//         keep what they were credited.
//       - stamped `organiserCredit: "FULL_PRICE"` (every sale since): kept
//         ONCE, the buyer's. The organiser is credited the full 7500.
//     This surface reports the amounts and takes no position on the pricing.
//
// UNKNOWN NEVER RENDERS AS 0 — the house rule stated at the top of
// `PayoutsOwedSection.tsx`. A null figure is a dash on every line here, the
// net included.
//
// The layout is a WATERFALL rather than a row of tiles on purpose: a gap in a
// sequence reads as missing, where a dash in a tile reads as zero.
// ─────────────────────────────────────────────────────────────────────────────

const MONO = { fontFamily: "$mono" } as const;
const NOWRAP = { whiteSpace: "nowrap" } as const;
/** The total figure only: break a long amount rather than overflow 320px. */
const BREAK_WORD = { overflowWrap: "anywhere" } as const;

/** One currency row, typed FROM THE ROUTER so backend drift is a compile
 *  error here rather than a silent `undefined` at render. The shape this
 *  component depends on: `platformFeesByMode` (three ints summing to
 *  `platformFeesChargedCents`), two gradually-filled cost lines each with
 *  `*Cents: number | null`, `*UnavailableReason: "nothing_to_report" |
 *  "unread" | "partial_coverage" | null` and a `*Coverage` — `feesReturnedCoverage` counts refunded ticket
 *  items; `processorCostCoverage` counts charged orders and also carries
 *  `parked` (reads that failed repeatedly and will not retry without a
 *  manual reset; still unmeasured, so the line stays partial). The net rides
 *  the same three fields — `netKeptCents`, `netKeptUnavailableReason`,
 *  `netKeptCoverage` (eligible orders over counted orders) — and
 *  `netKeptCents` may be NEGATIVE. */
type RevenueRow =
  inferRouterOutputs<AppRouter>["platform"]["getPlatformRevenue"]["rows"][number];
type UnavailableReason = RevenueRow["processorCostUnavailableReason"];

/** One line of the waterfall. `cents === null` is UNKNOWN, never zero. */
function Line({
  label,
  hint,
  detail,
  cents,
  currency,
  unknownLabel,
  tone,
  emphasis,
  partial,
  total,
}: {
  label: string;
  hint?: string;
  /** A second caption in the label idiom (mono) — for a breakdown of the
   *  figure, where `hint` is prose about it. */
  detail?: string;
  cents: number | null;
  currency: string;
  unknownLabel?: string;
  tone?: TextProps["tone"];
  emphasis?: boolean;
  /** Figure is real but INCOMPLETE — shown, and badged so it cannot be read
   *  as a total. Distinct from `cents === null`, which is "nothing known". */
  partial?: boolean;
  /** This line is the TOTAL RULE under the divider: the figure carries the
   *  display weight, the label stays emphasised body. `tag="p"` is not
   *  optional — `variant="h3"` would otherwise emit an `<h3>` and splice a
   *  heading into the page outline between two real ones. */
  total?: boolean;
}) {
  const t = useTranslations();
  const figureVariant = total ? "h3" : emphasis ? "body" : "bodySmall";
  return (
    <YStack gap={2} paddingVertical="$1" minWidth={0}>
      <XStack
        gap="$3"
        justifyContent="space-between"
        alignItems="baseline"
        flexWrap="wrap"
        minWidth={0}
      >
        <XStack gap="$2" alignItems="center" flexShrink={1} minWidth={0}>
          <Text
            variant={emphasis ? "body" : "bodySmall"}
            weight={emphasis ? "bold" : undefined}
            tone={tone}
          >
            {label}
          </Text>
          {cents === null && unknownLabel && (
            <Badge tone="danger" size="sm">
              {unknownLabel}
            </Badge>
          )}
          {cents !== null && partial && (
            <Badge tone="warning" size="sm">
              {String(t("admin.pstRevPartial"))}
            </Badge>
          )}
        </XStack>
        {cents === null ? (
          <Text
            variant={figureVariant}
            tag={total ? "p" : undefined}
            weight="bold"
            // `margin: auto` pinning, the one sanctioned margin: the row
            // WRAPS at narrow widths, and a wrapped figure on a line of its
            // own would otherwise fall back to flex-start and read as a
            // second label. The net's h3 figure is the widest thing here, so
            // it is the one that wraps first.
            marginLeft="auto"
            tone="error"
            style={NOWRAP}
            {...MONO}
          >
            {"—"}
          </Text>
        ) : (
          // No tone: a NEGATIVE net is a real result, not a failure, and
          // `tone="error"` here would read as one. The minus sign is the
          // signal, and `Money` renders it.
          <Money
            cents={cents}
            currency={currency.toUpperCase()}
            variant={figureVariant}
            tag={total ? "p" : undefined}
            weight="bold"
            marginLeft="auto"
            // The TOTAL figure is the widest thing in the card, and at 320px a
            // long or negative amount escaped both its row and the viewport
            // (measured: 339px document scrollWidth against a 320px viewport
            // with `-$12,450,000.00`, which `scrollWidth` alone would not have
            // caught on the real $1.00 figure). It breaks instead of
            // overflowing; the cost lines keep `nowrap`, since they are small
            // enough to never need it.
            //
            // KNOWN LIMIT, measured and accepted: at 320px the h3 figure has
            // 214px, so a net of roughly $100k or more wraps, and a digit
            // string has no break opportunity — it splits mid-thousands-group
            // (`-$12,450,00` / `0.00`). Nothing overflows or overlaps and the
            // caption reflows, but it reads poorly. The fix is a type step-down
            // at a narrow breakpoint; no media prop is used anywhere in this
            // directory today, and guessing a breakpoint name is a worse bug
            // than the wrap, so it is left for a deliberate pass.
            style={total ? BREAK_WORD : NOWRAP}
            flexShrink={total ? 1 : undefined}
            minWidth={total ? 0 : undefined}
            {...MONO}
          />
        )}
      </XStack>
      {hint && (
        <Text variant="caption" tone="muted">
          {hint}
        </Text>
      )}
      {detail && (
        <Text variant="caption" tone="muted" {...MONO}>
          {detail}
        </Text>
      )}
    </YStack>
  );
}

/** The four-state props for a gradually-filled line, derived from the row's
 *  reason so every such line — both cost lines AND the net — is wired
 *  identically.
 *
 *  Only ONE caption is ever shown, and which one is decided here rather than
 *  by the caller, so no line can accidentally caption a state it should not.
 *  `nothing_to_report` gets NO badge on purpose: the figure is a real 0, and
 *  a badge next to a real figure reads as a warning about it. */
function costLineProps(
  reason: UnavailableReason,
  t: ReturnType<typeof useTranslations>,
  captions: {
    /** The measured/total sentence. Shown ONLY in `partial_coverage`. */
    coverage: string;
    /** Why this line's 0 is 0. Shown ONLY in `nothing_to_report`. */
    nothing: string;
    /** Badge text for the `unread` state. The cost lines say "Not read yet"
     *  — a sweep will fill them. The net says "Not computable": no sweep
     *  closes a gap in the inputs it is netting over. */
    unknownLabel?: string;
  },
) {
  return {
    hint:
      reason === "partial_coverage"
        ? captions.coverage
        : reason === "nothing_to_report"
          ? captions.nothing
          : undefined,
    unknownLabel:
      reason === "unread"
        ? (captions.unknownLabel ?? String(t("admin.pstRevNotRead")))
        : undefined,
    partial: reason === "partial_coverage",
  };
}

function CurrencyBook({
  row,
  recoveredCostsResolved,
}: {
  row: RevenueRow;
  recoveredCostsResolved: boolean;
}) {
  const t = useTranslations();
  const ccy = row.currency.toUpperCase();
  const money = (cents: number) => Money.format(cents, { currency: ccy });

  // The by-mode split under "fees charged". The unknown bucket is appended
  // only when non-zero: a permanent "· $0.00 with no recorded mode" would
  // teach readers to skip the line, and it is the one they must not skip.
  const byModeParts = [
    String(
      t("admin.pstRevFeesByMode", {
        passThrough: money(row.platformFeesByMode.passThroughCents),
        absorb: money(row.platformFeesByMode.absorbCents),
      }),
    ),
  ];
  if (row.platformFeesByMode.unknownCents > 0) {
    byModeParts.push(
      String(
        t("admin.pstRevFeesModeUnknown", {
          unknown: money(row.platformFeesByMode.unknownCents),
        }),
      ),
    );
  }
  const byMode = byModeParts.join(" ");

  const feesReturnedCoverageHint = String(
    t("admin.pstRevFeesReturnedCoverage", {
      measured: row.feesReturnedCoverage.measured,
      total: row.feesReturnedCoverage.total,
    }),
  );
  // Parked reads are a different kind of gap: "not read YET" promises a
  // sweep will close it, and for parked orders nothing will until someone
  // resets them. Say so, or the partial figure looks self-healing.
  const processorCoverage = row.processorCostCoverage;
  const processorCoverageHint =
    processorCoverage.parked > 0
      ? String(
          t("admin.pstRevProcessorParked", {
            measured: processorCoverage.measured,
            total: processorCoverage.total,
            parked: processorCoverage.parked,
          }),
        )
      : String(
          t("admin.pstRevProcessorCoverage", {
            measured: processorCoverage.measured,
            total: processorCoverage.total,
          }),
        );
  // The net's coverage counts ORDERS, not rows of one column: an order drops
  // out when its fee mode, its processor read or one of its refund stamps is
  // missing. So this caption names the exclusions instead of promising a
  // sweep — three of the four will not close on their own.
  const netKeptCoverageHint = String(
    t("admin.pstRevNetKeptCoverage", {
      measured: row.netKeptCoverage.measured,
      total: row.netKeptCoverage.total,
    }),
  );

  return (
    <YStack
      gap={2}
      padding="$3"
      borderWidth={1}
      borderColor="$borderColor"
      borderRadius="$3"
      backgroundColor="$surface"
      minWidth={0}
    >
      <XStack
        gap="$2"
        justifyContent="space-between"
        alignItems="baseline"
        flexWrap="wrap"
      >
        <Text variant="caption" tone="muted" textTransform="uppercase">
          {ccy}
        </Text>
        <Text variant="caption" tone="muted">
          {String(t("admin.pstRevOrders", { count: row.orderCount }))}
        </Text>
      </XStack>

      <Line
        label={String(t("admin.pstRevTicketVolume"))}
        hint={String(t("admin.pstRevTicketVolumeHint"))}
        cents={row.ticketVolumeCents}
        currency={ccy}
      />
      <Line
        label={String(t("admin.pstRevFeesCharged"))}
        hint={String(t("admin.pstRevFeesChargedHint"))}
        detail={byMode}
        cents={row.platformFeesChargedCents}
        currency={ccy}
      />
      {/* Both cost lines have four states, and `partial_coverage` is the
          dangerous one: a partial sum looks exactly like a complete cost. It
          is labelled, and its coverage is spelled out under it, so the figure
          cannot be read as the total. An EMPTY population is the opposite
          case — a finished answer of 0, captioned rather than badged. */}
      <Line
        label={String(t("admin.pstRevFeesReturned"))}
        cents={row.feesReturnedCents}
        currency={ccy}
        {...costLineProps(row.feesReturnedUnavailableReason, t, {
          coverage: feesReturnedCoverageHint,
          // "No TICKETS refunded", not "no refunds": `total` counts refunded
          // items of `kind = 'ticket'` only. A refunded non-ticket line
          // never carried a fee stamp, so the CONCLUSION holds either way —
          // the caption just does not claim more than the count supports.
          nothing: String(t("admin.pstRevFeesReturnedNothing")),
        })}
      />
      <Line
        label={String(t("admin.pstRevProcessorCost"))}
        cents={row.processorCostCents}
        currency={ccy}
        {...costLineProps(row.processorCostUnavailableReason, t, {
          coverage: processorCoverageHint,
          // ALL THREE "nothing" CAPTIONS STATE THEIR EXACT PREDICATE, not a
          // friendlier paraphrase of it, because each line's `total` counts
          // a slightly different thing and the paraphrase was wrong on this
          // one. The numerator here sums `processorFeeCents` over ALL
          // counted orders, while `total` counts only those with
          // `stripePaymentIntentId IS NOT NULL` — so 0 of 0 says "no order
          // here has a linked card charge", which is a PROXY for "nothing
          // was charged", not an empty population. Dev has 6 USD orders at
          // $775 gross with no payment intent, so the two readings really do
          // come apart. The FIGURE is still exact (the state also requires
          // `measured === 0`, i.e. every counted order has a NULL
          // `processorFeeCents`, so the sum is 0 by construction); it is the
          // SENTENCE that would have overclaimed. Understating a cost
          // overstates net kept, so this line gets the careful wording.
          nothing: String(t("admin.pstRevProcessorCostNothing")),
        })}
      />
      <Line
        label={String(t("admin.pstRevConnectRecovered"))}
        cents={row.connectAccountFeesRecoveredCents}
        currency={ccy}
        unknownLabel={
          recoveredCostsResolved
            ? undefined
            : String(t("admin.pstRevConnectUnknown"))
        }
      />

      {/* The total rule. The net is the SAME three-state line as the two
          costs above it — one helper drives all three, so the net cannot
          quietly present a partial sum as a total while they refuse to. What
          it keeps is the display weight, and the explanation directly under
          it rather than as a footnote: a reader who misses that this is a
          subset reads it as all-time profit. */}
      <YStack
        borderTopWidth={2}
        borderTopColor="$borderColorStrong"
        paddingTop="$2"
        marginTop="$1"
        gap="$1"
      >
        <Line
          label={String(t("admin.pstRevNetKept"))}
          cents={row.netKeptCents}
          currency={ccy}
          emphasis
          total
          {...costLineProps(row.netKeptUnavailableReason, t, {
            coverage: netKeptCoverageHint,
            // The net's 0-of-0 is a currency with no orders in the COUNTED
            // statuses (the set named by `pstRevStatuses` above), so
            // "nothing eligible yet" would be the wrong sentence — there was
            // nothing to be eligible. "Counted" rather than "no orders at
            // all": a currency holding only PENDING orders would reach here
            // too, and nothing was kept on those either. The Connect fee is
            // not in the net, so a payout-only currency's $0.00 net is not
            // contradicted by its recovered-cost line above.
            nothing: String(t("admin.pstRevNetKeptNothing")),
            unknownLabel: String(t("admin.pstRevNetKeptUnavailable")),
          })}
        />
        <Text variant="caption" tone="muted">
          {String(
            t("admin.pstRevNetExplain", {
              recorded: money(row.platformFeesChargedCents),
            }),
          )}
        </Text>
      </YStack>

      {/* Tax sits BELOW the rule, outside the sum, with its own explanation.
          Placing it as a line above would invite exactly the addition it must
          never be part of. */}
      <YStack
        borderTopWidth={1}
        borderTopColor="$borderColor"
        paddingTop="$2"
        marginTop="$2"
        gap={2}
      >
        <XStack
          gap="$3"
          justifyContent="space-between"
          alignItems="baseline"
          flexWrap="wrap"
        >
          <Text variant="bodySmall" tone="muted">
            {String(t("admin.pstRevTaxHeld"))}
          </Text>
          <Money
            cents={row.taxCollectedHeldForRemittanceCents}
            currency={ccy}
            variant="bodySmall"
            tone="muted"
            style={NOWRAP}
            {...MONO}
          />
        </XStack>
        <Text variant="caption" tone="muted">
          {String(t("admin.pstRevTaxHeldHint"))}
        </Text>
      </YStack>
    </YStack>
  );
}

export function PlatformRevenueSection() {
  const t = useTranslations();
  const query = trpc.platform.getPlatformRevenue.useQuery();

  const rows = query.data?.rows ?? [];

  return (
    <YStack gap={12} tag="section" aria-labelledby="platform-revenue-heading">
      <YStack gap={4}>
        <Text variant="h3" tag="h2" id="platform-revenue-heading">
          {String(t("admin.pstRevTitle"))}
        </Text>
        <Text variant="bodySmall" tone="muted">
          {String(t("admin.pstRevIntro"))}
        </Text>
      </YStack>

      {query.isError &&
        (getAppErrorCode(query.error) === "SERVICE_UNAVAILABLE" ? (
          <XStack gap={12} alignItems="center" flexWrap="wrap" role="alert">
            <Text color="$danger" variant="body">
              {String(t("admin.pstRevTimedOut"))}
            </Text>
            <Button
              variant="ghost"
              size="$1"
              onPress={() => query.refetch()}
              disabled={query.isFetching}
            >
              {String(t("admin.pstRevRetry"))}
            </Button>
          </XStack>
        ) : (
          <Text color="$danger" variant="body" role="alert">
            {formatErrorMessage(query.error)}
          </Text>
        ))}

      {/* One book per currency, never summed across them. */}
      <XStack gap="$3" flexWrap="wrap" alignItems="stretch">
        {rows.map((row) => (
          <YStack
            key={row.currency}
            flexGrow={1}
            flexShrink={1}
            flexBasis={0}
            // 240, not 280. `minWidth` overrides `flexShrink`, so a floor
            // wider than the narrowest viewport minus this section's own
            // insets pushes the BODY sideways — measured as 2px of horizontal
            // document overflow at 320px. Keep this at or under the sibling
            // sections' floors (220 upcoming / 260 owed), which is where the
            // two-up-on-desktop break still lands.
            minWidth={240}
          >
            <CurrencyBook
              row={row}
              recoveredCostsResolved={
                query.data?.recoveredCostsResolved ?? false
              }
            />
          </YStack>
        ))}
      </XStack>

      {!query.isLoading && !query.isError && rows.length === 0 && (
        <Text variant="bodySmall" tone="muted">
          {String(t("admin.pstRevEmpty"))}
        </Text>
      )}

      {query.data?.statuses && (
        <Text variant="caption" tone="muted">
          {String(
            t("admin.pstRevStatuses", {
              statuses: query.data.statuses.join(", "),
            }),
          )}
        </Text>
      )}
    </YStack>
  );
}
