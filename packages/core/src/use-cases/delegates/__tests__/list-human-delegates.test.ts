import { describe, it, expect, vi } from "vitest";
import { listHumanDelegates } from "../list-human-delegates";

const principalId = "a1111111-1111-4111-a111-111111111111";
const delegateId = "b2222222-2222-4222-b222-222222222222";

function makeDeps(overrides?: { items?: unknown[]; total?: number }) {
  return {
    repos: {
      humanDelegates: {
        listDelegates: vi.fn(async () => ({
          items: overrides?.items ?? [
            {
              humanId: delegateId,
              name: "Jane Helper",
              email: "jane@example.com",
              role: "EDITOR",
              joinedAt: new Date("2025-06-01"),
            },
          ],
          total: overrides?.total ?? 1,
        })),
        addDelegate: vi.fn(),
        getDelegation: vi.fn(),
        removeDelegate: vi.fn(),
        countDelegatesByRole: vi.fn(),
      },
    },
    logger: undefined,
  };
}

describe("listHumanDelegates", () => {
  it("returns paginated delegate list for the principal", async () => {
    const deps = makeDeps();
    const result = await listHumanDelegates(deps, {
      actorHumanId: principalId,
      principalId,
      limit: 50,
      offset: 0,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].humanId).toBe(delegateId);
    expect(result.items[0].role).toBe("EDITOR");
    expect(result.total).toBe(1);
    expect(deps.repos.humanDelegates.listDelegates).toHaveBeenCalledWith({
      principalId,
      limit: 50,
      offset: 0,
    });
  });

  it("uses default limit/offset", async () => {
    const deps = makeDeps();
    await listHumanDelegates(deps, {
      actorHumanId: principalId,
      principalId,
    });

    expect(deps.repos.humanDelegates.listDelegates).toHaveBeenCalledWith({
      principalId,
      limit: 50,
      offset: 0,
    });
  });

  it("throws forbidden when actor is not the principal", async () => {
    const deps = makeDeps();
    await expect(
      listHumanDelegates(deps, {
        actorHumanId: delegateId,
        principalId,
        limit: 50,
        offset: 0,
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("throws invalid_input on bad input", async () => {
    const deps = makeDeps();
    await expect(
      listHumanDelegates(deps, { actorHumanId: "not-uuid", principalId }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
