import { describe, expect, it } from "vitest";

import { BLOCKED_SETTLEMENT_DISPUTE_STATUSES } from "../../settlements/dispute-statuses";
import { resolveOrderStatusFilter } from "../_shared/dispute-list-filter";

describe("resolveOrderStatusFilter", () => {
  it("translates the DISPUTED status into the dispute-mirror filter (OPEN / UNDER_REVIEW / LOST)", () => {
    expect(resolveOrderStatusFilter({ status: "DISPUTED" })).toEqual({
      disputeStatuses: BLOCKED_SETTLEMENT_DISPUTE_STATUSES,
    });
    expect(BLOCKED_SETTLEMENT_DISPUTE_STATUSES).toEqual([
      "OPEN",
      "UNDER_REVIEW",
      "LOST",
    ]);
  });

  it.each(["PENDING", "SUCCEEDED", "PART_REFUNDED", "REFUNDED", "CANCELLED"] as const)(
    "keeps Order.status semantics for %s",
    (status) => {
      expect(resolveOrderStatusFilter({ status })).toEqual({ status });
    },
  );

  it("passes an empty filter through", () => {
    expect(resolveOrderStatusFilter({})).toEqual({});
  });

  it("splits a multi-select containing DISPUTED into the remaining statuses + the dispute arm", () => {
    expect(
      resolveOrderStatusFilter({ statuses: ["SUCCEEDED", "DISPUTED"] }),
    ).toEqual({
      statuses: ["SUCCEEDED"],
      disputeStatuses: BLOCKED_SETTLEMENT_DISPUTE_STATUSES,
    });
    expect(resolveOrderStatusFilter({ statuses: ["DISPUTED"] })).toEqual({
      disputeStatuses: BLOCKED_SETTLEMENT_DISPUTE_STATUSES,
    });
    expect(resolveOrderStatusFilter({ statuses: ["SUCCEEDED"] })).toEqual({
      statuses: ["SUCCEEDED"],
    });
  });
});
