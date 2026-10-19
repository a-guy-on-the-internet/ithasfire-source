import { describe, expect, it, vi } from "vitest";

import { adminGrantHumanRole } from "../admin-grant-human-role";
import type { AdminGrantHumanRoleDeps } from "../admin-grant-human-role";
import { ACTOR_ID, NOW, TARGET_ID, makeClock, makeStaffAuthz } from "./_fixtures";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function buildDeps(
  overrides: {
    rolesByHuman?: Record<string, string[]>;
    targetExists?: boolean;
    grantResult?: { granted: boolean };
    /** The target's AuthUser; null = a human with no AuthUser. */
    authUserId?: string | null;
    sessionCount?: number;
  } = {},
) {
  const getById = vi.fn(async () =>
    (overrides.targetExists ?? true) ? { id: TARGET_ID } : null,
  );
  const grantHumanRole = vi.fn(
    async () => overrides.grantResult ?? { granted: true },
  );
  const audit = { log: vi.fn() };
  const authUserId =
    overrides.authUserId === undefined ? "auth-target" : overrides.authUserId;
  const getByIdWithIdentity = vi.fn(async () => ({
    human: { id: TARGET_ID },
    identity: authUserId ? { authUserId } : undefined,
  }));
  const invalidateSessionsForAuthUsers = vi.fn(async () => ({
    count: overrides.sessionCount ?? 2,
  }));

  const txRepos = {
    humans: { getById, getByIdWithIdentity, invalidateSessionsForAuthUsers },
    authz: { grantHumanRole },
    audit,
  };

  const deps: AdminGrantHumanRoleDeps = {
    repos: {
      tx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(txRepos)),
    } as unknown as AdminGrantHumanRoleDeps["repos"],
    authz: makeStaffAuthz(overrides.rolesByHuman ?? { [ACTOR_ID]: ["ADMIN"] }),
    clock: makeClock(),
  };

  return {
    deps,
    mocks: {
      getById,
      grantHumanRole,
      audit,
      getByIdWithIdentity,
      invalidateSessionsForAuthUsers,
    },
  };
}

const INPUT = {
  actorHumanId: ACTOR_ID,
  targetHumanId: TARGET_ID,
  role: "SUPPORT" as const,
};

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("adminGrantHumanRole", () => {
  it("grants the role and audits the decision", async () => {
    const { deps, mocks } = buildDeps();

    const result = await adminGrantHumanRole(deps, INPUT);

    expect(result).toEqual({
      targetHumanId: TARGET_ID,
      role: "SUPPORT",
      granted: true,
      sessionsInvalidated: 2,
    });
    expect(mocks.grantHumanRole).toHaveBeenCalledWith({
      humanId: TARGET_ID,
      role: "SUPPORT",
    });
    expect(mocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "human_role",
        entityId: TARGET_ID,
        action: "role.granted",
        data: {
          actorHumanId: ACTOR_ID,
          targetHumanId: TARGET_ID,
          role: "SUPPORT",
          granted: true,
          sessionsInvalidated: 2,
        },
        at: NOW,
      }),
    );
  });

  it("rejects a non-ADMIN actor with STAFF_ONLY", async () => {
    const { deps, mocks } = buildDeps({
      rolesByHuman: { [ACTOR_ID]: ["REVIEWER"] },
    });

    await expect(adminGrantHumanRole(deps, INPUT)).rejects.toMatchObject({
      code: "STAFF_ONLY",
    });
    expect(mocks.grantHumanRole).not.toHaveBeenCalled();
    expect(mocks.audit.log).not.toHaveBeenCalled();
  });

  it("reports HUMAN_NOT_FOUND when the target does not exist", async () => {
    const { deps, mocks } = buildDeps({ targetExists: false });

    await expect(adminGrantHumanRole(deps, INPUT)).rejects.toMatchObject({
      code: "HUMAN_NOT_FOUND",
    });
    expect(mocks.grantHumanRole).not.toHaveBeenCalled();
  });

  it("is idempotent: granting an already-held role reports granted:false without erroring", async () => {
    const { deps, mocks } = buildDeps({ grantResult: { granted: false } });

    const result = await adminGrantHumanRole(deps, INPUT);

    expect(result.granted).toBe(false);
    expect(mocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ granted: false }),
      }),
    );
  });

  it.each(["ADMIN", "REVIEWER", "SUPPORT", "DEVELOPER", "COMMUNITY_MODERATOR"] as const)(
    "a new %s grant signs the target out everywhere, in the grant's transaction",
    async (role) => {
      const { deps, mocks } = buildDeps({ sessionCount: 3 });

      const result = await adminGrantHumanRole(deps, { ...INPUT, role });

      expect(result.sessionsInvalidated).toBe(3);
      expect(mocks.getByIdWithIdentity).toHaveBeenCalledWith(TARGET_ID);
      expect(mocks.invalidateSessionsForAuthUsers).toHaveBeenCalledWith([
        "auth-target",
      ]);
      expect(deps.repos.tx).toHaveBeenCalledTimes(1);
      expect(mocks.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "role.granted",
          data: expect.objectContaining({ role, sessionsInvalidated: 3 }),
        }),
      );
    },
  );

  it("an already-held staff role signs nobody out", async () => {
    const { deps, mocks } = buildDeps({ grantResult: { granted: false } });

    const result = await adminGrantHumanRole(deps, INPUT);

    expect(result.sessionsInvalidated).toBe(0);
    expect(mocks.invalidateSessionsForAuthUsers).not.toHaveBeenCalled();
  });

  it("a USER grant signs nobody out (USER is no staff grant)", async () => {
    const { deps, mocks } = buildDeps();

    const result = await adminGrantHumanRole(deps, { ...INPUT, role: "USER" });

    expect(result.sessionsInvalidated).toBe(0);
    expect(mocks.invalidateSessionsForAuthUsers).not.toHaveBeenCalled();
  });

  it("a staff grant to a human with no AuthUser has no sessions to end", async () => {
    const { deps, mocks } = buildDeps({ authUserId: null });

    const result = await adminGrantHumanRole(deps, INPUT);

    expect(result.sessionsInvalidated).toBe(0);
    expect(mocks.invalidateSessionsForAuthUsers).not.toHaveBeenCalled();
    expect(mocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ sessionsInvalidated: 0 }),
      }),
    );
  });

  it("a failed sign-out fails the grant (one transaction: the role does not land without it)", async () => {
    const { deps, mocks } = buildDeps();
    mocks.invalidateSessionsForAuthUsers.mockRejectedValue(new Error("db down"));

    await expect(adminGrantHumanRole(deps, INPUT)).rejects.toThrow("db down");
    expect(mocks.audit.log).not.toHaveBeenCalled();
  });

  it("rejects invalid input (bad role value)", async () => {
    const { deps } = buildDeps();

    await expect(
      adminGrantHumanRole(deps, { ...INPUT, role: "NOT_A_ROLE" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
