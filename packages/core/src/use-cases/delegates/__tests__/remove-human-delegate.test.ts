import { describe, it, expect, vi } from "vitest";
import { removeHumanDelegate } from "../remove-human-delegate";

const principalId = "a1111111-1111-4111-a111-111111111111";
const delegateId = "b2222222-2222-4222-b222-222222222222";

function makeDeps(overrides?: { delegationExists?: boolean }) {
  const exists = overrides?.delegationExists ?? true;
  const txRepos = {
    humanDelegates: {
      getDelegation: vi.fn(async () =>
        exists
          ? {
              id: "hd-1",
              principalId,
              delegateId,
              role: "EDITOR",
              createdAt: new Date(),
            }
          : null,
      ),
      removeDelegate: vi.fn(async () => true),
      addDelegate: vi.fn(),
      listDelegates: vi.fn(),
      countDelegatesByRole: vi.fn(),
    },
    audit: {
      log: vi.fn(async () => {}),
    },
  };

  return {
    repos: {
      ...txRepos,
      tx: vi.fn(async (fn: (tx: typeof txRepos) => Promise<unknown>) =>
        fn(txRepos),
      ),
    },
    authn: {
      ensureAuthedHuman: vi.fn(async () => ({ providerUserId: principalId })),
    },
    clock: { now: () => new Date("2025-06-01") },
    logger: undefined,
  };
}

describe("removeHumanDelegate", () => {
  it("removes a delegate and returns ok", async () => {
    const deps = makeDeps();
    const result = await removeHumanDelegate(deps, {
      actorHumanId: principalId,
      principalId,
      targetHumanId: delegateId,
    });

    expect(result).toEqual({ ok: true });
    expect(deps.repos.tx).toHaveBeenCalled();
  });

  it("throws forbidden when actor is not the principal", async () => {
    const deps = makeDeps();
    await expect(
      removeHumanDelegate(deps, {
        actorHumanId: delegateId,
        principalId,
        targetHumanId: delegateId,
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("throws not_found when delegation does not exist", async () => {
    const deps = makeDeps({ delegationExists: false });
    await expect(
      removeHumanDelegate(deps, {
        actorHumanId: principalId,
        principalId,
        targetHumanId: delegateId,
      }),
    ).rejects.toMatchObject({ code: "DELEGATION_NOT_FOUND" });
  });

  it("logs an audit event with the previous role", async () => {
    const deps = makeDeps();
    await removeHumanDelegate(deps, {
      actorHumanId: principalId,
      principalId,
      targetHumanId: delegateId,
    });

    const auditCall = (
      deps.repos as unknown as { audit: { log: ReturnType<typeof vi.fn> } }
    ).audit.log.mock.calls[0][0];
    expect(auditCall.action).toBe("human.delegate_removed");
    expect(auditCall.data.previousRole).toBe("EDITOR");
  });
});
