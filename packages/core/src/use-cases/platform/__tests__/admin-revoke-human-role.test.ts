import { describe, expect, it, vi } from "vitest";

import { adminRevokeHumanRole } from "../admin-revoke-human-role";
import type { AdminRevokeHumanRoleDeps } from "../admin-revoke-human-role";
import { ACTOR_ID, NOW, TARGET_ID, makeClock, makeStaffAuthz } from "./_fixtures";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function buildDeps(
  overrides: {
    rolesByHuman?: Record<string, string[]>;
    targetExists?: boolean;
    revokeResult?: { revoked: boolean };
    adminHumanIds?: string[];
  } = {},
) {
  const getById = vi.fn(async () =>
    (overrides.targetExists ?? true) ? { id: TARGET_ID } : null,
  );
  const revokeHumanRole = vi.fn(
    async () => overrides.revokeResult ?? { revoked: true },
  );
  const listHumanIdsByStaffRole = vi.fn(
    async () => overrides.adminHumanIds ?? [ACTOR_ID, TARGET_ID],
  );
  const lockAdminRoleGuard = vi.fn(async () => undefined);
  const audit = { log: vi.fn() };

  const txRepos = {
    humans: { getById },
    authz: { revokeHumanRole, listHumanIdsByStaffRole, lockAdminRoleGuard },
    audit,
  };

  const deps: AdminRevokeHumanRoleDeps = {
    repos: {
      tx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(txRepos)),
    } as unknown as AdminRevokeHumanRoleDeps["repos"],
    authz: makeStaffAuthz(overrides.rolesByHuman ?? { [ACTOR_ID]: ["ADMIN"] }),
    clock: makeClock(),
  };

  return {
    deps,
    mocks: {
      getById,
      revokeHumanRole,
      listHumanIdsByStaffRole,
      lockAdminRoleGuard,
      audit,
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

describe("adminRevokeHumanRole", () => {
  it("revokes the role and audits the decision", async () => {
    const { deps, mocks } = buildDeps();

    const result = await adminRevokeHumanRole(deps, INPUT);

    expect(result).toEqual({
      targetHumanId: TARGET_ID,
      role: "SUPPORT",
      revoked: true,
    });
    expect(mocks.revokeHumanRole).toHaveBeenCalledWith({
      humanId: TARGET_ID,
      role: "SUPPORT",
    });
    expect(mocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "human_role",
        entityId: TARGET_ID,
        action: "role.revoked",
        data: {
          actorHumanId: ACTOR_ID,
          targetHumanId: TARGET_ID,
          role: "SUPPORT",
          revoked: true,
        },
        at: NOW,
      }),
    );
  });

  it("rejects a non-ADMIN actor with STAFF_ONLY", async () => {
    const { deps, mocks } = buildDeps({
      rolesByHuman: { [ACTOR_ID]: ["SUPPORT"] },
    });

    await expect(adminRevokeHumanRole(deps, INPUT)).rejects.toMatchObject({
      code: "STAFF_ONLY",
    });
    expect(mocks.revokeHumanRole).not.toHaveBeenCalled();
    expect(mocks.audit.log).not.toHaveBeenCalled();
  });

  it("reports HUMAN_NOT_FOUND when the target does not exist", async () => {
    const { deps, mocks } = buildDeps({ targetExists: false });

    await expect(adminRevokeHumanRole(deps, INPUT)).rejects.toMatchObject({
      code: "HUMAN_NOT_FOUND",
    });
    expect(mocks.revokeHumanRole).not.toHaveBeenCalled();
  });

  it("is idempotent: revoking a role not held reports revoked:false without erroring", async () => {
    const { deps, mocks } = buildDeps({ revokeResult: { revoked: false } });

    const result = await adminRevokeHumanRole(deps, INPUT);

    expect(result.revoked).toBe(false);
    expect(mocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ revoked: false }),
      }),
    );
  });

  it("rejects invalid input (bad role value)", async () => {
    const { deps } = buildDeps();

    await expect(
      adminRevokeHumanRole(deps, { ...INPUT, role: "NOT_A_ROLE" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  describe("last-ADMIN lockout guard", () => {
    it("rejects revoking ADMIN from the sole remaining ADMIN", async () => {
      const { deps, mocks } = buildDeps({
        adminHumanIds: [TARGET_ID],
      });

      await expect(
        adminRevokeHumanRole(deps, { ...INPUT, role: "ADMIN" }),
      ).rejects.toMatchObject({ code: "CANNOT_DEMOTE_LAST_OWNER" });
      expect(mocks.revokeHumanRole).not.toHaveBeenCalled();
      expect(mocks.audit.log).not.toHaveBeenCalled();
    });

    it("rejects revoking ADMIN from the last admin even when the actor is a different human", async () => {
      // Actor holds ADMIN (passes RBAC) but is revoking someone else's role;
      // the guard is a count-based "last ADMIN" check, not a self-action check.
      const { deps, mocks } = buildDeps({
        rolesByHuman: { [ACTOR_ID]: ["ADMIN"] },
        adminHumanIds: [TARGET_ID],
      });

      await expect(
        adminRevokeHumanRole(deps, { ...INPUT, role: "ADMIN" }),
      ).rejects.toMatchObject({ code: "CANNOT_DEMOTE_LAST_OWNER" });
      expect(mocks.revokeHumanRole).not.toHaveBeenCalled();
    });

    it("allows revoking ADMIN from one of several ADMINs", async () => {
      const { deps, mocks } = buildDeps({
        adminHumanIds: [ACTOR_ID, TARGET_ID, "33333333-3333-4333-8333-333333333333"],
      });

      const result = await adminRevokeHumanRole(deps, {
        ...INPUT,
        role: "ADMIN",
      });

      expect(result.revoked).toBe(true);
      expect(mocks.revokeHumanRole).toHaveBeenCalledWith({
        humanId: TARGET_ID,
        role: "ADMIN",
      });
    });

    it("does not consult the ADMIN-count guard when revoking a non-ADMIN role", async () => {
      // Even if the target were (hypothetically) the "last ADMIN", revoking a
      // different role must not be blocked by this guard.
      const { deps, mocks } = buildDeps({
        adminHumanIds: [TARGET_ID],
      });

      const result = await adminRevokeHumanRole(deps, INPUT); // role: "SUPPORT"

      expect(result.revoked).toBe(true);
      expect(mocks.listHumanIdsByStaffRole).not.toHaveBeenCalled();
      // The advisory lock exists solely to protect the ADMIN-count guard —
      // a non-ADMIN revoke never consults that guard, so it must not pay
      // the lock-acquisition round trip either.
      expect(mocks.lockAdminRoleGuard).not.toHaveBeenCalled();
      expect(mocks.revokeHumanRole).toHaveBeenCalledWith({
        humanId: TARGET_ID,
        role: "SUPPORT",
      });
    });

    it("acquires the advisory lock before reading the ADMIN count (closes the concurrent-different-target revoke race)", async () => {
      // Regression test for the round-2 BLOCKING finding: two concurrent
      // revokes against two DIFFERENT sole-remaining ADMINs could each read
      // "2 ADMINs left" before the other committed, since they write to two
      // different `Human` rows and no row lock serializes them. The fix
      // takes a fixed-key Postgres advisory lock BEFORE the count-read so
      // concurrent callers queue behind the SAME lock regardless of target.
      // A real concurrent-timing assertion needs a live Postgres connection
      // (covered by the adapters integration test); at the unit level we
      // assert the mechanism is wired correctly: the lock call happens, and
      // it happens strictly before the count-read within the same
      // transaction, every time an ADMIN revoke reaches the guard.
      const { deps, mocks } = buildDeps({
        adminHumanIds: [ACTOR_ID, TARGET_ID],
      });

      await adminRevokeHumanRole(deps, { ...INPUT, role: "ADMIN" });

      expect(mocks.lockAdminRoleGuard).toHaveBeenCalledTimes(1);
      expect(mocks.listHumanIdsByStaffRole).toHaveBeenCalledTimes(1);
      const lockOrder = mocks.lockAdminRoleGuard.mock.invocationCallOrder[0]!;
      const countOrder =
        mocks.listHumanIdsByStaffRole.mock.invocationCallOrder[0]!;
      expect(lockOrder).toBeLessThan(countOrder);
    });

    it("acquires the advisory lock even on the rejecting (last-ADMIN) path, before the guard throws", async () => {
      // The lock must be taken unconditionally ahead of the count-read, not
      // only on the "allowed" path — otherwise a rejecting caller wouldn't
      // have serialized against a concurrent caller that's mid count-read.
      const { deps, mocks } = buildDeps({
        adminHumanIds: [TARGET_ID],
      });

      await expect(
        adminRevokeHumanRole(deps, { ...INPUT, role: "ADMIN" }),
      ).rejects.toMatchObject({ code: "CANNOT_DEMOTE_LAST_OWNER" });

      expect(mocks.lockAdminRoleGuard).toHaveBeenCalledTimes(1);
    });

    it("allows revoking ADMIN from a target who is not currently an ADMIN (idempotent no-op)", async () => {
      const { deps, mocks } = buildDeps({
        adminHumanIds: [ACTOR_ID],
        revokeResult: { revoked: false },
      });

      const result = await adminRevokeHumanRole(deps, {
        ...INPUT,
        role: "ADMIN",
      });

      expect(result.revoked).toBe(false);
      expect(mocks.revokeHumanRole).toHaveBeenCalled();
    });
  });
});
