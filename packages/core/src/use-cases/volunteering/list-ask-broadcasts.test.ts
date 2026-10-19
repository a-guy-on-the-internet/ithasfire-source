import { describe, expect, it, vi } from "vitest";

import type { Repos, TxRepos } from "@th/ports/repos";

import { listAskBroadcasts } from "./list-ask-broadcasts";
import type { ListAskBroadcastsDeps } from "./list-ask-broadcasts";

// ── Constants ────────────────────────────────────────────────────────────────

const OWNER_ID = "00000000-0000-4000-8000-000000000001";
const COORDINATOR_ID = "00000000-0000-4000-8000-000000000002";
const STRANGER_ID = "00000000-0000-4000-8000-000000000003";
const ORG_ID = "00000000-0000-4000-8000-000000000004";
const ASK_ID = "00000000-0000-4000-8000-000000000005";
const GROUP_ID = "00000000-0000-4000-8000-000000000007";
const OTHER_GROUP_ID = "00000000-0000-4000-8000-000000000008";
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

const groupWithRoster = (id: string, coordinatorHumanId: string | null) => ({
  id,
  askId: ASK_ID,
  name: `Group ${id.slice(-1)}`,
  description: null,
  capacity: null,
  coordinatorHumanId,
  createdAt: NOW,
  updatedAt: NOW,
  memberCount: 0,
  coordinator: null,
});

const broadcast = (over: Record<string, unknown>) => ({
  id: crypto.randomUUID(),
  askId: ASK_ID,
  senderHumanId: OWNER_ID,
  scopeType: "ALL" as const,
  scopeId: null,
  subject: "s",
  body: "b",
  recipientCount: 1,
  createdAt: NOW,
  ...over,
});

const ownerAllBroadcast = broadcast({ id: "00000000-0000-4000-8000-0000000000a1" });
const ownerOtherGroupBroadcast = broadcast({
  id: "00000000-0000-4000-8000-0000000000a2",
  scopeType: "GROUP",
  scopeId: OTHER_GROUP_ID,
});
const ownerOwnGroupBroadcast = broadcast({
  id: "00000000-0000-4000-8000-0000000000a3",
  scopeType: "GROUP",
  scopeId: GROUP_ID,
});
const coordinatorSentBroadcast = broadcast({
  id: "00000000-0000-4000-8000-0000000000a4",
  senderHumanId: COORDINATOR_ID,
  scopeType: "GROUP",
  scopeId: GROUP_ID,
});

const allBroadcasts = [
  ownerAllBroadcast,
  ownerOtherGroupBroadcast,
  ownerOwnGroupBroadcast,
  coordinatorSentBroadcast,
];

// ── Mock builder ─────────────────────────────────────────────────────────────

function makeDeps(txOverrides: Record<string, unknown> = {}) {
  const txRepos = {
    authz: {
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
      getAsk: vi.fn(async () => baseAsk),
      listGroupsByAsk: vi.fn(async () => [
        groupWithRoster(GROUP_ID, COORDINATOR_ID),
        groupWithRoster(OTHER_GROUP_ID, null),
      ]),
      listBroadcastsByAsk: vi.fn(async () => allBroadcasts),
    },
    ...txOverrides,
  };
  const deps: ListAskBroadcastsDeps = {
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

describe("listAskBroadcasts", () => {
  it("owner sees every broadcast on the ask", async () => {
    const { deps } = makeDeps();

    const result = await listAskBroadcasts(deps, {
      actorHumanId: OWNER_ID,
      askId: ASK_ID,
    });

    expect(result.broadcasts).toEqual(allBroadcasts);
  });

  it("coordinator sees only their own sends plus GROUP broadcasts targeting their group", async () => {
    const { deps } = makeDeps({
      authz: { getOrgMembership: vi.fn(async () => null) },
    });

    const result = await listAskBroadcasts(deps, {
      actorHumanId: COORDINATOR_ID,
      askId: ASK_ID,
    });

    expect(result.broadcasts).toEqual([
      ownerOwnGroupBroadcast,
      coordinatorSentBroadcast,
    ]);
    // The owner's ALL and other-group traffic never appears.
    expect(result.broadcasts).not.toContainEqual(ownerAllBroadcast);
    expect(result.broadcasts).not.toContainEqual(ownerOtherGroupBroadcast);
  });

  it("non-owner non-coordinator gets the uniform ownership denial (never an empty list)", async () => {
    const { deps, txRepos } = makeDeps({
      authz: { getOrgMembership: vi.fn(async () => null) },
    });

    await expect(
      listAskBroadcasts(deps, { actorHumanId: STRANGER_ID, askId: ASK_ID }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    expect(
      (txRepos.volunteering as any).listBroadcastsByAsk,
    ).not.toHaveBeenCalled();
  });

  it("404s a missing ask", async () => {
    const { deps } = makeDeps({
      volunteering: {
        getAsk: vi.fn(async () => null),
        listGroupsByAsk: vi.fn(),
        listBroadcastsByAsk: vi.fn(),
      },
    });

    await expect(
      listAskBroadcasts(deps, { actorHumanId: OWNER_ID, askId: ASK_ID }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "ask_not_found" });
  });
});
