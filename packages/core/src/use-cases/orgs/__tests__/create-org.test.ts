import { describe, expect, it, vi } from "vitest";

import { createOrg, type CreateOrgDeps } from "../create-org";
import type { AuthZPort } from "@th/ports/authz";
import type { Repos, TxRepos } from "@th/ports/repos";
import type {
  OrganizationRecord,
  OrganizationsRepo,
} from "@th/ports/repos/organizations";
import { createFakeIdempotencyPort } from "@th/test-utils/fakes/idempotency";
import { createTestLogger } from "@th/test-utils/fakes/logger";

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const CLIENT_KEY = "client-key-123456";
const ORGANIZATION_ID = "22222222-2222-4222-8222-222222222222";

function makeDeps() {
  const organizationsRepo: OrganizationsRepo = {
    getById: vi.fn(),
    create: vi.fn(async ({ name, status, createdAt }) => {
      expect(status).toBe("ACTIVE");
      expect(createdAt).toBeInstanceOf(Date);
      return {
        id: ORGANIZATION_ID,
        name,
        slug: "org",
        status,
        defaultLocale: null,
        trustTier: "NEW",
        trustBadgeLabel: null,
        trustBadgeIcon: null,
        createdAt: new Date(),
      } satisfies OrganizationRecord;
    }),
    addMember: vi.fn(async () => ({ created: true, previousRole: null })),
    countMembersByRole: vi.fn(async () => 1),
    listActive: vi.fn(async () => ({ items: [], total: 0 })),
  };

  const auditRepo = {
    log: vi.fn(async () => {}),
  };

  const authzRepo = {
    getOrgMembership: vi.fn(),
    listOrgMembershipsByHumanId: vi.fn(async () => []),
    getStaffRolesForHumanId: vi.fn(async () => []),
    getEventOrgId: vi.fn(async () => null),
    getPlaceAccessContext: vi.fn(async () => null),
    isPlaceVerifiedForOrg: vi.fn(async () => false),
  };

  const humansRepo = {
    getById: vi.fn(async () => ({
      id: ACTOR_ID,
      email: "actor@example.com",
      username: null,
      name: "Actor",
      phone: null,
      status: "ACTIVE" as const,

      roles: ["USER"],
      emailVerified: true,
      phoneVerified: true,
      locale: null,
    })),
  };

  const txRepos: TxRepos = {
    featuredEvents: {} as TxRepos["featuredEvents"],
    eventApplications: {} as TxRepos["eventApplications"],
    eventWaitlists: {} as TxRepos["eventWaitlists"],
    inviteLists: {} as TxRepos["inviteLists"],
    organizations: organizationsRepo,
    audit: auditRepo as unknown as TxRepos["audit"],
    authz: authzRepo as unknown as TxRepos["authz"],
    humans: humansRepo as unknown as TxRepos["humans"],
    events: {} as TxRepos["events"],
    orders: {} as TxRepos["orders"],
    tickets: {} as TxRepos["tickets"],
    seats: {} as TxRepos["seats"],
    agreements: {} as TxRepos["agreements"],
    feePolicies: {} as TxRepos["feePolicies"],
    splits: {} as TxRepos["splits"],
    payees: {} as TxRepos["payees"],
    settlements: {} as TxRepos["settlements"],
    resaleListings: {} as TxRepos["resaleListings"],
    idempotency: {} as TxRepos["idempotency"],
    apiKeys: {} as TxRepos["apiKeys"],
    places: {} as TxRepos["places"],
    savedLocations: {} as TxRepos["savedLocations"],
    categories: {
      listActive: vi.fn(),
      getBySlug: vi.fn(),
      getById: vi.fn(),
      upsertSeed: vi.fn(),
    } as TxRepos["categories"],
    eventTemplates: {} as TxRepos["eventTemplates"],
    eventHumans: {} as TxRepos["eventHumans"],
    series: {} as TxRepos["series"],
    seriesOccurrences: {} as TxRepos["seriesOccurrences"],
    pushDevices: {} as TxRepos["pushDevices"],
    notificationPrefs: {} as TxRepos["notificationPrefs"],
    notificationDigests: {} as TxRepos["notificationDigests"],
    notifications: undefined as unknown as TxRepos["notifications"],
    placeLayouts: {} as TxRepos["placeLayouts"],
    placeLayoutBlobs: {} as TxRepos["placeLayoutBlobs"],
    placeLayoutStatuses: {} as TxRepos["placeLayoutStatuses"],
    orderItems: {} as TxRepos["orderItems"],
    orderItemSettlementLines: {} as TxRepos["orderItemSettlementLines"],
    settlementLines: {} as TxRepos["settlementLines"],
    payouts: {} as TxRepos["payouts"],
    entityPages: {
      upsert: vi.fn(
        async (input: {
          ownerType: string;
          ownerId: string;
          slug: string;
          displayName: string;
        }) => ({
          id: "page-1",
          ownerType: input.ownerType,
          ownerId: input.ownerId,
          slug: input.slug,
          displayName: input.displayName,
          bio: null,
          avatarUrl: null,
          bannerUrl: null,
          visibility: "PUBLIC",
        }),
      ),
    } as unknown as TxRepos["entityPages"],
    resourceQuotas: {
      getEffectiveQuota: vi.fn(async () => ({
        kind: "ORGS_OWNED",
        limitValue: 3n,
        currentUsage: 0n,
        isOverride: false,
      })),
      hasPendingExpansionRequest: vi.fn(async () => false),
      incrementUsage: vi.fn(async () => ({ currentUsage: 1n })),
    } as unknown as TxRepos["resourceQuotas"],
  };

  const repos: Repos = {
    ...txRepos,
    tx: async <T>(fn: (tx: TxRepos) => Promise<T>) => fn(txRepos),
  };

  const authz: AuthZPort = {
    hasOrgRole: vi.fn(),
    requireOrgRole: vi.fn(async () => {}),
    canEditEvent: vi.fn(),
    canManagePlace: vi.fn(),
    canFinanceOrg: vi.fn(),
    hasStaffRole: vi.fn(async () => ({ allowed: false })),
  };

  const idempotency = createFakeIdempotencyPort();
  const now = new Date("2025-01-01T00:00:00.000Z");
  const clock = { now: () => now };
  const logger = createTestLogger();

  const deps: CreateOrgDeps = {
    repos,
    idempotency,
    authz,
    clock,
    logger,
  };

  return {
    deps,
    organizationsRepo,
    auditRepo,
    entityPages: txRepos.entityPages,
    idempotency,
    authz,
    now,
  };
}

