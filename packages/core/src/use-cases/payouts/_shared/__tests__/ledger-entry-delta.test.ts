import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { PayeeLedgerEntryType } from "@th/types/repos/payee-ledger";

import {
  LEGACY_DEBT_RECOVERY_KEY_PREFIX,
  ledgerEntryBalanceDeltaCents,
} from "../ledger-entry-delta";

// ─────────────────────────────────────────────────────────────────────────────
// Two guards, one purpose: the helper must say exactly what the adapter's
// `listRollupDrift` CASE says about every entry type, forever.
//
//   1. Every enum member is pinned to an explicit sign, with the adapter arm
//      that justifies it quoted in the comment.
//   2. The adapter's SQL is read as TEXT and each arm is asserted to still be
//      there. The mapping lives in inline SQL, so it cannot be imported; this
//      is the "drift guard lives with the data" form for an un-importable
//      source. Reformat the CASE and this fails — fix the guard together with
//      the SQL, deliberately.
// ─────────────────────────────────────────────────────────────────────────────

const AMOUNT = 1_234;

/** Every member, so a new enum value fails the exhaustiveness test below. */
const ALL_TYPES: readonly PayeeLedgerEntryType[] = [
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

const delta = (
  type: PayeeLedgerEntryType,
  extra: { idempotencyKey?: string; relatedEntryType?: PayeeLedgerEntryType | null } = {},
) =>
  ledgerEntryBalanceDeltaCents({
    type,
    amountCents: AMOUNT,
    idempotencyKey: extra.idempotencyKey ?? `k:${type}`,
    relatedEntryType: extra.relatedEntryType ?? null,
  });

describe("ledgerEntryBalanceDeltaCents — every type, pinned", () => {
  // adapter: WHEN e."type" IN ('SETTLEMENT_CREDIT', 'TRANSFER_REVERSAL_CREDIT',
  //            'CASH_SALE_DEBIT_REVERSAL') THEN e."amountCents"::bigint
  it("SETTLEMENT_CREDIT adds", () => {
    expect(delta("SETTLEMENT_CREDIT")).toBe(AMOUNT);
  });
  it("TRANSFER_REVERSAL_CREDIT adds", () => {
    expect(delta("TRANSFER_REVERSAL_CREDIT")).toBe(AMOUNT);
  });
  it("CASH_SALE_DEBIT_REVERSAL adds — a gate refund gives the fee + tax back", () => {
    expect(delta("CASH_SALE_DEBIT_REVERSAL")).toBe(AMOUNT);
  });

  // adapter: WHEN e."type" IN ('REFUND_DEBIT', 'DISPUTE_DEBIT', 'CASH_SALE_DEBIT')
  //            THEN -e."amountCents"::bigint
  it("REFUND_DEBIT subtracts", () => {
    expect(delta("REFUND_DEBIT")).toBe(-AMOUNT);
  });
  it("DISPUTE_DEBIT subtracts", () => {
    expect(delta("DISPUTE_DEBIT")).toBe(-AMOUNT);
  });
  it("CASH_SALE_DEBIT subtracts — the door's fee + tax are owed to the platform", () => {
    expect(delta("CASH_SALE_DEBIT")).toBe(-AMOUNT);
  });
  it("a cash-sale debit and its reversal net to zero", () => {
    expect(delta("CASH_SALE_DEBIT") + delta("CASH_SALE_DEBIT_REVERSAL")).toBe(0);
  });

  // adapter: WHEN e."type" = 'PAYOUT' THEN CASE
  //            WHEN e."idempotencyKey" LIKE 'debt-recovery:%' THEN +amount
  //            ELSE -amount END
  it("PAYOUT subtracts", () => {
    expect(delta("PAYOUT", { idempotencyKey: "payout:item-1" })).toBe(-AMOUNT);
  });
  it("a LEGACY debt-recovery PAYOUT adds — the deleted writer applied +=", () => {
    expect(LEGACY_DEBT_RECOVERY_KEY_PREFIX).toBe("debt-recovery:");
    expect(
      delta("PAYOUT", { idempotencyKey: `${LEGACY_DEBT_RECOVERY_KEY_PREFIX}item-1` }),
    ).toBe(AMOUNT);
  });
  it("the legacy prefix is a PREFIX match, not a substring match (LIKE 'debt-recovery:%')", () => {
    expect(delta("PAYOUT", { idempotencyKey: "payout:debt-recovery:x" })).toBe(
      -AMOUNT,
    );
  });

  // adapter: WHEN e."type" = 'DISPUTE_RELEASE' THEN CASE WHEN EXISTS (
  //            SELECT 1 ... rel."id" = e."relatedEntryId" AND rel."type" = 'DISPUTE_DEBIT')
  //            THEN +amount ELSE 0 END
  it("DISPUTE_RELEASE compensating a DISPUTE_DEBIT adds (won-after-lost)", () => {
    expect(delta("DISPUTE_RELEASE", { relatedEntryType: "DISPUTE_DEBIT" })).toBe(
      AMOUNT,
    );
  });
  it("DISPUTE_RELEASE of a DISPUTE_HOLD is 0 — it moves the hold bucket", () => {
    expect(delta("DISPUTE_RELEASE", { relatedEntryType: "DISPUTE_HOLD" })).toBe(0);
  });
  it("DISPUTE_RELEASE with NO related row (explicit null) is 0 — the SQL's EXISTS is false", () => {
    // `relatedEntryType` is REQUIRED on the input type, so "forgot to
    // resolve it" is a compile error rather than a silent wrong sign; the
    // only runtime form of "no related row" is an explicit null.
    expect(delta("DISPUTE_RELEASE", { relatedEntryType: null })).toBe(0);
  });
  it("DISPUTE_RELEASE related to anything but a DISPUTE_DEBIT is 0", () => {
    for (const other of ALL_TYPES.filter((t) => t !== "DISPUTE_DEBIT")) {
      expect(delta("DISPUTE_RELEASE", { relatedEntryType: other })).toBe(0);
    }
  });

  // adapter: `ELSE 0` — these three live in `expectedPendingHoldCents` /
  // `expectedReserveCents`, never in the balance.
  it("DISPUTE_HOLD is 0", () => {
    expect(delta("DISPUTE_HOLD")).toBe(0);
  });
  it("RESERVE_HOLD is 0", () => {
    expect(delta("RESERVE_HOLD")).toBe(0);
  });
  it("RESERVE_RELEASE is 0", () => {
    expect(delta("RESERVE_RELEASE")).toBe(0);
  });

  // adapter: `ELSE 0`, and its doc block: "MANUAL_ADJUSTMENT contributes 0 —
  // zero writers exist today; when the ledger-admin correction tool lands,
  // its sign must be added HERE and in the payable query together."
  it("MANUAL_ADJUSTMENT is 0 — no writer exists and the rollup ignores it", () => {
    expect(delta("MANUAL_ADJUSTMENT")).toBe(0);
  });

  it("covers every enum member exactly once", () => {
    const seen = new Set<PayeeLedgerEntryType>();
    for (const type of ALL_TYPES) {
      expect(seen.has(type)).toBe(false);
      seen.add(type);
      // Every member yields an integer and never NaN/undefined.
      expect(Number.isInteger(delta(type))).toBe(true);
    }
    expect(seen.size).toBe(12);
  });

  it("never touches the amount's magnitude — |delta| is 0 or the amount", () => {
    for (const type of ALL_TYPES) {
      const d = Math.abs(delta(type, { relatedEntryType: "DISPUTE_DEBIT" }));
      expect(d === 0 || d === AMOUNT).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Parity guard against the adapter's SQL.
// ─────────────────────────────────────────────────────────────────────────────

const ADAPTER_PATH = join(
  __dirname,
  "../../../../../../adapters/src/db/prisma/payee-ledger.ts",
);

/** Collapse whitespace so a re-indent does not count as drift. */
const squash = (s: string) => s.replace(/\s+/g, " ").trim();

function rollupBalanceCase(): string {
  const source = readFileSync(ADAPTER_PATH, "utf8");
  const start = source.indexOf("async function listRollupDrift(");
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf('AS "expectedLedgerBalanceCents"', start);
  expect(end).toBeGreaterThan(start);
  return squash(source.slice(start, end));
}

describe("ledgerEntryBalanceDeltaCents — parity with listRollupDrift's SQL", () => {
  const sql = rollupBalanceCase();

  it("+ arm: SETTLEMENT_CREDIT, TRANSFER_REVERSAL_CREDIT and CASH_SALE_DEBIT_REVERSAL", () => {
    expect(sql).toContain(
      squash(`WHEN e."type" IN ('SETTLEMENT_CREDIT', 'TRANSFER_REVERSAL_CREDIT', 'CASH_SALE_DEBIT_REVERSAL')
              THEN e."amountCents"::bigint`),
    );
  });

  it("DISPUTE_RELEASE arm: + only when relatedEntry is a DISPUTE_DEBIT, else 0", () => {
    expect(sql).toContain(
      squash(`WHEN e."type" = 'DISPUTE_RELEASE' THEN
              CASE
                WHEN EXISTS (
                  SELECT 1 FROM public."PayeeLedgerEntry" rel
                  WHERE rel."id" = e."relatedEntryId"
                    AND rel."type" = 'DISPUTE_DEBIT'
                )
                THEN e."amountCents"::bigint
                ELSE 0
              END`),
    );
  });

  it("PAYOUT arm: − except the legacy debt-recovery: prefix, which is +", () => {
    expect(sql).toContain(
      squash(`WHEN e."type" = 'PAYOUT' THEN
              CASE
                WHEN e."idempotencyKey" LIKE '${LEGACY_DEBT_RECOVERY_KEY_PREFIX}%'
                THEN e."amountCents"::bigint
                ELSE -e."amountCents"::bigint
              END`),
    );
  });

  it("− arm: REFUND_DEBIT, DISPUTE_DEBIT and CASH_SALE_DEBIT", () => {
    expect(sql).toContain(
      squash(`WHEN e."type" IN ('REFUND_DEBIT', 'DISPUTE_DEBIT', 'CASH_SALE_DEBIT')
              THEN -e."amountCents"::bigint`),
    );
  });

  it("everything else — holds, reserves, MANUAL_ADJUSTMENT — falls to ELSE 0", () => {
    // The tail of the balance CASE is the catch-all. If the adapter ever
    // gives MANUAL_ADJUSTMENT (or a hold/reserve type) its own arm, this
    // stops matching and the helper's 0 must be revisited in the same commit.
    expect(sql).toContain(squash(`THEN -e."amountCents"::bigint ELSE 0 END )::bigint`));
    for (const zeroType of [
      "DISPUTE_HOLD",
      "RESERVE_HOLD",
      "RESERVE_RELEASE",
      "MANUAL_ADJUSTMENT",
    ]) {
      expect(sql).not.toContain(`'${zeroType}'`);
    }
  });
});
