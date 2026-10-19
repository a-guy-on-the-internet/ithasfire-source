import { describe, expect, it, vi } from "vitest";

import type { AuthZPort } from "@th/ports/authz";
import type { Repos, TxRepos } from "@th/ports/repos";

import {
  removeOrgMember,
  type RemoveOrgMemberDeps,
} from "../remove-org-member";
import { expectOuterHandleUnused, makeOuterHandle } from "./outer-handle";

const ACTOR_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TARGET_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OTHER_ORG_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

type Role = "OWNER" | "ADMIN" | "EDITOR" | "VIEWER" | "FINANCE" | "SCANNER";

type Opts = {
  /** The target's current role; ignored when the actor targets themselves. */
  existingRole?: Role | null;
  /** The actor's own membership row. Defaults to ADMIN. */
  actorRole?: Role | null;
  ownerCount?: number;
  authzError?: unknown;
  removeSuccess?: boolean;
  /** What the repo revokes when asked for the target's OWNER invitations. */
  pendingOwnerInvitations?: Array<{ id: string; email: string }>;
};

function makeDeps(options: Opts = {}) {
  const existingRole =
    "existingRole" in options ? options.existingRole : "EDITOR";
  const actorRole = "actorRole" in options ? options.actorRole : "ADMIN";

  // These mocks are the transaction's handle only: `repos.tx` passes them to
  // its callback and nothing else reaches them.
  const organizationsRepo = {
    lockOwnerRoster: vi.fn(async () => {}),
    revokePendingOwnerInvitationsByInviter: vi.fn(
      async () => options.pendingOwnerInvitations ?? [],
    ),
    removeMember: vi.fn(async () => options.removeSuccess ?? true),
    countMembersByRole: vi.fn(
      async () => options.ownerCount ?? (existingRole === "OWNER" ? 2 : 0),
    ),
  };

  const auditRepo = { log: vi.fn(async () => {}) };

  const authzRepo = {
    getOrgMembership: vi.fn(
      async (input: { orgId: string; humanId: string }) => {
        if (input.orgId !== ORG_ID) return null;
        const role = input.humanId === ACTOR_ID ? actorRole : existingRole;
        return role ? { orgId: ORG_ID, humanId: input.humanId, role } : null;
      },
    ),
  };

  const quotasRepo = {
    incrementUsage: vi.fn(async () => {}),
  };

  const txSide = {
    organizations: organizationsRepo,
    audit: auditRepo,
    authz: authzRepo,
    resourceQuotas: quotasRepo,
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

  const clock = { now: () => new Date("2025-03-01T00:00:00.000Z") };

  const deps: RemoveOrgMemberDeps = { repos, authz, clock };

  return {
    deps,
    organizationsRepo,
    auditRepo,
    authzRepo,
    quotasRepo,
    outer,
  };
}

describe("removeOrgMember", () => {
  it("removes a member and returns ok", async () => {
    const { deps, organizationsRepo, auditRepo } = makeDeps({
      existingRole: "EDITOR",
    });

    const result = await removeOrgMember(deps, {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
      targetHumanId: TARGET_ID,
    });

    expect(result).toEqual({ ok: true });
    expect(organizationsRepo.removeMember).toHaveBeenCalledWith({
      orgId: ORG_ID,
      humanId: TARGET_ID,
    });
    expect(auditRepo.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "org.member_removed",
        data: expect.objectContaining({
          targetHumanId: TARGET_ID,
          role: "EDITOR",
        }),
      }),
    );
  });

  it("prevents removing the last owner", async () => {
    const { deps } = makeDeps({
      actorRole: "OWNER",
      existingRole: "OWNER",
      ownerCount: 1,
    });

    await expect(
      removeOrgMember(deps, {
        actorHumanId: ACTOR_ID,
        orgId: ORG_ID,
        targetHumanId: TARGET_ID,
      }),
    ).rejects.toMatchObject({ code: "CANNOT_REMOVE_LAST_OWNER" });
  });

  it("allows removing an owner when there are multiple", async () => {
    const { deps } = makeDeps({
      actorRole: "OWNER",
      existingRole: "OWNER",
      ownerCount: 2,
    });

    const result = await removeOrgMember(deps, {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
      targetHumanId: TARGET_ID,
    });

    expect(result.ok).toBe(true);
  });

  it("throws not_found when member does not exist", async () => {
    const { deps } = makeDeps({ existingRole: null });

    await expect(
      removeOrgMember(deps, {
        actorHumanId: ACTOR_ID,
        orgId: ORG_ID,
        targetHumanId: TARGET_ID,
      }),
    ).rejects.toMatchObject({ code: "MEMBER_NOT_FOUND" });
  });

  it("throws when actor lacks permission", async () => {
    const { deps } = makeDeps({
      authzError: { code: "forbidden", message: "insufficient_role" },
    });

    await expect(
      removeOrgMember(deps, {
        actorHumanId: ACTOR_ID,
        orgId: ORG_ID,
        targetHumanId: TARGET_ID,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("decrements MEMBERS_PER_ORG for the org", async () => {
    const { deps, quotasRepo } = makeDeps({ existingRole: "EDITOR" });

    await removeOrgMember(deps, {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
      targetHumanId: TARGET_ID,
    });

    expect(quotasRepo.incrementUsage).toHaveBeenCalledWith({
      subjectType: "ORG",
      subjectId: ORG_ID,
      kind: "MEMBERS_PER_ORG",
      delta: -1n,
    });
  });

  it("decrements ORGS_JOINED for the removed human", async () => {
    const { deps, quotasRepo } = makeDeps({ existingRole: "EDITOR" });

    await removeOrgMember(deps, {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
      targetHumanId: TARGET_ID,
    });

    expect(quotasRepo.incrementUsage).toHaveBeenCalledWith({
      subjectType: "HUMAN",
      subjectId: TARGET_ID,
      kind: "ORGS_JOINED",
      delta: -1n,
    });
  });

  describe("only an OWNER removes an OWNER", () => {
    const input = {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
      targetHumanId: TARGET_ID,
    };

    it("refuses an ADMIN removing an OWNER, whatever the owner count", async () => {
      for (const ownerCount of [1, 2]) {
        const { deps, organizationsRepo, auditRepo, quotasRepo } = makeDeps({
          actorRole: "ADMIN",
          existingRole: "OWNER",
          ownerCount,
        });

        await expect(removeOrgMember(deps, input)).rejects.toMatchObject({
          code: "INSUFFICIENT_ROLE",
        });
        expect(organizationsRepo.removeMember).not.toHaveBeenCalled();
        expect(auditRepo.log).not.toHaveBeenCalled();
        expect(quotasRepo.incrementUsage).not.toHaveBeenCalled();
      }
    });

    it("lets an OWNER remove another OWNER", async () => {
      const { deps, organizationsRepo, auditRepo, authzRepo } = makeDeps({
        actorRole: "OWNER",
        existingRole: "OWNER",
        ownerCount: 2,
      });

      await expect(removeOrgMember(deps, input)).resolves.toEqual({ ok: true });
      expect(authzRepo.getOrgMembership).toHaveBeenCalledWith({
        orgId: ORG_ID,
        humanId: ACTOR_ID,
      });
      expect(organizationsRepo.removeMember).toHaveBeenCalledWith({
        orgId: ORG_ID,
        humanId: TARGET_ID,
      });
      expect(auditRepo.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "org.member_removed",
          data: expect.objectContaining({
            actorHumanId: ACTOR_ID,
            targetHumanId: TARGET_ID,
            role: "OWNER",
          }),
        }),
      );
    });

    it("lets an OWNER remove themselves while another OWNER remains", async () => {
      const { deps, organizationsRepo } = makeDeps({
        actorRole: "OWNER",
        ownerCount: 2,
      });

      await expect(
        removeOrgMember(deps, { ...input, targetHumanId: ACTOR_ID }),
      ).resolves.toEqual({ ok: true });
      expect(organizationsRepo.removeMember).toHaveBeenCalledWith({
        orgId: ORG_ID,
        humanId: ACTOR_ID,
      });
    });

    it("stops the last OWNER removing themselves", async () => {
      const { deps, organizationsRepo } = makeDeps({
        actorRole: "OWNER",
        ownerCount: 1,
      });

      await expect(
        removeOrgMember(deps, { ...input, targetHumanId: ACTOR_ID }),
      ).rejects.toMatchObject({ code: "CANNOT_REMOVE_LAST_OWNER" });
      expect(organizationsRepo.removeMember).not.toHaveBeenCalled();
    });

    it("refuses removing an OWNER by an actor with no membership row", async () => {
      // The port fake lets everyone through, so this is the in-transaction
      // read refusing on its own.
      const { deps, organizationsRepo } = makeDeps({
        actorRole: null,
        existingRole: "OWNER",
        ownerCount: 2,
      });

      await expect(removeOrgMember(deps, input)).rejects.toMatchObject({
        code: "INSUFFICIENT_ROLE",
      });
      expect(organizationsRepo.removeMember).not.toHaveBeenCalled();
    });

    it("reads memberships in the org the request names", async () => {
      // Every row here belongs to ORG_ID; the request names another org.
      const { deps, organizationsRepo } = makeDeps({
        actorRole: "OWNER",
        existingRole: "OWNER",
        ownerCount: 2,
      });

      await expect(
        removeOrgMember(deps, { ...input, orgId: OTHER_ORG_ID }),
      ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
      expect(organizationsRepo.removeMember).not.toHaveBeenCalled();
    });

    it("leaves an ADMIN free to remove any non-owner", async () => {
      const others = ["ADMIN", "EDITOR", "VIEWER", "FINANCE", "SCANNER"] as const;
      for (const existingRole of others) {
        const { deps, organizationsRepo } = makeDeps({
          actorRole: "ADMIN",
          existingRole,
        });

        await expect(removeOrgMember(deps, input)).resolves.toEqual({
          ok: true,
        });
        expect(organizationsRepo.removeMember).toHaveBeenCalledWith({
          orgId: ORG_ID,
          humanId: TARGET_ID,
        });
      }
    });
  });

  describe("owner roster lock", () => {
    const input = {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
      targetHumanId: TARGET_ID,
    };

    it("locks the org's roster before reading the target, the actor or the owner count", async () => {
      const { deps, organizationsRepo, authzRepo, outer } = makeDeps({
        actorRole: "OWNER",
        existingRole: "OWNER",
        ownerCount: 2,
      });

      await removeOrgMember(deps, input);

      expect(organizationsRepo.lockOwnerRoster).toHaveBeenCalledTimes(1);
      expect(organizationsRepo.lockOwnerRoster).toHaveBeenCalledWith(ORG_ID);
      // On the transaction's handle: the outer one took no lock and made no
      // read or write.
      expectOuterHandleUnused(outer);
      const lockedAt =
        organizationsRepo.lockOwnerRoster.mock.invocationCallOrder[0]!;
      // Both membership reads (actor, then target) and the count come after.
      expect(authzRepo.getOrgMembership).toHaveBeenCalledTimes(2);
      for (const readAt of [
        ...authzRepo.getOrgMembership.mock.invocationCallOrder,
        ...organizationsRepo.countMembersByRole.mock.invocationCallOrder,
        ...organizationsRepo.removeMember.mock.invocationCallOrder,
      ]) {
        expect(lockedAt).toBeLessThan(readAt);
      }
    });

    it("locks for a non-owner removal too", async () => {
      const { deps, organizationsRepo, authzRepo, outer } = makeDeps({
        actorRole: "ADMIN",
        existingRole: "EDITOR",
      });

      await removeOrgMember(deps, input);

      expect(organizationsRepo.lockOwnerRoster).toHaveBeenCalledTimes(1);
      expectOuterHandleUnused(outer);
      expect(
        organizationsRepo.lockOwnerRoster.mock.invocationCallOrder[0]!,
      ).toBeLessThan(authzRepo.getOrgMembership.mock.invocationCallOrder[0]!);
    });
  });

  describe("a removed OWNER's pending OWNER invitations", () => {
    const input = {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
      targetHumanId: TARGET_ID,
    };
    const pendingOwnerInvitations = [
      { id: "inv-1", email: "one@example.com" },
      { id: "inv-2", email: "two@example.com" },
    ];

    it("are revoked in the same transaction, with one audit row each", async () => {
      const { deps, organizationsRepo, auditRepo, outer } = makeDeps(
        {
          actorRole: "OWNER",
          existingRole: "OWNER",
          ownerCount: 2,
          pendingOwnerInvitations,
        },
      );

      await removeOrgMember(deps, input);

      expect(
        organizationsRepo.revokePendingOwnerInvitationsByInviter,
      ).toHaveBeenCalledTimes(1);
      expect(
        organizationsRepo.revokePendingOwnerInvitationsByInviter,
      ).toHaveBeenCalledWith({ orgId: ORG_ID, invitedByHumanId: TARGET_ID });
      expectOuterHandleUnused(outer);
      for (const invitation of pendingOwnerInvitations) {
        expect(auditRepo.log).toHaveBeenCalledWith({
          entity: "organization",
          entityId: ORG_ID,
          action: "org.invitation_revoked",
          data: {
            actorHumanId: ACTOR_ID,
            invitationId: invitation.id,
            email: invitation.email,
            invitedByHumanId: TARGET_ID,
            reason: "INVITER_NO_LONGER_OWNER",
          },
          at: expect.any(Date),
        });
      }
      // Two revokes plus the removal itself.
      expect(auditRepo.log).toHaveBeenCalledTimes(3);
    });

    it("are revoked when an OWNER removes themselves", async () => {
      const { deps, organizationsRepo } = makeDeps({
        actorRole: "OWNER",
        ownerCount: 2,
      });

      await removeOrgMember(deps, { ...input, targetHumanId: ACTOR_ID });

      expect(
        organizationsRepo.revokePendingOwnerInvitationsByInviter,
      ).toHaveBeenCalledWith({ orgId: ORG_ID, invitedByHumanId: ACTOR_ID });
    });

    it("are left alone when the removed member is not an OWNER", async () => {
      const { deps, organizationsRepo, auditRepo } = makeDeps({
        actorRole: "ADMIN",
        existingRole: "ADMIN",
        pendingOwnerInvitations,
      });

      await removeOrgMember(deps, input);

      expect(
        organizationsRepo.revokePendingOwnerInvitationsByInviter,
      ).not.toHaveBeenCalled();
      expect(auditRepo.log).toHaveBeenCalledTimes(1);
    });

    it("are left alone when the removal is refused or finds no row", async () => {
      const refusals = [
        { actorRole: "ADMIN", ownerCount: 2, removeSuccess: true },
        { actorRole: "OWNER", ownerCount: 1, removeSuccess: true },
        { actorRole: "OWNER", ownerCount: 2, removeSuccess: false },
      ] as const;
      for (const { actorRole, ownerCount, removeSuccess } of refusals) {
        const { deps, organizationsRepo } = makeDeps({
          actorRole,
          existingRole: "OWNER",
          ownerCount,
          removeSuccess,
          pendingOwnerInvitations,
        });

        await expect(removeOrgMember(deps, input)).rejects.toBeDefined();
        expect(
          organizationsRepo.revokePendingOwnerInvitationsByInviter,
        ).not.toHaveBeenCalled();
      }
    });
  });

  describe("the actor's role is read again inside the transaction", () => {
    const input = {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
      targetHumanId: TARGET_ID,
    };

    // The port fake lets everyone through, as it would for an actor who lost
    // the role between the early check and the transaction.
    it.each([
      ["was removed from the org", null],
      ["was demoted to EDITOR", "EDITOR"],
      ["was demoted to VIEWER", "VIEWER"],
    ] as const)(
      "refuses a non-owner change by an actor who %s, with no write",
      async (_label, actorRole) => {
        const { deps, organizationsRepo, auditRepo, authzRepo } = makeDeps({
          actorRole,
          existingRole: "EDITOR",
        });

        await expect(removeOrgMember(deps, input)).rejects.toMatchObject({
          code: "INSUFFICIENT_ROLE",
        });
        expect(authzRepo.getOrgMembership).toHaveBeenCalledWith({
          orgId: ORG_ID,
          humanId: ACTOR_ID,
        });
        expect(organizationsRepo.removeMember).not.toHaveBeenCalled();
        expect(auditRepo.log).not.toHaveBeenCalled();
      },
    );

    it("reads the actor's row after the lock", async () => {
      const { deps, organizationsRepo, authzRepo } = makeDeps({
        actorRole: "ADMIN",
        existingRole: "EDITOR",
      });

      await removeOrgMember(deps, input);

      expect(authzRepo.getOrgMembership).toHaveBeenNthCalledWith(1, {
        orgId: ORG_ID,
        humanId: ACTOR_ID,
      });
      expect(
        organizationsRepo.lockOwnerRoster.mock.invocationCallOrder[0]!,
      ).toBeLessThan(authzRepo.getOrgMembership.mock.invocationCallOrder[0]!);
    });
  });
});
