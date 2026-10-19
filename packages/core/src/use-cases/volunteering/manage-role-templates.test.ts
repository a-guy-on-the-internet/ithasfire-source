import { describe, expect, it, vi } from "vitest";

import type { Repos, TxRepos } from "@th/ports/repos";
import type { RoleTemplateRecord } from "@th/ports/repos/volunteering";
import {
  createRoleTemplate,
  updateRoleTemplate,
  archiveRoleTemplate,
  listRoleTemplates,
  upsertRoleTemplateShifts,
  getRoleTemplateWithShifts,
} from "./manage-role-templates";
import type { ManageRoleTemplatesDeps } from "./manage-role-templates";

// ── Constants ────────────────────────────────────────────────────────────────

const ACTOR_ID = "00000000-0000-4000-8000-000000000001";
const ORG_ID = "00000000-0000-4000-8000-000000000002";
const TEMPLATE_ID = "00000000-0000-4000-8000-000000000010";
const OTHER_ORG_ID = "00000000-0000-4000-8000-000000000003";
const OTHER_ORG_TEMPLATE_ID = "00000000-0000-4000-8000-000000000011";
const PLATFORM_TEMPLATE_ID = "00000000-0000-4000-8000-000000000012";
const LIVE_PACK_ID = "00000000-0000-4000-8000-000000000020";
const NOW = new Date("2026-06-01T12:00:00.000Z");

// ── Fixtures ─────────────────────────────────────────────────────────────────

const baseTemplate: RoleTemplateRecord = {
  id: TEMPLATE_ID,
  orgId: ORG_ID,
  name: "Bar Staff",
  description: "Serve drinks",
  defaultCapacity: 10,
  sortOrder: 0,
  archived: false,
  isPlatform: false,
  packId: null,
  createdAt: NOW,
  updatedAt: NOW,
};

/**
 * A platform catalogue row: NO owning org, `isPlatform` true. Every
 * mutating use case must refuse this before it ever asks "is the actor a
 * member of the owning org" — there is no owning org to ask about, and the
 * row is shared by every org on the platform.
 */
const platformTemplate: RoleTemplateRecord = {
  ...baseTemplate,
  id: PLATFORM_TEMPLATE_ID,
  orgId: null,
  name: "Door",
  isPlatform: true,
  packId: LIVE_PACK_ID,
};

/** Another org's private row — must 404 identically to "does not exist". */
const otherOrgTemplate: RoleTemplateRecord = {
  ...baseTemplate,
  id: OTHER_ORG_TEMPLATE_ID,
  orgId: OTHER_ORG_ID,
  name: "Their Bar Staff",
};

// ── Mock builder ─────────────────────────────────────────────────────────────

function makeTxRepos(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    authz: {
      getOrgMembership: vi.fn(async () => ({ role: "ADMIN" })),
    },
    volunteering: {
      createRoleTemplate: vi.fn(async (input: any) => ({
        ...baseTemplate,
        ...input,
        id: TEMPLATE_ID,
        archived: false,
        sortOrder: input.sortOrder ?? 0,
        createdAt: NOW,
        updatedAt: NOW,
      })),
      updateRoleTemplate: vi.fn(async (id: string, input: any) => ({
        ...baseTemplate,
        ...input,
        id,
        updatedAt: NOW,
      })),
      archiveRoleTemplate: vi.fn(async () => undefined),
      listRoleTemplates: vi.fn(async () => []),
      getRoleTemplate: vi.fn(async () => baseTemplate),
      upsertRoleTemplateShifts: vi.fn(
        async (templateId: string, shifts: any[]) =>
          shifts.map((shift, index) => ({
            id: `shift-${index}`,
            templateId,
            label: shift.label,
            startMinuteOfDay: shift.startMinuteOfDay,
            endMinuteOfDay: shift.endMinuteOfDay,
            startDayOffset: shift.startDayOffset ?? 0,
            endsNextDay: shift.endsNextDay ?? false,
            capacity: shift.capacity ?? null,
            position: shift.position ?? index,
            // Echoed, not defaulted: the point of these assertions is that
            // the use case THREADS them through the replace-set.
            anchor: shift.anchor,
            offsetMinutes: shift.offsetMinutes,
            notes: shift.notes,
            createdAt: NOW,
            updatedAt: NOW,
          })),
      ),
      getRoleTemplateWithShifts: vi.fn(async () => ({
        ...baseTemplate,
        shifts: [],
      })),
      listRoleTemplateShifts: vi.fn(async () => []),
      listRoleTemplateShiftsByTemplateIds: vi.fn(async () => ({})),
    },
    audit: { log: vi.fn(async () => undefined) },
    ...overrides,
  };
}

function makeDeps(
  txOverrides: Record<string, unknown> = {},
): ManageRoleTemplatesDeps {
  const txRepos = makeTxRepos(txOverrides);
  return {
    repos: {
      tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) =>
        fn(txRepos as TxRepos),
      ),
    } as unknown as Repos,
    clock: { now: () => NOW },
  };
}

