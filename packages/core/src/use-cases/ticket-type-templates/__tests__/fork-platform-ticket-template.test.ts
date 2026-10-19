import { describe, expect, it, vi } from "vitest";

import { forkPlatformTicketTemplate } from "../fork-platform-ticket-template";
import { createFakeIdempotencyPort, createTestLogger } from "@th/test-utils";
import type {
  TicketPackRecord,
  TicketTypeTemplateRecord,
} from "@th/types";
import type { Repos, TxRepos } from "@th/ports/repos";

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_ORG_ID = "aaaaaaaa-2222-4222-8222-222222222222";
const ACTOR = "33333333-3333-4333-8333-333333333333";
const OUTSIDER = "99999999-9999-4999-8999-999999999999";
const PACK_ID = "44444444-4444-4444-8444-444444444444";
const SOURCE_ID = "55555555-5555-4555-8555-555555555555";
const NOW = new Date("2026-08-04T12:00:00.000Z");

// A catalogue row saved before door-sales-same-price-and-tax FR-012 removed
// the per-type door price: its stored JSON still carries the key. The fork must
// neither fail on it nor copy it forward.
const SOURCE_ENTRIES = [
  {
    name: "Advance",
    priceCents: 1500,
    pricingMode: "FIXED" as const,
    minimumCents: null,
    suggestedCents: null,
    capacity: 100,
    resaleAllowed: false,
    resaleCapCents: null,
    transferAllowed: true,
    doorPriceCents: 2000,
  },
];

function makeSource(
  overrides: Partial<TicketTypeTemplateRecord> = {},
): TicketTypeTemplateRecord {
  return {
    id: SOURCE_ID,
    ownerScope: "ORGANIZATION",
    ownerId: null,
    name: "Advance + door",
    ticketTypes: SOURCE_ENTRIES,
    isPlatform: true,
    packId: PACK_ID,
    createdByHumanId: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    ...overrides,
  };
}

