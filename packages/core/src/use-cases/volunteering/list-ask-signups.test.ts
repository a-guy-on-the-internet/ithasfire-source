import { describe, expect, it, vi } from "vitest";

import type { Repos, TxRepos } from "@th/ports/repos";
import type { VolunteerSignupRecord } from "@th/ports/repos/volunteering";

import { listAskSignups } from "./list-ask-signups";
import type { ListAskSignupsDeps } from "./list-ask-signups";

const OWNER_ID = "00000000-0000-4000-8000-000000000001";
const COORDINATOR_ID = "00000000-0000-4000-8000-000000000002";
const OTHER_COORDINATOR_ID = "00000000-0000-4000-8000-000000000003";
const ORG_ID = "00000000-0000-4000-8000-000000000004";
const ASK_ID = "00000000-0000-4000-8000-000000000005";
const ROLE_ID = "00000000-0000-4000-8000-000000000006";
const OWN_GROUP_ID = "00000000-0000-4000-8000-000000000007";
const OTHER_GROUP_ID = "00000000-0000-4000-8000-000000000008";
const FOREIGN_ASK_ID = "00000000-0000-4000-8000-000000000009";
const STRANGER_ID = "00000000-0000-4000-8000-000000000099";
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

const ownGroup = {
  id: OWN_GROUP_ID,
  askId: ASK_ID,
  name: "Door team",
  description: null,
  capacity: null,
  coordinatorHumanId: COORDINATOR_ID,
  createdAt: NOW,
  updatedAt: NOW,
};

const otherGroup = {
  ...ownGroup,
  id: OTHER_GROUP_ID,
  name: "Bar team",
  coordinatorHumanId: OTHER_COORDINATOR_ID,
};

const groupsWithInfo = [
  { ...ownGroup, memberCount: 1, coordinator: null },
  { ...otherGroup, memberCount: 2, coordinator: null },
];

const signup = {
  id: "00000000-0000-4000-8000-000000000010",
  askId: ASK_ID,
  eventId: null,
  roleId: ROLE_ID,
  groupId: null,
  status: "APPROVED",
  contactEmail: "vol@example.com",
} as unknown as VolunteerSignupRecord;

const page = (items: VolunteerSignupRecord[]) => ({
  items,
  pageInfo: {
    total: items.length,
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
      // Owner path resolves through org membership (ORG-subject ask);
      // OWNER_ID is an ADMIN, everyone else is a non-member.
      getOrgMembership: vi.fn(
        async ({ humanId }: { orgId: string; humanId: string }) =>
          humanId === OWNER_ID ? { role: "ADMIN" } : null,
      ),
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
      getGroup: vi.fn(async (id: string) =>
        id === OWN_GROUP_ID ? ownGroup : id === OTHER_GROUP_ID ? otherGroup : null,
      ),
      listGroupsByAsk: vi.fn(async () => groupsWithInfo),
      listSignupsByAsk: vi.fn(async () => page([signup])),
    },
    ...txOverrides,
  };
  const deps: ListAskSignupsDeps = {
    repos: {
      tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) =>
        fn(txRepos as unknown as TxRepos),
      ),
    } as unknown as Repos,
    clock: { now: () => NOW },
  };
  return { deps, txRepos };
}

const vol = (txRepos: ReturnType<typeof makeDeps>["txRepos"]) =>
  txRepos.volunteering as unknown as {
    getAsk: ReturnType<typeof vi.fn>;
    getGroup: ReturnType<typeof vi.fn>;
    listGroupsByAsk: ReturnType<typeof vi.fn>;
    listSignupsByAsk: ReturnType<typeof vi.fn>;
  };

