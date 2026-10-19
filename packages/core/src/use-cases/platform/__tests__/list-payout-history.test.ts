import { describe, expect, it, vi } from "vitest";

import type { PayoutHistoryItem } from "@th/ports/repos/payout-items";

import {
  listPayoutHistory,
  PAYOUT_HISTORY_STATEMENT_TIMEOUT_MS,
  type ListPayoutHistoryDeps,
} from "../list-payout-history";

const ACTOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_ID = "11111111-1111-4111-8111-111111111111";
const HUMAN_ID = "22222222-2222-4222-8222-222222222222";
const TRANSFERRED_AT = new Date("2026-09-09T05:00:00.000Z");
const SCHEDULED_FOR = new Date("2026-09-08T05:00:00.000Z");

function historyRow(
  overrides: Partial<PayoutHistoryItem> = {},
): PayoutHistoryItem {
  return {
    id: "item-1",
    payoutId: "payout-1",
    payeeId: "payee-org",
    subjectType: "ORGANIZATION",
    subjectId: ORG_ID,
    currency: "usd",
    amountCents: 50_000,
    connectAccountFeeCents: 200,
    recoveredDebtCents: 0,
    reserveHeldCents: 1_000,
    reserveReleasedCents: 250,
    netCents: 49_050,
    status: "transferred",
    transferredAt: TRANSFERRED_AT,
    failedAt: null,
    failureReason: null,
    stripeTransferId: "tr_123",
    occurredAt: TRANSFERRED_AT,
    scheduledFor: SCHEDULED_FOR,
    payoutStatus: "completed",
    processorBatchId: null,
    createdAt: SCHEDULED_FOR,
    ...overrides,
  };
}

type Options = {
  allowed?: boolean;
  rows?: PayoutHistoryItem[];
  nextCursor?: string | null;
  total?: number;
  labelsFail?: boolean;
};

function makeDeps(options: Options = {}) {
  const rows = options.rows ?? [historyRow()];
  const hasStaffRole = vi.fn(async () => ({ allowed: options.allowed ?? true }));
  const listHistory = vi.fn(async () => ({
    items: rows,
    pageInfo: {
      cursorField: "occurredAt,id",
      nextCursor: options.nextCursor ?? null,
      limit: 25,
      hasNextPage: Boolean(options.nextCursor),
    },
    total: options.total ?? rows.length,
  }));
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
      ids
        .filter((id) => id === HUMAN_ID)
        .map((id) => ({ id, name: "Sole Artist" })),
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
    repos: { payoutItems: { listHistory }, organizations, humans },
    authz: { hasStaffRole },
    logger,
    reportError,
  } as unknown as ListPayoutHistoryDeps;

  return {
    deps,
    hasStaffRole,
    listHistory,
    organizations,
    humans,
    logger,
    reportError,
    lookupFailure,
  };
}

