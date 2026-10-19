import { describe, expect, it, vi } from "vitest";

import { createCaller } from "./test-helpers";
import { platformRouter } from "../platform";

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const PAYEE_ID = "22222222-2222-4222-8222-222222222222";
const ORG_ID = "33333333-3333-4333-8333-333333333333";

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

function makeRepos() {
  return {
    payeeLedger: {
      listDebtPositions: vi.fn(async () => ({
        items: [
          {
            payeeId: PAYEE_ID,
            subjectType: "ORGANIZATION",
            subjectId: ORG_ID,
            currency: "usd",
            payableCents: -12_000,
            debtSinceAt: new Date("2026-08-01T00:00:00.000Z"),
            lastDebitType: "DISPUTE_DEBIT",
            lastDebitAt: new Date("2026-08-01T00:00:00.000Z"),
            disputeDebitCents: 12_000,
            refundDebitCents: 0,
          },
        ],
        pageInfo: {
          cursorField: "payableCents,payeeId,currency",
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
    events: { getUpcomingStatsForOwners: vi.fn(async () => []) },
    disputes: { countOpenByOwners: vi.fn(async () => []) },
  } as any;
}

describe("platform.listPayeeDebtPositions", () => {
  it("rejects an unauthenticated caller", async () => {
    const { caller } = createCaller(
      { listPayeeDebtPositions: platformRouter.listPayeeDebtPositions },
      { actorHumanId: null, repos: makeRepos() },
    );
    await expect(caller.listPayeeDebtPositions({})).rejects.toThrow(
      /unauthorized/i,
    );
  });

  it("rejects a non-staff caller via the use case's STAFF_ONLY gate without reading the ledger", async () => {
    const repos = makeRepos();
    const { authz, hasStaffRole } = authzWith(false);
    const { caller } = createCaller(
      { listPayeeDebtPositions: platformRouter.listPayeeDebtPositions },
      { actorHumanId: ACTOR_ID, authz, repos },
    );

    await expect(caller.listPayeeDebtPositions({})).rejects.toThrow(
      /forbidden|staff/i,
    );
    expect(hasStaffRole).toHaveBeenCalledWith({
      actorHumanId: ACTOR_ID,
      requiredRoles: ["ADMIN", "SUPPORT"],
    });
    expect(repos.payeeLedger.listDebtPositions).not.toHaveBeenCalled();
  });

  it("returns the enriched page for staff and passes the cursor + limit through", async () => {
    const repos = makeRepos();
    const { authz } = authzWith(true);
    const { caller } = createCaller(
      { listPayeeDebtPositions: platformRouter.listPayeeDebtPositions },
      { actorHumanId: ACTOR_ID, authz, repos },
    );

    const result = await caller.listPayeeDebtPositions({
      cursor: "abc",
      limit: 10,
    });

    expect(repos.payeeLedger.listDebtPositions).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: "abc", limit: 10 }),
    );
    expect(result.total).toBe(1);
    expect(result.items[0]).toMatchObject({
      payeeId: PAYEE_ID,
      ownerLabel: "DRKMTTR",
      ownerSlug: "drkmttr",
      payableCents: -12_000,
      upcomingEventCount: 0,
      openDisputeCount: 0,
    });
  });

  it("refuses unknown input keys (strict schema survives the omit)", async () => {
    const { authz } = authzWith(true);
    const { caller } = createCaller(
      { listPayeeDebtPositions: platformRouter.listPayeeDebtPositions },
      { actorHumanId: ACTOR_ID, authz, repos: makeRepos() },
    );
    const err = await caller
      .listPayeeDebtPositions({ direction: "forward" })
      .then(
        () => null,
        (e: unknown) => e as { code?: string; message?: string },
      );
    expect(err?.code).toBe("BAD_REQUEST");
    expect(err?.message).toContain("direction");
  });
});
