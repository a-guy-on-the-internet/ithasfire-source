import { describe, expect, it, vi } from "vitest";

import type { PayeeLedgerDebtPosition } from "@th/ports/repos/payee-ledger";

import {
  listPayeeDebtPositions,
  PAYEE_DEBT_STATEMENT_TIMEOUT_MS,
  type ListPayeeDebtPositionsDeps,
} from "../list-payee-debt-positions";

const ACTOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_ID = "11111111-1111-4111-8111-111111111111";
const HUMAN_ID = "22222222-2222-4222-8222-222222222222";
const ORG_PAYEE = "payee-org";
const HUMAN_PAYEE = "payee-human";
const NOW = new Date("2026-09-01T12:00:00.000Z");
const AUG_1 = new Date("2026-08-01T00:00:00.000Z");
const OCT_1 = new Date("2026-10-01T20:00:00.000Z");

function debtRow(
  overrides: Partial<PayeeLedgerDebtPosition> = {},
): PayeeLedgerDebtPosition {
  return {
    payeeId: ORG_PAYEE,
    subjectType: "ORGANIZATION",
    subjectId: ORG_ID,
    currency: "usd",
    payableCents: -12_000,
    debtSinceAt: AUG_1,
    lastDebitType: "DISPUTE_DEBIT",
    lastDebitAt: AUG_1,
    disputeDebitCents: 12_000,
    refundDebitCents: 0,
    ...overrides,
  };
}

type Options = {
  allowed?: boolean;
  rows?: PayeeLedgerDebtPosition[];
  nextCursor?: string | null;
  total?: number;
  labelsFail?: boolean;
};

function makeDeps(options: Options = {}) {
  const rows = options.rows ?? [debtRow()];
  const hasStaffRole = vi.fn(async () => ({ allowed: options.allowed ?? true }));
  const listDebtPositions = vi.fn(async () => ({
    items: rows,
    pageInfo: {
      cursorField: "payableCents,payeeId,currency",
      nextCursor: options.nextCursor ?? null,
      limit: 25,
      hasNextPage: Boolean(options.nextCursor),
    },
    total: options.total ?? rows.length,
  }));
  const getUpcomingStatsForOwners = vi.fn(async () => [
    {
      ownerType: "ORGANIZATION" as const,
      ownerId: ORG_ID,
      upcomingCount: 2,
      nextEventAt: OCT_1,
    },
  ]);
  const countOpenByOwners = vi.fn(async () => [
    { ownerOrgId: ORG_ID, ownerHumanId: null, openDisputeCount: 1 },
  ]);
  const lookupFailure = new Error("db down");
  const organizations = {
    getByIds: vi.fn(async (ids: string[]) => {
      if (options.labelsFail) throw lookupFailure;
      return ids
        .filter((id) => id === ORG_ID)
        .map((id) => ({ id, name: "DRKMTTR", slug: "drkmttr" }));
    }),
  };
  const humans = {
    getByIds: vi.fn(async (ids: string[]) =>
      ids.filter((id) => id === HUMAN_ID).map((id) => ({ id, name: "Sole Artist" })),
    ),
  };
  const reportError = vi.fn();
  const logger = {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  };
  logger.child.mockReturnValue(logger);

  const deps = {
    repos: {
      payeeLedger: { listDebtPositions },
      organizations,
      humans,
      events: { getUpcomingStatsForOwners },
      disputes: { countOpenByOwners },
    },
    authz: { hasStaffRole },
    clock: { now: () => NOW },
    logger,
    reportError,
  } as unknown as ListPayeeDebtPositionsDeps;

  return {
    deps,
    hasStaffRole,
    listDebtPositions,
    getUpcomingStatsForOwners,
    countOpenByOwners,
    organizations,
    humans,
    reportError,
    lookupFailure,
  };
}