describe("createOrg", () => {
  it("creates org and owner membership", async () => {
    const { deps, organizationsRepo, auditRepo, idempotency } = makeDeps();

    const result = await createOrg(deps, {
      actorHumanId: ACTOR_ID,
      name: "  Stellar Events ",
      clientKey: CLIENT_KEY,
    });

    expect(result).toEqual({ orgId: ORGANIZATION_ID });
    expect(organizationsRepo.create).toHaveBeenCalledTimes(1);
    expect(organizationsRepo.create).toHaveBeenCalledWith({
      name: "Stellar Events",
      slug: "stellar-events",
      status: "ACTIVE",
      createdAt: expect.any(Date),
    });
    expect(organizationsRepo.addMember).toHaveBeenCalledWith({
      orgId: ORGANIZATION_ID,
      humanId: ACTOR_ID,
      role: "OWNER",
      addedAt: expect.any(Date),
    });
    expect(auditRepo.log).toHaveBeenCalledWith({
      entity: "organization",
      entityId: ORGANIZATION_ID,
      action: "organization.created",
      data: {
        actorHumanId: ACTOR_ID,
        name: "Stellar Events",
      },
      at: expect.any(Date),
    });

    const key = `org:create:${ACTOR_ID}:Stellar Events:${CLIENT_KEY}`;
    const stored = idempotency.__store.get(key);
    expect(stored?.response).toEqual(result);
  });

  it("replays prior result when idempotent", async () => {
    const { deps, organizationsRepo, idempotency } = makeDeps();

    const input = {
      actorHumanId: ACTOR_ID,
      name: "Nova Collective",
      clientKey: CLIENT_KEY,
    } as const;

    const first = await createOrg(deps, input);
    expect(first.orgId).toBe(ORGANIZATION_ID);

    const second = await createOrg(deps, input);
    expect(second).toEqual(first);
    expect(organizationsRepo.create).toHaveBeenCalledTimes(1);

    const key = `org:create:${ACTOR_ID}:Nova Collective:${CLIENT_KEY}`;
    expect(idempotency.__store.get(key)?.response).toEqual(first);
  });

  it("auto-creates an EntityPage for the new organization", async () => {
    const { deps, entityPages } = makeDeps();

    await createOrg(deps, {
      actorHumanId: ACTOR_ID,
      name: "Stellar Events",
      clientKey: CLIENT_KEY,
    });

    expect(entityPages.upsert).toHaveBeenCalledTimes(1);
    expect(entityPages.upsert).toHaveBeenCalledWith({
      ownerType: "ORGANIZATION",
      ownerId: ORGANIZATION_ID,
      slug: expect.stringContaining("stellar-events"),
      displayName: "Stellar Events",
    });
  });

  it("does not auto-create a second EntityPage on idempotent replay", async () => {
    const { deps, entityPages } = makeDeps();

    const input = {
      actorHumanId: ACTOR_ID,
      name: "Replay Org",
      clientKey: CLIENT_KEY,
    } as const;

    await createOrg(deps, input);
    await createOrg(deps, input);

    // The transaction only ran once; the second call returned the idempotent replay.
    expect(entityPages.upsert).toHaveBeenCalledTimes(1);
  });
});
