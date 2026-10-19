import { describe, expect, it, vi } from "vitest";

import type { Repos, TxRepos } from "@th/ports/repos";
import type {
  RoleTemplateWithShiftsRecord,
  VolunteerPackRecord,
  VolunteerPackWithRolesRecord,
} from "@th/ports/repos/volunteering";

import { getVolunteerPackAdmin } from "../get-volunteer-pack-admin";
import { listVolunteerPacksAdmin } from "../list-volunteer-packs-admin";
import { removeVolunteerPack } from "../remove-volunteer-pack";
import { setVolunteerPackStatus } from "../set-volunteer-pack-status";
import { upsertVolunteerPack } from "../upsert-volunteer-pack";

// ── Constants ────────────────────────────────────────────────────────────────

const ACTOR_ID = "00000000-0000-4000-8000-000000000001";
const PACK_ID = "00000000-0000-4000-8000-000000000020";
const ROLE_ID = "00000000-0000-4000-8000-000000000030";
const CATEGORY_ID = "00000000-0000-4000-8000-000000000040";
const NOW = new Date("2026-07-28T12:00:00.000Z");

// ── Fixtures ─────────────────────────────────────────────────────────────────

const draftPack: VolunteerPackRecord = {
  id: PACK_ID,
  key: "house-show",
  name: "House show",
  blurb: "Six roles for a living-room gig.",
  status: "DRAFT",
  targetCategoryIds: [CATEGORY_ID],
  rankFirst: false,
  sortOrder: 0,
  curatedByHumanId: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const packRole: RoleTemplateWithShiftsRecord = {
  id: ROLE_ID,
  orgId: null,
  name: "Door",
  description: "Greet and check tickets",
  defaultCapacity: 2,
  sortOrder: 0,
  archived: false,
  isPlatform: true,
  packId: PACK_ID,
  createdAt: NOW,
  updatedAt: NOW,
  shifts: [],
};

const packWithRoles: VolunteerPackWithRolesRecord = {
  ...draftPack,
  roles: [packRole],
};

// ── Mock builders ────────────────────────────────────────────────────────────

/** Every STAFF_TECH-gated use case shares this authz surface. */
function makeAuthz(allowed = true, role = "ADMIN") {
  return {
    hasStaffRole: vi.fn(async () => ({
      allowed,
      ...(allowed ? { role } : {}),
    })),
  };
}

function makeTxRepos(volunteeringOverrides: Record<string, unknown> = {}) {
  return {
    volunteering: {
      listPacks: vi.fn(async () => [
        { ...draftPack, roleCount: 1, forkCount: 0 },
      ]),
      getPack: vi.fn(async () => draftPack),
      getPackByKey: vi.fn(async () => null),
      getPackWithRoles: vi.fn(async () => packWithRoles),
      createPack: vi.fn(async (input: any) => ({
        ...draftPack,
        ...input,
        id: PACK_ID,
        status: input.status ?? "DRAFT",
      })),
      updatePack: vi.fn(async (id: string, input: any) => ({
        ...draftPack,
        ...input,
        id,
      })),
      deletePack: vi.fn(async () => undefined),
      createPlatformRoleTemplate: vi.fn(async (input: any) => ({
        ...packRole,
        id: "new-role",
        name: input.name,
      })),
      updateRoleTemplate: vi.fn(async () => packRole),
      upsertRoleTemplateShifts: vi.fn(async () => []),
      deletePlatformRoleTemplates: vi.fn(async (ids: string[]) => ids.length),
      deletePlatformRoleTemplatesByPack: vi.fn(async () => 1),
      countPlatformRoleTemplatesByPack: vi.fn(async () => 0),
      ...volunteeringOverrides,
    },
    audit: { log: vi.fn(async () => undefined) },
  };
}

function makeDeps(volunteeringOverrides: Record<string, unknown> = {}) {
  const txRepos = makeTxRepos(volunteeringOverrides);
  const authz = makeAuthz();
  return {
    txRepos,
    authz,
    deps: {
      repos: {
        ...txRepos,
        tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) =>
          fn(txRepos as unknown as TxRepos),
        ),
      } as unknown as Repos,
      authz: authz as any,
      clock: { now: () => NOW },
    },
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// STAFF_TECH gate (FR-014)
// ══════════════════════════════════════════════════════════════════════════════

describe("volunteerPacks.admin — STAFF_TECH gate", () => {
  const cases = [
    [
      "list",
      (deps: any) => listVolunteerPacksAdmin(deps, { actorHumanId: ACTOR_ID }),
    ],
    [
      "get",
      (deps: any) =>
        getVolunteerPackAdmin(deps, {
          actorHumanId: ACTOR_ID,
          packId: PACK_ID,
        }),
    ],
    [
      "upsert",
      (deps: any) =>
        upsertVolunteerPack(deps, {
          actorHumanId: ACTOR_ID,
          key: "house-show",
          name: "House show",
        }),
    ],
    [
      "setStatus",
      (deps: any) =>
        setVolunteerPackStatus(deps, {
          actorHumanId: ACTOR_ID,
          packId: PACK_ID,
          status: "LIVE",
        }),
    ],
    [
      "remove",
      (deps: any) =>
        removeVolunteerPack(deps, {
          actorHumanId: ACTOR_ID,
          packId: PACK_ID,
        }),
    ],
  ] as const;

  it.each(cases)("%s asks for ADMIN + DEVELOPER only", async (_name, run) => {
    const { deps, authz } = makeDeps();
    await run(deps);
    expect(authz.hasStaffRole).toHaveBeenCalledWith({
      actorHumanId: ACTOR_ID,
      requiredRoles: ["ADMIN", "DEVELOPER"],
    });
    // Explicitly NOT the wider STAFF_ALL that `featured` uses.
    const call = (
      authz.hasStaffRole.mock.calls as unknown as Array<
        [{ requiredRoles: string[] }]
      >
    )[0];
    expect(call?.[0].requiredRoles).not.toContain("REVIEWER");
    expect(call?.[0].requiredRoles).not.toContain("SUPPORT");
  });

  it.each(cases)(
    "%s refuses a non-STAFF_TECH staff member",
    async (_n, run) => {
      const { deps, txRepos } = makeDeps();
      (deps.authz as any).hasStaffRole = vi.fn(async () => ({
        allowed: false,
      }));

      await expect(run(deps)).rejects.toMatchObject({ code: "STAFF_ONLY" });
      expect(txRepos.audit.log).not.toHaveBeenCalled();
    },
  );
});

// ══════════════════════════════════════════════════════════════════════════════
// listVolunteerPacksAdmin
// ══════════════════════════════════════════════════════════════════════════════

describe("listVolunteerPacksAdmin", () => {
  it("returns every pack, DRAFT included, with role and fork counts", async () => {
    const { deps } = makeDeps();
    const result = await listVolunteerPacksAdmin(deps, {
      actorHumanId: ACTOR_ID,
    });
    expect(result.packs).toEqual([
      expect.objectContaining({
        id: PACK_ID,
        status: "DRAFT",
        roleCount: 1,
        forkCount: 0,
      }),
    ]);
  });

  it("passes a status filter through when asked", async () => {
    const { deps, txRepos } = makeDeps();
    await listVolunteerPacksAdmin(deps, {
      actorHumanId: ACTOR_ID,
      status: "LIVE",
    });
    expect(txRepos.volunteering.listPacks).toHaveBeenCalledWith({
      status: "LIVE",
    });
  });

  it("asks for EVERY pack when no status is given", async () => {
    const { deps, txRepos } = makeDeps();
    await listVolunteerPacksAdmin(deps, { actorHumanId: ACTOR_ID });
    expect(txRepos.volunteering.listPacks).toHaveBeenCalledWith(undefined);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// getVolunteerPackAdmin — preview (FR-016)
// ══════════════════════════════════════════════════════════════════════════════

describe("getVolunteerPackAdmin", () => {
  it("previews a DRAFT pack with its roles — status is not part of the gate", async () => {
    const { deps } = makeDeps();
    const result = await getVolunteerPackAdmin(deps, {
      actorHumanId: ACTOR_ID,
      packId: PACK_ID,
    });
    expect(result.pack.status).toBe("DRAFT");
    expect(result.pack.roles).toHaveLength(1);
    expect(result.pack.roles[0]).toMatchObject({ name: "Door" });
  });

  it("uses the status-BLIND read, never the LIVE-only organizer one", async () => {
    const { deps, txRepos } = makeDeps();
    await getVolunteerPackAdmin(deps, {
      actorHumanId: ACTOR_ID,
      packId: PACK_ID,
    });
    expect(txRepos.volunteering.getPackWithRoles).toHaveBeenCalledWith(PACK_ID);
    expect(txRepos.volunteering.listPacks).not.toHaveBeenCalled();
  });

  it("404s an unknown pack", async () => {
    const { deps } = makeDeps({ getPackWithRoles: vi.fn(async () => null) });
    await expect(
      getVolunteerPackAdmin(deps, { actorHumanId: ACTOR_ID, packId: PACK_ID }),
    ).rejects.toMatchObject({ code: "VOLUNTEER_PACK_NOT_FOUND" });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// upsertVolunteerPack
// ══════════════════════════════════════════════════════════════════════════════

describe("upsertVolunteerPack", () => {
  const baseInput = {
    actorHumanId: ACTOR_ID,
    key: "house-show",
    name: "House show",
    blurb: "Six roles for a living-room gig.",
  };

  it("creates a new pack as DRAFT, never LIVE", async () => {
    const { deps, txRepos } = makeDeps();
    await upsertVolunteerPack(deps, baseInput);
    expect(txRepos.volunteering.createPack).toHaveBeenCalledWith(
      expect.objectContaining({ key: "house-show", status: "DRAFT" }),
    );
  });

  it("does not accept a status field at all (publishing is separate)", async () => {
    const { deps } = makeDeps();
    await expect(
      upsertVolunteerPack(deps, { ...baseInput, status: "LIVE" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("updates in place when the key already exists", async () => {
    const { deps, txRepos } = makeDeps({
      getPackByKey: vi.fn(async () => draftPack),
    });
    await upsertVolunteerPack(deps, { ...baseInput, name: "House shows" });
    expect(txRepos.volunteering.createPack).not.toHaveBeenCalled();
    expect(txRepos.volunteering.updatePack).toHaveBeenCalledWith(
      PACK_ID,
      expect.objectContaining({ name: "House shows" }),
    );
  });

  it("leaves `blurb` untouched on a metadata-only edit", async () => {
    // The staff editor's typo fix sends `{ key, name }`. Omitted must mean
    // untouched — the same contract `targetCategoryIds` / `rankFirst` /
    // `sortOrder` already honour — or a name fix silently NULLs staff-authored
    // copy with nothing in the audit row recording what it was.
    const { deps, txRepos } = makeDeps({
      getPackByKey: vi.fn(async () => draftPack),
    });
    await upsertVolunteerPack(deps, {
      actorHumanId: ACTOR_ID,
      key: "house-show",
      name: "House Show",
    });
    const [, patch] = txRepos.volunteering.updatePack.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(patch).not.toHaveProperty("blurb");
  });

  it("clears `blurb` when it is explicitly null", async () => {
    // `.nullish()`, so omitted and null stay distinguishable: staff can still
    // delete a blurb on purpose.
    const { deps, txRepos } = makeDeps({
      getPackByKey: vi.fn(async () => draftPack),
    });
    await upsertVolunteerPack(deps, { ...baseInput, blurb: null });
    const [, patch] = txRepos.volunteering.updatePack.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(patch).toMatchObject({ blurb: null });
  });

  it("never changes status on an edit", async () => {
    const { deps, txRepos } = makeDeps({
      getPackByKey: vi.fn(async () => ({ ...draftPack, status: "LIVE" })),
    });
    await upsertVolunteerPack(deps, baseInput);
    const [patch] = (
      txRepos.volunteering.updatePack.mock.calls as unknown as Array<
        [string, Record<string, unknown>]
      >
    ).map(([, arg]) => arg);
    expect(patch).toBeDefined();
    expect(patch).not.toHaveProperty("status");
  });

  it("rejects a non-slug key", async () => {
    const { deps } = makeDeps();
    for (const key of ["House Show", "house_show", "house--show", ""]) {
      await expect(
        upsertVolunteerPack(deps, { ...baseInput, key }),
      ).rejects.toMatchObject({ code: "invalid_input" });
    }
  });

  it("leaves roles untouched when `roles` is omitted", async () => {
    const { deps, txRepos } = makeDeps({
      getPackByKey: vi.fn(async () => draftPack),
    });
    await upsertVolunteerPack(deps, baseInput);
    expect(
      txRepos.volunteering.createPlatformRoleTemplate,
    ).not.toHaveBeenCalled();
    expect(
      txRepos.volunteering.deletePlatformRoleTemplates,
    ).not.toHaveBeenCalled();
  });

  it("creates catalogue rows for names the pack does not have yet", async () => {
    const { deps, txRepos } = makeDeps({
      getPackByKey: vi.fn(async () => draftPack),
      getPackWithRoles: vi.fn(async () => ({ ...draftPack, roles: [] })),
    });
    await upsertVolunteerPack(deps, {
      ...baseInput,
      roles: [{ name: "Sound", defaultCapacity: 1 }],
    });
    expect(
      txRepos.volunteering.createPlatformRoleTemplate,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ packId: PACK_ID, name: "Sound" }),
    );
  });

  it("updates a role in place rather than churning its id", async () => {
    const { deps, txRepos } = makeDeps({
      getPackByKey: vi.fn(async () => draftPack),
    });
    await upsertVolunteerPack(deps, {
      ...baseInput,
      roles: [{ name: "Door", description: "New copy" }],
    });
    expect(txRepos.volunteering.updateRoleTemplate).toHaveBeenCalledWith(
      ROLE_ID,
      expect.objectContaining({ name: "Door", description: "New copy" }),
    );
    expect(
      txRepos.volunteering.createPlatformRoleTemplate,
    ).not.toHaveBeenCalled();
  });

  it("deletes catalogue rows the payload no longer names", async () => {
    const { deps, txRepos } = makeDeps({
      getPackByKey: vi.fn(async () => draftPack),
    });
    await upsertVolunteerPack(deps, { ...baseInput, roles: [] });
    expect(
      txRepos.volunteering.deletePlatformRoleTemplates,
    ).toHaveBeenCalledWith([ROLE_ID]);
  });

  it("writes anchored shift presets through, offset and all", async () => {
    const { deps, txRepos } = makeDeps({
      getPackByKey: vi.fn(async () => draftPack),
    });
    await upsertVolunteerPack(deps, {
      ...baseInput,
      roles: [
        {
          name: "Door",
          shifts: [
            {
              label: "Load-in",
              startMinuteOfDay: 16 * 60,
              endMinuteOfDay: 18 * 60 + 30,
              anchor: "EVENT_START",
              offsetMinutes: -180,
              notes: "Loading dock",
            },
          ],
        },
      ],
    });
    expect(txRepos.volunteering.upsertRoleTemplateShifts).toHaveBeenCalledWith(
      ROLE_ID,
      [
        expect.objectContaining({
          anchor: "EVENT_START",
          offsetMinutes: -180,
          notes: "Loading dock",
        }),
      ],
    );
  });

  it("rejects two roles with the same name in one pack", async () => {
    const { deps } = makeDeps();
    await expect(
      upsertVolunteerPack(deps, {
        ...baseInput,
        roles: [{ name: "Door" }, { name: "door" }],
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("writes an audit row naming the actor (FR-015)", async () => {
    const { deps, txRepos } = makeDeps();
    await upsertVolunteerPack(deps, baseInput);
    expect(txRepos.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "volunteer_pack",
        entityId: PACK_ID,
        action: "volunteer_pack.created",
        data: expect.objectContaining({ actorHumanId: ACTOR_ID }),
      }),
    );
  });

  it("distinguishes created from updated in the audit action", async () => {
    const { deps, txRepos } = makeDeps({
      getPackByKey: vi.fn(async () => draftPack),
    });
    await upsertVolunteerPack(deps, baseInput);
    expect(txRepos.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "volunteer_pack.updated" }),
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// setVolunteerPackStatus
// ══════════════════════════════════════════════════════════════════════════════

describe("setVolunteerPackStatus", () => {
  it("publishes a pack and audits it as published", async () => {
    const { deps, txRepos } = makeDeps();
    const result = await setVolunteerPackStatus(deps, {
      actorHumanId: ACTOR_ID,
      packId: PACK_ID,
      status: "LIVE",
    });
    expect(result.pack.status).toBe("LIVE");
    expect(txRepos.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "volunteer_pack",
        entityId: PACK_ID,
        action: "volunteer_pack.published",
        data: expect.objectContaining({
          actorHumanId: ACTOR_ID,
          from: "DRAFT",
          to: "LIVE",
        }),
      }),
    );
  });

  it("unpublishes without touching the pack's roles", async () => {
    const { deps, txRepos } = makeDeps({
      getPack: vi.fn(async () => ({ ...draftPack, status: "LIVE" })),
    });
    await setVolunteerPackStatus(deps, {
      actorHumanId: ACTOR_ID,
      packId: PACK_ID,
      status: "DRAFT",
    });
    expect(txRepos.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "volunteer_pack.unpublished" }),
    );
    expect(
      txRepos.volunteering.deletePlatformRoleTemplates,
    ).not.toHaveBeenCalled();
    expect(
      txRepos.volunteering.deletePlatformRoleTemplatesByPack,
    ).not.toHaveBeenCalled();
  });

  it("404s an unknown pack", async () => {
    const { deps } = makeDeps({ getPack: vi.fn(async () => null) });
    await expect(
      setVolunteerPackStatus(deps, {
        actorHumanId: ACTOR_ID,
        packId: PACK_ID,
        status: "LIVE",
      }),
    ).rejects.toMatchObject({ code: "VOLUNTEER_PACK_NOT_FOUND" });
  });

  it("rejects a status outside the enum", async () => {
    const { deps } = makeDeps();
    await expect(
      setVolunteerPackStatus(deps, {
        actorHumanId: ACTOR_ID,
        packId: PACK_ID,
        status: "ARCHIVED",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// removeVolunteerPack — the CHECK-constraint ordering
// ══════════════════════════════════════════════════════════════════════════════

describe("removeVolunteerPack", () => {
  const validInput = { actorHumanId: ACTOR_ID, packId: PACK_ID };

  it("deletes the pack's catalogue roles BEFORE the pack itself", async () => {
    const order: string[] = [];
    const { deps } = makeDeps({
      deletePlatformRoleTemplatesByPack: vi.fn(async () => {
        order.push("roles");
        return 3;
      }),
      deletePack: vi.fn(async () => {
        order.push("pack");
      }),
    });

    const result = await removeVolunteerPack(deps, validInput);
    // The FK is SET NULL (fork-safe), and the CHECK makes SET NULL on a
    // surviving platform row raise — so this order is load-bearing, not tidy.
    expect(order).toEqual(["roles", "pack"]);
    expect(result).toEqual({ removed: true, deletedRoleCount: 3 });
  });

  it("scopes the role delete to PLATFORM rows of this pack", async () => {
    const { deps, txRepos } = makeDeps();
    await removeVolunteerPack(deps, validInput);
    // Org forks carry the same packId; the repo method is isPlatform-scoped,
    // and the generic id-list delete is never used here.
    expect(
      txRepos.volunteering.deletePlatformRoleTemplatesByPack,
    ).toHaveBeenCalledWith(PACK_ID);
    expect(
      txRepos.volunteering.deletePlatformRoleTemplates,
    ).not.toHaveBeenCalled();
  });

  it("runs the whole thing in ONE transaction", async () => {
    const { deps } = makeDeps();
    await removeVolunteerPack(deps, validInput);
    expect((deps.repos as any).tx).toHaveBeenCalledTimes(1);
  });

  it("throws a TYPED error when a role survives the delete (concurrent insert)", async () => {
    const { deps, txRepos } = makeDeps({
      countPlatformRoleTemplatesByPack: vi.fn(async () => 1),
    });

    await expect(removeVolunteerPack(deps, validInput)).rejects.toMatchObject({
      code: "VOLUNTEER_PACK_HAS_PLATFORM_ROLES",
    });
    expect(txRepos.volunteering.deletePack).not.toHaveBeenCalled();
  });

  it("translates a raw CHECK violation instead of surfacing a 500", async () => {
    const { deps } = makeDeps({
      deletePack: vi.fn(async () => {
        throw new Error(
          'new row for relation "VolunteerRoleTemplate" violates check constraint "VolunteerRoleTemplate_platform_pack_check"',
        );
      }),
    });

    await expect(removeVolunteerPack(deps, validInput)).rejects.toMatchObject({
      code: "VOLUNTEER_PACK_HAS_PLATFORM_ROLES",
    });
  });

  it("does not swallow an unrelated database error", async () => {
    const { deps } = makeDeps({
      deletePack: vi.fn(async () => {
        throw new Error("connection terminated unexpectedly");
      }),
    });

    await expect(removeVolunteerPack(deps, validInput)).rejects.toThrow(
      "connection terminated unexpectedly",
    );
  });

  it("404s an unknown pack before deleting anything", async () => {
    const { deps, txRepos } = makeDeps({ getPack: vi.fn(async () => null) });
    await expect(removeVolunteerPack(deps, validInput)).rejects.toMatchObject({
      code: "VOLUNTEER_PACK_NOT_FOUND",
    });
    expect(
      txRepos.volunteering.deletePlatformRoleTemplatesByPack,
    ).not.toHaveBeenCalled();
  });

  it("writes an audit row naming the actor and the role count (FR-015)", async () => {
    const { deps, txRepos } = makeDeps();
    await removeVolunteerPack(deps, validInput);
    expect(txRepos.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "volunteer_pack",
        entityId: PACK_ID,
        action: "volunteer_pack.deleted",
        data: expect.objectContaining({
          actorHumanId: ACTOR_ID,
          key: "house-show",
          deletedRoleCount: 1,
        }),
      }),
    );
  });
});
