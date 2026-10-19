import { describe, expect, it, vi } from "vitest";

import { deleteOrg } from "../delete-org";
import type { DeleteOrgDeps } from "../delete-org";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { AuthZPort } from "@th/ports/authz";
import type { OrgRole } from "@th/ports/repos/authz";
import { createTestLogger } from "@th/test-utils/fakes/logger";

import { expectOuterHandleUnused, makeOuterHandle } from "./outer-handle";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const ACTOR_ID = "00000000-0000-4000-8000-000000000002";
const MEMBER_A = "00000000-0000-4000-8000-000000000003";
const MEMBER_B = "00000000-0000-4000-8000-000000000004";
const BASE_DATE = new Date("2024-06-01T00:00:00.000Z");

interface MakeDepsOptions {
  orgStatus?: "ACTIVE" | "SUSPENDED" | "ARCHIVED";
  /**
   * The org's members as the transaction reads them, the actor's own row
   * included. The early check on the authz port does not read this list.
   */
  members?: Array<{ humanId: string; role: OrgRole }>;
  activeEventCount?: number;
  authzError?: unknown;
  /** How many PENDING invitations the repo reports revoking. */
  pendingInvitationCount?: number;
}

function makeDeps(options: MakeDepsOptions = {}) {
  const orgStatus = options.orgStatus ?? "ACTIVE";
  const members = options.members ?? [
    { humanId: ACTOR_ID, role: "OWNER" as const },
    { humanId: MEMBER_A, role: "ADMIN" as const },
    { humanId: MEMBER_B, role: "MEMBER" as const },
  ];
  const activeEventCount = options.activeEventCount ?? 0;

  // The transaction's handle only: `repos.tx` passes these mocks to its
  // callback and nothing else reaches them.
  const organizationsRepo = {
    lockOwnerRoster: vi.fn(async () => {}),
    revokeAllPendingInvitations: vi.fn(
      async () => options.pendingInvitationCount ?? 0,
    ),
    listMembers: vi.fn(async () => ({
      items: members.map((m) => ({
        humanId: m.humanId,
        name: null,
        email: null,
        role: m.role,
        joinedAt: BASE_DATE,
      })),
      total: members.length,
    })),
    update: vi.fn(async (input: any) => ({
      id: ORG_ID,
      name: "Test Org",
      slug: input.slug ?? "test-org",
      status: orgStatus,
    })),
    removeMember: vi.fn(async () => true),
  };

  const authzRepo = {
    getOrgMembership: vi.fn(
      async (input: { orgId: string; humanId: string }) => {
        if (input.orgId !== ORG_ID) return null;
        const member = members.find((m) => m.humanId === input.humanId);
        return member
          ? { orgId: ORG_ID, humanId: member.humanId, role: member.role }
          : null;
      },
    ),
  };

  const auditRepo = {
    log: vi.fn(async () => undefined),
  };

  const quotasRepo = {
    incrementUsage: vi.fn(async () => undefined),
  };

  const txSide = {
    organizations: organizationsRepo,
    audit: auditRepo,
    authz: authzRepo,
    resourceQuotas: quotasRepo,
  };

  // The two guards the use case runs before its transaction. Every other
  // method on the outer handle throws.
  const outerOrganizationsRepo = {
    getById: vi.fn(async () => ({
      id: ORG_ID,
      name: "Test Org",
      slug: "test-org",
      status: orgStatus,
    })),
  };
  const eventsRepo = {
    listByOwner: vi.fn(async () => ({
      items: Array.from({ length: activeEventCount }, (_, i) => ({
        id: `event-${i}`,
        orgId: ORG_ID,
        status: "PUBLISHED",
      })),
      total: activeEventCount,
    })),
  };
  const outer = makeOuterHandle(txSide, {
    organizations: outerOrganizationsRepo,
    events: eventsRepo,
  });

  const repos = {
    ...outer,
    tx: vi.fn(async (fn: (tx: TxRepos) => Promise<any>) =>
      fn(txSide as unknown as TxRepos),
    ),
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
  } as unknown as AuthZPort;

  const clock = {
    now: vi.fn(() => BASE_DATE),
  };

  const logger = createTestLogger();

  const deps: DeleteOrgDeps = {
    repos,
    authz,
    clock,
    logger,
  };

  return {
    deps,
    mocks: {
      organizationsRepo,
      outerOrganizationsRepo,
      authzRepo,
      eventsRepo,
      quotasRepo,
      auditRepo,
      outer,
    },
  };
}

