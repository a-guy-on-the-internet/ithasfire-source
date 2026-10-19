import { describe, expect, it, vi } from "vitest";

import type { Repos, TxRepos } from "@th/ports/repos";
import type { VolunteerSignupRecord } from "@th/ports/repos/volunteering";
import type { NotifyInput, NotifyOutput } from "../comms/notify";

import { assignSignupToGroup } from "./assign-signup-to-group";
import type { AssignSignupToGroupDeps } from "./assign-signup-to-group";

// ── Constants ────────────────────────────────────────────────────────────────

const OWNER_ID = "00000000-0000-4000-8000-000000000001";
const COORDINATOR_ID = "00000000-0000-4000-8000-000000000002";
const OTHER_COORDINATOR_ID = "00000000-0000-4000-8000-000000000003";
const ORG_ID = "00000000-0000-4000-8000-000000000004";
const ASK_ID = "00000000-0000-4000-8000-000000000005";
const OTHER_ASK_ID = "00000000-0000-4000-8000-000000000006";
const GROUP_ID = "00000000-0000-4000-8000-000000000007";
const OTHER_GROUP_ID = "00000000-0000-4000-8000-000000000008";
const SIGNUP_ID = "00000000-0000-4000-8000-000000000009";
const ROLE_ID = "00000000-0000-4000-8000-000000000010";
const NOW = new Date("2026-07-01T12:00:00.000Z");

// ── Fixtures ─────────────────────────────────────────────────────────────────

const baseAsk = {
  id: ASK_ID,
  subjectType: "ORG" as const,
  subjectId: ORG_ID,
  orgId: ORG_ID,
  title: "Standing bar crew",
  description: null,
  status: "OPEN" as const,
  cadence: "ONGOING" as const,
  startsAt: null,
  endsAt: null,
  capacity: null,
  autoApprove: false,
  waiverRequired: false,
  smsOptInEnabled: false,
  formSchema: {},
  createdAt: NOW,
  updatedAt: NOW,
};

const baseGroup = {
  id: GROUP_ID,
  askId: ASK_ID,
  name: "Door team",
  description: null,
  capacity: null,
  coordinatorHumanId: COORDINATOR_ID,
  createdAt: NOW,
  updatedAt: NOW,
};

const otherGroup = {
  ...baseGroup,
  id: OTHER_GROUP_ID,
  name: "Bar team",
  coordinatorHumanId: OTHER_COORDINATOR_ID,
};

/** APPROVED pool signup (unassigned). */
const poolSignup = {
  id: SIGNUP_ID,
  eventId: null,
  askId: ASK_ID,
  roleId: ROLE_ID,
  shiftId: null,
  groupId: null,
  humanId: null,
  contactEmail: "volunteer@example.com",
  contactName: "Volunteer User",
  contactPhone: null,
  smsOptIn: false,
  status: "APPROVED" as const,
  hoursWorked: null,
  answers: {},
  reviewerHumanId: null,
  reviewedAt: null,
  checkedInAt: null,
  waiverAcceptedAt: null,
  notes: null,
  metadata: {},
  createdAt: NOW,
  updatedAt: NOW,
} as unknown as VolunteerSignupRecord;

const memberSignup = { ...poolSignup, groupId: GROUP_ID };

const emptyPage = {
  items: [] as VolunteerSignupRecord[],
  pageInfo: {
    total: 0,
    count: 0,
    limit: 1,
    offset: 0,
    hasNextPage: false,
    nextOffset: null,
  },
};

const pageWithTotal = (total: number) => ({
  ...emptyPage,
  pageInfo: { ...emptyPage.pageInfo, total },
});

const NOTIFY_RESULT: NotifyOutput = {
  ok: true,
  variant: "volunteer.group-signup-assigned",
  category: "transactional",
  scope: { kind: "ORG", orgId: ORG_ID },
  inApp: { status: "skipped", reason: "no_adapter" },
};

// ── Mock builder ─────────────────────────────────────────────────────────────

