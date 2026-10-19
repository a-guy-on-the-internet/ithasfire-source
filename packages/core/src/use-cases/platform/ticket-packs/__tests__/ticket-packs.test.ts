import { describe, expect, it, vi } from "vitest";

import type { Repos, TxRepos } from "@th/ports/repos";
import type {
  TicketPackRecord,
  TicketPackWithTemplatesRecord,
  TicketTypeTemplateRecord,
} from "@th/types";

import { getTicketPackAdmin } from "../get-ticket-pack-admin";
import { listTicketPacksAdmin } from "../list-ticket-packs-admin";
import { removeTicketPack } from "../remove-ticket-pack";
import { setTicketPackStatus } from "../set-ticket-pack-status";
import { upsertTicketPack } from "../upsert-ticket-pack";

// ── Constants ────────────────────────────────────────────────────────────────

const ACTOR_ID = "00000000-0000-4000-8000-000000000001";
const PACK_ID = "00000000-0000-4000-8000-000000000020";
const TEMPLATE_ID = "00000000-0000-4000-8000-000000000030";
const NOW = new Date("2026-08-04T12:00:00.000Z");

// ── Fixtures ─────────────────────────────────────────────────────────────────

const GA_ENTRY = {
  name: "General admission",
  priceCents: 2000,
  pricingMode: "FIXED" as const,
  minimumCents: null,
  suggestedCents: null,
  capacity: 100,
  resaleAllowed: false,
  resaleCapCents: null,
  transferAllowed: true,
};

