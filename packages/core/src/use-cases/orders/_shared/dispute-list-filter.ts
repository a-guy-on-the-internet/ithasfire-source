import type { DisputeStatus } from "@th/types/repos/disputes";
import type { OrderStatus } from "@th/types/repos/orders";

import { BLOCKED_SETTLEMENT_DISPUTE_STATUSES } from "../../settlements/dispute-statuses";

export type ResolvedOrderStatusFilter = {
  status?: OrderStatus;
  statuses?: OrderStatus[];
  disputeStatuses?: readonly DisputeStatus[];
};

/**
 * Translate the `DISPUTED` status-filter value into a filter on the order's
 * Dispute-row mirror. `Order.status` is never set to `DISPUTED` by the
 * dispute lifecycle (`markDisputeStatus` writes only `disputeStatus`), so a
 * plain `status = 'DISPUTED'` predicate is always empty. "Disputed" here
 * means the same thing the list badge and the refund guard mean: OPEN,
 * UNDER_REVIEW or LOST. Every other status value keeps its `Order.status`
 * semantics untouched; WON / WARNING_* are not "disputed".
 */
export function resolveOrderStatusFilter(input: {
  status?: OrderStatus;
  statuses?: OrderStatus[];
}): ResolvedOrderStatusFilter {
  const out: ResolvedOrderStatusFilter = {};
  let disputed = false;

  if (input.statuses?.length) {
    const rest = input.statuses.filter((s) => s !== "DISPUTED");
    disputed = rest.length !== input.statuses.length;
    if (rest.length > 0) out.statuses = rest;
  } else if (input.status === "DISPUTED") {
    disputed = true;
  } else if (input.status) {
    out.status = input.status;
  }

  if (disputed) out.disputeStatuses = BLOCKED_SETTLEMENT_DISPUTE_STATUSES;
  return out;
}
