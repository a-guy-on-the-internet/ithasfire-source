import { describe, expect, it, vi } from "vitest";

import type { AuthZPort } from "@th/ports/authz";
import type { Repos, TxRepos } from "@th/ports/repos";

import {
  transferOrgOwnership,
  type TransferOrgOwnershipDeps,
} from "../transfer-ownership";
import { expectOuterHandleUnused, makeOuterHandle } from "./outer-handle";

const ACTOR_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TARGET_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OTHER_ORG_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const NOW = new Date("2025-03-01T00:00:00.000Z");

type Role = "OWNER" | "ADMIN" | "EDITOR" | "VIEWER" | "FINANCE" | "SCANNER";

type Opts = {
  /** The actor's own membership row. Defaults to OWNER. */
  actorRole?: Role | null;
  /** The target's membership row. Defaults to EDITOR; null = not a member. */
  targetRole?: Role | null;
  authzError?: unknown;
  /** What the repo revokes when asked for the actor's OWNER invitations. */
  pendingOwnerInvitations?: Array<{ id: string; email: string }>;
};

function makeDeps(options: Opts = {}) {
  const actorRole = "actorRole" in options ? options.actorRole : "OWNER";
  const targetRole = "targetRole" in options ? options.targetRole : "EDITOR";

  // These mocks are the transaction's handle only: `repos.tx` passes them to
  // its callback and nothing else reaches them.
  const organizationsRepo = {
    lockOwnerRoster: vi.fn(async () => {}),
    addMember: vi.fn(async () => ({ created: false, previousRole: null })),
    revokePendingOwnerInvitationsByInviter: vi.fn(
      async () => options.pendingOwnerInvitations ?? [],
    ),
    countMembersByRole: vi.fn(),
    removeMember: vi.fn(),
  };

  const auditRepo = { log: vi.fn(async () => {}) };

  const authzRepo = {
    getOrgMembership: vi.fn(
      async (input: { orgId: string; humanId: string }) => {
        if (input.orgId !== ORG_ID) return null;
        const role =
          input.humanId === ACTOR_ID
            ? actorRole
            : input.humanId === TARGET_ID
              ? targetRole
              : null;
        return role ? { orgId: ORG_ID, humanId: input.humanId, role } : null;
      },
    ),
  };

  const txSide = {
    organizations: organizationsRepo,
    audit: auditRepo,
    authz: authzRepo,
  };

  // The use case reads and writes nothing outside its transaction.
  const outer = makeOuterHandle(txSide);

  const repos = {
    ...outer,
    tx: async <T>(fn: (tx: TxRepos) => Promise<T>) =>
      fn(txSide as unknown as TxRepos),
  } as unknown as Repos;

  const authz: AuthZPort = {
    hasOrgRole: vi.fn(),
    requireOrgRole: options.authzError
      ? vi.fn(async () => {
          throw options.authzError;
        })
      : vi.fn(async () => {}),
    canEditEvent: vi.fn(),
    canManagePlace: vi.fn(),
    canFinanceOrg: vi.fn(),
    hasStaffRole: vi.fn(async () => ({ allowed: false })),
  };

  const deps: TransferOrgOwnershipDeps = {
    repos,
    authz,
    clock: { now: () => NOW },
  };

  return { deps, organizationsRepo, auditRepo, authzRepo, authz, outer };
}

const input = {
  actorHumanId: ACTOR_ID,
  orgId: ORG_ID,
  targetHumanId: TARGET_ID,
};

const transferMark = {
  reason: "OWNERSHIP_TRANSFER",
  transferFromHumanId: ACTOR_ID,
  transferToHumanId: TARGET_ID,
};

function expectNoWrites(made: ReturnType<typeof makeDeps>) {
  expectOuterHandleUnused(made.outer);
  expect(made.organizationsRepo.addMember).not.toHaveBeenCalled();
  expect(
    made.organizationsRepo.revokePendingOwnerInvitationsByInviter,
  ).not.toHaveBeenCalled();
  expect(made.organizationsRepo.removeMember).not.toHaveBeenCalled();
  expect(made.auditRepo.log).not.toHaveBeenCalled();
}