function makePack(status: "DRAFT" | "LIVE"): TicketPackRecord {
  return {
    id: PACK_ID,
    key: "advance-plus-door",
    name: "Advance + door",
    blurb: null,
    status,
    sortOrder: 1,
    curatedByHumanId: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

interface MakeContextOptions {
  source?: TicketTypeTemplateRecord | null;
  packStatus?: "DRAFT" | "LIVE";
  /** Owned rows findByName should surface for a name collision. */
  existingByName?: TicketTypeTemplateRecord | null;
  /** Role of ACTOR inside ORG_ID; null = not a member. */
  actorRole?: string | null;
}

function makeContext(options: MakeContextOptions = {}) {
  const source = options.source === undefined ? makeSource() : options.source;
  const pack = makePack(options.packStatus ?? "LIVE");
  const actorRole = options.actorRole === undefined ? "ADMIN" : options.actorRole;

  const createdRows: TicketTypeTemplateRecord[] = [];
  let createSeq = 0;

  const ticketTypeTemplatesRepo = {
    getById: vi.fn(async (id: string) => {
      if (source && id === source.id) return source;
      const created = createdRows.find((row) => row.id === id);
      return created ?? null;
    }),
    findByName: vi.fn(async () => options.existingByName ?? null),
    create: vi.fn(
      async (input: {
        ownerScope: "ORGANIZATION" | "HUMAN";
        ownerId: string;
        name: string;
        ticketTypes: typeof SOURCE_ENTRIES;
        createdByHumanId: string;
        createdAt: Date;
        packId?: string | null;
      }): Promise<TicketTypeTemplateRecord> => {
        createSeq += 1;
        const row: TicketTypeTemplateRecord = {
          id: `66666666-6666-4666-8666-66666666660${createSeq}`,
          ownerScope: input.ownerScope,
          ownerId: input.ownerId,
          name: input.name,
          ticketTypes: input.ticketTypes,
          isPlatform: false,
          packId: input.packId ?? null,
          createdByHumanId: input.createdByHumanId,
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
          archivedAt: null,
        };
        createdRows.push(row);
        return row;
      },
    ),
    getPack: vi.fn(async (id: string) => (id === PACK_ID ? pack : null)),
  };

  const auditRepo = { log: vi.fn(async () => {}) };
  const authzRepo = {
    getOrgMembership: vi.fn(
      async ({ orgId, humanId }: { orgId: string; humanId: string }) => {
        if (orgId !== ORG_ID) return null;
        if (humanId !== ACTOR) return null;
        if (actorRole === null) return null;
        return { orgId, humanId, role: actorRole };
      },
    ),
  };

  const txRepos = {
    ticketTypeTemplates: ticketTypeTemplatesRepo,
    audit: auditRepo,
    authz: authzRepo,
    organizations: {
      getById: vi.fn(async (id: string) =>
        id === ORG_ID || id === OTHER_ORG_ID ? { id, name: "Org" } : null,
      ),
    },
    humans: { getById: vi.fn(async (id: string) => ({ id })) },
  } as unknown as TxRepos;

  const repos = {
    ...txRepos,
    tx: async <T>(fn: (tx: TxRepos) => Promise<T>) => fn(txRepos),
  } as unknown as Repos;

  const idempotency = createFakeIdempotencyPort();
  const idemSpies = {
    get: vi.spyOn(idempotency, "get"),
    begin: vi.spyOn(idempotency, "begin"),
  };

  const deps = {
    repos,
    idempotency,
    clock: { now: () => NOW },
    logger: createTestLogger(),
  };

  return {
    deps,
    mocks: {
      ticketTypeTemplates: ticketTypeTemplatesRepo,
      audit: auditRepo,
      authz: authzRepo,
    },
    idemSpies,
  };
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    actorHumanId: ACTOR,
    ownerScope: "ORGANIZATION",
    ownerId: ORG_ID,
    templateId: SOURCE_ID,
    ...overrides,
  };
}

describe("forkPlatformTicketTemplate", () => {
  it("copies a LIVE platform template into an owned row with packId provenance", async () => {
    const ctx = makeContext();

    const result = await forkPlatformTicketTemplate(ctx.deps, baseInput());

    expect(result.template).toMatchObject({
      ownerScope: "ORGANIZATION",
      ownerId: ORG_ID,
      isPlatform: false,
      packId: PACK_ID,
      name: "Advance + door",
    });
    // Entries copied verbatim (FR-009), minus the removed door-price key.
    expect(result.template.ticketTypes).toEqual([
      expect.objectContaining({ name: "Advance", priceCents: 1500 }),
    ]);
    expect(result.template.ticketTypes[0]).not.toHaveProperty(
      "doorPriceCents",
    );
    const createdEntries =
      ctx.mocks.ticketTypeTemplates.create.mock.calls[0]?.[0]?.ticketTypes;
    expect(createdEntries).toHaveLength(1);
    expect(createdEntries[0]).toMatchObject({ name: "Advance", priceCents: 1500 });
    expect(createdEntries[0]).not.toHaveProperty("doorPriceCents");
    expect(ctx.mocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "ticket_type_template",
        action: "forked_from_platform",
        data: expect.objectContaining({
          sourceTemplateId: SOURCE_ID,
          packId: PACK_ID,
        }),
      }),
    );
  });

  it("is idempotent: a double-click creates exactly one copy", async () => {
    const ctx = makeContext();

    const first = await forkPlatformTicketTemplate(ctx.deps, baseInput());
    const second = await forkPlatformTicketTemplate(ctx.deps, baseInput());

    expect(second.template.id).toBe(first.template.id);
    expect(ctx.mocks.ticketTypeTemplates.create).toHaveBeenCalledTimes(1);
  });

  it("rejects a non-OWNER/ADMIN caller BEFORE any idempotency-store touch (FR-010)", async () => {
    const ctx = makeContext({ actorRole: "EDITOR" });

    await expect(
      forkPlatformTicketTemplate(ctx.deps, baseInput()),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });

    expect(ctx.idemSpies.get).not.toHaveBeenCalled();
    expect(ctx.idemSpies.begin).not.toHaveBeenCalled();
    expect(ctx.mocks.ticketTypeTemplates.create).not.toHaveBeenCalled();
  });

  it("rejects a non-member naming another org before any store touch", async () => {
    const ctx = makeContext();

    await expect(
      forkPlatformTicketTemplate(
        ctx.deps,
        baseInput({ actorHumanId: OUTSIDER, ownerId: OTHER_ORG_ID }),
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    expect(ctx.idemSpies.get).not.toHaveBeenCalled();
  });

  it("answers a DRAFT pack's template with TEMPLATE_NOT_FOUND", async () => {
    const ctx = makeContext({ packStatus: "DRAFT" });

    await expect(
      forkPlatformTicketTemplate(ctx.deps, baseInput()),
    ).rejects.toMatchObject({ code: "TEMPLATE_NOT_FOUND" });
    expect(ctx.mocks.ticketTypeTemplates.create).not.toHaveBeenCalled();
  });

  it("refuses to fork an owned template (no duplicate-my-template primitive)", async () => {
    const ctx = makeContext({
      source: makeSource({ ownerId: ORG_ID, isPlatform: false, packId: null }),
    });

    await expect(
      forkPlatformTicketTemplate(ctx.deps, baseInput()),
    ).rejects.toMatchObject({ code: "TEMPLATE_NOT_FOUND" });
  });

  it("fails TEMPLATE_NAME_TAKEN on an unrelated same-name template, then a rename retry succeeds", async () => {
    const unrelated = makeSource({
      id: "77777777-7777-4777-8777-777777777777",
      ownerId: ORG_ID,
      isPlatform: false,
      packId: null,
      name: "Advance + door",
    });
    const ctx = makeContext({ existingByName: unrelated });

    await expect(
      forkPlatformTicketTemplate(ctx.deps, baseInput()),
    ).rejects.toMatchObject({ code: "TEMPLATE_NAME_TAKEN" });
    expect(ctx.mocks.ticketTypeTemplates.create).not.toHaveBeenCalled();

    // The claim was RELEASED (not a `failed:` marker), so an immediate retry
    // with an explicit name on the same key is not locked out.
    expect(ctx.deps.idempotency.release).toHaveBeenCalledTimes(1);
    expect(ctx.deps.idempotency.fail).not.toHaveBeenCalled();
    ctx.mocks.ticketTypeTemplates.findByName.mockResolvedValue(null);
    const retry = await forkPlatformTicketTemplate(
      ctx.deps,
      baseInput({ name: "Advance + door (mine)" }),
    );
    expect(retry.template.name).toBe("Advance + door (mine)");
    expect(retry.template.packId).toBe(PACK_ID);
  });

  it("releases the claim on a transient failure so a same-key retry proceeds at once", async () => {
    const ctx = makeContext();
    const reportError = vi.fn();
    const deps = { ...ctx.deps, reportError };
    ctx.mocks.ticketTypeTemplates.create.mockRejectedValueOnce(
      new Error("connection reset"),
    );

    await expect(
      forkPlatformTicketTemplate(deps, baseInput()),
    ).rejects.toThrow("connection reset");
    expect(ctx.deps.idempotency.release).toHaveBeenCalledTimes(1);
    expect(ctx.deps.idempotency.fail).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();

    const retry = await forkPlatformTicketTemplate(deps, baseInput());
    expect(retry.template.packId).toBe(PACK_ID);
  });

  it("keeps the claim when the work committed and only the idempotency commit throws", async () => {
    const ctx = makeContext();
    vi.spyOn(ctx.deps.idempotency, "commit").mockRejectedValueOnce(
      new Error("redis down"),
    );

    await expect(
      forkPlatformTicketTemplate(ctx.deps, baseInput()),
    ).rejects.toThrow("redis down");

    // A same-key retry is refused, so committed work cannot be redone.
    await expect(
      forkPlatformTicketTemplate(ctx.deps, baseInput()),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_LOCK_IN_PROGRESS" });

    expect(ctx.mocks.ticketTypeTemplates.create).toHaveBeenCalledTimes(1);
    expect(ctx.deps.idempotency.release).not.toHaveBeenCalled();
    expect(ctx.deps.idempotency.fail).not.toHaveBeenCalled();
  });

  it("returns an existing live fork unchanged instead of duplicating it", async () => {
    const existingFork = makeSource({
      id: "88888888-8888-4888-8888-888888888888",
      ownerId: ORG_ID,
      isPlatform: false,
      packId: PACK_ID,
      name: "Advance + door",
      createdByHumanId: ACTOR,
    });
    const ctx = makeContext({ existingByName: existingFork });

    const result = await forkPlatformTicketTemplate(ctx.deps, baseInput());

    expect(result.template.id).toBe(existingFork.id);
    expect(ctx.mocks.ticketTypeTemplates.create).not.toHaveBeenCalled();
    // Nothing written — no audit row for a no-op.
    expect(ctx.mocks.audit.log).not.toHaveBeenCalled();
  });

  it("treats an ARCHIVED fork as a collision rather than reviving it", async () => {
    const archivedFork = makeSource({
      id: "88888888-8888-4888-8888-888888888888",
      ownerId: ORG_ID,
      isPlatform: false,
      packId: PACK_ID,
      name: "Advance + door",
      archivedAt: new Date("2026-08-01T00:00:00.000Z"),
    });
    const ctx = makeContext({ existingByName: archivedFork });

    await expect(
      forkPlatformTicketTemplate(ctx.deps, baseInput()),
    ).rejects.toMatchObject({ code: "TEMPLATE_NAME_TAKEN" });
  });
});
