import { describe, expect, it, vi } from "vitest";

import type { Repos, TxRepos } from "@th/ports/repos";
import type { VolunteerBroadcastRecipient } from "@th/ports/repos/volunteering";
import type { NotifyOutput } from "../comms/notify";

import { broadcastToRoster } from "./broadcast-to-roster";
import type { BroadcastToRosterDeps } from "./broadcast-to-roster";

// ── Constants ────────────────────────────────────────────────────────────────

const OWNER_ID = "00000000-0000-4000-8000-000000000001";
const COORDINATOR_ID = "00000000-0000-4000-8000-000000000002";
const OTHER_COORDINATOR_ID = "00000000-0000-4000-8000-000000000003";
const ORG_ID = "00000000-0000-4000-8000-000000000004";
const ASK_ID = "00000000-0000-4000-8000-000000000005";
const OTHER_ASK_ID = "00000000-0000-4000-8000-000000000006";
const GROUP_ID = "00000000-0000-4000-8000-000000000007";
const OTHER_GROUP_ID = "00000000-0000-4000-8000-000000000008";
const ROLE_ID = "00000000-0000-4000-8000-000000000010";
const BROADCAST_ID = "00000000-0000-4000-8000-000000000011";
const HUMAN_A = "00000000-0000-4000-8000-000000000012";
const SIGNUP_A = "00000000-0000-4000-8000-000000000013";
const SIGNUP_B = "00000000-0000-4000-8000-000000000014";
const SIGNUP_C = "00000000-0000-4000-8000-000000000015";
const NOW = new Date("2026-07-02T12:00:00.000Z");

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

const askRole = {
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
};

const recipientWithAccount: VolunteerBroadcastRecipient = {
  signupId: SIGNUP_A,
  humanId: HUMAN_A,
  contactEmail: "alice@example.com",
  contactName: "Alice",
};

const shadowRecipient: VolunteerBroadcastRecipient = {
  signupId: SIGNUP_B,
  humanId: null,
  contactEmail: "bob@example.com",
  contactName: null,
};

const storedBroadcast = {
  id: BROADCAST_ID,
  askId: ASK_ID,
  senderHumanId: OWNER_ID,
  scopeType: "ALL" as const,
  scopeId: null,
  subject: "Schedule change",
  body: "Doors now open at 7pm.",
  recipientCount: 5,
  createdAt: NOW,
};

const NOTIFY_RESULT: NotifyOutput = {
  ok: true,
  variant: "volunteer.broadcast",
  category: "organizerMessages",
  scope: { kind: "ORG", orgId: ORG_ID },
  inApp: { status: "skipped", reason: "no_adapter" },
};

const validInput = {
  actorHumanId: OWNER_ID,
  askId: ASK_ID,
  scope: { kind: "ALL" as const },
  subject: "Schedule change",
  body: "Doors now open at 7pm.",
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
    organizations: {
      getById: vi.fn(async () => ({
        id: ORG_ID,
        name: "Dev QA Collective",
        contactEmail: "hello@devqa.example",
      })),
    },
    // The coordinator seat needs a verified email (B2); every actor here is
    // verified unless a test says otherwise.
    humans: {
      getByIdWithIdentity: vi.fn(async () => ({
        identity: { emailVerified: true },
      })),
    },
    volunteering: {
      getAsk: vi.fn(async () => baseAsk),
      getGroup: vi.fn(async (id: string) => groupsById[id] ?? null),
      getEventRole: vi.fn(async () => askRole),
      getBroadcast: vi.fn(async () => null),
      listBroadcastRecipients: vi.fn(async () => [
        recipientWithAccount,
        shadowRecipient,
      ]),
      createBroadcast: vi.fn(async (input: any) => ({
        id: input.id ?? BROADCAST_ID,
        askId: input.askId,
        senderHumanId: input.senderHumanId,
        scopeType: input.scopeType,
        scopeId: input.scopeId ?? null,
        subject: input.subject,
        body: input.body,
        recipientCount: input.recipientCount,
        createdAt: NOW,
      })),
    },
    audit: { log: vi.fn(async () => undefined) },
    ...overrides,
  };
}