function makeTxRepos(overrides: Record<string, unknown> = {}) {
  const groupsById: Record<string, typeof baseGroup> = {
    [GROUP_ID]: baseGroup,
    [OTHER_GROUP_ID]: otherGroup,
  };
  return {
    authz: {
      // Default: owner (ADMIN member). Coordinator tests override to null.
      getOrgMembership: vi.fn(async () => ({ role: "ADMIN" })),
    },
    // The coordinator seat needs a verified email (B2); every actor here is
    // verified unless a test says otherwise.
    humans: {
      getByIdWithIdentity: vi.fn(async () => ({
        identity: { emailVerified: true },
      })),
    },
    volunteering: {
      getSignup: vi.fn(async () => poolSignup),
      getAsk: vi.fn(async () => baseAsk),
      getGroup: vi.fn(async (id: string) => groupsById[id] ?? null),
      listSignupsByAsk: vi.fn(async () => emptyPage),
      assignSignupToGroup: vi.fn(
        async (signupId: string, groupId: string | null) => ({
          ...poolSignup,
          id: signupId,
          groupId,
        }),
      ),
      getEventRole: vi.fn(async () => ({
        id: ROLE_ID,
        eventId: null,
        askId: ASK_ID,
        templateId: null,
        name: "Door",
        description: null,
        capacity: null,
        autoApprove: null,
        defaultHours: null,
        sortOrder: 0,
        createdAt: NOW,
        updatedAt: NOW,
        shifts: [],
      })),
    },
    audit: { log: vi.fn(async () => undefined) },
    ...overrides,
  };
}

