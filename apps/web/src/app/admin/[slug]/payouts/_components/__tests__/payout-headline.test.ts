import { describe, expect, it } from "vitest";

import type { GetOrgPayoutOverviewOutput } from "@th/core/use-cases/payouts/get-org-payout-overview";
import type { GetPayeeStatementOutput } from "@th/core/use-cases/payouts/get-payee-statement";

import {
  answerLead,
  comingLater,
  formatPayoutNight,
  headlineFromOverview,
  headlineFromStatement,
  minimumMeterFraction,
  minimumVerdict,
  payoutsBlockedFromStatus,
  readyNowDiffers,
  sendCaption,
  tonightSendsCents,
  type PayoutHeadline,
} from "../payout-headline";

const base: PayoutHeadline = {
  payeeId: "payee-1",
  currency: "usd",
  balanceCents: 1564,
  payableCents: 500,
  payableResolved: true,
  pendingHoldCents: 0,
  reserveCents: 0,
  payoutMinimumCents: 100,
  minimumResolved: true,
  belowMinimum: false,
  payoutOverdue: false,
  nextPayoutRunNight: "2026-10-12",
};

describe("minimumVerdict — the discriminator order the use case documents", () => {
  it("no payee comes first: a brand-new org's nulls are not an outage", () => {
    expect(
      minimumVerdict({
        ...base,
        payeeId: null,
        payableCents: 0,
        belowMinimum: null,
        // Even with a failed policy read, no-payee wins.
        minimumResolved: false,
        payoutMinimumCents: null,
      }),
    ).toEqual({ kind: "no-payee" });
  });

  it("then the payable read, then the minimum read, then the boolean", () => {
    expect(
      minimumVerdict({
        ...base,
        payableCents: null,
        payableResolved: false,
        minimumResolved: false,
        payoutMinimumCents: null,
        belowMinimum: null,
      }),
    ).toEqual({ kind: "payable-unresolved" });
    expect(
      minimumVerdict({
        ...base,
        minimumResolved: false,
        payoutMinimumCents: null,
        belowMinimum: null,
      }),
    ).toEqual({ kind: "minimum-unresolved" });
    expect(minimumVerdict({ ...base, belowMinimum: true })).toEqual({
      kind: "below",
      payableCents: 500,
      payoutMinimumCents: 100,
    });
    expect(minimumVerdict(base)).toEqual({
      kind: "clear",
      payableCents: 500,
      payoutMinimumCents: 100,
    });
  });

  it("a null verdict with both reads resolved is 'cannot say', never 'clear'", () => {
    expect(minimumVerdict({ ...base, belowMinimum: null })).toEqual({
      kind: "unknown",
    });
  });
});

describe("tonightSendsCents — a missing number is never a zero", () => {
  it("is the payable when it clears, a measured 0 under the minimum, null otherwise", () => {
    expect(tonightSendsCents({ kind: "clear", payableCents: 500, payoutMinimumCents: 100 })).toBe(500);
    expect(tonightSendsCents({ kind: "below", payableCents: 60, payoutMinimumCents: 100 })).toBe(0);
    expect(tonightSendsCents({ kind: "payable-unresolved" })).toBeNull();
    expect(tonightSendsCents({ kind: "minimum-unresolved" })).toBeNull();
    expect(tonightSendsCents({ kind: "unknown" })).toBeNull();
    expect(tonightSendsCents({ kind: "no-payee" })).toBeNull();
  });
});

describe("minimumMeterFraction — visual only, clamped", () => {
  it("fills proportionally, clamps to [0, 1], and stays empty when unmeasured", () => {
    expect(minimumMeterFraction({ kind: "below", payableCents: 60, payoutMinimumCents: 100 })).toBe(0.6);
    expect(minimumMeterFraction({ kind: "clear", payableCents: 500, payoutMinimumCents: 100 })).toBe(1);
    expect(minimumMeterFraction({ kind: "below", payableCents: -200, payoutMinimumCents: 100 })).toBe(0);
    expect(minimumMeterFraction({ kind: "clear", payableCents: 500, payoutMinimumCents: 0 })).toBe(1);
    expect(minimumMeterFraction({ kind: "clear", payableCents: 0, payoutMinimumCents: 0 })).toBe(0);
    expect(minimumMeterFraction({ kind: "minimum-unresolved" })).toBe(0);
  });
});

