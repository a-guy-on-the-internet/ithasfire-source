import type { DisputeStatus } from "@th/types/repos/disputes";

export const BLOCKED_SETTLEMENT_DISPUTE_STATUSES = [
  "OPEN",
  "UNDER_REVIEW",
  "LOST",
] as const satisfies readonly DisputeStatus[];

const blockedSettlementDisputeStatuses = new Set<DisputeStatus>(
  BLOCKED_SETTLEMENT_DISPUTE_STATUSES,
);

export function isBlockedSettlementDisputeStatus(
  status: DisputeStatus | null | undefined,
): boolean {
  return status != null && blockedSettlementDisputeStatuses.has(status);
}