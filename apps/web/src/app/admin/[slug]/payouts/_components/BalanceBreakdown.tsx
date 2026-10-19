"use client";

import { XStack, YStack } from "tamagui";
import {
  Badge,
  NextLinkAnchor,
  Text,
  useFormatters,
  useTranslations,
} from "@th/ui";
import type {
  GetOrgPayoutOverviewOutput,
  OrgPayoutTranche,
} from "@th/core/use-cases/payouts/get-org-payout-overview";

import { fmtCurrency, fmtDateShort } from "@/lib/format";
import { ACCENT_TEXT, BORDER } from "@/lib/design-tokens";

import { groupTrancheLines } from "./breakdown-lines";
import { MoneyText } from "./money-text";
import { reconcile } from "./reconciliation";

// ─────────────────────────────────────────────────────────────────────────────
// "Coming up" — the tranches that have not matured yet,
// each with the shows behind it. A BREAKDOWN, not a timeline: no row carries
// a running balance, because nothing up here has one yet.
//
// Every figure on a date row is the GROSS credit. The debt caption names what
// a carried-forward refund takes from it and what is then expected; the hold
// caption says a dispute is sitting on part of it and that the hold is
// already inside today's payable — never subtracted twice, and the copy says
// so rather than inviting the reader to do the subtraction.
// ─────────────────────────────────────────────────────────────────────────────

const figureStyle = { fontVariantNumeric: "tabular-nums" } as const;

// Date row: [date · chip] on the left, gross pinned right. The left half
// wraps internally, so below the stack point the chip drops UNDER the date
// rather than clipping — a chip is never truncated.
const dateRowStyle = {
  display: "flex",
  alignItems: "baseline",
  gap: 12,
  paddingBottom: 8,
  borderBottom: "2px solid var(--borderColor, #211C16)",
} as const;

const dateRowLeadStyle = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "baseline",
  gap: 12,
  flex: 1,
  minWidth: 0,
} as const;

const lineRowStyle = {
  display: "grid",
  gridTemplateColumns: "1fr auto",
  alignItems: "baseline",
  gap: 12,
  padding: "8px 0",
  borderBottom: `1px solid ${BORDER}`,
} as const;

// The house link hover — accent-as-INK on hover/focus. `NextLinkAnchor`
// forwards only DOM-safe props to the real <a>, so this lives in a scoped
// stylesheet rather than a Tamagui `hoverStyle` that would never land.
const EVENT_LINK_CLASS = "th-payouts-event-link";
const eventLinkCss = `
.${EVENT_LINK_CLASS} { color: inherit; text-decoration: underline; text-underline-offset: 2px; }
.${EVENT_LINK_CLASS}:hover, .${EVENT_LINK_CLASS}:focus-visible { color: ${ACCENT_TEXT}; }
`;

type BreakdownProps = {
  overview: GetOrgPayoutOverviewOutput;
};

export function BalanceBreakdown({ overview }: BreakdownProps) {
  const t = useTranslations();

  const reconciliation = reconcile(overview);

  // Only the states that carry a fact the list cannot show by itself: the
  // read failed, the list was cut, or nothing is maturing. The sum sentences
  // ("the dates below plus what's ready = owed") are gone (board B,
  // 2026-10-14): the answer above already splits now from later, and the
  // dated list is the breakdown.
  const reconcileText = (() => {
    switch (reconciliation.kind) {
      case "unresolved":
        return String(t("admin.payoutsReconcileUnresolved"));
      case "truncated":
        return String(
          t("admin.payoutsReconcileTruncated", {
            shown: reconciliation.shown,
            total: reconciliation.total ?? reconciliation.shown,
          }),
        );
      case "empty":
        return String(t("admin.payoutsReconcileEmpty"));
      default:
        return null;
    }
  })();

  return (
    <YStack gap="$4" data-testid="payout-breakdown">
      <style>{eventLinkCss}</style>
      {reconcileText !== null && (
        <Text
          variant="bodySmall"
          tone="muted"
          style={figureStyle}
          data-testid="payout-reconciliation"
        >
          {reconcileText}
        </Text>
      )}

      {overview.upcoming.length > 0 && (
        // The "Coming up" subhead is the page's, above this list.
        <YStack gap="$5">
          {overview.upcoming.map((tranche, index) => (
            <TrancheBlock
              key={`${tranche.currency}:${new Date(tranche.maturesAt).toISOString()}`}
              tranche={tranche}
              isNext={index === 0}
              attributionResolved={overview.attributionResolved}
              currency={overview.currency}
            />
          ))}
        </YStack>
      )}
    </YStack>
  );
}

