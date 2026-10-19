"use client";

import { XStack, YStack } from "tamagui";
import { Button, Money, Text, useTranslations } from "@th/ui";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";
import { getAppErrorCode } from "@/lib/app-error";

// ─────────────────────────────────────────────────────────────────────────────
// "Recurring revenue" — what the membership book is worth, per currency.
//
// THE LABEL IS THE FEATURE. Memberships carry a 0% platform fee on purpose, so
// every cent here belongs to a venue or an artist and NONE of it is platform
// income. A staff page that showed this under a bare "Revenue" heading would
// put a number into a revenue conversation that is wrong by one hundred
// percent of itself. Every heading, hint and aria-label on this section says
// whose money it is.
//
// TWO FIGURES, and the annualised one is the honest one. `annualisedCents` is
// exact integer arithmetic — every active membership at its yearly value, no
// division involved. `monthlyCents` is that total divided by twelve ONCE and
// floored, which is a derived number and is presented as one: the remainder
// the floor discarded is rendered beside it rather than dropped, and the count
// of annually-billed members is named whenever it is non-zero so a reader
// knows the normalisation applied to their book.
//
// TRIALING IS COUNTED, NEVER VALUED. A trial member is entitled to benefits and
// has paid nothing; folding them into the money would overstate the running
// rate by exactly the trial cohort.
// ─────────────────────────────────────────────────────────────────────────────

const MONO = { fontFamily: "$mono" } as const;
// An amount must never break mid-token: "$90.9 / 9" reads as a different
// number.
const NOWRAP = { whiteSpace: "nowrap" } as const;

type CurrencyTotal = {
  currency: string;
  activeCount: number;
  trialingCount: number;
  annualisedCents: number;
  monthlyCents: number;
  monthlyRemainderCents: number;
  annualBilledCount: number;
};

function Figure({
  label,
  hint,
  cents,
  currency,
  children,
}: {
  label: string;
  hint: string;
  cents: number;
  currency: string;
  children?: React.ReactNode;
}) {
  return (
    <YStack
      // `flexBasis: 0` explicitly rather than the `flex={1}` shorthand: inside
      // a wrapping row the shorthand's basis is what decides whether the pair
      // sits side by side or stacks.
      flexGrow={1}
      flexShrink={1}
      flexBasis={0}
      minWidth={240}
      gap="$1"
      padding="$3"
      borderWidth={1}
      borderColor="$borderColor"
      borderRadius="$3"
      // `$surface`, NOT `$backgroundStrong` — the latter resolves to the INK in
      // this theme and default-coloured text on it is invisible.
      backgroundColor="$surface"
    >
      <Text variant="caption" tone="muted" textTransform="uppercase">
        {label}
      </Text>
      <Money
        cents={cents}
        currency={currency.toUpperCase()}
        variant="h3"
        tag="p"
        weight="bold"
        style={NOWRAP}
        {...MONO}
      />
      <Text variant="caption" tone="muted">
        {hint}
      </Text>
      {children}
    </YStack>
  );
}

function CurrencyBlock({ row }: { row: CurrencyTotal }) {
  const t = useTranslations();
  return (
    <YStack gap="$2" minWidth={0}>
      <XStack gap="$2" alignItems="baseline" flexWrap="wrap">
        <Text variant="caption" tone="muted" textTransform="uppercase">
          {row.currency.toUpperCase()}
        </Text>
        <Text variant="caption" tone="muted">
          {String(
            t("platformMemberships.mvRevActive", { count: row.activeCount }),
          )}
        </Text>
        {row.trialingCount > 0 && (
          <Text variant="caption" tone="muted">
            {String(
              t("platformMemberships.mvRevTrialing", {
                count: row.trialingCount,
              }),
            )}
          </Text>
        )}
      </XStack>

      {/* Wraps to one column below ~520px so neither figure is ever clipped. */}
      <XStack gap="$3" flexWrap="wrap" alignItems="stretch">
        <Figure
          label={String(t("platformMemberships.mvRevMonthly"))}
          hint={String(t("platformMemberships.mvRevMonthlyHint"))}
          cents={row.monthlyCents}
          currency={row.currency}
        >
          {/* Only when the normalisation actually applied to this book. On an
              all-monthly book the sentence would be a fact about nothing. */}
          {row.annualBilledCount > 0 && (
            <Text variant="caption" tone="muted">
              {String(
                t("platformMemberships.mvRevAnnualBilled", {
                  count: row.annualBilledCount,
                }),
              )}
            </Text>
          )}
          {/* The cents the floor discarded, stated rather than hidden. Zero is
              the normal case and says nothing. */}
          {row.monthlyRemainderCents > 0 && (
            <XStack gap="$1" alignItems="baseline" flexWrap="wrap">
              <Text variant="caption" tone="muted">
                {String(t("platformMemberships.mvRevRemainder"))}
              </Text>
              <Money
                cents={row.monthlyRemainderCents}
                currency={row.currency.toUpperCase()}
                variant="caption"
                tone="muted"
                style={NOWRAP}
                {...MONO}
              />
            </XStack>
          )}
        </Figure>

        <Figure
          label={String(t("platformMemberships.mvRevAnnualised"))}
          hint={String(t("platformMemberships.mvRevAnnualisedHint"))}
          cents={row.annualisedCents}
          currency={row.currency}
        />
      </XStack>
    </YStack>
  );
}

