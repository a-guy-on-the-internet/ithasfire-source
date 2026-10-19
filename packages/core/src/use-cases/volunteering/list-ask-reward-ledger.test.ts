import { describe, expect, it, vi } from "vitest";

import type { Repos, TxRepos } from "@th/ports/repos";

import { listAskRewardLedger } from "./list-ask-reward-ledger";
import type { ListAskRewardLedgerDeps } from "./list-ask-reward-ledger";

// ── Constants ────────────────────────────────────────────────────────────────

const ACTOR_ID = "00000000-0000-4000-8000-000000000001";
const ORG_ID = "00000000-0000-4000-8000-000000000002";
const ASK_ID = "00000000-0000-4000-8000-000000000003";
const REWARD_ID = "00000000-0000-4000-8000-000000000004";
const TICKET_TYPE_ID = "00000000-0000-4000-8000-000000000005";
const NOW = new Date("2026-07-02T12:00:00.000Z");

// ── Fixtures ─────────────────────────────────────────────────────────────────

const eventAsk = {
  id: ASK_ID,
  subjectType: "EVENT" as const,
  subjectId: "event",
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

const reward = {
  id: REWARD_ID,
  askId: ASK_ID,
  roleId: null,
  ticketTypeId: TICKET_TYPE_ID,
  trigger: "ON_CHECK_IN" as const,
  maxGrants: 10,
  grantsUsed: 2,
  active: true,
  createdAt: NOW,
  updatedAt: NOW,
};

function ledgerRow(overrides: Record<string, unknown>) {
  return {
    id: crypto.randomUUID(),
    rewardId: REWARD_ID,
    signupId: crypto.randomUUID(),
    humanId: null,
    contactEmail: "vol@example.com",
    status: "GRANTED",
    compOrderId: crypto.randomUUID(),
    ticketId: crypto.randomUUID(),
    faceValueCents: 5000,
    grantedAt: NOW,
    redeemedAt: null,
    revokedAt: null,
    revokeReason: null,
    rewardRoleId: null,
    rewardTicketTypeId: TICKET_TYPE_ID,
    ticketStatus: "VALID",
    ...overrides,
  };
}

const rows = [
  ledgerRow({ status: "GRANTED", ticketStatus: "VALID" }),
  ledgerRow({ status: "GRANTED", ticketStatus: "SCANNED" }), // redeemed-derived
  ledgerRow({ status: "REVOKED", ticketStatus: "INVALID", revokedAt: NOW }),
];

function makeTxRepos(overrides: Record<string, unknown> = {}) {
  return {
    volunteering: {
      getAsk: vi.fn(async () => eventAsk),
      listGrantsByAsk: vi.fn(async () => rows),
      // The summary now enumerates the ask's full reward config (not just the
      // rewards referenced by grants), so a zero-grant reward is still shown.
      listRewardsByAsk: vi.fn(async () => [reward]),
    },
    authz: {
      getOrgMembership: vi.fn(async () => ({ role: "FINANCE" })),
    },
    ...overrides,
  };
}

function makeDeps(txOverrides: Record<string, unknown> = {}) {
  const txRepos = makeTxRepos(txOverrides);
  const deps: ListAskRewardLedgerDeps = {
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

describe("listAskRewardLedger", () => {
  it("reports counts, remaining budget, face value, and derives redemption from SCANNED", async () => {
    const { deps } = makeDeps();

    const result = await listAskRewardLedger(deps, {
      actorHumanId: ACTOR_ID,
      askId: ASK_ID,
    });

    expect(result.counts).toEqual({
      granted: 1,
      redeemed: 1,
      revoked: 1,
      total: 3,
    });
    // Non-revoked comps count toward face value: 2 × $50.00.
    expect(result.faceValueCents).toBe(10000);
    // maxGrants 10 − grantsUsed 2 = 8.
    expect(result.remainingBudget).toBe(8);
    expect(result.rewards).toHaveLength(1);
    expect(result.rewards[0]).toMatchObject({
      id: REWARD_ID,
      maxGrants: 10,
      grantsUsed: 2,
      remaining: 8,
    });

    // The SCANNED grant is flagged redeemed even though redeemedAt is unstamped.
    const scanned = result.grants.find((g) => g.ticketStatus === "SCANNED");
    expect(scanned?.redeemed).toBe(true);
    const valid = result.grants.find((g) => g.ticketStatus === "VALID");
    expect(valid?.redeemed).toBe(false);
  });

  it("reports null remaining budget when a reward is uncapped", async () => {
    const { deps } = makeDeps({
      volunteering: {
        getAsk: vi.fn(async () => eventAsk),
        listGrantsByAsk: vi.fn(async () => rows),
        listRewardsByAsk: vi.fn(async () => [{ ...reward, maxGrants: null }]),
      },
    });

    const result = await listAskRewardLedger(deps, {
      actorHumanId: ACTOR_ID,
      askId: ASK_ID,
    });

    expect(result.remainingBudget).toBeNull();
    expect(result.rewards[0].remaining).toBeNull();
  });

  it("surfaces a configured reward that has zero grants (counts stay grant-derived)", async () => {
    const { deps } = makeDeps({
      volunteering: {
        getAsk: vi.fn(async () => eventAsk),
        // No grants yet…
        listGrantsByAsk: vi.fn(async () => []),
        // …but a reward IS configured — it must still appear with its budget.
        listRewardsByAsk: vi.fn(async () => [{ ...reward, grantsUsed: 0 }]),
      },
    });

    const result = await listAskRewardLedger(deps, {
      actorHumanId: ACTOR_ID,
      askId: ASK_ID,
    });

    expect(result.counts).toEqual({
      granted: 0,
      redeemed: 0,
      revoked: 0,
      total: 0,
    });
    expect(result.faceValueCents).toBe(0);
    expect(result.rewards).toHaveLength(1);
    expect(result.rewards[0]).toMatchObject({ id: REWARD_ID, remaining: 10 });
    expect(result.remainingBudget).toBe(10);
  });

  it("forbids a non-finance actor (VIEWER)", async () => {
    const { deps } = makeDeps({
      authz: { getOrgMembership: vi.fn(async () => ({ role: "VIEWER" })) },
    });

    await expect(
      listAskRewardLedger(deps, { actorHumanId: ACTOR_ID, askId: ASK_ID }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("rejects a missing ask", async () => {
    const { deps } = makeDeps({
      volunteering: {
        getAsk: vi.fn(async () => null),
        listGrantsByAsk: vi.fn(),
        listRewardsByAsk: vi.fn(),
      },
    });

    await expect(
      listAskRewardLedger(deps, { actorHumanId: ACTOR_ID, askId: ASK_ID }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
