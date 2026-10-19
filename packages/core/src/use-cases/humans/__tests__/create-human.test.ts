import { beforeEach, describe, expect, it, vi } from "vitest";

import { createHuman } from "../create-human";
import type { CreateHumanDeps } from "../create-human";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { AuditRepo } from "@th/ports/repos/audit";
import type { HumansRepo } from "@th/ports/repos/humans";
import type { EntityPagesRepo } from "@th/ports/repos/entity-pages";
import { createTestLogger } from "@th/test-utils/fakes/logger";

const DEFAULT_HUMAN_ID = "11111111-1111-4111-8111-111111111111";

function makeDeps() {
  const humansRepo: HumansRepo = {
    getById: vi.fn(),
    getByEmail: vi.fn(),
    getByPhone: vi.fn(),
    getHumanIdForAuthUserId: vi.fn(),
    linkAuthUserToHuman: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    ensureByProvider: vi.fn(),
  } as unknown as HumansRepo;

  const entityPagesRepo: EntityPagesRepo = {
    getByOwner: vi.fn(),
    upsert: vi.fn(),
  } as unknown as EntityPagesRepo;

  const auditRepo: AuditRepo = {
    log: vi.fn(),
  } as AuditRepo;

  const txRepos = {
    humans: humansRepo,
    entityPages: entityPagesRepo,
    audit: auditRepo,
    tickets: {} as any,
    seats: {} as any,
    agreements: {} as any,
    feePolicies: {} as any,
    events: {} as any,
    orders: {} as any,
    splits: {} as any,
    payees: {} as any,
    settlements: {} as any,
    resaleListings: {} as any,
    idempotency: {} as any,
    authz: {} as any,
    apiKeys: {} as any,
    organizations: {} as any,
    places: {} as any,
    savedLocations: {} as any,
  } as unknown as TxRepos;

  const repos: Repos = {
    humans: humansRepo,
    entityPages: entityPagesRepo,
    audit: auditRepo,
    tickets: {} as any,
    seats: {} as any,
    agreements: {} as any,
    feePolicies: {} as any,
    events: {} as any,
    orders: {} as any,
    splits: {} as any,
    payees: {} as any,
    settlements: {} as any,
    resaleListings: {} as any,
    idempotency: {} as any,
    authz: {} as any,
    apiKeys: {} as any,
    organizations: {} as any,
    places: {} as any,
    savedLocations: {} as any,
    tx: async <T>(fn: (tx: TxRepos) => Promise<T>) => fn(txRepos),
  } as unknown as Repos;

  const clock = { now: () => new Date("2024-01-01T00:00:00.000Z") };

  const logger = createTestLogger();

  const deps: CreateHumanDeps = {
    repos,
    clock,
    logger,
  };

  return { deps, humansRepo, entityPagesRepo, auditRepo };
}

describe("createHuman", () => {
  let ctx: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    ctx = makeDeps();
  });

  it("returns existing human when found by email", async () => {
    const email = "user@example.com";
    const phone = "+12345678901";

    const existingHuman = {
      id: DEFAULT_HUMAN_ID,
      name: "Ada Lovelace",
      status: "ACTIVE",
      roles: ["USER"],
      locale: null,
    };
    const existingIdentity = {
      authUserId: DEFAULT_HUMAN_ID,
      email,
      emailVerified: true,
      phone,
      phoneVerified: false,
      username: null,
      displayUsername: null,
      image: null,
    };

    (ctx.humansRepo.getByEmail as any).mockResolvedValueOnce({
      human: existingHuman,
      identity: existingIdentity,
    });
    (ctx.entityPagesRepo.getByOwner as any).mockResolvedValue({
      id: "page-1",
      ownerType: "HUMAN",
      ownerId: DEFAULT_HUMAN_ID,
      slug: "ada-lovelace-11111111",
      displayName: "Ada Lovelace",
      bio: null,
      avatarUrl: null,
      bannerUrl: null,
      visibility: "PUBLIC",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const input = {
      actorSystem: "service",
      email,
      name: " Ada Lovelace ",
      phone,
      clientKey: "idem-key-1234",
    } as const;

    const result = await createHuman(ctx.deps, input);

    expect(result).toEqual({
      humanId: DEFAULT_HUMAN_ID,
      created: false, // Always false now since we only return existing
      human: {
        id: DEFAULT_HUMAN_ID,
        email,
        name: "Ada Lovelace",
        phone,
        status: "ACTIVE",
      },
      profile: {
        humanId: DEFAULT_HUMAN_ID,
        slug: "ada-lovelace-11111111",
        displayName: "Ada Lovelace",
      },
    });
    // In the new model, create is never called
    expect(ctx.humansRepo.create).not.toHaveBeenCalled();
  });

  it("throws not_found when no human exists for email", async () => {
    (ctx.humansRepo.getByEmail as any).mockResolvedValueOnce(null);

    await expect(
      createHuman(ctx.deps, {
        actorSystem: "service",
        email: "user@example.com",
        phone: "+12345678901",
        clientKey: "idem-key-1234",
      }),
    ).rejects.toMatchObject({ code: "HUMAN_NOT_FOUND" });

    expect(ctx.humansRepo.create).not.toHaveBeenCalled();
  });
});
