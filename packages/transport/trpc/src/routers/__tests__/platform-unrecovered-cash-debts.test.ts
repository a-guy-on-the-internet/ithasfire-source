import { describe, expect, it, vi } from "vitest";

import { createCaller } from "./test-helpers";
import { platformRouter } from "../platform";

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const PAYEE_ID = "22222222-2222-4222-8222-222222222222";
const ORG_ID = "33333333-3333-4333-8333-333333333333";

const procedures = {
  listUnrecoveredCashDebts: platformRouter.listUnrecoveredCashDebts,
};

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
      listUnrecoveredCashDebts: vi.fn(async () => ({
        items: [
          {
            payeeId: PAYEE_ID,
            subjectType: "ORGANIZATION",
            subjectId: ORG_ID,
            orgName: "Cash Only Collective",
            orgSlug: "cash-only-collective",
            currency: "usd",
            unrecoveredCashDebtCents: 1_450,
            overdueCashDebtCents: 950,
            oldestUnrecoveredAt: new Date("2023-11-15T00:00:00.000Z"),
            hasStripeAccount: false,
            payoutsEnabled: false,
            payableCents: -1_450,
          },
        ],
        pageInfo: {
          cursorField: "overdueCashDebtCents,payeeId,currency",
          nextCursor: null,
          limit: 25,
          hasNextPage: false,
        },
        total: 1,
      })),
    },
  } as any;
}

describe("platform.listUnrecoveredCashDebts", () => {
  it("rejects an unauthenticated caller", async () => {
    const repos = makeRepos();
    const { caller } = createCaller(procedures, { actorHumanId: null, repos });
    await expect(caller.listUnrecoveredCashDebts()).rejects.toThrow(
      /unauthorized/i,
    );
    expect(repos.payeeLedger.listUnrecoveredCashDebts).not.toHaveBeenCalled();
  });

  it("rejects a non-staff caller via the use case's STAFF_ONLY gate without reading the ledger", async () => {
    const repos = makeRepos();
    const { authz, hasStaffRole } = authzWith(false);
    const { caller } = createCaller(procedures, {
      actorHumanId: ACTOR_ID,
      authz,
      repos,
    });

    const err = await caller.listUnrecoveredCashDebts().then(
      () => null,
      (e: unknown) => e as { code?: string },
    );
    expect(err?.code).toBe("FORBIDDEN");
    expect(hasStaffRole).toHaveBeenCalledWith({
      actorHumanId: ACTOR_ID,
      requiredRoles: ["ADMIN", "SUPPORT"],
    });
    expect(repos.payeeLedger.listUnrecoveredCashDebts).not.toHaveBeenCalled();
  });

  it("returns the page for staff, with or without arguments, and passes cursor + limit through", async () => {
    const repos = makeRepos();
    const { authz } = authzWith(true);
    const { caller } = createCaller(procedures, {
      actorHumanId: ACTOR_ID,
      authz,
      repos,
    });

    const bare = await caller.listUnrecoveredCashDebts();
    expect(bare.total).toBe(1);
    expect(bare.items[0]).toMatchObject({
      payeeId: PAYEE_ID,
      orgName: "Cash Only Collective",
      overdueCashDebtCents: 950,
      hasStripeAccount: false,
    });
    // The test-helper clock reads 2024-01-01; the cutoff is 30 days before.
    expect(bare.overdueBefore).toEqual(new Date("2023-12-02T00:00:00.000Z"));

    await caller.listUnrecoveredCashDebts({ cursor: "abc", limit: 10 });
    expect(repos.payeeLedger.listUnrecoveredCashDebts).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: "abc", limit: 10 }),
    );
  });

  it("refuses unknown input keys (strict schema survives the omit)", async () => {
    const { authz } = authzWith(true);
    const { caller } = createCaller(procedures, {
      actorHumanId: ACTOR_ID,
      authz,
      repos: makeRepos(),
    });
    const err = await caller
      .listUnrecoveredCashDebts({ olderThanDays: 1 } as never)
      .then(
        () => null,
        (e: unknown) => e as { code?: string; message?: string },
      );
    expect(err?.code).toBe("BAD_REQUEST");
    expect(err?.message).toContain("olderThanDays");
  });
});
