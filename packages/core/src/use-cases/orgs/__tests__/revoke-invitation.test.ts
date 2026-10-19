import { describe, expect, it, vi } from "vitest";

import type { AuthZPort } from "@th/ports/authz";
import type { Repos, TxRepos } from "@th/ports/repos";

import {
  isLiveOwnerInvitation,
  revokeInvitation,
  revokeOwnerInvitationsSentBy,
  type RevokeInvitationDeps,
} from "../revoke-invitation";
import { expectOuterHandleUnused, makeOuterHandle } from "./outer-handle";

const ACTOR_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const INVITER_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const INVITATION_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const NOW = new Date("2026-02-22T12:00:00.000Z");
const NOT_YET_EXPIRED = new Date("2026-02-25T00:00:00.000Z");
const LAPSED = new Date("2026-02-20T00:00:00.000Z");

type Role = "OWNER" | "ADMIN" | "EDITOR" | "VIEWER" | "FINANCE" | "SCANNER";

type Opts = {
  /** The actor's own membership row. Defaults to ADMIN. */
  actorRole?: Role | null;
  /** The inviter's membership row today. Defaults to OWNER; null = removed. */
  inviterRole?: Role | null;
  /** The stored invitation; null = the org has none with that id. */
  invitation?: { role: Role; status: string; expiresAt?: Date } | null;
  authzError?: unknown;
};