describe("deleteOrg", () => {
  it("archives the org, removes all members, and decrements quotas", async () => {
    const { deps, mocks } = makeDeps();

    const result = await deleteOrg(deps, {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
    });

    expect(result.ok).toBe(true);
    expect(result.archivedMemberCount).toBe(3);

    // All 3 members should be removed.
    expect(mocks.organizationsRepo.removeMember).toHaveBeenCalledTimes(3);

    // ORGS_JOINED decremented for each member.
    const orgsJoinedCalls = mocks.quotasRepo.incrementUsage.mock.calls.filter(
      (c: any[]) => c[0].kind === "ORGS_JOINED",
    );
    expect(orgsJoinedCalls).toHaveLength(3);
    for (const call of orgsJoinedCalls) {
      expect(call[0].delta).toBe(-1n);
      expect(call[0].subjectType).toBe("HUMAN");
    }

    // ORGS_OWNED decremented for the actor.
    const orgsOwnedCalls = mocks.quotasRepo.incrementUsage.mock.calls.filter(
      (c: any[]) => c[0].kind === "ORGS_OWNED",
    );
    expect(orgsOwnedCalls).toHaveLength(1);
    expect(orgsOwnedCalls[0][0]).toMatchObject({
      subjectType: "HUMAN",
      subjectId: ACTOR_ID,
      kind: "ORGS_OWNED",
      delta: -1n,
    });

    // Org slug should be archived.
    expect(mocks.organizationsRepo.update).toHaveBeenCalledWith(
      expect.objectContaining({
        id: ORG_ID,
        slug: expect.stringContaining("__archived_"),
      }),
    );

    // Audit log should be written.
    expect(mocks.auditRepo.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "organization",
        entityId: ORG_ID,
        action: "organization.deleted",
      }),
    );
  });

  it("revokes every pending invitation of the org in the same transaction and counts them in the audit row", async () => {
    const { deps, mocks } = makeDeps({ pendingInvitationCount: 4 });

    await deleteOrg(deps, { actorHumanId: ACTOR_ID, orgId: ORG_ID });

    expect(
      mocks.organizationsRepo.revokeAllPendingInvitations,
    ).toHaveBeenCalledTimes(1);
    expect(
      mocks.organizationsRepo.revokeAllPendingInvitations,
    ).toHaveBeenCalledWith(ORG_ID);
    expectOuterHandleUnused(mocks.outer);
    expect(mocks.auditRepo.log).toHaveBeenCalledTimes(1);
    expect(mocks.auditRepo.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "organization.deleted",
        data: expect.objectContaining({
          removedMemberCount: 3,
          revokedInvitationCount: 4,
        }),
      }),
    );
  });

  it("takes the owner roster lock on the transaction's handle before the actor's row, the member list or any write", async () => {
    const { deps, mocks } = makeDeps();

    await deleteOrg(deps, { actorHumanId: ACTOR_ID, orgId: ORG_ID });

    expect(mocks.organizationsRepo.lockOwnerRoster).toHaveBeenCalledTimes(1);
    expect(mocks.organizationsRepo.lockOwnerRoster).toHaveBeenCalledWith(
      ORG_ID,
    );
    // The outer handle answered the two guards and nothing else.
    expectOuterHandleUnused(mocks.outer);
    expect(mocks.authzRepo.getOrgMembership).toHaveBeenCalledTimes(1);
    expect(mocks.organizationsRepo.listMembers).toHaveBeenCalledTimes(1);
    const lockedAt =
      mocks.organizationsRepo.lockOwnerRoster.mock.invocationCallOrder[0]!;
    for (const at of [
      ...mocks.authzRepo.getOrgMembership.mock.invocationCallOrder,
      ...mocks.organizationsRepo.listMembers.mock.invocationCallOrder,
      ...mocks.organizationsRepo.update.mock.invocationCallOrder,
      ...mocks.organizationsRepo.removeMember.mock.invocationCallOrder,
      ...mocks.organizationsRepo.revokeAllPendingInvitations.mock
        .invocationCallOrder,
    ]) {
      expect(lockedAt).toBeLessThan(at);
    }
  });

  it("revokes nothing when the delete is refused", async () => {
    const refused = [
      makeDeps({ orgStatus: "ARCHIVED" }),
      makeDeps({ activeEventCount: 1 }),
      makeDeps({
        authzError: { code: "forbidden", message: "insufficient_role" },
      }),
    ];
    for (const { deps, mocks } of refused) {
      await expect(
        deleteOrg(deps, { actorHumanId: ACTOR_ID, orgId: ORG_ID }),
      ).rejects.toBeDefined();
      expect(
        mocks.organizationsRepo.revokeAllPendingInvitations,
      ).not.toHaveBeenCalled();
      expect(mocks.organizationsRepo.lockOwnerRoster).not.toHaveBeenCalled();
    }
  });

  describe("the actor's role is read again inside the transaction", () => {
    // The port fake lets everyone through, as it would for an actor who held
    // OWNER at the early check and lost it while waiting for the lock.
    it.each([
      [
        "was demoted to ADMIN",
        [
          { humanId: ACTOR_ID, role: "ADMIN" as const },
          { humanId: MEMBER_A, role: "OWNER" as const },
        ],
      ],
      [
        "was removed from the org",
        [{ humanId: MEMBER_A, role: "OWNER" as const }],
      ],
    ])(
      "refuses an actor who %s, with no write",
      async (_label, members) => {
        const { deps, mocks } = makeDeps({ members, pendingInvitationCount: 2 });

        await expect(
          deleteOrg(deps, { actorHumanId: ACTOR_ID, orgId: ORG_ID }),
        ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });

        expect(mocks.authzRepo.getOrgMembership).toHaveBeenCalledWith({
          orgId: ORG_ID,
          humanId: ACTOR_ID,
        });
        expect(
          mocks.organizationsRepo.lockOwnerRoster.mock.invocationCallOrder[0]!,
        ).toBeLessThan(
          mocks.authzRepo.getOrgMembership.mock.invocationCallOrder[0]!,
        );
        expect(mocks.organizationsRepo.listMembers).not.toHaveBeenCalled();
        expect(mocks.organizationsRepo.update).not.toHaveBeenCalled();
        expect(mocks.organizationsRepo.removeMember).not.toHaveBeenCalled();
        expect(
          mocks.organizationsRepo.revokeAllPendingInvitations,
        ).not.toHaveBeenCalled();
        expect(mocks.quotasRepo.incrementUsage).not.toHaveBeenCalled();
        expect(mocks.auditRepo.log).not.toHaveBeenCalled();
        expectOuterHandleUnused(mocks.outer);
      },
    );

    it("reads the member list on the transaction's handle, after the lock, and removes whoever is on it then", async () => {
      // A member whose accept commits while this delete waits for the lock
      // is on the list only if it is read after the lock, which only the
      // transaction's handle can do: the outer `listMembers` throws.
      const { deps, mocks } = makeDeps({
        members: [
          { humanId: ACTOR_ID, role: "OWNER" },
          { humanId: MEMBER_A, role: "ADMIN" },
          { humanId: MEMBER_B, role: "EDITOR" },
        ],
      });

      const result = await deleteOrg(deps, {
        actorHumanId: ACTOR_ID,
        orgId: ORG_ID,
      });

      expect(result.archivedMemberCount).toBe(3);
      expect(mocks.outer.organizations!.listMembers).not.toHaveBeenCalled();
      expect(mocks.organizationsRepo.listMembers).toHaveBeenCalledTimes(1);
      expect(
        mocks.organizationsRepo.lockOwnerRoster.mock.invocationCallOrder[0]!,
      ).toBeLessThan(
        mocks.organizationsRepo.listMembers.mock.invocationCallOrder[0]!,
      );
      expect(mocks.organizationsRepo.removeMember).toHaveBeenCalledWith({
        orgId: ORG_ID,
        humanId: MEMBER_B,
      });
      const orgsJoinedSubjects = mocks.quotasRepo.incrementUsage.mock.calls
        .filter((c: any[]) => c[0].kind === "ORGS_JOINED")
        .map((c: any[]) => c[0].subjectId);
      expect(orgsJoinedSubjects).toEqual([ACTOR_ID, MEMBER_A, MEMBER_B]);
    });
  });

  it("throws not_found when the org does not exist", async () => {
    const { deps, mocks } = makeDeps();
    mocks.outerOrganizationsRepo.getById.mockResolvedValueOnce(null);

    await expect(
      deleteOrg(deps, { actorHumanId: ACTOR_ID, orgId: ORG_ID }),
    ).rejects.toMatchObject({ code: "ORG_NOT_FOUND" });
  });

  it("throws conflict when the org is already archived", async () => {
    const { deps } = makeDeps({ orgStatus: "ARCHIVED" });

    await expect(
      deleteOrg(deps, { actorHumanId: ACTOR_ID, orgId: ORG_ID }),
    ).rejects.toMatchObject({ code: "ORG_ALREADY_ARCHIVED" });
  });

  it("throws conflict when the org has active events", async () => {
    const { deps } = makeDeps({ activeEventCount: 1 });

    await expect(
      deleteOrg(deps, { actorHumanId: ACTOR_ID, orgId: ORG_ID }),
    ).rejects.toMatchObject({ code: "ORG_HAS_ACTIVE_EVENTS" });
  });

  it("throws when actor is not an owner", async () => {
    const { deps } = makeDeps({
      authzError: { code: "forbidden", message: "insufficient_role" },
    });

    await expect(
      deleteOrg(deps, { actorHumanId: ACTOR_ID, orgId: ORG_ID }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("handles an org whose only member is its owner", async () => {
    const { deps, mocks } = makeDeps({
      members: [{ humanId: ACTOR_ID, role: "OWNER" }],
    });

    const result = await deleteOrg(deps, {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
    });

    expect(result.ok).toBe(true);
    expect(result.archivedMemberCount).toBe(1);

    // The owner's own row is the only one removed.
    expect(mocks.organizationsRepo.removeMember).toHaveBeenCalledTimes(1);
    expect(mocks.organizationsRepo.removeMember).toHaveBeenCalledWith({
      orgId: ORG_ID,
      humanId: ACTOR_ID,
    });

    // ORGS_OWNED still decremented for the actor.
    const orgsOwnedCalls = mocks.quotasRepo.incrementUsage.mock.calls.filter(
      (c: any[]) => c[0].kind === "ORGS_OWNED",
    );
    expect(orgsOwnedCalls).toHaveLength(1);
    expect(orgsOwnedCalls[0][0].delta).toBe(-1n);
  });
});