type TrancheBlockProps = {
  tranche: OrgPayoutTranche;
  isNext: boolean;
  attributionResolved: boolean;
  currency: string;
};

function TrancheBlock({
  tranche,
  isNext,
  attributionResolved,
  currency,
}: TrancheBlockProps) {
  const t = useTranslations();
  const fmt = useFormatters();
  const money = (cents: number) => fmtCurrency(fmt, cents, currency);

  const groups = groupTrancheLines(tranche.lines);
  const moreCount = tranche.linesTruncated
    ? Math.max(0, tranche.creditCount - tranche.lines.length)
    : 0;

  return (
    <YStack gap="$1" data-testid="payout-tranche">
      <div style={dateRowStyle}>
        <div style={dateRowLeadStyle}>
          <Text variant="overline">{fmtDateShort(fmt, tranche.maturesAt)}</Text>
          {isNext && (
            <Badge tone="neutral" size="sm">
              {String(t("admin.payoutsNextChip"))}
            </Badge>
          )}
        </div>
        <MoneyText weight="bold" data-testid="payout-tranche-gross">
          {money(tranche.creditCents)}
        </MoneyText>
      </div>

      {tranche.linesResolved ? (
        groups.map((group) => {
          const title =
            group.eventTitle ??
            String(
              t(
                attributionResolved
                  ? "admin.payoutsLineUnattributed"
                  : "admin.payoutsLineUnnamed",
              ),
            );
          const sub = group.eventStartsAt
            ? String(
                t("admin.payoutsLineOrders", {
                  date: fmtDateShort(fmt, group.eventStartsAt),
                  count: group.orderCount,
                }),
              )
            : String(
                t("admin.payoutsLineOrdersNoDate", {
                  count: group.orderCount,
                }),
              );
          return (
            <div
              key={group.key}
              style={lineRowStyle}
              data-testid="payout-tranche-line"
            >
              <YStack gap="$1" minWidth={0}>
                {group.eventSlug ? (
                  // `/events/<slug>`, never the id — `/events/<uuid>` 404s.
                  <NextLinkAnchor
                    href={`/events/${group.eventSlug}`}
                    className={EVENT_LINK_CLASS}
                  >
                    <Text variant="body" weight="medium" tone="inherit">
                      {title}
                    </Text>
                  </NextLinkAnchor>
                ) : (
                  <Text variant="body" weight="medium">
                    {title}
                  </Text>
                )}
                <Text variant="caption" tone="muted">
                  {sub}
                </Text>
              </YStack>
              <MoneyText>{money(group.amountCents)}</MoneyText>
            </div>
          );
        })
      ) : (
        <Text variant="caption" tone="muted" paddingVertical="$2">
          {String(t("admin.payoutsLinesUnresolved"))}
        </Text>
      )}

      {moreCount > 0 && (
        <Text variant="caption" tone="muted" paddingVertical="$1">
          {String(t("admin.payoutsLinesMore", { count: moreCount }))}
        </Text>
      )}

      {tranche.debtAppliedCents !== null &&
        tranche.debtAppliedCents > 0 &&
        tranche.expectedCents !== null && (
          <XStack paddingTop="$2">
            <Text variant="caption" color="$accentText" style={figureStyle}>
              {String(
                t("admin.payoutsDebtCaption", {
                  debt: money(tranche.debtAppliedCents),
                  expected: money(tranche.expectedCents),
                }),
              )}
            </Text>
          </XStack>
        )}

      {tranche.heldCents > 0 && (
        <XStack paddingTop="$2">
          <Text variant="caption" tone="warning" style={figureStyle}>
            {String(
              t("admin.payoutsHoldCaption", { held: money(tranche.heldCents) }),
            )}
          </Text>
        </XStack>
      )}
    </YStack>
  );
}