export function RecurringRevenueSection() {
  const t = useTranslations();
  const query = trpc.platform.summariseRecurringRevenue.useQuery();

  const rows = (query.data?.ownerRevenueByCurrency ?? []) as CurrencyTotal[];
  /** The tier lookup failed, so whatever is below is PARTIAL or absent. */
  const degraded = Boolean(query.data && !query.data.tiersResolved);
  const hasRows = rows.length > 0;

  return (
    <YStack gap={12} tag="section" aria-labelledby="recurring-revenue-heading">
      <YStack gap={4}>
        <Text variant="h3" tag="h2" id="recurring-revenue-heading">
          {String(t("platformMemberships.mvRevTitle"))}
        </Text>
        <Text variant="bodySmall" tone="muted">
          {String(t("platformMemberships.mvRevIntro"))}
        </Text>
      </YStack>

      {query.isError &&
        (getAppErrorCode(query.error) === "SERVICE_UNAVAILABLE" ? (
          <XStack gap={12} alignItems="center" flexWrap="wrap" role="alert">
            <Text color="$danger" variant="body">
              {String(t("platformMemberships.mvTimedOut"))}
            </Text>
            <Button
              variant="ghost"
              size="$1"
              onPress={() => query.refetch()}
              disabled={query.isFetching}
            >
              {String(t("platformMemberships.mvRetry"))}
            </Button>
          </XStack>
        ) : (
          <Text color="$danger" variant="body" role="alert">
            {formatErrorMessage(query.error)}
          </Text>
        ))}

      {/* A PARTIAL book must never look like the whole book. When the tier
          lookup degraded, the totals below cover only the tiers that resolved
          and the reader is told so before they read a number.

          Only when there ARE rows: "these totals cover only part of the book"
          is a sentence about totals, and there are none to qualify when the
          lookup resolved nothing at all. That case gets its own line below. */}
      {degraded && hasRows && (
        <Text variant="bodySmall" tone="warning" role="status">
          {String(t("platformMemberships.mvRevTiersDegraded"))}
        </Text>
      )}

      {query.isLoading ? (
        <Text variant="bodySmall" tone="muted">
          {String(t("platformMemberships.mvLoading"))}
        </Text>
      ) : degraded && !hasRows ? (
        // NEVER the empty sentence. This is the exact hazard the use case's
        // header exists to prevent — "a count with no tier behind it has no
        // price and no currency, so it is DROPPED rather than valued at zero"
        // — and it would be reintroduced here if a failed lookup fell through
        // to `mvRevEmpty`. A Neon cold start on a book with nine paying
        // members would tell staff there are none, in the calm grey of a
        // normal empty state. UNKNOWN and ZERO are different facts and the
        // dangerous direction is reporting the first as the second.
        <Text variant="bodySmall" tone="warning" role="alert">
          {String(t("platformMemberships.mvRevUnavailable"))}
        </Text>
      ) : !hasRows ? (
        <Text variant="bodySmall" tone="muted">
          {String(t("platformMemberships.mvRevEmpty"))}
        </Text>
      ) : (
        <YStack gap="$4">
          {rows.map((row) => (
            <CurrencyBlock key={row.currency} row={row} />
          ))}
          <Text variant="caption" tone="muted">
            {String(
              t("platformMemberships.mvRevTierCount", {
                count: query.data?.activeTierCount ?? 0,
              }),
            )}
          </Text>
        </YStack>
      )}
    </YStack>
  );
}
