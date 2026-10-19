import { describe, expect, it, vi } from "vitest";

import type { Repos, TxRepos } from "@th/ports/repos";

import { listAskRewards } from "./list-ask-rewards";
import type { ListAskRewardsDeps } from "./list-ask-rewards";

// ── Constants ────────────────────────────────────────────────────────────────

const ACTOR_ID = "00000000-0000-4000-8000-000000000001";
const ORG_ID = "00000000-0000-4000-8000-000000000002";
const ASK_ID = "00000000-0000-4000-8000-000000000003";
const EVENT_ID = "00000000-0000-4000-8000-000000000004";
const ROLE_ID = "00000000-0000-4000-8000-000000000005";
const TICKET_TYPE_ID = "00000000-0000-4000-8000-000000000006";
const REWARD_ASK_ID = "00000000-0000-4000-8000-000000000007";
const REWARD_ROLE_ID = "00000000-0000-4000-8000-000000000008";
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

const askLevelReward = {
  id: REWARD_ASK_ID,
  askId: ASK_ID,
  roleId: null,
  ticketTypeId: TICKET_TYPE_ID,
  trigger: "ON_CHECK_IN" as const,
  maxGrants: 50,
  grantsUsed: 3,
  active: true,
  createdAt: NOW,
  updatedAt: NOW,
};

// Zero-grant, capped role-level reward — the case the ledger's grant-derived
// summary would miss.
const roleLevelReward = {
  id: REWARD_ROLE_ID,
  askId: ASK_ID,
  roleId: ROLE_ID,
  ticketTypeId: TICKET_TYPE_ID,
  trigger: "ON_APPROVAL" as const,
  maxGrants: 5,
  grantsUsed: 0,
  active: false,
  createdAt: NOW,
  updatedAt: NOW,
};

const ticketTypes = [
  { id: TICKET_TYPE_ID, name: "General Admission", priceCents: 2500 },
];

function makeTxRepos(overrides: Record<string, unknown> = {}) {
  return {
    volunteering: {
      getAsk: vi.fn(async () => eventAsk),
      listRewardsByAsk: vi.fn(async () => [askLevelReward, roleLevelReward]),
    },
    events: {
      listTicketTypes: vi.fn(async () => ticketTypes),
    },
    authz: {
      getOrgMembership: vi.fn(async () => ({ role: "FINANCE" })),
    },
    ...overrides,
  };
}

function makeDeps(txOverrides: Record<string, unknown> = {}) {
  const txRepos = makeTxRepos(txOverrides);
  const deps: ListAskRewardsDeps = {
    repos: {
      tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) =>
        fn(txRepos as unknown as TxRepos),
      ),
    } as unknown as Repos,
    clock: { now: () => NOW },
  };
  return { deps, txRepos };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("listAskRewards", () => {
  it("enumerates every configured reward incl. inactive / zero-grant, with face value + remaining", async () => {
    const { deps, txRepos } = makeDeps();

    const result = await listAskRewards(deps, {
      actorHumanId: ACTOR_ID,
      askId: ASK_ID,
    });

    expect(txRepos.volunteering.listRewardsByAsk).toHaveBeenCalledWith(ASK_ID);
    expect(result.askId).toBe(ASK_ID);
    expect(result.rewards).toHaveLength(2);

    expect(result.rewards[0]).toEqual({
      id: REWARD_ASK_ID,
      roleId: null,
      ticketTypeId: TICKET_TYPE_ID,
      ticketTypeName: "General Admission",
      faceValueCents: 2500,
      trigger: "ON_CHECK_IN",
      maxGrants: 50,
      grantsUsed: 3,
      active: true,
      remaining: 47,
      createdAt: NOW,
      updatedAt: NOW,
    });

    // The inactive, zero-grant role reward is still surfaced (the config form
    // needs it to pre-fill) with remaining = maxGrants.
    expect(result.rewards[1]).toMatchObject({
      id: REWARD_ROLE_ID,
      roleId: ROLE_ID,
      active: false,
      grantsUsed: 0,
      remaining: 5,
      faceValueCents: 2500,
    });
  });

  it("reports null face value + null remaining when the ticket type is gone / uncapped", async () => {
    const { deps } = makeDeps({
      volunteering: {
        getAsk: vi.fn(async () => eventAsk),
        listRewardsByAsk: vi.fn(async () => [
          { ...askLevelReward, maxGrants: null },
        ]),
      },
      events: { listTicketTypes: vi.fn(async () => []) },
    });

    const result = await listAskRewards(deps, {
      actorHumanId: ACTOR_ID,
      askId: ASK_ID,
    });

    expect(result.rewards[0].faceValueCents).toBeNull();
    expect(result.rewards[0].ticketTypeName).toBeNull();
    expect(result.rewards[0].remaining).toBeNull();
  });

  it("skips the ticket-type lookup when there are no rewards", async () => {
    const listTicketTypes = vi.fn(async () => ticketTypes);
    const { deps } = makeDeps({
      volunteering: {
        getAsk: vi.fn(async () => eventAsk),
        listRewardsByAsk: vi.fn(async () => []),
      },
      events: { listTicketTypes },
    });

    const result = await listAskRewards(deps, {
      actorHumanId: ACTOR_ID,
      askId: ASK_ID,
    });

    expect(result.rewards).toEqual([]);
    expect(listTicketTypes).not.toHaveBeenCalled();
  });

  it("forbids a non-finance actor (VIEWER)", async () => {
    const { deps } = makeDeps({
      authz: { getOrgMembership: vi.fn(async () => ({ role: "VIEWER" })) },
    });

    await expect(
      listAskRewards(deps, { actorHumanId: ACTOR_ID, askId: ASK_ID }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("rejects a missing ask", async () => {
    const { deps } = makeDeps({
      volunteering: {
        getAsk: vi.fn(async () => null),
        listRewardsByAsk: vi.fn(),
      },
    });

    await expect(
      listAskRewards(deps, { actorHumanId: ACTOR_ID, askId: ASK_ID }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
