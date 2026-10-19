import { describe, expect, it, vi } from "vitest";

import type { Repos, TxRepos } from "@th/ports/repos";
import type { VolunteerSignupRecord } from "@th/ports/repos/volunteering";

import { listAskRoster } from "./list-ask-roster";
import type { ListAskRosterDeps } from "./list-ask-roster";

const OWNER_ID = "00000000-0000-4000-8000-000000000001";
const COORDINATOR_ID = "00000000-0000-4000-8000-000000000002";
const ORG_ID = "00000000-0000-4000-8000-000000000003";
const ASK_ID = "00000000-0000-4000-8000-000000000004";
const ROLE_ID = "00000000-0000-4000-8000-000000000005";
const GROUP_ID = "00000000-0000-4000-8000-000000000006";
const NOW = new Date("2026-07-01T12:00:00.000Z");

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

const baseRole = {
  id: ROLE_ID,
  eventId: null,
  askId: ASK_ID,
  templateId: null,
  name: "Door",
  description: null,
  capacity: 5,
  autoApprove: null,
  defaultHours: null,
  sortOrder: 0,
  createdAt: NOW,
  updatedAt: NOW,
  shifts: [],
};

const groupWithInfo = {
  id: GROUP_ID,
  askId: ASK_ID,
  name: "Door team",
  description: null,
  capacity: null,
  coordinatorHumanId: COORDINATOR_ID,
  createdAt: NOW,
  updatedAt: NOW,
  memberCount: 2,
  coordinator: { humanId: COORDINATOR_ID, name: "Coord" },
};

const poolSignup = {
  id: "00000000-0000-4000-8000-000000000007",
  askId: ASK_ID,
  eventId: null,
  roleId: ROLE_ID,
  groupId: null,
  status: "APPROVED",
  contactEmail: "pool@example.com",
} as unknown as VolunteerSignupRecord;

const page = (items: VolunteerSignupRecord[], total: number) => ({
  items,
  pageInfo: {
    total,
    count: items.length,
    limit: 200,
    offset: 0,
    hasNextPage: false,
    nextOffset: null,
  },
});

function makeDeps(txOverrides: Record<string, unknown> = {}) {
  const txRepos = {
    authz: {
      getOrgMembership: vi.fn(async () => ({ role: "ADMIN" })),
    },
    volunteering: {
      getAsk: vi.fn(async () => baseAsk),
      listRolesByAsk: vi.fn(async () => [baseRole]),
      listGroupsByAsk: vi.fn(async () => [groupWithInfo]),
      // Per-role fill counts still ride the offset primitive's totals.
      listSignupsByAsk: vi.fn(async (_askId: string, opts: any) => {
        if (opts?.status === "APPROVED") return page([], 3);
        if (opts?.status === "CHECKED_IN") return page([], 1);
        return page([], 2); // PENDING
      }),
      // The general pool is the keyset read.
      listSignupsByAskCursor: vi.fn(async () => ({
        items: [poolSignup],
        nextCursor: null,
      })),
    },
    ...txOverrides,
  };
  const deps: ListAskRosterDeps = {
    repos: {
      tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) =>
        fn(txRepos as unknown as TxRepos),
      ),
    } as unknown as Repos,
    clock: { now: () => NOW },
  };
  return { deps, txRepos };
}

describe("listAskRoster", () => {
  it("returns ask + roles with fill counts + groups + general pool for the owner", async () => {
    const { deps } = makeDeps();

    const result = await listAskRoster(deps, {
      actorHumanId: OWNER_ID,
      askId: ASK_ID,
    });

    expect(result.ask.id).toBe(ASK_ID);
    expect(result.roles).toHaveLength(1);
    expect(result.roles[0]).toMatchObject({
      id: ROLE_ID,
      acceptedCount: 4, // 3 approved + 1 checked-in
      pendingCount: 2,
    });
    expect(result.groups).toEqual([groupWithInfo]);
    expect(result.generalPool).toEqual([poolSignup]);
    expect(result.nextCursor).toBeNull();
  });

  it("requests the general pool as unassigned APPROVED signups with the default page size", async () => {
    const { deps, txRepos } = makeDeps();

    await listAskRoster(deps, { actorHumanId: OWNER_ID, askId: ASK_ID });

    expect(
      (txRepos.volunteering as any).listSignupsByAskCursor,
    ).toHaveBeenCalledWith(
      ASK_ID,
      expect.objectContaining({
        groupId: null,
        status: "APPROVED",
        cursor: null,
        limit: 50,
      }),
    );
  });

  it("forwards the cursor + limit to the pool read and passes nextCursor through", async () => {
    const { deps, txRepos } = makeDeps();
    (txRepos.volunteering as any).listSignupsByAskCursor = vi.fn(async () => ({
      items: [poolSignup],
      nextCursor: "2026-07-01T12:00:00.000Z|deadbeef",
    }));

    const result = await listAskRoster(deps, {
      actorHumanId: OWNER_ID,
      askId: ASK_ID,
      cursor: "2026-06-30T00:00:00.000Z|cafebabe",
      limit: 25,
    });

    expect(
      (txRepos.volunteering as any).listSignupsByAskCursor,
    ).toHaveBeenCalledWith(
      ASK_ID,
      expect.objectContaining({
        cursor: "2026-06-30T00:00:00.000Z|cafebabe",
        limit: 25,
      }),
    );
    expect(result.nextCursor).toBe("2026-07-01T12:00:00.000Z|deadbeef");
  });

  it("rejects a limit above the 200 max (invalid_input)", async () => {
    const { deps } = makeDeps();

    await expect(
      listAskRoster(deps, {
        actorHumanId: OWNER_ID,
        askId: ASK_ID,
        limit: 201,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("404s when the ask is missing", async () => {
    const { deps, txRepos } = makeDeps();
    (txRepos.volunteering as any).getAsk = vi.fn(async () => null);

    await expect(
      listAskRoster(deps, { actorHumanId: OWNER_ID, askId: ASK_ID }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "ask_not_found" });
  });

  it("is OWNER-ONLY: a coordinator (non-owner) gets forbidden", async () => {
    // The whole-ask roster is exactly what coordinator scope must NOT see
    // (other groups' rosters) — spec `coordinator_scope.may_not`.
    const { deps, txRepos } = makeDeps({
      authz: { getOrgMembership: vi.fn(async () => null) },
    });

    await expect(
      listAskRoster(deps, { actorHumanId: COORDINATOR_ID, askId: ASK_ID }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    // No signup data was read before the gate threw.
    expect(
      (txRepos.volunteering as any).listSignupsByAsk,
    ).not.toHaveBeenCalled();
    expect(
      (txRepos.volunteering as any).listSignupsByAskCursor,
    ).not.toHaveBeenCalled();
  });
});
