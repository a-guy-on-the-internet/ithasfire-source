import { describe, expect, it } from "vitest";

import {
  LEDGER_ENTRY_LABEL_KEY,
  ledgerEntryChange,
  ledgerHoldVerb,
  olderBalanceAfterCents,
  type LedgerEntryType,
} from "../ledger-entry-presentation";

const ALL_TYPES: LedgerEntryType[] = [
  "SETTLEMENT_CREDIT",
  "REFUND_DEBIT",
  "DISPUTE_HOLD",
  "DISPUTE_DEBIT",
  "DISPUTE_RELEASE",
  "PAYOUT",
  "RESERVE_HOLD",
  "RESERVE_RELEASE",
  "MANUAL_ADJUSTMENT",
  "TRANSFER_REVERSAL_CREDIT",
  "CASH_SALE_DEBIT",
  "CASH_SALE_DEBIT_REVERSAL",
];

describe("ledgerEntryChange", () => {
  it("reads the direction from the balance column when both sides are known", () => {
    expect(
      ledgerEntryChange(
        { type: "SETTLEMENT_CREDIT", amountCents: 500, balanceAfterCents: 1500 },
        1000,
      ),
    ).toEqual({ kind: "credit", cents: 500 });
    expect(
      ledgerEntryChange(
        { type: "PAYOUT", amountCents: 900, balanceAfterCents: 100 },
        1000,
      ),
    ).toEqual({ kind: "debit", cents: 900 });
  });

  it("a row whose balance did not move is 'none' even if its type usually adds", () => {
    // A DISPUTE_RELEASE that released a HOLD moves no balance; the server's
    // balance column says so and the Change column must agree with it.
    expect(
      ledgerEntryChange(
        { type: "DISPUTE_RELEASE", amountCents: 300, balanceAfterCents: 1000 },
        1000,
      ),
    ).toEqual({ kind: "none", cents: 300 });
  });

  it("falls back to the documented direction per type when movement is unknown", () => {
    const byType = Object.fromEntries(
      ALL_TYPES.map((type) => [
        type,
        ledgerEntryChange({ type, amountCents: 100, balanceAfterCents: null }, 50)
          .kind,
      ]),
    );
    expect(byType).toEqual({
      SETTLEMENT_CREDIT: "credit",
      TRANSFER_REVERSAL_CREDIT: "credit",
      DISPUTE_RELEASE: "credit",
      REFUND_DEBIT: "debit",
      DISPUTE_DEBIT: "debit",
      PAYOUT: "debit",
      DISPUTE_HOLD: "none",
      RESERVE_HOLD: "none",
      RESERVE_RELEASE: "none",
      // No documented direction; unsigned until its balance says.
      MANUAL_ADJUSTMENT: "none",
      // A door cash sale's fee + tax, and its gate-refund reversal.
      CASH_SALE_DEBIT: "debit",
      CASH_SALE_DEBIT_REVERSAL: "credit",
    });
    // Unknown OLDER balance falls back the same way.
    expect(
      ledgerEntryChange(
        { type: "MANUAL_ADJUSTMENT", amountCents: 100, balanceAfterCents: 900 },
        null,
      ),
    ).toEqual({ kind: "none", cents: 100 });
  });

  it("a manual adjustment takes its sign from the balance movement", () => {
    expect(
      ledgerEntryChange(
        { type: "MANUAL_ADJUSTMENT", amountCents: 100, balanceAfterCents: 900 },
        1000,
      ),
    ).toEqual({ kind: "debit", cents: 100 });
  });
});

describe("olderBalanceAfterCents", () => {
  const rows = [{ balanceAfterCents: 1500 }, { balanceAfterCents: 1000 }];

  it("is the next older row's balance-after", () => {
    expect(olderBalanceAfterCents(rows, 0, false)).toBe(1000);
  });

  it("is 0 for the oldest row when nothing is behind it — the ledger opened at zero", () => {
    expect(olderBalanceAfterCents(rows, 1, false)).toBe(0);
  });

  it("is unknown for the oldest LOADED row while more pages remain", () => {
    expect(olderBalanceAfterCents(rows, 1, true)).toBeNull();
  });

  it("is unknown for a row above an unconfirmed page seam, even with a row below it", () => {
    expect(olderBalanceAfterCents(rows, 0, false, new Set([0]))).toBeNull();
    expect(olderBalanceAfterCents(rows, 0, false, new Set([5]))).toBe(1000);
  });
});

describe("labels and bucket verbs", () => {
  it("every entry type has a label key", () => {
    for (const type of ALL_TYPES) {
      expect(LEDGER_ENTRY_LABEL_KEY[type]).toMatch(/^admin\.payoutsEntry/);
    }
  });

  it("holds are 'held', releases are 'released', balance movers have no verb", () => {
    expect(ledgerHoldVerb("DISPUTE_HOLD")).toBe("held");
    expect(ledgerHoldVerb("RESERVE_HOLD")).toBe("held");
    expect(ledgerHoldVerb("RESERVE_RELEASE")).toBe("released");
    expect(ledgerHoldVerb("DISPUTE_RELEASE")).toBe("released");
    expect(ledgerHoldVerb("SETTLEMENT_CREDIT")).toBeNull();
    expect(ledgerHoldVerb("PAYOUT")).toBeNull();
  });
});
