import { describe, expect, it, vi } from "vitest";

import {
  acceptInvitation,
  type AcceptInvitationDeps,
} from "../accept-invitation";
import type { Repos, TxRepos } from "@th/ports/repos";
import type {
  OrganizationRecord,
  OrgInvitationRecord,
} from "@th/types/repos/organizations";

import { expectOuterHandleUnused, makeOuterHandle } from "./outer-handle";

const ACTOR_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const VALID_TOKEN = "valid-token-abc123";
const INVITER_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function makeInvitation(
  overrides: Partial<OrgInvitationRecord> = {},
): OrgInvitationRecord {
  return {
    id: "inv-1",
    orgId: ORG_ID,
    email: "invitee@example.com",
    role: "EDITOR",
    invitedByHumanId: INVITER_ID,
    token: VALID_TOKEN,
    status: "PENDING",
    expiresAt: new Date("2026-03-01T00:00:00.000Z"),
    acceptedAt: null,
    acceptedByHumanId: null,
    createdAt: new Date("2026-02-22T00:00:00.000Z"),
    ...overrides,
  };
}

type MakeDepsOptions = {
  invitation?: OrgInvitationRecord | null;
  existingMembership?: { orgId: string; humanId: string; role: string } | null;
  orgStatus?: OrganizationRecord["status"];
  actorEmail?: string;
  emailVerified?: boolean;
  /** The inviter's membership row today. Defaults to ADMIN; null = removed. */
  inviterRole?: OrgInvitationRecord["role"] | null;
  /**
   * What the token resolves to once the roster lock is held, when that
   * differs from the first read (a demotion, a re-invite or the org's
   * deletion committed while the accept waited). null = the token no longer
   * exists.
   */
  invitationAfterLock?: OrgInvitationRecord | null;
};