describe("headlineFrom* — the next payout run's night", () => {
  const run = { runAt: "2026-10-13T05:00:00.000Z", night: "2026-10-12" };

  it("carries the night from the overview and from the statement", () => {
    expect(
      headlineFromOverview({
        nextPayoutRun: run,
      } as unknown as GetOrgPayoutOverviewOutput).nextPayoutRunNight,
    ).toBe("2026-10-12");
    expect(
      headlineFromStatement({
        nextPayoutRun: run,
      } as unknown as GetPayeeStatementOutput).nextPayoutRunNight,
    ).toBe("2026-10-12");
  });

  it("is null when the server says it cannot name the run (null, not missing)", () => {
    expect(
      headlineFromOverview({
        nextPayoutRun: null,
      } as unknown as GetOrgPayoutOverviewOutput).nextPayoutRunNight,
    ).toBeNull();
    expect(
      headlineFromStatement({
        nextPayoutRun: null,
      } as unknown as GetPayeeStatementOutput).nextPayoutRunNight,
    ).toBeNull();
  });

  it("is null, not a crash, when an older API does not send the field", () => {
    expect(
      headlineFromOverview({} as unknown as GetOrgPayoutOverviewOutput)
        .nextPayoutRunNight,
    ).toBeNull();
    expect(
      headlineFromStatement({} as unknown as GetPayeeStatementOutput)
        .nextPayoutRunNight,
    ).toBeNull();
  });
});

describe("formatPayoutNight", () => {
  it("delegates to the one calendar-date formatter (covered in lib/__tests__/format-calendar-date.test.ts)", () => {
    const fmt = {
      dateTime: (date: Date, options: Intl.DateTimeFormatOptions) =>
        new Intl.DateTimeFormat("en-US", options).format(date),
    };
    expect(formatPayoutNight(fmt, "2026-10-12")).toBe("Oct 12, 2026");
    expect(formatPayoutNight(fmt, "2026-02-31")).toBeNull();
  });
});

describe("payoutsBlockedFromStatus — the batch's own eligibility, never a guess", () => {
  it("is false while the status is loading or failed (undefined)", () => {
    expect(payoutsBlockedFromStatus(undefined)).toBe(false);
  });

  it("is true when no Stripe account is connected", () => {
    expect(
      payoutsBlockedFromStatus({ connected: false, payoutsEnabled: false }),
    ).toBe(true);
  });

  it("is true when connected but payouts are off", () => {
    expect(
      payoutsBlockedFromStatus({ connected: true, payoutsEnabled: false }),
    ).toBe(true);
  });

  it("is false when connected with payouts on, whatever charges say", () => {
    expect(
      payoutsBlockedFromStatus({ connected: true, payoutsEnabled: true }),
    ).toBe(false);
  });
});

describe("sendCaption — the We send it sub-line", () => {
  const t = (key: string, values?: { date: string }) =>
    values ? `${key}|${values.date}` : key;
  const clear = minimumVerdict(base);

  it("names the night when it is known", () => {
    expect(sendCaption(t, clear, "Oct 12, 2026")).toBe(
      "admin.payoutsSendSubNight|Oct 12, 2026",
    );
  });

  it("falls back to the dateless copy when the night is unknown", () => {
    expect(sendCaption(t, clear, null)).toBe("admin.payoutsSendSub");
  });

  it("replaces the whole caption when payouts are blocked, date and reasons included", () => {
    const below = minimumVerdict({ ...base, belowMinimum: true });
    expect(sendCaption(t, clear, "Oct 12, 2026", true)).toBe(
      "admin.payoutsSendSubBlocked",
    );
    expect(sendCaption(t, below, null, true)).toBe(
      "admin.payoutsSendSubBlocked",
    );
  });

  it("keeps today's caption when payouts are not blocked (unknown is no blocker)", () => {
    expect(sendCaption(t, clear, "Oct 12, 2026", false)).toBe(
      "admin.payoutsSendSubNight|Oct 12, 2026",
    );
    expect(sendCaption(t, clear, "Oct 12, 2026")).toBe(
      "admin.payoutsSendSubNight|Oct 12, 2026",
    );
  });

  it("appends the below-minimum reason to either variant", () => {
    const below = minimumVerdict({ ...base, belowMinimum: true });
    expect(sendCaption(t, below, "Oct 12, 2026")).toBe(
      "admin.payoutsSendSubNight|Oct 12, 2026 · admin.payoutsSendBelowReason",
    );
    expect(sendCaption(t, below, null)).toBe(
      "admin.payoutsSendSub · admin.payoutsSendBelowReason",
    );
  });

  it("appends the can't-say note whenever the amount is unknown", () => {
    const unknown = minimumVerdict({
      ...base,
      minimumResolved: false,
      payoutMinimumCents: null,
      belowMinimum: null,
    });
    expect(sendCaption(t, unknown, "Oct 12, 2026")).toBe(
      "admin.payoutsSendSubNight|Oct 12, 2026 · admin.payoutsCantSay",
    );
    expect(sendCaption(t, minimumVerdict({ ...base, payeeId: null }), null)).toBe(
      "admin.payoutsSendSub · admin.payoutsCantSay",
    );
  });
});