function makeDeps(options: Opts = {}) {
  const actorRole = "actorRole" in options ? options.actorRole : "ADMIN";
  const inviterRole = "inviterRole" in options ? options.inviterRole : "OWNER";
  const invitation =
    "invitation" in options
      ? options.invitation
      : { role: "EDITOR" as const, status: "PENDING" };

  // The transaction's handle only: `repos.tx` passes these mocks to its
  // callback and nothing else reaches them.
  const organizationsRepo = {
    lockOwnerRoster: vi.fn(async () => {}),
    listInvitations: vi.fn(async (input: { orgId: string }) => ({
      items:
        invitation && input.orgId === ORG_ID
          ? [
              {
                id: INVITATION_ID,
                orgId: ORG_ID,
                email: "invitee@example.com",
                invitedByHumanId: INVITER_ID,
                expiresAt: NOT_YET_EXPIRED,
                ...invitation,
              },
            ]
          : [],
      total: invitation ? 1 : 0,
    })),
    updateInvitationStatus: vi.fn(async () => ({})),
  };

  const auditRepo = { log: vi.fn(async () => {}) };

  const authzRepo = {
    getOrgMembership: vi.fn(
      async (input: { orgId: string; humanId: string }) => {
        if (input.orgId !== ORG_ID) return null;
        const role =
          input.humanId === ACTOR_ID
            ? actorRole
            : input.humanId === INVITER_ID
              ? inviterRole
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

  const deps: RevokeInvitationDeps = {
    repos,
    authz,
    clock: { now: () => NOW },
  };

  return { deps, organizationsRepo, auditRepo, authzRepo, outer };
}

const input = {
  actorHumanId: ACTOR_ID,
  orgId: ORG_ID,
  invitationId: INVITATION_ID,
};

describe("revokeInvitation", () => {
  it("lets an ADMIN revoke a pending non-owner invitation, with an audit row", async () => {
    const { deps, organizationsRepo, auditRepo } = makeDeps();

    await expect(revokeInvitation(deps, input)).resolves.toEqual({ ok: true });
    expect(organizationsRepo.updateInvitationStatus).toHaveBeenCalledWith({
      id: INVITATION_ID,
      status: "REVOKED",
    });
    expect(auditRepo.log).toHaveBeenCalledWith({
      entity: "organization",
      entityId: ORG_ID,
      action: "org.invitation_revoked",
      data: {
        actorHumanId: ACTOR_ID,
        invitationId: INVITATION_ID,
        email: "invitee@example.com",
      },
      at: NOW,
    });
  });

  it("answers INVITATION_NOT_FOUND for an id the org does not have", async () => {
    const { deps, organizationsRepo } = makeDeps({ invitation: null });

    await expect(revokeInvitation(deps, input)).rejects.toMatchObject({
      code: "INVITATION_NOT_FOUND",
    });
    expect(organizationsRepo.updateInvitationStatus).not.toHaveBeenCalled();
  });

  it("answers INVITATION_NOT_PENDING for one already accepted", async () => {
    const { deps, organizationsRepo } = makeDeps({
      invitation: { role: "EDITOR", status: "ACCEPTED" },
    });

    await expect(revokeInvitation(deps, input)).rejects.toMatchObject({
      code: "INVITATION_NOT_PENDING",
    });
    expect(organizationsRepo.updateInvitationStatus).not.toHaveBeenCalled();
  });

  it("throws when the actor fails the port's role gate", async () => {
    const { deps, organizationsRepo } = makeDeps({
      authzError: { code: "forbidden", message: "insufficient_role" },
    });

    await expect(revokeInvitation(deps, input)).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(organizationsRepo.listInvitations).not.toHaveBeenCalled();
  });

  // The port fake lets everyone through, as it would for an actor who lost
  // the role between the early check and the transaction.
  it.each([
    ["was removed from the org", null],
    ["was demoted to EDITOR", "EDITOR"],
  ] as const)(
    "refuses, inside the transaction, an actor who %s",
    async (_label, actorRole) => {
      const { deps, organizationsRepo, authzRepo } = makeDeps({ actorRole });

      await expect(revokeInvitation(deps, input)).rejects.toMatchObject({
        code: "INSUFFICIENT_ROLE",
      });
      expect(authzRepo.getOrgMembership).toHaveBeenCalledWith({
        orgId: ORG_ID,
        humanId: ACTOR_ID,
      });
      expect(organizationsRepo.updateInvitationStatus).not.toHaveBeenCalled();
    },
  );

  describe("only an OWNER revokes a live OWNER invitation", () => {
    const ownerInvitation = { role: "OWNER", status: "PENDING" } as const;

    it("refuses an ADMIN and leaves the invitation pending", async () => {
      const { deps, organizationsRepo, auditRepo, authzRepo } = makeDeps({
        actorRole: "ADMIN",
        invitation: ownerInvitation,
      });

      await expect(revokeInvitation(deps, input)).rejects.toMatchObject({
        code: "INSUFFICIENT_ROLE",
      });
      // The inviter's role is read in the invitation's org.
      expect(authzRepo.getOrgMembership).toHaveBeenCalledWith({
        orgId: ORG_ID,
        humanId: INVITER_ID,
      });
      expect(organizationsRepo.updateInvitationStatus).not.toHaveBeenCalled();
      expect(auditRepo.log).not.toHaveBeenCalled();
    });

    it("lets an OWNER, reading their role in the invitation's org", async () => {
      const { deps, organizationsRepo, auditRepo, authzRepo } = makeDeps({
        actorRole: "OWNER",
        invitation: ownerInvitation,
      });

      await expect(revokeInvitation(deps, input)).resolves.toEqual({
        ok: true,
      });
      expect(authzRepo.getOrgMembership).toHaveBeenCalledWith({
        orgId: ORG_ID,
        humanId: ACTOR_ID,
      });
      expect(organizationsRepo.updateInvitationStatus).toHaveBeenCalledWith({
        id: INVITATION_ID,
        status: "REVOKED",
      });
      expect(auditRepo.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: "org.invitation_revoked" }),
      );
    });

    it("lets an ADMIN revoke one past its expiry (still PENDING in the database)", async () => {
      const { deps, organizationsRepo } = makeDeps({
        actorRole: "ADMIN",
        invitation: { ...ownerInvitation, expiresAt: LAPSED },
      });

      await expect(revokeInvitation(deps, input)).resolves.toEqual({
        ok: true,
      });
      expect(organizationsRepo.updateInvitationStatus).toHaveBeenCalledWith({
        id: INVITATION_ID,
        status: "REVOKED",
      });
    });

    it.each([
      ["is an ADMIN", "ADMIN"],
      ["was demoted to EDITOR", "EDITOR"],
      ["left the org", null],
    ] as const)(
      "lets an ADMIN revoke one whose sender %s",
      async (_label, inviterRole) => {
        const { deps, organizationsRepo } = makeDeps({
          actorRole: "ADMIN",
          inviterRole,
          invitation: ownerInvitation,
        });

        await expect(revokeInvitation(deps, input)).resolves.toEqual({
          ok: true,
        });
        expect(organizationsRepo.updateInvitationStatus).toHaveBeenCalledTimes(
          1,
        );
      },
    );

    it.each(["ADMIN", "EDITOR", "VIEWER", "FINANCE", "SCANNER"] as const)(
      "leaves an ADMIN free to revoke a %s invitation without reading the inviter",
      async (role) => {
        const { deps, organizationsRepo, authzRepo } = makeDeps({
          actorRole: "ADMIN",
          invitation: { role, status: "PENDING" },
        });

        await expect(revokeInvitation(deps, input)).resolves.toEqual({
          ok: true,
        });
        // The actor's own row, and nothing else.
        expect(authzRepo.getOrgMembership).toHaveBeenCalledTimes(1);
        expect(authzRepo.getOrgMembership).toHaveBeenCalledWith({
          orgId: ORG_ID,
          humanId: ACTOR_ID,
        });
        expect(organizationsRepo.updateInvitationStatus).toHaveBeenCalledTimes(
          1,
        );
      },
    );
  });
});

describe("revokeInvitation owner roster lock", () => {
  it.each([
    ["an EDITOR invitation, by an ADMIN", "ADMIN", "EDITOR"],
    ["an OWNER invitation, by an OWNER", "OWNER", "OWNER"],
  ] as const)(
    "is taken on the transaction's handle before the actor, the invitation and its sender are read: %s",
    async (_label, actorRole, invitationRole) => {
      const { deps, organizationsRepo, authzRepo, auditRepo, outer } =
        makeDeps({
          actorRole,
          invitation: { role: invitationRole, status: "PENDING" },
        });

      await revokeInvitation(deps, input);

      expect(organizationsRepo.lockOwnerRoster).toHaveBeenCalledTimes(1);
      expect(organizationsRepo.lockOwnerRoster).toHaveBeenCalledWith(ORG_ID);
      expectOuterHandleUnused(outer);
      const lockedAt =
        organizationsRepo.lockOwnerRoster.mock.invocationCallOrder[0]!;
      expect(authzRepo.getOrgMembership).toHaveBeenCalled();
      for (const at of [
        ...authzRepo.getOrgMembership.mock.invocationCallOrder,
        ...organizationsRepo.listInvitations.mock.invocationCallOrder,
        ...organizationsRepo.updateInvitationStatus.mock.invocationCallOrder,
        ...auditRepo.log.mock.invocationCallOrder,
      ]) {
        expect(lockedAt).toBeLessThan(at);
      }
    },
  );

  it("refuses an ADMIN whose EDITOR invitation an OWNER re-sent at OWNER while the revoke waited for the lock", async () => {
    // What the row reads as once the re-invite's upsert has committed: same
    // id, now a live OWNER invitation from an OWNER.
    const { deps, organizationsRepo, auditRepo } = makeDeps({
      actorRole: "ADMIN",
      inviterRole: "OWNER",
      invitation: { role: "OWNER", status: "PENDING" },
    });

    await expect(revokeInvitation(deps, input)).rejects.toMatchObject({
      code: "INSUFFICIENT_ROLE",
    });
    expect(
      organizationsRepo.lockOwnerRoster.mock.invocationCallOrder[0]!,
    ).toBeLessThan(
      organizationsRepo.listInvitations.mock.invocationCallOrder[0]!,
    );
    expect(organizationsRepo.updateInvitationStatus).not.toHaveBeenCalled();
    expect(auditRepo.log).not.toHaveBeenCalled();
  });

  it("takes no lock when the port's role gate refuses", async () => {
    const { deps, organizationsRepo } = makeDeps({
      authzError: { code: "forbidden", message: "insufficient_role" },
    });

    await expect(revokeInvitation(deps, input)).rejects.toBeDefined();
    expect(organizationsRepo.lockOwnerRoster).not.toHaveBeenCalled();
  });
});

describe("isLiveOwnerInvitation", () => {
  function makeRepos(inviterRole: Role | null) {
    const getOrgMembership = vi.fn(
      async (input: { orgId: string; humanId: string }) =>
        inviterRole && input.orgId === ORG_ID && input.humanId === INVITER_ID
          ? { orgId: ORG_ID, humanId: INVITER_ID, role: inviterRole }
          : null,
    );
    return { repos: { authz: { getOrgMembership } }, getOrgMembership };
  }

  const live = {
    orgId: ORG_ID,
    role: "OWNER",
    status: "PENDING",
    expiresAt: NOT_YET_EXPIRED,
    invitedByHumanId: INVITER_ID,
  } as const;

  it("is true for a PENDING, unexpired OWNER invitation whose sender holds OWNER", async () => {
    const { repos, getOrgMembership } = makeRepos("OWNER");

    await expect(isLiveOwnerInvitation(repos, live, NOW)).resolves.toBe(true);
    expect(getOrgMembership).toHaveBeenCalledWith({
      orgId: ORG_ID,
      humanId: INVITER_ID,
    });
  });

  it("is true at the very instant of expiry, as acceptInvitation still honours it", async () => {
    const { repos } = makeRepos("OWNER");

    await expect(
      isLiveOwnerInvitation(repos, { ...live, expiresAt: NOW }, NOW),
    ).resolves.toBe(true);
  });

  it.each([
    ["another role", { role: "ADMIN" }],
    ["a revoked one", { status: "REVOKED" }],
    ["an accepted one", { status: "ACCEPTED" }],
    ["one past its expiry", { expiresAt: LAPSED }],
  ] as const)("is false for %s, without reading the inviter", async (_l, over) => {
    const { repos, getOrgMembership } = makeRepos("OWNER");

    await expect(
      isLiveOwnerInvitation(repos, { ...live, ...over }, NOW),
    ).resolves.toBe(false);
    expect(getOrgMembership).not.toHaveBeenCalled();
  });

  it.each([["ADMIN"], ["EDITOR"], [null]] as const)(
    "is false when the sender's role today is %s",
    async (inviterRole) => {
      const { repos } = makeRepos(inviterRole);

      await expect(isLiveOwnerInvitation(repos, live, NOW)).resolves.toBe(
        false,
      );
    },
  );
});

describe("revokeOwnerInvitationsSentBy", () => {
  function makeTx(revoked: Array<{ id: string; email: string }>) {
    const organizations = {
      revokePendingOwnerInvitationsByInviter: vi.fn(async () => revoked),
    };
    const audit = { log: vi.fn(async () => {}) };
    const tx = { organizations, audit } as unknown as Pick<
      TxRepos,
      "organizations" | "audit"
    >;
    return { tx, organizations, audit };
  }

  const args = {
    orgId: ORG_ID,
    inviterHumanId: INVITER_ID,
    actorHumanId: ACTOR_ID,
    at: NOW,
  };

  it("asks the repo for that inviter's invitations in that org, and audits each one revoked", async () => {
    const { tx, organizations, audit } = makeTx([
      { id: "inv-1", email: "one@example.com" },
      { id: "inv-2", email: "two@example.com" },
    ]);

    await expect(revokeOwnerInvitationsSentBy(tx, args)).resolves.toBe(2);

    expect(
      organizations.revokePendingOwnerInvitationsByInviter,
    ).toHaveBeenCalledWith({ orgId: ORG_ID, invitedByHumanId: INVITER_ID });
    expect(audit.log).toHaveBeenCalledTimes(2);
    expect(audit.log).toHaveBeenNthCalledWith(1, {
      entity: "organization",
      entityId: ORG_ID,
      action: "org.invitation_revoked",
      data: {
        actorHumanId: ACTOR_ID,
        invitationId: "inv-1",
        email: "one@example.com",
        invitedByHumanId: INVITER_ID,
        reason: "INVITER_NO_LONGER_OWNER",
      },
      at: NOW,
    });
  });

  it("writes no audit row when nothing was revoked", async () => {
    const { tx, audit } = makeTx([]);

    await expect(revokeOwnerInvitationsSentBy(tx, args)).resolves.toBe(0);
    expect(audit.log).not.toHaveBeenCalled();
  });
});
