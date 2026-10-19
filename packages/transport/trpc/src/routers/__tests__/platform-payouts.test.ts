import { describe, expect, it, vi } from "vitest";

import { createCaller } from "./test-helpers";
import { platformRouter } from "../platform";

// Transport coverage for the two payout-visibility reads on
// /platform/settlements. The thin-transport contract is what is under test
// here: auth, the `.omit({ actorHumanId })` + `.strict()` input, the output
// schema, and error mapping. The arithmetic lives in the use cases and is
// tested there.

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const PAYEE_ID = "22222222-2222-4222-8222-222222222222";
const ORG_ID = "33333333-3333-4333-8333-333333333333";

const TRANSFERRED_AT = new Date("2026-09-09T05:00:00.000Z");
const SCHEDULED_FOR = new Date("2026-09-08T05:00:00.000Z");

const authzWith = (allowed: boolean) => {
  const hasStaffRole = vi.fn(async () => ({ allowed }));
  return {
    authz: {
      hasOrgRole: vi.fn(),
      requireOrgRole: vi.fn(),
      canEditEvent: vi.fn(),
      canManagePlace: vi.fn(),
      canFinanceOrg: vi.fn(),
      hasStaffRole,
    } as any,
    hasStaffRole,
  };
};

function makePayableRepos() {
  return {
    payeeLedger: {
      listPayableBalances: vi.fn(async () => [
        {
          payeeId: PAYEE_ID,
          currency: "usd",
          payableCents: 12_000,
          oldestMaturedAt: new Date("2026-08-01T00:00:00.000Z"),
        },
        // A debt cell: the view must drop it, exactly like the batch does.
        {
          payeeId: "payee-debt",
          currency: "usd",
          payableCents: -500,
          oldestMaturedAt: null,
        },
      ]),
      sumOutstandingLiability: vi.fn(async () => [
        {
          currency: "usd",
          unpaidCreditsCents: 90_000,
          reserveHeldCents: 5_000,
          pendingHoldCents: 2_500,
        },
      ]),
    },
    payees: {
      getByIds: vi.fn(async () => [
        {
          id: PAYEE_ID,
          subjectType: "ORGANIZATION",
          subjectId: ORG_ID,
          stripeAccountId: "acct_1",
          payoutsEnabled: true,
        },
      ]),
    },
    feePolicies: {
      resolveEffective: vi.fn(async () => ({ payoutMinimumCents: 1_000 })),
    },
    organizations: {
      getByIds: vi.fn(async () => [
        { id: ORG_ID, name: "DRKMTTR", slug: "drkmttr" },
      ]),
    },
    humans: { getByIds: vi.fn(async () => []) },
  } as any;
}

function makeHistoryRepos() {
  return {
    payoutItems: {
      listHistory: vi.fn(async () => ({
        items: [
          {
            id: "item-1",
            payoutId: "payout-1",
            payeeId: PAYEE_ID,
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
          },
        ],
        pageInfo: {
          cursorField: "occurredAt,id",
          nextCursor: null,
          limit: 25,
          hasNextPage: false,
        },
        total: 1,
      })),
    },
    organizations: {
      getByIds: vi.fn(async () => [
        { id: ORG_ID, name: "DRKMTTR", slug: "drkmttr" },
      ]),
    },
    humans: { getByIds: vi.fn(async () => []) },
  } as any;
}

