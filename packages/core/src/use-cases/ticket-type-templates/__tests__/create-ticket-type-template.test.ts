import { describe, expect, it, vi } from "vitest";

import { createTicketTypeTemplate } from "../create-ticket-type-template";
import { createFakeIdempotencyPort, createTestLogger } from "@th/test-utils";
import type { TicketTypeTemplateRecord } from "@th/types";
import type { Repos, TxRepos } from "@th/ports/repos";

const DEFAULT_ORG_ID = "22222222-2222-4222-8222-222222222222";
const DEFAULT_ACTOR_ID = "33333333-3333-4333-8333-333333333333";
const DEFAULT_TEMPLATE_ID = "44444444-4444-4444-8444-444444444444";
const FIXED_NOW = new Date("2026-07-23T12:00:00.000Z");

const BASE_ENTRIES = [
  {
    name: "GA",
    priceCents: 2500,
    capacity: 100,
  },
  {
    name: "VIP",
    priceCents: 10000,
    capacity: 20,
  },
];

interface MakeContextOptions {
  existingTemplate?: TicketTypeTemplateRecord | null;
  membershipRole?: string | null;
}

function makeContext(options: MakeContextOptions = {}) {
  const membershipRole =
    options.membershipRole === undefined ? "ADMIN" : options.membershipRole;

  const ticketTypeTemplatesRepo = {
    getById: vi.fn(async () => null),
    findByName: vi.fn(async () => options.existingTemplate ?? null),
    create: vi.fn(
      async (input: {
        ownerScope: "HUMAN" | "ORGANIZATION";
        ownerId: string;
        name: string;
        ticketTypes: TicketTypeTemplateRecord["ticketTypes"];
        createdByHumanId: string;
        createdAt: Date;
      }): Promise<TicketTypeTemplateRecord> => ({
        id: DEFAULT_TEMPLATE_ID,
        ownerScope: input.ownerScope,
        ownerId: input.ownerId,
        name: input.name,
        ticketTypes: input.ticketTypes,
        createdByHumanId: input.createdByHumanId,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
        archivedAt: null,
      }),
    ),
    list: vi.fn(async () => []),
    archive: vi.fn(),
  };

  const auditRepo = { log: vi.fn(async () => {}) };

  const authzRepo = {
    getHumanDelegation: vi.fn(async () => null),
    getOrgMembership: vi.fn(
      async ({ orgId, humanId }: { orgId: string; humanId: string }) => {
        if (orgId !== DEFAULT_ORG_ID) return null;
        if (humanId !== DEFAULT_ACTOR_ID) return null;
        if (membershipRole === null) return null;
        return { orgId, humanId, role: membershipRole };
      },
    ),
  };

  const organizationsRepo = {
    getById: vi.fn(async (id: string) =>
      id === DEFAULT_ORG_ID ? { id, name: "Org", status: "ACTIVE" } : null,
    ),
  };

  const humansRepo = {
    getById: vi.fn(async (id: string) => ({
      id,
      email: "owner@example.com",
      name: "Owner",
      status: "ACTIVE",
    })),
  };

  const txRepos = {
    ticketTypeTemplates: ticketTypeTemplatesRepo,
    audit: auditRepo,
    authz: authzRepo,
    organizations: organizationsRepo,
    humans: humansRepo,
  } as unknown as TxRepos;

  const repos = {
    ...txRepos,
    tx: async <T>(fn: (tx: TxRepos) => Promise<T>) => fn(txRepos),
  } as unknown as Repos;

  const deps = {
    repos,
    idempotency: createFakeIdempotencyPort(),
    clock: { now: () => FIXED_NOW },
    logger: createTestLogger(),
  };

  return {
    deps,
    mocks: { ticketTypeTemplates: ticketTypeTemplatesRepo, audit: auditRepo },
  };
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    actorHumanId: DEFAULT_ACTOR_ID,
    ownerScope: "ORGANIZATION",
    ownerId: DEFAULT_ORG_ID,
    name: "Standard door split",
    ticketTypes: BASE_ENTRIES,
    clientKey: "create-template-key",
    ...overrides,
  };
}

