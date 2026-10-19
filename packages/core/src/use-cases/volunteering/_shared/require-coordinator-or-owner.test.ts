import { describe, expect, it, vi } from "vitest";

import type { TxRepos } from "@th/ports/repos";

import { requireCoordinatorOrOwner } from "./require-coordinator-or-owner";

const ACTOR_ID = "00000000-0000-4000-8000-000000000001";
const ORG_ID = "00000000-0000-4000-8000-000000000002";
const ASK_ID = "00000000-0000-4000-8000-000000000003";
const GROUP_ID = "00000000-0000-4000-8000-000000000004";
const OTHER_ASK_ID = "00000000-0000-4000-8000-000000000005";
const OTHER_HUMAN_ID = "00000000-0000-4000-8000-000000000006";
const EVENT_ID = "00000000-0000-4000-8000-000000000007";
const NOW = new Date("2026-07-01T12:00:00.000Z");

const orgAsk = {
  id: ASK_ID,
  subjectType: "ORG" as const,
  subjectId: ORG_ID,
  orgId: ORG_ID,
  title: "Standing crew",
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
  coordinatorHumanId: ACTOR_ID,
  createdAt: NOW,
  updatedAt: NOW,
};

function makeTx(overrides: Record<string, unknown> = {}): TxRepos {
  return {
    authz: {
      // Default: not a member → owner check denies.
      getOrgMembership: vi.fn(async () => null),
    },
    events: {
      getById: vi.fn(async () => null),
    },
    // The coordinator seat needs a verified email (B2); every actor here is
    // verified unless a test says otherwise.
    humans: {
      getByIdWithIdentity: vi.fn(async () => ({
        identity: { emailVerified: true },
      })),
    },
    volunteering: {
      getGroup: vi.fn(async () => baseGroup),
    },
    ...overrides,
  } as unknown as TxRepos;
}

describe("requireCoordinatorOrOwner", () => {
  it("grants via 'owner' when the actor owns the ask subject", async () => {
    const tx = makeTx({
      authz: { getOrgMembership: vi.fn(async () => ({ role: "ADMIN" })) },
    });

    const access = await requireCoordinatorOrOwner(
      tx,
      { ask: orgAsk, signupGroupId: GROUP_ID },
      ACTOR_ID,
    );

    expect(access).toEqual({ via: "owner", group: null });
    // Owner short-circuits — the group is never even loaded.
    expect((tx as any).volunteering.getGroup).not.toHaveBeenCalled();
  });

  // B2: a coordinator assigned by email may be an unverified account someone
  // else opened under that address. The seat opens once the inbox is proven.
  it("refuses an unverified coordinator with email_verification_required", async () => {
    const tx = makeTx({
      humans: {
        getByIdWithIdentity: vi.fn(async () => ({
          identity: { emailVerified: false },
        })),
      },
    });

    await expect(
      requireCoordinatorOrOwner(
        tx,
        { ask: orgAsk, signupGroupId: GROUP_ID },
        ACTOR_ID,
      ),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: "email_verification_required",
    });
  });

  it("an unverified OWNER is unaffected (the check is the coordinator leg only)", async () => {
    const tx = makeTx({
      authz: { getOrgMembership: vi.fn(async () => ({ role: "ADMIN" })) },
      humans: {
        getByIdWithIdentity: vi.fn(async () => ({
          identity: { emailVerified: false },
        })),
      },
    });

    await expect(
      requireCoordinatorOrOwner(
        tx,
        { ask: orgAsk, signupGroupId: GROUP_ID },
        ACTOR_ID,
      ),
    ).resolves.toEqual({ via: "owner", group: null });
    expect((tx as any).humans.getByIdWithIdentity).not.toHaveBeenCalled();
  });

  it("a stranger still gets the uniform ownership denial, with no identity read", async () => {
    const tx = makeTx({
      volunteering: {
        getGroup: vi.fn(async () => ({
          ...baseGroup,
          coordinatorHumanId: "99999999-9999-4999-8999-999999999999",
        })),
      },
    });

    await expect(
      requireCoordinatorOrOwner(
        tx,
        { ask: orgAsk, signupGroupId: GROUP_ID },
        ACTOR_ID,
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    expect((tx as any).humans.getByIdWithIdentity).not.toHaveBeenCalled();
  });

  it("grants via 'coordinator' when the actor coordinates the signup's group", async () => {
    const tx = makeTx();

    const access = await requireCoordinatorOrOwner(
      tx,
      { ask: orgAsk, signupGroupId: GROUP_ID },
      ACTOR_ID,
    );

    expect(access.via).toBe("coordinator");
    expect(access.group).toMatchObject({ id: GROUP_ID });
    // Loaded fresh in the same tx (NFR-002).
    expect((tx as any).volunteering.getGroup).toHaveBeenCalledWith(GROUP_ID);
  });

  it("rejects a coordinator acting on another group's signup with forbidden (not 404)", async () => {
    const tx = makeTx({
      volunteering: {
        // The TARGET signup's group is coordinated by someone else.
        getGroup: vi.fn(async () => ({
          ...baseGroup,
          coordinatorHumanId: OTHER_HUMAN_ID,
        })),
      },
    });

    await expect(
      requireCoordinatorOrOwner(
        tx,
        { ask: orgAsk, signupGroupId: GROUP_ID },
        ACTOR_ID,
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("rejects on pool signups (groupId null) — owner only", async () => {
    const tx = makeTx();

    await expect(
      requireCoordinatorOrOwner(
        tx,
        { ask: orgAsk, signupGroupId: null },
        ACTOR_ID,
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    expect((tx as any).volunteering.getGroup).not.toHaveBeenCalled();
  });

  it("rejects when the coordinated group belongs to a DIFFERENT ask", async () => {
    const tx = makeTx({
      volunteering: {
        getGroup: vi.fn(async () => ({ ...baseGroup, askId: OTHER_ASK_ID })),
      },
    });

    await expect(
      requireCoordinatorOrOwner(
        tx,
        { ask: orgAsk, signupGroupId: GROUP_ID },
        ACTOR_ID,
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("rejects when the group has no coordinator at all", async () => {
    const tx = makeTx({
      volunteering: {
        getGroup: vi.fn(async () => ({
          ...baseGroup,
          coordinatorHumanId: null,
        })),
      },
    });

    await expect(
      requireCoordinatorOrOwner(
        tx,
        { ask: orgAsk, signupGroupId: GROUP_ID },
        ACTOR_ID,
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("propagates structural ownership errors instead of trying coordinator scope", async () => {
    // EVENT-subject ask whose event row is gone: EVENT_NOT_FOUND must
    // surface, never be masked by a coordinator fallback.
    const eventAsk = {
      ...orgAsk,
      subjectType: "EVENT" as const,
      subjectId: EVENT_ID,
    };
    const tx = makeTx();

    await expect(
      requireCoordinatorOrOwner(
        tx,
        { ask: eventAsk, signupGroupId: GROUP_ID },
        ACTOR_ID,
      ),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
    expect((tx as any).volunteering.getGroup).not.toHaveBeenCalled();
  });
});
