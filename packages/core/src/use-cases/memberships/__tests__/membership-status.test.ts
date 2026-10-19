import { describe, expect, it } from "vitest";

import {
  MEMBERSHIP_BENEFIT_GRANTING_STATUSES,
  MEMBERSHIP_LIVE_STATUSES,
  MEMBERSHIP_PAYMENT_FAILING_STATUSES,
  MEMBERSHIP_STATUS_PAST_DUE,
} from "../membership-status";

/**
 * DRIFT GUARD for the three status lists.
 *
 * They encode one idea between them — a subscription that still BILLS but
 * grants NOTHING is a failing card — and that idea only holds while
 * `PAYMENT_FAILING === LIVE \ GRANTING`. `MEMBERSHIP_PAYMENT_FAILING_STATUSES`
 * is written out rather than computed on purpose (a derived list would absorb
 * any future Stripe status into copy that names a cause which is not
 * happening), and this test is the price of that choice: adding to LIVE
 * without deciding what it means here fails right now, loudly, instead of
 * shipping a health alert that says "card failing" about a paused
 * subscription.
 */
describe("membership status lists", () => {
  it("PAYMENT_FAILING is exactly LIVE minus BENEFIT_GRANTING", () => {
    const granting = new Set<string>(MEMBERSHIP_BENEFIT_GRANTING_STATUSES);
    const derived = MEMBERSHIP_LIVE_STATUSES.filter((s) => !granting.has(s));
    expect([...MEMBERSHIP_PAYMENT_FAILING_STATUSES].sort()).toEqual(
      [...derived].sort(),
    );
  });

  it("every payment-failing status is live, and none of them grants benefits", () => {
    for (const status of MEMBERSHIP_PAYMENT_FAILING_STATUSES) {
      expect(MEMBERSHIP_LIVE_STATUSES).toContain(status);
      expect(MEMBERSHIP_BENEFIT_GRANTING_STATUSES).not.toContain(status);
    }
  });

  it("keeps Stripe's lower-snake casing, never ours", () => {
    // An upper-cased value would produce a row no existing comparison matches:
    // lapsed to the benefits resolver AND absent to the double-subscribe
    // guard, so a past-due member could be billed a second subscription.
    for (const status of [
      ...MEMBERSHIP_LIVE_STATUSES,
      ...MEMBERSHIP_BENEFIT_GRANTING_STATUSES,
      ...MEMBERSHIP_PAYMENT_FAILING_STATUSES,
      MEMBERSHIP_STATUS_PAST_DUE,
    ]) {
      expect(status).toBe(status.toLowerCase());
    }
  });

  it("includes past_due, the status that had no operational surface at all", () => {
    expect(MEMBERSHIP_PAYMENT_FAILING_STATUSES).toContain(
      MEMBERSHIP_STATUS_PAST_DUE,
    );
  });
});
