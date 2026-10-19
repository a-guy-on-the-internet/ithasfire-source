import { describe, expect, it, vi } from "vitest";

import { listOrgOrders } from "../list-org-orders";

function makeDeps() {
  const deps = {
    repos: {
      orders: {
        listForOrg: vi.fn(async () => ({ items: [], total: 0 })),
      },
    },
    authz: {
      canFinanceOrg: vi.fn(async () => ({ allowed: true })),
    },
  } as any;

  return deps;
}

describe("listOrgOrders", () => {
  it("rejects when not allowed to finance org", async () => {
    const deps = makeDeps();
    deps.authz.canFinanceOrg.mockResolvedValueOnce({ allowed: false });

    await expect(
      listOrgOrders(deps, {
        actorHumanId: "11111111-1111-4111-8111-111111111111",
        orgId: "22222222-2222-4222-8222-222222222222",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(deps.repos.orders.listForOrg).not.toHaveBeenCalled();
  });

  it("passes pagination to repo", async () => {
    const deps = makeDeps();

    await listOrgOrders(deps, {
      actorHumanId: "11111111-1111-4111-8111-111111111111",
      orgId: "22222222-2222-4222-8222-222222222222",
      limit: 10,
      offset: 20,
    });

    expect(deps.repos.orders.listForOrg).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "22222222-2222-4222-8222-222222222222",
        limit: 10,
        offset: 20,
      }),
    );
  });
});

describe("listOrgOrders — DISPUTED filter", () => {
  it("sends the dispute-mirror filter to the repo instead of status = DISPUTED", async () => {
    const deps = makeDeps();

    await listOrgOrders(deps, {
      actorHumanId: "11111111-1111-4111-8111-111111111111",
      orgId: "22222222-2222-4222-8222-222222222222",
      status: "DISPUTED",
    });

    const call = deps.repos.orders.listForOrg.mock.calls[0]![0];
    expect(call.status).toBeUndefined();
    expect(call.disputeStatuses).toEqual(["OPEN", "UNDER_REVIEW", "LOST"]);
  });

  it("keeps a plain status filter as Order.status", async () => {
    const deps = makeDeps();

    await listOrgOrders(deps, {
      actorHumanId: "11111111-1111-4111-8111-111111111111",
      orgId: "22222222-2222-4222-8222-222222222222",
      status: "SUCCEEDED",
    });

    const call = deps.repos.orders.listForOrg.mock.calls[0]![0];
    expect(call.status).toBe("SUCCEEDED");
    expect(call.disputeStatuses).toBeUndefined();
  });
});