function makeDepsWithMocks(txOverrides: Record<string, unknown> = {}) {
  const txRepos = makeTxRepos(txOverrides);
  const deps: ManageRoleTemplatesDeps = {
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
// createRoleTemplate
// ══════════════════════════════════════════════════════════════════════════════

describe("createRoleTemplate", () => {
  const validInput = {
    actorHumanId: ACTOR_ID,
    orgId: ORG_ID,
    name: "Security",
    description: "Event security staff",
    defaultCapacity: 5,
  };

  it("creates a template and returns it", async () => {
    const deps = makeDeps();
    const result = await createRoleTemplate(deps, validInput);

    expect(result).toMatchObject({
      id: TEMPLATE_ID,
      orgId: ORG_ID,
      name: "Security",
    });
  });

  it("logs an audit entry", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    await createRoleTemplate(deps, validInput);

    expect((txRepos.audit as any).log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "volunteer_role_template",
        action: "created",
      }),
    );
  });

  it("rejects when actor lacks ADMIN role", async () => {
    const deps = makeDeps({
      authz: { getOrgMembership: vi.fn(async () => ({ role: "VIEWER" })) },
    });

    await expect(createRoleTemplate(deps, validInput)).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("rejects when name is already taken (case-insensitive)", async () => {
    const deps = makeDeps({
      volunteering: {
        createRoleTemplate: vi.fn(),
        updateRoleTemplate: vi.fn(),
        archiveRoleTemplate: vi.fn(),
        listRoleTemplates: vi.fn(async () => [
          { ...baseTemplate, name: "security" },
        ]),
        getRoleTemplate: vi.fn(async () => null),
      },
    });

    await expect(createRoleTemplate(deps, validInput)).rejects.toMatchObject({ code: "TEMPLATE_NAME_TAKEN" });
  });

  it("rejects invalid input (empty name)", async () => {
    const deps = makeDeps();
    await expect(
      createRoleTemplate(deps, { ...validInput, name: "" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects invalid input (missing orgId)", async () => {
    const deps = makeDeps();
    await expect(
      createRoleTemplate(deps, { ...validInput, orgId: undefined }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("allows OWNER role", async () => {
    const deps = makeDeps({
      authz: { getOrgMembership: vi.fn(async () => ({ role: "OWNER" })) },
    });
    const result = await createRoleTemplate(deps, validInput);
    expect(result.id).toBe(TEMPLATE_ID);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// updateRoleTemplate
// ══════════════════════════════════════════════════════════════════════════════

describe("updateRoleTemplate", () => {
  const validInput = {
    actorHumanId: ACTOR_ID,
    id: TEMPLATE_ID,
    name: "Updated Name",
  };

  it("updates a template and returns it", async () => {
    const deps = makeDeps();
    const result = await updateRoleTemplate(deps, validInput);

    expect(result).toMatchObject({
      id: TEMPLATE_ID,
      name: "Updated Name",
    });
  });

  it("rejects when template is not found", async () => {
    const deps = makeDeps({
      volunteering: {
        getRoleTemplate: vi.fn(async () => null),
        listRoleTemplates: vi.fn(async () => []),
        createRoleTemplate: vi.fn(),
        updateRoleTemplate: vi.fn(),
        archiveRoleTemplate: vi.fn(),
      },
    });

    await expect(updateRoleTemplate(deps, validInput)).rejects.toMatchObject({ code: "TEMPLATE_NOT_FOUND" });
  });

  it("rejects when actor lacks ADMIN role", async () => {
    const deps = makeDeps({
      authz: { getOrgMembership: vi.fn(async () => ({ role: "EDITOR" })) },
    });

    await expect(updateRoleTemplate(deps, validInput)).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("rejects when renaming to a taken name", async () => {
    const deps = makeDeps({
      volunteering: {
        getRoleTemplate: vi.fn(async () => baseTemplate),
        listRoleTemplates: vi.fn(async () => [
          baseTemplate,
          { ...baseTemplate, id: "other-id", name: "Updated Name" },
        ]),
        createRoleTemplate: vi.fn(),
        updateRoleTemplate: vi.fn(),
        archiveRoleTemplate: vi.fn(),
      },
    });

    await expect(updateRoleTemplate(deps, validInput)).rejects.toMatchObject({ code: "TEMPLATE_NAME_TAKEN" });
  });

  it("allows renaming to the same name (no collision with self)", async () => {
    const deps = makeDeps({
      volunteering: {
        getRoleTemplate: vi.fn(async () => baseTemplate),
        listRoleTemplates: vi.fn(async () => [baseTemplate]),
        createRoleTemplate: vi.fn(),
        updateRoleTemplate: vi.fn(async (id: string, input: any) => ({
          ...baseTemplate,
          ...input,
          id,
        })),
        archiveRoleTemplate: vi.fn(),
      },
    });

    // "Bar Staff" → "bar staff" should succeed (same template, case variant)
    const result = await updateRoleTemplate(deps, {
      ...validInput,
      name: "Bar Staff",
    });
    expect(result.id).toBe(TEMPLATE_ID);
  });

  it("logs an audit entry", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    await updateRoleTemplate(deps, validInput);

    expect((txRepos.audit as any).log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "volunteer_role_template",
        action: "updated",
      }),
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// archiveRoleTemplate
// ══════════════════════════════════════════════════════════════════════════════

describe("archiveRoleTemplate", () => {
  const validInput = {
    actorHumanId: ACTOR_ID,
    id: TEMPLATE_ID,
  };

  it("archives a template", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    await archiveRoleTemplate(deps, validInput);

    expect(
      (txRepos.volunteering as any).archiveRoleTemplate,
    ).toHaveBeenCalledWith(TEMPLATE_ID);
  });

  it("is idempotent when already archived", async () => {
    const { deps, txRepos } = makeDepsWithMocks({
      volunteering: {
        getRoleTemplate: vi.fn(async () => ({
          ...baseTemplate,
          archived: true,
        })),
        archiveRoleTemplate: vi.fn(async () => undefined),
        listRoleTemplates: vi.fn(async () => []),
        createRoleTemplate: vi.fn(),
        updateRoleTemplate: vi.fn(),
      },
    });

    await archiveRoleTemplate(deps, validInput);

    // Should NOT call archiveRoleTemplate when already archived
    expect(
      (txRepos.volunteering as any).archiveRoleTemplate,
    ).not.toHaveBeenCalled();
  });

  it("rejects when template is not found", async () => {
    const deps = makeDeps({
      volunteering: {
        getRoleTemplate: vi.fn(async () => null),
        archiveRoleTemplate: vi.fn(),
        listRoleTemplates: vi.fn(async () => []),
        createRoleTemplate: vi.fn(),
        updateRoleTemplate: vi.fn(),
      },
    });

    await expect(archiveRoleTemplate(deps, validInput)).rejects.toMatchObject({ code: "TEMPLATE_NOT_FOUND" });
  });

  it("rejects when actor lacks ADMIN role", async () => {
    const deps = makeDeps({
      authz: { getOrgMembership: vi.fn(async () => ({ role: "VIEWER" })) },
    });

    await expect(archiveRoleTemplate(deps, validInput)).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("logs an audit entry", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    await archiveRoleTemplate(deps, validInput);

    expect((txRepos.audit as any).log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "volunteer_role_template",
        action: "archived",
      }),
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// listRoleTemplates
// ══════════════════════════════════════════════════════════════════════════════

describe("listRoleTemplates", () => {
  const validInput = {
    actorHumanId: ACTOR_ID,
    orgId: ORG_ID,
  };

  it("returns templates for the org", async () => {
    const deps = makeDeps({
      volunteering: {
        listRoleTemplates: vi.fn(async () => [baseTemplate]),
        getRoleTemplate: vi.fn(),
        createRoleTemplate: vi.fn(),
        updateRoleTemplate: vi.fn(),
        archiveRoleTemplate: vi.fn(),
      },
    });

    const result = await listRoleTemplates(deps, validInput);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: TEMPLATE_ID, name: "Bar Staff" });
  });

  it("passes includeArchived option through", async () => {
    const listFn = vi.fn(async () => []);
    const deps = makeDeps({
      volunteering: {
        listRoleTemplates: listFn,
        getRoleTemplate: vi.fn(),
        createRoleTemplate: vi.fn(),
        updateRoleTemplate: vi.fn(),
        archiveRoleTemplate: vi.fn(),
      },
    });

    await listRoleTemplates(deps, { ...validInput, includeArchived: true });

    expect(listFn).toHaveBeenCalledWith(ORG_ID, {
      includeArchived: true,
      // FR-009: the organizer-facing list is org rows UNION LIVE platform
      // rows, resolved in the repo in a single query.
      includePlatform: true,
    });
  });

  it("allows EDITOR role to list", async () => {
    const deps = makeDeps({
      authz: { getOrgMembership: vi.fn(async () => ({ role: "EDITOR" })) },
    });

    // EDITOR is in ORG_ANY_ROLE, so listing should succeed
    const result = await listRoleTemplates(deps, validInput);
    expect(Array.isArray(result)).toBe(true);
  });

  it("allows read-only VIEWER (auditor) to list", async () => {
    const deps = makeDeps({
      authz: { getOrgMembership: vi.fn(async () => ({ role: "VIEWER" })) },
    });

    // VIEWER is a read-only auditor; the LIST read path is any-member now.
    const result = await listRoleTemplates(deps, validInput);
    expect(Array.isArray(result)).toBe(true);
  });

  it("allows SCANNER role to list", async () => {
    const deps = makeDeps({
      authz: { getOrgMembership: vi.fn(async () => ({ role: "SCANNER" })) },
    });

    const result = await listRoleTemplates(deps, validInput);
    expect(Array.isArray(result)).toBe(true);
  });

  it("rejects non-members", async () => {
    const deps = makeDeps({
      authz: { getOrgMembership: vi.fn(async () => null) },
    });

    await expect(listRoleTemplates(deps, validInput)).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// upsertRoleTemplateShifts
// ══════════════════════════════════════════════════════════════════════════════

describe("upsertRoleTemplateShifts", () => {
  const validInput = {
    actorHumanId: ACTOR_ID,
    templateId: TEMPLATE_ID,
    shifts: [
      // Setup: 4:00 PM – 6:30 PM on event day
      {
        label: "Setup",
        startMinuteOfDay: 16 * 60,
        endMinuteOfDay: 18 * 60 + 30,
      },
      // Doors: 6:30 PM – 8:00 PM, capped at 4 volunteers
      {
        label: "Doors",
        startMinuteOfDay: 18 * 60 + 30,
        endMinuteOfDay: 20 * 60,
        capacity: 4,
      },
      // Main: 8:00 PM – 11:00 PM
      { label: "Main", startMinuteOfDay: 20 * 60, endMinuteOfDay: 23 * 60 },
    ],
  };

  it("replaces the template's shift list and returns the new rows", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    const result = await upsertRoleTemplateShifts(deps, validInput);

    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({
      label: "Setup",
      startMinuteOfDay: 16 * 60,
      endMinuteOfDay: 18 * 60 + 30,
      startDayOffset: 0,
      position: 0,
    });
    expect(
      (txRepos as any).volunteering.upsertRoleTemplateShifts,
    ).toHaveBeenCalledWith(
      TEMPLATE_ID,
      expect.arrayContaining([
        expect.objectContaining({ label: "Setup", position: 0 }),
        expect.objectContaining({ label: "Doors", position: 1 }),
        expect.objectContaining({ label: "Main", position: 2 }),
      ]),
    );
    expect((txRepos as any).audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "volunteer_role_template",
        entityId: TEMPLATE_ID,
        action: "shifts_upserted",
      }),
    );
  });

  it("supports empty shift arrays (clear all)", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    const result = await upsertRoleTemplateShifts(deps, {
      actorHumanId: ACTOR_ID,
      templateId: TEMPLATE_ID,
      shifts: [],
    });
    expect(result).toEqual([]);
    expect(
      (txRepos as any).volunteering.upsertRoleTemplateShifts,
    ).toHaveBeenCalledWith(TEMPLATE_ID, []);
  });

  it("rejects when end time-of-day equals start without endsNextDay", async () => {
    const deps = makeDeps();
    await expect(
      upsertRoleTemplateShifts(deps, {
        actorHumanId: ACTOR_ID,
        templateId: TEMPLATE_ID,
        shifts: [{ label: "Bad", startMinuteOfDay: 600, endMinuteOfDay: 600 }],
      }),
    ).rejects.toBeDefined();
  });

  it("accepts a 24-hour shift via endsNextDay", async () => {
    const { deps } = makeDepsWithMocks();
    const result = await upsertRoleTemplateShifts(deps, {
      actorHumanId: ACTOR_ID,
      templateId: TEMPLATE_ID,
      shifts: [
        {
          label: "Overnight",
          startMinuteOfDay: 22 * 60,
          endMinuteOfDay: 22 * 60,
          endsNextDay: true,
        },
      ],
    });
    expect(result[0]).toMatchObject({
      label: "Overnight",
      endsNextDay: true,
    });
  });

  it("accepts a wrap-past-midnight shift (end < start, endsNextDay true)", async () => {
    const { deps } = makeDepsWithMocks();
    const result = await upsertRoleTemplateShifts(deps, {
      actorHumanId: ACTOR_ID,
      templateId: TEMPLATE_ID,
      shifts: [
        {
          label: "Cleanup",
          startMinuteOfDay: 23 * 60,
          endMinuteOfDay: 30,
          endsNextDay: true,
        },
      ],
    });
    expect(result[0]).toMatchObject({
      label: "Cleanup",
      startMinuteOfDay: 23 * 60,
      endMinuteOfDay: 30,
      endsNextDay: true,
    });
  });

  it("rejects endsNextDay on a shift that already ends after it starts", async () => {
    const { deps } = makeDepsWithMocks();
    // 10:00 → 20:00 with the flag set is a 34-hour shift, and nothing can
    // round-trip it: `endsNextDay` is DERIVED by `parseShiftDraftFields`
    // (`end < start`) and the editor draft has no field for it, so a stored row
    // of this shape reads back as a plain 10-hour shift and silently loses a
    // day on the next unrelated edit. The shape is refused rather than
    // supported — the editors have no >24h control to edit it with.
    await expect(
      upsertRoleTemplateShifts(deps, {
        actorHumanId: ACTOR_ID,
        templateId: TEMPLATE_ID,
        shifts: [
          {
            label: "Impossible",
            startMinuteOfDay: 10 * 60,
            endMinuteOfDay: 20 * 60,
            endsNextDay: true,
          },
        ],
      }),
    ).rejects.toThrow();
  });

  it("rejects when template not found", async () => {
    const deps = makeDeps({
      volunteering: {
        getRoleTemplate: vi.fn(async () => null),
        upsertRoleTemplateShifts: vi.fn(async () => []),
      },
    });
    await expect(
      upsertRoleTemplateShifts(deps, validInput),
    ).rejects.toMatchObject({ code: "TEMPLATE_NOT_FOUND" });
  });

  it("rejects EDITOR role (admin-only mutation)", async () => {
    const deps = makeDeps({
      authz: { getOrgMembership: vi.fn(async () => ({ role: "EDITOR" })) },
    });
    await expect(
      upsertRoleTemplateShifts(deps, validInput),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("rejects VIEWER role (write stays strict)", async () => {
    const deps = makeDeps({
      authz: { getOrgMembership: vi.fn(async () => ({ role: "VIEWER" })) },
    });
    await expect(
      upsertRoleTemplateShifts(deps, validInput),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// getRoleTemplateWithShifts
// ══════════════════════════════════════════════════════════════════════════════

describe("getRoleTemplateWithShifts", () => {
  const validInput = { actorHumanId: ACTOR_ID, templateId: TEMPLATE_ID };

  it("returns template with shifts", async () => {
    const deps = makeDeps({
      volunteering: {
        getRoleTemplateWithShifts: vi.fn(async () => ({
          ...baseTemplate,
          shifts: [
            {
              id: "shift-1",
              templateId: TEMPLATE_ID,
              label: "Setup",
              startMinuteOfDay: 16 * 60,
              endMinuteOfDay: 18 * 60 + 30,
              startDayOffset: 0,
              endsNextDay: false,
              capacity: 2,
              position: 0,
              createdAt: NOW,
              updatedAt: NOW,
            },
          ],
        })),
      },
    });

    const result = await getRoleTemplateWithShifts(deps, validInput);
    expect(result).not.toBeNull();
    expect(result?.shifts).toHaveLength(1);
    expect(result?.shifts[0]?.label).toBe("Setup");
  });

  it("returns null when template not found", async () => {
    const deps = makeDeps({
      volunteering: {
        getRoleTemplateWithShifts: vi.fn(async () => null),
      },
    });
    const result = await getRoleTemplateWithShifts(deps, validInput);
    expect(result).toBeNull();
  });

  it("allows EDITOR role to read", async () => {
    const deps = makeDeps({
      authz: { getOrgMembership: vi.fn(async () => ({ role: "EDITOR" })) },
      volunteering: {
        getRoleTemplateWithShifts: vi.fn(async () => ({
          ...baseTemplate,
          shifts: [],
        })),
      },
    });
    const result = await getRoleTemplateWithShifts(deps, validInput);
    expect(result).not.toBeNull();
  });

  // Regression guard: this single-template read INTENTIONALLY stays on
  // ORG_EDIT_ROLES (unlike the LIST read, which is now ORG_ANY_ROLE). A
  // future edit that silently widens it to any-member must fail here.
  it("rejects VIEWER role (read stays edit-only)", async () => {
    const deps = makeDeps({
      authz: { getOrgMembership: vi.fn(async () => ({ role: "VIEWER" })) },
      volunteering: {
        getRoleTemplateWithShifts: vi.fn(async () => ({
          ...baseTemplate,
          shifts: [],
        })),
      },
    });
    await expect(
      getRoleTemplateWithShifts(deps, validInput),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("rejects SCANNER role (read stays edit-only)", async () => {
    const deps = makeDeps({
      authz: { getOrgMembership: vi.fn(async () => ({ role: "SCANNER" })) },
      volunteering: {
        getRoleTemplateWithShifts: vi.fn(async () => ({
          ...baseTemplate,
          shifts: [],
        })),
      },
    });
    await expect(
      getRoleTemplateWithShifts(deps, validInput),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Platform catalogue rows are read-only to organizers (FR-007 / NFR-002)
//
// `VolunteerRoleTemplate` now holds platform rows (orgId NULL, isPlatform
// true) shared by every org. These use cases reach a template by BARE ID and
// derive authz from the row itself, so without an explicit rejection an org
// OWNER could edit or archive catalogue content for the whole platform.
// ══════════════════════════════════════════════════════════════════════════════

describe("platform templates are immutable to organizers", () => {
  /**
   * Deps whose `getRoleTemplate` resolves ids across tenants — exactly what
   * the real repo does, since `getRoleTemplate` carries no tenancy filter.
   */
  function makeMultiTenantDeps() {
    const rows = [baseTemplate, platformTemplate, otherOrgTemplate];
    return makeDepsWithMocks({
      volunteering: {
        getRoleTemplate: vi.fn(
          async (id: string) => rows.find((r) => r.id === id) ?? null,
        ),
        getRoleTemplateWithShifts: vi.fn(async (id: string) => {
          const row = rows.find((r) => r.id === id);
          return row ? { ...row, shifts: [] } : null;
        }),
        listRoleTemplates: vi.fn(async () => []),
        createRoleTemplate: vi.fn(),
        updateRoleTemplate: vi.fn(),
        archiveRoleTemplate: vi.fn(async () => undefined),
        upsertRoleTemplateShifts: vi.fn(async () => []),
      },
    });
  }

  it("updateRoleTemplate: an org OWNER gets TEMPLATE_NOT_FOUND and writes nothing", async () => {
    const { deps, txRepos } = makeMultiTenantDeps();
    (txRepos.authz as any).getOrgMembership = vi.fn(async () => ({
      role: "OWNER",
    }));

    await expect(
      updateRoleTemplate(deps, {
        actorHumanId: ACTOR_ID,
        id: PLATFORM_TEMPLATE_ID,
        name: "Hijacked",
      }),
    ).rejects.toMatchObject({ code: "TEMPLATE_NOT_FOUND" });

    // The row is untouched...
    expect(
      (txRepos.volunteering as any).updateRoleTemplate,
    ).not.toHaveBeenCalled();
    // ...and the rejection happened BEFORE any membership lookup, so the
    // guard can't be defeated by holding a role in some other org.
    expect((txRepos.authz as any).getOrgMembership).not.toHaveBeenCalled();
  });

  it("archiveRoleTemplate: an org OWNER gets TEMPLATE_NOT_FOUND and writes nothing", async () => {
    const { deps, txRepos } = makeMultiTenantDeps();
    (txRepos.authz as any).getOrgMembership = vi.fn(async () => ({
      role: "OWNER",
    }));

    await expect(
      archiveRoleTemplate(deps, {
        actorHumanId: ACTOR_ID,
        id: PLATFORM_TEMPLATE_ID,
      }),
    ).rejects.toMatchObject({ code: "TEMPLATE_NOT_FOUND" });

    expect(
      (txRepos.volunteering as any).archiveRoleTemplate,
    ).not.toHaveBeenCalled();
    expect((txRepos.authz as any).getOrgMembership).not.toHaveBeenCalled();
    expect((txRepos.audit as any).log).not.toHaveBeenCalled();
  });

  it("upsertRoleTemplateShifts: an org OWNER gets TEMPLATE_NOT_FOUND and writes nothing", async () => {
    const { deps, txRepos } = makeMultiTenantDeps();
    (txRepos.authz as any).getOrgMembership = vi.fn(async () => ({
      role: "OWNER",
    }));

    await expect(
      upsertRoleTemplateShifts(deps, {
        actorHumanId: ACTOR_ID,
        templateId: PLATFORM_TEMPLATE_ID,
        shifts: [
          { label: "Setup", startMinuteOfDay: 960, endMinuteOfDay: 1110 },
        ],
      }),
    ).rejects.toMatchObject({ code: "TEMPLATE_NOT_FOUND" });

    expect(
      (txRepos.volunteering as any).upsertRoleTemplateShifts,
    ).not.toHaveBeenCalled();
    expect((txRepos.authz as any).getOrgMembership).not.toHaveBeenCalled();
  });

  it("getRoleTemplateWithShifts: a platform row reads as null, not as an editable template", async () => {
    const { deps, txRepos } = makeMultiTenantDeps();

    const result = await getRoleTemplateWithShifts(deps, {
      actorHumanId: ACTOR_ID,
      templateId: PLATFORM_TEMPLATE_ID,
    });

    expect(result).toBeNull();
    expect((txRepos.authz as any).getOrgMembership).not.toHaveBeenCalled();
  });

  it("another org's template still 404s identically — same code, nothing written", async () => {
    const { deps, txRepos } = makeMultiTenantDeps();
    // The actor IS a member (of their own org) — membership alone must not
    // unlock a foreign row.
    (txRepos.authz as any).getOrgMembership = vi.fn(async (input: any) =>
      input.orgId === ORG_ID ? { role: "OWNER" } : null,
    );

    await expect(
      updateRoleTemplate(deps, {
        actorHumanId: ACTOR_ID,
        id: OTHER_ORG_TEMPLATE_ID,
        name: "Hijacked",
      }),
    ).rejects.toMatchObject({ code: "TEMPLATE_NOT_FOUND" });

    expect(
      (txRepos.volunteering as any).updateRoleTemplate,
    ).not.toHaveBeenCalled();
  });

  it("an org row with a NULL orgId is unmutatable rather than unowned-and-open", async () => {
    const { deps, txRepos } = makeDepsWithMocks({
      volunteering: {
        // Defensive shape: flag not set, but no owning org either.
        getRoleTemplate: vi.fn(async () => ({
          ...baseTemplate,
          orgId: null,
          isPlatform: false,
        })),
        listRoleTemplates: vi.fn(async () => []),
        createRoleTemplate: vi.fn(),
        updateRoleTemplate: vi.fn(),
        archiveRoleTemplate: vi.fn(),
      },
    });

    await expect(
      updateRoleTemplate(deps, {
        actorHumanId: ACTOR_ID,
        id: TEMPLATE_ID,
        name: "Hijacked",
      }),
    ).rejects.toMatchObject({ code: "TEMPLATE_NOT_FOUND" });
    expect(
      (txRepos.volunteering as any).updateRoleTemplate,
    ).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// listRoleTemplates — org rows + LIVE platform rows, zero foreign rows
// (FR-009 / NFR-002)
// ══════════════════════════════════════════════════════════════════════════════

describe("listRoleTemplates tenancy", () => {
  /**
   * Stands in for the repo's union query: this org's rows plus platform
   * rows whose pack is LIVE. Rows belonging to another org, and platform
   * rows under a DRAFT pack, are simply not in the result set.
   */
  function fakeList(all: RoleTemplateRecord[], livePackIds: string[]) {
    return vi.fn(
      async (orgId: string, opts?: { includePlatform?: boolean }) =>
        all.filter((t) =>
          t.isPlatform
            ? Boolean(
                opts?.includePlatform &&
                  t.orgId === null &&
                  t.packId !== null &&
                  livePackIds.includes(t.packId),
              )
            : t.orgId === orgId,
        ),
    );
  }

  const draftPackTemplate: RoleTemplateRecord = {
    ...platformTemplate,
    id: "00000000-0000-4000-8000-000000000013",
    name: "Unpublished",
    packId: "00000000-0000-4000-8000-000000000021",
  };

  it("returns Org A's rows + LIVE platform rows and ZERO of Org B's", async () => {
    const deps = makeDeps({
      volunteering: {
        listRoleTemplates: fakeList(
          [baseTemplate, otherOrgTemplate, platformTemplate, draftPackTemplate],
          [LIVE_PACK_ID],
        ),
        getRoleTemplate: vi.fn(),
        createRoleTemplate: vi.fn(),
        updateRoleTemplate: vi.fn(),
        archiveRoleTemplate: vi.fn(),
      },
    });

    const result = await listRoleTemplates(deps, {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
    });

    expect(result.map((t) => t.id).sort()).toEqual(
      [TEMPLATE_ID, PLATFORM_TEMPLATE_ID].sort(),
    );
    // Nothing from Org B, by id and by owner.
    expect(result.some((t) => t.orgId === OTHER_ORG_ID)).toBe(false);
    // Nothing from an unpublished pack.
    expect(result.some((t) => t.id === draftPackTemplate.id)).toBe(false);
  });

  it("flags platform rows so the caller can tag them read-only", async () => {
    const deps = makeDeps({
      volunteering: {
        listRoleTemplates: fakeList(
          [baseTemplate, platformTemplate],
          [LIVE_PACK_ID],
        ),
        getRoleTemplate: vi.fn(),
        createRoleTemplate: vi.fn(),
        updateRoleTemplate: vi.fn(),
        archiveRoleTemplate: vi.fn(),
      },
    });

    const result = await listRoleTemplates(deps, {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
    });

    const own = result.find((t) => t.id === TEMPLATE_ID);
    const platform = result.find((t) => t.id === PLATFORM_TEMPLATE_ID);
    expect(own).toMatchObject({ isPlatform: false, packId: null });
    expect(platform).toMatchObject({
      isPlatform: true,
      orgId: null,
      packId: LIVE_PACK_ID,
    });
  });

  it("the name-collision precheck on create stays ORG-ONLY", async () => {
    // A platform role named "Door" must not block an org from creating its
    // own "Door" — the DB unique is (orgId, name).
    const listFn = fakeList([platformTemplate], [LIVE_PACK_ID]);
    const deps = makeDeps({
      volunteering: {
        listRoleTemplates: listFn,
        getRoleTemplate: vi.fn(),
        createRoleTemplate: vi.fn(async (input: any) => ({
          ...baseTemplate,
          ...input,
          id: TEMPLATE_ID,
        })),
        updateRoleTemplate: vi.fn(),
        archiveRoleTemplate: vi.fn(),
      },
    });

    const created = await createRoleTemplate(deps, {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
      name: "Door",
    });

    expect(created.id).toBe(TEMPLATE_ID);
    // Asked for org rows only — no includePlatform.
    expect(listFn).toHaveBeenCalledWith(ORG_ID, { includeArchived: true });
  });

  it("the rename-collision precheck on update stays ORG-ONLY", async () => {
    const listFn = fakeList([baseTemplate, platformTemplate], [LIVE_PACK_ID]);
    const deps = makeDeps({
      volunteering: {
        listRoleTemplates: listFn,
        getRoleTemplate: vi.fn(async () => baseTemplate),
        createRoleTemplate: vi.fn(),
        updateRoleTemplate: vi.fn(async (id: string, input: any) => ({
          ...baseTemplate,
          ...input,
          id,
        })),
        archiveRoleTemplate: vi.fn(),
      },
    });

    // "Door" is taken by a PLATFORM row — that is not a collision.
    const updated = await updateRoleTemplate(deps, {
      actorHumanId: ACTOR_ID,
      id: TEMPLATE_ID,
      name: "Door",
    });

    expect(updated.name).toBe("Door");
    expect(listFn).toHaveBeenCalledWith(ORG_ID, { includeArchived: true });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Shift anchoring — the replace-set must ROUND-TRIP anchor / offset / notes
// ══════════════════════════════════════════════════════════════════════════════

describe("upsertRoleTemplateShifts — anchor round-trip (FR-005 prerequisite)", () => {
  it("defaults an unanchored draft to WALL_CLOCK + offset 0 + no notes", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    await upsertRoleTemplateShifts(deps, {
      actorHumanId: ACTOR_ID,
      templateId: TEMPLATE_ID,
      shifts: [
        {
          label: "Setup",
          startMinuteOfDay: 16 * 60,
          endMinuteOfDay: 18 * 60 + 30,
        },
      ],
    });

    expect(
      (txRepos as any).volunteering.upsertRoleTemplateShifts,
    ).toHaveBeenCalledWith(TEMPLATE_ID, [
      expect.objectContaining({
        anchor: "WALL_CLOCK",
        offsetMinutes: 0,
        notes: null,
      }),
    ]);
  });

  /**
   * The regression this whole schema change exists for. Before it, a forked
   * EVENT_START preset was silently reset to (WALL_CLOCK, 0, NULL) on the
   * org's first save in the shift editor — no error, no visible diff, and the
   * shift moved to the wrong time.
   */
  it("preserves an EVENT_START preset with a negative offset", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    const result = await upsertRoleTemplateShifts(deps, {
      actorHumanId: ACTOR_ID,
      templateId: TEMPLATE_ID,
      shifts: [
        {
          label: "Load-in",
          startMinuteOfDay: 16 * 60,
          endMinuteOfDay: 18 * 60 + 30,
          anchor: "EVENT_START",
          offsetMinutes: -180,
          notes: "Meet at the loading dock",
        },
      ],
    });

    expect(
      (txRepos as any).volunteering.upsertRoleTemplateShifts,
    ).toHaveBeenCalledWith(TEMPLATE_ID, [
      expect.objectContaining({
        anchor: "EVENT_START",
        offsetMinutes: -180,
        notes: "Meet at the loading dock",
      }),
    ]);
    expect(result[0]).toMatchObject({
      anchor: "EVENT_START",
      offsetMinutes: -180,
    });
  });

  it("preserves an EVENT_END preset with a positive offset", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    await upsertRoleTemplateShifts(deps, {
      actorHumanId: ACTOR_ID,
      templateId: TEMPLATE_ID,
      shifts: [
        {
          label: "Cleanup",
          startMinuteOfDay: 0,
          endMinuteOfDay: 90,
          anchor: "EVENT_END",
          offsetMinutes: 30,
        },
      ],
    });

    expect(
      (txRepos as any).volunteering.upsertRoleTemplateShifts,
    ).toHaveBeenCalledWith(TEMPLATE_ID, [
      expect.objectContaining({ anchor: "EVENT_END", offsetMinutes: 30 }),
    ]);
  });

  it("rejects a non-zero offset on a WALL_CLOCK preset", async () => {
    const deps = makeDeps();
    await expect(
      upsertRoleTemplateShifts(deps, {
        actorHumanId: ACTOR_ID,
        templateId: TEMPLATE_ID,
        shifts: [
          {
            label: "Confused",
            startMinuteOfDay: 600,
            endMinuteOfDay: 720,
            anchor: "WALL_CLOCK",
            offsetMinutes: -60,
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects a non-zero offset when the anchor is simply omitted", async () => {
    const deps = makeDeps();
    await expect(
      upsertRoleTemplateShifts(deps, {
        actorHumanId: ACTOR_ID,
        templateId: TEMPLATE_ID,
        shifts: [
          {
            label: "Confused",
            startMinuteOfDay: 600,
            endMinuteOfDay: 720,
            offsetMinutes: -60,
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects an offset beyond ±24 hours", async () => {
    const deps = makeDeps();
    for (const offsetMinutes of [-1441, 1441, -18000]) {
      await expect(
        upsertRoleTemplateShifts(deps, {
          actorHumanId: ACTOR_ID,
          templateId: TEMPLATE_ID,
          shifts: [
            {
              label: "Way off",
              startMinuteOfDay: 600,
              endMinuteOfDay: 720,
              anchor: "EVENT_START",
              offsetMinutes,
            },
          ],
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });
    }
  });

  it("accepts exactly ±24 hours (the bound is inclusive)", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    await upsertRoleTemplateShifts(deps, {
      actorHumanId: ACTOR_ID,
      templateId: TEMPLATE_ID,
      shifts: [
        {
          label: "Overnight festival load-in",
          startMinuteOfDay: 600,
          endMinuteOfDay: 720,
          anchor: "EVENT_START",
          offsetMinutes: -1440,
        },
      ],
    });
    expect(
      (txRepos as any).volunteering.upsertRoleTemplateShifts,
    ).toHaveBeenCalledWith(TEMPLATE_ID, [
      expect.objectContaining({ offsetMinutes: -1440 }),
    ]);
  });

  it("rejects an unknown anchor value", async () => {
    const deps = makeDeps();
    await expect(
      upsertRoleTemplateShifts(deps, {
        actorHumanId: ACTOR_ID,
        templateId: TEMPLATE_ID,
        shifts: [
          {
            label: "Doors",
            startMinuteOfDay: 600,
            endMinuteOfDay: 720,
            anchor: "DOORS",
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("sanitizes notes as plain text", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    await upsertRoleTemplateShifts(deps, {
      actorHumanId: ACTOR_ID,
      templateId: TEMPLATE_ID,
      shifts: [
        {
          label: "Setup",
          startMinuteOfDay: 600,
          endMinuteOfDay: 720,
          notes: "  <script>alert(1)</script> back door  ",
        },
      ],
    });

    const [, shifts] = (
      txRepos as any
    ).volunteering.upsertRoleTemplateShifts.mock.calls[0];
    expect(shifts[0].notes).not.toContain("<script>");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Pack shadowing (FR-011) — an org's fork hides the catalogue row it came from
// ══════════════════════════════════════════════════════════════════════════════

describe("listRoleTemplates — pack shadowing", () => {
  const validInput = { actorHumanId: ACTOR_ID, orgId: ORG_ID };
  const FORK_ID = "00000000-0000-4000-8000-000000000031";

  /** The org's copy of `platformTemplate` — same pack, same name. */
  const fork: RoleTemplateRecord = {
    ...baseTemplate,
    id: FORK_ID,
    orgId: ORG_ID,
    name: "Door",
    isPlatform: false,
    packId: LIVE_PACK_ID,
  };

  function listing(rows: RoleTemplateRecord[]) {
    return makeDeps({
      volunteering: {
        listRoleTemplates: vi.fn(async () => rows),
        getRoleTemplate: vi.fn(),
        createRoleTemplate: vi.fn(),
        updateRoleTemplate: vi.fn(),
        archiveRoleTemplate: vi.fn(),
      },
    });
  }

  it("hides the platform row once the org has forked it", async () => {
    const result = await listRoleTemplates(
      listing([fork, platformTemplate]),
      validInput,
    );
    expect(result.map((t) => t.id)).toEqual([FORK_ID]);
  });

  it("keeps the platform row when nothing has been forked", async () => {
    const result = await listRoleTemplates(
      listing([baseTemplate, platformTemplate]),
      validInput,
    );
    expect(result.map((t) => t.id)).toEqual([TEMPLATE_ID, PLATFORM_TEMPLATE_ID]);
  });

  it("shadows only the forked role, not the rest of its pack", async () => {
    // The bug a packId-only key would cause: forking "Door" from a six-role
    // pack would hide the other five.
    const sibling: RoleTemplateRecord = {
      ...platformTemplate,
      id: "00000000-0000-4000-8000-000000000032",
      name: "Sound",
    };
    const result = await listRoleTemplates(
      listing([fork, platformTemplate, sibling]),
      validInput,
    );
    expect(result.map((t) => t.name)).toEqual(["Door", "Sound"]);
  });

  it("does not shadow on name alone (an org's unrelated row keeps the catalogue row visible)", async () => {
    // Same name, no pack provenance — a "Door" the org made before packs
    // existed must not hide the catalogue's "Door".
    const homegrown: RoleTemplateRecord = {
      ...baseTemplate,
      id: "00000000-0000-4000-8000-000000000033",
      name: "Door",
      packId: null,
    };
    const result = await listRoleTemplates(
      listing([homegrown, platformTemplate]),
      validInput,
    );
    expect(result.map((t) => t.id)).toEqual([
      homegrown.id,
      PLATFORM_TEMPLATE_ID,
    ]);
  });

  it("does not shadow on packId alone across different names", async () => {
    const renamedFork: RoleTemplateRecord = {
      ...fork,
      name: "Front Door",
    };
    const result = await listRoleTemplates(
      listing([renamedFork, platformTemplate]),
      validInput,
    );
    expect(result.map((t) => t.name)).toEqual(["Front Door", "Door"]);
  });

  it("matches names case-insensitively", async () => {
    const result = await listRoleTemplates(
      listing([{ ...fork, name: "DOOR" }, platformTemplate]),
      validInput,
    );
    expect(result.map((t) => t.id)).toEqual([FORK_ID]);
  });

  it("never lets one platform row shadow another", async () => {
    // Two catalogue rows in the same pack can't share a name (partial unique
    // index), but the filter must key off ORG rows regardless.
    const result = await listRoleTemplates(
      listing([platformTemplate, { ...platformTemplate, id: "x" }]),
      validInput,
    );
    expect(result).toHaveLength(2);
  });
});
