import { describe, expect, it, vi } from "vitest";

import {
  inviteMember,
  ORG_INVITE_DAILY_MAX,
  ORG_INVITE_DAILY_WINDOW_SECONDS,
  tokenFingerprint,
  type InviteMemberDeps,
} from "../invite-member";
import type { AuthZPort } from "@th/ports/authz";
import type { MailerPort } from "@th/ports/comms/mailer";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { OrganizationRecord } from "@th/ports/repos/organizations";
import type { OrgInvitationRecord } from "@th/types/repos/organizations";

import { expectOuterHandleUnused, makeOuterHandle } from "./outer-handle";

const ACTOR_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TARGET_EMAIL = "newhire@example.com";
const EXISTING_HUMAN_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const STORED_INVITER_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

type MakeDepsOptions = {
  existingHuman?: { id: string; email: string; name: string | null } | null;
  existingMembership?: { orgId: string; humanId: string; role: string } | null;
  orgStatus?: OrganizationRecord["status"];
  authzError?: unknown;
  /**
   * The actor's own membership row as the transaction reads it. Defaults to
   * ADMIN; null = not a member.
   */
  actorRole?: OrgInvitationRecord["role"] | null;
  /**
   * The actor's row as the OWNER check before the transaction reads it, when
   * the role changed in between. Defaults to `actorRole`.
   */
  actorRoleAtEarlyCheck?: OrgInvitationRecord["role"] | null;
  /** The invitation already stored for this org and email, if any. */
  storedInvitation?:
    | (Pick<OrgInvitationRecord, "role" | "status"> & { expiresAt?: Date })
    | null;
  /** The stored invitation's sender today. Defaults to OWNER; null = removed. */
  storedInviterRole?: OrgInvitationRecord["role"] | null;
};