function makeDeps(options: MakeDepsOptions = {}) {
  const inviterRole = "inviterRole" in options ? options.inviterRole : "ADMIN";

  // These mocks are the transaction's handle only: `repos.tx` passes them to
  // its callback and nothing else reaches them.
  let locked = false;

  const organizationsRepoImpl = {
    lockOwnerRoster: vi.fn(async () => {
      locked = true;
    }),
    getById: vi.fn(
      async () =>
        ({
          id: ORG_ID,
          name: "Test Org",
          slug: "test-org",
          status: options.orgStatus ?? "ACTIVE",
        }) satisfies OrganizationRecord,
    ),
    addMember: vi.fn(async () => ({ created: true, previousRole: null })),
    getInvitationByToken: vi.fn(async () => {
      if (locked && "invitationAfterLock" in options) {
        return options.invitationAfterLock ?? null;
      }
      return options.invitation === null
        ? null
        : (options.invitation ?? makeInvitation());
    }),
    updateInvitationStatus: vi.fn(
      async (input: { id: string; status: string }) => ({
        ...makeInvitation(),
        status: input.status,
      }),
    ),
    createInvitation: vi.fn(),
    getInvitationByOrgAndEmail: vi.fn(),
    listInvitations: vi.fn(),
    create: vi.fn(),
    countMembersByRole: vi.fn(),
    listActive: vi.fn(),
    listMembers: vi.fn(),
    removeMember: vi.fn(),
  };
  const organizationsRepo =
    organizationsRepoImpl as unknown as TxRepos["organizations"];

  const auditRepoImpl = {
    log: vi.fn(async () => {}),
  };
  const auditRepo = auditRepoImpl as unknown as TxRepos["audit"];

  const authzRepoImpl = {
    getOrgMembership: vi.fn(
      async (input: { orgId: string; humanId: string }) => {
        if (input.orgId !== ORG_ID) return null;
        if (input.humanId === INVITER_ID) {
          return inviterRole
            ? { orgId: ORG_ID, humanId: INVITER_ID, role: inviterRole }
            : null;
        }
        return options.existingMembership ?? null;
      },
    ),
    getEventOrgId: vi.fn(),
    getPlaceAccessContext: vi.fn(),
    isPlaceVerifiedForOrg: vi.fn(),
    getStaffRolesForHumanId: vi.fn(async () => []),
  };
  const authzRepo = authzRepoImpl as unknown as TxRepos["authz"];

  const txRepos = {
    organizations: organizationsRepo,
    audit: auditRepo,
    authz: authzRepo,
    humans: {
      getByIdWithIdentity: vi.fn(async (id: string) => ({
        human: { id, name: "Ivy Invitee" },
        identity: {
          email: options.actorEmail ?? "invitee@example.com",
          emailVerified: options.emailVerified ?? true,
        },
      })),
    } as unknown as TxRepos["humans"],
    featuredEvents: {} as TxRepos["featuredEvents"],
    eventApplications: {} as TxRepos["eventApplications"],
    eventWaitlists: {} as TxRepos["eventWaitlists"],
    inviteLists: {} as TxRepos["inviteLists"],
    contactImports: {} as TxRepos["contactImports"],
    events: {} as TxRepos["events"],
    images: {} as TxRepos["images"],
    audioUploads: {} as TxRepos["audioUploads"],
    eventUnlocks: {} as TxRepos["eventUnlocks"],
    eventInvites: {} as TxRepos["eventInvites"],
    orders: {} as TxRepos["orders"],
    tickets: {} as TxRepos["tickets"],
    pendingTicketTransfers: {} as TxRepos["pendingTicketTransfers"],
    seats: {} as TxRepos["seats"],
    payoutTerms: {} as TxRepos["payoutTerms"],
    feePolicies: {} as TxRepos["feePolicies"],
    promos: {} as TxRepos["promos"],
    splits: {} as TxRepos["splits"],
    payees: {} as TxRepos["payees"],
    settlements: {} as TxRepos["settlements"],
    resaleListings: {} as TxRepos["resaleListings"],
    claims: {} as TxRepos["claims"],
    idempotency: {} as TxRepos["idempotency"],
    apiKeys: {} as TxRepos["apiKeys"],
    places: {} as TxRepos["places"],
    placeVerificationRequests: {} as TxRepos["placeVerificationRequests"],
    placeVerificationDocuments: {} as TxRepos["placeVerificationDocuments"],
    savedLocations: {} as TxRepos["savedLocations"],
    entityPages: {} as TxRepos["entityPages"],
    categories: {} as TxRepos["categories"],
    eventTemplates: {} as TxRepos["eventTemplates"],
    eventHumans: {} as TxRepos["eventHumans"],
    humanDelegates: {} as TxRepos["humanDelegates"],
    series: {} as TxRepos["series"],
    seriesOccurrences: {} as TxRepos["seriesOccurrences"],
    pushDevices: {} as TxRepos["pushDevices"],
    notificationPrefs: {} as TxRepos["notificationPrefs"],
    notificationDigests: {} as TxRepos["notificationDigests"],
    notifications: undefined as unknown as TxRepos["notifications"],
    placeLayouts: {} as TxRepos["placeLayouts"],
    placeLayoutBlobs: {} as TxRepos["placeLayoutBlobs"],
    placeLayoutStatuses: {} as TxRepos["placeLayoutStatuses"],
    orderItems: {} as TxRepos["orderItems"],
    orderItemSettlementLines: {} as TxRepos["orderItemSettlementLines"],
    settlementLines: {} as TxRepos["settlementLines"],
    payouts: {} as TxRepos["payouts"],
    analytics: {} as TxRepos["analytics"],
    embeds: {} as TxRepos["embeds"],
    platformSettings: {} as TxRepos["platformSettings"],
    payoutItems: {} as TxRepos["payoutItems"],
    placeWaivers: {} as TxRepos["placeWaivers"],
    tags: {} as TxRepos["tags"],
    announcements: {} as TxRepos["announcements"],
    volunteering: {} as TxRepos["volunteering"],
    resourceQuotas: {
      getEffectiveQuota: vi.fn(async () => ({
        kind: "ORGS_JOINED",
        limitValue: 10n,
        currentUsage: 0n,
        isOverride: false,
      })),
      hasPendingExpansionRequest: vi.fn(async () => false),
      incrementUsage: vi.fn(async () => ({ currentUsage: 1n })),
      getDefaultLimit: vi.fn(),
      listDefaultLimits: vi.fn(),
      upsertDefaultLimit: vi.fn(),
      getOverride: vi.fn(),
      upsertOverride: vi.fn(),
      getUsage: vi.fn(),
      getExpansionRequestById: vi.fn(),
      createExpansionRequest: vi.fn(),
      reviewExpansionRequest: vi.fn(),
      listExpansionRequests: vi.fn(),
    } satisfies Record<
      keyof TxRepos["resourceQuotas"],
      unknown
    > as unknown as TxRepos["resourceQuotas"],
    eventTypes: {} as TxRepos["eventTypes"],
    waiverTemplates: {} as TxRepos["waiverTemplates"],
    waiverAcceptances: {} as TxRepos["waiverAcceptances"],
  } satisfies TxRepos;

  // The use case reads and writes nothing outside its transaction.
  const outer = makeOuterHandle(
    txRepos as unknown as Record<string, Record<string, unknown>>,
  );

  const repos = {
    ...outer,
    tx: async <T>(fn: (tx: TxRepos) => Promise<T>) => fn(txRepos),
  } as unknown as Repos;

  const clock = { now: () => new Date("2026-02-22T12:00:00.000Z") };

  const deps: AcceptInvitationDeps = {
    repos,
    clock,
    logger: undefined,
  };

  return {
    deps,
    organizationsRepo: organizationsRepoImpl,
    auditRepo: auditRepoImpl,
    authzRepo: authzRepoImpl,
    outer,
  };
}

