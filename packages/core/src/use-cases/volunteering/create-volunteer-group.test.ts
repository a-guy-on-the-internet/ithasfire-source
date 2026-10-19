import { describe, expect, it, vi } from "vitest";

import type { Repos, TxRepos } from "@th/ports/repos";
import type {
  VolunteerAskRecord,
  VolunteerGroupRecord,
} from "@th/ports/repos/volunteering";

import { createVolunteerGroup } from "./create-volunteer-group";
import type { CreateVolunteerGroupDeps } from "./create-volunteer-group";

// ── Constants ────────────────────────────────────────────────────────────────

const ACTOR_ID = "00000000-0000-4000-8000-000000000001";
const ORG_ID = "00000000-0000-4000-8000-000000000002";
const ASK_ID = "00000000-0000-4000-8000-000000000010";
const GROUP_ID = "00000000-0000-4000-8000-000000000040";
const NOW = new Date("2026-07-01T12:00:00.000Z");

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

// ── Mock builder ─────────────────────────────────────────────────────────────

function makeTxRepos(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    authz: {
      getOrgMembership: vi.fn(async () => ({ orgId: ORG_ID, role: "ADMIN" })),
      getOrgMemberships: vi.fn(async () => [{ orgId: ORG_ID, role: "ADMIN" }]),
    },
    volunteering: {
      getAsk: vi.fn(async () => baseAsk),
      createGroup: vi.fn(async (input: any) => ({
        ...baseGroup,
        ...input,
        id: GROUP_ID,
      })),
    },
    audit: { log: vi.fn(async () => undefined) },
    ...overrides,
  };
}

function makeDepsWithMocks(txOverrides: Record<string, unknown> = {}) {
  const txRepos = makeTxRepos(txOverrides);
  const deps: CreateVolunteerGroupDeps = {
    repos: {
      tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) =>
        fn(txRepos as TxRepos),
      ),
    } as unknown as Repos,
    clock: { now: () => NOW },
  };
  return { deps, txRepos };
}

// ══════════════════════════════════════════════════════════════════════════════

describe("createVolunteerGroup", () => {
  const validInput = {
    actorHumanId: ACTOR_ID,
    askId: ASK_ID,
    name: "Flyer crew",
    capacity: 6,
  };

  it("creates a group and returns its id", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    const result = await createVolunteerGroup(deps, validInput);

    expect(result).toEqual({ groupId: GROUP_ID });
    expect((txRepos.volunteering as any).createGroup).toHaveBeenCalledWith({
      askId: ASK_ID,
      name: "Flyer crew",
      description: null,
      capacity: 6,
    });
    expect((txRepos.audit as any).log).toHaveBeenCalledWith(
      expect.objectContaining({ entity: "volunteer_group", action: "created" }),
    );
  });

  it("propagates the adapter's duplicate_group_name conflict untouched", async () => {
    const { deps } = makeDepsWithMocks({
      volunteering: {
        getAsk: vi.fn(async () => baseAsk),
        createGroup: vi.fn(async () => {
          throw {
            code: "duplicate_group_name",
            message: "duplicate_group_name",
          };
        }),
      },
    });
    await expect(createVolunteerGroup(deps, validInput)).rejects.toMatchObject({
      code: "duplicate_group_name",
    });
  });

  it("rejects when the ask does not exist", async () => {
    const { deps } = makeDepsWithMocks({
      volunteering: { getAsk: vi.fn(async () => null), createGroup: vi.fn() },
    });
    await expect(createVolunteerGroup(deps, validInput)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("rejects an ARCHIVED ask", async () => {
    const { deps } = makeDepsWithMocks({
      volunteering: {
        getAsk: vi.fn(async () => ({ ...baseAsk, status: "ARCHIVED" })),
        createGroup: vi.fn(),
      },
    });
    await expect(createVolunteerGroup(deps, validInput)).rejects.toMatchObject({
      code: "CONFLICT",
      message: "ask_archived",
    });
  });

  it("rejects a VIEWER on the owning org", async () => {
    const { deps } = makeDepsWithMocks({
      authz: {
        getOrgMembership: vi.fn(async () => ({ orgId: ORG_ID, role: "VIEWER" })),
      },
    });
    await expect(createVolunteerGroup(deps, validInput)).rejects.toMatchObject({
      code: "INSUFFICIENT_ROLE",
    });
  });

  it("rejects a non-member (coordinators can never create groups)", async () => {
    const { deps } = makeDepsWithMocks({
      authz: { getOrgMembership: vi.fn(async () => null) },
    });
    await expect(createVolunteerGroup(deps, validInput)).rejects.toMatchObject({
      code: "INSUFFICIENT_ROLE",
    });
  });
});