describe("platform.listPayablePositions", () => {
  it("rejects an unauthenticated caller", async () => {
    const { caller } = createCaller(
      { listPayablePositions: platformRouter.listPayablePositions },
      { actorHumanId: null, repos: makePayableRepos() },
    );
    await expect(caller.listPayablePositions()).rejects.toThrow(/unauthorized/i);
  });

  it("rejects a non-staff caller via the use case's STAFF_ONLY gate without reading the ledger", async () => {
    const repos = makePayableRepos();
    const { authz, hasStaffRole } = authzWith(false);
    const { caller } = createCaller(
      { listPayablePositions: platformRouter.listPayablePositions },
      { actorHumanId: ACTOR_ID, authz, repos },
    );

    await expect(caller.listPayablePositions()).rejects.toThrow(
      /forbidden|staff/i,
    );
    expect(hasStaffRole).toHaveBeenCalledWith({
      actorHumanId: ACTOR_ID,
      requiredRoles: ["ADMIN", "SUPPORT"],
    });
    expect(repos.payeeLedger.listPayableBalances).not.toHaveBeenCalled();
    expect(repos.payeeLedger.sumOutstandingLiability).not.toHaveBeenCalled();
  });

  it("returns payable and liability as SEPARATE fields for staff", async () => {
    const repos = makePayableRepos();
    const { authz } = authzWith(true);
    const { caller } = createCaller(
      { listPayablePositions: platformRouter.listPayablePositions },
      { actorHumanId: ACTOR_ID, authz, repos },
    );

    const result = await caller.listPayablePositions();

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      payeeId: PAYEE_ID,
      ownerLabel: "DRKMTTR",
      ownerSlug: "drkmttr",
      payableCents: 12_000,
      // The batch's post-payable gates, evaluated server-side: this payee is
      // above the minimum and eligible, so nothing blocks it tonight.
      belowMinimum: false,
      ineligibleReason: null,
      identityResolved: true,
    });
    expect(result.payoutMinimumCents).toBe(1_000);
    expect(result.minimumResolved).toBe(true);
    expect(result.payableTotals).toEqual([
      { currency: "usd", payableCents: 12_000, cellCount: 1 },
    ]);
    expect(result.liabilityTotals).toEqual([
      {
        currency: "usd",
        unpaidCreditsCents: 90_000,
        reserveHeldCents: 5_000,
        pendingHoldCents: 2_500,
        totalOwedCents: 97_500,
      },
    ]);
    expect(result.truncated).toBe(false);
  });

  it("refuses unknown input keys (strict schema survives the omit)", async () => {
    const { authz } = authzWith(true);
    const { caller } = createCaller(
      { listPayablePositions: platformRouter.listPayablePositions },
      { actorHumanId: ACTOR_ID, authz, repos: makePayableRepos() },
    );
    const err = await caller.listPayablePositions({ cursor: "x" } as never).then(
      () => null,
      (e: unknown) => e as { code?: string; message?: string },
    );
    expect(err?.code).toBe("BAD_REQUEST");
    expect(err?.message).toContain("cursor");
  });
});

describe("platform.listPayoutHistory", () => {
  it("rejects an unauthenticated caller", async () => {
    const { caller } = createCaller(
      { listPayoutHistory: platformRouter.listPayoutHistory },
      { actorHumanId: null, repos: makeHistoryRepos() },
    );
    await expect(caller.listPayoutHistory({})).rejects.toThrow(/unauthorized/i);
  });

  it("rejects a non-staff caller via the use case's STAFF_ONLY gate without reading payouts", async () => {
    const repos = makeHistoryRepos();
    const { authz, hasStaffRole } = authzWith(false);
    const { caller } = createCaller(
      { listPayoutHistory: platformRouter.listPayoutHistory },
      { actorHumanId: ACTOR_ID, authz, repos },
    );

    await expect(caller.listPayoutHistory({})).rejects.toThrow(
      /forbidden|staff/i,
    );
    expect(hasStaffRole).toHaveBeenCalledWith({
      actorHumanId: ACTOR_ID,
      requiredRoles: ["ADMIN", "SUPPORT"],
    });
    expect(repos.payoutItems.listHistory).not.toHaveBeenCalled();
  });

  it("passes the status filter, cursor and limit through and returns the enriched page", async () => {
    const repos = makeHistoryRepos();
    const { authz } = authzWith(true);
    const { caller } = createCaller(
      { listPayoutHistory: platformRouter.listPayoutHistory },
      { actorHumanId: ACTOR_ID, authz, repos },
    );

    const result = await caller.listPayoutHistory({
      status: "transferred",
      cursor: "abc",
      limit: 10,
    });

    expect(repos.payoutItems.listHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "transferred",
        cursor: "abc",
        limit: 10,
      }),
    );
    expect(result.total).toBe(1);
    expect(result.items[0]).toMatchObject({
      id: "item-1",
      ownerLabel: "DRKMTTR",
      ownerSlug: "drkmttr",
      amountCents: 50_000,
      netCents: 49_050,
      status: "transferred",
      stripeTransferId: "tr_123",
    });
  });

  it("refuses unknown input keys (strict schema survives the omit)", async () => {
    const { authz } = authzWith(true);
    const { caller } = createCaller(
      { listPayoutHistory: platformRouter.listPayoutHistory },
      { actorHumanId: ACTOR_ID, authz, repos: makeHistoryRepos() },
    );
    const err = await caller.listPayoutHistory({ direction: "forward" }).then(
      () => null,
      (e: unknown) => e as { code?: string; message?: string },
    );
    expect(err?.code).toBe("BAD_REQUEST");
    expect(err?.message).toContain("direction");
  });

  it("refuses a status outside the filter set", async () => {
    const { authz } = authzWith(true);
    const { caller } = createCaller(
      { listPayoutHistory: platformRouter.listPayoutHistory },
      { actorHumanId: ACTOR_ID, authz, repos: makeHistoryRepos() },
    );
    await expect(
      caller.listPayoutHistory({ status: "canceled" as never }),
    ).rejects.toThrow(/BAD_REQUEST|invalid|expected/i);
  });
});
