import { describe, expect, it, vi } from "vitest";

import type { Repos, TxRepos } from "@th/ports/repos";

import { setVolunteerReward } from "./set-volunteer-reward";
import type { SetVolunteerRewardDeps } from "./set-volunteer-reward";

// ── Constants ────────────────────────────────────────────────────────────────

const ACTOR_ID = "00000000-0000-4000-8000-000000000001";
const EVENT_ID = "00000000-0000-4000-8000-000000000002";
const ORG_ID = "00000000-0000-4000-8000-000000000003";
const ASK_ID = "00000000-0000-4000-8000-000000000004";
const ROLE_ID = "00000000-0000-4000-8000-000000000005";
const TICKET_TYPE_ID = "00000000-0000-4000-8000-000000000006";
const REWARD_ID = "00000000-0000-4000-8000-000000000007";
const NOW = new Date("2026-07-02T12:00:00.000Z");

// ── Fixtures ─────────────────────────────────────────────────────────────────

const eventAsk = {
  id: ASK_ID,
  subjectType: "EVENT" as const,
  subjectId: EVENT_ID,
  orgId: ORG_ID,
  title: "Door crew",
  description: null,
  status: "OPEN" as const,
  cadence: "ONE_TIME" as const,
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

const baseTicketType = {
  id: TICKET_TYPE_ID,
  name: "General Admission",
  priceCents: 5000,
  capacity: 100,
  status: "ACTIVE" as const,
  seatSectionId: null,
  resaleAllowed: false,
  resaleCapCents: null,
  transferAllowed: true,
};

const baseRole = {
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

function makeTxRepos(overrides: Record<string, unknown> = {}) {
  const upsertReward = vi.fn(async (input: any) => ({
    id: REWARD_ID,
    askId: input.askId,
    roleId: input.roleId ?? null,
    ticketTypeId: input.ticketTypeId,
    trigger: input.trigger ?? "ON_CHECK_IN",
    maxGrants: input.maxGrants ?? null,
    grantsUsed: 0,
    active: true,
    createdAt: NOW,
    updatedAt: NOW,
  }));
  return {
    volunteering: {
      getAsk: vi.fn(async () => eventAsk),
      getEventRole: vi.fn(async () => baseRole),
      upsertReward,
    },
    events: {
      listTicketTypes: vi.fn(async () => [baseTicketType]),
    },
    authz: {
      getOrgMembership: vi.fn(async () => ({ role: "FINANCE" })),
    },
    audit: { log: vi.fn(async () => undefined) },
    ...overrides,
  };
}

function makeDeps(txOverrides: Record<string, unknown> = {}) {
  const txRepos = makeTxRepos(txOverrides);
  const deps: SetVolunteerRewardDeps = {
    repos: {
      tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) =>
        fn(txRepos as unknown as TxRepos),
      ),
    } as unknown as Repos,
    clock: { now: () => NOW },
  };
  return { deps, txRepos };
}

const validInput = {
  actorHumanId: ACTOR_ID,
  askId: ASK_ID,
  ticketTypeId: TICKET_TYPE_ID,
  trigger: "ON_CHECK_IN" as const,
  maxGrants: 50,
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe("setVolunteerReward", () => {
  it("upserts a COMP reward on an EVENT ask and audits volunteer_reward_set", async () => {
    const { deps, txRepos } = makeDeps();

    const result = await setVolunteerReward(deps, validInput);

    expect(result).toEqual({ ok: true, rewardId: REWARD_ID });
    expect((txRepos.volunteering as any).upsertReward).toHaveBeenCalledWith(
      expect.objectContaining({
        askId: ASK_ID,
        roleId: null,
        ticketTypeId: TICKET_TYPE_ID,
        trigger: "ON_CHECK_IN",
        maxGrants: 50,
      }),
    );
    expect((txRepos.audit as any).log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "volunteer_reward",
        action: "volunteer_reward_set",
        data: expect.objectContaining({
          askId: ASK_ID,
          ticketTypeId: TICKET_TYPE_ID,
          faceValueCents: 5000,
        }),
      }),
    );
  });

  it("rejects a non-EVENT-subject ask with reward_requires_event_ask", async () => {
    const { deps } = makeDeps({
      volunteering: {
        getAsk: vi.fn(async () => ({
          ...eventAsk,
          subjectType: "ORG",
          subjectId: ORG_ID,
        })),
        getEventRole: vi.fn(async () => baseRole),
        upsertReward: vi.fn(),
      },
    });

    await expect(setVolunteerReward(deps, validInput)).rejects.toMatchObject({
      code: "CONFLICT",
      message: "reward_requires_event_ask",
    });
  });

  it("rejects when the ticket type does not belong to the ask's event", async () => {
    const { deps } = makeDeps({
      events: { listTicketTypes: vi.fn(async () => []) },
    });

    await expect(setVolunteerReward(deps, validInput)).rejects.toMatchObject({
      code: "TICKET_TYPE_NOT_FOUND",
    });
  });

  it("rejects a role-scoped reward whose role is not on the ask", async () => {
    const { deps } = makeDeps({
      volunteering: {
        getAsk: vi.fn(async () => eventAsk),
        getEventRole: vi.fn(async () => ({ ...baseRole, askId: "other-ask" })),
        upsertReward: vi.fn(),
      },
    });

    await expect(
      setVolunteerReward(deps, { ...validInput, roleId: ROLE_ID }),
    ).rejects.toMatchObject({ code: "ROLE_NOT_FOUND" });
  });

  it("enforces ORG_FINANCE_ROLES — a VIEWER is forbidden", async () => {
    const { deps } = makeDeps({
      authz: { getOrgMembership: vi.fn(async () => ({ role: "VIEWER" })) },
    });

    await expect(setVolunteerReward(deps, validInput)).rejects.toMatchObject({
      code: "INSUFFICIENT_ROLE",
    });
  });

  it("enforces ORG_FINANCE_ROLES — an EDITOR (not finance) is forbidden", async () => {
    const { deps } = makeDeps({
      authz: { getOrgMembership: vi.fn(async () => ({ role: "EDITOR" })) },
    });

    await expect(setVolunteerReward(deps, validInput)).rejects.toMatchObject({
      code: "INSUFFICIENT_ROLE",
    });
  });

  it("maps the adapter's duplicate_reward race to a conflict", async () => {
    const { deps } = makeDeps({
      volunteering: {
        getAsk: vi.fn(async () => eventAsk),
        getEventRole: vi.fn(async () => baseRole),
        upsertReward: vi.fn(async () => {
          throw { code: "duplicate_reward", message: "duplicate_reward" };
        }),
      },
    });

    await expect(setVolunteerReward(deps, validInput)).rejects.toMatchObject({
      code: "CONFLICT",
      message: "duplicate_reward",
    });
  });

  it("rejects a missing ask", async () => {
    const { deps } = makeDeps({
      volunteering: {
        getAsk: vi.fn(async () => null),
        getEventRole: vi.fn(),
        upsertReward: vi.fn(),
      },
    });

    await expect(setVolunteerReward(deps, validInput)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