describe("listAskSignups", () => {
  describe("owner (FR-007 — sees the whole ask)", () => {
    it("ALL scope: lists the whole ask with default pagination", async () => {
      const { deps, txRepos } = makeDeps();

      const result = await listAskSignups(deps, {
        actorHumanId: OWNER_ID,
        askId: ASK_ID,
        scope: { kind: "ALL" },
      });

      expect(result.items).toEqual([signup]);
      expect(vol(txRepos).listSignupsByAsk).toHaveBeenCalledWith(ASK_ID, {
        limit: 200,
        offset: 0,
      });
    });

    it("ALL + status PENDING is the review queue; roleId + paging forwarded", async () => {
      const { deps, txRepos } = makeDeps();

      await listAskSignups(deps, {
        actorHumanId: OWNER_ID,
        askId: ASK_ID,
        scope: { kind: "ALL" },
        status: "PENDING",
        roleId: ROLE_ID,
        limit: 50,
        offset: 100,
      });

      expect(vol(txRepos).listSignupsByAsk).toHaveBeenCalledWith(ASK_ID, {
        roleId: ROLE_ID,
        status: "PENDING",
        limit: 50,
        offset: 100,
      });
    });

    it("GROUP scope: lists one group's members (per-group member list)", async () => {
      const { deps, txRepos } = makeDeps();

      await listAskSignups(deps, {
        actorHumanId: OWNER_ID,
        askId: ASK_ID,
        scope: { kind: "GROUP", groupId: OTHER_GROUP_ID },
      });

      expect(vol(txRepos).listSignupsByAsk).toHaveBeenCalledWith(ASK_ID, {
        groupId: OTHER_GROUP_ID,
        limit: 200,
        offset: 0,
      });
    });

    it("GROUP scope 404s on a foreign-ask group (never lists)", async () => {
      const { deps, txRepos } = makeDeps();
      vol(txRepos).getGroup = vi.fn(async () => ({
        ...ownGroup,
        askId: FOREIGN_ASK_ID,
      }));

      await expect(
        listAskSignups(deps, {
          actorHumanId: OWNER_ID,
          askId: ASK_ID,
          scope: { kind: "GROUP", groupId: OWN_GROUP_ID },
        }),
      ).rejects.toMatchObject({
        code: "NOT_FOUND",
        message: "group_not_found",
      });
      expect(vol(txRepos).listSignupsByAsk).not.toHaveBeenCalled();
    });

    it("POOL scope defaults to the general pool (unassigned APPROVED)", async () => {
      const { deps, txRepos } = makeDeps();

      await listAskSignups(deps, {
        actorHumanId: OWNER_ID,
        askId: ASK_ID,
        scope: { kind: "POOL" },
      });

      expect(vol(txRepos).listSignupsByAsk).toHaveBeenCalledWith(ASK_ID, {
        groupId: null,
        status: "APPROVED",
        limit: 200,
        offset: 0,
      });
    });

    it("POOL scope: owner may override the status (unassigned PENDING)", async () => {
      const { deps, txRepos } = makeDeps();

      await listAskSignups(deps, {
        actorHumanId: OWNER_ID,
        askId: ASK_ID,
        scope: { kind: "POOL" },
        status: "PENDING",
      });

      expect(vol(txRepos).listSignupsByAsk).toHaveBeenCalledWith(ASK_ID, {
        groupId: null,
        status: "PENDING",
        limit: 200,
        offset: 0,
      });
    });
  });

  describe("coordinator (non-owner)", () => {
    it("may list their OWN group", async () => {
      const { deps, txRepos } = makeDeps();

      const result = await listAskSignups(deps, {
        actorHumanId: COORDINATOR_ID,
        askId: ASK_ID,
        scope: { kind: "GROUP", groupId: OWN_GROUP_ID },
      });

      expect(result.items).toEqual([signup]);
      expect(vol(txRepos).listSignupsByAsk).toHaveBeenCalledWith(ASK_ID, {
        groupId: OWN_GROUP_ID,
        limit: 200,
        offset: 0,
      });
    });

    it("may list the general POOL (FR-005 pool pulls) — read is pool-scoped", async () => {
      const { deps, txRepos } = makeDeps();

      const result = await listAskSignups(deps, {
        actorHumanId: COORDINATOR_ID,
        askId: ASK_ID,
        scope: { kind: "POOL" },
      });

      expect(result.items).toEqual([signup]);
      // NFR-003: the single read is the pool-scoped repo filter — never
      // a broad read narrowed in memory.
      const calls = vol(txRepos).listSignupsByAsk.mock.calls;
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual([
        ASK_ID,
        { groupId: null, status: "APPROVED", limit: 200, offset: 0 },
      ]);
    });

    it("ALL scope is forbidden — whole-ask reads are owner-only", async () => {
      const { deps, txRepos } = makeDeps();

      await expect(
        listAskSignups(deps, {
          actorHumanId: COORDINATOR_ID,
          askId: ASK_ID,
          scope: { kind: "ALL" },
        }),
      ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
      expect(vol(txRepos).listSignupsByAsk).not.toHaveBeenCalled();
    });

    it("another group's roster is forbidden (uniform denial, no oracle)", async () => {
      const { deps, txRepos } = makeDeps();

      await expect(
        listAskSignups(deps, {
          actorHumanId: COORDINATOR_ID,
          askId: ASK_ID,
          scope: { kind: "GROUP", groupId: OTHER_GROUP_ID },
        }),
      ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
      expect(vol(txRepos).listSignupsByAsk).not.toHaveBeenCalled();
    });

    it("a foreign-ask group is forbidden with the SAME denial as a stranger", async () => {
      const { deps, txRepos } = makeDeps();
      vol(txRepos).getGroup = vi.fn(async () => ({
        ...ownGroup,
        askId: FOREIGN_ASK_ID,
      }));

      await expect(
        listAskSignups(deps, {
          actorHumanId: COORDINATOR_ID,
          askId: ASK_ID,
          scope: { kind: "GROUP", groupId: OWN_GROUP_ID },
        }),
      ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
      expect(vol(txRepos).listSignupsByAsk).not.toHaveBeenCalled();
    });

    it("POOL with a non-APPROVED status is forbidden (the pending queue is the owner's)", async () => {
      const { deps, txRepos } = makeDeps();

      await expect(
        listAskSignups(deps, {
          actorHumanId: COORDINATOR_ID,
          askId: ASK_ID,
          scope: { kind: "POOL" },
          status: "PENDING",
        }),
      ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
      expect(vol(txRepos).listSignupsByAsk).not.toHaveBeenCalled();
    });
  });

  describe("stranger / structural", () => {
    it("an actor with no seat anywhere is forbidden on POOL", async () => {
      const { deps, txRepos } = makeDeps();

      await expect(
        listAskSignups(deps, {
          actorHumanId: STRANGER_ID,
          askId: ASK_ID,
          scope: { kind: "POOL" },
        }),
      ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
      expect(vol(txRepos).listSignupsByAsk).not.toHaveBeenCalled();
    });

    it("404s when the ask is missing", async () => {
      const { deps, txRepos } = makeDeps();
      vol(txRepos).getAsk = vi.fn(async () => null);

      await expect(
        listAskSignups(deps, {
          actorHumanId: OWNER_ID,
          askId: ASK_ID,
          scope: { kind: "ALL" },
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND", message: "ask_not_found" });
    });
  });
});