describe("listPayeeDebtPositions", () => {
  it("refuses a non-staff actor with STAFF_ONLY before touching the ledger", async () => {
    const h = makeDeps({ allowed: false });
    await expect(
      listPayeeDebtPositions(h.deps, { actorHumanId: ACTOR }),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });
    expect(h.hasStaffRole).toHaveBeenCalledWith({
      actorHumanId: ACTOR,
      requiredRoles: ["ADMIN", "SUPPORT"],
    });
    expect(h.listDebtPositions).not.toHaveBeenCalled();
  });

  it("rejects unknown input keys", async () => {
    const h = makeDeps();
    await expect(
      listPayeeDebtPositions(h.deps, { actorHumanId: ACTOR, direction: "forward" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("enriches each debt cell with owner label, slug, upcoming events and open disputes", async () => {
    const h = makeDeps();
    const out = await listPayeeDebtPositions(h.deps, { actorHumanId: ACTOR });

    expect(h.listDebtPositions).toHaveBeenCalledWith({
      now: NOW,
      cursor: null,
      limit: undefined,
      statementTimeoutMs: PAYEE_DEBT_STATEMENT_TIMEOUT_MS,
    });
    expect(h.getUpcomingStatsForOwners).toHaveBeenCalledWith({
      owners: [{ ownerType: "ORGANIZATION", ownerId: ORG_ID }],
      now: NOW,
    });
    expect(h.countOpenByOwners).toHaveBeenCalledWith({
      orgIds: [ORG_ID],
      humanIds: [],
    });
    expect(out).toEqual({
      items: [
        {
          payeeId: ORG_PAYEE,
          subjectType: "ORGANIZATION",
          subjectId: ORG_ID,
          ownerLabel: "DRKMTTR",
          ownerSlug: "drkmttr",
          currency: "usd",
          payableCents: -12_000,
          debtSinceAt: AUG_1,
          lastDebitType: "DISPUTE_DEBIT",
          lastDebitAt: AUG_1,
          disputeDebitCents: 12_000,
          refundDebitCents: 0,
          openDisputeCount: 1,
          upcomingEventCount: 2,
          nextEventAt: OCT_1,
        },
      ],
      nextCursor: null,
      total: 1,
    });
  });

  it("reports zero upcoming events / zero open disputes for an owner absent from both rollups (the no-recovery case)", async () => {
    const h = makeDeps({
      rows: [
        debtRow({
          payeeId: HUMAN_PAYEE,
          subjectType: "HUMAN",
          subjectId: HUMAN_ID,
          payableCents: -500,
          lastDebitType: "REFUND_DEBIT",
          disputeDebitCents: 0,
          refundDebitCents: 500,
          debtSinceAt: null,
        }),
      ],
    });
    const out = await listPayeeDebtPositions(h.deps, { actorHumanId: ACTOR });
    expect(out.items[0]).toMatchObject({
      ownerLabel: "Sole Artist",
      ownerSlug: null,
      upcomingEventCount: 0,
      nextEventAt: null,
      openDisputeCount: 0,
      debtSinceAt: null,
    });
    expect(h.countOpenByOwners).toHaveBeenCalledWith({
      orgIds: [],
      humanIds: [HUMAN_ID],
    });
  });

  it("passes a cash-only organiser's CASH_SALE_DEBIT through as the last debit (spec 2026-10-07, R6)", async () => {
    const h = makeDeps({
      rows: [
        debtRow({
          payableCents: -1_536,
          lastDebitType: "CASH_SALE_DEBIT",
          disputeDebitCents: 0,
          refundDebitCents: 0,
        }),
      ],
    });
    const out = await listPayeeDebtPositions(h.deps, { actorHumanId: ACTOR });
    expect(out.items[0]).toMatchObject({
      payableCents: -1_536,
      lastDebitType: "CASH_SALE_DEBIT",
    });
  });

  it("passes the cursor + limit through and surfaces the next cursor", async () => {
    const h = makeDeps({ nextCursor: "next-1", total: 40 });
    const out = await listPayeeDebtPositions(h.deps, {
      actorHumanId: ACTOR,
      cursor: "prev-1",
      limit: 10,
    });
    expect(h.listDebtPositions).toHaveBeenCalledWith({
      now: NOW,
      cursor: "prev-1",
      limit: 10,
      statementTimeoutMs: PAYEE_DEBT_STATEMENT_TIMEOUT_MS,
    });
    expect(out.nextCursor).toBe("next-1");
    expect(out.total).toBe(40);
  });

  it("skips the enrichment reads entirely on an empty page", async () => {
    const h = makeDeps({ rows: [] });
    const out = await listPayeeDebtPositions(h.deps, { actorHumanId: ACTOR });
    expect(out).toEqual({ items: [], nextCursor: null, total: 0 });
    expect(h.getUpcomingStatsForOwners).not.toHaveBeenCalled();
    expect(h.countOpenByOwners).not.toHaveBeenCalled();
    expect(h.organizations.getByIds).not.toHaveBeenCalled();
  });

  it("keeps the row (label null) and REPORTS when the owner-name lookup fails", async () => {
    const h = makeDeps({ labelsFail: true });
    const out = await listPayeeDebtPositions(h.deps, { actorHumanId: ACTOR });
    expect(out.items[0]).toMatchObject({
      ownerLabel: null,
      ownerSlug: null,
      payableCents: -12_000,
      upcomingEventCount: 2,
    });
    expect(h.reportError).toHaveBeenCalledWith(
      h.lookupFailure,
      expect.objectContaining({
        tags: expect.objectContaining({ useCase: "listPayeeDebtPositions" }),
      }),
    );
  });

  it("lets the adapter's SERVICE_UNAVAILABLE timeout through untouched (the UI renders it inline)", async () => {
    const h = makeDeps();
    h.listDebtPositions.mockRejectedValueOnce(
      Object.assign(new Error("payee_ledger_debt_positions_timeout"), {
        code: "SERVICE_UNAVAILABLE",
      }),
    );
    await expect(
      listPayeeDebtPositions(h.deps, { actorHumanId: ACTOR }),
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  });

  it("FAILS the read (no false 'None') when the recovery signal cannot be computed", async () => {
    const h = makeDeps();
    h.getUpcomingStatsForOwners.mockRejectedValueOnce(new Error("events down"));
    await expect(
      listPayeeDebtPositions(h.deps, { actorHumanId: ACTOR }),
    ).rejects.toThrow("events down");
  });
});
