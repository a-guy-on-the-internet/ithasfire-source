import { describe, expect, it, vi } from "vitest";

import type { Repos, TxRepos } from "@th/ports/repos";
import type {
  VolunteerAskRecord,
  VolunteerGroupRecord,
} from "@th/ports/repos/volunteering";
import type { NotifyInput, NotifyOutput } from "../comms/notify";

import { assignGroupCoordinator } from "./assign-group-coordinator";
import type { AssignGroupCoordinatorDeps } from "./assign-group-coordinator";

// ── Constants ────────────────────────────────────────────────────────────────

const ACTOR_ID = "00000000-0000-4000-8000-000000000001";
const ORG_ID = "00000000-0000-4000-8000-000000000002";
const ASK_ID = "00000000-0000-4000-8000-000000000010";
const GROUP_ID = "00000000-0000-4000-8000-000000000040";
const COORDINATOR_ID = "00000000-0000-4000-8000-000000000050";
const GUEST_HUMAN_ID = "00000000-0000-4000-8000-000000000051";
const NOW = new Date("2026-07-01T12:00:00.000Z");
const APP_BASE_URL = "https://test.local";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const baseAsk: VolunteerAskRecord = {
  id: ASK_ID,
  subjectType: "ORG",
  subjectId: ORG_ID,
  orgId: ORG_ID,
  title: "Street team",
  description: null,
  status: "OPEN",
  cadence: "ONGOING",
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

const baseGroup: VolunteerGroupRecord = {
  id: GROUP_ID,
  askId: ASK_ID,
  name: "Flyer crew",
  description: null,
  capacity: null,
  coordinatorHumanId: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const NOTIFY_RESULT: NotifyOutput = {
  ok: true,
  variant: "volunteer.group-coordinator-assigned",
  category: "transactional",
  scope: { kind: "ORG", orgId: ORG_ID },
  inApp: { status: "skipped", reason: "no_adapter" },
};

// ── Mock builder ─────────────────────────────────────────────────────────────

const NEW_EMAIL = "new.coordinator@example.com";

/**
 * Identity fixture: the freshly minted guest is a shadow (unverified, no
 * linked auth account); everyone else is a real, verified account.
 */
function identityFor(id: string) {
  const shadow = id === GUEST_HUMAN_ID;
  return {
    human: { id, name: shadow ? null : "Coordinator", status: "ACTIVE" },
    identity: {
      authUserId: `auth-${id}`,
      email: shadow ? NEW_EMAIL : "coordinator@example.com",
      emailVerified: !shadow,
    },
  };
}

function makeTxRepos(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const { humans: humansOverride, ...rest } = overrides as {
    humans?: Record<string, unknown>;
  };
  return {
    authz: {
      getOrgMembership: vi.fn(async () => ({ orgId: ORG_ID, role: "ADMIN" })),
      getOrgMemberships: vi.fn(async () => [{ orgId: ORG_ID, role: "ADMIN" }]),
    },
    humans: {
      getById: vi.fn(async (id: string) =>
        id === ACTOR_ID
          ? { id: ACTOR_ID, name: "Sam Rivera", status: "ACTIVE" }
          : { id: COORDINATOR_ID, name: "Coordinator", status: "ACTIVE" },
      ),
      ensureGuestHuman: vi.fn(async () => ({
        humanId: GUEST_HUMAN_ID,
        created: true,
      })),
      getByIdWithIdentity: vi.fn(async (id: string) => identityFor(id)),
      listAuthAccounts: vi.fn(async (id: string) =>
        id === GUEST_HUMAN_ID
          ? []
          : [{ providerId: "credential", accountId: id, createdAt: NOW }],
      ),
      ...(humansOverride ?? {}),
    },
    volunteering: {
      getGroup: vi.fn(async () => baseGroup),
      getAsk: vi.fn(async () => baseAsk),
      setGroupCoordinatorIfCurrent: vi.fn(
        async (
          groupId: string,
          _expected: string | null,
          coordinatorHumanId: string | null,
        ) => ({
          ...baseGroup,
          id: groupId,
          coordinatorHumanId,
          updatedAt: NOW,
        }),
      ),
    },
    audit: { log: vi.fn(async () => undefined) },
    ...rest,
  };
}

function makeDepsWithMocks(txOverrides: Record<string, unknown> = {}) {
  const txRepos = makeTxRepos(txOverrides);
  const notify = vi.fn(async () => NOTIFY_RESULT);
  const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
  // Root (non-tx) lookup used by the new-address cap: only NEW_EMAIL is
  // unknown; any other address already has an account.
  const getByEmail = vi.fn(async (email: string) =>
    email === NEW_EMAIL ? null : identityFor(COORDINATOR_ID),
  );
  const listEmailVerifiedIds = vi.fn(async (ids: readonly string[]) =>
    ids.filter((id) => identityFor(id).identity.emailVerified),
  );
  const rateLimit = {
    consume: vi.fn(async () => ({
      allowed: true,
      remaining: 10,
      retryAfterSeconds: 0,
    })),
  };
  const deps: AssignGroupCoordinatorDeps = {
    repos: {
      tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) =>
        fn(txRepos as TxRepos),
      ),
      // B2: who proved their inbox (the shadow guest has not).
      humans: { getByEmail, listEmailVerifiedIds },
    } as unknown as Repos,
    clock: { now: () => NOW },
    notify,
    appBaseUrl: APP_BASE_URL,
    rateLimit,
    logger: logger as never,
  };
  return {
    deps,
    txRepos,
    notify,
    logger,
    rateLimit,
    getByEmail,
    listEmailVerifiedIds,
  };
}