function makeDeps(txOverrides: Record<string, unknown> = {}) {
  const txRepos = makeTxRepos(txOverrides);
  const notify = vi.fn(async () => NOTIFY_RESULT);
  // B2: every coordinator verified unless a test says otherwise.
  const listEmailVerifiedIds = vi.fn(
    async (ids: readonly string[]): Promise<string[]> => [...ids],
  );
  const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
  const reportError = vi.fn();
  const deps: AssignSignupToGroupDeps = {
    repos: {
      tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) =>
        fn(txRepos as unknown as TxRepos),
      ),
      humans: { listEmailVerifiedIds },
    } as unknown as Repos,
    clock: { now: () => NOW },
    notify,
    appBaseUrl: "https://test.local",
    logger: logger as never,
    reportError,
  };
  return { deps, txRepos, notify, listEmailVerifiedIds, logger, reportError };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("assignSignupToGroup", () => {
  it("owner assigns a pool signup into a group; audits; notifies the coordinator", async () => {
    const { deps, txRepos, notify } = makeDeps();

    const result = await assignSignupToGroup(deps, {
      actorHumanId: OWNER_ID,
      signupId: SIGNUP_ID,
      groupId: GROUP_ID,
    });

    expect(result.groupId).toBe(GROUP_ID);
    expect(
      (txRepos.volunteering as any).assignSignupToGroup,
    ).toHaveBeenCalledWith(SIGNUP_ID, GROUP_ID);
    expect((txRepos.audit as any).log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "assigned_to_group",
        data: expect.objectContaining({
          askId: ASK_ID,
          fromGroupId: null,
          toGroupId: GROUP_ID,
          via: "owner",
        }),
      }),
    );
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        humanId: COORDINATOR_ID,
        variant: "volunteer.group-signup-assigned",
        scope: { kind: "ORG", orgId: ORG_ID },
        payload: expect.objectContaining({
          askId: ASK_ID,
          groupId: GROUP_ID,
          signupId: SIGNUP_ID,
        }),
      }),
    );
  });

  it("owner moves a member between groups (any move)", async () => {
    const { deps, txRepos } = makeDeps();
    (txRepos.volunteering as any).getSignup = vi.fn(async () => memberSignup);

    const result = await assignSignupToGroup(deps, {
      actorHumanId: OWNER_ID,
      signupId: SIGNUP_ID,
      groupId: OTHER_GROUP_ID,
    });

    expect(result.groupId).toBe(OTHER_GROUP_ID);
  });

  it("coordinator pulls an APPROVED pool signup into their OWN group", async () => {
    const { deps, txRepos, notify } = makeDeps({
      authz: { getOrgMembership: vi.fn(async () => null) },
    });

    const result = await assignSignupToGroup(deps, {
      actorHumanId: COORDINATOR_ID,
      signupId: SIGNUP_ID,
      groupId: GROUP_ID,
    });

    expect(result.groupId).toBe(GROUP_ID);
    expect((txRepos.audit as any).log).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ via: "coordinator" }),
      }),
    );
    // The coordinator made the move themselves — no self-notification.
    expect(notify).not.toHaveBeenCalled();
  });

  it("coordinator releases their own member back to the pool", async () => {
    const { deps, txRepos } = makeDeps({
      authz: { getOrgMembership: vi.fn(async () => null) },
    });
    (txRepos.volunteering as any).getSignup = vi.fn(async () => memberSignup);

    const result = await assignSignupToGroup(deps, {
      actorHumanId: COORDINATOR_ID,
      signupId: SIGNUP_ID,
      groupId: null,
    });

    expect(result.groupId).toBeNull();
    expect((txRepos.audit as any).log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "released_to_pool" }),
    );
  });

  it("forbids a coordinator pulling a pool signup into ANOTHER group", async () => {
    const { deps, txRepos } = makeDeps({
      authz: { getOrgMembership: vi.fn(async () => null) },
    });

    await expect(
      assignSignupToGroup(deps, {
        actorHumanId: COORDINATOR_ID,
        signupId: SIGNUP_ID,
        groupId: OTHER_GROUP_ID,
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    expect(
      (txRepos.volunteering as any).assignSignupToGroup,
    ).not.toHaveBeenCalled();
  });

  it("forbids a coordinator releasing ANOTHER group's member", async () => {
    const { deps, txRepos } = makeDeps({
      authz: { getOrgMembership: vi.fn(async () => null) },
    });
    (txRepos.volunteering as any).getSignup = vi.fn(async () => ({
      ...memberSignup,
      groupId: OTHER_GROUP_ID,
    }));

    await expect(
      assignSignupToGroup(deps, {
        actorHumanId: COORDINATOR_ID,
        signupId: SIGNUP_ID,
        groupId: null,
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("forbids a coordinator moving their own member group → group (owner only)", async () => {
    const { deps, txRepos } = makeDeps({
      authz: { getOrgMembership: vi.fn(async () => null) },
    });
    // The signup is in the actor's OWN group, but the destination is a
    // different group — still owner-only.
    (txRepos.volunteering as any).getSignup = vi.fn(async () => memberSignup);

    await expect(
      assignSignupToGroup(deps, {
        actorHumanId: COORDINATOR_ID,
        signupId: SIGNUP_ID,
        groupId: OTHER_GROUP_ID,
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    // The coordinator seat is never even consulted for cross moves.
    expect((txRepos.volunteering as any).getGroup).not.toHaveBeenCalled();
  });

  it("rejects a coordinator pull of a non-APPROVED pool signup (conflict)", async () => {
    const { deps, txRepos } = makeDeps({
      authz: { getOrgMembership: vi.fn(async () => null) },
    });
    (txRepos.volunteering as any).getSignup = vi.fn(async () => ({
      ...poolSignup,
      status: "PENDING",
    }));

    await expect(
      assignSignupToGroup(deps, {
        actorHumanId: COORDINATOR_ID,
        signupId: SIGNUP_ID,
        groupId: GROUP_ID,
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "signup_not_approved",
    });
  });

  it("owner may move a non-APPROVED signup (any move)", async () => {
    const { deps, txRepos } = makeDeps();
    (txRepos.volunteering as any).getSignup = vi.fn(async () => ({
      ...poolSignup,
      status: "PENDING",
    }));

    const result = await assignSignupToGroup(deps, {
      actorHumanId: OWNER_ID,
      signupId: SIGNUP_ID,
      groupId: GROUP_ID,
    });

    expect(result.groupId).toBe(GROUP_ID);
  });

  it("404s a target group belonging to a different ask", async () => {
    const { deps } = makeDeps({
      volunteering: {
        ...makeTxRepos().volunteering,
        getGroup: vi.fn(async () => ({ ...baseGroup, askId: OTHER_ASK_ID })),
      },
    });

    await expect(
      assignSignupToGroup(deps, {
        actorHumanId: OWNER_ID,
        signupId: SIGNUP_ID,
        groupId: GROUP_ID,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "group_not_found" });
  });

  it("enforces group capacity against accepted members", async () => {
    const { deps, txRepos } = makeDeps();
    (txRepos.volunteering as any).getGroup = vi.fn(async () => ({
      ...baseGroup,
      capacity: 2,
    }));
    (txRepos.volunteering as any).listSignupsByAsk = vi.fn(async () =>
      pageWithTotal(1),
    );

    await expect(
      assignSignupToGroup(deps, {
        actorHumanId: OWNER_ID,
        signupId: SIGNUP_ID,
        groupId: GROUP_ID,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", message: "group_full" });
  });

  it("is an idempotent no-op when the signup is already there", async () => {
    const { deps, txRepos, notify } = makeDeps();
    (txRepos.volunteering as any).getSignup = vi.fn(async () => memberSignup);

    const result = await assignSignupToGroup(deps, {
      actorHumanId: OWNER_ID,
      signupId: SIGNUP_ID,
      groupId: GROUP_ID,
    });

    expect(result.groupId).toBe(GROUP_ID);
    expect(
      (txRepos.volunteering as any).assignSignupToGroup,
    ).not.toHaveBeenCalled();
    expect((txRepos.audit as any).log).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("throws SIGNUP_NOT_FOUND for missing signups and ask-less signups", async () => {
    const { deps, txRepos } = makeDeps();
    (txRepos.volunteering as any).getSignup = vi.fn(async () => null);
    await expect(
      assignSignupToGroup(deps, {
        actorHumanId: OWNER_ID,
        signupId: SIGNUP_ID,
        groupId: GROUP_ID,
      }),
    ).rejects.toMatchObject({ code: "SIGNUP_NOT_FOUND" });

    (txRepos.volunteering as any).getSignup = vi.fn(async () => ({
      ...poolSignup,
      askId: null,
    }));
    await expect(
      assignSignupToGroup(deps, {
        actorHumanId: OWNER_ID,
        signupId: SIGNUP_ID,
        groupId: GROUP_ID,
      }),
    ).rejects.toMatchObject({ code: "SIGNUP_NOT_FOUND" });
  });

  it("does not fail the move when the coordinator notification throws", async () => {
    const { deps, notify } = makeDeps();
    (notify as any).mockRejectedValueOnce(new Error("mail down"));

    const result = await assignSignupToGroup(deps, {
      actorHumanId: OWNER_ID,
      signupId: SIGNUP_ID,
      groupId: GROUP_ID,
    });

    expect(result.groupId).toBe(GROUP_ID);
  });

  // B2 (account squatting through guest checkout): a coordinator seat can be
  // given BY EMAIL to an existing account, so an unverified coordinator may
  // be someone else's. Email still goes; in-app and push only when verified.
  describe("verified coordinators only for in-app and push (B2)", () => {
    const EMAIL_ONLY = {
      inApp: { enabled: false },
      push: { enabled: false },
      sms: { enabled: false },
    };
    const assign = (deps: AssignSignupToGroupDeps) =>
      assignSignupToGroup(deps, {
        actorHumanId: OWNER_ID,
        signupId: SIGNUP_ID,
        groupId: GROUP_ID,
      });

    it("a verified coordinator gets every channel", async () => {
      const { deps, notify, listEmailVerifiedIds, reportError } = makeDeps();
      await assign(deps);

      expect(listEmailVerifiedIds).toHaveBeenCalledWith([COORDINATOR_ID]);
      const call = (notify.mock.calls[0] as unknown as [NotifyInput])[0];
      expect(call.channels).toBeUndefined();
      expect(reportError).not.toHaveBeenCalled();
    });

    it("an unverified coordinator gets email only", async () => {
      const { deps, notify, listEmailVerifiedIds } = makeDeps();
      listEmailVerifiedIds.mockResolvedValueOnce([]);
      await assign(deps);

      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({
          humanId: COORDINATOR_ID,
          variant: "volunteer.group-signup-assigned",
          channels: EMAIL_ONLY,
        }),
      );
    });

    it("a failed lookup still moves the signup, sends email only, logs ERROR and reports", async () => {
      const { deps, notify, listEmailVerifiedIds, logger, reportError } =
        makeDeps();
      listEmailVerifiedIds.mockRejectedValueOnce(new Error("db down"));

      const result = await assign(deps);

      expect(result.groupId).toBe(GROUP_ID);
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({ channels: EMAIL_ONLY }),
      );
      expect(logger.error).toHaveBeenCalledWith(
        "volunteering.assignSignupToGroup.verified_lookup_failed",
        expect.objectContaining({ recipientHumanId: COORDINATOR_ID }),
      );
      expect(reportError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          tags: expect.objectContaining({ stage: "verified_lookup" }),
        }),
      );
    });

    it("a throwing reporter does not change the outcome", async () => {
      const { deps, notify, listEmailVerifiedIds, reportError } = makeDeps();
      listEmailVerifiedIds.mockRejectedValueOnce(new Error("db down"));
      reportError.mockImplementationOnce(() => {
        throw new Error("sentry down");
      });

      const result = await assign(deps);

      expect(result.groupId).toBe(GROUP_ID);
      expect(notify).toHaveBeenCalledTimes(1);
    });
  });
});
