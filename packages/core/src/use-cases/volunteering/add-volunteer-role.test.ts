import { describe, expect, it, vi } from "vitest";

import type { Repos, TxRepos } from "@th/ports/repos";
import type {
  EventVolunteerRoleWithShiftsRecord,
  RoleTemplateRecord,
  VolunteerAskRecord,
} from "@th/ports/repos/volunteering";

import {
  addVolunteerAskRole,
  updateVolunteerAskRole,
} from "./add-volunteer-role";
import type { ManageVolunteerAskRolesDeps } from "./add-volunteer-role";

// ── Constants ────────────────────────────────────────────────────────────────

const ACTOR_ID = "00000000-0000-4000-8000-000000000001";
const ORG_ID = "00000000-0000-4000-8000-000000000002";
const OTHER_ORG_ID = "00000000-0000-4000-8000-000000000003";
const EVENT_ID = "00000000-0000-4000-8000-000000000004";
const ASK_ID = "00000000-0000-4000-8000-000000000010";
const ROLE_ID = "00000000-0000-4000-8000-000000000020";
const TEMPLATE_ID = "00000000-0000-4000-8000-000000000030";
const PLATFORM_TEMPLATE_ID = "00000000-0000-4000-8000-000000000031";
const OTHER_ORG_TEMPLATE_ID = "00000000-0000-4000-8000-000000000032";
const DRAFT_TEMPLATE_ID = "00000000-0000-4000-8000-000000000033";
const LIVE_PACK_ID = "00000000-0000-4000-8000-000000000040";
const DRAFT_PACK_ID = "00000000-0000-4000-8000-000000000041";
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

const baseAskRole: EventVolunteerRoleWithShiftsRecord = {
  id: ROLE_ID,
  eventId: null,
  askId: ASK_ID,
  templateId: null,
  name: "Door",
  description: null,
  capacity: 4,
  autoApprove: null,
  defaultHours: null,
  sortOrder: 0,
  createdAt: NOW,
  updatedAt: NOW,
  shifts: [],
};

const baseTemplate: RoleTemplateRecord = {
  id: TEMPLATE_ID,
  orgId: ORG_ID,
  name: "Bar Staff",
  description: "Serve drinks",
  defaultCapacity: 8,
  sortOrder: 0,
  archived: false,
  isPlatform: false,
  packId: null,
  createdAt: NOW,
  updatedAt: NOW,
};

/** LIVE platform catalogue row: no owning org, read-only, pack-backed. */
const platformTemplate: RoleTemplateRecord = {
  ...baseTemplate,
  id: PLATFORM_TEMPLATE_ID,
  orgId: null,
  name: "Door (Ithas Fire)",
  description: "Greet and check tickets",
  defaultCapacity: 2,
  isPlatform: true,
  packId: LIVE_PACK_ID,
};

/**
 * Stands in for the adapter's `getRoleTemplateUsableBy` tenancy rule rather
 * than blindly returning a row, so these tests exercise the real "which
 * templates can this ask reach" contract: own-org rows, plus LIVE platform
 * rows, and nothing else.
 */
function fakeUsableBy(
  rows: RoleTemplateRecord[],
  livePackIds: readonly string[] = [LIVE_PACK_ID],
) {
  return vi.fn(async (id: string, orgId: string | null) => {
    const row = rows.find((r) => r.id === id);
    if (!row) return null;
    if (row.isPlatform) {
      return row.orgId === null &&
        row.packId !== null &&
        livePackIds.includes(row.packId)
        ? row
        : null;
    }
    return orgId !== null && row.orgId === orgId ? row : null;
  });
}

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
      getRoleTemplateUsableBy: fakeUsableBy([baseTemplate, platformTemplate]),
      getEventRole: vi.fn(async () => baseAskRole),
      createEventRole: vi.fn(async (input: any) => ({
        ...baseAskRole,
        ...input,
        id: ROLE_ID,
      })),
      updateEventRole: vi.fn(async (id: string, input: any) => ({
        ...baseAskRole,
        ...Object.fromEntries(
          Object.entries(input).filter(([, v]) => v !== undefined),
        ),
        id,
      })),
    },
    audit: { log: vi.fn(async () => undefined) },
    ...overrides,
  };
}