function makeDeps(txOverrides: Record<string, unknown> = {}) {
  const txRepos = makeTxRepos(txOverrides);
  const notify = vi.fn(async () => NOTIFY_RESULT);
  const mailerSend = vi.fn(async () => ({
    result: { id: "msg", status: "sent" },
  }));
  const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
  // Empty snapshot = category defaults apply (organizerMessages email on).
  const readEffective = vi.fn(async () => ({}));
  const deps: BroadcastToRosterDeps = {
    repos: {
      tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) =>
        fn(txRepos as unknown as TxRepos),
      ),
      notificationPrefs: { readEffective },
    } as unknown as Repos,
    clock: { now: () => NOW },
    mailer: { send: mailerSend as any },
    notify,
    appBaseUrl: "https://test.local",
    logger: logger as any,
  };
  return { deps, txRepos, notify, mailerSend, logger, readEffective };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("broadcastToRoster", () => {
  it("owner ALL: writes the ledger row with the deduped recipient count, audits, emails, and notifies account holders", async () => {
    const { deps, txRepos, notify, mailerSend } = makeDeps();

    const result = await broadcastToRoster(deps, validInput);

    expect(result).toEqual({
      ok: true,
      broadcastId: BROADCAST_ID,
      recipientCount: 2,
    });
    expect(
      (txRepos.volunteering as any).listBroadcastRecipients,
    ).toHaveBeenCalledWith(ASK_ID, { kind: "ALL" });
    expect((txRepos.volunteering as any).createBroadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        askId: ASK_ID,
        senderHumanId: OWNER_ID,
        scopeType: "ALL",
        scopeId: null,
        subject: "Schedule change",
        body: "Doors now open at 7pm.",
        recipientCount: 2,
      }),
    );
    expect((txRepos.audit as any).log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "volunteer_broadcast",
        entityId: BROADCAST_ID,
        action: "broadcast_sent",
        data: expect.objectContaining({
          askId: ASK_ID,
          scopeType: "ALL",
          recipientCount: 2,
          via: "owner",
        }),
      }),
    );

    // One email per deduped contact, keyed on (broadcastId, signupId).
    expect(mailerSend).toHaveBeenCalledTimes(2);
    expect(mailerSend).toHaveBeenCalledWith(
      expect.objectContaining({
        to: { to: "alice@example.com", name: "Alice" },
        subject: "Schedule change",
        idempotencyKey: `volunteer-broadcast:${BROADCAST_ID}:${SIGNUP_A}`,
      }),
    );
    expect(mailerSend).toHaveBeenCalledWith(
      expect.objectContaining({
        to: { to: "bob@example.com" },
        idempotencyKey: `volunteer-broadcast:${BROADCAST_ID}:${SIGNUP_B}`,
      }),
    );

    // In-app only for the recipient with an account.
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        humanId: HUMAN_A,
        variant: "volunteer.broadcast",
        scope: { kind: "ORG", orgId: ORG_ID },
        idempotencyKey: `${BROADCAST_ID}:broadcast:${HUMAN_A}`,
        payload: expect.objectContaining({
          askId: ASK_ID,
          broadcastId: BROADCAST_ID,
          askTitle: "Standing bar crew",
          subject: "Schedule change",
          body: "Doors now open at 7pm.",
        }),
      }),
    );
  });

  it("sets Reply-To to the owning org's contact email; omits it when none is on file", async () => {
    const { deps, mailerSend } = makeDeps();
    await broadcastToRoster(deps, validInput);
    expect(mailerSend).toHaveBeenCalledWith(
      expect.objectContaining({
        replyTo: { to: "hello@devqa.example", name: "Dev QA Collective" },
      }),
    );

    const noEmail = makeDeps({
      organizations: {
        getById: vi.fn(async () => ({
          id: ORG_ID,
          name: "Dev QA Collective",
          contactEmail: null,
        })),
      },
    });
    await broadcastToRoster(noEmail.deps, validInput);
    for (const call of noEmail.mailerSend.mock.calls) {
      expect((call as any[])[0].replyTo).toBeUndefined();
    }
  });

  it.each([
    ["ROLE", { kind: "ROLE" as const, roleId: ROLE_ID }, ROLE_ID],
    ["GROUP", { kind: "GROUP" as const, groupId: GROUP_ID }, GROUP_ID],
    ["POOL", { kind: "POOL" as const }, null],
  ])("owner %s scope: validates the target and stamps scopeId", async (_kind, scope, scopeId) => {
    const { deps, txRepos } = makeDeps();

    const result = await broadcastToRoster(deps, { ...validInput, scope });

    expect(result.ok).toBe(true);
    expect(
      (txRepos.volunteering as any).listBroadcastRecipients,
    ).toHaveBeenCalledWith(ASK_ID, scope);
    expect((txRepos.volunteering as any).createBroadcast).toHaveBeenCalledWith(
      expect.objectContaining({ scopeType: scope.kind, scopeId }),
    );
  });

  it("coordinator may broadcast to their OWN group", async () => {
    const { deps, txRepos } = makeDeps({
      authz: { getOrgMembership: vi.fn(async () => null) },
    });

    const result = await broadcastToRoster(deps, {
      ...validInput,
      actorHumanId: COORDINATOR_ID,
      scope: { kind: "GROUP", groupId: GROUP_ID },
    });

    expect(result.ok).toBe(true);
    expect((txRepos.audit as any).log).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ via: "coordinator" }),
      }),
    );
  });

  it.each([
    ["ALL", { kind: "ALL" as const }],
    ["POOL", { kind: "POOL" as const }],
    ["ROLE", { kind: "ROLE" as const, roleId: ROLE_ID }],
    ["another coordinator's GROUP", { kind: "GROUP" as const, groupId: OTHER_GROUP_ID }],
  ])(
    "coordinator targeting %s gets the uniform ownership denial",
    async (_label, scope) => {
      const { deps, txRepos, mailerSend } = makeDeps({
        authz: { getOrgMembership: vi.fn(async () => null) },
      });

      await expect(
        broadcastToRoster(deps, {
          ...validInput,
          actorHumanId: COORDINATOR_ID,
          scope,
        }),
      ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
      expect(
        (txRepos.volunteering as any).createBroadcast,
      ).not.toHaveBeenCalled();
      expect(mailerSend).not.toHaveBeenCalled();
    },
  );

  it("coordinator naming a foreign-ask group gets the same uniform denial (never a 404)", async () => {
    const { deps } = makeDeps({
      authz: { getOrgMembership: vi.fn(async () => null) },
      volunteering: {
        ...makeTxRepos().volunteering,
        getGroup: vi.fn(async () => ({
          ...baseGroup,
          askId: OTHER_ASK_ID,
        })),
      },
    });

    await expect(
      broadcastToRoster(deps, {
        ...validInput,
        actorHumanId: COORDINATOR_ID,
        scope: { kind: "GROUP", groupId: GROUP_ID },
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("404s an owner's ROLE scope naming a foreign-ask role", async () => {
    const { deps } = makeDeps({
      volunteering: {
        ...makeTxRepos().volunteering,
        getEventRole: vi.fn(async () => ({ ...askRole, askId: OTHER_ASK_ID })),
      },
    });

    await expect(
      broadcastToRoster(deps, {
        ...validInput,
        scope: { kind: "ROLE", roleId: ROLE_ID },
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "role_not_found" });
  });

  it("404s an owner's GROUP scope naming a foreign-ask group", async () => {
    const { deps } = makeDeps({
      volunteering: {
        ...makeTxRepos().volunteering,
        getGroup: vi.fn(async () => ({ ...baseGroup, askId: OTHER_ASK_ID })),
      },
    });

    await expect(
      broadcastToRoster(deps, {
        ...validInput,
        scope: { kind: "GROUP", groupId: GROUP_ID },
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "group_not_found" });
  });

  it("idempotent replay by broadcastId: stored count returned, nothing re-resolved or re-sent", async () => {
    const { deps, txRepos, notify, mailerSend } = makeDeps({
      volunteering: {
        ...makeTxRepos().volunteering,
        getBroadcast: vi.fn(async () => storedBroadcast),
      },
    });

    const result = await broadcastToRoster(deps, {
      ...validInput,
      broadcastId: BROADCAST_ID,
    });

    expect(result).toEqual({
      ok: true,
      broadcastId: BROADCAST_ID,
      recipientCount: 5,
    });
    expect(
      (txRepos.volunteering as any).listBroadcastRecipients,
    ).not.toHaveBeenCalled();
    expect(
      (txRepos.volunteering as any).createBroadcast,
    ).not.toHaveBeenCalled();
    expect((txRepos.audit as any).log).not.toHaveBeenCalled();
    expect(mailerSend).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("replay still works on an ARCHIVED ask (retry of a pre-archive send)", async () => {
    const { deps } = makeDeps({
      volunteering: {
        ...makeTxRepos().volunteering,
        getAsk: vi.fn(async () => ({ ...baseAsk, status: "ARCHIVED" })),
        getBroadcast: vi.fn(async () => storedBroadcast),
      },
    });

    const result = await broadcastToRoster(deps, {
      ...validInput,
      broadcastId: BROADCAST_ID,
    });
    expect(result.recipientCount).toBe(5);
  });

  it("rejects a broadcastId replay whose stored row doesn't match this request", async () => {
    const { deps } = makeDeps({
      volunteering: {
        ...makeTxRepos().volunteering,
        getBroadcast: vi.fn(async () => ({
          ...storedBroadcast,
          body: "Different body entirely.",
        })),
      },
    });

    await expect(
      broadcastToRoster(deps, { ...validInput, broadcastId: BROADCAST_ID }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_CONFLICT" });
  });

  it("maps a create race (duplicate_broadcast) to a retryable CONFLICT", async () => {
    const { deps, mailerSend } = makeDeps({
      volunteering: {
        ...makeTxRepos().volunteering,
        createBroadcast: vi.fn(async () => {
          throw {
            code: "duplicate_broadcast",
            message: "duplicate_broadcast",
          } as const;
        }),
      },
    });

    await expect(
      broadcastToRoster(deps, { ...validInput, broadcastId: BROADCAST_ID }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "duplicate_broadcast",
    });
    expect(mailerSend).not.toHaveBeenCalled();
  });

  it("empty recipient set: ledger row still written with count 0, no sends", async () => {
    const { deps, txRepos, notify, mailerSend } = makeDeps({
      volunteering: {
        ...makeTxRepos().volunteering,
        listBroadcastRecipients: vi.fn(async () => []),
      },
    });

    const result = await broadcastToRoster(deps, validInput);

    expect(result.recipientCount).toBe(0);
    expect((txRepos.volunteering as any).createBroadcast).toHaveBeenCalledWith(
      expect.objectContaining({ recipientCount: 0 }),
    );
    expect(mailerSend).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("dedupes recipients by email (first signup is the mailer key) but keeps a later row's account linkage", async () => {
    const { deps, notify, mailerSend } = makeDeps({
      volunteering: {
        ...makeTxRepos().volunteering,
        listBroadcastRecipients: vi.fn(async () => [
          { ...shadowRecipient, contactEmail: "Alice@Example.com" },
          { ...recipientWithAccount, signupId: SIGNUP_C },
        ]),
      },
    });

    const result = await broadcastToRoster(deps, validInput);

    expect(result.recipientCount).toBe(1);
    expect(mailerSend).toHaveBeenCalledTimes(1);
    // Earliest signup stays the idempotency representative.
    expect(mailerSend).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: `volunteer-broadcast:${BROADCAST_ID}:${SIGNUP_B}`,
      }),
    );
    // The later signup's humanId still gets the in-app notification.
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ humanId: HUMAN_A }),
    );
  });

  it("shadow (humanId-less) recipients get email only, with no preference read", async () => {
    const { deps, notify, mailerSend, readEffective } = makeDeps({
      volunteering: {
        ...makeTxRepos().volunteering,
        listBroadcastRecipients: vi.fn(async () => [shadowRecipient]),
      },
    });

    await broadcastToRoster(deps, validInput);

    expect(mailerSend).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
    expect(readEffective).not.toHaveBeenCalled();
  });

  it("FR-009: skips the direct email for an account holder who disabled organizerMessages email; in-app notify still attempted; shadow recipient unaffected", async () => {
    const { deps, notify, mailerSend, logger, readEffective } = makeDeps();
    readEffective.mockResolvedValue({
      email: { organizerMessages: false },
    } as any);

    const result = await broadcastToRoster(deps, validInput);

    expect(result.ok).toBe(true);
    // Same read the notify pipeline uses: effective prefs at ORG scope.
    expect(readEffective).toHaveBeenCalledWith({
      humanId: HUMAN_A,
      scope: { kind: "ORG", orgId: ORG_ID },
    });
    // Only the shadow recipient (no preferences) is emailed.
    expect(mailerSend).toHaveBeenCalledTimes(1);
    expect(mailerSend).toHaveBeenCalledWith(
      expect.objectContaining({ to: { to: "bob@example.com" } }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      "volunteering.broadcastToRoster.email_skipped",
      expect.objectContaining({
        broadcastId: BROADCAST_ID,
        signupId: SIGNUP_A,
        reason: "channel_disabled",
      }),
    );
    // The in-app leg still runs — notify does its own preference handling.
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ humanId: HUMAN_A }),
    );
  });

  it("preference-read failure fails CLOSED: email skipped and logged (mirrors notify + send-announcement), notify still attempted", async () => {
    const { deps, notify, mailerSend, logger, readEffective } = makeDeps();
    readEffective.mockRejectedValue(new Error("prefs db down"));

    const result = await broadcastToRoster(deps, validInput);

    expect(result.ok).toBe(true);
    // Alice (humanId) is NOT emailed; shadow Bob still is.
    expect(mailerSend).toHaveBeenCalledTimes(1);
    expect(mailerSend).toHaveBeenCalledWith(
      expect.objectContaining({ to: { to: "bob@example.com" } }),
    );
    expect(logger.error).toHaveBeenCalledWith(
      "volunteering.broadcastToRoster.preference_read_failed",
      expect.objectContaining({
        broadcastId: BROADCAST_ID,
        signupId: SIGNUP_A,
      }),
    );
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("stranger probing a KNOWN broadcastId gets the uniform denial before the replay pre-read (anti-oracle)", async () => {
    const getBroadcast = vi.fn(async () => storedBroadcast);
    const { deps, txRepos, mailerSend } = makeDeps({
      authz: { getOrgMembership: vi.fn(async () => null) },
      volunteering: {
        ...makeTxRepos().volunteering,
        getBroadcast,
      },
    });

    await expect(
      broadcastToRoster(deps, {
        ...validInput,
        // A stranger: not an org member, not a coordinator of any group.
        actorHumanId: OTHER_COORDINATOR_ID,
        broadcastId: BROADCAST_ID,
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });

    // The replay pre-read never runs for an unauthorized actor — a known
    // broadcastId must not become an existence/content oracle, and the
    // stored counts are never returned.
    expect(getBroadcast).not.toHaveBeenCalled();
    expect(
      (txRepos.volunteering as any).listBroadcastRecipients,
    ).not.toHaveBeenCalled();
    expect(mailerSend).not.toHaveBeenCalled();
  });

  it("uses GLOBAL notify scope for non-org asks", async () => {
    const { deps, notify } = makeDeps({
      volunteering: {
        ...makeTxRepos().volunteering,
        getAsk: vi.fn(async () => ({
          ...baseAsk,
          subjectType: "HUMAN",
          subjectId: OWNER_ID,
          orgId: null,
        })),
      },
    });

    await broadcastToRoster(deps, validInput);

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ scope: { kind: "GLOBAL" } }),
    );
  });

  it("mailer and notify failures are logged, never fail the broadcast", async () => {
    const { deps, logger, mailerSend, notify } = makeDeps();
    mailerSend.mockRejectedValueOnce(new Error("smtp down"));
    (notify as any).mockRejectedValueOnce(new Error("notify down"));

    const result = await broadcastToRoster(deps, validInput);

    expect(result.ok).toBe(true);
    expect(logger.error).toHaveBeenCalledWith(
      "volunteering.broadcastToRoster.email_failed",
      expect.objectContaining({ broadcastId: BROADCAST_ID }),
    );
    expect(logger.error).toHaveBeenCalledWith(
      "volunteering.broadcastToRoster.notify_failed",
      expect.objectContaining({ broadcastId: BROADCAST_ID }),
    );
  });

  it("refuses ARCHIVED asks but allows CLOSED rosters (roster preserved per FR-007)", async () => {
    const archived = makeDeps({
      volunteering: {
        ...makeTxRepos().volunteering,
        getAsk: vi.fn(async () => ({ ...baseAsk, status: "ARCHIVED" })),
      },
    });
    await expect(
      broadcastToRoster(archived.deps, validInput),
    ).rejects.toMatchObject({ code: "CONFLICT", message: "ask_archived" });

    const closed = makeDeps({
      volunteering: {
        ...makeTxRepos().volunteering,
        getAsk: vi.fn(async () => ({ ...baseAsk, status: "CLOSED" })),
      },
    });
    const result = await broadcastToRoster(closed.deps, validInput);
    expect(result.ok).toBe(true);
  });

  it("404s a missing ask", async () => {
    const { deps } = makeDeps({
      volunteering: {
        ...makeTxRepos().volunteering,
        getAsk: vi.fn(async () => null),
      },
    });

    await expect(broadcastToRoster(deps, validInput)).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "ask_not_found",
    });
  });

  it("rejects oversized subject/body at the schema boundary", async () => {
    const { deps } = makeDeps();
    await expect(
      broadcastToRoster(deps, { ...validInput, subject: "x".repeat(201) }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      broadcastToRoster(deps, { ...validInput, body: "x".repeat(5001) }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
