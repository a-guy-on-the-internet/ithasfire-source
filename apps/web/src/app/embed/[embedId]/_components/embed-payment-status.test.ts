import { describe, expect, it } from "vitest";

import {
  NOTHING_KNOWN,
  asPaidStatus,
  earlierOrderAfterServerAnswer,
  type UnknownOutcome,
} from "./embed-payment-status";

describe("asPaidStatus — the two statuses that mean the buyer has paid", () => {
  it.each(["succeeded", "processing"] as const)("%s is paid", (status) => {
    expect(asPaidStatus(status)).toBe(status);
  });

  it.each(["requires_payment_method", "requires_action", "canceled", "", null, undefined])(
    "%s is not",
    (status) => {
      expect(asPaidStatus(status)).toBeNull();
    },
  );
});

describe("earlierOrderAfterServerAnswer — what the server's answer does to an earlier order's record", () => {
  const notPaid = (paymentIntentStatus: string) =>
    ({ outcome: "not_paid", orderId: "order-1", paymentIntentStatus }) as const;
  const record = (over: Partial<UnknownOutcome> = {}): UnknownOutcome => ({
    ...NOTHING_KNOWN,
    ...over,
  });

  it.each(["confirmed", "processing"] as const)(
    "%s → the record says so, and is kept (the buyer is told they paid)",
    (outcome) => {
      const before = record({ confirmsStillOut: 1 });
      expect(
        earlierOrderAfterServerAnswer(before, { outcome, orderId: "order-1" }),
      ).toEqual({ ...before, serverSaid: outcome });
    },
  );

  it.each(["confirmed", "processing"] as const)(
    "%s a second time → the same record, unchanged (a repeat is not news)",
    (outcome) => {
      const before = record({ serverSaid: outcome });
      expect(
        earlierOrderAfterServerAnswer(before, { outcome, orderId: "order-1" }),
      ).toBe(before);
    },
  );

  it("canceled → forgotten, even with a confirm of ours still out", () => {
    expect(
      earlierOrderAfterServerAnswer(
        record({ confirmsStillOut: 2 }),
        notPaid("canceled"),
      ),
    ).toBeNull();
  });

  it("requires_payment_method → forgotten only when no confirm of ours is still out", () => {
    expect(
      earlierOrderAfterServerAnswer(record(), notPaid("requires_payment_method")),
    ).toBeNull();
    const stillOut = record({ confirmsStillOut: 1 });
    expect(
      earlierOrderAfterServerAnswer(stillOut, notPaid("requires_payment_method")),
    ).toBe(stillOut);
  });

  it.each(["requires_action", "requires_confirmation", "requires_capture"])(
    "%s can still be charged → kept as it was",
    (status) => {
      const before = record();
      expect(earlierOrderAfterServerAnswer(before, notPaid(status))).toBe(before);
    },
  );

  it.each(["canceled", "requires_payment_method"])(
    "'not paid' (%s) against Stripe's own 'paid' is a disagreement, never 'you were not charged': kept",
    (status) => {
      const before = record({ stripeSaid: "succeeded" });
      expect(earlierOrderAfterServerAnswer(before, notPaid(status))).toBe(before);
    },
  );

  it("'not paid' after the server itself said the payment went through: kept", () => {
    const before = record({ serverSaid: "confirmed" });
    expect(earlierOrderAfterServerAnswer(before, notPaid("canceled"))).toBe(before);
  });

  it("no answer → kept as it was", () => {
    const before = record();
    expect(
      earlierOrderAfterServerAnswer(before, {
        outcome: "unanswered",
        final: false,
      }),
    ).toBe(before);
  });
});