describe("transferOrgOwnership", () => {
  it("makes the target OWNER and the actor ADMIN, revokes the actor's OWNER invitations and audits both role changes, all in one transaction after the lock", async () => {
    const made = makeDeps({
      targetRole: "EDITOR",
      pendingOwnerInvitations: [{ id: "inv-1", email: "one@example.com" }],
    });
    const { deps, organizationsRepo, auditRepo, authzRepo, outer } = made;

    await expect(transferOrgOwnership(deps, input)).resolves.toEqual({
      ok: true,
      previousTargetRole: "EDITOR",
    });

    // Both role writes, target first.
    expect(organizationsRepo.addMember).toHaveBeenCalledTimes(2);
    expect(organizationsRepo.addMember).toHaveBeenNthCalledWith(1, {
      orgId: ORG_ID,
      humanId: TARGET_ID,
      role: "OWNER",
      addedAt: NOW,
    });
    expect(organizationsRepo.addMember).toHaveBeenNthCalledWith(2, {
      orgId: ORG_ID,
      humanId: ACTOR_ID,
      role: "ADMIN",
      addedAt: NOW,
    });

    // The actor's pending OWNER invitations go with the role.
    expect(
      organizationsRepo.revokePendingOwnerInvitationsByInviter,
    ).toHaveBeenCalledTimes(1);
    expect(
      organizationsRepo.revokePendingOwnerInvitationsByInviter,
    ).toHaveBeenCalledWith({ orgId: ORG_ID, invitedByHumanId: ACTOR_ID });

    // What two updateMemberRole calls would have written, each marked as one
    // transfer, plus the revoked invitation.
    expect(auditRepo.log).toHaveBeenCalledTimes(3);
    expect(auditRepo.log).toHaveBeenCalledWith({
      entity: "organization",
      entityId: ORG_ID,
      action: "org.member_role_updated",
      data: {
        actorHumanId: ACTOR_ID,
        targetHumanId: TARGET_ID,
        previousRole: "EDITOR",
        newRole: "OWNER",
        ...transferMark,
      },
      at: NOW,
    });
    expect(auditRepo.log).toHaveBeenCalledWith({
      entity: "organization",
      entityId: ORG_ID,
      action: "org.member_role_updated",
      data: {
        actorHumanId: ACTOR_ID,
        targetHumanId: ACTOR_ID,
        previousRole: "OWNER",
        newRole: "ADMIN",
        ...transferMark,
      },
      at: NOW,
    });
    expect(auditRepo.log).toHaveBeenCalledWith({
      entity: "organization",
      entityId: ORG_ID,
      action: "org.invitation_revoked",
      data: {
        actorHumanId: ACTOR_ID,
        invitationId: "inv-1",
        email: "one@example.com",
        invitedByHumanId: ACTOR_ID,
        reason: "INVITER_NO_LONGER_OWNER",
      },
      at: NOW,
    });

    // Every one of them on the transaction's handle: the outer one took no
    // lock and made no read or write.
    expectOuterHandleUnused(outer);
    expect(organizationsRepo.lockOwnerRoster).toHaveBeenCalledTimes(1);

    // And after the lock, which comes before any row is read.
    expect(organizationsRepo.lockOwnerRoster).toHaveBeenCalledWith(ORG_ID);
    const lockedAt =
      organizationsRepo.lockOwnerRoster.mock.invocationCallOrder[0]!;
    expect(authzRepo.getOrgMembership).toHaveBeenCalledTimes(2);
    for (const at of [
      ...authzRepo.getOrgMembership.mock.invocationCallOrder,
      ...organizationsRepo.addMember.mock.invocationCallOrder,
      ...organizationsRepo.revokePendingOwnerInvitationsByInviter.mock
        .invocationCallOrder,
      ...auditRepo.log.mock.invocationCallOrder,
    ]) {
      expect(lockedAt).toBeLessThan(at);
    }
  });

  it("reads the actor's role in the org the request names", async () => {
    const { deps, authzRepo } = makeDeps();

    await transferOrgOwnership(deps, input);

    expect(authzRepo.getOrgMembership).toHaveBeenCalledWith({
      orgId: ORG_ID,
      humanId: ACTOR_ID,
    });
  });

  it.each(["ADMIN", "EDITOR", "VIEWER", "FINANCE", "SCANNER"] as const)(
    "lets an OWNER transfer to a member who is %s",
    async (targetRole) => {
      const { deps, organizationsRepo } = makeDeps({ targetRole });

      await expect(transferOrgOwnership(deps, input)).resolves.toEqual({
        ok: true,
        previousTargetRole: targetRole,
      });
      expect(organizationsRepo.addMember).toHaveBeenCalledWith(
        expect.objectContaining({ humanId: TARGET_ID, role: "OWNER" }),
      );
      expect(organizationsRepo.addMember).toHaveBeenCalledWith(
        expect.objectContaining({ humanId: ACTOR_ID, role: "ADMIN" }),
      );
    },
  );

  it("still demotes the actor when the target is already OWNER, with one role change", async () => {
    const { deps, organizationsRepo, auditRepo } = makeDeps({
      targetRole: "OWNER",
    });

    await expect(transferOrgOwnership(deps, input)).resolves.toEqual({
      ok: true,
      previousTargetRole: "OWNER",
    });

    expect(organizationsRepo.addMember).toHaveBeenCalledTimes(1);
    expect(organizationsRepo.addMember).toHaveBeenCalledWith({
      orgId: ORG_ID,
      humanId: ACTOR_ID,
      role: "ADMIN",
      addedAt: NOW,
    });
    expect(
      organizationsRepo.revokePendingOwnerInvitationsByInviter,
    ).toHaveBeenCalledWith({ orgId: ORG_ID, invitedByHumanId: ACTOR_ID });
    expect(auditRepo.log).toHaveBeenCalledTimes(1);
    expect(auditRepo.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "org.member_role_updated",
        data: expect.objectContaining({
          targetHumanId: ACTOR_ID,
          previousRole: "OWNER",
          newRole: "ADMIN",
          ...transferMark,
        }),
      }),
    );
  });

  it.each(["ADMIN", "EDITOR", "VIEWER", "FINANCE", "SCANNER"] as const)(
    "refuses an actor who is %s, with no write",
    async (actorRole) => {
      const made = makeDeps({ actorRole });

      await expect(
        transferOrgOwnership(made.deps, input),
      ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
      expectNoWrites(made);
    },
  );

  it("refuses an actor with no membership row, with no write", async () => {
    // The port fake lets everyone through, so this is the in-transaction
    // read refusing on its own.
    const made = makeDeps({ actorRole: null });

    await expect(transferOrgOwnership(made.deps, input)).rejects.toMatchObject(
      { code: "INSUFFICIENT_ROLE" },
    );
    expectNoWrites(made);
  });

  it("refuses an OWNER of another org", async () => {
    // Every row here belongs to ORG_ID; the request names another org.
    const made = makeDeps();

    await expect(
      transferOrgOwnership(made.deps, { ...input, orgId: OTHER_ORG_ID }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    expectNoWrites(made);
  });

  it("answers MEMBER_NOT_FOUND for a target who is not a member, with no write", async () => {
    const made = makeDeps({ targetRole: null });

    await expect(transferOrgOwnership(made.deps, input)).rejects.toMatchObject(
      { code: "MEMBER_NOT_FOUND" },
    );
    expectNoWrites(made);
  });

  it("answers INVALID_INPUT for a transfer to oneself, before the role gate, the lock or any write", async () => {
    const made = makeDeps();

    await expect(
      transferOrgOwnership(made.deps, { ...input, targetHumanId: ACTOR_ID }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(made.authz.requireOrgRole).not.toHaveBeenCalled();
    expect(made.organizationsRepo.lockOwnerRoster).not.toHaveBeenCalled();
    expectNoWrites(made);
  });

  it("stops at the port's role gate before opening a transaction", async () => {
    const made = makeDeps({
      authzError: { code: "forbidden", message: "insufficient_role" },
    });

    await expect(transferOrgOwnership(made.deps, input)).rejects.toMatchObject(
      { code: "forbidden" },
    );
    expect(made.organizationsRepo.lockOwnerRoster).not.toHaveBeenCalled();
    expectNoWrites(made);
  });

  it("asks the port for the admin roles only, leaving the OWNER decision to the transaction", async () => {
    const { deps, authz } = makeDeps();

    await transferOrgOwnership(deps, input);

    expect(authz.requireOrgRole).toHaveBeenCalledWith({
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
      requiredRoles: ["OWNER", "ADMIN"],
    });
  });

  it("rejects input carrying an unknown key", async () => {
    const made = makeDeps();

    await expect(
      transferOrgOwnership(made.deps, { ...input, newRole: "OWNER" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expectNoWrites(made);
  });
});