describe("createTicketTypeTemplate", () => {
  it("creates a template with normalized entries", async () => {
    const ctx = makeContext();

    const result = await createTicketTypeTemplate(ctx.deps, baseInput());

    expect(result).toEqual({ templateId: DEFAULT_TEMPLATE_ID });
    expect(ctx.mocks.ticketTypeTemplates.create).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerScope: "ORGANIZATION",
        ownerId: DEFAULT_ORG_ID,
        name: "Standard door split",
        createdByHumanId: DEFAULT_ACTOR_ID,
        createdAt: FIXED_NOW,
        ticketTypes: [
          expect.objectContaining({
            name: "GA",
            priceCents: 2500,
            pricingMode: "FIXED",
            capacity: 100,
            resaleAllowed: false,
            transferAllowed: true,
          }),
          expect.objectContaining({ name: "VIP", priceCents: 10000 }),
        ],
      }),
    );
    expect(ctx.mocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "ticket_type_template",
        action: "created",
        at: FIXED_NOW,
      }),
    );
  });

  // ── FR-011: relative schedule + window on stored entries ────────────────

  it("stores the relative schedule and window verbatim (no resolution at save)", async () => {
    const ctx = makeContext();

    await createTicketTypeTemplate(
      ctx.deps,
      baseInput({
        ticketTypes: [
          {
            name: "Early bird",
            priceCents: 1200,
            capacity: 30,
            salesOpen: { anchor: "EVENT_PUBLISH", offsetMinutes: 0 },
            salesClose: { anchor: "EVENT_START", offsetMinutes: -20160 },
            scheduledPriceChange: {
              at: { anchor: "EVENT_START", offsetMinutes: -10080 },
              priceCents: 2000,
            },
          },
        ],
      }),
    );

    expect(ctx.mocks.ticketTypeTemplates.create).toHaveBeenCalledWith(
      expect.objectContaining({
        ticketTypes: [
          expect.objectContaining({
            salesOpen: { anchor: "EVENT_PUBLISH", offsetMinutes: 0 },
            salesClose: { anchor: "EVENT_START", offsetMinutes: -20160 },
            scheduledPriceChange: {
              at: { anchor: "EVENT_START", offsetMinutes: -10080 },
              priceCents: 2000,
            },
          }),
        ],
      }),
    );
  });

  it("defaults the relative fields to null on an entry that omits them (NFR-001)", async () => {
    const ctx = makeContext();

    await createTicketTypeTemplate(ctx.deps, baseInput());

    const entries = ctx.mocks.ticketTypeTemplates.create.mock.calls[0]![0]
      .ticketTypes as Record<string, unknown>[];
    for (const entry of entries) {
      expect(entry).toMatchObject({
        salesOpen: null,
        salesClose: null,
        scheduledPriceChange: null,
      });
    }
  });

  it("rejects a window that is inverted under its own shared anchor", async () => {
    // Both bounds on EVENT_START: the anchor cancels, so this is wrong for
    // EVERY event and belongs at the write boundary, not in FR-016's
    // apply-time warning path.
    const ctx = makeContext();

    await expect(
      createTicketTypeTemplate(
        ctx.deps,
        baseInput({
          ticketTypes: [
            {
              name: "Early bird",
              priceCents: 1200,
              capacity: 30,
              salesOpen: { anchor: "EVENT_START", offsetMinutes: -1440 },
              salesClose: { anchor: "EVENT_START", offsetMinutes: -20160 },
            },
          ],
        }),
      ),
    ).rejects.toBeTruthy();
    expect(ctx.mocks.ticketTypeTemplates.create).not.toHaveBeenCalled();
  });

  it("allows a mixed-anchor window that only apply time can judge", async () => {
    const ctx = makeContext();

    await createTicketTypeTemplate(
      ctx.deps,
      baseInput({
        ticketTypes: [
          {
            name: "Early bird",
            priceCents: 1200,
            capacity: 30,
            salesOpen: { anchor: "EVENT_PUBLISH", offsetMinutes: 0 },
            salesClose: { anchor: "EVENT_START", offsetMinutes: -20160 },
          },
        ],
      }),
    );

    expect(ctx.mocks.ticketTypeTemplates.create).toHaveBeenCalled();
  });

  it("rejects a scheduled price change on an ADJUSTABLE entry", async () => {
    // `upsertTicketType` CLEARS it silently (a buyer-chosen price has no list
    // price to flip), and that clear emits no warning anywhere — the one
    // genuinely silent drop in the feature. Refused at the write boundary
    // instead, while the combination is still unauthorable.
    const ctx = makeContext();

    await expect(
      createTicketTypeTemplate(
        ctx.deps,
        baseInput({
          ticketTypes: [
            {
              name: "Pay what you can",
              priceCents: 0,
              capacity: 60,
              pricingMode: "ADJUSTABLE",
              minimumCents: 0,
              suggestedCents: 1000,
              scheduledPriceChange: {
                at: { anchor: "EVENT_START", offsetMinutes: -10080 },
                priceCents: 2000,
              },
            },
          ],
        }),
      ),
    ).rejects.toBeTruthy();
    expect(ctx.mocks.ticketTypeTemplates.create).not.toHaveBeenCalled();
  });

  it("still allows a WINDOW on an ADJUSTABLE entry — sellability is not price", async () => {
    const ctx = makeContext();

    await createTicketTypeTemplate(
      ctx.deps,
      baseInput({
        ticketTypes: [
          {
            name: "Pay what you can",
            priceCents: 0,
            capacity: 60,
            pricingMode: "ADJUSTABLE",
            minimumCents: 0,
            suggestedCents: 1000,
            salesOpen: { anchor: "EVENT_START", offsetMinutes: -1440 },
          },
        ],
      }),
    );

    expect(ctx.mocks.ticketTypeTemplates.create).toHaveBeenCalled();
  });

  it("rejects an offset beyond the leap-year cap", async () => {
    const ctx = makeContext();

    await expect(
      createTicketTypeTemplate(
        ctx.deps,
        baseInput({
          ticketTypes: [
            {
              name: "Early bird",
              priceCents: 1200,
              capacity: 30,
              // −20160 fat-fingered as seconds.
              salesClose: { anchor: "EVENT_START", offsetMinutes: -1209600 },
            },
          ],
        }),
      ),
    ).rejects.toBeTruthy();
    expect(ctx.mocks.ticketTypeTemplates.create).not.toHaveBeenCalled();
  });

  it("rejects a duplicate template name for the owner", async () => {
    const ctx = makeContext({
      existingTemplate: {
        id: DEFAULT_TEMPLATE_ID,
        ownerScope: "ORGANIZATION",
        ownerId: DEFAULT_ORG_ID,
        name: "Standard door split",
        ticketTypes: [],
        createdByHumanId: DEFAULT_ACTOR_ID,
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
        archivedAt: null,
      },
    });

    await expect(
      createTicketTypeTemplate(ctx.deps, baseInput()),
    ).rejects.toMatchObject({ code: "TEMPLATE_NAME_TAKEN" });
    expect(ctx.mocks.ticketTypeTemplates.create).not.toHaveBeenCalled();
  });

  it("rejects duplicate entry names within the template", async () => {
    const ctx = makeContext();

    await expect(
      createTicketTypeTemplate(
        ctx.deps,
        baseInput({
          ticketTypes: [
            { name: "GA", priceCents: 2500, capacity: 100 },
            { name: "ga ", priceCents: 3000, capacity: 50 },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(ctx.mocks.ticketTypeTemplates.create).not.toHaveBeenCalled();
  });

  it("requires an edit-capable org role", async () => {
    const ctx = makeContext({ membershipRole: "VIEWER" });

    await expect(
      createTicketTypeTemplate(ctx.deps, baseInput()),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    expect(ctx.mocks.ticketTypeTemplates.create).not.toHaveBeenCalled();
  });

  it("rejects HUMAN-scope templates for other humans", async () => {
    const ctx = makeContext();

    await expect(
      createTicketTypeTemplate(
        ctx.deps,
        baseInput({
          ownerScope: "HUMAN",
          ownerId: "99999999-9999-4999-8999-999999999999",
        }),
      ),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });

  it("replays the same result under idempotency", async () => {
    const ctx = makeContext();
    const input = baseInput();

    const first = await createTicketTypeTemplate(ctx.deps, input);
    const second = await createTicketTypeTemplate(ctx.deps, input);

    expect(first).toEqual(second);
    expect(ctx.mocks.ticketTypeTemplates.create).toHaveBeenCalledTimes(1);
  });
});

describe("ticket-type template WRITES cap PWYW amounts; READS stay lenient", () => {
  it("the write schema refuses a minimum or suggestion above $10,000.00", async () => {
    const { ticketTypeTemplateEntriesSchema, ticketTypeTemplateDtoSchema } =
      await import("../schemas");
    const entry = {
      name: "Sliding scale",
      priceCents: 0,
      pricingMode: "ADJUSTABLE" as const,
      minimumCents: 500,
      suggestedCents: 1_000_001,
      capacity: 50,
    };
    const written = ticketTypeTemplateEntriesSchema.safeParse([entry]);
    expect(written.success).toBe(false);
    expect(
      written.error!.issues.find((i) => i.path.includes("suggestedCents"))
        ?.message,
    ).toMatch(/capped at \$10,000\.00 per ticket/);
    expect(
      ticketTypeTemplateEntriesSchema.safeParse([
        { ...entry, suggestedCents: 1_000_000 },
      ]).success,
    ).toBe(true);

    // A stored template from before the cap still LOADS.
    const stored = ticketTypeTemplateDtoSchema.safeParse({
      id: "11111111-1111-4111-8111-111111111111",
      ownerScope: "ORGANIZATION",
      ownerId: "22222222-2222-4222-8222-222222222222",
      name: "Old pack",
      ticketTypes: [entry],
      isPlatform: false,
      packId: null,
      createdByHumanId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(stored.success).toBe(true);
  });
});