describe("acceptInvitation", () => {
  it("accepts a valid pending invitation", async () => {
    const { deps, organizationsRepo, auditRepo } = makeDeps();

    const result = await acceptInvitation(deps, {
      actorHumanId: ACTOR_ID,
      token: VALID_TOKEN,
    });

    expect(result.orgId).toBe(ORG_ID);
    expect(result.orgName).toBe("Test Org");
    expect(result.role).toBe("EDITOR");
    expect(organizationsRepo.addMember).toHaveBeenCalledWith({
      orgId: ORG_ID,
      humanId: ACTOR_ID,
      role: "EDITOR",
      addedAt: expect.any(Date),
    });
    expect(organizationsRepo.updateInvitationStatus).toHaveBeenCalledWith({
      id: "inv-1",
      status: "ACCEPTED",
      acceptedAt: expect.any(Date),
      acceptedByHumanId: ACTOR_ID,
    });
    expect(auditRepo.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "org.invitation_accepted",
      }),
    );
  });

  it("rejects when invitation not found", async () => {
    const { deps } = makeDeps({ invitation: null });

    await expect(
      acceptInvitation(deps, {
        actorHumanId: ACTOR_ID,
        token: "nonexistent-token",
      }),
    ).rejects.toMatchObject({ code: "INVITATION_NOT_FOUND" });
  });

  it("rejects when invitation is already accepted", async () => {
    const { deps } = makeDeps({
      invitation: makeInvitation({ status: "ACCEPTED" }),
    });

    await expect(
      acceptInvitation(deps, {
        actorHumanId: ACTOR_ID,
        token: VALID_TOKEN,
      }),
    ).rejects.toMatchObject({ code: "INVITATION_NOT_PENDING" });
  });

  it("rejects when invitation is expired", async () => {
    const { deps, organizationsRepo } = makeDeps({
      invitation: makeInvitation({
        expiresAt: new Date("2026-02-20T00:00:00.000Z"), // before clock.now()
      }),
    });

    await expect(
      acceptInvitation(deps, {
        actorHumanId: ACTOR_ID,
        token: VALID_TOKEN,
      }),
    ).rejects.toMatchObject({ code: "INVITATION_EXPIRED" });

    // The EXPIRED write is issued, but the throw that follows rolls the
    // transaction back: the stored status stays PENDING.
    expect(organizationsRepo.updateInvitationStatus).toHaveBeenCalledWith({
      id: "inv-1",
      status: "EXPIRED",
    });
  });

  it("handles already-a-member gracefully", async () => {
    const { deps, organizationsRepo } = makeDeps({
      existingMembership: { orgId: ORG_ID, humanId: ACTOR_ID, role: "ADMIN" },
    });

    const result = await acceptInvitation(deps, {
      actorHumanId: ACTOR_ID,
      token: VALID_TOKEN,
    });

    expect(result.role).toBe("ADMIN");
    expect(organizationsRepo.addMember).not.toHaveBeenCalled();
    expect(organizationsRepo.updateInvitationStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: "ACCEPTED" }),
    );
  });

  it("rejects when org is inactive", async () => {
    const { deps } = makeDeps({ orgStatus: "SUSPENDED" });

    await expect(
      acceptInvitation(deps, {
        actorHumanId: ACTOR_ID,
        token: VALID_TOKEN,
      }),
    ).rejects.toMatchObject({ code: "ORGANIZATION_INACTIVE" });
  });
  describe("consent gate: the signed-in account must own the invited email", () => {
    const input = { actorHumanId: ACTOR_ID, token: VALID_TOKEN };

    it("rejects an account with a different email and creates no membership", async () => {
      const { deps, organizationsRepo } = makeDeps({
        actorEmail: "victim@example.com",
      });
      await expect(acceptInvitation(deps, input)).rejects.toMatchObject({
        code: "INVITATION_NOT_FOUND",
      });
      expect(organizationsRepo.addMember).not.toHaveBeenCalled();
      expect(organizationsRepo.updateInvitationStatus).not.toHaveBeenCalled();
    });

    it("rejects the wrong account BEFORE revealing status (already-accepted token)", async () => {
      const { deps } = makeDeps({
        actorEmail: "victim@example.com",
        invitation: makeInvitation({ status: "ACCEPTED" }),
      });
      await expect(acceptInvitation(deps, input)).rejects.toMatchObject({
        code: "INVITATION_NOT_FOUND",
      });
    });

    it("rejects the matching account while its email is unverified", async () => {
      const { deps, organizationsRepo } = makeDeps({ emailVerified: false });
      await expect(acceptInvitation(deps, input)).rejects.toMatchObject({
        code: "EMAIL_NOT_VERIFIED",
      });
      expect(organizationsRepo.addMember).not.toHaveBeenCalled();
    });

    it("accepts the matching verified account (case/whitespace-insensitive)", async () => {
      const { deps, organizationsRepo } = makeDeps({
        actorEmail: "  Invitee@Example.COM ",
      });
      await expect(acceptInvitation(deps, input)).resolves.toMatchObject({
        orgId: ORG_ID,
        role: "EDITOR",
      });
      expect(organizationsRepo.addMember).toHaveBeenCalledWith(
        expect.objectContaining({ humanId: ACTOR_ID, role: "EDITOR" }),
      );
    });
  });

  describe("an OWNER invitation needs an inviter who holds OWNER today", () => {
    const input = { actorHumanId: ACTOR_ID, token: VALID_TOKEN };

    it("mints OWNER when the inviter is an OWNER", async () => {
      const { deps, organizationsRepo, auditRepo, authzRepo } = makeDeps({
        invitation: makeInvitation({ role: "OWNER" }),
        inviterRole: "OWNER",
      });

      await expect(acceptInvitation(deps, input)).resolves.toMatchObject({
        orgId: ORG_ID,
        role: "OWNER",
      });
      expect(authzRepo.getOrgMembership).toHaveBeenCalledWith({
        orgId: ORG_ID,
        humanId: INVITER_ID,
      });
      expect(organizationsRepo.addMember).toHaveBeenCalledWith({
        orgId: ORG_ID,
        humanId: ACTOR_ID,
        role: "OWNER",
        addedAt: expect.any(Date),
      });
      expect(auditRepo.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "org.invitation_accepted",
          data: expect.objectContaining({ role: "OWNER" }),
        }),
      );
    });

    it.each([
      ["an ADMIN sent it", "ADMIN"],
      ["the inviter was demoted to EDITOR", "EDITOR"],
      ["the inviter left the org", null],
    ] as const)("refuses when %s", async (_label, inviterRole) => {
      const { deps, organizationsRepo, auditRepo } = makeDeps({
        invitation: makeInvitation({ role: "OWNER" }),
        inviterRole,
      });

      await expect(acceptInvitation(deps, input)).rejects.toMatchObject({
        code: "INVITATION_NOT_PENDING",
        meta: { status: "REVOKED" },
      });
      expect(organizationsRepo.addMember).not.toHaveBeenCalled();
      expect(organizationsRepo.updateInvitationStatus).not.toHaveBeenCalled();
      expect(auditRepo.log).not.toHaveBeenCalled();
    });

    it("refuses an existing member too, and leaves the invitation unmarked", async () => {
      const { deps, organizationsRepo } = makeDeps({
        invitation: makeInvitation({ role: "OWNER" }),
        inviterRole: "ADMIN",
        existingMembership: { orgId: ORG_ID, humanId: ACTOR_ID, role: "EDITOR" },
      });

      await expect(acceptInvitation(deps, input)).rejects.toMatchObject({
        code: "INVITATION_NOT_PENDING",
      });
      expect(organizationsRepo.updateInvitationStatus).not.toHaveBeenCalled();
    });

    it("answers INVITATION_EXPIRED first for an expired OWNER invitation an ADMIN sent", async () => {
      const { deps, organizationsRepo } = makeDeps({
        invitation: makeInvitation({
          role: "OWNER",
          expiresAt: new Date("2026-02-20T00:00:00.000Z"), // before clock.now()
        }),
        inviterRole: "ADMIN",
      });

      await expect(acceptInvitation(deps, input)).rejects.toMatchObject({
        code: "INVITATION_EXPIRED",
      });
      expect(organizationsRepo.addMember).not.toHaveBeenCalled();
    });

    it("still answers INVITATION_NOT_FOUND to an account the invitation was not sent to", async () => {
      const { deps } = makeDeps({
        invitation: makeInvitation({ role: "OWNER" }),
        inviterRole: "ADMIN",
        actorEmail: "victim@example.com",
      });

      await expect(acceptInvitation(deps, input)).rejects.toMatchObject({
        code: "INVITATION_NOT_FOUND",
      });
    });

    it.each(["ADMIN", "EDITOR", "VIEWER", "FINANCE", "SCANNER"] as const)(
      "honours a %s invitation whose inviter has since left the org",
      async (role) => {
        const { deps, organizationsRepo } = makeDeps({
          invitation: makeInvitation({ role }),
          inviterRole: null,
        });

        await expect(acceptInvitation(deps, input)).resolves.toMatchObject({
          role,
        });
        expect(organizationsRepo.addMember).toHaveBeenCalledWith(
          expect.objectContaining({ humanId: ACTOR_ID, role }),
        );
      },
    );
  });

  describe("owner roster lock", () => {
    const input = { actorHumanId: ACTOR_ID, token: VALID_TOKEN };

    it("is taken for an OWNER invitation, on the transaction's handle, before the invitation is re-read and the inviter is read", async () => {
      const { deps, organizationsRepo, authzRepo, outer } = makeDeps({
        invitation: makeInvitation({ role: "OWNER" }),
        inviterRole: "OWNER",
      });

      await acceptInvitation(deps, input);

      expect(organizationsRepo.lockOwnerRoster).toHaveBeenCalledTimes(1);
      expect(organizationsRepo.lockOwnerRoster).toHaveBeenCalledWith(ORG_ID);
      expectOuterHandleUnused(outer);
      const lockedAt =
        organizationsRepo.lockOwnerRoster.mock.invocationCallOrder[0]!;
      // Read once to find the org, once more under the lock.
      const tokenReads =
        organizationsRepo.getInvitationByToken.mock.invocationCallOrder;
      expect(tokenReads).toHaveLength(2);
      expect(tokenReads[0]!).toBeLessThan(lockedAt);
      expect(lockedAt).toBeLessThan(tokenReads[1]!);
      for (const at of [
        ...authzRepo.getOrgMembership.mock.invocationCallOrder,
        ...organizationsRepo.addMember.mock.invocationCallOrder,
        ...organizationsRepo.updateInvitationStatus.mock.invocationCallOrder,
      ]) {
        expect(lockedAt).toBeLessThan(at);
      }
    });

    it("refuses when the sender's demotion revoked the invitation while the accept waited for the lock", async () => {
      const { deps, organizationsRepo, auditRepo } = makeDeps({
        invitation: makeInvitation({ role: "OWNER" }),
        // The row the first read saw is PENDING and its sender was an OWNER.
        inviterRole: "OWNER",
        invitationAfterLock: makeInvitation({
          role: "OWNER",
          status: "REVOKED",
        }),
      });

      await expect(acceptInvitation(deps, input)).rejects.toMatchObject({
        code: "INVITATION_NOT_PENDING",
        meta: { status: "REVOKED" },
      });
      expect(organizationsRepo.addMember).not.toHaveBeenCalled();
      expect(organizationsRepo.updateInvitationStatus).not.toHaveBeenCalled();
      expect(auditRepo.log).not.toHaveBeenCalled();
    });

    it("answers INVITATION_NOT_FOUND when a re-invite replaced the token while the accept waited", async () => {
      const { deps, organizationsRepo } = makeDeps({
        invitation: makeInvitation({ role: "OWNER" }),
        inviterRole: "OWNER",
        invitationAfterLock: null,
      });

      await expect(acceptInvitation(deps, input)).rejects.toMatchObject({
        code: "INVITATION_NOT_FOUND",
      });
      expect(organizationsRepo.addMember).not.toHaveBeenCalled();
    });

    it.each(["ADMIN", "EDITOR", "VIEWER", "FINANCE", "SCANNER"] as const)(
      "is taken for a %s invitation too, before the invitation is re-read and any membership is read or written",
      async (role) => {
        const { deps, organizationsRepo, authzRepo, outer } = makeDeps({
          invitation: makeInvitation({ role }),
        });

        await acceptInvitation(deps, input);

        expect(organizationsRepo.lockOwnerRoster).toHaveBeenCalledTimes(1);
        expect(organizationsRepo.lockOwnerRoster).toHaveBeenCalledWith(ORG_ID);
        expectOuterHandleUnused(outer);
        const lockedAt =
          organizationsRepo.lockOwnerRoster.mock.invocationCallOrder[0]!;
        const tokenReads =
          organizationsRepo.getInvitationByToken.mock.invocationCallOrder;
        expect(tokenReads).toHaveLength(2);
        expect(tokenReads[0]!).toBeLessThan(lockedAt);
        expect(lockedAt).toBeLessThan(tokenReads[1]!);
        for (const at of [
          ...authzRepo.getOrgMembership.mock.invocationCallOrder,
          ...organizationsRepo.addMember.mock.invocationCallOrder,
          ...organizationsRepo.updateInvitationStatus.mock.invocationCallOrder,
        ]) {
          expect(lockedAt).toBeLessThan(at);
        }
        // The sender's role matters for an OWNER invitation only.
        expect(authzRepo.getOrgMembership).not.toHaveBeenCalledWith(
          expect.objectContaining({ humanId: INVITER_ID }),
        );
      },
    );

    it.each(["ADMIN", "EDITOR", "VIEWER", "FINANCE", "SCANNER"] as const)(
      "refuses a %s invitation that the org's deletion revoked while the accept waited for the lock",
      async (role) => {
        const { deps, organizationsRepo, auditRepo } = makeDeps({
          invitation: makeInvitation({ role }),
          invitationAfterLock: makeInvitation({ role, status: "REVOKED" }),
        });

        await expect(acceptInvitation(deps, input)).rejects.toMatchObject({
          code: "INVITATION_NOT_PENDING",
          meta: { status: "REVOKED" },
        });
        expect(organizationsRepo.addMember).not.toHaveBeenCalled();
        expect(organizationsRepo.updateInvitationStatus).not.toHaveBeenCalled();
        expect(auditRepo.log).not.toHaveBeenCalled();
      },
    );

    it("answers INVITATION_NOT_FOUND for a non-OWNER invitation whose token a re-invite replaced while the accept waited", async () => {
      const { deps, organizationsRepo } = makeDeps({
        invitation: makeInvitation({ role: "EDITOR" }),
        invitationAfterLock: null,
      });

      await expect(acceptInvitation(deps, input)).rejects.toMatchObject({
        code: "INVITATION_NOT_FOUND",
      });
      expect(organizationsRepo.addMember).not.toHaveBeenCalled();
    });

    it("takes no lock for an accept refused before it: wrong account, used, expired, inactive org", async () => {
      const refused = [
        makeDeps({ actorEmail: "victim@example.com" }),
        makeDeps({ invitation: makeInvitation({ status: "ACCEPTED" }) }),
        makeDeps({
          invitation: makeInvitation({
            expiresAt: new Date("2026-02-01T00:00:00.000Z"),
          }),
        }),
        makeDeps({ orgStatus: "SUSPENDED" }),
      ];
      for (const { deps, organizationsRepo } of refused) {
        await expect(acceptInvitation(deps, input)).rejects.toBeDefined();
        expect(organizationsRepo.lockOwnerRoster).not.toHaveBeenCalled();
      }
    });
  });
});
