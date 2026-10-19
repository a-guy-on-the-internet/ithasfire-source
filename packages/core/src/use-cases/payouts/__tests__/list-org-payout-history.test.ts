import { describe, expect, it, vi } from "vitest";

import {
  listOrgPayoutHistory,
  listOrgPayoutHistoryOutputSchema,
  ORG_PAYOUT_HISTORY_TIMEOUT_MS,
  type ListOrgPayoutHistoryDeps,
} from "../list-org-payout-history";

const ACTOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const PAYEE = "payee-org";

function payoutItem(overrides: Record<string, unknown> = {}) {
  return {
    id: "item-1",
    payoutId: "payout-1",
    payeeId: PAYEE,
    subjectType: "ORGANIZATION" as const,
    subjectId: ORG_ID,
    currency: "usd",
    amountCents: 50_000,
    netCents: 48_700,
    connectAccountFeeCents: 200,
    recoveredDebtCents: 0,
    reserveHeldCents: 1_100,
    reserveReleasedCents: 0,
    status: "transferred" as const,
    transferredAt: new Date("2026-09-06T00:00:00.000Z"),
    failedAt: null,
    failureReason: null,
    stripeTransferId: "tr_123",
    occurredAt: new Date("2026-09-06T00:00:00.000Z"),
    scheduledFor: new Date("2026-09-05T00:00:00.000Z"),
    payoutStatus: "completed",
    processorBatchId: "batch_1",
    createdAt: new Date("2026-09-05T00:00:00.000Z"),
    ...overrides,
  };
}

function makeDeps(
  options: {
    allowed?: boolean;
    payeeRef?: { id: string } | null;
    items?: ReturnType<typeof payoutItem>[];
    nextCursor?: string | null;
    total?: number;
  } = {},
) {
  const canFinanceOrg = vi.fn(async () => ({
    allowed: options.allowed ?? true,
  }));
  const getBySubject = vi.fn(async () =>
    options.payeeRef === undefined ? { id: PAYEE } : options.payeeRef,
  );
  const listHistory = vi.fn(async () => ({
    items: options.items ?? [payoutItem()],
    pageInfo: {
      cursorField: "occurredAt",
      nextCursor: options.nextCursor ?? null,
      limit: 25,
      hasNextPage: Boolean(options.nextCursor),
    },
    total: options.total ?? 1,
  }));

  const deps = {
    repos: { payoutItems: { listHistory }, payees: { getBySubject } },
    authz: { canFinanceOrg },
  } as unknown as ListOrgPayoutHistoryDeps;

  return { deps, canFinanceOrg, getBySubject, listHistory };
}

const run = async (
  h: ReturnType<typeof makeDeps>,
  input: Record<string, unknown> = {},
) =>
  listOrgPayoutHistoryOutputSchema.parse(
    await listOrgPayoutHistory(h.deps, {
      actorHumanId: ACTOR,
      orgId: ORG_ID,
      ...input,
    }),
  );

