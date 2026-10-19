import { describe, expect, it, vi } from "vitest";

import { listTicketTypeTemplates } from "../list-ticket-type-templates";
import { createTestLogger } from "@th/test-utils";
import type {
  TicketPackRecord,
  TicketTypeTemplateRecord,
} from "@th/types";
import type { Repos, TxRepos } from "@th/ports/repos";

const ORG_A = "22222222-2222-4222-8222-222222222222";
const ORG_B = "aaaaaaaa-2222-4222-8222-222222222222";
const ACTOR = "33333333-3333-4333-8333-333333333333";
const PACK_GA = "44444444-4444-4444-8444-444444444401";
const PACK_PWYC = "44444444-4444-4444-8444-444444444402";
const NOW = new Date("2026-08-04T12:00:00.000Z");

function entry(name: string, priceCents = 2000) {
  return {
    name,
    priceCents,
    pricingMode: "FIXED" as const,
    minimumCents: null,
    suggestedCents: null,
    capacity: 100,
    resaleAllowed: false,
    resaleCapCents: null,
    transferAllowed: true,
  };
}

let templateSeq = 0;
function template(
  overrides: Partial<TicketTypeTemplateRecord>,
): TicketTypeTemplateRecord {
  templateSeq += 1;
  return {
    id: `55555555-5555-4555-8555-5555555555${String(templateSeq).padStart(2, "0")}`,
    ownerScope: "ORGANIZATION",
    ownerId: ORG_A,
    name: "Owned",
    ticketTypes: [entry("GA")],
    isPlatform: false,
    packId: null,
    createdByHumanId: ACTOR,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    ...overrides,
  };
}