function makeDeps(options: MakeDepsOptions = {}) {
  const invitationStore: OrgInvitationRecord[] = [];
  const actorRole = "actorRole" in options ? options.actorRole : "ADMIN";
  const actorRoleAtEarlyCheck =
    "actorRoleAtEarlyCheck" in options
      ? options.actorRoleAtEarlyCheck
      : actorRole;
  const storedInviterRole =
    "storedInviterRole" in options ? options.storedInviterRole : "OWNER";

  // `organizationsRepoImpl`, `auditRepoImpl`, `authzRepoImpl` and
  // `humansRepoImpl` are the transaction's handle only: `repos.tx` passes
  // them to its callback and nothing else reaches them.
  const organizationsRepoImpl = {
    lockOwnerRoster: vi.fn(async () => {}),
    getById: vi.fn(
      async () =>
        ({
          id: ORG_ID,
          name: "Test Org",
          slug: "test-org",
          status: options.orgStatus ?? "ACTIVE",
        }) satisfies OrganizationRecord,
    ),
    create: vi.fn(),
    addMember: vi.fn(async () => ({ created: true, previousRole: null })),
    isMemberByEmail: vi.fn(async () => Boolean(options.existingMembership)),
    countMembersByRole: vi.fn(async () => 1),
    listActive: vi.fn(),
    listMembers: vi.fn(),
    removeMember: vi.fn(),
    createInvitation: vi.fn(
      async (input: {
        orgId: string;
        email: string;
        role: string;
        invitedByHumanId: string;
        token: string;
        expiresAt: Date;
      }) => {
        const inv: OrgInvitationRecord = {
          id: "inv-" + Math.random().toString(36).slice(2, 10),
          orgId: input.orgId,
          email: input.email,
          role: input.role as OrgInvitationRecord["role"],
          invitedByHumanId: input.invitedByHumanId,
          token: input.token,
          status: "PENDING",
          expiresAt: input.expiresAt,
          acceptedAt: null,
          acceptedByHumanId: null,
          createdAt: new Date("2026-02-22T00:00:00.000Z"),
        };
        invitationStore.push(inv);
        return inv;
      },
    ),
    getInvitationByToken: vi.fn(),
    getInvitationByOrgAndEmail: vi.fn(async (orgId: string, email: string) =>
      options.storedInvitation && orgId === ORG_ID && email === TARGET_EMAIL
        ? {
            id: "inv-stored",
            orgId: ORG_ID,
            email: TARGET_EMAIL,
            invitedByHumanId: STORED_INVITER_ID,
            token: "stored-token",
            expiresAt: new Date("2026-02-25T00:00:00.000Z"),
            acceptedAt: null,
            acceptedByHumanId: null,
            createdAt: new Date("2026-02-18T00:00:00.000Z"),
            ...options.storedInvitation,
          }
        : null,
    ),
    listInvitations: vi.fn(),
    updateInvitationStatus: vi.fn(),
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
        if (input.humanId === ACTOR_ID) {
          return actorRole
            ? { orgId: ORG_ID, humanId: ACTOR_ID, role: actorRole }
            : null;
        }
        if (input.humanId === STORED_INVITER_ID) {
          return storedInviterRole
            ? {
                orgId: ORG_ID,
                humanId: STORED_INVITER_ID,
                role: storedInviterRole,
              }
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

  const humansRepoImpl = {
    getById: vi.fn(),
    getByEmail: vi.fn(async () => {
      if (!options.existingHuman) return null;
      return {
        human: {
          id: options.existingHuman.id,
          name: options.existingHuman.name,
          status: "ACTIVE",
          roles: [],
          locale: null,
        },
        identity: {
          email: options.existingHuman.email,
          emailVerified: true,
          phone: null,
          phoneVerified: false,
        },
      };
    }),
    getByPhone: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    ensureByProvider: vi.fn(),
  };
  const humansRepo = humansRepoImpl as unknown as TxRepos["humans"];

  const txRepos = {
    organizations: organizationsRepo,
    audit: auditRepo,
    authz: authzRepo,
    humans: humansRepo,
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
        kind: "MEMBERS_PER_ORG",
        limitValue: 25n,
        currentUsage: 0n,
        isOverride: false,
      })),
      hasPendingExpansionRequest: vi.fn(async () => false),
      incrementUsage: vi.fn(async (input: any) => ({
        id: "usage-1",
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        kind: input.kind,
        currentUsage: 1n,
        updatedAt: new Date(),
        createdAt: new Date(),
      })),
      getDefaultLimit: vi.fn(async () => null),
      listDefaultLimits: vi.fn(async () => []),
      upsertDefaultLimit: vi.fn(),
      getOverride: vi.fn(async () => null),
      upsertOverride: vi.fn(),
      getUsage: vi.fn(async () => null),
      getExpansionRequestById: vi.fn(async () => null),
      createExpansionRequest: vi.fn(),
      reviewExpansionRequest: vi.fn(),
      listExpansionRequests: vi.fn(async () => ({ items: [], total: 0 })),
    } satisfies Record<keyof TxRepos["resourceQuotas"], unknown>,
    eventTypes: {} as TxRepos["eventTypes"],
    waiverTemplates: {} as TxRepos["waiverTemplates"],
    waiverAcceptances: {} as TxRepos["waiverAcceptances"],
  } satisfies TxRepos;

  // What the use case reads outside its transaction: the member lookup, the
  // early OWNER check for an invite at OWNER, and the inviter's name for the
  // email. Every other method on the outer handle throws.
  const outerOrganizationsRepo = {
    isMemberByEmail: vi.fn(async () => Boolean(options.existingMembership)),
  };
  const outerAuthzRepo = {
    getOrgMembership: vi.fn(
      async (input: { orgId: string; humanId: string }) =>
        input.orgId === ORG_ID &&
        input.humanId === ACTOR_ID &&
        actorRoleAtEarlyCheck
          ? { orgId: ORG_ID, humanId: ACTOR_ID, role: actorRoleAtEarlyCheck }
          : null,
    ),
  };
  const outerHumansRepo = { getById: vi.fn() };
  const outer = makeOuterHandle(
    txRepos as unknown as Record<string, Record<string, unknown>>,
    {
      organizations: outerOrganizationsRepo,
      authz: outerAuthzRepo,
      humans: outerHumansRepo,
    },
  );

  const repos = {
    ...outer,
    tx: async <T>(fn: (tx: TxRepos) => Promise<T>) => fn(txRepos),
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

  const clock = { now: () => new Date("2026-02-22T00:00:00.000Z") };

  const deps: InviteMemberDeps = {
    repos,
    authz,
    clock,
    logger: undefined,
  };

  return {
    deps,
    organizationsRepo: organizationsRepoImpl,
    auditRepo: auditRepoImpl,
    authzRepo: authzRepoImpl,
    humansRepo: humansRepoImpl,
    outerOrganizationsRepo,
    outerAuthzRepo,
    outerHumansRepo,
    outer,
    invitationStore,
  };
}

