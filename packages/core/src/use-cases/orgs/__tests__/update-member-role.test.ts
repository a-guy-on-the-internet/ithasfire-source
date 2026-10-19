import { describe, expect, it, vi } from "vitest";

import type { AuthZPort } from "@th/ports/authz";
import type { Repos, TxRepos } from "@th/ports/repos";

import {
  updateMemberRole,
  type UpdateMemberRoleDeps,
} from "../update-member-role";
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
    addMember: vi.fn(async () => ({
      created: false,
      previousRole: existingRole,
    })),
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

  const clock = { now: () => new Date("2025-03-01T00:00:00.000Z") };

  const deps: UpdateMemberRoleDeps = { repos, authz, clock };

  return {
    deps,
    organizationsRepo,
    auditRepo,
    authzRepo,
    authz,
    outer,
  };
}

describe("updateMemberRole", () => {
  it("updates an editor to admin", async () => {
    const { deps, organizationsRepo, auditRepo } = makeDeps({
      existingRole: "EDITOR",
    });

    const result = await updateMemberRole(deps, {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
      targetHumanId: TARGET_ID,
      newRole: "ADMIN",
    });

    expect(result).toEqual({ ok: true, previousRole: "EDITOR" });
    expect(organizationsRepo.addMember).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: ORG_ID,
        humanId: TARGET_ID,
        role: "ADMIN",
      }),
    );
    expect(auditRepo.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "org.member_role_updated",
        data: expect.objectContaining({
          previousRole: "EDITOR",
          newRole: "ADMIN",
        }),
      }),
    );
  });

  it("noops when role is already the same", async () => {
    const { deps, organizationsRepo } = makeDeps({ existingRole: "ADMIN" });

    const result = await updateMemberRole(deps, {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
      targetHumanId: TARGET_ID,
      newRole: "ADMIN",
    });

    expect(result).toEqual({ ok: true, previousRole: "ADMIN" });
    expect(organizationsRepo.addMember).not.toHaveBeenCalled();
  });

  it("prevents demoting the last owner", async () => {
    const { deps } = makeDeps({
      actorRole: "OWNER",
      existingRole: "OWNER",
      ownerCount: 1,
    });

    await expect(
      updateMemberRole(deps, {
        actorHumanId: ACTOR_ID,
        orgId: ORG_ID,
        targetHumanId: TARGET_ID,
        newRole: "ADMIN",
      }),
    ).rejects.toMatchObject({ code: "CANNOT_DEMOTE_LAST_OWNER" });
  });

  it("allows demoting an owner when there are multiple", async () => {
    const { deps } = makeDeps({
      actorRole: "OWNER",
      existingRole: "OWNER",
      ownerCount: 2,
    });

    const result = await updateMemberRole(deps, {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
      targetHumanId: TARGET_ID,
      newRole: "ADMIN",
    });

    expect(result.ok).toBe(true);
  });

  it("throws not_found when member does not exist", async () => {
    const { deps } = makeDeps({ existingRole: null });

    await expect(
      updateMemberRole(deps, {
        actorHumanId: ACTOR_ID,
        orgId: ORG_ID,
        targetHumanId: TARGET_ID,
        newRole: "ADMIN",
      }),
    ).rejects.toMatchObject({ code: "MEMBER_NOT_FOUND" });
  });

  it("throws when actor lacks permission", async () => {
    const { deps } = makeDeps({
      authzError: { code: "forbidden", message: "insufficient_role" },
    });

    await expect(
      updateMemberRole(deps, {
        actorHumanId: ACTOR_ID,
        orgId: ORG_ID,
        targetHumanId: TARGET_ID,
        newRole: "ADMIN",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  describe("only an OWNER changes who owns the org", () => {
    const input = {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
      targetHumanId: TARGET_ID,
    };

    it("refuses an ADMIN promoting a member to OWNER", async () => {
      const { deps, organizationsRepo, auditRepo } = makeDeps({
        actorRole: "ADMIN",
        existingRole: "EDITOR",
      });

      await expect(
        updateMemberRole(deps, { ...input, newRole: "OWNER" }),
      ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
      expect(organizationsRepo.addMember).not.toHaveBeenCalled();
      expect(auditRepo.log).not.toHaveBeenCalled();
    });

    it("lets an OWNER promote a member to OWNER", async () => {
      const { deps, organizationsRepo, authzRepo } = makeDeps({
        actorRole: "OWNER",
        existingRole: "EDITOR",
      });

      await expect(
        updateMemberRole(deps, { ...input, newRole: "OWNER" }),
      ).resolves.toEqual({ ok: true, previousRole: "EDITOR" });
      expect(authzRepo.getOrgMembership).toHaveBeenCalledWith({
        orgId: ORG_ID,
        humanId: ACTOR_ID,
      });
      expect(organizationsRepo.addMember).toHaveBeenCalledWith(
        expect.objectContaining({ humanId: TARGET_ID, role: "OWNER" }),
      );
    });

    it("refuses an ADMIN promoting themselves to OWNER", async () => {
      const { deps, organizationsRepo } = makeDeps({ actorRole: "ADMIN" });

      await expect(
        updateMemberRole(deps, {
          ...input,
          targetHumanId: ACTOR_ID,
          newRole: "OWNER",
        }),
      ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
      expect(organizationsRepo.addMember).not.toHaveBeenCalled();
    });

    it("refuses an ADMIN demoting an OWNER, whatever the owner count", async () => {
      for (const ownerCount of [1, 2]) {
        const { deps, organizationsRepo, auditRepo } = makeDeps({
          actorRole: "ADMIN",
          existingRole: "OWNER",
          ownerCount,
        });

        await expect(
          updateMemberRole(deps, { ...input, newRole: "ADMIN" }),
        ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
        expect(organizationsRepo.addMember).not.toHaveBeenCalled();
        expect(auditRepo.log).not.toHaveBeenCalled();
      }
    });

    it("refuses an ADMIN re-setting OWNER on a member who already holds it", async () => {
      const { deps } = makeDeps({ actorRole: "ADMIN", existingRole: "OWNER" });

      await expect(
        updateMemberRole(deps, { ...input, newRole: "OWNER" }),
      ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    });

    it("lets an OWNER demote another OWNER", async () => {
      const { deps, organizationsRepo, auditRepo } = makeDeps({
        actorRole: "OWNER",
        existingRole: "OWNER",
        ownerCount: 2,
      });

      await expect(
        updateMemberRole(deps, { ...input, newRole: "EDITOR" }),
      ).resolves.toEqual({ ok: true, previousRole: "OWNER" });
      expect(organizationsRepo.addMember).toHaveBeenCalledWith(
        expect.objectContaining({ humanId: TARGET_ID, role: "EDITOR" }),
      );
      expect(auditRepo.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "org.member_role_updated",
          data: expect.objectContaining({
            actorHumanId: ACTOR_ID,
            previousRole: "OWNER",
            newRole: "EDITOR",
          }),
        }),
      );
    });

    it("lets an OWNER demote themselves while another OWNER remains", async () => {
      const { deps, organizationsRepo } = makeDeps({
        actorRole: "OWNER",
        ownerCount: 2,
      });

      await expect(
        updateMemberRole(deps, {
          ...input,
          targetHumanId: ACTOR_ID,
          newRole: "ADMIN",
        }),
      ).resolves.toEqual({ ok: true, previousRole: "OWNER" });
      expect(organizationsRepo.addMember).toHaveBeenCalledWith(
        expect.objectContaining({ humanId: ACTOR_ID, role: "ADMIN" }),
      );
    });

    it("stops the last OWNER demoting themselves", async () => {
      const { deps, organizationsRepo } = makeDeps({
        actorRole: "OWNER",
        ownerCount: 1,
      });

      await expect(
        updateMemberRole(deps, {
          ...input,
          targetHumanId: ACTOR_ID,
          newRole: "ADMIN",
        }),
      ).rejects.toMatchObject({ code: "CANNOT_DEMOTE_LAST_OWNER" });
      expect(organizationsRepo.addMember).not.toHaveBeenCalled();
    });

    it("refuses an owner change by an actor with no membership row", async () => {
      // The port fake lets everyone through, so this is the in-transaction
      // read refusing on its own.
      const { deps, organizationsRepo } = makeDeps({
        actorRole: null,
        existingRole: "OWNER",
        ownerCount: 2,
      });

      await expect(
        updateMemberRole(deps, { ...input, newRole: "ADMIN" }),
      ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
      expect(organizationsRepo.addMember).not.toHaveBeenCalled();
    });

    it("reads memberships in the org the request names", async () => {
      // Every row here belongs to ORG_ID; the request names another org.
      const { deps, organizationsRepo } = makeDeps({ actorRole: "OWNER" });

      await expect(
        updateMemberRole(deps, {
          ...input,
          orgId: OTHER_ORG_ID,
          newRole: "OWNER",
        }),
      ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
      expect(organizationsRepo.addMember).not.toHaveBeenCalled();
    });

    it("answers MEMBER_NOT_FOUND before the owner check for a non-member target", async () => {
      const { deps } = makeDeps({ actorRole: "ADMIN", existingRole: null });

      await expect(
        updateMemberRole(deps, { ...input, newRole: "OWNER" }),
      ).rejects.toMatchObject({ code: "MEMBER_NOT_FOUND" });
    });

    it("leaves an ADMIN free to move members between the other roles", async () => {
      const others = ["ADMIN", "EDITOR", "VIEWER", "FINANCE", "SCANNER"] as const;
      for (const from of others) {
        for (const to of others) {
          if (from === to) continue;
          const { deps, organizationsRepo } = makeDeps({
            actorRole: "ADMIN",
            existingRole: from,
          });

          await expect(
            updateMemberRole(deps, { ...input, newRole: to }),
          ).resolves.toEqual({ ok: true, previousRole: from });
          expect(organizationsRepo.addMember).toHaveBeenCalledWith(
            expect.objectContaining({ humanId: TARGET_ID, role: to }),
          );
        }
      }
    });
  });

  describe("owner roster lock", () => {
    const input = {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
      targetHumanId: TARGET_ID,
      newRole: "ADMIN",
    };

    it("locks the org's roster before reading the target, the actor or the owner count", async () => {
      const { deps, organizationsRepo, authzRepo, outer } = makeDeps({
        actorRole: "OWNER",
        existingRole: "OWNER",
        ownerCount: 2,
      });

      await updateMemberRole(deps, input);

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
        ...organizationsRepo.addMember.mock.invocationCallOrder,
      ]) {
        expect(lockedAt).toBeLessThan(readAt);
      }
    });

    it("locks for a non-owner change too", async () => {
      const { deps, organizationsRepo, authzRepo, outer } = makeDeps({
        actorRole: "ADMIN",
        existingRole: "EDITOR",
      });

      await updateMemberRole(deps, input);

      expect(organizationsRepo.lockOwnerRoster).toHaveBeenCalledTimes(1);
      expectOuterHandleUnused(outer);
      expect(
        organizationsRepo.lockOwnerRoster.mock.invocationCallOrder[0]!,
      ).toBeLessThan(authzRepo.getOrgMembership.mock.invocationCallOrder[0]!);
    });
  });

  describe("a demoted OWNER's pending OWNER invitations", () => {
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

      await updateMemberRole(deps, { ...input, newRole: "ADMIN" });

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
      // Two revokes plus the role change itself.
      expect(auditRepo.log).toHaveBeenCalledTimes(3);
    });

    it("are revoked when an OWNER demotes themselves", async () => {
      const { deps, organizationsRepo } = makeDeps({
        actorRole: "OWNER",
        ownerCount: 2,
      });

      await updateMemberRole(deps, {
        ...input,
        targetHumanId: ACTOR_ID,
        newRole: "EDITOR",
      });

      expect(
        organizationsRepo.revokePendingOwnerInvitationsByInviter,
      ).toHaveBeenCalledWith({ orgId: ORG_ID, invitedByHumanId: ACTOR_ID });
    });

    it("writes only the role-change audit row when there are none", async () => {
      const { deps, auditRepo } = makeDeps({
        actorRole: "OWNER",
        existingRole: "OWNER",
        ownerCount: 2,
      });

      await updateMemberRole(deps, { ...input, newRole: "ADMIN" });

      expect(auditRepo.log).toHaveBeenCalledTimes(1);
      expect(auditRepo.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: "org.member_role_updated" }),
      );
    });

    it("are left alone when nobody stops being OWNER", async () => {
      const cases = [
        // A non-owner changes role.
        { actorRole: "ADMIN", existingRole: "EDITOR", newRole: "ADMIN" },
        // A member becomes OWNER.
        { actorRole: "OWNER", existingRole: "EDITOR", newRole: "OWNER" },
        // OWNER to OWNER changes nothing.
        { actorRole: "OWNER", existingRole: "OWNER", newRole: "OWNER" },
      ] as const;
      for (const { actorRole, existingRole, newRole } of cases) {
        const { deps, organizationsRepo } = makeDeps({
          actorRole,
          existingRole,
          ownerCount: 2,
          pendingOwnerInvitations,
        });

        await updateMemberRole(deps, { ...input, newRole });

        expect(
          organizationsRepo.revokePendingOwnerInvitationsByInviter,
        ).not.toHaveBeenCalled();
      }
    });

    it("are left alone when the demotion is refused", async () => {
      const refusals = [
        { actorRole: "ADMIN", ownerCount: 2 },
        { actorRole: "OWNER", ownerCount: 1 },
      ] as const;
      for (const { actorRole, ownerCount } of refusals) {
        const { deps, organizationsRepo } = makeDeps({
          actorRole,
          existingRole: "OWNER",
          ownerCount,
          pendingOwnerInvitations,
        });

        await expect(
          updateMemberRole(deps, { ...input, newRole: "ADMIN" }),
        ).rejects.toBeDefined();
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
      targetHumanId: TARGET_ID, newRole: "ADMIN",
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

        await expect(updateMemberRole(deps, input)).rejects.toMatchObject({
          code: "INSUFFICIENT_ROLE",
        });
        expect(authzRepo.getOrgMembership).toHaveBeenCalledWith({
          orgId: ORG_ID,
          humanId: ACTOR_ID,
        });
        expect(organizationsRepo.addMember).not.toHaveBeenCalled();
        expect(auditRepo.log).not.toHaveBeenCalled();
      },
    );

    it("reads the actor's row after the lock", async () => {
      const { deps, organizationsRepo, authzRepo } = makeDeps({
        actorRole: "ADMIN",
        existingRole: "EDITOR",
      });

      await updateMemberRole(deps, input);

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