describe("listOrgPayoutHistory", () => {
  it("refuses an actor without org finance permission, BEFORE any read", async () => {
    const h = makeDeps({ allowed: false });

    await expect(
      listOrgPayoutHistory(h.deps, { actorHumanId: ACTOR, orgId: ORG_ID }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(h.getBySubject).not.toHaveBeenCalled();
    expect(h.listHistory).not.toHaveBeenCalled();
  });

  it("scopes the read to the ORG's own payee — never omits payeeIds", async () => {
    const h = makeDeps();

    await run(h);

    expect(h.getBySubject).toHaveBeenCalledWith({
      type: "ORGANIZATION",
      id: ORG_ID,
    });
    expect(h.listHistory).toHaveBeenCalledWith({
      status: "all",
      payeeIds: [PAYEE],
      cursor: null,
      limit: undefined,
      statementTimeoutMs: ORG_PAYOUT_HISTORY_TIMEOUT_MS,
    });
    // An OMITTED `payeeIds` would be every payee on the platform.
    const call = h.listHistory.mock.calls[0]![0] as { payeeIds?: string[] };
    expect(call.payeeIds).toBeDefined();
  });

  it("another org's id yields that org's payee, never this one's rows", async () => {
    const h = makeDeps();

    await listOrgPayoutHistory(h.deps, {
      actorHumanId: ACTOR,
      orgId: OTHER_ORG,
    });

    expect(h.canFinanceOrg).toHaveBeenCalledWith({
      actorHumanId: ACTOR,
      orgId: OTHER_ORG,
    });
    expect(h.getBySubject).toHaveBeenCalledWith({
      type: "ORGANIZATION",
      id: OTHER_ORG,
    });
  });

  it("returns an empty page with payeeId null when the org never onboarded", async () => {
    const h = makeDeps({ payeeRef: null });

    const out = await run(h);

    expect(out).toEqual({
      items: [],
      nextCursor: null,
      total: 0,
      payeeId: null,
    });
    expect(h.listHistory).not.toHaveBeenCalled();
  });

  it("maps a row with every deduction, and drops the platform-wide batch id", async () => {
    const h = makeDeps();

    const out = await run(h);

    expect(out.items[0]).toEqual({
      id: "item-1",
      payoutId: "payout-1",
      currency: "usd",
      amountCents: 50_000,
      netCents: 48_700,
      connectAccountFeeCents: 200,
      recoveredDebtCents: 0,
      reserveHeldCents: 1_100,
      reserveReleasedCents: 0,
      status: "transferred",
      occurredAt: new Date("2026-09-06T00:00:00.000Z"),
      transferredAt: new Date("2026-09-06T00:00:00.000Z"),
      scheduledFor: new Date("2026-09-05T00:00:00.000Z"),
      failedAt: null,
      failureReason: null,
      stripeTransferId: "tr_123",
    });
    expect(out.items[0]).not.toHaveProperty("processorBatchId");
    expect(out.items[0]).not.toHaveProperty("payeeId");
  });

  it("keeps a NULL netCents null — a pre-cutover row is not a $0 transfer", async () => {
    const h = makeDeps({ items: [payoutItem({ netCents: null })] });

    const out = await run(h);

    expect(out.items[0]!.netCents).toBeNull();
  });

  it("keeps the batch's own failure reason, which is the only explanation there is", async () => {
    const h = makeDeps({
      items: [
        payoutItem({
          status: "failed",
          transferredAt: null,
          stripeTransferId: null,
          failedAt: new Date("2026-09-06T01:00:00.000Z"),
          failureReason: "payee_missing_stripe_account",
        }),
      ],
    });

    const out = await run(h);

    expect(out.items[0]).toMatchObject({
      status: "failed",
      failureReason: "payee_missing_stripe_account",
    });
  });

  it("passes status, cursor and limit through and returns the page info", async () => {
    const h = makeDeps({ nextCursor: "cursor-2", total: 42 });

    const out = await run(h, {
      status: "transferred",
      cursor: "cursor-1",
      limit: 10,
    });

    expect(h.listHistory).toHaveBeenCalledWith({
      status: "transferred",
      payeeIds: [PAYEE],
      cursor: "cursor-1",
      limit: 10,
      statementTimeoutMs: ORG_PAYOUT_HISTORY_TIMEOUT_MS,
    });
    expect(out.nextCursor).toBe("cursor-2");
    expect(out.total).toBe(42);
    expect(out.payeeId).toBe(PAYEE);
  });

  it("rejects an unknown input key, and a payeeId the caller tries to supply", async () => {
    const h = makeDeps();

    await expect(
      listOrgPayoutHistory(h.deps, {
        actorHumanId: ACTOR,
        orgId: ORG_ID,
        payeeId: "someone-elses-payee",
      }),
    ).rejects.toBeTruthy();
  });

  it("lets a read failure THROW — a money table must not silently show nothing", async () => {
    const h = makeDeps();
    const boom = new Error("history read timed out");
    h.listHistory.mockRejectedValueOnce(boom);

    await expect(
      listOrgPayoutHistory(h.deps, { actorHumanId: ACTOR, orgId: ORG_ID }),
    ).rejects.toBe(boom);
  });
});
