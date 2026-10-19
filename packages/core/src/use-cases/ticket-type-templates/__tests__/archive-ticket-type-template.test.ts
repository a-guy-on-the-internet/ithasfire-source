import { describe, expect, it, vi } from "vitest";

import { archiveTicketTypeTemplate } from "../archive-ticket-type-template";
import { listTicketTypeTemplates } from "../list-ticket-type-templates";
import { createFakeIdempotencyPort, createTestLogger } from "@th/test-utils";
import type { TicketTypeTemplateRecord } from "@th/types";
import type { Repos, TxRepos } from "@th/ports/repos";

const DEFAULT_ORG_ID = "22222222-2222-4222-8222-222222222222";
const DEFAULT_ACTOR_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_ACTOR_ID = "99999999-9999-4999-8999-999999999999";
const DEFAULT_TEMPLATE_ID = "44444444-4444-4444-8444-444444444444";
const DEFAULT_PACK_ID = "77777777-7777-4777-8777-777777777777";
const FIXED_NOW = new Date("2026-07-23T12:00:00.000Z");

interface MakeContextOptions {
  templateArchivedAt?: Date | null;
  /** Turns the fixture into a platform catalogue row (FR-005 matrix). */
  platform?: boolean;
}

function makeTemplate(
  archivedAt: Date | null,
  platform = false,
): TicketTypeTemplateRecord {
  return {
    id: DEFAULT_TEMPLATE_ID,
    ownerScope: "ORGANIZATION",
    ownerId: platform ? null : DEFAULT_ORG_ID,
    name: "Standard door split",
    ticketTypes: [
      {
        name: "GA",
        priceCents: 2500,
        pricingMode: "FIXED",
        minimumCents: null,
        suggestedCents: null,
        capacity: 100,
        resaleAllowed: false,
        resaleCapCents: null,
        transferAllowed: true,
      },
    ],
    isPlatform: platform,
    packId: platform ? DEFAULT_PACK_ID : null,
    createdByHumanId: platform ? null : DEFAULT_ACTOR_ID,
    createdAt: new Date("2026-07-01T12:00:00.000Z"),
    updatedAt: new Date("2026-07-01T12:00:00.000Z"),
    archivedAt,
  };
}

function makeContext(options: MakeContextOptions = {}) {
  const template = makeTemplate(
    options.templateArchivedAt ?? null,
    options.platform ?? false,
  );

  const ticketTypeTemplatesRepo = {
    getById: vi.fn(async (id: string) => (id === template.id ? template : null)),
    findByName: vi.fn(async () => null),
    create: vi.fn(),
    list: vi.fn(async () => [template]),
    archive: vi.fn(async () => ({ ...template, archivedAt: FIXED_NOW })),
  };

  const auditRepo = { log: vi.fn(async () => {}) };

  const authzRepo = {
    // Only DEFAULT_ACTOR_ID is a member of the owning org.
    getOrgMembership: vi.fn(
      async ({ orgId, humanId }: { orgId: string; humanId: string }) => {
        if (orgId !== DEFAULT_ORG_ID) return null;
        if (humanId !== DEFAULT_ACTOR_ID) return null;
        return { orgId, humanId, role: "ADMIN" };
      },
    ),
  };

  const txRepos = {
    ticketTypeTemplates: ticketTypeTemplatesRepo,
    audit: auditRepo,
    authz: authzRepo,
    organizations: {
      getById: vi.fn(async (id: string) =>
        id === DEFAULT_ORG_ID ? { id, name: "Org", status: "ACTIVE" } : null,
      ),
    },
    humans: {
      getById: vi.fn(async (id: string) => ({ id, status: "ACTIVE" })),
    },
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
    mocks: {
      ticketTypeTemplates: ticketTypeTemplatesRepo,
      audit: auditRepo,
      authz: authzRepo,
    },
  };
}