// ══════════════════════════════════════════════════════════════════════════════

describe("assignGroupCoordinator", () => {
  it("assigns an existing human and notifies post-commit (standard variant)", async () => {
    const { deps, txRepos, notify } = makeDepsWithMocks();
    const result = await assignGroupCoordinator(deps, {
      actorHumanId: ACTOR_ID,
      groupId: GROUP_ID,
      coordinatorHumanId: COORDINATOR_ID,
    });

    expect(result.coordinatorHumanId).toBe(COORDINATOR_ID);
    expect(
      (txRepos.volunteering as any).setGroupCoordinatorIfCurrent,
    ).toHaveBeenCalledWith(GROUP_ID, null, COORDINATOR_ID);
    expect((txRepos.audit as any).log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "volunteer_group",
        action: "coordinator_assigned",
      }),
    );
    expect(notify).toHaveBeenCalledWith({
      humanId: COORDINATOR_ID,
      variant: "volunteer.group-coordinator-assigned",
      payload: {
        askId: ASK_ID,
        askTitle: "Street team",
        groupId: GROUP_ID,
        groupName: "Flyer crew",
        coordinateUrl: `${APP_BASE_URL}/volunteers/coordinate/${ASK_ID}`,
        accountCompletionUrl: null,
        assignerName: "Sam Rivera",
      },
      scope: { kind: "ORG", orgId: ORG_ID },
      idempotencyKey: `${GROUP_ID}:coordinator-assigned:${COORDINATOR_ID}:${NOW.toISOString()}`,
    });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("resolves a coordinator email via ensureGuestHuman and sends the invite variant", async () => {
    const { deps, txRepos, notify } = makeDepsWithMocks();
    await assignGroupCoordinator(deps, {
      actorHumanId: ACTOR_ID,
      groupId: GROUP_ID,
      coordinatorEmail: "new.coordinator@example.com",
    });

    // No `name`: passing the address would write it into Human.name (and
    // rename an existing account), which the owner's roster renders.
    expect((txRepos.humans as any).ensureGuestHuman).toHaveBeenCalledWith({
      email: "new.coordinator@example.com",
    });
    expect(
      (txRepos.volunteering as any).setGroupCoordinatorIfCurrent,
    ).toHaveBeenCalledWith(GROUP_ID, null, GUEST_HUMAN_ID);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        humanId: GUEST_HUMAN_ID,
        variant: "volunteer.group-coordinator-assigned",
        payload: expect.objectContaining({
          accountCompletionUrl: `${APP_BASE_URL}/auth/complete?email=${encodeURIComponent("new.coordinator@example.com")}&src=volunteer-coordinator`,
        }),
      }),
    );
  });

  it("uses the standard variant when the email resolves to an existing account", async () => {
    const { deps, notify } = makeDepsWithMocks({
      humans: {
        getById: vi.fn(async () => ({
          id: GUEST_HUMAN_ID,
          name: "Existing",
          status: "ACTIVE",
        })),
        ensureGuestHuman: vi.fn(async () => ({
          humanId: GUEST_HUMAN_ID,
          created: false,
        })),
        // A real account: verified email.
        getByIdWithIdentity: vi.fn(async () => ({
          human: { id: GUEST_HUMAN_ID },
          identity: { email: "existing@example.com", emailVerified: true },
        })),
      },
    });
    await assignGroupCoordinator(deps, {
      actorHumanId: ACTOR_ID,
      groupId: GROUP_ID,
      coordinatorEmail: "existing@example.com",
    });

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ accountCompletionUrl: null }),
      }),
    );
  });

  it("clears the coordinator (null) without notifying", async () => {
    const { deps, txRepos, notify } = makeDepsWithMocks({
      volunteering: {
        getGroup: vi.fn(async () => ({
          ...baseGroup,
          coordinatorHumanId: COORDINATOR_ID,
        })),
        getAsk: vi.fn(async () => baseAsk),
        setGroupCoordinatorIfCurrent: vi.fn(async () => ({
          ...baseGroup,
          coordinatorHumanId: null,
        })),
      },
    });
    const result = await assignGroupCoordinator(deps, {
      actorHumanId: ACTOR_ID,
      groupId: GROUP_ID,
    });

    expect(result.coordinatorHumanId).toBeNull();
    expect(
      (txRepos.volunteering as any).setGroupCoordinatorIfCurrent,
    ).toHaveBeenCalledWith(GROUP_ID, COORDINATOR_ID, null);
    expect((txRepos.audit as any).log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "coordinator_cleared" }),
    );
    expect(notify).not.toHaveBeenCalled();
  });

  it("no-ops (and skips notify) when the coordinator is unchanged", async () => {
    const { deps, txRepos, notify } = makeDepsWithMocks({
      volunteering: {
        getGroup: vi.fn(async () => ({
          ...baseGroup,
          coordinatorHumanId: COORDINATOR_ID,
        })),
        getAsk: vi.fn(async () => baseAsk),
        setGroupCoordinatorIfCurrent: vi.fn(),
      },
    });
    await assignGroupCoordinator(deps, {
      actorHumanId: ACTOR_ID,
      groupId: GROUP_ID,
      coordinatorHumanId: COORDINATOR_ID,
    });

    expect(
      (txRepos.volunteering as any).setGroupCoordinatorIfCurrent,
    ).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("uses a GLOBAL notification scope for orgless (HUMAN-subject) asks", async () => {
    const { deps, notify } = makeDepsWithMocks({
      volunteering: {
        getGroup: vi.fn(async () => baseGroup),
        getAsk: vi.fn(async () => ({
          ...baseAsk,
          subjectType: "HUMAN",
          subjectId: ACTOR_ID,
          orgId: null,
        })),
        setGroupCoordinatorIfCurrent: vi.fn(async () => ({
          ...baseGroup,
          coordinatorHumanId: COORDINATOR_ID,
        })),
      },
    });
    await assignGroupCoordinator(deps, {
      actorHumanId: ACTOR_ID,
      groupId: GROUP_ID,
      coordinatorHumanId: COORDINATOR_ID,
    });

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ scope: { kind: "GLOBAL" } }),
    );
  });

  it("is owner-only: a VIEWER (or the coordinator themselves without ownership) is forbidden", async () => {
    const { deps, notify } = makeDepsWithMocks({
      authz: {
        getOrgMembership: vi.fn(async () => ({ orgId: ORG_ID, role: "VIEWER" })),
      },
    });
    await expect(
      assignGroupCoordinator(deps, {
        actorHumanId: COORDINATOR_ID,
        groupId: GROUP_ID,
        coordinatorHumanId: COORDINATOR_ID,
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    expect(notify).not.toHaveBeenCalled();
  });

  it("rejects a missing group", async () => {
    const { deps } = makeDepsWithMocks({
      volunteering: {
        getGroup: vi.fn(async () => null),
        getAsk: vi.fn(),
        setGroupCoordinatorIfCurrent: vi.fn(),
      },
    });
    await expect(
      assignGroupCoordinator(deps, {
        actorHumanId: ACTOR_ID,
        groupId: GROUP_ID,
        coordinatorHumanId: COORDINATOR_ID,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects a missing coordinator human", async () => {
    const { deps } = makeDepsWithMocks({
      humans: { getById: vi.fn(async () => null), ensureGuestHuman: vi.fn() },
    });
    await expect(
      assignGroupCoordinator(deps, {
        actorHumanId: ACTOR_ID,
        groupId: GROUP_ID,
        coordinatorHumanId: COORDINATOR_ID,
      }),
    ).rejects.toMatchObject({ code: "HUMAN_NOT_FOUND" });
  });

  it.each(["SUSPENDED", "BANNED"] as const)(
    "rejects a %s coordinator human",
    async (status) => {
      const { deps, txRepos, notify } = makeDepsWithMocks({
        humans: {
          getById: vi.fn(async () => ({
            id: COORDINATOR_ID,
            name: "Coordinator",
            status,
          })),
          ensureGuestHuman: vi.fn(),
        },
      });
      await expect(
        assignGroupCoordinator(deps, {
          actorHumanId: ACTOR_ID,
          groupId: GROUP_ID,
          coordinatorHumanId: COORDINATOR_ID,
        }),
      ).rejects.toMatchObject({
        code: "CONFLICT",
        message: "human_not_active",
      });
      expect(
        (txRepos.volunteering as any).setGroupCoordinatorIfCurrent,
      ).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
    },
  );

  it.each(["SUSPENDED", "BANNED"] as const)(
    "rejects a %s human resolved via coordinatorEmail",
    async (status) => {
      const { deps, txRepos, notify } = makeDepsWithMocks({
        humans: {
          getById: vi.fn(async () => ({
            id: GUEST_HUMAN_ID,
            name: "Existing",
            status,
          })),
          ensureGuestHuman: vi.fn(async () => ({
            humanId: GUEST_HUMAN_ID,
            created: false,
          })),
        },
      });
      await expect(
        assignGroupCoordinator(deps, {
          actorHumanId: ACTOR_ID,
          groupId: GROUP_ID,
          coordinatorEmail: "suspended@example.com",
        }),
      ).rejects.toMatchObject({
        code: "CONFLICT",
        message: "human_not_active",
      });
      expect(
        (txRepos.volunteering as any).setGroupCoordinatorIfCurrent,
      ).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
    },
  );

  it("rejects an ARCHIVED ask", async () => {
    const { deps } = makeDepsWithMocks({
      volunteering: {
        getGroup: vi.fn(async () => baseGroup),
        getAsk: vi.fn(async () => ({ ...baseAsk, status: "ARCHIVED" })),
        setGroupCoordinatorIfCurrent: vi.fn(),
      },
    });
    await expect(
      assignGroupCoordinator(deps, {
        actorHumanId: ACTOR_ID,
        groupId: GROUP_ID,
        coordinatorHumanId: COORDINATOR_ID,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", message: "ask_archived" });
  });

  it("rejects providing both coordinatorHumanId and coordinatorEmail", async () => {
    const { deps } = makeDepsWithMocks();
    await expect(
      assignGroupCoordinator(deps, {
        actorHumanId: ACTOR_ID,
        groupId: GROUP_ID,
        coordinatorHumanId: COORDINATOR_ID,
        coordinatorEmail: "both@example.com",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("does not notify when the owner assigns themselves", async () => {
    const { deps, txRepos, notify } = makeDepsWithMocks();
    const result = await assignGroupCoordinator(deps, {
      actorHumanId: ACTOR_ID,
      groupId: GROUP_ID,
      coordinatorHumanId: ACTOR_ID,
    });

    expect(result.coordinatorHumanId).toBe(ACTOR_ID);
    expect(
      (txRepos.volunteering as any).setGroupCoordinatorIfCurrent,
    ).toHaveBeenCalledWith(GROUP_ID, null, ACTOR_ID);
    expect(notify).not.toHaveBeenCalled();
  });

  it("notifies once across repeated assignments of the same person", async () => {
    // Stateful group: the second call sees the first call's write.
    let current: string | null = null;
    const { deps, notify } = makeDepsWithMocks({
      volunteering: {
        getGroup: vi.fn(async () => ({
          ...baseGroup,
          coordinatorHumanId: current,
        })),
        getAsk: vi.fn(async () => baseAsk),
        setGroupCoordinatorIfCurrent: vi.fn(async (_g: string, _e: string | null, id: string | null) => {
          current = id;
          return { ...baseGroup, coordinatorHumanId: id };
        }),
      },
    });
    const input = {
      actorHumanId: ACTOR_ID,
      groupId: GROUP_ID,
      coordinatorHumanId: COORDINATOR_ID,
    };
    await assignGroupCoordinator(deps, input);
    await assignGroupCoordinator(deps, input);

    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("replacing coordinator A with B notifies B only", async () => {
    const NEW_ID = "00000000-0000-4000-8000-000000000060";
    const { deps, notify } = makeDepsWithMocks({
      humans: {
        getById: vi.fn(async (id: string) => ({
          id,
          name: id === ACTOR_ID ? "Sam Rivera" : "B",
          status: "ACTIVE",
        })),
        ensureGuestHuman: vi.fn(),
      },
      volunteering: {
        getGroup: vi.fn(async () => ({
          ...baseGroup,
          coordinatorHumanId: COORDINATOR_ID,
        })),
        getAsk: vi.fn(async () => baseAsk),
        setGroupCoordinatorIfCurrent: vi.fn(async (_g: string, _e: string | null, id: string | null) => ({
          ...baseGroup,
          coordinatorHumanId: id,
        })),
      },
    });
    await assignGroupCoordinator(deps, {
      actorHumanId: ACTOR_ID,
      groupId: GROUP_ID,
      coordinatorHumanId: NEW_ID,
    });

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ humanId: NEW_ID }),
    );
  });

  it("drops an assigner name that looks like an email address", async () => {
    const { deps, notify } = makeDepsWithMocks({
      humans: {
        getById: vi.fn(async (id: string) => ({
          id,
          name: id === ACTOR_ID ? "owner@example.com" : "Coordinator",
          status: "ACTIVE",
        })),
        ensureGuestHuman: vi.fn(),
      },
    });
    await assignGroupCoordinator(deps, {
      actorHumanId: ACTOR_ID,
      groupId: GROUP_ID,
      coordinatorHumanId: COORDINATOR_ID,
    });

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ assignerName: null }),
      }),
    );
  });

  it("reports a thrown notify failure and still returns the assignment", async () => {
    const { deps, notify } = makeDepsWithMocks();
    const boom = new Error("smtp down");
    notify.mockRejectedValueOnce(boom);
    const reportError = vi.fn();
    deps.reportError = reportError;

    const result = await assignGroupCoordinator(deps, {
      actorHumanId: ACTOR_ID,
      groupId: GROUP_ID,
      coordinatorHumanId: COORDINATOR_ID,
    });

    expect(result.coordinatorHumanId).toBe(COORDINATOR_ID);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(boom, {
      tags: { useCase: "assignGroupCoordinator", reason: "notify_failed" },
      extra: {
        groupId: GROUP_ID,
        askId: ASK_ID,
        coordinatorHumanId: COORDINATOR_ID,
      },
    });
  });

  it("reports an email leg that comes back failed (notify does not throw for it)", async () => {
    const { deps, notify, logger } = makeDepsWithMocks();
    notify.mockResolvedValueOnce({
      ...NOTIFY_RESULT,
      email: { status: "failed", reason: "port_error" },
    });
    const reportError = vi.fn();
    deps.reportError = reportError;

    const result = await assignGroupCoordinator(deps, {
      actorHumanId: ACTOR_ID,
      groupId: GROUP_ID,
      coordinatorHumanId: COORDINATOR_ID,
    });

    expect(result.coordinatorHumanId).toBe(COORDINATOR_ID);
    expect(logger.error).toHaveBeenCalledWith(
      "volunteering.assignGroupCoordinator.notify_failed",
      expect.objectContaining({ reason: "email_failed" }),
    );
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { useCase: "assignGroupCoordinator", reason: "email_failed" },
      }),
    );
  });

  it("a throwing reporter does not fail the assignment", async () => {
    const { deps, notify } = makeDepsWithMocks();
    notify.mockRejectedValueOnce(new Error("smtp down"));
    deps.reportError = vi.fn(() => {
      throw new Error("sentry is down too");
    });

    await expect(
      assignGroupCoordinator(deps, {
        actorHumanId: ACTOR_ID,
        groupId: GROUP_ID,
        coordinatorHumanId: COORDINATOR_ID,
      }),
    ).resolves.toMatchObject({ coordinatorHumanId: COORDINATOR_ID });
  });

  // ── Compare-and-swap write ─────────────────────────────────────────────

  it("a lost compare-and-swap (concurrent double-submit) writes no audit and sends no notice", async () => {
    const { deps, txRepos, notify } = makeDepsWithMocks({
      volunteering: {
        getGroup: vi
          .fn()
          // Read before the write: still unassigned.
          .mockResolvedValueOnce(baseGroup)
          // Re-read after losing the race: the winner's write.
          .mockResolvedValueOnce({ ...baseGroup, coordinatorHumanId: COORDINATOR_ID }),
        getAsk: vi.fn(async () => baseAsk),
        setGroupCoordinatorIfCurrent: vi.fn(async () => null),
      },
    });

    const result = await assignGroupCoordinator(deps, {
      actorHumanId: ACTOR_ID,
      groupId: GROUP_ID,
      coordinatorHumanId: COORDINATOR_ID,
    });

    expect(result.coordinatorHumanId).toBe(COORDINATOR_ID);
    expect(
      (txRepos.volunteering as any).setGroupCoordinatorIfCurrent,
    ).toHaveBeenCalledWith(GROUP_ID, null, COORDINATOR_ID);
    expect((txRepos.audit as any).log).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("a lost compare-and-swap to a DIFFERENT coordinator is a CONFLICT, not a silent success", async () => {
    const OTHER_ID = "00000000-0000-4000-8000-000000000070";
    const { deps, txRepos, notify } = makeDepsWithMocks({
      volunteering: {
        getGroup: vi
          .fn()
          .mockResolvedValueOnce(baseGroup)
          .mockResolvedValueOnce({ ...baseGroup, coordinatorHumanId: OTHER_ID }),
        getAsk: vi.fn(async () => baseAsk),
        setGroupCoordinatorIfCurrent: vi.fn(async () => null),
      },
    });

    await expect(
      assignGroupCoordinator(deps, {
        actorHumanId: ACTOR_ID,
        groupId: GROUP_ID,
        coordinatorHumanId: COORDINATOR_ID,
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "coordinator_changed",
    });
    expect((txRepos.audit as any).log).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("a lost compare-and-swap because the group was DELETED is NOT_FOUND", async () => {
    const { deps, notify } = makeDepsWithMocks({
      volunteering: {
        getGroup: vi
          .fn()
          .mockResolvedValueOnce(baseGroup)
          .mockResolvedValueOnce(null),
        getAsk: vi.fn(async () => baseAsk),
        setGroupCoordinatorIfCurrent: vi.fn(async () => null),
      },
    });

    await expect(
      assignGroupCoordinator(deps, {
        actorHumanId: ACTOR_ID,
        groupId: GROUP_ID,
        coordinatorHumanId: COORDINATOR_ID,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "group_not_found" });
    expect(notify).not.toHaveBeenCalled();
  });

  it("trims and lowercases coordinatorEmail before resolving it", async () => {
    const { deps, txRepos, getByEmail } = makeDepsWithMocks();
    await assignGroupCoordinator(deps, {
      actorHumanId: ACTOR_ID,
      groupId: GROUP_ID,
      coordinatorEmail: "  New.Coordinator@Example.COM ",
    });

    expect(getByEmail).toHaveBeenCalledWith(NEW_EMAIL);
    expect((txRepos.humans as any).ensureGuestHuman).toHaveBeenCalledWith({
      email: NEW_EMAIL,
    });
  });

  // ── Invite flavor follows ACCOUNT STATE (review #5) ──────────────────────

  it("sends the invite flavor to an EXISTING password-less shadow account", async () => {
    // ensureGuestHuman did not mint it (created:false), but the account is
    // still a shadow: unverified email and no linked auth account.
    const { deps, notify } = makeDepsWithMocks({
      humans: {
        getById: vi.fn(async (id: string) => ({
          id,
          name: id === ACTOR_ID ? "Sam Rivera" : null,
          status: "ACTIVE",
        })),
        ensureGuestHuman: vi.fn(async () => ({
          humanId: GUEST_HUMAN_ID,
          created: false,
        })),
      },
    });
    await assignGroupCoordinator(deps, {
      actorHumanId: ACTOR_ID,
      groupId: GROUP_ID,
      coordinatorEmail: "existing-shadow@example.com",
    });

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          // The link carries the account's own address.
          accountCompletionUrl: `${APP_BASE_URL}/auth/complete?email=${encodeURIComponent(NEW_EMAIL)}&src=volunteer-coordinator`,
        }),
      }),
    );
  });

  it("does NOT send the invite flavor to an unverified account that has a linked login", async () => {
    const { deps, notify } = makeDepsWithMocks({
      humans: {
        listAuthAccounts: vi.fn(async () => [
          { providerId: "google", accountId: "g-1", createdAt: NOW },
        ]),
      },
    });
    await assignGroupCoordinator(deps, {
      actorHumanId: ACTOR_ID,
      groupId: GROUP_ID,
      coordinatorEmail: NEW_EMAIL,
    });

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ accountCompletionUrl: null }),
      }),
    );
  });

  // ── Per-assignment idempotency key (review #2) ──────────────────────────

  it("keys the notice per assignment: A→B→A notifies A twice with distinct keys", async () => {
    const B_ID = "00000000-0000-4000-8000-000000000061";
    let current: string | null = null;
    let tick = 0;
    const { deps, notify } = makeDepsWithMocks({
      humans: {
        getById: vi.fn(async (id: string) => ({
          id,
          name: id === ACTOR_ID ? "Sam Rivera" : "X",
          status: "ACTIVE",
        })),
      },
      volunteering: {
        getGroup: vi.fn(async () => ({ ...baseGroup, coordinatorHumanId: current })),
        getAsk: vi.fn(async () => baseAsk),
        setGroupCoordinatorIfCurrent: vi.fn(async (_g: string, _e: string | null, id: string | null) => {
          current = id;
          tick += 1;
          return {
            ...baseGroup,
            coordinatorHumanId: id,
            updatedAt: new Date(NOW.getTime() + tick * 1000),
          };
        }),
      },
    });
    for (const id of [COORDINATOR_ID, B_ID, COORDINATOR_ID]) {
      await assignGroupCoordinator(deps, {
        actorHumanId: ACTOR_ID,
        groupId: GROUP_ID,
        coordinatorHumanId: id,
      });
    }

    const keysForA = (notify.mock.calls as unknown as [{ humanId: string; idempotencyKey: string }][])
      .map(([call]) => call)
      .filter((call) => call.humanId === COORDINATOR_ID)
      .map((call) => call.idempotencyKey);
    expect(keysForA).toHaveLength(2);
    expect(new Set(keysForA).size).toBe(2);
  });

  // ── appBaseUrl unset (review #4) ────────────────────────────────────────

  it("skips the notice with one reported config warning when appBaseUrl is null", async () => {
    const { deps, notify, logger } = makeDepsWithMocks();
    deps.appBaseUrl = null;
    const reportError = vi.fn();
    deps.reportError = reportError;

    const result = await assignGroupCoordinator(deps, {
      actorHumanId: ACTOR_ID,
      groupId: GROUP_ID,
      coordinatorHumanId: COORDINATOR_ID,
    });

    expect(result.coordinatorHumanId).toBe(COORDINATOR_ID);
    expect(notify).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      "volunteering.assignGroupCoordinator.notify_skipped_no_base_url",
      expect.anything(),
    );
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
      tags: {
        useCase: "assignGroupCoordinator",
        stage: "notify",
        reason: "no_base_url",
      },
      extra: { groupId: GROUP_ID },
    });
  });

  // ── Daily cap on NEW addresses (review #1) ──────────────────────────────

  it("spends the actor's daily new-address budget for an address with no account", async () => {
    const { deps, rateLimit } = makeDepsWithMocks();
    await assignGroupCoordinator(deps, {
      actorHumanId: ACTOR_ID,
      groupId: GROUP_ID,
      coordinatorEmail: NEW_EMAIL,
    });

    expect(rateLimit.consume).toHaveBeenCalledWith(
      `volunteer:assignCoordinator:newEmail:${ACTOR_ID}`,
      20,
      86400,
    );
  });

  it("does not spend the budget for an address that already has an account, nor for coordinatorHumanId", async () => {
    const { deps, rateLimit } = makeDepsWithMocks();
    await assignGroupCoordinator(deps, {
      actorHumanId: ACTOR_ID,
      groupId: GROUP_ID,
      coordinatorEmail: "existing@example.com",
    });
    await assignGroupCoordinator(deps, {
      actorHumanId: ACTOR_ID,
      groupId: GROUP_ID,
      coordinatorHumanId: COORDINATOR_ID,
    });

    expect(rateLimit.consume).not.toHaveBeenCalled();
  });

  it("refuses a new address with RATE_LIMITED once the daily budget is spent — nothing written", async () => {
    const { deps, txRepos, rateLimit, notify } = makeDepsWithMocks();
    rateLimit.consume.mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 3600,
    });

    await expect(
      assignGroupCoordinator(deps, {
        actorHumanId: ACTOR_ID,
        groupId: GROUP_ID,
        coordinatorEmail: NEW_EMAIL,
      }),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(deps.repos.tx).not.toHaveBeenCalled();
    expect((txRepos.humans as any).ensureGuestHuman).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("fails CLOSED and reports when the limiter errors", async () => {
    const { deps, rateLimit } = makeDepsWithMocks();
    const boom = new Error("redis down");
    rateLimit.consume.mockRejectedValueOnce(boom);
    const reportError = vi.fn();
    deps.reportError = reportError;

    await expect(
      assignGroupCoordinator(deps, {
        actorHumanId: ACTOR_ID,
        groupId: GROUP_ID,
        coordinatorEmail: NEW_EMAIL,
      }),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(deps.repos.tx).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(boom, {
      tags: {
        useCase: "assignGroupCoordinator",
        area: "coordinator_new_email_cap",
        reason: "consume_failed",
      },
      extra: { actorHumanId: ACTOR_ID },
    });
  });

  it("fails CLOSED and reports when no limiter is wired", async () => {
    const { deps } = makeDepsWithMocks();
    deps.rateLimit = null;
    const reportError = vi.fn();
    deps.reportError = reportError;

    await expect(
      assignGroupCoordinator(deps, {
        actorHumanId: ACTOR_ID,
        groupId: GROUP_ID,
        coordinatorEmail: NEW_EMAIL,
      }),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(deps.repos.tx).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ reason: "limiter_unwired" }),
      }),
    );
  });

  it("does not fail the assignment when the notification send throws", async () => {
    const { deps, notify, logger } = makeDepsWithMocks();
    notify.mockRejectedValueOnce(new Error("smtp down"));

    const result = await assignGroupCoordinator(deps, {
      actorHumanId: ACTOR_ID,
      groupId: GROUP_ID,
      coordinatorHumanId: COORDINATOR_ID,
    });

    expect(result.coordinatorHumanId).toBe(COORDINATOR_ID);
    expect(logger.error).toHaveBeenCalledWith(
      "volunteering.assignGroupCoordinator.notify_failed",
      expect.objectContaining({ groupId: GROUP_ID }),
    );
  });

  // B2 (account squatting through guest checkout): the seat can be given BY
  // EMAIL to an existing account, so an unverified coordinator may be someone
  // else's. Email still goes; in-app and push only to a verified account.
  describe("verified coordinators only for in-app and push (B2)", () => {
    const EMAIL_ONLY = {
      inApp: { enabled: false },
      push: { enabled: false },
      sms: { enabled: false },
    };

    it("sends a verified coordinator the notice on every channel", async () => {
      const { deps, notify, listEmailVerifiedIds } = makeDepsWithMocks();
      await assignGroupCoordinator(deps, {
        actorHumanId: ACTOR_ID,
        groupId: GROUP_ID,
        coordinatorHumanId: COORDINATOR_ID,
      });

      expect(listEmailVerifiedIds).toHaveBeenCalledWith([COORDINATOR_ID]);
      const call = (notify.mock.calls[0] as unknown as [NotifyInput])[0];
      expect(call.channels).toBeUndefined();
    });

    it("sends an unverified coordinator email only", async () => {
      const { deps, notify, listEmailVerifiedIds } = makeDepsWithMocks();
      listEmailVerifiedIds.mockResolvedValueOnce([]);
      await assignGroupCoordinator(deps, {
        actorHumanId: ACTOR_ID,
        groupId: GROUP_ID,
        coordinatorHumanId: COORDINATOR_ID,
      });

      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({
          humanId: COORDINATOR_ID,
          variant: "volunteer.group-coordinator-assigned",
          channels: EMAIL_ONLY,
        }),
      );
    });

    it("a failed lookup still assigns, sends email only, logs ERROR and reports", async () => {
      const { deps, notify, logger, listEmailVerifiedIds } =
        makeDepsWithMocks();
      const reportError = vi.fn();
      deps.reportError = reportError;
      listEmailVerifiedIds.mockRejectedValueOnce(new Error("db down"));

      const result = await assignGroupCoordinator(deps, {
        actorHumanId: ACTOR_ID,
        groupId: GROUP_ID,
        coordinatorHumanId: COORDINATOR_ID,
      });

      expect(result.coordinatorHumanId).toBe(COORDINATOR_ID);
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({ channels: EMAIL_ONLY }),
      );
      expect(logger.error).toHaveBeenCalledWith(
        "volunteering.assignGroupCoordinator.verified_lookup_failed",
        expect.objectContaining({ coordinatorHumanId: COORDINATOR_ID }),
      );
      expect(reportError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          tags: expect.objectContaining({ stage: "verified_lookup" }),
        }),
      );
    });
  });
});