const draftPack: TicketPackRecord = {
  id: PACK_ID,
  key: "general-admission",
  name: "General admission",
  blurb: "One simple GA type.",
  status: "DRAFT",
  sortOrder: 0,
  curatedByHumanId: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const packTemplate: TicketTypeTemplateRecord = {
  id: TEMPLATE_ID,
  ownerScope: "ORGANIZATION",
  ownerId: null,
  name: "General admission",
  ticketTypes: [GA_ENTRY],
  isPlatform: true,
  packId: PACK_ID,
  createdByHumanId: null,
  createdAt: NOW,
  updatedAt: NOW,
  archivedAt: null,
};

const packWithTemplates: TicketPackWithTemplatesRecord = {
  ...draftPack,
  templates: [packTemplate],
};

// ── Mock builders ────────────────────────────────────────────────────────────

interface MakeContextOptions {
  /** Result of authz.hasStaffRole — defaults to allowed. */
  staffAllowed?: boolean;
  pack?: TicketPackRecord | null;
  packWithTemplates?: TicketPackWithTemplatesRecord | null;
  /** Platform templates remaining after deleteByPack (race simulation). */
  remainingAfterDelete?: number;
}

function makeContext(options: MakeContextOptions = {}) {
  const pack = options.pack === undefined ? draftPack : options.pack;
  const withTemplates =
    options.packWithTemplates === undefined
      ? packWithTemplates
      : options.packWithTemplates;

  const repo = {
    listPacks: vi.fn(async () => [
      { ...draftPack, templateCount: 1, entryCount: 1, forkCount: 3 },
    ]),
    getPack: vi.fn(async (id: string) => (pack && id === pack.id ? pack : null)),
    getPackByKey: vi.fn(async (key: string) =>
      pack && key === pack.key ? pack : null,
    ),
    getPackWithTemplates: vi.fn(async (id: string) =>
      withTemplates && id === withTemplates.id ? withTemplates : null,
    ),
    createPack: vi.fn(async (input: Record<string, unknown>) => ({
      ...draftPack,
      ...input,
    })),
    updatePack: vi.fn(async (_id: string, input: Record<string, unknown>) => ({
      ...(pack ?? draftPack),
      ...input,
    })),
    deletePack: vi.fn(async () => {}),
    createPlatformTemplate: vi.fn(async (input: Record<string, unknown>) => ({
      ...packTemplate,
      ...input,
      id: "00000000-0000-4000-8000-000000000099",
    })),
    updatePlatformTemplate: vi.fn(
      async (_id: string, input: Record<string, unknown>) => ({
        ...packTemplate,
        ...input,
      }),
    ),
    deletePlatformTemplates: vi.fn(async (ids: string[]) => ids.length),
    deletePlatformTemplatesByPack: vi.fn(async () => 1),
    countPlatformTemplatesByPack: vi.fn(
      async () => options.remainingAfterDelete ?? 0,
    ),
  };

  const auditRepo = { log: vi.fn(async () => {}) };

  const txRepos = {
    ticketTypeTemplates: repo,
    audit: auditRepo,
  } as unknown as TxRepos;

  const repos = {
    ...txRepos,
    tx: async <T>(fn: (tx: TxRepos) => Promise<T>) => fn(txRepos),
  } as unknown as Repos;

  const authz = {
    hasStaffRole: vi.fn(async () => ({
      allowed: options.staffAllowed ?? true,
    })),
  };

  return {
    deps: { repos, authz, clock: { now: () => NOW } },
    mocks: { repo, audit: auditRepo, authz },
  };
}

// ── STAFF_TECH gate (every procedure, FR-012 acceptance) ─────────────────────

describe("ticket packs staff gate", () => {
  const cases: Array<[string, (deps: any) => Promise<unknown>]> = [
    [
      "listTicketPacksAdmin",
      (deps) => listTicketPacksAdmin(deps, { actorHumanId: ACTOR_ID }),
    ],
    [
      "getTicketPackAdmin",
      (deps) =>
        getTicketPackAdmin(deps, { actorHumanId: ACTOR_ID, packId: PACK_ID }),
    ],
    [
      "upsertTicketPack",
      (deps) =>
        upsertTicketPack(deps, {
          actorHumanId: ACTOR_ID,
          key: "general-admission",
          name: "General admission",
        }),
    ],
    [
      "setTicketPackStatus",
      (deps) =>
        setTicketPackStatus(deps, {
          actorHumanId: ACTOR_ID,
          packId: PACK_ID,
          status: "LIVE",
        }),
    ],
    [
      "removeTicketPack",
      (deps) =>
        removeTicketPack(deps, { actorHumanId: ACTOR_ID, packId: PACK_ID }),
    ],
  ];

  for (const [name, run] of cases) {
    it(`${name} refuses a non-STAFF_TECH actor before any read or write`, async () => {
      const ctx = makeContext({ staffAllowed: false });

      await expect(run(ctx.deps)).rejects.toMatchObject({
        code: "STAFF_ONLY",
      });
      expect(ctx.mocks.repo.createPack).not.toHaveBeenCalled();
      expect(ctx.mocks.repo.updatePack).not.toHaveBeenCalled();
      expect(ctx.mocks.repo.deletePack).not.toHaveBeenCalled();
      expect(ctx.mocks.audit.log).not.toHaveBeenCalled();
      // The gate asks for STAFF_TECH (ADMIN + DEVELOPER) — REVIEWER/SUPPORT
      // land in the !allowed branch above.
      expect(ctx.mocks.authz.hasStaffRole).toHaveBeenCalledWith({
        actorHumanId: ACTOR_ID,
        requiredRoles: ["ADMIN", "DEVELOPER"],
      });
    });
  }
});

// ── Reads ────────────────────────────────────────────────────────────────────

describe("listTicketPacksAdmin", () => {
  it("returns packs with template, entry and fork counts", async () => {
    const ctx = makeContext();

    const result = await listTicketPacksAdmin(ctx.deps, {
      actorHumanId: ACTOR_ID,
    });

    expect(result.packs).toHaveLength(1);
    expect(result.packs[0]).toMatchObject({
      key: "general-admission",
      templateCount: 1,
      entryCount: 1,
      forkCount: 3,
    });
  });
});

describe("getTicketPackAdmin", () => {
  it("returns a DRAFT pack with its templates (status-blind preview)", async () => {
    const ctx = makeContext();

    const result = await getTicketPackAdmin(ctx.deps, {
      actorHumanId: ACTOR_ID,
      packId: PACK_ID,
    });

    expect(result.pack.status).toBe("DRAFT");
    expect(result.pack.templates).toHaveLength(1);
    expect(result.pack.templates[0]).toMatchObject({
      isPlatform: true,
      ownerId: null,
      packId: PACK_ID,
    });
  });

  it("404s an unknown pack", async () => {
    const ctx = makeContext({ pack: null, packWithTemplates: null });

    await expect(
      getTicketPackAdmin(ctx.deps, {
        actorHumanId: ACTOR_ID,
        packId: PACK_ID,
      }),
    ).rejects.toMatchObject({ code: "TICKET_PACK_NOT_FOUND" });
  });
});

// ── Upsert ───────────────────────────────────────────────────────────────────

describe("upsertTicketPack", () => {
  it("creates an unknown key as DRAFT and audits", async () => {
    const ctx = makeContext({ pack: null });
    // getPackWithTemplates must resolve the fresh row after create.
    ctx.mocks.repo.getPackWithTemplates.mockResolvedValue({
      ...packWithTemplates,
      templates: [],
    });

    await upsertTicketPack(ctx.deps, {
      actorHumanId: ACTOR_ID,
      key: "general-admission",
      name: "General admission",
      blurb: "One simple GA type.",
    });

    expect(ctx.mocks.repo.createPack).toHaveBeenCalledWith(
      expect.objectContaining({ key: "general-admission", status: "DRAFT" }),
    );
    expect(ctx.mocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "ticket_pack",
        action: "ticket_pack.created",
      }),
    );
  });

  it("reconciles templates by name: update the match, create the new, delete the stale", async () => {
    const ctx = makeContext();

    await upsertTicketPack(ctx.deps, {
      actorHumanId: ACTOR_ID,
      key: "general-admission",
      name: "General admission",
      templates: [
        // Case-insensitive match with the existing "General admission".
        { name: "GENERAL ADMISSION", ticketTypes: [GA_ENTRY] },
        { name: "Early bird", ticketTypes: [{ ...GA_ENTRY, name: "Early bird" }] },
      ],
    });

    expect(ctx.mocks.repo.updatePlatformTemplate).toHaveBeenCalledWith(
      TEMPLATE_ID,
      expect.objectContaining({ name: "GENERAL ADMISSION" }),
    );
    expect(ctx.mocks.repo.createPlatformTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ packId: PACK_ID, name: "Early bird" }),
    );
    // Nothing stale in this payload — the existing row was matched.
    expect(ctx.mocks.repo.deletePlatformTemplates).toHaveBeenCalledWith([]);
  });

  it("deletes templates the payload no longer names (platform-only repo call)", async () => {
    const ctx = makeContext();

    await upsertTicketPack(ctx.deps, {
      actorHumanId: ACTOR_ID,
      key: "general-admission",
      name: "General admission",
      templates: [],
    });

    expect(ctx.mocks.repo.deletePlatformTemplates).toHaveBeenCalledWith([
      TEMPLATE_ID,
    ]);
  });

  it("leaves templates untouched when the field is omitted (metadata-only edit)", async () => {
    const ctx = makeContext();

    await upsertTicketPack(ctx.deps, {
      actorHumanId: ACTOR_ID,
      key: "general-admission",
      name: "Renamed",
    });

    expect(ctx.mocks.repo.updatePack).toHaveBeenCalledWith(
      PACK_ID,
      expect.objectContaining({ name: "Renamed" }),
    );
    // Blurb omitted ⇒ not nulled (the volunteer upsert's lesson).
    expect(ctx.mocks.repo.updatePack).not.toHaveBeenCalledWith(
      PACK_ID,
      expect.objectContaining({ blurb: null }),
    );
    expect(ctx.mocks.repo.createPlatformTemplate).not.toHaveBeenCalled();
    expect(ctx.mocks.repo.deletePlatformTemplates).not.toHaveBeenCalled();
  });

  it("rejects duplicate template names within one pack", async () => {
    const ctx = makeContext();

    await expect(
      upsertTicketPack(ctx.deps, {
        actorHumanId: ACTOR_ID,
        key: "general-admission",
        name: "General admission",
        templates: [
          { name: "General admission", ticketTypes: [GA_ENTRY] },
          { name: "general admission", ticketTypes: [GA_ENTRY] },
        ],
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects non-integer money in entries", async () => {
    const ctx = makeContext();

    await expect(
      upsertTicketPack(ctx.deps, {
        actorHumanId: ACTOR_ID,
        key: "general-admission",
        name: "General admission",
        templates: [
          {
            name: "Bad",
            ticketTypes: [{ ...GA_ENTRY, name: "Bad", priceCents: 19.99 }],
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});

// ── Publish / unpublish ──────────────────────────────────────────────────────

describe("setTicketPackStatus", () => {
  it("publishes and audits the transition", async () => {
    const ctx = makeContext();

    const result = await setTicketPackStatus(ctx.deps, {
      actorHumanId: ACTOR_ID,
      packId: PACK_ID,
      status: "LIVE",
    });

    expect(result.pack.status).toBe("LIVE");
    expect(ctx.mocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "ticket_pack",
        action: "ticket_pack.published",
        data: expect.objectContaining({ from: "DRAFT", to: "LIVE" }),
      }),
    );
  });

  it("404s an unknown pack", async () => {
    const ctx = makeContext({ pack: null });

    await expect(
      setTicketPackStatus(ctx.deps, {
        actorHumanId: ACTOR_ID,
        packId: PACK_ID,
        status: "LIVE",
      }),
    ).rejects.toMatchObject({ code: "TICKET_PACK_NOT_FOUND" });
  });
});

// ── Remove ───────────────────────────────────────────────────────────────────

describe("removeTicketPack", () => {
  it("deletes platform templates BEFORE the pack, in order, and audits", async () => {
    const ctx = makeContext();
    const order: string[] = [];
    ctx.mocks.repo.deletePlatformTemplatesByPack.mockImplementation(
      async () => {
        order.push("templates");
        return 1;
      },
    );
    ctx.mocks.repo.deletePack.mockImplementation(async () => {
      order.push("pack");
    });

    const result = await removeTicketPack(ctx.deps, {
      actorHumanId: ACTOR_ID,
      packId: PACK_ID,
    });

    expect(order).toEqual(["templates", "pack"]);
    expect(result).toEqual({ removed: true, deletedTemplateCount: 1 });
    expect(ctx.mocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "ticket_pack",
        action: "ticket_pack.deleted",
        data: expect.objectContaining({ deletedTemplateCount: 1 }),
      }),
    );
  });

  it("surfaces a typed conflict when a platform row survives the delete", async () => {
    const ctx = makeContext({ remainingAfterDelete: 1 });

    await expect(
      removeTicketPack(ctx.deps, {
        actorHumanId: ACTOR_ID,
        packId: PACK_ID,
      }),
    ).rejects.toMatchObject({ code: "TICKET_PACK_HAS_PLATFORM_TEMPLATES" });
    expect(ctx.mocks.repo.deletePack).not.toHaveBeenCalled();
  });

  it("translates a CHECK violation from the pack delete into the typed error", async () => {
    const ctx = makeContext();
    ctx.mocks.repo.deletePack.mockRejectedValue(
      new Error(
        'violates check constraint "TicketTypeTemplate_platform_pack_check"',
      ),
    );

    await expect(
      removeTicketPack(ctx.deps, {
        actorHumanId: ACTOR_ID,
        packId: PACK_ID,
      }),
    ).rejects.toMatchObject({ code: "TICKET_PACK_HAS_PLATFORM_TEMPLATES" });
  });
});