describe("listPayoutHistory", () => {
  it("refuses a non-staff actor without reading payout history", async () => {
    const h = makeDeps({ allowed: false });
    await expect(
      listPayoutHistory(h.deps, { actorHumanId: ACTOR }),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });
    expect(h.hasStaffRole).toHaveBeenCalledWith({
      actorHumanId: ACTOR,
      requiredRoles: ["ADMIN", "SUPPORT"],
    });
    expect(h.listHistory).not.toHaveBeenCalled();
  });

  it("refuses unknown input keys (strict schema)", async () => {
    const h = makeDeps();
    await expect(
      listPayoutHistory(h.deps, { actorHumanId: ACTOR, direction: "forward" }),
    ).rejects.toBeTruthy();
  });

  it("defaults to the unfiltered feed and passes the statement budget", async () => {
    const h = makeDeps();
    await listPayoutHistory(h.deps, { actorHumanId: ACTOR });
    expect(h.listHistory).toHaveBeenCalledWith({
      status: "all",
      cursor: null,
      limit: undefined,
      statementTimeoutMs: PAYOUT_HISTORY_STATEMENT_TIMEOUT_MS,
    });
  });

  it("passes the status filter, cursor and limit through", async () => {
    const h = makeDeps({ nextCursor: "next-page" });
    const out = await listPayoutHistory(h.deps, {
      actorHumanId: ACTOR,
      status: "failed",
      cursor: "abc",
      limit: 10,
    });
    expect(h.listHistory).toHaveBeenCalledWith({
      status: "failed",
      cursor: "abc",
      limit: 10,
      statementTimeoutMs: PAYOUT_HISTORY_STATEMENT_TIMEOUT_MS,
    });
    expect(out.nextCursor).toBe("next-page");
  });

  it("rejects a status outside the filter set", async () => {
    const h = makeDeps();
    await expect(
      listPayoutHistory(h.deps, { actorHumanId: ACTOR, status: "canceled" }),
    ).rejects.toBeTruthy();
  });

  it("returns the deductions that explain the net, and resolves who was paid", async () => {
    const h = makeDeps();
    const out = await listPayoutHistory(h.deps, { actorHumanId: ACTOR });

    expect(out.total).toBe(1);
    expect(out.items[0]).toMatchObject({
      id: "item-1",
      ownerLabel: "DRKMTTR",
      ownerSlug: "drkmttr",
      amountCents: 50_000,
      connectAccountFeeCents: 200,
      reserveHeldCents: 1_000,
      reserveReleasedCents: 250,
      netCents: 49_050,
      status: "transferred",
      stripeTransferId: "tr_123",
      occurredAt: TRANSFERRED_AT,
    });
    // Gross − withheld + released = the recorded net. Integer cents only.
    const row = out.items[0]!;
    expect(
      row.amountCents -
        row.recoveredDebtCents -
        row.reserveHeldCents -
        row.connectAccountFeeCents +
        row.reserveReleasedCents,
    ).toBe(row.netCents);
  });

  it("carries the failure reason and dates a pending item by its batch schedule", async () => {
    const h = makeDeps({
      rows: [
        historyRow({
          id: "item-failed",
          status: "failed",
          transferredAt: null,
          failedAt: TRANSFERRED_AT,
          failureReason: "account_closed",
          stripeTransferId: null,
          occurredAt: SCHEDULED_FOR,
        }),
        historyRow({
          id: "item-pending",
          payeeId: "payee-human",
          subjectType: "HUMAN",
          subjectId: HUMAN_ID,
          status: "pending",
          transferredAt: null,
          stripeTransferId: null,
          occurredAt: SCHEDULED_FOR,
        }),
      ],
    });

    const out = await listPayoutHistory(h.deps, { actorHumanId: ACTOR });

    expect(out.items[0]).toMatchObject({
      status: "failed",
      failureReason: "account_closed",
      transferredAt: null,
      occurredAt: SCHEDULED_FOR,
    });
    expect(out.items[1]).toMatchObject({
      status: "pending",
      ownerLabel: "Sole Artist",
      ownerSlug: null,
      occurredAt: SCHEDULED_FOR,
    });
  });

  it("still lists the payouts when the label lookup fails, and reports the swallow", async () => {
    const h = makeDeps({ labelsFail: true });

    const out = await listPayoutHistory(h.deps, { actorHumanId: ACTOR });

    expect(out.items[0]).toMatchObject({
      id: "item-1",
      amountCents: 50_000,
      ownerLabel: null,
      ownerSlug: null,
      subjectId: ORG_ID,
    });
    expect(h.logger.error).toHaveBeenCalledWith(
      "payout_history_owner_label_lookup_failed",
      expect.objectContaining({ err: h.lookupFailure }),
    );
    expect(h.reportError).toHaveBeenCalledWith(
      h.lookupFailure,
      expect.objectContaining({
        tags: { useCase: "listPayoutHistory", step: "attachOwnerLabels" },
      }),
    );
  });

  it("a throwing reporter never changes the result", async () => {
    const h = makeDeps({ labelsFail: true });
    (h.reportError as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("sentry is down");
    });

    await expect(
      listPayoutHistory(h.deps, { actorHumanId: ACTOR }),
    ).resolves.toMatchObject({ total: 1 });
  });

  it("skips the label lookups entirely on an empty page", async () => {
    const h = makeDeps({ rows: [], total: 0 });

    const out = await listPayoutHistory(h.deps, { actorHumanId: ACTOR });

    expect(out).toEqual({ items: [], nextCursor: null, total: 0 });
    expect(h.organizations.getByIds).not.toHaveBeenCalled();
    expect(h.humans.getByIds).not.toHaveBeenCalled();
  });
});
