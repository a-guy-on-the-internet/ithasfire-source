import { describe, it, expect, vi } from "vitest";
import { updateHumanDelegateRole } from "../update-human-delegate-role";

const principalId = "a1111111-1111-4111-a111-111111111111";
const delegateId = "b2222222-2222-4222-b222-222222222222";

function makeDeps(overrides?: { existingRole?: string | null }) {
  const role =
    "existingRole" in (overrides ?? {}) ? overrides!.existingRole : "EDITOR";
  const txRepos = {
    humanDelegates: {
      getDelegation: vi.fn(async () =>
        role !== null
          ? { id: "hd-1", principalId, delegateId, role, createdAt: new Date() }
          : null,
      ),
      addDelegate: vi.fn(async () => ({
        id: "hd-1",
        principalId,
        delegateId,
        role: "ADMIN",
        createdAt: new Date(),
      })),
      removeDelegate: vi.fn(),
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

describe("updateHumanDelegateRole", () => {
  it("updates a delegate role and returns changed=true", async () => {
    const deps = makeDeps({ existingRole: "EDITOR" });
    const result = await updateHumanDelegateRole(deps, {
      actorHumanId: principalId,
      principalId,
      targetHumanId: delegateId,
      newRole: "ADMIN",
    });

    expect(result).toEqual({ ok: true, changed: true });
    expect(deps.repos.tx).toHaveBeenCalled();
  });

  it("no-ops when role is already the same", async () => {
    const deps = makeDeps({ existingRole: "ADMIN" });
    const result = await updateHumanDelegateRole(deps, {
      actorHumanId: principalId,
      principalId,
      targetHumanId: delegateId,
      newRole: "ADMIN",
    });

    expect(result).toEqual({ ok: true, changed: false });
  });

  it("throws forbidden when actor is not the principal", async () => {
    const deps = makeDeps();
    await expect(
      updateHumanDelegateRole(deps, {
        actorHumanId: delegateId,
        principalId,
        targetHumanId: delegateId,
        newRole: "ADMIN",
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("throws not_found when delegation does not exist", async () => {
    const deps = makeDeps({ existingRole: null });
    await expect(
      updateHumanDelegateRole(deps, {
        actorHumanId: principalId,
        principalId,
        targetHumanId: delegateId,
        newRole: "ADMIN",
      }),
    ).rejects.toMatchObject({ code: "DELEGATION_NOT_FOUND" });
  });

  it("rejects OWNER role at the schema level", async () => {
    const deps = makeDeps();
    await expect(
      updateHumanDelegateRole(deps, {
        actorHumanId: principalId,
        principalId,
        targetHumanId: delegateId,
        newRole: "OWNER",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