function pack(overrides: Partial<TicketPackRecord>): TicketPackRecord {
  return {
    id: PACK_GA,
    key: "general-admission",
    name: "General admission",
    blurb: "One simple GA type.",
    status: "LIVE",
    sortOrder: 0,
    curatedByHumanId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeContext(input: {
  owned: TicketTypeTemplateRecord[];
  platform: TicketTypeTemplateRecord[];
  packs: TicketPackRecord[];
}) {
  const ticketTypeTemplatesRepo = {
    list: vi.fn(async (_scope: string, ownerId: string) =>
      input.owned.filter((row) => row.ownerId === ownerId),
    ),
    listLivePlatformTemplates: vi.fn(async () => input.platform),
    listLivePacks: vi.fn(async () => input.packs),
  };

  const txRepos = {
    ticketTypeTemplates: ticketTypeTemplatesRepo,
    authz: {
      getOrgMembership: vi.fn(
        async ({ orgId, humanId }: { orgId: string; humanId: string }) =>
          orgId === ORG_A && humanId === ACTOR
            ? { orgId, humanId, role: "ADMIN" }
            : null,
      ),
    },
    organizations: {
      getById: vi.fn(async (id: string) => ({ id, name: "Org" })),
    },
    humans: { getById: vi.fn(async (id: string) => ({ id })) },
  } as unknown as TxRepos;

  const repos = {
    ...txRepos,
    tx: async <T>(fn: (tx: TxRepos) => Promise<T>) => fn(txRepos),
  } as unknown as Repos;

  return { repos, mocks: { ticketTypeTemplates: ticketTypeTemplatesRepo } };
}

const baseInput = {
  actorHumanId: ACTOR,
  ownerScope: "ORGANIZATION" as const,
  ownerId: ORG_A,
};

describe("listTicketTypeTemplates (FR-006 union + shadowing)", () => {
  it("returns owned rows plus LIVE platform rows, flagged and grouped", async () => {
    const owned = [template({ name: "My own" })];
    const platformRow = template({
      ownerId: null,
      isPlatform: true,
      packId: PACK_GA,
      name: "General admission",
      createdByHumanId: null,
    });
    const ctx = makeContext({
      owned,
      platform: [platformRow],
      packs: [pack({})],
    });

    const result = await listTicketTypeTemplates(
      { repos: ctx.repos, logger: createTestLogger() },
      baseInput,
    );

    expect(result.items).toHaveLength(2);
    const own = result.items.find((i) => !i.isPlatform);
    const plat = result.items.find((i) => i.isPlatform);
    expect(own).toMatchObject({ name: "My own", ownerId: ORG_A, packId: null });
    expect(plat).toMatchObject({
      name: "General admission",
      ownerId: null,
      isPlatform: true,
      packId: PACK_GA,
    });
    expect(result.packs).toEqual([
      {
        id: PACK_GA,
        key: "general-admission",
        name: "General admission",
        blurb: "One simple GA type.",
        sortOrder: 0,
      },
    ]);
  });

  it("hides a catalogue row shadowed by the owner's fork (packId + name, case-insensitive)", async () => {
    const fork = template({
      name: "GENERAL ADMISSION",
      packId: PACK_GA,
    });
    const platformRow = template({
      ownerId: null,
      isPlatform: true,
      packId: PACK_GA,
      name: "General admission",
      createdByHumanId: null,
    });
    const ctx = makeContext({
      owned: [fork],
      platform: [platformRow],
      packs: [pack({})],
    });

    const result = await listTicketTypeTemplates(
      { repos: ctx.repos, logger: createTestLogger() },
      baseInput,
    );

    // One row for the pair — the fork — and no empty pack group left over.
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ id: fork.id, isPlatform: false });
    expect(result.packs).toEqual([]);
  });

  it("does not shadow across packs or unrelated same-name templates", async () => {
    // Fork of the GA pack, but a same-name catalogue row in ANOTHER pack
    // stays visible.
    const fork = template({ name: "General admission", packId: PACK_GA });
    const gaRow = template({
      ownerId: null,
      isPlatform: true,
      packId: PACK_GA,
      name: "General admission",
      createdByHumanId: null,
    });
    const pwycRow = template({
      ownerId: null,
      isPlatform: true,
      packId: PACK_PWYC,
      name: "General admission",
      createdByHumanId: null,
    });
    const ctx = makeContext({
      owned: [fork],
      platform: [gaRow, pwycRow],
      packs: [
        pack({}),
        pack({ id: PACK_PWYC, key: "pay-what-you-can", name: "Pay what you can", sortOrder: 3 }),
      ],
    });

    const result = await listTicketTypeTemplates(
      { repos: ctx.repos, logger: createTestLogger() },
      baseInput,
    );

    const platformItems = result.items.filter((i) => i.isPlatform);
    expect(platformItems).toHaveLength(1);
    expect(platformItems[0]).toMatchObject({ packId: PACK_PWYC });
    expect(result.packs.map((p) => p.key)).toEqual(["pay-what-you-can"]);
  });

  it("lists a stored template whose entries still carry the removed doorPriceCents key, without the key", async () => {
    // Rows saved before door-sales-same-price-and-tax FR-012 hold the key in
    // their JSON. The entry schema is strict for WRITES; on read it must strip
    // the key, or one legacy row would make the whole list throw.
    const legacyEntry = { ...entry("Advance", 1500), doorPriceCents: 2000 };
    const owned = [
      template({
        name: "Legacy advance + door",
        ticketTypes: [legacyEntry] as TicketTypeTemplateRecord["ticketTypes"],
      }),
    ];
    const ctx = makeContext({ owned, platform: [], packs: [] });

    const result = await listTicketTypeTemplates(
      { repos: ctx.repos, logger: createTestLogger() },
      baseInput,
    );

    expect(result.items).toHaveLength(1);
    const [listedEntry] = result.items[0]!.ticketTypes;
    expect(listedEntry).toMatchObject({ name: "Advance", priceCents: 1500 });
    expect(listedEntry).not.toHaveProperty("doorPriceCents");
  });

  it("returns zero rows belonging to another owner (NFR-002)", async () => {
    const foreign = template({ ownerId: ORG_B, name: "B's template" });
    const ctx = makeContext({ owned: [foreign], platform: [], packs: [] });

    const result = await listTicketTypeTemplates(
      { repos: ctx.repos, logger: createTestLogger() },
      baseInput,
    );

    expect(result.items).toEqual([]);
  });

  it("denies non-members before any repo read", async () => {
    const ctx = makeContext({ owned: [], platform: [], packs: [] });

    await expect(
      listTicketTypeTemplates(
        { repos: ctx.repos, logger: createTestLogger() },
        { ...baseInput, ownerId: ORG_B },
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    expect(ctx.mocks.ticketTypeTemplates.list).not.toHaveBeenCalled();
    expect(
      ctx.mocks.ticketTypeTemplates.listLivePlatformTemplates,
    ).not.toHaveBeenCalled();
  });
});