describe("readyNowDiffers — Ready now earns a figure only when it is not what we send", () => {
  it("cleared and unblocked: equal, so hidden", () => {
    expect(readyNowDiffers(minimumVerdict(base), false)).toBe(false);
  });

  it("holds and fees never make it differ: they sit outside the payable", () => {
    expect(
      readyNowDiffers(
        minimumVerdict({ ...base, reserveCents: 2500, pendingHoldCents: 300 }),
        false,
      ),
    ).toBe(false);
  });

  it("under the minimum: we send 0 while something is ready, so shown", () => {
    expect(
      readyNowDiffers(
        minimumVerdict({ ...base, payableCents: 60, belowMinimum: true }),
        false,
      ),
    ).toBe(true);
  });

  it("Stripe can't receive payouts: shown, even when the minimum clears", () => {
    expect(readyNowDiffers(minimumVerdict(base), true)).toBe(true);
  });

  it("a read failed: shown (with its own couldn't-check), never hidden as equal", () => {
    expect(
      readyNowDiffers(
        minimumVerdict({ ...base, payableResolved: false, payableCents: null }),
        false,
      ),
    ).toBe(true);
    expect(
      readyNowDiffers(
        minimumVerdict({
          ...base,
          minimumResolved: false,
          payoutMinimumCents: null,
          belowMinimum: null,
        }),
        false,
      ),
    ).toBe(true);
  });
});

describe("answerLead — the first sentence of the answer", () => {
  it("cleared: sends the payable", () => {
    expect(answerLead(base, false)).toEqual({ kind: "sends", cents: 500 });
  });

  it("under the minimum: a measured zero", () => {
    expect(
      answerLead({ ...base, payableCents: 60, belowMinimum: true }, false),
    ).toEqual({ kind: "sends", cents: 0 });
  });

  it("blocked: on hold, with what waits — or nothing claimed when none is ready", () => {
    expect(answerLead(base, true)).toEqual({ kind: "on-hold", readyCents: 500 });
    expect(answerLead({ ...base, payableCents: -200 }, true)).toEqual({
      kind: "on-hold",
      readyCents: null,
    });
    expect(
      answerLead({ ...base, payableResolved: false, payableCents: null }, true),
    ).toEqual({ kind: "on-hold", readyCents: null });
  });

  it("an unreadable payable or minimum: unknown, never a zero", () => {
    expect(
      answerLead({ ...base, payableResolved: false, payableCents: null }, false),
    ).toEqual({ kind: "unknown" });
    expect(
      answerLead(
        { ...base, minimumResolved: false, payoutMinimumCents: null, belowMinimum: null },
        false,
      ),
    ).toEqual({ kind: "unknown" });
  });
});

describe("comingLater — '…$X more by <date>' from the overview only", () => {
  const nov8 = new Date("2026-11-08T06:00:00.000Z");
  const nov15 = new Date("2026-11-15T06:00:00.000Z");
  const input = {
    upcoming: [{ maturesAt: nov8 }, { maturesAt: nov15 }],
    upcomingTruncated: false,
    upcomingResolved: true,
    upcomingExpectedCents: 285848,
  } as unknown as Parameters<typeof comingLater>[0];

  it("the expected (net) sum, dated by the last tranche", () => {
    expect(comingLater(input)).toEqual({ cents: 285848, by: nov15 });
  });

  it("a truncated list: the amount (summed server-side over all), no date", () => {
    expect(comingLater({ ...input, upcomingTruncated: true })).toEqual({
      cents: 285848,
      by: null,
    });
  });

  it("nothing honest to say: unresolved, unknown net, or nothing positive", () => {
    expect(comingLater({ ...input, upcomingResolved: false })).toBeNull();
    expect(comingLater({ ...input, upcomingExpectedCents: null })).toBeNull();
    expect(comingLater({ ...input, upcomingExpectedCents: 0 })).toBeNull();
    expect(
      comingLater({ ...input, upcoming: [], upcomingExpectedCents: 0 }),
    ).toBeNull();
  });
});
