"use client";

import { XStack, YStack } from "tamagui";
import { Button, Text, useFormatters, useTranslations } from "@th/ui";

import { fmtCurrency } from "@/lib/format";

import { RewardStatusBadge } from "./RewardStatusBadge";
import {
  effectiveRewardStatus,
  type RewardGrantStatus,
} from "./volunteering-helpers";

export type RewardLedgerGrantRow = {
  id: string;
  signupId: string;
  contactEmail: string;
  status: RewardGrantStatus;
  redeemed: boolean;
  faceValueCents: number;
  grantedAt: Date | string;
  redeemedAt: Date | string | null;
  revokedAt: Date | string | null;
};

export type RewardLedgerData = {
  counts: {
    granted: number;
    redeemed: number;
    revoked: number;
    total: number;
  };
  /** null = at least one uncapped reward. */
  remainingBudget: number | null;
  faceValueCents: number;
  grants: RewardLedgerGrantRow[];
};

export type RewardLedgerTableProps = {
  ledger: RewardLedgerData;
  currency: string | null;
  /**
   * Finance-only "Void comp" hook. When provided, a Void action renders on
   * every GRANTED, un-redeemed grant row; clicking it asks the owner (the
   * RewardsTab) to confirm + fire the revoke. Omitted on read-only surfaces —
   * the table stays presentational and owns no mutation.
   */
  onVoid?: (grant: RewardLedgerGrantRow) => void;
  /** Grant id whose void is in flight — disables its Void button. */
  voidPendingId?: string | null;
};

function StatCard({
  label,
  value,
  testId,
}: {
  label: string;
  value: string;
  testId?: string;
}) {
  return (
    <YStack
      gap="$1"
      borderWidth={1}
      borderColor="$borderColor"
      backgroundColor="$surface"
      padding="$3"
      minWidth={140}
      flex={1}
      data-testid={testId}
    >
      <Text variant="caption" tone="muted" style={{ textTransform: "uppercase" }}>
        {label}
      </Text>
      <Text variant="h4" weight="bold">
        {value}
      </Text>
    </YStack>
  );
}

/**
 * Reward ledger (volunteer-comp-tickets spec, FR-006): granted / redeemed /
 * revoked counts, remaining budget, total face value comped, and the per-grant
 * rows. Redemption is derived server-side from the live comp-ticket scan. All
 * money is integer cents formatted through the app currency formatter.
 */
export function RewardLedgerTable({
  ledger,
  currency,
  onVoid,
  voidPendingId,
}: RewardLedgerTableProps) {
  const t = useTranslations();
  const fmt = useFormatters();
  const displayCurrency = currency ?? "usd";

  const fmtDate = (value: Date | string | null): string => {
    if (value == null) return "—";
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return fmt.dateTime(date, { dateStyle: "medium", timeStyle: "short" });
  };

  return (
    <YStack gap="$3" data-testid="volunteer-reward-ledger">
      <Text
        tag="h3"
        variant="h4"
        weight="bold"
        style={{ textTransform: "uppercase" }}
      >
        {String(t("volunteering.rewardLedgerTitle"))}
      </Text>

      {/* Summary stats. */}
      <XStack gap="$2" flexWrap="wrap">
        <StatCard
          label={String(t("volunteering.rewardLedgerGranted"))}
          value={String(ledger.counts.granted)}
          testId="volunteer-reward-stat-granted"
        />
        <StatCard
          label={String(t("volunteering.rewardLedgerRedeemed"))}
          value={String(ledger.counts.redeemed)}
          testId="volunteer-reward-stat-redeemed"
        />
        <StatCard
          label={String(t("volunteering.rewardLedgerRevoked"))}
          value={String(ledger.counts.revoked)}
          testId="volunteer-reward-stat-revoked"
        />
        <StatCard
          label={String(t("volunteering.rewardLedgerRemaining"))}
          value={
            ledger.remainingBudget == null
              ? String(t("volunteering.rewardLedgerUncapped"))
              : String(ledger.remainingBudget)
          }
          testId="volunteer-reward-stat-remaining"
        />
        <StatCard
          label={String(t("volunteering.rewardLedgerFaceValue"))}
          value={fmtCurrency(fmt, ledger.faceValueCents, displayCurrency)}
          testId="volunteer-reward-stat-face-value"
        />
      </XStack>

      {/* Per-grant rows. */}
      {ledger.grants.length === 0 ? (
        <Text
          variant="bodySmall"
          tone="muted"
          data-testid="volunteer-reward-ledger-empty"
        >
          {String(t("volunteering.rewardLedgerEmpty"))}
        </Text>
      ) : (
        <YStack gap="$2">
          {ledger.grants.map((grant) => {
            const status = effectiveRewardStatus(grant);
            // A comp can be voided only while it's a live, unused grant. A
            // REDEEMED (scanned) or already-REVOKED grant shows no action —
            // reclaiming a used comp is a manual refund decision, not a void.
            const canVoid =
              onVoid != null && grant.status === "GRANTED" && !grant.redeemed;
            return (
              <XStack
                key={grant.id}
                gap="$3"
                alignItems="center"
                justifyContent="space-between"
                flexWrap="wrap"
                borderWidth={1}
                borderColor="$borderColor"
                padding="$3"
                data-testid={`volunteer-reward-grant-${grant.id}`}
              >
                <YStack gap="$1" flex={1} minWidth={200}>
                  <Text variant="body" style={{ fontWeight: 600 }}>
                    {grant.contactEmail}
                  </Text>
                  <Text variant="caption" tone="muted">
                    {String(
                      t("volunteering.rewardGrantTimeline", {
                        granted: fmtDate(grant.grantedAt),
                        redeemed: fmtDate(grant.redeemedAt),
                        revoked: fmtDate(grant.revokedAt),
                      }),
                    )}
                  </Text>
                </YStack>
                <XStack gap="$2" alignItems="center" flexWrap="wrap">
                  <Text variant="body">
                    {fmtCurrency(fmt, grant.faceValueCents, displayCurrency)}
                  </Text>
                  <RewardStatusBadge status={status} testIdSuffix={grant.signupId} />
                  {canVoid ? (
                    <Button
                      variant="outlined"
                      size="$2"
                      minHeight={44}
                      disabled={voidPendingId === grant.id}
                      onPress={() => onVoid?.(grant)}
                      data-testid={`volunteer-reward-void-${grant.id}`}
                    >
                      <Text tone="inherit" variant="bodySmall">
                        {String(t("volunteering.rewardVoidCta"))}
                      </Text>
                    </Button>
                  ) : null}
                </XStack>
              </XStack>
            );
          })}
        </YStack>
      )}
    </YStack>
  );
}