describe("archiveTicketTypeTemplate", () => {
  it("archives the template and audits", async () => {
    const ctx = makeContext();

    const result = await archiveTicketTypeTemplate(ctx.deps, {
      actorHumanId: DEFAULT_ACTOR_ID,
      templateId: DEFAULT_TEMPLATE_ID,
      clientKey: "archive-key-1",
    });

    expect(result).toEqual({ ok: true });
    expect(ctx.mocks.ticketTypeTemplates.archive).toHaveBeenCalledWith({
      templateId: DEFAULT_TEMPLATE_ID,
      archivedAt: FIXED_NOW,
    });
    expect(ctx.mocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "ticket_type_template",
        action: "archived",
        at: FIXED_NOW,
      }),
    );
  });

  it("denies actors outside the owning org", async () => {
    const ctx = makeContext();

    await expect(
      archiveTicketTypeTemplate(ctx.deps, {
        actorHumanId: OTHER_ACTOR_ID,
        templateId: DEFAULT_TEMPLATE_ID,
        clientKey: "archive-key-2",
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    expect(ctx.mocks.ticketTypeTemplates.archive).not.toHaveBeenCalled();
  });

  it("returns ok for an already-archived template without re-archiving", async () => {
    const ctx = makeContext({ templateArchivedAt: new Date("2026-07-10") });

    const result = await archiveTicketTypeTemplate(ctx.deps, {
      actorHumanId: DEFAULT_ACTOR_ID,
      templateId: DEFAULT_TEMPLATE_ID,
      clientKey: "archive-key-3",
    });

    expect(result).toEqual({ ok: true });
    expect(ctx.mocks.ticketTypeTemplates.archive).not.toHaveBeenCalled();
    expect(ctx.mocks.audit.log).not.toHaveBeenCalled();
  });

  it("rejects a missing template", async () => {
    const ctx = makeContext();

    await expect(
      archiveTicketTypeTemplate(ctx.deps, {
        actorHumanId: DEFAULT_ACTOR_ID,
        templateId: "88888888-8888-4888-8888-888888888888",
        clientKey: "archive-key-4",
      }),
    ).rejects.toMatchObject({ code: "TEMPLATE_NOT_FOUND" });
  });

  // ── FR-005 (BLOCKING SECURITY): platform rows are read-only ──────────────

  it("rejects a platform template with TEMPLATE_NOT_FOUND before any owner check", async () => {
    const ctx = makeContext({ platform: true });

    await expect(
      archiveTicketTypeTemplate(ctx.deps, {
        actorHumanId: DEFAULT_ACTOR_ID,
        templateId: DEFAULT_TEMPLATE_ID,
        clientKey: "archive-key-5",
      }),
    ).rejects.toMatchObject({ code: "TEMPLATE_NOT_FOUND" });

    // Same code as a foreign/missing template — no existence signal — and
    // the platform row is untouched.
    expect(ctx.mocks.ticketTypeTemplates.archive).not.toHaveBeenCalled();
    expect(ctx.mocks.audit.log).not.toHaveBeenCalled();
    // BEFORE owner access: the org membership lookup never ran.
    expect(ctx.mocks.authz.getOrgMembership).not.toHaveBeenCalled();
  });

  it("fails closed on a mis-shaped row (null ownerId without the flag)", async () => {
    const ctx = makeContext({ platform: true });
    // Simulate a row with ownerId null but isPlatform false.
    const template = makeTemplate(null, true);
    ctx.mocks.ticketTypeTemplates.getById.mockResolvedValue({
      ...template,
      isPlatform: false,
    });

    await expect(
      archiveTicketTypeTemplate(ctx.deps, {
        actorHumanId: DEFAULT_ACTOR_ID,
        templateId: DEFAULT_TEMPLATE_ID,
        clientKey: "archive-key-6",
      }),
    ).rejects.toMatchObject({ code: "TEMPLATE_NOT_FOUND" });
    expect(ctx.mocks.ticketTypeTemplates.archive).not.toHaveBeenCalled();
  });
});

describe("listTicketTypeTemplates", () => {
  it("denies non-members of the owning org", async () => {
    const ctx = makeContext();

    await expect(
      listTicketTypeTemplates(
        { repos: ctx.deps.repos, logger: ctx.deps.logger },
        {
          actorHumanId: OTHER_ACTOR_ID,
          ownerScope: "ORGANIZATION",
          ownerId: DEFAULT_ORG_ID,
        },
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    expect(ctx.mocks.ticketTypeTemplates.list).not.toHaveBeenCalled();
  });
});
