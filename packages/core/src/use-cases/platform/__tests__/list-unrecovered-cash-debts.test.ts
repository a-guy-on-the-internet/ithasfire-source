import { describe, expect, it, vi } from "vitest";

import type { PayeeLedgerUnrecoveredCashDebt } from "@th/ports/repos/payee-ledger";

import {
  CASH_DEBT_OVERDUE_DAYS,
  listUnrecoveredCashDebts,
  UNRECOVERED_CASH_DEBT_STATEMENT_TIMEOUT_MS,
  type ListUnrecoveredCashDebtsDeps,
} from "../list-unrecovered-cash-debts";

const ACTOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_ID = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-10-08T15:30:00.000Z");
const AUG_20 = new Date("2026-08-20T02:00:00.000Z");

function row(
  overrides: Partial<PayeeLedgerUnrecoveredCashDebt> = {},
): PayeeLedgerUnrecoveredCashDebt {
  return {
    payeeId: "payee-org",
    subjectType: "ORGANIZATION",
    subjectId: ORG_ID,
    orgName: "Cash Only Collective",
    orgSlug: "cash-only-collective",
    currency: "usd",
    unrecoveredCashDebtCents: 1_450,
    overdueCashDebtCents: 950,
    oldestUnrecoveredAt: AUG_20,
    hasStripeAccount: false,
    payoutsEnabled: false,
    payableCents: -1_450,
    ...overrides,
  };
}

function makeDeps(
  options: { allowed?: boolean; rows?: PayeeLedgerUnrecoveredCashDebt[]; nextCursor?: string | null; total?: number } = {},
) {
  const rows = options.rows ?? [row()];
  const hasStaffRole = vi.fn(async () => ({ allowed: options.allowed ?? true }));
  const listUnrecoveredCashDebts = vi.fn(async () => ({
    items: rows,
    pageInfo: {
      cursorField: "overdueCashDebtCents,payeeId,currency",
      nextCursor: options.nextCursor ?? null,
      limit: 25,
      hasNextPage: Boolean(options.nextCursor),
    },
    total: options.total ?? rows.length,
  }));
  const deps = {
    repos: { payeeLedger: { listUnrecoveredCashDebts } },
    authz: { hasStaffRole },
    clock: { now: () => NOW },
  } as unknown as ListUnrecoveredCashDebtsDeps;
  return { deps, hasStaffRole, listUnrecoveredCashDebts };
}

describe("listUnrecoveredCashDebts", () => {
  it("refuses a non-staff caller with STAFF_ONLY and never reads the ledger", async () => {
    const { deps, hasStaffRole, listUnrecoveredCashDebts: read } = makeDeps({
      allowed: false,
    });
    await expect(
      listUnrecoveredCashDebts(deps, { actorHumanId: ACTOR }),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });
    expect(hasStaffRole).toHaveBeenCalledWith({
      actorHumanId: ACTOR,
      requiredRoles: ["ADMIN", "SUPPORT"],
    });
    expect(read).not.toHaveBeenCalled();
  });

  it("takes the 30-day cutoff from the injected clock, not the wall clock", async () => {
    const { deps, listUnrecoveredCashDebts: read } = makeDeps();
    const out = await listUnrecoveredCashDebts(deps, { actorHumanId: ACTOR });

    expect(CASH_DEBT_OVERDUE_DAYS).toBe(30);
    const expectedCutoff = new Date("2026-09-08T15:30:00.000Z");
    expect(read).toHaveBeenCalledWith({
      now: NOW,
      olderThan: expectedCutoff,
      cursor: null,
      limit: undefined,
      statementTimeoutMs: UNRECOVERED_CASH_DEBT_STATEMENT_TIMEOUT_MS,
    });
    expect(out.overdueBefore).toEqual(expectedCutoff);
  });

  it("passes the cursor and limit through and returns the next cursor and total", async () => {
    const { deps, listUnrecoveredCashDebts: read } = makeDeps({
      rows: [row(), row({ payeeId: "payee-2", currency: "cad" })],
      nextCursor: "next-page",
      total: 7,
    });
    const out = await listUnrecoveredCashDebts(deps, {
      actorHumanId: ACTOR,
      cursor: "page-2",
      limit: 2,
    });

    expect(read).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: "page-2", limit: 2 }),
    );
    expect(out.nextCursor).toBe("next-page");
    expect(out.total).toBe(7);
    expect(out.items).toHaveLength(2);
    expect(out.items[0]).toEqual({
      payeeId: "payee-org",
      subjectType: "ORGANIZATION",
      subjectId: ORG_ID,
      orgName: "Cash Only Collective",
      orgSlug: "cash-only-collective",
      currency: "usd",
      unrecoveredCashDebtCents: 1_450,
      overdueCashDebtCents: 950,
      oldestUnrecoveredAt: AUG_20,
      hasStripeAccount: false,
      payoutsEnabled: false,
      payableCents: -1_450,
    });
  });

  it("refuses unknown keys and an out-of-range limit before any read", async () => {
    const { deps, hasStaffRole, listUnrecoveredCashDebts: read } = makeDeps();
    await expect(
      listUnrecoveredCashDebts(deps, { actorHumanId: ACTOR, olderThanDays: 1 }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      listUnrecoveredCashDebts(deps, { actorHumanId: ACTOR, limit: 0 }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(hasStaffRole).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });
});
