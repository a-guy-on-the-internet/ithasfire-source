import { describe, expect, it, vi } from "vitest";

// The view module imports the app's tRPC client and hooks; only its pure
// row helpers are under test here.
vi.mock("@/trpc", () => ({ trpc: {} }));
vi.mock("@/hooks/useIsMobile", () => ({ useIsMobile: () => false }));

import {
  orderCashDebtRows,
  payeeHref,
  payeeName,
  payoutState,
  type CashDebtRow,
} from "../CashDebtsView";

function row(overrides: Partial<CashDebtRow>): CashDebtRow {
  return {
    payeeId: "p",
    subjectType: "ORGANIZATION",
    subjectId: "0f0e0d0c-0b0a-4000-8000-000000000000",
    orgName: "Harbor Lights Collective",
    orgSlug: "harbor-lights",
    currency: "usd",
    unrecoveredCashDebtCents: 26815,
    overdueCashDebtCents: 21240,
    oldestUnrecoveredAt: new Date("2026-08-02T00:00:00.000Z"),
    hasStripeAccount: true,
    payoutsEnabled: true,
    payableCents: -26815,
    ...overrides,
  };
}

describe("payoutState", () => {
  it("no Stripe account is 'not set up' whatever payoutsEnabled says", () => {
    expect(payoutState({ hasStripeAccount: false, payoutsEnabled: true })).toBe(
      "notSetUp",
    );
  });
  it("an account with payouts off is paused", () => {
    expect(payoutState({ hasStripeAccount: true, payoutsEnabled: false })).toBe(
      "paused",
    );
  });
  it("an account with payouts on is on", () => {
    expect(payoutState({ hasStripeAccount: true, payoutsEnabled: true })).toBe(
      "on",
    );
  });
});

describe("orderCashDebtRows", () => {
  it("puts 'not set up' first and keeps the server's order otherwise", () => {
    const rows = [
      row({ payeeId: "a", hasStripeAccount: true }),
      row({ payeeId: "b", hasStripeAccount: false }),
      row({ payeeId: "c", hasStripeAccount: true }),
      row({ payeeId: "d", hasStripeAccount: false }),
    ];
    expect(orderCashDebtRows(rows).map((r) => r.payeeId)).toEqual([
      "b",
      "d",
      "a",
      "c",
    ]);
  });
});

describe("payee link and name", () => {
  it("an organisation links to its admin page", () => {
    expect(payeeHref(row({}))).toBe("/admin/harbor-lights");
    expect(payeeName(row({}))).toBe("Harbor Lights Collective");
  });
  it("a person has no link and no name from the server: a short id", () => {
    const person = row({ subjectType: "HUMAN", orgName: null, orgSlug: null });
    expect(payeeHref(person)).toBeNull();
    expect(payeeName(person)).toBe("0f0e0d0c...");
  });
});
