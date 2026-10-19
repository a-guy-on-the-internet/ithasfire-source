"use client";

import { Badge, Text, useTranslations } from "@th/ui";

import {
  REWARD_STATUS_LABEL_KEY,
  REWARD_STATUS_TONE,
  type RewardBadgeStatus,
} from "./volunteering-helpers";

export type RewardStatusBadgeProps = {
  /**
   * Effective reward status for a signup. `NONE` (or nullish) means the
   * volunteer has no comp reward on this signup — nothing is rendered so the
   * roster stays quiet for the un-rewarded majority.
   */
  status: RewardBadgeStatus | null | undefined;
  /** Optional test id suffix (e.g. the signup id) for targeting a row's badge. */
  testIdSuffix?: string;
};

/**
 * Presentational reward-status badge shown on roster / signup rows
 * (volunteer-comp-tickets spec, FR-006). Granted / redeemed / revoked map to
 * distinct tones; `NONE` renders nothing. Purely a label — all reward
 * configuration is finance-gated elsewhere, and coordinators see this badge
 * read-only.
 */
export function RewardStatusBadge({ status, testIdSuffix }: RewardStatusBadgeProps) {
  const t = useTranslations();

  if (!status || status === "NONE") return null;

  const testId = testIdSuffix
    ? `reward-status-badge-${testIdSuffix}`
    : "reward-status-badge";

  return (
    <span
      data-testid={testId}
      title={String(t("volunteering.rewardBadgeTooltip"))}
    >
      <Badge tone={REWARD_STATUS_TONE[status]} size="sm">
        <Text variant="caption" style={{ textTransform: "uppercase" }}>
          {String(t(REWARD_STATUS_LABEL_KEY[status]))}
        </Text>
      </Badge>
    </span>
  );
}