describe("inviteMember", () => {
  it("creates a pending invitation when email has no account", async () => {
    const { deps, organizationsRepo, auditRepo, invitationStore } = makeDeps();

    const result = await inviteMember(deps, {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
      email: TARGET_EMAIL,
      role: "EDITOR",
    });

    expect(result.addedDirectly).toBe(false);
    expect(result.invitation.email).toBe(TARGET_EMAIL);
    expect(result.invitation.role).toBe("EDITOR");
    expect(result.invitation.status).toBe("PENDING");
    expect(organizationsRepo.createInvitation).toHaveBeenCalledTimes(1);
    expect(auditRepo.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "org.invitation_sent",
        data: expect.objectContaining({
          email: TARGET_EMAIL,
          role: "EDITOR",
        }),
      }),
    );
  });

  it("sends a PENDING invitation (never a direct add) when the email already has an account", async () => {
    const { deps, organizationsRepo, auditRepo, invitationStore } = makeDeps({
      existingHuman: {
        id: EXISTING_HUMAN_ID,
        email: TARGET_EMAIL,
        name: "Jane",
      },
    });

    const result = await inviteMember(deps, {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
      email: TARGET_EMAIL,
      role: "VIEWER",
    });

    expect(result.addedDirectly).toBe(false);
    expect(result.invitation.status).toBe("PENDING");
    expect(organizationsRepo.createInvitation).toHaveBeenCalledTimes(1);
    expect(invitationStore).toHaveLength(1);
    // No membership, no quota consumption on the target: both happen only in
    // acceptInvitation, on the invitee's own action (F3/F10).
    expect(organizationsRepo.addMember).not.toHaveBeenCalled();
    const quotas = (deps.repos as unknown as {
      resourceQuotas: { incrementUsage: ReturnType<typeof vi.fn> };
    }).resourceQuotas;
    expect(quotas.incrementUsage).not.toHaveBeenCalled();
    expect(auditRepo.log).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "org.member_added" }),
    );
  });

  it("returns the same response shape whether or not the email has an account (no existence oracle)", async () => {
    const withAccount = makeDeps({
      existingHuman: {
        id: EXISTING_HUMAN_ID,
        email: TARGET_EMAIL,
        name: "Jane",
      },
    });
    const withoutAccount = makeDeps();
    const input = {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
      email: TARGET_EMAIL,
      role: "EDITOR",
    };

    const a = await inviteMember(withAccount.deps, input);
    const b = await inviteMember(withoutAccount.deps, input);

    // Only the random invitation id differs.
    const strip = (r: typeof a) => ({
      ...r,
      invitation: { ...r.invitation, id: "<id>" },
    });
    expect(strip(a)).toEqual(strip(b));
    expect(JSON.stringify(a)).not.toContain(EXISTING_HUMAN_ID);
  });

  it("rejects when existing user is already a member", async () => {
    const { deps } = makeDeps({
      existingHuman: {
        id: EXISTING_HUMAN_ID,
        email: TARGET_EMAIL,
        name: "Jane",
      },
      existingMembership: {
        orgId: ORG_ID,
        humanId: EXISTING_HUMAN_ID,
        role: "VIEWER",
      },
    });

    await expect(
      inviteMember(deps, {
        actorHumanId: ACTOR_ID,
        orgId: ORG_ID,
        email: TARGET_EMAIL,
        role: "EDITOR",
      }),
    ).rejects.toMatchObject({ code: "ALREADY_A_MEMBER" });
  });

  it("rejects when actor lacks required role", async () => {
    const forbiddenError = {
      code: "forbidden",
      message: "insufficient_role",
    } as const;
    const { deps, organizationsRepo } = makeDeps({
      authzError: forbiddenError,
    });

    await expect(
      inviteMember(deps, {
        actorHumanId: ACTOR_ID,
        orgId: ORG_ID,
        email: TARGET_EMAIL,
        role: "VIEWER",
      }),
    ).rejects.toMatchObject(forbiddenError);

    expect(organizationsRepo.createInvitation).not.toHaveBeenCalled();
  });

  it("rejects when org is inactive", async () => {
    const { deps } = makeDeps({ orgStatus: "SUSPENDED" });

    await expect(
      inviteMember(deps, {
        actorHumanId: ACTOR_ID,
        orgId: ORG_ID,
        email: TARGET_EMAIL,
        role: "VIEWER",
      }),
    ).rejects.toMatchObject({ code: "ORGANIZATION_INACTIVE" });
  });

  it("sets expiration 7 days from now", async () => {
    const { deps, invitationStore } = makeDeps();

    await inviteMember(deps, {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
      email: TARGET_EMAIL,
      role: "EDITOR",
    });

    expect(invitationStore).toHaveLength(1);
    const inv = invitationStore[0]!;
    const expectedExpiry = new Date("2026-03-01T00:00:00.000Z");
    expect(inv.expiresAt.getTime()).toBe(expectedExpiry.getTime());
  });

  it("sends invitation email when mailer is provided", async () => {
    const { deps, outerHumansRepo } = makeDeps();

    outerHumansRepo.getById.mockResolvedValueOnce({
      id: ACTOR_ID,
      name: "Alice Admin",
      status: "ACTIVE",
      roles: [],
      locale: null,
    });

    const mailer: MailerPort = {
      send: vi.fn(async () => ({ messageId: "msg-1", accepted: true })),
      sendBatch: vi.fn(),
      health: vi.fn(),
    };

    deps.mailer = mailer;
    deps.publicAppUrl = "https://ithasfire.com";

    const result = await inviteMember(deps, {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
      email: TARGET_EMAIL,
      role: "EDITOR",
    });

    expect(result.addedDirectly).toBe(false);
    expect(mailer.send).toHaveBeenCalledTimes(1);
    expect(mailer.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: { to: TARGET_EMAIL },
        template: expect.objectContaining({
          key: "org.invitation",
          variables: expect.objectContaining({
            orgName: "Test Org",
            role: "editor",
            inviterName: "Alice Admin",
            expiresInDays: 7,
          }),
        }),
        idempotencyKey: expect.stringContaining("org-invitation:"),
      }),
    );
  });

  it("does not send email when mailer is not provided", async () => {
    const { deps } = makeDeps();
    // Ensure no mailer is set (default)
    expect(deps.mailer).toBeUndefined();

    const result = await inviteMember(deps, {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
      email: TARGET_EMAIL,
      role: "EDITOR",
    });

    expect(result.addedDirectly).toBe(false);
    expect(result.invitation.status).toBe("PENDING");
  });

  it("does not throw when email sending fails", async () => {
    const { deps, outerHumansRepo } = makeDeps();

    outerHumansRepo.getById.mockResolvedValueOnce({
      id: ACTOR_ID,
      name: "Alice Admin",
      status: "ACTIVE",
      roles: [],
      locale: null,
    });

    const mailer: MailerPort = {
      send: vi.fn(async () => {
        throw new Error("SES unavailable");
      }),
      sendBatch: vi.fn(),
      health: vi.fn(),
    };

    deps.mailer = mailer;
    deps.publicAppUrl = "https://ithasfire.com";

    const result = await inviteMember(deps, {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
      email: TARGET_EMAIL,
      role: "EDITOR",
    });

    // Invitation is still created despite email failure
    expect(result.addedDirectly).toBe(false);
    expect(result.invitation.status).toBe("PENDING");
    expect(mailer.send).toHaveBeenCalledTimes(1);
  });
  it("never sets replyTo to the org's unverified contact email", async () => {
    const { deps, organizationsRepo } = makeDeps();
    organizationsRepo.getById.mockResolvedValueOnce({
      id: ORG_ID,
      name: "Test Org",
      slug: "test-org",
      status: "ACTIVE",
      contactEmail: "attacker-controlled@example.com",
    } as unknown as OrganizationRecord);

    const mailer: MailerPort = {
      send: vi.fn(async () => ({ messageId: "msg-1", accepted: true })),
      sendBatch: vi.fn(),
      health: vi.fn(),
    };
    deps.mailer = mailer;
    deps.publicAppUrl = "https://ithasfire.com";

    await inviteMember(deps, {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
      email: TARGET_EMAIL,
      role: "EDITOR",
    });

    const sent = (mailer.send as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(sent.replyTo).toBeUndefined();
    expect(JSON.stringify(sent)).not.toContain("attacker-controlled");
  });

  it("reports a swallowed email failure via reportError, and a throwing reporter changes nothing", async () => {
    const { deps } = makeDeps();
    const mailer: MailerPort = {
      send: vi.fn(async () => {
        throw new Error("SES unavailable");
      }),
      sendBatch: vi.fn(),
      health: vi.fn(),
    };
    deps.mailer = mailer;
    deps.publicAppUrl = "https://ithasfire.com";
    const reportError = vi.fn();
    deps.reportError = reportError;

    const result = await inviteMember(deps, {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
      email: TARGET_EMAIL,
      role: "EDITOR",
    });

    expect(result.invitation.status).toBe("PENDING");
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ useCase: "inviteMember" }),
      }),
    );

    deps.reportError = vi.fn(() => {
      throw new Error("reporter down");
    });
    await expect(
      inviteMember(deps, {
        actorHumanId: ACTOR_ID,
        orgId: ORG_ID,
        email: TARGET_EMAIL,
        role: "EDITOR",
      }),
    ).resolves.toMatchObject({ invitation: { status: "PENDING" } });
  });
  describe("per-org daily invitation cap", () => {
    const input = {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
      email: TARGET_EMAIL,
      role: "EDITOR",
    };

    it("consumes the org bucket after authz and rejects with RATE_LIMITED when exhausted", async () => {
      const { deps, organizationsRepo } = makeDeps();
      const consume = vi.fn(async () => ({
        allowed: false,
        remaining: 0,
        retryAfterSeconds: 3600,
      }));
      deps.rateLimit = { consume };

      await expect(inviteMember(deps, input)).rejects.toMatchObject({
        code: "RATE_LIMITED",
      });
      expect(consume).toHaveBeenCalledWith(
        `orgs:invite:org:${ORG_ID}`,
        ORG_INVITE_DAILY_MAX,
        ORG_INVITE_DAILY_WINDOW_SECONDS,
      );
      expect(organizationsRepo.createInvitation).not.toHaveBeenCalled();
    });

    it("does not consume the org bucket when the caller fails authz (no cross-org budget drain)", async () => {
      const { deps } = makeDeps({
        authzError: { code: "forbidden", message: "insufficient_role" },
      });
      const consume = vi.fn();
      deps.rateLimit = { consume };

      await expect(inviteMember(deps, input)).rejects.toMatchObject({
        code: "forbidden",
      });
      expect(consume).not.toHaveBeenCalled();
    });

    it("fails open (and reports) when the limiter throws", async () => {
      const { deps } = makeDeps();
      deps.rateLimit = {
        consume: vi.fn(async () => {
          throw new Error("redis down");
        }),
      };
      const reportError = vi.fn();
      deps.reportError = reportError;

      await expect(inviteMember(deps, input)).resolves.toMatchObject({
        invitation: { status: "PENDING" },
      });
      expect(reportError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          tags: expect.objectContaining({ area: "org_invite_daily_cap" }),
        }),
      );
    });
  });
  describe("only an OWNER invites at OWNER", () => {
    const input = {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
      email: TARGET_EMAIL,
      role: "OWNER",
    };

    it("refuses an ADMIN, before the member lookup and the daily cap", async () => {
      const { deps, organizationsRepo, outerOrganizationsRepo, auditRepo } =
        makeDeps({ actorRole: "ADMIN" });
      const consume = vi.fn();
      deps.rateLimit = { consume };
      const mailer: MailerPort = {
        send: vi.fn(),
        sendBatch: vi.fn(),
        health: vi.fn(),
      };
      deps.mailer = mailer;
      deps.publicAppUrl = "https://ithasfire.com";

      await expect(inviteMember(deps, input)).rejects.toMatchObject({
        code: "INSUFFICIENT_ROLE",
      });
      expect(organizationsRepo.createInvitation).not.toHaveBeenCalled();
      expect(organizationsRepo.lockOwnerRoster).not.toHaveBeenCalled();
      expect(outerOrganizationsRepo.isMemberByEmail).not.toHaveBeenCalled();
      expect(consume).not.toHaveBeenCalled();
      expect(auditRepo.log).not.toHaveBeenCalled();
      expect(mailer.send).not.toHaveBeenCalled();
    });

    it("refuses an actor with no membership row", async () => {
      // The port fake lets everyone through, so this is the literal-role read
      // refusing on its own.
      const { deps, organizationsRepo } = makeDeps({ actorRole: null });

      await expect(inviteMember(deps, input)).rejects.toMatchObject({
        code: "INSUFFICIENT_ROLE",
      });
      expect(organizationsRepo.createInvitation).not.toHaveBeenCalled();
    });

    it("lets an OWNER, and records them as the inviter", async () => {
      const { deps, organizationsRepo, auditRepo, authzRepo, outerAuthzRepo } =
        makeDeps({ actorRole: "OWNER" });

      const result = await inviteMember(deps, input);

      expect(result.invitation.role).toBe("OWNER");
      // Once before the transaction, once inside it.
      expect(outerAuthzRepo.getOrgMembership).toHaveBeenCalledTimes(1);
      expect(outerAuthzRepo.getOrgMembership).toHaveBeenCalledWith({
        orgId: ORG_ID,
        humanId: ACTOR_ID,
      });
      expect(authzRepo.getOrgMembership).toHaveBeenCalledTimes(1);
      expect(authzRepo.getOrgMembership).toHaveBeenCalledWith({
        orgId: ORG_ID,
        humanId: ACTOR_ID,
      });
      expect(organizationsRepo.createInvitation).toHaveBeenCalledWith(
        expect.objectContaining({
          role: "OWNER",
          invitedByHumanId: ACTOR_ID,
        }),
      );
      expect(auditRepo.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "org.invitation_sent",
          data: expect.objectContaining({ role: "OWNER" }),
        }),
      );
    });

    it.each(["ADMIN", "EDITOR", "VIEWER", "FINANCE", "SCANNER"] as const)(
      "leaves an ADMIN free to invite at %s",
      async (role) => {
        const { deps, organizationsRepo } = makeDeps({ actorRole: "ADMIN" });

        const result = await inviteMember(deps, { ...input, role });

        expect(result.invitation.role).toBe(role);
        expect(organizationsRepo.createInvitation).toHaveBeenCalledWith(
          expect.objectContaining({ role, invitedByHumanId: ACTOR_ID }),
        );
      },
    );
  });

  describe("a pending OWNER invitation is an OWNER's to replace", () => {
    const input = {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
      email: TARGET_EMAIL,
    };
    const pendingOwner = { role: "OWNER", status: "PENDING" } as const;

    it.each(["ADMIN", "EDITOR", "VIEWER", "FINANCE", "SCANNER"] as const)(
      "refuses an ADMIN re-inviting the address at %s",
      async (role) => {
        const { deps, organizationsRepo, auditRepo, authzRepo } = makeDeps({
          actorRole: "ADMIN",
          storedInvitation: pendingOwner,
        });
        const mailer: MailerPort = {
          send: vi.fn(),
          sendBatch: vi.fn(),
          health: vi.fn(),
        };
        deps.mailer = mailer;
        deps.publicAppUrl = "https://ithasfire.com";

        await expect(
          inviteMember(deps, { ...input, role }),
        ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
        expect(organizationsRepo.getInvitationByOrgAndEmail).toHaveBeenCalledWith(
          ORG_ID,
          TARGET_EMAIL,
        );
        expect(authzRepo.getOrgMembership).toHaveBeenCalledWith({
          orgId: ORG_ID,
          humanId: ACTOR_ID,
        });
        expect(organizationsRepo.createInvitation).not.toHaveBeenCalled();
        expect(auditRepo.log).not.toHaveBeenCalled();
        expect(mailer.send).not.toHaveBeenCalled();
      },
    );

    it.each(["OWNER", "EDITOR"] as const)(
      "lets an OWNER re-invite the address at %s",
      async (role) => {
        const { deps, organizationsRepo } = makeDeps({
          actorRole: "OWNER",
          storedInvitation: pendingOwner,
        });

        const result = await inviteMember(deps, { ...input, role });

        expect(result.invitation.role).toBe(role);
        expect(organizationsRepo.createInvitation).toHaveBeenCalledWith(
          expect.objectContaining({ role, invitedByHumanId: ACTOR_ID }),
        );
      },
    );

    it.each([
      ["a pending EDITOR invitation", { role: "EDITOR", status: "PENDING" }],
      ["a pending ADMIN invitation", { role: "ADMIN", status: "PENDING" }],
      ["a revoked OWNER invitation", { role: "OWNER", status: "REVOKED" }],
      ["an accepted OWNER invitation", { role: "OWNER", status: "ACCEPTED" }],
      [
        "an OWNER invitation past its expiry (still PENDING in the database)",
        {
          role: "OWNER",
          status: "PENDING",
          expiresAt: new Date("2026-02-21T00:00:00.000Z"), // before clock.now()
        },
      ],
    ] as const)("lets an ADMIN re-invite over %s", async (_label, stored) => {
      const { deps, organizationsRepo } = makeDeps({
        actorRole: "ADMIN",
        storedInvitation: stored,
      });

      const result = await inviteMember(deps, { ...input, role: "EDITOR" });

      expect(result.invitation.status).toBe("PENDING");
      expect(organizationsRepo.createInvitation).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["is an ADMIN", "ADMIN"],
      ["was demoted to EDITOR", "EDITOR"],
      ["left the org", null],
    ] as const)(
      "lets an ADMIN re-invite over a pending OWNER invitation whose sender %s",
      async (_label, storedInviterRole) => {
        const { deps, organizationsRepo, authzRepo } = makeDeps({
          actorRole: "ADMIN",
          storedInvitation: pendingOwner,
          storedInviterRole,
        });

        const result = await inviteMember(deps, { ...input, role: "EDITOR" });

        expect(result.invitation.role).toBe("EDITOR");
        expect(authzRepo.getOrgMembership).toHaveBeenCalledWith({
          orgId: ORG_ID,
          humanId: STORED_INVITER_ID,
        });
        expect(organizationsRepo.createInvitation).toHaveBeenCalledTimes(1);
      },
    );

    it("still refuses an ADMIN at OWNER over a lapsed OWNER invitation", async () => {
      const { deps, organizationsRepo } = makeDeps({
        actorRole: "ADMIN",
        storedInvitation: {
          ...pendingOwner,
          expiresAt: new Date("2026-02-21T00:00:00.000Z"),
        },
      });

      await expect(
        inviteMember(deps, { ...input, role: "OWNER" }),
      ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
      expect(organizationsRepo.createInvitation).not.toHaveBeenCalled();
    });

    it("looks the stored invitation up by org and email alone, with or without an account", async () => {
      const withAccount = makeDeps({
        existingHuman: {
          id: EXISTING_HUMAN_ID,
          email: TARGET_EMAIL,
          name: "Jane",
        },
      });
      const withoutAccount = makeDeps();

      for (const made of [withAccount, withoutAccount]) {
        await inviteMember(made.deps, { ...input, role: "EDITOR" });
        expect(
          made.organizationsRepo.getInvitationByOrgAndEmail,
        ).toHaveBeenCalledTimes(1);
        expect(
          made.organizationsRepo.getInvitationByOrgAndEmail,
        ).toHaveBeenCalledWith(ORG_ID, TARGET_EMAIL);
        expect(made.humansRepo.getByEmail).not.toHaveBeenCalled();
      }
    });
  });

  describe("owner roster lock", () => {
    const input = {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
      email: TARGET_EMAIL,
    };

    it.each(["EDITOR", "OWNER"] as const)(
      "is taken on the transaction's handle, before the actor's row, the org, the stored invitation and the upsert are touched (%s invite)",
      async (role) => {
        const { deps, organizationsRepo, authzRepo, auditRepo, outer } =
          makeDeps({ actorRole: "OWNER" });

        await inviteMember(deps, { ...input, role });

        expect(organizationsRepo.lockOwnerRoster).toHaveBeenCalledTimes(1);
        expect(organizationsRepo.lockOwnerRoster).toHaveBeenCalledWith(ORG_ID);
        // The outer handle answered its three reads and nothing else: no
        // lock, no stored-invitation read, no upsert, no audit row.
        expectOuterHandleUnused(outer);
        const lockedAt =
          organizationsRepo.lockOwnerRoster.mock.invocationCallOrder[0]!;
        expect(authzRepo.getOrgMembership).toHaveBeenCalled();
        for (const at of [
          ...authzRepo.getOrgMembership.mock.invocationCallOrder,
          ...organizationsRepo.getById.mock.invocationCallOrder,
          ...organizationsRepo.getInvitationByOrgAndEmail.mock
            .invocationCallOrder,
          ...organizationsRepo.createInvitation.mock.invocationCallOrder,
          ...auditRepo.log.mock.invocationCallOrder,
        ]) {
          expect(lockedAt).toBeLessThan(at);
        }
      },
    );

    it("checks an OWNER invite's actor again after the lock", async () => {
      // OWNER at the early check, demoted by the time the transaction runs.
      const { deps, organizationsRepo, authzRepo, outerAuthzRepo, auditRepo } =
        makeDeps({ actorRoleAtEarlyCheck: "OWNER", actorRole: "ADMIN" });

      await expect(
        inviteMember(deps, { ...input, role: "OWNER" }),
      ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
      expect(outerAuthzRepo.getOrgMembership).toHaveBeenCalledTimes(1);
      expect(authzRepo.getOrgMembership).toHaveBeenCalledWith({
        orgId: ORG_ID,
        humanId: ACTOR_ID,
      });
      expect(
        organizationsRepo.lockOwnerRoster.mock.invocationCallOrder[0]!,
      ).toBeLessThan(authzRepo.getOrgMembership.mock.invocationCallOrder[0]!);
      expect(organizationsRepo.createInvitation).not.toHaveBeenCalled();
      expect(auditRepo.log).not.toHaveBeenCalled();
    });
  });

  describe("the actor's role is read again inside the transaction", () => {
    const input = {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
      email: TARGET_EMAIL,
      role: "EDITOR",
    };

    // The port fake lets everyone through, as it would for an actor who lost
    // the role between the early check and the transaction.
    it.each([
      ["was removed from the org", null],
      ["was demoted to EDITOR", "EDITOR"],
      ["was demoted to VIEWER", "VIEWER"],
    ] as const)(
      "refuses an invite by an actor who %s, with no write and no email",
      async (_label, actorRole) => {
        const { deps, organizationsRepo, authzRepo, auditRepo } = makeDeps({
          actorRole,
        });
        const mailer: MailerPort = {
          send: vi.fn(),
          sendBatch: vi.fn(),
          health: vi.fn(),
        };
        deps.mailer = mailer;
        deps.publicAppUrl = "https://ithasfire.com";

        await expect(inviteMember(deps, input)).rejects.toMatchObject({
          code: "INSUFFICIENT_ROLE",
        });
        expect(authzRepo.getOrgMembership).toHaveBeenCalledWith({
          orgId: ORG_ID,
          humanId: ACTOR_ID,
        });
        expect(organizationsRepo.createInvitation).not.toHaveBeenCalled();
        expect(auditRepo.log).not.toHaveBeenCalled();
        expect(mailer.send).not.toHaveBeenCalled();
      },
    );

    it("reads the actor's row once, after the lock, for an invite below OWNER", async () => {
      const { deps, organizationsRepo, authzRepo, outerAuthzRepo } = makeDeps({
        actorRole: "ADMIN",
      });

      await inviteMember(deps, input);

      // No OWNER check before the transaction for this role.
      expect(outerAuthzRepo.getOrgMembership).not.toHaveBeenCalled();
      expect(authzRepo.getOrgMembership).toHaveBeenCalledTimes(1);
      expect(authzRepo.getOrgMembership).toHaveBeenCalledWith({
        orgId: ORG_ID,
        humanId: ACTOR_ID,
      });
      expect(
        organizationsRepo.lockOwnerRoster.mock.invocationCallOrder[0]!,
      ).toBeLessThan(authzRepo.getOrgMembership.mock.invocationCallOrder[0]!);
    });
  });

  it("checks membership with ONE email-keyed query, never a conditional account lookup (timing oracle)", async () => {
    const { deps, outerOrganizationsRepo, humansRepo } = makeDeps({
      existingHuman: { id: EXISTING_HUMAN_ID, email: TARGET_EMAIL, name: "Jane" },
    });
    await inviteMember(deps, {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
      email: TARGET_EMAIL,
      role: "EDITOR",
    });
    expect(outerOrganizationsRepo.isMemberByEmail).toHaveBeenCalledWith(
      ORG_ID,
      TARGET_EMAIL,
    );
    expect(humansRepo.getByEmail).not.toHaveBeenCalled();
  });

  it("uses a mail idempotency key that changes with the rotated token, so a re-invite is actually sent", async () => {
    const { deps, organizationsRepo } = makeDeps();
    // Re-invite upserts the same row: same id, new token.
    organizationsRepo.createInvitation.mockImplementation(async (input: {
      orgId: string; email: string; role: string; invitedByHumanId: string; token: string; expiresAt: Date;
    }) => ({
      id: "inv-fixed",
      orgId: input.orgId,
      email: input.email,
      role: input.role as OrgInvitationRecord["role"],
      invitedByHumanId: input.invitedByHumanId,
      token: input.token,
      status: "PENDING",
      expiresAt: input.expiresAt,
      acceptedAt: null,
      acceptedByHumanId: null,
      createdAt: new Date("2026-02-22T00:00:00.000Z"),
    }));
    const mailer: MailerPort = {
      send: vi.fn(async () => ({ messageId: "m", accepted: true })),
      sendBatch: vi.fn(),
      health: vi.fn(),
    };
    deps.mailer = mailer;
    deps.publicAppUrl = "https://ithasfire.com";
    const input = { actorHumanId: ACTOR_ID, orgId: ORG_ID, email: TARGET_EMAIL, role: "EDITOR" };

    await inviteMember(deps, input);
    await inviteMember(deps, input);

    const calls = (mailer.send as ReturnType<typeof vi.fn>).mock.calls;
    const k1 = calls[0]![0].idempotencyKey as string;
    const k2 = calls[1]![0].idempotencyKey as string;
    expect(k1).toMatch(/^org-invitation:inv-fixed:[0-9a-f]{16}$/);
    expect(k2).toMatch(/^org-invitation:inv-fixed:[0-9a-f]{16}$/);
    expect(k1).not.toBe(k2);
    // Each key matches the token in the link it carries.
    for (const c of calls) {
      const url = c[0].template.variables.acceptUrl as string;
      const tok = decodeURIComponent(url.split("token=")[1]!);
      expect(c[0].idempotencyKey).toBe(`org-invitation:inv-fixed:${tokenFingerprint(tok)}`);
    }
  });
});