function makeDepsWithMocks(txOverrides: Record<string, unknown> = {}) {
  const txRepos = makeTxRepos(txOverrides);
  const deps: ManageVolunteerAskRolesDeps = {
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
// addVolunteerAskRole
// ══════════════════════════════════════════════════════════════════════════════

describe("addVolunteerAskRole", () => {
  const validInput = {
    actorHumanId: ACTOR_ID,
    askId: ASK_ID,
    name: "Door",
    capacity: 4,
    defaultHours: 3.5,
  };

  it("creates an ask-owned role with askId and NO eventId", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    const result = await addVolunteerAskRole(deps, validInput);

    expect(result).toMatchObject({ id: ROLE_ID, askId: ASK_ID });
    const createArgs = (txRepos.volunteering as any).createEventRole.mock
      .calls[0][0];
    expect(createArgs).toMatchObject({
      askId: ASK_ID,
      name: "Door",
      capacity: 4,
      defaultHours: 3.5,
    });
    expect(createArgs.eventId).toBeUndefined();
    expect((txRepos.audit as any).log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "event_volunteer_role",
        action: "created",
      }),
    );
  });

  it("seeds description/capacity from a same-org template when not provided", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    await addVolunteerAskRole(deps, {
      actorHumanId: ACTOR_ID,
      askId: ASK_ID,
      name: "Bar",
      templateId: TEMPLATE_ID,
    });

    expect((txRepos.volunteering as any).createEventRole).toHaveBeenCalledWith(
      expect.objectContaining({
        templateId: TEMPLATE_ID,
        description: "Serve drinks",
        capacity: 8,
      }),
    );
  });

  it("input fields win over template defaults", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    await addVolunteerAskRole(deps, {
      actorHumanId: ACTOR_ID,
      askId: ASK_ID,
      name: "Bar",
      templateId: TEMPLATE_ID,
      description: "Custom description",
      capacity: 2,
    });

    expect((txRepos.volunteering as any).createEventRole).toHaveBeenCalledWith(
      expect.objectContaining({ description: "Custom description", capacity: 2 }),
    );
  });

  it("rejects a template from another org (uniform TEMPLATE_NOT_FOUND)", async () => {
    const { deps } = makeDepsWithMocks({
      volunteering: {
        getAsk: vi.fn(async () => baseAsk),
        getRoleTemplateUsableBy: fakeUsableBy([
          { ...baseTemplate, id: OTHER_ORG_TEMPLATE_ID, orgId: OTHER_ORG_ID },
        ]),
        createEventRole: vi.fn(),
      },
    });
    await expect(
      addVolunteerAskRole(deps, {
        actorHumanId: ACTOR_ID,
        askId: ASK_ID,
        name: "Bar",
        templateId: OTHER_ORG_TEMPLATE_ID,
      }),
    ).rejects.toMatchObject({ code: "TEMPLATE_NOT_FOUND" });
  });

  it("rejects an ORG template on an orgless (HUMAN-subject) ask", async () => {
    const { deps } = makeDepsWithMocks({
      volunteering: {
        getAsk: vi.fn(async () => ({
          ...baseAsk,
          subjectType: "HUMAN",
          subjectId: ACTOR_ID,
          orgId: null,
        })),
        getRoleTemplateUsableBy: fakeUsableBy([baseTemplate]),
        createEventRole: vi.fn(),
      },
    });
    await expect(
      addVolunteerAskRole(deps, {
        actorHumanId: ACTOR_ID,
        askId: ASK_ID,
        name: "Bar",
        templateId: TEMPLATE_ID,
      }),
    ).rejects.toMatchObject({ code: "TEMPLATE_NOT_FOUND" });
  });

  // ── Platform catalogue rows (FR-010) ──────────────────────────────────

  it("seeds from a LIVE platform template (no owning org)", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    await addVolunteerAskRole(deps, {
      actorHumanId: ACTOR_ID,
      askId: ASK_ID,
      name: "Door",
      templateId: PLATFORM_TEMPLATE_ID,
    });

    expect((txRepos.volunteering as any).createEventRole).toHaveBeenCalledWith(
      expect.objectContaining({
        templateId: PLATFORM_TEMPLATE_ID,
        description: "Greet and check tickets",
        capacity: 2,
      }),
    );
  });

  it("resolves templates scoped to the ask's org, never unscoped", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    await addVolunteerAskRole(deps, {
      actorHumanId: ACTOR_ID,
      askId: ASK_ID,
      name: "Bar",
      templateId: TEMPLATE_ID,
    });

    expect(
      (txRepos.volunteering as any).getRoleTemplateUsableBy,
    ).toHaveBeenCalledWith(TEMPLATE_ID, ORG_ID);
  });

  it("rejects a platform template whose pack is still DRAFT", async () => {
    const { deps } = makeDepsWithMocks({
      volunteering: {
        getAsk: vi.fn(async () => baseAsk),
        getRoleTemplateUsableBy: fakeUsableBy([
          {
            ...platformTemplate,
            id: DRAFT_TEMPLATE_ID,
            packId: DRAFT_PACK_ID,
          },
        ]),
        createEventRole: vi.fn(),
      },
    });
    await expect(
      addVolunteerAskRole(deps, {
        actorHumanId: ACTOR_ID,
        askId: ASK_ID,
        name: "Door",
        templateId: DRAFT_TEMPLATE_ID,
      }),
    ).rejects.toMatchObject({ code: "TEMPLATE_NOT_FOUND" });
  });

  it("allows a LIVE platform template on an orgless (HUMAN-subject) ask", async () => {
    const { deps, txRepos } = makeDepsWithMocks({
      volunteering: {
        getAsk: vi.fn(async () => ({
          ...baseAsk,
          subjectType: "HUMAN",
          subjectId: ACTOR_ID,
          orgId: null,
        })),
        getRoleTemplateUsableBy: fakeUsableBy([baseTemplate, platformTemplate]),
        createEventRole: vi.fn(async (input: any) => ({
          ...baseAskRole,
          ...input,
          id: ROLE_ID,
        })),
      },
    });
    await addVolunteerAskRole(deps, {
      actorHumanId: ACTOR_ID,
      askId: ASK_ID,
      name: "Door",
      templateId: PLATFORM_TEMPLATE_ID,
    });

    expect((txRepos.volunteering as any).createEventRole).toHaveBeenCalledWith(
      expect.objectContaining({ templateId: PLATFORM_TEMPLATE_ID }),
    );
  });

  it("propagates the adapter's duplicate_role_name conflict untouched", async () => {
    const { deps } = makeDepsWithMocks({
      volunteering: {
        getAsk: vi.fn(async () => baseAsk),
        getRoleTemplate: vi.fn(),
        createEventRole: vi.fn(async () => {
          throw { code: "duplicate_role_name", message: "duplicate_role_name" };
        }),
      },
    });
    await expect(addVolunteerAskRole(deps, validInput)).rejects.toMatchObject({
      code: "duplicate_role_name",
    });
  });

  it("rejects when the ask does not exist", async () => {
    const { deps } = makeDepsWithMocks({
      volunteering: { getAsk: vi.fn(async () => null) },
    });
    await expect(addVolunteerAskRole(deps, validInput)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("rejects an ARCHIVED ask", async () => {
    const { deps } = makeDepsWithMocks({
      volunteering: {
        getAsk: vi.fn(async () => ({ ...baseAsk, status: "ARCHIVED" })),
        createEventRole: vi.fn(),
      },
    });
    await expect(addVolunteerAskRole(deps, validInput)).rejects.toMatchObject({
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
    await expect(addVolunteerAskRole(deps, validInput)).rejects.toMatchObject({
      code: "INSUFFICIENT_ROLE",
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// updateVolunteerAskRole
// ══════════════════════════════════════════════════════════════════════════════

describe("updateVolunteerAskRole", () => {
  const validInput = {
    actorHumanId: ACTOR_ID,
    id: ROLE_ID,
    name: "Door crew",
    defaultHours: 4,
  };

  it("updates an ask-owned role", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    const result = await updateVolunteerAskRole(deps, validInput);

    expect(result).toMatchObject({ id: ROLE_ID, name: "Door crew" });
    expect((txRepos.volunteering as any).updateEventRole).toHaveBeenCalledWith(
      ROLE_ID,
      expect.objectContaining({ name: "Door crew", defaultHours: 4 }),
    );
  });

  it("404s event-owned roles — they stay with the event flow", async () => {
    const { deps } = makeDepsWithMocks({
      volunteering: {
        getEventRole: vi.fn(async () => ({
          ...baseAskRole,
          eventId: EVENT_ID,
          askId: ASK_ID,
        })),
        getAsk: vi.fn(),
        updateEventRole: vi.fn(),
      },
    });
    await expect(
      updateVolunteerAskRole(deps, validInput),
    ).rejects.toMatchObject({ code: "ROLE_NOT_FOUND" });
  });

  it("rejects a missing role", async () => {
    const { deps } = makeDepsWithMocks({
      volunteering: { getEventRole: vi.fn(async () => null) },
    });
    await expect(
      updateVolunteerAskRole(deps, validInput),
    ).rejects.toMatchObject({ code: "ROLE_NOT_FOUND" });
  });

  it("rejects a VIEWER on the owning org", async () => {
    const { deps } = makeDepsWithMocks({
      authz: {
        getOrgMembership: vi.fn(async () => ({ orgId: ORG_ID, role: "VIEWER" })),
      },
    });
    await expect(
      updateVolunteerAskRole(deps, validInput),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("rejects an ARCHIVED ask", async () => {
    const { deps, txRepos } = makeDepsWithMocks({
      volunteering: {
        getEventRole: vi.fn(async () => baseAskRole),
        getAsk: vi.fn(async () => ({ ...baseAsk, status: "ARCHIVED" })),
        updateEventRole: vi.fn(),
      },
    });
    await expect(
      updateVolunteerAskRole(deps, validInput),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "ask_archived",
    });
    expect(
      (txRepos.volunteering as any).updateEventRole,
    ).not.toHaveBeenCalled();
  });

  it("propagates duplicate_role_name from a rename race untouched", async () => {
    const { deps } = makeDepsWithMocks({
      volunteering: {
        getEventRole: vi.fn(async () => baseAskRole),
        getAsk: vi.fn(async () => baseAsk),
        updateEventRole: vi.fn(async () => {
          throw { code: "duplicate_role_name", message: "duplicate_role_name" };
        }),
      },
    });
    await expect(
      updateVolunteerAskRole(deps, validInput),
    ).rejects.toMatchObject({ code: "duplicate_role_name" });
  });
});
